const mongoose = require('mongoose');

const billServiceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    provider: { type: String, required: true },
    type: { type: String, required: true }, // e.g., 'telecom', 'electricity', 'water', 'gas'
    logo: { type: String, default: null },
    fee: { type: Number, default: 0 },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('BillService', billServiceSchema);
