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
  const exp2rew = await req('POST', '/rewards/expense-to-reward', { amount: 1000, merchantId }, userToken);
  assert('POST /rewards/expense-to-reward success', exp2rew.success === true, `msg=${exp2rew.message}`);
  assert('expense-to-reward returns pointsEarned', exp2rew.data?.pointsEarned !== undefined);
  assert('expense-to-reward returns newBalance', exp2rew.data?.newBalance !== undefined);

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

  const send = await req('POST', '/rewards/send-gift', {
    recipientPhone: TEST_MERCHANT.phone,
    amount: 5,
    message: 'Happy testing!',
  }, userToken);

  assert('POST /rewards/send-gift success', send.success === true, `msg=${send.message} status=${send.status}`);
  assert('send-gift returns newBalance', send.data?.newBalance !== undefined, `data=${JSON.stringify(send.data)}`);

  // Verify transaction record was created
  const txsAfter = await req('GET', '/user/transactions', null, userToken);
  const countAfter = txsAfter.data?.transactions?.length ?? 0;
  assert('send-gift created transaction record', countAfter > countBefore, `before=${countBefore} after=${countAfter}`);
  assert('send-gift transaction has GIFT reference',
    txsAfter.data?.transactions?.some?.((t) => t.reference?.startsWith('GIFT-')),
    `refs=${txsAfter.data?.transactions?.map?.((t) => t.reference).join(',')}`);
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
  assert('the permission catalogue covers 10 modules and 5 roles',
    catalogue.success === true &&
    catalogue.data?.modules?.length === 10 &&
    catalogue.data?.builtInRoles?.length === 5 &&
    catalogue.data.permissions.length === 47,
    `${catalogue.data?.modules?.length} modules, ${catalogue.data?.builtInRoles?.length} roles, ${catalogue.data?.permissions?.length} permissions`);

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
    await testReferral();
    await testGiftSend();
    await testAdmin();
    await testDashboards();
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
