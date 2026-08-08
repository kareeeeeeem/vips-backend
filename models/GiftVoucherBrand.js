const mongoose = require('mongoose');

const giftVoucherBrandSchema = new mongoose.Schema(
  {
    name:      { type: String, required: true },
    logoUrl:   { type: String, default: '' },
    minAmount: { type: Number, default: 100 },
    maxAmount: { type: Number, default: 10000 },
    currency:  { type: String, default: 'TND' },
    isActive:  { type: Boolean, default: true },
    category:  { type: String, default: 'general' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('GiftVoucherBrand', giftVoucherBrandSchema);
