const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const ChatMessage = require('../models/ChatMessage');

/**
 * Live chat between a customer and a merchant.
 *
 * The identity comes from the JWT on the handshake, never from the client.
 * A `register` event carrying a user id would let anyone claim to be any
 * account and receive that account's messages — which is not a chat feature,
 * it is a way to read other people's conversations.
 *
 * Each socket joins a room named after its own user id. Rooms rather than a
 * single stored socket id, so somebody signed in on a phone and a laptop
 * gets the message on both instead of whichever connected last.
 */
function setupChatServer(httpServer, { corsOrigins } = {}) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      // Mirrors the REST CORS config rather than '*', so the socket is not a
      // looser door into the same data than the API beside it.
      origin: corsOrigins && corsOrigins.length ? corsOrigins : true,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    // A phone on a train loses the connection constantly; these let a client
    // drop for a while without the server forgetting it.
    pingTimeout: 30000,
    pingInterval: 25000,
  });

  // ── Authentication ──
  io.use(async (socket, next) => {
    try {
      const token =
        (socket.handshake.auth && socket.handshake.auth.token) ||
        (socket.handshake.headers.authorization || '').replace(/^Bearer /, '');

      if (!token) return next(new Error('A token is required to open a chat.'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      // Loaded rather than trusted from the token, so a disabled or deleted
      // account cannot keep chatting until its token happens to expire.
      const user = await User.findById(decoded.id).select('fullName role isActive').lean();
      if (!user) return next(new Error('That account no longer exists.'));
      if (user.isActive === false) return next(new Error('This account is disabled.'));

      socket.data.userId = String(user._id);
      socket.data.role = user.role;
      socket.data.name = user.fullName;
      next();
    } catch (error) {
      next(new Error('Invalid or expired token.'));
    }
  });

  io.on('connection', (socket) => {
    const { userId, role } = socket.data;
    socket.join(userId);

    socket.emit('ready', { userId, role });
    // Presence, scoped to the people already in a conversation with them —
    // broadcasting the whole online list to everyone would hand every client
    // a live roster of who is using the platform.
    announcePresence(io, userId, true);

    /**
     * A customer talks to a merchant and a merchant talks back. Anything
     * else — customer to customer, or to an admin — is refused, so this
     * cannot become a way to message arbitrary accounts.
     */
    const canTalkTo = (other) => {
      if (role === 'customer') return other.role === 'merchant';
      if (role === 'merchant') return other.role === 'customer';
      return false;
    };

    socket.on('send-message', async (payload, ack) => {
      const respond = (result) => {
        if (typeof ack === 'function') ack(result);
        else if (!result.ok) socket.emit('message-failed', result);
      };

      try {
        const toUserId = String((payload && payload.toUserId) || '');
        const body = String((payload && payload.body) || '').trim();

        if (!body) return respond({ ok: false, error: 'The message is empty.' });
        if (body.length > 2000) {
          return respond({ ok: false, error: 'That message is too long.' });
        }
        if (!toUserId || toUserId === userId) {
          return respond({ ok: false, error: 'Choose someone to send it to.' });
        }

        const other = await User.findById(toUserId).select('role isActive').lean();
        if (!other) return respond({ ok: false, error: 'That account does not exist.' });
        if (!canTalkTo(other)) {
          return respond({
            ok: false,
            error: 'You can only message a merchant you buy from, or a customer who messaged you.',
          });
        }

        const message = await ChatMessage.create({
          conversationId: ChatMessage.conversationKey(userId, toUserId),
          from: userId,
          to: toUserId,
          body,
        });

        const wire = {
          _id: String(message._id),
          conversationId: message.conversationId,
          from: userId,
          to: toUserId,
          body: message.body,
          createdAt: message.createdAt,
          readAt: null,
        };

        // To the recipient's room, and back to the sender's own other
        // devices, so a conversation opened on two screens stays in step.
        io.to(toUserId).emit('new-message', wire);
        socket.to(userId).emit('new-message', wire);
        respond({ ok: true, message: wire });
      } catch (error) {
        respond({ ok: false, error: error.message });
      }
    });

    socket.on('mark-read', async (payload, ack) => {
      try {
        const otherId = String((payload && payload.withUserId) || '');
        if (!otherId) return;
        const result = await ChatMessage.updateMany(
          { conversationId: ChatMessage.conversationKey(userId, otherId), to: userId, readAt: null },
          { readAt: new Date() }
        );
        // Told to the sender too, so their own screen can show the ticks
        // without polling for them.
        io.to(otherId).emit('messages-read', { byUserId: userId, at: new Date() });
        if (typeof ack === 'function') ack({ ok: true, updated: result.modifiedCount });
      } catch (error) {
        if (typeof ack === 'function') ack({ ok: false, error: error.message });
      }
    });

    socket.on('typing', (payload) => {
      const toUserId = String((payload && payload.toUserId) || '');
      if (!toUserId) return;
      io.to(toUserId).emit('typing', { fromUserId: userId, typing: payload.typing === true });
    });

    socket.on('disconnect', () => {
      // Only once the last device is gone. Signing out on a laptop should not
      // show a customer as offline on their phone.
      if (io.sockets.adapter.rooms.get(userId) === undefined) {
        announcePresence(io, userId, false);
      }
    });
  });

  return io;
}

/**
 * Tell the people this user has actually talked to that they came or went.
 *
 * Not a broadcast: emitting the full online list to every client would give
 * anyone a live roster of who is using the platform.
 */
async function announcePresence(io, userId, online) {
  try {
    const conversations = await ChatMessage.find({
      $or: [{ from: userId }, { to: userId }],
    })
      .select('from to')
      .limit(200)
      .lean();

    const others = new Set();
    for (const m of conversations) {
      others.add(String(m.from) === userId ? String(m.to) : String(m.from));
    }
    for (const other of others) {
      io.to(other).emit('presence', { userId, online });
    }
  } catch (error) {
    // Presence is a nicety. Failing to announce it must never take the
    // connection down with it.
    console.error('[CHAT] presence announce failed:', error.message);
  }
}

module.exports = { setupChatServer };
