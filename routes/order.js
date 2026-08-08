const express = require('express');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// ─── POST /api/order/create ───────────────────────────────
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { merchantId, items, paymentMethod, deliveryAddress, orderType, orderNote, couponCode, couponDiscountAmount } = req.body;

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

    // Normalize deliveryAddress: accept both plain string and structured object
    const addressObj = typeof deliveryAddress === 'string'
      ? { address: deliveryAddress }
      : (deliveryAddress || {});

    const order = await Order.create({
      userId:              req.user.id,
      merchantId,
      items:               normalizedItems,
      totalAmount,
      couponDiscountAmount: discount,
      paymentMethod:       paymentMethod || 'cash',
      deliveryAddress:     addressObj,
      orderType:           orderType || 'delivery',
      orderNote:           orderNote || '',
      status:              'pending',
      pendingAt:           new Date(),
    });

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
    const filter = { userId: req.user.id, status: 'delivered' };
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
      };
    });

    res.json({ success: true, data: trips });
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
