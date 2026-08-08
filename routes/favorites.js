const express = require('express');
const User = require('../models/User');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Use auth for all favorites routes
router.use(authMiddleware);

// GET /api/favorites - return user's favorites
router.get('/', async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('favorites');
    res.json({ success: true, data: user.favorites });
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
