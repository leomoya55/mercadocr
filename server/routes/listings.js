const router = require('express').Router();
const Listing = require('../models/listing.model');
const User = require('../models/user.model');
const upload = require('../config/cloudinary');
const { verifyToken } = require('../middleware/auth');

// Get all listings — public
router.get('/', (req, res) => {
  Listing.find()
    .sort({ featured: -1, createdAt: -1 })
    .then(listings => res.json(listings))
    .catch(err => res.status(400).json('Error: ' + err));
});

// Add new listing — auth required
router.post('/add', verifyToken, upload.array('photos'), async (req, res) => {
  try {
    const uid = req.uid;
    const { name, description, price, category, contact, provincia } = req.body;
    if (!req.files || req.files.length === 0) {
      return res.status(400).json('At least one photo is required');
    }
    if (!provincia) return res.status(400).json('Provincia is required');
    const photos = req.files.map(file => file.path);
    const user = await User.findOne({ firebaseUid: uid });
    if (!user) return res.status(404).json('User not found');

    let featured = false;
    if (user.plan === 'pro') {
      featured = true;
    } else if (user.plan === 'basic') {
      const count = await Listing.countDocuments({ author: uid });
      if (count >= 20) {
        return res.status(402).json({ error: 'Basic plan limit reached', code: 'LIMIT_REACHED' });
      }
    } else if (user.plan === 'free') {
      if (!user.freeListingUsed) {
        user.freeListingUsed = true;
      } else if (user.singlePostCredits > 0) {
        user.singlePostCredits -= 1;
      } else {
        return res.status(402).json({ error: 'Payment required', code: 'PAYMENT_REQUIRED' });
      }
    }
    user.listingsCount = (user.listingsCount || 0) + 1;
    await user.save();

    const newListing = new Listing({ name, description, price, category, photos, contact, provincia, author: uid, featured });
    await newListing.save();
    res.json({ message: 'Listing added!', featured });
  } catch (err) {
    console.error('Add listing error:', err);
    res.status(500).json('Error: ' + err.message);
  }
});

// Get listings by user — public (listings are public)
router.get('/user/:uid', (req, res) => {
  Listing.find({ author: req.params.uid })
    .sort({ createdAt: -1 })
    .then(listings => res.json(listings))
    .catch(err => res.status(400).json('Error: ' + err));
});

// Get listing by ID — public, includes seller public info
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
    const { name, description, price, category, contact, provincia } = req.body;
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json('Listing not found');
    if (listing.author !== uid) return res.status(403).json('Not authorized');

    listing.name = name;
    listing.description = description;
    listing.price = price;
    listing.category = category;
    listing.contact = contact;
    if (provincia) listing.provincia = provincia;
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

// Delete listing — auth required, must own listing
router.post('/delete/:id', verifyToken, async (req, res) => {
  try {
    const uid = req.uid;
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json('Listing not found');
    if (listing.author !== uid) return res.status(403).json('Not authorized');

    await listing.deleteOne();
    await User.findOneAndUpdate({ firebaseUid: uid }, { $inc: { listingsCount: -1 } });
    res.json('Listing deleted');
  } catch (err) {
    console.error('Delete listing error:', err);
    res.status(500).json('Error: ' + err.message);
  }
});

module.exports = router;
