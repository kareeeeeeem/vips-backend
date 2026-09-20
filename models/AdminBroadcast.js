const mongoose = require('mongoose');

const adminBroadcastSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 100 },
  message: { type: String, required: true, trim: true, maxlength: 1000 },
  audience: { type: String, enum: ['customers', 'merchants', 'all'], required: true },
  type: { type: String, enum: ['system', 'promotion', 'account'], default: 'system' },
  actionUrl: { type: String, default: '', maxlength: 300 },
  sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  customerCount: { type: Number, default: 0, min: 0 },
  merchantCount: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

module.exports = mongoose.model('AdminBroadcast', adminBroadcastSchema);
