/**
 * VIPs Backend — End-to-End Integration Test Suite
 *
 * Run with: node tests/integration.test.js
 * Requires: a running backend at BASE_URL with a seeded MongoDB.
 */

require('dotenv').config();

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000/api';

// ─── Direct-DB test seeding ────────────────────────────────────
// Wallet points can only be earned for real through spin-wheel/check-in/
// referral rewards or a gateway-verified top-up (routes/payment.js) — there
// is no HTTP endpoint that mints points on request (a prior one was removed
// as a live free-money exploit). Some flows below need a specific starting
// balance to be deterministic, so we seed it directly in Mongo, the same
// database the running backend under test is already using.
const mongoose = require('mongoose');
const User = require('../models/User');
let dbConnected = false;

async function seedWalletPoints(uid, amount) {
  if (!dbConnected) {
    await mongoose.connect(process.env.MONGODB_URI);
    dbConnected = true;
  }
  await User.updateOne({ _id: uid }, { $inc: { walletPoints: amount } });
}

/**
 * Create a throwaway admin straight in Mongo.
 *
 * There is deliberately no HTTP endpoint that mints the first admin (that
 * would be an unauthenticated privilege-escalation hole), so the suite writes
 * one the same way seedWalletPoints writes points. Uses .save() rather than
 * an update so the password pre-save hook hashes it.
 */
/**
 * Create a throwaway account of any role, straight in Mongo.
 *
 * seedAdmin below forces role:'admin' — passing it a merchant silently
 * produced an admin, and every lookup for that merchant then missed.
 * Returns the saved document so callers have the real _id without a
 * round-trip through /auth/me.
 */
async function seedUser(user) {
  if (!dbConnected) {
    await mongoose.connect(process.env.MONGODB_URI);
    dbConnected = true;
  }
  const doc = new User({ isVerified: true, ...user });
  await doc.save();
  return doc;
}

async function seedAdmin(admin) {
  if (!dbConnected) {
    await mongoose.connect(process.env.MONGODB_URI);
    dbConnected = true;
  }
  const doc = new User({ ...admin, role: 'admin', isVerified: true });
  await doc.save();
  return doc._id.toString();
}

// ─── Minimal HTTP helper ─────────────────────────────────────
async function req(method, path, body, token) {
  const { default: fetch } = await import('node-fetch').catch(() => {
    // fallback to built-in fetch (Node 18+)
    return { default: globalThis.fetch };
  });
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, ...json };
}

// ─── Test runner ─────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
    failures.push(`${label}${detail ? `: ${detail}` : ''}`);
  }
}

// ─── State shared between tests ──────────────────────────────
let _phoneSeq = 0;
/** A phone number no other test row holds. The unique index makes a
 *  same-millisecond collision a real failure, so this counts rather than
 *  trusting the clock. */
function _uniquePhone(prefix = '3') {
  _phoneSeq += 1;
  return (prefix + String(Date.now() + _phoneSeq).slice(-8)).slice(0, 9);
}

let userToken, merchantToken, userId, merchantId, orderId, couponId;
let adminToken, adminId;

const ts = Date.now();
const TEST_USER = {
  fullName: 'QA Test User',
  email: `qa_user_${ts}@vips.test`,
  phone: String(ts).slice(-9).padStart(9, '5'),
  password: 'QAPassword123',
  role: 'customer',
};

const TEST_MERCHANT = {
  fullName: 'QA Merchant Store',
  email: `qa_merchant_${ts}@vips.test`,
  phone: String(ts + 1).slice(-9).padStart(9, '7'),
  password: 'MerchPassword123',
  role: 'merchant',
  storeName: 'QA Store',
  storeCategory: 'Food',
};

// ─── FLOW 1: Auth ────────────────────────────────────────────
async function testAuth() {
  console.log('\n══ FLOW 1: Authentication ══');

  // Register user
  const reg = await req('POST', '/auth/register', TEST_USER);
  assert('POST /auth/register returns 201', reg.status === 201, `status=${reg.status}`);
  assert('register returns token', !!reg.data?.token, `token=${reg.data?.token}`);
  assert('register returns user object', !!reg.data?.user?._id);
  userToken = reg.data?.token;
  userId = reg.data?.user?._id;

  // Register merchant
  const mReg = await req('POST', '/auth/register', TEST_MERCHANT);
  assert('POST /auth/register merchant returns 201', mReg.status === 201, `status=${mReg.status} msg=${mReg.message}`);
  merchantToken = mReg.data?.token;
  merchantId = mReg.data?.user?._id;

  // Login
  const login = await req('POST', '/auth/login', { email: TEST_USER.email, password: TEST_USER.password });
  assert('POST /auth/login success', login.success === true, `msg=${login.message}`);
  assert('login returns fresh token', !!login.data?.token);

  // Verify token
  const me = await req('GET', '/auth/me', null, userToken);
  assert('GET /auth/me returns user', me.data?.user?.email === TEST_USER.email);

  // Duplicate registration rejected
  const dup = await req('POST', '/auth/register', TEST_USER);
  assert('duplicate register returns 400', dup.status === 400, `status=${dup.status}`);
}

// ─── FLOW 2: User Wallet Ledger ──────────────────────────────
async function testWallet() {
  console.log('\n══ FLOW 2: Wallet & Ledger ══');

  const wallet = await req('GET', '/user/wallet', null, userToken);
  assert('GET /user/wallet success', wallet.success === true);
  assert('wallet returns balance field', wallet.data?.balance !== undefined, `balance=${wallet.data?.balance}`);
  assert('wallet returns points field', wallet.data?.points !== undefined, `points=${wallet.data?.points}`);
  assert('wallet returns recentTransactions array', Array.isArray(wallet.data?.recentTransactions));

  // Seed points directly (no HTTP endpoint mints points on request — see
  // seedWalletPoints comment above) and confirm the wallet reflects it.
  const pointsBefore = wallet.data?.points ?? 0;
  await seedWalletPoints(userId, 500);
  const walletAfter = await req('GET', '/user/wallet', null, userToken);
  const pointsAfter = walletAfter.data?.points ?? 0;
  assert('wallet points increased after seeding', pointsAfter >= pointsBefore + 500, `points=${pointsAfter}`);

  // Transactions log
  const txLog = await req('GET', '/user/transactions', null, userToken);
  assert('GET /user/transactions success', txLog.success === true);
  assert('transactions returns array', Array.isArray(txLog.data?.transactions));
}

// ─── FLOW 3: Rewards & Spin Wheel ───────────────────────────
async function testRewards() {
  console.log('\n══ FLOW 3: Rewards ══');

  // Spin wheel
  const spin = await req('POST', '/rewards/spin-wheel', {}, userToken);
  assert('POST /rewards/spin-wheel success', spin.success === true, `msg=${spin.message}`);
  assert('spin returns reward type', spin.data?.type !== undefined, `type=${spin.data?.type}`);
  assert('spin returns reward amount', spin.data?.amount !== undefined, `amount=${spin.data?.amount}`);
  assert('spin returns newBalance', spin.data?.newBalance !== undefined, `newBalance=${spin.data?.newBalance}`);

  // Coupons list
  const coupons = await req('GET', '/rewards/coupons', null, userToken);
  assert('GET /rewards/coupons success', coupons.success === true);
  assert('coupons returns array', Array.isArray(coupons.data));

  // Expense to reward
  // §4.1 puts the merchant at the till. This endpoint let a customer type
  // their own spend and be credited points for it — points nothing backed.
  const exp2rew = await req('POST', '/rewards/expense-to-reward', { amount: 1000, merchantId }, userToken);
  assert('a customer can no longer credit their own spending',
    exp2rew.status === 410, `${exp2rew.status}`);
  assert('and is told where the flow moved to',
    exp2rew.code === 'FLOW_MOVED_TO_MERCHANT', String(exp2rew.code));

  // Gift voucher brands
  const vouchers = await req('GET', '/rewards/gift-vouchers', null, userToken);
  assert('GET /rewards/gift-vouchers success', vouchers.success === true);
  assert('gift-vouchers returns non-empty array', Array.isArray(vouchers.data) && vouchers.data.length > 0,
    `count=${vouchers.data?.length}`);
  assert('gift-voucher brand has minAmount field', vouchers.data?.[0]?.minAmount !== undefined);
}

// ─── FLOW 4: Order Checkout → Merchant Dashboard ─────────────
async function testOrderFlow() {
  console.log('\n══ FLOW 4: Order Checkout → Merchant Dashboard ══');

  // Real products, created by the merchant. /order/create prices every line
  // from the Product/Deal document rather than from the request — it used to
  // total the order from whatever price the client claimed, so a D 29.990
  // burger could be ordered for a millime.
  const burger = await req('POST', '/merchant/products',
    { name: 'Test Burger', price: 29.99, category: 'Food' }, merchantToken);
  const fries = await req('POST', '/merchant/products',
    { name: 'Test Fries', price: 9.99, category: 'Food' }, merchantToken);
  const burgerId = burger.data?._id;
  const friesId  = fries.data?._id;
  assert('merchant products created for the order flow', !!burgerId && !!friesId,
    `burger=${burgerId} fries=${friesId}`);

  const orderPayload = {
    merchantId,
    items: [
      // Deliberately understated prices — the server must ignore them.
      { productId: burgerId, name: 'Test Burger', price: 0.001, quantity: 2 },
      { productId: friesId,  name: 'Test Fries',  price: 0.001, quantity: 1 },
    ],
    paymentMethod: 'cash',
    deliveryAddress: '123 Test Street, Test City',
    orderType: 'delivery',
    orderNote: 'Extra sauce please',
  };

  const createOrder = await req('POST', '/order/create', orderPayload, userToken);
  assert('POST /order/create success', createOrder.success === true, `msg=${createOrder.message}`);
  assert('order is priced from the database, not the request',
    Math.abs((createOrder.data?.totalAmount ?? 0) - (29.99 * 2 + 9.99)) < 0.01,
    `total=${createOrder.data?.totalAmount} (expected ${29.99 * 2 + 9.99})`);

  const bogus = await req('POST', '/order/create', {
    merchantId,
    items: [{ productId: '000000000000000000000000', name: 'Ghost', price: 5, quantity: 1 }],
    paymentMethod: 'cash',
  }, userToken);
  assert('order with an unknown item is rejected', bogus.success === false, `msg=${bogus.message}`);
  assert('order has id field', !!createOrder.data?._id || !!createOrder.data?.id, `data keys=${Object.keys(createOrder.data || {}).join(',')}`);
  const orderTotal = createOrder.data?.totalAmount ?? createOrder.data?.order_amount ?? 0;
  assert('order totalAmount computed correctly', orderTotal > 0, `total=${orderTotal}`);
  orderId = createOrder.data?._id;  // store MongoDB _id for subsequent lookups

  // Item name preserved
  const firstItem = createOrder.data?.items?.[0];
  assert('item name stored as item_name', firstItem?.item_name === 'Test Burger' || firstItem?.name === 'Test Burger',
    `item=${JSON.stringify(firstItem)}`);

  // deliveryAddress stored as object
  const addr = createOrder.data?.deliveryAddress || createOrder.data?.delivery_address;
  assert('deliveryAddress normalized to object', typeof addr === 'object' && addr !== null, `addr=${JSON.stringify(addr)}`);

  // User can fetch their orders
  const myOrders = await req('GET', '/order/my-orders', null, userToken);
  assert('GET /order/my-orders success', myOrders.success === true);
  assert('my-orders contains created order',
    myOrders.data?.some?.((o) => String(o._id) === String(orderId) || String(o.id) === String(orderId)),
    `orderId=${orderId} ids=${myOrders.data?.map?.((o) => o._id).join(',')}`);

  // Merchant can see the order (only if merchant token is available)
  if (merchantToken) {
    const mOrders = await req('GET', '/merchant/orders', null, merchantToken);
    assert('GET /merchant/orders returns data', mOrders.orders !== undefined || mOrders.success === true, `keys=${Object.keys(mOrders).join(',')}`);
    assert('merchant orders returns array', Array.isArray(mOrders.orders) || Array.isArray(mOrders.data?.orders) || Array.isArray(mOrders.data),
    `keys=${Object.keys(mOrders).join(',')}`);

    // Merchant updates order status — use MongoDB _id stored in orderId
    if (orderId) {
      const update = await req('PUT', `/merchant/orders/${orderId}/status`, { status: 'confirmed' }, merchantToken);
      assert('PUT /merchant/orders/:id/status success', update.success === true, `msg=${update.message}`);
    }
  } else {
    console.log('  ⚠ Skipping merchant order tests (no merchant token)');
  }

  // User fetches updated order
  if (orderId) {
    const updatedOrder = await req('GET', `/order/${orderId}`, null, userToken);
    assert('GET /order/:id success', updatedOrder.success === true);
  }
}

// ─── FLOW 5: VIPs Club Check-in & Convert ────────────────────
async function testVipsClub() {
  console.log('\n══ FLOW 5: VIPs Club ══');

  const club = await req('GET', '/user/vips-club', null, userToken);
  assert('GET /user/vips-club success', club.success === true, `msg=${club.message}`);
  assert('vips-club returns walletPoints', club.data?.walletPoints !== undefined || club.data?.diamonds !== undefined);
  assert('vips-club returns rank', club.data?.rank !== undefined || club.data?.currentRank !== undefined);

  // Check-in
  const checkin = await req('POST', '/user/vips-club/checkin', {}, userToken);
  assert('POST /user/vips-club/checkin returns success or already checked in',
    checkin.success === true || checkin.message?.includes('Already'), `msg=${checkin.message}`);
  if (checkin.success) {
    assert('checkin returns pointsEarned', checkin.data?.pointsEarned !== undefined);
    assert('checkin returns newBalance', checkin.data?.newBalance !== undefined);
  }
}

// ─── FLOW 6: Notifications ───────────────────────────────────
async function testNotifications() {
  console.log('\n══ FLOW 6: Notifications ══');

  const notifs = await req('GET', '/user/notifications', null, userToken);
  assert('GET /user/notifications success', notifs.success === true);
  assert('notifications returns array', Array.isArray(notifs.data));

  const readAll = await req('POST', '/user/notifications/read-all', {}, userToken);
  assert('POST /user/notifications/read-all success', readAll.success === true, `msg=${readAll.message}`);
}

// ─── FLOW 7: Content Feed ─────────────────────────────────────
async function testContent() {
  console.log('\n══ FLOW 7: Content Feed ══');

  const deals = await req('GET', '/content/hot-deals', null, userToken);
  assert('GET /content/hot-deals success', deals.success === true);
  assert('hot-deals returns array', Array.isArray(deals.data));

  const promos = await req('GET', '/content/promotions', null, userToken);
  assert('GET /content/promotions success', promos.success === true);
  assert('promotions returns array', Array.isArray(promos.data));
  assert('promotions has content (seeded)', promos.data?.length > 0, `count=${promos.data?.length}`);

  const search = await req('GET', '/content/search?q=pizza', null, userToken);
  assert('GET /content/search?q=pizza success', search.success === true);
  assert('search returns deals array', Array.isArray(search.data?.deals));
  assert('search returns products array', Array.isArray(search.data?.products));
  assert('search returns merchants array', Array.isArray(search.data?.merchants));
}

// ─── FLOW 8: Merchant Routes ─────────────────────────────────
async function testMerchant() {
  console.log('\n══ FLOW 8: Merchant Dashboard ══');

  if (!merchantToken) {
    console.log('  ⚠ No merchant token — skipping merchant flow tests');
    return;
  }

  const dashboard = await req('GET', '/merchant/dashboard', null, merchantToken);
  assert('GET /merchant/dashboard success', dashboard.success === true, `msg=${dashboard.message}`);
  assert('dashboard returns revenue data', dashboard.data?.totalSales !== undefined || dashboard.data?.todayRevenue !== undefined || dashboard.data?.revenue !== undefined,
    `keys=${Object.keys(dashboard.data || {}).join(',')}`);

  const profile = await req('GET', '/merchant/profile', null, merchantToken);
  assert('GET /merchant/profile success', profile.success === true);
  assert('profile has merchant fields', profile.data?.role === 'merchant', `role=${profile.data?.role}`);

  // Merchant assets (previously 404'd due to wrong mount path)
  const assets = await req('GET', '/merchant/assets', null, merchantToken);
  assert('GET /merchant/assets success (fixed mount)', assets.success === true, `status=${assets.status} msg=${assets.message}`);
  assert('merchant assets returns array', Array.isArray(assets.data));

  // Merchant staff (previously 404'd)
  const staff = await req('GET', '/merchant/staff', null, merchantToken);
  assert('GET /merchant/staff success (fixed mount)', staff.success === true, `msg=${staff.message}`);

  // Merchant dues (previously 404'd)
  const dues = await req('GET', '/merchant/dues', null, merchantToken);
  assert('GET /merchant/dues success (fixed mount)', dues.success === true, `msg=${dues.message}`);

  // Merchant tax-rates (previously 404'd)
  const tax = await req('GET', '/merchant/tax-rates', null, merchantToken);
  assert('GET /merchant/tax-rates success (fixed mount)', tax.success === true, `msg=${tax.message}`);

  // Merchant subscription
  const plans = await req('GET', '/merchant/subscription/plans', null, merchantToken);
  assert('GET /merchant/subscription/plans success', plans.success === true, `msg=${plans.message}`);

  // Merchant ads
  const ads = await req('GET', '/merchant/ads', null, merchantToken);
  assert('GET /merchant/ads success', ads.success === true, `msg=${ads.message}`);
}

// ─── FLOW 9: Referral — transaction records ──────────────────
async function testReferral() {
  console.log('\n══ FLOW 9: Referral Code ══');

  const referralInfo = await req('GET', '/user/referral', null, userToken);
  assert('GET /user/referral success', referralInfo.success === true);
  assert('referral returns code', !!referralInfo.data?.referralCode);

  // New user uses referral code
  const referrer = await req('GET', '/user/referral', null, merchantToken);
  const code = referrer.data?.referralCode;

  if (code) {
    const newUserPayload = {
      fullName: 'Referral Test User',
      email: `ref_test_${Date.now()}@vips.test`,
      phone: `02${Date.now()}`.slice(0, 12),
      password: 'RefPass123',
      role: 'customer',
    };
    const regNew = await req('POST', '/auth/register', newUserPayload);
    const newToken = regNew.data?.token;

    if (newToken) {
      const useRef = await req('POST', '/user/referral/use', { code }, newToken);
      assert('POST /user/referral/use success', useRef.success === true, `msg=${useRef.message}`);
      assert('referral/use returns newBalance', useRef.data?.newBalance !== undefined, `data=${JSON.stringify(useRef.data)}`);

      // Verify transaction records were created for both users
      const newUserTx = await req('GET', '/user/transactions', null, newToken);
      assert('referral created TX record for new user', newUserTx.data?.transactions?.some?.((t) => t.description?.includes('Referral')),
        `txCount=${newUserTx.data?.transactions?.length}`);
    }
  }
}

// ─── FLOW 10: Send Gift → Transaction audit trail ─────────────
async function testGiftSend() {
  console.log('\n══ FLOW 10: Gift Send ══');

  // Seed points, then convert to walletBalance — 5000 pts × 0.01 = 50 TND balance
  await seedWalletPoints(userId, 10000);
  await req('POST', '/user/vips-club/convert', { points: 5000 }, userToken);

  const txsBefore = await req('GET', '/user/transactions', null, userToken);
  const countBefore = txsBefore.data?.transactions?.length ?? 0;

  // §4.3 forbids moving value between accounts, and §7 rests the platform's
  // central-bank exemption on that. This used to transfer walletBalance —
  // dinars topped up through a payment gateway — between customers.
  const send = await req('POST', '/rewards/send-gift', {
    recipientPhone: TEST_MERCHANT.phone,
    amount: 5,
    message: 'Happy testing!',
  }, userToken);
  assert('balance can no longer be sent between accounts',
    send.status === 410, `${send.status}`);
  assert('and the caller is pointed at gifting an offer',
    send.code === 'USE_GIFT_OFFER', String(send.code));

  // The sanctioned alternative: buy an offer in a friend's name. Points
  // leave the buyer and the friend receives a voucher — no balance moves.
  // The recipient has to be a consumer account: a gifted offer is something
  // a customer redeems, and a merchant account has nothing to redeem it in.
  const friendPhone = _uniquePhone('4');
  await seedUser({
    fullName: 'Gift Recipient',
    email: `gift_friend_${Date.now()}@vips.test`,
    phone: friendPhone,
    password: 'FriendPass123',
    role: 'customer',
  });

  const balBefore = (await req('GET', '/user/wallet', null, userToken)).data?.points ?? 0;
  const gift = await req('POST', '/rewards/gift-offer', {
    recipientPhone: friendPhone,
    points: 200,
    message: 'Happy testing!',
  }, userToken);

  if (balBefore >= 200) {
    assert('an offer can be gifted to a friend', gift.success === true, gift.message);
    assert('the gift costs the buyer their own points',
      gift.data?.newBalance === balBefore - 200,
      `${balBefore} - 200 vs ${gift.data?.newBalance}`);
    assert('the friend receives a redeemable code',
      typeof gift.data?.code === 'string' && gift.data.code.startsWith('GIFT-'),
      String(gift.data?.code));
    assert('200 points is stated as 2 TND of value',
      gift.data?.valueTnd === 2, String(gift.data?.valueTnd));

    const txsAfter = await req('GET', '/user/transactions', null, userToken);
    const countAfter = txsAfter.data?.transactions?.length ?? 0;
    assert('gifting an offer is recorded', countAfter > countBefore,
      `before=${countBefore} after=${countAfter}`);
  } else {
    assert('gifting more points than you hold is refused',
      gift.success === false, gift.message);
  }

  const self = await req('POST', '/rewards/gift-offer', {
    recipientPhone: TEST_USER.phone, points: 10,
  }, userToken);
  assert('a gift cannot be sent to yourself', self.status === 400, `${self.status}`);
}

// ─── Runner ──────────────────────────────────────────────────

// ─── FLOW 11: Admin console ──────────────────────────────────
async function testAdmin() {
  console.log('\n══ FLOW 11: Admin console ══');

  const adminEmail = `qa_admin_${ts}@vips.test`;
  const adminPassword = 'AdminPassword123';
  adminId = await seedAdmin({
    fullName: 'QA Admin',
    email: adminEmail,
    phone: String(ts + 2).slice(-9).padStart(9, '9'),
    password: adminPassword,
  });

  // ── Auth gate ──
  const asCustomer = await req('POST', '/admin/login', {
    email: TEST_USER.email,
    password: TEST_USER.password,
  });
  assert('admin login rejects a valid customer account', asCustomer.status === 401,
    `status ${asCustomer.status}`);

  const wrongPass = await req('POST', '/admin/login', {
    email: adminEmail,
    password: 'not-the-password',
  });
  assert('admin login rejects a wrong password', wrongPass.status === 401);

  const login = await req('POST', '/admin/login', {
    email: adminEmail,
    password: adminPassword,
  });
  assert('admin login succeeds', login.success === true && !!login.data?.token);
  adminToken = login.data?.token;

  const noToken = await req('GET', '/admin/dashboard/stats');
  assert('admin routes reject an anonymous request', noToken.status === 401);

  const customerToken = await req('GET', '/admin/dashboard/stats', null, userToken);
  assert('admin routes reject a customer token', customerToken.status === 403,
    `status ${customerToken.status}`);

  const me = await req('GET', '/admin/me', null, adminToken);
  assert('GET /admin/me returns the signed-in admin',
    me.success === true && me.data?.user?.role === 'admin');

  // ── Dashboard ──
  const stats = await req('GET', '/admin/dashboard/stats', null, adminToken);
  assert('dashboard stats returns every section',
    stats.success === true &&
    typeof stats.data?.users?.total === 'number' &&
    typeof stats.data?.merchants?.total === 'number' &&
    typeof stats.data?.orders?.total === 'number' &&
    typeof stats.data?.revenue?.total === 'number');

  const charts = await req('GET', '/admin/dashboard/charts?days=7', null, adminToken);
  assert('dashboard charts fills every day in the window',
    charts.success === true && Array.isArray(charts.data?.series) &&
    charts.data.series.length === 7,
    `got ${charts.data?.series?.length}`);

  const recent = await req('GET', '/admin/dashboard/recent?limit=3', null, adminToken);
  assert('dashboard recent activity returns its four lists',
    recent.success === true &&
    Array.isArray(recent.data?.orders) &&
    Array.isArray(recent.data?.users) &&
    Array.isArray(recent.data?.merchants) &&
    Array.isArray(recent.data?.pendingRegistrations));

  // ── Users ──
  const users = await req('GET', '/admin/users?limit=5', null, adminToken);
  assert('users list is paginated',
    users.success === true && Array.isArray(users.data?.items) &&
    typeof users.data?.total === 'number' && typeof users.data?.pages === 'number');

  const searched = await req(
    'GET', `/admin/users?search=${encodeURIComponent(TEST_USER.email)}`, null, adminToken);
  assert('users search finds the test customer by email',
    searched.data?.items?.some((u) => u.email === TEST_USER.email));

  const userDetail = await req('GET', `/admin/users/${userId}`, null, adminToken);
  assert('user details include the order/spend summary',
    userDetail.success === true &&
    typeof userDetail.data?.stats?.orders === 'number' &&
    typeof userDetail.data?.stats?.totalSpent === 'number');

  const badId = await req('GET', '/admin/users/not-an-object-id', null, adminToken);
  assert('a malformed id is a 400, not a 500', badId.status === 400,
    `status ${badId.status}`);

  // ── Ban must actually lock the account out, not just flag it ──
  const ban = await req('PUT', `/admin/users/${userId}/ban`, { banned: true }, adminToken);
  assert('banning a user succeeds', ban.success === true &&
    ban.data?.user?.isActive === false);

  const bannedLogin = await req('POST', '/auth/login', {
    email: TEST_USER.email,
    password: TEST_USER.password,
  });
  assert('a banned user can no longer log in', bannedLogin.status === 403,
    `status ${bannedLogin.status}`);

  const unban = await req('PUT', `/admin/users/${userId}/ban`, { banned: false }, adminToken);
  assert('reinstating a user succeeds', unban.success === true &&
    unban.data?.user?.isActive === true);

  const reinstatedLogin = await req('POST', '/auth/login', {
    email: TEST_USER.email,
    password: TEST_USER.password,
  });
  assert('a reinstated user can log in again', reinstatedLogin.success === true);

  const badRole = await req('PUT', `/admin/users/${userId}/role`, { role: 'wizard' }, adminToken);
  assert('an unknown role is rejected', badRole.status === 400);

  const selfDelete = await req('DELETE', `/admin/users/${adminId}`, null, adminToken);
  assert('an admin cannot delete their own account', selfDelete.status === 400);

  // ── Merchants ──
  const merchants = await req('GET', '/admin/merchants?limit=5', null, adminToken);
  assert('merchants list carries an approval status per row',
    merchants.success === true && Array.isArray(merchants.data?.items) &&
    merchants.data.items.every((m) => typeof m.approvalStatus === 'string'));

  const merchantDetail = await req('GET', `/admin/merchants/${merchantId}`, null, adminToken);
  assert('merchant details include the sales summary',
    merchantDetail.success === true &&
    typeof merchantDetail.data?.stats?.revenue === 'number' &&
    typeof merchantDetail.data?.stats?.products === 'number');

  const deactivate = await req(
    'PUT', `/admin/merchants/${merchantId}/activate`, { active: false }, adminToken);
  assert('deactivating a merchant succeeds',
    deactivate.success === true && deactivate.data?.merchant?.isActive === false);

  const reactivate = await req(
    'PUT', `/admin/merchants/${merchantId}/activate`, { active: true }, adminToken);
  assert('reactivating a merchant succeeds',
    reactivate.success === true && reactivate.data?.merchant?.isActive === true);

  // ── Orders ──
  const orders = await req('GET', '/admin/orders?limit=5', null, adminToken);
  assert('orders list joins the customer and merchant names',
    orders.success === true && Array.isArray(orders.data?.items) &&
    typeof orders.data?.statusCounts === 'object');

  if (orderId) {
    const orderDetail = await req('GET', `/admin/orders/${orderId}`, null, adminToken);
    assert('order details load', orderDetail.success === true &&
      !!orderDetail.data?.order);

    const badStatus = await req(
      'PUT', `/admin/orders/${orderId}/status`, { status: 'teleported' }, adminToken);
    assert('an off-enum order status is rejected', badStatus.status === 400);

    const setStatus = await req(
      'PUT', `/admin/orders/${orderId}/status`, { status: 'confirmed' }, adminToken);
    assert('an order status update stamps its timestamp',
      setStatus.success === true && !!setStatus.data?.order?.confirmedAt);
  }

  // ── Inventory ──
  const inventory = await req('GET', '/admin/inventory?limit=5', null, adminToken);
  assert('inventory list reports platform totals',
    inventory.success === true && Array.isArray(inventory.data?.items) &&
    typeof inventory.data?.totalValue === 'number');

  // The type chips exist to say how many of each kind there are. Counting
  // them over a filter that includes the type itself zeroed every other chip
  // the moment one was picked — and zeroed "All" too, so the counts claimed
  // the ledger was empty while the list below them showed rows.
  const allMovements = await req('GET', '/admin/inventory/movements?limit=1',
    null, adminToken);
  const typedMovements = await req('GET',
    '/admin/inventory/movements?limit=1&type=adjustment', null, adminToken);
  assert('filtering the ledger by type does not zero the type counts',
    Object.keys(typedMovements.data?.byType || {}).length ===
    Object.keys(allMovements.data?.byType || {}).length,
    `${Object.keys(typedMovements.data?.byType || {}).length} vs ` +
    `${Object.keys(allMovements.data?.byType || {}).length} types`);
  assert('the filtered list itself is still narrowed to that type',
    (typedMovements.data?.items || []).every((m) => m.type === 'adjustment'));

  const alerts = await req('GET', '/admin/inventory/alerts', null, adminToken);
  assert('low-stock alerts cover both stock lines and products',
    alerts.success === true && Array.isArray(alerts.data?.stock) &&
    Array.isArray(alerts.data?.products));

  // ── Reports ──
  for (const name of ['sales', 'profit', 'products', 'customers', 'merchants', 'orders', 'commission']) {
    const report = await req('GET', `/admin/reports/${name}`, null, adminToken);
    assert(`${name} report returns a summary`,
      report.success === true && typeof report.data?.summary === 'object',
      report.message);
  }

  // Sales must count till takings as well as online orders, or POS revenue
  // is invisible in every money figure.
  const salesReport = await req('GET', '/admin/reports/sales', null, adminToken);
  assert('the sales report separates online and POS revenue',
    typeof salesReport.data?.summary?.onlineRevenue === 'number' &&
    typeof salesReport.data?.summary?.posRevenue === 'number' &&
    salesReport.data.summary.revenue ===
      Number((salesReport.data.summary.onlineRevenue +
              salesReport.data.summary.posRevenue).toFixed(3)),
    JSON.stringify(salesReport.data?.summary));

  for (const groupBy of ['day', 'week', 'month', 'year']) {
    const grouped = await req('GET', `/admin/reports/sales?groupBy=${groupBy}`, null, adminToken);
    assert(`sales can be grouped by ${groupBy}`,
      grouped.success === true && grouped.data?.groupBy === groupBy);
  }

  const badGroup = await req('GET', '/admin/reports/sales?groupBy=fortnight', null, adminToken);
  assert('an unknown groupBy falls back to day rather than erroring',
    badGroup.success === true && badGroup.data?.groupBy === 'day');

  // The profit report must never present a margin it cannot back up.
  const profit = await req('GET', '/admin/reports/profit', null, adminToken);
  const ps = profit.data?.summary || {};
  assert('profit reports how much of revenue has a known cost',
    typeof ps.costCoverage === 'number' && ps.costCoverage >= 0 && ps.costCoverage <= 100,
    `coverage ${ps.costCoverage}`);
  assert('the margin is computed over costed revenue, not all revenue',
    ps.costedRevenue <= ps.revenue &&
    (ps.costedRevenue === 0
      ? ps.margin === 0
      : Math.abs(ps.margin - (ps.grossProfit / ps.costedRevenue) * 100) < 0.01),
    JSON.stringify(ps));

  // Commission explains a small total instead of letting it read as bad sales.
  const commission = await req('GET', '/admin/reports/commission', null, adminToken);
  const cs = commission.data?.summary || {};
  assert('commission reports how many merchants are on a zero rate',
    typeof cs.merchantsOnZeroRate === 'number' &&
    typeof cs.merchantsWithRateSet === 'number');
  assert('commission never exceeds the revenue it is taken from',
    cs.commission <= cs.revenue &&
    Math.abs((cs.commission + cs.merchantEarnings) - cs.revenue) < 0.01,
    JSON.stringify(cs));

  // Export
  const csv = await (async () => {
    const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));
    const r = await fetch(`${BASE_URL}/admin/reports/export?type=commission&format=csv`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    return { status: r.status, type: r.headers.get('content-type'),
             disposition: r.headers.get('content-disposition'), body: await r.text() };
  })();
  assert('CSV export returns a downloadable file',
    csv.status === 200 &&
    (csv.type || '').includes('text/csv') &&
    (csv.disposition || '').includes('attachment'),
    `${csv.status} ${csv.type}`);
  assert('the CSV has a header row and quoted fields',
    csv.body.includes('"Merchant"') && csv.body.includes('"Commission (TND)"'),
    csv.body.slice(0, 120));

  const badExport = await req('GET', '/admin/reports/export?type=nonsense', null, adminToken);
  assert('an unknown export type is rejected', badExport.status === 400);

  const pdfExport = await req('GET', '/admin/reports/export?type=sales&format=pdf', null, adminToken);
  assert('PDF export says so plainly rather than returning a mislabelled CSV',
    pdfExport.status === 400 && /csv/i.test(pdfExport.message || ''));

  // ── Top bar: notifications and global search ──
  const notifications = await req('GET', '/admin/notifications', null, adminToken);
  assert('notifications return actionable items with a route',
    notifications.success === true && Array.isArray(notifications.data?.items) &&
    notifications.data.items.every((i) =>
      typeof i.count === 'number' && i.count > 0 && typeof i.title === 'string'),
    'an item with a zero count should be filtered out entirely');

  assert('the notification badge counts distinct backlogs, not rows',
    notifications.data?.total === notifications.data?.items?.length);

  const search = await req('GET', `/admin/search?q=${encodeURIComponent('QA')}`, null, adminToken);
  assert('global search spans users, merchants and orders',
    search.success === true && Array.isArray(search.data?.users) &&
    Array.isArray(search.data?.merchants) && Array.isArray(search.data?.orders));

  const shortSearch = await req('GET', '/admin/search?q=Q', null, adminToken);
  assert('a one-character search is an empty result, not an error',
    shortSearch.success === true && shortSearch.data?.total === 0);

  const orderSearch = await req('GET', '/admin/search?q=1059', null, adminToken);
  assert('searching an order number finds that order',
    orderSearch.data?.orders?.some((o) => o.orderNumber === 1059),
    JSON.stringify(orderSearch.data?.orders?.map((o) => o.orderNumber)));

  const searchNoToken = await req('GET', '/admin/search?q=QA');
  assert('search is admin-gated', searchNoToken.status === 401);

  // ── Inventory: ledger, transfers, locations ──
  const movementsBefore = await req('GET', '/admin/inventory/movements', null, adminToken);
  assert('the stock ledger is readable', movementsBefore.success === true &&
    Array.isArray(movementsBefore.data?.items));

  // Create a stock line as the merchant, so the ledger is proven to capture
  // merchant-side changes and not only admin ones.
  const stockLine = await req('POST', '/merchant/stock', {
    name: `Ledger Item ${ts}`,
    category: 'Supplies',
    currentStock: 60,
    lowStockThreshold: 10,
    unitPrice: 2.5,
  }, merchantToken);
  assert('merchant can create a stock line', stockLine.success === true);
  const stockId = stockLine.data?._id;

  const afterCreate = await req('GET', `/admin/inventory/movements?stockId=${stockId}`, null, adminToken);
  assert('creating a stock line writes an opening movement',
    afterCreate.data?.items?.some((m) => m.type === 'initial' && m.balanceAfter === 60));

  await req('PUT', `/merchant/stock/${stockId}`, { currentStock: 45 }, merchantToken);
  const afterDecrease = await req('GET', `/admin/inventory/movements?stockId=${stockId}`, null, adminToken);
  assert('a merchant stock decrease is recorded as an "out" with real balances',
    afterDecrease.data?.items?.some(
      (m) => m.type === 'out' && m.quantity === 15 && m.balanceBefore === 60 && m.balanceAfter === 45));

  // A rename is not a stock movement — the ledger must not fill with no-ops.
  const beforeRename = afterDecrease.data?.total;
  await req('PUT', `/merchant/stock/${stockId}`, { name: `Renamed ${ts}` }, merchantToken);
  const afterRename = await req('GET', `/admin/inventory/movements?stockId=${stockId}`, null, adminToken);
  assert('a rename writes no movement', afterRename.data?.total === beforeRename,
    `${beforeRename} -> ${afterRename.data?.total}`);

  // Transfers
  const transfer = await req('POST', '/admin/inventory/transfer', {
    fromStockId: stockId,
    toLocation: `Depot ${ts}`,
    quantity: 20,
    // Unique per run: an earlier run's rows carry the same text, and the
    // search below would otherwise match those too.
    reason: `Integration test transfer ${ts}`,
  }, adminToken);
  assert('a transfer to a new location succeeds', transfer.success === true);
  assert('the transfer opens the destination line at the moved quantity',
    transfer.data?.to?.currentStock === 20 && transfer.data?.from?.currentStock === 25);

  const bothHalves = await req(
    'GET', `/admin/inventory/movements?search=${encodeURIComponent(`Integration test transfer ${ts}`)}`,
    null, adminToken);
  const refs = (bothHalves.data?.items || []).map((m) => m.reference);
  assert('both halves of the transfer share one reference',
    refs.length === 2 && refs[0] === refs[1] && !!refs[0], JSON.stringify(refs));

  const overTransfer = await req('POST', '/admin/inventory/transfer', {
    fromStockId: stockId, toLocation: `Depot2 ${ts}`, quantity: 99999,
  }, adminToken);
  assert('a transfer larger than the balance on hand is refused',
    overTransfer.status === 409, `status ${overTransfer.status}`);

  const zeroTransfer = await req('POST', '/admin/inventory/transfer', {
    fromStockId: stockId, toLocation: `Depot3 ${ts}`, quantity: 0,
  }, adminToken);
  assert('a zero-quantity transfer is refused', zeroTransfer.status === 400);

  const sameLocation = await req('POST', '/admin/inventory/transfer', {
    fromStockId: stockId, toLocation: 'Main', quantity: 1,
  }, adminToken);
  assert('a transfer to the source location is refused', sameLocation.status === 400);

  const locations = await req('GET', '/admin/inventory/locations', null, adminToken);
  assert('locations are derived from stock that actually exists',
    locations.success === true &&
    locations.data?.items?.some((l) => l.location === `Depot ${ts}` && l.units === 20));

  const byLocation = await req(
    'GET', `/admin/inventory?location=${encodeURIComponent(`Depot ${ts}`)}`, null, adminToken);
  assert('inventory can be filtered to one location',
    byLocation.data?.items?.every((i) => i.location === `Depot ${ts}`) &&
    byLocation.data?.total === 1);

  const badTransfer = await req('POST', '/admin/inventory/transfer', {
    fromStockId: 'not-an-id', toLocation: 'X', quantity: 1,
  }, adminToken);
  assert('a malformed source id is a 400', badTransfer.status === 400);

  // ── POS: session, cart, invoice, refund ──
  const noSession = await req('GET', '/admin/pos/cart', null, adminToken);
  assert('the cart is refused with no open till', noSession.status === 409);

  const posMerchantId = merchantId;
  const startTill = await req('POST', '/admin/pos/session/start',
    { merchantId: posMerchantId, openingFloat: 50 }, adminToken);
  assert('a till session opens', startTill.success === true);

  const doubleTill = await req('POST', '/admin/pos/session/start',
    { merchantId: posMerchantId }, adminToken);
  assert('a second open till is refused', doubleTill.status === 409);

  // Give the merchant a product with known price and stock to sell.
  const posProduct = await req('POST', '/merchant/products', {
    name: `POS Widget ${ts}`,
    price: 10,
    category: 'Food',
    stock: 8,
    vat: 0,
  }, merchantToken);
  const posProductId = posProduct.data?._id || posProduct.data?.product?._id;
  assert('a sellable product exists for the till', !!posProductId,
    JSON.stringify(posProduct).slice(0, 160));

  // POST /merchant/products ignores `stock` (it is only in the update
  // whitelist), so the opening quantity has to be set with a follow-up PUT
  // or the till has nothing to sell.
  const stocked = await req('PUT', `/merchant/products/${posProductId}`,
    { stock: 8 }, merchantToken);
  assert('opening stock can be set on the product', stocked.data?.stock === 8,
    `stock ${stocked.data?.stock}`);

  if (posProductId) {
    const overStock = await req('POST', '/admin/pos/cart/add',
      { productId: posProductId, quantity: 99 }, adminToken);
    assert('adding more than the stock on hand is refused', overStock.status === 409);

    const added = await req('POST', '/admin/pos/cart/add',
      { productId: posProductId, quantity: 3 }, adminToken);
    assert('a product can be rung up', added.success === true);
    // The price comes from the Product document, never the request — the
    // same hole that let a D 12.500 item be ordered for D 0.001.
    assert('the line is priced from the catalogue, not the client',
      added.data?.totals?.subtotal === 30, JSON.stringify(added.data?.totals));

    const badDiscount = await req('POST', '/admin/pos/cart/discount',
      { amount: 150, type: 'percentage' }, adminToken);
    assert('a discount over 100% is refused', badDiscount.status === 400);

    const discounted = await req('POST', '/admin/pos/cart/discount',
      { amount: 10, type: 'percentage' }, adminToken);
    assert('a percentage discount is applied to the subtotal',
      discounted.data?.totals?.discount === 3 && discounted.data?.totals?.total === 27,
      JSON.stringify(discounted.data?.totals));

    await req('POST', '/admin/pos/cart/customer',
      { name: 'Walk In Tester', phone: `9${ts}`.slice(0, 9) }, adminToken);

    const shortCash = await req('POST', '/admin/pos/invoice/create',
      { paymentMethod: 'cash', amountPaid: 1 }, adminToken);
    assert('cash below the total is refused', shortCash.status === 400);

    const invoice = await req('POST', '/admin/pos/invoice/create',
      { paymentMethod: 'cash', amountPaid: 50 }, adminToken);
    assert('the sale completes', invoice.success === true);
    assert('the invoice number follows POS-YYMMDD-NNNN',
      /^POS-\d{6}-\d{4}$/.test(invoice.data?.invoice?.invoiceNumber || ''),
      invoice.data?.invoice?.invoiceNumber);
    assert('change due is computed from the cash tendered',
      invoice.data?.invoice?.changeDue === 23, `${invoice.data?.invoice?.changeDue}`);

    const emptied = await req('GET', '/admin/pos/cart', null, adminToken);
    assert('the cart is emptied by the sale', emptied.data?.items?.length === 0);

    const afterSale = await req('GET', `/admin/inventory?search=${encodeURIComponent(`POS Widget ${ts}`)}`, null, adminToken);
    void afterSale; // stock lives on Product, checked below via the catalogue

    const invoiceId = invoice.data?.invoice?._id;

    const noReason = await req('POST', '/admin/pos/invoice/refund',
      { invoiceId }, adminToken);
    assert('a refund without a reason is refused', noReason.status === 400);

    const refunded = await req('POST', '/admin/pos/invoice/refund',
      { invoiceId, reason: 'Integration test refund' }, adminToken);
    assert('a refund succeeds', refunded.success === true);

    const doubleRefund = await req('POST', '/admin/pos/invoice/refund',
      { invoiceId, reason: 'again' }, adminToken);
    assert('a second refund on the same invoice is refused', doubleRefund.status === 409);

    const invoices = await req('GET', `/admin/pos/invoices?search=${encodeURIComponent(`POS Widget ${ts}`)}`, null, adminToken);
    assert('a refunded invoice is excluded from the sales total',
      invoices.data?.totals?.sales === 0 && invoices.data?.totals?.refunded === 27,
      JSON.stringify(invoices.data?.totals));
  }

  const closeTill = await req('POST', '/admin/pos/session/end', { closingCount: 50 }, adminToken);
  assert('the till closes and reconciles', closeTill.success === true);
  assert('a fully refunded day leaves the float intact',
    closeTill.data?.expectedCash === 50 && closeTill.data?.difference === 0,
    JSON.stringify({ e: closeTill.data?.expectedCash, d: closeTill.data?.difference }));

  // ── Roles and permissions ──
  const profile = await req('GET', '/admin/me', null, adminToken);
  assert('/me reports the admin role and effective permissions',
    typeof profile.data?.adminRole === 'string' && Array.isArray(profile.data?.permissions));

  const catalogue = await req('GET', '/admin/permissions', null, adminToken);
  // Asserted against the module itself rather than a number written here: a
  // hardcoded count fails every time a module is added, which trains whoever
  // sees it to bump the number instead of checking what changed.
  const perms = require('../middleware/permissions');
  assert('the API serves exactly the catalogue the permissions module defines',
    catalogue.success === true &&
    catalogue.data?.modules?.length === perms.MODULES.length &&
    catalogue.data?.builtInRoles?.length === perms.ROLES.length &&
    catalogue.data.permissions.length === perms.ALL_PERMISSIONS.length,
    `${catalogue.data?.modules?.length}/${perms.MODULES.length} modules, ` +
    `${catalogue.data?.builtInRoles?.length}/${perms.ROLES.length} roles, ` +
    `${catalogue.data?.permissions?.length}/${perms.ALL_PERMISSIONS.length} permissions`);

  assert('every module contributes at least one permission',
    perms.MODULES.every((m) =>
      perms.ALL_PERMISSIONS.some((p) => p.startsWith(`${m}.`))),
    'a module with no actions would show as an empty column in the matrix');

  assert('every permission carries a label and an enforcement flag',
    (catalogue.data?.catalogue || []).every(
      (c) => typeof c.label === 'string' && typeof c.enforced === 'boolean'));

  // A permission that gates no route is declared as such rather than being
  // presented as a grant that does something.
  const unenforced = (catalogue.data?.catalogue || []).filter((c) => !c.enforced);
  assert('permissions that gate nothing say why',
    unenforced.length > 0 && unenforced.every((c) => c.reason.length > 0),
    JSON.stringify(unenforced.map((c) => c.key)));

  // A viewer is the real test of the gate: read everything, change nothing.
  const viewerEmail = `viewer_${ts}@vips.test`;
  const viewerCreated = await req('POST', '/admin/staff', {
    fullName: 'QA Viewer',
    email: viewerEmail,
    phone: `77${ts}`.slice(0, 12),
    password: 'ViewerPass1',
    adminRole: 'viewer',
  }, adminToken);
  assert('a viewer account can be created', viewerCreated.success === true,
    viewerCreated.message);

  const viewerLogin = await req('POST', '/admin/login',
    { email: viewerEmail, password: 'ViewerPass1' });
  const viewerToken = viewerLogin.data?.token;
  assert('the viewer can sign in', !!viewerToken);

  const viewerRead = await req('GET', '/admin/users?limit=1', null, viewerToken);
  assert('a viewer can read users', viewerRead.success === true);

  const viewerBan = await req('PUT', `/admin/users/${userId}/ban`, { banned: true }, viewerToken);
  assert('a viewer cannot ban', viewerBan.status === 403, `status ${viewerBan.status}`);

  const viewerDelete = await req('DELETE', `/admin/users/${userId}`, null, viewerToken);
  assert('a viewer cannot delete', viewerDelete.status === 403);

  const viewerStaff = await req('POST', '/admin/staff', {
    fullName: 'x', email: `x${ts}@y.z`, phone: `78${ts}`.slice(0, 12), password: 'abcdef',
  }, viewerToken);
  assert('a viewer cannot create staff', viewerStaff.status === 403);

  // The hole this caught the first time: the POS mount only checked
  // pos.read, so a read-only account could open a till and take money.
  const viewerTill = await req('POST', '/admin/pos/session/start',
    { merchantId }, viewerToken);
  assert('a viewer cannot open a till', viewerTill.status === 403,
    `status ${viewerTill.status}`);

  // Under the expanded model the viewer role carries no POS permission at
  // all — reading till receipts means reading takings, which is not part of
  // a read-only observer's remit.
  const viewerReceipts = await req('GET', '/admin/pos/invoices?limit=1', null, viewerToken);
  assert('a viewer cannot read till receipts', viewerReceipts.status === 403,
    `status ${viewerReceipts.status}`);

  // A manager writes but never deletes.
  const managerEmail = `manager_${ts}@vips.test`;
  await req('POST', '/admin/staff', {
    fullName: 'QA Manager',
    email: managerEmail,
    phone: `79${ts}`.slice(0, 12),
    password: 'ManagerPass1',
    adminRole: 'manager',
  }, adminToken);
  const managerToken = (await req('POST', '/admin/login',
    { email: managerEmail, password: 'ManagerPass1' })).data?.token;

  const managerBan = await req('PUT', `/admin/users/${userId}/ban`, { banned: false }, managerToken);
  assert('a manager can write', managerBan.success === true);

  const managerDelete = await req('DELETE', `/admin/users/${userId}`, null, managerToken);
  assert('a manager cannot delete', managerDelete.status === 403);

  const managerStaff = await req('POST', '/admin/staff', {
    fullName: 'y', email: `y${ts}@y.z`, phone: `80${ts}`.slice(0, 12), password: 'abcdef',
  }, managerToken);
  assert('a manager cannot manage staff', managerStaff.status === 403);

  // Only a super admin may mint another super admin.
  const escalate = await req('POST', '/admin/staff', {
    fullName: 'Escalation',
    email: `esc_${ts}@vips.test`,
    phone: `81${ts}`.slice(0, 12),
    password: 'EscPass1234',
    adminRole: 'super_admin',
  }, adminToken);
  assert('a plain admin cannot create a super admin', escalate.status === 403,
    `status ${escalate.status}`);

  const badPermission = await req('PUT', `/admin/staff/${viewerCreated.data?.staff?._id}`,
    { permissions: ['orders.teleport'] }, adminToken);
  assert('an unknown permission string is rejected', badPermission.status === 400);

  const grant = await req('PUT', `/admin/staff/${viewerCreated.data?.staff?._id}`,
    { permissions: ['orders.cancel'] }, adminToken);
  assert('an extra permission can be granted on top of a role',
    grant.success === true &&
    grant.data?.effectivePermissions?.includes('orders.cancel'));

  const retiredName = await req('PUT', `/admin/staff/${viewerCreated.data?.staff?._id}`,
    { permissions: ['orders.write'] }, adminToken);
  assert('a permission name from the old three-action model is rejected',
    retiredName.status === 400, `status ${retiredName.status}`);

  // ── Per-action boundaries ──
  const cashierEmail = `cashier_${ts}@vips.test`;
  await req('POST', '/admin/staff', {
    fullName: 'QA Cashier',
    email: cashierEmail,
    phone: `82${ts}`.slice(0, 12),
    password: 'CashierPass1',
    adminRole: 'cashier',
  }, adminToken);
  const cashierToken = (await req('POST', '/admin/login',
    { email: cashierEmail, password: 'CashierPass1' })).data?.token;
  assert('a cashier can sign in', !!cashierToken);

  const cashierProducts = await req('GET', '/admin/products?limit=1', null, cashierToken);
  assert('a cashier can read the catalogue', cashierProducts.success === true);

  const cashierTill = await req('POST', '/admin/pos/session/start',
    { merchantId }, cashierToken);
  // A cashier who cannot open a till cannot do the job at all, so the role
  // carries open_session and close_session.
  assert('a cashier can open a till', cashierTill.success === true, cashierTill.message);
  await req('POST', '/admin/pos/session/end', { closingCount: 0 }, cashierToken);

  const cashierRefund = await req('POST', '/admin/pos/invoice/refund',
    { invoiceId: '6a94b0000000000000000000', reason: 'x' }, cashierToken);
  assert('a cashier cannot refund', cashierRefund.status === 403);

  const cashierUsers = await req('GET', '/admin/users?limit=1', null, cashierToken);
  assert('a cashier cannot read customers', cashierUsers.status === 403);

  const cashierReports = await req('GET', '/admin/reports/sales', null, cashierToken);
  assert('a cashier cannot read reports', cashierReports.status === 403);

  // Ban and unban are separate grants on one endpoint, so the direction the
  // body asks for is what gets checked.
  const managerBanDirection = await req('PUT', `/admin/users/${userId}/ban`,
    { banned: true }, managerToken);
  assert('a manager can ban', managerBanDirection.success === true);
  await req('PUT', `/admin/users/${userId}/ban`, { banned: false }, managerToken);

  const managerProductCreate = await req('POST', '/admin/products', {
    merchantId, name: `Blocked ${ts}`, price: 1, category: 'Food',
  }, managerToken);
  assert('a manager cannot create a product', managerProductCreate.status === 403);

  const managerAssignRole = await req('PUT',
    `/admin/staff/${viewerCreated.data?.staff?._id}`, { adminRole: 'admin' }, managerToken);
  assert('a manager cannot assign a role', managerAssignRole.status === 403);

  // Reading a report and taking the data out of the system are separate
  // decisions, so a read-only account cannot export a customer list.
  const viewerExport = await req('GET',
    '/admin/reports/export?type=sales&format=csv', null, viewerToken);
  assert('a viewer cannot export', viewerExport.status === 403,
    `status ${viewerExport.status}`);

  const viewerReport = await req('GET', '/admin/reports/sales', null, viewerToken);
  assert('a viewer can still read a report', viewerReport.success === true);

  // ── Admin products ──
  const productCreated = await req('POST', '/admin/products', {
    merchantId, name: `Admin Product ${ts}`, price: 9.5, category: 'Food', costPrice: 4,
  }, adminToken);
  assert('an admin can add a product to a catalogue', productCreated.success === true,
    productCreated.message);
  const adminProductId = productCreated.data?.product?._id;

  const badDiscount = await req('PUT', `/admin/products/${adminProductId}`,
    { discountPrice: 99 }, adminToken);
  assert('a discount above the list price is rejected', badDiscount.status === 400);

  const priced = await req('PUT', `/admin/products/${adminProductId}`,
    { discountPrice: 7 }, adminToken);
  assert('a valid discount is accepted', priced.success === true);

  const productRemoved = await req('DELETE', `/admin/products/${adminProductId}`, null, adminToken);
  assert('an unsold product can be deleted', productRemoved.success === true);

  // ── Admin-created customer ──
  const walkIn = await req('POST', '/admin/users', {
    fullName: 'Walk In Customer', phone: `83${ts}`.slice(0, 12),
  }, adminToken);
  assert('an admin can create a customer account', walkIn.success === true,
    walkIn.message);

  // Custom roles
  const customRole = await req('POST', '/admin/roles', {
    name: `qa_role_${ts}`,
    description: 'Integration test role',
    permissions: ['reports.read', 'orders.read'],
  }, adminToken);
  assert('a custom role can be created', customRole.success === true);

  const dupBuiltIn = await req('POST', '/admin/roles',
    { name: 'super_admin', permissions: [] }, adminToken);
  assert('a custom role cannot shadow a built-in name', dupBuiltIn.status === 409);

  const deletedRole = await req('DELETE', `/admin/roles/${customRole.data?.role?._id}`,
    null, adminToken);
  assert('a custom role can be deleted', deletedRole.success === true);

  // ── Platform settings ──
  const settings = await req('GET', '/admin/settings', null, adminToken);
  assert('settings report the admin roster and live integration status',
    settings.success === true && Array.isArray(settings.data?.admins) &&
    typeof settings.data?.integrations?.sendgrid === 'boolean');

  const secondEmail = `qa_admin2_${ts}@vips.test`;
  const created = await req('POST', '/admin/settings/admins', {
    fullName: 'QA Second Admin',
    email: secondEmail,
    phone: String(ts + 3).slice(-9).padStart(9, '8'),
    password: 'SecondAdmin123',
  }, adminToken);
  assert('a second admin can be created from the console', created.success === true);

  const duplicate = await req('POST', '/admin/settings/admins', {
    fullName: 'Dup',
    email: secondEmail,
    phone: String(ts + 4).slice(-9).padStart(9, '8'),
    password: 'SecondAdmin123',
  }, adminToken);
  assert('a duplicate admin email is rejected', duplicate.status === 409);

  const shortPassword = await req('POST', '/admin/settings/admins', {
    fullName: 'Short',
    email: `qa_admin3_${ts}@vips.test`,
    phone: String(ts + 5).slice(-9).padStart(9, '8'),
    password: 'abc',
  }, adminToken);
  assert('a too-short admin password is rejected', shortPassword.status === 400);

  // An operator's name signs every receipt, till session and stock movement
  // they touched. Deleting the account does not remove those rows, it blanks
  // who is on them — so an account with history has to be disabled instead.
  const signedStaff = await req('DELETE', `/admin/staff/${adminId}`, null, adminToken);
  assert('an operator with till or ledger history cannot be deleted',
    signedStaff.status === 400 || signedStaff.status === 409,
    `status ${signedStaff.status}: ${signedStaff.message}`);

  const cleanEmail = `disposable_${ts}@vips.test`;
  const cleanStaff = await req('POST', '/admin/staff', {
    fullName: 'Disposable Operator',
    email: cleanEmail,
    phone: `88${String(ts).slice(-9)}`.slice(0, 12),
    password: 'Disposable123',
    adminRole: 'viewer',
  }, adminToken);
  const cleanId = cleanStaff.data?.staff?._id;
  if (cleanId) {
    const removed = await req('DELETE', `/admin/staff/${cleanId}`, null, adminToken);
    assert('an operator who has signed nothing can still be deleted',
      removed.success === true, removed.message);
  }

  const removeSelf = await req(
    'DELETE', `/admin/settings/admins/${adminId}`, null, adminToken);
  assert('an admin cannot remove their own account', removeSelf.status === 400);

  const secondId = created.data?.user?._id;
  if (secondId) {
    const removed = await req(
      'DELETE', `/admin/settings/admins/${secondId}`, null, adminToken);
    assert('the second admin can be removed', removed.success === true);
  }
}

// ─── FLOW 12: Analytical dashboards ──────────────────────────
async function testDashboards() {
  console.log('\n📊 FLOW 12: Analytical Dashboards');
  if (!adminToken) return assert('admin token available for dashboards', false);

  const BOARDS = ['sales', 'operations', 'finance', 'marketing', 'merchants'];

  for (const name of BOARDS) {
    const board = await req('GET', `/admin/dashboards/${name}`, null, adminToken);
    assert(`the ${name} dashboard returns figures and its window`,
      board.success === true && board.data && typeof board.data.window === 'object' &&
      typeof board.data.window.groupBy === 'string',
      board.message);
  }

  // ── The window ──
  for (const [period, groupBy] of [
    ['today', 'hour'], ['day', 'hour'], ['week', 'day'],
    ['month', 'day'], ['year', 'month'],
  ]) {
    const r = await req('GET', `/admin/dashboards/sales?period=${period}`, null, adminToken);
    assert(`period=${period} groups by ${groupBy}`,
      r.data?.window?.groupBy === groupBy,
      `got ${r.data?.window?.groupBy}`);
  }

  const unknownPeriod = await req('GET', '/admin/dashboards/sales?period=fortnight',
    null, adminToken);
  assert('an unknown period falls back rather than erroring',
    unknownPeriod.success === true && unknownPeriod.data?.window?.period === 'month');

  // An unparseable custom range must not become { $gte: Invalid Date }, which
  // matches nothing and would show an empty board as if there were no sales.
  const badRange = await req('GET',
    '/admin/dashboards/sales?period=custom&startDate=banana', null, adminToken);
  assert('an unparseable custom range falls back to the default window',
    badRange.success === true && badRange.data?.window?.period === 'month',
    JSON.stringify(badRange.data?.window));

  const custom = await req('GET',
    '/admin/dashboards/sales?startDate=2026-08-01&endDate=2026-08-15', null, adminToken);
  assert('a custom range is honoured and reported back',
    custom.data?.window?.period === 'custom' &&
    custom.data.window.startDate.startsWith('2026-08-01') &&
    // Inclusive end date: 2026-08-15 must cover all of that day.
    new Date(custom.data.window.endDate).getTime() >
      new Date('2026-08-15T00:00:00.000Z').getTime(),
    JSON.stringify(custom.data?.window));

  assert('the window names the baseline it compares against',
    typeof custom.data?.window?.comparedWith?.startDate === 'string' &&
    new Date(custom.data.window.comparedWith.endDate) <=
      new Date(custom.data.window.startDate));

  // ── Charts are continuous and reconcile with their headline ──
  const chartChecks = [
    ['sales', 'salesChart', 'totalRevenue'],
    ['sales', 'dailyTrend', 'totalRevenue'],
    ['finance', 'revenueChart', 'totalRevenue'],
  ];
  for (const [board, series, total] of chartChecks) {
    const r = await req('GET', `/admin/dashboards/${board}?period=month`, null, adminToken);
    const points = r.data?.[series] || [];
    const labels = points.map((p) => p.date);
    const sum = Number(points.reduce((acc, p) => acc + p.value, 0).toFixed(3));
    assert(`${board}.${series} has no duplicate buckets`,
      labels.length === new Set(labels).size);
    // A $group omits empty periods, so a line chart would join 19 August to
    // 25 August as if consecutive. Zero-filling is what makes the axis honest.
    assert(`${board}.${series} fills quiet periods rather than skipping them`,
      points.length >= 28, `${points.length} buckets for a 30-day window`);
    assert(`${board}.${series} sums to ${total}`,
      Math.abs(sum - r.data[total]) < 0.01, `${sum} vs ${r.data[total]}`);
  }

  const weekly = await req('GET',
    '/admin/dashboards/sales?startDate=2026-03-05&endDate=2026-08-31', null, adminToken);
  const weekLabels = (weekly.data?.salesChart || []).map((p) => p.date);
  assert('ISO week buckets are generated the way Mongo labels them',
    weekly.data?.window?.groupBy === 'week' &&
    weekLabels.length === new Set(weekLabels).size &&
    weekLabels.every((l) => /^\d{4}-W\d{2}$/.test(l)) &&
    Math.abs(
      Number((weekly.data.salesChart.reduce((a, p) => a + p.value, 0)).toFixed(3)) -
      weekly.data.totalRevenue
    ) < 0.01,
    weekLabels.slice(0, 3).join(','));

  // ── Figures the platform cannot back up ──
  const sales = await req('GET', '/admin/dashboards/sales', null, adminToken);
  assert('conversion rate is reported as untracked, not invented',
    sales.data?.conversionRate === null &&
    typeof sales.data?.conversionRateNote === 'string' &&
    sales.data.conversionRateNote.length > 0);

  assert('revenue splits into online and counter takings that add up',
    Math.abs((sales.data.onlineRevenue + sales.data.posRevenue) -
             sales.data.totalRevenue) < 0.01,
    JSON.stringify({ o: sales.data.onlineRevenue, p: sales.data.posRevenue,
                     t: sales.data.totalRevenue }));

  // Order lines with no product id must not collapse into one fictional
  // product holding the summed revenue of several real ones.
  assert('the product ranking never invents a merged product',
    Array.isArray(sales.data.topProducts) &&
    sales.data.topProducts.every((p) => p.name && p.name !== 'name:') &&
    typeof sales.data.unattributedRevenue === 'number');

  // A ranking that read online orders alone would leave a merchant who sells
  // mostly over the counter absent from a list sitting directly beneath a
  // total that counted them.
  const tillOnly = await req('GET', '/admin/dashboards/sales?period=today', null, adminToken);
  assert('the merchant ranking counts counter sales as well as online orders',
    tillOnly.data.posRevenue === 0 ||
    (tillOnly.data.topMerchants || []).length > 0,
    `pos ${tillOnly.data.posRevenue} but ${(tillOnly.data.topMerchants || []).length} merchants ranked`);
  assert('no merchant is ranked above the revenue the window recorded',
    (sales.data.topMerchants || [])
      .every((m) => m.revenue <= sales.data.totalRevenue + 0.01));

  assert('every change is a number or an explicit null, never a fake zero',
    Object.values(sales.data.change || {})
      .every((v) => v === null || typeof v === 'number'));

  const operations = await req('GET', '/admin/dashboards/operations', null, adminToken);
  const od = operations.data || {};
  const statusTotal = (od.orderStatusDistribution || [])
    .reduce((sum, s) => sum + s.count, 0);
  assert('the status breakdown accounts for every order in the window',
    statusTotal === od.totalOrders, `${statusTotal} vs ${od.totalOrders}`);
  assert('the queue stages never exceed the order count',
    od.pendingOrders + od.inProgressOrders + od.completedOrders + od.cancelledOrders
      <= od.totalOrders);
  assert('fulfilment time is null when nothing was delivered, never zero',
    od.fulfillmentSampleSize > 0
      ? typeof od.averageFulfillmentTime === 'number'
      : od.averageFulfillmentTime === null,
    `sample ${od.fulfillmentSampleSize}, value ${od.averageFulfillmentTime}`);

  const finance = await req('GET', '/admin/dashboards/finance', null, adminToken);
  const fd = finance.data || {};
  assert('the margin is computed over costed revenue, not all revenue',
    fd.costedRevenue <= fd.totalRevenue &&
    (fd.costedRevenue === 0
      ? fd.margin === 0
      : Math.abs(fd.margin - (fd.totalProfit / fd.costedRevenue) * 100) < 0.01),
    JSON.stringify({ c: fd.costedRevenue, r: fd.totalRevenue, m: fd.margin }));
  assert('cost coverage says how much of revenue the margin describes',
    typeof fd.costCoverage === 'number' &&
    fd.costCoverage >= 0 && fd.costCoverage <= 100);
  assert('commission never exceeds the revenue it is taken from',
    fd.totalCommissions <= fd.totalRevenue + 0.01);
  assert('commission by category adds up to the commission total',
    Math.abs((fd.commissionBreakdown || []).reduce((s, c) => s + c.amount, 0) -
             fd.totalCommissions) < 0.01);

  const marketing = await req('GET', '/admin/dashboards/marketing', null, adminToken);
  const md = marketing.data || {};
  assert('churn is null out of an empty cohort rather than 0%',
    md.churnBaseline > 0
      ? typeof md.churnRate === 'number'
      : md.churnRate === null,
    `baseline ${md.churnBaseline}, rate ${md.churnRate}`);
  assert('churn states what it counted',
    typeof md.churnDefinition === 'string' && md.churnDefinition.length > 0);
  // Every customer lands in exactly one segment, so the pie cannot
  // double-count anyone or leave anyone out.
  const segmentTotal = (md.customerSegments || []).reduce((s, x) => s + x.count, 0);
  assert('the customer segments partition the customer base exactly once',
    segmentTotal === md.totalCustomers, `${segmentTotal} vs ${md.totalCustomers}`);

  const merchants = await req('GET', '/admin/dashboards/merchants', null, adminToken);
  const rd = merchants.data || {};
  assert('an unrated merchant carries null, not a zero rating',
    (rd.merchantPerformance || []).every((m) =>
      m.rating === null ? m.ratedOrders === 0 : m.rating > 0));
  assert('cancellation rates are real percentages',
    (rd.merchantPerformance || []).every((m) =>
      m.cancellationRate >= 0 && m.cancellationRate <= 100));
  assert('merchants who sold nothing are counted rather than hidden',
    typeof rd.idleMerchants === 'number' &&
    rd.sellingMerchants + rd.idleMerchants === rd.totalMerchants,
    JSON.stringify({ s: rd.sellingMerchants, i: rd.idleMerchants, t: rd.totalMerchants }));

  // ── Permissions ──
  const roleToken = async (role) => {
    const email = `dash_${role}_${ts}@vips.test`;
    await req('POST', '/admin/staff', {
      fullName: `Dash ${role}`,
      email,
      phone: `9${String(ts + role.length).slice(-10)}`.slice(0, 12),
      password: 'DashPass1234',
      adminRole: role,
    }, adminToken);
    const login = await req('POST', '/admin/login', { email, password: 'DashPass1234' });
    return login.data?.token;
  };

  const dashCashier = await roleToken('cashier');
  const dashViewer = await roleToken('viewer');
  assert('dashboard test roles can sign in', !!dashCashier && !!dashViewer);

  // A till operator must not be able to read the platform's margin,
  // commission or customer base off a dashboard.
  for (const board of ['sales', 'finance', 'marketing', 'merchants']) {
    const r = await req('GET', `/admin/dashboards/${board}`, null, dashCashier);
    assert(`a cashier cannot open the ${board} dashboard`, r.status === 403,
      `status ${r.status}`);
  }
  const cashierOps = await req('GET', '/admin/dashboards/operations', null, dashCashier);
  assert('a cashier can open the operations dashboard', cashierOps.success === true,
    cashierOps.message);

  for (const board of BOARDS) {
    const r = await req('GET', `/admin/dashboards/${board}`, null, dashViewer);
    assert(`a viewer can read the ${board} dashboard`, r.success === true, r.message);
  }
  const viewerDashExport = await req('GET',
    '/admin/dashboards/sales/export?format=csv', null, dashViewer);
  assert('a viewer cannot export a dashboard', viewerDashExport.status === 403,
    `status ${viewerDashExport.status}`);

  // ── Export ──
  const fetchCsv = async (path, token) => {
    const { default: f } = await import('node-fetch').catch(
      () => ({ default: globalThis.fetch }));
    const r = await f(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, type: r.headers.get('content-type'),
             disposition: r.headers.get('content-disposition'), body: await r.text() };
  };

  const EXPECTED_HEADER = {
    sales: '"Product"',
    operations: '"Status"',
    finance: '"Category"',
    marketing: '"Customer"',
    merchants: '"Merchant"',
  };
  for (const board of BOARDS) {
    const csv = await fetchCsv(`/admin/dashboards/${board}/export?format=csv`, adminToken);
    assert(`the ${board} dashboard exports a downloadable CSV`,
      csv.status === 200 && (csv.type || '').includes('text/csv') &&
      (csv.disposition || '').includes('attachment') &&
      csv.body.includes(EXPECTED_HEADER[board]),
      `${csv.status} ${csv.type} ${csv.body.slice(0, 60)}`);
  }

  const dashPdf = await req('GET', '/admin/dashboards/sales/export?format=pdf',
    null, adminToken);
  assert('dashboard PDF export says so plainly rather than mislabelling a CSV',
    dashPdf.status === 400 && /csv/i.test(dashPdf.message || ''));

  // Login must answer with the same role and permissions /me does. Without
  // them the console cannot tell what the operator may do, and hides every
  // gated control for the whole session after signing in.
  const cashierLogin = await req('POST', '/admin/login',
    { email: `dash_cashier_${ts}@vips.test`, password: 'DashPass1234' });
  assert('login returns the caller\'s role and effective permissions',
    cashierLogin.data?.adminRole === 'cashier' &&
    Array.isArray(cashierLogin.data?.permissions) &&
    cashierLogin.data.permissions.includes('dashboard.read') &&
    cashierLogin.data.permissions.includes('pos.open_session') &&
    !cashierLogin.data.permissions.includes('reports.read'),
    JSON.stringify({ role: cashierLogin.data?.adminRole,
                     count: (cashierLogin.data?.permissions || []).length }));

  const meEnvelope = await req('GET', '/admin/me', null, dashCashier);
  assert('login and /me agree on the permission set',
    JSON.stringify((cashierLogin.data?.permissions || []).slice().sort()) ===
    JSON.stringify((meEnvelope.data?.permissions || []).slice().sort()));

  const dashUnknown = await req('GET', '/admin/dashboards/nonsense/export',
    null, adminToken);
  assert('an unknown dashboard export is rejected', dashUnknown.status === 400);

  // The bootstrap script and the permissions module must agree on the role
  // list, or a role the console fully understands cannot be created at all.
  const { ROLES } = require('../middleware/permissions');
  const createAdminSource = require('fs')
    .readFileSync(require('path').join(__dirname, '../scripts/create-admin.js'), 'utf8');
  assert('create-admin.js accepts every role the permissions module defines',
    !/const ROLES = \[/.test(createAdminSource) &&
    createAdminSource.includes("require('../middleware/permissions')") &&
    ROLES.includes('cashier'),
    'the script keeps its own copy of the role list');
}

// ─── FLOW 13: Client/server wiring ──────────────────────────
// Both directions, from the real Express stack rather than a hand-kept list.
// A call with no route is a dead button; a route with no caller is a feature
// that was built and then never reached from the console.
function testWiring() {
  console.log('\n🔌 FLOW 13: Console ↔ backend wiring');
  const fs = require('fs');
  const pathMod = require('path');
  const adminRouter = require('../routes/admin');

  const routes = [];
  (function walk(stack, prefix) {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) {
          routes.push({
            method: m.toUpperCase(),
            path: '/admin' + prefix + (layer.route.path === '/' ? '' : layer.route.path),
          });
        }
      } else if (layer.name === 'router' && layer.handle.stack) {
        const m = layer.regexp.toString().match(/\\\/([^\\\/\?]+)/);
        walk(layer.handle.stack, prefix + (m ? '/' + m[1] : ''));
      }
    }
  })(adminRouter.stack, '');

  const dart = fs.readFileSync(
    pathMod.join(__dirname, '../../admin/services/admin_api_service.dart'), 'utf8');
  const calls = [];
  const re = /_api\.(get|post|put|delete)\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(dart))) {
    const raw = m[2].replace(/\$\{[^}]+\}/g, ':p').replace(/\$\w+/g, ':p').split('?')[0];
    if (raw.startsWith('/admin')) calls.push({ method: m[1].toUpperCase(), raw });
  }
  assert('the console calls the admin API', calls.length > 50, `${calls.length} calls found`);

  // Only the segment under /reports or /dashboards is an enum the client
  // interpolates; collapsing every "products" would hide /admin/products
  // behind /admin/reports/products.
  const norm = (p) =>
    p.replace(/:[^/]+/g, ':p')
     .replace(/^\/admin\/(reports|dashboards)\/[^/]+/, '/admin/$1/:p');

  const routeKeys = new Set(routes.map((r) => `${r.method} ${norm(r.path)}`));
  const callKeys = new Set(calls.map((c) => `${c.method} ${norm(c.raw)}`));

  const unrouted = [...callKeys].filter((k) => !routeKeys.has(k));
  assert('every call the console makes has a backend route',
    unrouted.length === 0, unrouted.join('; '));

  const uncalled = [...routeKeys].filter((k) => !callKeys.has(k) && k !== 'POST /admin/logout');
  assert('every admin endpoint is reachable from the console',
    uncalled.length === 0,
    uncalled.length ? `built but never called: ${uncalled.join('; ')}` : '');

  console.log(`    ${routes.length} endpoints, ${calls.length} client calls`);
}

// ─── FLOW 14: Editing a customer ────────────────────────────
async function testUserEditing() {
  console.log('\n✏️  FLOW 14: Customer editing');
  if (!adminToken || !userId) return assert('prerequisites for user editing', false);

  const renamed = await req('PUT', `/admin/users/${userId}`,
    { fullName: 'QA Renamed User' }, adminToken);
  assert('an admin can correct a customer\'s name',
    renamed.success === true && renamed.data?.user?.fullName === 'QA Renamed User',
    renamed.message);
  assert('only the fields sent are reported as changed',
    Array.isArray(renamed.data?.changed) && renamed.data.changed.join() === 'fullName',
    JSON.stringify(renamed.data?.changed));

  const noop = await req('PUT', `/admin/users/${userId}`, {}, adminToken);
  assert('an empty edit is rejected rather than silently succeeding', noop.status === 400);

  const blank = await req('PUT', `/admin/users/${userId}`, { fullName: '   ' }, adminToken);
  assert('a blank name is rejected', blank.status === 400);

  // Email and phone are sign-in identifiers, so a collision would lock the
  // other account's owner out through somebody else's edit.
  const taken = await req('PUT', `/admin/users/${userId}`,
    { email: TEST_MERCHANT.email }, adminToken);
  assert('an email already in use is refused', taken.status === 409, `status ${taken.status}`);

  const takenPhone = await req('PUT', `/admin/users/${userId}`,
    { phone: TEST_MERCHANT.phone }, adminToken);
  assert('a phone already in use is refused', takenPhone.status === 409);

  const sameEmail = await req('PUT', `/admin/users/${userId}`,
    { email: TEST_USER.email, fullName: 'QA Test User' }, adminToken);
  assert('re-sending an account\'s own email is not a collision',
    sameEmail.success === true, sameEmail.message);

  // Console operators carry role and permission rules this route does not
  // repeat, so it refuses them outright rather than half-applying them.
  const onAdmin = await req('PUT', `/admin/users/${adminId}`,
    { fullName: 'Nope' }, adminToken);
  assert('a console operator cannot be edited through the customer route',
    onAdmin.status === 403, `status ${onAdmin.status}`);

  const badId = await req('PUT', '/admin/users/not-an-id', { fullName: 'X' }, adminToken);
  assert('an invalid user id is rejected', badId.status === 400);
}

// ─── FLOW 15: Audit log ─────────────────────────────────────
async function testAuditLog() {
  console.log('\n🔎 FLOW 15: Audit log');
  if (!adminToken || !userId) return assert('prerequisites for the audit log', false);

  const before = await req('GET', '/admin/audit/logs?limit=1', null, adminToken);
  assert('the audit log is readable', before.success === true &&
    Array.isArray(before.data?.items), before.message);
  const countBefore = before.data?.total || 0;

  // One change that goes through, and one that is refused.
  await req('PUT', `/admin/users/${userId}/ban`, { banned: true }, adminToken);
  await req('PUT', `/admin/users/${userId}/ban`, { banned: false }, adminToken);
  const readsBefore = await req('GET', '/admin/users?limit=1', null, adminToken);
  assert('a read still works while auditing is on', readsBefore.success === true);

  await new Promise((r) => setTimeout(r, 400));

  const after = await req('GET', '/admin/audit/logs?limit=20', null, adminToken);
  assert('a change is recorded', after.data.total > countBefore,
    `${countBefore} → ${after.data.total}`);

  // Reads would bury the writes: a hundred page loads between two bans makes
  // the bans harder to find, not easier.
  const anyRead = (after.data.items || []).some((e) => e.method === 'GET');
  assert('reads are not recorded', anyRead === false);

  const ban = (after.data.items || []).find((e) => /suspend/i.test(e.action || ''));
  assert('the entry says what was done in words, not just the endpoint',
    !!ban && ban.action && !ban.action.startsWith('PUT '),
    ban ? ban.action : 'no ban entry found');
  assert('the entry names the operator and survives their deletion',
    !!ban && typeof ban.actorName === 'string' && ban.actorName.length > 0 &&
    typeof ban.actorEmail === 'string');
  assert('the entry records which direction was asked for',
    !!ban && ban.changes && ban.changes.banned === true,
    JSON.stringify(ban && ban.changes));

  // A refused attempt is the line an audit log exists for.
  const viewerEmail = `audit_viewer_${ts}@vips.test`;
  await req('POST', '/admin/staff', {
    fullName: 'Audit Viewer', email: viewerEmail,
    phone: `71${String(ts).slice(-9)}`.slice(0, 12),
    password: 'AuditViewer1', adminRole: 'viewer',
  }, adminToken);
  const viewerTok = (await req('POST', '/admin/login',
    { email: viewerEmail, password: 'AuditViewer1' })).data?.token;
  const refused = await req('DELETE', `/admin/users/${userId}`, null, viewerTok);
  assert('the refusal itself returns 403', refused.status === 403);

  await new Promise((r) => setTimeout(r, 400));
  const denied = await req('GET', '/admin/audit/logs?outcome=denied&limit=10',
    null, adminToken);
  assert('a refused attempt is recorded, not just the successes',
    (denied.data?.items || []).some((e) => e.statusCode === 403),
    'nothing with a 403 in the denied filter');
  assert('every entry under the denied filter really failed',
    (denied.data?.items || []).every((e) => e.success === false));

  // A password reaching this collection would be a password stored in clear.
  const withSecret = await req('POST', '/admin/staff', {
    fullName: 'Secret Probe', email: `secret_${ts}@vips.test`,
    phone: `72${String(ts).slice(-9)}`.slice(0, 12),
    password: 'PlainTextSecret9', adminRole: 'viewer',
  }, adminToken);
  await new Promise((r) => setTimeout(r, 400));
  const staffEntries = await req('GET', '/admin/audit/logs?search=operator&limit=20',
    null, adminToken);
  const leaked = (staffEntries.data?.items || []).some((e) =>
    JSON.stringify(e.changes || {}).includes('PlainTextSecret9'));
  assert('a password never reaches the audit collection', leaked === false);
  const redacted = (staffEntries.data?.items || []).some((e) =>
    e.changes && e.changes.password === '[redacted]');
  assert('the password field is recorded as redacted rather than dropped',
    redacted === true, 'a missing key reads as "they left it blank"');

  // A viewer can read the log (settings.read); a cashier cannot.
  const cashierEmail = `audit_cashier_${ts}@vips.test`;
  await req('POST', '/admin/staff', {
    fullName: 'Audit Cashier', email: cashierEmail,
    phone: `73${String(ts).slice(-9)}`.slice(0, 12),
    password: 'AuditCash123', adminRole: 'cashier',
  }, adminToken);
  const cashTok = (await req('POST', '/admin/login',
    { email: cashierEmail, password: 'AuditCash123' })).data?.token;
  const cashRead = await req('GET', '/admin/audit/logs', null, cashTok);
  assert('a cashier cannot read the audit log', cashRead.status === 403,
    `status ${cashRead.status}`);

  const entryId = (after.data.items || [])[0]?._id;
  if (entryId) {
    const one = await req('GET', `/admin/audit/logs/${entryId}`, null, adminToken);
    assert('a single entry can be opened', one.success === true && !!one.data?.entry);
  }
  const badEntry = await req('GET', '/admin/audit/logs/not-an-id', null, adminToken);
  assert('an invalid audit id is rejected', badEntry.status === 400);

  if (withSecret.data?.staff?._id) {
    await req('DELETE', `/admin/staff/${withSecret.data.staff._id}`, null, adminToken);
  }
}

// ─── FLOW 16: Analytics ─────────────────────────────────────
async function testAnalytics() {
  console.log('\n📈 FLOW 16: Visitor analytics');
  if (!adminToken) return assert('prerequisites for analytics', false);

  const sid = `qa${String(ts).slice(-14)}`;
  const track = (body) => req('POST', '/analytics/track', body, null);

  // Public on purpose: a visit happens before anyone signs in, and requiring
  // a token would count only the people who already converted.
  const anon = await track({
    sessionId: sid, app: 'consumer', platform: 'android',
    events: [{ screen: '/home' }, { screen: '/search' }, { screen: '/product/:id' }],
  });
  assert('a visit is recorded without any token',
    anon.success === true && anon.data?.recorded === 3, anon.message);

  // The character filter alone passes an ObjectId — it is 24 hex characters
  // and entirely [a-z0-9]. Every segment is shape-checked for that reason.
  const leaky = await track({
    sessionId: sid, app: 'consumer',
    events: [{ screen: '/product/6a86187d95bbf4ce88e3144c' }, { screen: '/cart' }],
  });
  assert('a route carrying a record id is refused, the rest is kept',
    leaky.data?.recorded === 1, `recorded ${leaky.data?.recorded}`);

  const shortId = await track({ sessionId: 'x', events: [{ screen: '/home' }] });
  assert('a session id that short is rejected', shortId.status === 400);

  const noEvents = await track({ sessionId: sid, events: [] });
  assert('a call with no events is rejected', noEvents.status === 400);

  const flood = await track({
    sessionId: sid,
    events: Array.from({ length: 200 }, () => ({ screen: '/home' })),
  });
  assert('a batch is capped rather than accepted whole',
    flood.data?.recorded === 50, `recorded ${flood.data?.recorded}`);

  // ── The console's view ──
  const overview = await req('GET', '/admin/analytics/overview?days=30', null, adminToken);
  assert('the analytics overview loads', overview.success === true, overview.message);
  const d = overview.data || {};

  assert('tracking is reported as on once something is recorded', d.tracking === true);
  assert('a visitor is a session, not a screen view',
    d.visitors.screenViews > d.visitors.inWindow,
    `${d.visitors.screenViews} views over ${d.visitors.inWindow} visitors`);

  // Arithmetically right, completely meaningless: while tracking is younger
  // than the window it counts orders against a fraction of the visits.
  assert('the conversion rate is withheld while tracking is younger than the window',
    d.conversion.measurable === false
      ? d.conversion.rate === null && d.conversion.reason.length > 0
      : typeof d.conversion.rate === 'number',
    JSON.stringify({ m: d.conversion.measurable, r: d.conversion.rate }));

  assert('the daily series is zero-filled across the whole window',
    Array.isArray(d.visitorsByDay) && d.visitorsByDay.length === 30);

  assert('no recorded screen name contains a record id',
    (d.topScreens || []).every((s) => !/[0-9a-f]{24}/i.test(s.screen)),
    (d.topScreens || []).map((s) => s.screen).join(','));

  assert('sessions are split by app and platform',
    Array.isArray(d.byApp) && Array.isArray(d.byPlatform) &&
    d.byApp.some((a) => a.app === 'consumer'));

  // analytics.read is granted wherever reports.read is; a cashier has neither.
  const anaCashEmail = `ana_cashier_${ts}@vips.test`;
  await req('POST', '/admin/staff', {
    fullName: 'Ana Cashier', email: anaCashEmail,
    phone: `74${String(ts).slice(-9)}`.slice(0, 12),
    password: 'AnaCash1234', adminRole: 'cashier',
  }, adminToken);
  const anaCashTok = (await req('POST', '/admin/login',
    { email: anaCashEmail, password: 'AnaCash1234' })).data?.token;
  const denied = await req('GET', '/admin/analytics/overview', null, anaCashTok);
  assert('a cashier cannot read analytics', denied.status === 403,
    `status ${denied.status}`);

  const { PERMISSION_CATALOGUE } = require('../middleware/permissions');
  assert('analytics is a declared permission module',
    PERMISSION_CATALOGUE.some((p) => p.key === 'analytics.read' && p.enforced));
}

// ─── FLOW 17: Bulk product import ───────────────────────────
async function testBulkImport() {
  console.log('\n📥 FLOW 17: Bulk product import');
  if (!merchantToken) return assert('prerequisites for bulk import', false);

  const send = async (csv, { name = 'products.csv', dryRun = false } = {}) => {
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), name);
    const r = await fetch(
      `${BASE_URL}/merchant/products/import/csv?dryRun=${dryRun}`,
      { method: 'POST', headers: { Authorization: `Bearer ${merchantToken}` }, body: form });
    return { status: r.status, ...(await r.json()) };
  };

  // ── Template ──
  const tmplRes = await fetch(`${BASE_URL}/merchant/products/import/template`,
    { headers: { Authorization: `Bearer ${merchantToken}` } });
  const tmplBuf = Buffer.from(await tmplRes.arrayBuffer());
  assert('the template downloads as CSV',
    tmplRes.status === 200 && (tmplRes.headers.get('content-type') || '').includes('text/csv'));
  // Excel reads a file without one as the current codepage, so an Arabic
  // product name comes back as mojibake — the first thing a merchant sees.
  assert('the template carries a byte-order mark for Excel',
    tmplBuf[0] === 0xef && tmplBuf[1] === 0xbb && tmplBuf[2] === 0xbf);

  // ── A check writes nothing ──
  const good = 'name,category,price,costPrice,stock,code\n' +
    `Imported A ${ts},Drinks,4.5,1.8,50,IMP-A-${ts}\n` +
    `Imported B ${ts},Bakery,3,1.2,30,IMP-B-${ts}\n`;
  const dry = await send(good, { dryRun: true });
  assert('a check reports what would happen without writing',
    dry.success === true && dry.data.dryRun === true &&
    dry.data.wouldCreate === 2 && dry.data.created === 0, dry.message);

  // Filtered by name here rather than by a query param: /merchant/products
  // returns the whole catalogue, which already holds products from the
  // merchant flow above.
  const afterDry = await req('GET', '/merchant/products', null, merchantToken);
  const dryMatches = (afterDry.data?.items || afterDry.data || [])
    .filter((p) => (p.name || '').includes(`Imported A ${ts}`));
  assert('a check writes nothing to the catalogue',
    dryMatches.length === 0, `${dryMatches.length} found after a dry run`);

  // ── The real import ──
  const real = await send(good);
  assert('the import creates the products',
    real.data.created === 2 && real.data.skipped === 0, JSON.stringify(real.data));

  // ── Duplicates ──
  const again = await send(good);
  assert('re-uploading the same file creates nothing',
    again.data.created === 0 && again.data.skipped === 2);
  assert('a skipped row says which rule matched',
    (again.data.issues || []).some((i) => /already exists/i.test(i.message || '')));

  // A file that repeats a row is not caught by checking the database: both
  // rows are new when the upload starts.
  const selfDupe = `name,category,price\nSelf ${ts},X,1\nSelf ${ts},X,1\n`;
  const sd = await send(selfDupe);
  assert('a file that repeats a row imports it once',
    sd.data.created === 1 && sd.data.skipped === 1, JSON.stringify(sd.data));

  // ── Bad rows ──
  const bad = 'name,category,price,discountPrice\n' +
    ',Drinks,5,\n' +
    `NoPrice ${ts},Drinks,,\n` +
    `NotANumber ${ts},Drinks,abc,\n` +
    `Negative ${ts},Drinks,-5,\n` +
    `BadDiscount ${ts},Drinks,10,99\n` +
    `Fine ${ts},Drinks,7,\n`;
  const b = await send(bad);
  assert('good rows import while bad ones are reported',
    b.data.created === 1 && b.data.failed === 5, JSON.stringify(b.data));
  assert('every problem names the line in the file',
    (b.data.issues || []).every((i) => typeof i.line === 'number' && i.line >= 2));
  assert('a discount above the price is refused',
    (b.data.issues || []).some((i) => i.field === 'discountPrice'));

  // ── Quoting and locale ──
  const tricky = 'name,category,price\n' +
    `"Cafe ""Special"", large ${ts}",Drinks,"12,50"\n`;
  const tr = await send(tricky);
  assert('a quoted comma does not split the row, and a decimal comma parses',
    tr.data.created === 1, JSON.stringify(tr.data));
  const madeRes = await req('GET', '/merchant/products', null, merchantToken);
  const made = (madeRes.data?.items || madeRes.data || [])
    .find((p) => (p.name || '').includes(`${ts}`));
  assert('the quoted field is stored whole, with its price',
    !!made && made.name.includes('"Special", large') && made.price === 12.5,
    made ? `${made.name} @ ${made.price}` : 'not found');

  // ── Refusals ──
  const xlsx = await send('binary', { name: 'products.xlsx' });
  assert('an Excel file is refused with instructions, not a parse error',
    xlsx.status === 400 && /save as/i.test(xlsx.message || ''), xlsx.message);

  const headerOnly = await send('name,category,price\n');
  assert('a file with only a header is refused', headerOnly.status === 400);

  const huge = 'name,category,price\n' +
    Array.from({ length: 2100 }, (_, i) => `Bulk${i},X,1`).join('\n');
  const h = await send(huge);
  assert('a file over the row limit is refused', h.status === 400 && /2000/.test(h.message));

  const noToken = await fetch(`${BASE_URL}/merchant/products/import/csv`,
    { method: 'POST', body: new FormData() });
  assert('importing needs a merchant token', noToken.status === 401);

  // ── History ──
  const history = await req('GET', '/merchant/products/import/history',
    null, merchantToken);
  assert('the import history is real, not an empty stub',
    history.success === true && (history.data?.items || []).length > 0,
    `${(history.data?.items || []).length} entries`);
  assert('checks are recorded alongside imports',
    (history.data.items || []).some((i) => i.dryRun === true));

  const first = history.data.items[0];
  const one = await req('GET', `/merchant/products/import/history/${first._id}`,
    null, merchantToken);
  assert('a single import can be opened', one.success === true && !!one.data?.import);

  // Another merchant's import id must not read back their file name.
  const other = await req('GET', `/merchant/products/import/history/${first._id}`,
    null, userToken);
  assert('an import belongs to the merchant who ran it',
    other.status === 401 || other.status === 403 || other.status === 404,
    `status ${other.status}`);
}

// ─── FLOW 18: Live chat ─────────────────────────────────────
async function testChat() {
  console.log('\n💬 FLOW 18: Live chat');
  const { io: ioClient } = require('socket.io-client');
  const ORIGIN = BASE_URL.replace(/\/api\/?$/, '');

  const connect = (token) => new Promise((resolve, reject) => {
    const s = ioClient(ORIGIN, { auth: { token }, transports: ['websocket'], reconnection: false });
    s.on('ready', (d) => resolve({ socket: s, ready: d }));
    s.on('connect_error', (e) => reject(new Error(e.message)));
    setTimeout(() => reject(new Error('timed out')), 8000);
  });

  // Identity must come from the token. A client-supplied user id would let
  // anyone claim any account and read that account's conversations.
  let refusedBadToken = false;
  try { await connect('not-a-real-token'); } catch { refusedBadToken = true; }
  assert('a socket with an invalid token is refused', refusedBadToken);

  let refusedNoToken = false;
  try { await connect(''); } catch { refusedNoToken = true; }
  assert('a socket with no token is refused', refusedNoToken);

  if (!userToken || !merchantToken) return assert('chat prerequisites', false);

  const customer = await connect(userToken);
  const merchant = await connect(merchantToken);
  assert('the socket resolves the sender from the token',
    customer.ready.userId === String(userId), customer.ready.userId);

  const delivered = new Promise((r) => merchant.socket.once('new-message', r));
  const ack = await new Promise((r) =>
    customer.socket.emit('send-message',
      { toUserId: merchantId, body: `QA hello ${ts}` }, r));
  assert('a customer can message a merchant', ack.ok === true, ack.error);
  const got = await delivered;
  assert('the merchant receives it live', got.body === `QA hello ${ts}`);

  const back = new Promise((r) => customer.socket.once('new-message', r));
  const replyAck = await new Promise((r) =>
    merchant.socket.emit('send-message',
      { toUserId: userId, body: `QA reply ${ts}` }, r));
  assert('the merchant can reply', replyAck.ok === true, replyAck.error);
  assert('the customer receives the reply', (await back).body === `QA reply ${ts}`);

  // The pairing rule: this must not become a way to message any account.
  const toSelf = await new Promise((r) =>
    customer.socket.emit('send-message', { toUserId: String(userId), body: 'x' }, r));
  assert('a customer cannot message themselves', toSelf.ok === false);

  const empty = await new Promise((r) =>
    customer.socket.emit('send-message', { toUserId: merchantId, body: '   ' }, r));
  assert('an empty message is refused', empty.ok === false);

  const long = await new Promise((r) =>
    customer.socket.emit('send-message',
      { toUserId: merchantId, body: 'x'.repeat(3000) }, r));
  assert('an over-long message is refused', long.ok === false);

  // A chat that only delivers to whoever is connected loses everything sent
  // while the other side is closed, which for a merchant is most of the day.
  merchant.socket.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  await new Promise((r) =>
    customer.socket.emit('send-message',
      { toUserId: merchantId, body: `QA offline ${ts}` }, r));
  await new Promise((r) => setTimeout(r, 300));

  const history = await req('GET', `/chat/messages/${userId}`, null, merchantToken);
  assert('a message sent while the recipient was offline is not lost',
    (history.data?.items || []).some((m) => m.body === `QA offline ${ts}`));
  assert('history is ordered oldest first, the way a conversation reads',
    (history.data?.items || []).length >= 2 &&
    new Date(history.data.items[0].createdAt) <=
      new Date(history.data.items[history.data.items.length - 1].createdAt));

  const convos = await req('GET', '/chat/conversations', null, merchantToken);
  assert('the conversation list names the other party and counts unread',
    (convos.data?.items || []).some((c) =>
      c.withUserId === String(userId) && c.unread > 0), JSON.stringify(convos.data?.items));

  const unread = await req('GET', '/chat/unread', null, merchantToken);
  assert('an unread total is available for a badge', unread.data?.unread > 0);

  const merchant2 = await connect(merchantToken);
  const readAck = await new Promise((r) =>
    merchant2.socket.emit('mark-read', { withUserId: String(userId) }, r));
  assert('marking read clears the unread count',
    readAck.ok === true && readAck.updated > 0, JSON.stringify(readAck));
  const after = await req('GET', '/chat/unread', null, merchantToken);
  assert('the badge is zero afterwards', after.data?.unread === 0);

  const noAuth = await req('GET', `/chat/messages/${merchantId}`, null, null);
  assert('chat history needs a token', noAuth.status === 401);

  customer.socket.disconnect();
  merchant2.socket.disconnect();
}

// ─── FLOW 19: Order tracking ────────────────────────────────
// ─── FLOW 22: Admin order cancellation and board reconciliation ──────
//
// Both assertions here are regressions for bugs this suite did not catch:
// the cancel route referenced `reason` above the line that defined it (a
// clean 500 on every cancellation), and the merchants dashboard silently
// dropped revenue belonging to no merchant, so it disagreed with the sales
// dashboard about the same window.
// ─── FLOW 23: The merchant's delivery estimate ───────────────────────
//
// The endpoint existed and was tested before the merchant app could reach
// it. What was untested is the round trip: toMerchantJSON did not carry
// estimatedDeliveryAt, so the screen that sets the value could not read it
// back and every order looked like it had no estimate.
// ─── FLOW 24: The documented business model ──────────────────────────
//
// Every figure asserted here is quoted from "وثيقة منصة فيبس التفصيلية".
// The platform previously ran a redemption rate ten times the documented
// one, two different earn rates at once, no guarantee at all, and a
// Giftback that shared only its name with the one in §4.2.
// ─── FLOW 25: What the screenshots asked for ─────────────────────────
//
// Each block here is a rule that came off a reviewed screen, kept so the
// behaviour cannot quietly go back to what it was.
async function testScreenshotFixes() {
  console.log('\n🖼  FLOW 25: Reviewed-screen behaviour');
  if (!adminToken) return assert('screenshot-fix prerequisites', false);

  const stamp = Date.now();
  const merchant = await seedUser({
    fullName: 'Screens Store', email: `screens_m_${stamp}@vips.test`,
    phone: _uniquePhone('5'), password: 'ScreensPass123', role: 'merchant',
    storeName: 'Screens Store', earnRate: 6,
  });
  const customer = await seedUser({
    fullName: 'Screens Customer', email: `screens_c_${stamp}@vips.test`,
    phone: _uniquePhone('6'), password: 'ScreensPass123', role: 'customer',
  });
  const mTok = (await req('POST', '/auth/login',
    { email: merchant.email, password: 'ScreensPass123' })).data?.token;
  if (!mTok) return assert('screenshot-fix login', false);

  // ── Vouchers carry dinars, not a percentage ──
  const voucher = await req('POST', '/merchant/coupons', {
    code: `SCV${stamp}`.slice(0, 14),
    discount: 50, discountUnit: 'tnd', type: 'voucher',
    expiryDate: new Date(Date.now() + 30 * 86400000).toISOString(),
  }, mTok);
  assert('a voucher is worth dinars, not a percentage',
    voucher.data?.discountUnit === 'tnd' && voucher.data?.discount === 50,
    JSON.stringify(voucher.data?.discountUnit));
  assert('and its price in points follows the documented rate',
    voucher.data?.pointsCost === 5000, String(voucher.data?.pointsCost));

  const badPercent = await req('POST', '/merchant/coupons', {
    code: `SCB${stamp}`.slice(0, 14), discount: 500, type: 'percentage',
    expiryDate: new Date(Date.now() + 30 * 86400000).toISOString(),
  }, mTok);
  assert('a percentage above 100 is refused', badPercent.status === 400,
    `${badPercent.status}`);

  // ── A published offer stands for a while ──
  const voucherId = voucher.data?._id;
  const tooSoon = await req('PUT', `/merchant/coupons/${voucherId}`, { discount: 10 }, mTok);
  assert('terms cannot be rewritten straight after publishing',
    tooSoon.status === 409 && tooSoon.code === 'EDIT_COOLDOWN',
    `${tooSoon.status} ${tooSoon.code}`);
  const switchOff = await req('PUT', `/merchant/coupons/${voucherId}`, { isActive: false }, mTok);
  assert('but it can always be switched off', switchOff.success === true, switchOff.message);

  const listed = await req('GET', '/merchant/coupons', null, mTok);
  const row = (listed.data || []).find((c) => String(c._id) === String(voucherId));
  assert('the list says when each offer becomes editable',
    row && row.editable === false && row.editableAt,
    JSON.stringify(row && { editable: row.editable, at: row.editableAt }));

  // ── The storefront discount holds for a day ──
  const setDiscount = await req('PUT', '/merchant/storefront-discount',
    { discountPercentage: 15 }, mTok);
  assert('a merchant can set their storefront discount',
    setDiscount.success === true, setDiscount.message);
  const changeAgain = await req('PUT', '/merchant/storefront-discount',
    { discountPercentage: 40 }, mTok);
  assert('and cannot change it again the same day',
    changeAgain.status === 409, `${changeAgain.status}`);
  const overHundred = await req('PUT', '/merchant/storefront-discount',
    { discountPercentage: 150 }, mTok);
  assert('a discount above 100% is refused', overHundred.status === 400,
    `${overHundred.status}`);

  // ── VIPs Recovery is money taken back out, not points handed out ──
  const dash = await req('GET', '/merchant/dashboard', null, mTok);
  assert('the dashboard reports recovery rather than "issued"',
    dash.data?.vipsRecoveryPoints !== undefined && dash.data?.totalVipsIssued === undefined,
    JSON.stringify(Object.keys(dash.data || {}).filter((k) => k.startsWith('vips') || k.includes('Vips'))));

  // ── Topping up: two sources, and money is confirmed before it counts ──
  const topup = await req('GET', '/merchant/guarantee/topup', null, mTok);
  assert('the top-up screen offers both sources',
    topup.data?.recoverable !== undefined && Array.isArray(topup.data?.pendingBankDeposits),
    JSON.stringify(topup.data));

  const declared = await req('POST', '/merchant/guarantee/topup/bank',
    { amountTnd: 500, reference: 'TRF-1' }, mTok);
  assert('a declared transfer creates a request, not points',
    declared.success === true && declared.data?.status === 'pending',
    JSON.stringify(declared.data));
  const beforeConfirm = await req('GET', '/merchant/guarantee', null, mTok);
  assert('and no points exist until it is confirmed',
    (beforeConfirm.data?.totalPoints || 0) === 0,
    String(beforeConfirm.data?.totalPoints));

  const requests = await req('GET', '/admin/guarantee-requests', null, adminToken);
  const mine = (requests.data?.items || []).find((r) => r.id === declared.data.id);
  assert('the console lists it for review', Boolean(mine), 'not listed');

  const confirmed = await req('PUT', `/admin/guarantee-requests/${declared.data.id}`,
    { action: 'confirm' }, adminToken);
  assert('confirming it creates the points',
    confirmed.data?.guarantee?.unallocatedPoints === 50000,
    String(confirmed.data?.guarantee?.unallocatedPoints));
  const twice = await req('PUT', `/admin/guarantee-requests/${declared.data.id}`,
    { action: 'confirm' }, adminToken);
  assert('and one transfer cannot be confirmed twice', twice.status === 409,
    `${twice.status}`);

  // ── Targeted offers ──
  const segs = await req('GET', '/merchant/rewards/segments', null, mTok);
  assert('every customer segment reports its live size',
    (segs.data?.segments || []).length === 4 &&
      segs.data.segments.every((x) => typeof x.customers === 'number'),
    JSON.stringify((segs.data?.segments || []).map((x) => x.key)));

  const action = await req('POST', '/merchant/rewards/actions',
    { segment: 'be_back', discountType: 'percent', discountValue: 20, availabilityDays: 7 }, mTok);
  assert('an offer starts as a draft with a message written for it',
    action.data?.status === 'draft' && `${action.data?.message}`.length > 0,
    JSON.stringify(action.data?.status));
  const emptySend = await req('POST', `/merchant/rewards/actions/${action.data._id}/send`, {}, mTok);
  assert('sending to an empty group is refused rather than sending nothing',
    emptySend.status === 409, `${emptySend.status}`);

  const badSegment = await req('POST', '/merchant/rewards/actions',
    { segment: 'everyone', discountValue: 10 }, mTok);
  assert('an unknown segment is refused', badSegment.status === 400, `${badSegment.status}`);

  // ── The report is in dinars and keeps the two due directions apart ──
  const report = await req('GET', '/merchant/report', null, mTok);
  assert('the report is denominated in dinars', report.data?.currency === 'TND',
    String(report.data?.currency));
  assert('and reports what is owed each way separately',
    report.data?.due?.fromCustomers !== undefined &&
      report.data?.due?.toSuppliers !== undefined,
    JSON.stringify(report.data?.due));

  // ── Plans are the documented three ──
  const plans = await req('GET', '/merchant/subscription/plans', null, mTok);
  const codes = (plans.data || []).map((p) => p.code).sort();
  assert('the plan list is the documented three',
    JSON.stringify(codes) === JSON.stringify(['advanced', 'basic', 'professional']),
    JSON.stringify(codes));
  assert('and each is priced in dinars against a commission',
    (plans.data || []).every((p) => p.currency === 'TND' && typeof p.commissionPercent === 'number'),
    JSON.stringify((plans.data || []).map((p) => [p.code, p.price, p.commissionPercent])));

  await User.deleteMany({ email: { $in: [merchant.email, customer.email] } });
  await require('../models/Coupon').deleteMany({ merchantId: merchant._id });
}

async function testBusinessModel() {
  console.log('\n📜 FLOW 24: The documented business model');
  const economics = require('../config/economics');

  // ── §5.1 exchange rate ──
  const rates = await req('GET', '/config/rates');
  assert('100 points is 1 dinar, everywhere it is quoted',
    rates.data?.pointsPerTnd === 100 && rates.data?.vipsToTnd === 0.01,
    JSON.stringify(rates.data));
  assert('the rate is the same in both directions',
    economics.pointsToTnd(economics.tndToPoints(37)) === 37);

  if (!adminToken) return assert('business-model prerequisites', false);

  // A merchant and customer of our own, so the assertions below are exact.
  const stamp = Date.now();
  const merchant = {
    fullName: 'Model Store', email: `model_m_${stamp}@vips.test`,
    phone: _uniquePhone(), password: 'ModelPass123', role: 'merchant',
    storeName: 'Model Store', earnRate: 6,
  };
  const customer = {
    fullName: 'Model Customer', email: `model_c_${stamp}@vips.test`,
    phone: _uniquePhone(), password: 'ModelPass123', role: 'customer',
  };
  const mDoc = await seedUser(merchant);
  const cDoc = await seedUser(customer);
  const merchantId = String(mDoc._id);
  const cId = String(cDoc._id);

  const mTok = (await req('POST', '/auth/login', { email: merchant.email, password: merchant.password })).data?.token;
  const cTok = (await req('POST', '/auth/login', { email: customer.email, password: customer.password })).data?.token;
  if (!mTok || !cTok) return assert('business-model logins', false);

  // ── §5.1 guarantee ──
  const before = await req('POST', '/merchant/earn',
    { userId: cId, invoiceAmount: 50 }, mTok);
  assert('a merchant with no guarantee cannot award points',
    before.status === 409, `${before.status}`);

  const dep = await req('POST', `/admin/merchants/${merchantId}/guarantee/deposit`,
    { amount: 1000 }, adminToken);
  assert('1,000 TND of guarantee becomes 100,000 points',
    dep.data?.unallocatedPoints === 100000, JSON.stringify(dep.data?.unallocatedPoints || dep.message));
  assert('a deposit lands unallocated for the merchant to split',
    dep.data?.budgets?.discount === 0);

  const alloc = await req('POST', '/merchant/guarantee/allocate',
    { budget: 'discount', points: 60000 }, mTok);
  assert('the merchant splits it across the three budgets',
    alloc.data?.budgets?.discount === 60000 && alloc.data?.unallocatedPoints === 40000,
    JSON.stringify(alloc.data?.budgets));
  const over = await req('POST', '/merchant/guarantee/allocate',
    { budget: 'packages', points: 999999 }, mTok);
  assert('a merchant cannot allocate points they do not hold', over.status === 409, `${over.status}`);

  // ── §4.1 earning ──
  const earn = await req('POST', '/merchant/earn',
    { qr: `VIPS_USER_${cId}`, invoiceAmount: 50 }, mTok);
  assert('a scanned QR resolves to the customer it belongs to',
    earn.success === true, earn.message);
  assert('50 TND at 6 points/TND earns 300 points',
    earn.data?.pointsAwarded === 300, String(earn.data?.pointsAwarded));
  assert('300 points is 3 TND — the documented 6% return',
    earn.data?.pointsValueTnd === 3, String(earn.data?.pointsValueTnd));
  assert('the points come out of the merchant guarantee, not thin air',
    earn.data?.guarantee?.budgets?.discount === 59700,
    String(earn.data?.guarantee?.budgets?.discount));

  // ── §4.2 Giftback ──
  const gb = await req('POST', '/merchant/gift-back',
    { userId: cId, changeTnd: 0.8, invoiceTnd: 10.8, consent: true }, mTok);
  assert('0.800 TND of change becomes 80 Giftback points',
    gb.data?.points === 80, String(gb.data?.points || gb.message));
  const activatesIn = new Date(gb.data.activatesAt).getTime() - Date.now();
  assert('Giftback points are deferred by twelve hours',
    activatesIn > 11.5 * 3600e3 && activatesIn < 12.5 * 3600e3,
    `${Math.round(activatesIn / 3600e3)}h`);

  const wallet = await req('GET', '/user/wallet', null, cTok);
  assert('deferred points are not spendable yet',
    wallet.data?.points === 300, String(wallet.data?.points));
  assert('but the customer is shown they are coming',
    wallet.data?.pendingGiftbackPoints === 80, String(wallet.data?.pendingGiftbackPoints));

  const noConsent = await req('POST', '/merchant/gift-back',
    { userId: cId, changeTnd: 0.5, consent: false }, mTok);
  assert('Giftback without the customer agreeing is refused',
    noConsent.status === 403, `${noConsent.status}`);
  const tooBig = await req('POST', '/merchant/gift-back',
    { userId: cId, changeTnd: 6, consent: true }, mTok);
  assert('change of 5 TND or more is not change and is refused',
    tooBig.status === 400, `${tooBig.status}`);

  const limits = await req('GET', `/merchant/gift-back/limits?userId=${cId}`, null, mTok);
  assert('the monthly cap is 50 TND and belongs to the customer',
    limits.data?.monthlyCapTnd === 50 && limits.data?.allowance?.usedTnd === 0.8,
    JSON.stringify(limits.data?.allowance));

  const log = await req('GET', '/merchant/gift-back/history', null, mTok);
  assert('the merchant keeps a Giftback approval log',
    (log.data?.items || []).length >= 1 && log.data.items[0].consentedAt);

  // ── §5.2 refunds ──
  const refund = await req('GET', '/merchant/guarantee/refund', null, mTok);
  assert('refunds run on a 60-day cycle with a 100 TND floor',
    refund.data?.cycleDays === 60 && refund.data?.minimumTnd === 100,
    JSON.stringify(refund.data));
  assert('and are reviewed within five working days',
    refund.data?.reviewWorkingDays === 5);
  const tooSmall = await req('POST', '/merchant/guarantee/refund', { amount: 50 }, mTok);
  assert('a refund below the floor is refused',
    tooSmall.status === 400 || tooSmall.status === 409, `${tooSmall.status}`);

  const ledger = await req('GET', '/merchant/guarantee/ledger', null, mTok);
  const kinds = (ledger.data?.items || []).map((i) => i.type);
  assert('every guarantee movement is on the ledger',
    kinds.includes('deposit') && kinds.includes('allocate') && kinds.includes('fund'),
    kinds.join(','));

  // ── §8 plans ──
  for (const [plan, commission] of [['basic', 3], ['professional', 2], ['advanced', 1]]) {
    const r = await req('PUT', `/admin/merchants/${merchantId}/plan`, { plan }, adminToken);
    assert(`the ${plan} plan carries ${commission}% commission`,
      r.data?.commissionRate === commission, String(r.data?.commissionRate));
  }
  const badPlan = await req('PUT', `/admin/merchants/${merchantId}/plan`, { plan: 'platinum' }, adminToken);
  assert('an unknown plan is refused', badPlan.status === 400, `${badPlan.status}`);

  // ── platform exposure ──
  const held = await req('GET', '/admin/guarantees', null, adminToken);
  assert('the console reports guarantee held across the platform',
    typeof held.data?.totalHeldTnd === 'number', JSON.stringify(held.data?.totalHeldTnd));

  await User.deleteMany({ email: { $in: [merchant.email, customer.email] } });
}

async function testDeliveryEstimate() {
  console.log('\n⏱  FLOW 23: Delivery estimate');
  if (!merchantToken || !orderId) return assert('estimate prerequisites', false);

  const before = await req('GET', `/merchant/orders/${orderId}`, null, merchantToken);
  assert('an order with no estimate says so rather than omitting the field',
    before.estimated_delivery_at === null,
    JSON.stringify(before.estimated_delivery_at));

  const at = new Date(Date.now() + 45 * 60 * 1000);
  const set = await req('PUT', `/merchant/orders/${orderId}/eta`,
    { estimatedDeliveryAt: at.toISOString() }, merchantToken);
  assert('a merchant can set an estimate', set.success === true, set.message);

  const after = await req('GET', `/merchant/orders/${orderId}`, null, merchantToken);
  assert('the estimate survives the round trip to the merchant screen',
    after.estimated_delivery_at === at.toISOString(),
    `${after.estimated_delivery_at} vs ${at.toISOString()}`);

  // The whole point of the field: the customer sees the promise.
  const tracking = await req('GET', `/order/${orderId}/tracking`, null, userToken);
  assert('the customer is shown the same estimate',
    new Date(tracking.data.estimatedDeliveryAt).toISOString() === at.toISOString(),
    JSON.stringify(tracking.data.estimatedDeliveryAt));

  const bad = await req('PUT', `/merchant/orders/${orderId}/eta`,
    { estimatedDeliveryAt: 'not a date' }, merchantToken);
  assert('a value that is not a date is refused', bad.status === 400, `${bad.status}`);

  const cleared = await req('PUT', `/merchant/orders/${orderId}/eta`,
    { estimatedDeliveryAt: null }, merchantToken);
  assert('an estimate can be cleared', cleared.success === true, cleared.message);

  const gone = await req('GET', `/merchant/orders/${orderId}`, null, merchantToken);
  assert('clearing it really clears it', gone.estimated_delivery_at === null,
    JSON.stringify(gone.estimated_delivery_at));

  // Another merchant's order is not this merchant's to promise about.
  const foreign = await req('PUT', '/merchant/orders/999999999/eta',
    { estimatedDeliveryAt: at.toISOString() }, merchantToken);
  assert('an order that is not yours cannot be given an estimate',
    foreign.status === 404 || foreign.status === 400, `${foreign.status}`);
}

async function testAdminOrderCancel() {
  console.log('\n🚫 FLOW 22: Admin cancellation & board reconciliation');
  if (!adminToken || !userId) return assert('cancellation prerequisites', false);

  if (!dbConnected) {
    await mongoose.connect(process.env.MONGODB_URI);
    dbConnected = true;
  }
  const Order = require('../models/Order');
  const seeded = new Order({
    userId,
    merchantId: merchantId || null,
    totalAmount: 42,
    status: 'pending',
    items: [{ item_name: 'Cancellable', quantity: 1, price: 42 }],
  });
  await seeded.save();

  const REASON = 'Cancelled during the QA sweep';
  const cancelled = await req(
    'DELETE', `/admin/orders/${seeded._id}?reason=${encodeURIComponent(REASON)}`,
    null, adminToken
  );
  assert('an admin can cancel an order', cancelled.status === 200 && cancelled.success === true,
    `${cancelled.status} ${cancelled.message}`);
  assert('cancelling does not 500 on an undefined reason', cancelled.status !== 500,
    cancelled.message);

  const after = await Order.findById(seeded._id).lean();
  assert('the cancellation is recorded as cancelled', after.status === 'cancelled', after.status);
  assert('the reason given is the reason stored', after.cancellationReason === REASON,
    after.cancellationReason);
  const last = (after.statusHistory || [])[(after.statusHistory || []).length - 1];
  assert('the timeline records who cancelled it and why',
    last && last.status === 'cancelled' && last.byRole === 'admin' && last.note === REASON,
    JSON.stringify(last));

  // Already cancelled — the guard, not a second history entry.
  const again = await req('DELETE', `/admin/orders/${seeded._id}`, null, adminToken);
  assert('an order cannot be cancelled twice', again.status === 409, `${again.status}`);

  await Order.deleteOne({ _id: seeded._id });

  // The two boards answer the same question over the same window and must
  // not produce two numbers for it.
  const win = 'startDate=2026-08-01&endDate=2026-08-31';
  const sales = await req('GET', `/admin/dashboards/sales?${win}`, null, adminToken);
  const merch = await req('GET', `/admin/dashboards/merchants?${win}`, null, adminToken);
  assert('both boards answer', sales.success === true && merch.success === true);
  const attributed = merch.data?.totalRevenue ?? 0;
  const unattributed = merch.data?.unattributedRevenue ?? 0;
  assert('the merchants board states revenue belonging to no merchant',
    typeof merch.data?.unattributedRevenue === 'number');
  assert('the merchants board reconciles with the sales board',
    Math.abs((attributed + unattributed) - (sales.data?.totalRevenue ?? 0)) < 0.01,
    `${attributed} + ${unattributed} vs ${sales.data?.totalRevenue}`);
  assert('a deleted merchant keeps its revenue rather than losing it',
    (merch.data?.merchantPerformance || []).every((m) => typeof m.revenue === 'number'));
}

async function testOrderTracking() {
  console.log('\n📍 FLOW 19: Order tracking');
  if (!userToken || !merchantToken || !orderId) {
    return assert('order tracking prerequisites', false);
  }

  // The status history is written by a pre-save hook, not by the routes.
  // Eight places change order.status — the admin console, the merchant app, a
  // customer cancelling, a refund request and three payment confirmations —
  // and a history each of them had to append would have holes in exactly the
  // ones somebody forgot.
  let t = await req('GET', `/order/${orderId}/tracking`, null, userToken);
  assert('a customer can track their own order',
    t.success === true && typeof t.data?.status === 'string', t.message);
  assert('the timeline starts at the moment the order was placed',
    (t.data.history || []).length > 0 && t.data.history[0].status === 'pending',
    JSON.stringify((t.data.history || []).map((h) => h.status)));
  assert('an order with a recorded journey says so',
    t.data.historyRecorded === true);
  // An empty map implies tracking that is not happening.
  assert('no live location until something reports one',
    t.data.liveLocation === null);

  const before = (t.data.history || []).length;
  await req('PUT', `/merchant/orders/${orderId}/status`,
    { status: 'processing', reason: 'Started preparing' }, merchantToken);
  t = await req('GET', `/order/${orderId}/tracking`, null, userToken);
  assert('a status change is appended to the journey',
    (t.data.history || []).length === before + 1);
  const last = t.data.history[t.data.history.length - 1];
  assert('the entry records the reason the merchant gave',
    last.status === 'processing' && last.note === 'Started preparing',
    JSON.stringify(last));
  assert('the entry names the role that made the change, not the person',
    last.by === 'merchant',
    'a customer must not be handed staff names through their own order');

  // ── Location ──
  const loc = await req('PUT', `/merchant/orders/${orderId}/location`,
    { lat: 36.8065, lng: 10.1815 }, merchantToken);
  assert('a merchant can report where the delivery is', loc.success === true, loc.message);

  // Out of range is a bug in the caller; storing it would put the customer's
  // delivery in the middle of the ocean.
  const badLat = await req('PUT', `/merchant/orders/${orderId}/location`,
    { lat: 999, lng: 0 }, merchantToken);
  assert('a latitude outside -90..90 is refused', badLat.status === 400);
  const notNumber = await req('PUT', `/merchant/orders/${orderId}/location`,
    { lat: 'north', lng: 0 }, merchantToken);
  assert('a non-numeric coordinate is refused', notNumber.status === 400);

  t = await req('GET', `/order/${orderId}/tracking`, null, userToken);
  assert('the reported position reaches the customer',
    t.data.liveLocation && t.data.liveLocation.lat === 36.8065);

  // ── Estimate ──
  const eta = await req('PUT', `/merchant/orders/${orderId}/eta`,
    { estimatedDeliveryAt: new Date(Date.now() + 3600e3).toISOString() }, merchantToken);
  assert('a merchant can give an estimated time', eta.success === true, eta.message);
  const badEta = await req('PUT', `/merchant/orders/${orderId}/eta`,
    { estimatedDeliveryAt: 'soon' }, merchantToken);
  assert('an unparseable estimate is refused', badEta.status === 400);
  // A merchant who no longer knows should be able to say so rather than
  // leave a promise standing on the customer's screen.
  const cleared = await req('PUT', `/merchant/orders/${orderId}/eta`,
    { estimatedDeliveryAt: null }, merchantToken);
  assert('an estimate can be cleared',
    cleared.success === true && cleared.data.estimatedDeliveryAt === null);

  // ── Privacy ──
  const noToken = await req('GET', `/order/${orderId}/tracking`, null, null);
  assert('tracking needs a token', noToken.status === 401);
  const otherPerson = await req('GET', `/order/${orderId}/tracking`, null, merchantToken);
  assert('an order can only be tracked by the customer who placed it',
    otherPerson.status === 404, `status ${otherPerson.status}`);

  // ── The platform still agrees with itself ──
  // The tracker reads Order.status, the same field every report and dashboard
  // reads. A second status field would have let the customer's screen and the
  // admin console disagree about the same order.
  const adminView = await req('GET', `/admin/orders/${orderId}`, null, adminToken);
  const adminStatus = adminView.data?.order?.status || adminView.data?.status;
  t = await req('GET', `/order/${orderId}/tracking`, null, userToken);
  assert('the customer and the console report the same status',
    adminStatus === t.data.status, `admin=${adminStatus} customer=${t.data.status}`);
}

async function runAll() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   VIPs E2E Integration Test Suite            ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Target: ${BASE_URL}\n`);

  try {
    await testAuth();
    await testWallet();
    await testRewards();
    await testOrderFlow();
    await testVipsClub();
    await testNotifications();
    await testContent();
    await testMerchant();
    await testBulkImport();
    await testChat();
    await testReferral();
    await testGiftSend();
    await testAdmin();
    // After testAdmin: the cross-check below needs an admin token, and the
    // whole point of it is that the customer's tracker and the console read
    // the same status field.
    await testOrderTracking();
    await testDashboards();
    testWiring();
    await testUserEditing();
    await testAuditLog();
    await testAnalytics();
    await testDeliveryEstimate();
    await testAdminOrderCancel();
    await testBusinessModel();
    await testScreenshotFixes();
  } catch (err) {
    console.error('\n💥 Test runner crashed:', err.message);
  }

  if (dbConnected) await mongoose.disconnect();

  console.log('\n══════════════════════════════════════════════');
  console.log(`Results: ${passed} passed / ${failed} failed`);
  if (failures.length) {
    console.log('\nFailed assertions:');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
  }
  console.log('══════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
}

runAll();
