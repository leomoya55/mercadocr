const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

const requiredEnv = ['MONGO_URI', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET',
  'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
const missing = requiredEnv.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('MISSING ENV VARS:', missing.join(', '));
}

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : [
      'http://localhost:5000',
      'http://localhost:5500',
      'http://localhost:5501',
      'http://127.0.0.1:5500',
      'http://127.0.0.1:5501',
    ];

// In production (Vercel), all requests are same-origin so we allow any origin
// that the browser presents — the vercel.json routes everything through server.js
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / server-to-server
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (process.env.NODE_ENV === 'production' || !process.env.ALLOWED_ORIGINS) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

app.use('/api/payment/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Redirect .html URLs to clean paths (preserve query string)
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    const base = req.path.slice(0, -5);
    const clean = base === '/index' ? '/' : base;
    return res.redirect(301, clean + req.url.slice(req.path.length));
  }
  next();
});

// Serve static frontend from project root
app.use(express.static(path.join(__dirname, '../'), { extensions: ['html'] }));

// Serverless-safe MongoDB connection
const connectDB = async () => {
  const state = mongoose.connection.readyState;
  if (state === 1) return; // already connected
  if (state === 2) {
    // Already connecting — wait instead of calling connect() again
    await new Promise((resolve, reject) => {
      mongoose.connection.once('connected', resolve);
      mongoose.connection.once('error', reject);
    });
    return;
  }
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 8000,
    socketTimeoutMS: 30000,
  });
  console.log('MongoDB connected');
};

// Health check — always responds even if DB is down (no auth, no DB required)
app.get('/api/health', (req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.json({
    server: 'ok',
    db: states[mongoose.connection.readyState] || 'unknown',
    env: {
      MONGO_URI:            !!process.env.MONGO_URI,
      STRIPE_SECRET_KEY:    !!process.env.STRIPE_SECRET_KEY,
      FIREBASE_PROJECT_ID:  !!process.env.FIREBASE_PROJECT_ID,
      FIREBASE_CLIENT_EMAIL:!!process.env.FIREBASE_CLIENT_EMAIL,
      FIREBASE_PRIVATE_KEY: !!process.env.FIREBASE_PRIVATE_KEY,
      CLOUDINARY_CLOUD_NAME:!!process.env.CLOUDINARY_CLOUD_NAME,
    },
  });
});

// Best-effort connect at startup
connectDB().catch(err => console.error('Initial DB connect error:', err.message));

// Ensure DB is ready before every API call (handles cold starts)
app.use('/api/', async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('DB connect error:', err.message);
    res.status(503).json({ error: 'DB_UNAVAILABLE' });
  }
});

app.use('/api/listings', require('./routes/listings'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/users', require('./routes/users'));

if (require.main === module) {
  app.listen(port, () => console.log(`Server running on port ${port}`));
}

module.exports = app;
