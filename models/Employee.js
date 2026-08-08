const mongoose = require('mongoose');

const employeeSchema = new mongoose.Schema({
  merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:    { type: String, required: true },
  role:    { type: String, default: 'Cashier' },
  status:  { type: String, enum: ['active', 'pending', 'removed'], default: 'active' },
  email:   { type: String, default: '' },
  phone:   { type: String, default: '' },
  salary:  { type: Number, default: 0 },
  pin:     { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('Employee', employeeSchema);
