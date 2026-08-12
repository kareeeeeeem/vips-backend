/**
 * autoSeeder.js — runs once on startup, fills every empty collection
 * so the app NEVER renders empty screens during development.
 */

const Deal        = require('../models/Deal');
const Outing      = require('../models/Outing');
const Product     = require('../models/Product');
const Promotion   = require('../models/Promotion');
const BillService = require('../models/BillService');
const GiftVoucherBrand = require('../models/GiftVoucherBrand');
const Coupon      = require('../models/Coupon');
const User        = require('../models/User');
const Transaction = require('../models/Transaction');
const UserNotification = require('../models/UserNotification');
const MerchantAd  = require('../models/MerchantAd');

// ─── Shared image pools ─────────────────────────────────────────────────────
const FOOD_IMGS = [
  'https://images.unsplash.com/photo-1565299624946-b28f40a0ca4b?w=600&h=400&fit=crop',
  'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600&h=400&fit=crop',
  'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=600&h=400&fit=crop',
  'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=600&h=400&fit=crop',
];
const ENT_IMGS = [
  'https://images.unsplash.com/photo-1569973189506-82c9b96b8e30?w=600&h=400&fit=crop',
  'https://images.unsplash.com/photo-1508739773434-c26b3d09e071?w=600&h=400&fit=crop',
  'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600&h=400&fit=crop',
];
const SHOP_IMGS = [
  'https://images.unsplash.com/photo-1555529669-e69e7aa0ba9a?w=600&h=400&fit=crop',
  'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=600&h=400&fit=crop',
  'https://images.unsplash.com/photo-1601924994987-69e26d50dc26?w=600&h=400&fit=crop',
];
const TECH_IMGS = [
  'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=600&h=400&fit=crop',
  'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=600&h=400&fit=crop',
  'https://images.unsplash.com/photo-1486312338219-ce68d2c6f44d?w=600&h=400&fit=crop',
];

// ─── 1. HOT DEALS (permanent, endTime = null) ────────────────────────────────
async function seedHotDeals() {
  const count = await Deal.countDocuments({ endTime: null });
  if (count >= 5) return;
  await Deal.deleteMany({ endTime: null });
  await Deal.insertMany([
    { title: 'Dream Park Adventure', description: '29% off @ Dream Park — rides & shows included', image: ENT_IMGS[0], currentPrice: 265, originalPrice: 375, discount: 29, rating: 4.7, category: 'entertainment' },
    { title: 'Mega Pizza Feast', description: 'Large Pizza + 2 Sides + soft drink', image: FOOD_IMGS[0], currentPrice: 89, originalPrice: 150, discount: 41, rating: 4.5, category: 'food' },
    { title: 'Syrian Kitchen Special', description: 'Authentic Syrian & Egyptian dishes for two', image: FOOD_IMGS[1], currentPrice: 99, originalPrice: 160, discount: 38, rating: 4.8, category: 'food' },
    { title: 'Mall of Egypt VIP Pass', description: 'Skip-the-line shopping + 15% store discounts', image: SHOP_IMGS[0], currentPrice: 180, originalPrice: 250, discount: 28, rating: 4.6, category: 'shopping' },
    { title: 'Tech Bundle Deal', description: 'Laptop stand + keyboard + mouse combo', image: TECH_IMGS[0], currentPrice: 299, originalPrice: 450, discount: 34, rating: 4.4, category: 'electronics' },
    { title: 'Spa & Wellness Day', description: 'Full day spa access + 60-min massage', image: 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=600&h=400&fit=crop', currentPrice: 320, originalPrice: 500, discount: 36, rating: 4.9, category: 'wellness' },
    { title: 'Cinema Night Out', description: 'Premium seat + popcorn + drink combo', image: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=600&h=400&fit=crop', currentPrice: 75, originalPrice: 120, discount: 38, rating: 4.3, category: 'entertainment' },
  ]);
  console.log('🌱 Seeded hot deals');
}

// ─── 2. ENDING SOON DEALS (endTime set) ─────────────────────────────────────
async function seedEndingSoonDeals() {
  const count = await Deal.countDocuments({ endTime: { $ne: null, $gt: new Date() } });
  if (count >= 3) return;
  await Deal.deleteMany({ endTime: { $ne: null } });
  const base = Date.now();
  await Deal.insertMany([
    { title: 'Flash Burger Offer', description: 'Double smash burger + fries — today only!', image: FOOD_IMGS[3], currentPrice: 55, originalPrice: 110, discount: 50, rating: 4.6, category: 'food', endTime: new Date(base + 4 * 3600000) },
    { title: 'Weekend Escape Package', description: 'Hotel night + breakfast + pool access', image: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=600&h=400&fit=crop', currentPrice: 750, originalPrice: 1200, discount: 38, rating: 4.8, category: 'travel', endTime: new Date(base + 12 * 3600000) },
    { title: 'Fitness Class Bundle', description: '10 yoga/pilates classes at premium studios', image: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=600&h=400&fit=crop', currentPrice: 195, originalPrice: 350, discount: 44, rating: 4.7, category: 'wellness', endTime: new Date(base + 24 * 3600000) },
    { title: 'Dessert Extravaganza', description: 'Box of 12 premium macarons + hot drink', image: 'https://images.unsplash.com/photo-1464349095431-e9a21285b5f3?w=600&h=400&fit=crop', currentPrice: 45, originalPrice: 80, discount: 44, rating: 4.5, category: 'food', endTime: new Date(base + 6 * 3600000) },
  ]);
  console.log('🌱 Seeded ending-soon deals');
}

// ─── 3. OUTINGS ──────────────────────────────────────────────────────────────
async function seedOutings() {
  const count = await Outing.countDocuments();
  if (count >= 4) return;
  await Outing.deleteMany({});
  await Outing.insertMany([
    { title: 'Mall Of Egypt Offers', subtitle: 'Shopping & Entertainment Hub', image: SHOP_IMGS[0], category: 'Shopping', location: 'New Cairo', type: 'mall', rating: 4.6 },
    { title: 'Walk of Cairo', subtitle: 'Outdoor Shopping Experience', image: 'https://images.unsplash.com/photo-1481026469463-66327c86e544?w=600&h=400&fit=crop', category: 'Outdoor', location: 'New Capital', type: 'outdoor', rating: 4.5 },
    { title: 'City Stars Plaza', subtitle: 'Retail Therapy & Dining', image: SHOP_IMGS[1], category: 'Shopping', location: 'Heliopolis', type: 'mall', rating: 4.7 },
    { title: 'Al Azhar Park', subtitle: 'Green oasis in the heart of Cairo', image: 'https://images.unsplash.com/photo-1501854140801-50d01698950b?w=600&h=400&fit=crop', category: 'Outdoor', location: 'Old Cairo', type: 'outdoor', rating: 4.8 },
    { title: 'Porto Marina Resort', subtitle: 'Beach, pools & entertainment', image: 'https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=600&h=400&fit=crop', category: 'Beach', location: 'North Coast', type: 'resort', rating: 4.9 },
    { title: 'Grand Egyptian Museum', subtitle: 'World heritage at your doorstep', image: 'https://images.unsplash.com/photo-1539650116574-8efeb43e2750?w=600&h=400&fit=crop', category: 'Culture', location: 'Giza', type: 'museum', rating: 4.9 },
  ]);
  console.log('🌱 Seeded outings');
}

// ─── 4. PRODUCTS ─────────────────────────────────────────────────────────────
async function seedProducts() {
  const count = await Product.countDocuments();
  if (count >= 6) return;
  let merchant = await User.findOne({ role: 'merchant' });
  if (!merchant) {
    merchant = await User.create({ fullName: 'VIPs Store', email: 'store@vips.com', phone: '00000001', password: 'Pass1234!', role: 'merchant', storeName: 'VIPs Digital Store', storeCategory: 'Digital' });
  }
  await Product.deleteMany({});
  await Product.insertMany([
    { merchantId: merchant._id, name: 'Saas Landing Software Theme', description: 'High-converting SaaS landing page template', price: 50, image: TECH_IMGS[0], category: 'Photo' },
    { merchantId: merchant._id, name: 'Oifolio Digital Marketing Theme', description: 'Digital marketing portfolio template', price: 60, image: TECH_IMGS[1], category: 'Course' },
    { merchantId: merchant._id, name: 'Minimoll Fashion eCommerce', description: 'Sleek eCommerce landing page template', price: 27, image: 'https://images.unsplash.com/photo-1542744173-8e7e53415bb0?w=300&h=200&fit=crop', category: 'E-book' },
    { merchantId: merchant._id, name: 'FoodBari Flutter Restaurant UI', description: 'Beautiful Flutter UI for food apps', price: 15, image: FOOD_IMGS[3], category: 'Photo' },
    { merchantId: merchant._id, name: 'Apps Premium Landing Theme', description: 'High-converting mobile app landing', price: 33, image: TECH_IMGS[2], category: 'Course' },
    { merchantId: merchant._id, name: 'Business Corporate Theme', description: 'Professional layout for businesses', price: 45, image: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=300&h=200&fit=crop', category: 'Guide' },
    { merchantId: merchant._id, name: 'Universal Studios Ticket Pass', description: 'Fast track ticket to Universal Studios', price: 120, image: ENT_IMGS[1], category: 'Ticket' },
    { merchantId: merchant._id, name: 'Ultimate Dev Startup Guide', description: 'Build and scale your coding business', price: 19, image: TECH_IMGS[1], category: 'Guide' },
    { merchantId: merchant._id, name: 'Travel Booking Platform UI', description: 'Complete travel booking Flutter template', price: 42, image: 'https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=300&h=200&fit=crop', category: 'E-book' },
    { merchantId: merchant._id, name: 'Fitness App UI Kit', description: 'Complete workout & health UI kit', price: 38, image: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=300&h=200&fit=crop', category: 'Course' },
  ]);
  console.log('🌱 Seeded products');
}

// ─── 5. PROMOTIONS ──────────────────────────────────────────────────────────
async function seedPromotions() {
  const now = new Date();
  const count = await Promotion.countDocuments({ isActive: true, expiresAt: { $gt: now } });
  if (count >= 4) return;
  await Promotion.deleteMany({});
  const d = (days) => new Date(Date.now() + days * 86400000);
  await Promotion.insertMany([
    { title: 'FREE SHIPPING', subtitle: 'On all orders above 500 pts', type: 'shipping', code: 'FREESHIP', discount: 100, minOrderValue: 500, expiresAt: d(30), isActive: true },
    { title: '20% OFF', subtitle: 'On your next purchase', type: 'discount', code: 'SAVE20', discount: 20, minOrderValue: 200, expiresAt: d(14), isActive: true },
    { title: 'DOUBLE POINTS', subtitle: 'Earn 2× VIPs diamonds this weekend', type: 'points', code: 'DOUBLE2X', discount: 0, minOrderValue: 0, expiresAt: d(30), isActive: true },
    { title: '10% CASHBACK', subtitle: 'On all food orders', type: 'cashback', code: 'CASH10', discount: 10, minOrderValue: 100, expiresAt: d(7), isActive: true },
    { title: 'WELCOME BONUS', subtitle: 'New user 15% off first order', type: 'discount', code: 'WELCOME15', discount: 15, minOrderValue: 50, expiresAt: d(60), isActive: true },
  ]);
  console.log('🌱 Seeded promotions');
}

// ─── 6. BILL SERVICES ────────────────────────────────────────────────────────
async function seedBillServices() {
  const count = await BillService.countDocuments();
  if (count >= 8) return;
  await BillService.deleteMany({});
  await BillService.insertMany([
    { name: 'Home Internet', provider: 'Tunisie Telecom', type: 'internet', logo: 'https://www.tunisietelecom.tn/favicon.ico', fee: 0 },
    { name: 'Mobile Bills', provider: 'Ooredoo', type: 'mobile', logo: 'https://www.ooredoo.tn/favicon.ico', fee: 0 },
    { name: 'Electric Bill', provider: 'STEG', type: 'electricity', logo: 'https://nabeul.info/wp-content/uploads/2019/09/nabeul-info-steg.jpg', fee: 0 },
    { name: 'Gas Bill', provider: 'STEG', type: 'gas', logo: 'https://nabeul.info/wp-content/uploads/2019/09/nabeul-info-steg.jpg', fee: 0 },
    { name: 'Water Bill', provider: 'SONEDE', type: 'water', logo: 'https://www.sonede.com.tn/wp-content/uploads/2024/03/cropped-logo-sonede-2_Plan-de-travail-1.png', fee: 0 },
    { name: 'TV/Cable', provider: 'Canal+', type: 'tv', logo: 'https://cdn-icons-png.flaticon.com/512/3580/3580296.png', fee: 0 },
    { name: 'Donation', provider: 'Various NGOs', type: 'donation', logo: 'https://cdn-icons-png.flaticon.com/512/2917/2917242.png', fee: 0 },
    { name: 'Education', provider: 'Ministry of Education', type: 'education', logo: 'https://cdn-icons-png.flaticon.com/512/2436/2436874.png', fee: 0 },
    { name: 'Government Services', provider: 'E-Gov', type: 'government', logo: 'https://cdn-icons-png.flaticon.com/512/3437/3437364.png', fee: 0 },
    { name: 'Insurance', provider: 'CNAM', type: 'insurance', logo: 'https://cdn-icons-png.flaticon.com/512/3209/3209265.png', fee: 0 },
  ]);
  console.log('🌱 Seeded bill services');
}

// ─── 7. GIFT VOUCHER BRANDS ──────────────────────────────────────────────────
async function seedGiftVoucherBrands() {
  const count = await GiftVoucherBrand.countDocuments({ isActive: true });
  if (count >= 5) return;
  await GiftVoucherBrand.deleteMany({});
  await GiftVoucherBrand.insertMany([
    { name: 'Carrefour', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2d/Carrefour_Logo.svg/200px-Carrefour_Logo.svg.png', minAmount: 200, maxAmount: 5000, currency: 'TND', isActive: true, category: 'shopping' },
    { name: '2B Electronics', logoUrl: 'https://cdn-icons-png.flaticon.com/512/3659/3659899.png', minAmount: 500, maxAmount: 20000, currency: 'TND', isActive: true, category: 'electronics' },
    { name: 'FiT&F Gym', logoUrl: 'https://cdn-icons-png.flaticon.com/512/2936/2936886.png', minAmount: 200, maxAmount: 1000, currency: 'TND', isActive: true, category: 'fitness' },
    { name: 'Monoprix', logoUrl: 'https://cdn-icons-png.flaticon.com/512/3724/3724788.png', minAmount: 100, maxAmount: 2000, currency: 'TND', isActive: true, category: 'grocery' },
    { name: 'Amazon', logoUrl: 'https://cdn-icons-png.flaticon.com/512/5968/5968217.png', minAmount: 200, maxAmount: 10000, currency: 'USD', isActive: true, category: 'online' },
    { name: 'Netflix', logoUrl: 'https://cdn-icons-png.flaticon.com/512/5977/5977590.png', minAmount: 50, maxAmount: 500, currency: 'USD', isActive: true, category: 'streaming' },
  ]);
  console.log('🌱 Seeded gift voucher brands');
}

// ─── 8. COUPONS ──────────────────────────────────────────────────────────────
async function seedCoupons() {
  const now = new Date();
  const count = await Coupon.countDocuments({ isActive: true, expiryDate: { $gt: now } });
  if (count >= 4) return;
  await Coupon.deleteMany({});
  const exp = (days) => new Date(Date.now() + days * 86400000);
  await Coupon.insertMany([
    { code: 'VIPS10', discount: 10, type: 'percentage', minOrderAmount: 100, maxUses: 500, usedCount: 0, isActive: true, expiryDate: exp(30), description: '10% off any order' },
    { code: 'FLAT50', discount: 50, type: 'fixed', minOrderAmount: 200, maxUses: 200, usedCount: 0, isActive: true, expiryDate: exp(14), description: '50 TND off orders above 200' },
    { code: 'NEWUSER', discount: 15, type: 'percentage', minOrderAmount: 50, maxUses: 1000, usedCount: 0, isActive: true, expiryDate: exp(60), description: '15% welcome discount for new users' },
    { code: 'SUMMER25', discount: 25, type: 'percentage', minOrderAmount: 150, maxUses: 300, usedCount: 0, isActive: true, expiryDate: exp(45), description: '25% summer sale discount' },
    { code: 'WEEKEND20', discount: 20, type: 'percentage', minOrderAmount: 80, maxUses: 400, usedCount: 0, isActive: true, expiryDate: exp(7), description: '20% off this weekend only' },
  ]);
  console.log('🌱 Seeded coupons');
}

// ─── 9. TRENDING MERCHANTS ───────────────────────────────────────────────────
async function seedTrendingMerchants() {
  const count = await User.countDocuments({ role: 'merchant', isTrending: true });
  if (count >= 4) return;
  const existing = await User.countDocuments({ role: 'merchant' });
  if (existing === 0) {
    const merchants = [
      { fullName: 'Burger Palace', email: 'burger@vips.com', phone: '11111001', password: 'Pass1234!', role: 'merchant', storeName: 'Burger Palace', storeCategory: 'Food', isTrending: true, discountPercentage: 25, brandColor: '#FF6B35', logo: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ca4b?w=200&h=200&fit=crop' },
      { fullName: 'TechZone Store', email: 'tech@vips.com', phone: '11111002', password: 'Pass1234!', role: 'merchant', storeName: 'TechZone Store', storeCategory: 'Electronics', isTrending: true, discountPercentage: 15, brandColor: '#0066FF', logo: 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=200&h=200&fit=crop' },
      { fullName: 'Fashion Hub', email: 'fashion@vips.com', phone: '11111003', password: 'Pass1234!', role: 'merchant', storeName: 'Fashion Hub', storeCategory: 'Fashion', isTrending: true, discountPercentage: 30, brandColor: '#E91E63', logo: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=200&h=200&fit=crop' },
      { fullName: 'Fresh Mart', email: 'freshmart@vips.com', phone: '11111004', password: 'Pass1234!', role: 'merchant', storeName: 'Fresh Mart', storeCategory: 'Grocery', isTrending: true, discountPercentage: 10, brandColor: '#4CAF50', logo: 'https://images.unsplash.com/photo-1490818387583-1baba5e638af?w=200&h=200&fit=crop' },
    ];
    for (const m of merchants) {
      await User.findOneAndUpdate({ email: m.email }, m, { upsert: true, new: true });
    }
  } else {
    // Mark first 4 merchants as trending
    const merchantIds = await User.find({ role: 'merchant' }).select('_id').limit(4);
    await User.updateMany({ _id: { $in: merchantIds.map(m => m._id) } }, { isTrending: true, discountPercentage: 20 });
  }
  console.log('🌱 Seeded trending merchants');
}

// ─── 10. DEMO TRANSACTIONS (for new users who have none) ────────────────────
async function seedDemoTransactionsForUser(userId) {
  const count = await Transaction.countDocuments({ userId });
  if (count >= 2) return;
  const d = (days) => new Date(Date.now() - days * 86400000);
  await Transaction.insertMany([
    { userId, type: 'credit', amount: 500, currency: 'TND', description: 'Welcome bonus credit', status: 'completed', reference: `WELCOME-${userId}`, createdAt: d(30) },
    { userId, type: 'expense', amount: 89, currency: 'TND', description: 'Mega Pizza Deal payment', status: 'completed', reference: `BILL-${Date.now() - 1}`, createdAt: d(15) },
    { userId, type: 'reward', amount: 100, currency: 'PTS', description: 'Spin wheel reward: 100 diamonds', status: 'completed', reference: `SPIN-${Date.now() - 2}`, createdAt: d(10) },
    { userId, type: 'expense', amount: 55, currency: 'TND', description: 'Flash Burger Offer payment', status: 'completed', reference: `ORD-${Date.now() - 3}`, createdAt: d(5) },
  ]);
}

// ─── 11. DEMO NOTIFICATIONS (for new users who have none) ───────────────────
async function seedDemoNotificationsForUser(userId) {
  const count = await UserNotification.countDocuments({ userId });
  if (count >= 1) return;
  await UserNotification.insertMany([
    { userId, title: 'Welcome to VIPs! 🎉', message: 'Your account is set up. Explore exclusive deals and start saving today.', type: 'system', isRead: false },
    { userId, title: 'Your wallet has been credited', message: 'We added a 500 TND welcome bonus to your wallet. Start shopping!', type: 'payment', isRead: false },
    { userId, title: 'New Hot Deal Available', message: 'Dream Park Adventure — 29% off. Book now before it expires!', type: 'promotion', isRead: false },
    { userId, title: 'Double Points Weekend 🌟', message: 'Earn 2× VIPs diamonds on every purchase this weekend.', type: 'reward', isRead: false },
    { userId, title: 'Your order has been placed', message: 'Order #001 is being processed. Expected delivery in 30 minutes.', type: 'order', isRead: true },
  ]);
}

// ─── 12. SEED NOTIFICATIONS for existing users with none ────────────────────
async function seedUserNotifications() {
  try {
    const totalNotifs = await UserNotification.countDocuments();
    if (totalNotifs >= 1) return; // notifications already exist globally

    // Find up to 10 customer users and seed welcome notifications for each
    const customers = await User.find({ role: 'customer' }).select('_id').limit(10);
    for (const customer of customers) {
      await seedDemoNotificationsForUser(customer._id);
    }
    if (customers.length > 0) {
      console.log(`🌱 Seeded notifications for ${customers.length} users`);
    }
  } catch (e) {
    console.log('UserNotification seed error:', e.message);
  }
}

// ─── Master runner ───────────────────────────────────────────────────────────
async function runAutoSeeder() {
  console.log('🌱 Running auto-seeder...');
  try {
    await Promise.all([
      seedHotDeals(),
      seedEndingSoonDeals(),
      seedOutings(),
      seedProducts(),
      seedPromotions(),
      seedBillServices(),
      seedGiftVoucherBrands(),
      seedCoupons(),
      seedTrendingMerchants(),
      seedUserNotifications(),
    ]);
    console.log('✅ Auto-seeder complete');
  } catch (e) {
    console.error('❌ Auto-seeder error:', e.message);
  }
}

module.exports = { runAutoSeeder, seedDemoTransactionsForUser, seedDemoNotificationsForUser };
