const mongoose = require('mongoose');

const stockSchema = new mongoose.Schema(
  {
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, default: 'General' },
    currentStock: { type: Number, default: 0 },
    lowStockThreshold: { type: Number, default: 10 },
    unitPrice: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Stock', stockSchema);
