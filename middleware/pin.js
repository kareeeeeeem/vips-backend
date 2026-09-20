const User = require('../models/User');

// A server-side PIN gate for high-impact actions. The PIN is never trusted
// from the client: it is compared with the bcrypt hash stored on the account.
async function requirePin(req, res, next) {
  try {
    const pin = String(req.body?.pin || '').trim();
    if (!/^\d{4,6}$/.test(pin)) {
      return res.status(400).json({ success: false, message: 'A valid 4-6 digit PIN is required.' });
    }
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });
    if (!user.pin) return res.status(400).json({ success: false, message: 'Set a security PIN before continuing.' });
    if (!(await user.comparePin(pin))) {
      return res.status(401).json({ success: false, message: 'Incorrect PIN.' });
    }
    next();
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

module.exports = { requirePin };
