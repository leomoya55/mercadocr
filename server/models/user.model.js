const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    firebaseUid:          { type: String, required: true, unique: true },
    email:                { type: String, required: true },
    // Public handle for the seller's public profile (/perfil?u=username). Derived
    // from the email local-part (the text before '@'), sanitized and made unique
    // with a numeric suffix on collision. Lowercased. See generateUsername() in
    // routes/users.js. Other users search and view sellers by this handle.
    username:             { type: String, default: '' },
    nombre:               { type: String, default: '' },
    apellido:             { type: String, default: '' },
    // Optional profile picture (Cloudinary secure_url in the mercadocr/avatars
    // folder). '' = no photo → the UI falls back to an initial-letter avatar.
    photoURL:             { type: String, default: '' },
    phone:                { type: String, default: '' },
    provincia:            { type: String, default: '' },
    plan:                 { type: String, enum: ['free', 'basic', 'pro'], default: 'free' },
    // True when an admin manually granted this paid plan as a comp (no Stripe
    // subscription). Comped plans never expire and are skipped by the downgrade
    // cron. Purchased plans leave this false and must renew via Stripe.
    compedPlan:           { type: Boolean, default: false },
    freeListingUsed:      { type: Boolean, default: false },
    singlePostCredits:    { type: Number, default: 0, min: 0 },
    listingsCount:        { type: Number, default: 0 },

    // ─── Referrals ──────────────────────────────────────────────────────────
    // referredBy: firebaseUid of the member whose invite link this user signed up
    // with. Set EXACTLY ONCE, at (or just after) signup — see POST /ensure. Once
    // non-empty it is locked, so a referral can never be re-attributed or
    // double-counted. '' = organic signup / no referrer.
    referredBy:           { type: String, default: '' },
    // Lifetime number of users who signed up with this member's invite link.
    // Denormalized counter, incremented atomically when a referral is attributed.
    referralCount:        { type: Number, default: 0, min: 0 },

    // ─── Stripe / subscription state ────────────────────────────────────────
    // These are a CACHE of Stripe's state, written ONLY by the webhook and the
    // cron backstop. Never read `plan` directly for entitlement decisions — use
    // config/membership.js → getEffectiveMembership(), which validates these
    // fields so a missed webhook can't grant indefinite free access.
    stripeCustomerId:     { type: String, default: null },
    stripeSubscriptionId: { type: String, default: null },
    subscriptionStatus:   { type: String, default: null }, // active|trialing|past_due|canceled|unpaid|incomplete|incomplete_expired|paused
    currentPeriodEnd:     { type: Date,   default: null }, // canonical paid-through date
    cancelAtPeriodEnd:    { type: Boolean, default: false },
    planExpiresAt:        { type: Date,   default: null }, // LEGACY: kept in sync for old data; prefer currentPeriodEnd

    createdAt:            { type: Date, default: Date.now },
}, {
    timestamps: true, // adds updatedAt; createdAt above is preserved for legacy data
});

// ─── Indexes (created via syncIndexes in a guarded startup migration; autoIndex
//     is disabled in production — see server.js) ─────────────────────────────

// Email uniqueness — the dedup_users_by_email_v1 migration already removed dupes.
userSchema.index({ email: 1 }, { unique: true });

// Public username uniqueness, only for users that actually have one (the field
// defaults to '' until backfilled/generated). A plain unique index would collide
// on every empty-string default, so we index only non-empty string usernames.
userSchema.index(
  { username: 1 },
  { unique: true, partialFilterExpression: { username: { $type: 'string', $gt: '' } } }
);

// Phone uniqueness, but ONLY for real (non-empty) phone numbers. A plain unique
// index would collide on the many users whose phone is '' (the schema default).
// partialFilterExpression indexes only documents with a non-empty string phone.
userSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string', $gt: '' } } }
);

// Stripe lookups (webhook fallback path) — unique where present.
userSchema.index(
  { stripeCustomerId: 1 },
  { unique: true, partialFilterExpression: { stripeCustomerId: { $type: 'string' } } }
);
userSchema.index(
  { stripeSubscriptionId: 1 },
  { unique: true, partialFilterExpression: { stripeSubscriptionId: { $type: 'string' } } }
);

// Cron backstop scans for paid users whose period has lapsed.
userSchema.index({ plan: 1, currentPeriodEnd: 1 });

// Referral lookups: list everyone a given member referred (admin) — sparse-ish
// since most rows have referredBy = ''.
userSchema.index({ referredBy: 1 });

module.exports = mongoose.model('User', userSchema);
