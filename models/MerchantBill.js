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

    /**
     * Short code the customer's app resolves to this bill (§4.3, paying with
     * points). The QR used to encode the bill number and the amount as plain
     * text, which is a label rather than a reference — nothing on the
     * customer's side could look it up, so nothing could be paid with it.
     *
     * Deliberately not the Mongo id: a bill code is shown on a screen, read
     * by a stranger's camera, and sometimes typed, and an id that leaks the
     * shape of the database is not what belongs on a restaurant table.
     */
    payCode:        { type: String, default: null, unique: true, sparse: true, index: true },
    /** Bills are settled at the till, so a code is not open indefinitely. */
    payCodeExpiresAt: { type: Date, default: null },
    /** Points actually spent, when the customer paid this way. */
    pointsSpent:    { type: Number, default: 0 },
    paidAt:         { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MerchantBill', merchantBillSchema);
