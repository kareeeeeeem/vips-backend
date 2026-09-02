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
/**
 * A short, unambiguous code for a bill awaiting payment.
 *
 * Avoids 0/O and 1/I entirely: the code is read off a screen by a camera in
 * a restaurant and sometimes typed by hand, and those pairs are where people
 * and OCR both go wrong.
 */
const PAY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAY_CODE_TTL_MS = 60 * 60 * 1000; // an hour at the table is generous

function makePayCode() {
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += PAY_ALPHABET[Math.floor(Math.random() * PAY_ALPHABET.length)];
  }
  return `VB-${out}`;
}

router.post('/', async (req, res) => {
  try {
    const {
      customerId, customerName, customerPhone,
      items, subtotal, taxAmount, taxRate,
      discountAmount, serviceCharge, grandTotal,
      paymentMethod, paymentStatus, paidAmount, notes, cashierId,
    } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Bill must have at least one item' });
    }

    const billNumber   = `BILL-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const parsedTotal  = parseFloat(grandTotal);
    if (!Number.isFinite(parsedTotal) || parsedTotal <= 0) {
      return res.status(400).json({ success: false, message: 'grandTotal must be a number greater than 0' });
    }

    // `paidAmount ?? parsedTotal`, not `||`: the app sends 0 when it is
    // generating a QR for the customer to pay, and 0 is falsy — so an
    // explicitly-unpaid bill was being recorded as paid in full.
    const rawPaid = (paidAmount === undefined || paidAmount === null || paidAmount === '')
      ? parsedTotal
      : parseFloat(paidAmount);
    const parsedPaid   = Number.isFinite(rawPaid) ? Math.max(0, rawPaid) : 0;
    const changeAmount = Math.max(0, parsedPaid - parsedTotal);

    // Honour what the caller says about payment instead of stamping every
    // bill 'paid'. A bill awaiting a customer scan is 'pending' and must not
    // be booked as revenue yet.
    const ALLOWED_PAYMENT_STATUS = ['paid', 'pending', 'partial'];
    let resolvedStatus = ALLOWED_PAYMENT_STATUS.includes(paymentStatus)
      ? paymentStatus
      : (parsedPaid >= parsedTotal ? 'paid' : (parsedPaid > 0 ? 'partial' : 'pending'));
    // Keep the two consistent even if the caller contradicts itself.
    if (resolvedStatus === 'paid' && parsedPaid < parsedTotal) resolvedStatus = 'partial';
    if (parsedPaid <= 0) resolvedStatus = 'pending';

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
      paymentStatus:  resolvedStatus,
      paidAmount:     parsedPaid,
      changeAmount,
      notes:          notes || '',
      cashierId:      cashierId || null,
      status:         'active',
      // An unpaid bill gets a code the customer's app can resolve, so the QR
      // on the merchant's screen refers to something rather than merely
      // describing it. A bill already settled needs no code.
      ...(resolvedStatus === 'pending'
        ? { payCode: makePayCode(), payCodeExpiresAt: new Date(Date.now() + PAY_CODE_TTL_MS) }
        : {}),
    });

    // Record income only for money actually taken. Every bill used to book a
    // completed income transaction for its full total the moment it was
    // created — including the unpaid ones the app generates a QR for — so a
    // merchant's revenue counted bills nobody had paid.
    if (parsedPaid > 0) {
      await Transaction.create({
        userId:      customerId || req.user.id,
        merchantId:  req.user.id,
        type:        'income',
        amount:      parsedPaid,
        currency:    'TND',
        description: `POS Sale — ${billNumber}`,
        status:      resolvedStatus === 'paid' ? 'completed' : 'pending',
        reference:   billNumber,
      });
    }

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

// ─── PUT /api/merchant/billing/:id/pay ────────────────────
// Settle a bill that was created 'pending' (the QR flow: the merchant
// generates a code, the customer pays, then the bill is marked paid).
// Without this a pending bill had no way to ever become paid.
router.put('/:id/pay', async (req, res) => {
  try {
    const { paidAmount, paymentMethod } = req.body;
    const bill = await MerchantBill.findOne({ _id: req.params.id, merchantId: req.user.id });
    if (!bill) return res.status(404).json({ success: false, message: 'Bill not found' });
    if (bill.status !== 'active') {
      return res.status(400).json({ success: false, message: `Bill is ${bill.status}` });
    }
    if (bill.paymentStatus === 'paid') {
      return res.status(400).json({ success: false, message: 'Bill is already paid' });
    }

    const outstanding = Math.max(0, bill.grandTotal - (bill.paidAmount || 0));
    const raw = (paidAmount === undefined || paidAmount === null || paidAmount === '')
      ? outstanding
      : parseFloat(paidAmount);
    if (!Number.isFinite(raw) || raw <= 0) {
      return res.status(400).json({ success: false, message: 'paidAmount must be a number greater than 0' });
    }
    if (raw > outstanding + 1e-9) {
      return res.status(400).json({
        success: false,
        message: `Payment exceeds the outstanding balance (D ${outstanding.toFixed(3)})`,
        data: { outstanding },
      });
    }

    bill.paidAmount    = (bill.paidAmount || 0) + raw;
    bill.changeAmount  = Math.max(0, bill.paidAmount - bill.grandTotal);
    bill.paymentStatus = bill.paidAmount >= bill.grandTotal ? 'paid' : 'partial';
    if (paymentMethod) bill.paymentMethod = paymentMethod;
    await bill.save();

    await Transaction.create({
      userId:      bill.customerId || req.user.id,
      merchantId:  req.user.id,
      type:        'income',
      amount:      raw,
      currency:    'TND',
      description: `POS Sale — ${bill.billNumber}`,
      status:      'completed',
      reference:   bill.billNumber,
    });

    res.json({ success: true, message: 'Payment recorded', data: bill });
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
      currency:    'TND',
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
