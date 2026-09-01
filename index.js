const express  = require('express');
const cors     = require('cors');
const { setupChatServer } = require('./websocket/chatServer');
const dotenv   = require('dotenv');
const mongoose = require('mongoose');

dotenv.config();

// ─── Required configuration ───────────────────────────────
// Booting without these does not fail here — it fails later, per request, as
// a 500 that looks like a bug in whatever endpoint happened to be called
// first. JWT_SECRET missing is the worst of them: jwt.sign throws on every
// login, so the platform looks broken rather than misconfigured.
const REQUIRED_ENV = ['MONGODB_URI', 'JWT_SECRET'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`❌ Missing required environment variable(s): ${missingEnv.join(', ')}`);
  console.error('   Set them in .env (local) or the service environment (Render), then restart.');
  process.exit(1);
}

const STARTED_AT = new Date().toISOString();

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

// Entries are pruned when their key is hit again, but a key that is never hit
// again is never pruned — one map entry per IP that ever touched a limited
// route, held for the life of the process. On a long-running dyno that only
// grows. Sweep hourly for anything with no request in the last hour.
const RATE_LIMIT_TTL = 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_TTL;
  for (const [key, times] of rateLimitMap) {
    if (!times.length || times[times.length - 1] < cutoff) rateLimitMap.delete(key);
  }
}, RATE_LIMIT_TTL).unref();

// Apply rate limiting to auth endpoints (10 requests per minute)
app.use('/api/auth', rateLimit(10, 60000));

// The admin console signs in at /api/admin/login, which is NOT under
// /api/auth and so was not covered by the limiter above — the one endpoint
// on the platform that hands out a super_admin token accepted unlimited
// password guesses.
//
// Keyed on the account being attacked, not just the source address. Brute
// force targets one account, so that is what has to be capped; keying on IP
// alone would also mean a shop with several admins behind one connection, or
// a CI run, locks its own people out after eight sign-ins between them. The
// looser per-IP cap on top is what stops one address spraying one password
// across many accounts.
// Only *failed* sign-ins count. Brute force is a stream of wrong passwords;
// a burst of correct ones is a shop opening for the day or a test suite, and
// counting those locked out exactly the people who were allowed in.
const adminLoginLimits = { perAccount: [6, 5 * 60 * 1000], perAddress: [40, 5 * 60 * 1000] };
const adminLoginFailures = new Map();

app.use('/api/admin/login', (req, res, next) => {
  const now = Date.now();
  const email = String(req.body?.email || '').toLowerCase().trim();
  const buckets = [
    ['ip:' + req.ip, ...adminLoginLimits.perAddress],
    ...(email ? [[`acct:${req.ip}:${email}`, ...adminLoginLimits.perAccount]] : []),
  ];

  for (const [key, max, windowMs] of buckets) {
    const hits = (adminLoginFailures.get(key) || []).filter((t) => t > now - windowMs);
    if (hits.length >= max) {
      return res.status(429).json({
        success: false,
        message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
      });
    }
  }

  // Record after the fact, so the counter tracks failures rather than
  // traffic. A correct password also clears the account's own streak —
  // whoever just proved they own it is not the attacker.
  const send = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 401 || res.statusCode === 403) {
      for (const [key, , windowMs] of buckets) {
        const hits = (adminLoginFailures.get(key) || []).filter((t) => t > now - windowMs);
        hits.push(now);
        adminLoginFailures.set(key, hits);
      }
    } else if (res.statusCode < 400 && email) {
      adminLoginFailures.delete(`acct:${req.ip}:${email}`);
    }
    return send(body);
  };
  next();
});

setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_TTL;
  for (const [key, times] of adminLoginFailures) {
    if (!times.length || times[times.length - 1] < cutoff) adminLoginFailures.delete(key);
  }
}, RATE_LIMIT_TTL).unref();

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
const paymentRoutes   = require('./routes/payment');

app.use('/api/auth',      authRoutes);
app.use('/api/user',      userRoutes);
app.use('/api/content',   contentRoutes);
app.use('/api/order',     orderRoutes);
app.use('/api/services',  servicesRoutes);
app.use('/api/rewards',   rewardsRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/cart',      cartRoutes);
app.use('/api/payment',   paymentRoutes);

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
// Stock/assets/tax-rates/staff (HRM) are all served by the crud sub-routers
// mounted inside merchant.js itself at these same paths — dedicated route
// files for them (routes/assets.js, routes/hrm.js, routes/tax.js) used to
// be mounted here too but were 100% unreachable dead code, since Express
// matches '/api/merchant' (registered first) before ever reaching these.
// Only the /dues/:id/collect route isn't covered by merchant.js's generic
// dues CRUD sub-router, so dues.js stays mounted for that one route.
const duesRoutes               = require('./routes/dues');

// Core merchant endpoints (profile, orders, finance, cashiers, stock,
// assets, tax-rates, staff, dues CRUD, etc.)
app.use('/api/merchant',                    merchantRoutes);

// Feature-specific merchant endpoints
app.use('/api/merchant/billing',            merchantBillingRoutes);
app.use('/api/merchant/ads',               merchantAdsRoutes);
app.use('/api/merchant/barcodes',           merchantBarcodeRoutes);
app.use('/api/merchant/credits',            merchantCreditRoutes);
app.use('/api/merchant/partnership',        merchantPartnershipRoutes);
app.use('/api/merchant/subscription',       merchantSubscriptionRoutes);
app.use('/api/merchant/notifications',      merchantNotifRoutes);
app.use('/api/merchant/dues',               duesRoutes);

// ═══════════════════════════════════════════════════════════
// UPLOAD ROUTE
// ═══════════════════════════════════════════════════════════
const uploadRoutes = require('./routes/upload');
app.use('/api/upload', uploadRoutes);

// Anonymous screen-view tracking. Public: a visit happens before anyone signs
// in, and a conversion rate measured only over people who already signed in
// is measured over the one population it must not be.
app.use('/api/analytics', require('./routes/analytics'));

// Chat history. The socket below carries what happens live; this is what was
// said before you opened the screen.
app.use('/api/chat', require('./routes/chat'));
app.use('/uploads', express.static(require('path').join(__dirname, 'uploads')));

// ─── Config: conversion rates ─────────────────────────────
app.get('/api/config/rates', (req, res) => {
  const { TND_PER_POINT, POINTS_PER_TND } = require('./config/economics');
  res.json({
    success: true,
    data: {
      vipsToTnd: TND_PER_POINT,
      conversionRate: TND_PER_POINT,
      pointsPerTnd: POINTS_PER_TND,
    },
  });
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

// ═══════════════════════════════════════════════════════════
// ADMIN CONSOLE ROUTES
// ═══════════════════════════════════════════════════════════
// Mounted after the inline /api/admin/employees/:id route above so that
// pre-existing, more specific handler keeps matching first; everything else
// under /api/admin falls through to this router.
const adminRoutes = require('./routes/admin');
app.use('/api/admin', adminRoutes);

// ─── Health Check ─────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const dbStates = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  const dbReadyState = mongoose.connection.readyState;
  res.json({
    status:    'ok',
    message:   'VIPs Backend is running',
    timestamp: new Date().toISOString(),
    // Which build is actually serving. Without this there is no way to tell a
    // deployed change from an unchanged one short of holding an admin
    // credential: every path under /api/admin answers 401 before routing, so
    // probing for a new endpoint proves nothing. Render sets RENDER_GIT_COMMIT
    // itself; locally this falls back to the package version.
    build: {
      commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'local',
      branch: process.env.RENDER_GIT_BRANCH || null,
      version: require('./package.json').version,
      startedAt: STARTED_AT,
      env: process.env.NODE_ENV || 'development',
    },
    db: {
      readyState: dbReadyState,
      status:     dbStates[dbReadyState] || 'unknown',
    },
    // Boolean + error message only — never the raw FIREBASE_SERVICE_ACCOUNT
    // value — so social-login misconfiguration can be diagnosed without
    // dashboard/log access.
    firebaseAdmin: require('./utils/firebaseAdmin').getInitStatus(),
    mailer:        require('./utils/mailer').getInitStatus(),
    paymee:        require('./utils/paymee').getInitStatus(),
    paypal:        require('./utils/paypal').getInitStatus(),
  });
});

// ─── Global Error Handler ─────────────────────────────────
app.use((err, req, res, next) => {
  const status = err.status || 500;
  // Always log the real thing.
  console.error(`❌ Error: ${req.method} ${req.originalUrl} →`, err.message);

  // A 4xx message describes what the caller did wrong and is safe to return.
  // A 5xx message is whatever threw — a Mongoose validation dump, a driver
  // error carrying the connection string, an internal path — and none of that
  // belongs in a response to the public. Generic in production only, so local
  // debugging still shows the cause.
  const safe =
    status < 500 || process.env.NODE_ENV !== 'production'
      ? err.message || 'Internal Server Error'
      : 'Internal Server Error';

  res.status(status).json({ success: false, message: safe });
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
    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
    });
    // Attached to the same server, so it shares the port and Render needs no
    // extra service. Identity comes from the JWT on the handshake.
    // Same origin policy as the REST API above, so the socket is not a
    // looser door into the same data than the endpoints beside it.
    const io = setupChatServer(server);
    // Reachable from any route via req.app.get('io') — an order status change
    // pushes to the customer over the same connection the chat already uses.
    app.set('io', io);
    console.log('💬 Chat socket ready on /socket.io');
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    console.log('⚠️  Starting server WITHOUT database...');
    // No socket without a database: every message is persisted, so a chat
    // running against no DB would accept messages and silently lose them.
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT} (No DB — chat disabled)`);
    });
  });
