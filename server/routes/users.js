const router   = require('express').Router();
const User     = require('../models/user.model');
const Listing  = require('../models/listing.model');
const { verifyToken }            = require('../middleware/auth');
const { ensureUser }             = require('../middleware/ensureUser');
const { getActiveCount }          = require('../middleware/listingLimits');
const { getPlan, isOwner }        = require('../config/plans');
const { getEffectiveMembership }  = require('../config/membership');

// ─── Shared helper: build the profile response payload ───────────────────────

async function buildProfileResponse(uid, user, email) {
  const listingCount = await getActiveCount(uid);
  // Report the RESOLVED plan, not the stored one — an expired/lapsed paid plan
  // must surface as free so the UI and the user agree with backend enforcement.
  const eff          = getEffectiveMembership(user, email);
  const plan         = getPlan(eff.plan);
  const credits      = user.singlePostCredits || 0;
  const maxListings  = plan.maxListings === Infinity ? null : plan.maxListings;
  const remaining    = maxListings === null ? null : Math.max(0, maxListings - listingCount);

  return {
    user,
    plan: eff.plan,                      // canonical resolved tier
    effective: {                         // richer state for the UI
      plan: eff.plan,
      active: eff.active,
      status: eff.status,
      currentPeriodEnd: eff.currentPeriodEnd,
      cancelAtPeriodEnd: eff.cancelAtPeriodEnd,
    },
    listingCount, remaining, maxListings, credits,
  };
}

// ─── Public ──────────────────────────────────────────────────────────────────

// GET /phone-check — returns { available: bool }
router.get('/phone-check', async (req, res) => {
  try {
    const phone = (req.query.phone || '').trim();
    if (!phone) return res.json({ available: true });
    const exists = await User.findOne({ phone }).select('_id').lean();
    res.json({ available: !exists });
  } catch {
    res.json({ available: true }); // fail open — server re-validates on profile save
  }
});

// GET /public/:uid — seller info shown on listing detail pages
router.get('/public/:uid', async (req, res) => {
  try {
    const user = await User.findOne({ firebaseUid: req.params.uid })
      .select('nombre apellido phone provincia -_id').lean();
    if (!user) return res.status(404).json('User not found');
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /me — primary authenticated endpoints ───────────────────────────────────

/**
 * GET /me
 * Returns full profile + active listing count + remaining slots.
 * ensureUser upserts the profile if it doesn't exist yet.
 */
router.get('/me', verifyToken, ensureUser, async (req, res) => {
  try {
    res.json(await buildProfileResponse(req.uid, req.dbUser, req.email));
  } catch (err) {
    console.error('[GET /me]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /me/profile
 * Update nombre, apellido, phone, provincia.
 * Enforces phone uniqueness across all accounts.
 * Also back-fills the seller's active listings so contact/provincia stay in sync.
 */
router.put('/me/profile', verifyToken, ensureUser, async (req, res) => {
  try {
    const uid        = req.uid;
    const { nombre, apellido, phone, provincia } = req.body;
    const cleanPhone = (phone || '').trim();

    // ── Phone is LOCKED once set ────────────────────────────────────────────
    // The phone number is the seller's WhatsApp shown on every listing, so it's
    // treated as semi-immutable: a user may set it once if it's currently empty,
    // but cannot change it afterward through self-service (prevents account
    // hijack / contact-swap scams and bait-and-switch listings). Changes are
    // handled manually via support. Enforced here on the SERVER — the readonly
    // field in settings.html is only a UX hint and can be bypassed.
    const hasPhone   = !!(req.dbUser?.phone && req.dbUser.phone.trim());
    const wantsPhone = phone !== undefined && cleanPhone !== (req.dbUser?.phone || '').trim();
    if (hasPhone && wantsPhone) {
      return res.status(403).json({
        error: 'phone_locked',
        message: 'El número de teléfono no se puede cambiar aquí. Escríbenos a soporte para modificarlo.',
      });
    }

    // Only run the uniqueness check when we will actually write a (new) phone.
    const willSetPhone = !hasPhone && !!cleanPhone;
    if (willSetPhone) {
      const conflict = await User.findOne({ phone: cleanPhone, firebaseUid: { $ne: uid } })
        .select('_id').lean();
      if (conflict) {
        return res.status(409).json({ error: 'Este número ya está registrado por otra cuenta.' });
      }
    }

    const set = {};
    if (nombre    !== undefined) set.nombre    = nombre;
    if (apellido  !== undefined) set.apellido  = apellido;
    if (willSetPhone)            set.phone     = cleanPhone;
    if (provincia !== undefined) set.provincia = provincia;

    const updated = await User.findOneAndUpdate(
      { firebaseUid: uid },
      { $set: set },
      { new: true }
    );

    // ── Back-fill active listings that still have empty contact/provincia ──
    // Runs fire-and-forget so it never blocks the settings save response.
    // Only touches listings where the field is currently blank — never overwrites
    // a non-empty value (respects any per-listing overrides set elsewhere).
    // Uses the user's effective phone (newly set OR the existing locked one).
    const effectivePhone = willSetPhone ? cleanPhone : (req.dbUser?.phone || '').trim();
    const listingSync = {};
    if (effectivePhone) listingSync.contact  = effectivePhone;
    if (provincia)      listingSync.provincia = provincia;

    if (Object.keys(listingSync).length) {
      const orClauses = [];
      if (effectivePhone) orClauses.push({ contact:  { $in: ['', null] } });
      if (provincia)      orClauses.push({ provincia: { $in: ['', null] } });

      Listing.updateMany(
        { author: uid, status: { $ne: 'sold' }, $or: orClauses },
        { $set: listingSync }
      ).catch(e => console.warn('[PUT /me/profile] listing sync failed:', e.message));
    }

    res.json({ user: updated });
  } catch (err) {
    console.error('[PUT /me/profile]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── /ensure — stores full registration data atomically ──────────────────────

/**
 * POST /ensure
 * Called by register.js right after Firebase account creation.
 * Uses findOneAndUpdate + upsert — never a separate find + create.
 * Back-fills any missing profile fields for existing accounts.
 */
router.post('/ensure', verifyToken, async (req, res) => {
  try {
    const uid        = req.uid;
    const email      = req.email || (req.body.email || '');
    const { nombre, apellido, phone, provincia } = req.body;
    const owner      = isOwner(req.email) || isOwner(email);
    const cleanPhone = (phone || '').trim();

    // Phone uniqueness check before any write
    if (cleanPhone) {
      const conflict = await User.findOne({ phone: cleanPhone, firebaseUid: { $ne: uid } })
        .select('_id').lean();
      if (conflict) {
        return res.status(409).json({ error: 'Este número ya está registrado por otra cuenta.' });
      }
    }

    // Atomic upsert — $setOnInsert only fires when inserting a new document
    let user;
    try {
      user = await User.findOneAndUpdate(
        { firebaseUid: uid },
        {
          $setOnInsert: {
            email,
            nombre:            nombre    || '',
            apellido:          apellido  || '',
            phone:             cleanPhone,
            provincia:         provincia || '',
            plan:              owner ? 'pro' : 'free',
            singlePostCredits: 0,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch (err) {
      // E11000: a profile with this email already exists under a DIFFERENT
      // firebaseUid (e.g. the user deleted their Firebase account and is
      // re-registering with the same email, but the old DB doc lingers). The
      // token's email is verified → same person. Reclaim that doc by re-pointing
      // it to the new uid instead of failing registration with a 500. The
      // back-fill below then fills in the freshly-submitted name/phone/provincia.
      if (err && err.code === 11000 && email) {
        user = await User.findOneAndUpdate(
          { email, firebaseUid: { $ne: uid } },
          { $set: { firebaseUid: uid, ...(owner ? { plan: 'pro' } : {}) } },
          { new: true }
        );
      }
      if (!user) throw err; // not a reclaimable collision — surface the real error
    }

    // For existing users: back-fill any registration fields that are still empty
    const toSet = {};
    if (nombre     && !user.nombre)    toSet.nombre    = nombre;
    if (apellido   && !user.apellido)  toSet.apellido  = apellido;
    if (cleanPhone && !user.phone)     toSet.phone     = cleanPhone;
    if (provincia  && !user.provincia) toSet.provincia = provincia;
    if (owner && user.plan !== 'pro')  toSet.plan      = 'pro';

    if (Object.keys(toSet).length) {
      user = await User.findOneAndUpdate(
        { firebaseUid: uid },
        { $set: toSet },
        { new: true }
      );
    }

    res.json({ user });
  } catch (err) {
    console.error('[ensure]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Legacy routes (backwards compatibility) ──────────────────────────────────

// GET /:uid — same payload as /me, verifies caller owns the profile
router.get('/:uid', verifyToken, ensureUser, async (req, res) => {
  try {
    if (req.uid !== req.params.uid) return res.status(403).json('Forbidden');
    res.json(await buildProfileResponse(req.uid, req.dbUser, req.email));
  } catch (err) {
    console.error('[GET /:uid]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /:uid/profile — same logic as /me/profile (legacy route)
router.put('/:uid/profile', verifyToken, ensureUser, async (req, res) => {
  try {
    if (req.uid !== req.params.uid) return res.status(403).json('Forbidden');
    const uid        = req.uid;
    const { nombre, apellido, phone, provincia } = req.body;
    const cleanPhone = (phone || '').trim();

    // Phone is LOCKED once set — settable once when empty, never changed via
    // self-service afterward. See /me/profile above for the full rationale.
    const hasPhone   = !!(req.dbUser?.phone && req.dbUser.phone.trim());
    const wantsPhone = phone !== undefined && cleanPhone !== (req.dbUser?.phone || '').trim();
    if (hasPhone && wantsPhone) {
      return res.status(403).json({
        error: 'phone_locked',
        message: 'El número de teléfono no se puede cambiar aquí. Escríbenos a soporte para modificarlo.',
      });
    }

    const willSetPhone = !hasPhone && !!cleanPhone;
    if (willSetPhone) {
      const conflict = await User.findOne({ phone: cleanPhone, firebaseUid: { $ne: uid } })
        .select('_id').lean();
      if (conflict) {
        return res.status(409).json({ error: 'Este número ya está registrado por otra cuenta.' });
      }
    }

    const set = {};
    if (nombre    !== undefined) set.nombre    = nombre;
    if (apellido  !== undefined) set.apellido  = apellido;
    if (willSetPhone)            set.phone     = cleanPhone;
    if (provincia !== undefined) set.provincia = provincia;

    const updated = await User.findOneAndUpdate(
      { firebaseUid: uid },
      { $set: set },
      { new: true }
    );

    // Back-fill active listings with empty contact/provincia (same as /me/profile)
    const effectivePhone = willSetPhone ? cleanPhone : (req.dbUser?.phone || '').trim();
    const listingSync = {};
    if (effectivePhone) listingSync.contact  = effectivePhone;
    if (provincia)      listingSync.provincia = provincia;

    if (Object.keys(listingSync).length) {
      const orClauses = [];
      if (effectivePhone) orClauses.push({ contact:  { $in: ['', null] } });
      if (provincia)      orClauses.push({ provincia: { $in: ['', null] } });

      Listing.updateMany(
        { author: uid, status: { $ne: 'sold' }, $or: orClauses },
        { $set: listingSync }
      ).catch(e => console.warn('[PUT /:uid/profile] listing sync failed:', e.message));
    }

    res.json({ user: updated });
  } catch (err) {
    console.error('[PUT /:uid/profile]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Plan mutation is INTENTIONALLY not exposed here ──────────────────────────
//
// SECURITY: There is deliberately NO user-facing endpoint to set `plan`,
// `planExpiresAt`, `stripeCustomerId`, or `stripeSubscriptionId`. The only
// writers of those fields are:
//   1. The Stripe webhook (server/routes/payment.js) — the source of truth.
//   2. The admin route (server/routes/admin.js) — manual owner grants.
//
// A previous `PUT /:uid/plan` route let any authenticated user set their OWN
// plan to 'pro' (the guard only blocked editing OTHER users), which completely
// bypassed payment. It was removed. Do not re-add a self-serve plan setter.

module.exports = router;
