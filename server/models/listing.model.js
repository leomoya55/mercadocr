const mongoose = require('mongoose');

const listingSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  description: { type: String, required: true },
  price:       { type: Number, required: true },
  category:    { type: String, required: true },
  photos:      [{ type: String, required: true }],
  contact:     { type: String, default: '' },
  provincia:   { type: String, default: '' },
  author:      { type: String, required: true }, // Firebase UID
  featured:    { type: Boolean, default: false },
  status:      { type: String, enum: ['active', 'sold'], default: 'active' },
}, {
  timestamps: true,
});

/**
 * Compound index on (author, status).
 * Powers getActiveCount() — countDocuments({ author: uid, status: { $ne: 'sold' } })
 * without a full collection scan.
 *
 * Also speeds up GET /listings/user/:uid (find by author).
 */
listingSchema.index({ author: 1, status: 1 });

/**
 * Index on status for the public listings feed (all active listings).
 * Powers GET /listings sorted by featured + createdAt.
 */
listingSchema.index({ status: 1, featured: -1, createdAt: -1 });

module.exports = mongoose.model('Listing', listingSchema);
