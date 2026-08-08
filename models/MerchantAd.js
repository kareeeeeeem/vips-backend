const mongoose = require('mongoose');

const merchantAdSchema = new mongoose.Schema(
  {
    merchantId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title:          { type: String, required: true },
    description:    { type: String, default: '' },
    imageUrl:       { type: String, default: '' },
    targetAudience: { type: String, default: 'all' },
    budget:         { type: Number, default: 0 },
    spentAmount:    { type: Number, default: 0 },
    startDate:      { type: Date, required: true },
    endDate:        { type: Date, required: true },
    status: {
      type: String,
      enum: ['draft', 'active', 'paused', 'ended', 'scheduled'],
      default: 'draft',
    },
    impressions: { type: Number, default: 0 },
    clicks:      { type: Number, default: 0 },
    conversions: { type: Number, default: 0 },
    adType: {
      type: String,
      enum: ['banner', 'sponsored', 'featured', 'popup'],
      default: 'banner',
    },
    targetUrl:   { type: String, default: '' },
    isBoost:     { type: Boolean, default: false },
    boostBudget: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MerchantAd', merchantAdSchema);
