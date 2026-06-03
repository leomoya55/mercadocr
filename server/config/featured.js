/**
 * featured.js — Featured / boosted listing promotion system.
 *
 * A "boost" is a paid, time-limited promotion bought per listing. While active:
 *   • the listing's `featured` flag is true → it sorts above normal listings and
 *     ranks higher in search, and shows a "Destacado" badge;
 *   • `featuredUntil` holds the expiry; the boost-expiry sweep clears `featured`
 *     once it lapses.
 *
 * Editorial featuring (admin) is the same `featured` flag but with
 * featuredUntil === null, so it never auto-expires.
 *
 * SCALABILITY: add a new package to BOOST_PACKAGES and it immediately works
 * end-to-end (pricing, checkout, apply, admin) — no other code changes needed.
 * Amounts are in Stripe's minor units for CRC (×100), matching routes/payment.js.
 */

const BOOST_PACKAGES = {
  '24h': { label: 'Destacado 24 horas', days: 1,  amount: 50000  }, // ₡500
  '7d':  { label: 'Destacado 7 días',   days: 7,  amount: 150000 }, // ₡1,500
  '30d': { label: 'Destacado 30 días',  days: 30, amount: 400000 }, // ₡4,000
};

const { isOwner } = require('./plans');

/** True if `type` is a known boost package. */
function isBoostType(type) {
  return Object.prototype.hasOwnProperty.call(BOOST_PACKAGES, type);
}

/** Package definition for a boost type, or null. */
function getBoostPackage(type) {
  return BOOST_PACKAGES[type] || null;
}

/**
 * Admin/editorial feature gate (manual toggle via the admin panel).
 * Paid boosts do NOT go through here — they're applied by the Stripe webhook
 * after payment (see applyBoost).
 */
function canFeatureListing(user, email) {
  return isOwner(email);
}

/**
 * Apply a paid boost to a listing. Called from the Stripe webhook AFTER payment
 * is confirmed. Idempotent-ish: re-applying extends from "now", which is the
 * desired behavior if a user buys a second boost.
 *
 * Safety: only boosts a listing that exists, belongs to `uid`, and is not hidden.
 * Returns the updated listing, or null if nothing matched (caller can log/refund).
 *
 * @param {string} listingId
 * @param {string} uid        Firebase UID of the buyer (must own the listing)
 * @param {string} boostType  key of BOOST_PACKAGES
 * @returns {Promise<object|null>}
 */
async function applyBoost(listingId, uid, boostType) {
  const pkg = getBoostPackage(boostType);
  if (!pkg) return null;

  const Listing = require('../models/listing.model');
  const now = new Date();
  // Stack on top of any remaining time so a user is never shortchanged: if the
  // listing is already boosted into the future, extend from that point.
  const current = await Listing.findOne({ _id: listingId, author: uid })
    .select('featuredUntil').lean();
  if (!current) return null;
  const base = (current.featuredUntil && new Date(current.featuredUntil) > now)
    ? new Date(current.featuredUntil)
    : now;
  const until = new Date(base.getTime() + pkg.days * 24 * 60 * 60 * 1000);

  return Listing.findOneAndUpdate(
    { _id: listingId, author: uid, hidden: { $ne: true } },
    { $set: {
        featured: true,
        featuredUntil: until,
        boostType,
        boostPurchaseDate: now,
    } },
    { new: true }
  );
}

/**
 * Clear lapsed timed boosts. Editorial features (featuredUntil === null) are left
 * untouched. Returns the number of listings demoted. Cheap + indexed
 * ({ featuredUntil: 1 }); typically matches 0 rows.
 *
 * Called both lazily from the public feed (self-healing, so a 24h boost expires
 * on time regardless of cron cadence) and from the daily cron as a backstop.
 */
async function expireBoosts() {
  const Listing = require('../models/listing.model');
  const res = await Listing.updateMany(
    { featured: true, featuredUntil: { $ne: null, $lte: new Date() } },
    { $set: { featured: false, featuredUntil: null } }
  );
  return res.modifiedCount || 0;
}

module.exports = {
  BOOST_PACKAGES,
  isBoostType,
  getBoostPackage,
  canFeatureListing,
  applyBoost,
  expireBoosts,
};
