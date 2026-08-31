const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * The admin console gate: verify the token, load the admin, attach it.
 *
 * Loads the account on every request rather than trusting the claims in the
 * token. That matters because a JWT lives for days: without this, demoting
 * someone from super_admin to viewer, or disabling their account, would not
 * take effect until their token expired.
 *
 * `req.admin` is the User document (admins are Users with role 'admin' — see
 * the note on User.adminRole for why they are not a separate collection).
 * `req.user` is also set, so the handlers already written against it, and the
 * refs that attribute an action to whoever performed it, keep working.
 */
module.exports = async function adminAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.',
      });
    }

    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);

    const admin = await User.findById(decoded.id).select('-password -pin');
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.',
      });
    }
    if (admin.isActive === false) {
      return res.status(403).json({
        success: false,
        message: 'This admin account is disabled.',
      });
    }

    req.admin = admin;
    req.user = { id: String(admin._id), email: admin.email, role: admin.role };
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token.',
    });
  }
};
