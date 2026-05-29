const mongoose = require('mongoose');

/**
 * auditLog.model.js — immutable trail of privileged (admin) actions.
 *
 * WHY: every destructive admin action (delete listing, change a user's plan,
 * grant credits, hide content, resolve reports) currently happened with no
 * record of who did what, when, or to whom. For a system that handles money and
 * can ban/alter users, that's both an operational blind spot and a compliance
 * gap. This collection is append-only — nothing in the app ever updates or
 * deletes a row (a TTL handles long-term retention instead).
 */
const auditLogSchema = new mongoose.Schema(
  {
    actorUid:   { type: String, required: true }, // Firebase UID of the admin
    actorEmail: { type: String, required: true },
    action:     { type: String, required: true }, // e.g. 'listing.delete', 'user.plan.set'
    targetType: { type: String, default: null },  // 'listing' | 'user' | 'report'
    targetId:   { type: String, default: null },
    meta:       { type: mongoose.Schema.Types.Mixed, default: {} }, // before/after, params, etc.
    ip:         { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorUid: 1, createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
// Retain 1 year, then auto-expire.
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
