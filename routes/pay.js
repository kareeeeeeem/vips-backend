/**
 * Paying a merchant's bill with VIPs points (§4.3).
 *
 * The merchant enters the total and shows a code; the customer resolves it
 * and settles the bill from their points balance. Nothing here lets a
 * customer pay more than the bill, pay a bill twice, or pay one that is not
 * theirs to pay — each of those is checked at the moment of payment rather
 * than trusted from the request.
 */
const express = require('express');
const { authMiddleware } = require('../middleware/auth');

const User = require('../models/User');
const MerchantBill = require('../models/MerchantBill');
const Transaction = require('../models/Transaction');
const giftback = require('../utils/giftback');
const guarantee = require('../utils/guarantee');
const { pointsToTnd, tndToPoints, commissionForInvoice } = require('../config/economics');

const router = express.Router();
router.use(authMiddleware);

/** Normalises whatever the camera read into a bare pay code. */
function extractPayCode(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  // Accept the code alone, or the QR payload that carries it.
  const match = text.match(/VB-[A-Z2-9]{8}/i);
  return match ? match[0].toUpperCase() : null;
}

async function loadPayableBill(code) {
  const bill = await MerchantBill.findOne({ payCode: code })
    .populate('merchantId', 'storeName fullName logo storeCategory earnRate');
  if (!bill) return { error: { status: 404, message: 'No bill matches that code.' } };
  if (bill.status !== 'active') {
    return { error: { status: 409, message: `This bill was ${bill.status}.` } };
  }
  if (bill.paymentStatus === 'paid') {
    // The code is deliberately kept on a paid bill rather than cleared:
    // clearing it makes a second scan answer "no such bill", which reads as
    // a broken code to someone who has just paid with it.
    return { error: { status: 409, message: 'This bill has already been paid.' } };
  }
  if (bill.payCodeExpiresAt && bill.payCodeExpiresAt < new Date()) {
    return {
      error: {
        status: 410,
        message: 'This code has expired. Ask the shop to show a new one.',
      },
    };
  }
  return { bill };
}

// ─── GET /api/pay/bill/:code ──────────────────────────────
/**
 * What the customer sees before they agree to anything: the shop, the
 * amount, what it costs in points, and whether they have enough.
 */
router.get('/bill/:code', async (req, res) => {
  try {
    const code = extractPayCode(req.params.code);
    if (!code) return res.status(400).json({ success: false, message: 'That is not a VIPs bill code.' });

    const { bill, error } = await loadPayableBill(code);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    // Anything inside its twelve hours is not spendable yet, so settle what
    // is due before telling the customer what they hold.
    await giftback.activateDue(req.user.id);
    const customer = await User.findById(req.user.id).select('walletPoints');

    const due = Math.max(0, bill.grandTotal - (bill.paidAmount || 0));
    const pointsNeeded = tndToPoints(due);
    const held = customer?.walletPoints || 0;

    res.json({
      success: true,
      data: {
        payCode: bill.payCode,
        billNumber: bill.billNumber,
        merchant: {
          name: bill.merchantId?.storeName || bill.merchantId?.fullName || 'Shop',
          category: bill.merchantId?.storeCategory || '',
          logo: bill.merchantId?.logo || null,
        },
        items: (bill.items || []).map((i) => ({
          name: i.name, quantity: i.quantity, total: i.total,
        })),
        grandTotal: bill.grandTotal,
        alreadyPaid: bill.paidAmount || 0,
        dueTnd: Math.round(due * 1000) / 1000,
        pointsNeeded,
        yourPoints: held,
        // Said plainly rather than left for the app to work out, so both
        // sides agree on whether this can go ahead.
        canPay: held >= pointsNeeded && pointsNeeded > 0,
        shortBy: Math.max(0, pointsNeeded - held),
        expiresAt: bill.payCodeExpiresAt,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── POST /api/pay/bill/:code ─────────────────────────────
/**
 * Settles the bill from the customer's points.
 *
 * The bill is claimed with a guarded update before any balance moves, so two
 * taps — or two phones — cannot pay the same bill twice. If crediting the
 * merchant then fails, the claim is released rather than leaving a bill
 * marked paid that nobody paid for.
 */
router.post('/bill/:code', async (req, res) => {
  try {
    const code = extractPayCode(req.params.code);
    if (!code) return res.status(400).json({ success: false, message: 'That is not a VIPs bill code.' });

    const { bill, error } = await loadPayableBill(code);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    await giftback.activateDue(req.user.id);
    const customer = await User.findById(req.user.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Account not found.' });

    const due = Math.max(0, bill.grandTotal - (bill.paidAmount || 0));
    const pointsNeeded = tndToPoints(due);
    if (pointsNeeded <= 0) {
      return res.status(409).json({ success: false, message: 'There is nothing left to pay on this bill.' });
    }
    if ((customer.walletPoints || 0) < pointsNeeded) {
      return res.status(400).json({
        success: false,
        message: `This bill needs ${pointsNeeded} points and you have ${customer.walletPoints || 0}.`,
        data: { pointsNeeded, yourPoints: customer.walletPoints || 0 },
      });
    }

    // Claim it first. `paymentStatus: 'pending'` in the filter is what makes
    // a second attempt find nothing.
    const claimed = await MerchantBill.findOneAndUpdate(
      { _id: bill._id, paymentStatus: 'pending', status: 'active' },
      {
        $set: {
          paymentStatus: 'paid',
          paymentMethod: 'points',
          paidAmount: bill.grandTotal,
          pointsSpent: pointsNeeded,
          paidAt: new Date(),
          customerId: customer._id,
        },
      },
      { new: true }
    );
    if (!claimed) {
      return res.status(409).json({ success: false, message: 'This bill has just been paid.' });
    }

    try {
      customer.walletPoints = (customer.walletPoints || 0) - pointsNeeded;
      await customer.save();

      // §4.2's third offer: the shop handed over goods for points, so the
      // value returns to the balance that funds their offers.
      await guarantee.creditRedemption(bill.merchantId._id || bill.merchantId, pointsNeeded, {
        customerId: customer._id,
        note: `Bill ${bill.billNumber} paid with points`,
      });

      const commission = commissionForInvoice(due, (bill.merchantId.merchantPlan) || 'basic');

      await Transaction.create([
        {
          userId: customer._id,
          merchantId: bill.merchantId._id || bill.merchantId,
          type: 'expense',
          amount: pointsNeeded,
          currency: 'PTS',
          description: `Paid ${due} TND at ${bill.merchantId?.storeName || 'a shop'}`,
          status: 'completed',
          reference: bill.billNumber,
        },
        {
          userId: customer._id,
          merchantId: bill.merchantId._id || bill.merchantId,
          type: 'income',
          amount: due,
          currency: 'TND',
          description: `Bill ${bill.billNumber} paid with VIPs points`,
          status: 'completed',
          reference: bill.billNumber,
        },
      ]);

      // Tell the merchant's screen without making them refresh.
      const io = req.app.get('io');
      if (io) {
        io.to(String(bill.merchantId._id || bill.merchantId)).emit('bill-paid', {
          billNumber: bill.billNumber,
          amount: due,
          pointsSpent: pointsNeeded,
          customerName: customer.fullName,
        });
      }

      res.json({
        success: true,
        message: `Paid ${due} TND with ${pointsNeeded} points.`,
        data: {
          billNumber: bill.billNumber,
          paidTnd: Math.round(due * 1000) / 1000,
          pointsSpent: pointsNeeded,
          remainingPoints: customer.walletPoints,
          remainingValueTnd: pointsToTnd(customer.walletPoints),
          merchant: bill.merchantId?.storeName || bill.merchantId?.fullName || 'Shop',
          commission,
        },
      });
    } catch (inner) {
      // Put the bill back rather than leaving it marked paid by nobody.
      await MerchantBill.updateOne(
        { _id: bill._id },
        {
          $set: {
            paymentStatus: 'pending',
            paymentMethod: bill.paymentMethod,
            paidAmount: bill.paidAmount || 0,
            pointsSpent: 0,
            paidAt: null,
          },
        }
      );
      throw inner;
    }
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
