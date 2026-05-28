/**
 * featured.js — Featured listing promotion system
 *
 * ─── Phase 1 (NOW) ────────────────────────────────────────────────────────────
 *   Admin-only manual toggle via POST /api/listings/feature/:id.
 *   Featured status is a standalone boolean — completely independent of:
 *     - plan tier (free / basic / pro)
 *     - Stripe subscription status
 *     - any automatic system trigger
 *
 * ─── Phase 2 (FUTURE — not yet implemented) ───────────────────────────────────
 *   Users purchase "boost credits" via a separate Stripe checkout.
 *   Each credit = a fixed number of featured days for one listing.
 *
 *   Schema additions needed:
 *     User:    featuredCredits: { type: Number, default: 0 }
 *     Listing: featuredUntil:   { type: Date,    default: null }
 *              boostType:       { type: String,   default: null }
 *              // 'standard' | 'homepage' | 'search-top'
 *
 *   Routes to add (see listings.js):
 *     POST /api/listings/boost/:id    — deduct credit, set featuredUntil
 *     POST /api/payment/create-checkout-session  type: 'featured_boost'
 *
 *   Jobs needed:
 *     Scheduled cleanup: Listing.updateMany({ featuredUntil: { $lt: new Date() } }, { featured: false, featuredUntil: null })
 *     Run via Vercel Cron or a separate worker.
 *
 *   Boost types (suggested pricing):
 *     'standard'   — 7 days   ₡2,000   appears before non-featured in search
 *     'homepage'   — 3 days   ₡3,500   pinned in the featured section on homepage
 *     'search-top' — 14 days  ₡5,000   pinned at top of all search results
 */

const { isOwner } = require('./plans');

/**
 * Phase 1: Returns true if this actor is allowed to feature a listing.
 * Phase 2: will also return true for users with featuredCredits > 0 (paid boost).
 *
 * @param {object} user   — Mongoose user document (req.dbUser)
 * @param {string} email  — verified email from Firebase token (req.email)
 * @returns {boolean}
 */
function canFeatureListing(user, email) {
  // Admin/owner always can (manual editorial control)
  if (isOwner(email)) return true;

  // Phase 2 hook — uncomment when paid boost is implemented:
  // if (user && (user.featuredCredits ?? 0) > 0) return true;

  return false;
}

/**
 * Phase 2: Returns true if this user has a boost credit they can spend.
 * Currently always false — reserved for paid promotion launch.
 *
 * @param {object} user
 * @returns {boolean}
 */
function hasBoostCredit(user) {
  // Phase 2: return (user?.featuredCredits ?? 0) > 0;
  return false;
}

/**
 * Phase 2: Deduct one boost credit and apply featured status.
 * No-op in Phase 1 — returns false to signal nothing was deducted.
 *
 * @param {string} uid
 * @param {string} listingId
 * @param {string} boostType  'standard' | 'homepage' | 'search-top'
 * @returns {Promise<boolean>}
 */
async function applyBoost(uid, listingId, boostType) {
  // Phase 2 implementation:
  // const User    = require('../models/user.model');
  // const Listing = require('../models/listing.model');
  // const DURATIONS = { standard: 7, homepage: 3, 'search-top': 14 };
  // const days = DURATIONS[boostType] ?? 7;
  // const deducted = await User.findOneAndUpdate(
  //   { firebaseUid: uid, featuredCredits: { $gt: 0 } },
  //   { $inc: { featuredCredits: -1 } }
  // );
  // if (!deducted) return false;
  // const until = new Date();
  // until.setDate(until.getDate() + days);
  // await Listing.findByIdAndUpdate(listingId, { featured: true, featuredUntil: until, boostType });
  // return true;
  return false;
}

module.exports = { canFeatureListing, hasBoostCredit, applyBoost };
