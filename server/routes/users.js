const router = require('express').Router();
const User = require('../models/user.model');
const Listing = require('../models/listing.model');
const { verifyToken } = require('../middleware/auth');

function isOwner(email) {
  const e = (email || '').toLowerCase().trim();
  const fromEnv = (process.env.FOUNDER_EMAIL || '').toLowerCase().trim();
  return e === 'leomoyawr300@gmail.com' || (fromEnv && e === fromEnv);
}

// Public seller info — no auth needed
router.get('/public/:uid', async (req, res) => {
  const user = await User.findOne({ firebaseUid: req.params.uid })
    .select('nombre apellido phone provincia -_id')
    .lean();
  if (!user) return res.status(404).json('User not found');
  res.json(user);
});

// Ensure user profile exists after login/register — auth required
router.post('/ensure', verifyToken, async (req, res) => {
  const uid = req.uid;
  const { email, nombre, apellido, phone, provincia } = req.body;
  if (!email) return res.status(400).json('Email is required');

  let user = await User.findOne({ firebaseUid: uid });
  const isFounder = isOwner(email);

  if (!user) {
    user = await User.create({
      firebaseUid: uid,
      email,
      nombre: nombre || '',
      apellido: apellido || '',
      phone: phone || '',
      provincia: provincia || '',
      plan: isFounder ? 'pro' : 'free',
    });
  } else {
    // Auto-upgrade founder on every login
    if (isFounder && user.plan !== 'pro') {
      user.plan = 'pro';
      await user.save();
    }
  }
  res.json({ user });
});

// Get own user profile — auth required
router.get('/:uid', verifyToken, async (req, res) => {
  if (req.uid !== req.params.uid) return res.status(403).json('Forbidden');

  const user = await User.findOne({ firebaseUid: req.params.uid });
  if (!user) return res.status(404).json('User not found');

  // Owner always has Pro — force it in the response and persist async
  if (isOwner(user.email)) {
    if (user.plan !== 'pro') {
      user.plan = 'pro';
      user.save().catch(e => console.error('[owner upgrade]', e.message));
    }
    const userObj = user.toObject();
    userObj.plan = 'pro';
    const listingCount = await Listing.countDocuments({ author: req.params.uid, status: { $ne: 'sold' } });
    return res.json({ user: userObj, listingCount });
  }

  const listingCount = await Listing.countDocuments({ author: req.params.uid, status: { $ne: 'sold' } });
  res.json({ user, listingCount });
});

// Update profile info (nombre, apellido, phone, provincia) — auth required
router.put('/:uid/profile', verifyToken, async (req, res) => {
  if (req.uid !== req.params.uid) return res.status(403).json('Forbidden');

  const user = await User.findOne({ firebaseUid: req.params.uid });
  if (!user) return res.status(404).json('User not found');

  const { nombre, apellido, phone, provincia } = req.body;
  if (nombre !== undefined) user.nombre = nombre;
  if (apellido !== undefined) user.apellido = apellido;
  if (phone !== undefined) user.phone = phone;
  if (provincia !== undefined) user.provincia = provincia;
  await user.save();
  res.json({ user });
});

// Update plan — auth required (webhook is primary source)
router.put('/:uid/plan', verifyToken, async (req, res) => {
  if (req.uid !== req.params.uid) return res.status(403).json('Forbidden');

  const user = await User.findOne({ firebaseUid: req.params.uid });
  if (!user) return res.status(404).json('User not found');

  const { plan, planExpiresAt, stripeCustomerId, stripeSubscriptionId } = req.body;
  if (plan) user.plan = plan;
  if (planExpiresAt !== undefined) user.planExpiresAt = planExpiresAt;
  if (stripeCustomerId !== undefined) user.stripeCustomerId = stripeCustomerId;
  if (stripeSubscriptionId !== undefined) user.stripeSubscriptionId = stripeSubscriptionId;
  await user.save();

  if (user.plan === 'pro') {
    await Listing.updateMany({ author: req.params.uid }, { featured: true });
  }
  res.json({ user });
});

// Mark free listing as used — auth required
router.post('/:uid/free-listing', verifyToken, async (req, res) => {
  if (req.uid !== req.params.uid) return res.status(403).json('Forbidden');

  const user = await User.findOne({ firebaseUid: req.params.uid });
  if (!user) return res.status(404).json('User not found');

  user.freeListingUsed = true;
  await user.save();
  res.json({ user });
});

module.exports = router;
