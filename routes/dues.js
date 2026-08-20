const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const Due = require('../models/Due');

const router = express.Router();
router.use(authMiddleware);

// The only route here that isn't already served by merchant.js's generic
// dues CRUD sub-router (GET /, POST /, PUT /:id, DELETE /:id) — Express
// falls through to this file only for the /:id/collect path.
router.put('/:id/collect', async (req, res) => {
  try {
    const { paidAmount } = req.body;
    const due = await Due.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      { paidAmount: parseFloat(paidAmount || 0), lastTransaction: new Date() },
      { new: true }
    );
    if (!due) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: due });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
