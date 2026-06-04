// Sentry must load FIRST so its instrumentation installs before express/mongoose.
// It is a safe no-op when SENTRY_DSN is unset, and also calls dotenv.config().
const sentry = require('./config/sentry');
require('dotenv').config();

// Initialize Firebase Admin BEFORE anything else that might use it
const admin = require('firebase-admin');
const hasAdminConfig = !!(
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY
);
if (hasAdminConfig && !admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    console.log('[Firebase] Admin SDK initialized');
  } catch (err) {
    console.error('[Firebase] Initialization error:', err.message);
  }
}

const express   = require('express');
const mongoose  = require('mongoose');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const fs        = require('fs');
const dns       = require('dns').promises;

// Optional security dependencies — skip gracefully if not yet installed
let helmet, mongoSanitize;
try { helmet        = require('helmet');                 } catch { /* not installed yet */ }
try { mongoSanitize = require('express-mongo-sanitize'); } catch { /* not installed yet */ }

const app  = express();
const port = process.env.PORT || 3001;

// In production, never auto-build indexes on connect — on serverless that would
// fire on every cold start and add latency/timeout risk. Indexes are created
// once via a guarded migration (ensure_indexes_v7) in runStartupMigrations().
mongoose.set('autoIndex', process.env.NODE_ENV !== 'production');

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
  // SECURITY: in production, refuse to boot with missing secrets. Without the
  // Firebase Admin credentials, verifyToken silently falls back to accepting
  // UNSIGNED tokens (see middleware/auth.js) — anyone could forge an admin
  // identity. Failing fast here makes that degradation impossible in prod.
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to start in production with missing env vars.');
    process.exit(1);
  }
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
  // CRITICAL: never rate-limit Stripe's webhook. Stripe retries from many IPs and
  // a 429 here means permanently lost payment events. The cron endpoint is
  // separately authenticated and must not be throttled either.
  skip: (req) =>
    req.path === '/api/payment/webhook' ||
    req.path.startsWith('/api/cron/'),
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

// ─── Pretty referral links ───────────────────────────────────────────────────
// /ref/<username> → /register?ref=<username>. Lets members share a short, clean
// invite link (e.g. www.mercaticocr.com/ref/juan.perez) instead of a query
// string. The code must match our username charset; anything else falls through
// to a normal 404 (prevents this from becoming an open-redirect).
app.get('/ref/:code', (req, res, next) => {
  const code = String(req.params.code || '').toLowerCase();
  if (!/^[a-z0-9._-]{1,40}$/.test(code)) return next();
  return res.redirect(302, '/register?ref=' + encodeURIComponent(code));
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
    // Expired listings are off the marketplace until renewed
    if (listing.expiresAt && new Date(listing.expiresAt) <= new Date()) return next();

    const htmlPath = path.join(__dirname, '../product.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    // SECURITY (stored XSS): listing name/description are attacker-controlled and
    // are injected into HTML here. The previous code escaped only double-quotes
    // and put the RAW name inside <title>, so a listing named
    //   </title><script>…</script>
    // executed for every visitor of the product page. Escape ALL HTML-significant
    // characters for every interpolated value, in both element and attribute
    // contexts.
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const name   = esc(listing.name || 'Anuncio');
    const desc   = esc((listing.description || 'Ver anuncio en MercaTico').slice(0, 200));
    const price  = esc('₡' + Number(listing.price || 0).toLocaleString('es-CR'));
    // Only allow http(s) image URLs into the og:image attribute.
    let rawPhoto = (listing.photos && listing.photos[0]) ? String(listing.photos[0]) : '';
    // Make HEIC/older images renderable + optimized for the social preview too.
    if (rawPhoto.includes('res.cloudinary.com') && rawPhoto.includes('/upload/') && !/\/upload\/[^/]*f_auto/.test(rawPhoto)) {
      rawPhoto = rawPhoto.replace('/upload/', '/upload/f_auto,q_auto/');
    }
    const photo  = /^https?:\/\//i.test(rawPhoto) ? esc(rawPhoto) : '';
    const title  = `${name} — ${price} | MercaTico`;

    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
      .replace(
        '</head>',
        `  <meta name="description" content="${desc}">\n` +
        `  <meta property="og:title" content="${name}">\n` +
        `  <meta property="og:description" content="${desc}">\n` +
        `  <meta property="og:type" content="product">\n` +
        (photo ? `  <meta property="og:image" content="${photo}">\n` : '') +
        `  <meta property="og:site_name" content="MercaTico">\n` +
        `  <meta name="twitter:card" content="summary_large_image">\n` +
        `  <meta name="twitter:title" content="${name}">\n` +
        `  <meta name="twitter:description" content="${desc}">\n` +
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

// ─── Dynamic OG meta for seller profiles (/perfil?u=username) ────────────────
//
// Without this, sharing a seller link shows the generic "Vendedores - MercaTico"
// preview. Here we look up the seller and inject their name + avatar so the
// preview reads e.g. "Vendedor - Leonardo Moya | MercaTico". Must run BEFORE
// express.static so this overrides the static perfil.html. Falls through to the
// static page when there's no ?u= or the user isn't found.
app.get('/perfil', async (req, res, next) => {
  const username = String(req.query.u || '').trim().toLowerCase();
  if (!username) return next(); // generic /perfil directory → static page

  try {
    await connectDB();
    const User = require('./models/user.model');
    const user = await User.findOne({ username })
      .select('nombre apellido username photoURL -_id').lean();
    if (!user) return next();

    const htmlPath = path.join(__dirname, '../perfil.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const fullName = ((user.nombre || '') + ' ' + (user.apellido || '')).trim() || user.username;
    const name     = esc(fullName);
    const title    = `Vendedor - ${name} | MercaTico`;
    const ogTitle  = `Vendedor - ${name}`;
    const desc     = esc(`Mira todos los anuncios de ${fullName} en MercaTico.`);

    // Avatar for the preview image; optimize Cloudinary URLs and fall back to the
    // site image when the seller has no photo. og:image needs an absolute URL.
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    const base  = proto + '://' + req.headers.host;
    let rawPhoto = String(user.photoURL || '');
    if (rawPhoto.includes('res.cloudinary.com') && rawPhoto.includes('/upload/') && !/\/upload\/[^/]*f_auto/.test(rawPhoto)) {
      rawPhoto = rawPhoto.replace('/upload/', '/upload/f_auto,q_auto/');
    }
    const photo = /^https?:\/\//i.test(rawPhoto) ? esc(rawPhoto) : esc(base + '/images/estasies.png');
    const url   = esc(base + '/perfil?u=' + encodeURIComponent(user.username));

    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
      .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${desc}">`)
      .replace(
        '</head>',
        `  <meta property="og:title" content="${ogTitle}">\n` +
        `  <meta property="og:description" content="${desc}">\n` +
        `  <meta property="og:type" content="profile">\n` +
        `  <meta property="og:url" content="${url}">\n` +
        `  <meta property="og:image" content="${photo}">\n` +
        `  <meta property="og:site_name" content="MercaTico">\n` +
        `  <meta name="twitter:card" content="summary_large_image">\n` +
        `  <meta name="twitter:title" content="${ogTitle}">\n` +
        `  <meta name="twitter:description" content="${desc}">\n` +
        `  <meta name="twitter:image" content="${photo}">\n` +
        '</head>'
      );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(html);
  } catch (err) {
    console.error('[OG perfil]', err.message);
    next(); // fall through to static on any error
  }
});

// ─── Social link-preview (Open Graph) for the home + listings pages ──────────
//
// Injects og:/twitter: meta so links shared on WhatsApp/Facebook show a title,
// description and the logo image. Uses the request host so the absolute image
// URL is correct on any domain (vercel.app today, a custom domain later).
// Product pages get their own dynamic OG above; this covers the entry pages.
const _ogPages = {
  '/':         { title: 'MercaTico — Compra y vende en Costa Rica', desc: 'El mercado digital de Costa Rica. Compra y vende productos nuevos y usados cerca de ti.' },
  '/listings': { title: 'Anuncios - MercaTico', desc: 'Explora anuncios de Costa Rica: ropa, electrónica, hogar, vehículos, bienes raíces y más.' },
};
app.get(['/', '/listings'], (req, res, next) => {
  try {
    const meta = _ogPages[req.path];
    if (!meta) return next();
    const file = req.path === '/listings' ? 'listings.html' : 'index.html';
    let html = fs.readFileSync(path.join(__dirname, '../', file), 'utf8');

    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    const base  = proto + '://' + req.headers.host;
    const img   = base + '/images/estasies.png';
    const url   = base + req.path;
    const esc   = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const tags =
      `  <meta name="description" content="${esc(meta.desc)}">\n` +
      `  <meta property="og:title" content="${esc(meta.title)}">\n` +
      `  <meta property="og:description" content="${esc(meta.desc)}">\n` +
      `  <meta property="og:type" content="website">\n` +
      `  <meta property="og:url" content="${esc(url)}">\n` +
      `  <meta property="og:image" content="${esc(img)}">\n` +
      `  <meta property="og:site_name" content="MercaTico">\n` +
      `  <meta name="twitter:card" content="summary_large_image">\n` +
      `  <meta name="twitter:title" content="${esc(meta.title)}">\n` +
      `  <meta name="twitter:description" content="${esc(meta.desc)}">\n` +
      `  <meta name="twitter:image" content="${esc(img)}">\n`;

    html = html.replace('</head>', tags + '</head>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.send(html);
  } catch (err) {
    console.error('[OG home/listings]', err.message);
    next(); // fall through to static on any error
  }
});

// Serve static frontend from project root.
// HTML is served with no-cache so browsers (esp. mobile Safari) always pick up
// the latest markup — otherwise a stale cached page keeps loading old form/JS
// references after a deploy. JS/CSS stay cacheable; they're busted via ?v=.
app.use(express.static(path.join(__dirname, '../'), {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

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
    // 5b. Ensure all schema indexes exist (one-time per schema version).
    //
    //     autoIndex is disabled in production, so we build indexes explicitly here
    //     exactly once, guarded by a _migrations marker. createIndexes only ADDS
    //     missing indexes (never drops), so it's safe and idempotent. Each model
    //     is wrapped independently: a failure to build one (e.g. a legacy
    //     duplicate-email blocking the unique index) is logged but never blocks
    //     the others or the server. Bump the version suffix to force a rebuild
    //     after adding new indexes.
    const indexesRan = await migrationsCol.findOne({ name: 'ensure_indexes_v7' });
    if (!indexesRan) {
      const models = {
        User:           require('./models/user.model'),
        Listing:        require('./models/listing.model'),
        Report:         require('./models/report.model'),
        ProcessedEvent: require('./models/processedEvent.model'),
        AuditLog:       require('./models/auditLog.model'),
      };
      let allOk = true;
      for (const [name, Model] of Object.entries(models)) {
        try {
          await Model.createIndexes();
          console.log(`[migration] Indexes ensured for ${name}`);
        } catch (e) {
          allOk = false;
          console.error(`[migration] createIndexes failed for ${name}:`, e.message);
        }
      }
      // Only mark complete if every model succeeded, so a transient failure
      // (e.g. a duplicate that still needs cleanup) retries on the next cold start.
      if (allOk) {
        await migrationsCol.insertOne({ name: 'ensure_indexes_v7', ranAt: new Date() });
      }
    }

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

    // 6. Backfill expiresAt on listings created before the expiry feature.
    //    Give every existing listing a fresh 30-day window from now so nothing
    //    disappears the moment the feature ships; new clocks start on renewal.
    const expiryBackfillRan = await migrationsCol.findOne({ name: 'backfill_listing_expiry_v1' });
    if (!expiryBackfillRan) {
      const listingsCol = mongoose.connection.collection('listings');
      const thirtyDaysOut = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const backfilled = await listingsCol.updateMany(
        { expiresAt: { $exists: false } },
        { $set: { expiresAt: thirtyDaysOut } }
      );
      await migrationsCol.insertOne({ name: 'backfill_listing_expiry_v1', ranAt: new Date() });
      console.log(`[migration] backfill_listing_expiry_v1: set expiresAt on ${backfilled.modifiedCount} listing(s)`);
    }

    // 7. Backfill public usernames (handles) for existing users.
    //    New users get one lazily on their first /me; this seeds every legacy
    //    account so they're searchable and have a public profile immediately.
    const usernameBackfillRan = await migrationsCol.findOne({ name: 'backfill_usernames_v1' });
    if (!usernameBackfillRan) {
      const usersCol = mongoose.connection.collection('users');
      const needing = await usersCol
        .find({ $or: [{ username: { $exists: false } }, { username: '' }, { username: null }] })
        .project({ email: 1, firebaseUid: 1 })
        .toArray();
      // Build usernames in-memory, tracking taken handles to guarantee uniqueness
      // across the batch (the DB unique index is the ultimate guard).
      const taken = new Set(
        (await usersCol.find({ username: { $type: 'string', $gt: '' } }).project({ username: 1 }).toArray())
          .map(u => u.username)
      );
      const slug = (email) => {
        const local = String(email || '').split('@')[0].toLowerCase();
        const s = local.normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[^a-z0-9._-]+/g, '').replace(/[._-]{2,}/g, '.').replace(/^[._-]+|[._-]+$/g, '');
        return s || 'usuario';
      };
      let made = 0;
      for (const u of needing) {
        const base = slug(u.email);
        let candidate = base, n = 1;
        while (taken.has(candidate)) { n += 1; candidate = base + '-' + n; }
        taken.add(candidate);
        try {
          await usersCol.updateOne({ _id: u._id }, { $set: { username: candidate } });
          made += 1;
        } catch (e) {
          if (e.code !== 11000) console.warn('[migration] username backfill row failed:', e.message);
        }
      }
      await migrationsCol.insertOne({ name: 'backfill_usernames_v1', ranAt: new Date() });
      console.log(`[migration] backfill_usernames_v1: set username on ${made} user(s)`);
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
app.use('/api/cron',     require('./routes/cron'));

// Sentry express error handler — must come AFTER all routes. No-op when disabled.
sentry.setupExpressErrorHandler(app);

if (require.main === module) {
  app.listen(port, () => console.log(`Server running on port ${port}`));
}

module.exports = app;
