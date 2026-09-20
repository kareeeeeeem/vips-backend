const express = require('express');
const Subscription = require('../models/Subscription');
const MerchantSubscription = require('../models/MerchantSubscription');
const Transaction = require('../models/Transaction');
const { requirePermission } = require('../middleware/permissions');
const { paginate, escapeRegex, isValidId } = require('../utils/adminHelpers');

const router = express.Router();

router.get('/', requirePermission('subscriptions.read'), async (req, res) => {
  try {
    const audience = req.query.audience === 'merchant' ? 'merchant' : 'customer';
    const { page, limit, skip } = paginate(req.query);
    const Model = audience === 'merchant' ? MerchantSubscription : Subscription;
    const ownerField = audience === 'merchant' ? 'merchantId' : 'userId';
    const filter = {};
    if (req.query.status === 'active') filter.isActive = true;
    if (req.query.status === 'inactive') filter.isActive = false;
    if (req.query.plan) {
      filter[audience === 'merchant' ? 'planCode' : 'tier'] = req.query.plan;
    }
    if (audience === 'customer' && req.query.paymentStatus) {
      filter.paymentStatus = req.query.paymentStatus;
    }
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(req.query.search.trim()), 'i');
      const users = await require('../models/User').find({
        $or: [{ fullName: rx }, { email: rx }, { phone: rx }, { storeName: rx }],
      }).select('_id');
      filter[ownerField] = { $in: users.map((u) => u._id) };
    }
    const [items, total] = await Promise.all([
      Model.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate(ownerField, 'fullName email phone storeName userId').lean(),
      Model.countDocuments(filter),
    ]);
    res.json({ success: true, message: 'Subscriptions', data: {
      audience,
      items: items.map((item) => ({
        ...item,
        owner: item[ownerField],
        ownerName: item[ownerField]
          ? (item[ownerField].storeName || item[ownerField].fullName)
          : 'Deleted account',
      })),
      total, page, limit, pages: Math.ceil(total / limit),
    }});
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/customer/:id/payment', requirePermission('subscriptions.review_payment'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid subscription id.' });
    }
    const action = String(req.body.action || '').trim();
    const reason = String(req.body.reason || '').trim();
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action must be approve or reject.' });
    }
    if (action === 'reject' && reason.length < 3) {
      return res.status(400).json({ success: false, message: 'A rejection reason is required.' });
    }

    const pending = await Subscription.findOne({
      _id: req.params.id,
      paymentStatus: 'pending_payment',
      isActive: false,
    });
    if (!pending) {
      return res.status(409).json({ success: false, message: 'This payment request was already reviewed or is not pending.' });
    }
    const now = new Date();
    if (action === 'reject') {
      const rejected = await Subscription.findOneAndUpdate(
        { _id: pending._id, paymentStatus: 'pending_payment', isActive: false },
        { paymentStatus: 'rejected', reviewedBy: req.admin._id, reviewedAt: now, reviewReason: reason },
        { new: true, runValidators: true },
      );
      if (!rejected) return res.status(409).json({ success: false, message: 'This request was reviewed by another administrator.' });
      return res.json({ success: true, message: 'Payment request rejected.', data: { subscription: rejected } });
    }

    const prior = await Subscription.findOne({
      userId: pending.userId,
      isActive: true,
      endDate: { $gt: now },
    }).sort({ endDate: -1 });
    const startDate = prior?.tier === pending.tier ? prior.endDate : now;
    const endDate = new Date(startDate.getTime() + pending.durationWeeks * 7 * 86400000);
    const approved = await Subscription.findOneAndUpdate(
      { _id: pending._id, paymentStatus: 'pending_payment', isActive: false },
      {
        paymentStatus: 'paid', isActive: true, startDate, endDate,
        reviewedBy: req.admin._id, reviewedAt: now, reviewReason: reason,
      },
      { new: true, runValidators: true },
    );
    if (!approved) return res.status(409).json({ success: false, message: 'This request was reviewed by another administrator.' });
    try {
      await Transaction.create({
        operationId: `subscription-payment:${approved._id}`,
        userId: approved.userId,
        type: 'expense',
        amount: approved.amountPaid,
        currency: 'TND',
        account: approved.paymentMethod === 'bank_transfer' ? 'Bank' : 'Cash',
        description: `${approved.tier} subscription — ${approved.durationWeeks} week(s) (${approved.paymentMethod})`,
        status: 'completed',
        reference: `SUB-${approved._id}`,
      });
      await Subscription.updateMany(
        { userId: approved.userId, isActive: true, _id: { $ne: approved._id } },
        { isActive: false },
      );
    } catch (error) {
      await Subscription.updateOne(
        { _id: approved._id, paymentStatus: 'paid' },
        { paymentStatus: 'pending_payment', isActive: false, reviewedBy: null, reviewedAt: null, reviewReason: '', startDate: pending.startDate, endDate: pending.endDate },
      );
      if (prior) await Subscription.updateOne({ _id: prior._id }, { isActive: true });
      throw error;
    }
    res.json({ success: true, message: 'Payment approved and subscription activated.', data: { subscription: approved } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:audience/:id', requirePermission('subscriptions.update'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid subscription id.' });
    }
    const merchant = req.params.audience === 'merchant';
    if (!merchant && req.params.audience !== 'customer') {
      return res.status(400).json({ success: false, message: 'Audience must be customer or merchant.' });
    }
    const update = {};
    if (typeof req.body.isActive === 'boolean') update.isActive = req.body.isActive;
    if (merchant && typeof req.body.autoRenew === 'boolean') update.autoRenew = req.body.autoRenew;
    if (req.body.endDate !== undefined) {
      if (req.body.endDate === null || req.body.endDate === '') {
        if (!merchant) {
          return res.status(400).json({ success: false, message: 'Customer subscriptions require an end date.' });
        }
        update.endDate = null;
      }
      else {
        const date = new Date(req.body.endDate);
        if (Number.isNaN(date.getTime())) {
          return res.status(400).json({ success: false, message: 'Invalid end date.' });
        }
        update.endDate = date;
      }
    }
    if (!Object.keys(update).length) {
      return res.status(400).json({ success: false, message: 'No supported change was supplied.' });
    }
    const Model = merchant ? MerchantSubscription : Subscription;
    const subscription = await Model.findByIdAndUpdate(req.params.id, update, {
      new: true, runValidators: true,
    });
    if (!subscription) return res.status(404).json({ success: false, message: 'Subscription not found.' });
    res.json({ success: true, message: 'Subscription updated.', data: { subscription } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
