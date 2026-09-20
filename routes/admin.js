const express = require('express');
const jwt     = require('jsonwebtoken');
const mongoose = require('mongoose');

const adminAuth = require('../middleware/adminAuth');
const {
  ALL_PERMISSIONS,
  hasPermission,
  PERMISSION_CATALOGUE,
  ROLE_PERMISSIONS,
  ROLES,
  MODULE_ACTIONS,
  permissionsFor,
  unknownPermissions,
  requirePermission,
  requireAnyPermission,
} = require('../middleware/permissions');
const { auditLog } = require('../middleware/auditLog');

const User                 = require('../models/User');
const Order                = require('../models/Order');
const Product              = require('../models/Product');
const Stock                = require('../models/Stock');
const Transaction          = require('../models/Transaction');
const BusinessRegistration = require('../models/BusinessRegistration');
const Payout               = require('../models/Payout');
const MerchantAd           = require('../models/MerchantAd');
const StockMovement        = require('../models/StockMovement');
const PosInvoice           = require('../models/PosInvoice');
const PosSession           = require('../models/PosSession');
const Role                 = require('../models/Role');
const AdminAuditLog        = require('../models/AdminAuditLog');
const MerchantSubscription = require('../models/MerchantSubscription');
const VisitEvent           = require('../models/VisitEvent');

const { recordMovement, movementTypeForDelta } = require('../utils/stockLedger');

const guarantee = require('../utils/guarantee');
const { BUDGET_LABELS, PLANS, PLAN_KEYS, pointsToTnd } = require('../config/economics');

const router = express.Router();

// ═══════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════

// Which order statuses count as money actually earned. An order has exactly
// one status, so summing over both terminal states double-counts nothing:
// 'delivered' ends a delivery order, 'picked_up' ends a takeaway one.
const REVENUE_STATUSES = ['delivered', 'picked_up'];

// Both spellings are in the Order enum (historical drift), so any filter on
// "cancelled" has to cover both or it silently misses half the rows.
const CANCELLED_STATUSES = ['canceled', 'cancelled'];

/** Clamp page/limit into a sane range and return the mongo skip/limit pair. */
const paginate = (query) => {
  const page  = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
};

/** Escape a user-supplied search string before it goes into a RegExp. */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a `createdAt` filter from ?from=&to= (ISO dates or yyyy-mm-dd).
 * Returns null when neither is usable, so callers can skip the key entirely.
 */
const dateRangeFilter = (query, field = 'createdAt') => {
  const range = {};
  const from = query.from ? new Date(query.from) : null;
  const to   = query.to ? new Date(query.to) : null;
  if (from && !isNaN(from)) range.$gte = from;
  if (to && !isNaN(to)) {
    // An inclusive end date: '2026-08-30' should cover all of that day.
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.to))) to.setHours(23, 59, 59, 999);
    range.$lte = to;
  }
  return Object.keys(range).length ? { [field]: range } : null;
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/** Fail fast with a 400 rather than letting mongoose throw a CastError 500. */
const requireValidId = (req, res) => {
  if (!isValidId(req.params.id)) {
    res.status(400).json({ success: false, message: 'Invalid id.' });
    return false;
  }
  return true;
};

/** Three decimals, matching every other money and percentage figure here. */
const round = (n) => Number((Number(n) || 0).toFixed(3));

/** Start-of-day N days ago, for the chart/report windows. */
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
};

// ═══════════════════════════════════════════════════════════
// AUTH — the only routes on this router that are not admin-gated
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/admin/login
 * Deliberately separate from /auth/login: it refuses any account whose role
 * is not 'admin', so a stolen customer password can never open the console
 * even though both read the same User collection.
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    // Same generic message whether the account is missing, is not an admin,
    // or the password is wrong — otherwise this endpoint tells an attacker
    // which addresses are admins.
    const reject = () =>
      res.status(401).json({ success: false, message: 'Invalid credentials or not an admin account.' });

    if (!user || user.role !== 'admin') return reject();
    if (!(await user.comparePassword(password))) return reject();
    if (user.isActive === false) {
      return res.status(403).json({ success: false, message: 'This admin account is disabled.' });
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    res.json({
      success: true,
      message: 'Login successful!',
      // The same envelope /me returns. Without the role and the effective
      // permissions here, the console has no idea what the operator may do
      // until something happens to call /me — so every permission-gated
      // control stays hidden for the whole first session after signing in.
      data: {
        user: user.toJSON(),
        token,
        adminRole: user.adminRole,
        permissions: permissionsFor(user),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Everything below requires a valid admin token ─────────
// adminAuth loads the account on every request rather than trusting the
// token's claims, so a demotion or a disabled account takes effect at once
// instead of when the token finally expires.
router.use(adminAuth);

// Every change an operator makes, recorded once here rather than by each
// handler — a log each route has to remember to write is a log with holes in
// exactly the routes somebody forgot. Reads are not recorded; a hundred page
// loads between two bans makes the bans harder to find, not easier.
router.use(auditLog);

/**
 * GET /api/admin/me — the signed-in admin's profile and effective permissions.
 *
 * The console reads `permissions` to hide controls the caller cannot use.
 * That is presentation only: every one of those actions is gated server-side
 * too, so hiding a button is a courtesy rather than the security boundary.
 */
router.get('/me', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'Admin not found.' });
    res.json({
      success: true,
      message: 'Admin profile',
      data: {
        user: user.toJSON(),
        adminRole: user.adminRole,
        permissions: permissionsFor(user),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/admin/logout
 * JWTs are stateless, so this cannot revoke the token — the client discards
 * it. Kept as a real endpoint so the app has one place to record the event
 * and so logout still works the same way if token revocation is added later.
 */
router.post('/logout', async (req, res) => {
  res.json({ success: true, message: 'Logged out.', data: {} });
});

// ═══════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/dashboard/stats — the overview cards. */
router.get('/dashboard/stats', requirePermission('dashboard.read'), async (req, res) => {
  try {
    const since30 = daysAgo(30);

    const [
      totalUsers, activeUsers, newUsers30,
      totalMerchants, activeMerchants, pendingMerchants,
      totalOrders, pendingOrders, cancelledOrders,
      revenueAgg, revenue30Agg,
      totalProducts, lowStockCount, pendingPayouts,
    ] = await Promise.all([
      User.countDocuments({ role: 'customer' }),
      User.countDocuments({ role: 'customer', isActive: true }),
      User.countDocuments({ role: 'customer', createdAt: { $gte: since30 } }),

      User.countDocuments({ role: 'merchant' }),
      User.countDocuments({ role: 'merchant', isActive: true }),
      BusinessRegistration.countDocuments({ status: { $in: ['pending', 'under_review'] } }),

      Order.countDocuments({}),
      Order.countDocuments({ status: 'pending' }),
      Order.countDocuments({ status: { $in: CANCELLED_STATUSES } }),

      Order.aggregate([
        { $match: { status: { $in: REVENUE_STATUSES } } },
        { $group: { _id: null, total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: { status: { $in: REVENUE_STATUSES }, createdAt: { $gte: since30 } } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]),

      Product.countDocuments({}),
      // A low-stock line is one at or under its own threshold, so the
      // comparison has to be field-to-field, not against a constant.
      Stock.countDocuments({ $expr: { $lte: ['$currentStock', '$lowStockThreshold'] } }),
      Payout.countDocuments({ status: 'pending' }),
    ]);

    const revenue = revenueAgg[0] || { total: 0, count: 0 };

    res.json({
      success: true,
      message: 'Dashboard stats',
      data: {
        users: {
          total: totalUsers,
          active: activeUsers,
          banned: totalUsers - activeUsers,
          newLast30Days: newUsers30,
        },
        merchants: {
          total: totalMerchants,
          active: activeMerchants,
          inactive: totalMerchants - activeMerchants,
          pendingApproval: pendingMerchants,
        },
        orders: {
          total: totalOrders,
          pending: pendingOrders,
          cancelled: cancelledOrders,
          completed: revenue.count,
        },
        revenue: {
          total: Number((revenue.total || 0).toFixed(3)),
          last30Days: Number(((revenue30Agg[0] || {}).total || 0).toFixed(3)),
          averageOrderValue: revenue.count
            ? Number((revenue.total / revenue.count).toFixed(3))
            : 0,
        },
        catalog: {
          products: totalProducts,
          lowStockItems: lowStockCount,
        },
        payouts: { pending: pendingPayouts },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/admin/dashboard/charts?days=30
 * One point per calendar day. Days with no orders are filled in with zeros
 * so the client can plot a continuous line instead of guessing the gaps.
 */
router.get('/dashboard/charts', requirePermission('dashboard.read'), async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const since = daysAgo(days - 1);

    const [orderSeries, signupSeries] = await Promise.all([
      Order.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            orders: { $sum: 1 },
            revenue: {
              $sum: { $cond: [{ $in: ['$status', REVENUE_STATUSES] }, '$totalAmount', 0] },
            },
          },
        },
      ]),
      User.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            users:     { $sum: { $cond: [{ $eq: ['$role', 'customer'] }, 1, 0] } },
            merchants: { $sum: { $cond: [{ $eq: ['$role', 'merchant'] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const orderByDay  = new Map(orderSeries.map((d) => [d._id, d]));
    const signupByDay = new Map(signupSeries.map((d) => [d._id, d]));

    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = daysAgo(i);
      const key = d.toISOString().slice(0, 10);
      const o = orderByDay.get(key);
      const s = signupByDay.get(key);
      series.push({
        date: key,
        orders:    o ? o.orders : 0,
        revenue:   o ? Number(o.revenue.toFixed(3)) : 0,
        users:     s ? s.users : 0,
        merchants: s ? s.merchants : 0,
      });
    }

    res.json({ success: true, message: 'Chart data', data: { days, series } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/admin/dashboard/recent — the activity feed. */
router.get('/dashboard/recent', requirePermission('dashboard.read'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);

    const [orders, users, merchants, registrations] = await Promise.all([
      Order.find({})
        .sort({ createdAt: -1 }).limit(limit)
        .populate('userId', 'fullName email')
        .populate('merchantId', 'storeName fullName')
        .lean(),
      User.find({ role: 'customer' })
        .sort({ createdAt: -1 }).limit(limit)
        .select('fullName email phone createdAt isActive').lean(),
      User.find({ role: 'merchant' })
        .sort({ createdAt: -1 }).limit(limit)
        .select('storeName fullName email createdAt isActive').lean(),
      BusinessRegistration.find({ status: { $in: ['pending', 'under_review'] } })
        .sort({ createdAt: -1 }).limit(limit)
        .select('businessName ownerName status createdAt merchantId').lean(),
    ]);

    res.json({
      success: true,
      message: 'Recent activity',
      data: {
        orders: orders.map((o) => ({
          _id: o._id,
          orderNumber: o.orderNumber,
          totalAmount: o.totalAmount,
          status: o.status,
          createdAt: o.createdAt,
          customerName: o.userId ? o.userId.fullName : '',
          merchantName: o.merchantId ? (o.merchantId.storeName || o.merchantId.fullName) : '',
        })),
        users,
        merchants,
        pendingRegistrations: registrations,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/admin/users
 * ?search= &role= &status=active|banned &from= &to= &page= &limit=
 */
router.get('/users', requirePermission('users.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req.query);
    const filter = {};

    if (req.query.role) {
      filter.role = req.query.role;
    } else {
      // Default view is the customer base. Merchants have their own screen
      // with merchant-specific columns, and listing admins here by default
      // just adds noise to the number the operator is actually watching.
      filter.role = 'customer';
    }

    if (req.query.status === 'active') filter.isActive = true;
    if (req.query.status === 'banned') filter.isActive = false;

    if (req.query.search) {
      const rx = new RegExp(escapeRegex(req.query.search.trim()), 'i');
      filter.$or = [{ fullName: rx }, { email: rx }, { phone: rx }];
    }

    const range = dateRangeFilter(req.query);
    if (range) Object.assign(filter, range);

    const [items, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 }).skip(skip).limit(limit)
        .select('fullName email phone role isActive isVerified walletBalance walletPoints packageName profileImage createdAt lastLogin')
        .lean(),
      User.countDocuments(filter),
    ]);

    res.json({
      success: true,
      message: 'Users',
      data: { items, total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/admin/users/:id — profile plus the order/spend summary. */
router.get('/users/:id', requirePermission('users.read'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const [orderStats, recentOrders, transactions] = await Promise.all([
      Order.aggregate([
        { $match: { userId: user._id } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            spent: {
              $sum: { $cond: [{ $in: ['$status', REVENUE_STATUSES] }, '$totalAmount', 0] },
            },
            cancelled: {
              $sum: { $cond: [{ $in: ['$status', CANCELLED_STATUSES] }, 1, 0] },
            },
          },
        },
      ]),
      Order.find({ userId: user._id })
        .sort({ createdAt: -1 }).limit(10)
        .select('orderNumber totalAmount status createdAt orderType').lean(),
      Transaction.find({ userId: user._id })
        .sort({ createdAt: -1 }).limit(10).lean(),
    ]);

    const stats = orderStats[0] || { total: 0, spent: 0, cancelled: 0 };

    res.json({
      success: true,
      message: 'User details',
      data: {
        user: user.toJSON(),
        stats: {
          orders: stats.total,
          cancelledOrders: stats.cancelled,
          totalSpent: Number((stats.spent || 0).toFixed(3)),
        },
        recentOrders,
        recentTransactions: transactions,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PUT /api/admin/users/:id/ban  { banned: true|false }
 * Flips User.isActive, which /auth/login and /auth/social both refuse to
 * issue a token for — so this genuinely locks the account out rather than
 * only hiding it from admin lists.
 */
router.put('/users/:id/ban', requireAnyPermission('users.ban', 'users.unban'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (user.role === 'admin') {
      return res.status(403).json({ success: false, message: 'Admin accounts cannot be banned here.' });
    }

    // Accept an explicit flag; fall back to a toggle so the caller does not
    // have to read the current state first.
    const banned = typeof req.body.banned === 'boolean' ? req.body.banned : user.isActive;

    // The route accepts either grant; which one is actually needed depends on
    // the direction, so it is checked here rather than at the gate.
    const needed = banned ? 'users.ban' : 'users.unban';
    if (!hasPermission(req.admin, needed)) {
      return res.status(403).json({
        success: false,
        message: `Your role does not allow this (${needed} required).`,
      });
    }

    user.isActive = !banned;
    await user.save({ validateBeforeSave: false });

    res.json({
      success: true,
      message: banned ? 'User banned.' : 'User reinstated.',
      data: { user: user.toJSON() },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** PUT /api/admin/users/:id/role  { role } */
router.put('/users/:id/role', requirePermission('users.update'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const { role } = req.body;
    const allowed = ['customer', 'merchant', 'agent', 'admin'];
    if (!allowed.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Role must be one of: ${allowed.join(', ')}.`,
      });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    // Guard against the console locking itself out: the last remaining
    // admin must not be able to demote themselves.
    if (user.role === 'admin' && role !== 'admin') {
      const admins = await User.countDocuments({ role: 'admin' });
      if (admins <= 1) {
        return res.status(409).json({
          success: false,
          message: 'This is the only admin account — promote another admin first.',
        });
      }
    }

    user.role = role;
    await user.save({ validateBeforeSave: false });

    res.json({ success: true, message: 'Role updated.', data: { user: user.toJSON() } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * DELETE /api/admin/users/:id
 * Hard delete. Orders are intentionally left in place — they are financial
 * records, and removing them would silently rewrite past revenue figures.
 */
router.delete('/users/:id', requirePermission('users.delete'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (String(user._id) === String(req.user.id)) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
    }
    if (user.role === 'admin') {
      return res.status(403).json({ success: false, message: 'Admin accounts cannot be deleted here.' });
    }

    const orders = await Order.countDocuments({ userId: user._id });
    await user.deleteOne();

    res.json({
      success: true,
      message: 'User deleted.',
      data: { deletedId: req.params.id, ordersRetained: orders },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/admin/users — create a customer account from the console.
 *
 * For someone who walks in without the app. The password is random and never
 * shown: they take it over with the normal forgot-password flow, so nobody
 * ends up sharing a password over a counter.
 */
/**
 * PUT /api/admin/users/:id — edit a customer's own details.
 *
 * `users.update` is labelled "Edit a customer, including their role", but
 * until now only the role route used it: the console could ban, delete and
 * promote an account without being able to correct a typo in the name it
 * shows everywhere. Role changes stay on their own route, which enforces the
 * last-admin and self-demotion rules this one has no business repeating.
 */
router.put('/users/:id', requirePermission('users.update'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid user id.' });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (user.role === 'admin') {
      // Console operators are edited on the Staff screen, which also carries
      // the role and permission rules this route deliberately does not.
      return res.status(403).json({
        success: false,
        message: 'Console operators are edited from the Staff screen.',
      });
    }

    const changes = {};
    if (typeof req.body.fullName === 'string') {
      const name = req.body.fullName.trim();
      if (!name) {
        return res.status(400).json({ success: false, message: 'A name is required.' });
      }
      changes.fullName = name;
    }
    if (typeof req.body.city === 'string') changes.city = req.body.city.trim() || null;

    // Email and phone are the two sign-in identifiers, so a change to either
    // has to stay unique or the owner is locked out of their own account by
    // someone else's edit.
    if (typeof req.body.email === 'string') {
      const email = req.body.email.toLowerCase().trim();
      if (!email) {
        return res.status(400).json({ success: false, message: 'An email is required.' });
      }
      if (email !== user.email) {
        const taken = await User.findOne({ email, _id: { $ne: user._id } });
        if (taken) {
          return res.status(409).json({
            success: false,
            message: 'Another account already uses that email.',
          });
        }
        changes.email = email;
      }
    }
    if (typeof req.body.phone === 'string') {
      const phone = req.body.phone.trim();
      if (!phone) {
        return res.status(400).json({ success: false, message: 'A phone number is required.' });
      }
      if (phone !== user.phone) {
        const taken = await User.findOne({ phone, _id: { $ne: user._id } });
        if (taken) {
          return res.status(409).json({
            success: false,
            message: 'Another account already uses that phone number.',
          });
        }
        changes.phone = phone;
      }
    }

    if (!Object.keys(changes).length) {
      return res.status(400).json({ success: false, message: 'Nothing to change.' });
    }

    Object.assign(user, changes);
    await user.save();

    res.json({
      success: true,
      message: `${user.fullName} updated.`,
      data: { user: user.toJSON(), changed: Object.keys(changes) },
    });
  } catch (error) {
    const status = error.name === 'ValidationError' ? 400 : 500;
    res.status(status).json({ success: false, message: error.message });
  }
});

router.post('/users', requirePermission('users.create'), async (req, res) => {
  try {
    const { fullName, phone } = req.body;
    if (!String(fullName || '').trim() || !String(phone || '').trim()) {
      return res.status(400).json({ success: false, message: 'Name and phone are required.' });
    }

    const email = String(req.body.email || '').toLowerCase().trim() ||
      `walkin_${Date.now()}@customer.vips.local`;

    const existing = await User.findOne({
      $or: [{ email }, { phone: String(phone).trim() }],
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'An account with that email or phone already exists.',
      });
    }

    const user = await User.create({
      fullName: String(fullName).trim(),
      email,
      phone: String(phone).trim(),
      password: require('crypto').randomBytes(24).toString('hex'),
      role: 'customer',
      city: String(req.body.city || '').trim() || null,
    });

    res.status(201).json({
      success: true,
      message: `${user.fullName} added. They set a password via "forgot password".`,
      data: { user: user.toJSON() },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// MERCHANTS
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/admin/merchants
 * ?search= &status=active|inactive &approval=pending|under_review|approved|rejected|none
 * Each row carries its BusinessRegistration status so the list can show
 * "awaiting approval" without a second request per merchant.
 */
router.get('/merchants', requirePermission('merchants.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req.query);
    const filter = { role: 'merchant' };

    if (req.query.status === 'active') filter.isActive = true;
    if (req.query.status === 'inactive') filter.isActive = false;

    if (req.query.search) {
      const rx = new RegExp(escapeRegex(req.query.search.trim()), 'i');
      filter.$or = [{ storeName: rx }, { fullName: rx }, { email: rx }, { phone: rx }];
    }

    const range = dateRangeFilter(req.query);
    if (range) Object.assign(filter, range);

    // An approval filter is a filter on the registration document, so
    // resolve it to a merchant-id set first rather than trying to join.
    if (req.query.approval) {
      if (req.query.approval === 'none') {
        const registered = await BusinessRegistration.distinct('merchantId');
        filter._id = { $nin: registered };
      } else {
        const matching = await BusinessRegistration
          .find({ status: req.query.approval }).distinct('merchantId');
        filter._id = { $in: matching };
      }
    }

    const [merchants, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 }).skip(skip).limit(limit)
        .select('storeName fullName email phone storeCategory storeAddress logo isActive isTrending walletBalance packageName createdAt stats')
        .lean(),
      User.countDocuments(filter),
    ]);

    const ids = merchants.map((m) => m._id);
    const registrations = await BusinessRegistration.find({ merchantId: { $in: ids } })
      .select('merchantId status businessName').lean();
    const regByMerchant = new Map(registrations.map((r) => [String(r.merchantId), r]));

    const items = merchants.map((m) => {
      const reg = regByMerchant.get(String(m._id));
      return {
        ...m,
        approvalStatus: reg ? reg.status : 'none',
        businessName: reg ? reg.businessName : (m.storeName || ''),
        registrationId: reg ? reg._id : null,
      };
    });

    res.json({
      success: true,
      message: 'Merchants',
      data: { items, total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/admin/merchants/:id — profile, registration, sales summary. */
router.get('/merchants/:id', requirePermission('merchants.read'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const merchant = await User.findOne({ _id: req.params.id, role: 'merchant' });
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });

    const [registration, salesAgg, productCount, stockCount, recentOrders, ads] = await Promise.all([
      BusinessRegistration.findOne({ merchantId: merchant._id }).lean(),
      Order.aggregate([
        { $match: { merchantId: merchant._id } },
        {
          $group: {
            _id: null,
            orders: { $sum: 1 },
            revenue: {
              $sum: { $cond: [{ $in: ['$status', REVENUE_STATUSES] }, '$totalAmount', 0] },
            },
          },
        },
      ]),
      Product.countDocuments({ merchantId: merchant._id }),
      Stock.countDocuments({ merchantId: merchant._id }),
      Order.find({ merchantId: merchant._id })
        .sort({ createdAt: -1 }).limit(10)
        .select('orderNumber totalAmount status createdAt').lean(),
      MerchantAd.find({ merchantId: merchant._id })
        .sort({ createdAt: -1 }).limit(5)
        .select('title status budget spentAmount impressions clicks').lean(),
    ]);

    const sales = salesAgg[0] || { orders: 0, revenue: 0 };

    res.json({
      success: true,
      message: 'Merchant details',
      data: {
        merchant: merchant.toJSON(),
        registration: registration || null,
        approvalStatus: registration ? registration.status : 'none',
        stats: {
          orders: sales.orders,
          revenue: Number((sales.revenue || 0).toFixed(3)),
          products: productCount,
          stockItems: stockCount,
        },
        recentOrders,
        ads,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PUT /api/admin/merchants/:id/approve  { approved: true|false, reason }
 * Writes the BusinessRegistration decision. Approving also reactivates the
 * merchant account, since an approved merchant that still cannot log in
 * would make the button look like it did nothing.
 */
router.put('/merchants/:id/approve', requirePermission('merchants.approve'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const merchant = await User.findOne({ _id: req.params.id, role: 'merchant' });
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });

    const registration = await BusinessRegistration.findOne({ merchantId: merchant._id });
    if (!registration) {
      return res.status(404).json({
        success: false,
        message: 'This merchant has not submitted a business registration yet.',
      });
    }

    const approved = req.body.approved !== false;
    if (!approved && !String(req.body.reason || '').trim()) {
      return res.status(400).json({ success: false, message: 'A rejection reason is required.' });
    }

    registration.status = approved ? 'approved' : 'rejected';
    registration.reviewedAt = new Date();
    if (approved) {
      registration.approvedAt = new Date();
      registration.rejectionReason = '';
    } else {
      registration.rejectionReason = String(req.body.reason).trim();
    }
    await registration.save();

    if (approved && merchant.isActive === false) {
      merchant.isActive = true;
      await merchant.save({ validateBeforeSave: false });
    }

    res.json({
      success: true,
      message: approved ? 'Merchant approved.' : 'Merchant rejected.',
      data: { registration: registration.toJSON(), merchant: merchant.toJSON() },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** PUT /api/admin/merchants/:id/activate  { active: true|false } */
router.put('/merchants/:id/activate', requireAnyPermission('merchants.activate', 'merchants.deactivate'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const merchant = await User.findOne({ _id: req.params.id, role: 'merchant' });
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });

    const active = typeof req.body.active === 'boolean' ? req.body.active : !merchant.isActive;

    const needed = active ? 'merchants.activate' : 'merchants.deactivate';
    if (!hasPermission(req.admin, needed)) {
      return res.status(403).json({
        success: false,
        message: `Your role does not allow this (${needed} required).`,
      });
    }

    merchant.isActive = active;
    await merchant.save({ validateBeforeSave: false });

    // A deactivated merchant must also disappear from the storefront —
    // otherwise customers keep ordering from a shop that cannot serve them.
    await Product.updateMany({ merchantId: merchant._id }, { $set: { isActive: active } });

    res.json({
      success: true,
      message: active ? 'Merchant activated.' : 'Merchant deactivated.',
      data: { merchant: merchant.toJSON() },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * DELETE /api/admin/merchants/:id
 * Refuses while the merchant still has live orders — deleting then would
 * strand customers holding an order nobody owns.
 */
// ═══════════════════════════════════════════════════════════
// §5.1 / §5.2 — MERCHANT GUARANTEES
// ═══════════════════════════════════════════════════════════

// ─── GET /admin/merchants/:id/guarantee ───────────────────
router.get('/merchants/:id/guarantee', requirePermission('merchants.read'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;
    const merchant = await User.findOne({ _id: req.params.id, role: 'merchant' });
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });

    const GuaranteeLedger = require('../models/GuaranteeLedger');
    const ledger = await GuaranteeLedger.find({ merchantId: merchant._id })
      .sort({ createdAt: -1 }).limit(50).lean();

    res.json({
      success: true,
      data: {
        merchant: { id: String(merchant._id), name: merchant.storeName || merchant.fullName },
        ...guarantee.summarise(merchant),
        budgetLabels: BUDGET_LABELS,
        ledger,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /admin/merchants/:id/guarantee/deposit ──────────
/**
 * Records cash received from a merchant as an operating guarantee (§5.1).
 *
 * Admin-only on purpose: the deposit stands for money that actually arrived,
 * so a merchant cannot credit their own. It converts at 100 points = 1 TND
 * and lands unallocated for the merchant to split across their budgets.
 */
router.post('/merchants/:id/guarantee/deposit', requirePermission('merchants.update'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;
    const { amount, note } = req.body;
    const data = await guarantee.deposit(req.params.id, amount, {
      byId: req.user.id,
      note: note || 'Guarantee deposit recorded by an administrator',
    });
    res.status(201).json({ success: true, message: 'Guarantee recorded.', data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// ─── PUT /admin/merchants/:id/plan ────────────────────────
// §8: moving a merchant between plans is what changes their commission.
router.put('/merchants/:id/plan', requirePermission('merchants.update'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;
    const { plan, earnRate } = req.body;
    const merchant = await User.findOne({ _id: req.params.id, role: 'merchant' });
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });

    if (plan !== undefined) {
      if (!PLAN_KEYS.includes(plan)) {
        return res.status(400).json({
          success: false,
          message: `Plan must be one of: ${PLAN_KEYS.join(', ')}.`,
        });
      }
      merchant.merchantPlan = plan; // the pre-save hook resets commissionRate
    }
    if (earnRate !== undefined) {
      const rate = Number(earnRate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        return res.status(400).json({ success: false, message: 'The earn rate must be between 0 and 100 points per dinar.' });
      }
      merchant.earnRate = rate;
    }
    await merchant.save();

    // Keep the merchant app's subscription record in step with the plan the
    // console applies. Previously the User record changed commission while
    // /merchant/subscription/current still showed the old plan.
    if (plan) {
      const economicPlan = PLANS[plan];
      await MerchantSubscription.findOneAndUpdate(
        { merchantId: merchant._id },
        {
          planCode: plan,
          planName: economicPlan.label,
          price: economicPlan.monthlyFeeTnd,
          isActive: true,
        },
        { upsert: true, new: true, runValidators: true },
      );
    }

    res.json({
      success: true,
      message: 'Merchant plan updated.',
      data: {
        merchantPlan: merchant.merchantPlan,
        commissionRate: merchant.commissionRate,
        earnRate: merchant.earnRate,
        plans: PLANS,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /admin/guarantee-requests ────────────────────────
// Bank transfers merchants say they have sent, waiting to be confirmed.
router.get('/guarantee-requests', requirePermission('merchants.read'), async (req, res) => {
  try {
    const GuaranteeDepositRequest = require('../models/GuaranteeDepositRequest');
    const status = req.query.status || 'pending';
    const rows = await GuaranteeDepositRequest.find(
      status === 'all' ? {} : { status }
    )
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('merchantId', 'storeName fullName phone')
      .lean();

    res.json({
      success: true,
      data: {
        items: rows.map((r) => ({
          id: String(r._id),
          merchantId: r.merchantId ? String(r.merchantId._id) : null,
          merchantName: r.merchantId?.storeName || r.merchantId?.fullName || 'Deleted merchant',
          amountTnd: r.amountTnd,
          reference: r.reference,
          bankName: r.bankName,
          note: r.note,
          status: r.status,
          requestedAt: r.createdAt,
          reviewedAt: r.reviewedAt,
        })),
        pendingTotalTnd: rows
          .filter((r) => r.status === 'pending')
          .reduce((sum, r) => sum + r.amountTnd, 0),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /admin/guarantee-requests/:id ────────────────────
/**
 * Confirms or turns down a declared transfer.
 *
 * Confirming is what creates the points, and it runs through the same
 * deposit path as a directly recorded one so the ledger reads identically
 * either way. Guarded against being confirmed twice: a second confirmation
 * would mint a second guarantee against one transfer.
 */
router.put('/guarantee-requests/:id', requirePermission('merchants.update'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;
    const GuaranteeDepositRequest = require('../models/GuaranteeDepositRequest');
    const { action, note } = req.body;
    if (!['confirm', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'action must be confirm or reject.' });
    }

    const request = await GuaranteeDepositRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: 'Request not found.' });
    if (request.status !== 'pending') {
      return res.status(409).json({
        success: false,
        message: `This request was already ${request.status}.`,
      });
    }

    if (action === 'reject') {
      request.status = 'rejected';
      request.reviewedAt = new Date();
      request.reviewedBy = req.user.id;
      request.reviewNote = String(note || '').slice(0, 300);
      await request.save();
      return res.json({ success: true, message: 'Request turned down.', data: { status: request.status } });
    }

    // Claim it before crediting, so two administrators confirming at once
    // cannot both credit the same transfer.
    const claimed = await GuaranteeDepositRequest.findOneAndUpdate(
      { _id: request._id, status: 'pending' },
      {
        $set: {
          status: 'confirmed',
          reviewedAt: new Date(),
          reviewedBy: req.user.id,
          reviewNote: String(note || '').slice(0, 300),
        },
      },
      { new: true }
    );
    if (!claimed) {
      return res.status(409).json({ success: false, message: 'This request was just handled by someone else.' });
    }

    const data = await guarantee.deposit(request.merchantId, request.amountTnd, {
      byId: req.user.id,
      note: `Bank transfer confirmed${request.reference ? ` — ref ${request.reference}` : ''}`,
    });

    res.json({
      success: true,
      message: `${request.amountTnd} TND confirmed and converted to points.`,
      data: { status: 'confirmed', guarantee: data },
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// ─── GET /admin/guarantees ────────────────────────────────
// Platform-wide exposure: how much guarantee is held, and who is suspended.
router.get('/guarantees', requirePermission('merchants.read'), async (req, res) => {
  try {
    const merchants = await User.find({ role: 'merchant' })
      .select('storeName fullName guarantee merchantPlan earnRate')
      .lean();

    const rows = merchants.map((m) => {
      const g = m.guarantee || {};
      const b = g.budgets || {};
      const held = (g.unallocatedPoints || 0) + (b.discount || 0) + (b.packages || 0) + (b.general || 0);
      return {
        merchantId: String(m._id),
        name: m.storeName || m.fullName,
        plan: m.merchantPlan || 'basic',
        earnRate: m.earnRate ?? null,
        depositedTnd: g.depositedTnd || 0,
        refundedTnd: g.refundedTnd || 0,
        heldPoints: held,
        heldTnd: pointsToTnd(held),
        budgets: { discount: b.discount || 0, packages: b.packages || 0, general: b.general || 0 },
        suspended: Boolean(g.suspendedAt),
      };
    }).sort((a, b) => b.heldTnd - a.heldTnd);

    res.json({
      success: true,
      data: {
        items: rows,
        // What the platform is holding on merchants' behalf. It is not
        // revenue (§5.3) and is refundable in full, so it is reported apart
        // from anything the platform has earned.
        totalHeldTnd: Math.round(rows.reduce((s, r) => s + r.heldTnd, 0) * 1000) / 1000,
        totalDepositedTnd: Math.round(rows.reduce((s, r) => s + r.depositedTnd, 0) * 1000) / 1000,
        totalRefundedTnd: Math.round(rows.reduce((s, r) => s + r.refundedTnd, 0) * 1000) / 1000,
        merchantsWithoutGuarantee: rows.filter((r) => r.heldPoints === 0).length,
        suspendedMerchants: rows.filter((r) => r.suspended).length,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/merchants/:id', requirePermission('merchants.delete'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const merchant = await User.findOne({ _id: req.params.id, role: 'merchant' });
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });

    const liveStatuses = ['pending', 'confirmed', 'processing', 'ready', 'handover'];
    const live = await Order.countDocuments({ merchantId: merchant._id, status: { $in: liveStatuses } });
    if (live > 0) {
      return res.status(409).json({
        success: false,
        message: `This merchant has ${live} order(s) still in progress. Deactivate instead, or resolve them first.`,
      });
    }

    await Promise.all([
      Product.deleteMany({ merchantId: merchant._id }),
      Stock.deleteMany({ merchantId: merchant._id }),
      BusinessRegistration.deleteMany({ merchantId: merchant._id }),
    ]);
    await merchant.deleteOne();

    res.json({ success: true, message: 'Merchant deleted.', data: { deletedId: req.params.id } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/admin/orders
 * ?search= &status= &paymentStatus= &orderType= &userId= &merchantId=
 * &from= &to= &page= &limit=
 */
router.get('/orders', requirePermission('orders.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req.query);
    const filter = {};

    if (req.query.status) {
      // 'cancelled' has to match both spellings in the enum.
      filter.status = CANCELLED_STATUSES.includes(req.query.status)
        ? { $in: CANCELLED_STATUSES }
        : req.query.status;
    }
    if (req.query.paymentStatus) filter.paymentStatus = req.query.paymentStatus;
    if (req.query.orderType)     filter.orderType = req.query.orderType;
    if (req.query.userId && isValidId(req.query.userId)) filter.userId = req.query.userId;
    if (req.query.merchantId && isValidId(req.query.merchantId)) filter.merchantId = req.query.merchantId;

    const range = dateRangeFilter(req.query);
    if (range) Object.assign(filter, range);

    if (req.query.search) {
      const term = req.query.search.trim();
      const orderNumber = parseInt(term, 10);
      const rx = new RegExp(escapeRegex(term), 'i');
      const or = [{ 'deliveryAddress.contact_person_name': rx }, { 'items.item_name': rx }];
      if (!isNaN(orderNumber)) or.push({ orderNumber });
      if (isValidId(term)) or.push({ _id: term });
      filter.$or = or;
    }

    const [items, total, statusCounts] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate('userId', 'fullName email phone')
        .populate('merchantId', 'storeName fullName phone')
        .lean(),
      Order.countDocuments(filter),
      // Tab badges for the same filter set minus the status itself, so the
      // counts do not collapse to the tab the operator is already on.
      Order.aggregate([
        { $match: (() => { const f = { ...filter }; delete f.status; return f; })() },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      success: true,
      message: 'Orders',
      data: {
        items: items.map((o) => ({
          ...o,
          customerName: o.userId ? o.userId.fullName : '',
          customerPhone: o.userId ? o.userId.phone : '',
          merchantName: o.merchantId ? (o.merchantId.storeName || o.merchantId.fullName) : '',
        })),
        total, page, limit,
        pages: Math.ceil(total / limit),
        statusCounts: statusCounts.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {}),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/admin/orders/:id */
router.get('/orders/:id', requirePermission('orders.read'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const order = await Order.findById(req.params.id)
      .populate('userId', 'fullName email phone profileImage')
      .populate('merchantId', 'storeName fullName phone storeAddress logo')
      .lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

    res.json({ success: true, message: 'Order details', data: { order } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PUT /api/admin/orders/:id/status  { status, note }
 * Stamps the matching *At timestamp too, so the timeline the customer and
 * merchant apps both render stays consistent with an admin-side change.
 */
router.put('/orders/:id/status', requirePermission('orders.update'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const { status } = req.body;
    const allowed = Order.schema.path('status').enumValues;
    if (!allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${allowed.join(', ')}.`,
      });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

    order.$locals.statusBy = { id: req.user.id, role: 'admin', note: '' };
    order.status = status;

    const stamps = {
      pending: 'pendingAt',
      confirmed: 'confirmedAt',
      processing: 'processingAt',
      handover: 'handoverAt',
      picked_up: 'pickedUpAt',
      delivered: 'deliveredAt',
      canceled: 'canceledAt',
      cancelled: 'canceledAt',
      refund_requested: 'refundRequestedAt',
      refunded: 'refundedAt',
    };
    if (stamps[status]) order[stamps[status]] = new Date();
    if (req.body.note) order.orderNote = String(req.body.note);

    // Refunding from the console has to take back the loyalty points the
    // sale awarded, exactly as refunding from the Merchant app does. It did
    // not: this route only relabelled the status, so an order refunded here
    // returned the customer's money and left them holding every point it had
    // earned them. Same helper as the merchant path, so the two cannot drift.
    let refundedPoints = 0;
    if (status === 'refunded' && order.paymentStatus !== 'refunded') {
      const { reversePointsForOrder } = require('../utils/points');
      const reversal = await reversePointsForOrder(order);
      refundedPoints = reversal.points;
      order.paymentStatus = 'refunded';
    }

    await order.save();

    res.json({
      success: true,
      message: refundedPoints
        ? `Order refunded, and ${refundedPoints} point(s) taken back.`
        : 'Order status updated.',
      data: { order: order.toJSON(), refundedPoints },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * DELETE /api/admin/orders/:id — cancels rather than destroys.
 * Orders are financial records; wiping one would rewrite past revenue.
 */
router.delete('/orders/:id', requirePermission('orders.cancel'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

    if (CANCELLED_STATUSES.includes(order.status)) {
      return res.status(409).json({ success: false, message: 'This order is already cancelled.' });
    }
    if (REVENUE_STATUSES.includes(order.status)) {
      return res.status(409).json({
        success: false,
        message: 'A completed order cannot be cancelled — issue a refund instead.',
      });
    }

    // Accept the reason from either place: the app's shared ApiService.delete
    // sends no request body, so it passes ?reason= instead. Reading only
    // req.body here would silently drop every reason the console sends.
    const reason = String(req.body.reason || req.query.reason || 'Cancelled by administrator');

    order.$locals.statusBy = { id: req.user.id, role: 'admin', note: reason };
    order.status = 'cancelled';
    order.canceledAt = new Date();
    order.cancellationReason = reason;
    await order.save();

    res.json({ success: true, message: 'Order cancelled.', data: { order: order.toJSON() } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// INVENTORY
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/admin/inventory
 * Every merchant's stock in one list. ?search= &merchantId= &lowStock=true
 */
router.get('/inventory', requirePermission('inventory.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req.query);
    const filter = {};

    if (req.query.merchantId && isValidId(req.query.merchantId)) {
      filter.merchantId = req.query.merchantId;
    }
    if (req.query.location) filter.location = req.query.location;
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(req.query.search.trim()), 'i');
      filter.$or = [{ name: rx }, { category: rx }, { location: rx }];
    }
    if (req.query.lowStock === 'true') {
      filter.$expr = { $lte: ['$currentStock', '$lowStockThreshold'] };
    }

    const [items, total, valueAgg] = await Promise.all([
      Stock.find(filter)
        .sort({ updatedAt: -1 }).skip(skip).limit(limit)
        .populate('merchantId', 'storeName fullName').lean(),
      Stock.countDocuments(filter),
      Stock.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            value: { $sum: { $multiply: ['$currentStock', '$unitPrice'] } },
            units: { $sum: '$currentStock' },
          },
        },
      ]),
    ]);

    const totals = valueAgg[0] || { value: 0, units: 0 };

    res.json({
      success: true,
      message: 'Inventory',
      data: {
        items: items.map((i) => ({
          ...i,
          merchantName: i.merchantId ? (i.merchantId.storeName || i.merchantId.fullName) : '',
          isLowStock: i.currentStock <= i.lowStockThreshold,
        })),
        total, page, limit,
        pages: Math.ceil(total / limit),
        totalValue: Number((totals.value || 0).toFixed(3)),
        totalUnits: totals.units || 0,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** PUT /api/admin/inventory/:id  { currentStock, lowStockThreshold, unitPrice, category, name } */
router.put('/inventory/:id', requireAnyPermission('inventory.update', 'inventory.adjust'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const item = await Stock.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Stock item not found.' });

    const balanceBefore = item.currentStock;
    const numeric = ['currentStock', 'lowStockThreshold', 'unitPrice'];
    for (const key of numeric) {
      if (req.body[key] === undefined) continue;
      const value = Number(req.body[key]);
      if (isNaN(value) || value < 0) {
        return res.status(400).json({ success: false, message: `${key} must be a number of 0 or more.` });
      }
      item[key] = value;
    }
    if (typeof req.body.name === 'string' && req.body.name.trim()) item.name = req.body.name.trim();
    if (typeof req.body.category === 'string' && req.body.category.trim()) item.category = req.body.category.trim();
    if (typeof req.body.location === 'string' && req.body.location.trim()) {
      item.location = req.body.location.trim();
    }

    await item.save();

    // Same ledger the merchant routes write to, so the movement history is
    // one continuous record regardless of who made the change.
    if (item.currentStock !== balanceBefore) {
      await recordMovement({
        stock: item,
        type: movementTypeForDelta(balanceBefore, item.currentStock),
        quantity: Math.abs(item.currentStock - balanceBefore),
        balanceBefore,
        balanceAfter: item.currentStock,
        reason: String(req.body.reason || 'Adjusted from the admin console'),
        performedBy: req.user.id,
        performedByRole: 'admin',
      });
    }

    res.json({ success: true, message: 'Stock item updated.', data: { item: item.toJSON() } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/admin/inventory/movements
 * The stock ledger. ?merchantId= &stockId= &type= &search= &from= &to=
 */
router.get('/inventory/movements', requirePermission('inventory.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req.query);
    const filter = {};

    if (req.query.merchantId && isValidId(req.query.merchantId)) {
      filter.merchantId = req.query.merchantId;
    }
    if (req.query.stockId && isValidId(req.query.stockId)) {
      filter.stockId = req.query.stockId;
    }
    if (req.query.type) filter.type = req.query.type;
    if (req.query.location) filter.location = req.query.location;
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(req.query.search.trim()), 'i');
      filter.$or = [{ itemName: rx }, { reason: rx }, { category: rx }];
    }

    const range = dateRangeFilter(req.query);
    if (range) Object.assign(filter, range);

    // The same scope the list is under — search, merchant, stock line, dates —
    // but without the type constraint, so the chips keep their counts.
    const typeAgnosticFilter = { ...filter };
    delete typeAgnosticFilter.type;

    const [items, total, byType] = await Promise.all([
      StockMovement.find(filter)
        .sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate('merchantId', 'storeName fullName')
        .populate('performedBy', 'fullName role')
        .lean(),
      StockMovement.countDocuments(filter),
      // Counted over everything except the type filter itself. Including it
      // zeroed every other chip the moment one was picked — and zeroed the
      // "All" chip too, so the counts said the ledger was empty while the
      // list beneath them was showing rows. The chips exist to say what is
      // there, which they cannot do if choosing one erases the answer.
      StockMovement.aggregate([
        { $match: typeAgnosticFilter },
        { $group: { _id: '$type', count: { $sum: 1 }, units: { $sum: '$quantity' } } },
      ]),
    ]);

    res.json({
      success: true,
      message: 'Stock movements',
      data: {
        items: items.map((m) => ({
          ...m,
          merchantName: m.merchantId
            ? (m.merchantId.storeName || m.merchantId.fullName)
            : '',
          performedByName: m.performedBy ? m.performedBy.fullName : 'System',
        })),
        total, page, limit,
        pages: Math.ceil(total / limit),
        byType: byType.reduce(
          (acc, t) => ({ ...acc, [t._id]: { count: t.count, units: t.units } }), {}),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/admin/inventory/transfer
 * { fromStockId, quantity, toStockId | toLocation, reason }
 *
 * Moves units between two stock lines and writes both halves of the movement
 * under one reference. Either name an existing destination line (`toStockId`)
 * or a destination `toLocation`, in which case the sibling line for the same
 * item at that location is found or created.
 */
router.post('/inventory/transfer', requirePermission('inventory.transfer'), async (req, res) => {
  try {
    const { fromStockId, toStockId, toLocation, quantity } = req.body;

    if (!isValidId(fromStockId)) {
      return res.status(400).json({ success: false, message: 'A valid source stock id is required.' });
    }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ success: false, message: 'Quantity must be greater than 0.' });
    }

    const source = await Stock.findById(fromStockId);
    if (!source) {
      return res.status(404).json({ success: false, message: 'Source stock item not found.' });
    }
    // Refuse rather than let a transfer drive the source negative — the same
    // floor the merchant app enforces on its minus button.
    if (source.currentStock < qty) {
      return res.status(409).json({
        success: false,
        message: `Only ${source.currentStock} unit(s) of ${source.name} are on hand.`,
      });
    }

    let destination = null;
    if (toStockId) {
      if (!isValidId(toStockId)) {
        return res.status(400).json({ success: false, message: 'Invalid destination stock id.' });
      }
      destination = await Stock.findById(toStockId);
      if (!destination) {
        return res.status(404).json({ success: false, message: 'Destination stock item not found.' });
      }
    } else {
      const location = String(toLocation || '').trim();
      if (!location) {
        return res.status(400).json({
          success: false,
          message: 'Give either a destination stock id or a destination location.',
        });
      }
      if (location === source.location) {
        return res.status(400).json({
          success: false,
          message: 'The destination location is the same as the source.',
        });
      }
      destination = await Stock.findOne({
        merchantId: source.merchantId,
        name: source.name,
        location,
      });
      // Nothing there yet: open the line at zero so the transfer has somewhere
      // real to land, rather than failing on a location that simply has no
      // history for this item.
      if (!destination) {
        destination = await Stock.create({
          merchantId: source.merchantId,
          name: source.name,
          category: source.category,
          location,
          currentStock: 0,
          lowStockThreshold: source.lowStockThreshold,
          unitPrice: source.unitPrice,
        });
      }
    }

    if (String(destination._id) === String(source._id)) {
      return res.status(400).json({ success: false, message: 'Source and destination are the same line.' });
    }

    const reference = `TRF-${Date.now()}-${String(source._id).slice(-4)}`;
    const reason = String(req.body.reason || '').trim() || 'Stock transfer';

    const sourceBefore = source.currentStock;
    const destBefore = destination.currentStock;

    source.currentStock = sourceBefore - qty;
    destination.currentStock = destBefore + qty;
    await Promise.all([source.save(), destination.save()]);

    await Promise.all([
      recordMovement({
        stock: source, type: 'transfer_out', quantity: qty,
        balanceBefore: sourceBefore, balanceAfter: source.currentStock,
        reason, reference,
        performedBy: req.user.id, performedByRole: 'admin',
      }),
      recordMovement({
        stock: destination, type: 'transfer_in', quantity: qty,
        balanceBefore: destBefore, balanceAfter: destination.currentStock,
        reason, reference,
        performedBy: req.user.id, performedByRole: 'admin',
      }),
    ]);

    res.json({
      success: true,
      message: `Transferred ${qty} × ${source.name} to ${destination.location}.`,
      data: {
        reference,
        from: source.toJSON(),
        to: destination.toJSON(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/admin/inventory/locations — the warehouses actually in use. */
router.get('/inventory/locations', requirePermission('inventory.read'), async (req, res) => {
  try {
    const filter = {};
    if (req.query.merchantId && isValidId(req.query.merchantId)) {
      filter.merchantId = req.query.merchantId;
    }
    // Derived from the data rather than a hardcoded list, so a location chip
    // can never point at a warehouse that holds nothing.
    const locations = await Stock.aggregate([
      { $match: filter },
      {
        $group: {
          _id: { $ifNull: ['$location', 'Main'] },
          lines: { $sum: 1 },
          units: { $sum: '$currentStock' },
          value: { $sum: { $multiply: ['$currentStock', '$unitPrice'] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      success: true,
      message: 'Stock locations',
      data: {
        items: locations.map((l) => ({
          location: l._id,
          lines: l.lines,
          units: l.units,
          value: Number(l.value.toFixed(3)),
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** POST /api/admin/inventory — open a stock line for a merchant. */
router.post('/inventory', requirePermission('inventory.create'), async (req, res) => {
  try {
    const { merchantId, name } = req.body;
    if (!isValidId(merchantId)) {
      return res.status(400).json({ success: false, message: 'A valid merchant id is required.' });
    }
    if (!String(name || '').trim()) {
      return res.status(400).json({ success: false, message: 'An item name is required.' });
    }

    const merchant = await User.findOne({ _id: merchantId, role: 'merchant' });
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found.' });
    }

    const numbers = {};
    for (const key of ['currentStock', 'lowStockThreshold', 'unitPrice']) {
      if (req.body[key] === undefined) continue;
      const value = Number(req.body[key]);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({
          success: false,
          message: `${key} must be a number of 0 or more.`,
        });
      }
      numbers[key] = value;
    }

    const item = await Stock.create({
      merchantId,
      name: String(name).trim(),
      category: String(req.body.category || 'General').trim(),
      location: String(req.body.location || 'Main').trim(),
      ...numbers,
    });

    // Same ledger the merchant routes write to, so a line opened here has an
    // opening balance in the history like any other.
    await recordMovement({
      stock: item,
      type: 'initial',
      quantity: item.currentStock,
      balanceBefore: 0,
      balanceAfter: item.currentStock,
      reason: 'Stock line opened from the admin console',
      performedBy: req.user.id,
      performedByRole: 'admin',
    });

    res.status(201).json({
      success: true,
      message: `${item.name} added to ${merchant.storeName || merchant.fullName}.`,
      data: { item: item.toJSON() },
    });
  } catch (error) {
    const status = error.name === 'ValidationError' ? 400 : 500;
    res.status(status).json({ success: false, message: error.message });
  }
});

/** DELETE /api/admin/inventory/:id */
router.delete('/inventory/:id', requirePermission('inventory.delete'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const item = await Stock.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Stock item not found.' });

    await recordMovement({
      stock: item,
      type: 'removed',
      quantity: item.currentStock,
      balanceBefore: item.currentStock,
      balanceAfter: 0,
      reason: String(req.body.reason || 'Removed from the admin console'),
      performedBy: req.user.id,
      performedByRole: 'admin',
    });
    // The ledger row is written before the delete so the history keeps the
    // item name and its closing balance after the line itself is gone.
    await item.deleteOne();

    res.json({ success: true, message: 'Stock line removed.', data: { deletedId: req.params.id } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/admin/inventory/alerts — everything at or below its threshold. */
router.get('/inventory/alerts', requirePermission('inventory.read'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    const [stockAlerts, productAlerts] = await Promise.all([
      Stock.find({ $expr: { $lte: ['$currentStock', '$lowStockThreshold'] } })
        .sort({ currentStock: 1 }).limit(limit)
        .populate('merchantId', 'storeName fullName').lean(),
      // Products carry their own alert quantity, and a product at zero is
      // just as much a stockout as a Stock line — a low-stock screen that
      // only reads one of the two collections misses half the problem.
      Product.find({
        $and: [
          { $expr: { $lte: ['$stock', '$alertQty'] } },
          { isActive: true },
        ],
      })
        .sort({ stock: 1 }).limit(limit)
        .populate('merchantId', 'storeName fullName').lean(),
    ]);

    res.json({
      success: true,
      message: 'Low-stock alerts',
      data: {
        stock: stockAlerts.map((i) => ({
          _id: i._id,
          name: i.name,
          category: i.category,
          currentStock: i.currentStock,
          lowStockThreshold: i.lowStockThreshold,
          unitPrice: i.unitPrice,
          merchantName: i.merchantId ? (i.merchantId.storeName || i.merchantId.fullName) : '',
        })),
        products: productAlerts.map((p) => ({
          _id: p._id,
          name: p.name,
          category: p.category,
          stock: p.stock,
          alertQty: p.alertQty,
          price: p.price,
          merchantName: p.merchantId ? (p.merchantId.storeName || p.merchantId.fullName) : '',
        })),
        total: stockAlerts.length + productAlerts.length,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════
// Their own file: seven reports plus CSV export outgrew this one, and they
// share a set of revenue/date helpers now lifted into utils/adminHelpers.js
// so both files answer "what counts as revenue" the same way.
router.use('/reports', require('./admin_reports'));

// ═══════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/admin/analytics/overview?days=30
 *
 * Visitors, and the conversion rate they finally give a denominator to.
 *
 * A "visitor" is a distinct session, not a screen view — one person opening
 * the app and looking at nine screens is one visitor, and counting rows
 * instead would report nine.
 */
router.get('/analytics/overview', requirePermission('analytics.read'), async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const since = daysAgo(days - 1);
    const startOfToday = daysAgo(0);
    const startOfWeek = daysAgo(6);

    const distinctSessions = (match) => VisitEvent.distinct('sessionId', match);

    const [
      allSessions, todaySessions, weekSessions, windowSessions,
      screens, byApp, byPlatform, dailySeries,
      signedInSessions, totalEvents,
      ordersInWindow, buyersInWindow,
      customers, newCustomers,
      merchants, activeMerchants, pendingMerchants,
    ] = await Promise.all([
      distinctSessions({}),
      distinctSessions({ createdAt: { $gte: startOfToday } }),
      distinctSessions({ createdAt: { $gte: startOfWeek } }),
      distinctSessions({ createdAt: { $gte: since } }),

      VisitEvent.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$screen', views: { $sum: 1 }, sessions: { $addToSet: '$sessionId' } } },
        { $project: { screen: '$_id', views: 1, sessions: { $size: '$sessions' } } },
        { $sort: { views: -1 } },
        { $limit: 15 },
      ]),
      VisitEvent.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$app', sessions: { $addToSet: '$sessionId' } } },
        { $project: { app: '$_id', sessions: { $size: '$sessions' } } },
        { $sort: { sessions: -1 } },
      ]),
      VisitEvent.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$platform', sessions: { $addToSet: '$sessionId' } } },
        { $project: { platform: '$_id', sessions: { $size: '$sessions' } } },
        { $sort: { sessions: -1 } },
      ]),
      VisitEvent.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            sessions: { $addToSet: '$sessionId' },
          },
        },
        { $project: { date: '$_id', value: { $size: '$sessions' } } },
        { $sort: { date: 1 } },
      ]),
      distinctSessions({ createdAt: { $gte: since }, userId: { $ne: null } }),
      VisitEvent.countDocuments({ createdAt: { $gte: since } }),

      Order.countDocuments({ createdAt: { $gte: since } }),
      Order.distinct('userId', { createdAt: { $gte: since } }),

      User.countDocuments({ role: 'customer' }),
      User.countDocuments({ role: 'customer', createdAt: { $gte: since } }),

      User.countDocuments({ role: 'merchant' }),
      User.countDocuments({ role: 'merchant', isActive: true }),
      BusinessRegistration.countDocuments({ status: { $in: ['pending', 'under_review'] } }),
    ]);

    const visitors = windowSessions.length;
    // Null, not zero, until something has been tracked: a conversion rate of
    // 0% claims nobody who visited bought, which is a different statement
    // from "nobody has visited yet".
    const tracking = allSessions.length > 0;

    // Tracking was added after these orders existed, so for a while the window
    // holds more orders than sessions and the ratio comes out above 100%.
    // That is arithmetically right and completely meaningless, so it is
    // withheld and the reason is given instead of printing "1520%".
    const firstEvent = tracking
      ? await VisitEvent.findOne({}).sort({ createdAt: 1 }).select('createdAt').lean()
      : null;
    const trackingStartedAt = firstEvent ? firstEvent.createdAt : null;
    const coversWholeWindow = trackingStartedAt
      ? new Date(trackingStartedAt) <= since
      : false;
    const conversionMeasurable = tracking && coversWholeWindow && visitors > 0;

    // Zero-filled so a quiet day is a gap in the line rather than a missing
    // point the chart joins straight over.
    const byDay = new Map(dailySeries.map((d) => [d.date, d.value]));
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const key = daysAgo(i).toISOString().slice(0, 10);
      series.push({ date: key, value: byDay.get(key) || 0 });
    }

    res.json({
      success: true,
      message: 'Analytics overview',
      data: {
        days,
        tracking,
        // What the figures cannot say, said once rather than implied by a zero.
        trackingNote: tracking
          ? 'A visitor is one app session. Sessions are anonymous — no device '
            + 'id, no IP address, and a screen name never carries a record id.'
          : 'Nothing has been recorded yet. The apps report an anonymous '
            + 'session when they open; figures appear once they do.',

        visitors: {
          total: allSessions.length,
          today: todaySessions.length,
          thisWeek: weekSessions.length,
          inWindow: visitors,
          screenViews: totalEvents,
          // Sessions where somebody was signed in, which is the honest way to
          // say how much of the traffic is from people with an account.
          signedIn: signedInSessions.length,
        },

        conversion: {
          // Orders over sessions, at last measurable — but only once tracking
          // covers the whole window it is being measured over.
          rate: conversionMeasurable ? round((ordersInWindow / visitors) * 100) : null,
          orders: ordersInWindow,
          visitors,
          buyers: buyersInWindow.length,
          buyerRate: conversionMeasurable
            ? round((buyersInWindow.length / visitors) * 100)
            : null,
          measurable: conversionMeasurable,
          trackingStartedAt,
          reason: conversionMeasurable
            ? ''
            : !tracking
              ? 'Nothing has been tracked yet.'
              : 'Tracking started inside this window, so it counted only part '
                + 'of the visits these orders came from. The rate becomes '
                + 'meaningful once the window starts after tracking did.',
        },

        customers: {
          total: customers,
          newInWindow: newCustomers,
          buyersInWindow: buyersInWindow.length,
        },

        merchants: {
          total: merchants,
          active: activeMerchants,
          pendingApproval: pendingMerchants,
        },

        visitorsByDay: series,
        topScreens: screens.map((s) => ({
          screen: s.screen || 'unknown',
          views: s.views,
          sessions: s.sessions,
        })),
        byApp: byApp.map((a) => ({ app: a.app || 'unknown', sessions: a.sessions })),
        byPlatform: byPlatform.map((p) => ({
          platform: p.platform || 'unknown',
          sessions: p.sessions,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/admin/audit/logs
 * ?search= &actorId= &targetType= &outcome=success|denied &from= &to=
 *
 * Gated on settings.read rather than a permission of its own: the log names
 * every operator and what they touched, so whoever can already see the admin
 * roster is the right audience for it.
 */
router.get('/audit/logs', requirePermission('settings.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req.query);
    const filter = {};

    if (req.query.actorId && isValidId(req.query.actorId)) {
      filter.actorId = req.query.actorId;
    }
    if (req.query.targetType) filter.targetType = req.query.targetType;
    // A refused attempt is the line an audit log exists for, so it is
    // directly filterable rather than buried among the successes.
    if (req.query.outcome === 'success') filter.success = true;
    if (req.query.outcome === 'denied') filter.success = false;

    const range = dateRangeFilter(req.query);
    if (range) Object.assign(filter, range);

    if (req.query.search) {
      const rx = new RegExp(escapeRegex(req.query.search.trim()), 'i');
      filter.$or = [
        { action: rx }, { actorName: rx }, { actorEmail: rx },
        { path: rx }, { targetId: rx },
      ];
    }

    const [items, total, actors] = await Promise.all([
      AdminAuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AdminAuditLog.countDocuments(filter),
      // Who appears in the log at all, so the filter cannot offer an operator
      // with nothing to show.
      AdminAuditLog.aggregate([
        { $group: { _id: '$actorId', name: { $last: '$actorName' }, entries: { $sum: 1 } } },
        { $sort: { entries: -1 } },
        { $limit: 50 },
      ]),
    ]);

    res.json({
      success: true,
      message: 'Audit log',
      data: {
        items,
        total, page, limit,
        pages: Math.ceil(total / limit),
        actors: actors
          .filter((a) => a._id)
          .map((a) => ({ actorId: String(a._id), name: a.name || 'Unknown', entries: a.entries })),
        targetTypes: ['user', 'merchant', 'order', 'product', 'stock', 'pos', 'staff', 'role'],
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/admin/audit/logs/:id — one entry, with what was sent. */
router.get('/audit/logs/:id', requirePermission('settings.read'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;
    const entry = await AdminAuditLog.findById(req.params.id).lean();
    if (!entry) {
      return res.status(404).json({ success: false, message: 'Audit entry not found.' });
    }
    res.json({ success: true, message: 'Audit entry', data: { entry } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ANALYTICAL DASHBOARDS
// ═══════════════════════════════════════════════════════════
// Five read models over the same collections the reports read, sharing their
// revenue rules from utils/adminHelpers so a dashboard can never disagree
// with the report behind it. Each dashboard carries its own permission gate:
// the operations board is shift-level and sits behind dashboard.read, the
// four that aggregate platform money and customers need reports.read.
router.use('/dashboards', require('./admin_dashboards'));

// ═══════════════════════════════════════════════════════════
// TOP-BAR: NOTIFICATIONS AND GLOBAL SEARCH
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/admin/notifications
 *
 * The console's notification bell. Every item is a real backlog the operator
 * can act on right now, counted live — not a stored feed. That keeps the bell
 * from ever showing a stale or invented number: if the count is 3, there are
 * genuinely 3 things waiting.
 */
router.get('/notifications', requirePermission('dashboard.read'), async (req, res) => {
  try {
    const [
      pendingApprovals, pendingOrders, refundRequests,
      lowStock, lowProducts, pendingPayouts, bannedUsers,
    ] = await Promise.all([
      BusinessRegistration.countDocuments({ status: { $in: ['pending', 'under_review'] } }),
      Order.countDocuments({ status: 'pending' }),
      Order.countDocuments({ status: 'refund_requested' }),
      Stock.countDocuments({ $expr: { $lte: ['$currentStock', '$lowStockThreshold'] } }),
      Product.countDocuments({
        $and: [{ $expr: { $lte: ['$stock', '$alertQty'] } }, { isActive: true }],
      }),
      Payout.countDocuments({ status: 'pending' }),
      User.countDocuments({ role: { $ne: 'admin' }, isActive: false }),
    ]);

    // `route` and `args` tell the client exactly where to send the operator,
    // so a notification can never be a dead end.
    const items = [
      {
        key: 'merchant_approvals',
        title: 'Merchants awaiting approval',
        count: pendingApprovals,
        severity: 'warning',
        route: '/merchants',
        args: { approval: 'pending' },
      },
      {
        key: 'refund_requests',
        title: 'Refund requests to review',
        count: refundRequests,
        severity: 'danger',
        route: '/orders',
        args: { status: 'refund_requested' },
      },
      {
        key: 'low_stock',
        title: 'Items at or below their stock threshold',
        count: lowStock + lowProducts,
        severity: 'danger',
        route: '/inventory',
        args: { lowStock: true },
      },
      {
        key: 'pending_orders',
        title: 'Orders still pending',
        count: pendingOrders,
        severity: 'info',
        route: '/orders',
        args: { status: 'pending' },
      },
      {
        key: 'pending_payouts',
        title: 'Merchant payout requests pending',
        count: pendingPayouts,
        severity: 'info',
        // Was a dead end until the finance dashboard gave payouts a screen.
        route: '/dashboards/finance',
        args: {},
      },
      {
        key: 'banned_users',
        title: 'Suspended accounts',
        count: bannedUsers,
        severity: 'muted',
        route: '/users',
        args: { status: 'banned' },
      },
    ].filter((item) => item.count > 0);

    res.json({
      success: true,
      message: 'Admin notifications',
      data: {
        items,
        // The badge counts distinct things needing attention, not the sum of
        // every pending row — 400 pending orders is one thing to look at.
        total: items.length,
        urgent: items.filter((i) => i.severity === 'danger' || i.severity === 'warning').length,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/admin/search?q=&limit=
 *
 * One search box across users, merchants and orders, so the operator does not
 * have to guess which section a name or order number lives in.
 */
router.get('/search', requirePermission('dashboard.read'), async (req, res) => {
  try {
    const term = String(req.query.q || '').trim();
    if (term.length < 2) {
      return res.json({
        success: true,
        message: 'Search',
        data: { query: term, users: [], merchants: [], orders: [], total: 0 },
      });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);
    const rx = new RegExp(escapeRegex(term), 'i');
    const orderNumber = parseInt(term, 10);

    const orderOr = [{ 'items.item_name': rx }, { 'deliveryAddress.contact_person_name': rx }];
    if (!isNaN(orderNumber)) orderOr.push({ orderNumber });
    if (isValidId(term)) orderOr.push({ _id: term });

    const [users, merchants, orders] = await Promise.all([
      User.find({
        role: { $in: ['customer', 'agent'] },
        $or: [{ fullName: rx }, { email: rx }, { phone: rx }],
      })
        .limit(limit)
        .select('fullName email phone role isActive')
        .lean(),
      User.find({
        role: 'merchant',
        $or: [{ storeName: rx }, { fullName: rx }, { email: rx }, { phone: rx }],
      })
        .limit(limit)
        .select('storeName fullName email phone isActive storeCategory')
        .lean(),
      Order.find({ $or: orderOr })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate('userId', 'fullName')
        .select('orderNumber totalAmount status createdAt userId')
        .lean(),
    ]);

    res.json({
      success: true,
      message: 'Search',
      data: {
        query: term,
        users,
        merchants,
        orders: orders.map((o) => ({
          _id: o._id,
          orderNumber: o.orderNumber,
          totalAmount: o.totalAmount,
          status: o.status,
          createdAt: o.createdAt,
          customerName: o.userId ? o.userId.fullName : '',
        })),
        total: users.length + merchants.length + orders.length,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// POINT OF SALE
// ═══════════════════════════════════════════════════════════
// Its own file — the till has enough surface (sessions, cart, invoices,
// customers) that folding it in here would bury the rest. Mounted inside
// this router so it inherits the admin gate above rather than re-declaring it.
router.use('/pos', requirePermission('pos.read'), require('./admin_pos'));
router.use('/products', require('./admin_products'));
router.use('/offers', require('./admin_offers'));
router.use('/subscriptions', require('./admin_subscriptions'));
router.use('/wallets', require('./admin_wallets'));
router.use('/ads', require('./admin_ads'));
router.use('/broadcasts', require('./admin_broadcasts'));

// ═══════════════════════════════════════════════════════════
// PLATFORM SETTINGS
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/admin/settings
 * Reports what is actually live in this process rather than what someone
 * hopes is configured — the same signal /api/health exposes, plus the admin
 * roster, so the Settings screen never has to claim a state it cannot see.
 */
router.get('/settings', requirePermission('settings.read'), async (req, res) => {
  try {
    // Capped, unlike the rest of this payload, which is a handful of
    // booleans: the roster grows without limit and this endpoint has no
    // paging, so an installation with hundreds of operators would ship the
    // whole list on every visit to the Settings screen. `adminCount` is the
    // real total, and the full list lives on the paginated Staff screen.
    const ROSTER_LIMIT = 50;
    const [admins, adminCount] = await Promise.all([
      User.find({ role: 'admin' })
        .sort({ createdAt: 1 })
        .limit(ROSTER_LIMIT)
        .select('fullName email phone isActive createdAt lastLogin').lean(),
      User.countDocuments({ role: 'admin' }),
    ]);

    res.json({
      success: true,
      message: 'Platform settings',
      data: {
        admins,
        adminCount,
        // Said explicitly so the screen can show "50 of 89" rather than
        // letting a truncated list read as the whole roster.
        adminsTruncated: adminCount > admins.length,
        integrations: {
          firebaseAdmin: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT),
          sendgrid:      Boolean(process.env.SENDGRID_API_KEY),
          paymee:        Boolean(process.env.PAYMEE_API_KEY),
          paypal:        Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
        },
        environment: {
          nodeEnv: process.env.NODE_ENV || 'development',
          backendUrl: process.env.BACKEND_URL || '',
          database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/admin/settings/admins  { fullName, email, phone, password }
 * The only way to mint another admin from inside the app. Creating the
 * *first* one is deliberately not possible over HTTP — see
 * scripts/create-admin.js.
 */
router.post('/settings/admins', requirePermission('staff.create'), async (req, res) => {
  try {
    const { fullName, email, phone, password } = req.body;
    if (!fullName || !email || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'Full name, email, phone and password are all required.',
      });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    const normalisedEmail = String(email).toLowerCase().trim();
    const existing = await User.findOne({ $or: [{ email: normalisedEmail }, { phone }] });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'An account with that email or phone already exists.',
      });
    }

    const admin = await User.create({
      fullName: String(fullName).trim(),
      email: normalisedEmail,
      phone: String(phone).trim(),
      password,
      role: 'admin',
      isVerified: true,
    });

    res.status(201).json({ success: true, message: 'Admin created.', data: { user: admin.toJSON() } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** DELETE /api/admin/settings/admins/:id — never the last one, never yourself. */
router.delete('/settings/admins/:id', requirePermission('staff.delete'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    if (String(req.params.id) === String(req.user.id)) {
      return res.status(400).json({ success: false, message: 'You cannot remove your own admin account.' });
    }

    const admin = await User.findOne({ _id: req.params.id, role: 'admin' });
    if (!admin) return res.status(404).json({ success: false, message: 'Admin not found.' });

    const count = await User.countDocuments({ role: 'admin' });
    if (count <= 1) {
      return res.status(409).json({ success: false, message: 'The last admin account cannot be removed.' });
    }

    await admin.deleteOne();
    res.json({ success: true, message: 'Admin removed.', data: { deletedId: req.params.id } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/admin/config — the business model's own numbers.
 *
 * The console needs the plan list to offer a plan, the budget keys to label a
 * guarantee, and the Giftback and refund rules to explain a decision. Reading
 * them from config/economics.js means the screens restate the documents
 * rather than keeping a second, drifting copy of them in the browser — the
 * same reason those literals were pulled out of the routes in the first
 * place. Nothing here is per-account, so any signed-in operator may read it.
 */
router.get('/config', (req, res) => {
  const {
    POINTS_PER_TND, DEFAULT_EARN_RATE, MAX_EARN_RATE,
    DIAMONDS_PER_TND, GIFTBACK, BUDGETS, REFUND, EDIT_COOLDOWN, PLANS,
  } = require('../config/economics');

  res.json({
    success: true,
    message: 'Platform economics',
    data: {
      pointsPerTnd: POINTS_PER_TND,
      diamondsPerTnd: DIAMONDS_PER_TND,
      earnRate: { default: DEFAULT_EARN_RATE, max: MAX_EARN_RATE },
      budgets: BUDGETS.map((key) => ({ key, label: BUDGET_LABELS[key] })),
      giftback: GIFTBACK,
      refund: REFUND,
      editCooldown: EDIT_COOLDOWN,
      plans: PLAN_KEYS.map((key) => PLANS[key]),
    },
  });
});

// ═══════════════════════════════════════════════════════════
// STAFF AND ROLES
// ═══════════════════════════════════════════════════════════
// "Staff" here means console operators — admin accounts with a role. The
// separate `Staff` model is a merchant's own employees (name, salary, leave)
// and is a different thing entirely, reached through /api/merchant/staff.

/** GET /api/admin/permissions — the catalogue, so the UI is never out of step. */
router.get('/permissions', requirePermission('staff.read'), async (req, res) => {
  try {
    const custom = await Role.find({ isActive: true }).select('name description permissions').lean();
    res.json({
      success: true,
      message: 'Permission catalogue',
      data: {
        permissions: ALL_PERMISSIONS,
        // The descriptive form: what each permission means, and whether it
        // actually gates a route yet. A permission that gates nothing is
        // said so rather than shown as a checkbox that quietly does nothing.
        catalogue: PERMISSION_CATALOGUE,
        modules: Object.entries(MODULE_ACTIONS).map(([name, actions]) => ({
          name,
          actions: Object.keys(actions),
        })),
        builtInRoles: ROLES.map((name) => ({
          name,
          permissions: ROLE_PERMISSIONS[name],
          isBuiltIn: true,
        })),
        customRoles: custom,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/admin/staff — console operators. */
router.get('/staff', requirePermission('staff.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req.query);
    const filter = { role: 'admin' };
    if (req.query.adminRole) filter.adminRole = req.query.adminRole;
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(req.query.search.trim()), 'i');
      filter.$or = [{ fullName: rx }, { email: rx }, { phone: rx }];
    }

    const [items, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: 1 }).skip(skip).limit(limit)
        .select('fullName email phone adminRole permissions isActive createdAt lastLogin')
        .lean(),
      User.countDocuments(filter),
    ]);

    // How many records each operator's name is on. The delete control is
    // disabled with a reason when this is above zero, rather than being live
    // and then answering 409 — the server refuses either way, and a button
    // that only ever errors is worse than one that says why it is off.
    // Counted for the page's rows only, in four grouped passes rather than
    // four queries per row.
    const ids = items.map((a) => a._id);
    const tally = new Map(ids.map((id) => [String(id), 0]));
    const absorb = (rows) => {
      for (const row of rows) {
        const key = String(row._id);
        if (tally.has(key)) tally.set(key, tally.get(key) + row.count);
      }
    };
    const countBy = (Model, field) =>
      Model.aggregate([
        { $match: { [field]: { $in: ids } } },
        { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      ]);
    (await Promise.all([
      countBy(PosInvoice, 'cashierId'),
      countBy(PosInvoice, 'refundedBy'),
      countBy(PosSession, 'cashierId'),
      countBy(StockMovement, 'performedBy'),
    ])).forEach(absorb);

    res.json({
      success: true,
      message: 'Console staff',
      data: {
        items: items.map((a) => ({
          ...a,
          effectivePermissions: permissionsFor(a),
          signedRecords: tally.get(String(a._id)) || 0,
        })),
        total, page, limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/admin/staff/:id — one console operator.
 *
 * Registered after GET /staff so the literal path is matched first; a bare
 * `:id` here would otherwise swallow it.
 */
router.get('/staff/:id', requirePermission('staff.read'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const staff = await User.findOne({ _id: req.params.id, role: 'admin' })
      .select('fullName email phone adminRole permissions isActive isVerified createdAt lastLogin')
      .lean();
    if (!staff) return res.status(404).json({ success: false, message: 'Admin not found.' });

    res.json({
      success: true,
      message: 'Console operator',
      data: {
        staff,
        // What the role grants plus any extras, so the detail screen shows
        // what this person can actually do rather than only the extras.
        effectivePermissions: permissionsFor(staff),
        rolePermissions: ROLE_PERMISSIONS[staff.adminRole] || [],
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** POST /api/admin/staff — create a console operator. */
router.post('/staff', requirePermission('staff.create'), async (req, res) => {
  try {
    const { fullName, email, phone, password, adminRole } = req.body;
    if (!fullName || !email || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'Full name, email, phone and password are all required.',
      });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    const roleToSet = adminRole || 'viewer';
    if (!ROLE_PERMISSIONS[roleToSet]) {
      return res.status(400).json({
        success: false,
        message: `Role must be one of: ${Object.keys(ROLE_PERMISSIONS).join(', ')}.`,
      });
    }
    // Only a super admin may mint another super admin, or nothing stops an
    // ordinary admin promoting themselves past their own ceiling.
    if (roleToSet === 'super_admin' && req.admin.adminRole !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Only a super admin can create another super admin.',
      });
    }

    const normalisedEmail = String(email).toLowerCase().trim();
    const existing = await User.findOne({ $or: [{ email: normalisedEmail }, { phone }] });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'An account with that email or phone already exists.',
      });
    }

    const staff = await User.create({
      fullName: String(fullName).trim(),
      email: normalisedEmail,
      phone: String(phone).trim(),
      password,
      role: 'admin',
      adminRole: roleToSet,
      permissions: Array.isArray(req.body.permissions) ? req.body.permissions : [],
      isVerified: true,
    });

    res.status(201).json({
      success: true,
      message: `${staff.fullName} added as ${roleToSet.replace('_', ' ')}.`,
      data: { staff: staff.toJSON() },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** PUT /api/admin/staff/:id — change a console operator's role or details. */
router.put('/staff/:id', requirePermission('staff.update'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const staff = await User.findOne({ _id: req.params.id, role: 'admin' });
    if (!staff) return res.status(404).json({ success: false, message: 'Admin not found.' });

    if (req.body.adminRole !== undefined) {
      if (!hasPermission(req.admin, 'staff.assign_role')) {
        return res.status(403).json({
          success: false,
          message: 'Your role does not allow this (staff.assign_role required).',
        });
      }
      if (!ROLE_PERMISSIONS[req.body.adminRole]) {
        return res.status(400).json({
          success: false,
          message: `Role must be one of: ${Object.keys(ROLE_PERMISSIONS).join(', ')}.`,
        });
      }
      if (req.body.adminRole === 'super_admin' && req.admin.adminRole !== 'super_admin') {
        return res.status(403).json({
          success: false,
          message: 'Only a super admin can grant super admin.',
        });
      }
      // Demoting the last super admin would leave nobody able to grant the
      // role back — the same lockout the last-admin guard prevents.
      if (staff.adminRole === 'super_admin' && req.body.adminRole !== 'super_admin') {
        const supers = await User.countDocuments({ role: 'admin', adminRole: 'super_admin' });
        if (supers <= 1) {
          return res.status(409).json({
            success: false,
            message: 'This is the only super admin — promote another one first.',
          });
        }
      }
      staff.adminRole = req.body.adminRole;
    }

    if (Array.isArray(req.body.permissions)) {
      if (!hasPermission(req.admin, 'staff.assign_permissions')) {
        return res.status(403).json({
          success: false,
          message: 'Your role does not allow this (staff.assign_permissions required).',
        });
      }
      const unknown = unknownPermissions(req.body.permissions);
      if (unknown.length) {
        return res.status(400).json({
          success: false,
          message: `Unknown permission(s): ${unknown.join(', ')}.`,
        });
      }
      if (req.body.permissions.includes('*') && req.admin.adminRole !== 'super_admin') {
        return res.status(403).json({
          success: false,
          message: 'Only a super admin can grant the full permission set.',
        });
      }
      staff.permissions = req.body.permissions;
    }

    if (typeof req.body.fullName === 'string' && req.body.fullName.trim()) {
      staff.fullName = req.body.fullName.trim();
    }
    if (typeof req.body.isActive === 'boolean') {
      if (String(staff._id) === String(req.user.id) && req.body.isActive === false) {
        return res.status(400).json({
          success: false,
          message: 'You cannot disable your own account.',
        });
      }
      staff.isActive = req.body.isActive;
    }

    await staff.save({ validateBeforeSave: false });

    res.json({
      success: true,
      message: 'Admin updated.',
      data: { staff: staff.toJSON(), effectivePermissions: permissionsFor(staff) },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** DELETE /api/admin/staff/:id */
router.delete('/staff/:id', requirePermission('staff.delete'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    if (String(req.params.id) === String(req.user.id)) {
      return res.status(400).json({ success: false, message: 'You cannot remove your own account.' });
    }

    const staff = await User.findOne({ _id: req.params.id, role: 'admin' });
    if (!staff) return res.status(404).json({ success: false, message: 'Admin not found.' });

    if (staff.adminRole === 'super_admin' && req.admin.adminRole !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Only a super admin can remove another super admin.',
      });
    }

    const remaining = await User.countDocuments({ role: 'admin' });
    if (remaining <= 1) {
      return res.status(409).json({ success: false, message: 'The last admin cannot be removed.' });
    }

    // An operator's name is what the till receipts, the session history and
    // the stock ledger are signed with. Deleting the account does not remove
    // those rows — it blanks their attribution, so a receipt that was rung up
    // by a named cashier silently becomes one rung up by nobody. Disabling
    // ends their access and keeps the trail readable, which is the whole
    // point of recording who did what.
    const [invoices, refunds, sessions, movements] = await Promise.all([
      PosInvoice.countDocuments({ cashierId: staff._id }),
      PosInvoice.countDocuments({ refundedBy: staff._id }),
      PosSession.countDocuments({ cashierId: staff._id }),
      StockMovement.countDocuments({ performedBy: staff._id }),
    ]);
    const signed = invoices + refunds + sessions + movements;
    if (signed > 0) {
      const parts = [];
      if (invoices) parts.push(`${invoices} receipt(s)`);
      if (refunds) parts.push(`${refunds} refund(s)`);
      if (sessions) parts.push(`${sessions} till session(s)`);
      if (movements) parts.push(`${movements} stock movement(s)`);
      return res.status(409).json({
        success: false,
        message: `${staff.fullName} is recorded on ${parts.join(', ')}. ` +
          'Disable the account instead — deleting it would leave those ' +
          'records with no one attached to them.',
        data: { signedRecords: signed, invoices, refunds, sessions, movements },
      });
    }

    await staff.deleteOne();
    res.json({ success: true, message: 'Admin removed.', data: { deletedId: req.params.id } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Custom roles ──────────────────────────────────────────

/** GET /api/admin/roles */
router.get('/roles', requirePermission('staff.read'), async (req, res) => {
  try {
    const roles = await Role.find({}).sort({ createdAt: -1 }).lean();
    res.json({
      success: true,
      message: 'Roles',
      data: {
        items: roles,
        // The four built-ins are code, not rows, so they are listed
        // alongside rather than pretending to be editable records.
        builtIn: Object.entries(ROLE_PERMISSIONS).map(([name, permissions]) => ({
          name, permissions, isBuiltIn: true,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** POST /api/admin/roles */
router.post('/roles', requirePermission('staff.assign_permissions'), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, message: 'A role name is required.' });
    if (ROLE_PERMISSIONS[name]) {
      return res.status(409).json({
        success: false,
        message: `"${name}" is a built-in role name.`,
      });
    }

    const permissions = Array.isArray(req.body.permissions) ? req.body.permissions : [];
    const unknown = unknownPermissions(permissions);
    if (unknown.length) {
      return res.status(400).json({
        success: false,
        message: `Unknown permission(s): ${unknown.join(', ')}.`,
      });
    }

    const existing = await Role.findOne({ name });
    if (existing) {
      return res.status(409).json({ success: false, message: 'That role already exists.' });
    }

    const role = await Role.create({
      name,
      description: String(req.body.description || '').trim(),
      permissions,
      createdBy: req.user.id,
    });

    res.status(201).json({ success: true, message: 'Role created.', data: { role } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** PUT /api/admin/roles/:id */
router.put('/roles/:id', requirePermission('staff.assign_permissions'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ success: false, message: 'Role not found.' });

    if (Array.isArray(req.body.permissions)) {
      const unknown = unknownPermissions(req.body.permissions);
      if (unknown.length) {
        return res.status(400).json({
          success: false,
          message: `Unknown permission(s): ${unknown.join(', ')}.`,
        });
      }
      role.permissions = req.body.permissions;
    }
    if (typeof req.body.description === 'string') role.description = req.body.description.trim();
    if (typeof req.body.isActive === 'boolean') role.isActive = req.body.isActive;

    await role.save();
    res.json({ success: true, message: 'Role updated.', data: { role } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** DELETE /api/admin/roles/:id */
router.delete('/roles/:id', requirePermission('staff.assign_permissions'), async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ success: false, message: 'Role not found.' });
    if (role.isBuiltIn) {
      return res.status(403).json({ success: false, message: 'A built-in role cannot be deleted.' });
    }

    await role.deleteOne();
    res.json({ success: true, message: 'Role deleted.', data: { deletedId: req.params.id } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
