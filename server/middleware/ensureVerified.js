const admin = require('firebase-admin');

async function ensureVerified(req, res, next) {
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
        console.error('Error checking email verification status:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}

module.exports = ensureVerified;
