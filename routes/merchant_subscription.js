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

// ─── Plan catalogue (static) ──────────────────────────────
const PLANS = {
  free: {
    name:  'Free',
    code:  'free',
    price: 0,
    features: {
      maxProducts:     10,
      maxCashiers:     1,
      analytics:       false,
      adsEnabled:      false,
      prioritySupport: false,
      apiAccess:       false,
    },
  },
  basic: {
    name:  'Basic',
    code:  'basic',
    price: 9.99,
    features: {
      maxProducts:     50,
      maxCashiers:     3,
      analytics:       true,
      adsEnabled:      false,
      prioritySupport: false,
      apiAccess:       false,
    },
  },
  pro: {
    name:  'Professional',
    code:  'pro',
    price: 29.99,
    features: {
      maxProducts:     500,
      maxCashiers:     10,
      analytics:       true,
      adsEnabled:      true,
      prioritySupport: true,
      apiAccess:       false,
    },
  },
  enterprise: {
    name:  'Enterprise',
    code:  'enterprise',
    price: 99.99,
    features: {
      maxProducts:     -1,
      maxCashiers:     -1,
      analytics:       true,
      adsEnabled:      true,
      prioritySupport: true,
      apiAccess:       true,
    },
  },
};

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
        planName:   PLANS.free.name,
        planCode:   PLANS.free.code,
        price:      PLANS.free.price,
        features:   PLANS.free.features,
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
        currency:    'GMD',
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

    res.json({ success: true, message: `Subscribed to ${plan.name}`, data: sub });
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
