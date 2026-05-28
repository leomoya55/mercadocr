const User            = require('../models/user.model');
const { isOwner }     = require('../config/plans');

/**
 * Middleware: guarantees req.dbUser is populated for every protected route.
 *
 * Uses findOneAndUpdate + upsert:true — never a separate find + create.
 * If the user document does not exist, it is created atomically via $setOnInsert.
 * The owner account always has plan:'pro' forced via $set (runs on every request).
 *
 * Must run AFTER verifyToken (needs req.uid and req.email).
 */
const ensureUser = async (req, res, next) => {
  try {
    const uid   = req.uid;
    const email = req.email || '';
    const owner = isOwner(email);

    // $setOnInsert: applied only when MongoDB inserts a new document
    const setOnInsert = {
      email,
      nombre:            '',
      apellido:          '',
      phone:             '',
      provincia:         '',
      plan:              owner ? 'pro' : 'free',
      singlePostCredits: 0,
    };

    const update = { $setOnInsert: setOnInsert };

    // Owner: force plan:'pro' on every request (update AND insert)
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
