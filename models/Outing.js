const mongoose = require('mongoose');

const outingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    subtitle: { type: String, required: true },
    image: { type: String, required: true },
    category: { type: String, required: true },
    location: { type: String, required: true },
    type: { type: String, required: true }, // e.g., 'mall', 'outdoor', 'plaza'
    rating: { type: Number, default: 0 },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Outing', outingSchema);
