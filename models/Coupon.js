const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema(
  {
    code:               { type: String, required: true, unique: true, uppercase: true },
    // Frontend expects 'discount' — stored here; discountPercentage kept as alias
    discount:           { type: Number, required: true },
    discountPercentage: { type: Number },            // populated via pre-save for legacy compat
    maxDiscountAmount:  { type: Number, default: null },
    type:               { type: String, enum: ['percentage', 'fixed', 'voucher'], default: 'percentage' },
    expiryDate:         { type: Date, required: true },
    isActive:           { type: Boolean, default: true },
    merchantId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    usageCount:         { type: Number, default: 0 },
    maxUsage:           { type: Number, default: null },
    // Aliases kept for seeder / legacy compatibility
    usedCount:          { type: Number, default: 0 },
    maxUses:            { type: Number, default: null },
    minOrderAmount:     { type: Number, default: 0 },
    description:        { type: String, default: '' },
    tags:               [{ type: String }],
  },
  { timestamps: true }
);

// Keep discountPercentage in sync so old code reading it still works
couponSchema.pre('save', function (next) {
  this.discountPercentage = this.discount;
  next();
});

module.exports = mongoose.model('Coupon', couponSchema);
