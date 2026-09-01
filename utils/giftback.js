/**
 * Giftback: the change a customer forgoes, returned as deferred loyalty
 * points (§4.2, §7).
 *
 * Activation is lazy — a grant becomes spendable the first time anything
 * reads the customer's wallet after its twelve hours are up. A scheduled job
 * would leave points that are due but not credited whenever the job is late
 * or the process restarts, and "due but not credited" is the one state a
 * customer would notice.
 */
const GiftbackGrant = require('../models/GiftbackGrant');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { GIFTBACK, tndToPoints, pointsToTnd } = require('../config/economics');

const startOfMonth = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1);

/**
 * Credits every grant whose twelve hours have elapsed. Safe to call often
 * and from anywhere; a grant can only move out of `pending` once.
 */
async function activateDue(userId) {
  const due = await GiftbackGrant.find({
    userId,
    status: 'pending',
    activatesAt: { $lte: new Date() },
  });
  if (!due.length) return { activated: 0, points: 0 };

  let credited = 0;
  for (const grant of due) {
    // Guarded update: if a concurrent request already activated this grant,
    // matchedCount is 0 and the points are not credited twice.
    const claim = await GiftbackGrant.updateOne(
      { _id: grant._id, status: 'pending' },
      { $set: { status: 'active', activatedAt: new Date() } }
    );
    if (!claim.modifiedCount) continue;

    await User.updateOne({ _id: userId }, { $inc: { walletPoints: grant.points } });
    await Transaction.create({
      userId,
      merchantId: grant.merchantId,
      type: 'gift_back',
      amount: grant.points,
      currency: 'PTS',
      description: `Giftback activated — ${grant.changeTnd} TND change`,
      status: 'completed',
      reference: `GIFTBACK-${grant._id}`,
    });
    credited += grant.points;
  }
  return { activated: due.length, points: credited };
}

/** How much of this customer's monthly allowance is left, in dinars. */
async function monthlyAllowance(userId) {
  const rows = await GiftbackGrant.aggregate([
    {
      $match: {
        userId: require('mongoose').Types.ObjectId.createFromHexString(String(userId)),
        status: { $ne: 'void' },
        createdAt: { $gte: startOfMonth() },
      },
    },
    { $group: { _id: null, tnd: { $sum: '$changeTnd' } } },
  ]);
  const used = Math.round((rows[0]?.tnd || 0) * 1000) / 1000;
  return {
    capTnd: GIFTBACK.MONTHLY_CAP_TND,
    usedTnd: used,
    remainingTnd: Math.max(0, Math.round((GIFTBACK.MONTHLY_CAP_TND - used) * 1000) / 1000),
  };
}

class GiftbackError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

/**
 * Record a grant. Every rule in §4.2 is checked here, because each one is
 * part of why the feature is a loyalty gift rather than a cash refund.
 */
async function grant({ userId, merchantId, changeTnd, invoiceTnd = null, consented }) {
  const change = Math.round(Number(changeTnd) * 1000) / 1000;

  if (!Number.isFinite(change) || change <= 0) {
    throw new GiftbackError('The change must be a positive amount.');
  }
  if (change >= GIFTBACK.MAX_CHANGE_TND) {
    throw new GiftbackError(
      `Giftback covers change under ${GIFTBACK.MAX_CHANGE_TND} TND. ${change} TND has to be handed back.`
    );
  }
  if (consented !== true) {
    throw new GiftbackError('The customer has to agree before their change becomes points.', 403);
  }

  const allowance = await monthlyAllowance(userId);
  if (change > allowance.remainingTnd) {
    throw new GiftbackError(
      `This customer has ${allowance.remainingTnd} TND of their ${GIFTBACK.MONTHLY_CAP_TND} TND monthly Giftback allowance left.`,
      409,
      { allowance }
    );
  }

  const now = new Date();
  const record = await GiftbackGrant.create({
    userId,
    merchantId,
    changeTnd: change,
    points: tndToPoints(change),
    invoiceTnd,
    consentedAt: now,
    activatesAt: new Date(now.getTime() + GIFTBACK.ACTIVATION_DELAY_HOURS * 60 * 60 * 1000),
  });

  return { grant: record, allowance: await monthlyAllowance(userId) };
}

/** The customer's Giftback screen (§6.1). */
async function summaryFor(userId) {
  await activateDue(userId);
  const [grants, allowance] = await Promise.all([
    GiftbackGrant.find({ userId }).sort({ createdAt: -1 }).limit(50).lean(),
    monthlyAllowance(userId),
  ]);
  const pending = grants.filter((g) => g.status === 'pending');
  return {
    allowance,
    activationDelayHours: GIFTBACK.ACTIVATION_DELAY_HOURS,
    maxChangeTnd: GIFTBACK.MAX_CHANGE_TND,
    pendingPoints: pending.reduce((s, g) => s + g.points, 0),
    pendingTnd: pointsToTnd(pending.reduce((s, g) => s + g.points, 0)),
    grants: grants.map((g) => ({
      id: String(g._id),
      merchantId: String(g.merchantId),
      changeTnd: g.changeTnd,
      points: g.points,
      status: g.status,
      grantedAt: g.createdAt,
      activatesAt: g.activatesAt,
      activatedAt: g.activatedAt,
    })),
  };
}

module.exports = { activateDue, monthlyAllowance, grant, summaryFor, GiftbackError };
