const express = require('express');
const BillService = require('../models/BillService');
const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { authMiddleware, optionalAuthMiddleware } = require('../middleware/auth');

const router = express.Router();

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
    const packages = [
      {
        id: 'basic',
        tier: 'basic',
        name: 'Basic',
        price: 0,
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
        price: 15,
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
        price: 25,
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
        price: 50,
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
  try {
    const { tier } = req.body;
    const validTiers = ['silver', 'gold', 'platinum'];
    if (!validTiers.includes(tier)) {
      return res.status(400).json({ success: false, message: 'Invalid package tier' });
    }

    const prices = { silver: 15, gold: 25, platinum: 50 };
    const user = await User.findById(req.user.id);

    if (user.walletBalance < prices[tier]) {
      return res.status(400).json({ success: false, message: 'Insufficient wallet balance' });
    }

    user.walletBalance -= prices[tier];
    await user.save();

    const endDate = new Date();
    endDate.setFullYear(endDate.getFullYear() + 1);

    await Subscription.findOneAndUpdate(
      { userId: req.user.id, isActive: true },
      { isActive: false }
    );

    const subscription = await Subscription.create({
      userId: req.user.id,
      tier,
      endDate,
      isActive: true,
    });

    await Transaction.create({
      userId: req.user.id,
      type: 'expense',
      amount: prices[tier],
      description: `Subscription to ${tier} package`,
      status: 'completed',
      reference: `SUB-${Date.now()}`,
    });

    res.json({ success: true, message: `Subscribed to ${tier} package!`, data: subscription });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/services/mobile-recharge ───────────────────
router.post('/mobile-recharge', authMiddleware, async (req, res) => {
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
  try {
    const { billServiceId, subscriberNumber, accountNumber } = req.body;
    if (!billServiceId || !subscriberNumber) {
      return res.status(400).json({ success: false, message: 'billServiceId and subscriberNumber are required' });
    }

    const service = await BillService.findById(billServiceId).catch(() => null);
    const serviceName = service?.name ?? 'Bill Service';

    // Simulate a bill lookup — in production this would call the external utility API
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
