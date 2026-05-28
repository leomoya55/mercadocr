const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const rateLimit = require('express-rate-limit');
const path     = require('path');
const fs       = require('fs');
const dns      = require('dns').promises;
require('dotenv').config();

// Optional security dependencies — skip gracefully if not yet installed
let helmet, mongoSanitize;
try { helmet       = require('helmet');                  } catch { /* not installed yet */ }
try { mongoSanitize = require('express-mongo-sanitize'); } catch { /* not installed yet */ }

const app  = express();
const port = process.env.PORT || 5000;

// ─── Security headers ─────────────────────────────────────────────────────────
if (helmet) {
  app.use(helmet({
    contentSecurityPolicy: false, // Configured separately if needed
    crossOriginEmbedderPolicy: false,
  }));
}

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

// ─── NoSQL injection protection ───────────────────────────────────────────────
// Strips keys that start with '$' or contain '.' from req.body/params/query.
if (mongoSanitize) {
  app.use(mongoSanitize());
}

// ─── Structured request logger ────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (req.path.startsWith('/api/') || res.statusCode >= 400) {
      console.log(JSON.stringify({
        ts:     new Date().toISOString(),
        method: req.method,
        path:   req.path,
        status: res.statusCode,
        ms,
        uid:    req.uid || null,
      }));
    }
  });
  next();
});

// Redirect .html URLs to clean paths (preserve query string)
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    const base = req.path.slice(0, -5);
    const clean = base === '/index' ? '/' : base;
    return res.redirect(301, clean + req.url.slice(req.path.length));
  }
  next();
});

// ─── OG / SEO meta-tag injection for product pages ───────────────────────────
//
// Must come BEFORE express.static so dynamic meta overrides the static file.
// Only handles GET /product?id=… — all other routes continue to static.
//
// Pattern: read product.html, patch <title> and <meta> tags, stream response.
// No server-side render framework needed — simple string replacement.
//
app.get('/product', async (req, res, next) => {
  const id = req.query.id;
  if (!id) return next(); // no id → fall through to static (will 404 gracefully)

  try {
    await connectDB();
    const Listing = require('./models/listing.model');
    const listing  = await Listing.findById(id).lean();
    if (!listing || listing.hidden) return next();

    const htmlPath = path.join(__dirname, '../product.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const name   = listing.name        || 'Anuncio';
    const desc   = listing.description || 'Ver anuncio en MercadoCR';
    const price  = '₡' + Number(listing.price).toLocaleString('es-CR');
    const photo  = listing.photos && listing.photos[0] ? listing.photos[0] : '';
    const title  = `${name} — ${price} | MercadoCR`;
    const descSafe = desc.replace(/"/g, '&quot;').slice(0, 200);
    const nameSafe = name.replace(/"/g, '&quot;');

    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
      .replace(
        '</head>',
        `  <meta name="description" content="${descSafe}">\n` +
        `  <meta property="og:title" content="${nameSafe}">\n` +
        `  <meta property="og:description" content="${descSafe}">\n` +
        `  <meta property="og:type" content="product">\n` +
        (photo ? `  <meta property="og:image" content="${photo}">\n` : '') +
        `  <meta property="og:site_name" content="MercadoCR">\n` +
        `  <meta name="twitter:card" content="summary_large_image">\n` +
        `  <meta name="twitter:title" content="${nameSafe}">\n` +
        `  <meta name="twitter:description" content="${descSafe}">\n` +
        (photo ? `  <meta name="twitter:image" content="${photo}">\n` : '') +
        '</head>'
      );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60'); // 1-min cache
    res.send(html);
  } catch (err) {
    console.error('[OG inject]', err.message);
    next(); // fall through to static on any error
  }
});

// Serve static frontend from project root
app.use(express.static(path.join(__dirname, '../'), { extensions: ['html'] }));

// Serverless-safe MongoDB connection
let lastDbError = null;

// ─── Startup migrations ───────────────────────────────────────────────────────
//
// Runs once per cold start, immediately after the first successful DB connect.
// Each step is idempotent — safe to run on every deploy / restart.
//
//  1. Drop the stale uid_1 index (old schema used field 'uid'; current schema uses
//     'firebaseUid'). Without dropping it, every new user upsert writes firebaseUid
//     and leaves uid absent — MongoDB stores that as uid:null in the non-sparse
//     index. The second new user hits E11000 duplicate key { uid: null }.
//
//  2. Migrate any legacy documents that stored the UID in 'uid' (not 'firebaseUid').
//     ensureUser's filter is { firebaseUid: uid }, so these records are invisible to
//     the current code and trigger a new-insert attempt on every login → E11000.
//
//  3. Delete corrupted documents produced by past failed upserts: those with
//     firebaseUid null or missing are unusable orphan records and block new
//     registrations.
//
async function runStartupMigrations() {
  try {
    const col = mongoose.connection.collection('users');

    // 1. Drop stale uid_1 index
    try {
      await col.dropIndex('uid_1');
      console.log('[migration] Dropped stale uid_1 index');
    } catch (err) {
      if (err.code === 27) {
        // IndexNotFound — already dropped or never existed; nothing to do
      } else {
        console.warn('[migration] uid_1 dropIndex failed:', err.code, err.message);
      }
    }

    // 2. Rename uid → firebaseUid on old documents
    const migrated = await col.updateMany(
      { uid: { $exists: true }, firebaseUid: { $exists: false } },
      { $rename: { uid: 'firebaseUid' } }
    );
    if (migrated.modifiedCount > 0) {
      console.log(`[migration] Renamed uid→firebaseUid on ${migrated.modifiedCount} document(s)`);
    }

    // 3. Delete corrupted documents with null/missing firebaseUid
    const deleted = await col.deleteMany({
      $or: [{ firebaseUid: null }, { firebaseUid: { $exists: false } }],
    });
    if (deleted.deletedCount > 0) {
      console.log(`[migration] Deleted ${deleted.deletedCount} corrupted user doc(s) (null/missing firebaseUid)`);
    }

    // 4. Deduplicate user documents by email (one-time).
    //
    //    During the E11000 bug period, failed upserts sometimes produced multiple
    //    user documents for the same email with different firebaseUid values.
    //    For each duplicated email we keep the most complete record (has a name,
    //    newest createdAt) and delete the rest.
    //
    const migrationsCol = mongoose.connection.collection('_migrations');
    const dedupRan = await migrationsCol.findOne({ name: 'dedup_users_by_email_v1' });
    if (!dedupRan) {
      const dups = await col.aggregate([
        { $group: {
            _id:  '$email',
            count: { $sum: 1 },
            docs: { $push: { id: '$_id', nombre: '$nombre', createdAt: '$createdAt' } },
        }},
        { $match: { count: { $gt: 1 }, _id: { $nin: [null, ''] } } },
      ]).toArray();

      let totalRemoved = 0;
      for (const dup of dups) {
        // Sort: has nombre first, then newest createdAt — keep index 0
        const sorted = dup.docs.sort(function (a, b) {
          const aN = a.nombre ? 1 : 0;
          const bN = b.nombre ? 1 : 0;
          if (aN !== bN) return bN - aN;
          return new Date(b.createdAt) - new Date(a.createdAt);
        });
        const deleteIds = sorted.slice(1).map(function (d) { return d.id; });
        if (deleteIds.length) {
          await col.deleteMany({ _id: { $in: deleteIds } });
          totalRemoved += deleteIds.length;
          console.log(`[migration] Removed ${deleteIds.length} duplicate(s) for email: ${dup._id}`);
        }
      }
      await migrationsCol.insertOne({ name: 'dedup_users_by_email_v1', ranAt: new Date() });
      if (totalRemoved === 0) console.log('[migration] dedup_users_by_email_v1: no duplicates found');
    }

    // 5. Clear auto-featured listings (one-time, tracked so it never re-runs).
    //
    //    Old versions of the code set featured:true automatically for Pro plan
    //    users. That logic was removed — featured is now a manual admin action
    //    only (POST /api/admin/listings/:id/feature).
    //
    //    We track completion in a _migrations collection so this step is skipped
    //    on subsequent cold starts and never touches listings the admin
    //    intentionally features via the admin panel in the future.
    const alreadyRan = await migrationsCol.findOne({ name: 'clear_auto_featured_v1' });
    if (!alreadyRan) {
      const listingsCol = mongoose.connection.collection('listings');
      const cleared = await listingsCol.updateMany(
        { featured: true },
        { $set: { featured: false } }
      );
      await migrationsCol.insertOne({ name: 'clear_auto_featured_v1', ranAt: new Date() });
      if (cleared.modifiedCount > 0) {
        console.log(`[migration] Cleared featured flag on ${cleared.modifiedCount} listing(s) (auto-featured cleanup)`);
      } else {
        console.log('[migration] clear_auto_featured_v1: no listings to clear');
      }
    }
  } catch (err) {
    // Never let a migration error prevent the server from starting
    console.error('[migration] Startup migration error:', err.message);
  }
}

const connectDB = async () => {
  const state = mongoose.connection.readyState;
  if (state === 1) return;
  if (state === 2) {
    await new Promise((resolve, reject) => {
      mongoose.connection.once('connected', resolve);
      mongoose.connection.once('error', reject);
    });
    return;
  }
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 30000,
      maxPoolSize: 1,   // serverless: one connection per function instance
    });
    lastDbError = null;
    console.log('MongoDB connected');
    // Run once per cold start — drops stale uid_1 index, migrates old uid field,
    // cleans up corrupted documents. All steps are idempotent.
    await runStartupMigrations();
  } catch (err) {
    lastDbError = err.message;
    throw err;
  }
};

// Health check — awaits DB connection so status is accurate
app.get('/api/health', async (req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];

  // Wait for connection so we report the real state, not just "connecting"
  let connectErr = null;
  try { await connectDB(); } catch (e) { connectErr = e.message; }

  // Atlas SRV hostnames have no A records — test SRV first, fall back to A
  let dnsStatus = 'no MONGO_URI';
  const uriMatch = (process.env.MONGO_URI || '').match(/@([^/?]+)/);
  const clusterHost = uriMatch ? uriMatch[1].split(':')[0] : null;
  if (clusterHost) {
    try {
      await dns.resolveSrv(`_mongodb._tcp.${clusterHost}`);
      dnsStatus = 'resolved (SRV)';
    } catch {
      try {
        await dns.resolve(clusterHost);
        dnsStatus = 'resolved (A)';
      } catch (e2) {
        dnsStatus = 'FAILED: ' + e2.message;
      }
    }
  }

  res.json({
    server: 'ok',
    db: states[mongoose.connection.readyState] || 'unknown',
    dbError: connectErr || lastDbError || null,
    clusterHost,
    dns: dnsStatus,
    env: {
      MONGO_URI:             !!process.env.MONGO_URI,
      STRIPE_SECRET_KEY:     !!process.env.STRIPE_SECRET_KEY,
      FIREBASE_PROJECT_ID:   !!process.env.FIREBASE_PROJECT_ID,
      FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
      FIREBASE_PRIVATE_KEY:  !!process.env.FIREBASE_PRIVATE_KEY,
      CLOUDINARY_CLOUD_NAME: !!process.env.CLOUDINARY_CLOUD_NAME,
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
app.use('/api/payment',  require('./routes/payment'));
app.use('/api/users',    require('./routes/users'));
app.use('/api/reports',  require('./routes/reports'));
app.use('/api/admin',    require('./routes/admin'));

if (require.main === module) {
  app.listen(port, () => console.log(`Server running on port ${port}`));
}

module.exports = app;
