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
    const ids = user.cart.map(item => item.itemId).filter(id => mongoose.isValidObjectId(id));
    const [products, deals] = await Promise.all([
      Product.find({ _id: { $in: ids } }).lean(), Deal.find({ _id: { $in: ids } }).lean(),
    ]);
    const catalogue = new Map([...deals, ...products].map(item => [String(item._id), item]));
    const cart = user.cart.map(item => {
      const current = catalogue.get(item.itemId);
      if (!current) return { ...item.toObject(), available: false };
      return {
        ...item.toObject(), name: current.name || current.title,
        price: current.price != null ? (current.discountPrice > 0 ? current.discountPrice : current.price) : current.currentPrice,
        merchantId: current.merchantId?.toString() || null,
        image: current.image, taxRate: current.vat || 0, taxMethod: current.taxMethod || 'None',
        available: current.isActive !== false && current.inStock !== false,
      };
    });
    res.json({ success: true, data: cart });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cart/add - body: { itemId, itemType, name, price, quantity, merchantId }
router.post('/add', async (req, res) => {
  try {
    const { itemId, itemType } = req.body;
    const quantity = Number(req.body.quantity ?? 1);
    if (typeof itemId !== 'string' || !mongoose.isValidObjectId(itemId)) {
      return res.status(400).json({ success: false, message: 'A valid itemId is required' });
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) {
      return res.status(400).json({ success: false, message: 'Quantity must be between 1 and 999' });
    }

    // Resolve the real price/name rather than trusting the body, and refresh
    // them on an item that is already in the cart. Adding an item that was
    // already there only bumped the quantity, so a line first stored with a
    // stale (or zero) price kept that price forever — and the cart screen
    // renders whatever price is stored on the line.
    let resolvedPrice;
    let resolvedName;
    let resolvedMerchant;

    if (mongoose.Types.ObjectId.isValid(itemId)) {
      const product = await Product.findOne({ _id: itemId, isActive: true, inStock: true });
      if (product) {
        resolvedPrice = (product.discountPrice != null && product.discountPrice > 0)
          ? product.discountPrice
          : product.price;
        resolvedName = product.name || resolvedName;
        resolvedMerchant = product.merchantId?.toString();
      } else {
        const deal = await Deal.findOne({ _id: itemId, isActive: true, $or: [{ endTime: null }, { endTime: { $gt: new Date() } }] });
        if (deal) {
          resolvedPrice = deal.currentPrice;
          resolvedName = deal.title || resolvedName;
          resolvedMerchant = deal.merchantId?.toString();
        }
      }
    }

    if (!Number.isFinite(resolvedPrice) || resolvedPrice < 0) {
      return res.status(404).json({ success: false, message: 'This item is no longer available' });
    }
    if (resolvedMerchant && !await User.exists({ _id: resolvedMerchant, role: 'merchant', isActive: { $ne: false } })) {
      return res.status(404).json({ success: false, message: 'This store is currently unavailable' });
    }
    const incrementExisting = () => User.findOneAndUpdate(
      { _id: req.user.id, cart: { $elemMatch: { itemId, quantity: { $lte: 999 - quantity } } } },
      { $inc: { 'cart.$.quantity': quantity }, $set: {
        'cart.$.price': resolvedPrice, 'cart.$.name': resolvedName, 'cart.$.merchantId': resolvedMerchant || null,
      } }, { new: true },
    ).select('cart');
    let user = await incrementExisting();
    if (!user) {
      user = await User.findOneAndUpdate(
        { _id: req.user.id, 'cart.itemId': { $ne: itemId } },
        { $push: { cart: { itemId, itemType: itemType || 'product', name: resolvedName,
          price: resolvedPrice, quantity, merchantId: resolvedMerchant || null } } }, { new: true },
      ).select('cart');
    }
    // A simultaneous first add may have inserted the line between the two writes.
    if (!user) user = await incrementExisting();
    if (!user) return res.status(409).json({ success: false, message: 'Maximum item quantity reached' });
    res.json({ success: true, data: user.cart });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/cart/update - body: { itemId, quantity }
router.put('/update', async (req, res) => {
  try {
    const { itemId } = req.body;
    const quantity = Number(req.body.quantity);
    if (!itemId) return res.status(400).json({ success: false, message: 'itemId required' });
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) {
      return res.status(400).json({ success: false, message: 'Quantity must be between 1 and 999' });
    }
    const user = await User.findOneAndUpdate({ _id: req.user.id, 'cart.itemId': itemId },
      { $set: { 'cart.$.quantity': quantity } }, { new: true }).select('cart');
    if (!user) return res.status(404).json({ success: false, message: 'Item not in cart' });
    res.json({ success: true, data: user.cart });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/cart/remove/:itemId
router.delete('/remove/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const user = await User.findByIdAndUpdate(req.user.id, { $pull: { cart: { itemId } } }, { new: true }).select('cart');
    res.json({ success: true, data: user.cart });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cart/clear
router.post('/clear', async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.user.id, { $set: { cart: [] } }, { new: true }).select('cart');
    res.json({ success: true, data: user.cart });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
