const mongoose = require('mongoose');

const listingSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  description: { type: String, required: true },
  price:       { type: Number, required: true },
  category:    { type: String, required: true },
  // Apparel size — only used for the 'Ropa y accesorios' category; '' otherwise.
  size:        { type: String, default: '' },
  condition:   {
    type: String,
    enum: ['new', 'like_new', 'good', 'fair', 'regular', ''],
    default: '',
  },
  photos:      [{ type: String, required: true }],
  contact:     { type: String, default: '' },
  provincia:   { type: String, default: '' },
  author:      { type: String, required: true }, // Firebase UID
  featured:    { type: Boolean, default: false },
  hidden:      { type: Boolean, default: false }, // Admin moderation flag
  views:       { type: Number, default: 0 },
  viewedBy:    [{ type: String }],               // Firebase UIDs — one entry per unique viewer
  status:      { type: String, enum: ['active', 'sold'], default: 'active' },
  // When the listing was marked sold. Sold listings stay visible in the seller's
  // panel for a week, then the cleanup-sold cron deletes the doc + Cloudinary
  // images. Null for active listings.
  soldAt:      { type: Date, default: null },
}, {
  timestamps: true,
});

/**
 * Powers the cleanup-sold cron: find sold listings whose week has elapsed.
 */
listingSchema.index({ status: 1, soldAt: 1 });

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
listingSchema.index({ status: 1, category: 1, createdAt: -1 });
listingSchema.index({ status: 1, provincia: 1, createdAt: -1 });
listingSchema.index({ status: 1, price: 1 });

module.exports = mongoose.model('Listing', listingSchema);
