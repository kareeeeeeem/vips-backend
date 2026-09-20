/**
 * Awarding loyalty points (§4.1).
 *
 * The rate belongs to the merchant, not to this file. It used to be a
 * literal 1 point per TND here and 0.1 in routes/rewards.js, so what a
 * customer earned depended on which screen credited it. A merchant with no
 * rate set awards nothing rather than falling back to a platform-wide
 * number nobody agreed to.
 */
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { pointsForInvoice, DEFAULT_EARN_RATE } = require('../config/economics');

/** The merchant's own rate, or null when they have not set a policy. */
async function earnRateFor(merchantId) {
  if (!merchantId) return null;
  const merchant = await User.findById(merchantId).select('earnRate role').lean();
  if (!merchant || merchant.role !== 'merchant') return null;
  return Number.isFinite(merchant.earnRate) ? merchant.earnRate : null;
}

async function creditPointsForOrder(order) {
  if (!order || order.pointsCredited) return { credited: false };

  const rate = await earnRateFor(order.merchantId);
  if (rate === null || rate <= 0) {
    // Nothing to award, but the order is settled either way — leaving the
    // flag unset would have a retry try again on every webhook.
    order.pointsCredited = true;
    await order.save();
    return { credited: false, reason: 'merchant has no earn rate set' };
  }

  const points = pointsForInvoice(order.totalAmount || 0, rate);
  if (points <= 0) {
    order.pointsCredited = true;
    await order.save();
    return { credited: false };
  }

  const user = await User.findById(order.userId);
  if (!user) return { credited: false };

  user.walletPoints = (user.walletPoints || 0) + points;
  order.pointsCredited = true;

  await Promise.all([
    user.save(),
    order.save(),
    Transaction.create({
      userId: user._id,
      merchantId: order.merchantId || null,
      type: 'reward',
      amount: points,
      currency: 'PTS',
      description: `${points} VIPS points earned on order #${order.orderNumber}`,
      status: 'completed',
      reference: `ORDER-EARN-${order._id}`,
    }),
  ]);

  return { credited: true, points, rate };
}

/**
 * Take back the points an order awarded, when it is refunded.
 *
 * Reads the amount from the ledger entry that granted it rather than
 * recomputing. Two reasons: the merchant may have changed their earn rate
 * since the sale, and recomputing is what went wrong before — the merchant
 * route clawed back `Math.floor(totalAmount)`, one point per dinar, against
 * a credit made at the merchant's own rate of six, so a refunded 100 TND
 * order took back 100 of the 600 points it had given.
 *
 * Lives here, beside the crediting, because there were two refund paths —
 * the merchant app and the admin console — and only one of them reversed
 * anything at all. A rule each caller has to remember is a rule with holes
 * in exactly the caller that forgot.
 */
async function reversePointsForOrder(order) {
  if (!order || !order.pointsCredited) return { reversed: false, points: 0 };

  const earned = await Transaction.findOne({
    reference: `ORDER-EARN-${order._id}`,
    type: 'reward',
  }).select('amount').lean();

  const points = Math.max(0, Math.floor(earned?.amount || 0));
  if (points <= 0) return { reversed: false, points: 0 };

  const user = await User.findById(order.userId);
  if (!user) return { reversed: false, points: 0 };

  // Never below zero: the customer may have spent them already. What cannot
  // be recovered is written off rather than turned into a negative balance
  // that would silently eat their next legitimate earnings.
  const taken = Math.min(points, user.walletPoints || 0);
  user.walletPoints = (user.walletPoints || 0) - taken;
  await user.save();

  await Transaction.create({
    userId: user._id,
    merchantId: order.merchantId || null,
    type: 'debit',
    amount: taken,
    currency: 'PTS',
    description: `${taken} VIPS points reversed — order #${order.orderNumber} refunded`,
    status: 'completed',
    reference: `ORDER-REVERSE-${order._id}`,
  });

  return { reversed: true, points: taken, awarded: points };
}

module.exports = {
  creditPointsForOrder, reversePointsForOrder, earnRateFor, DEFAULT_EARN_RATE,
};
