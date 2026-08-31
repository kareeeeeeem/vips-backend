const mongoose = require('mongoose');

/**
 * What an operator did in the console.
 *
 * The platform records who a receipt, till session and stock movement belong
 * to, but nothing recorded who banned a customer, approved a merchant,
 * changed a price or granted a permission — so a console with five roles and
 * forty-seven permissions had no way to answer "who did this, and when".
 *
 * Written by middleware rather than by each route, because a log every
 * handler has to remember to call is a log with holes in it.
 */
const adminAuditLogSchema = new mongoose.Schema(
  {
    // Denormalised on purpose: an operator can be disabled or removed later,
    // and an audit line that reads "deleted account" is not an audit line.
    actorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, default: '' },
    actorEmail:{ type: String, default: '' },
    actorRole: { type: String, default: '' },

    method: { type: String, required: true },
    path:   { type: String, required: true },

    /// A human label for what was attempted — "Banned a customer", not
    /// "PUT /users/:id/ban".
    action: { type: String, default: '' },

    /// What it was done to, so a record can be traced back to its subject.
    targetType: { type: String, default: '' },
    targetId:   { type: String, default: '' },

    /// The HTTP outcome. Refusals are recorded too: an operator repeatedly
    /// hitting 403 is exactly what an audit log exists to surface.
    statusCode: { type: Number, default: 0 },
    success:    { type: Boolean, default: false },

    /// The request body with every secret stripped. Kept small — this is a
    /// record of what changed, not a copy of the database.
    changes: { type: mongoose.Schema.Types.Mixed, default: null },

    /// Why it failed, when it did.
    message: { type: String, default: '' },

    ip: { type: String, default: '' },
  },
  { timestamps: true }
);

adminAuditLogSchema.index({ createdAt: -1 });
adminAuditLogSchema.index({ actorId: 1, createdAt: -1 });
adminAuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
adminAuditLogSchema.index({ success: 1, createdAt: -1 });

module.exports = mongoose.model('AdminAuditLog', adminAuditLogSchema);
