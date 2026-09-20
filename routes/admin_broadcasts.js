const express = require('express');
const User = require('../models/User');
const UserNotification = require('../models/UserNotification');
const MerchantNotification = require('../models/MerchantNotification');
const AdminBroadcast = require('../models/AdminBroadcast');
const { requirePermission } = require('../middleware/permissions');
const { paginate } = require('../utils/adminHelpers');

const router = express.Router();

router.get('/', requirePermission('broadcasts.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req.query);
    const [items, total] = await Promise.all([
      AdminBroadcast.find().sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate('sentBy', 'fullName email').lean(),
      AdminBroadcast.countDocuments(),
    ]);
    res.json({ success: true, data: { items, total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/', requirePermission('broadcasts.send'), async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    const message = String(req.body.message || '').trim();
    const audience = String(req.body.audience || '').trim();
    const type = ['system', 'promotion', 'account'].includes(req.body.type) ? req.body.type : 'system';
    const actionUrl = String(req.body.actionUrl || '').trim();
    if (title.length < 3 || title.length > 100 || message.length < 3 || message.length > 1000) {
      return res.status(400).json({ success: false, message: 'Title and message must be between 3 and their maximum allowed length.' });
    }
    if (!['customers', 'merchants', 'all'].includes(audience)) {
      return res.status(400).json({ success: false, message: 'Audience must be customers, merchants or all.' });
    }
    if (actionUrl.length > 300 || (actionUrl && !actionUrl.startsWith('/'))) {
      return res.status(400).json({ success: false, message: 'Action URL must be an internal path beginning with /.' });
    }

    const [customers, merchants] = await Promise.all([
      audience === 'merchants' ? [] : User.find({ role: 'customer', isBanned: { $ne: true } }).select('_id').lean(),
      audience === 'customers' ? [] : User.find({ role: 'merchant', isBanned: { $ne: true } }).select('_id').lean(),
    ]);
    if (!customers.length && !merchants.length) {
      return res.status(409).json({ success: false, message: 'The selected audience has no eligible recipients.' });
    }
    const broadcast = await AdminBroadcast.create({
      title, message, audience, type, actionUrl, sentBy: req.admin._id,
      customerCount: customers.length, merchantCount: merchants.length,
    });
    try {
      if (customers.length) {
        await UserNotification.insertMany(customers.map(({ _id }) => ({
          userId: _id, title, message, type, actionUrl: actionUrl || null,
          data: { broadcastId: broadcast._id },
        })));
      }
      if (merchants.length) {
        await MerchantNotification.insertMany(merchants.map(({ _id }) => ({
          merchantId: _id, title, body: message,
          type: type === 'promotion' ? 'alert' : 'system', actionUrl,
          data: { broadcastId: broadcast._id },
        })));
      }
    } catch (error) {
      await Promise.all([
        UserNotification.deleteMany({ 'data.broadcastId': broadcast._id }),
        MerchantNotification.deleteMany({ 'data.broadcastId': broadcast._id }),
        AdminBroadcast.deleteOne({ _id: broadcast._id }),
      ]);
      throw error;
    }
    res.status(201).json({ success: true, message: 'Broadcast sent.', data: { broadcast } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
