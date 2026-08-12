const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const Stock = require('../models/Stock');

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const items = await Stock.find({ merchantId: req.user.id }).sort({ createdAt: -1 });
    res.json({ success: true, data: items });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const item = await Stock.create({ ...req.body, merchantId: req.user.id });
    res.status(201).json({ success: true, data: item });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const item = await Stock.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      req.body,
      { new: true }
    );
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: item });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await Stock.findOneAndDelete({ _id: req.params.id, merchantId: req.user.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
