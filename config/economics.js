/**
 * Every number the VIPs business model is defined by, in one place.
 *
 * Source: "وثيقة منصة فيبس التفصيلية" and "النسخة الشاملة للمتاجر الشريكة".
 * Section numbers below refer to those documents — when a figure here is
 * questioned, that is what it has to be checked against.
 *
 * These used to be literals scattered across routes/order.js,
 * routes/payment.js, routes/rewards.js, utils/points.js and index.js, which
 * is how the platform ended up running two different earn rates at once and
 * a redemption rate ten times the documented one.
 */

// ─── §5.1 Points ↔ currency ────────────────────────────────
// 100 points = 1 TND. Fixed, and the same in both directions: the guarantee
// a merchant deposits converts at this rate, and so does a point a customer
// redeems. A spread between the two would make the platform earn on the
// difference, which §5.3 explicitly rules out.
const POINTS_PER_TND = 100;
const TND_PER_POINT = 1 / POINTS_PER_TND; // 0.01

/** Points → dinars, rounded to millimes (3 decimals, Tunisian dinar). */
const pointsToTnd = (points) => Math.round((Number(points) || 0) * TND_PER_POINT * 1000) / 1000;

/** Dinars → points. Floors: never credit a fraction of a point. */
const tndToPoints = (tnd) => Math.floor((Number(tnd) || 0) * POINTS_PER_TND);

// ─── §4.1 Earning ──────────────────────────────────────────
// Each merchant sets their own rate; the document's worked example is 6
// points per 1 TND spent (a 6% return, since 100 points = 1 TND). A merchant
// with no rate set earns the customer nothing rather than silently falling
// back to a platform-wide number nobody agreed to.
const DEFAULT_EARN_RATE = 6;
const MAX_EARN_RATE = 100; // 100 points per TND = 100% back; a ceiling, not a target.

/** Points earned on an invoice at a merchant's own rate. */
const pointsForInvoice = (amountTnd, earnRate) => {
  const rate = Number(earnRate);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.floor((Number(amountTnd) || 0) * Math.min(rate, MAX_EARN_RATE));
};

// ─── §4.2 Giftback ─────────────────────────────────────────
// The customer forgoes the change on their invoice and receives it as
// loyalty points. Every constraint here is load-bearing: §7 argues the
// platform needs no central-bank licence *because* the feature is optional,
// capped per customer, and deferred.
const GIFTBACK = {
  /** Change must be under 5 TND — this is change, not a payment. */
  MAX_CHANGE_TND: 5,
  /** Per customer, per calendar month. Not per merchant. */
  MONTHLY_CAP_TND: 50,
  /** Points stay pending this long before they can be spent. */
  ACTIVATION_DELAY_HOURS: 12,
};

// ─── §5.1 Merchant guarantee and its three budgets ─────────
// The deposit converts to points which the merchant splits across three
// budgets. Every offer is funded from one of them; when a budget runs dry
// that offer type stops being accepted.
const BUDGETS = ['discount', 'packages', 'general'];
const BUDGET_LABELS = {
  discount: 'ميزانية التخفيض',   // funds Cashback
  packages: 'ميزانية الباقات',   // funds Packages
  general:  'الرصيد العام',      // receives Voucher redemptions
};

// ─── §5.2 Guarantee refunds ────────────────────────────────
const REFUND = {
  /** Refunds may be requested once every two months. */
  CYCLE_DAYS: 60,
  /** Below this the administrative cost outweighs the transfer. */
  MIN_TND: 100,
  /** Working days the platform has to review a request. */
  REVIEW_WORKING_DAYS: 5,
};

// ─── §8 Subscription tiers ─────────────────────────────────
// The monthly fee buys a lower commission, so a merchant's rate is a
// property of their plan rather than a number typed in by hand.
const PLANS = {
  basic:        { key: 'basic',        monthlyFeeTnd: 0,   commissionPercent: 3, label: 'أساسية' },
  professional: { key: 'professional', monthlyFeeTnd: 49,  commissionPercent: 2, label: 'احترافية' },
  advanced:     { key: 'advanced',     monthlyFeeTnd: 149, commissionPercent: 1, label: 'متقدمة' },
};
const PLAN_KEYS = Object.keys(PLANS);

/** Commission the platform takes on an invoice, in dinars. */
const commissionForInvoice = (amountTnd, planKey) => {
  const plan = PLANS[planKey] || PLANS.basic;
  return Math.round((Number(amountTnd) || 0) * (plan.commissionPercent / 100) * 1000) / 1000;
};

module.exports = {
  POINTS_PER_TND, TND_PER_POINT, pointsToTnd, tndToPoints,
  DEFAULT_EARN_RATE, MAX_EARN_RATE, pointsForInvoice,
  GIFTBACK, BUDGETS, BUDGET_LABELS, REFUND,
  PLANS, PLAN_KEYS, commissionForInvoice,
};
