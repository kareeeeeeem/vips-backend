const express = require('express');

const User                 = require('../models/User');
const Order                = require('../models/Order');
const Product              = require('../models/Product');
const Stock                = require('../models/Stock');
const PosInvoice           = require('../models/PosInvoice');
const Payout               = require('../models/Payout');
const BusinessRegistration = require('../models/BusinessRegistration');

const { requirePermission, hasPermission } = require('../middleware/permissions');
const {
  REVENUE_STATUSES,
  CANCELLED_STATUSES,
  round,
  isValidId,
  toCsv,
} = require('../utils/adminHelpers');

const router = express.Router();

/**
 * The five analytical dashboards.
 *
 * Mounted at /api/admin/dashboards. These are read models over the same
 * collections the reports read, deliberately sharing REVENUE_STATUSES and the
 * "count PosInvoice too" rule from utils/adminHelpers — a dashboard that
 * disagreed with the report behind it about the same month's revenue would be
 * worse than no dashboard.
 *
 * Gating: `operations` shows the order queue and stock backlog, which is the
 * shift-level view a cashier already has through orders.read / inventory.read,
 * so it sits behind `dashboard.read`. The other four aggregate platform money,
 * margins, commission and the customer base, so they need `reports.read` —
 * the same boundary that keeps a till operator out of the reports screen.
 */
const canOperate = requirePermission('dashboard.read');
const canAnalyse = requirePermission('reports.read');
const canExport  = requirePermission('reports.export');

// ═══════════════════════════════════════════════════════════
// THE SHARED WINDOW
// ═══════════════════════════════════════════════════════════

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const PERIODS = ['today', 'day', 'week', 'month', 'year', 'custom'];

/**
 * Bucket format for a granularity.
 *
 * 'hour' exists only here: a single day grouped by day is one bar, which is
 * not a chart. Week uses ISO numbering (%G-W%V) for the same reason the
 * reports do — %U would put late December and early January in one bucket.
 */
const FORMATS = {
  hour:  '%Y-%m-%d %H:00',
  day:   '%Y-%m-%d',
  week:  '%G-W%V',
  month: '%Y-%m',
  year:  '%Y',
};

/**
 * Resolve ?period= / ?startDate= / ?endDate= into one window.
 *
 * Also returns the window of the same length immediately before it, which is
 * what every "+23% vs last period" figure on these screens is measured
 * against. Without a named baseline a percentage change is just a number.
 */
function dashboardWindow(query) {
  const now = new Date();
  const requested = String(query.period || '').toLowerCase();

  // startDate/endDate is the spec's spelling; from/to is what the reports
  // screen already sends. Both are accepted so one client can drive either.
  const rawStart = query.startDate || query.from;
  const rawEnd   = query.endDate   || query.to;

  let period = PERIODS.includes(requested)
    ? (requested === 'day' ? 'today' : requested)
    : (rawStart || rawEnd ? 'custom' : 'month');

  let from = null;
  let to = now;

  if (period === 'custom') {
    const parsedFrom = rawStart ? new Date(rawStart) : null;
    const parsedTo   = rawEnd ? new Date(rawEnd) : null;
    if (parsedFrom && !isNaN(parsedFrom)) from = parsedFrom;
    if (parsedTo && !isNaN(parsedTo)) {
      // A bare '2026-08-31' means all of that day, not midnight.
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(rawEnd))) parsedTo.setHours(23, 59, 59, 999);
      to = parsedTo;
    }
    // An unparseable custom range falls back to the default rather than
    // querying { $gte: Invalid Date }, which matches nothing and would show
    // an empty dashboard as if the platform had no sales.
    if (!from) period = 'month';
  }

  if (period === 'today') from = startOfDay(now);
  if (period === 'week')  from = startOfDay(new Date(now.getTime() - 6 * 864e5));
  if (period === 'month') from = startOfDay(new Date(now.getTime() - 29 * 864e5));
  if (period === 'year') {
    from = startOfDay(now);
    from.setDate(1);
    from.setMonth(from.getMonth() - 11);
  }

  if (from > to) [from, to] = [to, from];

  const spanDays = Math.max((to - from) / 864e5, 0);

  let groupBy;
  if (period === 'today') groupBy = 'hour';
  else if (period === 'year') groupBy = 'month';
  else if (spanDays <= 1) groupBy = 'hour';
  else if (spanDays <= 62) groupBy = 'day';
  else if (spanDays <= 365) groupBy = 'week';
  else groupBy = 'month';

  // The equivalent stretch immediately before this one. Same length, so the
  // comparison is like-for-like: a 7-day window is compared with the 7 days
  // before it, never with a calendar month.
  const length = to - from;
  const previous = {
    from: new Date(from.getTime() - length),
    to: new Date(from.getTime() - 1),
  };

  return { period, from, to, groupBy, format: FORMATS[groupBy], previous, spanDays };
}

const inWindow = (win, extra = {}, field = 'createdAt') => ({
  [field]: { $gte: win.from, $lte: win.to },
  ...extra,
});

const inPrevious = (win, extra = {}, field = 'createdAt') => ({
  [field]: { $gte: win.previous.from, $lte: win.previous.to },
  ...extra,
});

/**
 * Percentage change against the baseline window.
 *
 * Returns null when the baseline was zero: there is no percentage increase
 * from nothing, and rendering one as "+100%" would invent a trend out of a
 * first-ever sale.
 */
const changeVs = (current, previous) => {
  const now = Number(current) || 0;
  const before = Number(previous) || 0;
  if (before === 0) return null;
  return round(((now - before) / before) * 100);
};

const orderRevenue = (win, extra = {}) =>
  inWindow(win, { status: { $in: REVENUE_STATUSES }, ...extra });

const posRevenue = (win, extra = {}) =>
  inWindow(win, { status: 'completed', ...extra });

const previousOrderRevenue = (win, extra = {}) =>
  inPrevious(win, { status: { $in: REVENUE_STATUSES }, ...extra });

const previousPosRevenue = (win, extra = {}) =>
  inPrevious(win, { status: 'completed', ...extra });

const merchantScope = (query) =>
  query.merchantId && isValidId(query.merchantId) ? { merchantId: query.merchantId } : {};

/**
 * The bucket label Mongo's $dateToString would produce for this instant.
 *
 * $dateToString runs in UTC unless given a timezone, so these are built from
 * the UTC parts — deriving them from local parts would generate labels that
 * miss the real buckets by an hour and zero out a whole day's takings.
 */
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = d.getUTCDay() || 7;          // Monday = 1 … Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNumber);  // the Thursday names the week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 864e5 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function bucketKey(date, groupBy) {
  const iso = date.toISOString();
  switch (groupBy) {
    case 'hour':  return `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00`;
    case 'week':  return isoWeekKey(date);
    case 'month': return iso.slice(0, 7);
    case 'year':  return iso.slice(0, 4);
    default:      return iso.slice(0, 10);
  }
}

/**
 * The start of the bucket this instant falls in, in UTC.
 *
 * The window starts at local midnight, which is mid-bucket in UTC. Walking
 * from there in 24h steps stays permanently offset and never reaches today's
 * UTC bucket, so a week chart would stop at yesterday whenever today had no
 * sales of its own to append.
 */
const bucketStart = (date, groupBy) => {
  const d = new Date(date);
  if (groupBy === 'hour') { d.setUTCMinutes(0, 0, 0); return d; }
  d.setUTCHours(0, 0, 0, 0);
  if (groupBy === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 1));
  if (groupBy === 'month') d.setUTCDate(1);
  if (groupBy === 'year') { d.setUTCMonth(0); d.setUTCDate(1); }
  return d;
};

const advance = (date, groupBy) => {
  const d = new Date(date);
  if (groupBy === 'hour') d.setUTCHours(d.getUTCHours() + 1);
  else if (groupBy === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else if (groupBy === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (groupBy === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCDate(d.getUTCDate() + 1);
  return d;
};

/**
 * Every bucket in the window, in order, with the quiet ones at zero.
 *
 * A series straight out of $group omits periods with no rows, so a line chart
 * would join 19 August to 25 August as though they were consecutive and hide
 * the five dead days between them. The existing /dashboard/charts fills zeros
 * for exactly this reason; these charts do the same.
 */
function fillBuckets(win, rows, fields, groupBy = win.groupBy) {
  const byKey = new Map(rows.map((r) => [r.date, r]));
  const blank = Object.fromEntries(fields.map((f) => [f, 0]));
  const out = [];

  let cursor = bucketStart(win.from, groupBy);
  // A guard, not a policy: any real window produces far fewer buckets than
  // this, and an unbounded loop here would hang the request.
  for (let i = 0; i < 2000 && cursor <= win.to; i++) {
    const key = bucketKey(cursor, groupBy);
    if (!out.length || out[out.length - 1].date !== key) {
      out.push({ date: key, ...blank, ...(byKey.get(key) || {}) });
    }
    cursor = advance(cursor, groupBy);
  }

  // Anything the walk missed (a row on the very edge of the window) is kept
  // rather than silently dropped — the total must never shrink to fit a chart.
  const covered = new Set(out.map((o) => o.date));
  for (const row of rows) if (!covered.has(row.date)) out.push(row);

  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** Fold two `{_id, ...}` bucket lists into one sorted series. */
function mergeSeries(a, b, fields) {
  const out = new Map();
  for (const row of [...a, ...b]) {
    const current =
      out.get(row._id) || { date: row._id, ...Object.fromEntries(fields.map((f) => [f, 0])) };
    for (const field of fields) current[field] += row[field] || 0;
    out.set(row._id, current);
  }
  return [...out.values()].sort((x, y) => String(x.date).localeCompare(String(y.date)));
}

/** The window echoed back, so a screen can label exactly what it is showing. */
const windowPayload = (win) => ({
  period: win.period,
  groupBy: win.groupBy,
  startDate: win.from.toISOString(),
  endDate: win.to.toISOString(),
  comparedWith: {
    startDate: win.previous.from.toISOString(),
    endDate: win.previous.to.toISOString(),
  },
});

// ═══════════════════════════════════════════════════════════
// 1. SALES
// ═══════════════════════════════════════════════════════════

/**
 * GET /dashboards/sales?period=&startDate=&endDate=&merchantId=
 *
 * Revenue is Order + PosInvoice, as everywhere else in the admin API.
 */
router.get('/sales', canAnalyse, async (req, res) => {
  try {
    const win = dashboardWindow(req.query);
    const scope = merchantScope(req.query);

    const totalsGroup = (amountField) => ({
      $group: { _id: null, revenue: { $sum: amountField }, orders: { $sum: 1 } },
    });

    const seriesGroup = (amountField, format) => ({
      $group: {
        _id: { $dateToString: { format, date: '$createdAt' } },
        value: { $sum: amountField },
        orders: { $sum: 1 },
      },
    });

    const [
      orderTotals, posTotals,
      prevOrderTotals, prevPosTotals,
      orderSeries, posSeries,
      orderDaily, posDaily,
      productLines, posProductLines,
      orderMerchants, posMerchants,
      recentOrders, recentSales,
    ] = await Promise.all([
      Order.aggregate([{ $match: orderRevenue(win, scope) }, totalsGroup('$totalAmount')]),
      PosInvoice.aggregate([{ $match: posRevenue(win, scope) }, totalsGroup('$total')]),
      Order.aggregate([{ $match: previousOrderRevenue(win, scope) }, totalsGroup('$totalAmount')]),
      PosInvoice.aggregate([{ $match: previousPosRevenue(win, scope) }, totalsGroup('$total')]),

      Order.aggregate([{ $match: orderRevenue(win, scope) }, seriesGroup('$totalAmount', win.format)]),
      PosInvoice.aggregate([{ $match: posRevenue(win, scope) }, seriesGroup('$total', win.format)]),

      // The daily trend is always per-day regardless of the chart's chosen
      // granularity, so a year view still has a usable sparkline underneath.
      Order.aggregate([{ $match: orderRevenue(win, scope) }, seriesGroup('$totalAmount', FORMATS.day)]),
      PosInvoice.aggregate([{ $match: posRevenue(win, scope) }, seriesGroup('$total', FORMATS.day)]),

      // Grouped by product id, falling back to the line's own name when the
      // id is missing. Collapsing every id-less line into one bucket — which
      // is what grouping on a null id does — invents a single fictional
      // product holding the summed revenue of several real ones, and it
      // lands at the top of the ranking because it is the sum of many.
      Order.aggregate([
        { $match: orderRevenue(win, scope) },
        { $unwind: '$items' },
        {
          $group: {
            _id: {
              $ifNull: [
                { $toString: '$items.productId' },
                { $concat: ['name:', { $ifNull: ['$items.item_name', ''] }] },
              ],
            },
            name: { $last: '$items.item_name' },
            sales: { $sum: '$items.quantity' },
            revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
          },
        },
      ]),
      PosInvoice.aggregate([
        { $match: posRevenue(win, scope) },
        { $unwind: '$items' },
        {
          $group: {
            _id: {
              $ifNull: [
                { $toString: '$items.productId' },
                { $concat: ['name:', { $ifNull: ['$items.name', ''] }] },
              ],
            },
            name: { $last: '$items.name' },
            sales: { $sum: '$items.quantity' },
            revenue: { $sum: '$items.lineTotal' },
          },
        },
      ]),

      // Both revenue sources, as everywhere else. Ranking merchants on online
      // orders alone would leave one who sells mostly over the counter absent
      // from a list that sits directly under a total which counted them.
      Order.aggregate([
        { $match: orderRevenue(win, { ...scope, merchantId: { $ne: null } }) },
        { $group: { _id: '$merchantId', revenue: { $sum: '$totalAmount' }, orders: { $sum: 1 } } },
      ]),
      PosInvoice.aggregate([
        { $match: posRevenue(win, { ...scope, merchantId: { $ne: null } }) },
        { $group: { _id: '$merchantId', revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      ]),

      Order.find(inWindow(win, scope))
        .sort({ createdAt: -1 }).limit(10)
        .populate('userId', 'fullName')
        .populate('merchantId', 'storeName fullName')
        .select('orderNumber totalAmount status createdAt userId merchantId')
        .lean(),
      // Counter sales are orders too as far as an operator is concerned, so
      // the "recent orders" table shows both rather than hiding half the day.
      PosInvoice.find(inWindow(win, scope))
        .sort({ createdAt: -1 }).limit(10)
        .populate('merchantId', 'storeName fullName')
        .select('invoiceNumber total status createdAt customerName merchantId')
        .lean(),
    ]);

    const o = orderTotals[0] || { revenue: 0, orders: 0 };
    const p = posTotals[0] || { revenue: 0, orders: 0 };
    const po = prevOrderTotals[0] || { revenue: 0, orders: 0 };
    const pp = prevPosTotals[0] || { revenue: 0, orders: 0 };

    const totalRevenue = round(o.revenue + p.revenue);
    const totalOrders = o.orders + p.orders;
    const previousRevenue = round(po.revenue + pp.revenue);
    const previousOrders = po.orders + pp.orders;
    const averageOrderValue = totalOrders ? round(totalRevenue / totalOrders) : 0;
    const previousAov = previousOrders ? round(previousRevenue / previousOrders) : 0;

    const products = new Map();
    // Lines carrying neither a product id nor a name cannot be attributed to
    // anything. Their money is reported as its own figure rather than either
    // dropped from the totals or dressed up as a product.
    let unattributedRevenue = 0;
    let unattributedUnits = 0;

    for (const row of [...productLines, ...posProductLines]) {
      const key = String(row._id);
      if (key === 'name:') {
        unattributedRevenue += row.revenue || 0;
        unattributedUnits += row.sales || 0;
        continue;
      }
      const namedOnly = key.startsWith('name:');
      const current = products.get(key) || {
        productId: namedOnly ? null : key,
        name: namedOnly ? key.slice(5) : row.name || '',
        sales: 0,
        revenue: 0,
      };
      current.sales += row.sales || 0;
      current.revenue += row.revenue || 0;
      if (row.name) current.name = row.name;
      products.set(key, current);
    }

    // Older order lines predate item names being stored, so the top seller can
    // come back blank. Fill from the catalogue rather than printing "Unnamed"
    // against the largest revenue row.
    const unnamed = [...products.values()]
      .filter((r) => !r.name && r.productId)
      .map((r) => r.productId)
      .filter(isValidId);
    if (unnamed.length) {
      const named = await Product.find({ _id: { $in: unnamed } }).select('name').lean();
      for (const doc of named) {
        const row = products.get(String(doc._id));
        if (row) row.name = doc.name;
      }
    }

    const merchantTotals = new Map();
    for (const row of [...orderMerchants, ...posMerchants]) {
      const key = String(row._id);
      const acc = merchantTotals.get(key) || { merchantId: key, revenue: 0, orders: 0 };
      acc.revenue += row.revenue || 0;
      acc.orders += row.orders || 0;
      merchantTotals.set(key, acc);
    }

    const rankedMerchants = [...merchantTotals.values()]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const merchantDocs = await User.find({
      _id: { $in: rankedMerchants.map((m) => m.merchantId).filter(isValidId) },
    })
      .select('storeName fullName')
      .lean();
    const merchantNames = new Map(
      merchantDocs.map((d) => [String(d._id), d.storeName || d.fullName])
    );

    const topProducts = [...products.values()]
      .map((r) => ({ ...r, name: r.name || 'Unnamed product', revenue: round(r.revenue) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const recent = [
      ...recentOrders.map((r) => ({
        _id: r._id,
        source: 'online',
        reference: r.orderNumber,
        amount: round(r.totalAmount),
        status: r.status,
        createdAt: r.createdAt,
        customerName: r.userId ? r.userId.fullName : '',
        merchantName: r.merchantId ? r.merchantId.storeName || r.merchantId.fullName : '',
      })),
      ...recentSales.map((r) => ({
        _id: r._id,
        source: 'pos',
        reference: r.invoiceNumber,
        amount: round(r.total),
        status: r.status,
        createdAt: r.createdAt,
        customerName: r.customerName || 'Walk-in',
        merchantName: r.merchantId ? r.merchantId.storeName || r.merchantId.fullName : '',
      })),
    ]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10);

    res.json({
      success: true,
      message: 'Sales dashboard',
      data: {
        window: windowPayload(win),
        totalRevenue,
        totalOrders,
        averageOrderValue,
        onlineRevenue: round(o.revenue),
        posRevenue: round(p.revenue),

        // There is no visitor or session tracking anywhere in this platform,
        // so orders-over-visitors has no denominator to compute. Reported as
        // untracked rather than as a plausible-looking invented percentage.
        conversionRate: null,
        conversionRateNote:
          'Not tracked — the platform records no visitor or session data to divide orders by.',

        previous: {
          totalRevenue: previousRevenue,
          totalOrders: previousOrders,
          averageOrderValue: previousAov,
        },
        change: {
          totalRevenue: changeVs(totalRevenue, previousRevenue),
          totalOrders: changeVs(totalOrders, previousOrders),
          averageOrderValue: changeVs(averageOrderValue, previousAov),
        },

        salesChart: fillBuckets(
          win,
          mergeSeries(orderSeries, posSeries, ['value', 'orders']),
          ['value', 'orders']
        ).map((s) => ({ date: s.date, value: round(s.value), orders: s.orders })),
        dailyTrend: fillBuckets(
          win,
          mergeSeries(orderDaily, posDaily, ['value', 'orders']),
          ['value', 'orders'],
          'day'
        ).map((s) => ({ date: s.date, value: round(s.value), orders: s.orders })),

        topProducts,
        // What the ranking above does not cover, so a total that does not
        // reconcile has a stated reason instead of looking like a rounding bug.
        unattributedRevenue: round(unattributedRevenue),
        unattributedUnits,

        topMerchants: rankedMerchants.map((m) => ({
          merchantId: m.merchantId,
          name: merchantNames.get(m.merchantId) || 'Deleted merchant',
          revenue: round(m.revenue),
          orders: m.orders,
        })),
        recentOrders: recent,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// 2. OPERATIONS
// ═══════════════════════════════════════════════════════════

// The statuses that mean "somebody is working on it right now".
const IN_PROGRESS_STATUSES = ['confirmed', 'processing', 'ready', 'handover'];

/** GET /dashboards/operations — the queue, the clock and the stock backlog. */
router.get('/operations', canOperate, async (req, res) => {
  try {
    const win = dashboardWindow(req.query);
    const scope = merchantScope(req.query);
    const range = inWindow(win, scope);

    const [
      byStatus, fulfilment, prevFulfilment,
      lowStock, outOfStock, lowStockList,
      recentActivity, unpaid,
    ] = await Promise.all([
      Order.aggregate([
        { $match: range },
        { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$totalAmount' } } },
        { $sort: { count: -1 } },
      ]),
      // Averaged only over orders that actually carry a deliveredAt. An order
      // still in flight has none, and counting it as zero minutes would
      // flatter the figure exactly when the queue is worst.
      Order.aggregate([
        { $match: inWindow(win, { ...scope, deliveredAt: { $ne: null } }) },
        {
          $group: {
            _id: null,
            minutes: { $avg: { $divide: [{ $subtract: ['$deliveredAt', '$createdAt'] }, 60000] } },
            count: { $sum: 1 },
          },
        },
      ]),
      Order.aggregate([
        { $match: inPrevious(win, { ...scope, deliveredAt: { $ne: null } }) },
        {
          $group: {
            _id: null,
            minutes: { $avg: { $divide: [{ $subtract: ['$deliveredAt', '$createdAt'] }, 60000] } },
            count: { $sum: 1 },
          },
        },
      ]),

      // A low-stock line is at or under its own threshold, so the comparison
      // is field-to-field rather than against one platform-wide constant.
      Stock.countDocuments({ ...scope, $expr: { $lte: ['$currentStock', '$lowStockThreshold'] } }),
      Stock.countDocuments({ ...scope, currentStock: { $lte: 0 } }),
      Stock.find({ ...scope, $expr: { $lte: ['$currentStock', '$lowStockThreshold'] } })
        .sort({ currentStock: 1 }).limit(10)
        .populate('merchantId', 'storeName fullName')
        .select('name category location currentStock lowStockThreshold merchantId')
        .lean(),

      // No audit trail exists for status transitions, so "recent activity" is
      // the orders touched most recently, showing where they landed — not a
      // per-change history this system never recorded.
      Order.find(scope)
        .sort({ updatedAt: -1 }).limit(10)
        .populate('merchantId', 'storeName fullName')
        .select('orderNumber status totalAmount updatedAt createdAt merchantId')
        .lean(),

      Order.countDocuments(inWindow(win, { ...scope, paymentStatus: { $ne: 'paid' } })),
    ]);

    const countOf = (statuses) =>
      byStatus.filter((s) => statuses.includes(s._id)).reduce((sum, s) => sum + s.count, 0);

    const total = byStatus.reduce((sum, s) => sum + s.count, 0);
    const cancelledOrders = countOf(CANCELLED_STATUSES);
    const f = fulfilment[0] || null;
    const pf = prevFulfilment[0] || null;

    res.json({
      success: true,
      message: 'Operations dashboard',
      data: {
        window: windowPayload(win),

        totalOrders: total,
        pendingOrders: countOf(['pending']),
        inProgressOrders: countOf(IN_PROGRESS_STATUSES),
        completedOrders: countOf(REVENUE_STATUSES),
        cancelledOrders,
        cancellationRate: total ? round((cancelledOrders / total) * 100) : 0,
        unpaidOrders: unpaid,

        orderStatusDistribution: byStatus.map((s) => ({
          status: s._id || 'unknown',
          count: s.count,
          value: round(s.value),
        })),

        // Null rather than 0 when nothing was delivered in the window: "no
        // completed deliveries to measure" and "instant fulfilment" are not
        // the same answer.
        averageFulfillmentTime: f ? round(f.minutes / 60) : null,
        averageFulfillmentMinutes: f ? round(f.minutes) : null,
        fulfillmentSampleSize: f ? f.count : 0,
        previous: {
          averageFulfillmentTime: pf ? round(pf.minutes / 60) : null,
          fulfillmentSampleSize: pf ? pf.count : 0,
        },
        change: {
          averageFulfillmentTime:
            f && pf ? changeVs(f.minutes, pf.minutes) : null,
        },

        lowStockItems: lowStock,
        outOfStockItems: outOfStock,
        lowStockList: lowStockList.map((s) => ({
          _id: s._id,
          name: s.name,
          category: s.category,
          location: s.location,
          currentStock: s.currentStock,
          lowStockThreshold: s.lowStockThreshold,
          merchantName: s.merchantId
            ? s.merchantId.storeName || s.merchantId.fullName
            : 'Unknown',
        })),

        recentActivity: recentActivity.map((o) => ({
          _id: o._id,
          reference: o.orderNumber,
          status: o.status,
          amount: round(o.totalAmount),
          updatedAt: o.updatedAt,
          createdAt: o.createdAt,
          merchantName: o.merchantId
            ? o.merchantId.storeName || o.merchantId.fullName
            : '',
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// 3. FINANCE
// ═══════════════════════════════════════════════════════════

/**
 * Unwind to line level and join each line to its product for the cost.
 * `productId` is Mixed on Order items, so the join matches on the string form.
 */
const costedLineStages = () => [
  { $unwind: '$items' },
  {
    $lookup: {
      from: 'products',
      let: { pid: { $toString: '$items.productId' } },
      pipeline: [
        { $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$pid'] } } },
        { $project: { costPrice: 1 } },
      ],
      as: 'product',
    },
  },
  { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
];

/**
 * Group costed lines into revenue / costed revenue / cost.
 *
 * Only lines whose product has a cost recorded contribute to `costedRevenue`
 * and `cost`, so the profit below is a matched pair. Product.costPrice
 * defaults to 0 meaning "not recorded", and treating those as free goods
 * would show 100% margin on every legacy sale.
 */
const profitGroup = (revenueExpr, bucket) => ({
  $group: {
    _id: bucket,
    revenue: { $sum: revenueExpr },
    costedRevenue: { $sum: { $cond: [{ $gt: ['$product.costPrice', 0] }, revenueExpr, 0] } },
    cost: {
      $sum: {
        $cond: [
          { $gt: ['$product.costPrice', 0] },
          { $multiply: ['$product.costPrice', '$items.quantity'] },
          0,
        ],
      },
    },
  },
});

const ORDER_LINE_REVENUE = { $multiply: ['$items.price', '$items.quantity'] };
const POS_LINE_REVENUE = '$items.lineTotal';

/** GET /dashboards/finance — revenue, margin, commission and payouts. */
router.get('/finance', canAnalyse, async (req, res) => {
  try {
    const win = dashboardWindow(req.query);
    const scope = merchantScope(req.query);
    const bucket = { $dateToString: { format: win.format, date: '$createdAt' } };

    const [
      orderProfitSeries, posProfitSeries,
      orderProfitTotal, posProfitTotal,
      prevOrderProfit, prevPosProfit,
      orderByMerchant, posByMerchant,
      merchants,
      pendingPayouts, recentPayouts, paidPayouts,
    ] = await Promise.all([
      Order.aggregate([
        { $match: orderRevenue(win, scope) },
        ...costedLineStages(),
        profitGroup(ORDER_LINE_REVENUE, bucket),
      ]),
      PosInvoice.aggregate([
        { $match: posRevenue(win, scope) },
        ...costedLineStages(),
        profitGroup(POS_LINE_REVENUE, bucket),
      ]),
      Order.aggregate([
        { $match: orderRevenue(win, scope) },
        ...costedLineStages(),
        profitGroup(ORDER_LINE_REVENUE, null),
      ]),
      PosInvoice.aggregate([
        { $match: posRevenue(win, scope) },
        ...costedLineStages(),
        profitGroup(POS_LINE_REVENUE, null),
      ]),
      Order.aggregate([
        { $match: previousOrderRevenue(win, scope) },
        ...costedLineStages(),
        profitGroup(ORDER_LINE_REVENUE, null),
      ]),
      PosInvoice.aggregate([
        { $match: previousPosRevenue(win, scope) },
        ...costedLineStages(),
        profitGroup(POS_LINE_REVENUE, null),
      ]),

      Order.aggregate([
        { $match: orderRevenue(win, { ...scope, merchantId: { $ne: null } }) },
        { $group: { _id: '$merchantId', revenue: { $sum: '$totalAmount' }, orders: { $sum: 1 } } },
      ]),
      PosInvoice.aggregate([
        { $match: posRevenue(win, scope) },
        { $group: { _id: '$merchantId', revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      ]),

      User.find({ role: 'merchant' })
        .select('storeName fullName storeCategory commissionRate')
        .lean(),

      Payout.aggregate([
        { $match: { status: 'pending' } },
        { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Payout.find({})
        .sort({ createdAt: -1 }).limit(10)
        .populate('merchantId', 'storeName fullName')
        .select('amount status createdAt processedAt merchantId')
        .lean(),
      Payout.aggregate([
        { $match: inWindow(win, { status: 'paid' }) },
        { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
    ]);

    const sumProfit = (rows) =>
      rows.reduce(
        (acc, r) => ({
          revenue: acc.revenue + (r.revenue || 0),
          costedRevenue: acc.costedRevenue + (r.costedRevenue || 0),
          cost: acc.cost + (r.cost || 0),
        }),
        { revenue: 0, costedRevenue: 0, cost: 0 }
      );

    const current = sumProfit([...orderProfitTotal, ...posProfitTotal]);
    const before = sumProfit([...prevOrderProfit, ...prevPosProfit]);

    const totalRevenue = round(current.revenue);
    const costedRevenue = round(current.costedRevenue);
    const totalProfit = round(costedRevenue - current.cost);
    const previousProfit = round(before.costedRevenue - before.cost);

    // Commission per merchant from that merchant's own rate, then folded up by
    // store category. A merchant on the default 0% contributes nothing, and
    // the count of those is returned so a small total reads as "rates were
    // never set" rather than as a bad month.
    const info = new Map(
      merchants.map((m) => [
        String(m._id),
        {
          name: m.storeName || m.fullName || 'Unknown',
          category: m.storeCategory || 'Uncategorised',
          rate: m.commissionRate || 0,
        },
      ])
    );

    const perMerchant = new Map();
    for (const row of [...orderByMerchant, ...posByMerchant]) {
      const key = String(row._id);
      const acc = perMerchant.get(key) || { revenue: 0, orders: 0 };
      acc.revenue += row.revenue || 0;
      acc.orders += row.orders || 0;
      perMerchant.set(key, acc);
    }

    const byCategory = new Map();
    let totalCommissions = 0;
    let merchantsOnZeroRate = 0;
    for (const [merchantId, totals] of perMerchant) {
      const meta = info.get(merchantId) || { category: 'Uncategorised', rate: 0 };
      const commission = totals.revenue * (meta.rate / 100);
      totalCommissions += commission;
      if (meta.rate === 0) merchantsOnZeroRate++;
      const acc = byCategory.get(meta.category) || { category: meta.category, amount: 0, revenue: 0, merchants: 0 };
      acc.amount += commission;
      acc.revenue += totals.revenue;
      acc.merchants += 1;
      byCategory.set(meta.category, acc);
    }

    const pending = pendingPayouts[0] || { amount: 0, count: 0 };
    const paid = paidPayouts[0] || { amount: 0, count: 0 };

    res.json({
      success: true,
      message: 'Finance dashboard',
      data: {
        window: windowPayload(win),

        totalRevenue,
        totalProfit,
        totalCommissions: round(totalCommissions),
        pendingPayouts: round(pending.amount),
        pendingPayoutCount: pending.count,
        paidPayouts: round(paid.amount),
        paidPayoutCount: paid.count,

        // How much of the revenue the margin was actually computed over. Read
        // `margin` only as far as this number allows — at 12% coverage it is
        // a statement about 12% of the business.
        costedRevenue,
        costCoverage: totalRevenue ? round((costedRevenue / totalRevenue) * 100) : 0,
        margin: costedRevenue ? round((totalProfit / costedRevenue) * 100) : 0,
        merchantsOnZeroRate,

        previous: {
          totalRevenue: round(before.revenue),
          totalProfit: previousProfit,
        },
        change: {
          totalRevenue: changeVs(totalRevenue, before.revenue),
          totalProfit: changeVs(totalProfit, previousProfit),
        },

        revenueChart: fillBuckets(
          win,
          mergeSeries(orderProfitSeries, posProfitSeries, ['revenue']),
          ['revenue']
        ).map((s) => ({ date: s.date, value: round(s.revenue) })),
        profitChart: fillBuckets(
          win,
          mergeSeries(orderProfitSeries, posProfitSeries, ['costedRevenue', 'cost']),
          ['costedRevenue', 'cost']
        ).map((s) => ({ date: s.date, value: round(s.costedRevenue - s.cost) })),

        commissionBreakdown: [...byCategory.values()]
          .map((c) => ({
            category: c.category,
            amount: round(c.amount),
            revenue: round(c.revenue),
            merchants: c.merchants,
          }))
          .sort((a, b) => b.amount - a.amount),

        recentPayouts: recentPayouts.map((p) => ({
          _id: p._id,
          amount: round(p.amount),
          status: p.status,
          createdAt: p.createdAt,
          processedAt: p.processedAt,
          merchantName: p.merchantId
            ? p.merchantId.storeName || p.merchantId.fullName
            : 'Unknown',
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// 4. MARKETING
// ═══════════════════════════════════════════════════════════

/** GET /dashboards/marketing — acquisition, engagement and retention. */
router.get('/marketing', canAnalyse, async (req, res) => {
  try {
    const win = dashboardWindow(req.query);

    const [
      totals, newCustomers, prevNewCustomers,
      growth,
      activeIds, previousActiveIds,
      lifetimeSpend,
      topSpenders,
    ] = await Promise.all([
      User.aggregate([
        { $match: { role: 'customer' } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            enabled: { $sum: { $cond: ['$isActive', 1, 0] } },
            verified: { $sum: { $cond: ['$isVerified', 1, 0] } },
          },
        },
      ]),
      User.countDocuments(inWindow(win, { role: 'customer' })),
      User.countDocuments(inPrevious(win, { role: 'customer' })),

      User.aggregate([
        { $match: inWindow(win, { role: 'customer' }) },
        { $group: { _id: { $dateToString: { format: win.format, date: '$createdAt' } }, value: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),

      Order.distinct('userId', orderRevenue(win)),
      Order.distinct('userId', previousOrderRevenue(win)),

      // Lifetime, not windowed: whether someone is a repeat customer is a
      // property of their whole history, not of the 30 days being looked at.
      Order.aggregate([
        { $match: { status: { $in: REVENUE_STATUSES } } },
        {
          $group: {
            _id: '$userId',
            spent: { $sum: '$totalAmount' },
            orders: { $sum: 1 },
            lastOrder: { $max: '$createdAt' },
          },
        },
      ]),

      Order.aggregate([
        { $match: orderRevenue(win, { userId: { $ne: null } }) },
        { $group: { _id: '$userId', spent: { $sum: '$totalAmount' }, orders: { $sum: 1 } } },
        { $sort: { spent: -1 } },
        { $limit: 10 },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'customer' } },
        { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            spent: 1, orders: 1,
            name: '$customer.fullName',
            email: '$customer.email',
          },
        },
      ]),
    ]);

    const t = totals[0] || { total: 0, enabled: 0, verified: 0 };

    const activeCustomers = activeIds.length;
    const previousActive = previousActiveIds.length;

    const buyers = lifetimeSpend.length;
    const repeatBuyers = lifetimeSpend.filter((s) => s.orders > 1).length;
    const totalOrdersEver = lifetimeSpend.reduce((sum, s) => sum + s.orders, 0);
    const totalSpentEver = lifetimeSpend.reduce((sum, s) => sum + s.spent, 0);

    // Churn, stated as a definition rather than a bare percentage: of the
    // customers who bought in the previous window, the share that did not buy
    // in this one. Null when nobody bought in the baseline — there is no
    // churn rate out of an empty cohort, and 0% would read as perfect
    // retention.
    const activeSet = new Set(activeIds.map(String));
    const churned = previousActiveIds.filter((id) => !activeSet.has(String(id))).length;
    const churnRate = previousActive ? round((churned / previousActive) * 100) : null;

    const activeIdSet = activeSet;
    const lapsed = lifetimeSpend.filter((s) => !activeIdSet.has(String(s._id))).length;

    res.json({
      success: true,
      message: 'Marketing dashboard',
      data: {
        window: windowPayload(win),

        totalCustomers: t.total,
        newCustomers,
        activeCustomers,
        verifiedCustomers: t.verified,
        enabledCustomers: t.enabled,

        churnRate,
        churnedCustomers: churned,
        churnBaseline: previousActive,
        churnDefinition:
          'Customers who bought in the previous period and did not buy in this one.',

        previous: {
          newCustomers: prevNewCustomers,
          activeCustomers: previousActive,
        },
        change: {
          newCustomers: changeVs(newCustomers, prevNewCustomers),
          activeCustomers: changeVs(activeCustomers, previousActive),
        },

        customerGrowthChart: fillBuckets(
          win,
          growth.map((g) => ({ date: g._id, value: g.value })),
          ['value']
        ),

        // Every customer lands in exactly one segment, so the pie sums to the
        // customer count instead of double-counting anyone.
        customerSegments: [
          { segment: 'Active', count: activeCustomers },
          { segment: 'Lapsed', count: lapsed },
          { segment: 'Never bought', count: Math.max(t.total - buyers, 0) },
        ],

        engagementMetrics: {
          ordersPerCustomer: buyers ? round(totalOrdersEver / buyers) : 0,
          repeatRate: buyers ? round((repeatBuyers / buyers) * 100) : 0,
          lifetimeValue: buyers ? round(totalSpentEver / buyers) : 0,
          buyers,
          repeatBuyers,
          // Buyers as a share of all customers. The honest denominator for a
          // conversion figure in a platform with no visitor tracking.
          buyerRate: t.total ? round((buyers / t.total) * 100) : 0,
        },

        topCustomers: topSpenders.map((s) => ({
          userId: s._id,
          name: s.name || 'Deleted account',
          email: s.email || '',
          orders: s.orders,
          spent: round(s.spent),
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// 5. MERCHANTS
// ═══════════════════════════════════════════════════════════

/** GET /dashboards/merchants — roster, rankings and performance. */
router.get('/merchants', canAnalyse, async (req, res) => {
  try {
    const win = dashboardWindow(req.query);

    const [
      roster, pendingApprovals, growth,
      byCategory,
      orderPerformance, posPerformance,
      ratings,
      newMerchants, prevNewMerchants,
      unattributedOrderRows, unattributedPosRows,
    ] = await Promise.all([
      User.aggregate([
        { $match: { role: 'merchant' } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            active: { $sum: { $cond: ['$isActive', 1, 0] } },
          },
        },
      ]),
      BusinessRegistration.countDocuments({ status: { $in: ['pending', 'under_review'] } }),
      User.aggregate([
        { $match: inWindow(win, { role: 'merchant' }) },
        { $group: { _id: { $dateToString: { format: win.format, date: '$createdAt' } }, value: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      User.aggregate([
        { $match: { role: 'merchant' } },
        { $group: { _id: '$storeCategory', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),

      Order.aggregate([
        { $match: inWindow(win, { merchantId: { $ne: null } }) },
        {
          $group: {
            _id: '$merchantId',
            orders: { $sum: { $cond: [{ $in: ['$status', REVENUE_STATUSES] }, 1, 0] } },
            allOrders: { $sum: 1 },
            revenue: { $sum: { $cond: [{ $in: ['$status', REVENUE_STATUSES] }, '$totalAmount', 0] } },
            cancelled: { $sum: { $cond: [{ $in: ['$status', CANCELLED_STATUSES] }, 1, 0] } },
          },
        },
      ]),
      PosInvoice.aggregate([
        { $match: posRevenue(win) },
        { $group: { _id: '$merchantId', orders: { $sum: 1 }, revenue: { $sum: '$total' } } },
      ]),

      // Ratings are lifetime, not windowed: a merchant's score is a property
      // of their whole history, and scoping it to 30 days would show most of
      // the roster as unrated. `ratedOrders` travels with it so a 5.0 from a
      // single rating is visibly that.
      Order.aggregate([
        { $match: { merchantId: { $ne: null }, rating: { $gt: 0 } } },
        { $group: { _id: '$merchantId', rating: { $avg: '$rating' }, ratedOrders: { $sum: 1 } } },
      ]),

      User.countDocuments(inWindow(win, { role: 'merchant' })),
      User.countDocuments(inPrevious(win, { role: 'merchant' })),

      // The exact complement of the `merchantId: { $ne: null }` match above —
      // in Mongo, `{ field: null }` matches both an explicit null and a
      // missing field, so between them the two cover every order in the
      // window. Revenue that belongs to no merchant cannot appear in a
      // per-merchant ranking, but dropping it silently is what makes this
      // board's total disagree with the sales board's for the same window.
      Order.aggregate([
        { $match: orderRevenue(win, { merchantId: null }) },
        { $group: { _id: null, revenue: { $sum: '$totalAmount' }, orders: { $sum: 1 } } },
      ]),
      PosInvoice.aggregate([
        { $match: posRevenue(win, { merchantId: null }) },
        { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      ]),
    ]);

    const combined = new Map();
    const absorb = (rows) => {
      for (const row of rows) {
        const key = String(row._id);
        const acc = combined.get(key) || {
          merchantId: key, revenue: 0, orders: 0, allOrders: 0, cancelled: 0,
        };
        acc.revenue += row.revenue || 0;
        acc.orders += row.orders || 0;
        acc.allOrders += row.allOrders || row.orders || 0;
        acc.cancelled += row.cancelled || 0;
        combined.set(key, acc);
      }
    };
    absorb(orderPerformance);
    absorb(posPerformance);

    const ratingById = new Map(
      ratings.map((r) => [String(r._id), { rating: round(r.rating), ratedOrders: r.ratedOrders }])
    );

    const ids = [...combined.keys()].filter(isValidId);
    const docs = await User.find({ _id: { $in: ids } })
      .select('storeName fullName storeCategory isActive commissionRate')
      .lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));

    const performance = [...combined.values()]
      .map((row) => {
        const doc = byId.get(row.merchantId);
        const rated = ratingById.get(row.merchantId) || { rating: null, ratedOrders: 0 };
        return {
          merchantId: row.merchantId,
          name: doc ? doc.storeName || doc.fullName : 'Deleted merchant',
          category: (doc && doc.storeCategory) || 'Uncategorised',
          isActive: doc ? doc.isActive !== false : false,
          revenue: round(row.revenue),
          orders: row.orders,
          cancelled: row.cancelled,
          cancellationRate: row.allOrders ? round((row.cancelled / row.allOrders) * 100) : 0,
          commissionRate: (doc && doc.commissionRate) || 0,
          // Null, not 0: an unrated merchant is not a badly rated one.
          rating: rated.rating,
          ratedOrders: rated.ratedOrders,
        };
      })
      .sort((a, b) => b.revenue - a.revenue);

    const r = roster[0] || { total: 0, active: 0 };
    const revenueTotal = round(performance.reduce((sum, m) => sum + m.revenue, 0));

    const unattributed = [...unattributedOrderRows, ...unattributedPosRows].reduce(
      (acc, row) => ({
        revenue: acc.revenue + (row.revenue || 0),
        orders: acc.orders + (row.orders || 0),
      }),
      { revenue: 0, orders: 0 }
    );

    res.json({
      success: true,
      message: 'Merchants dashboard',
      data: {
        window: windowPayload(win),

        totalMerchants: r.total,
        activeMerchants: r.active,
        inactiveMerchants: Math.max(r.total - r.active, 0),
        pendingApprovals,
        newMerchants,
        sellingMerchants: performance.filter((m) => m.revenue > 0).length,
        // Merchants on the books who sold nothing in the window — invisible in
        // any top-N ranking, and the more actionable half of the roster.
        idleMerchants: Math.max(r.total - performance.filter((m) => m.revenue > 0).length, 0),
        // Revenue attributable to a merchant. This is deliberately not the
        // same figure as the sales dashboard's totalRevenue, which counts
        // every sale; the difference is `unattributedRevenue` below, so the
        // two boards reconcile exactly instead of quietly disagreeing.
        totalRevenue: revenueTotal,
        unattributedRevenue: round(unattributed.revenue),
        unattributedOrders: unattributed.orders,

        previous: { newMerchants: prevNewMerchants },
        change: { newMerchants: changeVs(newMerchants, prevNewMerchants) },

        topMerchants: performance.slice(0, 10),
        merchantPerformance: performance.slice(0, 50),
        merchantGrowthChart: fillBuckets(
          win,
          growth.map((g) => ({ date: g._id, value: g.value })),
          ['value']
        ),
        merchantCategories: byCategory.map((c) => ({
          category: c._id || 'Uncategorised',
          count: c.count,
        })),
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
 * GET /dashboards/:name/export?format=csv
 *
 * Re-enters this router and serialises the table the screen is showing, so the
 * file and the dashboard can never drift into two answers for one question —
 * the same trick the reports export uses.
 */
const EXPORTS = {
  sales: {
    section: 'topProducts',
    columns: [
      { key: 'name', label: 'Product' },
      { key: 'sales', label: 'Units sold' },
      { key: 'revenue', label: 'Revenue (TND)' },
    ],
  },
  operations: {
    section: 'orderStatusDistribution',
    columns: [
      { key: 'status', label: 'Status' },
      { key: 'count', label: 'Orders' },
      { key: 'value', label: 'Value (TND)' },
    ],
  },
  finance: {
    section: 'commissionBreakdown',
    columns: [
      { key: 'category', label: 'Category' },
      { key: 'merchants', label: 'Merchants' },
      { key: 'revenue', label: 'Revenue (TND)' },
      { key: 'amount', label: 'Commission (TND)' },
    ],
  },
  marketing: {
    section: 'topCustomers',
    columns: [
      { key: 'name', label: 'Customer' },
      { key: 'email', label: 'Email' },
      { key: 'orders', label: 'Orders' },
      { key: 'spent', label: 'Spend in period (TND)' },
    ],
  },
  merchants: {
    section: 'merchantPerformance',
    columns: [
      { key: 'name', label: 'Merchant' },
      { key: 'category', label: 'Category' },
      { key: 'orders', label: 'Orders' },
      { key: 'revenue', label: 'Revenue (TND)' },
      { key: 'rating', label: 'Rating' },
      { key: 'cancellationRate', label: 'Cancellation rate (%)' },
    ],
  },
};

router.get('/:name/export', canExport, async (req, res) => {
  try {
    const name = String(req.params.name || '').toLowerCase();
    const spec = EXPORTS[name];
    if (!spec) {
      return res.status(400).json({
        success: false,
        message: `Unknown dashboard. Expected one of: ${Object.keys(EXPORTS).join(', ')}.`,
      });
    }

    const format = String(req.query.format || 'csv').toLowerCase();
    if (format !== 'csv') {
      // Said plainly rather than handing back a CSV with a .pdf name.
      return res.status(400).json({
        success: false,
        message: "Only CSV export is available. Use the browser's print view for PDF.",
      });
    }

    // Viewing the finance dashboard already requires reports.read; exporting
    // it must not be a way around that for someone holding only reports.export.
    if (name !== 'operations') {
      if (!hasPermission(req.admin, 'reports.read')) {
        return res.status(403).json({
          success: false,
          message: 'Your role does not allow this (reports.read required).',
        });
      }
    }

    const layer = router.stack.find(
      (l) => l.route && l.route.path === `/${name}`
    );
    if (!layer) {
      return res.status(500).json({ success: false, message: 'Dashboard not available.' });
    }

    let payload = null;
    const capture = {
      json: (body) => { payload = body; return capture; },
      status: () => capture,
    };
    const handlers = layer.route.stack;
    await handlers[handlers.length - 1].handle(req, capture, () => {});

    if (!payload || !payload.success) {
      return res.status(500).json({ success: false, message: 'Could not build the dashboard.' });
    }

    const rows = payload.data[spec.section] || [];
    const csv = toCsv(rows, spec.columns);
    const stamp = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vips-${name}-dashboard-${stamp}.csv"`);
    // A BOM so Excel reads Arabic merchant and product names as UTF-8 rather
    // than mojibake, which is the point of exporting for most operators.
    res.send('﻿' + csv);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
