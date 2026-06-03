const router   = require('express').Router();
const User     = require('../models/user.model');
const Listing  = require('../models/listing.model');
const { verifyToken }            = require('../middleware/auth');
const { ensureUser }             = require('../middleware/ensureUser');
const { getActiveCount }          = require('../middleware/listingLimits');
const { getPlan, isOwner }        = require('../config/plans');
const { getEffectiveMembership }  = require('../config/membership');

// ─── Public username (handle) helpers ────────────────────────────────────────

/**
 * Derive a clean handle from an email local-part (the text before '@').
 * Lowercased, restricted to [a-z0-9._-], with collapsed/trimmed separators.
 * Returns 'usuario' when nothing usable remains.
 */
function slugFromEmail(email) {
  const local = String(email || '').split('@')[0].toLowerCase();
  let slug = local
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9._-]+/g, '')                     // allowed chars only
    .replace(/[._-]{2,}/g, '.')                        // collapse runs of separators
    .replace(/^[._-]+|[._-]+$/g, '');                  // trim leading/trailing separators
  return slug || 'usuario';
}

/**
 * Generate a unique username for a user, derived from their email. On collision,
 * appends -2, -3, … until free. Excludes the user's own doc so it's idempotent.
 * Returns the chosen username (does NOT persist it).
 */
async function generateUsername(email, excludeUid) {
  const base = slugFromEmail(email);
  let candidate = base;
  let n = 1;
  // Bounded loop — in practice resolves on the first 1–2 tries.
  while (n < 1000) {
    const clash = await User.findOne({
      username: candidate,
      ...(excludeUid ? { firebaseUid: { $ne: excludeUid } } : {}),
    }).select('_id').lean();
    if (!clash) return candidate;
    n += 1;
    candidate = base + '-' + n;
  }
  // Extremely unlikely fallback — append a short random suffix.
  return base + '-' + Math.random().toString(36).slice(2, 7);
}

/**
 * Ensure a user document has a username, generating + persisting one if missing.
 * Best-effort and self-healing: safe to call on every authenticated request.
 * Returns the (possibly newly set) username.
 */
async function ensureUsername(user) {
  if (user && user.username) return user.username;
  if (!user || !user.firebaseUid) return '';
  const username = await generateUsername(user.email, user.firebaseUid);
  try {
    await User.updateOne({ firebaseUid: user.firebaseUid, $or: [{ username: '' }, { username: { $exists: false } }] }, { $set: { username } });
    user.username = username;
  } catch (e) {
    // Unique-index race: another request set it first. Re-read and use that.
    if (e && e.code === 11000) {
      const fresh = await User.findOne({ firebaseUid: user.firebaseUid }).select('username').lean();
      if (fresh && fresh.username) { user.username = fresh.username; return fresh.username; }
    } else {
      console.warn('[ensureUsername] failed:', e.message);
    }
  }
  return user.username || '';
}

// ─── Shared helper: build the profile response payload ───────────────────────

async function buildProfileResponse(uid, user, email) {
  // Self-healing: make sure this user has a public handle for their profile.
  await ensureUsername(user);
  const listingCount = await getActiveCount(uid);
  // Report the RESOLVED plan, not the stored one — an expired/lapsed paid plan
  // must surface as free so the UI and the user agree with backend enforcement.
  const eff          = getEffectiveMembership(user, email);
  const plan         = getPlan(eff.plan);
  const credits      = user.singlePostCredits || 0;
  const maxListings  = plan.maxListings === Infinity ? null : plan.maxListings;
  const remaining    = maxListings === null ? null : Math.max(0, maxListings - listingCount);

  // ── Downgrade grandfathering (Option A) ──────────────────────────────────────
  // When a paid plan lapses/downgrades, the user keeps ALL existing listings live
  // (we never archive). But they have more active listings than the new plan
  // allows, so they can't create new ones until they upgrade or reduce. Surface
  // that state explicitly so the UI can show a clear, non-alarming banner instead
  // of a bare "limit reached" error.
  const overLimit = maxListings !== null && listingCount > maxListings;
  const excess    = overLimit ? listingCount - maxListings : 0;

  return {
    user,
    plan: eff.plan,                      // canonical resolved tier
    effective: {                         // richer state for the UI
      plan: eff.plan,
      active: eff.active,
      status: eff.status,
      currentPeriodEnd: eff.currentPeriodEnd,
      cancelAtPeriodEnd: eff.cancelAtPeriodEnd,
      expired: eff.expired,
    },
    listingCount, remaining, maxListings, credits,
    overLimit, excess,
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
      .select('username nombre apellido phone provincia -_id').lean();
    if (!user) return res.status(404).json('User not found');
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Public seller profiles & search ─────────────────────────────────────────

/**
 * GET /search?q= — find sellers by username or name (public).
 * Used by the "Buscar vendedores" box. Case-insensitive substring match. Returns
 * a lightweight list (no contact info) so anyone can discover a profile.
 */
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ users: [] });
    // Escape regex metacharacters in user input.
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');
    const users = await User.find({
      username: { $type: 'string', $gt: '' },
      $or: [{ username: rx }, { nombre: rx }, { apellido: rx }],
    })
      .select('username nombre apellido provincia plan compedPlan subscriptionStatus currentPeriodEnd planExpiresAt cancelAtPeriodEnd email firebaseUid -_id')
      .limit(20)
      .lean();

    // Attach a live count of active listings per seller (small N, fine to loop).
    const out = [];
    for (const u of users) {
      const listingCount = await getActiveCount(u.firebaseUid);
      out.push({
        username: u.username,
        nombre: u.nombre || '',
        apellido: u.apellido || '',
        provincia: u.provincia || '',
        sellerPro: getEffectiveMembership(u).plan === 'pro',
        listingCount,
      });
    }
    res.json({ users: out });
  } catch (err) {
    console.error('[GET /users/search]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /u/:username — a seller's public profile + their active listings (public).
 * Mirrors the marketplace-style profile: anyone can view a user's published items.
 */
router.get('/u/:username', async (req, res) => {
  try {
    const username = String(req.params.username || '').trim().toLowerCase();
    if (!username) return res.status(404).json({ error: 'not_found' });

    const user = await User.findOne({ username })
      .select('username nombre apellido provincia createdAt plan compedPlan subscriptionStatus currentPeriodEnd planExpiresAt cancelAtPeriodEnd email firebaseUid')
      .lean();
    if (!user) return res.status(404).json({ error: 'not_found' });

    // Public, active (non-hidden, non-expired) listings only.
    const listings = await Listing.find({
      author: user.firebaseUid,
      status: 'active',
      hidden: { $ne: true },
      expiresAt: { $gt: new Date() },
    })
      .sort({ featured: -1, createdAt: -1 })
      .select('-viewedBy -favoritedBy')
      .limit(60)
      .lean();

    const sellerPro = getEffectiveMembership(user).plan === 'pro';

    res.json({
      profile: {
        username: user.username,
        nombre: user.nombre || '',
        apellido: user.apellido || '',
        provincia: user.provincia || '',
        sellerPro,
        memberSince: user.createdAt || null,
        listingCount: listings.length,
      },
      listings: listings.map(l => ({ ...l, sellerPro })),
    });
  } catch (err) {
    console.error('[GET /users/u/:username]', err.message);
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
