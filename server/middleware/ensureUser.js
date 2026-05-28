const User        = require('../models/user.model');
const { isOwner } = require('../config/plans');

/**
 * Middleware: guarantees req.dbUser is populated for every protected route.
 *
 * Uses findOneAndUpdate + upsert:true — never a separate find + create.
 *
 * ROOT CAUSE OF PREVIOUS DB_ERROR:
 *   setDefaultsOnInsert:true tells Mongoose to inject schema defaults into
 *   $setOnInsert automatically. The User schema has plan:{default:'free'}.
 *   For the owner we add $set:{plan:'pro'}. Mongoose then ALSO injects
 *   plan:'free' into $setOnInsert (from the schema default), giving MongoDB
 *   the same path in two operators → "path conflict at 'plan'" → DB_ERROR.
 *
 * FIX: do NOT use setDefaultsOnInsert. Specify every required field explicitly
 * in $setOnInsert so Mongoose has nothing left to inject.
 *
 * Must run AFTER verifyToken (needs req.uid and req.email).
 */
const ensureUser = async (req, res, next) => {
  try {
    const uid   = req.uid;
    const email = req.email || '';

    // Hard guard — uid must be set by verifyToken before this middleware runs.
    // An upsert with uid=null/undefined would match NO document but still write a
    // new record with firebaseUid:null, triggering E11000 on the uid_1 stale index
    // (and again for every subsequent user). Reject early so the DB is never touched.
    if (!uid) {
      console.error('[ensureUser] uid is null/undefined — verifyToken must run first');
      return res.status(401).json({ error: 'UID missing from token', code: 'NO_UID' });
    }

    const owner = isOwner(email);

    //
    // $setOnInsert — only fires when MongoDB inserts a new document (upsert).
    //
    // All schema fields with defaults are listed here explicitly so
    // Mongoose has nothing to inject via setDefaultsOnInsert.
    //
    // plan is intentionally absent for owner: $set handles it on both
    // insert and update without creating a path conflict.
    //
    const setOnInsert = {
      email,
      nombre:              '',
      apellido:            '',
      phone:               '',
      provincia:           '',
      singlePostCredits:   0,
      freeListingUsed:     false,
      listingsCount:       0,
      planExpiresAt:       null,
      stripeCustomerId:    null,
      stripeSubscriptionId: null,
      createdAt:           new Date(),
      ...(owner ? {} : { plan: 'free' }),
      // owner: plan comes from $set below — must NOT be here too
    };

    const update = { $setOnInsert: setOnInsert };

    // Owner: force plan:'pro' via $set (runs on insert AND update).
    // This field must be absent from $setOnInsert — having it in both
    // operators causes MongoDB to throw a path-conflict error.
    if (owner) update.$set = { plan: 'pro' };

    req.dbUser = await User.findOneAndUpdate(
      { firebaseUid: uid },
      update,
      {
        upsert: true,
        new:    true,
        // setDefaultsOnInsert is intentionally omitted — we list all fields
        // explicitly above to prevent Mongoose from injecting plan:'free'
        // into $setOnInsert for the owner (which would conflict with $set).
      }
    );

    next();
  } catch (err) {
    // Log the full error so the real message is visible in server logs
    console.error('[ensureUser] ERROR:', err.name, '|', err.message);
    res.status(500).json({
      error:   err.message,
      code:    'ENSURE_USER_FAILED',
    });
  }
};

module.exports = { ensureUser };
