const mongoose = require('mongoose');

const billItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  name:     { type: String, required: true },
  price:    { type: Number, required: true },
  quantity: { type: Number, required: true, default: 1 },
  discount: { type: Number, default: 0 },
  total:    { type: Number, required: true },
});

const merchantBillSchema = new mongoose.Schema(
  {
    merchantId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    customerId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    customerName:   { type: String, default: 'Walk-in Customer' },
    customerPhone:  { type: String, default: '' },
    billNumber:     { type: String, required: true, unique: true },
    items:          [billItemSchema],
    subtotal:       { type: Number, required: true },
    taxAmount:      { type: Number, default: 0 },
    taxRate:        { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    serviceCharge:  { type: Number, default: 0 },
    grandTotal:     { type: Number, required: true },
    paymentMethod:  { type: String, enum: ['cash', 'card', 'wallet', 'points', 'credit'], default: 'cash' },
    paymentStatus:  { type: String, enum: ['paid', 'pending', 'partial', 'voided'], default: 'paid' },
    paidAmount:     { type: Number, default: 0 },
    changeAmount:   { type: Number, default: 0 },
    notes:          { type: String, default: '' },
    cashierId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    status:         { type: String, enum: ['active', 'voided', 'refunded'], default: 'active' },
    voidReason:     { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MerchantBill', merchantBillSchema);
