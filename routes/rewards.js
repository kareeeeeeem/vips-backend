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

    const coupon = await Coupon.findByIdAndUpdate(
      req.params.id,
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
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found' });
    res.json({ success: true, message: 'Coupon deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/rewards/expense-to-reward ───────────────────────
router.post('/expense-to-reward', authMiddleware, async (req, res) => {
  try {
    const { amount, merchantId } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    // Give 10% of expense as reward points
    const pointsEarned = Math.floor(amount * 0.1);

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

    const sender = await User.findById(req.user.id);
    if (!sender) return res.status(404).json({ success: false, message: 'User not found' });
    if (sender.walletBalance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
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

    // Check if it's a merchant QR (userId format)
    const merchant = await User.findOne({ _id: code, role: 'merchant' }).catch(() => null);
    if (merchant) {
      return res.json({
        success: true,
        message: `Merchant: ${merchant.storeName}`,
        data: { type: 'merchant', merchant: { id: merchant._id, name: merchant.storeName, category: merchant.storeCategory } },
      });
    }

    // Check coupon code
    const Coupon = require('../models/Coupon');
    const coupon = await Coupon.findOne({ code, isActive: true }).catch(() => null);
    if (coupon) {
      if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
        return res.status(400).json({ success: false, message: 'This coupon has expired' });
      }
      return res.json({
        success: true,
        message: `Coupon ${code} is valid!`,
        data: { type: 'coupon', coupon },
      });
    }

    return res.status(404).json({ success: false, message: 'Invalid QR code' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
