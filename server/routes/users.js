const router   = require('express').Router();
const User     = require('../models/user.model');
const Listing  = require('../models/listing.model');
const { verifyToken }            = require('../middleware/auth');
const { ensureUser }             = require('../middleware/ensureUser');
const ensureVerified             = require('../middleware/ensureVerified');
const { getActiveCount }          = require('../middleware/listingLimits');
const { getPlan, isOwner }        = require('../config/plans');
const { getEffectiveMembership }  = require('../config/membership');
const { cloudinary, configureCloudinary } = require('../config/cloudinary');
const { isConfigured: emailConfigured, sendVerificationEmail } = require('../config/email');
const { writeLimiter }            = require('../middleware/rateLimiters');

// Accept only well-formed Cloudinary URLs from OUR cloud + avatars folder.
function isValidAvatarUrl(url) {
  if (typeof url !== 'string') return false;
  const prefix = 'https://res.cloudinary.com/' + (process.env.CLOUDINARY_CLOUD_NAME || '') + '/';
  return url.startsWith(prefix) && url.includes('/mercadocr/avatars/');
}

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
    // Referral summary for the member's own dashboard. `code` is their public
    // username, which doubles as their invite code; the client builds the full
    // link as `${origin}/register?ref=${code}`. `count` is lifetime referrals.
    referral: {
      code:  user.username || '',
      count: user.referralCount || 0,
    },
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
      .select('username nombre apellido phone provincia photoURL -_id').lean();
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
      .select('username nombre apellido provincia photoURL plan compedPlan subscriptionStatus currentPeriodEnd planExpiresAt cancelAtPeriodEnd email firebaseUid -_id')
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
        photoURL: u.photoURL || '',
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
      .select('username nombre apellido provincia photoURL createdAt plan compedPlan subscriptionStatus currentPeriodEnd planExpiresAt cancelAtPeriodEnd email firebaseUid')
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
        photoURL: user.photoURL || '',
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
 * POST /me/avatar-signature
 * Hands the browser a short-lived Cloudinary signature for a direct profile-photo
 * upload (folder mercadocr/avatars). Gated to authenticated, verified users.
 */
router.post('/me/avatar-signature', verifyToken, ensureVerified, (req, res) => {
  try {
    configureCloudinary();
    const timestamp = Math.round(Date.now() / 1000);
    const folder = 'mercadocr/avatars';
    const signature = cloudinary.utils.api_sign_request(
      { timestamp, folder },
      process.env.CLOUDINARY_API_SECRET
    );
    res.json({
      signature, timestamp, folder,
      apiKey: process.env.CLOUDINARY_API_KEY,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    });
  } catch (err) {
    console.error('[POST /me/avatar-signature]', err.message);
    res.status(500).json({ error: 'No se pudo preparar la subida de la foto.' });
  }
});

/**
 * PUT /me/photo   body: { photoURL }
 * Save (or clear) the user's profile picture. photoURL must be a Cloudinary URL
 * from our cloud + avatars folder; pass '' to remove the current photo.
 */
router.put('/me/photo', verifyToken, ensureUser, async (req, res) => {
  try {
    const raw = (req.body && typeof req.body.photoURL === 'string') ? req.body.photoURL.trim() : '';
    if (raw && !isValidAvatarUrl(raw)) {
      return res.status(400).json({ error: 'URL de imagen inválida.' });
    }
    const updated = await User.findOneAndUpdate(
      { firebaseUid: req.uid },
      { $set: { photoURL: raw } },
      { new: true }
    ).select('photoURL').lean();
    res.json({ photoURL: updated ? updated.photoURL : '' });
  } catch (err) {
    console.error('[PUT /me/photo]', err.message);
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

    // ─── Referral attribution (once, at/near signup) ────────────────────────
    // `ref` is the referrer's public username, carried from the invite link
    // (/register?ref=<username>). We attribute the referral here because /ensure
    // is the one call register.js makes with the ref in hand. Rules:
    //   - set referredBy AT MOST ONCE (the conditional update below is atomic, so
    //     concurrent /ensure calls can't double-count);
    //   - never self-refer; the referrer must be a different account;
    //   - only within 7 days of account creation, so an old account can't have a
    //     referrer attached long after the fact.
    try {
      const ref = String(req.body.ref || '').trim().toLowerCase();
      if (ref && user && !user.referredBy) {
        const ACCOUNT_AGE_LIMIT = 7 * 24 * 60 * 60 * 1000; // 7 days
        const age = Date.now() - new Date(user.createdAt || Date.now()).getTime();
        if (age <= ACCOUNT_AGE_LIMIT) {
          const referrer = await User.findOne({ username: ref })
            .select('firebaseUid email').lean();
          const selfRefer = referrer &&
            (referrer.firebaseUid === uid ||
             (referrer.email || '').toLowerCase() === (email || '').toLowerCase());
          if (referrer && !selfRefer) {
            // Atomic: only the FIRST writer (referredBy still empty) wins, so the
            // referrer's counter is incremented exactly once.
            const claim = await User.updateOne(
              { firebaseUid: uid, $or: [{ referredBy: '' }, { referredBy: { $exists: false } }] },
              { $set: { referredBy: referrer.firebaseUid } }
            );
            if (claim.modifiedCount === 1) {
              await User.updateOne(
                { firebaseUid: referrer.firebaseUid },
                { $inc: { referralCount: 1 } }
              );
              user.referredBy = referrer.firebaseUid;
            }
          }
        }
      }
    } catch (e) {
      // Referral tracking is best-effort — never fail registration over it.
      console.warn('[ensure] referral attribution failed:', e.message);
    }

    res.json({ user });
  } catch (err) {
    console.error('[ensure]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Verification email (sent from our own domain via Resend) ─────────────────
//
// POST /me/send-verification
// Mints a Firebase verification link server-side and emails it from
// verificacion@mercaticocr.com (good deliverability) instead of Firebase's
// generic sender. The client falls back to firebase user.sendEmailVerification()
// when this returns a non-2xx (e.g. Resend not configured yet), so verification
// keeps working during the transition.
router.post('/me/send-verification', verifyToken, writeLimiter, async (req, res) => {
  try {
    if (req.emailVerified) return res.json({ alreadyVerified: true });
    if (!req.email)        return res.status(400).json({ error: 'no_email' });

    // No provider configured → tell the client to use the Firebase fallback.
    if (!emailConfigured()) {
      return res.status(503).json({ error: 'email_not_configured', code: 'EMAIL_NOT_CONFIGURED' });
    }

    const admin    = require('firebase-admin');
    const SITE_URL = process.env.SITE_URL || 'https://www.mercaticocr.com';
    // The continue URL must be on a Firebase Authorized Domain (mercaticocr.com).
    const link = await admin.auth().generateEmailVerificationLink(req.email, { url: SITE_URL + '/login' });

    await sendVerificationEmail(req.email, link);
    res.json({ success: true });
  } catch (err) {
    console.error('[POST /me/send-verification]', err.message);
    // 502 signals "we tried but the provider failed" → client falls back.
    res.status(502).json({ error: 'send_failed', code: 'SEND_FAILED' });
  }
});

// ─── Self-service account deletion for the "wrong email" case ─────────────────
//
// DELETE /me
// Lets a user who just registered with a TYPO in their email throw the account
// away themselves and start over — instead of the owner having to manually
// delete it from both Firebase Auth and MongoDB. Deletes the Mongo profile AND
// the Firebase Auth user (server-side via Admin SDK, so it works even if the
// client session isn't "recently logged in").
//
// SCOPE GUARD: only UNVERIFIED accounts may self-delete here. A verified account
// may have listings/history, so deleting it is routed through support to avoid
// accidental data loss and orphaned listings.
router.delete('/me', verifyToken, async (req, res) => {
  try {
    if (req.emailVerified) {
      return res.status(403).json({
        error: 'verified_account',
        message: 'Tu cuenta ya está verificada. Escríbenos a soporte para eliminarla.',
      });
    }

    // Extra safety: never delete an account that already has listings.
    const listingCount = await Listing.countDocuments({ author: req.uid });
    if (listingCount > 0) {
      return res.status(409).json({
        error: 'has_listings',
        message: 'Tu cuenta tiene anuncios. Escríbenos a soporte para eliminarla.',
      });
    }

    await User.deleteOne({ firebaseUid: req.uid });

    // Delete the Firebase Auth user too, so the email is freed up immediately and
    // the user can re-register with the corrected address. Best-effort: if it
    // fails, the Mongo doc is already gone and the client also calls user.delete().
    try {
      const admin = require('firebase-admin');
      await admin.auth().deleteUser(req.uid);
    } catch (e) {
      console.warn('[DELETE /me] Firebase deleteUser failed (client will retry):', e.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /me]', err.message);
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
