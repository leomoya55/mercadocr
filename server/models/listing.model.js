const mongoose = require('mongoose');

// Active listings stay live for 30 days, then expire and must be renewed.
const LISTING_ACTIVE_MS = 30 * 24 * 60 * 60 * 1000;

const listingSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  description: { type: String, required: true },
  price:       { type: Number, required: true },
  category:    { type: String, required: true },
  // Optional second-level category (e.g. 'Celulares' under 'Electrónica').
  // Validated against the shared taxonomy (js/categories.js) in the route. '' when
  // the category has no subcategories or the user didn't pick one.
  subcategory: { type: String, default: '' },
  // Apparel size — only used for the 'Ropa y accesorios' category; '' otherwise.
  size:        { type: String, default: '' },
  // Real-estate details — only used for the 'Bienes Raíces' category.
  realEstate: {
    operation:    { type: String, enum: ['alquiler', 'venta', ''], default: '' },
    propertyType: { type: String, default: '' }, // casa, apartamento, lote, local, oficina, bodega, finca
    area:         { type: Number, default: null }, // metros cuadrados (m²)
    bedrooms:     { type: Number, default: null },
    bathrooms:    { type: Number, default: null },
  },
  // Job details — only used for the 'Empleos' category.
  job: {
    employmentType: { type: String, default: '' }, // tiempo_completo, medio_tiempo, por_horas, temporal, freelance
    modality:       { type: String, default: '' }, // presencial, remoto, hibrido
    company:        { type: String, default: '' },
    salary:         { type: String, default: '' }, // free text, e.g. "₡500.000/mes" or "A convenir"
    applyEmail:     { type: String, default: '' }, // how applicants apply (required for Empleos)
    applyUrl:       { type: String, default: '' }, // optional external application link
  },
  condition:   {
    type: String,
    enum: ['new', 'like_new', 'good', 'fair', 'regular', ''],
    default: '',
  },
  photos:      [{ type: String, required: true }],
  contact:     { type: String, default: '' },
  provincia:   { type: String, default: '' },
  author:      { type: String, required: true }, // Firebase UID

  // ─── Promotion / featured ───────────────────────────────────────────────────
  // `featured` is the live flag used by the feed sort and badge. It can be set:
  //   • manually by an admin (editorial), OR
  //   • by a paid boost, which ALSO stamps featuredUntil/boostType/boostPurchaseDate.
  // A paid boost is "active" while featuredUntil > now; the expiry cron clears
  // `featured` + `featuredUntil` once it lapses. An admin/editorial feature has
  // featured:true with featuredUntil:null (never auto-expires).
  featured:        { type: Boolean, default: false },
  hidden:          { type: Boolean, default: false }, // Admin moderation flag
  featuredUntil:     { type: Date,   default: null },  // null = not a timed boost
  boostType:         { type: String, enum: ['', '24h', '7d', '30d'], default: '' },
  boostPurchaseDate: { type: Date,   default: null },

  // Denormalized "is the seller a Pro member?" — powers Pro priority placement in
  // the feed/search sort (a perk of Pro). Kept in sync when the author's plan
  // changes (payment webhook, cron, admin) and set at creation. Best-effort for
  // sorting; the displayed Featured-Seller badge is re-derived live in the feed
  // response so it's always accurate even if a sync was missed.
  sellerPro:         { type: Boolean, default: false },

  // ─── Analytics (architecture now; dashboards later) ─────────────────────────
  // These are additive counters so we can build seller analytics for Pro without
  // a later migration. `views` already existed; clicks/favorites/leads are new.
  //   views     — unique authenticated viewers of the product page
  //   clicks    — contact-intent clicks (WhatsApp / email / apply-link)
  //   favorites — number of users who saved this listing
  //   leads     — qualified contact events (currently == clicks; reserved so the
  //               definition can tighten later without another migration)
  views:       { type: Number, default: 0 },
  clicks:      { type: Number, default: 0 },
  favorites:   { type: Number, default: 0 },
  leads:       { type: Number, default: 0 },
  viewedBy:    [{ type: String }],               // Firebase UIDs — one entry per unique viewer
  favoritedBy: [{ type: String }],               // Firebase UIDs — one entry per user who saved it
  status:      { type: String, enum: ['active', 'sold'], default: 'active' },
  // When the listing was marked sold. Sold listings stay visible in the seller's
  // panel for a week, then the cleanup-sold cron deletes the doc + Cloudinary
  // images. Null for active listings.
  soldAt:      { type: Date, default: null },
  // When the listing expires. Past this date the listing drops out of the public
  // feed and the seller must renew it (resets to now + 30 days). Defaults to
  // 30 days after creation.
  expiresAt:   { type: Date, default: () => new Date(Date.now() + LISTING_ACTIVE_MS) },
}, {
  timestamps: true,
});

/**
 * Powers the cleanup-sold cron: find sold listings whose week has elapsed.
 */
listingSchema.index({ status: 1, soldAt: 1 });

/**
 * Powers the public-feed expiry filter and per-user active counting.
 */
listingSchema.index({ status: 1, expiresAt: 1 });

/**
 * Compound index on (author, status).
 * Powers getActiveCount() and GET /listings/user/:uid.
 */
listingSchema.index({ author: 1, status: 1 });

/**
 * Full-text search index — name weighted 3×, description 1×.
 * Powers GET /listings?q=keyword.
 */
listingSchema.index(
  { name: 'text', description: 'text' },
  { weights: { name: 3, description: 1 }, name: 'text_search' }
);

/**
 * Public feed indexes — all queries filter status first.
 * featured+createdAt: main feed sort.
 * category+createdAt: category filter.
 * provincia+createdAt: province filter.
 * price: range queries.
 */
listingSchema.index({ status: 1, featured: -1, createdAt: -1 });
// Main feed sort: boosted first, then Pro sellers, then newest.
listingSchema.index({ status: 1, featured: -1, sellerPro: -1, createdAt: -1 });
listingSchema.index({ status: 1, category: 1, createdAt: -1 });
// Category + subcategory drill-down (subcategory filter on a chosen category).
listingSchema.index({ status: 1, category: 1, subcategory: 1, createdAt: -1 });
listingSchema.index({ status: 1, provincia: 1, createdAt: -1 });
listingSchema.index({ status: 1, price: 1 });

/**
 * Powers the boost-expiry cron: find listings whose timed boost has lapsed.
 * Partial-ish: only timed boosts set featuredUntil, so the scan stays small.
 */
listingSchema.index({ featuredUntil: 1 });

module.exports = mongoose.model('Listing', listingSchema);
module.exports.LISTING_ACTIVE_MS = LISTING_ACTIVE_MS;
