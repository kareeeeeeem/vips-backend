/**
 * Merchant Notification Routes  —  /api/merchant/notifications
 * Real merchant notifications (replaces the empty stub in merchant.js).
 */

const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const MerchantNotification = require('../models/MerchantNotification');

const router = express.Router();
router.use(authMiddleware);

// ─── GET /api/merchant/notifications ─────────────────────
router.get('/', async (req, res) => {
  try {
    const { isRead, type, page = 1, limit = 20 } = req.query;
    const filter = { merchantId: req.user.id };
    if (isRead !== undefined) filter.isRead = isRead === 'true';
    if (type)                 filter.type   = type;

    const [notifications, total, unreadCount] = await Promise.all([
      MerchantNotification.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit)),
      MerchantNotification.countDocuments(filter),
      MerchantNotification.countDocuments({ merchantId: req.user.id, isRead: false }),
    ]);

    res.json({
      success: true,
      data: {
        notifications,
        total,
        unreadCount,
        pagination: { page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/notifications/read-all ───────────
router.post('/read-all', async (req, res) => {
  try {
    await MerchantNotification.updateMany(
      { merchantId: req.user.id, isRead: false },
      { isRead: true }
    );
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/merchant/notifications/:id/read ────────────
router.put('/:id/read', async (req, res) => {
  try {
    const n = await MerchantNotification.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      { isRead: true },
      { new: true }
    );
    if (!n) return res.status(404).json({ success: false, message: 'Notification not found' });
    res.json({ success: true, data: n });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── DELETE /api/merchant/notifications/:id ──────────────
router.delete('/:id', async (req, res) => {
  try {
    await MerchantNotification.findOneAndDelete({ _id: req.params.id, merchantId: req.user.id });
    res.json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── DELETE /api/merchant/notifications ──────────────────
// Clear all notifications for this merchant
router.delete('/', async (req, res) => {
  try {
    await MerchantNotification.deleteMany({ merchantId: req.user.id });
    res.json({ success: true, message: 'All notifications cleared' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Internal helper (used by other routes to push a notification) ───
// Call: require('./merchant_notifications').push(merchantId, title, body, type, data)
async function push(merchantId, title, body, type = 'system', data = {}) {
  try {
    await MerchantNotification.create({ merchantId, title, body, type, data });
  } catch (_) {}
}

module.exports = router;
module.exports.push = push;
