const express = require('express');
const MerchantAd = require('../models/MerchantAd');
const { requirePermission } = require('../middleware/permissions');
const { paginate, escapeRegex, isValidId } = require('../utils/adminHelpers');

const router = express.Router();

router.get('/', requirePermission('ads.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req.query);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.moderation) filter.moderationStatus = req.query.moderation;
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(req.query.search.trim()), 'i');
      filter.$or = [{ title: rx }, { description: rx }, { targetAudience: rx }];
    }
    const [items, total] = await Promise.all([
      MerchantAd.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate('merchantId', 'storeName fullName phone').lean(),
      MerchantAd.countDocuments(filter),
    ]);
    res.json({ success: true, message: 'Advertisements', data: {
      items: items.map((ad) => ({ ...ad,
        merchantName: ad.merchantId ? (ad.merchantId.storeName || ad.merchantId.fullName) : 'Deleted merchant',
      })),
      total, page, limit, pages: Math.ceil(total / limit),
    }});
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:id/moderate', requirePermission('ads.moderate'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid ad id.' });
    const decision = req.body.decision;
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'Decision must be approved or rejected.' });
    }
    const reason = String(req.body.reason || '').trim();
    if (decision === 'rejected' && reason.length < 3) {
      return res.status(400).json({ success: false, message: 'A rejection reason is required.' });
    }
    const ad = await MerchantAd.findByIdAndUpdate(req.params.id, {
      moderationStatus: decision,
      moderationReason: reason,
      moderatedBy: req.user.id,
      moderatedAt: new Date(),
      ...(decision === 'rejected' ? { status: 'paused' } : {}),
    }, { new: true, runValidators: true });
    if (!ad) return res.status(404).json({ success: false, message: 'Advertisement not found.' });
    res.json({ success: true, message: `Advertisement ${decision}.`, data: { ad } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
