// Shared points-earning logic. Rate: 1 VIPS point per 1 TND spent (matches
// the redemption side's VIPS_TO_TND = 0.1 in routes/order.js — i.e. points
// are worth 10% of their earn-value when redeemed, a standard loyalty
// cashback spread). Guarded by Order.pointsCredited so a webhook retry or a
// second status-update call never double-credits the same order.
const Transaction = require('../models/Transaction');
const User = require('../models/User');

const POINTS_PER_CURRENCY_UNIT = 1;

async function creditPointsForOrder(order) {
  if (!order || order.pointsCredited) return { credited: false };

  const points = Math.floor((order.totalAmount || 0) * POINTS_PER_CURRENCY_UNIT);
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

  return { credited: true, points };
}

module.exports = { creditPointsForOrder, POINTS_PER_CURRENCY_UNIT };
