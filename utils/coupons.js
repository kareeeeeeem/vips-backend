/**
 * Resolving a coupon code into the discount it is actually worth.
 *
 * This exists because /order/create took `couponDiscountAmount` straight from
 * the request body and subtracted it from the total. No lookup, no ownership
 * check, no cap — so `{"couponCode":"ANYTHING","couponDiscountAmount":999999}`
 * bought a 60 TND order for nothing. Item prices were already read from the
 * database for exactly this reason; the discount was the hole left beside it.
 *
 * Every caller now asks this module what a code is worth, so the rules —
 * ownership, expiry, usage, minimum spend, and what `discount` is measured in
 * — are stated once rather than per route.
 */

const Coupon = require('../models/Coupon');
const { roundTnd } = require('../config/economics');

class CouponError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'CouponError';
    this.status = status;
  }
}

/**
 * What `code` is worth against `subtotal` for `userId` at `merchantId`.
 *
 * Returns `{ coupon, discountTnd }`. Throws CouponError with a message meant
 * for the customer when the code cannot be used.
 */
async function resolve({ code, userId, merchantId, subtotal }) {
  const trimmed = String(code || '').trim().toUpperCase();
  if (!trimmed) throw new CouponError('No coupon code was given.');

  const coupon = await Coupon.findOne({ code: trimmed, isActive: true });
  if (!coupon) throw new CouponError('That coupon is not valid.', 404);

  // A voucher redeemed with points belongs to whoever redeemed it. Without
  // this, learning the code is enough to spend someone else's points.
  if (coupon.userId && String(coupon.userId) !== String(userId)) {
    throw new CouponError('That voucher belongs to another account.', 403);
  }

  if (coupon.expiryDate && new Date() > coupon.expiryDate) {
    throw new CouponError('That coupon has expired.');
  }

  // Both spellings are in use across the seeder and the merchant routes, so
  // a cap set through either one has to be honoured.
  const used = Math.max(coupon.usageCount || 0, coupon.usedCount || 0);
  const cap = coupon.maxUsage ?? coupon.maxUses ?? null;
  if (cap !== null && used >= cap) {
    throw new CouponError('That coupon has already been used.');
  }

  // A merchant's own coupon is not spendable in another merchant's shop.
  if (coupon.merchantId && merchantId && String(coupon.merchantId) !== String(merchantId)) {
    throw new CouponError('That coupon is not valid at this shop.');
  }

  const total = Number(subtotal) || 0;
  if (coupon.minOrderAmount && total < coupon.minOrderAmount) {
    throw new CouponError(
      `That coupon needs a basket of at least ${coupon.minOrderAmount} TND.`
    );
  }

  const value = Number(coupon.discount) || 0;
  let discountTnd;

  // §4.2's third offer is a voucher worth a stated number of dinars, not a
  // percentage off. `discountUnit` is what tells the two apart; a bare
  // number read as a percentage turned a 50 TND voucher into 50% off.
  if (coupon.discountUnit === 'tnd' || coupon.type === 'fixed' || coupon.type === 'voucher') {
    discountTnd = value;
  } else {
    discountTnd = (total * value) / 100;
    if (coupon.maxDiscountAmount != null && coupon.maxDiscountAmount > 0) {
      discountTnd = Math.min(discountTnd, coupon.maxDiscountAmount);
    }
  }

  // Never more than the basket: a discount larger than the order would make
  // the total negative, and a coupon is not a payout.
  discountTnd = roundTnd(Math.max(0, Math.min(discountTnd, total)));

  return { coupon, discountTnd };
}

/**
 * Record that a coupon was spent.
 *
 * Both counter spellings are advanced together so a cap set through either
 * one keeps working, and the guard is on the *stored* count rather than the
 * one read earlier — two checkouts racing cannot both take the last use.
 */
async function consume(coupon) {
  const cap = coupon.maxUsage ?? coupon.maxUses ?? null;
  const filter = { _id: coupon._id, isActive: true };
  if (cap !== null) {
    filter.$or = [
      { usageCount: { $lt: cap } },
      { usageCount: { $exists: false } },
    ];
  }
  const claimed = await Coupon.findOneAndUpdate(
    filter,
    { $inc: { usageCount: 1, usedCount: 1 } },
    { new: true }
  );
  if (!claimed) throw new CouponError('That coupon has just been used.', 409);
  return claimed;
}

module.exports = { resolve, consume, CouponError };
