/**
 * Merchant Billing Routes  —  /api/merchant/billing
 * POS (Point-of-Sale) bill management for merchants.
 */

const express = require('express');
const mongoose = require('mongoose');
const { authMiddleware } = require('../middleware/auth');
const MerchantBill = require('../models/MerchantBill');
const Transaction  = require('../models/Transaction');

const router = express.Router();
router.use(authMiddleware);

// ─── GET /api/merchant/billing ────────────────────────────
// List bills with optional filters
router.get('/', async (req, res) => {
  try {
    const { status, paymentMethod, page = 1, limit = 20, from, to } = req.query;
    const filter = { merchantId: req.user.id };

    if (status)        filter.status        = status;
    if (paymentMethod) filter.paymentMethod = paymentMethod;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to)   filter.createdAt.$lte = new Date(to);
    }

    const [bills, total, revenueAgg] = await Promise.all([
      MerchantBill.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit)),
      MerchantBill.countDocuments(filter),
      MerchantBill.aggregate([
        { $match: { merchantId: new mongoose.Types.ObjectId(req.user.id), status: 'active' } },
        { $group: { _id: null, sum: { $sum: '$grandTotal' } } },
      ]),
    ]);

    res.json({
      success: true,
      data: {
        bills,
        total,
        totalRevenue: revenueAgg[0]?.sum || 0,
        pagination: {
          page:  parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/billing/stats ──────────────────────
// Today / month / all-time revenue summary
router.get('/stats', async (req, res) => {
  try {
    const merchantOid = new mongoose.Types.ObjectId(req.user.id);
    const today      = new Date(); today.setHours(0, 0, 0, 0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const [todayAgg, monthAgg, totalAgg] = await Promise.all([
      MerchantBill.aggregate([
        { $match: { merchantId: merchantOid, status: 'active', createdAt: { $gte: today } } },
        { $group: { _id: null, revenue: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
      ]),
      MerchantBill.aggregate([
        { $match: { merchantId: merchantOid, status: 'active', createdAt: { $gte: monthStart } } },
        { $group: { _id: null, revenue: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
      ]),
      MerchantBill.aggregate([
        { $match: { merchantId: merchantOid, status: 'active' } },
        { $group: { _id: null, revenue: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      success: true,
      data: {
        today: { revenue: todayAgg[0]?.revenue || 0, count: todayAgg[0]?.count || 0 },
        month: { revenue: monthAgg[0]?.revenue || 0, count: monthAgg[0]?.count || 0 },
        total: { revenue: totalAgg[0]?.revenue || 0, count: totalAgg[0]?.count || 0 },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/billing ───────────────────────────
// Create a new POS bill
router.post('/', async (req, res) => {
  try {
    const {
      customerId, customerName, customerPhone,
      items, subtotal, taxAmount, taxRate,
      discountAmount, serviceCharge, grandTotal,
      paymentMethod, paidAmount, notes, cashierId,
    } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Bill must have at least one item' });
    }

    const billNumber   = `BILL-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const parsedTotal  = parseFloat(grandTotal);
    const parsedPaid   = parseFloat(paidAmount  || parsedTotal);
    const changeAmount = Math.max(0, parsedPaid - parsedTotal);

    const bill = await MerchantBill.create({
      merchantId:     req.user.id,
      customerId:     customerId || null,
      customerName:   customerName || 'Walk-in Customer',
      customerPhone:  customerPhone || '',
      billNumber,
      items,
      subtotal:       parseFloat(subtotal),
      taxAmount:      parseFloat(taxAmount      || 0),
      taxRate:        parseFloat(taxRate        || 0),
      discountAmount: parseFloat(discountAmount || 0),
      serviceCharge:  parseFloat(serviceCharge  || 0),
      grandTotal:     parsedTotal,
      paymentMethod:  paymentMethod || 'cash',
      paymentStatus:  'paid',
      paidAmount:     parsedPaid,
      changeAmount,
      notes:          notes || '',
      cashierId:      cashierId || null,
      status:         'active',
    });

    // Record as income transaction
    await Transaction.create({
      userId:      customerId || req.user.id,
      merchantId:  req.user.id,
      type:        'income',
      amount:      parsedTotal,
      currency:    'GMD',
      description: `POS Sale — ${billNumber}`,
      status:      'completed',
      reference:   billNumber,
    });

    res.status(201).json({ success: true, message: 'Bill created successfully', data: bill });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/billing/:id ────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const bill = await MerchantBill.findOne({ _id: req.params.id, merchantId: req.user.id });
    if (!bill) return res.status(404).json({ success: false, message: 'Bill not found' });
    res.json({ success: true, data: bill });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/merchant/billing/:id/void ───────────────────
router.put('/:id/void', async (req, res) => {
  try {
    const { reason } = req.body;
    const bill = await MerchantBill.findOne({ _id: req.params.id, merchantId: req.user.id });
    if (!bill) return res.status(404).json({ success: false, message: 'Bill not found' });
    if (bill.status === 'voided') {
      return res.status(400).json({ success: false, message: 'Bill already voided' });
    }

    bill.status        = 'voided';
    bill.paymentStatus = 'voided';
    bill.voidReason    = reason || 'Voided by merchant';
    await bill.save();

    res.json({ success: true, message: 'Bill voided successfully', data: bill });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/merchant/billing/:id/refund ─────────────────
router.put('/:id/refund', async (req, res) => {
  try {
    const bill = await MerchantBill.findOne({ _id: req.params.id, merchantId: req.user.id });
    if (!bill) return res.status(404).json({ success: false, message: 'Bill not found' });

    bill.status        = 'refunded';
    bill.paymentStatus = 'voided';
    await bill.save();

    // Record refund expense
    await Transaction.create({
      userId:      req.user.id,
      merchantId:  req.user.id,
      type:        'expense',
      amount:      bill.grandTotal,
      currency:    'GMD',
      description: `Refund — ${bill.billNumber}`,
      status:      'completed',
      reference:   `REF-${bill.billNumber}`,
    });

    res.json({ success: true, message: 'Bill refunded', data: bill });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
