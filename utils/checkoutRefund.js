const User = require('../models/User');
const Transaction = require('../models/Transaction');

// Points applied at checkout belong back to the customer when the order is
// cancelled/refunded. The marker and balance increment share one atomic write
// so repeated status updates cannot credit the same refund twice.
async function refundCheckoutFunds(order) {
  if (!['canceled', 'cancelled', 'refunded'].includes(order.status)) return;
  const points = Math.max(0, order.walletPointsRedeemed || 0);
  const money = order.paymentMethod === 'wallet' && ['paid', 'refunded'].includes(order.paymentStatus)
    ? Math.max(0, order.totalAmount || 0) : 0;
  if (!points && !money) return;
  const userId = order.userId?._id || order.userId;
  const result = await User.updateOne(
    { _id: userId, checkoutRefundIds: { $ne: order._id } },
    { $inc: { walletPoints: points, walletBalance: money }, $addToSet: { checkoutRefundIds: order._id } },
  );
  // Rebuild a missing ledger row on a retry after a transient write failure.
  if (!result.modifiedCount && !await User.exists({ _id: userId, checkoutRefundIds: order._id })) return;
  for (const [currency, amount] of [['PTS', points], ['TND', money]]) {
    if (!amount) continue;
    const operationId = `checkout-refund:${order._id}:${currency}`;
    try {
      await Transaction.updateOne({ operationId }, { $setOnInsert: {
        userId, merchantId: order.merchantId, type: 'credit', amount, currency,
        status: 'completed', reference: operationId,
        description: `Checkout refund for order #${order.orderNumber}`,
      } }, { upsert: true });
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }
}

module.exports = { refundCheckoutFunds };
