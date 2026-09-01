const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Deal = require('../models/Deal');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// §5.1: 100 points = 1 TND, from the one module that defines it. This was
// 0.1 — ten times the documented rate — duplicated here, in payment.js and
// in index.js, which is how the three drifted apart.
const { TND_PER_POINT: VIPS_TO_TND } = require('../config/economics');

// ─── POST /api/order/create ───────────────────────────────
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { merchantId, items, paymentMethod, deliveryAddress, orderType, orderNote, couponCode, couponDiscountAmount, walletPointsRedeemed } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Order must contain at least one item' });
    }

    // Prices come from the database, never from the request. This used to
    // take `item.price` straight off the body and total the order from it, so
    // a modified client could order a D 12.500 product for D 0.001 — the
    // server simply believed whatever price it was handed.
    const normalizedItems = [];
    for (const item of items) {
      const id = item.productId || item.id;
      const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));

      let priced = null;
      let name = item.name || item.item_name || '';

      if (id && mongoose.Types.ObjectId.isValid(id)) {
        const product = await Product.findById(id).select('name price discountPrice');
        if (product) {
          priced = (product.discountPrice != null && product.discountPrice > 0)
            ? product.discountPrice
            : product.price;
          name = product.name || name;
        } else {
          const deal = await Deal.findById(id).select('title currentPrice');
          if (deal) {
            priced = deal.currentPrice;
            name = deal.title || name;
          }
        }
      }

      if (priced === null) {
        return res.status(400).json({
          success: false,
          message: `Item "${name || id}" is no longer available`,
        });
      }

      normalizedItems.push({
        productId:        id,
        item_name:        name,
        price:            Number(priced) || 0,
        quantity,
        tax_amount:       Number(item.tax_amount) || 0,
        discount_on_item: Number(item.discount_on_item) || 0,
      });
    }

    let totalAmount = normalizedItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const discount = Number(couponDiscountAmount) || 0;
    totalAmount = Math.max(0, totalAmount - discount);

    // Redeem wallet points against the remaining total, if requested.
    // Capped by both what the user actually has and what's left to pay —
    // never lets a redemption push the order below zero or overdraw the
    // wallet.
    let pointsUsed = 0;
    let walletDiscountAmount = 0;
    const requestedPoints = Number(walletPointsRedeemed) || 0;
    let user = null;
    if (requestedPoints > 0) {
      user = await User.findById(req.user.id);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });

      const maxRedeemableByBalance = Math.max(0, Math.floor(user.walletPoints));
      const maxRedeemableByTotal = Math.floor(totalAmount / VIPS_TO_TND);
      pointsUsed = Math.max(0, Math.min(requestedPoints, maxRedeemableByBalance, maxRedeemableByTotal));
      walletDiscountAmount = Math.round(pointsUsed * VIPS_TO_TND * 100) / 100;
      totalAmount = Math.max(0, Math.round((totalAmount - walletDiscountAmount) * 100) / 100);
    }

    // Normalize deliveryAddress: accept both plain string and structured object
    const addressObj = typeof deliveryAddress === 'string'
      ? { address: deliveryAddress }
      : (deliveryAddress || {});

    // A bare '' or falsy value isn't a valid ObjectId — omit the field
    // entirely rather than passing something that fails Mongoose's cast.
    const validMerchantId = merchantId && String(merchantId).trim() ? merchantId : null;

    const order = await Order.create({
      userId:              req.user.id,
      merchantId:          validMerchantId,
      items:               normalizedItems,
      totalAmount,
      couponDiscountAmount: discount,
      walletPointsRedeemed: pointsUsed,
      walletDiscountAmount,
      paymentMethod:       paymentMethod || 'cash',
      deliveryAddress:     addressObj,
      orderType:           orderType || 'delivery',
      orderNote:           orderNote || '',
      status:              'pending',
      pendingAt:           new Date(),
    });

    if (pointsUsed > 0 && user) {
      user.walletPoints -= pointsUsed;
      await Promise.all([
        user.save(),
        Transaction.create({
          userId:     user._id,
          merchantId: merchantId || user._id,
          type:       'debit',
          amount:     pointsUsed,
          currency:   'PTS',
          description: `${pointsUsed} VIPS points redeemed on order #${order.orderNumber}`,
          status:     'completed',
          reference:  `ORDER-PTS-${order._id}`,
        }),
      ]);
    }

    // Tell the merchant a customer just ordered. Merchant notifications only
    // ever fired when the merchant changed a status themselves — i.e. they
    // were told about their own action and never about the one event that
    // actually needs their attention, so the Notifications screen sat empty
    // while real orders came in.
    if (validMerchantId) {
      try {
        const { push } = require('./merchant_notifications');
        await push(
          validMerchantId,
          'New Order',
          `Order #${order.orderNumber} — D ${Number(order.totalAmount || 0).toFixed(2)}`,
          'order',
          // orderNumber travels alongside the id: the merchant order screen
          // is addressed by the numeric order number, not the Mongo id.
          { orderId: order._id, orderNumber: order.orderNumber },
        );
      } catch (_) {}
    }

    res.status(201).json({ success: true, message: 'Order created', data: order });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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
    if (['delivered', 'cancelled'].includes(order.status)) {
      return res.status(400).json({ success: false, message: 'Cannot cancel this order' });
    }
    order.$locals.statusBy = { id: req.user.id, role: 'customer', note: req.body.reason || '' };
    order.status = 'cancelled';
    order.canceledAt = new Date();
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
