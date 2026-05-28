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
  try {
    const uid = req.uid;
    const { email, nombre, apellido, phone, provincia } = req.body;
    if (!email) return res.status(400).json('Email is required');

    let user = await User.findOne({ firebaseUid: uid });
    // Use token email (req.email) as the authoritative check — body email is a fallback
    const isFounder = isOwner(req.email) || isOwner(email);

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
      let changed = false;
      // Fill in any missing profile fields that were passed (e.g. from registration)
      if (phone && !user.phone)       { user.phone    = phone;    changed = true; }
      if (provincia && !user.provincia){ user.provincia = provincia; changed = true; }
      if (nombre && !user.nombre)     { user.nombre   = nombre;   changed = true; }
      if (apellido && !user.apellido) { user.apellido  = apellido;  changed = true; }
      // Auto-upgrade founder on every login
      if (isFounder && user.plan !== 'pro') { user.plan = 'pro'; changed = true; }
      if (changed) await user.save();
    }
    res.json({ user });
  } catch (err) {
    console.error('[ensure]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get own user profile — auth required
router.get('/:uid', verifyToken, async (req, res) => {
  try {
    if (req.uid !== req.params.uid) return res.status(403).json('Forbidden');

    const user = await User.findOne({ firebaseUid: req.params.uid });
    if (!user) return res.status(404).json('User not found');

    // Owner always has Pro — check Firebase token email (most reliable) then DB email
    if (isOwner(req.email) || isOwner(user.email)) {
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
  } catch (err) {
    console.error('[GET /:uid]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update profile info (nombre, apellido, phone, provincia) — auth required
router.put('/:uid/profile', verifyToken, async (req, res) => {
  try {
    if (req.uid !== req.params.uid) return res.status(403).json('Forbidden');

    const { nombre, apellido, phone, provincia } = req.body;

    // Upsert: create profile if it doesn't exist yet (handles race on first visit)
    let user = await User.findOne({ firebaseUid: req.params.uid });
    if (!user) {
      user = new User({
        firebaseUid: req.params.uid,
        email: req.email || '',
        plan: isOwner(req.email) ? 'pro' : 'free',
      });
    }

    // Unique phone check — skip for empty values
    const cleanPhone = (phone || '').trim();
    if (cleanPhone) {
      const conflict = await User.findOne({ phone: cleanPhone, firebaseUid: { $ne: req.params.uid } });
      if (conflict) return res.status(409).json({ error: 'Este número ya está registrado por otra cuenta.' });
    }

    if (nombre    !== undefined) user.nombre    = nombre;
    if (apellido  !== undefined) user.apellido  = apellido;
    if (phone     !== undefined) user.phone     = cleanPhone;
    if (provincia !== undefined) user.provincia = provincia;
    await user.save();
    res.json({ user });
  } catch (err) {
    console.error('[PUT /:uid/profile]', err.message);
    res.status(500).json({ error: err.message });
  }
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
