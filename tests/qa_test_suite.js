const http = require('http');

const BASE_URL = 'http://localhost:3000';

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, body: json });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', (err) => reject(err));

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runQA() {
  console.log('==================================================');
  console.log('🚀 QA AUTOMATED SUITE FOR VIPS BACKEND & APPUSER');
  console.log('==================================================\n');

  const results = [];

  function record(name, passed, details = '') {
    results.push({ name, passed, details });
    const mark = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${mark} | ${name}${details ? ` -> ${details}` : ''}`);
  }

  try {
    // 1. Health Check
    const health = await request('GET', '/api/health');
    record('Health Check Endpoint', health.status === 200 && health.body.status === 'ok');

    // 2. Auth: Customer Registration
    const testUser = {
      fullName: 'QA Test User',
      email: `qa_${Date.now()}@vips.com`,
      phone: `9${Math.floor(1000000 + Math.random() * 9000000)}`,
      password: 'password123',
      role: 'customer',
    };

    const regRes = await request('POST', '/api/auth/register', testUser);
    record('User Registration Flow', regRes.status === 201 && regRes.body.success, `ID: ${regRes.body.data?.user?._id}`);

    const token = regRes.body.data?.token;

    // 3. Auth: Login Flow
    const loginRes = await request('POST', '/api/auth/login', {
      email: testUser.email,
      password: testUser.password,
    });
    record('User Login Flow', loginRes.status === 200 && loginRes.body.success);

    // 4. User Profile / Me
    const meRes = await request('GET', '/api/auth/me', null, token);
    record('Fetch Profile /me', meRes.status === 200 && meRes.body.data?.user?.email === testUser.email);

    // 5. Wallet Topup
    const topupRes = await request('POST', '/api/user/wallet/topup', { vipsAmount: 500, cardId: '4242' }, token);
    record('Wallet Top-up Flow (500 PTS)', topupRes.status === 200 && topupRes.body.success);

    // 6. Wallet Check
    const walletRes = await request('GET', '/api/user/wallet', null, token);
    record('Get Wallet Balance & Transactions', walletRes.status === 200 && walletRes.body.data?.points >= 500);

    // 7. VIPs Club: Daily Check-in
    const checkinRes = await request('POST', '/api/user/vips-club/checkin', {}, token);
    record('VIPs Club Daily Check-in', checkinRes.status === 200 && checkinRes.body.success);

    // 8. VIPs Club: Duplicate Check-in Edge Case
    const checkinDupRes = await request('POST', '/api/user/vips-club/checkin', {}, token);
    record('VIPs Club Duplicate Check-in Edge Case', checkinDupRes.status === 400 && !checkinDupRes.body.success, 'Properly blocked duplicate check-in');

    // 9. VIPs Club: Convert Points to Wallet
    const convertRes = await request('POST', '/api/user/vips-club/convert', { points: 100 }, token);
    record('Convert Points to Wallet Balance', convertRes.status === 200 && convertRes.body.success);

    // 10. Spin Wheel
    const spinRes = await request('POST', '/api/rewards/spin-wheel', {}, token);
    record('Spin Wheel Reward Flow', spinRes.status === 200 && spinRes.body.success, `Won: ${spinRes.body.data?.amount} pts`);

    // 11. Content: Hot Deals & Search
    const hotDeals = await request('GET', '/api/content/hot-deals');
    record('Fetch Hot Deals', hotDeals.status === 200 && Array.isArray(hotDeals.body.data));

    const searchRes = await request('GET', '/api/content/search?q=pizza');
    record('Search Content Query ("pizza")', searchRes.status === 200 && searchRes.body.success);

    // 12. Cart Operations
    const addCart = await request('POST', '/api/cart/add', { itemId: 'prod123', name: 'Test Pizza', price: 15.0, quantity: 2, merchantId: 'm123' }, token);
    record('Add Item to Cart', addCart.status === 200 && addCart.body.success);

    const getCart = await request('GET', '/api/cart', null, token);
    record('Fetch User Cart', getCart.status === 200 && getCart.body.data?.length > 0);

    // 13. Favorites Toggle
    const favRes = await request('POST', '/api/favorites/toggle', { itemId: 'deal123', itemType: 'deal' }, token);
    record('Toggle Favorite Item', favRes.status === 200 && favRes.body.success);

    // 14. Order Creation
    const createOrderRes = await request('POST', '/api/order/create', {
      merchantId: regRes.body.data.user._id,
      items: [{ productId: 'p1', name: 'Delicious Pizza', price: 20.0, quantity: 1 }],
      paymentMethod: 'cash',
      deliveryAddress: '123 Main St, Nabeul',
    }, token);
    record('Create Order Flow', createOrderRes.status === 201 && createOrderRes.body.success, `Order ID: ${createOrderRes.body.data?._id}`);

    const orderId = createOrderRes.body.data?._id;

    // 15. Order Details
    const orderDetailsRes = await request('GET', `/api/order/${orderId}`, null, token);
    record('Fetch Single Order Details', orderDetailsRes.status === 200 && orderDetailsRes.body.success);

    // 16. Order Review Submission
    const reviewRes = await request('POST', `/api/order/${orderId}/review`, { rating: 5, review: 'Excellent food and fast delivery!' }, token);
    record('Submit Order Rating & Review', reviewRes.status === 200 && reviewRes.body.success);

    // 17. Order Cancellation
    const cancelRes = await request('PUT', `/api/order/${orderId}/cancel`, {}, token);
    record('Cancel Order Flow', cancelRes.status === 200 && cancelRes.body.success);

    // 18. Services: Pay Bill
    const billsRes = await request('GET', '/api/services/bills');
    const billId = billsRes.body.data?.[0]?._id;

    const payBillRes = await request('POST', '/api/services/pay-bill', { billServiceId: billId, amount: 5.0, referenceNumber: 'REF123456' }, token);
    record('Pay Bill Flow', payBillRes.status === 200 && payBillRes.body.success);

    // 19. Services: Mobile Recharge
    const rechargeRes = await request('POST', '/api/services/mobile-recharge', { operator: 'Ooredoo', amount: 5.0, phoneNumber: '22113344' }, token);
    record('Mobile Recharge Flow', rechargeRes.status === 200 && rechargeRes.body.success);

    // 20. Services: Donation
    const donateRes = await request('POST', '/api/services/donate', { organization: 'Red Cross', amount: 2.0 }, token);
    record('Donation Flow', donateRes.status === 200 && donateRes.body.success);

    // 21. Edge Case: Insufficient Balance Purchase
    const overspendRes = await request('POST', '/api/services/donate', { organization: 'UNICEF', amount: 999999.0 }, token);
    record('Edge Case: Insufficient Balance Error Handling', overspendRes.status === 400 && !overspendRes.body.success, 'Clean error response returned');

  } catch (err) {
    console.error('❌ Network / Server Error during QA run:', err.message);
  }

  console.log('\n==================================================');
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  console.log(`📊 QA RESULT SUMMARY: ${passed}/${total} Tests Passed (${Math.round((passed / total) * 100)}%)`);
  console.log('==================================================\n');
}

runQA();
