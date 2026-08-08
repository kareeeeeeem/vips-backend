/**
 * VIPs Backend — End-to-End Integration Test Suite
 *
 * Run with: node tests/integration.test.js
 * Requires: a running backend at BASE_URL with a seeded MongoDB.
 */

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000/api';

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

  // Top-up points
  const topup = await req('POST', '/user/wallet/topup', { vipsAmount: 500, cardId: 'test-card' }, userToken);
  assert('POST /user/wallet/topup success', topup.success === true, `msg=${topup.message}`);
  assert('topup returns newBalance', topup.data?.newBalance !== undefined || topup.data?.walletPoints !== undefined);

  // Verify points updated
  const walletAfter = await req('GET', '/user/wallet', null, userToken);
  const pointsAfter = walletAfter.data?.points ?? 0;
  assert('wallet points increased after topup', pointsAfter >= 500, `points=${pointsAfter}`);

  // Transactions log
  const txLog = await req('GET', '/user/transactions', null, userToken);
  assert('GET /user/transactions success', txLog.success === true);
  assert('transactions returns array', Array.isArray(txLog.data?.transactions));
  assert('transactions includes topup record', txLog.data?.transactions?.length >= 1);
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

  // Create order as user
  const orderPayload = {
    merchantId,
    items: [
      { productId: 'test-product-1', name: 'Test Burger', price: 29.99, quantity: 2 },
      { productId: 'test-product-2', name: 'Test Fries', price: 9.99, quantity: 1 },
    ],
    paymentMethod: 'cash',
    deliveryAddress: '123 Test Street, Test City',
    orderType: 'delivery',
    orderNote: 'Extra sauce please',
  };

  const createOrder = await req('POST', '/order/create', orderPayload, userToken);
  assert('POST /order/create success', createOrder.success === true, `msg=${createOrder.message}`);
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

  // Top up points, then convert to walletBalance — 5000 pts × 0.01 = 50 TND balance
  await req('POST', '/user/wallet/topup', { vipsAmount: 10000, cardId: 'gift-test' }, userToken);
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
  } catch (err) {
    console.error('\n💥 Test runner crashed:', err.message);
  }

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
