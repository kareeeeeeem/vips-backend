const express = require('express');

const User = require('../models/User');
const ChatMessage = require('../models/ChatMessage');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

/**
 * The socket delivers what happens while you are looking. This is everything
 * that happened before — opening a conversation to an empty screen when
 * there is history would look like the messages were lost.
 */

/** GET /api/chat/conversations — who you have talked to, newest first. */
router.get('/conversations', async (req, res) => {
  try {
    const me = req.user.id;
    const mine = require('mongoose').Types.ObjectId.createFromHexString(me);

    const rows = await ChatMessage.aggregate([
      { $match: { $or: [{ from: mine }, { to: mine }] } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$conversationId',
          lastMessage: { $first: '$body' },
          lastAt: { $first: '$createdAt' },
          lastFrom: { $first: '$from' },
          // Counted here rather than in a second query per conversation.
          unread: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$to', mine] }, { $eq: ['$readAt', null] }] },
                1,
                0,
              ],
            },
          },
          participants: { $addToSet: '$from' },
          recipients: { $addToSet: '$to' },
        },
      },
      { $sort: { lastAt: -1 } },
      { $limit: 50 },
    ]);

    const otherIds = rows.map((row) => {
      const everyone = [...row.participants, ...row.recipients].map(String);
      return everyone.find((id) => id !== me);
    });

    const people = await User.find({ _id: { $in: otherIds.filter(Boolean) } })
      .select('fullName storeName role')
      .lean();
    const byId = new Map(people.map((p) => [String(p._id), p]));

    res.json({
      success: true,
      message: 'Conversations',
      data: {
        items: rows.map((row, index) => {
          const otherId = otherIds[index];
          const person = byId.get(otherId);
          return {
            conversationId: row._id,
            withUserId: otherId,
            // A merchant is known by their store name; that is what a
            // customer recognises, not the owner's legal name.
            withName: person
                ? (person.storeName || person.fullName || 'Unknown')
                : 'Deleted account',
            withRole: person ? person.role : '',
            lastMessage: row.lastMessage,
            lastAt: row.lastAt,
            lastFromMe: String(row.lastFrom) === me,
            unread: row.unread,
          };
        }),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/chat/messages/:withUserId?before=&limit= */
router.get('/messages/:withUserId', async (req, res) => {
  try {
    const me = req.user.id;
    const other = String(req.params.withUserId);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);

    const filter = { conversationId: ChatMessage.conversationKey(me, other) };
    if (req.query.before) {
      const before = new Date(req.query.before);
      if (!isNaN(before)) filter.createdAt = { $lt: before };
    }

    const [messages, person] = await Promise.all([
      // Newest first for paging, reversed below so the screen reads top to
      // bottom the way a conversation does.
      ChatMessage.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      User.findById(other).select('fullName storeName role').lean(),
    ]);

    res.json({
      success: true,
      message: 'Messages',
      data: {
        withUserId: other,
        withName: person
            ? (person.storeName || person.fullName || 'Unknown')
            : 'Deleted account',
        items: messages.reverse().map((m) => ({
          _id: m._id,
          from: m.from,
          to: m.to,
          body: m.body,
          createdAt: m.createdAt,
          readAt: m.readAt,
          fromMe: String(m.from) === me,
        })),
        hasMore: messages.length === limit,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/chat/unread — one number for a badge. */
router.get('/unread', async (req, res) => {
  try {
    const unread = await ChatMessage.countDocuments({ to: req.user.id, readAt: null });
    res.json({ success: true, message: 'Unread', data: { unread } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
