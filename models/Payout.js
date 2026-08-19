const mongoose = require('mongoose');

// A merchant's request to withdraw real currency (walletBalance) out of the
// app. There's no bank/disbursement rail wired up (same honest-gap
// category as card tokenization) so this is a real request/ledger record —
// funds are held (deducted from walletBalance) the moment the request is
// made, same as the rest of this app's finance features (Due, gift-back)
// are internal ledgers rather than connected to real money movement.
const payoutSchema = new mongoose.Schema(
  {
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount:     { type: Number, required: true },
    bankName:        { type: String, default: '' },
    accountName:     { type: String, default: '' },
    accountNumber:   { type: String, default: '' },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'paid'],
      default: 'pending',
    },
    note:        { type: String, default: '' },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

payoutSchema.index({ merchantId: 1, createdAt: -1 });

module.exports = mongoose.model('Payout', payoutSchema);
