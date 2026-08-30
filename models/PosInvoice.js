const mongoose = require('mongoose');

const posInvoiceItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name:      { type: String, default: '' },
    code:      { type: String, default: '' },
    quantity:  { type: Number, default: 1 },
    unitPrice: { type: Number, default: 0 },
    vat:       { type: Number, default: 0 },
    lineTotal: { type: Number, default: 0 },
  },
  { _id: false }
);

/**
 * A completed till sale.
 *
 * Kept separate from `Order` on purpose: Order.orderType is a fixed enum the
 * consumer and merchant apps both switch on, and widening it for counter
 * sales would change behaviour in two shipping apps. The reports and finance
 * dashboards read this collection explicitly instead, so POS revenue is
 * counted rather than quietly living in a silo.
 */
const posInvoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, unique: true },

    sessionId:  { type: mongoose.Schema.Types.ObjectId, ref: 'PosSession', required: true },
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    cashierId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // A walk-in has no account, so the name/phone stand alone rather than
    // forcing a User row to be invented for every counter sale.
    customerId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    customerName:  { type: String, default: '' },
    customerPhone: { type: String, default: '' },

    items: { type: [posInvoiceItemSchema], default: [] },

    subtotal:     { type: Number, default: 0 },
    discount:     { type: Number, default: 0 },
    discountType: { type: String, enum: ['percentage', 'fixed'], default: 'fixed' },
    tax:          { type: Number, default: 0 },
    total:        { type: Number, default: 0 },

    paymentMethod: { type: String, enum: ['cash', 'card', 'wallet'], default: 'cash' },
    amountPaid:    { type: Number, default: 0 },
    changeDue:     { type: Number, default: 0 },
    paymentStatus: { type: String, enum: ['paid', 'unpaid', 'refunded'], default: 'unpaid' },

    status: { type: String, enum: ['completed', 'refunded', 'cancelled'], default: 'completed' },

    refundedAt:     { type: Date, default: null },
    refundReason:   { type: String, default: '' },
    refundedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    note: { type: String, default: '' },
  },
  { timestamps: true }
);

posInvoiceSchema.index({ merchantId: 1, createdAt: -1 });
posInvoiceSchema.index({ sessionId: 1 });
posInvoiceSchema.index({ status: 1, createdAt: -1 });

/**
 * POS-YYMMDD-0001, sequential within the day.
 *
 * Derived from the highest number already issued today rather than a document
 * count: a count breaks the moment an invoice is deleted, and would hand two
 * sales the same number. The unique index is still the backstop, and the
 * route retries on a duplicate-key collision.
 */
posInvoiceSchema.pre('validate', async function (next) {
  if (this.invoiceNumber) return next();
  try {
    const now = new Date();
    const stamp =
      String(now.getFullYear()).slice(-2) +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0');
    const prefix = `POS-${stamp}-`;

    const last = await mongoose
      .model('PosInvoice')
      .findOne({ invoiceNumber: new RegExp(`^${prefix}`) })
      .sort({ invoiceNumber: -1 })
      .select('invoiceNumber')
      .lean();

    const lastSequence = last
      ? parseInt(String(last.invoiceNumber).slice(prefix.length), 10) || 0
      : 0;
    this.invoiceNumber = prefix + String(lastSequence + 1).padStart(4, '0');
    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model('PosInvoice', posInvoiceSchema);
