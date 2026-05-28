const router  = require('express').Router();
const Listing = require('../models/listing.model');
const User    = require('../models/user.model');
const upload  = require('../config/cloudinary');
const { verifyToken }          = require('../middleware/auth');
const { ensureUser }           = require('../middleware/ensureUser');
const { enforceListingLimit }  = require('../middleware/listingLimits');
const { isOwner }              = require('../config/plans');
const { canFeatureListing }    = require('../config/featured');

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

    // Base filter — only non-hidden active listings
    const filter = { status: 'active', hidden: { $ne: true } };

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

    let [listings, total] = await Promise.all([
      Listing.find(filter, q && q.trim() ? { score: { $meta: 'textScore' } } : {})
        .sort(sortObj)
        .skip(skip)
        .limit(limit)
        .lean(),
      Listing.countDocuments(filter),
    ]);

    // ── Fill in missing contact/provincia from the seller's current profile ───
    // Listings created before the registration fix may have contact='' or
    // provincia=''. One batch User lookup covers all authors on this page —
    // no N+1 queries. We never overwrite a field that already has a value.
    const missingContact  = listings.some(l => !l.contact);
    const missingProvincia = listings.some(l => !l.provincia);

    if (missingContact || missingProvincia) {
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
          contact:   l.contact   || s.phone     || '',
          provincia: l.provincia || s.provincia  || '',
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
    .then(listings => res.json(listings))
    .catch(err => res.status(400).json('Error: ' + err));
});

// GET /:id — single listing with seller info (increments view counter)
router.get('/:id', async (req, res) => {
  try {
    // Increment views atomically, return updated doc
    const listing = await Listing.findByIdAndUpdate(
      req.params.id,
      { $inc: { views: 1 } },
      { new: true }
    ).lean();
    if (!listing) return res.status(404).json('Listing not found');
    // Hidden listings are only visible in the admin panel
    if (listing.hidden) return res.status(404).json('Listing not found');

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
router.post('/add',
  verifyToken,
  ensureUser,
  enforceListingLimit,
  upload.array('photos'),
  async (req, res) => {
    try {
      const uid  = req.uid;
      const user = req.dbUser;
      const { name, description, price, category, condition } = req.body;

      if (!req.files || req.files.length === 0) {
        return res.status(400).json('At least one photo is required');
      }

      const photos    = req.files.map(f => f.path);
      const provincia = user.provincia || '';
      const contact   = user.phone    || user.email || '';

      // featured is a manual/earned distinction — never auto-set on creation
      const newListing = new Listing({
        name, description, price, category,
        condition: condition || '',
        photos, contact, provincia,
        author: uid, featured: false,
      });
      await newListing.save();

      // Return id, name, and first photo so the frontend can show a success modal
      res.json({ message: 'Listing added!', id: newListing._id, name, photo: photos[0] || null });
    } catch (err) {
      console.error('[POST /add]', err);
      res.status(500).json('Error: ' + err.message);
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
 * Sets status = 'sold', which immediately frees a slot in the active count
 * (getActiveCount excludes sold listings via { status: { $ne: 'sold' } }).
 */
router.post('/mark-sold/:id', verifyToken, async (req, res) => {
  try {
    const uid     = req.uid;
    const listing = await Listing.findById(req.params.id);
    if (!listing)             return res.status(404).json('Listing not found');
    if (listing.author !== uid) return res.status(403).json('Not authorized');

    listing.status = 'sold';
    await listing.save();
    res.json('Listing marked as sold');
  } catch (err) {
    console.error('[POST /mark-sold]', err);
    res.status(500).json('Error: ' + err.message);
  }
});

/**
 * POST /delete/:id
 * Hard-deletes the document. Because getActiveCount only counts existing
 * documents, deletion immediately frees a slot — no extra bookkeeping needed.
 */
router.post('/delete/:id', verifyToken, async (req, res) => {
  try {
    const uid     = req.uid;
    const listing = await Listing.findById(req.params.id);
    if (!listing)             return res.status(404).json('Listing not found');
    if (listing.author !== uid) return res.status(403).json('Not authorized');

    await listing.deleteOne();
    res.json('Listing deleted');
  } catch (err) {
    console.error('[POST /delete]', err);
    res.status(500).json('Error: ' + err.message);
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
