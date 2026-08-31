const AdminAuditLog = require('../models/AdminAuditLog');

/**
 * Records every change an operator makes in the console.
 *
 * Mounted once, after adminAuth, rather than called from each route: a log
 * that every handler has to remember to write is a log with holes in exactly
 * the handlers somebody forgot.
 *
 * Only mutating methods are recorded. Reads are not interesting and would
 * bury the writes — a hundred page loads between two bans makes the bans
 * harder to find, not easier.
 */

// Never stored, whatever the route calls them.
const SECRET_KEYS = [
  'password', 'newPassword', 'currentPassword', 'confirmPassword',
  'token', 'accessToken', 'refreshToken', 'otp', 'secret', 'apiKey',
];

/**
 * The request body with secrets removed and long values clipped.
 *
 * A password that reaches the audit collection is a password stored in
 * plaintext, so these are replaced rather than hashed or truncated.
 */
function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[nested]';
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((v) => redact(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (SECRET_KEYS.some((s) => key.toLowerCase() === s.toLowerCase())) {
        out[key] = '[redacted]';
      } else {
        out[key] = redact(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) {
    return `${value.slice(0, 500)}… [${value.length} chars]`;
  }
  return value;
}

/**
 * A human label for the route, and what it acted on.
 *
 * Ordered most-specific first, because '/users/:id/ban' has to be matched
 * before the generic '/users/:id'.
 */
const ACTIONS = [
  [/^\/users\/[^/]+\/ban$/,          'POST PUT', (req) =>
    (req.body && req.body.banned === false) ? 'Reinstated a customer' : 'Suspended a customer', 'user'],
  [/^\/users\/[^/]+\/role$/,         'PUT',    () => 'Changed an account role', 'user'],
  [/^\/users\/[^/]+$/,               'PUT',    () => 'Edited a customer', 'user'],
  [/^\/users\/[^/]+$/,               'DELETE', () => 'Deleted a customer', 'user'],
  [/^\/users$/,                      'POST',   () => 'Created a customer', 'user'],

  [/^\/merchants\/[^/]+\/approve$/,  'PUT',    (req) =>
    (req.body && req.body.approved === false) ? 'Rejected a business registration' : 'Approved a business registration', 'merchant'],
  [/^\/merchants\/[^/]+\/activate$/, 'PUT',    (req) =>
    (req.body && req.body.active === false) ? 'Hid a merchant from customers' : 'Made a merchant visible', 'merchant'],
  [/^\/merchants\/[^/]+$/,           'DELETE', () => 'Deleted a merchant', 'merchant'],

  [/^\/orders\/[^/]+\/status$/,      'PUT',    (req) =>
    `Changed an order to ${(req.body && req.body.status) || 'a new status'}`, 'order'],
  [/^\/orders\/[^/]+$/,              'DELETE', () => 'Cancelled an order', 'order'],

  [/^\/products$/,                   'POST',   () => 'Added a product', 'product'],
  [/^\/products\/[^/]+$/,            'PUT',    () => 'Edited a product', 'product'],
  [/^\/products\/[^/]+$/,            'DELETE', () => 'Deleted a product', 'product'],

  [/^\/inventory\/transfer$/,        'POST',   () => 'Transferred stock between locations', 'stock'],
  [/^\/inventory$/,                  'POST',   () => 'Opened a stock line', 'stock'],
  [/^\/inventory\/[^/]+$/,           'PUT',    () => 'Edited a stock line', 'stock'],
  [/^\/inventory\/[^/]+$/,           'DELETE', () => 'Removed a stock line', 'stock'],

  [/^\/pos\/session\/start$/,        'POST',   () => 'Opened a till session', 'pos'],
  [/^\/pos\/session\/end$/,          'POST',   () => 'Closed a till session', 'pos'],
  [/^\/pos\/invoice\/create$/,       'POST',   () => 'Rang up a sale', 'pos'],
  [/^\/pos\/invoice\/refund$/,       'POST',   () => 'Refunded a receipt', 'pos'],
  [/^\/pos\/customers$/,             'POST',   () => 'Added a till customer', 'pos'],

  [/^\/staff$/,                      'POST',   () => 'Added a console operator', 'staff'],
  [/^\/staff\/[^/]+$/,               'PUT',    (req) => {
    const body = req.body || {};
    if (body.adminRole) return `Changed an operator's role to ${body.adminRole}`;
    if (body.permissions) return "Changed an operator's permissions";
    if (body.isActive === false) return 'Disabled an operator';
    if (body.isActive === true) return 'Re-enabled an operator';
    return 'Edited an operator';
  }, 'staff'],
  [/^\/staff\/[^/]+$/,               'DELETE', () => 'Removed a console operator', 'staff'],

  [/^\/roles$/,                      'POST',   () => 'Created a custom role', 'role'],
  [/^\/roles\/[^/]+$/,               'PUT',    () => 'Edited a custom role', 'role'],
  [/^\/roles\/[^/]+$/,               'DELETE', () => 'Deleted a custom role', 'role'],

  [/^\/settings\/admins$/,           'POST',   () => 'Created an administrator', 'staff'],
  [/^\/settings\/admins\/[^/]+$/,    'DELETE', () => 'Removed an administrator', 'staff'],
];

function describe(req) {
  for (const [pattern, methods, label, targetType] of ACTIONS) {
    if (!methods.split(' ').includes(req.method)) continue;
    if (!pattern.test(req.path)) continue;
    return { action: label(req), targetType };
  }
  return { action: `${req.method} ${req.path}`, targetType: '' };
}

/** The id the path acted on, when the last segment looks like one. */
function targetIdOf(req) {
  const segments = req.path.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (/^[0-9a-fA-F]{24}$/.test(segments[i])) return segments[i];
  }
  return '';
}

const RECORDED_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

// Signing in and out are their own records, written by those routes, because
// they happen before this middleware has an operator to attribute them to.
const SKIP_PATHS = [/^\/logout$/];

const auditLog = (req, res, next) => {
  if (!RECORDED_METHODS.includes(req.method)) return next();
  if (SKIP_PATHS.some((p) => p.test(req.path))) return next();

  const { action, targetType } = describe(req);
  const targetId = targetIdOf(req);
  // Captured before the handler runs: a route that mutates req.body would
  // otherwise be recorded as having received what it produced.
  const changes = redact(req.body);

  const write = (statusCode, payload) => {
    const body = payload && typeof payload === 'object' ? payload : {};
    AdminAuditLog.create({
      actorId: req.admin ? req.admin._id : null,
      actorName: req.admin ? req.admin.fullName : '',
      actorEmail: req.admin ? req.admin.email : '',
      actorRole: req.admin ? req.admin.adminRole : '',
      method: req.method,
      path: req.path,
      action,
      targetType,
      targetId,
      statusCode,
      success: statusCode >= 200 && statusCode < 300,
      changes,
      message: typeof body.message === 'string' ? body.message.slice(0, 300) : '',
      ip: req.ip || '',
      // Never let the audit write break the action it is recording. A failed
      // log is a gap in the history; a failed ban is a bug the operator sees.
    }).catch((error) => {
      console.error('[AUDIT] could not record admin action:', error.message);
    });
  };

  // res.json is what every handler in this API answers with, so wrapping it
  // catches the outcome — including the refusals, which are the lines an
  // audit log exists for.
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    write(res.statusCode, payload);
    return originalJson(payload);
  };

  next();
};

module.exports = { auditLog, redact, describe };
