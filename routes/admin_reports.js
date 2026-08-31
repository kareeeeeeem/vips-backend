const express = require('express');

const User                 = require('../models/User');
const Order                = require('../models/Order');
const Product              = require('../models/Product');
const PosInvoice           = require('../models/PosInvoice');
const BusinessRegistration = require('../models/BusinessRegistration');

const { requirePermission } = require('../middleware/permissions');
const {
  REVENUE_STATUSES,
  CANCELLED_STATUSES,
  round,
  isValidId,
  reportRange,
  groupFormat,
  normaliseGroupBy,
  toCsv,
} = require('../utils/adminHelpers');

const router = express.Router();

// Mounted at /api/admin/reports behind the admin gate. Reading a report is
// the one thing every role can do, so a single read permission covers the
// group; export is separately a read too — it is the same data in a file.
const canRead = requirePermission('reports.read');

/**
 * Match stages for the two places revenue comes from.
 *
 * Counter sales live in PosInvoice rather than Order (Order.orderType is a
 * fixed enum two shipping apps switch on). Every money figure here reads both
 * so till takings are never invisible in a report.
 */
const orderRevenueMatch = (query, extra = {}) => ({
  ...reportRange(query),
  status: { $in: REVENUE_STATUSES },
  ...extra,
});

const posRevenueMatch = (query, extra = {}) => ({
  ...reportRange(query),
  status: 'completed',
  ...extra,
});

const merchantScope = (query) =>
  query.merchantId && isValidId(query.merchantId) ? { merchantId: query.merchantId } : {};

/** Merge two `{_id, ...}` aggregation results keyed by bucket. */
function mergeByKey(a, b, fields) {
  const out = new Map();
  const absorb = (rows) => {
    for (const row of rows) {
      const current = out.get(row._id) || { key: row._id, ...Object.fromEntries(fields.map((f) => [f, 0])) };
      for (const field of fields) current[field] += row[field] || 0;
      out.set(row._id, current);
    }
  };
  absorb(a);
  absorb(b);
  return [...out.values()].sort((x, y) => String(x.key).localeCompare(String(y.key)));
}

// ═══════════════════════════════════════════════════════════
// SALES
// ═══════════════════════════════════════════════════════════

/** GET /reports/sales?from=&to=&groupBy=day|week|month|year&merchantId= */
router.get('/sales', canRead, async (req, res) => {
  try {
    const groupBy = normaliseGroupBy(req.query.groupBy);
    const format = groupFormat(groupBy);
    const scope = merchantScope(req.query);

    const [orderSeries, posSeries, orderTotals, posTotals, byMethod, topMerchants] =
      await Promise.all([
        Order.aggregate([
          { $match: orderRevenueMatch(req.query, scope) },
          {
            $group: {
              _id: { $dateToString: { format, date: '$createdAt' } },
              revenue: { $sum: '$totalAmount' },
              orders: { $sum: 1 },
            },
          },
        ]),
        PosInvoice.aggregate([
          { $match: posRevenueMatch(req.query, scope) },
          {
            $group: {
              _id: { $dateToString: { format, date: '$createdAt' } },
              revenue: { $sum: '$total' },
              orders: { $sum: 1 },
            },
          },
        ]),
        Order.aggregate([
          { $match: orderRevenueMatch(req.query, scope) },
          {
            $group: {
              _id: null,
              revenue: { $sum: '$totalAmount' },
              orders: { $sum: 1 },
              discounts: {
                $sum: {
                  $add: [
                    '$couponDiscountAmount',
                    '$storeDiscountAmount',
                    '$walletDiscountAmount',
                  ],
                },
              },
              tax: { $sum: '$totalTaxAmount' },
              delivery: { $sum: '$deliveryCharge' },
            },
          },
        ]),
        PosInvoice.aggregate([
          { $match: posRevenueMatch(req.query, scope) },
          {
            $group: {
              _id: null,
              revenue: { $sum: '$total' },
              orders: { $sum: 1 },
              discounts: { $sum: '$discount' },
              tax: { $sum: '$tax' },
            },
          },
        ]),
        Order.aggregate([
          { $match: orderRevenueMatch(req.query, scope) },
          { $group: { _id: '$paymentMethod', revenue: { $sum: '$totalAmount' }, orders: { $sum: 1 } } },
          { $sort: { revenue: -1 } },
        ]),
        Order.aggregate([
          { $match: orderRevenueMatch(req.query, { ...scope, merchantId: { $ne: null } }) },
          { $group: { _id: '$merchantId', revenue: { $sum: '$totalAmount' }, orders: { $sum: 1 } } },
          { $sort: { revenue: -1 } },
          { $limit: 10 },
          { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'merchant' } },
          { $unwind: { path: '$merchant', preserveNullAndEmptyArrays: true } },
          {
            $project: {
              revenue: 1,
              orders: 1,
              name: { $ifNull: ['$merchant.storeName', '$merchant.fullName'] },
            },
          },
        ]),
      ]);

    const o = orderTotals[0] || { revenue: 0, orders: 0, discounts: 0, tax: 0, delivery: 0 };
    const p = posTotals[0] || { revenue: 0, orders: 0, discounts: 0, tax: 0 };

    const revenue = round(o.revenue + p.revenue);
    const orders = o.orders + p.orders;
    const series = mergeByKey(orderSeries, posSeries, ['revenue', 'orders']);

    res.json({
      success: true,
      message: 'Sales report',
      data: {
        groupBy,
        summary: {
          revenue,
          orders,
          averageOrderValue: orders ? round(revenue / orders) : 0,
          discounts: round(o.discounts + p.discounts),
          tax: round(o.tax + p.tax),
          deliveryCharges: round(o.delivery),
          // Split out so the till's contribution is visible rather than
          // silently folded into one number.
          onlineRevenue: round(o.revenue),
          posRevenue: round(p.revenue),
        },
        series: series.map((s) => ({
          period: s.key,
          revenue: round(s.revenue),
          orders: s.orders,
        })),
        byPaymentMethod: byMethod.map((m) => ({
          method: m._id || 'unknown',
          revenue: round(m.revenue),
          orders: m.orders,
        })),
        topMerchants: topMerchants.map((m) => ({
          merchantId: m._id,
          name: m.name || 'Unknown',
          revenue: round(m.revenue),
          orders: m.orders,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PROFIT
// ═══════════════════════════════════════════════════════════

/**
 * GET /reports/profit
 *
 * Gross profit = revenue − cost of goods, over the lines whose product has a
 * cost recorded. `Product.costPrice` defaults to 0 meaning "not recorded", so
 * counting those as free would show a 100% margin on every legacy sale. The
 * response therefore reports `costCoverage`: the share of revenue the margin
 * was actually computed over. A margin on 12% coverage is not a margin.
 */
router.get('/profit', canRead, async (req, res) => {
  try {
    const groupBy = normaliseGroupBy(req.query.groupBy);
    const format = groupFormat(groupBy);
    const scope = merchantScope(req.query);

    // Both revenue sources are unwound to line level and joined to Product
    // for its cost. `productId` is Mixed on Order items, so the lookup uses
    // the string form to match either shape.
    const lineStages = (idField) => [
      { $unwind: '$items' },
      {
        $lookup: {
          from: 'products',
          let: { pid: { $toString: `$items.${idField}` } },
          pipeline: [
            { $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$pid'] } } },
            { $project: { costPrice: 1, name: 1 } },
          ],
          as: 'product',
        },
      },
      { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    ];

    const profitGroup = (revenueExpr, qtyExpr, periodExpr) => ({
      $group: {
        _id: periodExpr,
        revenue: { $sum: revenueExpr },
        // Only lines with a real cost contribute to either figure, so the
        // margin below is computed over a matched pair.
        costedRevenue: {
          $sum: { $cond: [{ $gt: ['$product.costPrice', 0] }, revenueExpr, 0] },
        },
        cost: {
          $sum: {
            $cond: [
              { $gt: ['$product.costPrice', 0] },
              { $multiply: ['$product.costPrice', qtyExpr] },
              0,
            ],
          },
        },
        units: { $sum: qtyExpr },
      },
    });

    const orderRevenueExpr = { $multiply: ['$items.price', '$items.quantity'] };
    const posRevenueExpr = '$items.lineTotal';

    const [orderSeries, posSeries, orderTotal, posTotal] = await Promise.all([
      Order.aggregate([
        { $match: orderRevenueMatch(req.query, scope) },
        ...lineStages('productId'),
        profitGroup(orderRevenueExpr, '$items.quantity', {
          $dateToString: { format, date: '$createdAt' },
        }),
      ]),
      PosInvoice.aggregate([
        { $match: posRevenueMatch(req.query, scope) },
        ...lineStages('productId'),
        profitGroup(posRevenueExpr, '$items.quantity', {
          $dateToString: { format, date: '$createdAt' },
        }),
      ]),
      Order.aggregate([
        { $match: orderRevenueMatch(req.query, scope) },
        ...lineStages('productId'),
        profitGroup(orderRevenueExpr, '$items.quantity', null),
      ]),
      PosInvoice.aggregate([
        { $match: posRevenueMatch(req.query, scope) },
        ...lineStages('productId'),
        profitGroup(posRevenueExpr, '$items.quantity', null),
      ]),
    ]);

    const o = orderTotal[0] || { revenue: 0, costedRevenue: 0, cost: 0, units: 0 };
    const p = posTotal[0] || { revenue: 0, costedRevenue: 0, cost: 0, units: 0 };

    const revenue = round(o.revenue + p.revenue);
    const costedRevenue = round(o.costedRevenue + p.costedRevenue);
    const cost = round(o.cost + p.cost);
    const grossProfit = round(costedRevenue - cost);

    const series = mergeByKey(orderSeries, posSeries, [
      'revenue', 'costedRevenue', 'cost', 'units',
    ]);

    const productsWithCost = await Product.countDocuments({ costPrice: { $gt: 0 } });
    const productsTotal = await Product.countDocuments({});

    res.json({
      success: true,
      message: 'Profit report',
      data: {
        groupBy,
        summary: {
          revenue,
          // The share of revenue the margin is computed over. Read the margin
          // only as far as this number allows.
          costedRevenue,
          costCoverage: revenue ? round((costedRevenue / revenue) * 100) : 0,
          cost,
          grossProfit,
          margin: costedRevenue ? round((grossProfit / costedRevenue) * 100) : 0,
          unitsSold: o.units + p.units,
          productsWithCost,
          productsTotal,
        },
        series: series.map((s) => ({
          period: s.key,
          revenue: round(s.revenue),
          cost: round(s.cost),
          grossProfit: round(s.costedRevenue - s.cost),
          units: s.units,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PRODUCTS
// ═══════════════════════════════════════════════════════════

/** GET /reports/products — best sellers across online orders and the till. */
router.get('/products', canRead, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const scope = merchantScope(req.query);

    const [orderLines, posLines, neverSold] = await Promise.all([
      Order.aggregate([
        { $match: orderRevenueMatch(req.query, scope) },
        { $unwind: '$items' },
        {
          $group: {
            _id: { $toString: '$items.productId' },
            name: { $last: '$items.item_name' },
            units: { $sum: '$items.quantity' },
            revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
            orders: { $sum: 1 },
          },
        },
      ]),
      PosInvoice.aggregate([
        { $match: posRevenueMatch(req.query, scope) },
        { $unwind: '$items' },
        {
          $group: {
            _id: { $toString: '$items.productId' },
            name: { $last: '$items.name' },
            units: { $sum: '$items.quantity' },
            revenue: { $sum: '$items.lineTotal' },
            orders: { $sum: 1 },
          },
        },
      ]),
      // Active catalogue entries that sold nothing in the window. Just as
      // actionable as the best sellers, and invisible in a top-N list.
      Product.find({ isActive: true, ...scope })
        .select('name category price stock merchantId')
        .limit(200)
        .lean(),
    ]);

    const merged = new Map();
    for (const row of [...orderLines, ...posLines]) {
      const key = row._id;
      const current = merged.get(key) || {
        productId: key, name: row.name || 'Unnamed', units: 0, revenue: 0, orders: 0,
      };
      current.units += row.units || 0;
      current.revenue += row.revenue || 0;
      current.orders += row.orders || 0;
      if (row.name) current.name = row.name;
      merged.set(key, current);
    }

    // Older order lines were written before names were stored on the item,
    // so the biggest seller can come back blank. Fall back to the catalogue
    // rather than showing "Unnamed" against the largest revenue row.
    const unnamed = [...merged.values()]
      .filter((r) => !r.name || r.name === 'Unnamed')
      .map((r) => r.productId)
      .filter(isValidId);
    if (unnamed.length) {
      const named = await Product.find({ _id: { $in: unnamed } }).select('name').lean();
      for (const product of named) {
        const row = merged.get(String(product._id));
        if (row) row.name = product.name;
      }
    }

    const ranked = [...merged.values()]
      .map((r) => ({ ...r, revenue: round(r.revenue) }))
      .sort((a, b) => b.revenue - a.revenue);

    const soldIds = new Set(ranked.map((r) => r.productId));
    const stagnant = neverSold
      .filter((p) => !soldIds.has(String(p._id)))
      .slice(0, limit)
      .map((p) => ({
        productId: String(p._id),
        name: p.name,
        category: p.category,
        price: p.price,
        stock: p.stock,
      }));

    res.json({
      success: true,
      message: 'Products report',
      data: {
        summary: {
          productsSold: ranked.length,
          unitsSold: ranked.reduce((sum, r) => sum + r.units, 0),
          revenue: round(ranked.reduce((sum, r) => sum + r.revenue, 0)),
          notSold: stagnant.length,
        },
        topByRevenue: ranked.slice(0, limit),
        topByUnits: [...ranked].sort((a, b) => b.units - a.units).slice(0, limit),
        notSold: stagnant,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// CUSTOMERS
// ═══════════════════════════════════════════════════════════

/** GET /reports/customers — acquisition, repeat rate and top spenders. */
router.get('/customers', canRead, async (req, res) => {
  try {
    const groupBy = normaliseGroupBy(req.query.groupBy);
    const format = groupFormat(groupBy);
    const range = reportRange(req.query);

    const [signups, spend, verification, orderedInRange] = await Promise.all([
      User.aggregate([
        { $match: { ...range, role: 'customer' } },
        { $group: { _id: { $dateToString: { format, date: '$createdAt' } }, signups: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      // Lifetime spend per customer, used for the repeat rate and the top
      // list. Not date-scoped on purpose: "repeat customer" is a property of
      // their whole history, not of the window being looked at.
      Order.aggregate([
        { $match: { status: { $in: REVENUE_STATUSES } } },
        { $group: { _id: '$userId', spent: { $sum: '$totalAmount' }, orders: { $sum: 1 } } },
      ]),
      User.aggregate([
        { $match: { role: 'customer' } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            active: { $sum: { $cond: ['$isActive', 1, 0] } },
            verified: { $sum: { $cond: ['$isVerified', 1, 0] } },
          },
        },
      ]),
      Order.distinct('userId', { ...range, status: { $in: REVENUE_STATUSES } }),
    ]);

    const buyers = spend.length;
    const repeatBuyers = spend.filter((s) => s.orders > 1).length;
    const totalSpent = spend.reduce((sum, s) => sum + s.spent, 0);

    const topIds = [...spend].sort((a, b) => b.spent - a.spent).slice(0, 10).map((s) => s._id);
    const topUsers = await User.find({ _id: { $in: topIds } })
      .select('fullName email phone')
      .lean();
    const byId = new Map(topUsers.map((u) => [String(u._id), u]));

    const v = verification[0] || { total: 0, active: 0, verified: 0 };

    res.json({
      success: true,
      message: 'Customers report',
      data: {
        groupBy,
        summary: {
          customers: v.total,
          active: v.active,
          verified: v.verified,
          signupsInRange: signups.reduce((sum, s) => sum + s.signups, 0),
          buyers,
          // Customers who ever bought, as a share of all customers — the
          // honest denominator for a conversion figure.
          conversionRate: v.total ? round((buyers / v.total) * 100) : 0,
          repeatBuyers,
          repeatRate: buyers ? round((repeatBuyers / buyers) * 100) : 0,
          activeInRange: orderedInRange.length,
          lifetimeValue: buyers ? round(totalSpent / buyers) : 0,
        },
        signupsByPeriod: signups.map((s) => ({ period: s._id, signups: s.signups })),
        topSpenders: [...spend]
          .sort((a, b) => b.spent - a.spent)
          .slice(0, 10)
          .map((s) => {
            const user = byId.get(String(s._id));
            return {
              userId: s._id,
              name: user ? user.fullName : 'Deleted account',
              email: user ? user.email : '',
              spent: round(s.spent),
              orders: s.orders,
              averageOrder: s.orders ? round(s.spent / s.orders) : 0,
            };
          }),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// MERCHANTS
// ═══════════════════════════════════════════════════════════

/** GET /reports/merchants — approval funnel, categories and performance. */
router.get('/merchants', canRead, async (req, res) => {
  try {
    const [byApproval, byCategory, performance, totalMerchants] = await Promise.all([
      BusinessRegistration.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
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
            revenue: {
              $sum: { $cond: [{ $in: ['$status', REVENUE_STATUSES] }, '$totalAmount', 0] },
            },
            cancelled: {
              $sum: { $cond: [{ $in: ['$status', CANCELLED_STATUSES] }, 1, 0] },
            },
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
            commissionRate: '$merchant.commissionRate',
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
          // Merchants who never submitted a registration at all — invisible
          // in the approval funnel, but real accounts.
          unregistered: Math.max(totalMerchants - registered, 0),
          approved: approvalCounts.approved || 0,
          pending: (approvalCounts.pending || 0) + (approvalCounts.under_review || 0),
          rejected: approvalCounts.rejected || 0,
        },
        byApproval: byApproval.map((a) => ({ status: a._id, count: a.count })),
        byCategory: byCategory.map((c) => ({
          category: c._id || 'Uncategorised',
          count: c.count,
        })),
        performance: performance.map((m) => ({
          merchantId: m._id,
          name: m.name || 'Unknown',
          category: m.category || 'Uncategorised',
          isActive: m.isActive !== false,
          orders: m.orders,
          cancelled: m.cancelled,
          revenue: round(m.revenue),
          commissionRate: m.commissionRate || 0,
          cancellationRate: m.orders ? round((m.cancelled / m.orders) * 100) : 0,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════

/** GET /reports/orders — status, type and fulfilment breakdowns. */
router.get('/orders', canRead, async (req, res) => {
  try {
    const range = reportRange(req.query);

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
      // Averaged only over orders that actually carry a deliveredAt — an
      // order still in flight has none, and counting it as zero would
      // flatter the number.
      Order.aggregate([
        { $match: { ...range, deliveredAt: { $ne: null } } },
        {
          $group: {
            _id: null,
            avgMinutes: {
              $avg: { $divide: [{ $subtract: ['$deliveredAt', '$createdAt'] }, 60000] },
            },
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
          cancellationRate: total ? round((cancelled / total) * 100) : 0,
          averageFulfilmentMinutes: f ? round(f.avgMinutes) : null,
          deliveredSampleSize: f ? f.count : 0,
        },
        byStatus: byStatus.map((s) => ({
          status: s._id,
          count: s.count,
          value: round(s.value),
        })),
        byType: byType.map((t) => ({ type: t._id || 'unknown', count: t.count })),
        byPaymentStatus: byPaymentStatus.map((p) => ({
          status: p._id || 'unknown',
          count: p.count,
          value: round(p.value),
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// COMMISSION
// ═══════════════════════════════════════════════════════════

/**
 * GET /reports/commission — the platform's cut per merchant.
 *
 * Computed from each merchant's own `commissionRate`, which defaults to 0.
 * A merchant on 0% contributes nothing, and the response says how many are
 * in that state — otherwise a small total reads as poor sales rather than as
 * rates never having been set.
 */
router.get('/commission', canRead, async (req, res) => {
  try {
    const scope = merchantScope(req.query);

    const [orderRevenue, posRevenue, merchants] = await Promise.all([
      Order.aggregate([
        { $match: orderRevenueMatch(req.query, { ...scope, merchantId: { $ne: null } }) },
        { $group: { _id: '$merchantId', revenue: { $sum: '$totalAmount' }, orders: { $sum: 1 } } },
      ]),
      PosInvoice.aggregate([
        { $match: posRevenueMatch(req.query, scope) },
        { $group: { _id: '$merchantId', revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      ]),
      User.find({ role: 'merchant' }).select('storeName fullName commissionRate').lean(),
    ]);

    const rates = new Map(
      merchants.map((m) => [
        String(m._id),
        { name: m.storeName || m.fullName, rate: m.commissionRate || 0 },
      ])
    );

    const combined = new Map();
    for (const row of [...orderRevenue, ...posRevenue]) {
      const key = String(row._id);
      const current = combined.get(key) || { revenue: 0, orders: 0 };
      current.revenue += row.revenue || 0;
      current.orders += row.orders || 0;
      combined.set(key, current);
    }

    const rows = [...combined.entries()]
      .map(([merchantId, totals]) => {
        const info = rates.get(merchantId) || { name: 'Unknown', rate: 0 };
        const commission = round(totals.revenue * (info.rate / 100));
        return {
          merchantId,
          name: info.name,
          commissionRate: info.rate,
          revenue: round(totals.revenue),
          orders: totals.orders,
          commission,
          merchantEarnings: round(totals.revenue - commission),
        };
      })
      .sort((a, b) => b.commission - a.commission);

    const totalRevenue = round(rows.reduce((sum, r) => sum + r.revenue, 0));
    const totalCommission = round(rows.reduce((sum, r) => sum + r.commission, 0));
    const onZeroRate = rows.filter((r) => r.commissionRate === 0).length;

    res.json({
      success: true,
      message: 'Commission report',
      data: {
        summary: {
          revenue: totalRevenue,
          commission: totalCommission,
          merchantEarnings: round(totalRevenue - totalCommission),
          effectiveRate: totalRevenue ? round((totalCommission / totalRevenue) * 100) : 0,
          sellingMerchants: rows.length,
          // The figure that explains a suspiciously small total.
          merchantsOnZeroRate: onZeroRate,
          merchantsWithRateSet: merchants.filter((m) => (m.commissionRate || 0) > 0).length,
        },
        byMerchant: rows,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════

/**
 * GET /reports/export?type=<report>&format=csv
 *
 * Re-runs the requested report against this same router and serialises the
 * table a human would read off the screen. Going back through the routes
 * rather than re-querying keeps the export and the screen from drifting into
 * two different answers for the same question.
 */
const EXPORTS = {
  sales:      { path: '/sales',      section: 'series',      columns: [
    { key: 'period', label: 'Period' },
    { key: 'revenue', label: 'Revenue (TND)' },
    { key: 'orders', label: 'Orders' },
  ]},
  profit:     { path: '/profit',     section: 'series',      columns: [
    { key: 'period', label: 'Period' },
    { key: 'revenue', label: 'Revenue (TND)' },
    { key: 'cost', label: 'Cost (TND)' },
    { key: 'grossProfit', label: 'Gross profit (TND)' },
    { key: 'units', label: 'Units' },
  ]},
  products:   { path: '/products',   section: 'topByRevenue', columns: [
    { key: 'name', label: 'Product' },
    { key: 'units', label: 'Units sold' },
    { key: 'revenue', label: 'Revenue (TND)' },
    { key: 'orders', label: 'Orders' },
  ]},
  customers:  { path: '/customers',  section: 'topSpenders', columns: [
    { key: 'name', label: 'Customer' },
    { key: 'email', label: 'Email' },
    { key: 'orders', label: 'Orders' },
    { key: 'spent', label: 'Lifetime spend (TND)' },
    { key: 'averageOrder', label: 'Average order (TND)' },
  ]},
  merchants:  { path: '/merchants',  section: 'performance', columns: [
    { key: 'name', label: 'Merchant' },
    { key: 'category', label: 'Category' },
    { key: 'orders', label: 'Orders' },
    { key: 'revenue', label: 'Revenue (TND)' },
    { key: 'cancellationRate', label: 'Cancellation rate (%)' },
  ]},
  orders:     { path: '/orders',     section: 'byStatus',    columns: [
    { key: 'status', label: 'Status' },
    { key: 'count', label: 'Orders' },
    { key: 'value', label: 'Value (TND)' },
  ]},
  commission: { path: '/commission', section: 'byMerchant',  columns: [
    { key: 'name', label: 'Merchant' },
    { key: 'commissionRate', label: 'Rate (%)' },
    { key: 'revenue', label: 'Revenue (TND)' },
    { key: 'commission', label: 'Commission (TND)' },
    { key: 'merchantEarnings', label: 'Merchant earnings (TND)' },
  ]},
};

router.get('/export', canRead, async (req, res) => {
  try {
    const type = String(req.query.type || '').toLowerCase();
    const spec = EXPORTS[type];
    if (!spec) {
      return res.status(400).json({
        success: false,
        message: `type must be one of: ${Object.keys(EXPORTS).join(', ')}.`,
      });
    }

    const format = String(req.query.format || 'csv').toLowerCase();
    if (format !== 'csv') {
      // Said plainly rather than returning a CSV with a .pdf name. Generating
      // a real PDF needs a rendering dependency this backend does not carry;
      // the console's print view covers it in the meantime.
      return res.status(400).json({
        success: false,
        message: 'Only CSV export is available. Use the browser\'s print view for PDF.',
      });
    }

    // Re-enter this router so the export is literally the report.
    const handler = router.stack.find(
      (layer) => layer.route && layer.route.path === spec.path
    );
    if (!handler) {
      return res.status(500).json({ success: false, message: 'Report not available.' });
    }

    let payload = null;
    const fakeRes = {
      json: (body) => { payload = body; return fakeRes; },
      status: () => fakeRes,
    };
    // Skip the permission layer already satisfied above and call the handler.
    const routeHandlers = handler.route.stack;
    await routeHandlers[routeHandlers.length - 1].handle(req, fakeRes, () => {});

    if (!payload || !payload.success) {
      return res.status(500).json({ success: false, message: 'Could not build the report.' });
    }

    const rows = payload.data[spec.section] || [];
    const csv = toCsv(rows, spec.columns);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `vips-${type}-${stamp}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // A BOM so Excel opens the Arabic merchant names as UTF-8 rather than
    // mojibake, which is the whole point of exporting for most operators.
    res.send('﻿' + csv);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
