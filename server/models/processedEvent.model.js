const mongoose = require('mongoose');

/**
 * processedEvent.model.js — webhook idempotency / replay-protection ledger.
 *
 * THE RISK THIS PREVENTS
 *   Stripe guarantees AT-LEAST-ONCE webhook delivery. The same event id WILL be
 *   delivered more than once in production — on our 5xx/timeout, on Stripe's
 *   internal retries, and occasionally even on success. Without a dedup ledger,
 *   a redelivered `checkout.session.completed` runs our `$inc singlePostCredits`
 *   twice → the user is handed free credits they never paid for. A redelivered
 *   subscription event is mostly harmless (idempotent $set) but still wasteful.
 *
 * HOW IT WORKS
 *   We use the Stripe event id as the document _id and rely on the primary-key
 *   unique constraint. The webhook handler does insertOne({_id: event.id}) FIRST,
 *   inside a try/catch. A duplicate key (E11000) means "already handled" → we
 *   return 200 immediately and do no further work. This converts Stripe's
 *   at-least-once delivery into our at-most-once processing.
 *
 * RETENTION
 *   Stripe stops retrying after ~3 days. A 30-day TTL keeps the collection tiny
 *   while comfortably covering the entire retry window plus manual replays from
 *   the Stripe dashboard.
 */
const processedEventSchema = new mongoose.Schema(
  {
    _id:  { type: String, required: true }, // Stripe event.id, e.g. "evt_1abc..."
    type: { type: String },                 // event.type, for debugging/audit
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false, versionKey: false }
);

// TTL: auto-delete 30 days after createdAt.
processedEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('ProcessedEvent', processedEventSchema);
