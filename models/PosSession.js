const mongoose = require('mongoose');

/**
 * One till session: an admin opens it against a merchant's catalogue, rings
 * up sales, and closes it with a cash count.
 *
 * The cart lives here rather than in the client so a refresh, a second tab or
 * a dropped connection cannot lose a half-rung sale — and so prices are only
 * ever the ones the server put there.
 */
const posCartItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    // Copied from the Product at the moment it was added: the catalogue can
    // be renamed or repriced mid-sale, and the line the cashier read to the
    // customer must not silently change underneath them.
    name:     { type: String, required: true },
    code:     { type: String, default: '' },
    unitPrice:{ type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    vat:      { type: Number, default: 0 },
  },
  { _id: true }
);

const posSessionSchema = new mongoose.Schema(
  {
    // The admin operating the till. Admins are Users with role 'admin' —
    // there is no separate Admin collection in this backend.
    cashierId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    status:  { type: String, enum: ['open', 'closed'], default: 'open' },
    openedAt: { type: Date, default: Date.now },
    closedAt: { type: Date, default: null },

    openingFloat: { type: Number, default: 0 },
    // What the cashier physically counted at close, and the difference from
    // what the till should hold. A blind figure is the point: it is only
    // meaningful if it is entered rather than computed.
    closingCount: { type: Number, default: null },
    cashDifference: { type: Number, default: null },

    // Running totals, updated as invoices are settled.
    totalSales:   { type: Number, default: 0 },
    totalRefunds: { type: Number, default: 0 },
    invoiceCount: { type: Number, default: 0 },
    refundCount:  { type: Number, default: 0 },

    // The in-progress sale. Cleared the moment an invoice is created.
    cart: { type: [posCartItemSchema], default: [] },
    cartDiscount:     { type: Number, default: 0 },
    cartDiscountType: { type: String, enum: ['percentage', 'fixed'], default: 'fixed' },
    customerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    customerName: { type: String, default: '' },
    customerPhone:{ type: String, default: '' },

    note: { type: String, default: '' },
  },
  { timestamps: true }
);

// One open session per cashier: the partial unique index is what actually
// stops a second till being opened, rather than a check that two concurrent
// requests could both pass.
posSessionSchema.index(
  { cashierId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } }
);
posSessionSchema.index({ merchantId: 1, openedAt: -1 });

module.exports = mongoose.model('PosSession', posSessionSchema);
