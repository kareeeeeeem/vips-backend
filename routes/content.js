const express = require('express');
const Deal = require('../models/Deal');
const Outing = require('../models/Outing');
const User = require('../models/User');
const Product = require('../models/Product');
const Promotion = require('../models/Promotion');
const Order = require('../models/Order');
const { authMiddleware, optionalAuthMiddleware } = require('../middleware/auth');
const { runAutoSeeder } = require('../utils/autoSeeder');

const router = express.Router();

// Real per-product stats derived from actual Orders, so product cards and
// the detail page stop showing a hardcoded 5.0 rating / 0 sell count for
// everything. `items.productId` is a Mixed field set by the client to the
// product's _id.toString() (see order.js's normalizeItems) — matched as a
// string here for the same reason. Order-level rating (POST /order/:id/review)
// isn't per-line-item, so an order containing several products has its one
// rating counted toward each of them — an approximation, not exact, but the
// data model has no finer-grained rating to draw from.
async function computeProductStats(productIds) {
  if (!productIds.length) return {};
  const [salesAgg, ratingAgg] = await Promise.all([
    Order.aggregate([
      { $unwind: '$items' },
      { $match: { 'items.productId': { $in: productIds }, status: { $ne: 'cancelled' } } },
      { $group: { _id: '$items.productId', salesCount: { $sum: '$items.quantity' } } },
    ]),
    Order.aggregate([
      { $match: { rating: { $gt: 0 } } },
      { $unwind: '$items' },
      { $match: { 'items.productId': { $in: productIds } } },
      { $group: { _id: '$items.productId', avgRating: { $avg: '$rating' }, reviewCount: { $sum: 1 } } },
    ]),
  ]);
  const stats = {};
  salesAgg.forEach((s) => { stats[s._id] = { ...(stats[s._id] || {}), salesCount: s.salesCount }; });
  ratingAgg.forEach((r) => {
    stats[r._id] = {
      ...(stats[r._id] || {}),
      avgRating: Math.round(r.avgRating * 10) / 10,
      reviewCount: r.reviewCount,
    };
  });
  return stats;
}

// ─── INIT SEED DATA ─────────────────────────────────────────
async function seedContent() {
  try {
    // Seed promotions
    const promoCount = await Promotion.countDocuments();
    if (promoCount === 0) {
      await Promotion.insertMany([
        {
          title: 'FREE SHIPPING',
          subtitle: 'On orders above 500 pts',
          type: 'shipping',
          code: 'FREESHIP',
          discount: 100,
          minOrderValue: 500,
          expiresAt: new Date(Date.now() + 30 * 86400000),
          isActive: true,
        },
        {
          title: '20% OFF',
          subtitle: 'On your next purchase',
          type: 'discount',
          code: 'SAVE20',
          discount: 20,
          minOrderValue: 200,
          expiresAt: new Date(Date.now() + 14 * 86400000),
          isActive: true,
        },
        {
          title: 'DOUBLE POINTS',
          subtitle: 'Earn 2x VIPs diamonds on weekends',
          type: 'points',
          code: 'DOUBLE2X',
          discount: 0,
          minOrderValue: 0,
          expiresAt: new Date(Date.now() + 30 * 86400000),
          isActive: true,
        },
        {
          title: '10% CASHBACK',
          subtitle: 'Get 10% cashback on all food orders',
          type: 'cashback',
          code: 'CASH10',
          discount: 10,
          minOrderValue: 100,
          expiresAt: new Date(Date.now() + 7 * 86400000),
          isActive: true,
        },
      ]);
    }

    const dealCount = await Deal.countDocuments();
    if (dealCount === 0) {
      await Deal.insertMany([
        { title: 'Dream Park', description: '29% off @Dream Park', image: 'https://images.unsplash.com/photo-1569973189506-82c9b96b8e30?ixlib=rb-4.0.3&auto=format&fit=crop&w=1000&q=80', currentPrice: 265, originalPrice: 375, discount: 29, category: 'entertainment' },
        { title: 'El Demeshky', description: 'Syrian & Egyptian dishes', image: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ca4b?ixlib=rb-4.0.3&auto=format&fit=crop&w=1000&q=80', currentPrice: 99, originalPrice: 150, discount: 37, category: 'food' },
        { title: 'Mega Pizza Deal', description: 'Large Pizza + 2 Sides', image: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?ixlib=rb-4.0.3&auto=format&fit=crop&w=1000&q=80', currentPrice: 150, originalPrice: 300, discount: 50, category: 'food', endTime: new Date(Date.now() + 12 * 3600000) }
      ]);
    }

    const outingCount = await Outing.countDocuments();
    if (outingCount === 0) {
      await Outing.insertMany([
        { title: 'Mall Of Egypt Offers', subtitle: 'Shopping & Entertainment', image: 'https://images.unsplash.com/photo-1555529669-e69e7aa0ba9a?ixlib=rb-4.0.3&auto=format&fit=crop&w=1000&q=80', category: 'Shopping', location: 'New Cairo', type: 'mall' },
        { title: 'Walk of Cairo', subtitle: 'Outdoor Shopping Experience', image: 'https://images.unsplash.com/photo-1508739773434-c26b3d09e071?ixlib=rb-4.0.3&auto=format&fit=crop&w=1000&q=80', category: 'Outdoor', location: 'New Capital', type: 'outdoor' }
      ]);
    }

    const productCount = await Product.countDocuments();
    if (productCount === 0) {
      // Find or create a merchant user for products
      let merchant = await User.findOne({ role: 'merchant' });
      if (!merchant) {
        merchant = await User.findOne();
        if (!merchant) {
          merchant = await User.create({
            fullName: 'VIPs Merchant Store',
            email: 'merchant@vips.com',
            phone: '12345678',
            password: 'password123',
            role: 'merchant',
            storeName: 'Saas Software Shop',
            storeCategory: 'Photo'
          });
        }
      }

      await Product.insertMany([
        {
          merchantId: merchant._id,
          name: 'Saas Landing Software Theme',
          description: 'A beautiful landing software theme for businesses',
          price: 50.0,
          image: 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=300&h=200&fit=crop',
          category: 'Photo'
        },
        {
          merchantId: merchant._id,
          name: 'Oifolio-Digital Marketing Theme',
          description: 'A digital marketing portfolio template',
          price: 60.0,
          image: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=300&h=200&fit=crop',
          category: 'Course'
        },
        {
          merchantId: merchant._id,
          name: 'Minimoll - Fashion eCommerce',
          description: 'Sleek eCommerce landing page',
          price: 27.0,
          image: 'https://images.unsplash.com/photo-1542744173-8e7e53415bb0?w=300&h=200&fit=crop',
          category: 'E-book'
        },
        {
          merchantId: merchant._id,
          name: 'FoodBari - Flutter Food Restaurant',
          description: 'Beautiful Flutter UI for a restaurant application',
          price: 15.0,
          image: 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=300&h=200&fit=crop',
          category: 'Photo'
        },
        {
          merchantId: merchant._id,
          name: 'Apps Premium Landing Theme',
          description: 'High-converting mobile app landing page',
          price: 33.0,
          image: 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=300&h=200&fit=crop',
          category: 'Course'
        },
        {
          merchantId: merchant._id,
          name: 'Business Corporate Theme',
          description: 'Professional layout for businesses',
          price: 45.0,
          image: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=300&h=200&fit=crop',
          category: 'Guide'
        },
        {
          merchantId: merchant._id,
          name: 'Universal Studios Ticket Pass',
          description: 'Fast track ticket to Universal Studios parks',
          price: 120.0,
          image: 'https://images.unsplash.com/photo-1508739773434-c26b3d09e071?w=300&h=200&fit=crop',
          category: 'Ticket'
        },
        {
          merchantId: merchant._id,
          name: 'Ultimate Dev Startup Guide',
          description: 'Learn how to build and scale your coding business',
          price: 19.0,
          image: 'https://images.unsplash.com/photo-1486312338219-ce68d2c6f44d?w=300&h=200&fit=crop',
          category: 'Guide'
        }
      ]);
    }
  } catch (e) {
    console.log('Seeding error:', e.message);
  }
}
seedContent();

// ─── GET /api/content/hot-deals ───────────────────────────
router.get('/hot-deals', optionalAuthMiddleware, async (req, res) => {
  try {
    let deals = await Deal.find({ endTime: null }).sort({ createdAt: -1 });
    if (deals.length === 0) {
      await runAutoSeeder();
      deals = await Deal.find({ endTime: null }).sort({ createdAt: -1 });
    }
    res.json({ success: true, data: deals });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/content/ending-soon-deals ───────────────────
router.get('/ending-soon-deals', optionalAuthMiddleware, async (req, res) => {
  try {
    let deals = await Deal.find({ endTime: { $ne: null, $gt: new Date() } }).sort({ endTime: 1 });
    if (deals.length === 0) {
      await runAutoSeeder();
      deals = await Deal.find({ endTime: { $ne: null, $gt: new Date() } }).sort({ endTime: 1 });
    }
    res.json({ success: true, data: deals });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/content/outings ─────────────────────────────
router.get('/outings', optionalAuthMiddleware, async (req, res) => {
  try {
    let outings = await Outing.find().sort({ createdAt: -1 });
    if (outings.length === 0) {
      await runAutoSeeder();
      outings = await Outing.find().sort({ createdAt: -1 });
    }
    res.json({ success: true, data: outings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/content/trending-merchants ──────────────────
router.get('/trending-merchants', optionalAuthMiddleware, async (req, res) => {
  try {
    let merchants = await User.find({ role: 'merchant', isTrending: true })
      .select('storeName storeCategory logo brandColor discountPercentage')
      .sort({ createdAt: -1 });
    if (merchants.length === 0) {
      await runAutoSeeder();
      merchants = await User.find({ role: 'merchant', isTrending: true })
        .select('storeName storeCategory logo brandColor discountPercentage')
        .sort({ createdAt: -1 });
    }
    res.json({ success: true, data: merchants });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/content/products ────────────────────────────
router.get('/products', optionalAuthMiddleware, async (req, res) => {
  try {
    const { category } = req.query;
    const filter = {};
    if (category && category !== 'All') filter.category = category;

    let products = await Product.find(filter).sort({ createdAt: -1 });
    if (products.length === 0) {
      await runAutoSeeder();
      products = await Product.find(filter).sort({ createdAt: -1 });
    }

    const stats = await computeProductStats(products.map((p) => p._id.toString()));
    const data = products.map((p) => {
      const s = stats[p._id.toString()] || {};
      const obj = p.toObject();
      obj.salesCount = s.salesCount || 0;
      obj.avgRating = s.avgRating || 0;
      obj.reviewCount = s.reviewCount || 0;
      return obj;
    });

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/content/products/:id ─────────────────────────
// Single product with real comments (commenter names populated), real
// merchant name, and the same real sales/rating stats as the list
// endpoint — previously didn't exist at all, so the product detail
// screen showed hardcoded fake description/comments/reviews/tags/
// related-products regardless of which real product was opened.
router.get('/products/:id', optionalAuthMiddleware, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
      .populate('merchantId', 'storeName fullName')
      .populate('comments.userId', 'fullName');
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    const stats = await computeProductStats([product._id.toString()]);
    const s = stats[product._id.toString()] || {};

    const obj = product.toObject();
    obj.salesCount = s.salesCount || 0;
    obj.avgRating = s.avgRating || 0;
    obj.reviewCount = s.reviewCount || 0;
    obj.merchantName = product.merchantId?.storeName || product.merchantId?.fullName || null;
    obj.comments = (obj.comments || [])
      .map((c) => ({ ...c, userName: c.userId?.fullName || 'VIPs User' }))
      .reverse();

    res.json({ success: true, data: obj });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/content/search ──────────────────────────────
// `category` and `sort` used to be silently ignored — the app's filter
// sheet (category chips + sort options) looked functional but never
// changed the results. Now both are actually applied.
router.get('/search', optionalAuthMiddleware, async (req, res) => {
  try {
    const { q = '', category, sort } = req.query;
    const regex = new RegExp(q, 'i');
    const catRegex = category && category !== 'All' ? new RegExp(`^${category}$`, 'i') : null;

    // "Outings" in the category picker means "only show outings", not a
    // literal category value to match against every collection.
    const onlyOutings = catRegex && category.toLowerCase() === 'outings';

    const dealFilter = { $or: [{ title: regex }, { description: regex }] };
    const outingFilter = { $or: [{ title: regex }, { subtitle: regex }, { category: regex }] };
    const merchantFilter = { role: 'merchant', $or: [{ storeName: regex }, { storeCategory: regex }] };
    const productFilter = { $or: [{ name: regex }, { description: regex }, { category: regex }] };

    if (catRegex && !onlyOutings) {
      dealFilter.category = catRegex;
      merchantFilter.storeCategory = catRegex;
      productFilter.category = catRegex;
    }

    let dealSort = {}, outingSort = {}, productSort = {};
    switch (sort) {
      case 'Price: Low to High':
        dealSort = { currentPrice: 1 };
        productSort = { price: 1 };
        break;
      case 'Price: High to Low':
        dealSort = { currentPrice: -1 };
        productSort = { price: -1 };
        break;
      case 'Newest':
        dealSort = outingSort = productSort = { createdAt: -1 };
        break;
      case 'Rating':
        dealSort = { rating: -1 };
        outingSort = { rating: -1 };
        break;
      default:
        break; // Relevance — no explicit sort
    }

    const [deals, outings, merchants, products] = await Promise.all([
      onlyOutings ? [] : Deal.find(dealFilter).sort(dealSort).limit(5),
      catRegex && !onlyOutings ? [] : Outing.find(outingFilter).sort(outingSort).limit(5),
      onlyOutings ? [] : User.find(merchantFilter)
        .select('storeName storeCategory logo brandColor discountPercentage').limit(5),
      onlyOutings ? [] : Product.find(productFilter).sort(productSort).limit(5),
    ]);

    // If everything empty (and no filter narrowed it down), reseed and retry once
    if (!deals.length && !outings.length && !merchants.length && !products.length && !catRegex) {
      await runAutoSeeder();
    }

    res.json({
      success: true,
      data: { deals, outings, merchants, products },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/content/promotions ──────────────────────────
router.get('/promotions', optionalAuthMiddleware, async (req, res) => {
  try {
    const now = new Date();
    let promotions = await Promotion.find({ isActive: true, expiresAt: { $gt: now } }).sort({ createdAt: -1 });
    if (promotions.length === 0) {
      await runAutoSeeder();
      promotions = await Promotion.find({ isActive: true, expiresAt: { $gt: now } }).sort({ createdAt: -1 });
    }
    res.json({ success: true, data: promotions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/catalog', authMiddleware, async (req, res) => {
  try {
    const { category } = req.query;
    const filter = { merchantId: req.user.id };
    if (category && category !== 'All') filter.category = category;
    const products = await Product.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, data: products });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/catalog', authMiddleware, async (req, res) => {
  try {
    const { name, category, price, image, description, isFeature, hasVariants } = req.body;
    const product = await Product.create({
      merchantId: req.user.id,
      name,
      category,
      price,
      image,
      description,
      isFeature,
      hasVariants,
    });
    res.status(201).json({ success: true, message: 'Product created successfully!', data: product });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/catalog/:id', authMiddleware, async (req, res) => {
  try {
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      req.body,
      { new: true, runValidators: true }
    );
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
    res.json({ success: true, message: 'Product updated successfully!', data: product });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/catalog/:id', authMiddleware, async (req, res) => {
  try {
    const product = await Product.findOneAndDelete({ _id: req.params.id, merchantId: req.user.id });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
    res.json({ success: true, message: 'Product deleted successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/catalog/:id/status', authMiddleware, async (req, res) => {
  try {
    const { isActive } = req.body;
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      { isActive },
      { new: true }
    );
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
    res.json({ success: true, message: 'Product status updated!', data: product });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/catalog/:id/stock', authMiddleware, async (req, res) => {
  try {
    const { stock } = req.body;
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      { stock },
      { new: true }
    );
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
    res.json({ success: true, message: 'Product stock updated!', data: product });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/content/products/:id/comment ──────────────────
router.post('/products/:id/comment', authMiddleware, async (req, res) => {
  try {
    const { comment } = req.body;
    if (!comment || !comment.trim()) {
      return res.status(400).json({ success: false, message: 'Comment text is required' });
    }
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    if (!product.comments) product.comments = [];
    product.comments.push({
      userId: req.user.id,
      text: comment.trim(),
      createdAt: new Date(),
    });
    await product.save();

    res.json({ success: true, message: 'Comment submitted', data: { comment: comment.trim() } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/content/deals/:id/redeem ──────────────────────
router.post('/deals/:id/redeem', authMiddleware, async (req, res) => {
  try {
    const deal = await Deal.findById(req.params.id);
    if (!deal) return res.status(404).json({ success: false, message: 'Deal not found' });
    if (!deal.isActive) return res.status(400).json({ success: false, message: 'Deal is no longer active' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Record the redemption in cart
    const itemId = deal._id.toString();
    const existing = user.cart.find(c => c.itemId?.toString() === itemId);
    if (existing) {
      existing.quantity = (existing.quantity || 1) + 1;
    } else {
      user.cart.push({
        itemId,
        itemType: 'deal',
        name: deal.title,
        price: deal.currentPrice ?? deal.price ?? 0,
        quantity: 1,
        merchantId: deal.merchantId,
      });
    }
    await user.save();

    res.json({ success: true, message: 'Deal added to cart!', data: { dealId: deal._id, title: deal.title } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
