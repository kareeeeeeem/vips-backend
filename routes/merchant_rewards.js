/**
 * Targeted offers to customer segments (§6.2).
 *
 * The point of the platform for a merchant is knowing which customers to
 * talk to and why. The segments here are the ones a shop actually acts on:
 * someone with a birthday, someone who came once, someone who used to come
 * and stopped, and the people who spend the most.
 */
const express = require('express');
const mongoose = require('mongoose');
const { authMiddleware } = require('../middleware/auth');

const User = require('../models/User');
const Order = require('../models/Order');
const Coupon = require('../models/Coupon');
const RewardAction = require('../models/RewardAction');
const { pointsToTnd } = require('../config/economics');

const router = express.Router();
router.use(authMiddleware);

const DAY = 24 * 60 * 60 * 1000;

const SEGMENTS = {
  birthday: {
    label: 'Birthday this month',
    blurb: 'Customers whose birthday falls this month.',
  },
  one_time: {
    label: 'Came once',
    blurb: 'Bought from you exactly once and have not been back.',
  },
  be_back: {
    label: 'Gone quiet',
    blurb: 'Used to come regularly and have not been seen for 30 days.',
  },
  top_spend: {
    label: 'Top spenders',
    blurb: 'The customers who have spent the most with you.',
  },
};

/**
 * Resolves a segment to real customers of this merchant.
 *
 * Built from orders rather than a stored customer list: a shop's customers
 * are the people who bought from it, and a list maintained separately drifts
 * from that the first time an order is refunded or an account is deleted.
 */
async function resolveSegment(merchantId, segment) {
  const moid = new mongoose.Types.ObjectId(String(merchantId));
  const now = new Date();

  const perCustomer = await Order.aggregate([
    { $match: { merchantId: moid, userId: { $ne: null } } },
    {
      $group: {
        _id: '$userId',
        orders: { $sum: 1 },
        spend: { $sum: '$totalAmount' },
        lastOrderAt: { $max: '$createdAt' },
      },
    },
  ]);
  if (!perCustomer.length) return [];

  const ids = perCustomer.map((r) => r._id);
  const users = await User.find({ _id: { $in: ids }, role: 'customer' })
    .select('fullName phone dateOfBirth walletPoints')
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  const rows = perCustomer
    .map((r) => {
      const user = byId.get(String(r._id));
      if (!user) return null; // account gone; not a customer to write to
      return {
        userId: String(r._id),
        name: user.fullName,
        phone: user.phone,
        orders: r.orders,
        spend: Math.round((r.spend || 0) * 1000) / 1000,
        lastOrderAt: r.lastOrderAt,
        daysSince: Math.floor((now - new Date(r.lastOrderAt)) / DAY),
        birthMonth: user.dateOfBirth ? new Date(user.dateOfBirth).getMonth() : null,
      };
    })
    .filter(Boolean);

  switch (segment) {
    case 'birthday':
      return rows.filter((r) => r.birthMonth === now.getMonth());
    case 'one_time':
      // One order, and long enough ago that they have had the chance to
      // return — someone who bought yesterday has not failed to come back.
      return rows.filter((r) => r.orders === 1 && r.daysSince >= 30);
    case 'be_back':
      return rows.filter((r) => r.orders >= 2 && r.daysSince >= 30);
    case 'top_spend':
      return [...rows].sort((a, b) => b.spend - a.spend).slice(0, 25);
    default:
      return [];
  }
}

// ─── GET /api/merchant/rewards/segments ───────────────────
// Every segment with its live size, so the merchant picks by how many
// people are actually in it rather than by name alone.
router.get('/segments', async (req, res) => {
  try {
    const entries = await Promise.all(
      Object.keys(SEGMENTS).map(async (key) => {
        const members = await resolveSegment(req.user.id, key);
        return {
          key,
          ...SEGMENTS[key],
          customers: members.length,
          // What this group is worth, so an empty segment is visibly not
          // worth writing to and a valuable one is visibly worth it.
          spend: Math.round(members.reduce((s, m) => s + m.spend, 0) * 1000) / 1000,
        };
      })
    );
    res.json({ success: true, data: { segments: entries } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── GET /api/merchant/rewards/segments/:key ──────────────
router.get('/segments/:key', async (req, res) => {
  try {
    if (!SEGMENTS[req.params.key]) {
      return res.status(404).json({ success: false, message: 'No such segment.' });
    }
    const members = await resolveSegment(req.user.id, req.params.key);
    res.json({
      success: true,
      data: {
        key: req.params.key,
        ...SEGMENTS[req.params.key],
        customers: members.length,
        items: members.slice(0, 100),
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/** A first draft of the message, which the merchant edits before sending. */
function draftMessage(segment, discountType, value, days) {
  const off = discountType === 'tnd' ? `${value} د.ت` : `${value}%`;
  switch (segment) {
    case 'birthday':
      return `كل عام وأنت بخير! هديتنا لك خصم ${off} على زيارتك القادمة خلال ${days} أيام.`;
    case 'one_time':
      return `اشتقنا لك! استخدم خصم ${off} على زيارتك القادمة خلال ${days} أيام.`;
    case 'be_back':
      return `مر وقت طويل — عد إلينا واحصل على خصم ${off} خلال ${days} أيام.`;
    case 'top_spend':
      return `شكراً لثقتك بنا. خصم ${off} خاص لك خلال ${days} أيام.`;
    default:
      return `خصم ${off} خلال ${days} أيام.`;
  }
}

// ─── GET /api/merchant/rewards/actions ────────────────────
router.get('/actions', async (req, res) => {
  try {
    const filter = { merchantId: req.user.id };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.segment) filter.segment = req.query.segment;

    const actions = await RewardAction.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    res.json({
      success: true,
      data: {
        items: actions.map((a) => ({
          ...a,
          id: String(a._id),
          segmentLabel: SEGMENTS[a.segment]?.label || a.segment,
        })),
        sent: actions.filter((a) => a.status === 'sent').length,
        reached: actions.reduce((s, a) => s + (a.reached || 0), 0),
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── POST /api/merchant/rewards/actions ───────────────────
// Drafts an offer. Nothing reaches a customer until it is sent.
router.post('/actions', async (req, res) => {
  try {
    const { segment, discountType, discountValue, maxDiscountTnd, availabilityDays, message } = req.body;
    if (!SEGMENTS[segment]) {
      return res.status(400).json({
        success: false,
        message: `Pick one of: ${Object.keys(SEGMENTS).join(', ')}.`,
      });
    }
    const value = Number(discountValue);
    const unit = discountType === 'tnd' ? 'tnd' : 'percent';
    if (!Number.isFinite(value) || value <= 0) {
      return res.status(400).json({ success: false, message: 'Set the discount.' });
    }
    if (unit === 'percent' && value > 100) {
      return res.status(400).json({ success: false, message: 'A percentage discount cannot be above 100.' });
    }
    const days = Math.min(Math.max(parseInt(availabilityDays, 10) || 7, 1), 90);

    const action = await RewardAction.create({
      merchantId: req.user.id,
      segment,
      discountType: unit,
      discountValue: value,
      maxDiscountTnd: maxDiscountTnd ? Number(maxDiscountTnd) : null,
      availabilityDays: days,
      message: String(message || '').trim() || draftMessage(segment, unit, value, days),
    });

    res.status(201).json({ success: true, data: { ...action.toObject(), id: String(action._id) } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── PUT /api/merchant/rewards/actions/:id ────────────────
// Editable only while it is a draft: an offer already in customers' hands
// cannot be quietly rewritten underneath them.
router.put('/actions/:id', async (req, res) => {
  try {
    const action = await RewardAction.findOne({ _id: req.params.id, merchantId: req.user.id });
    if (!action) return res.status(404).json({ success: false, message: 'Action not found.' });
    if (action.status === 'sent') {
      return res.status(409).json({
        success: false,
        message: 'This has already gone out. Create a new one instead of changing it.',
      });
    }

    const { discountType, discountValue, maxDiscountTnd, availabilityDays, message } = req.body;
    if (discountType !== undefined) action.discountType = discountType === 'tnd' ? 'tnd' : 'percent';
    if (discountValue !== undefined) {
      const v = Number(discountValue);
      if (!Number.isFinite(v) || v <= 0) {
        return res.status(400).json({ success: false, message: 'Set the discount.' });
      }
      if (action.discountType === 'percent' && v > 100) {
        return res.status(400).json({ success: false, message: 'A percentage discount cannot be above 100.' });
      }
      action.discountValue = v;
    }
    if (maxDiscountTnd !== undefined) {
      action.maxDiscountTnd = maxDiscountTnd === null ? null : Number(maxDiscountTnd);
    }
    if (availabilityDays !== undefined) {
      action.availabilityDays = Math.min(Math.max(parseInt(availabilityDays, 10) || 7, 1), 90);
    }
    if (message !== undefined) action.message = String(message).trim().slice(0, 500);

    await action.save();
    res.json({ success: true, data: { ...action.toObject(), id: String(action._id) } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── POST /api/merchant/rewards/actions/:id/send ──────────
/**
 * Sends the offer: issues one coupon for the action and notifies everyone
 * currently in the segment.
 *
 * The audience is resolved now, not when the draft was written — someone who
 * has since come back is no longer someone who stopped coming.
 */
router.post('/actions/:id/send', async (req, res) => {
  try {
    const action = await RewardAction.findOne({ _id: req.params.id, merchantId: req.user.id });
    if (!action) return res.status(404).json({ success: false, message: 'Action not found.' });
    if (action.status === 'sent') {
      return res.status(409).json({ success: false, message: 'This has already been sent.' });
    }

    const members = await resolveSegment(req.user.id, action.segment);
    if (!members.length) {
      return res.status(409).json({
        success: false,
        message: 'Nobody is in this group right now, so there is no one to send it to.',
      });
    }

    const code = `RA${Date.now().toString(36).toUpperCase()}`;
    const expiry = new Date(Date.now() + action.availabilityDays * DAY);

    await Coupon.create({
      code,
      discount: action.discountValue,
      discountUnit: action.discountType,
      maxDiscountAmount: action.maxDiscountTnd,
      type: action.discountType === 'tnd' ? 'fixed' : 'percentage',
      expiryDate: expiry,
      isActive: true,
      merchantId: req.user.id,
      description: action.message,
      maxUsage: members.length,
      tags: ['reward-action', action.segment],
    });

    // Notifications are best-effort: the offer and its coupon are real
    // whether or not every device is reachable.
    const io = req.app.get('io');
    if (io) {
      for (const m of members) {
        io.to(String(m.userId)).emit('reward-offer', {
          code,
          message: action.message,
          expiresAt: expiry,
        });
      }
    }

    action.status = 'sent';
    action.sentAt = new Date();
    action.reached = members.length;
    action.couponCode = code;
    await action.save();

    res.json({
      success: true,
      message: `Sent to ${members.length} customer(s).`,
      data: {
        id: String(action._id),
        reached: members.length,
        couponCode: code,
        expiresAt: expiry,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── GET /api/merchant/rewards/overview ───────────────────
// The counts at the top of the screen: how many customers were reached
// today, this week and this month.
router.get('/overview', async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfDay.getDate() - startOfDay.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const sent = await RewardAction.find({
      merchantId: req.user.id,
      status: 'sent',
      sentAt: { $gte: startOfMonth },
    }).select('sentAt reached').lean();

    const reachedSince = (from) =>
      sent.filter((a) => a.sentAt >= from).reduce((s, a) => s + (a.reached || 0), 0);

    res.json({
      success: true,
      data: {
        today: reachedSince(startOfDay),
        thisWeek: reachedSince(startOfWeek),
        thisMonth: reachedSince(startOfMonth),
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
