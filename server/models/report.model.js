const mongoose = require('mongoose');

const REASONS = ['spam', 'scam', 'inappropriate', 'wrong_category', 'duplicate', 'other'];

const reportSchema = new mongoose.Schema({
  listingId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Listing',
    required: true,
  },
  reporterUid: { type: String, required: true },
  reason: {
    type:     String,
    enum:     REASONS,
    required: true,
  },
  details: { type: String, default: '' },      // optional freetext, max 500 chars
  status:  {
    type:    String,
    enum:    ['pending', 'reviewed', 'dismissed', 'actioned'],
    default: 'pending',
  },
}, {
  timestamps: true,
});

// One report per user per listing — prevents spam
reportSchema.index({ listingId: 1, reporterUid: 1 }, { unique: true });

// Admin review queue — pending first, newest first within status
reportSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Report', reportSchema);
module.exports.REASONS = REASONS;
