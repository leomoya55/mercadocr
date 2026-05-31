/**
 * routes/cron.js — scheduled backstop jobs (invoked by Vercel Cron).
 *
 * WHY THIS EXISTS
 *   Webhooks are the PRIMARY downgrade mechanism, but they can be missed
 *   (a deploy mid-delivery, a transient 5xx that exhausts Stripe's retries, an
 *   event that never fires). The runtime resolver (config/membership.js) already
 *   protects entitlement on every request, but the STORED plan can stay stale,
 *   which skews admin stats and the cron also reconciles Stripe directly. This
 *   job is the durable, write-back safety net.
 *
 * SECURITY
 *   Cron endpoints are publicly reachable URLs. Vercel Cron automatically sends
 *   `Authorization: Bearer <CRON_SECRET>` when a CRON_SECRET env var is set. We
 *   reject any request whose bearer token doesn't match — so a malicious actor
 *   can't trigger mass downgrades or hammer Stripe by hitting the URL.
 */

const router  = require('express').Router();
const User    = require('../models/user.model');
const Listing = require('../models/listing.model');
const ProcessedEvent = require('../models/processedEvent.model');
const { stripe, tierFromSubscription, getPeriodEnd, ACTIVE_STATUSES } = require('../config/stripe');
const { cloudinary, configureCloudinary, getPublicIdFromUrl } = require('../config/cloudinary');
const { captureException } = require('../config/sentry');

// ─── Auth guard for every cron route ──────────────────────────────────────────
router.use((req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Refuse to run unguarded — better to no-op than expose an open downgrade URL.
    console.error('[cron] CRON_SECRET not set — refusing.');
    return res.status(503).json({ error: 'cron not configured' });
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

/**
 * GET /api/cron/downgrade-expired
 *
 * Finds paid users whose paid period has clearly lapsed and reconciles them
 * against Stripe (source of truth) before downgrading. We reconcile rather than
 * blindly downgrade so a user mid-renewal (whose webhook is merely delayed) is
 * not wrongly knocked down.
 */
router.get('/downgrade-expired', async (req, res) => {
  const now = new Date();
  // 1-day grace mirrors the resolver, so the cron never contradicts runtime.
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const candidates = await User.find({
    plan: { $in: ['basic', 'pro'] },
    // Admin comp grants never expire — exclude them from downgrade reconciliation.
    compedPlan: { $ne: true },
    // either no period stored, or it lapsed beyond the grace window
    $or: [
      { currentPeriodEnd: { $lt: cutoff } },
      { currentPeriodEnd: null, planExpiresAt: { $lt: cutoff } },
    ],
  }).select('firebaseUid plan stripeSubscriptionId email').limit(500).lean();

  let downgraded = 0, refreshed = 0, skipped = 0, errors = 0;

  for (const u of candidates) {
    try {
      // No subscription on record → straightforward downgrade.
      if (!u.stripeSubscriptionId) {
        await User.updateOne({ firebaseUid: u.firebaseUid }, {
          $set: { plan: 'free', subscriptionStatus: 'canceled', currentPeriodEnd: null, planExpiresAt: null, cancelAtPeriodEnd: false },
        });
        downgraded++;
        continue;
      }

      // Reconcile against Stripe.
      const sub = await stripe.subscriptions.retrieve(u.stripeSubscriptionId);
      const periodEnd = getPeriodEnd(sub);
      const stillActive = ACTIVE_STATUSES.has(sub.status) &&
        (!periodEnd || periodEnd.getTime() + 24 * 60 * 60 * 1000 > Date.now());

      if (stillActive) {
        // Webhook was missed but the sub is genuinely active → refresh, keep tier.
        await User.updateOne({ firebaseUid: u.firebaseUid }, {
          $set: {
            plan: tierFromSubscription(sub) || u.plan,
            subscriptionStatus: sub.status,
            currentPeriodEnd: periodEnd,
            planExpiresAt: periodEnd,
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          },
        });
        refreshed++;
      } else {
        await User.updateOne({ firebaseUid: u.firebaseUid }, {
          $set: { plan: 'free', subscriptionStatus: sub.status, currentPeriodEnd: null, planExpiresAt: null, cancelAtPeriodEnd: false, stripeSubscriptionId: null },
        });
        downgraded++;
      }
    } catch (err) {
      // A retrieve can fail if the sub was deleted in Stripe → downgrade safely.
      if (err?.statusCode === 404 || err?.code === 'resource_missing') {
        await User.updateOne({ firebaseUid: u.firebaseUid }, {
          $set: { plan: 'free', subscriptionStatus: 'canceled', currentPeriodEnd: null, planExpiresAt: null, cancelAtPeriodEnd: false, stripeSubscriptionId: null },
        });
        downgraded++;
      } else {
        console.error('[cron] reconcile failed for', u.firebaseUid, err.message);
        captureException(err, { where: 'cron_downgrade', firebaseUid: u.firebaseUid });
        errors++;
      }
    }
  }

  // Opportunistic cleanup: TTL handles ProcessedEvent expiry, but if the TTL
  // monitor is lagging we hard-delete very old rows here as a backstop.
  const ttlCutoff = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
  ProcessedEvent.deleteMany({ createdAt: { $lt: ttlCutoff } }).catch(() => {});

  console.log(JSON.stringify({ job: 'downgrade-expired', candidates: candidates.length, downgraded, refreshed, skipped, errors }));
  res.json({ ok: true, candidates: candidates.length, downgraded, refreshed, errors });
});

/**
 * GET /api/cron/cleanup-sold
 *
 * Deletes listings that have been marked sold for more than a week, removing
 * both the MongoDB document and the Cloudinary images. This keeps sold listings
 * visible in the seller's panel for ~7 days, then reclaims all the data so the
 * database and image storage never accumulate sold items indefinitely.
 */
router.get('/cleanup-sold', async (req, res) => {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const candidates = await Listing.find({
    status: 'sold',
    soldAt: { $ne: null, $lt: cutoff },
  }).select('_id photos').limit(500).lean();

  let deleted = 0, imagesDeleted = 0, errors = 0;
  if (candidates.length) configureCloudinary();

  for (const l of candidates) {
    try {
      if (Array.isArray(l.photos) && l.photos.length) {
        const publicIds = l.photos.map(getPublicIdFromUrl).filter(Boolean);
        if (publicIds.length) {
          await cloudinary.api.delete_resources(publicIds);
          imagesDeleted += publicIds.length;
        }
      }
      await Listing.deleteOne({ _id: l._id });
      deleted++;
    } catch (err) {
      console.error('[cron] cleanup-sold failed for', l._id, err.message);
      captureException(err, { where: 'cron_cleanup_sold', listingId: String(l._id) });
      errors++;
    }
  }

  console.log(JSON.stringify({ job: 'cleanup-sold', candidates: candidates.length, deleted, imagesDeleted, errors }));
  res.json({ ok: true, candidates: candidates.length, deleted, imagesDeleted, errors });
});

module.exports = router;
