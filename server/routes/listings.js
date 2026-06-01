const express = require('express');
const router  = require('express').Router();
const Listing = require('../models/listing.model');
const User    = require('../models/user.model');
const { upload, cloudinary, configureCloudinary, getPublicIdFromUrl } = require('../config/cloudinary');
const { verifyToken }          = require('../middleware/auth');
const { ensureUser }           = require('../middleware/ensureUser');
const { enforceListingLimit, getActiveCount, refundCreditIfUsed } = require('../middleware/listingLimits');
const { isOwner }              = require('../config/plans');
const { canFeatureListing }    = require('../config/featured');
const { createListingLimiter } = require('../middleware/rateLimiters');

// ─── Server-side listing validation (never trust the client) ─────────────────
// Must match the <option value="…"> values in publish.html exactly.
const VALID_CATEGORIES = new Set([
  'Ropa y accesorios', 'Electrónica', 'Hogar y muebles',
  'Vehículos', 'Bienes Raíces', 'Servicios', 'Otros',
]);
const VALID_CONDITIONS = new Set(['new', 'like_new', 'good', 'fair', 'regular', '']);

// Real-estate option whitelists — must match the <option> values in publish.html.
const RE_CATEGORY      = 'Bienes Raíces';
const VALID_RE_OPS     = new Set(['alquiler', 'venta', '']);
const VALID_RE_TYPES   = new Set(['casa', 'apartamento', 'lote', 'local', 'oficina', 'bodega', 'finca', '']);

/** Parse + sanitize the real-estate fields for a Bienes Raíces listing. */
function parseRealEstate(body) {
  const operation    = VALID_RE_OPS.has(String(body.re_operation || '')) ? String(body.re_operation || '') : '';
  const propertyType = VALID_RE_TYPES.has(String(body.re_type || '')) ? String(body.re_type || '') : '';
  const toNum = (v, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
  };
  return {
    operation,
    propertyType,
    area:      toNum(body.re_area, 1_000_000),
    bedrooms:  toNum(body.re_bedrooms, 50),
    bathrooms: toNum(body.re_bathrooms, 50),
  };
}

// ─── Prohibited-content filter ───────────────────────────────────────────────
// Blocks listings for illegal / restricted goods (drugs, alcohol, tobacco,
// weapons, sexual services). Terms are stored WITHOUT accents; the matcher
// strips accents from the listing text before testing, and matches whole words
// only (so "coca" doesn't trip on "cocada", etc.). Edit this list freely.
const BANNED_TERMS = [
  // Drogas
  'droga', 'drogas', 'marihuana', 'mariguana', 'marijuana', 'weed', 'cannabis',
  'mota', 'cogollo', 'porro', 'cocaina', 'crack', 'heroina', 'metanfetamina',
  'cristal', 'mdma', 'extasis', 'lsd', 'hachis', 'hash', 'ketamina', 'fentanilo',
  'cripy', 'cripa', 'sicodelicos', 'psicodelicos', 'hongos magicos',
  // Alcohol y tabaco
  'cerveza', 'cervezas', 'licor', 'licores', 'guaro', 'vodka', 'whisky', 'whiskey',
  'ron', 'tequila', 'aguardiente', 'cigarrillo', 'cigarrillos', 'cigarro', 'cigarros',
  'tabaco', 'vape', 'vaper', 'vapeador',
  // Servicios sexuales
  'prostitucion', 'prostituta', 'prostituto', 'escort', 'escorts', 'sexoservicio',
  'servicios sexuales', 'servicio sexual', 'dama de compania', 'acompanante sexual',
  // Armas
  'arma de fuego', 'armas de fuego', 'pistola', 'rifle', 'municion', 'municiones',
  'granada', 'silenciador',
];

function stripAccents(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Returns the first banned term found in the given text, or null. */
function findBannedTerm(text) {
  const hay = stripAccents(text);
  for (const term of BANNED_TERMS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Whole-word match (with optional plural suffix), bounded by non-alphanumeric
    // chars or string ends — so "cerveza" also catches "cervezas".
    const re = new RegExp('(^|[^a-z0-9])' + escaped + '(es|s)?([^a-z0-9]|$)');
    if (re.test(hay)) return term;
  }
  return null;
}

function validateListingInput(body) {
  const errors = [];
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim();
  const priceNum = Number(body.price);
  const category = String(body.category || '').trim();
  const condition = body.condition === undefined ? '' : String(body.condition).trim();
  // Size only applies to the clothing category; ignored (stored as '') otherwise.
  const size = category === 'Ropa y accesorios'
    ? String(body.size || '').trim().slice(0, 30)
    : '';
  // Real-estate details only apply to the Bienes Raíces category.
  const realEstate = category === RE_CATEGORY
    ? parseRealEstate(body)
    : { operation: '', propertyType: '', area: null, bedrooms: null, bathrooms: null };

  if (name.length < 3 || name.length > 100) errors.push('El título debe tener entre 3 y 100 caracteres.');
  if (description.length < 10 || description.length > 2000) errors.push('La descripción debe tener entre 10 y 2000 caracteres.');
  if (!Number.isFinite(priceNum) || priceNum < 0 || priceNum > 1_000_000_000) errors.push('Precio inválido.');
  if (!VALID_CATEGORIES.has(category)) errors.push('Categoría inválida.');
  if (!VALID_CONDITIONS.has(condition)) errors.push('Condición inválida.');

  // Prohibited content (illegal / restricted goods) — checked across title + description.
  if (findBannedTerm(`${name} ${description}`)) {
    errors.push('Este anuncio parece contener artículos no permitidos (drogas, alcohol, tabaco, armas o servicios sexuales). No podemos publicarlo.');
  }

  return { errors, clean: { name, description, price: priceNum, category, condition, size, realEstate } };
}

// ─── Public ──────────────────────────────────────────────────────────────────

/**
 * GET / — public listings feed with search, filter, sort, and pagination.
 *
 * Query params:
 *   q          — keyword (uses MongoDB text index; name weighted 3×, description 1×)
 *   category   — exact category string
 *   condition  — one of: new, like_new, good, fair, regular
 *   provincia  — province string
 *   minPrice   — numeric floor
 *   maxPrice   — numeric ceiling
 *   sort       — 'newest' (default) | 'oldest' | 'price_asc' | 'price_desc' | 'featured'
 *   page       — 1-based page number (default 1)
 *   limit      — results per page (default 20, max 50)
 *
 * Response: { listings: [...], pagination: { page, limit, total, pages } }
 */
router.get('/', async (req, res) => {
  try {
    const {
      q, category, condition, provincia,
      minPrice, maxPrice, sort,
    } = req.query;

    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    // Base filter — only non-hidden, non-expired active listings
    const filter = { status: 'active', hidden: { $ne: true }, expiresAt: { $gt: new Date() } };

    if (q && q.trim()) {
      filter.$text = { $search: q.trim() };
    }
    if (category)  filter.category  = category;
    if (condition) filter.condition  = condition;
    if (provincia) filter.provincia  = provincia;

    const min = parseFloat(minPrice);
    const max = parseFloat(maxPrice);
    if (!isNaN(min) || !isNaN(max)) {
      filter.price = {};
      if (!isNaN(min)) filter.price.$gte = min;
      if (!isNaN(max)) filter.price.$lte = max;
    }

    // Sort options
    let sortObj;
    if (q && q.trim() && !sort) {
      // Text search: sort by relevance score when no explicit sort requested
      sortObj = { score: { $meta: 'textScore' }, featured: -1 };
    } else {
      switch (sort) {
        case 'oldest':     sortObj = { createdAt:  1 }; break;
        case 'price_asc':  sortObj = { price:       1 }; break;
        case 'price_desc': sortObj = { price:      -1 }; break;
        case 'featured':   sortObj = { featured: -1, createdAt: -1 }; break;
        default:           sortObj = { featured: -1, createdAt: -1 }; // 'newest'
      }
    }

    // Build projection: always exclude viewedBy (internal array, never sent to frontend).
    // When using text search, also include the relevance score as a computed field.
    const projection = { viewedBy: 0 };
    if (q && q.trim()) projection.score = { $meta: 'textScore' };

    let [listings, total] = await Promise.all([
      Listing.find(filter, projection)
        .sort(sortObj)
        .skip(skip)
        .limit(limit)
        .lean(),
      Listing.countDocuments(filter),
    ]);

    // ── Fill in missing contact/provincia from the seller's current profile ───
    // Old listings may have contact='' or contact=email (pre-fix fallback).
    // We validate contact as a phone number (≥8 digits after stripping non-digits).
    // One batch User lookup covers all authors on this page — no N+1 queries.
    const isPhone = str => String(str || '').replace(/\D/g, '').length >= 8;

    const needsSync = listings.some(l => !l.provincia || !isPhone(l.contact));

    if (needsSync) {
      const authorUids = [...new Set(listings.map(l => l.author))];
      const sellers = await User
        .find({ firebaseUid: { $in: authorUids } })
        .select('firebaseUid phone provincia')
        .lean();
      const sellerMap = {};
      sellers.forEach(s => { sellerMap[s.firebaseUid] = s; });

      listings = listings.map(l => {
        const s = sellerMap[l.author];
        if (!s) return l;
        return {
          ...l,
          // Use stored contact only if it's a real phone; fall back to current profile phone
          contact:   isPhone(l.contact) ? l.contact : (s.phone || ''),
          provincia: l.provincia || s.provincia || '',
        };
      });
    }

    res.json({
      listings,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[GET /listings]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /user/:uid — all listings for a user (public profile view)
router.get('/user/:uid', (req, res) => {
  Listing.find({ author: req.params.uid })
    .sort({ status: 1, createdAt: -1 }) // active first, then sold
    .select('-viewedBy')
    .then(listings => res.json(listings))
    .catch(err => res.status(400).json('Error: ' + err));
});

/**
 * POST /:id/view — unique authenticated view tracking.
 *
 * Rules (all enforced atomically by the MongoDB filter, not by application logic):
 *   - Requires a valid Firebase JWT → guests never count.
 *   - Owner viewing their own listing → filter won't match → counted: false.
 *   - Already viewed → viewedBy contains uid → filter won't match → counted: false.
 *   - Hidden or non-active listing → filter won't match → counted: false.
 *   - First view by a new authenticated user → $inc views + $addToSet uid → counted: true.
 *
 * $addToSet instead of $push: guarantees array-level uniqueness at the MongoDB layer,
 * providing a second safety net against any edge-case concurrency or race conditions
 * that bypass the filter (e.g. two simultaneous requests with the same UID).
 *
 * updateOne returns no document → viewedBy never enters Node.js memory.
 * A follow-up findById fetches only the `views` Number for the response.
 *
 * Returns: { counted: boolean, views: number }
 */
router.post('/:id/view', verifyToken, async (req, res) => {
  try {
    const result = await Listing.updateOne(
      {
        _id:      req.params.id,
        status:   'active',            // sold listings do not gain views
        hidden:   { $ne: true },       // hidden listing   → no count
        author:   { $ne: req.uid },    // owner self-view  → no count
        viewedBy: { $ne: req.uid },    // already viewed   → no count
      },
      {
        $inc:      { views: 1 },
        $addToSet: { viewedBy: req.uid }, // array-level uniqueness guarantee
      }
    );

    const counted = result.modifiedCount === 1;

    // Fetch only the view count — viewedBy never enters Node memory
    const doc = await Listing.findById(req.params.id).select('views').lean();

    res.json({ counted, views: doc ? doc.views : 0 });
  } catch (err) {
    console.error('[POST /listings/:id/view]', err.message);
    res.json({ counted: false, views: 0 }); // never fail the page over a view count
  }
});

// GET /:id — single listing with seller info (does NOT increment views)
router.get('/:id', async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id).select('-viewedBy').lean();
    if (!listing) return res.status(404).json('Listing not found');
    // Hidden listings are only visible in the admin panel
    if (listing.hidden) return res.status(404).json('Listing not found');
    // Expired listings are off the marketplace until the owner renews them
    if (listing.expiresAt && new Date(listing.expiresAt) <= new Date()) {
      return res.status(404).json('Listing not found');
    }

    const seller = await User.findOne({ firebaseUid: listing.author })
      .select('nombre apellido phone provincia -_id').lean();
    res.json({ ...listing, seller: seller || null });
  } catch (err) {
    console.error('[GET /listings/:id]', err);
    res.status(400).json('Error: ' + err);
  }
});

// ─── Authenticated ────────────────────────────────────────────────────────────

/**
 * POST /add
 * Middleware chain:
 *   verifyToken      → authenticates, sets req.uid + req.email
 *   ensureUser       → upserts DB profile, sets req.dbUser
 *   enforceListingLimit → checks count against plan limit, may decrement credits
 *   upload.array     → parses multipart form (must come AFTER limit check so
 *                       Cloudinary upload is never triggered for rejected posts)
 *
 * Handler has zero plan / limit logic — all of that lives in middleware.
 */

/**
 * Wraps multer's upload.array so its errors become clean JSON instead of an
 * unhandled 500 (which the frontend can only show as a generic "Error al
 * publicar"). A rejected upload happens AFTER enforceListingLimit, so we refund
 * any credit it consumed before responding.
 */
/**
 * Delete images already uploaded to Cloudinary for a request that is about to be
 * rejected (validation/banned content/no-photo race), so rejected posts never
 * leave orphaned images behind.
 */
async function deleteUploadedFiles(files) {
  if (!files || !files.length) return;
  try {
    configureCloudinary();
    const publicIds = files
      .map(f => f.filename || getPublicIdFromUrl(f.path))
      .filter(Boolean);
    if (publicIds.length) await cloudinary.api.delete_resources(publicIds);
  } catch (e) {
    console.error('[POST /add] cleanup of rejected uploads failed:', e.message);
  }
}

function uploadPhotos(req, res, next) {
  configureCloudinary(); // idempotent — guarantees credentials are set before upload
  upload.array('photos')(req, res, async (err) => {
    if (!err) return next();
    await refundCreditIfUsed(req);
    let message = 'No se pudieron subir las imágenes. Intenta de nuevo.';
    if (err.code === 'LIMIT_FILE_SIZE') {
      message = 'Cada imagen debe pesar menos de 10 MB.';
    } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      message = 'Campo de imagen inesperado. Recarga la página e intenta de nuevo.';
    } else if (err.message && /tipo de archivo/i.test(err.message)) {
      message = err.message;
    }
    console.error('[POST /add] upload error:', err.code || err.http_code || '', err.message);
    return res.status(400).json({ error: message, code: 'UPLOAD_ERROR' });
  });
}

router.post('/add',
  verifyToken,
  createListingLimiter,   // anti-spam: keyed by uid, runs after verifyToken sets req.uid
  ensureUser,
  enforceListingLimit,
  uploadPhotos,
  async (req, res) => {
    try {
      const uid  = req.uid;
      const user = req.dbUser;

      // 1. Server-side validation. If it fails AFTER a credit was consumed,
      //    refund it so the user never pays ₡500 for a rejected post.
      const { errors, clean } = validateListingInput(req.body);
      if (errors.length) {
        await refundCreditIfUsed(req);
        await deleteUploadedFiles(req.files); // don't leave orphaned images for a rejected post
        return res.status(400).json({ error: errors.join(' '), code: 'VALIDATION' });
      }
      if (!req.files || req.files.length === 0) {
        await refundCreditIfUsed(req);
        return res.status(400).json({ error: 'Se requiere al menos una foto.', code: 'NO_PHOTO' });
      }

      const photos    = req.files.map(f => f.path);
      const provincia = user.provincia || '';
      const contact   = user.phone     || ''; // phone only — email is never a valid WA contact

      // featured is a manual/earned distinction — never auto-set on creation
      const newListing = new Listing({
        name: clean.name, description: clean.description, price: clean.price,
        category: clean.category, condition: clean.condition, size: clean.size,
        realEstate: clean.realEstate,
        photos, contact, provincia,
        author: uid, featured: false,
      });
      await newListing.save();

      // 2. Post-insert race reconciliation (TOCTOU guard).
      //    enforceListingLimit checked the count, but two concurrent POST /add
      //    requests can both pass the check and both insert, exceeding the limit.
      //    Only applies to finite plan limits where NO credit was used (a credit
      //    legitimately pays for one slot beyond the plan limit). If this insert
      //    pushed the user over, we delete the just-created (newest) listing and
      //    reject — failing SAFE toward the limit rather than over-granting.
      const maxAllowed = req.maxListings;
      if (maxAllowed !== Infinity && !req.usedCredit) {
        const activeCount = await getActiveCount(uid);
        if (activeCount > maxAllowed) {
          await Listing.deleteOne({ _id: newListing._id });
          return res.status(402).json({
            error: 'Listing limit reached for your plan',
            code:  'LIMIT_REACHED',
            plan:  req.effPlan,
            maxListings: maxAllowed,
          });
        }
      }

      res.json({ message: 'Listing added!', id: newListing._id, name: clean.name, photo: photos[0] || null });
    } catch (err) {
      console.error('[POST /add]', err);
      await refundCreditIfUsed(req); // never swallow a paid credit on error
      res.status(500).json({ error: err.message, code: 'ADD_FAILED' });
    }
  }
);

/**
 * POST /update/:id
 * Only the owner of the listing can update it.
 * Replaces photos only when new files are uploaded.
 */
router.post('/update/:id', verifyToken, upload.array('photos'), async (req, res) => {
  try {
    const uid     = req.uid;
    const listing = await Listing.findById(req.params.id);
    if (!listing)             return res.status(404).json('Listing not found');
    if (listing.author !== uid) return res.status(403).json('Not authorized');

    const { name, description, price, category, condition } = req.body;

    // Back-fill provincia/contact from profile if still missing on listing
    if (!listing.provincia || !listing.contact) {
      const user = await User.findOne({ firebaseUid: uid }).lean();
      if (user) {
        if (!listing.provincia) listing.provincia = user.provincia || '';
        if (!listing.contact)   listing.contact   = user.phone || user.email || '';
      }
    }

    listing.name        = name;
    listing.description = description;
    listing.price       = price;
    listing.category    = category;
    if (condition !== undefined) listing.condition = condition || '';
    // Size only applies to the clothing category; cleared otherwise.
    listing.size = category === 'Ropa y accesorios'
      ? String(req.body.size || '').trim().slice(0, 30)
      : '';
    // Real-estate details only apply to the Bienes Raíces category; cleared otherwise.
    listing.realEstate = category === RE_CATEGORY
      ? parseRealEstate(req.body)
      : { operation: '', propertyType: '', area: null, bedrooms: null, bathrooms: null };
    if (req.files && req.files.length > 0) {
      listing.photos = req.files.map(f => f.path);
    }

    await listing.save();
    res.json('Listing updated');
  } catch (err) {
    console.error('[POST /update]', err);
    res.status(500).json('Error: ' + err.message);
  }
});

/**
 * POST /mark-sold/:id
 * Sets status = 'sold' (frees a slot immediately — getActiveCount excludes sold)
 * and stamps soldAt. The listing stays visible in the seller's panel for a week,
 * then the cleanup-sold cron deletes the document and its Cloudinary images so
 * sold listings never accumulate in the database / image storage.
 */
router.post('/mark-sold/:id', verifyToken, async (req, res) => {
  try {
    const uid     = req.uid;
    const listing = await Listing.findById(req.params.id);
    if (!listing)             return res.status(404).json('Listing not found');
    if (listing.author !== uid) return res.status(403).json('Not authorized');

    listing.status = 'sold';
    listing.soldAt = new Date();
    await listing.save();
    res.json('Listing marked as sold');
  } catch (err) {
    console.error('[POST /mark-sold]', err);
    res.status(500).json('Error: ' + err.message);
  }
});

/**
 * POST /renew/:id
 * Owner-only. Extends an (expired or soon-to-expire) listing for another 30 days
 * and returns it to the active feed. Goes through enforceListingLimit so renewing
 * respects the user's plan limit exactly like publishing a new listing.
 */
router.post('/renew/:id',
  verifyToken,
  ensureUser,
  async (req, res, next) => {
    try {
      const listing = await Listing.findById(req.params.id);
      if (!listing)               return res.status(404).json({ error: 'Listing not found' });
      if (listing.author !== req.uid) return res.status(403).json({ error: 'Not authorized' });
      req._renewListing = listing;
      next();
    } catch (err) {
      console.error('[POST /renew] lookup', err);
      res.status(500).json({ error: err.message });
    }
  },
  enforceListingLimit,
  async (req, res) => {
    try {
      const listing = req._renewListing;
      const ttl = Listing.LISTING_ACTIVE_MS || 30 * 24 * 60 * 60 * 1000;
      listing.status    = 'active';
      listing.soldAt    = null;
      listing.expiresAt = new Date(Date.now() + ttl);
      await listing.save();
      res.json({ message: 'Listing renewed', expiresAt: listing.expiresAt });
    } catch (err) {
      await refundCreditIfUsed(req);
      console.error('[POST /renew]', err);
      res.status(500).json({ error: err.message, code: 'RENEW_FAILED' });
    }
  }
);

/**
 * POST /delete/:id
 * Hard-deletes the document. Because getActiveCount only counts existing
 * documents, this is safe and doesn't require a 'deleted' status.
 */
router.post('/delete/:id', verifyToken, async (req, res) => {
  try {
    configureCloudinary(); // Ensure Cloudinary is configured
    const listing = await Listing.findOne({ _id: req.params.id, author: req.uid });
    if (!listing) {
      return res.status(404).json('Listing not found or you do not have permission to delete it.');
    }

    // --- Cloudinary Deletion ---
    if (listing.photos && listing.photos.length > 0) {
      const publicIds = listing.photos.map(getPublicIdFromUrl).filter(id => id);
      if (publicIds.length > 0) {
        await cloudinary.api.delete_resources(publicIds);
        console.log(`[Cloudinary] Deleted ${publicIds.length} image(s) for listing ${listing._id}`);
      }
    }
    // -------------------------

    const deleteResult = await listing.deleteOne();

    // --- Verification Step ---
    if (deleteResult.deletedCount === 1) {
      console.log(`[MongoDB] Successfully deleted listing ${listing._id}`);
      res.json({ message: 'Listing deleted successfully', deleted: true });
    } else {
      console.warn(`[MongoDB] Failed to delete listing ${listing._id}. deleteOne returned deletedCount: 0`);
      res.status(500).json({ message: 'Failed to delete listing from database.', deleted: false });
    }

  } catch (err) {
    console.error('[POST /delete]', err);
    res.status(500).json('Server error while deleting listing.');
  }
});

/**
 * POST /feature/:id
 * Phase 1: Admin/owner-only manual feature toggle.
 * Phase 2 (future): will also accept requests from users with boost credits.
 *
 * Body: { featured: boolean }  — omit or pass true to feature, false to unfeature.
 *
 * featured is completely decoupled from plan tier and Stripe subscription status.
 * See server/config/featured.js for the Phase 2 roadmap.
 */
router.post('/feature/:id', verifyToken, ensureUser, async (req, res) => {
  try {
    if (!canFeatureListing(req.dbUser, req.email)) {
      return res.status(403).json({
        error: 'Only admin can feature listings at this time.',
        code:  'FEATURE_FORBIDDEN',
      });
    }

    const featured = req.body.featured !== false; // default true; pass false to unfeature
    const listing  = await Listing.findByIdAndUpdate(
      req.params.id,
      { featured },
      { new: true }
    );
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    res.json({ success: true, id: listing._id, featured: listing.featured });
  } catch (err) {
    console.error('[POST /feature]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
