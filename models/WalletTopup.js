const mongoose = require('mongoose');

// A gateway-verified purchase of VIPS points with real currency — replaces
// the old self-reported POST /user/wallet/topup (still kept for the
// integration test fixtures that use it to fund a test wallet, but no
// longer called by the real app: it minted wallet balance from a
// client-supplied number with nothing actually charged).
const walletTopupSchema = new mongoose.Schema(
  {
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    vipsAmount: { type: Number, required: true },
    tndAmount:  { type: Number, required: true },
    gateway:    { type: String, enum: ['paymee', 'paypal'], required: true },
    paymentReference: { type: String, default: null },
    status:     { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
  },
  { timestamps: true }
);

walletTopupSchema.index({ paymentReference: 1 }, { sparse: true });

module.exports = mongoose.model('WalletTopup', walletTopupSchema);
