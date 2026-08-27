const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Product = require('../models/Product');
const Deal = require('../models/Deal');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);

// GET /api/cart - return user's cart
router.get('/', async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('cart');
    res.json({ success: true, data: user.cart });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cart/add - body: { itemId, itemType, name, price, quantity, merchantId }
router.post('/add', async (req, res) => {
  try {
    const { itemId, itemType, name, price = 0, quantity = 1, merchantId } = req.body;
    if (!itemId) return res.status(400).json({ success: false, message: 'itemId required' });

    // Resolve the real price/name rather than trusting the body, and refresh
    // them on an item that is already in the cart. Adding an item that was
    // already there only bumped the quantity, so a line first stored with a
    // stale (or zero) price kept that price forever — and the cart screen
    // renders whatever price is stored on the line.
    let resolvedPrice = Number(price) || 0;
    let resolvedName = name;
    let resolvedMerchant = merchantId;

    if (mongoose.Types.ObjectId.isValid(itemId)) {
      const product = await Product.findById(itemId).select('name price discountPrice merchantId');
      if (product) {
        resolvedPrice = (product.discountPrice != null && product.discountPrice > 0)
          ? product.discountPrice
          : product.price;
        resolvedName = product.name || resolvedName;
        resolvedMerchant = resolvedMerchant || product.merchantId?.toString();
      } else {
        const deal = await Deal.findById(itemId).select('title currentPrice merchantId');
        if (deal) {
          resolvedPrice = deal.currentPrice;
          resolvedName = deal.title || resolvedName;
          resolvedMerchant = resolvedMerchant || deal.merchantId?.toString();
        }
      }
    }

    const user = await User.findById(req.user.id);
    const existing = user.cart.find(c => c.itemId?.toString() === itemId.toString());

    if (existing) {
      existing.quantity = (existing.quantity || 1) + quantity;
      existing.price = resolvedPrice;
      if (resolvedName) existing.name = resolvedName;
      if (resolvedMerchant) existing.merchantId = resolvedMerchant;
    } else {
      user.cart.push({
        itemId,
        itemType: itemType || 'product',
        name: resolvedName,
        price: resolvedPrice,
        quantity,
        merchantId: resolvedMerchant,
      });
    }

    await user.save();
    res.json({ success: true, data: user.cart });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/cart/update - body: { itemId, quantity }
router.put('/update', async (req, res) => {
  try {
    const { itemId, quantity } = req.body;
    if (!itemId) return res.status(400).json({ success: false, message: 'itemId required' });

    const user = await User.findById(req.user.id);
    const item = user.cart.find(c => c.itemId?.toString() === itemId.toString());
    if (!item) return res.status(404).json({ success: false, message: 'Item not in cart' });

    item.quantity = quantity;
    await user.save();
    res.json({ success: true, data: user.cart });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/cart/remove/:itemId
router.delete('/remove/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const user = await User.findById(req.user.id);
    user.cart = user.cart.filter(c => c.itemId?.toString() !== itemId.toString());
    await user.save();
    res.json({ success: true, data: user.cart });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cart/clear
router.post('/clear', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    user.cart = [];
    await user.save();
    res.json({ success: true, data: user.cart });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
