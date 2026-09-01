const mongoose = require('mongoose');

/**
 * One Giftback grant: change a customer chose to forgo, held as points that
 * cannot be spent yet (§4.2).
 *
 * This exists as its own record rather than as a straight credit to the
 * wallet because §7 rests on three properties that only a record can carry:
 * the customer consented, the amount counts against *their* monthly cap, and
 * the points are deferred. A balance alone proves none of them.
 */
const giftbackGrantSchema = new mongoose.Schema(
  {
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    /** The change forgone, in dinars. Must be under GIFTBACK.MAX_CHANGE_TND. */
    changeTnd: { type: Number, required: true, min: 0 },
    /** Its value in points at 100 = 1 TND. */
    points:    { type: Number, required: true, min: 0 },
    /** Invoice this change came off, for the merchant's approval log (§6.2). */
    invoiceTnd: { type: Number, default: null },

    /**
     * The customer said yes. Never defaulted to true: an opt-in that
     * defaults to on is not an opt-in, and the legal argument turns on it.
     */
    consentedAt: { type: Date, required: true },

    /** Spendable from here — 12 hours after the grant. */
    activatesAt: { type: Date, required: true, index: true },
    activatedAt: { type: Date, default: null },

    status: {
      type: String,
      enum: ['pending', 'active', 'void'],
      default: 'pending',
      index: true,
    },
    voidReason: { type: String, default: '' },
  },
  { timestamps: true }
);

// Drives both the monthly cap check and the customer's Giftback screen.
giftbackGrantSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('GiftbackGrant', giftbackGrantSchema);
