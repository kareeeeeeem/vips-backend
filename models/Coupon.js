const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema(
  {
    code:               { type: String, required: true, unique: true, uppercase: true },
    // Frontend expects 'discount' — stored here; discountPercentage kept as alias
    discount:           { type: Number, required: true },
    discountPercentage: { type: Number },            // populated via pre-save for legacy compat
    maxDiscountAmount:  { type: Number, default: null },
    type:               { type: String, enum: ['percentage', 'fixed', 'voucher', 'shipping'], default: 'percentage' },
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
    // Set only on personal vouchers redeemed via POST /rewards/redeem-points
    // (routes/rewards.js) — null for merchant-created/general coupons,
    // which anyone can apply. When set, only this user may apply the code.
    userId:             { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    pointsCost:         { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Keep discountPercentage in sync so old code reading it still works
couponSchema.pre('save', function (next) {
  this.discountPercentage = this.discount;
  next();
});

module.exports = mongoose.model('Coupon', couponSchema);
