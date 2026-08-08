const express = require('express');
const User = require('../models/User');
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

    const user = await User.findById(req.user.id);
    const existing = user.cart.find(c => c.itemId?.toString() === itemId.toString());

    if (existing) {
      existing.quantity = (existing.quantity || 1) + quantity;
    } else {
      user.cart.push({ itemId, itemType: itemType || 'product', name, price, quantity, merchantId });
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
