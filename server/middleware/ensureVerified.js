const admin = require('firebase-admin');
const { isOwner } = require('../config/plans');

/**
 * Blocks actions (publishing, image uploads) for users whose email is not
 * verified. Must run AFTER verifyToken, which sets req.uid and req.email.
 *
 * We check Firebase directly (getUser) rather than the ID token's
 * email_verified claim, because a just-verified user's cached token can still
 * say false until it refreshes — getUser is always current.
 *
 * The owner is always allowed (never lock the founder out).
 */
async function ensureVerified(req, res, next) {
  if (!req.uid) {
    return res.status(401).json({ error: 'No autenticado', code: 'UNAUTHENTICATED' });
  }

  // Founder bypass.
  if (isOwner(req.email)) return next();

  // If Firebase Admin isn't initialized we can't check — fail closed in
  // production, fail open in dev so local testing still works.
  if (!admin.apps.length) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(500).json({ error: 'Servicio no disponible', code: 'NO_ADMIN' });
    }
    return next();
  }

  try {
    const userRecord = await admin.auth().getUser(req.uid);
    if (!userRecord.emailVerified) {
      return res.status(403).json({
        error: 'Verificá tu correo electrónico antes de publicar.',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }
    next();
  } catch (error) {
    console.error('[ensureVerified] getUser failed:', error.message);
    return res.status(500).json({ error: 'Error verificando la cuenta', code: 'VERIFY_FAILED' });
  }
}

module.exports = ensureVerified;
