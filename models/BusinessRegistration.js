const mongoose = require('mongoose');

const businessRegistrationSchema = new mongoose.Schema(
  {
    merchantId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    businessName:       { type: String, required: true },
    businessType:       { type: String, required: true },
    ownerName:          { type: String, required: true },
    email:              { type: String, required: true },
    phone:              { type: String, required: true },
    address:            { type: String, required: true },
    city:               { type: String, default: '' },
    country:            { type: String, default: '' },
    postalCode:         { type: String, default: '' },
    taxId:              { type: String, default: '' },
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
