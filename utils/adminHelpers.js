/**
 * Shared query helpers for the admin API.
 *
 * Extracted so routes/admin.js and routes/admin_reports.js compute revenue,
 * date ranges and pagination the same way — two copies of "which statuses
 * count as revenue" is exactly how two screens end up disagreeing about the
 * same number.
 */

const mongoose = require('mongoose');

// Which order statuses count as money actually earned. An order has exactly
// one status, so summing over both terminal states double-counts nothing:
// 'delivered' ends a delivery order, 'picked_up' ends a takeaway one.
const REVENUE_STATUSES = ['delivered', 'picked_up'];

// Both spellings are in the Order enum (historical drift), so any filter on
// "cancelled" has to cover both or it silently misses half the rows.
const CANCELLED_STATUSES = ['canceled', 'cancelled'];

const round = (n) => Number((Number(n) || 0).toFixed(3));

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const paginate = (query) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
};

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
};

/**
 * Build a `createdAt` filter from ?from=&to=.
 * Returns null when neither is usable, so callers can skip the key entirely.
 */
const dateRangeFilter = (query, field = 'createdAt') => {
  const range = {};
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;
  if (from && !isNaN(from)) range.$gte = from;
  if (to && !isNaN(to)) {
    // An inclusive end date: '2026-08-30' should cover all of that day.
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.to))) to.setHours(23, 59, 59, 999);
    range.$lte = to;
  }
  return Object.keys(range).length ? { [field]: range } : null;
};

/** The reporting window, defaulting to the last 30 days. */
const reportRange = (query, field = 'createdAt') =>
  dateRangeFilter(query, field) || { [field]: { $gte: daysAgo(29) } };

const GROUP_BY = ['day', 'week', 'month', 'year'];

/**
 * A `$dateToString` format for the requested granularity.
 *
 * Week uses ISO week numbering (%G-W%V) rather than %Y-%U: %U resets at the
 * start of January, so the last days of December and the first of January
 * would land in the same bucket label.
 */
const groupFormat = (groupBy) => {
  switch (groupBy) {
    case 'week':  return '%G-W%V';
    case 'month': return '%Y-%m';
    case 'year':  return '%Y';
    default:      return '%Y-%m-%d';
  }
};

const normaliseGroupBy = (value) =>
  GROUP_BY.includes(value) ? value : 'day';

/**
 * Turn an array of objects into CSV.
 *
 * Quotes every field and doubles embedded quotes, so a product name with a
 * comma or a quote in it cannot shift the remaining columns of that row.
 */
function toCsv(rows, columns) {
  const escape = (value) => {
    if (value === null || value === undefined) return '""';
    return `"${String(value).replace(/"/g, '""')}"`;
  };
  const header = columns.map((c) => escape(c.label)).join(',');
  const body = rows
    .map((row) => columns.map((c) => escape(row[c.key])).join(','))
    .join('\n');
  return `${header}\n${body}`;
}

module.exports = {
  REVENUE_STATUSES,
  CANCELLED_STATUSES,
  GROUP_BY,
  round,
  isValidId,
  escapeRegex,
  paginate,
  daysAgo,
  dateRangeFilter,
  reportRange,
  groupFormat,
  normaliseGroupBy,
  toCsv,
};
