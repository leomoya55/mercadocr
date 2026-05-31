/**
 * routes/payment.js — Stripe Checkout, subscription lifecycle, and webhook.
 *
 * SECURITY MODEL
 *   • Checkout creation requires a verified Firebase token (verifyToken) and a
 *     DB profile (ensureUser). The price is ALWAYS chosen server-side from
 *     config/stripe.js — the client only sends a tier name ('basic'|'pro'|
 *     'single'); it can never influence the amount charged.
 *   • The webhook trusts ONLY Stripe's signature, never the request body shape.
 *   • Idempotency: every event id is recorded in ProcessedEvent before handling;
 *     a duplicate delivery is a no-op. (Stripe delivers at-least-once.)
 *   • Entitlement (`plan`) is written ONLY here (and the cron backstop). There is
 *     no user-facing plan setter anywhere in the app.
 */

const router  = require('express').Router();
const User    = require('../models/user.model');
const ProcessedEvent = require('../models/processedEvent.model');
const { verifyToken } = require('../middleware/auth');
const { ensureUser }  = require('../middleware/ensureUser');
const {
  stripe, PRICE_IDS, hasPriceIds, tierFromSubscription, getPeriodEnd,
} = require('../config/stripe');
const { captureException } = require('../config/sentry');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Get-or-create the single Stripe Customer for an app user.
 *
 * WHY: without this, every checkout created a NEW customer + a NEW subscription,
 * so a user upgrading from Basic→Pro ended up with TWO customers and TWO active
 * subscriptions → double-billed forever. One customer per firebaseUid fixes that
 * and is the anchor for proration upgrades.
 *
 * Concurrency: two simultaneous checkouts for a brand-new user could each create
 * a customer. We guard with an atomic conditional write — only the first writer
 * wins; the loser reuses the stored id (and we best-effort delete its orphan).
 *
 * @returns {Promise<string>} stripeCustomerId
 */
async function getOrCreateCustomer(user) {
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await stripe.customers.create({
    email: user.email || undefined,
    name:  [user.nombre, user.apellido].filter(Boolean).join(' ') || undefined,
    metadata: { firebaseUid: user.firebaseUid },
  });

  // Atomic claim: only set if still null. Prevents a race from overwriting an id
  // another concurrent request already stored.
  const claimed = await User.findOneAndUpdate(
    { firebaseUid: user.firebaseUid, stripeCustomerId: null },
    { $set: { stripeCustomerId: customer.id } },
    { new: true }
  );

  if (claimed) {
    user.stripeCustomerId = customer.id;
    return customer.id;
  }

  // We lost the race — another request already stored a customer. Re-read it and
  // discard the duplicate we just created so Stripe doesn't accumulate orphans.
  const fresh = await User.findOne({ firebaseUid: user.firebaseUid }).select('stripeCustomerId').lean();
  stripe.customers.del(customer.id).catch(() => { /* best-effort cleanup */ });
  return fresh?.stripeCustomerId || customer.id;
}

/**
 * Apply Stripe subscription state to the user doc. Idempotent ($set only) so it's
 * safe to run on every create/update/delete webhook and from the cron backstop.
 * Tier is derived from the active Price ID (authoritative), not from metadata.
 */
async function syncSubscriptionToUser(uid, subscription, { downgrade = false } = {}) {
  if (downgrade) {
    return User.findOneAndUpdate(
      { firebaseUid: uid },
      { $set: {
          plan: 'free',
          subscriptionStatus: subscription?.status || 'canceled',
          stripeSubscriptionId: null,
          currentPeriodEnd: null,
          planExpiresAt: null,
          cancelAtPeriodEnd: false,
      } },
      { new: true }
    );
  }

  const tier = tierFromSubscription(subscription) || 'free';
  const periodEnd = getPeriodEnd(subscription);

  return User.findOneAndUpdate(
    { firebaseUid: uid },
    { $set: {
        plan: tier,
        subscriptionStatus: subscription.status,
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: subscription.customer,
        currentPeriodEnd: periodEnd,
        planExpiresAt: periodEnd, // keep legacy field in sync
        cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
    } },
    { new: true }
  );
}

/**
 * Resolve the firebaseUid for a subscription event. Prefers metadata.uid (set at
 * creation), falls back to a customer-id lookup so we still attribute the event
 * even if metadata is ever missing (e.g. subscriptions created in the dashboard).
 */
async function resolveUid(subscription) {
  if (subscription?.metadata?.uid) return subscription.metadata.uid;
  if (subscription?.customer) {
    const u = await User.findOne({ stripeCustomerId: subscription.customer })
      .select('firebaseUid').lean();
    if (u) return u.firebaseUid;
  }
  return null;
}

// ─── Create Checkout / upgrade ────────────────────────────────────────────────

router.post('/create-checkout-session', verifyToken, ensureUser, async (req, res) => {
  const uid  = req.uid;
  const user = req.dbUser;
  const { type } = req.body;

  if (!type)                                       return res.status(400).json({ error: 'Missing type' });
  if (!['single', 'basic', 'pro'].includes(type))  return res.status(400).json({ error: 'Invalid payment type' });

  // Reject buying the plan you already actively hold (resolver-validated, not the
  // raw stored field — a stale 'pro' that already expired should be re-buyable).
  const { getEffectiveMembership } = require('../config/membership');
  const eff = getEffectiveMembership(user, req.email);
  if (type !== 'single' && eff.plan === type && eff.active) {
    const label = type === 'pro' ? 'Pro' : 'Basic';
    return res.status(400).json({ error: 'already_on_plan', message: `Ya tienes el plan ${label} activo.` });
  }

  const origin = req.headers.origin || `https://${req.headers.host}`;

  try {
    const customerId = await getOrCreateCustomer(user);

    // ── One-time single-post purchase ──────────────────────────────────────
    if (type === 'single') {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        line_items: [{
          price_data: {
            currency: 'crc',
            product_data: {
              name: 'Publicación adicional - MercadoCR',
              description: '1 publicación adicional en MercadoCR.',
            },
            unit_amount: 50000, // ₡500 (CRC has 2 decimal places in Stripe)
          },
          quantity: 1,
        }],
        success_url: `${origin}/publish?payment_success=true&type=single`,
        cancel_url:  `${origin}/publish?payment_canceled=true`,
        // metadata on BOTH the session and the resulting PaymentIntent for safety
        metadata: { uid, type: 'single' },
        payment_intent_data: { metadata: { uid, type: 'single' } },
      });
      return res.json({ id: session.id, url: session.url });
    }

    // ── Subscription tier change on an EXISTING active sub → proration ──────
    // If the user already has a live subscription and is switching tiers, we
    // swap the price on the existing subscription item with proration instead of
    // creating a second subscription (which would double-bill). Requires real
    // Price IDs.
    if (eff.active && user.stripeSubscriptionId && hasPriceIds()) {
      const newPriceId = PRICE_IDS[type];
      const sub  = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
      const itemId = sub.items.data[0]?.id;
      if (itemId) {
        const updated = await stripe.subscriptions.update(user.stripeSubscriptionId, {
          items: [{ id: itemId, price: newPriceId }],
          // Upgrade (basic→pro): charge the prorated difference now.
          // Downgrade (pro→basic): credit the difference to the next invoice.
          proration_behavior: 'create_prorations',
          cancel_at_period_end: false,
          metadata: { uid, type },
        });
        await syncSubscriptionToUser(uid, updated);
        return res.json({ upgraded: true, plan: type }); // no redirect needed
      }
    }

    // ── GUARD: never create a SECOND subscription for an existing subscriber ──
    // We only reach here with an active sub if the in-place proration swap above
    // could NOT run (Price IDs not configured, or the subscription item was
    // missing). Falling through to Checkout below would create a second active
    // subscription → the user is double-billed, and the cancel UI (which uses the
    // single stored stripeSubscriptionId) can never stop the orphaned one. Fail
    // loudly instead. New subscribers (no active sub) skip this and proceed.
    if (eff.active && user.stripeSubscriptionId) {
      console.error('[create-checkout-session] tier change blocked to avoid double-billing — hasPriceIds:', hasPriceIds(), 'sub:', user.stripeSubscriptionId);
      return res.status(409).json({
        error: 'subscription_change_unavailable',
        message: 'No pudimos cambiar tu plan automáticamente. Escríbenos y lo ajustamos manualmente.',
      });
    }

    // ── New subscription via Checkout ──────────────────────────────────────
    // Prefer a persistent Price ID (enables future proration); fall back to
    // inline price_data so checkout still works before Prices are created.
    let lineItem;
    if (hasPriceIds() && PRICE_IDS[type]) {
      lineItem = { price: PRICE_IDS[type], quantity: 1 };
    } else {
      const isPro = type === 'pro';
      lineItem = {
        price_data: {
          currency: 'crc',
          product_data: {
            name: isPro ? 'Suscripción Pro MercadoCR' : 'Suscripción Basic MercadoCR',
            description: isPro
              ? 'Plan Pro mensual con publicaciones ilimitadas.'
              : 'Plan Basic mensual con hasta 25 anuncios activos.',
          },
          unit_amount: isPro ? 1000000 : 500000, // ₡10,000 / ₡5,000
          recurring: { interval: 'month' },
        },
        quantity: 1,
      };
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [lineItem],
      success_url: `${origin}/pricing?payment_success=true&type=${type}`,
      cancel_url:  `${origin}/publish?payment_canceled=true`,
      metadata: { uid, type },
      subscription_data: { metadata: { uid, type } },
    });
    res.json({ id: session.id, url: session.url });
  } catch (error) {
    console.error('[create-checkout-session]', error.message);
    res.status(500).json({ error: 'Failed to create Stripe session' });
  }
});

// ─── Webhook ──────────────────────────────────────────────────────────────────
//
// Mounted with express.raw in server.js (Stripe signature needs the raw bytes).
// This route is excluded from the API rate limiter so Stripe retries are never
// throttled into permanent loss.
//
router.post('/webhook', async (req, res) => {
  const signature = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).send('Webhook secret not configured');

  // 1. Verify signature against the RAW body. Any tampering/replay-with-edits or
  //    a forged event (Blocker: webhook spoofing) fails here.
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  // 2. Idempotency / replay protection. Record the event id FIRST; a duplicate
  //    delivery hits the unique _id constraint and we ack without reprocessing.
  try {
    await ProcessedEvent.create({ _id: event.id, type: event.type });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(200).json({ received: true, duplicate: true });
    }
    // If the ledger write fails for another reason, return 500 so Stripe retries
    // rather than risk processing without a dedup record.
    console.error('[webhook] ProcessedEvent write failed:', err.message);
    return res.status(500).json({ error: 'idempotency store unavailable' });
  }

  // 3. Handle. Any throw → 500 so Stripe retries (and the retry is deduped by the
  //    ledger entry above only if we got that far; a throw here still leaves the
  //    ledger row, so handlers MUST be safe to skip on retry — they are, because
  //    all writes are idempotent $set / guarded $inc).
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        // Single-post one-time payment → grant exactly one credit.
        if (session.mode === 'payment' && session.metadata?.type === 'single') {
          const uid = session.metadata.uid;
          // payment_status guards against async payment methods that complete the
          // session before funds clear.
          if (uid && session.payment_status === 'paid') {
            await User.findOneAndUpdate(
              { firebaseUid: uid },
              { $inc: { singlePostCredits: 1 } }
            );
          }
        }
        // Subscription checkouts are fully handled by the subscription.* events
        // below (which carry the authoritative status + period end).
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const uid = await resolveUid(subscription);
        if (!uid) { console.warn('[webhook] no uid for subscription', subscription.id); break; }

        // A subscription that is canceled/unpaid/incomplete_expired should not
        // grant a tier even if the "updated" event arrives.
        const terminal = ['canceled', 'unpaid', 'incomplete_expired'].includes(subscription.status);
        await syncSubscriptionToUser(uid, subscription, { downgrade: terminal });
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const uid = await resolveUid(subscription);
        if (uid) await syncSubscriptionToUser(uid, subscription, { downgrade: true });
        break;
      }

      case 'invoice.payment_succeeded': {
        // Renewal succeeded → refresh status + period end from the linked sub.
        const invoice = event.data.object;
        const subId = invoice.subscription || invoice.parent?.subscription_details?.subscription;
        if (subId) {
          const subscription = await stripe.subscriptions.retrieve(subId);
          const uid = await resolveUid(subscription);
          if (uid) await syncSubscriptionToUser(uid, subscription);
        }
        break;
      }

      case 'invoice.payment_failed': {
        // Renewal failed. Mark status so the resolver/cron can downgrade once the
        // paid period lapses. We do NOT yank access mid-period — the user already
        // paid for the current period; Stripe Smart Retries may still succeed.
        const invoice = event.data.object;
        const subId = invoice.subscription || invoice.parent?.subscription_details?.subscription;
        if (subId) {
          const subscription = await stripe.subscriptions.retrieve(subId);
          const uid = await resolveUid(subscription);
          if (uid) {
            await User.findOneAndUpdate(
              { firebaseUid: uid },
              { $set: { subscriptionStatus: subscription.status } } // past_due / unpaid
            );
          }
        }
        break;
      }

      default:
        // Unhandled event types are fine — we already ack'd idempotently.
        break;
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[webhook] handler error:', event.type, error.message);
    captureException(error, { where: 'stripe_webhook', eventType: event?.type, eventId: event?.id });
    res.status(500).json({ error: 'Webhook handling failed' });
  }
});

// ─── Cancel (at period end) ───────────────────────────────────────────────────
//
// Correct SaaS semantics: cancellation schedules the sub to stop renewing but
// the user KEEPS access until the period they already paid for ends. The actual
// downgrade happens via customer.subscription.deleted at period end. We do NOT
// set plan:'free' here (the previous code did, robbing users of paid days).
//
router.post('/cancel-subscription', verifyToken, async (req, res) => {
  const uid = req.uid;
  const user = await User.findOne({ firebaseUid: uid })
    .select('stripeSubscriptionId').lean();
  if (!user)                      return res.status(404).json({ error: 'User not found' });
  if (!user.stripeSubscriptionId) return res.status(400).json({ error: 'No active subscription' });

  try {
    const sub = await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    const periodEnd = getPeriodEnd(sub);
    await User.findOneAndUpdate(
      { firebaseUid: uid },
      { $set: { cancelAtPeriodEnd: true, currentPeriodEnd: periodEnd, planExpiresAt: periodEnd } }
    );
    res.json({ success: true, cancelAtPeriodEnd: true, accessUntil: periodEnd });
  } catch (error) {
    console.error('[cancel-subscription]', error.message);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// ─── Resume (undo a scheduled cancellation before period end) ─────────────────
router.post('/resume-subscription', verifyToken, async (req, res) => {
  const uid = req.uid;
  const user = await User.findOne({ firebaseUid: uid })
    .select('stripeSubscriptionId').lean();
  if (!user?.stripeSubscriptionId) return res.status(400).json({ error: 'No subscription' });

  try {
    const sub = await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });
    await User.findOneAndUpdate(
      { firebaseUid: uid },
      { $set: { cancelAtPeriodEnd: false } }
    );
    res.json({ success: true, cancelAtPeriodEnd: false, status: sub.status });
  } catch (error) {
    console.error('[resume-subscription]', error.message);
    res.status(500).json({ error: 'Failed to resume subscription' });
  }
});

module.exports = router;
