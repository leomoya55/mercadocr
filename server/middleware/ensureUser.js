const User        = require('../models/user.model');
const { isOwner } = require('../config/plans');

/**
 * Middleware: guarantees req.dbUser is populated for every protected route.
 *
 * Uses findOneAndUpdate + upsert:true — never a separate find + create.
 *
 * IMPORTANT: A field must appear in ONLY ONE update operator per operation.
 * MongoDB throws "path conflict" if the same field appears in both $set and
 * $setOnInsert. So for the owner we put plan:'pro' in $set ONLY, and for
 * non-owners we put plan:'free' in $setOnInsert ONLY.
 *
 * Must run AFTER verifyToken (needs req.uid and req.email).
 */
const ensureUser = async (req, res, next) => {
  try {
    const uid   = req.uid;
    const email = req.email || '';
    const owner = isOwner(email);

    // $setOnInsert: applied only when MongoDB creates a new document.
    // plan is intentionally omitted here for the owner — $set handles it.
    const setOnInsert = {
      email,
      nombre:            '',
      apellido:          '',
      phone:             '',
      provincia:         '',
      singlePostCredits: 0,
      ...(owner ? {} : { plan: 'free' }), // non-owner only: set plan on first insert
    };

    const update = { $setOnInsert: setOnInsert };

    // Owner: force plan:'pro' via $set so it applies on BOTH insert and update.
    // This must NOT also appear in $setOnInsert (MongoDB path conflict).
    if (owner) update.$set = { plan: 'pro' };

    req.dbUser = await User.findOneAndUpdate(
      { firebaseUid: uid },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    next();
  } catch (err) {
    console.error('[ensureUser]', err.message);
    res.status(500).json({ error: 'DB_ERROR' });
  }
};

module.exports = { ensureUser };
