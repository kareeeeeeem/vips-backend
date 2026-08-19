const express = require('express');
const Coupon = require('../models/Coupon');
const GiftVoucher = require('../models/GiftVoucher');
const GiftVoucherBrand = require('../models/GiftVoucherBrand');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { authMiddleware } = require('../middleware/auth');
const { runAutoSeeder } = require('../utils/autoSeeder');

// ─── Seed gift voucher brands ─────────────────────────────
async function seedGiftVoucherBrands() {
  try {
    const count = await GiftVoucherBrand.countDocuments();
    if (count === 0) {
      await GiftVoucherBrand.insertMany([
        { name: 'Carrefour', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2d/Carrefour_Logo.svg/2560px-Carrefour_Logo.svg.png', minAmount: 200, maxAmount: 5000, currency: 'TND', category: 'shopping' },
        { name: '2B', logoUrl: 'https://play-lh.googleusercontent.com/gS8DlSY7k-D6mRAHU3C3A8c0Gqg-JdP1Moz1mHMUxYg0tdpJ7HHSZSWrczk6SgcQG0Y', minAmount: 500, maxAmount: 20000, currency: 'TND', category: 'electronics' },
        { name: 'FiT&F', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8f/Fit_%26_F_logo.svg/2048px-Fit_%26_F_logo.svg.png', minAmount: 200, maxAmount: 1000, currency: 'TND', category: 'fitness' },
        { name: 'Monoprix', logoUrl: 'https://upload.wikimedia.org/wikipedia/fr/thumb/d/d9/Monoprix-logo.svg/2560px-Monoprix-logo.svg.png', minAmount: 100, maxAmount: 2000, currency: 'TND', category: 'grocery' },
        { name: 'MG', logoUrl: 'https://cdn.worldvectorlogo.com/logos/mg-motor-1.svg', minAmount: 500, maxAmount: 5000, currency: 'TND', category: 'automotive' },
        { name: 'Amazon', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Amazon_logo.svg/2560px-Amazon_logo.svg.png', minAmount: 200, maxAmount: 10000, currency: 'USD', category: 'online' },
      ]);
    }
  } catch (e) {
    console.log('GiftVoucherBrand seed error:', e.message);
  }
}
seedGiftVoucherBrands();

const router = express.Router();

// ─── GET /api/rewards/coupons ─────────────────────────
router.get('/coupons', authMiddleware, async (req, res) => {
  try {
    let coupons = await Coupon.find({
      isActive: true,
      expiryDate: { $gt: new Date() },
    }).sort({ createdAt: -1 });
    if (coupons.length === 0) {
      await runAutoSeeder();
      coupons = await Coupon.find({ isActive: true, expiryDate: { $gt: new Date() } }).sort({ createdAt: -1 });
    }
    res.json({ success: true, data: coupons });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/rewards/coupons/:id ─────────────────────
router.put('/coupons/:id', authMiddleware, async (req, res) => {
  try {
    const { discount, minOrderAmount, expiryDate, isActive } = req.body;
    const updates = {};
    if (discount !== undefined) updates.discount = discount;
    if (minOrderAmount !== undefined) updates.minOrderAmount = minOrderAmount;
    if (expiryDate !== undefined) updates.expiryDate = new Date(expiryDate);
    if (isActive !== undefined) updates.isActive = isActive;

    const coupon = await Coupon.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found' });
    res.json({ success: true, message: 'Coupon updated', data: coupon });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── DELETE /api/rewards/coupons/:id ──────────────────
router.delete('/coupons/:id', authMiddleware, async (req, res) => {
  try {
    const coupon = await Coupon.findOneAndDelete({ _id: req.params.id, merchantId: req.user.id });
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found' });
    res.json({ success: true, message: 'Coupon deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/rewards/expense-to-reward ───────────────────────
// NOTE: `amount` is a self-reported expense with no receipt/gateway
// verification behind it, so this endpoint is inherently farmable by a
// user repeatedly claiming expenses that never happened. The caps below
// are a stopgap to bound the damage until expenses are tied to a
// verified purchase (e.g. a real Order/Transaction record); they are not
// a real fix and should be replaced once that verification exists.
const MAX_EXPENSE_AMOUNT = 5000;
const MAX_DAILY_EXPENSE_REWARD_POINTS = 500;

// Gift Back limits — enforced in /send-gift and reported by /limits.
// Placeholder business values pending confirmation; easy to tune later
// since everything reads from these constants.
const MIN_GIFT_AMOUNT = 1;
const MAX_GIFT_AMOUNT_PER_TX = 1000;
const MAX_DAILY_GIFT_AMOUNT = 1000;
const MAX_MONTHLY_GIFT_AMOUNT = 10000;

router.post('/expense-to-reward', authMiddleware, async (req, res) => {
  try {
    const { amount, merchantId: rawMerchantId } = req.body;

    if (!amount || amount <= 0 || amount > MAX_EXPENSE_AMOUNT) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    // The "Merchant phone / ID" field (reward_page.dart /
    // expense_to_reward_controller.dart) accepts either a scanned QR's
    // real ObjectId or a typed phone number — resolve whichever was sent
    // instead of passing it straight through, which would throw a
    // CastError (and 500 the whole request) for any typed phone number.
    let merchantId = null;
    if (rawMerchantId && /^[a-fA-F0-9]{24}$/.test(rawMerchantId)) {
      merchantId = rawMerchantId;
    } else if (rawMerchantId) {
      const merchantUser = await User.findOne({ phone: String(rawMerchantId).trim() }).select('_id');
      merchantId = merchantUser?._id || null;
    }

    // Give 10% of expense as reward points
    const pointsEarned = Math.floor(amount * 0.1);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todaysRewards = await Transaction.find({
      userId: req.user.id,
      type: 'reward',
      reference: { $regex: '^EXP-REW-' },
      createdAt: { $gte: startOfDay },
    }).select('amount');
    const totalToday = todaysRewards.reduce((sum, t) => sum + t.amount, 0);
    if (totalToday + pointsEarned > MAX_DAILY_EXPENSE_REWARD_POINTS) {
      return res.status(429).json({
        success: false,
        message: 'Daily expense-to-reward limit reached. Try again tomorrow.',
      });
    }

    const user = await User.findById(req.user.id);
    user.walletPoints += pointsEarned;
    await user.save();

    await Transaction.create({
      userId: user._id,
      merchantId: merchantId || user._id, // fallback if merchant ID not found
      type: 'reward',
      amount: pointsEarned,
      currency: 'PTS',
      description: `Reward for expense of ${amount}`,
      status: 'completed',
      reference: `EXP-REW-${Date.now()}`
    });

    res.json({
      success: true,
      message: 'Expense successfully converted to rewards!',
      data: { pointsEarned, newBalance: user.walletPoints }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/rewards/apply-coupon ───────────────────────
router.post('/apply-coupon', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    
    const coupon = await Coupon.findOne({ code, isActive: true });
    if (!coupon) {
      return res.status(404).json({ success: false, message: 'Invalid or expired coupon' });
    }
    // Personal vouchers redeemed via POST /rewards/redeem-points are
    // scoped to whoever redeemed them — not usable by anyone who just
    // learns the code.
    if (coupon.userId && String(coupon.userId) !== req.user.id) {
      return res.status(403).json({ success: false, message: 'This voucher belongs to another account' });
    }

    if (new Date() > coupon.expiryDate) {
      return res.status(400).json({ success: false, message: 'Coupon expired' });
    }

    res.json({ success: true, message: 'Coupon applied', data: coupon });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/rewards/gift-vouchers ─────────────────────────
router.get('/gift-vouchers', authMiddleware, async (req, res) => {
  try {
    let brands = await GiftVoucherBrand.find({ isActive: true }).sort({ name: 1 });
    if (brands.length === 0) {
      await runAutoSeeder();
      brands = await GiftVoucherBrand.find({ isActive: true }).sort({ name: 1 });
    }
    res.json({ success: true, data: brands });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/rewards/purchase-voucher ───────────────────
router.post('/purchase-voucher', authMiddleware, async (req, res) => {
  try {
    const { voucherId, amount } = req.body;
    if (!voucherId || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid voucher or amount' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.walletPoints < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient wallet points' });
    }

    user.walletPoints -= amount;
    await user.save();

    await Transaction.create({
      userId: user._id,
      merchantId: user._id,
      type: 'expense',
      amount,
      currency: 'PTS',
      description: `Gift voucher purchase #${voucherId}`,
      status: 'completed',
      reference: `VCH-${Date.now()}`,
    });

    res.json({
      success: true,
      message: 'Voucher purchased successfully',
      data: { newBalance: user.walletPoints },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/rewards/send-gift ──────────────────────────
router.post('/send-gift', authMiddleware, async (req, res) => {
  try {
    const { recipientPhone, amount, message } = req.body;

    if (!recipientPhone || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'recipientPhone and a valid amount are required' });
    }
    if (amount < MIN_GIFT_AMOUNT || amount > MAX_GIFT_AMOUNT_PER_TX) {
      return res.status(400).json({
        success: false,
        message: `Amount must be between ${MIN_GIFT_AMOUNT} and ${MAX_GIFT_AMOUNT_PER_TX} TND per gift.`,
      });
    }

    const sender = await User.findById(req.user.id);
    if (!sender) return res.status(404).json({ success: false, message: 'User not found' });
    if (sender.walletBalance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [todaysGifts, monthsGifts] = await Promise.all([
      Transaction.find({ userId: req.user.id, type: 'expense', reference: { $regex: '^GIFT-' }, createdAt: { $gte: startOfDay } }).select('amount'),
      Transaction.find({ userId: req.user.id, type: 'expense', reference: { $regex: '^GIFT-' }, createdAt: { $gte: startOfMonth } }).select('amount'),
    ]);
    const spentToday = todaysGifts.reduce((sum, t) => sum + t.amount, 0);
    const spentThisMonth = monthsGifts.reduce((sum, t) => sum + t.amount, 0);

    if (spentToday + amount > MAX_DAILY_GIFT_AMOUNT) {
      return res.status(429).json({ success: false, message: 'Daily gift limit reached. Try again tomorrow.' });
    }
    if (spentThisMonth + amount > MAX_MONTHLY_GIFT_AMOUNT) {
      return res.status(429).json({ success: false, message: 'Monthly gift limit reached.' });
    }

    // Deduct from sender
    sender.walletBalance -= amount;
    await sender.save();

    const code = 'GIFT-' + Math.random().toString(36).substr(2, 8).toUpperCase();

    const [gift] = await Promise.all([
      GiftVoucher.create({ senderId: req.user.id, recipientPhone, amount, message, code }),
      Transaction.create({
        userId: req.user.id,
        type: 'expense',
        amount,
        currency: 'TND',
        description: `Gift sent to ${recipientPhone} — code: ${code}`,
        status: 'completed',
        reference: code,
      }),
    ]);

    res.status(201).json({ success: true, message: 'Gift sent', data: { gift, newBalance: sender.walletBalance } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/rewards/limits ───────────────────────────────
// Real daily/monthly limits + actual usage-to-date for the Reward
// (expense-to-reward) and Gift Back (send-gift) flows, computed from this
// user's real Transaction history — not display-only placeholder numbers.
router.get('/limits', authMiddleware, async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [todaysRewards, todaysGifts, monthsGifts] = await Promise.all([
      Transaction.find({ userId: req.user.id, type: 'reward', reference: { $regex: '^EXP-REW-' }, createdAt: { $gte: startOfDay } }).select('amount'),
      Transaction.find({ userId: req.user.id, type: 'expense', reference: { $regex: '^GIFT-' }, createdAt: { $gte: startOfDay } }).select('amount'),
      Transaction.find({ userId: req.user.id, type: 'expense', reference: { $regex: '^GIFT-' }, createdAt: { $gte: startOfMonth } }).select('amount'),
    ]);

    const rewardPointsToday = todaysRewards.reduce((sum, t) => sum + t.amount, 0);
    const giftAmountToday = todaysGifts.reduce((sum, t) => sum + t.amount, 0);
    const giftAmountThisMonth = monthsGifts.reduce((sum, t) => sum + t.amount, 0);

    res.json({
      success: true,
      data: {
        reward: {
          maxExpensePerTransaction: MAX_EXPENSE_AMOUNT,
          dailyLimitPoints: MAX_DAILY_EXPENSE_REWARD_POINTS,
          usedTodayPoints: rewardPointsToday,
          remainingTodayPoints: Math.max(0, MAX_DAILY_EXPENSE_REWARD_POINTS - rewardPointsToday),
        },
        giftBack: {
          minAmount: MIN_GIFT_AMOUNT,
          maxAmountPerTransaction: MAX_GIFT_AMOUNT_PER_TX,
          dailyLimitAmount: MAX_DAILY_GIFT_AMOUNT,
          usedTodayAmount: giftAmountToday,
          remainingTodayAmount: Math.max(0, MAX_DAILY_GIFT_AMOUNT - giftAmountToday),
          monthlyLimitAmount: MAX_MONTHLY_GIFT_AMOUNT,
          usedThisMonthAmount: giftAmountThisMonth,
          remainingThisMonthAmount: Math.max(0, MAX_MONTHLY_GIFT_AMOUNT - giftAmountThisMonth),
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/rewards/spin-wheel ─────────────────────────
router.post('/spin-wheel', authMiddleware, async (req, res) => {
  try {
    // Match flutter spin wheel values
    const rewards = [
      { type: 'points', amount: 100 },
      { type: 'points', amount: 200 },
      { type: 'points', amount: 50 },
      { type: 'points', amount: 500 },
      { type: 'points', amount: 150 },
      { type: 'points', amount: 300 },
      { type: 'points', amount: 75 },
      { type: 'points', amount: 1000 },
    ];
    
    const randomReward = rewards[Math.floor(Math.random() * rewards.length)];

    if (randomReward.type === 'points') {
      const user = await User.findById(req.user.id);
      user.walletPoints = (user.walletPoints || 0) + randomReward.amount;
      await user.save();

      await Transaction.create({
        userId: user._id,
        type: 'reward',
        amount: randomReward.amount,
        currency: 'PTS',
        description: `Spin wheel reward: ${randomReward.amount} diamonds`,
        status: 'completed',
        reference: `SPIN-${Date.now()}`,
      });
    }

    const updatedUser = await User.findById(req.user.id).select('walletPoints');
    res.json({ success: true, message: 'Wheel spun', data: { ...randomReward, newBalance: updatedUser?.walletPoints || 0 } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/rewards/save-promotion ────────────────────
router.post('/save-promotion', authMiddleware, async (req, res) => {
  try {
    const { promotionId } = req.body;
    if (!promotionId) {
      return res.status(400).json({ success: false, message: 'promotionId is required' });
    }

    const Promotion = require('../models/Promotion');
    const promotion = await Promotion.findById(promotionId).catch(() => null);
    if (!promotion) {
      return res.status(404).json({ success: false, message: 'Promotion not found' });
    }

    res.json({
      success: true,
      message: 'Promotion saved successfully',
      data: { promotionId, title: promotion.title, code: promotion.code },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/rewards/validate-qr ───────────────────────
router.post('/validate-qr', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, message: 'QR code is required' });
    }

    // Check if it's a gift code
    if (code.startsWith('GIFT-')) {
      const GiftVoucher = require('../models/GiftVoucher');
      const gift = await GiftVoucher.findOne({ code, isClaimed: false });
      if (!gift) {
        return res.status(404).json({ success: false, message: 'Invalid or already used gift code' });
      }

      const user = await User.findById(req.user.id);
      user.walletBalance = (user.walletBalance || 0) + gift.amount;
      await user.save();

      gift.isClaimed = true;
      gift.claimedAt = new Date();
      await gift.save();

      await Transaction.create({
        userId: req.user.id,
        type: 'credit',
        amount: gift.amount,
        description: `Gift voucher redeemed: ${code}`,
        status: 'completed',
        reference: code,
      });

      const claimedUser = await User.findById(req.user.id).select('walletBalance');
      return res.json({
        success: true,
        message: `Gift of ${gift.amount} added to wallet!`,
        data: { type: 'gift', amount: gift.amount, newBalance: claimedUser?.walletBalance || 0 },
      });
    }

    // A VIPs ID card QR (see vips_id_view.dart: 'VIPS_USER_<mongoId>') —
    // used by Gift's "scan recipient" flow to resolve a real user to send
    // a gift to, without the sender needing to know their phone number.
    const userQrMatch = code.match(/^VIPS_USER_([a-fA-F0-9]{24})$/);
    if (userQrMatch) {
      const scannedUser = await User.findById(userQrMatch[1]).select('fullName phone storeName role');
      if (!scannedUser) {
        return res.status(404).json({ success: false, message: 'No account found for this QR code' });
      }
      return res.json({
        success: true,
        message: `User: ${scannedUser.fullName || scannedUser.phone}`,
        data: { type: 'user', user: { id: scannedUser._id, fullName: scannedUser.fullName, phone: scannedUser.phone } },
      });
    }

    // Check if it's a merchant QR (userId format)
    const merchant = await User.findOne({ _id: code, role: 'merchant' }).catch(() => null);
    if (merchant) {
      return res.json({
        success: true,
        message: `Merchant: ${merchant.storeName}`,
        data: { type: 'merchant', merchant: { id: merchant._id, name: merchant.storeName, category: merchant.storeCategory } },
      });
    }

    // Check coupon code (merchant-created, via Coupon management)
    const Coupon = require('../models/Coupon');
    const coupon = await Coupon.findOne({ code, isActive: true }).catch(() => null);
    if (coupon) {
      if (coupon.userId && String(coupon.userId) !== req.user.id) {
        return res.status(403).json({ success: false, message: 'This voucher belongs to another account' });
      }
      if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
        return res.status(400).json({ success: false, message: 'This coupon has expired' });
      }
      return res.json({
        success: true,
        message: `Coupon ${code} is valid!`,
        data: { type: 'coupon', coupon },
      });
    }

    // Check site-wide promotion code (seeded marketing promos, distinct
    // from merchant-created Coupons — same shape of check, different
    // collection, since the two aren't related).
    const Promotion = require('../models/Promotion');
    const promotion = await Promotion.findOne({ code, isActive: true }).catch(() => null);
    if (promotion) {
      if (promotion.expiresAt && new Date(promotion.expiresAt) < new Date()) {
        return res.status(400).json({ success: false, message: 'This promotion has expired' });
      }
      return res.json({
        success: true,
        message: `Promotion ${code} is valid!`,
        data: { type: 'promotion', promotion },
      });
    }

    return res.status(404).json({ success: false, message: 'Invalid QR code' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// POINTS → VOUCHER REDEMPTION
// ═══════════════════════════════════════════════════════════
//
// A fixed catalog (not a DB collection — this is a real, deliberate
// product decision, not a placeholder) of what walletPoints can be traded
// for. Redeeming issues a real, personal, single-use Coupon (see the
// userId field added to models/Coupon.js) applicable at checkout through
// the exact same /rewards/validate-qr → apply path every other coupon
// already goes through.
const VOUCHER_CATALOG = [
  { id: 'disc5',    title: '5% Discount',   type: 'percentage', discount: 5,  pointsCost: 500 },
  { id: 'disc10',   title: '10% Discount',  type: 'percentage', discount: 10, pointsCost: 1000 },
  { id: 'disc20',   title: '20% Discount',  type: 'percentage', discount: 20, pointsCost: 2000 },
  { id: 'freeship', title: 'Free Shipping', type: 'shipping',   discount: 100, pointsCost: 300 },
  { id: 'off10tnd', title: '10 TND Off',    type: 'fixed',      discount: 10, pointsCost: 400 },
];
const VOUCHER_VALIDITY_DAYS = 30;

// ─── GET /api/rewards/voucher-catalog ──────────────────────
router.get('/voucher-catalog', authMiddleware, async (req, res) => {
  res.json({ success: true, data: VOUCHER_CATALOG });
});

// ─── POST /api/rewards/redeem-points ───────────────────────
router.post('/redeem-points', authMiddleware, async (req, res) => {
  try {
    const { tierId } = req.body;
    const tier = VOUCHER_CATALOG.find((t) => t.id === tierId);
    if (!tier) return res.status(400).json({ success: false, message: 'Unknown voucher tier' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if ((user.walletPoints || 0) < tier.pointsCost) {
      return res.status(400).json({ success: false, message: 'Not enough points for this voucher' });
    }

    user.walletPoints -= tier.pointsCost;

    const code = `VIPS-${tier.id.toUpperCase()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    const expiryDate = new Date(Date.now() + VOUCHER_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

    const [voucher] = await Promise.all([
      Coupon.create({
        code,
        discount: tier.discount,
        type: tier.type,
        expiryDate,
        userId: user._id,
        pointsCost: tier.pointsCost,
        maxUsage: 1,
        description: tier.title,
      }),
      user.save(),
      Transaction.create({
        userId: user._id,
        type: 'expense',
        amount: tier.pointsCost,
        currency: 'PTS',
        description: `Redeemed ${tier.title} voucher`,
        status: 'completed',
        reference: `REDEEM-${Date.now()}`,
      }),
    ]);

    res.status(201).json({
      success: true,
      message: 'Voucher redeemed!',
      data: { voucher, newPointsBalance: user.walletPoints },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/rewards/my-vouchers ──────────────────────────
// Personal vouchers this user has redeemed — separate from GET /coupons
// (general/merchant coupons anyone can apply).
router.get('/my-vouchers', authMiddleware, async (req, res) => {
  try {
    const vouchers = await Coupon.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json({ success: true, data: vouchers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
