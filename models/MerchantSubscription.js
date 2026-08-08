const mongoose = require('mongoose');

const merchantSubscriptionSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    planName: {
      type: String,
      enum: ['Free', 'Basic', 'Professional', 'Enterprise'],
      default: 'Free',
    },
    planCode: {
      type: String,
      enum: ['free', 'basic', 'pro', 'enterprise'],
      default: 'free',
    },
    price:        { type: Number, default: 0 },
    billingCycle: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' },
    startDate:    { type: Date, default: Date.now },
    endDate:      { type: Date, default: null },
    isActive:     { type: Boolean, default: true },
    autoRenew:    { type: Boolean, default: false },
    features: {
      maxProducts:     { type: Number, default: 10 },
      maxCashiers:     { type: Number, default: 1 },
      analytics:       { type: Boolean, default: false },
      adsEnabled:      { type: Boolean, default: false },
      prioritySupport: { type: Boolean, default: false },
      apiAccess:       { type: Boolean, default: false },
    },
    paymentHistory: [
      {
        amount:    { type: Number },
        paidAt:    { type: Date, default: Date.now },
        reference: { type: String },
        method:    { type: String, default: 'wallet' },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model('MerchantSubscription', merchantSubscriptionSchema);
