const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const Due = require('../models/Due');

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const dues = await Due.find({ merchantId: req.user.id }).sort({ lastTransaction: -1 });
    res.json({ success: true, data: dues });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const due = await Due.create({ ...req.body, merchantId: req.user.id });
    res.json({ success: true, data: due });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const due = await Due.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      { ...req.body, lastTransaction: new Date() },
      { new: true }
    );
    if (!due) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: due });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await Due.findOneAndDelete({ _id: req.params.id, merchantId: req.user.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
