/**
 * server/routes/admin.js
 *
 * All routes are protected by two layers:
 *   1. verifyToken  — Firebase JWT must be valid
 *   2. isOwner gate — email must match OWNER_EMAIL (backend-enforced, never trust frontend)
 *
 * Frontend hiding is a UX convenience only. This file is the authoritative gate.
 */

const router  = require('express').Router();
const Listing = require('../models/listing.model');
const User    = require('../models/user.model');
const Report  = require('../models/report.model');
const { verifyToken } = require('../middleware/auth');
const { isOwner }     = require('../config/plans');

// ─── Admin guard (applies to every route in this file) ───────────────────────
router.use(verifyToken, (req, res, next) => {
  if (!isOwner(req.email)) {
    return res.status(403).json({ error: 'Forbidden', code: 'NOT_ADMIN' });
  }
  next();
});

// ─── Stats ────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/stats
 * Returns aggregate counts for the dashboard overview.
 */
router.get('/stats', async (req, res) => {
  try {
    const [
      totalListings,
      activeListings,
      soldListings,
      hiddenListings,
      totalUsers,
      proUsers,
      basicUsers,
      pendingReports,
    ] = await Promise.all([
      Listing.countDocuments(),
      Listing.countDocuments({ status: 'active', hidden: { $ne: true } }),
      Listing.countDocuments({ status: 'sold' }),
      Listing.countDocuments({ hidden: true }),
      User.countDocuments(),
      User.countDocuments({ plan: 'pro' }),
      User.countDocuments({ plan: 'basic' }),
      Report.countDocuments({ status: 'pending' }),
    ]);

    res.json({
      listings: {
        total:  totalListings,
        active: activeListings,
        sold:   soldListings,
        hidden: hiddenListings,
      },
      users: {
        total: totalUsers,
        pro:   proUsers,
        basic: basicUsers,
        free:  totalUsers - proUsers - basicUsers,
      },
      reports: { pending: pendingReports },
    });
  } catch (err) {
    console.error('[GET /admin/stats]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Listings ─────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/listings
 * Query params: page, limit, status, hidden (true/false), q, author (firebaseUid)
 */
router.get('/listings', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(50, parseInt(req.query.limit) || 20);
    const skip   = (page - 1) * limit;
    const filter = {};

    if (req.query.status) filter.status = req.query.status;
    if (req.query.hidden === 'true')  filter.hidden = true;
    if (req.query.hidden === 'false') filter.hidden = { $ne: true };
    if (req.query.author) filter.author = req.query.author;
    if (req.query.q)      filter.$text  = { $search: req.query.q };

    const [listings, total] = await Promise.all([
      Listing.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Listing.countDocuments(filter),
    ]);

    res.json({ listings, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('[GET /admin/listings]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/listings/:id/hide
 * POST /api/admin/listings/:id/unhide
 */
router.post('/listings/:id/hide', async (req, res) => {
  try {
    const listing = await Listing.findByIdAndUpdate(req.params.id, { hidden: true }, { new: true });
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    res.json({ success: true, hidden: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/listings/:id/unhide', async (req, res) => {
  try {
    const listing = await Listing.findByIdAndUpdate(req.params.id, { hidden: false }, { new: true });
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    res.json({ success: true, hidden: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/listings/:id/feature   body: { featured: true|false }
 */
router.post('/listings/:id/feature', async (req, res) => {
  try {
    const featured = req.body.featured !== false; // default true
    const listing  = await Listing.findByIdAndUpdate(
      req.params.id, { featured }, { new: true }
    );
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    res.json({ success: true, featured: listing.featured });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/admin/listings/:id
 */
router.delete('/listings/:id', async (req, res) => {
  try {
    const listing = await Listing.findByIdAndDelete(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Users ────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/users
 * Query params: page, limit, plan (free|basic|pro), q (search name/email)
 */
router.get('/users', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;
    const filter = {};

    if (req.query.plan) filter.plan = req.query.plan;
    if (req.query.q) {
      const rx = new RegExp(req.query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ nombre: rx }, { apellido: rx }, { email: rx }];
    }

    const [users, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).select('-__v').lean(),
      User.countDocuments(filter),
    ]);

    res.json({ users, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('[GET /admin/users]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/users/:uid/plan   body: { plan: 'free'|'basic'|'pro' }
 * Manually set a user's plan (e.g. manually grant Pro).
 */
router.post('/users/:uid/plan', async (req, res) => {
  try {
    const valid = ['free', 'basic', 'pro'];
    const { plan } = req.body;
    if (!valid.includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan', valid });
    }
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.params.uid },
      { $set: { plan } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, plan: user.plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/users/:uid/credits   body: { delta: 1 | -1 }
 * Increment or decrement a user's singlePostCredits.
 */
router.post('/users/:uid/credits', async (req, res) => {
  try {
    const delta = parseInt(req.body.delta) || 0;
    if (delta === 0) return res.status(400).json({ error: 'delta must be non-zero' });

    const user = await User.findOneAndUpdate(
      { firebaseUid: req.params.uid },
      { $inc: { singlePostCredits: delta } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Clamp to 0 if we went negative
    if (user.singlePostCredits < 0) {
      await User.updateOne({ firebaseUid: req.params.uid }, { $set: { singlePostCredits: 0 } });
      user.singlePostCredits = 0;
    }

    res.json({ success: true, credits: user.singlePostCredits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Reports ─────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/reports
 * Query params: page, limit, status (pending|reviewed|dismissed|actioned)
 */
router.get('/reports', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(50, parseInt(req.query.limit) || 20);
    const skip   = (page - 1) * limit;
    const filter = {};
    if (req.query.status) filter.status = req.query.status;

    const [reports, total] = await Promise.all([
      Report.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('listingId', 'name status hidden')
        .lean(),
      Report.countDocuments(filter),
    ]);

    res.json({ reports, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('[GET /admin/reports]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/reports/:id/:action
 * action: reviewed | dismissed | actioned
 */
router.post('/reports/:id/:action', async (req, res) => {
  try {
    const valid  = ['reviewed', 'dismissed', 'actioned'];
    const { action } = req.params;
    if (!valid.includes(action)) {
      return res.status(400).json({ error: 'Invalid action', valid });
    }
    const report = await Report.findByIdAndUpdate(
      req.params.id, { status: action }, { new: true }
    );
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json({ success: true, status: report.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
