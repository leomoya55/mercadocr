const admin = require('firebase-admin');

async function ensureVerified(req, res, next) {
    // Verify that Firebase Admin is initialized and req.user is set
    if (!req.user || !req.user.uid) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    // Check if Firebase Admin is available
    if (!admin.apps.length) {
        console.error('Firebase Admin SDK not initialized');
        return res.status(500).json({ error: 'Service temporarily unavailable' });
    }

    const { uid } = req.user;

    try {
        const userRecord = await admin.auth().getUser(uid);
        if (!userRecord.emailVerified) {
            return res.status(403).json({
                error: 'Email not verified',
                message: 'Please verify your email address to perform this action.'
            });
        }
        next();
    } catch (error) {
        console.error('Error checking email verification status:', error.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}

module.exports = ensureVerified;
