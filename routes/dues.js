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
    // `payment` is an increment (preferred — two devices collecting at once
    // can't clobber each other); `paidAmount` is the absolute new total,
    // kept for the existing caller. Neither was validated at all before, so
    // a collection could push paidAmount past totalAmount and leave the
    // party's remaining balance negative, or go negative outright.
    const { paidAmount, payment } = req.body;

    const due = await Due.findOne({ _id: req.params.id, merchantId: req.user.id });
    if (!due) return res.status(404).json({ success: false, message: 'Not found' });

    let nextPaid;
    if (payment !== undefined && payment !== null && payment !== '') {
      const inc = parseFloat(payment);
      if (!Number.isFinite(inc) || inc <= 0) {
        return res.status(400).json({ success: false, message: 'payment must be a number greater than 0' });
      }
      nextPaid = (due.paidAmount || 0) + inc;
    } else {
      nextPaid = parseFloat(paidAmount);
      if (!Number.isFinite(nextPaid) || nextPaid < 0) {
        return res.status(400).json({ success: false, message: 'paidAmount must be a number of 0 or more' });
      }
    }

    if (nextPaid > (due.totalAmount || 0) + 1e-9) {
      const outstanding = Math.max(0, (due.totalAmount || 0) - (due.paidAmount || 0));
      return res.status(400).json({
        success: false,
        message: `Payment exceeds the outstanding balance (D ${outstanding.toFixed(3)})`,
        data: { outstanding },
      });
    }

    due.paidAmount      = nextPaid;
    due.lastTransaction = new Date();
    await due.save();

    res.json({ success: true, data: due });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
