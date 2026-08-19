const express = require('express');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Same conversion rate as GET /api/config/rates (index.js) — kept in sync
// manually since rates aren't stored in the DB yet.
const VIPS_TO_TND = 0.1;

// ─── POST /api/order/create ───────────────────────────────
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { merchantId, items, paymentMethod, deliveryAddress, orderType, orderNote, couponCode, couponDiscountAmount, walletPointsRedeemed } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Order must contain at least one item' });
    }

    // Normalize items: map frontend field names to schema field names
    const normalizedItems = items.map((item) => ({
      productId:    item.productId || item.id,
      item_name:    item.name || item.item_name || '',
      price:        Number(item.price) || 0,
      quantity:     Number(item.quantity) || 1,
      tax_amount:   Number(item.tax_amount) || 0,
      discount_on_item: Number(item.discount_on_item) || 0,
    }));

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
router.get('/trips', authMiddleware, async (req, res) => {
  try {
    const { from, to } = req.query;
    const filter = { userId: req.user.id, status: 'delivered', hiddenFromTrips: { $ne: true } };
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
router.put('/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, userId: req.user.id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (['delivered', 'cancelled'].includes(order.status)) {
      return res.status(400).json({ success: false, message: 'Cannot cancel this order' });
    }
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

    order.rating = Number(rating);
    order.review = review || '';
    await order.save();

    res.json({ success: true, message: 'Review submitted successfully', data: order });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
