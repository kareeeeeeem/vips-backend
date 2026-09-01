const mongoose = require('mongoose');

/**
 * Every movement of a merchant's guarantee (§5.1, §5.2).
 *
 * The balances on User.guarantee are a running total; this is what they are
 * a total *of*. A guarantee is the merchant's own money held in trust, so a
 * figure they cannot reconcile line by line is not good enough — and §5.2's
 * refundable amount is defined as a formula over exactly these movements.
 *
 * Amounts are in points throughout; `tnd` carries the cash figure only for
 * the two entries that move real money (deposit and refund).
 */
const guaranteeLedgerSchema = new mongoose.Schema(
  {
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    type: {
      type: String,
      required: true,
      enum: [
        'deposit',    // cash in, converted to points
        'allocate',   // unallocated points moved into a budget
        'reallocate', // points moved between budgets
        'fund',       // an offer paid a customer out of a budget
        'redeem',     // a voucher was spent in-store; value returns to `general`
        'refund',     // cash out, back to the merchant
      ],
    },

    /** Signed, in points: positive adds to the named budget, negative takes from it. */
    points: { type: Number, required: true },

    /** Cash moved, in dinars. Only set on `deposit` and `refund`. */
    tnd: { type: Number, default: null },

    /** Which budget moved. Null for a deposit, which lands unallocated. */
    budget: { type: String, enum: ['discount', 'packages', 'general', null], default: null },
    /** For `reallocate`, where the points came from. */
    fromBudget: { type: String, enum: ['discount', 'packages', 'general', null], default: null },

    /** Balance of that budget immediately after this entry, for reconciliation. */
    balanceAfter: { type: Number, default: 0 },

    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '' },
    /** Admin or merchant user who caused the movement. */
    byId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

guaranteeLedgerSchema.index({ merchantId: 1, createdAt: -1 });
guaranteeLedgerSchema.index({ merchantId: 1, type: 1 });

module.exports = mongoose.model('GuaranteeLedger', guaranteeLedgerSchema);
