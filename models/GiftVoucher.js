const mongoose = require('mongoose');

const giftVoucherSchema = new mongoose.Schema(
  {
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    recipientPhone: { type: String, required: true },
    amount: { type: Number, required: true },
    message: { type: String, default: '' },
    isClaimed: { type: Boolean, default: false },
    claimedAt: { type: Date, default: null },
    code: { type: String, required: true, unique: true },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('GiftVoucher', giftVoucherSchema);
