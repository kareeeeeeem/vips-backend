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

module.exports = { creditPointsForOrder, earnRateFor, DEFAULT_EARN_RATE };
