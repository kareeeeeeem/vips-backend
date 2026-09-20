const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { requirePin } = require('../middleware/pin');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Order = require('../models/Order');
const Employee = require('../models/Employee');
const Contact = require('../models/Contact');
const UserNotification = require('../models/UserNotification');

const router = express.Router();

// All user routes require authentication
const giftback = require('../utils/giftback');
const {
  pointsToTnd, DIAMONDS_PER_TND, DIAMONDS_PER_POINT, diamondsToTnd, diamondsToPoints,
} = require('../config/economics');

router.use(authMiddleware);

// ─── GET /api/user/wallet ─────────────────────────────────
router.get('/wallet', async (req, res) => {
  try {
    // Giftback points become spendable twelve hours after they are granted
    // (§4.2). Settling anything due here, on the way in, means the balance
    // this endpoint reports is never behind what the customer is owed —
    // a scheduled job would leave a window where it was.
    await giftback.activateDue(req.user.id);

    const user = await User.findById(req.user.id).select(
      'walletBalance walletPoints'
    );

    const recentTransactions = await Transaction.find({
      userId: req.user.id,
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('merchantId', 'storeName fullName');

    const pending = await giftback.summaryFor(req.user.id);

    res.json({
      success: true,
      data: {
        balance: user.walletBalance,
        points: user.walletPoints,
        pointsValueTnd: pointsToTnd(user.walletPoints || 0),
        // Points already earned but not yet spendable, shown separately so
        // the wallet total is never a number the customer cannot use.
        pendingGiftbackPoints: pending.pendingPoints,
        recentTransactions,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ─── GET /api/user/notifications ─────────────────────────
router.get('/notifications', async (req, res) => {
  try {
    const userId = req.user.id;

    // Fetch persistent notifications
    let notifications = await UserNotification.find({ userId })
      .sort({ createdAt: -1 })
      .limit(50);

    // Bootstrap from orders/transactions if no stored notifications yet
    if (notifications.length === 0) {
      const [recentOrders, recentTx] = await Promise.all([
        Order.find({ userId }).sort({ createdAt: -1 }).limit(3),
        Transaction.find({ userId }).sort({ createdAt: -1 }).limit(3),
      ]);

      const toInsert = [];
      recentOrders.forEach((order) => {
        toInsert.push({
          userId,
          title: `Order #${order._id.toString().slice(-6)} ${order.status}`,
          message: `Your order for ${order.totalAmount?.toFixed(3) ?? '0.000'} is now ${order.status}.`,
          type: order.status === 'delivered' ? 'order' : 'payment',
          isRead: order.status === 'delivered',
          data: { orderId: order._id },
        });
      });
      recentTx.forEach((tx) => {
        toInsert.push({
          userId,
          title: tx.type === 'credit' ? 'Wallet Credited' : 'Wallet Debited',
          message: tx.description || `Wallet ${tx.type} of ${tx.amount}`,
          type: 'payment',
          isRead: tx.status === 'completed',
          data: { transactionId: tx._id },
        });
      });

      if (toInsert.length === 0) {
        toInsert.push({
          userId,
          title: 'Welcome to VIPs!',
          message: 'Your account is ready. Explore new offers and start ordering today.',
          type: 'system',
          isRead: false,
        });
      }

      notifications = await UserNotification.insertMany(toInsert);
    }

    const formatted = notifications.map((n) => ({
      _id: n._id,
      title: n.title,
      message: n.message,
      time: n.createdAt.toLocaleString(),
      type: n.type,
      isRead: n.isRead,
      data: n.data,
      actionUrl: n.actionUrl,
    }));

    const unreadCount = notifications.filter((n) => !n.isRead).length;
    const { unread } = req.query;
    const list = unread === 'true' ? formatted.filter((n) => !n.isRead) : formatted;

    res.json({ success: true, data: list, unreadCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/user/transactions ───────────────────────────
router.get('/transactions', async (req, res) => {
  try {
    const { type, page = 1, limit = 20 } = req.query;

    const filter = { userId: req.user.id };
    if (type) filter.type = type;

    let transactions = await Transaction.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('merchantId', 'storeName fullName');

    const total = await Transaction.countDocuments(filter);

    res.json({
      success: true,
      data: {
        transactions,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ─── POST /api/user/transfer ──────────────────────────────
router.post('/transfer', async (req, res) => {
  try {
    const { recipientPhone, amount, description } = req.body;

    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be a positive number.',
      });
    }

    // Find recipient
    const recipient = await User.findOne({ phone: recipientPhone });
    if (!recipient) {
      return res.status(404).json({
        success: false,
        message: 'Recipient not found.',
      });
    }

    if (recipient._id.equals(req.user.id)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot transfer to yourself.',
      });
    }

    // Check balance
    const sender = await User.findById(req.user.id);
    if (sender.walletBalance < amount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance.',
      });
    }

    // Deduct from sender
    sender.walletBalance -= amount;
    await sender.save();

    // Add to recipient
    recipient.walletBalance += amount;
    await recipient.save();

    // Create transactions for both
    const reference = `TRF-${Date.now()}`;

    await Transaction.create({
      userId: sender._id,
      type: 'debit',
      amount,
      description: description || `Transfer to ${recipient.fullName}`,
      status: 'completed',
      reference,
    });

    await Transaction.create({
      userId: recipient._id,
      type: 'credit',
      amount,
      description: `Transfer from ${sender.fullName}`,
      status: 'completed',
      reference,
    });

    res.json({
      success: true,
      message: 'Transfer successful!',
      data: {
        newBalance: sender.walletBalance,
        reference,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ─── POST /api/user/notifications/read-all ────────────────
router.post('/notifications/read-all', async (req, res) => {
  try {
    await UserNotification.updateMany({ userId: req.user.id, isRead: false }, { isRead: true });
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/user/notifications/:id/read-status ──────────
// Mark a single notification read or unread — previously only a
// mark-everything-read endpoint existed, so individual mark-as-read/unread
// in the app only updated local state and reverted on next load.
router.put('/notifications/:id/read-status', async (req, res) => {
  try {
    const { isRead } = req.body;
    const notification = await UserNotification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { isRead: isRead !== false },
      { new: true }
    );
    if (!notification) return res.status(404).json({ success: false, message: 'Notification not found' });
    res.json({ success: true, data: notification });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── DELETE /api/user/notifications/:id ────────────────────
router.delete('/notifications/:id', async (req, res) => {
  try {
    const result = await UserNotification.deleteOne({ _id: req.params.id, userId: req.user.id });
    if (result.deletedCount === 0) return res.status(404).json({ success: false, message: 'Notification not found' });
    res.json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/user/vips-club ──────────────────────────────
router.get('/vips-club', async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      'walletPoints walletBalance fullName lastCheckIn checkInStreak ' +
      'pendingDiamonds suspendedDiamonds superBonus todayCoins lastCoinResetDate'
    );

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const lastCheckIn = user.lastCheckIn ? new Date(user.lastCheckIn) : null;
    const checkedInToday = lastCheckIn && lastCheckIn >= today;

    // Reset todayCoins daily
    const lastReset = user.lastCoinResetDate ? new Date(user.lastCoinResetDate) : null;
    if (!lastReset || lastReset < today) {
      user.todayCoins = 0;
      user.lastCoinResetDate = today;
      await user.save({ validateBeforeSave: false });
    }

    const streak = user.checkInStreak || 0;
    const checkInDays = [
      { day: 'Day 1', reward: 100 },
      { day: 'Day 2', reward: 100 },
      { day: 'Day 3', reward: 100 },
      { day: 'Day 4', reward: 100 },
      { day: 'Day 5', reward: 250 },
      { day: 'Day 6', reward: 250 },
      { day: 'Day 7', reward: 1000 },
    ].map((d, i) => ({
      ...d,
      checked: i < streak,
      isToday: i === streak,
    }));

    // Compute rank by walletPoints
    const rank = await User.countDocuments({
      role: 'customer',
      isActive: true,
      walletPoints: { $gt: user.walletPoints },
    });

    res.json({
      success: true,
      data: {
        walletPoints: user.walletPoints,
        points: user.walletPoints,
        // Diamonds, not points. This reported walletPoints, so a balance of
        // 1,000 points was shown as 1,000 diamonds — a hundred times its
        // real value in the club.
        diamonds: user.diamonds || 0,
        convertibleDiamonds: user.diamonds || 0,
        diamondsPerTnd: DIAMONDS_PER_TND,
        diamondsValueTnd: diamondsToTnd(user.diamonds || 0),
        diamondsPerPoint: DIAMONDS_PER_POINT,
        pendingDiamonds: user.pendingDiamonds || 0,
        suspendedDiamonds: user.suspendedDiamonds || 0,
        superBonus: user.superBonus || 0,
        todayCoins: user.todayCoins || 0,
        balance: user.walletBalance,
        checkInStreak: streak,
        checkedInToday,
        checkInDays,
        rank: rank + 1,
        currentRank: rank + 1,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/user/vips-club/checkin ─────────────────────
router.post('/vips-club/checkin', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const lastCheckIn = user.lastCheckIn ? new Date(user.lastCheckIn) : null;
    if (lastCheckIn && lastCheckIn >= today) {
      return res.status(400).json({ success: false, message: 'Already checked in today' });
    }

    // Diamonds, not points. These same numbers were being credited as
    // loyalty points, so a daily check-in minted a whole dinar of spendable
    // value — and the seventh day ten — against no merchant guarantee at
    // all. As diamonds they are worth a hundredth of that, which is what a
    // daily streak reward should be.
    const dayRewards = [100, 100, 100, 100, 250, 250, 1000];
    const streak = (user.checkInStreak || 0) % 7;
    const rewardDiamonds = dayRewards[streak];

    user.diamonds = (user.diamonds || 0) + rewardDiamonds;
    user.checkInStreak = streak + 1 >= 7 ? 0 : streak + 1;
    user.lastCheckIn = new Date();
    await user.save();

    await Transaction.create({
      userId: user._id,
      type: 'reward',
      amount: rewardDiamonds,
      currency: 'DMD',
      description: `Daily check-in reward (Day ${streak + 1})`,
      status: 'completed',
      reference: `CHECKIN-${Date.now()}`,
    });

    res.json({
      success: true,
      message: `Checked in! ${rewardDiamonds} diamonds added.`,
      data: {
        diamondsEarned: rewardDiamonds,
        pointsEarned: 0,
        newDiamonds: user.diamonds,
        newBalance: user.walletPoints,
        newPoints: user.walletPoints,
        streak: user.checkInStreak,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/user/vips-club/convert ─────────────────────
/**
 * Turns club diamonds into loyalty points.
 *
 * Diamonds are worth a hundredth of a point, so the conversion floors: a
 * customer converting 150 diamonds gets 1 point and keeps the remaining 50
 * rather than losing them to rounding.
 */
router.post('/vips-club/convert', async (req, res) => {
  try {
    const requested = Math.floor(Number(req.body.diamonds ?? req.body.points));
    if (!Number.isFinite(requested) || requested < DIAMONDS_PER_POINT) {
      return res.status(400).json({
        success: false,
        message: `You need at least ${DIAMONDS_PER_POINT} diamonds to convert — that is one point.`,
      });
    }

    const user = await User.findById(req.user.id);
    if ((user.diamonds || 0) < requested) {
      return res.status(400).json({
        success: false,
        message: `You have ${user.diamonds || 0} diamonds.`,
      });
    }

    const points = diamondsToPoints(requested);
    // Only take what actually became points; the remainder stays theirs.
    const spent = points * DIAMONDS_PER_POINT;

    user.diamonds = (user.diamonds || 0) - spent;
    user.walletPoints = (user.walletPoints || 0) + points;
    await user.save();

    await Transaction.create({
      userId: user._id,
      type: 'credit',
      amount: points,
      currency: 'PTS',
      description: `Converted ${spent} diamonds to ${points} points`,
      status: 'completed',
      reference: `CONVERT-${Date.now()}`,
    });

    res.json({
      success: true,
      message: `${spent} diamonds became ${points} points.`,
      data: {
        diamondsSpent: spent,
        pointsGained: points,
        diamondsLeft: user.diamonds,
        newPoints: user.walletPoints,
        valueTnd: pointsToTnd(points),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/teams', async (req, res) => {
  try {
    const { name, role, email, status } = req.body;
    const employee = await Employee.create({
      merchantId: req.user.id,
      name,
      role,
      email,
      status: status || 'pending'
    });
    res.status(201).json({ success: true, data: employee });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/user/teams/:id/status ───────────────────────
router.put('/teams/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const employee = await Employee.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      { status },
      { new: true }
    );
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({ success: true, data: employee });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── DELETE /api/user/teams/:id ───────────────────────────
router.delete('/teams/:id', async (req, res) => {
  try {
    const employee = await Employee.findOneAndDelete({ _id: req.params.id, merchantId: req.user.id });
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({ success: true, message: 'Employee removed' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/user/reports ────────────────────────────────
router.get('/reports', async (req, res) => {
  try {
    const { startDate, endDate, type } = req.query;
    const userId = req.user.id;

    const filter = { userId };
    if (type && type !== 'all') filter.type = type;
    if (startDate && endDate) {
      filter.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    const transactions = await Transaction.find(filter)
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('merchantId', 'storeName fullName');

    // The app's Report screen has dedicated Coupon/Package tabs, but
    // Transaction.type (models/Transaction.js) has no 'coupon'/'package'
    // values — those tabs were always empty. Both are real, identifiable
    // by the reference prefix each flow already stamps on its Transaction
    // (SUB- for package subscriptions in routes/services.js; VCH-/REDEEM-/
    // ORDER-PTS- for gift-voucher purchases, points-redeemed vouchers, and
    // points spent as an order discount, in routes/rewards.js and
    // routes/order.js), so derive the report-facing type from that instead
    // of the raw ledger type.
    const reports = transactions.map(t => {
      let reportType = t.type;
      if (t.reference?.startsWith('SUB-')) {
        reportType = 'package';
      } else if (/^(VCH-|REDEEM-|ORDER-PTS-)/.test(t.reference || '')) {
        reportType = 'coupon';
      }
      return {
        id: t._id,
        title: t.description || `${t.type} transaction`,
        type: reportType,
        date: t.createdAt,
        amount: t.amount,
        status: t.status,
        description: t.description || '',
        reference: t.reference,
      };
    });

    res.json({ success: true, data: reports });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/user/contacts ───────────────────────────────
router.get('/contacts', async (req, res) => {
  try {
    const contacts = await Contact.find({ userId: req.user.id }).sort({ name: 1 });
    res.json({ success: true, data: contacts });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/user/contacts ──────────────────────────────
router.post('/contacts', async (req, res) => {
  try {
    const { name, phone, email, avatar } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, message: 'Name and phone are required' });
    }
    const contact = await Contact.create({ userId: req.user.id, name, phone, email, avatar });
    res.status(201).json({ success: true, data: contact });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'Contact with this phone already exists' });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── DELETE /api/user/contacts/:id ────────────────────────
router.delete('/contacts/:id', async (req, res) => {
  try {
    const contact = await Contact.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });
    res.json({ success: true, message: 'Contact removed' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PATCH /api/user/contacts/:id/favorite ────────────────
router.patch('/contacts/:id/favorite', async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, userId: req.user.id });
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });
    contact.isFavorite = !contact.isFavorite;
    await contact.save();
    res.json({ success: true, data: contact });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/user/leaderboard ────────────────────────────
router.get('/leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const topUsers = await User.find({ role: 'customer', isActive: true })
      .select('fullName walletPoints profileImage')
      .sort({ walletPoints: -1 })
      .limit(limit);

    const currentUser = await User.findById(req.user.id).select('walletPoints');

    const rankOfCurrentUser = await User.countDocuments({
      role: 'customer',
      isActive: true,
      walletPoints: { $gt: currentUser.walletPoints },
    });

    const ranked = topUsers.map((u, i) => ({
      rank: i + 1,
      userId: u._id,
      username: u.fullName,
      score: u.walletPoints,
      avatar: u.profileImage || null,
      isCurrentUser: u._id.toString() === req.user.id,
    }));

    res.json({
      success: true,
      data: {
        leaderboard: ranked,
        currentUserRank: rankOfCurrentUser + 1,
        currentUserScore: currentUser.walletPoints,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/user/referral ───────────────────────────────
router.get('/referral', async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      'referralCode referredUsers walletPoints'
    );

    if (!user.referralCode) {
      user.referralCode =
        'VIP' + user._id.toString().slice(-6).toUpperCase();
      await user.save({ validateBeforeSave: false });
    }

    const referredUsers = await User.find({
      referredBy: req.user.id,
    }).select('fullName createdAt isVerified');

    const totalInvited = referredUsers.length;
    const totalJoined = referredUsers.filter((u) => u.isVerified).length;
    const totalEarned = totalJoined * 25000;

    const friends = referredUsers.map((u) => ({
      name: u.fullName,
      joined: u.isVerified,
      date: u.createdAt.toISOString().split('T')[0],
    }));

    res.json({
      success: true,
      data: {
        referralCode: user.referralCode,
        totalInvited,
        totalJoined,
        totalEarned,
        friends,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/user/referral/use ─────────────────────────
router.post('/referral/use', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Code required' });

    const referrer = await User.findOne({ referralCode: code.toUpperCase() });
    if (!referrer) {
      return res.status(404).json({ success: false, message: 'Invalid referral code' });
    }

    const currentUser = await User.findById(req.user.id);
    if (currentUser.referredBy) {
      return res.status(400).json({ success: false, message: 'You already used a referral code' });
    }
    if (referrer._id.toString() === req.user.id) {
      return res.status(400).json({ success: false, message: 'Cannot use your own referral code' });
    }

    currentUser.referredBy = referrer._id;
    currentUser.walletPoints = (currentUser.walletPoints || 0) + 10000;
    await currentUser.save({ validateBeforeSave: false });

    referrer.walletPoints = (referrer.walletPoints || 0) + 25000;
    await referrer.save({ validateBeforeSave: false });

    // Create transaction records for both users
    const ref = `REF-${Date.now()}`;
    await Promise.all([
      Transaction.create({
        userId: currentUser._id,
        type: 'reward',
        amount: 10000,
        currency: 'PTS',
        description: `Referral bonus — joined via code ${code.toUpperCase()}`,
        status: 'completed',
        reference: ref,
      }),
      Transaction.create({
        userId: referrer._id,
        type: 'reward',
        amount: 25000,
        currency: 'PTS',
        description: `Referral reward — friend joined with your code`,
        status: 'completed',
        reference: `${ref}-R`,
      }),
    ]);

    res.json({
      success: true,
      message: 'Referral code applied! You earned 10,000 diamonds.',
      data: { pointsEarned: 10000, newBalance: currentUser.walletPoints },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/user/payment-methods ───────────────────────────
// NOTE: real wallet top-ups happen only through the gateway-verified flow in
// routes/payment.js (/paymee/topup-initiate, /paypal/topup-create + webhook
// crediting) — there used to be a POST /wallet/topup here that minted wallet
// balance directly from a client-supplied number with no charge behind it at
// all; it was dead from the app's side (credit_controller.dart already only
// calls the real gateway flow) but remained a live free-money exploit for
// anyone hitting the API directly. Removed.
router.get('/payment-methods', async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('paymentMethods');
    res.json({ success: true, data: { cards: user?.paymentMethods || [] } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/user/giftback ───────────────────────────────
/**
 * §6.1's "قسم خاص بنقاط Giftback": what was granted, what is still pending
 * its twelve hours, and how much of this month's 50 TND allowance is left.
 */
router.get('/giftback', async (req, res) => {
  try {
    res.json({ success: true, data: await giftback.summaryFor(req.user.id) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/user/vips-id ────────────────────────────────
/**
 * The card a customer shows at the till: their short id and the QR that
 * carries it. The id is assigned the first time this is asked for.
 */
router.get('/vips-id', async (req, res) => {
  try {
    const { ensureVipsId } = require('../utils/vipsId');
    const user = await User.findById(req.user.id).select('fullName role vipsId profileImage');
    if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });

    const vipsId = await ensureVipsId(user);
    res.json({
      success: true,
      data: {
        vipsId,
        // Both forms resolve, so a scan works even against an older build
        // that still reads the long one.
        qr: `VIPS_ID_${vipsId}`,
        fullName: user.fullName,
        role: user.role,
        digits: vipsId.length,
      },
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

/**
 * DELETE /api/user/account — the customer closes their own account.
 *
 * The Settings screen has offered this since it was written and called this
 * exact path; nothing served it, so the button showed a spinner and then an
 * error. It is also not optional: both stores require an app that creates
 * accounts to let a person delete one from inside it.
 *
 * Only ever acts on the caller's own account — the id comes from the token,
 * never from the request — so this cannot be pointed at anybody else.
 */
router.delete('/account', requirePin, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });

    // An operator deleting themselves here would leave the console with one
    // fewer administrator and no record of who did it. Staff are removed from
    // the console, where that is checked.
    if (user.role === 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Administrator accounts are closed from the admin console.',
      });
    }

    // A merchant still owes their customers whatever they have sold. Live
    // orders would be stranded, and a guarantee balance is the merchant's own
    // money held by the platform (§5.1) — deleting the account would strand
    // it with no one to refund it to.
    if (user.role === 'merchant') {
      const liveStatuses = ['pending', 'confirmed', 'processing', 'ready', 'handover'];
      const live = await Order.countDocuments({ merchantId: user._id, status: { $in: liveStatuses } });
      if (live > 0) {
        return res.status(409).json({
          success: false,
          message: `You have ${live} order(s) still in progress. Complete or cancel them first.`,
        });
      }

      const g = user.guarantee || {};
      const b = g.budgets || {};
      const held = (g.unallocatedPoints || 0) + (b.discount || 0) + (b.packages || 0) + (b.general || 0);
      if (held > 0) {
        return res.status(409).json({
          success: false,
          message: 'Your guarantee still holds a balance. Request a refund before closing the account.',
        });
      }
    }

    // Kept, deliberately: orders and transactions are financial records, and
    // deleting them would rewrite past revenue and break the merchant's own
    // books. The same rule the admin-side deletion follows.
    const [orders, transactions] = await Promise.all([
      Order.countDocuments({ userId: user._id }),
      Transaction.countDocuments({ userId: user._id }),
    ]);

    await user.deleteOne();

    res.json({
      success: true,
      message: 'Your account has been deleted.',
      data: { ordersRetained: orders, transactionsRetained: transactions },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
