const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tier: { type: String, enum: ['silver', 'gold', 'platinum'], required: true },
    startDate: { type: Date, default: Date.now },
    endDate: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
    durationWeeks: { type: Number, min: 1, max: 10 },
    amountPaid: { type: Number, min: 0 },
    paymentMethod: {
      type: String,
      enum: ['wallet', 'bank_transfer', 'partner_cash'],
      default: 'wallet',
    },
    paymentStatus: {
      type: String,
      enum: ['paid', 'pending_payment', 'rejected'],
      default: 'paid',
    },
    bankReference: { type: String, default: '' },
    partnerStore: { type: String, default: '' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    reviewReason: { type: String, default: '' },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Subscription', subscriptionSchema);
