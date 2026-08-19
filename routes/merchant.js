/**
 * Core Merchant Routes  —  /api/merchant
 *
 * Covers: dashboard, stats, wallet, profile, customers, orders,
 *         finance, cashiers, gift-back, reports, reviews,
 *         and CRUD for: stock, assets, tax-rates, staff, dues.
 *
 * Feature-specific modules are in separate files:
 *   merchant_billing.js       — POS billing
 *   merchant_ads.js           — Ad campaigns
 *   merchant_barcode.js       — Barcode / QR management
 *   merchant_credit.js        — Credit transactions
 *   merchant_partnership.js   — Business registration
 *   merchant_subscription.js  — Subscription plans
 *   merchant_notifications.js — Push notifications
 */

const express  = require('express');
const mongoose = require('mongoose');
const { authMiddleware } = require('../middleware/auth');

const User        = require('../models/User');
const Transaction = require('../models/Transaction');
const Order       = require('../models/Order');
const Stock       = require('../models/Stock');
const Asset       = require('../models/Asset');
const TaxRate     = require('../models/TaxRate');
const Staff       = require('../models/Staff');
const Due         = require('../models/Due');
const Employee    = require('../models/Employee');
const Coupon      = require('../models/Coupon');
const Payout      = require('../models/Payout');
const BusinessRegistration = require('../models/BusinessRegistration');
const Product = require('../models/Product');

const router = express.Router();
router.use(authMiddleware);

// ─── POST /api/merchant/register ──────────────────────────
// Alias for merchant_partnership/register — called by business registration flow
router.post('/register', async (req, res) => {
  try {
    const {
      ownerName, ownerNameAr, storeName, storeNameAr, businessType,
      category, jobTitle, phone, email, address, apartment, locationName,
      description, schedule, loyaltyType, documents, tin, facebook, instagram, website,
    } = req.body;
    const merchantId = req.user.id;

    const fields = {
      ownerName:      ownerName || '',
      ownerNameAr:    ownerNameAr || '',
      businessName:   storeName || '',
      businessNameAr: storeNameAr || '',
      businessType:   businessType || 'retail',
      jobTitle:       jobTitle || '',
      phone:          phone || '',
      email:          email || '',
      address:        address || '',
      apartment:      apartment || '',
      locationName:   locationName || '',
      description:    description || '',
      schedule:       schedule || {},
      loyaltyType:    loyaltyType === 'private' ? 'private' : 'everywhere',
      taxId:          tin || '',
      website:        website || '',
      'socialMedia.facebook':  facebook || '',
      'socialMedia.instagram': instagram || '',
      status: 'pending',
    };
    // Frontend uploads documents to /api/upload first and passes back plain
    // URL strings — the schema stores them as {type,url,uploadedAt}.
    if (Array.isArray(documents) && documents.length) {
      fields.documents = documents.map((url) => ({ type: 'document', url }));
    }

    const registration = await BusinessRegistration.findOneAndUpdate(
      { merchantId },
      { $set: fields, $setOnInsert: { merchantId } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    // Update user profile with the subset of registration info User itself
    // tracks (used for display elsewhere in the merchant app).
    await User.findByIdAndUpdate(merchantId, {
      $set: { storeName, storeCategory: category, phone, address, description }
    });
    res.json({ success: true, message: 'Registration submitted successfully', data: registration });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// DASHBOARD & STATS
// ═══════════════════════════════════════════════════════════

// ─── GET /api/merchant/dashboard ──────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const merchantId = req.user.id;
    const merchantObjectId = new (require('mongoose').Types.ObjectId)(merchantId);

    const [agg, pending, total, dueAgg, stockAgg] = await Promise.all([
      Transaction.aggregate([
        { $match: { merchantId: merchantObjectId, status: 'completed' } },
        { $group: {
            _id: '$type',
            total: { $sum: '$amount' },
            count: { $sum: 1 },
        }},
      ]),
      Transaction.countDocuments({ merchantId, status: 'pending' }),
      Transaction.countDocuments({ merchantId }),
      // Sale Due / Due Collect cards: real outstanding-vs-collected totals
      // from the Due ledger (routes/dues.js), not transaction-derived.
      Due.aggregate([
        { $match: { merchantId: merchantObjectId } },
        { $group: {
            _id: null,
            totalDue:       { $sum: { $subtract: ['$totalAmount', '$paidAmount'] } },
            totalCollected: { $sum: '$paidAmount' },
        }},
      ]),
      // Purchase card: current inventory value (stock on hand × unit
      // price) — there's no supplier purchase-order log in the schema, so
      // this is the closest real number rather than a fabricated one.
      Stock.aggregate([
        { $match: { merchantId: merchantObjectId } },
        { $group: { _id: null, value: { $sum: { $multiply: ['$currentStock', '$unitPrice'] } } } },
      ]),
    ]);

    const byType = {};
    agg.forEach(r => { byType[r._id] = r.total; });

    const totalSales    = byType['income']    || 0;
    const totalExpenses = byType['expense']   || 0;
    const totalGiftBack = byType['gift_back'] || 0;
    const totalRewards  = byType['reward']    || 0;

    res.json({
      success: true,
      data: {
        totalSales,
        totalExpenses,
        totalGiftBack,
        totalRewards,
        totalPurchases:      stockAgg[0]?.value || 0,
        totalSaleDue:        Math.max(0, dueAgg[0]?.totalDue || 0),
        totalDueCollect:     dueAgg[0]?.totalCollected || 0,
        pendingTransactions: pending,
        netProfit:           totalSales - totalExpenses,
        transactionCount:    total,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/stats ──────────────────────────────
// Today, this-week & this-month income / expense breakdown
router.get('/stats', async (req, res) => {
  try {
    const merchantId = req.user.id;
    const moid       = new (require('mongoose').Types.ObjectId)(merchantId);
    const now        = new Date();
    const today      = new Date(now); today.setHours(0, 0, 0, 0);
    const weekStart  = new Date(today); weekStart.setDate(today.getDate() - today.getDay());
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const agg = await Transaction.aggregate([
      { $match: { merchantId: moid, status: 'completed' } },
      {
        $group: {
          _id: {
            type:   '$type',
            period: {
              $switch: {
                branches: [
                  { case: { $gte: ['$createdAt', today]      }, then: 'today' },
                  { case: { $gte: ['$createdAt', weekStart]  }, then: 'week'  },
                  { case: { $gte: ['$createdAt', monthStart] }, then: 'month' },
                ],
                default: 'older',
              },
            },
          },
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]);

    const build = (period) => {
      const rows = agg.filter(r => r._id.period === period);
      const get  = (type) => rows.find(r => r._id.type === type)?.total || 0;
      const cnt  = rows.reduce((s, r) => s + r.count, 0);
      const sales    = get('income');
      const expenses = get('expense');
      return { sales, expenses, net: sales - expenses, transactionCount: cnt };
    };

    res.json({
      success: true,
      data: { today: build('today'), week: build('week'), month: build('month') },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/wallet ─────────────────────────────
// Merchant wallet summary: balance, points, in/out totals
router.get('/wallet', async (req, res) => {
  try {
    const merchantId = req.user.id;

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const moid  = new (require('mongoose').Types.ObjectId)(merchantId);

    const [agg, todayAgg, merchant] = await Promise.all([
      Transaction.aggregate([
        { $match: { merchantId: moid, status: 'completed' } },
        { $group: { _id: '$type', total: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        { $match: { merchantId: moid, status: 'completed', type: 'income', createdAt: { $gte: today } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      User.findById(merchantId).select('walletBalance walletPoints storeName'),
    ]);

    const byType = {};
    agg.forEach(r => { byType[r._id] = r.total; });

    const totalIn  = (byType['income'] || 0) + (byType['gift_back'] || 0) + (byType['reward'] || 0);
    const totalOut = byType['expense'] || 0;

    res.json({
      success: true,
      data: {
        balance:      merchant?.walletBalance || 0,
        points:       merchant?.walletPoints  || 0,
        totalVipsIn:  totalIn,
        totalVipsOut: totalOut,
        todayEarning: todayAgg[0]?.total || 0,
        netBalance:   totalIn - totalOut,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/wallet/payout ─────────────────────
// Funds are held (deducted from walletBalance) the moment the request is
// made — see models/Payout.js for why this stays 'pending' rather than
// actually disbursing (no bank rail is wired up).
router.post('/wallet/payout', async (req, res) => {
  try {
    const { amount, bankName, accountName, accountNumber } = req.body;
    const amt = Number(amount);
    if (!amt || amt <= 0) {
      return res.status(400).json({ success: false, message: 'A valid amount is required' });
    }
    if (!accountName || !accountNumber) {
      return res.status(400).json({ success: false, message: 'Account name and number are required' });
    }

    const merchant = await User.findById(req.user.id);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
    if ((merchant.walletBalance || 0) < amt) {
      return res.status(400).json({ success: false, message: 'Insufficient wallet balance' });
    }

    merchant.walletBalance -= amt;

    const [payout] = await Promise.all([
      Payout.create({
        merchantId: req.user.id, amount: amt,
        bankName: bankName || '', accountName, accountNumber,
      }),
      merchant.save(),
      Transaction.create({
        userId: req.user.id, merchantId: req.user.id, type: 'debit', amount: amt,
        currency: 'TND', description: 'Payout requested', status: 'pending',
        reference: `PAYOUT-${Date.now()}`,
      }),
    ]);

    res.status(201).json({ success: true, message: 'Payout requested', data: payout });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/wallet/payouts ─────────────────────
router.get('/wallet/payouts', async (req, res) => {
  try {
    const payouts = await Payout.find({ merchantId: req.user.id }).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, data: payouts });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════════════════════════

// ─── GET /api/merchant/profile ────────────────────────────
router.get('/profile', async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'Merchant not found' });
    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/merchant/profile ────────────────────────────
router.put('/profile', async (req, res) => {
  try {
    const { storeName, storeCategory, phone, address, description, logo, coverImage, brandColor, profileImage } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { storeName, storeCategory, phone, address, description, logo, coverImage, brandColor, profileImage },
      { new: true, runValidators: true }
    ).select('-password');
    res.json({ success: true, message: 'Profile updated', data: user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// CUSTOMERS
// ═══════════════════════════════════════════════════════════

// ─── GET /api/merchant/customers ──────────────────────────
router.get('/customers', async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;

    const customerIds = await Transaction.distinct('userId', { merchantId: req.user.id });

    const userFilter = { _id: { $in: customerIds } };
    if (search) {
      userFilter.$or = [
        { fullName: { $regex: search, $options: 'i' } },
        { phone:    { $regex: search, $options: 'i' } },
        { email:    { $regex: search, $options: 'i' } },
      ];
    }

    const [customers, total] = await Promise.all([
      User.find(userFilter)
        .select('fullName email phone walletPoints walletBalance createdAt profileImage')
        .skip((page - 1) * limit)
        .limit(parseInt(limit)),
      User.countDocuments(userFilter),
    ]);

    res.json({ success: true, data: { customers, total } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// TRANSACTIONS  (finance ledger)
// ═══════════════════════════════════════════════════════════

// ─── GET /api/merchant/transactions ───────────────────────
router.get('/transactions', async (req, res) => {
  try {
    const { type, status, page = 1, limit = 20 } = req.query;
    const filter = { merchantId: req.user.id };
    if (type)   filter.type   = type;
    if (status) filter.status = status;

    const [transactions, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .populate('userId', 'fullName email phone'),
      Transaction.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: {
        transactions,
        pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/transaction ───────────────────────
router.post('/transaction', async (req, res) => {
  try {
    const { userId, type, amount, currency, description } = req.body;
    const tx = await Transaction.create({
      userId:      userId || req.user.id,
      merchantId:  req.user.id,
      type,
      amount:      parseFloat(amount),
      currency:    currency || 'GMD',
      description: description || '',
      status:      'completed',
      reference:   `TXN-${Date.now()}`,
    });
    res.status(201).json({ success: true, message: 'Transaction created', data: { transaction: tx } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// FINANCE  (income / expense journal)
// ═══════════════════════════════════════════════════════════

// ─── GET /api/merchant/finance ────────────────────────────
router.get('/finance', async (req, res) => {
  try {
    const { type, page = 1, limit = 20 } = req.query;
    const filter = { merchantId: req.user.id };
    if (type) filter.type = type;

    const [txs, all] = await Promise.all([
      Transaction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(parseInt(limit)),
      Transaction.find({ merchantId: req.user.id }),
    ]);

    const totalIncome  = all.filter(t => ['income', 'reward', 'gift_back'].includes(t.type)).reduce((s, t) => s + t.amount, 0);
    const totalExpense = all.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);

    res.json({
      success: true,
      data: {
        transactions: txs,
        totalIncome,
        totalExpense,
        cashBalance:  totalIncome - totalExpense,
        bankBalance:  0,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/finance ───────────────────────────
router.post('/finance', async (req, res) => {
  try {
    const { title, category, amount, type, account, description } = req.body;
    if (!amount || !type) {
      return res.status(400).json({ success: false, message: 'amount and type are required' });
    }
    const tx = await Transaction.create({
      userId:      req.user.id,
      merchantId:  req.user.id,
      type:        type === 'income' ? 'income' : 'expense',
      amount:      parseFloat(amount),
      currency:    'GMD',
      description: title || description || '',
      status:      'completed',
      reference:   `FIN-${Date.now()}`,
    });
    res.status(201).json({ success: true, message: 'Transaction added', data: tx });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════

// Status-timestamp map — used when updating order status
const STATUS_TIMESTAMP = {
  pending:          'pendingAt',
  confirmed:        'confirmedAt',
  processing:       'processingAt',
  handover:         'handoverAt',
  picked_up:        'pickedUpAt',
  delivered:        'deliveredAt',
  canceled:         'canceledAt',
  refund_requested: 'refundRequestedAt',
  refunded:         'refundedAt',
};

// Cancel reasons list
const CANCEL_REASONS = [
  'Out of stock',
  'Restaurant is closed',
  'Too busy to accept orders',
  'Customer requested cancellation',
  'Delivery not available in area',
  'Other',
];

// Helper: resolve order by numeric orderNumber OR MongoDB _id
async function findMerchantOrder(id, merchantId) {
  // Only treat as numeric if the entire string is digits (avoids parseInt("6a55...") → 6)
  if (/^\d+$/.test(String(id))) {
    return Order.findOne({ orderNumber: parseInt(id, 10), merchantId })
      .populate('userId', 'fullName phone email profileImage createdAt updatedAt');
  }
  if (mongoose.Types.ObjectId.isValid(id)) {
    return Order.findOne({ _id: id, merchantId })
      .populate('userId', 'fullName phone email profileImage createdAt updatedAt');
  }
  return null;
}

// ─── GET /api/merchant/orders ─────────────────────────────
// ?type=store  → return cancel reasons list
// ?status=X&offset=Y&limit=10 → paginated list (Flutter format)
router.get('/orders', async (req, res) => {
  try {
    const { status, type, offset = 0, limit = 10 } = req.query;

    // Cancel reasons endpoint
    if (type === 'store') {
      return res.json({ reasons: CANCEL_REASONS });
    }

    const filter = { merchantId: req.user.id };
    if (status && status !== 'all' && status !== '') filter.status = status;

    const parsedOffset = parseInt(offset);
    const parsedLimit  = parseInt(limit);

    const [orders, total, merchant] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip(parsedOffset)
        .limit(parsedLimit)
        .populate('userId', 'fullName phone email profileImage createdAt updatedAt'),
      Order.countDocuments(filter),
      User.findById(req.user.id).select('storeName address phone logo'),
    ]);

    res.json({
      total_size: total,
      limit:      String(parsedLimit),
      offset:     String(parsedOffset),
      orders:     orders.map(o => o.toMerchantJSON(merchant)),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/orders/stats ───────────────────────
// Registered before GET /orders/:id so 'stats' doesn't get swallowed as an
// :id. True lifetime totals — the repository used to derive these purely
// from the ?status=pending list (AppConstants.currentOrdersUri), so
// "Total Orders"/"Total Revenue" only ever counted pending orders.
router.get('/orders/stats', async (req, res) => {
  try {
    const merchantId = req.user.id;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [totalOrders, pendingOrders, completedOrders, todayOrders, revenueAgg] = await Promise.all([
      Order.countDocuments({ merchantId }),
      Order.countDocuments({ merchantId, status: 'pending' }),
      Order.countDocuments({ merchantId, status: 'delivered' }),
      Order.countDocuments({ merchantId, createdAt: { $gte: startOfDay } }),
      Order.aggregate([
        { $match: { merchantId: new (require('mongoose').Types.ObjectId)(merchantId), paymentStatus: 'paid' } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]),
    ]);

    res.json({
      success: true,
      data: {
        totalOrders,
        pendingOrders,
        completedOrders,
        todayOrders,
        totalRevenue: revenueAgg[0]?.total || 0,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/orders ────────────────────────────
// Flutter sends status updates as POST with _method=put in body
// Body: { order_id, status, _method: 'put', reason, otp, processing_time }
router.post('/orders', async (req, res) => {
  try {
    const { order_id, status, reason, otp, processing_time } = req.body;

    const order = await findMerchantOrder(String(order_id), req.user.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const tsField = STATUS_TIMESTAMP[status];
    const update  = { status };
    if (tsField)          update[tsField]        = new Date();
    if (reason)           update.cancellationReason = reason;
    if (otp)              update.otp              = otp;
    if (processing_time)  update.processingTime   = parseInt(processing_time);

    Object.assign(order, update);
    await order.save();

    try {
      const { push } = require('./merchant_notifications');
      await push(req.user.id, 'Order Updated',
        `Order #${order.orderNumber} → ${status}`, 'order', { orderId: order._id });
    } catch (_) {}

    const merchant = await User.findById(req.user.id).select('storeName address phone logo');
    res.json({ success: true, message: 'Order status updated successfully', data: order.toMerchantJSON(merchant) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/orders/:id ─────────────────────────
router.get('/orders/:id', async (req, res) => {
  try {
    const order = await findMerchantOrder(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const merchant = await User.findById(req.user.id).select('storeName address phone logo');
    res.json(order.toMerchantJSON(merchant));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/orders/:id/items ───────────────────
router.get('/orders/:id/items', async (req, res) => {
  try {
    const order = await findMerchantOrder(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const items = (order.items || []).map((item, idx) => ({
      id:                 idx + 1,
      item_id:            item.productId ? parseInt(item.productId.toString().slice(-6), 16) : idx + 1,
      order_id:           order.orderNumber,
      price:              item.price || 0,
      variation:          item.variation || [],
      add_ons:            item.add_ons  || [],
      discount_on_item:   item.discount_on_item  || 0,
      discount_type:      item.discount_type     || 'amount',
      quantity:           item.quantity  || 1,
      tax_amount:         item.tax_amount || 0,
      variant:            item.variant   || '',
      created_at:         order.createdAt?.toISOString() || null,
      updated_at:         order.updatedAt?.toISOString() || null,
      item_campaign_id:   null,
      total_add_on_price: item.total_add_on_price || 0,
      item_name:          item.item_name          || '',
      item_image_full_url:item.item_image_full_url || '',
      item_description:   item.item_description   || '',
    }));

    res.json(items);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/merchant/orders/:id/status ──────────────────
// Legacy endpoint kept for compatibility; forwards to the same logic
router.put('/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const order = await findMerchantOrder(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const tsField = STATUS_TIMESTAMP[status];
    order.status = status;
    if (tsField) order[tsField] = new Date();

    // Cash on delivery settles at the door — mark it paid and earn the
    // customer their points at the same moment an online gateway's webhook
    // would (routes/payment.js). Online-method orders are left alone here;
    // their paymentStatus is only ever set by the gateway confirming.
    if (status === 'delivered' && order.paymentMethod === 'cash' && order.paymentStatus === 'pending') {
      order.paymentStatus = 'paid';
    }

    // Merchant approving a refund_requested order (see POST
    // /order/:id/request-refund for how it gets into that state): reverse
    // whatever was actually paid and credited, don't just relabel the
    // status. Denying a refund is just another status update — it goes
    // through this same route with status back to 'delivered' and hits
    // none of this.
    let refundedPoints = 0;
    if (status === 'refunded' && order.paymentStatus !== 'refunded') {
      if (order.pointsCredited) {
        const earnedPoints = Math.floor(order.totalAmount || 0);
        const user = await User.findById(order.userId);
        if (user) {
          user.walletPoints = Math.max(0, (user.walletPoints || 0) - earnedPoints);
          await user.save();
          refundedPoints = earnedPoints;
        }
      }
      order.paymentStatus = 'refunded';
    }
    await order.save();

    if (refundedPoints > 0) {
      await Transaction.create({
        userId: order.userId,
        merchantId: req.user.id,
        type: 'debit',
        amount: refundedPoints,
        currency: 'PTS',
        description: `${refundedPoints} VIPS points reversed — order #${order.orderNumber} refunded`,
        status: 'completed',
        reference: `ORDER-REFUND-${order._id}`,
      });
    }

    if (order.paymentStatus === 'paid' && !order.pointsCredited) {
      const { creditPointsForOrder } = require('../utils/points');
      await creditPointsForOrder(order);
    }

    try {
      const { push } = require('./merchant_notifications');
      await push(req.user.id, 'Order Updated',
        `Order #${order.orderNumber} → ${status}`, 'order', { orderId: order._id });
    } catch (_) {}

    const merchant = await User.findById(req.user.id).select('storeName address phone logo');
    res.json({ success: true, message: 'Order status updated', data: order.toMerchantJSON(merchant) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// GIFT BACK
// ═══════════════════════════════════════════════════════════

// ─── GET /api/merchant/gift-back/lookup ───────────────────
// Resolves a scanned VIPs QR (VIPS_USER_<id>, see vips_id_view.dart) or a
// typed phone number to a display name before the merchant confirms the
// send — deliberately not scoped to /merchant/customers' transaction
// history, since a gift-back's whole point can be a first-time customer.
router.get('/gift-back/lookup', async (req, res) => {
  try {
    const { userId, phone } = req.query;
    if (!userId && !phone) {
      return res.status(400).json({ success: false, message: 'userId or phone is required' });
    }
    const recipient = userId
      ? await User.findById(userId).select('fullName phone')
      : await User.findOne({ phone: String(phone).trim() }).select('fullName phone');
    if (!recipient) return res.status(404).json({ success: false, message: 'No customer found' });

    res.json({ success: true, data: { userId: recipient._id, fullName: recipient.fullName, phone: recipient.phone } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/gift-back ─────────────────────────
router.post('/gift-back', async (req, res) => {
  try {
    const { userId, phone, amount, message } = req.body;
    if ((!userId && !phone) || !amount) {
      return res.status(400).json({ success: false, message: 'userId or phone, and amount, are required' });
    }

    // The merchant-app flow only ever collects a phone number (there's no
    // reason a merchant would know a stranger's Mongo _id) — resolving it
    // here, rather than requiring the app to pre-resolve it via
    // /merchant/customers, also works for a customer this merchant has
    // never transacted with before, which that endpoint can't find (it's
    // scoped to this merchant's existing Transaction history).
    const recipient = userId
      ? await User.findById(userId)
      : await User.findOne({ phone: String(phone).trim() });
    if (!recipient) return res.status(404).json({ success: false, message: 'No customer found with that phone number' });

    recipient.walletPoints = (recipient.walletPoints || 0) + parseFloat(amount);
    await recipient.save();

    const tx = await Transaction.create({
      userId: recipient._id,
      merchantId:  req.user.id,
      type:        'gift_back',
      amount:      parseFloat(amount),
      currency:    'PTS',
      description: message || 'Gift back from merchant',
      status:      'completed',
      reference:   `GIFT-${Date.now()}`,
    });

    res.status(201).json({ success: true, message: 'Gift back sent!', data: { ...tx.toObject(), recipientName: recipient.fullName, recipientPhone: recipient.phone } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/gift-back/history ──────────────────
router.get('/gift-back/history', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const filter = { merchantId: req.user.id, type: 'gift_back', status: 'completed' };

    const [txs, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .populate('userId', 'fullName phone'),
      Transaction.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { transactions: txs, total, pagination: { page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / limit) } },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/gift-back/limits ───────────────────
router.get('/gift-back/limits', async (req, res) => {
  try {
    const merchantId = req.user.id;
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const DAILY_LIMIT = 1000;
    const MONTHLY_LIMIT = 10000;
    const TX_MIN = 1;
    const TX_MAX = 1000;

    const [dailyUsed, monthlyUsed] = await Promise.all([
      Transaction.aggregate([
        { $match: { merchantId: require('mongoose').Types.ObjectId.createFromHexString(merchantId), type: 'gift_back', createdAt: { $gte: startOfDay } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        { $match: { merchantId: require('mongoose').Types.ObjectId.createFromHexString(merchantId), type: 'gift_back', createdAt: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    const dailyUsedAmt = dailyUsed[0]?.total || 0;
    const monthlyUsedAmt = monthlyUsed[0]?.total || 0;

    res.json({
      success: true,
      data: {
        currency: 'D',
        dailyLimit: DAILY_LIMIT,
        remainingDailyLimit: Math.max(0, DAILY_LIMIT - dailyUsedAmt),
        monthlyLimit: MONTHLY_LIMIT,
        remainingMonthlyLimit: Math.max(0, MONTHLY_LIMIT - monthlyUsedAmt),
        txMin: TX_MIN,
        txMax: TX_MAX,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// CASHIERS
// ═══════════════════════════════════════════════════════════

// ─── GET /api/merchant/cashiers ───────────────────────────
router.get('/cashiers', async (req, res) => {
  try {
    const cashiers = await Employee.find({ merchantId: req.user.id }).sort({ createdAt: -1 });
    res.json({ success: true, data: cashiers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/cashiers ──────────────────────────
router.post('/cashiers', async (req, res) => {
  try {
    const cashier = await Employee.create({ ...req.body, merchantId: req.user.id });
    res.status(201).json({ success: true, message: 'Cashier added', data: cashier });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/merchant/cashiers/:id ───────────────────────
router.put('/cashiers/:id', async (req, res) => {
  try {
    const cashier = await Employee.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      req.body,
      { new: true }
    );
    if (!cashier) return res.status(404).json({ success: false, message: 'Cashier not found' });
    res.json({ success: true, data: cashier });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── DELETE /api/merchant/cashiers/:id ────────────────────
router.delete('/cashiers/:id', async (req, res) => {
  try {
    await Employee.findOneAndDelete({ _id: req.params.id, merchantId: req.user.id });
    res.json({ success: true, message: 'Cashier removed' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// REVIEWS
// ═══════════════════════════════════════════════════════════

// ─── GET /api/merchant/reviews ────────────────────────────
router.get('/reviews', async (req, res) => {
  try {
    const orders = await Order.find({
      merchantId: req.user.id,
      rating: { $exists: true, $gt: 0 },
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('userId', 'fullName phone');

    const reviews = orders.map(o => ({
      _id:          o._id,
      customerName: o.userId?.fullName || 'Customer',
      customerPhone:o.userId?.phone    || '',
      rating:       o.rating  || 5,
      comment:      o.review  || '',
      createdAt:    o.createdAt,
    }));

    const avg = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;

    res.json({ success: true, data: { reviews, average: parseFloat(avg.toFixed(1)), total: reviews.length } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════

// ─── GET /api/merchant/reports ────────────────────────────
router.get('/reports', async (req, res) => {
  try {
    const { from, to, type } = req.query;
    const merchantId = req.user.id;

    const filter = { merchantId, status: 'completed' };
    if (type) filter.type = type;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to)   filter.createdAt.$lte = new Date(to);
    }

    const transactions = await Transaction.find(filter).sort({ createdAt: -1 });

    const totalIncome   = transactions.filter(t => t.type === 'income')   .reduce((s, t) => s + t.amount, 0);
    const totalExpense  = transactions.filter(t => t.type === 'expense')  .reduce((s, t) => s + t.amount, 0);
    const totalGiftBack = transactions.filter(t => t.type === 'gift_back').reduce((s, t) => s + t.amount, 0);

    // Monthly breakdown
    const monthlyMap = {};
    transactions.forEach(t => {
      const key = new Date(t.createdAt).toISOString().slice(0, 7);
      if (!monthlyMap[key]) monthlyMap[key] = { income: 0, expense: 0, giftBack: 0, count: 0 };
      if (t.type === 'income')    monthlyMap[key].income   += t.amount;
      if (t.type === 'expense')   monthlyMap[key].expense  += t.amount;
      if (t.type === 'gift_back') monthlyMap[key].giftBack += t.amount;
      monthlyMap[key].count++;
    });

    res.json({
      success: true,
      data: {
        summary: {
          totalIncome,
          totalExpense,
          totalGiftBack,
          netProfit:        totalIncome - totalExpense,
          transactionCount: transactions.length,
        },
        transactions,
        monthlyBreakdown: Object.entries(monthlyMap)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, data]) => ({ month, ...data })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// CRUD SUB-ROUTES  (stock, assets, tax-rates, staff, dues)
// ═══════════════════════════════════════════════════════════

function crudRouter(Model, sortField = 'createdAt') {
  const r = express.Router();

  r.get('/', async (req, res) => {
    try {
      const items = await Model.find({ merchantId: req.user.id }).sort({ [sortField]: -1 });
      res.json({ success: true, data: items });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  r.post('/', async (req, res) => {
    try {
      const item = await Model.create({ ...req.body, merchantId: req.user.id });
      res.status(201).json({ success: true, data: item });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  r.put('/:id', async (req, res) => {
    try {
      const item = await Model.findOneAndUpdate(
        { _id: req.params.id, merchantId: req.user.id },
        req.body,
        { new: true }
      );
      if (!item) return res.status(404).json({ success: false, message: 'Not found' });
      res.json({ success: true, data: item });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  r.delete('/:id', async (req, res) => {
    try {
      await Model.findOneAndDelete({ _id: req.params.id, merchantId: req.user.id });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  return r;
}

router.use('/stock',     crudRouter(Stock));
router.use('/assets',    crudRouter(Asset));
router.use('/tax-rates', crudRouter(TaxRate));
router.use('/staff',     crudRouter(Staff));
router.use('/dues',      crudRouter(Due, 'lastTransaction'));

// ═══════════════════════════════════════════════════════════
// PRODUCTS  (merchant's own catalog)
// ═══════════════════════════════════════════════════════════

// ─── GET /api/merchant/products ───────────────────────────
router.get('/products', async (req, res) => {
  try {
    const { category, isActive } = req.query;
    const filter = { merchantId: req.user.id };
    if (category && category !== 'All') filter.category = category;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    const products = await Product.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, data: products });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── POST /api/merchant/products ──────────────────────────
router.post('/products', async (req, res) => {
  try {
    const { name, category, price, image, description, isFeature, hasVariants, isActive, vat, code, taxMethod } = req.body;
    if (!name || !price || !category) {
      return res.status(400).json({ success: false, message: 'name, price, and category are required' });
    }
    const product = await Product.create({
      merchantId: req.user.id,
      name, category, price, image, description,
      isFeature: isFeature ?? false,
      hasVariants: hasVariants ?? false,
      isActive: isActive !== false,
      vat: parseFloat(vat || 0),
      code: code || '',
      taxMethod: taxMethod || 'Exclusive',
    });
    res.status(201).json({ success: true, message: 'Product created successfully', data: product });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── PUT /api/merchant/products/:id ───────────────────────
router.put('/products/:id', async (req, res) => {
  try {
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      req.body,
      { new: true, runValidators: true }
    );
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, message: 'Product updated successfully', data: product });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── DELETE /api/merchant/products/:id ────────────────────
router.delete('/products/:id', async (req, res) => {
  try {
    const product = await Product.findOneAndDelete({ _id: req.params.id, merchantId: req.user.id });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, message: 'Product deleted successfully' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── GET  /api/merchant/coupons ───────────────────────────
router.get('/coupons', async (req, res) => {
  try {
    const coupons = await Coupon.find({ merchantId: req.user.id }).sort({ createdAt: -1 });
    res.json({ success: true, data: coupons });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── POST /api/merchant/coupons ───────────────────────────
router.post('/coupons', async (req, res) => {
  try {
    const { code, discount, discountPercentage, maxDiscountAmount, expiryDate, isActive, type, tags, maxUsage, minOrderAmount } = req.body;
    const discountValue = parseFloat(discount ?? discountPercentage ?? 0);
    if (!code || isNaN(discountValue)) {
      return res.status(400).json({ success: false, message: 'code and discount are required' });
    }
    const existing = await Coupon.findOne({ code: code.toUpperCase() });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Coupon code already exists' });
    }
    const coupon = await Coupon.create({
      code:              code.toUpperCase(),
      discount:          discountValue,
      maxDiscountAmount: maxDiscountAmount ? parseFloat(maxDiscountAmount) : null,
      type:              type || 'percentage',
      expiryDate:        expiryDate ? new Date(expiryDate) : new Date(Date.now() + 30 * 86400000),
      isActive:          isActive !== false,
      merchantId:        req.user.id,
      tags:              Array.isArray(tags) ? tags : [],
      maxUsage:          maxUsage ? parseInt(maxUsage) : null,
      minOrderAmount:    minOrderAmount ? parseFloat(minOrderAmount) : 0,
    });
    res.status(201).json({ success: true, data: coupon });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── PUT  /api/merchant/coupons/:id ──────────────────────
router.put('/coupons/:id', async (req, res) => {
  try {
    const coupon = await Coupon.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      req.body,
      { new: true }
    );
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found' });
    res.json({ success: true, data: coupon });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── DELETE /api/merchant/coupons/:id ────────────────────
router.delete('/coupons/:id', async (req, res) => {
  try {
    await Coupon.findOneAndDelete({ _id: req.params.id, merchantId: req.user.id });
    res.json({ success: true, message: 'Coupon deleted' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
