/**
 * config/stripe.js — single source of truth for the Stripe client and tier mapping.
 *
 * WHY THIS FILE EXISTS
 *   Every route that touches Stripe must use the SAME pinned API version and the
 *   SAME price→tier mapping. Scattering `require('stripe')(key)` across files risks
 *   version drift (different default API versions → different object shapes) and
 *   duplicated, divergent tier logic. One module, imported everywhere.
 *
 * API VERSION PINNING (production-critical)
 *   We pin `apiVersion` explicitly. Without pinning, a Stripe-side default change
 *   could silently alter webhook payload shapes in production. The pinned value
 *   matches what stripe@18 ships with ('2025-08-27.basil'). In the "basil" line,
 *   `current_period_end` moved OFF the Subscription object ONTO each subscription
 *   item — see getPeriodEnd() below, which reads both locations defensively so the
 *   code survives an API-version bump in either direction.
 */

const Stripe = require('stripe');

const STRIPE_API_VERSION = '2025-08-27.basil';

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: STRIPE_API_VERSION,
  // Stripe's built-in idempotent retries for OUR outbound calls (network blips).
  // Webhook idempotency (their inbound calls to us) is handled separately by the
  // ProcessedEvent collection.
  maxNetworkRetries: 2,
  timeout: 20000, // fail fast on a Vercel function rather than hanging to the 10s/60s limit
});

/**
 * Recurring Price IDs, created once in the Stripe dashboard (or via API) and set
 * as env vars. Persistent Price objects are REQUIRED for proration-based
 * upgrades/downgrades — inline price_data cannot be swapped onto an existing
 * subscription item.
 */
const PRICE_IDS = {
  basic: process.env.STRIPE_PRICE_BASIC || null,
  pro:   process.env.STRIPE_PRICE_PRO   || null,
};

/** True only when both recurring Price IDs are configured. */
function hasPriceIds() {
  return !!(PRICE_IDS.basic && PRICE_IDS.pro);
}

/**
 * Map a Stripe Price ID back to our internal tier. This is the AUTHORITATIVE
 * way to learn what a subscription grants — never trust metadata alone, because
 * metadata can be stale after an upgrade/downgrade swaps the price.
 *
 * @param {string} priceId
 * @returns {'basic'|'pro'|null}
 */
function tierFromPriceId(priceId) {
  if (!priceId) return null;
  if (priceId === PRICE_IDS.basic) return 'basic';
  if (priceId === PRICE_IDS.pro)   return 'pro';
  return null;
}

/**
 * Resolve the paid tier a subscription object grants.
 * Order of trust: active price ID  →  subscription metadata.type  →  null.
 *
 * @param {object} subscription — a Stripe Subscription object
 * @returns {'basic'|'pro'|null}
 */
function tierFromSubscription(subscription) {
  const priceId = subscription?.items?.data?.[0]?.price?.id;
  return tierFromPriceId(priceId) || (subscription?.metadata?.type ?? null);
}

/**
 * Read the current period end from a Subscription, tolerant of API-version
 * differences. basil → on items; pre-basil → on the subscription itself.
 *
 * @param {object} subscription
 * @returns {Date|null}
 */
function getPeriodEnd(subscription) {
  if (!subscription) return null;
  if (subscription.current_period_end) {
    return new Date(subscription.current_period_end * 1000);
  }
  const item = subscription.items?.data?.[0];
  if (item?.current_period_end) {
    return new Date(item.current_period_end * 1000);
  }
  return null;
}

/** Stripe statuses that mean "this subscription currently entitles the user". */
const ACTIVE_STATUSES = new Set(['active', 'trialing']);

module.exports = {
  stripe,
  STRIPE_API_VERSION,
  PRICE_IDS,
  hasPriceIds,
  tierFromPriceId,
  tierFromSubscription,
  getPeriodEnd,
  ACTIVE_STATUSES,
};
