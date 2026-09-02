const mongoose = require('mongoose');

/**
 * A targeted offer sent to one customer segment (§6.2, "الحملات الموجهة").
 *
 * The segment is a description, not a fixed list: a customer who has not
 * visited for thirty days today may have visited by the time the offer is
 * sent, and a stored list would keep offering them a "we miss you" discount
 * they no longer fit. The audience is resolved when the action runs.
 */
const rewardActionSchema = new mongoose.Schema(
  {
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /**
     * Which customers this is for.
     *  birthday  — birthday this month
     *  one_time  — bought once and never came back
     *  be_back   — used to come regularly and has gone quiet
     *  top_spend — the highest spenders
     */
    segment: {
      type: String,
      enum: ['birthday', 'one_time', 'be_back', 'top_spend'],
      required: true,
    },

    /** The message customers receive. Held so it can be edited before sending. */
    message: { type: String, required: true, maxlength: 500 },

    // ─── The offer ──────────────────────────────────────────
    discountType: { type: String, enum: ['percent', 'tnd'], default: 'percent' },
    discountValue: { type: Number, required: true, min: 0 },
    /** Caps a percentage discount in dinars. Null means uncapped. */
    maxDiscountTnd: { type: Number, default: null },
    /** Days the offer stays open once sent. */
    availabilityDays: { type: Number, default: 7, min: 1, max: 90 },

    status: {
      type: String,
      enum: ['draft', 'sent'],
      default: 'draft',
      index: true,
    },
    sentAt: { type: Date, default: null },
    /** How many customers it actually reached when it was sent. */
    reached: { type: Number, default: 0 },
    /** Coupon issued for this action, so redemptions can be traced back. */
    couponCode: { type: String, default: '' },
  },
  { timestamps: true }
);

rewardActionSchema.index({ merchantId: 1, createdAt: -1 });

module.exports = mongoose.model('RewardAction', rewardActionSchema);
