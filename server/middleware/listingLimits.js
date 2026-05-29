/**
 * Listing-limit middleware and helpers.
 *
 * enforceListingLimit — middleware for POST /listings/add
 *   Runs after verifyToken + ensureUser (needs req.uid, req.dbUser).
 *   Counts active listings from the DB — never trusts a stored counter.
 *   Falls back to singlePostCredits when the plan limit is exceeded.
 *   Returns 402 with a structured error body when no capacity remains.
 *   Sets req.activeListingCount so the handler can skip a second count.
 *
 * requirePlan(minPlan) — middleware factory
 *   Gates a route to users on a specific plan tier or above.
 *   e.g. requirePlan('basic') rejects free-plan users with 403.
 *
 * getActiveCount(uid) — exported helper
 *   Returns the live count of non-sold listings for a user.
 *   Uses the compound index { author: 1, status: 1 } for speed.
 */

const Listing = require('../models/listing.model');
const User    = require('../models/user.model');
const { getPlan, PLAN_RANK } = require('../config/plans');
const { getEffectiveMembership } = require('../config/membership');

// ─── Core count helper ────────────────────────────────────────────────────────

/**
 * Count a user's active (non-sold) listings.
 * Relies on the compound index { author: 1, status: 1 } in listing.model.js.
 *
 * @param {string} uid — Firebase UID
 * @returns {Promise<number>}
 */
async function getActiveCount(uid) {
  return Listing.countDocuments({ author: uid, status: { $ne: 'sold' } });
}

// ─── enforceListingLimit ──────────────────────────────────────────────────────

const enforceListingLimit = async (req, res, next) => {
  try {
    const uid  = req.uid;
    const user = req.dbUser; // guaranteed by ensureUser middleware

    // Resolve the REAL entitlement — never the raw stored user.plan. A user whose
    // Pro subscription lapsed (missed webhook, failed renewal) resolves to 'free'
    // here and is correctly held to the free limit.
    const eff       = getEffectiveMembership(user, req.email);
    const plan      = getPlan(eff.plan);
    const maxAllowed = plan.maxListings;

    // Expose resolution to the handler for post-insert race reconciliation.
    req.effPlan     = eff.plan;
    req.maxListings = maxAllowed;

    // Unlimited tiers (pro / owner) skip the count comparison.
    if (maxAllowed === Infinity) {
      req.activeListingCount = await getActiveCount(uid);
      return next();
    }

    const activeCount = await getActiveCount(uid);
    req.activeListingCount = activeCount;

    // Within plan limit — proceed.
    if (activeCount < maxAllowed) {
      return next();
    }

    // Over plan limit — consume a single-post credit (atomic, race-safe).
    if (user.singlePostCredits > 0) {
      const decremented = await User.findOneAndUpdate(
        { firebaseUid: uid, singlePostCredits: { $gt: 0 } },
        { $inc: { singlePostCredits: -1 } },
        { new: true }
      );
      if (decremented) {
        req.usedCredit = true; // handler refunds this if the listing fails to save
        return next();
      }
    }

    // No capacity left.
    return res.status(402).json({
      error:       'Listing limit reached for your plan',
      code:        'LIMIT_REACHED',
      plan:        eff.plan,
      maxListings: maxAllowed,
      activeCount,
      remaining:   0,
    });
  } catch (err) {
    console.error('[enforceListingLimit] ERROR:', err.name, '|', err.message);
    res.status(500).json({ error: err.message, code: 'LIMIT_CHECK_FAILED' });
  }
};

/**
 * Refund a single-post credit. Called by the POST /add handler when a listing
 * fails to save AFTER enforceListingLimit consumed a credit, so the user never
 * loses ₡500 for a post that never existed.
 */
async function refundCreditIfUsed(req) {
  if (req.usedCredit) {
    await User.findOneAndUpdate(
      { firebaseUid: req.uid },
      { $inc: { singlePostCredits: 1 } }
    ).catch(e => console.error('[refundCreditIfUsed]', e.message));
    req.usedCredit = false;
  }
}

// ─── requirePlan ─────────────────────────────────────────────────────────────

/**
 * Middleware factory: rejects requests from users below the required plan tier.
 *
 * Usage:
 *   router.post('/route', verifyToken, ensureUser, requirePlan('basic'), handler)
 *
 * @param {'free'|'basic'|'pro'} minPlan
 */
function requirePlan(minPlan) {
  return (req, res, next) => {
    const user = req.dbUser;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Resolver-derived rank (owner → pro; expired paid → free).
    const eff      = getEffectiveMembership(user, req.email);
    const minRank  = PLAN_RANK[minPlan] ?? 0;

    if (eff.rank >= minRank) return next();

    return res.status(403).json({
      error:        'Plan upgrade required',
      code:         'UPGRADE_REQUIRED',
      requiredPlan: minPlan,
      currentPlan:  eff.plan,
    });
  };
}

module.exports = { getActiveCount, enforceListingLimit, requirePlan, refundCreditIfUsed };
