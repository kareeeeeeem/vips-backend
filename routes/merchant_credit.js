/**
 * Merchant Credit Routes  —  /api/merchant/credits
 * Issue credit to customers and track repayments.
 */

const express  = require('express');
const mongoose = require('mongoose');
const { authMiddleware } = require('../middleware/auth');
const MerchantCredit = require('../models/MerchantCredit');
const User           = require('../models/User');
const Transaction    = require('../models/Transaction');

const router = express.Router();
router.use(authMiddleware);

// Per-transaction credit bounds. The merchant credit form has always
// displayed "Limit: D 25 - D 1000", but nothing enforced it — the only
// check was amount > 0, so any figure went through.
const CREDIT_LIMITS = { MIN: 25, MAX: 1000 };

// ─── GET /api/merchant/credits/limits ─────────────────────
// Registered before GET /:id so 'limits' isn't swallowed as an id.
router.get('/limits', (req, res) => {
  res.json({
    success: true,
    data: { currency: 'D', minAmount: CREDIT_LIMITS.MIN, maxAmount: CREDIT_LIMITS.MAX },
  });
});

// ─── GET /api/merchant/credits ────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { merchantId: req.user.id };
    if (status) filter.status = status;

    // 'overdue' is one of MerchantCredit.status's real values and the merchant
    // Credit screen totals it up as "dormant" — but nothing anywhere ever set
    // it, so that figure could only ever read 0. A credit whose due date has
    // passed while money is still owed is overdue; settle/cancel move it out
    // of that state through their own handlers.
    await MerchantCredit.updateMany(
      {
        merchantId: req.user.id,
        status: 'active',
        dueDate: { $ne: null, $lt: new Date() },
        remainingAmount: { $gt: 0 },
      },
      { $set: { status: 'overdue' } }
    );

    const [credits, total, activeAgg] = await Promise.all([
      MerchantCredit.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .populate('customerId', 'fullName phone'),
      MerchantCredit.countDocuments(filter),
      MerchantCredit.aggregate([
        { $match: {
            merchantId: new mongoose.Types.ObjectId(req.user.id),
            status: { $in: ['active', 'overdue'] },
        } },
        { $group: { _id: null, total: { $sum: '$remainingAmount' } } },
      ]),
    ]);

    res.json({
      success: true,
      data: {
        credits,
        total,
        totalActiveAmount: activeAgg[0]?.total || 0,
        pagination: { page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/credits ───────────────────────────
// Issue new credit to a customer
router.post('/', async (req, res) => {
  try {
    const { customerId, customerName, customerPhone, amount, dueDate, description } = req.body;
    const parsed = parseFloat(amount);
    if (amount === undefined || amount === null || amount === '' || !Number.isFinite(parsed)) {
      return res.status(400).json({ success: false, message: 'Valid amount is required' });
    }
    if (parsed < CREDIT_LIMITS.MIN) {
      return res.status(400).json({ success: false, message: `Minimum credit is D ${CREDIT_LIMITS.MIN}` });
    }
    if (parsed > CREDIT_LIMITS.MAX) {
      return res.status(400).json({ success: false, message: `Maximum credit is D ${CREDIT_LIMITS.MAX}` });
    }

    let resolvedName  = customerName;
    let resolvedPhone = customerPhone || '';

    if (customerId && !customerName) {
      const user = await User.findById(customerId).select('fullName phone');
      resolvedName  = user?.fullName || 'Unknown Customer';
      resolvedPhone = resolvedPhone || user?.phone || '';
    }

    const credit = await MerchantCredit.create({
      merchantId:      req.user.id,
      customerId:      customerId || null,
      customerName:    resolvedName  || 'Unknown Customer',
      customerPhone:   resolvedPhone,
      amount:          parsed,
      paidAmount:      0,
      remainingAmount: parsed,
      dueDate:         dueDate ? new Date(dueDate) : null,
      description:     description || '',
      reference:       `CRED-${Date.now()}`,
      status:          'active',
    });

    await Transaction.create({
      userId:      customerId || req.user.id,
      merchantId:  req.user.id,
      type:        'credit',
      amount:      parsed,
      currency:    'TND',
      description: description || `Credit issued to ${resolvedName}`,
      status:      'pending',
      reference:   credit.reference,
    });

    res.status(201).json({ success: true, message: 'Credit issued successfully', data: credit });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/credits/:id ────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const credit = await MerchantCredit.findOne({ _id: req.params.id, merchantId: req.user.id })
      .populate('customerId', 'fullName phone email');
    if (!credit) return res.status(404).json({ success: false, message: 'Credit not found' });
    res.json({ success: true, data: credit });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/merchant/credits/:id/settle ─────────────────
// Record a repayment against an active credit
router.put('/:id/settle', async (req, res) => {
  try {
    const { paymentAmount, method, note } = req.body;
    if (!paymentAmount || parseFloat(paymentAmount) <= 0) {
      return res.status(400).json({ success: false, message: 'Valid paymentAmount is required' });
    }

    const credit = await MerchantCredit.findOne({ _id: req.params.id, merchantId: req.user.id });
    if (!credit) return res.status(404).json({ success: false, message: 'Credit not found' });
    if (credit.status === 'settled') {
      return res.status(400).json({ success: false, message: 'Credit already settled' });
    }

    const payment = parseFloat(paymentAmount);
    const outstanding = Math.max(0, credit.amount - credit.paidAmount);
    if (payment > outstanding + 1e-9) {
      return res.status(400).json({
        success: false,
        message: `Payment exceeds the outstanding balance (D ${outstanding.toFixed(3)})`,
        data: { remainingAmount: outstanding },
      });
    }
    credit.paidAmount      += payment;
    credit.remainingAmount  = Math.max(0, credit.amount - credit.paidAmount);
    // A partial payment does not un-expire a due date — a credit still past
    // its due date with money owed stays overdue.
    const stillOverdue = credit.dueDate && credit.dueDate < new Date();
    credit.status = credit.remainingAmount <= 0
      ? 'settled'
      : (stillOverdue ? 'overdue' : 'active');
    credit.transactions.push({ amount: payment, method: method || 'cash', note: note || '' });
    await credit.save();

    await Transaction.create({
      userId:      credit.customerId || req.user.id,
      merchantId:  req.user.id,
      type:        'income',
      amount:      payment,
      currency:    'TND',
      description: `Credit repayment — ${credit.customerName}`,
      status:      'completed',
      reference:   `SETTLE-${Date.now()}`,
    });

    res.json({ success: true, message: 'Payment recorded', data: credit });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/merchant/credits/:id/cancel ─────────────────
router.put('/:id/cancel', async (req, res) => {
  try {
    const credit = await MerchantCredit.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      { status: 'cancelled' },
      { new: true }
    );
    if (!credit) return res.status(404).json({ success: false, message: 'Credit not found' });
    res.json({ success: true, message: 'Credit cancelled', data: credit });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
