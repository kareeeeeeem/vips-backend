/**
 * Brings existing data onto the documented model (§4.1, §5.1, §8).
 *
 * Three things changed underneath the data:
 *
 *  1. A point was worth 0.1 TND and is now worth 0.01 — the documented rate.
 *     Left alone, every wallet would silently lose nine tenths of its
 *     purchasing power overnight. Balances are multiplied by ten so what a
 *     customer can actually buy is exactly what it was yesterday.
 *  2. Merchants had no earn rate. Anyone unset gets the document's worked
 *     example, 6 points per dinar.
 *  3. Merchants had a hand-set commission and no plan. Everyone lands on
 *     `basic`, whose 3% is the documented default.
 *
 * Run it once, and read it first:
 *   node scripts/migrate-to-spec.js            # dry run, changes nothing
 *   node scripts/migrate-to-spec.js --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { DEFAULT_EARN_RATE, pointsToTnd } = require('../config/economics');

// 0.1 TND per point → 0.01 TND per point.
const VALUE_PRESERVING_FACTOR = 10;
const APPLY = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(APPLY ? '⚙️  APPLYING\n' : '🔍 DRY RUN — nothing will be written\n');

  // ─── 1. Customer point balances ──────────────────────────
  const holders = await User.find({ walletPoints: { $gt: 0 } })
    .select('fullName email walletPoints role')
    .lean();
  const totalBefore = holders.reduce((s, u) => s + (u.walletPoints || 0), 0);

  console.log(`1. Wallets holding points: ${holders.length}`);
  console.log(`   ${totalBefore} points, worth ${(totalBefore * 0.1).toFixed(3)} TND at the old rate.`);
  console.log(`   → ×${VALUE_PRESERVING_FACTOR} = ${totalBefore * VALUE_PRESERVING_FACTOR} points, ` +
              `worth ${pointsToTnd(totalBefore * VALUE_PRESERVING_FACTOR)} TND at the documented rate.`);
  console.log('   Same value; the number changes because the unit did.');
  for (const u of holders.slice(0, 5)) {
    console.log(`     ${(u.email || u.fullName || u._id).toString().padEnd(34)} ` +
                `${String(u.walletPoints).padStart(8)} → ${u.walletPoints * VALUE_PRESERVING_FACTOR}`);
  }
  if (holders.length > 5) console.log(`     … and ${holders.length - 5} more`);

  if (APPLY) {
    await User.updateMany(
      { walletPoints: { $gt: 0 } },
      [{ $set: { walletPoints: { $multiply: ['$walletPoints', VALUE_PRESERVING_FACTOR] } } }]
    );
    // Historical point transactions are restated in the same unit, so a
    // customer's ledger still adds up to the balance beside it.
    await Transaction.updateMany(
      { currency: 'PTS' },
      [{ $set: { amount: { $multiply: ['$amount', VALUE_PRESERVING_FACTOR] } } }]
    );
    console.log('   ✓ balances and PTS transactions restated');
  }

  // ─── 2. Merchant earn rates ──────────────────────────────
  const unset = await User.countDocuments({
    role: 'merchant',
    $or: [{ earnRate: null }, { earnRate: { $exists: false } }],
  });
  console.log(`\n2. Merchants with no earn rate: ${unset} → ${DEFAULT_EARN_RATE} points/TND`);
  if (APPLY && unset) {
    await User.updateMany(
      { role: 'merchant', $or: [{ earnRate: null }, { earnRate: { $exists: false } }] },
      { $set: { earnRate: DEFAULT_EARN_RATE } }
    );
    console.log('   ✓ set');
  }

  // ─── 3. Plans and commission ─────────────────────────────
  const planless = await User.countDocuments({
    role: 'merchant',
    $or: [{ merchantPlan: null }, { merchantPlan: { $exists: false } }],
  });
  console.log(`\n3. Merchants with no plan: ${planless} → basic (3% commission)`);
  if (APPLY && planless) {
    await User.updateMany(
      { role: 'merchant', $or: [{ merchantPlan: null }, { merchantPlan: { $exists: false } }] },
      { $set: { merchantPlan: 'basic', commissionRate: 3 } }
    );
    console.log('   ✓ set');
  }

  // ─── 4. Guarantee ────────────────────────────────────────
  // Deliberately not invented: a guarantee is real money a merchant paid in,
  // and seeding a balance nobody deposited would put unbacked points into
  // circulation — the exact failure §5.1 exists to prevent. Merchants start
  // at zero and deposit through the admin console.
  const merchants = await User.countDocuments({ role: 'merchant' });
  console.log(`\n4. Guarantee balances: left at zero for all ${merchants} merchants.`);
  console.log('   Not seeded on purpose — a guarantee stands for cash actually received.');
  console.log('   Until a merchant deposits, POST /merchant/earn refuses with BUDGET_EXHAUSTED.');

  await mongoose.disconnect();
  console.log(APPLY ? '\n✅ Migration applied.' : '\n🔍 Dry run complete. Re-run with --apply.');
})();
