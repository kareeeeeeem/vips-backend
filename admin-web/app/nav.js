/**
 * The sidebar, and the single list of what this console contains.
 *
 * Each entry names the permission that opens it. An operator only ever sees
 * the sections their role can actually use — a cashier signing in gets the
 * till and nothing else — and a group whose every child is hidden disappears
 * along with its heading, rather than leaving a label over empty space.
 */

export const NAV = [
  { path: '/', label: 'Dashboard', icon: 'las la-rocket', permission: 'dashboard.read' },

  {
    group: 'Insight',
    // These mirror routes/admin_dashboards.js exactly: `operations` is the
    // shift-level view a till operator already has through orders.read, so it
    // sits behind dashboard.read; the other four aggregate platform money,
    // margin and the customer base and need reports.read. Getting this wrong
    // does not open anything — the server still refuses — but it offers a
    // cashier five links that answer "you do not have permission", which is a
    // worse experience than not showing them.
    children: [
      { path: '/dashboards/sales', label: 'Sales', icon: 'las la-chart-line', permission: 'reports.read' },
      { path: '/dashboards/operations', label: 'Operations', icon: 'las la-truck-loading', permission: 'dashboard.read' },
      { path: '/dashboards/finance', label: 'Finance', icon: 'las la-coins', permission: 'reports.read' },
      { path: '/dashboards/marketing', label: 'Marketing', icon: 'las la-bullhorn', permission: 'reports.read' },
      { path: '/dashboards/merchants', label: 'Merchant health', icon: 'las la-store-alt', permission: 'reports.read' },
      { path: '/analytics', label: 'Visitors', icon: 'las la-eye', permission: 'analytics.read' },
    ],
  },

  {
    group: 'People',
    children: [
      { path: '/customers', label: 'Customers', icon: 'las la-users', permission: 'users.read' },
      { path: '/merchants', label: 'Merchants', icon: 'las la-store', permission: 'merchants.read' },
      {
        label: 'Guarantees',
        icon: 'las la-shield-alt',
        children: [
          { path: '/guarantees', label: 'Balances', permission: 'merchants.read' },
          { path: '/guarantees/requests', label: 'Refund requests', permission: 'merchants.read' },
        ],
      },
    ],
  },

  {
    group: 'Commerce',
    children: [
      { path: '/orders', label: 'Orders', icon: 'las la-shopping-bag', permission: 'orders.read' },
      { path: '/products', label: 'Products', icon: 'las la-box', permission: 'products.read' },
      { path: '/offers', label: 'Offers', icon: 'las la-tags', permission: 'offers.read' },
      { path: '/subscriptions', label: 'Subscriptions', icon: 'las la-id-card', permission: 'subscriptions.read' },
      { path: '/wallets', label: 'Wallets & points', icon: 'las la-wallet', permission: 'wallets.read' },
      { path: '/ads', label: 'Advertisements', icon: 'las la-ad', permission: 'ads.read' },
      { path: '/broadcasts', label: 'Broadcasts', icon: 'las la-bullhorn', permission: 'broadcasts.read' },
      {
        label: 'Inventory',
        icon: 'las la-warehouse',
        children: [
          { path: '/inventory', label: 'Stock', permission: 'inventory.read' },
          { path: '/inventory/movements', label: 'Movements', permission: 'inventory.read' },
          { path: '/inventory/alerts', label: 'Low stock', permission: 'inventory.read' },
        ],
      },
      {
        label: 'Point of sale',
        icon: 'las la-cash-register',
        children: [
          { path: '/pos', label: 'Till', permission: 'pos.read' },
          { path: '/pos/sessions', label: 'Sessions', permission: 'pos.read' },
          { path: '/pos/invoices', label: 'Receipts', permission: 'pos.read' },
        ],
      },
    ],
  },

  {
    group: 'Reports',
    children: [
      {
        label: 'Reports',
        icon: 'las la-file-invoice',
        children: [
          { path: '/reports/sales', label: 'Sales', permission: 'reports.read' },
          { path: '/reports/profit', label: 'Profit', permission: 'reports.read' },
          { path: '/reports/commission', label: 'Commission', permission: 'reports.read' },
          { path: '/reports/products', label: 'Products', permission: 'reports.read' },
          { path: '/reports/customers', label: 'Customers', permission: 'reports.read' },
          { path: '/reports/merchants', label: 'Merchants', permission: 'reports.read' },
          { path: '/reports/orders', label: 'Orders', permission: 'reports.read' },
        ],
      },
    ],
  },

  {
    group: 'Administration',
    children: [
      { path: '/staff', label: 'Operators', icon: 'las la-user-shield', permission: 'staff.read' },
      { path: '/roles', label: 'Roles', icon: 'las la-key', permission: 'staff.read' },
      { path: '/audit', label: 'Audit log', icon: 'las la-history', permission: 'settings.read' },
      { path: '/settings', label: 'Settings', icon: 'las la-cog', permission: 'settings.read' },
      { path: '/profile', label: 'My profile', icon: 'las la-user-circle' },
    ],
  },
];

/** Flatten the tree to `path -> entry`, for breadcrumbs and titles. */
export function flatten(items = NAV, trail = []) {
  const out = [];
  for (const item of items) {
    if (item.group) {
      out.push(...flatten(item.children, [...trail, { label: item.group }]));
    } else if (item.children) {
      out.push(...flatten(item.children, [...trail, { label: item.label }]));
    } else if (item.path) {
      out.push({ ...item, trail });
    }
  }
  return out;
}

export const byPath = () => Object.fromEntries(flatten().map((item) => [item.path, item]));
