const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    merchantId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name:          { type: String, required: true },
    code:          { type: String, default: '' },
    description:   { type: String, default: '' },
    price:         { type: Number, required: true },
    discountPrice: { type: Number, default: null },
    image:         { type: String, default: null },
    category:      { type: String, required: true },
    inStock:       { type: Boolean, default: true },
    isActive:      { type: Boolean, default: true },
    isFeature:     { type: Boolean, default: false },
    hasVariants:   { type: Boolean, default: false },
    stock:         { type: Number, default: 0 },
    vat:           { type: Number, default: 0 },
    taxMethod:     { type: String, enum: ['Exclusive', 'Inclusive', 'None'], default: 'Exclusive' },
    productType:   { type: String, default: 'Product' },
  },
  {
    timestamps: true,
  }
);

productSchema.index({ merchantId: 1 });
productSchema.index({ merchantId: 1, isActive: 1 });
productSchema.index({ category: 1 });

module.exports = mongoose.model('Product', productSchema);
