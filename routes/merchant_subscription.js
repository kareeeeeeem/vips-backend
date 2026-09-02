/**
 * Merchant Subscription Routes  —  /api/merchant/subscription
 * Plan catalogue, current subscription, and subscribe / cancel.
 */

const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const MerchantSubscription = require('../models/MerchantSubscription');
const User        = require('../models/User');
const Transaction = require('../models/Transaction');

const router = express.Router();
router.use(authMiddleware);

// ─── Plan catalogue (§8) ──────────────────────────────────
// Three plans, priced in dinars, where the monthly fee buys a lower
// commission. This used to be four tiers named Free/Basic/Pro/Enterprise
// priced in dollars at 9.99/29.99/99.99 — a different product from the one
// the platform document describes, and the reason the merchant's plan
// screen came up empty: nothing it listed matched a plan the rest of the
// system would accept.
const { PLANS: ECONOMIC_PLANS } = require('../config/economics');

const PLAN_FEATURES = {
  basic: {
    maxProducts:     50,
    maxCashiers:     2,
    customerDatabase: false,
    smartSegments:   false,
    campaigns:       false,
    predictive:      false,
    prioritySupport: false,
  },
  professional: {
    maxProducts:     500,
    maxCashiers:     10,
    customerDatabase: true,
    smartSegments:   true,
    campaigns:       true,
    predictive:      false,
    prioritySupport: false,
  },
  advanced: {
    maxProducts:     -1,
    maxCashiers:     -1,
    customerDatabase: true,
    smartSegments:   true,
    campaigns:       true,
    predictive:      true,
    prioritySupport: true,
  },
};

const PLANS = Object.fromEntries(
  Object.entries(ECONOMIC_PLANS).map(([key, plan]) => [
    key,
    {
      name:  plan.label,
      code:  key,
      // Dinars per month, and the commission the platform takes in return.
      price: plan.monthlyFeeTnd,
      currency: 'TND',
      commissionPercent: plan.commissionPercent,
      features: PLAN_FEATURES[key],
    },
  ])
);

// ─── GET /api/merchant/subscription/plans ─────────────────
router.get('/plans', async (req, res) => {
  res.json({ success: true, data: Object.values(PLANS) });
});

// ─── GET /api/merchant/subscription/current ───────────────
router.get('/current', async (req, res) => {
  try {
    let sub = await MerchantSubscription.findOne({ merchantId: req.user.id });
    if (!sub) {
      sub = await MerchantSubscription.create({
        merchantId: req.user.id,
        planName:   PLANS.basic.name,
        planCode:   PLANS.basic.code,
        price:      PLANS.basic.price,
        features:   PLANS.basic.features,
        startDate:  new Date(),
        endDate:    null,
        isActive:   true,
        autoRenew:  false,
      });
    }
    res.json({ success: true, data: sub });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/subscription/subscribe ────────────
router.post('/subscribe', async (req, res) => {
  try {
    const { planCode, billingCycle = 'monthly', paymentMethod = 'wallet' } = req.body;
    if (!planCode || !PLANS[planCode]) {
      return res.status(400).json({ success: false, message: 'Invalid plan code' });
    }

    const plan     = PLANS[planCode];
    const isYearly = billingCycle === 'yearly';
    const price    = isYearly ? plan.price * 10 : plan.price; // 2 months free on yearly
    const months   = isYearly ? 12 : 1;
    const endDate  = new Date();
    endDate.setMonth(endDate.getMonth() + months);

    if (price > 0) {
      const merchant = await User.findById(req.user.id);
      if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
      if (merchant.walletBalance < price) {
        return res.status(400).json({ success: false, message: 'Insufficient wallet balance' });
      }

      merchant.walletBalance -= price;
      await merchant.save();

      await Transaction.create({
        userId:      req.user.id,
        merchantId:  req.user.id,
        type:        'expense',
        amount:      price,
        currency:    'TND',
        description: `Subscription — ${plan.name} (${billingCycle})`,
        status:      'completed',
        reference:   `SUB-${Date.now()}`,
      });
    }

    const sub = await MerchantSubscription.findOneAndUpdate(
      { merchantId: req.user.id },
      {
        planName:     plan.name,
        planCode:     plan.code,
        price,
        billingCycle,
        startDate:    new Date(),
        endDate,
        isActive:     true,
        autoRenew:    true,
        features:     plan.features,
        $push: {
          paymentHistory: {
            amount:    price,
            reference: `SUB-${Date.now()}`,
            method:    paymentMethod,
          },
        },
      },
      { upsert: true, new: true }
    );

    // §8: the plan is what sets the commission, so the merchant's own record
    // moves with it. Without this the subscription screen would take the
    // money and change nothing the rest of the platform reads — the merchant
    // would keep paying 3% on a plan they had upgraded off.
    const merchantDoc = await User.findById(req.user.id);
    if (merchantDoc) {
      merchantDoc.merchantPlan = plan.code; // pre-save hook resets commissionRate
      await merchantDoc.save();
    }

    res.json({
      success: true,
      message: `Subscribed to ${plan.name}`,
      data: {
        ...sub.toObject(),
        commissionPercent: plan.commissionPercent,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/subscription/cancel ───────────────
// Turns off auto-renewal; subscription stays active until endDate
router.post('/cancel', async (req, res) => {
  try {
    const sub = await MerchantSubscription.findOneAndUpdate(
      { merchantId: req.user.id },
      { autoRenew: false },
      { new: true }
    );
    if (!sub) return res.status(404).json({ success: false, message: 'No subscription found' });
    res.json({
      success: true,
      message: 'Auto-renewal cancelled. Active until ' + (sub.endDate ? sub.endDate.toDateString() : 'N/A'),
      data: sub,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/subscription/history ───────────────
router.get('/history', async (req, res) => {
  try {
    const sub = await MerchantSubscription.findOne({ merchantId: req.user.id });
    if (!sub) return res.json({ success: true, data: [] });
    res.json({ success: true, data: sub.paymentHistory });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
