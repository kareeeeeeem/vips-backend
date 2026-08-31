/**
 * Admin console roles and permissions.
 *
 * A permission is `<module>.<action>`. Roles are named bundles; an individual
 * admin can be granted extras on top of their role. The wildcard '*' means
 * everything and is what the bootstrap super admin holds.
 */

const MODULES = [
  'dashboard',
  'users',
  'merchants',
  'orders',
  'inventory',
  'pos',
  'reports',
  'staff',
  'settings',
];

const ACTIONS = ['read', 'write', 'delete'];

/** Every permission string the system understands. */
const ALL_PERMISSIONS = MODULES.flatMap((m) => ACTIONS.map((a) => `${m}.${a}`));

const readAll = MODULES.map((m) => `${m}.read`);

/**
 * What each role can do out of the box.
 *
 * The split that matters: `manager` runs day-to-day operations but cannot
 * delete anything or touch staff and settings, and `viewer` is read-only —
 * so handing someone a login to look at reports cannot also hand them the
 * ability to ban a customer.
 */
const ROLE_PERMISSIONS = {
  super_admin: ['*'],

  // The everyday operator role. It can manage other operators, but the
  // super-admin ceiling is enforced separately: creating, promoting to, or
  // removing a super_admin is refused for anyone who is not one.
  admin: [
    ...readAll,
    'users.write', 'users.delete',
    'merchants.write', 'merchants.delete',
    'orders.write', 'orders.delete',
    'inventory.write',
    'pos.write',
    'staff.write', 'staff.delete',
    'settings.write',
  ],

  manager: [
    ...readAll,
    'users.write',
    'merchants.write',
    'orders.write',
    'inventory.write',
    'pos.write',
  ],

  viewer: [...readAll],
};

/** The effective set for an admin: their role's bundle plus any extras. */
function permissionsFor(admin) {
  if (!admin) return [];
  const fromRole = ROLE_PERMISSIONS[admin.adminRole] || ROLE_PERMISSIONS.viewer;
  const extra = Array.isArray(admin.permissions) ? admin.permissions : [];
  return [...new Set([...fromRole, ...extra])];
}

function hasPermission(admin, permission) {
  const granted = permissionsFor(admin);
  if (granted.includes('*')) return true;
  if (granted.includes(permission)) return true;
  // A module-level wildcard ('orders.*') covers every action in it.
  const [moduleName] = permission.split('.');
  return granted.includes(`${moduleName}.*`);
}

/**
 * Gate a route on one permission.
 *
 * Runs after `adminAuth`, which is what puts `req.admin` in place. Missing
 * that is a wiring mistake rather than a client error, so it answers 500
 * instead of quietly letting the request through.
 */
const requirePermission = (permission) => (req, res, next) => {
  if (!req.admin) {
    return res.status(500).json({
      success: false,
      message: 'Permission check ran before authentication.',
    });
  }
  if (!hasPermission(req.admin, permission)) {
    return res.status(403).json({
      success: false,
      message: `Your role does not allow this (${permission} required).`,
    });
  }
  next();
};

/** Gate a route on the admin's role, for the few things that are role-shaped. */
const requireAdminRole = (...roles) => (req, res, next) => {
  if (!req.admin) {
    return res.status(500).json({
      success: false,
      message: 'Role check ran before authentication.',
    });
  }
  if (!roles.includes(req.admin.adminRole)) {
    return res.status(403).json({
      success: false,
      message: `This action is limited to: ${roles.join(', ')}.`,
    });
  }
  next();
};

module.exports = {
  MODULES,
  ACTIONS,
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  permissionsFor,
  hasPermission,
  requirePermission,
  requireAdminRole,
};
