/**
 * Centralized plan configuration — single source of truth for all limit logic.
 * Import this everywhere plan limits, labels, or the owner check are needed.
 */

const OWNER_EMAIL = (process.env.FOUNDER_EMAIL || 'leomoyawr300@gmail.com').toLowerCase().trim();

/**
 * Plan definitions.
 * maxListings: Infinity means the backend never rejects on count alone.
 */
const PLANS = {
  free:  { maxListings: 3,        label: 'Gratis', featured: false },
  basic: { maxListings: 25,       label: 'Basic',  featured: false },
  pro:   { maxListings: Infinity, label: 'Pro',    featured: true  },
};

/**
 * Numeric rank used by requirePlan() to compare tiers.
 * Higher = more privileged.
 */
const PLAN_RANK = { free: 0, basic: 1, pro: 2 };

/**
 * Returns the config object for a given plan key.
 * Falls back to 'free' for any unknown value.
 */
function getPlan(planKey) {
  return PLANS[planKey] || PLANS.free;
}

/**
 * Returns true if the email belongs to the platform owner.
 * Owner always bypasses plan limits.
 */
function isOwner(email) {
  return (email || '').toLowerCase().trim() === OWNER_EMAIL;
}

module.exports = { PLANS, PLAN_RANK, OWNER_EMAIL, getPlan, isOwner };
