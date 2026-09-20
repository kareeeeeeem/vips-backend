/**
 * Authentication for the customer and merchant apps.
 *
 * A valid signature is not enough on its own: the token says who someone was
 * when it was issued, and tokens here live for seven days. Whether that
 * account still exists, and whether it is still allowed in, is a question
 * only the database can answer — so it is asked on every request, the same
 * way middleware/adminAuth.js has always asked it for the console.
 *
 * Without that load, banning a customer from the admin console blocked their
 * next *login* and nothing else: whoever was already signed in carried on
 * ordering and spending points until their token happened to expire. And a
 * deleted account kept a working token, so every screen answered 500 with
 * "Cannot read properties of null" instead of signing the person out.
 */

const jwt = require('jsonwebtoken');
const User = require('../models/User');

/** Read and verify the bearer token; returns its claims or null. */
function claimsFrom(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

const authMiddleware = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Access denied. No token provided.',
    });
  }

  const decoded = claimsFrom(req);
  if (!decoded) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token.',
    });
  }

  try {
    const account = await User.findById(decoded.id).select('_id email role isActive');

    // 401 rather than 404: from the client's side this is "your session is no
    // longer good", which is the same thing it does about an expired token —
    // clear it and show the sign-in screen.
    if (!account) {
      return res.status(401).json({
        success: false,
        message: 'This account no longer exists. Please sign in again.',
      });
    }

    if (account.isActive === false) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_SUSPENDED',
        message: 'This account has been suspended. Please contact support.',
      });
    }

    // The claims' shape is unchanged — a hundred routes read `req.user.id`
    // and `req.user.role`. The role comes from the record rather than the
    // token, so a role change takes effect at once instead of at expiry.
    req.user = { ...decoded, id: String(account._id), role: account.role };
    req.account = account;
    return next();
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Public endpoints: attaches the caller if they have a good token, and
 * carries on without one if they do not.
 *
 * A suspended or deleted account is treated as no caller at all rather than
 * as an error — these routes are meant to answer anonymously, and failing
 * them would take the storefront down for a banned user instead of simply
 * showing them the public view.
 */
const optionalAuthMiddleware = async (req, res, next) => {
  const decoded = claimsFrom(req);
  if (!decoded) return next();

  try {
    const account = await User.findById(decoded.id).select('_id email role isActive');
    if (account && account.isActive !== false) {
      req.user = { ...decoded, id: String(account._id), role: account.role };
      req.account = account;
    }
  } catch {
    // A database hiccup must not take out an endpoint that works anonymously.
  }
  return next();
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Insufficient permissions.',
    });
  }
  return next();
};

module.exports = { authMiddleware, optionalAuthMiddleware, requireRole };
