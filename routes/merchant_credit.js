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

// ─── GET /api/merchant/credits ────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { merchantId: req.user.id };
    if (status) filter.status = status;

    const [credits, total, activeAgg] = await Promise.all([
      MerchantCredit.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .populate('customerId', 'fullName phone'),
      MerchantCredit.countDocuments(filter),
      MerchantCredit.aggregate([
        { $match: { merchantId: new mongoose.Types.ObjectId(req.user.id), status: 'active' } },
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
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount is required' });
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
      amount:          parseFloat(amount),
      paidAmount:      0,
      remainingAmount: parseFloat(amount),
      dueDate:         dueDate ? new Date(dueDate) : null,
      description:     description || '',
      reference:       `CRED-${Date.now()}`,
      status:          'active',
    });

    await Transaction.create({
      userId:      customerId || req.user.id,
      merchantId:  req.user.id,
      type:        'credit',
      amount:      parseFloat(amount),
      currency:    'GMD',
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
    credit.paidAmount      += payment;
    credit.remainingAmount  = Math.max(0, credit.amount - credit.paidAmount);
    credit.status           = credit.remainingAmount <= 0 ? 'settled' : 'active';
    credit.transactions.push({ amount: payment, method: method || 'cash', note: note || '' });
    await credit.save();

    await Transaction.create({
      userId:      credit.customerId || req.user.id,
      merchantId:  req.user.id,
      type:        'income',
      amount:      payment,
      currency:    'GMD',
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
