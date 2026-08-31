const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    merchantId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name:          { type: String, required: true },
    code:          { type: String, default: '' },
    description:   { type: String, default: '' },
    price:         { type: Number, required: true },
    discountPrice: { type: Number, default: null },
    // What the merchant paid for it. 0 means "not recorded" rather than
    // "free": the profit report counts only revenue whose cost is known and
    // reports the coverage, because treating an unset cost as zero would
    // show every legacy sale at a 100% margin.
    costPrice:     { type: Number, default: 0, min: 0 },
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
    // Low-stock alert threshold. The merchant create/edit form has always
    // asked for an "Alert Quantity", but there was nowhere to store it and
    // the value was silently discarded on every save.
    alertQty:      { type: Number, default: 0 },

    // Matches exactly what POST /products/:id/comment pushes — was
    // previously undeclared, so pushes may not have persisted under
    // Mongoose's default strict mode.
    comments: [
      {
        userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        text:      { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true,
  }
);

productSchema.index({ merchantId: 1 });
productSchema.index({ merchantId: 1, isActive: 1 });
productSchema.index({ category: 1 });

module.exports = mongoose.model('Product', productSchema);
