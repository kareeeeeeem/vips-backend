/**
 * The short VIPs ID a person actually reads out.
 *
 * Six digits for a customer, four for a merchant — the merchant's is shorter
 * because it is quoted far more often, printed on receipts and said aloud
 * across a counter.
 *
 * Four digits caps the merchant network at 9,000 shops. That is well beyond
 * the current roster, but it is a real ceiling and the generator says so
 * rather than looping forever when it is reached.
 */
const User = require('../models/User');

const WIDTHS = { merchant: 4, customer: 6, admin: 6 };

function randomId(width) {
  const min = 10 ** (width - 1);
  const max = 10 ** width - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
}

/**
 * Returns the account's short id, assigning one the first time it is asked
 * for. Retries on collision — the space is small enough that collisions are
 * expected rather than exceptional.
 */
async function ensureVipsId(user) {
  const width = WIDTHS[user.role] || 6;
  // Older records may contain a Mongo id or an id generated with the wrong
  // role width. Re-issue those instead of leaking an invalid format.
  if (user.vipsId && new RegExp(`^\\d{${width}}$`).test(String(user.vipsId))) {
    return user.vipsId;
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    const candidate = randomId(width);
    // Claimed with a guarded update, so two requests for the same account —
    // or for two accounts landing on the same number — cannot both win.
    const claimed = await User.findOneAndUpdate(
      { _id: user._id, $or: [{ vipsId: null }, { vipsId: { $exists: false } }, { vipsId: user.vipsId }] },
      { $set: { vipsId: candidate } },
      { new: true }
    ).catch((err) => {
      if (err && err.code === 11000) return null; // taken; try another
      throw err;
    });

    if (claimed && claimed.vipsId) {
      user.vipsId = claimed.vipsId;
      return claimed.vipsId;
    }
    // Either someone else assigned one in the meantime, or the number was
    // taken. Re-read before deciding which.
    const fresh = await User.findById(user._id).select('vipsId').lean();
    if (fresh?.vipsId) {
      user.vipsId = fresh.vipsId;
      return fresh.vipsId;
    }
  }

  throw Object.assign(
    new Error(
      `Could not assign a ${width}-digit VIPs ID — the ${user.role} numbering space is full.`
    ),
    { status: 507 }
  );
}

/** Finds an account by its short id, whatever case or spacing it arrives in. */
async function findByVipsId(raw, role = null) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  const filter = { vipsId: digits };
  if (role) filter.role = role;
  return User.findOne(filter);
}

module.exports = { ensureVipsId, findByVipsId, WIDTHS };
