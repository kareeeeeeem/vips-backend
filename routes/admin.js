const express = require('express');
const jwt     = require('jsonwebtoken');
const mongoose = require('mongoose');

const { authMiddleware, requireRole } = require('../middleware/auth');

const User                 = require('../models/User');
const Order                = require('../models/Order');
const Product              = require('../models/Product');
const Stock                = require('../models/Stock');
const Transaction          = require('../models/Transaction');
const BusinessRegistration = require('../models/BusinessRegistration');
const Payout               = require('../models/Payout');
const MerchantAd           = require('../models/MerchantAd');
const StockMovement        = require('../models/StockMovement');

const { recordMovement, movementTypeForDelta } = require('../utils/stockLedger');

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
      data: { user: user.toJSON(), token },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Everything below requires a valid admin token ─────────
router.use(authMiddleware, requireRole('admin'));

/** GET /api/admin/me — the signed-in admin's own profile. */
router.get('/me', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'Admin not found.' });
    res.json({ success: true, message: 'Admin profile', data: { user: user.toJSON() } });
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
router.get('/dashboard/stats', async (req, res) => {
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
router.get('/dashboard/charts', async (req, res) => {
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
router.get('/dashboard/recent', async (req, res) => {
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
router.get('/users', async (req, res) => {
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
router.get('/users/:id', async (req, res) => {
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
router.put('/users/:id/ban', async (req, res) => {
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
router.put('/users/:id/role', async (req, res) => {
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
router.delete('/users/:id', async (req, res) => {
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

// ═══════════════════════════════════════════════════════════
// MERCHANTS
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/admin/merchants
 * ?search= &status=active|inactive &approval=pending|under_review|approved|rejected|none
 * Each row carries its BusinessRegistration status so the list can show
 * "awaiting approval" without a second request per merchant.
 */
router.get('/merchants', async (req, res) => {
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
router.get('/merchants/:id', async (req, res) => {
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
router.put('/merchants/:id/approve', async (req, res) => {
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
router.put('/merchants/:id/activate', async (req, res) => {
  try {
    if (!requireValidId(req, res)) return;

    const merchant = await User.findOne({ _id: req.params.id, role: 'merchant' });
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });

    const active = typeof req.body.active === 'boolean' ? req.body.active : !merchant.isActive;
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
router.delete('/merchants/:id', async (req, res) => {
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
router.get('/orders', async (req, res) => {
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
router.get('/orders/:id', async (req, res) => {
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
router.put('/orders/:id/status', async (req, res) => {
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

    await order.save();

    res.json({ success: true, message: 'Order status updated.', data: { order: order.toJSON() } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * DELETE /api/admin/orders/:id — cancels rather than destroys.
 * Orders are financial records; wiping one would rewrite past revenue.
 */
router.delete('/orders/:id', async (req, res) => {
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

    order.status = 'cancelled';
    order.canceledAt = new Date();
    // Accept the reason from either place: the app's shared ApiService.delete
    // sends no request body, so it passes ?reason= instead. Reading only
    // req.body here would silently drop every reason the console sends.
    order.cancellationReason = String(req.body.reason || req.query.reason || 'Cancelled by administrator');
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
router.get('/inventory', async (req, res) => {
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
router.put('/inventory/:id', async (req, res) => {
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
router.get('/inventory/movements', async (req, res) => {
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

    const [items, total, byType] = await Promise.all([
      StockMovement.find(filter)
        .sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate('merchantId', 'storeName fullName')
        .populate('performedBy', 'fullName role')
        .lean(),
      StockMovement.countDocuments(filter),
      StockMovement.aggregate([
        { $match: filter },
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
router.post('/inventory/transfer', async (req, res) => {
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
router.get('/inventory/locations', async (req, res) => {
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

/** GET /api/admin/inventory/alerts — everything at or below its threshold. */
router.get('/inventory/alerts', async (req, res) => {
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

/** GET /api/admin/reports/sales?from=&to= — revenue by day, payment method, top merchants. */
router.get('/reports/sales', async (req, res) => {
  try {
    const range = dateRangeFilter(req.query) || { createdAt: { $gte: daysAgo(29) } };
    const revenueMatch = { ...range, status: { $in: REVENUE_STATUSES } };

    const [byDay, byPaymentMethod, topMerchants, totals] = await Promise.all([
      Order.aggregate([
        { $match: revenueMatch },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            revenue: { $sum: '$totalAmount' },
            orders: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Order.aggregate([
        { $match: revenueMatch },
        { $group: { _id: '$paymentMethod', revenue: { $sum: '$totalAmount' }, orders: { $sum: 1 } } },
        { $sort: { revenue: -1 } },
      ]),
      Order.aggregate([
        { $match: { ...revenueMatch, merchantId: { $ne: null } } },
        { $group: { _id: '$merchantId', revenue: { $sum: '$totalAmount' }, orders: { $sum: 1 } } },
        { $sort: { revenue: -1 } },
        { $limit: 10 },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'merchant' } },
        { $unwind: { path: '$merchant', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            revenue: 1, orders: 1,
            name: { $ifNull: ['$merchant.storeName', '$merchant.fullName'] },
          },
        },
      ]),
      Order.aggregate([
        { $match: revenueMatch },
        {
          $group: {
            _id: null,
            revenue: { $sum: '$totalAmount' },
            orders: { $sum: 1 },
            discounts: { $sum: { $add: ['$couponDiscountAmount', '$storeDiscountAmount', '$walletDiscountAmount'] } },
            tax: { $sum: '$totalTaxAmount' },
            delivery: { $sum: '$deliveryCharge' },
          },
        },
      ]),
    ]);

    const t = totals[0] || { revenue: 0, orders: 0, discounts: 0, tax: 0, delivery: 0 };

    res.json({
      success: true,
      message: 'Sales report',
      data: {
        summary: {
          revenue: Number(t.revenue.toFixed(3)),
          orders: t.orders,
          averageOrderValue: t.orders ? Number((t.revenue / t.orders).toFixed(3)) : 0,
          discounts: Number(t.discounts.toFixed(3)),
          tax: Number(t.tax.toFixed(3)),
          deliveryCharges: Number(t.delivery.toFixed(3)),
        },
        byDay: byDay.map((d) => ({ date: d._id, revenue: Number(d.revenue.toFixed(3)), orders: d.orders })),
        byPaymentMethod: byPaymentMethod.map((p) => ({
          method: p._id || 'unknown',
          revenue: Number(p.revenue.toFixed(3)),
          orders: p.orders,
        })),
        topMerchants: topMerchants.map((m) => ({
          merchantId: m._id,
          name: m.name || 'Unknown',
          revenue: Number(m.revenue.toFixed(3)),
          orders: m.orders,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/admin/reports/users?from=&to= — growth, role split, top spenders. */
router.get('/reports/users', async (req, res) => {
  try {
    const range = dateRangeFilter(req.query) || { createdAt: { $gte: daysAgo(29) } };

    const [signupsByDay, byRole, verification, topSpenders] = await Promise.all([
      User.aggregate([
        { $match: range },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            signups: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      User.aggregate([
        { $group: { _id: '$role', count: { $sum: 1 }, active: { $sum: { $cond: ['$isActive', 1, 0] } } } },
        { $sort: { count: -1 } },
      ]),
      User.aggregate([
        { $match: { role: 'customer' } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            verified: { $sum: { $cond: ['$isVerified', 1, 0] } },
            withPin: { $sum: { $cond: [{ $ne: ['$pin', null] }, 1, 0] } },
          },
        },
      ]),
      Order.aggregate([
        { $match: { status: { $in: REVENUE_STATUSES } } },
        { $group: { _id: '$userId', spent: { $sum: '$totalAmount' }, orders: { $sum: 1 } } },
        { $sort: { spent: -1 } },
        { $limit: 10 },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
        { $project: { spent: 1, orders: 1, name: '$user.fullName', email: '$user.email' } },
      ]),
    ]);

    const v = verification[0] || { total: 0, verified: 0, withPin: 0 };

    res.json({
      success: true,
      message: 'Users report',
      data: {
        summary: {
          customers: v.total,
          verified: v.verified,
          withPin: v.withPin,
          signupsInRange: signupsByDay.reduce((sum, d) => sum + d.signups, 0),
        },
        signupsByDay: signupsByDay.map((d) => ({ date: d._id, signups: d.signups })),
        byRole: byRole.map((r) => ({ role: r._id || 'unknown', count: r.count, active: r.active })),
        topSpenders: topSpenders.map((u) => ({
          userId: u._id,
          name: u.name || 'Unknown',
          email: u.email || '',
          spent: Number(u.spent.toFixed(3)),
          orders: u.orders,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/admin/reports/merchants — approval funnel, categories, performance. */
router.get('/reports/merchants', async (req, res) => {
  try {
    const [byApproval, byCategory, performance, totalMerchants] = await Promise.all([
      BusinessRegistration.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      User.aggregate([
        { $match: { role: 'merchant' } },
        { $group: { _id: '$storeCategory', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Order.aggregate([
        { $match: { merchantId: { $ne: null } } },
        {
          $group: {
            _id: '$merchantId',
            orders: { $sum: 1 },
            revenue: { $sum: { $cond: [{ $in: ['$status', REVENUE_STATUSES] }, '$totalAmount', 0] } },
            cancelled: { $sum: { $cond: [{ $in: ['$status', CANCELLED_STATUSES] }, 1, 0] } },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 20 },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'merchant' } },
        { $unwind: { path: '$merchant', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            orders: 1, revenue: 1, cancelled: 1,
            name: { $ifNull: ['$merchant.storeName', '$merchant.fullName'] },
            category: '$merchant.storeCategory',
            isActive: '$merchant.isActive',
          },
        },
      ]),
      User.countDocuments({ role: 'merchant' }),
    ]);

    const approvalCounts = byApproval.reduce((acc, a) => ({ ...acc, [a._id]: a.count }), {});
    const registered = byApproval.reduce((sum, a) => sum + a.count, 0);

    res.json({
      success: true,
      message: 'Merchants report',
      data: {
        summary: {
          total: totalMerchants,
          registered,
          // Merchants who never submitted a business registration at all —
          // invisible in the approval funnel, but they are real accounts.
          unregistered: Math.max(totalMerchants - registered, 0),
          approved: approvalCounts.approved || 0,
          pending: (approvalCounts.pending || 0) + (approvalCounts.under_review || 0),
          rejected: approvalCounts.rejected || 0,
        },
        byApproval: byApproval.map((a) => ({ status: a._id, count: a.count })),
        byCategory: byCategory.map((c) => ({ category: c._id || 'Uncategorised', count: c.count })),
        performance: performance.map((m) => ({
          merchantId: m._id,
          name: m.name || 'Unknown',
          category: m.category || 'Uncategorised',
          isActive: m.isActive !== false,
          orders: m.orders,
          cancelled: m.cancelled,
          revenue: Number(m.revenue.toFixed(3)),
          cancellationRate: m.orders ? Number(((m.cancelled / m.orders) * 100).toFixed(1)) : 0,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/admin/reports/orders?from=&to= — status/type/payment breakdowns. */
router.get('/reports/orders', async (req, res) => {
  try {
    const range = dateRangeFilter(req.query) || { createdAt: { $gte: daysAgo(29) } };

    const [byStatus, byType, byPaymentStatus, fulfilment] = await Promise.all([
      Order.aggregate([
        { $match: range },
        { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$totalAmount' } } },
        { $sort: { count: -1 } },
      ]),
      Order.aggregate([
        { $match: range },
        { $group: { _id: '$orderType', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Order.aggregate([
        { $match: range },
        { $group: { _id: '$paymentStatus', count: { $sum: 1 }, value: { $sum: '$totalAmount' } } },
        { $sort: { count: -1 } },
      ]),
      // Average minutes from creation to delivery, over orders that
      // actually carry a deliveredAt — an order still in flight has none,
      // and averaging it in as zero would flatter the number.
      Order.aggregate([
        { $match: { ...range, deliveredAt: { $ne: null } } },
        {
          $group: {
            _id: null,
            avgMinutes: { $avg: { $divide: [{ $subtract: ['$deliveredAt', '$createdAt'] }, 60000] } },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const total = byStatus.reduce((sum, s) => sum + s.count, 0);
    const cancelled = byStatus
      .filter((s) => CANCELLED_STATUSES.includes(s._id))
      .reduce((sum, s) => sum + s.count, 0);
    const f = fulfilment[0] || null;

    res.json({
      success: true,
      message: 'Orders report',
      data: {
        summary: {
          total,
          cancelled,
          cancellationRate: total ? Number(((cancelled / total) * 100).toFixed(1)) : 0,
          averageFulfilmentMinutes: f ? Number(f.avgMinutes.toFixed(1)) : null,
          deliveredSampleSize: f ? f.count : 0,
        },
        byStatus: byStatus.map((s) => ({
          status: s._id,
          count: s.count,
          value: Number(s.value.toFixed(3)),
        })),
        byType: byType.map((t) => ({ type: t._id || 'unknown', count: t.count })),
        byPaymentStatus: byPaymentStatus.map((p) => ({
          status: p._id || 'unknown',
          count: p.count,
          value: Number(p.value.toFixed(3)),
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

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
router.get('/notifications', async (req, res) => {
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
        route: null,
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
router.get('/search', async (req, res) => {
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
// PLATFORM SETTINGS
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/admin/settings
 * Reports what is actually live in this process rather than what someone
 * hopes is configured — the same signal /api/health exposes, plus the admin
 * roster, so the Settings screen never has to claim a state it cannot see.
 */
router.get('/settings', async (req, res) => {
  try {
    const [admins, adminCount] = await Promise.all([
      User.find({ role: 'admin' })
        .sort({ createdAt: 1 })
        .select('fullName email phone isActive createdAt lastLogin').lean(),
      User.countDocuments({ role: 'admin' }),
    ]);

    res.json({
      success: true,
      message: 'Platform settings',
      data: {
        admins,
        adminCount,
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
router.post('/settings/admins', async (req, res) => {
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
router.delete('/settings/admins/:id', async (req, res) => {
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

module.exports = router;
