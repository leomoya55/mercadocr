/**
 * config/membership.js — the ONE place that decides what a user is actually
 * entitled to right now. No route may read `user.plan` directly anymore.
 *
 * WHY A RESOLVER INSTEAD OF user.plan
 *   `user.plan` is a CACHE written by webhooks. It can be stale or wrong:
 *     • The `customer.subscription.deleted` webhook can be missed (network blip,
 *       a 5xx during a deploy, the event delivered while the function was cold).
 *     • A renewal payment can fail → Stripe marks the sub past_due/unpaid, but
 *       no "deleted" event fires until Stripe finally cancels it days later.
 *     • Clocks drift; a cron downgrade may not have run yet.
 *   If routes trusted `user.plan`, any of the above = a user keeping Pro for free
 *   indefinitely. The resolver re-derives the truth from the persisted Stripe
 *   state (status + period end) on every call, so a single missed webhook can
 *   never grant unlimited free access. The daily cron (routes/cron.js) is a
 *   second backstop that also writes the corrected value back to the DB.
 *
 * SOURCE OF TRUTH PRECEDENCE
 *   1. Owner email           → always 'pro'.
 *   2. Stored free           → 'free'.
 *   3. Paid tier, BUT only if subscriptionStatus is active/trialing AND the paid
 *      period has not ended (with a small grace for webhook/clock lag).
 *   4. Otherwise             → 'free' (expired / past_due / canceled / unknown).
 */

const { isOwner, getPlan, PLAN_RANK } = require('./plans');
const { ACTIVE_STATUSES }             = require('./stripe');

/**
 * Grace window applied to currentPeriodEnd. Covers the gap between the real
 * renewal moment and the `customer.subscription.updated` webhook that pushes the
 * new period end into our DB, plus minor clock skew. Without it, an active,
 * paying user could be downgraded for a few minutes every billing cycle.
 *
 * It is intentionally SHORT — long enough to absorb webhook lag, short enough
 * that a genuinely lapsed user loses access within a day.
 */
const PERIOD_END_GRACE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Resolve a user's effective membership.
 *
 * @param {object} user        — Mongoose User doc or lean object.
 * @param {string} [emailHint] — verified email from the Firebase token. Pass it
 *                               when available (req.email) so the owner check
 *                               uses the cryptographically-verified email rather
 *                               than the stored one.
 * @returns {{
 *   plan: 'free'|'basic'|'pro',
 *   rank: number,
 *   isOwner: boolean,
 *   active: boolean,            // true if a PAID tier is currently entitled
 *   status: string|null,        // raw Stripe status, for display/debug
 *   currentPeriodEnd: Date|null,
 *   cancelAtPeriodEnd: boolean,
 *   expired: boolean,           // stored a paid tier but it's no longer valid
 *   reason: string              // why we resolved to this plan (for logging)
 * }}
 */
function getEffectiveMembership(user, emailHint) {
  const email = (emailHint || user?.email || '').toLowerCase().trim();

  // 1. Owner always Pro — independent of any Stripe state.
  if (isOwner(email)) {
    return result('pro', { isOwner: true, active: true, reason: 'owner' });
  }

  const storedPlan = user?.plan || 'free';

  // 2. Free stays free.
  if (storedPlan === 'free') {
    return result('free', { reason: 'stored_free' });
  }

  // 3. Paid tier — validate against the persisted Stripe state.
  const status = user?.subscriptionStatus || null;
  // currentPeriodEnd is the canonical field; planExpiresAt is the legacy field
  // written by the old webhook. Prefer the new one, fall back for old data.
  const periodEnd = user?.currentPeriodEnd || user?.planExpiresAt || null;
  const cancelAtPeriodEnd = !!user?.cancelAtPeriodEnd;

  const statusOk = status ? ACTIVE_STATUSES.has(status) : true; // null status = legacy data, don't punish
  const periodOk = periodEnd
    ? (new Date(periodEnd).getTime() + PERIOD_END_GRACE_MS) > Date.now()
    : true; // no period stored = legacy data, don't punish

  if (statusOk && periodOk) {
    return result(storedPlan, {
      active: true,
      status,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd,
      reason: 'paid_active',
    });
  }

  // 4. Stored a paid tier but it's no longer valid → effective free.
  return result('free', {
    status,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd,
    expired: true,
    reason: !statusOk ? `status_${status}` : 'period_ended',
  });
}

/** Build the canonical result object with sane defaults. */
function result(plan, extra = {}) {
  return {
    plan,
    rank: PLAN_RANK[plan] ?? 0,
    isOwner: false,
    active: false,
    status: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    expired: false,
    reason: 'unknown',
    maxListings: getPlan(plan).maxListings,
    ...extra,
  };
}

module.exports = { getEffectiveMembership, PERIOD_END_GRACE_MS };
