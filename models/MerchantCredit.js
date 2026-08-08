const mongoose = require('mongoose');

const creditPaymentSchema = new mongoose.Schema({
  amount:  { type: Number, required: true },
  paidAt:  { type: Date, default: Date.now },
  method:  { type: String, default: 'cash' },
  note:    { type: String, default: '' },
});

const merchantCreditSchema = new mongoose.Schema(
  {
    merchantId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    customerId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    customerName:   { type: String, required: true },
    customerPhone:  { type: String, default: '' },
    amount:          { type: Number, required: true },
    paidAmount:      { type: Number, default: 0 },
    remainingAmount: { type: Number, required: true },
    dueDate:         { type: Date, default: null },
    status: {
      type: String,
      enum: ['active', 'settled', 'overdue', 'cancelled'],
      default: 'active',
    },
    description:  { type: String, default: '' },
    reference:    { type: String, default: '' },
    transactions: [creditPaymentSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model('MerchantCredit', merchantCreditSchema);
