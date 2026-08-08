const mongoose = require('mongoose');

const merchantNotificationSchema = new mongoose.Schema(
  {
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title:      { type: String, required: true },
    body:       { type: String, required: true },
    type: {
      type: String,
      enum: ['order', 'payment', 'review', 'system', 'alert', 'gift_back', 'subscription'],
      default: 'system',
    },
    isRead:    { type: Boolean, default: false },
    data:      { type: mongoose.Schema.Types.Mixed, default: {} },
    actionUrl: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MerchantNotification', merchantNotificationSchema);
