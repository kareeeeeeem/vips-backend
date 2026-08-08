const mongoose = require('mongoose');

const staffSchema = new mongoose.Schema(
  {
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    role: { type: String, default: 'Staff' },
    status: { type: String, enum: ['Active', 'On Leave', 'Inactive'], default: 'Active' },
    salary: { type: Number, default: 0 },
    joinedDate: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Staff', staffSchema);
