const express = require('express');
const BillService = require('../models/BillService');
const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { authMiddleware, optionalAuthMiddleware } = require('../middleware/auth');

const router = express.Router();
const WEEKLY_PACKAGE_PRICES = Object.freeze({ silver: 0.3, gold: 0.5, platinum: 1 });

// ─── Real-provider integration gates ──────────────────────
// Mobile recharge and utility bill payment/inquiry have no actual telecom
// or utility provider behind them (no Orange/Ooredoo/Tunisie Telecom/
// STEG/SONEDE API integration exists). They used to debit the customer's
// real wallet balance and show "Recharged/Paid successfully!" regardless —
// real money taken, no real service ever delivered. Until a real provider
// (or aggregator) API key is set, these stay honestly disabled instead of
// faking success, mirroring how /payment/methods already gates Paymee/
// PayPal on whether real credentials are configured.
// No provider adapter exists in this repository. An API key alone cannot
// deliver airtime, query a bill or transfer a donation. Keep these gates shut
// until an actual provider implementation and its receipt verification exist.
const TELECOM_RECHARGE_CONFIGURED = false;
const UTILITY_BILLS_CONFIGURED = false;
const DONATIONS_CONFIGURED = false;
const NOT_CONFIGURED_MESSAGE =
  'This service isn\'t available yet — real provider integration is still pending.';

// ─── Seed bill services if empty ──────────────────────────
async function seedBillServices() {
  try {
    const count = await BillService.countDocuments();
    if (count === 0) {
      await BillService.insertMany([
        { name: 'Home Internet', provider: 'Tunisie Telecom', type: 'internet', logo: 'https://www.tunisietelecom.tn/favicon.ico', fee: 0 },
        { name: 'Mobile Bills', provider: 'Ooredoo', type: 'mobile', logo: 'https://www.ooredoo.tn/favicon.ico', fee: 0 },
        { name: 'Electric Bill', provider: 'STEG', type: 'electricity', logo: 'https://nabeul.info/wp-content/uploads/2019/09/nabeul-info-steg.jpg', fee: 0 },
        { name: 'Gas Bill', provider: 'STEG', type: 'gas', logo: 'https://nabeul.info/wp-content/uploads/2019/09/nabeul-info-steg.jpg', fee: 0 },
        { name: 'Water Bill', provider: 'SONEDE', type: 'water', logo: 'https://www.sonede.com.tn/wp-content/uploads/2024/03/cropped-logo-sonede-2_Plan-de-travail-1.png', fee: 0 },
        { name: 'TV/Cable', provider: 'Canal+', type: 'tv', logo: '', fee: 0 },
        { name: 'Donation', provider: 'Various NGOs', type: 'donation', logo: 'https://cdn-icons-png.flaticon.com/512/2917/2917242.png', fee: 0 },
        { name: 'Education', provider: 'Ministry of Education', type: 'education', logo: 'https://lechotunisien.com/wp-content/uploads/2022/09/ministere-de-leducation.png', fee: 0 },
        { name: 'Government Services', provider: 'E-Gov', type: 'government', logo: '', fee: 0 },
        { name: 'Insurance', provider: 'CNAM', type: 'insurance', logo: '', fee: 0 },
      ]);
    }
  } catch (e) {
    console.log('BillService seed error:', e.message);
  }
}
seedBillServices();

// ─── GET /api/services/status ──────────────────────────────
// Lets the app show real-integration availability up front (grey out /
// label "Coming soon") instead of letting the user go through a whole
// recharge/bill flow only to hit a 503 at the very last step. Same idea
// as GET /payment/methods for Paymee/PayPal.
router.get('/status', (req, res) => {
  res.json({
    success: true,
    data: {
      mobileRecharge: { configured: TELECOM_RECHARGE_CONFIGURED },
      utilityBills: { configured: UTILITY_BILLS_CONFIGURED },
      donations: { configured: DONATIONS_CONFIGURED },
    },
  });
});

// ─── GET /api/services/bills ──────────────────────────────
router.get('/bills', optionalAuthMiddleware, async (req, res) => {
  try {
    let bills = await BillService.find();
    if (bills.length === 0) {
      await seedBillServices();
      bills = await BillService.find();
    }
    res.json({ success: true, data: bills });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/services/pay-bill ──────────────────────────
router.post('/pay-bill', authMiddleware, async (req, res) => {
  if (!UTILITY_BILLS_CONFIGURED) {
    return res.status(503).json({ success: false, message: NOT_CONFIGURED_MESSAGE });
  }
  try {
    const { billServiceId, amount, referenceNumber } = req.body;

    if (!billServiceId || !amount || !referenceNumber) {
      return res.status(400).json({ success: false, message: 'billServiceId, amount and referenceNumber are required' });
    }
    if (amount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
    }

    const billService = await BillService.findById(billServiceId);
    if (!billService) {
      return res.status(404).json({ success: false, message: 'Bill service not found' });
    }

    const user = await User.findById(req.user.id);
    if (user.walletBalance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    user.walletBalance -= amount;
    await user.save();

    const transaction = await Transaction.create({
      userId: req.user.id,
      type: 'expense',
      amount,
      description: `Bill Payment to service ${billServiceId} for ${referenceNumber}`,
      status: 'completed',
      reference: `BILL-${Date.now()}`
    });

    res.json({ success: true, message: 'Bill paid successfully', data: { transaction, newBalance: user.walletBalance } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/services/packages ───────────────────────────
router.get('/packages', authMiddleware, async (req, res) => {
  try {
    // Priced by the week, not the year. A year is a larger commitment than
    // the app's single-step quantity picker suggests, and "1 year / 2 years"
    // asks for a decision the control makes look small.
    //
    // The weekly figures are round numbers rather than a yearly price
    // divided by 52, which produced 0.288 and 0.962 — prices no one would
    // put in front of a customer. They land close to the old annual value:
    // 0.3 a week is 15.6 a year against 15 before.
    const packages = [
      {
        id: 'basic',
        tier: 'basic',
        name: 'Basic',
        price: 0.0,
        billingPeriod: 'week',
        yearlyPrice: 0,
        monthlyPrice: 0,
        redeemPoints: 1000,
        giftPoints: 800,
        isActive: true,
        benefits: ['Standard Support', 'Basic Rewards (1x)', 'Monthly Newsletter'],
      },
      {
        id: 'silver',
        tier: 'silver',
        name: 'Silver',
        price: WEEKLY_PACKAGE_PRICES.silver,
        billingPeriod: 'week',
        yearlyPrice: 15.6,
        monthlyPrice: 1.25,
        redeemPoints: 1500,
        giftPoints: 1200,
        isActive: true,
        benefits: ['Priority Support (24h)', 'Enhanced Rewards (1.5x)', 'Monthly Bonus Offers'],
      },
      {
        id: 'gold',
        tier: 'gold',
        name: 'Gold',
        price: WEEKLY_PACKAGE_PRICES.gold,
        billingPeriod: 'week',
        yearlyPrice: 26,
        monthlyPrice: 2.08,
        redeemPoints: 2500,
        giftPoints: 2200,
        isPopular: true,
        isActive: true,
        benefits: ['Birthday Treat (15% off)', 'Increased Earning Rate (2x)', 'Tier Upgrade Bonus'],
      },
      {
        id: 'platinum',
        tier: 'platinum',
        name: 'Platinum',
        price: WEEKLY_PACKAGE_PRICES.platinum,
        billingPeriod: 'week',
        yearlyPrice: 52,
        monthlyPrice: 4.17,
        redeemPoints: 5000,
        giftPoints: 4500,
        isActive: true,
        benefits: ['Concierge Service', 'Maximum Rewards (3x)', 'Platinum-Exclusive Deals'],
      },
    ];
    res.json({ success: true, data: packages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/services/packages/current ────────────────────
// The Packages screen's "Current" badge was permanently hardcoded to
// Basic client-side — after a real purchase via POST
// /packages/subscribe there was no way to find out the account's real
// active tier.
router.get('/packages/current', authMiddleware, async (req, res) => {
  try {
    const sub = await Subscription.findOne({
      userId: req.user.id, isActive: true, endDate: { $gt: new Date() },
    }).sort({ endDate: -1 });
    res.json({ success: true, data: { tier: sub?.tier || 'basic', endDate: sub?.endDate || null } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/services/packages/subscribe ────────────────
router.post('/packages/subscribe', authMiddleware, async (req, res) => {
  let charged = 0;
  let subscription;
  let prior;
  const lockUntil = new Date(Date.now() + 5 * 60 * 1000);
  try {
    const { tier } = req.body;
    const paymentMethod = req.body.paymentMethod || 'wallet';
    if (!Object.hasOwn(WEEKLY_PACKAGE_PRICES, tier)) {
      return res.status(400).json({ success: false, message: 'Invalid package tier' });
    }
    const quantity = Number(req.body.quantity ?? 1);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10) {
      return res.status(400).json({ success: false, message: 'Choose between 1 and 10 weeks' });
    }
    const amount = require('../config/economics').roundTnd(WEEKLY_PACKAGE_PRICES[tier] * quantity);
    if (req.body.expectedTotal != null &&
        (!Number.isFinite(Number(req.body.expectedTotal)) || Math.abs(Number(req.body.expectedTotal) - amount) > 0.0005)) {
      return res.status(409).json({ success: false, message: 'The package price changed. Please refresh and review it.' });
    }

    if (paymentMethod === 'bank_transfer' || paymentMethod === 'partner_cash') {
      const bankReference = String(req.body.bankReference || '').trim();
      const partnerStore = String(req.body.partnerStore || '').trim();
      if (paymentMethod === 'bank_transfer' && bankReference.length < 3) {
        return res.status(400).json({ success: false, message: 'Enter the bank transfer reference.' });
      }
      if (paymentMethod === 'partner_cash' && !partnerStore) {
        return res.status(400).json({ success: false, message: 'Choose a partner store for cash payment.' });
      }

      const now = new Date();
      const endDate = new Date(now.getTime() + quantity * 7 * 86400000);
      const request = await Subscription.create({
        userId: req.user.id,
        tier,
        startDate: now,
        endDate,
        isActive: false,
        durationWeeks: quantity,
        amountPaid: amount,
        paymentMethod,
        paymentStatus: 'pending_payment',
        bankReference,
        partnerStore,
      });
      return res.status(202).json({
        success: true,
        message: paymentMethod === 'bank_transfer'
          ? 'Payment request received. We will verify your bank transfer.'
          : 'Cash payment request received. Pay at the selected partner store.',
        data: request,
      });
    }

    if (paymentMethod !== 'wallet') {
      return res.status(400).json({ success: false, message: 'Unsupported payment method.' });
    }
    const reserved = await User.findOneAndUpdate(
      { _id: req.user.id, walletBalance: { $gte: amount },
        $or: [{ subscriptionPurchaseUntil: null }, { subscriptionPurchaseUntil: { $lte: new Date() } }] },
      { $inc: { walletBalance: -amount }, $set: { subscriptionPurchaseUntil: lockUntil } },
    );
    if (!reserved) {
      return res.status(409).json({ success: false, message: 'Insufficient balance or a subscription purchase is already in progress.' });
    }
    charged = amount;
    prior = await Subscription.findOne({ userId: req.user.id, isActive: true, endDate: { $gt: new Date() } }).sort({ endDate: -1 });
    const startDate = prior?.tier === tier ? prior.endDate : new Date();
    const endDate = new Date(startDate.getTime() + quantity * 7 * 86400000);
    subscription = await Subscription.create({
      userId: req.user.id, tier, startDate, endDate, isActive: true,
      durationWeeks: quantity, amountPaid: amount,
    });
    await Transaction.create({
      userId: req.user.id, type: 'expense', amount, currency: 'TND',
      description: `${tier} subscription — ${quantity} week(s)`,
      status: 'completed', reference: `SUB-${subscription._id}`,
    });
    await Subscription.updateMany({ userId: req.user.id, isActive: true, _id: { $ne: subscription._id } }, { isActive: false });
    res.json({ success: true, message: `Subscribed to ${tier} for ${quantity} week(s)!`, data: subscription });
  } catch (error) {
    if (charged) await User.updateOne({ _id: req.user.id }, { $inc: { walletBalance: charged } });
    if (subscription) {
      await Subscription.deleteOne({ _id: subscription._id });
      await Transaction.deleteMany({ reference: `SUB-${subscription._id}` });
    }
    if (prior) await Subscription.updateOne({ _id: prior._id }, { isActive: true });
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await User.updateOne({ _id: req.user.id, subscriptionPurchaseUntil: lockUntil }, { $unset: { subscriptionPurchaseUntil: 1 } });
  }
});

// ─── POST /api/services/mobile-recharge ───────────────────
router.post('/mobile-recharge', authMiddleware, async (req, res) => {
  if (!TELECOM_RECHARGE_CONFIGURED) {
    return res.status(503).json({ success: false, message: NOT_CONFIGURED_MESSAGE });
  }
  try {
    const { operator, amount, phoneNumber } = req.body;

    if (!operator || !amount || !phoneNumber) {
      return res.status(400).json({ success: false, message: 'Operator, amount and phone number are required' });
    }
    if (amount <= 0 || amount > 500) {
      return res.status(400).json({ success: false, message: 'Recharge amount must be between 1 and 500 TND' });
    }

    const user = await User.findById(req.user.id);
    if (user.walletBalance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient wallet balance' });
    }

    user.walletBalance -= amount;
    await user.save();

    const transaction = await Transaction.create({
      userId: req.user.id,
      type: 'expense',
      amount,
      description: `Mobile recharge: ${amount} TND to ${phoneNumber} (${operator})`,
      status: 'completed',
      reference: `MOB-${Date.now()}`,
    });

    res.json({
      success: true,
      message: `Recharged ${amount} TND to ${phoneNumber} (${operator}) successfully!`,
      data: { transactionId: transaction._id, newBalance: user.walletBalance },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/services/donate ────────────────────────────
router.post('/donate', authMiddleware, async (req, res) => {
  if (!DONATIONS_CONFIGURED) {
    return res.status(503).json({ success: false, code: 'SERVICE_NOT_CONFIGURED', message: 'Donations are currently unavailable. Your wallet has not been charged.' });
  }
  try {
    const { organization, amount } = req.body;

    if (!organization || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Organization and amount are required' });
    }

    const user = await User.findById(req.user.id);
    if (user.walletBalance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient wallet balance' });
    }

    user.walletBalance -= amount;
    await user.save();

    const transaction = await Transaction.create({
      userId: req.user.id,
      type: 'expense',
      amount,
      description: `Donation to ${organization}`,
      status: 'completed',
      reference: `DON-${Date.now()}`,
    });

    res.json({
      success: true,
      message: `Donation of ${amount} TND to ${organization} sent successfully!`,
      data: { transactionId: transaction._id, newBalance: user.walletBalance },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/services/organizations ─────────────────────────────────────────
router.get('/organizations', async (req, res) => {
  res.json({
    success: true,
    data: [
      { _id: 'red-cross', name: 'Red Cross', logo: '' },
      { _id: 'unicef', name: 'UNICEF', logo: '' },
      { _id: 'who', name: 'WHO', logo: '' },
      { _id: 'save-children', name: 'Save Children', logo: '' },
      { _id: 'water-aid', name: 'Water Aid', logo: '' },
      { _id: 'wwf', name: 'WWF', logo: '' },
    ],
  });
});

// ─── POST /api/services/bill-inquiry ─────────────────────────
// Validate subscriber + account and return bill details before payment
router.post('/bill-inquiry', authMiddleware, async (req, res) => {
  if (!UTILITY_BILLS_CONFIGURED) {
    return res.status(503).json({ success: false, message: NOT_CONFIGURED_MESSAGE });
  }
  try {
    const { billServiceId, subscriberNumber, accountNumber } = req.body;
    if (!billServiceId || !subscriberNumber) {
      return res.status(400).json({ success: false, message: 'billServiceId and subscriberNumber are required' });
    }

    const service = await BillService.findById(billServiceId).catch(() => null);
    const serviceName = service?.name ?? 'Bill Service';

    // Real utility-provider lookup goes here once UTILITY_BILLS_API_KEY is set.
    const dueDate = new Date(Date.now() + 7 * 86400000).toLocaleDateString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    });
    const amountDue = parseFloat((Math.random() * 200 + 20).toFixed(2));

    res.json({
      success: true,
      data: {
        subscriberNumber,
        accountNumber: accountNumber ?? subscriberNumber,
        serviceName,
        status: 'Unpaid',
        dueDate,
        amountDue,
        currency: 'TND',
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
