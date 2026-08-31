const mongoose = require('mongoose');

/**
 * One message between a customer and a merchant.
 *
 * Stored rather than kept in memory. A chat that only delivers to whoever
 * happens to be connected loses every message sent while the other side is
 * closed — which for a merchant is most of the day, and is the first thing a
 * customer would hit. Persisting it also means opening a conversation shows
 * what was already said instead of an empty screen.
 */
const chatMessageSchema = new mongoose.Schema(
  {
    /// Both participant ids, sorted and joined. Deterministic from either
    /// direction, so one conversation has one key however it is looked up.
    conversationId: { type: String, required: true, index: true },

    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    to:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    body: { type: String, required: true, trim: true, maxlength: 2000 },

    /// When the recipient actually opened it. Null means unread — not zero,
    /// because "never read" and "read at the epoch" are different facts.
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

chatMessageSchema.index({ conversationId: 1, createdAt: -1 });
chatMessageSchema.index({ to: 1, readAt: 1 });

/** The conversation key for a pair, in either order. */
chatMessageSchema.statics.conversationKey = (a, b) =>
  [String(a), String(b)].sort().join(':');

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
