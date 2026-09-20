/**
 * Admin console roles and permissions.
 *
 * A permission is `<module>.<action>`. Actions are per-module rather than a
 * uniform CRUD set, because the actions that matter differ: banning a user,
 * approving a merchant and refunding an invoice are each their own decision
 * and each deserves its own grant.
 *
 * Roles are named bundles; an individual admin can be granted extras on top.
 * The wildcard '*' means everything and is what the bootstrap super admin
 * holds.
 */

/**
 * The catalogue.
 *
 * `enforced: false` marks a permission that is declared but gates no route
 * yet — granting it changes nothing today. It is listed so the model is
 * complete and the API surfaces the fact, rather than presenting a checkbox
 * that quietly does nothing.
 */
const MODULE_ACTIONS = {
  dashboard: {
    read: 'View the dashboard and its figures',
  },
  users: {
    create: 'Create a customer account',
    read: 'View customers and their details',
    update: 'Edit a customer, including their role',
    delete: 'Permanently delete a customer account',
    ban: 'Suspend a customer, blocking sign-in',
    unban: 'Reinstate a suspended customer',
  },
  merchants: {
    create: { label: 'Create a merchant account', enforced: false,
      reason: 'Merchants sign themselves up in the VIPs Merchant app.' },
    read: 'View merchants and their details',
    update: 'Edit a merchant',
    delete: 'Permanently delete a merchant',
    approve: 'Approve or reject a business registration',
    activate: 'Make a merchant visible to customers',
    deactivate: 'Hide a merchant from customers',
  },
  orders: {
    create: { label: 'Create an order', enforced: false,
      reason: 'Orders come from the customer app; counter sales go through the till.' },
    read: 'View orders and their details',
    update: 'Change an order status',
    delete: { label: 'Delete an order', enforced: false,
      reason: 'Orders are financial records — cancel instead of deleting.' },
    cancel: 'Cancel an order',
    refund: 'Move an order to refunded',
  },
  products: {
    create: 'Add a product to a merchant catalogue',
    read: 'View the product catalogue',
    update: 'Edit a product, including price and cost',
    delete: 'Remove a product from the catalogue',
  },
  offers: {
    read: 'View coupons and vouchers across every merchant',
    update: 'Activate or suspend a coupon or voucher',
    delete: 'Remove an unused coupon or voucher',
  },
  subscriptions: {
    read: 'View customer and merchant subscriptions',
    update: 'Suspend, restore or correct a subscription expiry',
    review_payment: 'Approve or reject bank-transfer and partner-cash subscription payments',
  },
  wallets: {
    read: 'View customer and merchant wallet balances and ledger entries',
    adjust: 'Apply a documented administrative wallet or points adjustment',
  },
  ads: {
    read: 'View advertisements submitted by merchants',
    moderate: 'Approve or reject advertisements before customers see them',
  },
  broadcasts: {
    read: 'View the administrative broadcast history',
    send: 'Send notifications to customers and merchants',
  },
  inventory: {
    create: 'Open a new stock line',
    read: 'View stock, movements and alerts',
    update: 'Edit a stock line',
    delete: 'Remove a stock line',
    transfer: 'Move stock between locations',
    adjust: 'Correct a stock level',
  },
  pos: {
    create: 'Ring up a sale and take payment',
    read: 'View the till, sessions and receipts',
    update: 'Change the cart, discount or customer',
    delete: { label: 'Delete a receipt', enforced: false,
      reason: 'Receipts are financial records — refund instead of deleting.' },
    refund: 'Refund a receipt',
    open_session: 'Open a till session',
    close_session: 'Close a till session',
  },
  reports: {
    read: 'View reports',
    export: 'Download a report as a file',
  },
  analytics: {
    read: 'View visitor and conversion analytics',
  },
  staff: {
    create: 'Add a console operator',
    read: 'View console operators',
    update: 'Edit an operator, including enabling and disabling',
    delete: 'Remove a console operator',
    assign_role: "Change an operator's role",
    assign_permissions: 'Grant permissions on top of a role',
  },
  settings: {
    read: 'View platform settings',
    update: 'Change platform settings and the admin roster',
  },
};

const MODULES = Object.keys(MODULE_ACTIONS);

/** Normalise a value that may be a plain label or a descriptor object. */
const describe = (value) =>
  typeof value === 'string'
    ? { label: value, enforced: true, reason: '' }
    : { enforced: true, reason: '', ...value };

/** Every permission string the system understands. */
const ALL_PERMISSIONS = MODULES.flatMap((module) =>
  Object.keys(MODULE_ACTIONS[module]).map((action) => `${module}.${action}`)
);

/** The catalogue as a flat, describable list for the API and the console. */
const PERMISSION_CATALOGUE = MODULES.flatMap((module) =>
  Object.entries(MODULE_ACTIONS[module]).map(([action, value]) => {
    const described = describe(value);
    return {
      key: `${module}.${action}`,
      module,
      action,
      label: described.label,
      enforced: described.enforced,
      reason: described.reason,
    };
  })
);

/** Helper for building role bundles. */
const only = (module, ...actions) => actions.map((a) => `${module}.${a}`);
const everything = (module) =>
  Object.keys(MODULE_ACTIONS[module]).map((a) => `${module}.${a}`);
const readAll = MODULES.map((m) => `${m}.read`);

/**
 * What each role can do out of the box.
 *
 * The splits that matter: `manager` runs day-to-day operations but deletes
 * nothing and cannot touch staff; `cashier` exists to work the till and sees
 * nothing else it does not need; `viewer` is read-only — so handing someone a
 * login to read reports cannot also hand them the ability to ban a customer.
 */
const ROLE_PERMISSIONS = {
  super_admin: ['*'],

  // Everything except minting another super admin, which is enforced
  // separately in the routes rather than as a permission.
  admin: ALL_PERMISSIONS.filter((p) => describe(
    MODULE_ACTIONS[p.split('.')[0]][p.split('.')[1]]
  ).enforced),

  manager: [
    ...readAll,
    ...only('users', 'update', 'ban', 'unban'),
    ...only('merchants', 'update', 'approve', 'activate', 'deactivate'),
    ...only('orders', 'update', 'cancel'),
    ...only('products', 'update'),
    ...only('offers', 'update'),
    ...only('subscriptions', 'update'),
    ...only('subscriptions', 'review_payment'),
    ...only('wallets', 'adjust'),
    ...only('ads', 'moderate'),
    ...only('broadcasts', 'send'),
    ...only('inventory', 'update', 'transfer', 'adjust'),
    ...only('pos', 'create', 'update', 'open_session', 'close_session'),
    ...only('reports', 'export'),
  ],

  cashier: [
    'dashboard.read',
    ...only('orders', 'read', 'update'),
    ...only('products', 'read'),
    ...only('offers', 'read'),
    ...only('subscriptions', 'read'),
    ...only('wallets', 'read'),
    ...only('ads', 'read'),
    ...only('inventory', 'read'),
    ...only('pos', 'create', 'read', 'update', 'open_session', 'close_session'),
  ],

  viewer: [
    ...only('dashboard', 'read'),
    ...only('users', 'read'),
    ...only('merchants', 'read'),
    ...only('orders', 'read'),
    ...only('products', 'read'),
    ...only('offers', 'read'),
    ...only('subscriptions', 'read'),
    ...only('wallets', 'read'),
    ...only('ads', 'read'),
    ...only('inventory', 'read'),
    ...only('reports', 'read'),
    ...only('analytics', 'read'),
  ],
};

const ROLES = Object.keys(ROLE_PERMISSIONS);

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

/** Reject a permission string the catalogue does not know. */
function unknownPermissions(list) {
  return (list || []).filter(
    (p) => p !== '*' && !ALL_PERMISSIONS.includes(p) && !p.endsWith('.*')
  );
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

/**
 * Gate a route on any one of several permissions.
 *
 * For endpoints that cover more than one decision — PUT /users/:id/ban both
 * bans and reinstates, so either grant is enough to reach it and the handler
 * checks which one the body is actually asking for.
 */
const requireAnyPermission = (...permissions) => (req, res, next) => {
  if (!req.admin) {
    return res.status(500).json({
      success: false,
      message: 'Permission check ran before authentication.',
    });
  }
  if (permissions.some((p) => hasPermission(req.admin, p))) return next();
  return res.status(403).json({
    success: false,
    message: `Your role does not allow this (one of: ${permissions.join(', ')}).`,
  });
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
  MODULE_ACTIONS,
  ALL_PERMISSIONS,
  PERMISSION_CATALOGUE,
  ROLE_PERMISSIONS,
  ROLES,
  permissionsFor,
  hasPermission,
  unknownPermissions,
  requirePermission,
  requireAnyPermission,
  requireAdminRole,
};
