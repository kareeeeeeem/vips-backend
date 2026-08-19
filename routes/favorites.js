const express = require('express');
const User = require('../models/User');
const Deal = require('../models/Deal');
const Product = require('../models/Product');
const Outing = require('../models/Outing');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Use auth for all favorites routes
router.use(authMiddleware);

// GET /api/favorites - return user's favorites (raw — just {itemId, itemType, addedAt})
router.get('/', async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('favorites');
    res.json({ success: true, data: user.favorites });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/favorites/details - favorites denormalized with the real item
// (title/image/price/etc.) they point to, so the app doesn't have to
// separately fetch and cross-reference every content list itself. Items
// whose target has been deleted since being favorited are dropped.
router.get('/details', async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('favorites');
    const favorites = user.favorites || [];

    const idsByType = { deal: [], product: [], outing: [], merchant: [] };
    for (const f of favorites) {
      const type = (f.itemType || '').toLowerCase();
      if (idsByType[type] && f.itemId) idsByType[type].push(f.itemId);
    }

    const [deals, products, outings, merchants] = await Promise.all([
      idsByType.deal.length ? Deal.find({ _id: { $in: idsByType.deal } }) : [],
      idsByType.product.length ? Product.find({ _id: { $in: idsByType.product } }) : [],
      idsByType.outing.length ? Outing.find({ _id: { $in: idsByType.outing } }) : [],
      idsByType.merchant.length
        ? User.find({ _id: { $in: idsByType.merchant } }).select('storeName storeCategory logo brandColor discountPercentage')
        : [],
    ]);

    const findIn = (list, id) => list.find((doc) => doc._id.toString() === id.toString());

    const results = favorites
      .map((f) => {
        const type = (f.itemType || '').toLowerCase();
        let item = null;
        if (type === 'deal') item = findIn(deals, f.itemId);
        else if (type === 'product') item = findIn(products, f.itemId);
        else if (type === 'outing') item = findIn(outings, f.itemId);
        else if (type === 'merchant') item = findIn(merchants, f.itemId);

        return item
          ? { itemId: f.itemId, itemType: f.itemType, addedAt: f.addedAt, item }
          : null;
      })
      .filter(Boolean);

    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/favorites/toggle - body: { itemId, itemType }
router.post('/toggle', async (req, res) => {
  try {
    const { itemId, itemType } = req.body;
    if (!itemId) return res.status(400).json({ success: false, message: 'itemId required' });

    const user = await User.findById(req.user.id);
    const index = user.favorites.findIndex(f => f.itemId?.toString() === itemId.toString());

    if (index === -1) {
      user.favorites.push({ itemId, itemType: itemType || 'Other' });
    } else {
      user.favorites.splice(index, 1);
    }

    await user.save();
    res.json({ success: true, data: user.favorites });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/favorites/:itemId
router.delete('/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const user = await User.findById(req.user.id);
    user.favorites = user.favorites.filter(f => f.itemId?.toString() !== itemId.toString());
    await user.save();
    res.json({ success: true, data: user.favorites });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
