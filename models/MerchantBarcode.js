const mongoose = require('mongoose');

const merchantBarcodeSchema = new mongoose.Schema(
  {
    merchantId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    productId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    productName: { type: String, required: true },
    code:        { type: String, required: true },
    qrData:      { type: String, default: '' },
    codeType:    { type: String, enum: ['barcode', 'qrcode'], default: 'qrcode' },
    price:       { type: Number, default: 0 },
    description: { type: String, default: '' },
    isActive:    { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MerchantBarcode', merchantBarcodeSchema);
