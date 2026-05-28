const router  = require('express').Router();
const Report  = require('../models/report.model');
const Listing = require('../models/listing.model');
const { verifyToken } = require('../middleware/auth');

const VALID_REASONS = ['spam', 'scam', 'inappropriate', 'wrong_category', 'duplicate', 'other'];

/**
 * POST /api/reports
 * Authenticated: any logged-in user can report a listing once.
 * A unique index on (listingId, reporterUid) prevents duplicate reports.
 */
router.post('/', verifyToken, async (req, res) => {
  try {
    const { listingId, reason, details } = req.body;

    if (!listingId || !reason) {
      return res.status(400).json({ error: 'listingId y reason son requeridos' });
    }
    if (!VALID_REASONS.includes(reason)) {
      return res.status(400).json({ error: 'Razón inválida', valid: VALID_REASONS });
    }

    const listing = await Listing.findById(listingId).lean();
    if (!listing) return res.status(404).json({ error: 'Anuncio no encontrado' });

    // Prevent self-reporting
    if (listing.author === req.uid) {
      return res.status(400).json({ error: 'No puedes reportar tu propio anuncio' });
    }

    const report = new Report({
      listingId,
      reporterUid: req.uid,
      reason,
      details: (details || '').slice(0, 500),
    });

    await report.save();
    res.json({ success: true, message: 'Reporte enviado. Gracias por ayudar a mantener la comunidad.' });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Ya reportaste este anuncio anteriormente.' });
    }
    console.error('[POST /reports]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
