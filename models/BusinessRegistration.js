const mongoose = require('mongoose');

const businessRegistrationSchema = new mongoose.Schema(
  {
    merchantId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    businessName:       { type: String, required: true },
    businessNameAr:     { type: String, default: '' },
    businessType:       { type: String, required: true },
    ownerName:          { type: String, required: true },
    ownerNameAr:        { type: String, default: '' },
    jobTitle:           { type: String, default: '' },
    email:              { type: String, required: true },
    phone:              { type: String, required: true },
    address:            { type: String, required: true },
    apartment:          { type: String, default: '' },
    locationName:       { type: String, default: '' },
    city:               { type: String, default: '' },
    country:            { type: String, default: '' },
    postalCode:         { type: String, default: '' },
    taxId:              { type: String, default: '' },
    // Per-weekday opening hours as submitted by the 3-step registration
    // flow's "Time Info" step — shape: { Sunday: {enabled,open,close}, ... }.
    schedule:           { type: mongoose.Schema.Types.Mixed, default: {} },
    loyaltyType:        { type: String, enum: ['private', 'everywhere'], default: 'everywhere' },
    // Reward-program preferences from the partnership "Reward Setup" step
    // (merchant_partnership_controller.dart) — recorded for reference;
    // the actual points-earn rate and Gift Back limits are still the
    // global constants in utils/points.js / routes/merchant.js, not
    // overridden per-merchant yet.
    minRewardPercent:   { type: Number, default: 0.5 },
    minPurchaseAmount:  { type: Number, default: 1 },
    redeemPointsValue:  { type: Number, default: 100 },
    redeemDinarValue:   { type: Number, default: 1 },
    registrationNumber: { type: String, default: '' },
    logoUrl:            { type: String, default: '' },
    bannerUrl:          { type: String, default: '' },
    description:        { type: String, default: '' },
    website:            { type: String, default: '' },
    socialMedia: {
      facebook:  { type: String, default: '' },
      instagram: { type: String, default: '' },
      twitter:   { type: String, default: '' },
    },
    documents: [
      {
        type:       { type: String },
        url:        { type: String },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    status: {
      type: String,
      enum: ['pending', 'under_review', 'approved', 'rejected'],
      default: 'pending',
    },
    rejectionReason: { type: String, default: '' },
    reviewedAt:      { type: Date, default: null },
    approvedAt:      { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BusinessRegistration', businessRegistrationSchema);
