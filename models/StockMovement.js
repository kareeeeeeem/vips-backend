const mongoose = require('mongoose');

/**
 * An append-only ledger of every change to a Stock line.
 *
 * Written by `utils/stockLedger.js` from both the merchant CRUD routes and the
 * admin console, so the movement history is complete rather than only showing
 * what an admin happened to do. Nothing updates or deletes a row here: a
 * correction is a new movement, which is what makes the running balance
 * auditable.
 */
const stockMovementSchema = new mongoose.Schema(
  {
    stockId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Stock', required: true },
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // Denormalised on purpose: a Stock line can be deleted, and a ledger whose
    // rows go blank the moment the item disappears is worthless for an audit.
    itemName: { type: String, default: '' },
    category: { type: String, default: '' },
    location: { type: String, default: 'Main' },

    type: {
      type: String,
      enum: [
        'initial',        // the line was created with an opening balance
        'in',             // stock added
        'out',            // stock consumed/sold
        'adjustment',     // corrected to an absolute figure
        'transfer_in',    // arrived from another line
        'transfer_out',   // sent to another line
        'removed',        // the line itself was deleted
      ],
      required: true,
    },

    // Always the magnitude of the change; `type` carries the direction, so a
    // caller can never accidentally record a negative "in".
    quantity:      { type: Number, required: true, min: 0 },
    balanceBefore: { type: Number, required: true },
    balanceAfter:  { type: Number, required: true },
    unitPrice:     { type: Number, default: 0 },

    reason:    { type: String, default: '' },
    // Groups the two halves of a transfer so they can be shown as one event.
    reference: { type: String, default: '' },

    performedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    performedByRole: { type: String, default: '' },
  },
  { timestamps: true }
);

stockMovementSchema.index({ merchantId: 1, createdAt: -1 });
stockMovementSchema.index({ stockId: 1, createdAt: -1 });
stockMovementSchema.index({ reference: 1 });

module.exports = mongoose.model('StockMovement', stockMovementSchema);
