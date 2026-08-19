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
    // Merchant-specific fields
    storeName: { type: String, default: null },
    storeAddress: { type: String, default: null },
    storeCategory: { type: String, default: null },
    logo: { type: String, default: null },
    brandColor: { type: String, default: null }, // e.g., '0xFFDC2626'
    isTrending: { type: Boolean, default: false },
    discountPercentage: { type: Number, default: 0 },
    
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

module.exports = mongoose.model('User', userSchema);
