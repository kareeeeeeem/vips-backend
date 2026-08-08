const mongoose = require('mongoose');

const dealSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String, required: true },
    image: { type: String, required: true },
    currentPrice: { type: Number, required: true },
    originalPrice: { type: Number, required: true },
    discount: { type: Number, required: true },
    rating: { type: Number, default: 0 },
    category: { type: String, required: true },
    endTime: { type: Date, default: null }, // Used for "Ending Soon" deals
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
  }
);

dealSchema.index({ endTime: 1 });
dealSchema.index({ category: 1 });

module.exports = mongoose.model('Deal', dealSchema);
