const express = require('express');
const VisitEvent = require('../models/VisitEvent');
const { optionalAuthMiddleware } = require('../middleware/auth');

const router = express.Router();

// A screen name has to look like a route, not like a record. '/product/:id'
// is a screen; '/product/68f3…' would turn a screen name into an identifier
// and put a browsing history in a collection that promises not to hold one.
const SCREEN_PATTERN = /^[a-z0-9/_:.-]{1,80}$/i;

// The character check alone is not enough: an ObjectId is 24 hex characters,
// which is entirely [a-z0-9] and passes it cleanly. Every segment is checked
// for the shapes an identifier actually takes, so a client that forgets to
// parameterise its route cannot quietly ship browsing histories.
const IDENTIFIER_SHAPES = [
  /^[0-9a-f]{24}$/i,                                          // Mongo ObjectId
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^\d{5,}$/,                                                 // a long number
  /^[0-9a-f]{32,}$/i,                                         // a hash or token
];

const looksLikeAnIdentifier = (screen) =>
  screen.split('/').filter(Boolean).some((segment) =>
    IDENTIFIER_SHAPES.some((shape) => shape.test(segment)));
const APPS = ['consumer', 'merchant', 'admin'];
const PLATFORMS = ['android', 'ios', 'web', 'macos', 'windows', 'linux', 'unknown'];

// One request carries a batch, because a screen view is not worth a round
// trip of its own on a phone connection.
const MAX_EVENTS = 50;

/**
 * POST /api/analytics/track
 *
 * Public on purpose: a visit happens before anyone signs in, and requiring a
 * token would count only the people who already converted — which is the one
 * population a conversion rate must not be measured over.
 *
 * `optionalAuthMiddleware` attaches the user when a token happens to be
 * present, so a session can be tied to an account that signed in and to
 * nothing at all otherwise.
 */
router.post('/track', optionalAuthMiddleware, async (req, res) => {
  try {
    const sessionId = String(req.body.sessionId || '').trim();
    // Long enough not to collide, short enough not to be a payload.
    if (sessionId.length < 8 || sessionId.length > 64) {
      return res.status(400).json({
        success: false,
        message: 'A sessionId between 8 and 64 characters is required.',
      });
    }

    const app = APPS.includes(req.body.app) ? req.body.app : 'consumer';
    const platform = PLATFORMS.includes(req.body.platform) ? req.body.platform : 'unknown';

    const raw = Array.isArray(req.body.events) ? req.body.events : [];
    if (!raw.length) {
      return res.status(400).json({ success: false, message: 'No events sent.' });
    }

    const userId = req.user && req.user.id ? req.user.id : null;
    const docs = raw
      .slice(0, MAX_EVENTS)
      .map((e) => String((e && e.screen) || '').trim())
      .filter((screen) =>
        screen && SCREEN_PATTERN.test(screen) && !looksLikeAnIdentifier(screen))
      .map((screen) => ({ sessionId, userId, app, platform, screen }));

    if (!docs.length) {
      return res.status(400).json({
        success: false,
        message: 'No event carried a usable screen name.',
      });
    }

    await VisitEvent.insertMany(docs, { ordered: false });
    res.json({ success: true, message: 'Recorded', data: { recorded: docs.length } });
  } catch (error) {
    // Analytics must never be the reason an app fails. The client treats any
    // error here as "carry on", and so does this handler.
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
