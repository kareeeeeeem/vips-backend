/**
 * Formatting, with the units kept apart.
 *
 * The platform runs three quantities that all look like numbers on a screen:
 * dinars, loyalty points (100 = 1 TND) and club diamonds (10,000 = 1 TND).
 * Printing one in the shape of another overstates a balance by two orders of
 * magnitude, so every figure goes through a function that names its unit.
 * Mirrors lib/vips-backend/config/economics.js.
 */

export const POINTS_PER_TND = 100;
export const DIAMONDS_PER_TND = 10000;

const nf = (min, max) => new Intl.NumberFormat('en-US', {
  minimumFractionDigits: min,
  maximumFractionDigits: max,
});

const int = nf(0, 0);
const money3 = nf(3, 3);

/** A plain count: 1,204. */
export const number = (value) => int.format(Number(value) || 0);

/** Dinars, to the millime — the Tunisian dinar has three decimal places. */
export function tnd(value) {
  return `${money3.format(Number(value) || 0)} TND`;
}

/** Dinars without the unit, for a column that already says TND in its header. */
export const tndBare = (value) => money3.format(Number(value) || 0);

/** Loyalty points, always whole — the backend floors rather than crediting a fraction. */
export function points(value) {
  const n = Math.round(Number(value) || 0);
  return `${int.format(n)} pt${Math.abs(n) === 1 ? '' : 's'}`;
}

export const pointsBare = (value) => int.format(Math.round(Number(value) || 0));

/** Club diamonds. */
export const diamonds = (value) => `${int.format(Math.round(Number(value) || 0))} 💎`;

/** What a points balance is worth, for the tooltip beside it. */
export const pointsAsTnd = (value) => tnd((Number(value) || 0) / POINTS_PER_TND);

/** 12.5 -> "12.5%". */
export function percent(value, decimals = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${nf(0, decimals).format(n)}%`;
}

/** A large figure shortened for a stat tile: 12,400 -> "12.4K". */
export function compact(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return int.format(n);
}

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric',
});
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

const parse = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function date(value) {
  const d = parse(value);
  return d ? dateFmt.format(d) : '—';
}

export function dateTime(value) {
  const d = parse(value);
  return d ? dateTimeFmt.format(d) : '—';
}

/** "3 days ago" — for audit trails and "last seen" columns. */
export function ago(value) {
  const d = parse(value);
  if (!d) return '—';
  const seconds = Math.round((Date.now() - d.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const steps = [
    ['second', 60], ['minute', 60], ['hour', 24],
    ['day', 7], ['week', 4.35], ['month', 12], ['year', Infinity],
  ];
  let amount = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(amount) < size) return rtf.format(-Math.round(amount), unit);
    amount /= size;
  }
  return dateFmt.format(d);
}

/** yyyy-mm-dd, the form the API's ?from= and ?to= filters expect. */
export function isoDate(value) {
  const d = parse(value) || new Date();
  return d.toISOString().slice(0, 10);
}

/** yyyy-mm-dd for N days before today. */
export function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return isoDate(d);
}

/** "under_review" -> "Under review". */
export function humanise(value) {
  if (value === null || value === undefined || value === '') return '—';
  const text = String(value).replace(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Initials for an avatar chip. */
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Shorten a Mongo id for display without losing its usefulness for support. */
export const shortId = (id) => (id ? `…${String(id).slice(-6)}` : '—');
