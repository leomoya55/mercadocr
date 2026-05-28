const router  = require('express').Router();
const Listing = require('../models/listing.model');
const User    = require('../models/user.model');
const upload  = require('../config/cloudinary');
const { verifyToken }          = require('../middleware/auth');
const { ensureUser }           = require('../middleware/ensureUser');
const { enforceListingLimit }  = require('../middleware/listingLimits');
const { isOwner }              = require('../config/plans');

// ─── Public ──────────────────────────────────────────────────────────────────

// GET / — all active listings, featured first
router.get('/', (req, res) => {
  Listing.find({ status: { $ne: 'sold' } })
    .sort({ featured: -1, createdAt: -1 })
    .then(listings => res.json(listings))
    .catch(err => res.status(400).json('Error: ' + err));
});

// GET /user/:uid — all listings for a user (public profile view)
router.get('/user/:uid', (req, res) => {
  Listing.find({ author: req.params.uid })
    .sort({ status: 1, createdAt: -1 }) // active first, then sold
    .then(listings => res.json(listings))
    .catch(err => res.status(400).json('Error: ' + err));
});

// GET /:id — single listing with seller info
router.get('/:id', async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id).lean();
    if (!listing) return res.status(404).json('Listing not found');
    const seller = await User.findOne({ firebaseUid: listing.author })
      .select('nombre apellido phone provincia -_id').lean();
    res.json({ ...listing, seller: seller || null });
  } catch (err) {
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
      const { name, description, price, category } = req.body;

      if (!req.files || req.files.length === 0) {
        return res.status(400).json('At least one photo is required');
      }

      const photos    = req.files.map(f => f.path);
      const provincia = user.provincia || '';
      const contact   = user.phone    || user.email || '';

      // Pro plan (and owner) get all listings featured automatically
      const featured = user.plan === 'pro' || isOwner(req.email);

      const newListing = new Listing({
        name, description, price, category,
        photos, contact, provincia,
        author: uid, featured,
      });
      await newListing.save();

      res.json({ message: 'Listing added!', featured });
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

    const { name, description, price, category } = req.body;

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

module.exports = router;
