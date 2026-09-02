const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      unique: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
    },
    role: {
      type: String,
      enum: ['customer', 'merchant', 'agent', 'admin'],
      default: 'customer',
    },

    // ── Admin console access (only meaningful when role === 'admin') ──
    // Kept on User rather than a separate Admin collection: 42 refs across
    // 29 models point at 'User', and five of them attribute an action to the
    // admin who took it (PosSession.cashierId, PosInvoice.cashierId and
    // refundedBy, StockMovement.performedBy). Moving admins to their own
    // collection would break every one of those populates, so the stock
    // ledger would read "System" and receipts would lose the cashier's name.
    adminRole: {
      type: String,
      enum: ['super_admin', 'admin', 'manager', 'cashier', 'viewer'],
      default: 'admin',
    },
    // Grants beyond the role's defaults. '*' means everything, which is what
    // the bootstrap super admin gets.
    permissions: { type: [String], default: [] },
    // Merchant-specific fields
    storeName: { type: String, default: null },
    storeAddress: { type: String, default: null },
    storeCategory: { type: String, default: null },
    storeDescription: { type: String, default: null },
    logo: { type: String, default: null },
    coverImage: { type: String, default: null },
    brandColor: { type: String, default: null }, // e.g., '0xFFDC2626'
    isTrending: { type: Boolean, default: false },
    discountPercentage: { type: Number, default: 0 },
    /**
     * When the storefront discount last changed. A shop-wide discount is a
     * promise on the storefront, so it stands for a day before it can be
     * rewritten — see EDIT_COOLDOWN.STORE_DISCOUNT_HOURS.
     */
    discountChangedAt:  { type: Date, default: null },
    // Platform cut on this merchant's sales, as a percentage. Derived from
    // `merchantPlan` (§8) rather than typed in — kept as a stored field so
    // historical reports still read the rate that applied at the time.
    commissionRate: { type: Number, default: 0, min: 0, max: 100 },

    // ─── §8 Subscription plan ──────────────────────────────
    // The monthly fee buys a lower commission. Every merchant is on a plan;
    // `basic` is free and is what an unconfigured merchant gets.
    merchantPlan: {
      type: String,
      enum: ['basic', 'professional', 'advanced'],
      default: 'basic',
    },

    // ─── §4.1 Points this merchant awards per 1 TND spent ──
    // The document's worked example is 6. Null means the merchant has not
    // set a policy yet and awards nothing — deliberately not a silent
    // platform-wide fallback, which is how two different rates ended up
    // running at once.
    earnRate: { type: Number, default: null, min: 0, max: 100 },

    // ─── §5.1 The collective guarantee ─────────────────────
    // Cash the merchant deposits, held as an operating guarantee and
    // converted to points at 100 points = 1 TND. The merchant splits those
    // points across three budgets; every offer is funded from one of them.
    // The platform never books this as revenue (§5.3) — it is refundable in
    // full, so it is tracked separately from `walletBalance` (their earnings).
    guarantee: {
      // Lifetime cash deposited, in dinars. Never decreases on spending —
      // only the budgets do — so the refundable amount can be derived.
      depositedTnd: { type: Number, default: 0, min: 0 },
      // Cash already refunded out, in dinars.
      refundedTnd: { type: Number, default: 0, min: 0 },
      // Unallocated points, waiting to be split across the budgets below.
      unallocatedPoints: { type: Number, default: 0, min: 0 },
      budgets: {
        discount: { type: Number, default: 0, min: 0 }, // funds Cashback
        packages: { type: Number, default: 0, min: 0 }, // funds Packages
        general:  { type: Number, default: 0, min: 0 }, // receives Voucher redemptions
      },
      // Set when a budget hits zero: the merchant stops accepting points for
      // that offer type until they top the guarantee up (§5.1, "النفاد").
      suspendedAt: { type: Date, default: null },
      lastRefundAt: { type: Date, default: null },
    },
    
    // Wallet
    walletBalance: { type: Number, default: 0 },
    walletPoints: { type: Number, default: 0 },

    // Favorites and Cart (client-side features backed on server)
    favorites: [
      {
        itemId: { type: String },
        itemType: { type: String, default: 'deal' },
        addedAt: { type: Date, default: Date.now },
      },
    ],

    // Merchants this user follows (role: 'customer' docs use this; a
    // merchant's own follower count is `User.countDocuments({ following: merchantId })`).
    following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    cart: [
      {
        itemId: { type: String },
        itemType: { type: String, default: 'product' },
        name: { type: String },
        price: { type: Number, default: 0 },
        quantity: { type: Number, default: 1 },
        merchantId: { type: String },
        addedAt: { type: Date, default: Date.now },
      },
    ],

    // Profile
    profileImage: { type: String, default: null },
    isVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    // Email-based two-factor: when on, POST /auth/login sends an OTP
    // instead of a token, and the client must call /auth/2fa/verify.
    twoFactorEnabled: { type: Boolean, default: false },

    // Payment methods — display data only (last4/expiry), never raw card
    // numbers or CVV. No route currently writes to this (card entry is
    // deliberately not implemented client-side for PCI reasons), so this
    // just makes the existing GET /user/payment-methods read a real,
    // declared field instead of an undefined one.
    paymentMethods: [
      {
        id: { type: String, required: true },
        type: { type: String, enum: ['card', 'paypal', 'wallet'], required: true },
        last4: { type: String },
        expiryDate: { type: String },
        isDefault: { type: Boolean, default: false },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    // Saved bank destinations a merchant can withdraw walletBalance to.
    // Bank-transfer details only — no card data, so nothing here is in PCI
    // scope (unlike `paymentMethods` above, which deliberately has no write
    // endpoint for that reason). Used by the merchant wallet's payout flow,
    // which previously made the merchant retype these on every request.
    payoutAccounts: [
      {
        bankName:      { type: String, default: '' },
        accountName:   { type: String, required: true },
        accountNumber: { type: String, required: true },
        isDefault:     { type: Boolean, default: false },
        createdAt:     { type: Date, default: Date.now },
      },
    ],

    // Extended profile (collected by the Edit Profile screen)
    city:             { type: String, default: null },
    civilStatus:      { type: String, default: null },
    postalCode:       { type: String, default: null },
    profession:       { type: String, default: null },
    gender:           { type: String, default: null },
    numberOfChildren: { type: Number, default: null },

    // Password Reset (OTP)
    resetPasswordToken: { type: String, default: null },
    resetPasswordExpires: { type: Date, default: null },

    // In-app security PIN (hashed, like password) — gates sensitive
    // screens (e.g. Wallet). Separate from the account password: lower
    // stakes, so it's set once after signup and can be reset with the
    // real password as proof of identity. null until the user actually
    // sets one via POST /auth/pin.
    pin: { type: String, default: null },

    // VIPs Club Check-in
    lastCheckIn: { type: Date, default: null },
    checkInStreak: { type: Number, default: 0 },

    // VIPs Club extended
    pendingDiamonds:   { type: Number, default: 0 },
    suspendedDiamonds: { type: Number, default: 0 },
    superBonus:        { type: Number, default: 0 },
    todayCoins:        { type: Number, default: 0 },
    lastCoinResetDate: { type: Date, default: null },

    // Package / subscription display name
    packageName:   { type: String, default: 'Free' },
    packageExpiry: { type: Date, default: null },
    lastLogin:     { type: Date, default: null },

    // Role-specific stats (updated by server on relevant events)
    stats: {
      products:            { type: Number, default: 0 },
      sales:               { type: Number, default: 0 },
      revenue:             { type: Number, default: 0 },
      totalDeliveries:     { type: Number, default: 0 },
      completedDeliveries: { type: Number, default: 0 },
      pendingDeliveries:   { type: Number, default: 0 },
      stores:              { type: Number, default: 0 },
      drivers:             { type: Number, default: 0 },
      customers:           { type: Number, default: 0 },
    },

    // Referral — no default so null/absent docs don't collide on the sparse index
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Push notification device tokens
    fcmTokens: [{ type: String }],
  },
  {
    timestamps: true, // createdAt, updatedAt
  }
);

userSchema.index({ role: 1, isTrending: 1 });
userSchema.index({ walletPoints: -1 });
userSchema.index({ role: 1, walletPoints: -1 });

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Hash PIN before saving (same treatment as password)
userSchema.pre('save', async function (next) {
  if (!this.isModified('pin') || !this.pin) return next();
  this.pin = await bcrypt.hash(this.pin, 12);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Compare PIN method
userSchema.methods.comparePin = async function (candidatePin) {
  if (!this.pin) return false;
  return bcrypt.compare(candidatePin, this.pin);
};

// Remove password/pin hashes from JSON output, expose only whether a PIN
// has been set (the frontend needs this to decide whether to show the
// Create PIN flow, without ever seeing the hash itself).
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  obj.hasPin = Boolean(obj.pin);
  delete obj.password;
  delete obj.pin;
  // Hashed OTP + expiry — internal reset-flow state, never useful (or
  // safe) to expose in an API response.
  delete obj.resetPasswordToken;
  delete obj.resetPasswordExpires;
  return obj;
};

/**
 * §8: the plan sets the commission. `commissionRate` stays a stored field so
 * historical reports keep reading the rate that applied when they were run,
 * but nothing may set it by hand to a value the plan does not carry — that
 * is how a merchant ends up on the free plan paying nothing.
 */
userSchema.pre('save', function syncCommissionToPlan(next) {
  if (this.role !== 'merchant') return next();
  if (this.isModified('merchantPlan') || this.isNew || this.commissionRate === undefined) {
    const { PLANS } = require('../config/economics');
    const plan = PLANS[this.merchantPlan] || PLANS.basic;
    this.commissionRate = plan.commissionPercent;
  }
  next();
});

module.exports = mongoose.model('User', userSchema);
