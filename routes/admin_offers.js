const express = require('express');
const Coupon = require('../models/Coupon');
const { requirePermission } = require('../middleware/permissions');
const { paginate, escapeRegex, isValidId } = require('../utils/adminHelpers');

const router = express.Router();

/** GET /api/admin/offers — the platform-wide coupon and voucher catalogue. */
router.get('/', requirePermission('offers.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req.query);
    const filter = {};
    if (req.query.type) filter.type = req.query.type;
    if (req.query.status === 'active') filter.isActive = true;
    if (req.query.status === 'inactive') filter.isActive = false;
    if (req.query.merchantId && isValidId(req.query.merchantId)) {
      filter.merchantId = req.query.merchantId;
    }
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(req.query.search.trim()), 'i');
      filter.$or = [{ code: rx }, { description: rx }, { tags: rx }];
    }

    const [items, total] = await Promise.all([
      Coupon.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('merchantId', 'storeName fullName phone')
        .lean(),
      Coupon.countDocuments(filter),
    ]);
    res.json({
      success: true,
      message: 'Offers',
      data: {
        items: items.map((offer) => ({
          ...offer,
          merchantName: offer.merchantId
            ? (offer.merchantId.storeName || offer.merchantId.fullName)
            : 'Platform',
        })),
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** PUT /api/admin/offers/:id/status — moderation without rewriting terms. */
router.put('/:id/status', requirePermission('offers.update'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid offer id.' });
    }
    if (typeof req.body.isActive !== 'boolean') {
      return res.status(400).json({ success: false, message: 'isActive must be true or false.' });
    }
    const offer = await Coupon.findByIdAndUpdate(
      req.params.id,
      { isActive: req.body.isActive },
      { new: true, runValidators: true },
    );
    if (!offer) return res.status(404).json({ success: false, message: 'Offer not found.' });
    res.json({ success: true, message: offer.isActive ? 'Offer activated.' : 'Offer suspended.', data: { offer } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** DELETE only unused offers; used vouchers remain financial evidence. */
router.delete('/:id', requirePermission('offers.delete'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid offer id.' });
    }
    const offer = await Coupon.findById(req.params.id);
    if (!offer) return res.status(404).json({ success: false, message: 'Offer not found.' });
    if ((offer.usageCount || offer.usedCount || 0) > 0) {
      return res.status(409).json({ success: false, message: 'A used offer cannot be deleted. Suspend it instead.' });
    }
    await offer.deleteOne();
    res.json({ success: true, message: 'Offer deleted.', data: { deletedId: req.params.id } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
