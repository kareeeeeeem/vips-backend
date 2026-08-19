const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Order = require('../models/Order');
const Employee = require('../models/Employee');
const Contact = require('../models/Contact');
const UserNotification = require('../models/UserNotification');
const { seedDemoTransactionsForUser } = require('../utils/autoSeeder');

const router = express.Router();

// All user routes require authentication
router.use(authMiddleware);

// ─── GET /api/user/wallet ─────────────────────────────────
router.get('/wallet', async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      'walletBalance walletPoints'
    );

    const recentTransactions = await Transaction.find({
      userId: req.user.id,
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('merchantId', 'storeName fullName');

    res.json({
      success: true,
      data: {
        balance: user.walletBalance,
        points: user.walletPoints,
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

    if (transactions.length === 0 && !type) {
      await seedDemoTransactionsForUser(req.user.id);
      transactions = await Transaction.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .populate('merchantId', 'storeName fullName');
    }

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
      walletPoints: { $gt: user.walletPoints },
    });

    res.json({
      success: true,
      data: {
        walletPoints: user.walletPoints,
        points: user.walletPoints,
        convertibleDiamonds: user.walletPoints,
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

    const dayRewards = [100, 100, 100, 100, 250, 250, 1000];
    const streak = (user.checkInStreak || 0) % 7;
    const rewardPoints = dayRewards[streak];

    user.walletPoints = (user.walletPoints || 0) + rewardPoints;
    user.checkInStreak = streak + 1 >= 7 ? 0 : streak + 1;
    user.lastCheckIn = new Date();
    await user.save();

    await Transaction.create({
      userId: user._id,
      type: 'reward',
      amount: rewardPoints,
      currency: 'PTS',
      description: `Daily check-in reward (Day ${streak + 1})`,
      status: 'completed',
      reference: `CHECKIN-${Date.now()}`,
    });

    res.json({
      success: true,
      message: `Check-in successful! You earned ${rewardPoints} points`,
      data: { pointsEarned: rewardPoints, newBalance: user.walletPoints, newPoints: user.walletPoints, streak: user.checkInStreak },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/user/vips-club/convert ─────────────────────
router.post('/vips-club/convert', async (req, res) => {
  try {
    const { points } = req.body;
    if (!points || points < 100) {
      return res.status(400).json({ success: false, message: 'Minimum 100 points required' });
    }

    const user = await User.findById(req.user.id);
    if (user.walletPoints < points) {
      return res.status(400).json({ success: false, message: 'Insufficient points' });
    }

    const walletAmount = points * 0.01;
    user.walletPoints -= points;
    user.walletBalance = (user.walletBalance || 0) + walletAmount;
    await user.save();

    await Transaction.create({
      userId: user._id,
      type: 'credit',
      amount: walletAmount,
      description: `Converted ${points} diamonds to wallet`,
      status: 'completed',
      reference: `CONVERT-${Date.now()}`,
    });

    res.json({
      success: true,
      message: `Converted ${points} points to ${walletAmount} wallet balance`,
      data: { walletAmount, newBalance: user.walletBalance, newPoints: user.walletPoints },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── DELETE /api/user/account ─────────────────────────────
router.delete('/account', async (req, res) => {
  try {
    const userId = req.user.id;

    await Promise.all([
      User.findByIdAndDelete(userId),
      Transaction.deleteMany({ userId }),
      Order.deleteMany({ userId }),
      UserNotification.deleteMany({ userId }),
      Contact.deleteMany({ userId }),
      Employee.deleteMany({ merchantId: userId }),
    ]);

    res.json({
      success: true,
      message: 'Account deleted successfully',
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/user/teams ──────────────────────────────────
router.get('/teams', async (req, res) => {
  try {
    const employees = await Employee.find({ merchantId: req.user.id }).sort({ createdAt: -1 });
    res.json({ success: true, data: employees });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/user/teams ─────────────────────────────────
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

    const reports = transactions.map(t => ({
      id: t._id,
      title: t.description || `${t.type} transaction`,
      type: t.type,
      date: t.createdAt,
      amount: t.amount,
      status: t.status,
      description: t.description || '',
      reference: t.reference,
    }));

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

// ─── POST /api/user/wallet/topup ─────────────────────────────
// NOTE: there is no live payment gateway behind this yet (see
// GET /payment-methods, which returns an empty card list as a placeholder),
// so this endpoint currently mints wallet balance from a client-supplied
// number with nothing actually charged. The cap below is a stopgap to
// bound the exposure until a real payment gateway is wired in — it is
// not a substitute for verifying an actual charge.
const MAX_TOPUP_AMOUNT = 50000;

router.post('/wallet/topup', async (req, res) => {
  try {
    const { vipsAmount, cardId } = req.body;
    if (!vipsAmount || vipsAmount < 100 || vipsAmount > MAX_TOPUP_AMOUNT) {
      return res.status(400).json({ success: false, message: 'Invalid top-up amount' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.walletPoints = (user.walletPoints || 0) + parseInt(vipsAmount);
    user.walletBalance = (user.walletBalance || 0) + (parseInt(vipsAmount) * 0.1);
    await user.save();

    await Transaction.create({
      userId: user._id,
      type: 'credit',
      amount: vipsAmount,
      currency: 'PTS',
      description: `VIPS credit purchase via card ****${cardId || '0000'}`,
      status: 'completed',
      reference: `TOP-${Date.now()}`,
    });

    res.json({
      success: true,
      message: `${vipsAmount} VIPS added to your wallet!`,
      data: { newBalance: user.walletPoints },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/user/payment-methods ───────────────────────────
router.get('/payment-methods', async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('paymentMethods');
    res.json({ success: true, data: { cards: user?.paymentMethods || [] } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
