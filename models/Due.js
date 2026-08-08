const mongoose = require('mongoose');

const dueSchema = new mongoose.Schema(
  {
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    partyName: { type: String, required: true, trim: true },
    phone: { type: String, default: '' },
    totalAmount: { type: Number, default: 0 },
    paidAmount: { type: Number, default: 0 },
    isCustomer: { type: Boolean, default: true },
    lastTransaction: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Due', dueSchema);
