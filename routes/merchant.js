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

/**
 * Push an order update to the customer who placed it, over the chat socket.
 *
 * Reuses that connection rather than opening a second one: the customer app
 * already holds it open, and a second socket would double the connections
 * for one more kind of message. Delivered to the customer's own room, so an
 * order update reaches them and nobody else.
 *
 * Never throws — a missed live update is a screen that refreshes a moment
 * later, while a thrown error would fail the status change itself.
 */
function emitOrderUpdate(req, order, event, payload) {
  try {
    const io = req.app.get('io');
    if (!io || !order.userId) return;
    // `findMerchantOrder` populates userId, so this is a document, not an id.
    // Stringifying it directly produced a room name nothing was listening on,
    // and the push silently went nowhere.
    const customerId = String(order.userId._id || order.userId);
    io.to(customerId).emit(event, {
      orderId: String(order._id),
      status: order.status,
      ...payload,
    });
  } catch (error) {
    console.error('[ORDER] could not push live update:', error.message);
  }
}

const User        = require('../models/User');
const Transaction = require('../models/Transaction');
const Order       = require('../models/Order');
const Stock       = require('../models/Stock');
const { recordMovement, movementTypeForDelta } = require('../utils/stockLedger');
const Asset       = require('../models/Asset');
const TaxRate     = require('../models/TaxRate');
const Staff       = require('../models/Staff');
const Due         = require('../models/Due');
const Employee    = require('../models/Employee');
const Coupon      = require('../models/Coupon');
const Payout      = require('../models/Payout');
const GuaranteeLedger = require('../models/GuaranteeLedger');
const PosInvoice  = require('../models/PosInvoice');
const BusinessRegistration = require('../models/BusinessRegistration');
const Product = require('../models/Product');
const guarantee = require('../utils/guarantee');
const giftback  = require('../utils/giftback');
const {
  pointsForInvoice, pointsToTnd, tndToPoints, DEFAULT_EARN_RATE, GIFTBACK, BUDGET_LABELS,
  EDIT_COOLDOWN, cooldownUntil,
} = require('../config/economics');

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
      licenseExpiry,
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
      ...(licenseExpiry ? { licenseExpiry: new Date(licenseExpiry) } : {}),
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
    // `address` / `description` are NOT User fields — the schema calls them
    // storeAddress / storeDescription, so passing them through verbatim meant
    // Mongoose strict mode dropped both while the route still answered
    // "Registration submitted successfully": a merchant's real street address
    // and store description never made it out of the registration record.
    const userUpdate = {};
    if (storeName   !== undefined) userUpdate.storeName        = storeName;
    if (category    !== undefined) userUpdate.storeCategory    = category;
    if (phone       !== undefined) userUpdate.phone            = phone;
    if (address     !== undefined) userUpdate.storeAddress     = address;
    if (description !== undefined) userUpdate.storeDescription = description;
    if (Object.keys(userUpdate).length) {
      await User.findByIdAndUpdate(merchantId, { $set: userUpdate });
    }
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

    // ?period=today|week|month|all (default all) — powers the period selector
    // on the merchant dashboard's Performance card. Cumulative, not exclusive:
    // "month" includes this week and today.
    const period = String(req.query.period || 'all').toLowerCase();
    const startOf = () => {
      const d = new Date(); d.setHours(0, 0, 0, 0);
      if (period === 'today') return d;
      if (period === 'week')  { const w = new Date(d); w.setDate(d.getDate() - d.getDay()); return w; }
      if (period === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
      return null;
    };
    const since = startOf();
    const dateFilter = since ? { createdAt: { $gte: since } } : {};

    const [agg, pending, total, dueAgg, stockAgg, recoveryAgg] = await Promise.all([
      Transaction.aggregate([
        { $match: { merchantId: merchantObjectId, status: 'completed', ...dateFilter } },
        { $group: {
            _id: '$type',
            total: { $sum: '$amount' },
            count: { $sum: 1 },
        }},
      ]),
      Transaction.countDocuments({ merchantId, status: 'pending', ...dateFilter }),
      Transaction.countDocuments({ merchantId, ...dateFilter }),
      // Sale Due / Due Collect cards: real outstanding-vs-collected totals
      // from the Due ledger (routes/dues.js), not transaction-derived.
      Due.aggregate([
        { $match: { merchantId: merchantObjectId, ...dateFilter } },
        { $group: {
            _id: null,
            totalDue:       { $sum: { $subtract: ['$totalAmount', '$paidAmount'] } },
            totalCollected: { $sum: '$paidAmount' },
        }},
      ]),
      // Stock Value card: current inventory value (stock on hand × unit
      // price). There is no supplier purchase-order log in the schema, so
      // this is inventory on hand — a point-in-time balance, deliberately
      // NOT filtered by ?period (a "today" filter on a stock level is
      // meaningless). The app labels this card "Stock Value" accordingly.
      Stock.aggregate([
        { $match: { merchantId: merchantObjectId } },
        { $group: { _id: null, value: { $sum: { $multiply: ['$currentStock', '$unitPrice'] } } } },
      ]),

      // §5.2 "VIPs Recovery": guarantee points the merchant has taken back
      // out as a bank transfer. Refund entries are signed negative on the
      // ledger, so the sum is negated to report it as an amount recovered.
      GuaranteeLedger.aggregate([
        { $match: { merchantId: merchantObjectId, type: 'refund' } },
        { $group: { _id: null, points: { $sum: '$points' }, tnd: { $sum: '$tnd' } } },
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
        // "VIPs Recovery" (§5.2): guarantee points the merchant has taken
        // back out as a bank transfer. This card used to read "VIPs Issued"
        // and showed rewards + gift-backs added together — two different
        // outflows summed into a figure that answered no question, and
        // already shown individually either side of it.
        vipsRecoveryPoints:  Math.abs(recoveryAgg[0]?.points || 0),
        vipsRecoveryTnd:     Math.abs(recoveryAgg[0]?.tnd || 0),
        transactionCount:    total,
        period,
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

    // Group by type + raw createdAt bucket flags rather than a $switch, so the
    // periods stay CUMULATIVE. The previous $switch stopped at the first
    // matching branch, which meant a transaction from today was counted in
    // "today" and then excluded from "week" and "month" — making both of those
    // totals silently too low.
    const agg = await Transaction.aggregate([
      { $match: { merchantId: moid, status: 'completed' } },
      {
        $group: {
          _id: {
            type:    '$type',
            isToday: { $gte: ['$createdAt', today] },
            isWeek:  { $gte: ['$createdAt', weekStart] },
            isMonth: { $gte: ['$createdAt', monthStart] },
          },
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]);

    const build = (period) => {
      const flag = { today: 'isToday', week: 'isWeek', month: 'isMonth' }[period];
      const rows = agg.filter(r => r._id[flag]);
      const get  = (type) => rows
        .filter(r => r._id.type === type)
        .reduce((sum, r) => sum + r.total, 0);
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

    const [agg, todayAgg, merchant, pendingPointsAgg, pendingPayoutAgg] = await Promise.all([
      Transaction.aggregate([
        { $match: { merchantId: moid, status: 'completed' } },
        { $group: { _id: '$type', total: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        { $match: { merchantId: moid, status: 'completed', type: 'income', createdAt: { $gte: today } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      User.findById(merchantId).select('walletBalance walletPoints storeName'),
      // Points movements not yet settled. The wallet screen has a
      // "N points pending" line that had no field behind it at all.
      Transaction.aggregate([
        { $match: { merchantId: moid, status: 'pending', type: { $in: ['reward', 'gift_back', 'credit'] } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      // Currency already requested for payout and held, but not yet paid.
      Payout.aggregate([
        { $match: { merchantId: moid, status: { $in: ['pending', 'approved'] } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    const byType = {};
    agg.forEach(r => { byType[r._id] = r.total; });

    const totalIn  = (byType['income'] || 0) + (byType['gift_back'] || 0) + (byType['reward'] || 0);
    const totalOut = byType['expense'] || 0;

    res.json({
      success: true,
      data: {
        balance:       merchant?.walletBalance || 0,
        points:        merchant?.walletPoints  || 0,
        pendingPoints: pendingPointsAgg[0]?.total || 0,
        pendingPayout: pendingPayoutAgg[0]?.total || 0,
        totalVipsIn:   totalIn,
        totalVipsOut:  totalOut,
        todayEarning:  todayAgg[0]?.total || 0,
        netBalance:    totalIn - totalOut,
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

// ─── Payout accounts (saved bank destinations) ────────────
// GET / POST / DELETE  /api/merchant/wallet/payout-accounts
// Deliberately bank-transfer details only — no card numbers, so nothing here
// falls in PCI scope.

router.get('/wallet/payout-accounts', async (req, res) => {
  try {
    const merchant = await User.findById(req.user.id).select('payoutAccounts');
    res.json({ success: true, data: merchant?.payoutAccounts || [] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/wallet/payout-accounts', async (req, res) => {
  try {
    const { bankName, accountName, accountNumber, isDefault } = req.body;
    if (!accountName || !accountNumber) {
      return res.status(400).json({ success: false, message: 'Account name and number are required' });
    }
    const merchant = await User.findById(req.user.id);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    merchant.payoutAccounts = merchant.payoutAccounts || [];
    const duplicate = merchant.payoutAccounts.find(
      a => a.accountNumber === String(accountNumber).trim()
    );
    if (duplicate) {
      return res.status(400).json({ success: false, message: 'That account is already saved' });
    }

    const makeDefault = isDefault === true || merchant.payoutAccounts.length === 0;
    if (makeDefault) merchant.payoutAccounts.forEach(a => { a.isDefault = false; });

    merchant.payoutAccounts.push({
      bankName:      String(bankName || '').trim(),
      accountName:   String(accountName).trim(),
      accountNumber: String(accountNumber).trim(),
      isDefault:     makeDefault,
    });
    await merchant.save();
    res.status(201).json({ success: true, message: 'Payout account saved', data: merchant.payoutAccounts });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/wallet/payout-accounts/:id', async (req, res) => {
  try {
    const merchant = await User.findById(req.user.id);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    const before = (merchant.payoutAccounts || []).length;
    merchant.payoutAccounts = (merchant.payoutAccounts || []).filter(
      a => String(a._id) !== String(req.params.id)
    );
    if (merchant.payoutAccounts.length === before) {
      return res.status(404).json({ success: false, message: 'Payout account not found' });
    }
    // Never leave the list without a default.
    if (merchant.payoutAccounts.length && !merchant.payoutAccounts.some(a => a.isDefault)) {
      merchant.payoutAccounts[0].isDefault = true;
    }
    await merchant.save();
    res.json({ success: true, message: 'Payout account removed', data: merchant.payoutAccounts });
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
// ─── GET /api/merchant/storefront-discount ────────────────
// The shop-wide discount and whether it may be changed yet.
router.get('/storefront-discount', async (req, res) => {
  try {
    const merchant = await User.findById(req.user.id).select('discountPercentage discountChangedAt');
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    const locked = cooldownUntil(merchant.discountChangedAt, EDIT_COOLDOWN.STORE_DISCOUNT_HOURS);
    res.json({
      success: true,
      data: {
        discountPercentage: merchant.discountPercentage || 0,
        editable: !locked,
        editableAt: locked,
        cooldownHours: EDIT_COOLDOWN.STORE_DISCOUNT_HOURS,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── PUT /api/merchant/storefront-discount ────────────────
/**
 * Changes the discount shown across the shop's storefront.
 *
 * Held for a day between changes. The banner is what a customer decides to
 * visit on; a figure that can be rewritten minute to minute is not an offer,
 * and the merchant confirming it is the point of the wait rather than a
 * formality.
 */
router.put('/storefront-discount', async (req, res) => {
  try {
    const value = parseFloat(req.body.discountPercentage);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return res.status(400).json({
        success: false,
        message: 'The discount has to be between 0 and 100 percent.',
      });
    }

    const merchant = await User.findById(req.user.id);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    if ((merchant.discountPercentage || 0) === value) {
      return res.json({
        success: true,
        message: 'That is already your discount.',
        data: { discountPercentage: value, editable: false },
      });
    }

    const locked = cooldownUntil(merchant.discountChangedAt, EDIT_COOLDOWN.STORE_DISCOUNT_HOURS);
    if (locked) {
      const hoursLeft = Math.ceil((locked - Date.now()) / 3600000);
      return res.status(409).json({
        success: false,
        code: 'EDIT_COOLDOWN',
        message: `You changed your storefront discount recently. You can change it again in ${hoursLeft} hour(s).`,
        data: { availableAt: locked, hoursRemaining: hoursLeft },
      });
    }

    merchant.discountPercentage = value;
    merchant.discountChangedAt = new Date();
    await merchant.save();

    const nextChange = cooldownUntil(merchant.discountChangedAt, EDIT_COOLDOWN.STORE_DISCOUNT_HOURS);
    res.json({
      success: true,
      message: `Your storefront now shows ${value}% off.`,
      data: {
        discountPercentage: value,
        editable: false,
        editableAt: nextChange,
        cooldownHours: EDIT_COOLDOWN.STORE_DISCOUNT_HOURS,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/profile', async (req, res) => {
  try {
    const {
      storeName, storeCategory, phone, logo, coverImage, brandColor, profileImage,
      // The app sends these under their plain names; the User schema stores
      // them as storeAddress / storeDescription. Previously they were passed
      // straight through as `address` / `description`, which Mongoose's strict
      // mode silently dropped — the route still answered "Profile updated"
      // while nothing was saved. Accept either spelling and map to the real
      // schema fields.
      address, storeAddress, description, storeDescription,
    } = req.body;

    // Build the $set from only the keys actually supplied, so a partial
    // update (e.g. logo-only after an image upload) can't blank the rest.
    const update = {};
    const setIf = (key, value) => { if (value !== undefined) update[key] = value; };
    setIf('storeName', storeName);
    setIf('storeCategory', storeCategory);
    setIf('phone', phone);
    setIf('logo', logo);
    setIf('coverImage', coverImage);
    setIf('brandColor', brandColor);
    setIf('profileImage', profileImage);
    setIf('storeAddress', storeAddress !== undefined ? storeAddress : address);
    setIf('storeDescription', storeDescription !== undefined ? storeDescription : description);

    const user = await User.findByIdAndUpdate(
      req.user.id,
      update,
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

    const moid = mongoose.Types.ObjectId.createFromHexString(String(req.user.id));
    // The merchant's own bookkeeping entries (POST /merchant/finance) are
    // stored with userId === merchantId, so a plain distinct() listed the
    // merchant as one of their own customers — complete with "visits"
    // counted from their own income/expense records.
    const customerIds = (await Transaction.distinct('userId', { merchantId: req.user.id }))
      .filter((id) => String(id) !== String(req.user.id));

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

    // Per-customer stats scoped to THIS merchant. The merchant Customers
    // screen shows Visits / Earned / Spent and a "Last visit" date; none of
    // them were served here, so Visits and Spent rendered 0 for everyone,
    // "Earned" showed the customer's platform-wide wallet balance as though
    // this merchant had given it, and "Last visit" was the signup date.
    const POINTS_IN  = ['gift_back', 'reward', 'credit'];
    const POINTS_OUT = ['expense', 'debit'];
    const statsAgg = await Transaction.aggregate([
      { $match: { merchantId: moid, userId: { $in: customers.map(c => c._id), $ne: moid } } },
      { $group: {
          _id: '$userId',
          totalVisits:  { $sum: 1 },
          lastVisit:    { $max: '$createdAt' },
          pointsEarned: { $sum: { $cond: [{ $in: ['$type', POINTS_IN] },  '$amount', 0] } },
          pointsSpent:  { $sum: { $cond: [{ $in: ['$type', POINTS_OUT] }, '$amount', 0] } },
      }},
    ]);
    const statsById = {};
    statsAgg.forEach(r => { statsById[String(r._id)] = r; });

    const enriched = customers.map(c => {
      const st = statsById[String(c._id)] || {};
      return {
        ...c.toObject(),
        totalVisits:  st.totalVisits  || 0,
        pointsEarned: st.pointsEarned || 0,
        pointsSpent:  st.pointsSpent  || 0,
        lastVisit:    st.lastVisit    || null,
      };
    });

    res.json({ success: true, data: { customers: enriched, total } });
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
    const { type, status, from, to, page = 1, limit = 20 } = req.query;
    const filter = { merchantId: req.user.id };
    if (type)   filter.type   = type;
    if (status) filter.status = status;

    // Date-range filter, backing the wallet screen's range chip (which used
    // to render the fixed literal "From: 11/26  To: 12/26" and filter nothing).
    // A bare 'YYYY-MM-DD' is treated as a whole day in UTC; a full ISO
    // timestamp is used exactly as given (the app sends the client's own
    // end-of-day instant, so the range matches the calendar the merchant
    // actually picked rather than the server's timezone).
    const isBareDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v));
    const fromDate = from ? new Date(from) : null;
    const toDate   = to   ? new Date(to)   : null;
    const fromValid = fromDate && !isNaN(fromDate.getTime());
    const toValid   = toDate   && !isNaN(toDate.getTime());
    if (fromValid || toValid) {
      filter.createdAt = {};
      if (fromValid) filter.createdAt.$gte = fromDate;
      if (toValid) {
        filter.createdAt.$lte = isBareDate(to)
          ? new Date(toDate.getTime() + 24 * 60 * 60 * 1000 - 1)
          : toDate;
      }
    }

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
      currency:    currency || 'TND',
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
const INCOME_TYPES = ['income', 'reward', 'gift_back', 'credit'];

router.get('/finance', async (req, res) => {
  try {
    const { type, category, account, page = 1, limit = 20 } = req.query;
    const filter = { merchantId: req.user.id };
    if (type)     filter.type     = type;
    if (category) filter.category = category;
    if (account)  filter.account  = account;

    const [txs, total, all] = await Promise.all([
      Transaction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(parseInt(limit)),
      Transaction.countDocuments(filter),
      Transaction.find({ merchantId: req.user.id }).select('type amount account'),
    ]);

    const isIncome = t => INCOME_TYPES.includes(t.type);
    const sum = list => list.reduce((s, t) => s + (t.amount || 0), 0);

    const totalIncome  = sum(all.filter(isIncome));
    const totalExpense = sum(all.filter(t => !isIncome(t)));

    // Per-account balances, derived from the journal rather than hardcoded.
    // `account` defaults to 'Cash' on the schema, so pre-existing rows written
    // before the field existed still land in the Cash column.
    const forAccount = name => all.filter(t => (t.account || 'Cash') === name);
    const balanceOf = name => sum(forAccount(name).filter(isIncome)) - sum(forAccount(name).filter(t => !isIncome(t)));

    res.json({
      success: true,
      data: {
        transactions: txs,
        totalIncome,
        totalExpense,
        cashBalance: balanceOf('Cash'),
        bankBalance: balanceOf('Bank'),
        // Per-account in/out, so the Accounts screen can show real statement
        // figures instead of the placeholder numbers it used to hardcode.
        accounts: ['Cash', 'Bank'].map(name => ({
          name,
          in:      sum(forAccount(name).filter(isIncome)),
          out:     sum(forAccount(name).filter(t => !isIncome(t))),
          balance: balanceOf(name),
          count:   forAccount(name).length,
        })),
        pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) },
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
    if (amount === undefined || amount === null || amount === '' || !type) {
      return res.status(400).json({ success: false, message: 'amount and type are required' });
    }
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, message: 'amount must be a number greater than 0' });
    }
    if (account && !['Cash', 'Bank'].includes(account)) {
      return res.status(400).json({ success: false, message: "account must be 'Cash' or 'Bank'" });
    }
    const tx = await Transaction.create({
      userId:      req.user.id,
      merchantId:  req.user.id,
      type:        type === 'income' ? 'income' : 'expense',
      amount:      parsedAmount,
      currency:    'TND',
      category:    category || 'Other',
      account:     account  || 'Cash',
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
    if (status && status !== 'all' && status !== '') {
      // The enum carries both spellings of cancelled, so an exact match on
      // one of them silently hid orders stored under the other.
      filter.status = (status === 'canceled' || status === 'cancelled')
        ? { $in: ['canceled', 'cancelled'] }
        : status;
    }

    const parsedOffset = parseInt(offset);
    const parsedLimit  = parseInt(limit);

    const [orders, total, merchant] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip(parsedOffset)
        .limit(parsedLimit)
        .populate('userId', 'fullName phone email profileImage createdAt updatedAt'),
      Order.countDocuments(filter),
      User.findById(req.user.id).select('storeName storeAddress phone logo'),
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
        `Order #${order.orderNumber} → ${status}`, 'order',
        { orderId: order._id, orderNumber: order.orderNumber });
    } catch (_) {}

    const merchant = await User.findById(req.user.id).select('storeName storeAddress phone logo');
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

    const merchant = await User.findById(req.user.id).select('storeName storeAddress phone logo');
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
    // `reason` was accepted by the app and sent on every cancellation, but
    // never read here — Order.cancellationReason stayed empty forever, so
    // nobody could tell why a merchant cancelled an order.
    const { status, reason } = req.body;
    // Validate up front — an unknown value used to reach order.save() and
    // come back as a raw Mongoose validation error in a 500.
    const ALLOWED = Order.schema.path('status').enumValues;
    if (!status || !ALLOWED.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `status must be one of: ${ALLOWED.join(', ')}`,
      });
    }
    const order = await findMerchantOrder(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const tsField = STATUS_TIMESTAMP[status];
    // Read by the pre-save hook that writes the status history, so the
    // customer's tracker can say who moved the order and why.
    order.$locals.statusBy = { id: req.user.id, role: 'merchant', note: reason || '' };
    order.status = status;
    if (tsField) order[tsField] = new Date();
    if ((status === 'canceled' || status === 'cancelled') && typeof reason === 'string' && reason.trim()) {
      order.cancellationReason = reason.trim();
    }

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

    // The customer's tracking screen updates without waiting for a refresh.
    emitOrderUpdate(req, order, 'order-status', {
      note: (reason || '').trim(),
      at: new Date(),
    });

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
        `Order #${order.orderNumber} → ${status}`, 'order',
        { orderId: order._id, orderNumber: order.orderNumber });
    } catch (_) {}

    const merchant = await User.findById(req.user.id).select('storeName storeAddress phone logo');
    res.json({ success: true, message: 'Order status updated', data: order.toMerchantJSON(merchant) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// GIFT BACK
// ═══════════════════════════════════════════════════════════

// ── Gift-back caps ────────────────────────────────────────
// One source of truth for both GET /gift-back/limits (which displays them)
// and POST /gift-back (which now enforces them). They used to live only
// inside the /limits handler, so the send endpoint accepted any amount:
// over the daily cap, over the per-transaction max, or negative — and a
// negative amount subtracted points from the customer's wallet.
/**
 * Resolves a scanned VIPs QR (`VIPS_USER_<id>`, see vips_id_view.dart) or a
 * typed phone number to the customer it belongs to.
 *
 * Deliberately not scoped to this merchant's existing customers: the whole
 * point of a loyalty network is the customer standing at the till for the
 * first time.
 */
async function resolveCustomer({ userId, phone, qr }) {
  const scanned = String(qr || '').trim();
  const fromQr = scanned.startsWith('VIPS_USER_') ? scanned.slice('VIPS_USER_'.length) : null;
  const id = fromQr || userId;

  if (id && /^[a-fA-F0-9]{24}$/.test(String(id))) {
    return User.findOne({ _id: id, role: 'customer' });
  }
  if (phone) return User.findOne({ phone: String(phone).trim(), role: 'customer' });
  return null;
}

// ─── GET /api/merchant/customers/lookup ───────────────────
// Name-only preview before the merchant commits to anything, so a mistyped
// phone number is caught before points move.
router.get('/customers/lookup', async (req, res) => {
  try {
    const { userId, phone, qr } = req.query;
    if (!userId && !phone && !qr) {
      return res.status(400).json({ success: false, message: 'Scan a QR code or enter a phone number.' });
    }
    const customer = await resolveCustomer({ userId, phone, qr });
    if (!customer) return res.status(404).json({ success: false, message: 'No VIPs customer matches that.' });

    const allowance = await giftback.monthlyAllowance(customer._id);
    res.json({
      success: true,
      data: {
        userId: String(customer._id),
        fullName: customer.fullName,
        phone: customer.phone,
        profileImage: customer.profileImage || null,
        giftbackAllowance: allowance,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// §4.1 — EARNING POINTS AT THE TILL
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/merchant/earn   { userId | phone | qr, invoiceAmount, giftbackChange?, giftbackConsent? }
 *
 * The customer pays as normal, shows their QR, and the merchant enters the
 * invoice. This replaces POST /rewards/expense-to-reward, where the customer
 * typed their own spend and the merchant was never involved — the document
 * puts the merchant at the centre of this flow precisely because they are
 * the one who saw the money.
 *
 * The points come out of the merchant's discount budget. §5.1 is explicit
 * that redeemable points are covered by the guarantee; awarding points that
 * nothing backs would make the platform, not the merchant, liable for them.
 */
router.post('/earn', async (req, res) => {
  try {
    const { userId, phone, qr, invoiceAmount, giftbackChange, giftbackConsent } = req.body;

    const invoice = Number(invoiceAmount);
    if (!Number.isFinite(invoice) || invoice <= 0) {
      return res.status(400).json({ success: false, message: 'Enter the invoice total.' });
    }

    const merchant = await User.findById(req.user.id);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });

    const rate = Number.isFinite(merchant.earnRate) ? merchant.earnRate : null;
    if (rate === null || rate <= 0) {
      return res.status(409).json({
        success: false,
        message: 'Set your points-per-dinar rate in settings before recording a sale.',
        data: { suggestedRate: DEFAULT_EARN_RATE },
      });
    }

    const customer = await resolveCustomer({ userId, phone, qr });
    if (!customer) return res.status(404).json({ success: false, message: 'No VIPs customer matches that.' });

    const points = pointsForInvoice(invoice, rate);

    // Funded before it is credited: if the budget cannot cover it, the
    // customer must not walk away believing they earned something.
    try {
      await guarantee.fund(merchant._id, 'discount', points, {
        customerId: customer._id,
        note: `Earned on a ${invoice} TND invoice at ${rate} pts/TND`,
      });
    } catch (err) {
      if (err.code === 'BUDGET_EXHAUSTED') {
        return res.status(409).json({
          success: false,
          message: 'Your discount budget cannot cover this sale. Top up your guarantee or move points between budgets.',
          data: { budget: err.budget, available: err.available, required: err.required },
        });
      }
      throw err;
    }

    customer.walletPoints = (customer.walletPoints || 0) + points;
    await customer.save();

    await Transaction.create({
      userId: customer._id,
      merchantId: merchant._id,
      type: 'reward',
      amount: points,
      currency: 'PTS',
      description: `${points} points on a ${invoice} TND purchase`,
      status: 'completed',
      reference: `EARN-${Date.now()}`,
    });

    // Giftback rides along on the same sale when the customer agrees to it,
    // which is exactly where the change actually arises.
    let giftbackResult = null;
    if (giftbackChange !== undefined && giftbackChange !== null && Number(giftbackChange) > 0) {
      try {
        const { grant, allowance } = await giftback.grant({
          userId: customer._id,
          merchantId: merchant._id,
          changeTnd: giftbackChange,
          invoiceTnd: invoice,
          consented: giftbackConsent === true,
        });
        giftbackResult = {
          accepted: true,
          points: grant.points,
          changeTnd: grant.changeTnd,
          activatesAt: grant.activatesAt,
          allowance,
        };
      } catch (err) {
        // The sale and its points stand; only the optional extra failed.
        giftbackResult = { accepted: false, reason: err.message };
      }
    }

    res.status(201).json({
      success: true,
      message: `${points} points added for ${customer.fullName}.`,
      data: {
        customer: { userId: String(customer._id), fullName: customer.fullName },
        invoiceAmount: invoice,
        earnRate: rate,
        pointsAwarded: points,
        pointsValueTnd: pointsToTnd(points),
        customerBalance: customer.walletPoints,
        giftback: giftbackResult,
        guarantee: guarantee.summarise(await User.findById(merchant._id)),
      },
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// §4.2 — GIFTBACK
// ═══════════════════════════════════════════════════════════

// ─── POST /api/merchant/gift-back ─────────────────────────
// Standalone Giftback, for a sale recorded outside /earn. Every constraint
// lives in utils/giftback so both paths obey the same rules.
router.post('/gift-back', async (req, res) => {
  try {
    const { userId, phone, qr, changeTnd, invoiceTnd, consent } = req.body;
    const customer = await resolveCustomer({ userId, phone, qr });
    if (!customer) return res.status(404).json({ success: false, message: 'No VIPs customer matches that.' });

    const { grant, allowance } = await giftback.grant({
      userId: customer._id,
      merchantId: req.user.id,
      changeTnd,
      invoiceTnd: invoiceTnd === undefined ? null : Number(invoiceTnd),
      consented: consent === true,
    });

    res.status(201).json({
      success: true,
      message: `${grant.points} Giftback points recorded. They become spendable in ${GIFTBACK.ACTIVATION_DELAY_HOURS} hours.`,
      data: {
        id: String(grant._id),
        recipientName: customer.fullName,
        changeTnd: grant.changeTnd,
        points: grant.points,
        activatesAt: grant.activatesAt,
        allowance,
      },
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/gift-back/limits ───────────────────
// The customer's remaining allowance — the cap is theirs, not the
// merchant's, so it can only be answered about a named customer.
router.get('/gift-back/limits', async (req, res) => {
  try {
    const customer = await resolveCustomer(req.query);
    if (!customer) {
      return res.json({
        success: true,
        data: {
          maxChangeTnd: GIFTBACK.MAX_CHANGE_TND,
          monthlyCapTnd: GIFTBACK.MONTHLY_CAP_TND,
          activationDelayHours: GIFTBACK.ACTIVATION_DELAY_HOURS,
          customer: null,
        },
      });
    }
    const allowance = await giftback.monthlyAllowance(customer._id);
    res.json({
      success: true,
      data: {
        maxChangeTnd: GIFTBACK.MAX_CHANGE_TND,
        monthlyCapTnd: GIFTBACK.MONTHLY_CAP_TND,
        activationDelayHours: GIFTBACK.ACTIVATION_DELAY_HOURS,
        customer: { userId: String(customer._id), fullName: customer.fullName },
        allowance,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/gift-back/history ──────────────────
// §6.2's "سجل الموافقات على Giftback": every grant this merchant took, with
// the change forgone and whether it has activated yet.
router.get('/gift-back/history', async (req, res) => {
  try {
    const GiftbackGrant = require('../models/GiftbackGrant');
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const grants = await GiftbackGrant.find({ merchantId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('userId', 'fullName phone')
      .lean();

    res.json({
      success: true,
      data: {
        items: grants.map((g) => ({
          id: String(g._id),
          customerName: g.userId?.fullName || 'Deleted customer',
          changeTnd: g.changeTnd,
          invoiceTnd: g.invoiceTnd,
          points: g.points,
          status: g.status,
          consentedAt: g.consentedAt,
          activatesAt: g.activatesAt,
          grantedAt: g.createdAt,
        })),
        totalChangeTnd: grants.reduce((s, g) => s + g.changeTnd, 0),
        totalPoints: grants.reduce((s, g) => s + g.points, 0),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// §5.1 / §5.2 — THE GUARANTEE
// ═══════════════════════════════════════════════════════════

// ─── GET /api/merchant/guarantee ──────────────────────────
router.get('/guarantee', async (req, res) => {
  try {
    const merchant = await User.findById(req.user.id);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });
    res.json({
      success: true,
      data: { ...guarantee.summarise(merchant), budgetLabels: BUDGET_LABELS },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/guarantee/allocate ────────────────
// Split unallocated points across the three budgets (§5.1).
router.post('/guarantee/allocate', async (req, res) => {
  try {
    const { budget, points } = req.body;
    const data = await guarantee.allocate(req.user.id, budget, points, { byId: req.user.id });
    res.json({ success: true, message: 'Budget updated.', data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/guarantee/reallocate ──────────────
router.post('/guarantee/reallocate', async (req, res) => {
  try {
    const { fromBudget, toBudget, points } = req.body;
    const data = await guarantee.reallocate(req.user.id, fromBudget, toBudget, points, { byId: req.user.id });
    res.json({ success: true, message: 'Points moved.', data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/guarantee/ledger ───────────────────
router.get('/guarantee/ledger', async (req, res) => {
  try {
    const GuaranteeLedger = require('../models/GuaranteeLedger');
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const filter = { merchantId: req.user.id };
    if (req.query.type) filter.type = req.query.type;

    const [items, total] = await Promise.all([
      GuaranteeLedger.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      GuaranteeLedger.countDocuments(filter),
    ]);
    res.json({ success: true, data: { items, total } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/report ─────────────────────────────
/**
 * The shop's position in one screen: what it sold, what it is owed, what it
 * owes, and what is sitting on the shelves.
 *
 * Every figure is in dinars. Amounts are computed here rather than in the
 * app so the report and the dashboard cannot answer the same question
 * differently.
 */
router.get('/report', async (req, res) => {
  try {
    const merchantObjectId = new mongoose.Types.ObjectId(String(req.user.id));
    const period = req.query.period || 'all';
    const since = (() => {
      const d = new Date(); d.setHours(0, 0, 0, 0);
      if (period === 'today') return d;
      if (period === 'week') { const w = new Date(d); w.setDate(d.getDate() - d.getDay()); return w; }
      if (period === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
      return null;
    })();
    const dateFilter = since ? { createdAt: { $gte: since } } : {};

    const [txAgg, dueAgg, productAgg, stockAgg, posAgg] = await Promise.all([
      Transaction.aggregate([
        { $match: { merchantId: merchantObjectId, currency: { $ne: 'PTS' }, ...dateFilter } },
        { $group: { _id: '$type', total: { $sum: '$amount' } } },
      ]),
      // A party is either a customer who owes the shop or a supplier the
      // shop owes; they are opposite directions and must not be summed.
      Due.aggregate([
        { $match: { merchantId: merchantObjectId } },
        {
          $group: {
            _id: '$isCustomer',
            outstanding: { $sum: { $subtract: ['$totalAmount', '$paidAmount'] } },
            parties: { $sum: 1 },
          },
        },
      ]),
      Product.aggregate([
        { $match: { merchantId: merchantObjectId } },
        { $group: { _id: '$category', items: { $sum: 1 } } },
      ]),
      Stock.aggregate([
        { $match: { merchantId: merchantObjectId } },
        {
          $group: {
            _id: null,
            value: { $sum: { $multiply: ['$currentStock', '$unitPrice'] } },
            units: { $sum: '$currentStock' },
            lines: { $sum: 1 },
          },
        },
      ]),
      PosInvoice.aggregate([
        { $match: { merchantId: merchantObjectId, status: 'completed', ...dateFilter } },
        { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } },
      ]),
    ]);

    const byType = {};
    txAgg.forEach((r) => { byType[r._id] = r.total; });

    const customerRow = dueAgg.find((r) => r._id === true);
    const supplierRow = dueAgg.find((r) => r._id === false);
    const customerDue = Math.max(0, customerRow?.outstanding || 0);
    const supplierDue = Math.max(0, supplierRow?.outstanding || 0);

    const round = (n) => Math.round((n || 0) * 1000) / 1000;

    res.json({
      success: true,
      data: {
        period,
        currency: 'TND',
        sales: {
          online: round(byType['income'] || 0),
          counter: round(posAgg[0]?.total || 0),
          total: round((byType['income'] || 0) + (posAgg[0]?.total || 0)),
          counterInvoices: posAgg[0]?.count || 0,
        },
        purchases: round(byType['expense'] || 0),
        due: {
          // Owed to the shop by customers, and owed by the shop to
          // suppliers. Reported apart because they pull opposite ways.
          fromCustomers: round(customerDue),
          toSuppliers: round(supplierDue),
          net: round(customerDue - supplierDue),
          customerParties: customerRow?.parties || 0,
          supplierParties: supplierRow?.parties || 0,
        },
        catalogue: {
          items: productAgg.reduce((sum, r) => sum + r.items, 0),
          categories: productAgg.filter((r) => r._id).length,
        },
        stock: {
          value: round(stockAgg[0]?.value || 0),
          units: stockAgg[0]?.units || 0,
          lines: stockAgg[0]?.lines || 0,
        },
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── GET /api/merchant/guarantee/topup ────────────────────
/**
 * The two ways a merchant can put points behind their offers (§5.1).
 *
 * The first costs nothing: points customers spent in this shop have already
 * come back to the general balance and can be moved to whichever budget
 * needs them. The second is real money, and has to be received before it
 * becomes points.
 */
router.get('/guarantee/topup', async (req, res) => {
  try {
    const GuaranteeDepositRequest = require('../models/GuaranteeDepositRequest');
    const merchant = await User.findById(req.user.id);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    const summary = guarantee.summarise(merchant);
    const pending = await GuaranteeDepositRequest.find({
      merchantId: req.user.id,
      status: 'pending',
    }).sort({ createdAt: -1 }).lean();

    res.json({
      success: true,
      data: {
        // Points already back from customers spending vouchers here. Moving
        // them is what the document calls renewing the points' validity —
        // they go back to funding offers instead of sitting idle.
        recoverable: {
          points: summary.budgets.general,
          tnd: pointsToTnd(summary.budgets.general),
          unallocatedPoints: summary.unallocatedPoints,
        },
        budgets: summary.budgets,
        pointsPerTnd: 100,
        pendingBankDeposits: pending.map((p) => ({
          id: String(p._id),
          amountTnd: p.amountTnd,
          reference: p.reference,
          requestedAt: p.createdAt,
        })),
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── POST /api/merchant/guarantee/topup/bank ──────────────
// Declares a bank transfer. Creates a request, not points.
router.post('/guarantee/topup/bank', async (req, res) => {
  try {
    const GuaranteeDepositRequest = require('../models/GuaranteeDepositRequest');
    const amount = Number(req.body.amountTnd);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Enter how much you transferred, in dinars.' });
    }

    const request = await GuaranteeDepositRequest.create({
      merchantId: req.user.id,
      amountTnd: amount,
      reference: String(req.body.reference || '').slice(0, 120),
      bankName: String(req.body.bankName || '').slice(0, 120),
      note: String(req.body.note || '').slice(0, 300),
    });

    res.status(201).json({
      success: true,
      message: 'Sent. Your points are added once the transfer is confirmed as received.',
      data: {
        id: String(request._id),
        amountTnd: request.amountTnd,
        pointsWhenConfirmed: tndToPoints(request.amountTnd),
        status: request.status,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── GET /api/merchant/guarantee/refund ───────────────────
// What can be taken out and, when it cannot, exactly why (§5.2).
router.get('/guarantee/refund', async (req, res) => {
  try {
    const merchant = await User.findById(req.user.id);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });
    res.json({ success: true, data: guarantee.refundability(merchant) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/guarantee/refund ──────────────────
// Files the request and holds the points. Reviewed within five working days
// (§5.2); the cash rail itself is not wired up, same honest gap as payouts.
router.post('/guarantee/refund', async (req, res) => {
  try {
    const { amount, bankName, accountName, accountNumber, note } = req.body;
    const data = await guarantee.refund(req.user.id, amount, {
      byId: req.user.id,
      note: note || 'Guarantee refund request',
    });

    const payout = await Payout.create({
      merchantId: req.user.id,
      amount: Number(amount),
      bankName: bankName || '',
      accountName: accountName || '',
      accountNumber: accountNumber || '',
      note: 'Guarantee refund',
    });

    res.status(201).json({
      success: true,
      message: `Refund requested. It is reviewed within ${guarantee.refundability(await User.findById(req.user.id)).reviewWorkingDays} working days.`,
      data: { payout, guarantee: data },
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

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
// Fields a merchant may set on their own staff record. `merchantId` is never
// among them — passing the raw body to findOneAndUpdate let a merchant
// reassign a cashier to another merchant's account.
const CASHIER_UPDATABLE = ['name', 'role', 'status', 'email', 'phone', 'salary', 'pin'];
const CASHIER_STATUSES  = ['active', 'pending', 'removed'];

function pickCashierFields(body) {
  const out = {};
  for (const key of CASHIER_UPDATABLE) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  if (out.salary !== undefined) out.salary = parseFloat(out.salary) || 0;
  return out;
}

router.post('/cashiers', async (req, res) => {
  try {
    const fields = pickCashierFields(req.body);
    // Validate up front — an empty body used to reach Mongoose and come
    // back as a raw validation error inside a 500.
    if (!fields.name || !String(fields.name).trim()) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    if (fields.status && !CASHIER_STATUSES.includes(fields.status)) {
      return res.status(400).json({ success: false, message: `status must be one of: ${CASHIER_STATUSES.join(', ')}` });
    }
    const cashier = await Employee.create({ ...fields, merchantId: req.user.id });
    res.status(201).json({ success: true, message: 'Cashier added', data: cashier });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/merchant/cashiers/:id ───────────────────────
router.put('/cashiers/:id', async (req, res) => {
  try {
    const fields = pickCashierFields(req.body);
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ success: false, message: 'No updatable fields supplied' });
    }
    if (fields.name !== undefined && !String(fields.name).trim()) {
      return res.status(400).json({ success: false, message: 'name cannot be empty' });
    }
    if (fields.status && !CASHIER_STATUSES.includes(fields.status)) {
      return res.status(400).json({ success: false, message: `status must be one of: ${CASHIER_STATUSES.join(', ')}` });
    }
    const cashier = await Employee.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      fields,
      { new: true, runValidators: true }
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

// Keys a client may never set on any of the CRUD models below. `merchantId`
// is the important one: PUT used to hand `req.body` straight to
// findOneAndUpdate, so a merchant could move a stock item, asset, tax rate,
// staff member or due onto another merchant's account.
const CRUD_PROTECTED = ['_id', 'id', '__v', 'merchantId', 'createdAt', 'updatedAt'];

function stripProtected(body) {
  const out = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (!CRUD_PROTECTED.includes(key)) out[key] = value;
  }
  return out;
}

function crudRouter(Model, sortField = 'createdAt', hooks = {}) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    try {
      const items = await Model.find({ merchantId: req.user.id }).sort({ [sortField]: -1 });
      res.json({ success: true, data: items });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  r.post('/', async (req, res) => {
    try {
      const item = await Model.create({ ...stripProtected(req.body), merchantId: req.user.id });
      if (hooks.afterCreate) await hooks.afterCreate(item, req);
      res.status(201).json({ success: true, data: item });
    } catch (e) {
      // A Mongoose validation failure is the caller's fault, not a server
      // fault — it used to come back as a 500 with the raw error text.
      const status = e.name === 'ValidationError' ? 400 : 500;
      res.status(status).json({ success: false, message: e.message });
    }
  });

  r.put('/:id', async (req, res) => {
    try {
      const update = stripProtected(req.body);
      if (Object.keys(update).length === 0) {
        return res.status(400).json({ success: false, message: 'No updatable fields supplied' });
      }
      // The pre-image is needed by the ledger hook: a movement row is only
      // meaningful if it can say what the balance was before the change.
      const before = hooks.afterUpdate
        ? await Model.findOne({ _id: req.params.id, merchantId: req.user.id }).lean()
        : null;
      const item = await Model.findOneAndUpdate(
        { _id: req.params.id, merchantId: req.user.id },
        update,
        { new: true, runValidators: true }
      );
      if (!item) return res.status(404).json({ success: false, message: 'Not found' });
      if (hooks.afterUpdate) await hooks.afterUpdate(before, item, req);
      res.json({ success: true, data: item });
    } catch (e) {
      const status = e.name === 'ValidationError' ? 400 : 500;
      res.status(status).json({ success: false, message: e.message });
    }
  });

  r.delete('/:id', async (req, res) => {
    try {
      // A delete that matched nothing used to answer `{success: true}`, so
      // deleting someone else's record read as a success.
      const item = await Model.findOneAndDelete({ _id: req.params.id, merchantId: req.user.id });
      if (!item) return res.status(404).json({ success: false, message: 'Not found' });
      if (hooks.afterDelete) await hooks.afterDelete(item, req);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  return r;
}

// Stock is the one CRUD model with an audit trail: every merchant-side
// change writes a StockMovement, so the admin console's movement history is
// the whole story and not just what an admin did.
const stockLedgerHooks = {
  afterCreate: (item, req) => recordMovement({
    stock: item,
    type: 'initial',
    quantity: item.currentStock,
    balanceBefore: 0,
    balanceAfter: item.currentStock,
    reason: 'Stock line created',
    performedBy: req.user.id,
    performedByRole: req.user.role,
  }),
  afterUpdate: (before, item, req) => {
    const from = before ? before.currentStock : 0;
    const to = item.currentStock;
    // A rename or price edit is not a stock movement — only log a real
    // quantity change, otherwise the ledger fills with no-op rows.
    if (from === to) return;
    return recordMovement({
      stock: item,
      type: movementTypeForDelta(from, to),
      quantity: Math.abs(to - from),
      balanceBefore: from,
      balanceAfter: to,
      reason: 'Updated by merchant',
      performedBy: req.user.id,
      performedByRole: req.user.role,
    });
  },
  afterDelete: (item, req) => recordMovement({
    stock: item,
    type: 'removed',
    quantity: item.currentStock,
    balanceBefore: item.currentStock,
    balanceAfter: 0,
    reason: 'Stock line deleted',
    performedBy: req.user.id,
    performedByRole: req.user.role,
  }),
};

// Bulk product import. Mounted inside this router so it inherits the
// merchant auth gate above rather than re-declaring it.
/**
 * PUT /api/merchant/orders/:id/location  { lat, lng }
 *
 * Where the delivery is right now. There is no driver app and no courier
 * integration, so this is the merchant reporting their own position while
 * they are out with an order — which is why it is not set automatically and
 * why the customer's screen hides the section until it is.
 */
router.put('/orders/:id/location', async (req, res) => {
  try {
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ success: false, message: 'lat and lng must be numbers.' });
    }
    // Rejected rather than stored: a coordinate outside these ranges is a
    // bug in the caller, and putting it on a map would send the customer to
    // the middle of the ocean.
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({
        success: false,
        message: 'lat must be between -90 and 90, lng between -180 and 180.',
      });
    }

    const order = await findMerchantOrder(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    order.deliveryLocation = { lat, lng, updatedAt: new Date() };
    await order.save();

    emitOrderUpdate(req, order, 'order-location', {
      liveLocation: { lat, lng, updatedAt: order.deliveryLocation.updatedAt },
    });

    res.json({
      success: true,
      message: 'Location updated.',
      data: { liveLocation: order.deliveryLocation },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** PUT /api/merchant/orders/:id/eta  { estimatedDeliveryAt } */
router.put('/orders/:id/eta', async (req, res) => {
  try {
    const raw = req.body.estimatedDeliveryAt;
    // An explicit null clears it — a merchant who no longer knows should be
    // able to say so rather than leave a promise on the customer's screen.
    if (raw === null) {
      const cleared = await findMerchantOrder(req.params.id, req.user.id);
      if (!cleared) return res.status(404).json({ success: false, message: 'Order not found' });
      cleared.estimatedDeliveryAt = null;
      await cleared.save();
      emitOrderUpdate(req, cleared, 'order-eta', { estimatedDeliveryAt: null });
      return res.json({ success: true, message: 'Estimate cleared.', data: { estimatedDeliveryAt: null } });
    }

    const at = new Date(raw);
    if (isNaN(at)) {
      return res.status(400).json({ success: false, message: 'estimatedDeliveryAt must be a date.' });
    }

    const order = await findMerchantOrder(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    order.estimatedDeliveryAt = at;
    await order.save();
    emitOrderUpdate(req, order, 'order-eta', { estimatedDeliveryAt: at });

    res.json({ success: true, message: 'Estimate set.', data: { estimatedDeliveryAt: at } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.use('/products/import', require('./merchant_import'));

router.use('/stock',     crudRouter(Stock, 'createdAt', stockLedgerHooks));
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
    const {
      name, category, price, image, description, isFeature, hasVariants,
      isActive, vat, code, taxMethod,
      // Previously not read off the body even though the merchant form
      // collects all three: the Type dropdown, the Alert Quantity input and
      // the promotional price were discarded on every save.
      productType, alertQty, discountPrice,
    } = req.body;
    if (!name || !price || !category) {
      return res.status(400).json({ success: false, message: 'name, price, and category are required' });
    }
    const promo = discountPrice === null || discountPrice === undefined || discountPrice === ''
      ? null
      : parseFloat(discountPrice);
    if (promo !== null && (isNaN(promo) || promo < 0)) {
      return res.status(400).json({ success: false, message: 'discountPrice must be a positive number' });
    }
    if (promo !== null && promo >= parseFloat(price)) {
      return res.status(400).json({ success: false, message: 'discountPrice must be lower than price' });
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
      productType: productType || 'Product',
      alertQty: parseFloat(alertQty || 0) || 0,
      discountPrice: promo,
    });
    res.status(201).json({ success: true, message: 'Product created successfully', data: product });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── PUT /api/merchant/products/:id ───────────────────────
// Only these may be changed through the API. The whole request body used to
// be passed straight to findOneAndUpdate, so a merchant could reassign
// `merchantId` (handing their product to another account) or overwrite the
// `comments` array wholesale.
const PRODUCT_UPDATABLE = [
  'name', 'code', 'description', 'price', 'discountPrice', 'costPrice', 'image',
  'category', 'inStock', 'isActive', 'isFeature', 'hasVariants', 'stock',
  'vat', 'taxMethod', 'productType', 'alertQty',
];

router.put('/products/:id', async (req, res) => {
  try {
    const update = {};
    for (const key of PRODUCT_UPDATABLE) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, message: 'No updatable fields supplied' });
    }
    if (update.discountPrice !== null && update.discountPrice !== undefined) {
      const promo = parseFloat(update.discountPrice);
      if (isNaN(promo) || promo < 0) {
        return res.status(400).json({ success: false, message: 'discountPrice must be a positive number' });
      }
      update.discountPrice = promo;
    }
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      update,
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
    const coupons = await Coupon.find({ merchantId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();

    // Whether each offer's terms can be changed yet, worked out here so the
    // app can grey the control and say when instead of offering an edit that
    // the server will refuse.
    const withLock = coupons.map((c) => {
      const locked = cooldownUntil(
        c.termsChangedAt || c.createdAt,
        EDIT_COOLDOWN.CATALOG_HOURS
      );
      return {
        ...c,
        editable: !locked,
        editableAt: locked,
        editCooldownHours: EDIT_COOLDOWN.CATALOG_HOURS,
      };
    });

    res.json({ success: true, data: withLock });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── POST /api/merchant/coupons ───────────────────────────
router.post('/coupons', async (req, res) => {
  try {
    const { code, discount, discountPercentage, maxDiscountAmount, expiryDate, isActive, type, tags, maxUsage, minOrderAmount, description, discountUnit } = req.body;
    const discountValue = parseFloat(discount ?? discountPercentage ?? 0);
    if (!code || isNaN(discountValue)) {
      return res.status(400).json({ success: false, message: 'code and discount are required' });
    }

    // A voucher carries a dinar value (§4.2); a coupon carries a percentage.
    const unit = discountUnit === 'tnd' || type === 'voucher' ? 'tnd' : 'percent';
    if (unit === 'percent' && (discountValue <= 0 || discountValue > 100)) {
      return res.status(400).json({
        success: false,
        message: 'A percentage discount has to be between 1 and 100.',
      });
    }
    if (unit === 'tnd' && discountValue <= 0) {
      return res.status(400).json({
        success: false,
        message: 'A voucher has to be worth more than nothing.',
      });
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
      discountUnit:      unit,
      // What a customer spends to get it, at the documented 100 points to
      // the dinar. Derived rather than typed so a voucher's price and its
      // face value cannot drift apart.
      pointsCost:        unit === 'tnd' ? tndToPoints(discountValue) : 0,
      expiryDate:        expiryDate ? new Date(expiryDate) : new Date(Date.now() + 30 * 86400000),
      isActive:          isActive !== false,
      merchantId:        req.user.id,
      tags:              Array.isArray(tags) ? tags : [],
      maxUsage:          maxUsage ? parseInt(maxUsage) : null,
      minOrderAmount:    minOrderAmount ? parseFloat(minOrderAmount) : 0,
      // Present on the model and on the create form, but previously not
      // read off the request — anything the merchant typed was discarded.
      description:       typeof description === 'string' ? description : '',
    });
    res.status(201).json({ success: true, data: coupon });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── PUT  /api/merchant/coupons/:id ──────────────────────
// Same reasoning as PRODUCT_UPDATABLE. Passing the raw body here let a
// merchant set `merchantId` (moving the coupon onto another account),
// `userId` (turning a general coupon into someone's personal voucher) or
// reset `usageCount` to sidestep `maxUsage`. `code` is excluded too — it is
// the unique key customers type at checkout.
const COUPON_UPDATABLE = [
  'discount', 'maxDiscountAmount', 'type', 'expiryDate', 'isActive',
  'tags', 'maxUsage', 'minOrderAmount', 'description',
];

// Changing any of these changes the deal a customer was shown, so they are
// what the cooldown guards. Turning an offer off, or letting it expire, is
// not a change of terms — a merchant must always be able to stop offering
// something immediately.
const COUPON_TERMS = ['discount', 'maxDiscountAmount', 'type', 'minOrderAmount', 'maxUsage'];

router.put('/coupons/:id', async (req, res) => {
  try {
    const update = {};
    for (const key of COUPON_UPDATABLE) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, message: 'No updatable fields supplied' });
    }

    const touchesTerms = COUPON_TERMS.some((k) => update[k] !== undefined);
    if (touchesTerms) {
      const existing = await Coupon.findOne({ _id: req.params.id, merchantId: req.user.id });
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Coupon not found' });
      }
      const since = existing.termsChangedAt || existing.createdAt;
      const locked = cooldownUntil(since, EDIT_COOLDOWN.CATALOG_HOURS);
      if (locked) {
        const hoursLeft = Math.ceil((locked - Date.now()) / 3600000);
        return res.status(409).json({
          success: false,
          code: 'EDIT_COOLDOWN',
          message: `This offer was published or changed recently. You can change its terms in ${hoursLeft} hour(s). You can switch it off now if you need to stop it.`,
          data: { availableAt: locked, hoursRemaining: hoursLeft },
        });
      }
      update.termsChangedAt = new Date();
    }
    if (update.discount !== undefined) {
      const d = parseFloat(update.discount);
      if (isNaN(d) || d < 0) {
        return res.status(400).json({ success: false, message: 'discount must be a positive number' });
      }
      update.discount = d;
      // Kept in sync by the model's pre-save hook, which findOneAndUpdate
      // does not run.
      update.discountPercentage = d;
    }
    if (update.expiryDate !== undefined) update.expiryDate = new Date(update.expiryDate);
    const coupon = await Coupon.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      update,
      { new: true, runValidators: true }
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
