const router = require('express').Router();
const Listing = require('../models/listing.model');
const User = require('../models/user.model');
const upload = require('../config/cloudinary');
const { verifyToken } = require('../middleware/auth');

const FREE_LIMIT  = 3;
const BASIC_LIMIT = 20;

// Get all active listings — public
router.get('/', (req, res) => {
  Listing.find({ status: { $ne: 'sold' } })
    .sort({ featured: -1, createdAt: -1 })
    .then(listings => res.json(listings))
    .catch(err => res.status(400).json('Error: ' + err));
});

// Add new listing — auth required
router.post('/add', verifyToken, upload.array('photos'), async (req, res) => {
  try {
    const uid = req.uid;
    const { name, description, price, category } = req.body;
    if (!req.files || req.files.length === 0) {
      return res.status(400).json('At least one photo is required');
    }

    const photos = req.files.map(file => file.path);
    const user = await User.findOne({ firebaseUid: uid });
    if (!user) return res.status(404).json('User not found');

    // Pull provincia and contact from the user's profile
    const provincia = user.provincia || '';
    const contact   = user.phone    || user.email || '';

    // Count only active (non-sold) listings for limit checks
    const activeCount = await Listing.countDocuments({ author: uid, status: { $ne: 'sold' } });

    let featured = false;

    if (user.plan === 'pro') {
      featured = true;
    } else if (user.plan === 'basic') {
      if (activeCount >= BASIC_LIMIT) {
        return res.status(402).json({ error: 'Basic plan limit reached', code: 'LIMIT_REACHED' });
      }
    } else {
      // Free plan
      if (activeCount < FREE_LIMIT) {
        // within free limit — no credit consumed
      } else if (user.singlePostCredits > 0) {
        user.singlePostCredits -= 1;
        await user.save();
      } else {
        return res.status(402).json({ error: 'Payment required', code: 'PAYMENT_REQUIRED' });
      }
    }

    const newListing = new Listing({ name, description, price, category, photos, contact, provincia, author: uid, featured });
    await newListing.save();
    res.json({ message: 'Listing added!', featured });
  } catch (err) {
    console.error('Add listing error:', err);
    res.status(500).json('Error: ' + err.message);
  }
});

// Get listings by user — public
router.get('/user/:uid', (req, res) => {
  Listing.find({ author: req.params.uid })
    .sort({ status: 1, createdAt: -1 }) // active first, then sold
    .then(listings => res.json(listings))
    .catch(err => res.status(400).json('Error: ' + err));
});

// Get listing by ID — public, includes seller info
router.get('/:id', async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id).lean();
    if (!listing) return res.status(404).json('Listing not found');
    const seller = await User.findOne({ firebaseUid: listing.author })
      .select('nombre apellido phone provincia -_id')
      .lean();
    res.json({ ...listing, seller: seller || null });
  } catch (err) {
    res.status(400).json('Error: ' + err);
  }
});

// Update listing — auth required, must own listing
router.post('/update/:id', verifyToken, upload.array('photos'), async (req, res) => {
  try {
    const uid = req.uid;
    const { name, description, price, category } = req.body;
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json('Listing not found');
    if (listing.author !== uid) return res.status(403).json('Not authorized');

    // Keep provincia/contact from profile if listing doesn't have them yet
    if (!listing.provincia || !listing.contact) {
      const user = await User.findOne({ firebaseUid: uid });
      if (user) {
        if (!listing.provincia) listing.provincia = user.provincia || '';
        if (!listing.contact)   listing.contact   = user.phone || user.email || '';
      }
    }

    listing.name = name;
    listing.description = description;
    listing.price = price;
    listing.category = category;
    if (req.files && req.files.length > 0) {
      listing.photos = req.files.map(file => file.path);
    }
    await listing.save();
    res.json('Listing updated');
  } catch (err) {
    console.error('Update listing error:', err);
    res.status(500).json('Error: ' + err.message);
  }
});

// Mark listing as sold — auth required, must own listing
router.post('/mark-sold/:id', verifyToken, async (req, res) => {
  try {
    const uid = req.uid;
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json('Listing not found');
    if (listing.author !== uid) return res.status(403).json('Not authorized');

    listing.status = 'sold';
    await listing.save();
    res.json('Listing marked as sold');
  } catch (err) {
    console.error('Mark sold error:', err);
    res.status(500).json('Error: ' + err.message);
  }
});

// Delete listing — auth required, must own listing
router.post('/delete/:id', verifyToken, async (req, res) => {
  try {
    const uid = req.uid;
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json('Listing not found');
    if (listing.author !== uid) return res.status(403).json('Not authorized');

    await listing.deleteOne();
    res.json('Listing deleted');
  } catch (err) {
    console.error('Delete listing error:', err);
    res.status(500).json('Error: ' + err.message);
  }
});

module.exports = router;
