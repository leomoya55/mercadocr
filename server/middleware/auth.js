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
      // Production: full cryptographic verification
      const decoded = await admin.auth().verifyIdToken(token);
      req.uid   = decoded.uid;
      req.email = (decoded.email || '').toLowerCase().trim();
    } else {
      // Dev mode: decode JWT payload without signature verification
      // Firebase tokens are JWTs — user_id/sub holds the UID
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
