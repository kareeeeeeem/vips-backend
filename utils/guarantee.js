/**
 * The merchant guarantee, and the only code that moves it (§5.1, §5.2).
 *
 * Every function here writes a GuaranteeLedger entry in the same step that
 * changes a balance. Nothing else in the codebase should touch
 * User.guarantee directly — a balance that can be changed without a ledger
 * line is a balance the merchant cannot reconcile.
 */
const User = require('../models/User');
const GuaranteeLedger = require('../models/GuaranteeLedger');
const { tndToPoints, pointsToTnd, BUDGETS, REFUND } = require('../config/economics');

class GuaranteeError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const asMerchant = async (merchantId) => {
  const merchant = await User.findById(merchantId);
  if (!merchant || merchant.role !== 'merchant') {
    throw new GuaranteeError('Merchant not found.', 404);
  }
  if (!merchant.guarantee) merchant.guarantee = {};
  if (!merchant.guarantee.budgets) merchant.guarantee.budgets = { discount: 0, packages: 0, general: 0 };
  return merchant;
};

const record = (merchant, entry) =>
  GuaranteeLedger.create({ merchantId: merchant._id, ...entry });

/**
 * Cash in. Converts at 100 points = 1 TND and lands unallocated — the
 * merchant decides the split themselves (§5.1, "توزيع الرصيد").
 */
async function deposit(merchantId, tnd, { byId = null, note = '' } = {}) {
  const amount = Number(tnd);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new GuaranteeError('Deposit amount must be a positive number of dinars.');
  }
  const merchant = await asMerchant(merchantId);
  const points = tndToPoints(amount);

  merchant.guarantee.depositedTnd = (merchant.guarantee.depositedTnd || 0) + amount;
  merchant.guarantee.unallocatedPoints = (merchant.guarantee.unallocatedPoints || 0) + points;
  // A top-up lifts a suspension; whether it stays lifted is decided by the
  // budgets the merchant allocates it to.
  merchant.guarantee.suspendedAt = null;
  await merchant.save();

  await record(merchant, {
    type: 'deposit', points, tnd: amount, byId, note,
    balanceAfter: merchant.guarantee.unallocatedPoints,
  });
  return summarise(merchant);
}

/** Move unallocated points into one of the three budgets. */
async function allocate(merchantId, budget, points, { byId = null } = {}) {
  if (!BUDGETS.includes(budget)) throw new GuaranteeError(`Unknown budget "${budget}".`);
  const amount = Math.floor(Number(points));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new GuaranteeError('Allocation must be a positive number of points.');
  }
  const merchant = await asMerchant(merchantId);
  if ((merchant.guarantee.unallocatedPoints || 0) < amount) {
    throw new GuaranteeError(
      `Only ${merchant.guarantee.unallocatedPoints || 0} unallocated points available.`,
      409
    );
  }

  merchant.guarantee.unallocatedPoints -= amount;
  merchant.guarantee.budgets[budget] = (merchant.guarantee.budgets[budget] || 0) + amount;
  await merchant.save();

  await record(merchant, {
    type: 'allocate', points: amount, budget, byId,
    balanceAfter: merchant.guarantee.budgets[budget],
  });
  return summarise(merchant);
}

/** Move points from one budget to another without a new deposit. */
async function reallocate(merchantId, fromBudget, toBudget, points, { byId = null } = {}) {
  if (!BUDGETS.includes(fromBudget) || !BUDGETS.includes(toBudget)) {
    throw new GuaranteeError('Both budgets must be discount, packages or general.');
  }
  if (fromBudget === toBudget) throw new GuaranteeError('Pick two different budgets.');
  const amount = Math.floor(Number(points));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new GuaranteeError('Amount must be a positive number of points.');
  }
  const merchant = await asMerchant(merchantId);
  if ((merchant.guarantee.budgets[fromBudget] || 0) < amount) {
    throw new GuaranteeError(
      `${fromBudget} holds only ${merchant.guarantee.budgets[fromBudget] || 0} points.`, 409
    );
  }

  merchant.guarantee.budgets[fromBudget] -= amount;
  merchant.guarantee.budgets[toBudget] = (merchant.guarantee.budgets[toBudget] || 0) + amount;
  await merchant.save();

  await record(merchant, {
    type: 'reallocate', points: amount, budget: toBudget, fromBudget, byId,
    balanceAfter: merchant.guarantee.budgets[toBudget],
  });
  return summarise(merchant);
}

/**
 * An offer pays out: points leave the funding budget and go to a customer.
 *
 * Refuses rather than going negative. §5.1 is explicit that a merchant whose
 * budget is exhausted stops accepting points until they top it up — an offer
 * that pays out of an empty budget is the platform covering it, which the
 * model does not allow.
 */
async function fund(merchantId, budget, points, { orderId = null, customerId = null, note = '' } = {}) {
  if (!BUDGETS.includes(budget)) throw new GuaranteeError(`Unknown budget "${budget}".`);
  const amount = Math.floor(Number(points));
  if (!Number.isFinite(amount) || amount <= 0) return null; // nothing to fund

  const merchant = await asMerchant(merchantId);
  const available = merchant.guarantee.budgets[budget] || 0;
  if (available < amount) {
    throw new GuaranteeError(
      `This merchant's ${budget} budget is exhausted (${available} points left, ${amount} needed).`,
      409,
      { code: 'BUDGET_EXHAUSTED', budget, available, required: amount }
    );
  }

  merchant.guarantee.budgets[budget] = available - amount;
  if (merchant.guarantee.budgets[budget] === 0) merchant.guarantee.suspendedAt = new Date();
  await merchant.save();

  await record(merchant, {
    type: 'fund', points: -amount, budget, orderId, customerId, note,
    balanceAfter: merchant.guarantee.budgets[budget],
  });
  return summarise(merchant);
}

/**
 * A customer spent a voucher in this store: the merchant handed over goods
 * and the value returns to their general balance (§4.2, third offer).
 */
async function creditRedemption(merchantId, points, { orderId = null, customerId = null, note = '' } = {}) {
  const amount = Math.floor(Number(points));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const merchant = await asMerchant(merchantId);
  merchant.guarantee.budgets.general = (merchant.guarantee.budgets.general || 0) + amount;
  if (merchant.guarantee.suspendedAt && merchant.guarantee.budgets.general > 0) {
    merchant.guarantee.suspendedAt = null;
  }
  await merchant.save();

  await record(merchant, {
    type: 'redeem', points: amount, budget: 'general', orderId, customerId, note,
    balanceAfter: merchant.guarantee.budgets.general,
  });
  return summarise(merchant);
}

/**
 * What a merchant may take back out, and whether they may take it now (§5.2).
 *
 * The refundable figure is the cash value of every point still sitting in
 * the guarantee — unallocated plus all three budgets. That is the document's
 * formula (deposit − used + redeemed) expressed as the balance it produces,
 * which is the same number and cannot drift from the ledger.
 */
function refundability(merchant) {
  const g = merchant.guarantee || {};
  const b = g.budgets || {};
  const points = (g.unallocatedPoints || 0) + (b.discount || 0) + (b.packages || 0) + (b.general || 0);
  const availableTnd = pointsToTnd(points);

  const last = g.lastRefundAt ? new Date(g.lastRefundAt) : null;
  const nextEligibleAt = last
    ? new Date(last.getTime() + REFUND.CYCLE_DAYS * 24 * 60 * 60 * 1000)
    : null;
  const cycleReady = !nextEligibleAt || nextEligibleAt <= new Date();

  const reasons = [];
  if (!cycleReady) {
    reasons.push(`Refunds are available once every ${REFUND.CYCLE_DAYS} days. Next: ${nextEligibleAt.toISOString().slice(0, 10)}.`);
  }
  if (availableTnd < REFUND.MIN_TND) {
    reasons.push(`The minimum refund is ${REFUND.MIN_TND} TND; ${availableTnd} TND is available.`);
  }

  return {
    availablePoints: points,
    availableTnd,
    minimumTnd: REFUND.MIN_TND,
    cycleDays: REFUND.CYCLE_DAYS,
    reviewWorkingDays: REFUND.REVIEW_WORKING_DAYS,
    nextEligibleAt,
    canRequest: reasons.length === 0,
    reasons,
  };
}

/**
 * Take cash back out. Draws from unallocated first, then the budgets in a
 * fixed order, so a partial refund leaves the merchant's own allocation
 * decisions intact for as long as possible.
 */
async function refund(merchantId, tnd, { byId = null, note = '' } = {}) {
  const amount = Number(tnd);
  const merchant = await asMerchant(merchantId);
  const state = refundability(merchant);

  if (!state.canRequest) throw new GuaranteeError(state.reasons.join(' '), 409, { refundability: state });
  if (!Number.isFinite(amount) || amount < REFUND.MIN_TND) {
    throw new GuaranteeError(`The minimum refund is ${REFUND.MIN_TND} TND.`);
  }
  if (amount > state.availableTnd) {
    throw new GuaranteeError(`Only ${state.availableTnd} TND is refundable.`, 409, { refundability: state });
  }

  let remaining = tndToPoints(amount);
  const g = merchant.guarantee;
  const drawOrder = [null, 'general', 'packages', 'discount']; // null = unallocated
  const entries = [];

  for (const budget of drawOrder) {
    if (remaining <= 0) break;
    const held = budget === null ? (g.unallocatedPoints || 0) : (g.budgets[budget] || 0);
    if (held <= 0) continue;
    const take = Math.min(held, remaining);
    if (budget === null) g.unallocatedPoints = held - take;
    else g.budgets[budget] = held - take;
    remaining -= take;
    entries.push({
      budget,
      points: -take,
      balanceAfter: budget === null ? g.unallocatedPoints : g.budgets[budget],
    });
  }

  g.refundedTnd = (g.refundedTnd || 0) + amount;
  g.lastRefundAt = new Date();
  await merchant.save();

  for (const e of entries) {
    await record(merchant, {
      type: 'refund', points: e.points, budget: e.budget,
      tnd: pointsToTnd(-e.points), balanceAfter: e.balanceAfter, byId, note,
    });
  }
  return summarise(merchant);
}

/** The merchant-facing view of their guarantee. */
function summarise(merchant) {
  const g = merchant.guarantee || {};
  const b = g.budgets || {};
  const totalPoints = (g.unallocatedPoints || 0) + (b.discount || 0) + (b.packages || 0) + (b.general || 0);
  return {
    depositedTnd: g.depositedTnd || 0,
    refundedTnd: g.refundedTnd || 0,
    unallocatedPoints: g.unallocatedPoints || 0,
    budgets: {
      discount: b.discount || 0,
      packages: b.packages || 0,
      general: b.general || 0,
    },
    totalPoints,
    totalTnd: pointsToTnd(totalPoints),
    suspended: Boolean(g.suspendedAt),
    suspendedAt: g.suspendedAt || null,
    refund: refundability(merchant),
  };
}

/** True when this merchant can still fund `points` out of `budget`. */
function canFund(merchant, budget, points) {
  const held = merchant?.guarantee?.budgets?.[budget] || 0;
  return held >= Math.floor(Number(points) || 0);
}

module.exports = {
  GuaranteeError,
  deposit, allocate, reallocate, fund, creditRedemption,
  refund, refundability, summarise, canFund,
};
