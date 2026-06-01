# MercaTico — Launch Readiness Review

_Prepared after implementing Epics #1–#6. Context: public beta with 20–30 free Pro testers._

This codebase is in genuinely good shape for a solo/small launch: serverless‑aware, webhook‑driven entitlement resolver, idempotent migrations, cron backstops, audit log, NoSQL sanitization, helmet, rate limiting, server‑side price selection, and a prior stored‑XSS fix. The notes below are about hardening for real users + payments, not foundational rewrites.

Severity legend: 🔴 fix before launch · 🟡 fix soon after · 🟢 nice‑to‑have / scale.

---

## 1. Bugs found

- 🟡 **Orphaned Cloudinary images (new in Epic #1).** Publish now uploads photos as they're selected. If a user selects photos then abandons the page, those images are never attached to a listing and never cleaned up. Add an orphan sweep: tag direct uploads with a context/tag and a daily cron that deletes `mercadocr/listings` assets older than ~24h that aren't referenced by any listing. (The existing per‑listing cleanup only covers attached photos.)
- ✅ **DONE — Paid boost with no listing to apply to.** The webhook now logs an error + `captureException` (`boost_paid_not_applied`, with session id) so you can refund manually. (Auto‑refund via `stripe.refunds.create` is a possible follow‑up.)
- 🟡 **Admin tab lazy‑load guard is ineffective.** In `js/admin.js`, `switchToTab()` sets `btn.dataset.loaded = '1'` _before_ the click handler checks `!btn.dataset.loaded`, so `loadUsers`/`loadReports` never fire from that guard (they happen to work via other paths). Pre‑existing; harmless today but confusing. (I deliberately made the new Boosts tab always reload to sidestep it.)
- 🟢 **Click/favorite counters can drift under races.** `favorites` is clamped to ≥0, but `favoritedBy` + `favorites` can desync under rapid concurrent toggles. Fine at beta scale; if it matters later, derive the count from `favoritedBy.length` on read.

## 2. Security

Strong baseline already. Additions/risks introduced or worth closing:

- ✅ **DONE — Third‑party CDN for image compression.** `browser-image-compression` is now **self‑hosted** at `js/vendor/browser-image-compression.js` (vendored from v2.0.2); publish.html no longer depends on jsdelivr. No external CDN on the publish path.
- 🟡 **No Content‑Security‑Policy.** `helmet({ contentSecurityPolicy: false })`. Given a prior stored‑XSS incident and now multiple external origins (gstatic/Firebase, jsdelivr, Cloudinary, Stripe), a CSP is the highest‑value defense‑in‑depth. Scope `script-src` to self + the known CDNs, `img-src` to self + Cloudinary, etc.
- ✅ **DONE — `POST /api/listings/:id/click` rate‑limited.** Now behind `clickLimiter` (30/min/IP). (Per‑user dedup can be added later if you surface paid analytics.)
- 🟢 **CORS allows any origin in production.** Safe because everything is same‑origin through Vercel, but consider pinning `ALLOWED_ORIGINS` to your real domain(s) once the custom domain is live.
- 🟢 **Seller billing fields**: I made `GET /listings/:id` expose only public seller fields + a derived `sellerPro` (previously it already limited fields) — keep that pattern; never return Stripe IDs/subscription state to clients.

## 3. Performance

- 🟡 **Feed now always does a second batch query** (authors → contact/provincia + live `sellerPro`). Previously conditional. It's a single indexed `$in` on `firebaseUid` (unique‑indexed) per page — fine, but it's on the hot path. If feed latency matters, cache seller→plan for a few minutes, or trust the denormalized `listing.sellerPro` for the badge too (drop the live lookup) once plan‑sync is proven reliable.
- 🟢 **`skip`/`limit` pagination** degrades on deep pages at scale. Move to range/cursor pagination (`createdAt`/`_id` based) when catalogs grow.
- 🟢 **Boost expiry** is self‑healing at feed time (throttled 60s/instance) + daily cron backstop — good. The lazy sweep is one indexed `updateMany` matching ~0 rows.
- 🟢 Client image compression (≤1600px, ≤0.9MB) + parallel pre‑upload is a big publish‑speed win and cuts Cloudinary bandwidth.

## 4. UX

- ✅ Subcategory accordion (desktop indent / mobile chips), over‑limit banner, faster publish with per‑image status, boost chooser.
- 🟡 **Surface the data you're now collecting.** Build the Pro **seller analytics dashboard** (views/clicks/favorites/leads are all captured) — it's the main justification for Pro and currently invisible.
- 🟡 **Favorites/saved UI.** The `POST /:id/favorite` endpoint + schema exist; add the heart button + a "Guardados" page. High retention value.
- 🟢 Show **boost remaining time** on dashboard cards (data is there: `featuredUntil`).
- 🟢 Consider a confirm/preview step before paid boost checkout (amount shown) — currently goes straight to Stripe.

## 5. Mobile

- ✅ Category chip strips, 2‑column grid on ≤480px, stacking forms.
- 🔴 **Test publish on real iOS Safari.** HEIC photos: `browser-image-compression` may not decode HEIC and we fall back to the original file; Cloudinary's `f_auto` fixes _display_, but verify the upload + preview actually work end‑to‑end on an iPhone before relying on it for beta sellers.
- 🟢 Verify tap targets on the boost chooser and chip strips on small devices (looks fine in preview at 375px).

## 6. Scaling

- 🔴 **Unbounded arrays on the listing document.** `viewedBy` (every unique viewer UID) and now `favoritedBy` live _inside_ the listing doc. A popular listing can grow these arrays large — slowing every read of that doc and, at extremes, approaching the 16MB document cap. **Before any virality**, move view/favorite tracking to a separate collection (`{ listingId, uid, type }` with a unique compound index) or use atomic counters + a dedup set with a TTL. For 20–30 beta users this is fine; flag it now so it's not a fire later.
- 🟡 **Plan→listing `sellerPro` denormalization** is synced at 4 points (webhook, cron downgrade, cron refresh, admin). The live feed lookup keeps the _badge_ correct regardless, but sort‑priority depends on the denorm staying in sync. Add a periodic reconcile (or a `sellerPro` backfill migration) as a safety net.
- 🟢 Text search via Mongo text index is fine now; consider Atlas Search for typo‑tolerance/facets at scale.
- 🟢 `maxPoolSize: 1` per serverless instance is correct for Vercel; keep an eye on Atlas connection counts as concurrency grows.

## 7. Growth & retention recommendations

- **Beta Pro comps:** grant via Admin → Usuarios → set plan **Pro**. This sets `compedPlan: true` (never expires, cron skips it) and now also flips `sellerPro` on their listings → they get the badge + priority immediately. Exactly what you want for testers.
- **Notifications/email:** "you have a new lead", "your listing/boost expires soon", "renew in 1 click". Biggest lever for re‑engagement.
- **Seller analytics dashboard** (Pro) — turn the captured metrics into a reason to stay subscribed.
- **Saved listings + saved searches** — bring buyers back.
- **SEO:** the new `?category=&subcategory=` URLs are shareable; add server‑rendered category/subcategory meta tags (you already do dynamic OG for products) and consider pretty paths (`/anuncios/electronica/laptops`) for indexing.
- **Feedback loop for beta:** a visible "Reportar un problema / sugerencia" link for the 20–30 testers; triage weekly.

---

## Suggested pre‑launch checklist (highest leverage first)

1. ✅ Self‑host `browser-image-compression` (done). 🔴 **Still needed:** verify publish on a real iPhone (Safari/HEIC) — requires a physical device.
2. 🔴 Plan the `viewedBy`/`favoritedBy` move off the listing doc before promoting the app widely (fine for the 20–30 beta; do before going wide).
3. 🟡 Add a CSP; rate‑limit `/click`.
4. 🟡 Orphan‑image cleanup cron; boost‑refund‑on‑missing‑listing handling (alert at minimum).
5. 🟡 Ship the Pro analytics dashboard + favorites UI (data + endpoints are ready).
6. 🟢 Migration/reconcile job for `sellerPro`; consider cursor pagination.

> Env reminder: production requires `STRIPE_PRICE_BASIC` / `STRIPE_PRICE_PRO` for proration upgrades, `CRON_SECRET` for the cron jobs, and all Firebase/Cloudinary/Mongo secrets (the server refuses to boot without them in production — good).
