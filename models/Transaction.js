const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    operationId: { type: String },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    type: {
      type: String,
      enum: ['credit', 'debit', 'gift_back', 'reward', 'expense', 'income', 'transfer'],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: 'TND',
    },
    // Finance-journal fields (merchant "Finance & Accounting" screen). The
    // merchant picks both in Add Transaction; without them on the schema
    // Mongoose strict mode silently discarded what the app sent, so every
    // journal row read back as category "Other" / account "Cash".
    category: {
      type: String,
      default: 'Other',
    },
    account: {
      type: String,
      enum: ['Cash', 'Bank'],
      default: 'Cash',
    },
    description: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'cancelled'],
      default: 'pending',
    },
    reference: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ operationId: 1 }, { unique: true, sparse: true });
transactionSchema.index({ merchantId: 1, createdAt: -1 });
transactionSchema.index({ merchantId: 1, status: 1 });
transactionSchema.index({ userId: 1, type: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
