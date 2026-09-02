const mongoose = require('mongoose');

/**
 * A merchant saying they have sent money for their guarantee (§5.1).
 *
 * Points are not created here. A guarantee stands for cash that actually
 * arrived, so the merchant declares the transfer and an administrator
 * confirms receipt — only then does utils/guarantee.deposit run. Letting a
 * merchant credit their own guarantee would put points into circulation
 * against money nobody had received.
 */
const guaranteeDepositRequestSchema = new mongoose.Schema(
  {
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amountTnd:  { type: Number, required: true, min: 0 },

    /** Bank transfer reference the merchant gives so it can be matched. */
    reference:  { type: String, default: '' },
    bankName:   { type: String, default: '' },
    note:       { type: String, default: '' },

    status: {
      type: String,
      enum: ['pending', 'confirmed', 'rejected'],
      default: 'pending',
      index: true,
    },
    /** Set when an administrator confirms or turns it down. */
    reviewedAt:  { type: Date, default: null },
    reviewedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewNote:  { type: String, default: '' },
  },
  { timestamps: true }
);

guaranteeDepositRequestSchema.index({ merchantId: 1, createdAt: -1 });

module.exports = mongoose.model('GuaranteeDepositRequest', guaranteeDepositRequestSchema);
