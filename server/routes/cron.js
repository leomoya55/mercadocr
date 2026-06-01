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
const { expireBoosts } = require('../config/featured');
const { syncSellerProListings } = require('../config/membership');
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
        await syncSellerProListings(u.firebaseUid, false);
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
        const refreshedTier = tierFromSubscription(sub) || u.plan;
        await User.updateOne({ firebaseUid: u.firebaseUid }, {
          $set: {
            plan: refreshedTier,
            subscriptionStatus: sub.status,
            currentPeriodEnd: periodEnd,
            planExpiresAt: periodEnd,
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          },
        });
        await syncSellerProListings(u.firebaseUid, refreshedTier === 'pro');
        refreshed++;
      } else {
        await User.updateOne({ firebaseUid: u.firebaseUid }, {
          $set: { plan: 'free', subscriptionStatus: sub.status, currentPeriodEnd: null, planExpiresAt: null, cancelAtPeriodEnd: false, stripeSubscriptionId: null },
        });
        await syncSellerProListings(u.firebaseUid, false);
        downgraded++;
      }
    } catch (err) {
      // A retrieve can fail if the sub was deleted in Stripe → downgrade safely.
      if (err?.statusCode === 404 || err?.code === 'resource_missing') {
        await User.updateOne({ firebaseUid: u.firebaseUid }, {
          $set: { plan: 'free', subscriptionStatus: 'canceled', currentPeriodEnd: null, planExpiresAt: null, cancelAtPeriodEnd: false, stripeSubscriptionId: null },
        });
        await syncSellerProListings(u.firebaseUid, false);
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
 * Hard-delete a batch of listings, removing their Cloudinary images first so no
 * orphaned images are left behind. Returns counts for logging.
 */
async function deleteListingBatch(listings, where) {
  let deleted = 0, imagesDeleted = 0, errors = 0;
  if (listings.length) configureCloudinary();

  for (const l of listings) {
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
      console.error(`[cron] ${where} failed for`, l._id, err.message);
      captureException(err, { where, listingId: String(l._id) });
      errors++;
    }
  }
  return { deleted, imagesDeleted, errors };
}

/**
 * GET /api/cron/cleanup
 *
 * Reclaims data from listings that are no longer live, removing both the
 * MongoDB document and the Cloudinary images so nothing accumulates:
 *   1. Sold listings   — deleted ~7 days after being marked sold.
 *   2. Abandoned posts — expired and never renewed; deleted ~7 days after they
 *                        expired (so the seller had a full week to renew).
 */
router.get('/cleanup', async (req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const sold = await Listing.find({
    status: 'sold',
    soldAt: { $ne: null, $lt: weekAgo },
  }).select('_id photos').limit(500).lean();

  const abandoned = await Listing.find({
    status: { $ne: 'sold' },
    expiresAt: { $ne: null, $lt: weekAgo }, // expired more than a week ago
  }).select('_id photos').limit(500).lean();

  const soldRes      = await deleteListingBatch(sold,      'cron_cleanup_sold');
  const abandonedRes = await deleteListingBatch(abandoned, 'cron_cleanup_expired');

  // Backstop for the lazy feed-time boost expiry: demote any timed boosts that
  // have lapsed (in case traffic was too low to trigger the lazy sweep).
  let boostsExpired = 0;
  try { boostsExpired = await expireBoosts(); } catch (e) { console.error('[cron] expireBoosts failed:', e.message); }

  const summary = {
    job: 'cleanup',
    sold:      { candidates: sold.length,      ...soldRes },
    abandoned: { candidates: abandoned.length, ...abandonedRes },
    boostsExpired,
  };
  console.log(JSON.stringify(summary));
  res.json({ ok: true, ...summary });
});

module.exports = router;
