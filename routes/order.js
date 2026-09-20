const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// §5.1: 100 points = 1 TND, from the one module that defines it. This was
// 0.1 — ten times the documented rate — duplicated here, in payment.js and
// in index.js, which is how the three drifted apart.
const coupons = require('../utils/coupons');

const { quoteCheckout, publicQuote } = require('../utils/checkout');

router.post('/quote', authMiddleware, async (req, res) => {
  try {
    res.json({ success: true, data: publicQuote(await quoteCheckout(req.body, req.user.id)) });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// Prices and the shop come from the catalogue. The same calculation powers
// the preview and the committed order, including delivery, tips and points.
router.post('/create', authMiddleware, async (req, res) => {
  let quote;
  let fundsReserved = false;
  let couponConsumed = false;
  let order;
  try {
    quote = await quoteCheckout(req.body, req.user.id);
    const { normalizedItems, merchantId, orderType, paymentMethod, totalAmount,
      discount, appliedCoupon, pointsUsed, walletDiscountAmount, deliveryCharge, tipAmount, taxAmount } = quote;
    if (req.body.expectedTotal != null &&
        (!Number.isFinite(Number(req.body.expectedTotal)) ||
         Math.abs(Number(req.body.expectedTotal) - totalAmount) > 0.0005)) {
      return res.status(409).json({ success: false, message: 'Your order total changed. Please review it again.', data: publicQuote(quote) });
    }
    const walletDebit = paymentMethod === 'wallet' ? totalAmount : 0;
    if (pointsUsed > 0 || walletDebit > 0) {
      const reserved = await User.findOneAndUpdate(
        { _id: req.user.id, walletPoints: { $gte: pointsUsed }, walletBalance: { $gte: walletDebit } },
        { $inc: { walletPoints: -pointsUsed, walletBalance: -walletDebit } },
      );
      if (!reserved) return res.status(409).json({ success: false, message: 'Your wallet balance changed. Please review your order.' });
      fundsReserved = true;
    }
    if (appliedCoupon) {
      await coupons.consume(appliedCoupon);
      couponConsumed = true;
    }
    const deliveryAddress = typeof req.body.deliveryAddress === 'string'
      ? { address: req.body.deliveryAddress } : (req.body.deliveryAddress || {});
    order = await Order.create({
      userId: req.user.id, merchantId, items: normalizedItems, totalAmount,
      couponDiscountAmount: discount,
      couponDiscountTitle: appliedCoupon ? (appliedCoupon.description || appliedCoupon.code) : '',
      walletPointsRedeemed: pointsUsed, walletDiscountAmount,
      deliveryCharge, additionalCharge: tipAmount, totalTaxAmount: taxAmount,
      paymentMethod, paymentStatus: walletDebit > 0 || totalAmount === 0 ? 'paid' : 'pending',
      deliveryAddress, orderType, orderNote: req.body.orderNote || '',
      scheduleAt: req.body.scheduleAt || null,
      status: 'pending', pendingAt: new Date(),
    });
    if (pointsUsed > 0) {
      await Transaction.create({
        userId: req.user.id, merchantId, type: 'debit', amount: pointsUsed, currency: 'PTS',
        description: `${pointsUsed} VIPS points redeemed on order #${order.orderNumber}`,
        status: 'completed', reference: `ORDER-PTS-${order._id}`,
      });
    }
    if (walletDebit > 0) {
      await Transaction.create({
        userId: req.user.id, merchantId, type: 'expense', amount: walletDebit, currency: 'TND',
        description: `Wallet payment for order #${order.orderNumber}`,
        status: 'completed', reference: `ORDER-WALLET-${order._id}`,
      });
    }
    // The cart is fulfilled server-side; a failed follow-up request from the
    // phone must not make already-ordered items reappear on the next launch.
    await User.updateOne({ _id: req.user.id }, {
      $pull: { cart: { itemId: { $in: normalizedItems.map(item => String(item.productId)) } } },
    });
    if (merchantId) {
      try {
        const { push } = require('./merchant_notifications');
        await push(merchantId, 'New Order',
          `Order #${order.orderNumber} — D ${totalAmount.toFixed(3)}`, 'order',
          { orderId: order._id, orderNumber: order.orderNumber });
      } catch (_) { /* Notification failure does not undo a placed order. */ }
    }
    res.status(201).json({ success: true, message: 'Order created', data: order });
  } catch (error) {
    // Compensate rejected checkouts. Conditional increments above prevent two
    // concurrent orders overdrawing a balance even on standalone MongoDB.
    if (order) {
      await Order.deleteOne({ _id: order._id });
      await Transaction.deleteMany({ reference: { $in: [`ORDER-PTS-${order._id}`, `ORDER-WALLET-${order._id}`] } });
    }
    if (fundsReserved) {
      await User.updateOne({ _id: req.user.id }, { $inc: {
        walletPoints: quote.pointsUsed,
        walletBalance: quote.paymentMethod === 'wallet' ? quote.totalAmount : 0,
      } });
    }
    if (couponConsumed) {
      await require('../models/Coupon').updateOne({ _id: quote.appliedCoupon._id },
        { $inc: { usageCount: -1, usedCount: -1 } });
    }
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/order/history ───────────────────────────────
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json({ success: true, data: orders });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/order/my-orders ────────────────────────────
router.get('/my-orders', authMiddleware, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { userId: req.user.id };
    if (status) filter.status = status;

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('merchantId', 'storeName fullName');

    res.json({ success: true, data: orders });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/order/trips ─────────────────────────────────
// Must be defined BEFORE /:id to avoid route conflict
// Maps the Shipping screen's filter chips (widgets/filter.dart-equivalent
// in shipping_controller.dart's _buildFilterSheet) onto real Order.status
// values — used to hardcode status:'delivered' regardless of which chip
// was tapped, so every filter but the default showed identical results.
const TRIP_STATUS_GROUPS = {
  Pending:   ['pending'],
  Active:    ['confirmed', 'processing', 'ready', 'handover', 'picked_up'],
  Completed: ['delivered'],
  Cancelled: ['canceled', 'cancelled'],
};

router.get('/trips', authMiddleware, async (req, res) => {
  try {
    const { from, to, status } = req.query;
    const filter = { userId: req.user.id, hiddenFromTrips: { $ne: true } };
    filter.status = (status && TRIP_STATUS_GROUPS[status]) ? { $in: TRIP_STATUS_GROUPS[status] } : 'delivered';
    if (from && to) {
      filter.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    }

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('merchantId', 'storeName fullName storeCategory');

    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const trips = orders.map((o) => {
      const date = new Date(o.createdAt);
      return {
        id: o._id,
        title: `Order at ${o.merchantId?.storeName || o.merchantId?.fullName || 'Store'}`,
        location: o.merchantId?.storeName || o.merchantId?.fullName || 'Unknown',
        time: `${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}`,
        date: `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`,
        amount: o.totalAmount,
        isMarked: o.tripMarked || false,
      };
    });

    res.json({ success: true, data: trips });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── DELETE /api/order/trips/:id ──────────────────────────
// Soft-delete: hides the underlying order from the Trips list without
// touching the order itself. Must be defined BEFORE /:id to avoid conflict.
router.delete('/trips/:id', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { hiddenFromTrips: true },
      { new: true }
    );
    if (!order) return res.status(404).json({ success: false, message: 'Trip not found' });
    res.json({ success: true, message: 'Trip deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PATCH /api/order/trips/:id/mark ──────────────────────
// Toggles (or explicitly sets via { isMarked }) the bookmark flag on a trip.
// Must be defined BEFORE /:id to avoid conflict.
router.patch('/trips/:id/mark', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, userId: req.user.id });
    if (!order) return res.status(404).json({ success: false, message: 'Trip not found' });

    order.tripMarked = typeof req.body.isMarked === 'boolean' ? req.body.isMarked : !order.tripMarked;
    await order.save();

    res.json({ success: true, message: 'Trip updated', data: { id: order._id, isMarked: order.tripMarked } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/order/:id ──────────────────────────────────
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, userId: req.user.id })
      .populate('merchantId', 'storeName fullName phone address');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, data: order });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/order/:id/cancel ────────────────────────────
/**
 * GET /api/order/:id/tracking
 *
 * The order's journey, for the customer who placed it. Scoped to them: an
 * order id from somebody else must not read back where their delivery is.
 *
 * Registered before ':id/cancel' and after ':id' — Express matches in order
 * and '/:id' would not capture this two-segment path anyway.
 */
router.get('/:id/tracking', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, userId: req.user.id })
      .select('orderNumber status statusHistory deliveryLocation estimatedDeliveryAt '
        + 'createdAt deliveredAt canceledAt merchantId')
      .populate('merchantId', 'storeName fullName phone')
      .lean();

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    // Ordered oldest first, the way a journey reads. The hook appends, so
    // they are already in order, but a sort makes that independent of it.
    const history = (order.statusHistory || [])
      .slice()
      .sort((a, b) => new Date(a.at) - new Date(b.at))
      .map((h) => ({
        status: h.status,
        at: h.at,
        note: h.note || '',
        // Who, by role only. A customer does not need the operator's name,
        // and it would be the one piece of staff data leaking outward.
        by: h.byRole || '',
      }));

    const location = order.deliveryLocation || {};
    const hasLocation = typeof location.lat === 'number' && typeof location.lng === 'number';

    res.json({
      success: true,
      message: 'Order tracking',
      data: {
        orderId: order._id,
        orderNumber: order.orderNumber,
        status: order.status,
        history,
        // Older orders predate this history, so the screen can say the
        // journey was not recorded rather than showing an empty timeline
        // that reads as nothing having happened.
        historyRecorded: history.length > 0,
        placedAt: order.createdAt,
        estimatedDeliveryAt: order.estimatedDeliveryAt,
        deliveredAt: order.deliveredAt,
        merchantName: order.merchantId
          ? (order.merchantId.storeName || order.merchantId.fullName || '')
          : '',
        merchantPhone: order.merchantId ? order.merchantId.phone || '' : '',
        // Null unless somebody is actually reporting a position. An empty
        // map implies tracking that is not happening.
        liveLocation: hasLocation
          ? { lat: location.lat, lng: location.lng, updatedAt: location.updatedAt }
          : null,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, userId: req.user.id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['pending', 'confirmed'].includes(order.status)) {
      return res.status(400).json({ success: false, message: 'Cannot cancel this order' });
    }
    order.$locals.statusBy = { id: req.user.id, role: 'customer', note: req.body.reason || '' };
    order.status = 'cancelled';
    order.canceledAt = new Date();
    order.cancellationReason = String(req.body.reason || '').slice(0, 500);
    await order.save();
    res.json({ success: true, message: 'Order cancelled', data: order });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/order/:id/request-refund ─────────────────────
router.put('/:id/request-refund', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, userId: req.user.id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'delivered') {
      return res.status(400).json({ success: false, message: 'Only delivered orders can be refunded' });
    }
    order.$locals.statusBy = { id: req.user.id, role: 'customer', note: req.body.reason || '' };
    order.status = 'refund_requested';
    order.refundRequestedAt = new Date();
    order.cancellationReason = (req.body?.reason || '').toString().slice(0, 500);
    await order.save();
    res.json({ success: true, message: 'Refund requested', data: order });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/order/:id/review ───────────────────────────
router.post('/:id/review', authMiddleware, async (req, res) => {
  try {
    const { rating, review } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
    }

    const order = await Order.findOne({ _id: req.params.id, userId: req.user.id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Only a delivered order can be reviewed. The route checked ownership and
    // nothing else, so a customer could rate an order the instant they placed
    // it — and those ratings feed the merchant's public average through
    // GET /content/merchants/:id/reviews. (Refunds already gate on delivered.)
    if (order.status !== 'delivered') {
      return res.status(400).json({
        success: false,
        message: 'You can review an order once it has been delivered',
      });
    }

    order.rating = Number(rating);
    order.review = review || '';
    await order.save();

    // 'review' is one of MerchantNotification's real types but nothing ever
    // emitted one, so a merchant was never told they had been reviewed.
    if (order.merchantId) {
      try {
        const { push } = require('./merchant_notifications');
        await push(
          order.merchantId,
          'New Review',
          `${order.rating}★ on order #${order.orderNumber}${order.review ? ` — "${order.review}"` : ''}`,
          'review',
          { orderId: order._id, orderNumber: order.orderNumber },
        );
      } catch (_) {}
    }

    res.json({ success: true, message: 'Review submitted successfully', data: order });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
