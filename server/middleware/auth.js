const admin = require('firebase-admin');

const hasAdminConfig = !!(
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY
);

if (hasAdminConfig && !admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    if (hasAdminConfig) {
      // Full cryptographic verification (production + any env with Firebase creds)
      const decoded = await admin.auth().verifyIdToken(token);
      if (!decoded.uid) {
        return res.status(401).json({ error: 'Token missing UID', code: 'NO_UID_IN_TOKEN' });
      }
      req.uid   = decoded.uid;
      req.email = (decoded.email || '').toLowerCase().trim();
    } else {
      // ── INSECURE dev-only fallback ──────────────────────────────────────────
      // Decodes the JWT payload WITHOUT verifying the signature. This trusts any
      // self-crafted token and must NEVER run in production. server.js already
      // process.exit(1)s in production when Firebase env is missing, so
      // hasAdminConfig is always true there — but we double-guard here so this
      // branch can never be reached in prod even if that check is ever removed.
      if (process.env.NODE_ENV === 'production' || process.env.ALLOW_INSECURE_AUTH !== 'true') {
        console.error('[verifyToken] Firebase Admin not configured and insecure auth not explicitly enabled — rejecting.');
        return res.status(401).json({ error: 'Auth not configured', code: 'AUTH_NOT_CONFIGURED' });
      }
      const payloadB64 = token.split('.')[1];
      const json = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const payload = JSON.parse(json);
      req.uid   = payload.user_id || payload.sub;
      req.email = (payload.email || '').toLowerCase().trim();
      if (!req.uid) throw new Error('No UID in token');
    }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

module.exports = { verifyToken };
