const mongoose = require('mongoose');

const promotionSchema = new mongoose.Schema(
  {
    title:         { type: String, required: true },
    subtitle:      { type: String, default: '' },
    type:          { type: String, enum: ['shipping', 'discount', 'points', 'cashback', 'other'], default: 'discount' },
    code:          { type: String, required: true, unique: true, uppercase: true },
    discount:      { type: Number, default: 0 },
    minOrderValue: { type: Number, default: 0 },
    imageUrl:      { type: String, default: null },
    expiresAt:     { type: Date, required: true },
    isActive:      { type: Boolean, default: true },
    merchantId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    usageCount:    { type: Number, default: 0 },
    maxUsage:      { type: Number, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Promotion', promotionSchema);
