// Synthetic fixtures for device UI verification, used only by run-isolated.
module.exports = async function seedUi(env) {
  if (!env.MONGODB_URI.includes('/vips_qa_') || env.NODE_ENV !== 'test') {
    throw new Error('UI fixtures require an isolated test database');
  }
  const User = require('../models/User');
  const Product = require('../models/Product');
  const Deal = require('../models/Deal');
  const merchant = await User.create({ fullName: 'QA Merchant', email: 'merchant@vips.test',
    phone: '21699000001', password: 'UiTest123!', role: 'merchant', storeName: 'QA Store',
    storeAddress: 'Test Street 1', storeCategory: 'Food', isTrending: true, isVerified: true });
  const user = await User.create({ fullName: 'QA Customer', email: 'customer@vips.test',
    phone: '21699000002', password: 'UiTest123!', role: 'customer', isVerified: true,
    walletBalance: 500, walletPoints: 10000, city: 'Tunis' });
  const product = await Product.create({ merchantId: merchant.id, name: 'QA Coffee',
    description: 'Synthetic UI test product', price: 10, category: 'Food', stock: 100, isFeature: true });
  const deal = await Deal.create({ merchantId: merchant.id, title: 'QA Lunch Deal',
    description: 'Synthetic UI test offer', image: 'http://127.0.0.1:3100/uploads/1787822925945-732605579.png', currentPrice: 15, originalPrice: 20,
    discount: 25, category: 'Food', endTime: new Date(Date.now() + 86400000) });
  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ id: user.id, role: 'customer' }, env.JWT_SECRET, { expiresIn: '8h' });
  require('node:fs').writeFileSync('/tmp/vips-ui-config.json', JSON.stringify({
    API_BASE_URL: env.TEST_URL, QA_TOKEN: token,
    QA_PRODUCT_ID: product.id, QA_DEAL_ID: deal.id, QA_MERCHANT_ID: merchant.id,
  }), { mode: 0o600 });
  console.log('Synthetic UI fixtures created; local test configuration: /tmp/vips-ui-config.json');
};
