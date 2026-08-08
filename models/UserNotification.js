const mongoose = require('mongoose');

const userNotificationSchema = new mongoose.Schema(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title:     { type: String, required: true },
    message:   { type: String, required: true },
    type:      { type: String, enum: ['order', 'payment', 'promotion', 'account', 'reward', 'system'], default: 'system' },
    isRead:    { type: Boolean, default: false },
    data:      { type: mongoose.Schema.Types.Mixed, default: null },
    actionUrl: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('UserNotification', userNotificationSchema);
