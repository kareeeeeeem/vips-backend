const mongoose = require('mongoose');

/**
 * A named permission bundle an admin can be assigned.
 *
 * The four built-in roles live in `middleware/permissions.js` because they
 * are code the gate depends on. This collection is for roles an operator
 * defines themselves, so a new one can be created without a deploy.
 */
const roleSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    permissions: { type: [String], default: [] },
    isActive:    { type: Boolean, default: true },
    // Marks the four roles that ship with the system so the API can refuse
    // to delete one out from under an admin who is using it.
    isBuiltIn:   { type: Boolean, default: false },
    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Role', roleSchema);
