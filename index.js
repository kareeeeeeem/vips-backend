const express  = require('express');
const cors     = require('cors');
const dotenv   = require('dotenv');
const mongoose = require('mongoose');

dotenv.config();

const app = express();

// ─── Middleware ────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'vendorType', 'localization_key', 'module_id'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ─── Simple in-memory rate limiter ────────────────────────
const rateLimitMap = new Map();
const rateLimit = (maxRequests, windowMs) => (req, res, next) => {
  const key = req.ip + ':' + req.path;
  const now = Date.now();
  const windowStart = now - windowMs;
  const requests = (rateLimitMap.get(key) || []).filter(t => t > windowStart);
  if (requests.length >= maxRequests) {
    return res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
  }
  requests.push(now);
  rateLimitMap.set(key, requests);
  next();
};

// Apply rate limiting to auth endpoints (10 requests per minute)
app.use('/api/auth', rateLimit(10, 60000));

// ═══════════════════════════════════════════════════════════
// USER-SIDE ROUTES
// ═══════════════════════════════════════════════════════════
const authRoutes      = require('./routes/auth');
const userRoutes      = require('./routes/user');
const contentRoutes   = require('./routes/content');
const orderRoutes     = require('./routes/order');
const servicesRoutes  = require('./routes/services');
const rewardsRoutes   = require('./routes/rewards');
const favoritesRoutes = require('./routes/favorites');
const cartRoutes      = require('./routes/cart');

app.use('/api/auth',      authRoutes);
app.use('/api/user',      userRoutes);
app.use('/api/content',   contentRoutes);
app.use('/api/order',     orderRoutes);
app.use('/api/services',  servicesRoutes);
app.use('/api/rewards',   rewardsRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/cart',      cartRoutes);

// ═══════════════════════════════════════════════════════════
// MERCHANT-SIDE ROUTES
// ═══════════════════════════════════════════════════════════
const merchantRoutes           = require('./routes/merchant');
const merchantBillingRoutes    = require('./routes/merchant_billing');
const merchantAdsRoutes        = require('./routes/merchant_ads');
const merchantBarcodeRoutes    = require('./routes/merchant_barcode');
const merchantCreditRoutes     = require('./routes/merchant_credit');
const merchantPartnershipRoutes= require('./routes/merchant_partnership');
const merchantSubscriptionRoutes=require('./routes/merchant_subscription');
const merchantNotifRoutes      = require('./routes/merchant_notifications');
const assetsRoutes             = require('./routes/assets');
const hrmRoutes                = require('./routes/hrm');
const duesRoutes               = require('./routes/dues');
const taxRoutes                = require('./routes/tax');

// Core merchant endpoints (profile, orders, finance, cashiers, etc.)
app.use('/api/merchant',                    merchantRoutes);

// Feature-specific merchant endpoints
app.use('/api/merchant/billing',            merchantBillingRoutes);
app.use('/api/merchant/ads',               merchantAdsRoutes);
app.use('/api/merchant/barcodes',           merchantBarcodeRoutes);
app.use('/api/merchant/credits',            merchantCreditRoutes);
app.use('/api/merchant/partnership',        merchantPartnershipRoutes);
app.use('/api/merchant/subscription',       merchantSubscriptionRoutes);
app.use('/api/merchant/notifications',      merchantNotifRoutes);
app.use('/api/merchant/assets',             assetsRoutes);
app.use('/api/merchant/staff',              hrmRoutes);
app.use('/api/merchant/dues',               duesRoutes);
app.use('/api/merchant/tax-rates',          taxRoutes);

// ═══════════════════════════════════════════════════════════
// UPLOAD ROUTE
// ═══════════════════════════════════════════════════════════
const uploadRoutes = require('./routes/upload');
app.use('/api/upload', uploadRoutes);
app.use('/uploads', express.static(require('path').join(__dirname, 'uploads')));

// ─── Config: conversion rates ─────────────────────────────
app.get('/api/config/rates', (req, res) => {
  res.json({ success: true, data: { vipsToTnd: 0.1, conversionRate: 0.1 } });
});

// ─── User: payment methods (placeholder — no live gateway) ─
app.get('/api/user/payment-methods', (req, res) => {
  res.json({ success: true, data: { cards: [] } });
});

// ─── Admin: update employee ────────────────────────────────
const { authMiddleware, requireRole } = require('./middleware/auth');
app.put('/api/admin/employees/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { name, email } = req.body;
    const Employee = require('./models/Employee');
    const emp = await Employee.findByIdAndUpdate(
      req.params.id,
      { name, email },
      { new: true }
    );
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({ success: true, data: emp });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Health Check ─────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const dbStates = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  const dbReadyState = mongoose.connection.readyState;
  res.json({
    status:    'ok',
    message:   'VIPs Backend is running',
    timestamp: new Date().toISOString(),
    db: {
      readyState: dbReadyState,
      status:     dbStates[dbReadyState] || 'unknown',
    },
    // Boolean + error message only — never the raw FIREBASE_SERVICE_ACCOUNT
    // value — so social-login misconfiguration can be diagnosed without
    // dashboard/log access.
    firebaseAdmin: require('./utils/firebaseAdmin').getInitStatus(),
  });
});

// ─── Global Error Handler ─────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
  });
});

// ─── Database & Server ────────────────────────────────────
const PORT = process.env.PORT || 3000;

const { runAutoSeeder } = require('./utils/autoSeeder');

mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('✅ Connected to MongoDB');
    if (process.env.NODE_ENV === 'production') {
      console.log('⚠️  Skipping auto-seeder in production (hardcoded demo accounts must not be created against a live DB).');
    } else {
      await runAutoSeeder();
    }
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    console.log('⚠️  Starting server WITHOUT database...');
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT} (No DB)`);
    });
  });
