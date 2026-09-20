const crypto = require('crypto');
const express = require('express');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { requirePermission } = require('../middleware/permissions');
const { paginate, escapeRegex, isValidId } = require('../utils/adminHelpers');

const router = express.Router();

router.get('/', requirePermission('wallets.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req.query);
    const filter = { role: { $in: ['customer', 'merchant'] } };
    if (req.query.role === 'customer' || req.query.role === 'merchant') {
      filter.role = req.query.role;
    }
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(req.query.search.trim()), 'i');
      filter.$or = [{ fullName: rx }, { storeName: rx }, { email: rx }, { phone: rx }, { userId: rx }];
    }
    const [items, total, totals] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
        .select('fullName storeName email phone userId role walletBalance walletPoints isActive').lean(),
      User.countDocuments(filter),
      User.aggregate([
        { $match: filter },
        { $group: { _id: null, walletBalance: { $sum: '$walletBalance' }, walletPoints: { $sum: '$walletPoints' } } },
      ]),
    ]);
    res.json({ success: true, message: 'Wallets', data: {
      items, total, page, limit, pages: Math.ceil(total / limit),
      totals: totals[0] || { walletBalance: 0, walletPoints: 0 },
    }});
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:id/transactions', requirePermission('wallets.read'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid account id.' });
    }
    const { page, limit, skip } = paginate(req.query);
    const filter = { userId: req.params.id };
    if (req.query.currency) filter.currency = req.query.currency;
    const [items, total] = await Promise.all([
      Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments(filter),
    ]);
    res.json({ success: true, message: 'Wallet ledger', data: {
      items, total, page, limit, pages: Math.ceil(total / limit),
    }});
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:id/adjust', requirePermission('wallets.adjust'), async (req, res) => {
  let ledger;
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid account id.' });
    }
    const unit = req.body.unit === 'points' ? 'points' : req.body.unit === 'wallet' ? 'wallet' : null;
    const delta = Number(req.body.delta);
    const reason = String(req.body.reason || '').trim();
    if (!unit || !Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ success: false, message: 'Unit and a non-zero adjustment are required.' });
    }
    if (reason.length < 5) {
      return res.status(400).json({ success: false, message: 'A clear adjustment reason is required.' });
    }
    if (unit === 'points' && !Number.isInteger(delta)) {
      return res.status(400).json({ success: false, message: 'Points adjustments must be whole numbers.' });
    }
    const field = unit === 'points' ? 'walletPoints' : 'walletBalance';
    const operationId = `admin-adjustment:${crypto.randomUUID()}`;
    ledger = await Transaction.create({
      operationId,
      userId: req.params.id,
      type: delta > 0 ? 'credit' : 'debit',
      amount: Math.abs(delta),
      currency: unit === 'points' ? 'PTS' : 'TND',
      description: `Admin adjustment: ${reason}`,
      status: 'pending',
      reference: operationId,
    });
    const account = await User.findOneAndUpdate(
      { _id: req.params.id, role: { $in: ['customer', 'merchant'] }, ...(delta < 0 ? { [field]: { $gte: Math.abs(delta) } } : {}) },
      { $inc: { [field]: delta } },
      { new: true },
    ).select('fullName storeName role walletBalance walletPoints');
    if (!account) {
      await ledger.deleteOne();
      return res.status(409).json({ success: false, message: 'Account not found or the adjustment would make its balance negative.' });
    }
    ledger.status = 'completed';
    await ledger.save();
    res.status(201).json({ success: true, message: 'Wallet adjustment recorded.', data: { account, transaction: ledger } });
  } catch (error) {
    if (ledger?.status === 'pending') await ledger.deleteOne().catch(() => {});
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
