const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const { authMiddleware } = require('../middleware/auth');
const { verifyFirebaseIdToken } = require('../utils/firebaseAdmin');

const router = express.Router();

// ─── POST /api/auth/register ──────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { fullName, email, phone, password, role, storeName, storeCategory, storeAddress } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email }, { phone }],
    });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this email or phone already exists.',
      });
    }

    const userFields = { fullName, email, phone, password, role: role || 'customer' };
    if (role === 'merchant') {
      if (storeName)     userFields.storeName     = storeName;
      if (storeCategory) userFields.storeCategory = storeCategory;
      if (storeAddress)  userFields.storeAddress  = storeAddress;
    }

    // Create user
    const user = await User.create(userFields);

    // Generate token
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({
      success: true,
      message: 'Account created successfully!',
      data: {
        user: user.toJSON(),
        token,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, phone, password } = req.body;

    // Support login by email OR phone
    const identifier = email || phone;
    if (!identifier) {
      return res.status(400).json({ success: false, message: 'Email or phone is required.' });
    }

    const user = await User.findOne({
      $or: [{ email: identifier }, { phone: identifier }],
    });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials.',
      });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    // Generate token
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Record last login
    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    res.json({
      success: true,
      message: 'Login successful!',
      data: {
        user: user.toJSON(),
        token,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ─── GET /api/auth/me ─────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    res.json({
      success: true,
      data: { user: user.toJSON() },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ─── PUT /api/auth/update-profile ─────────────────────────
router.put('/update-profile', authMiddleware, async (req, res) => {
  try {
    const {
      fullName, phone, profileImage,
      city, civilStatus, postalCode, profession, gender, numberOfChildren,
    } = req.body;

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { fullName, phone, profileImage, city, civilStatus, postalCode, profession, gender, numberOfChildren },
      { new: true, runValidators: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    res.json({
      success: true,
      message: 'Profile updated successfully!',
      data: { user: user.toJSON() },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ─── PUT /api/auth/change-password ────────────────────────
// Authenticated in-session password change — requires the current
// password, unlike /reset-password which is the logged-out OTP flow.
router.put('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required.',
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters.',
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }

    user.password = newPassword;
    await user.save();

    res.json({ success: true, message: 'Password changed successfully!' });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ─── POST /api/auth/forgot-password ───────────────────────
// Generates a 6-digit OTP and saves hashed version on the user doc.
// In production: send this OTP via email/SMS service.
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required.',
      });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });

    // Always return success to prevent email enumeration attacks
    if (!user) {
      return res.json({
        success: true,
        message: 'If this email exists, a reset code has been sent.',
      });
    }

    // Generate a 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Save hashed OTP on user doc
    user.resetPasswordToken = crypto.createHash('sha256').update(otp).digest('hex');
    user.resetPasswordExpires = otpExpiry;
    await user.save({ validateBeforeSave: false });

    // In production: send otp via email/SMS
    // OTP is logged to server console only — never returned in the HTTP response
    console.log(`🔑 OTP for ${email}: ${otp}`);

    res.json({
      success: true,
      message: 'Reset code sent successfully.',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ─── POST /api/auth/verify-otp ────────────────────────────
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required.' });
    }
    const hashedOtp = crypto.createHash('sha256').update(otp).digest('hex');
    const user = await User.findOne({
      email: email.toLowerCase().trim(),
      resetPasswordToken: hashedOtp,
      resetPasswordExpires: { $gt: new Date() },
    });
    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid or expired code.' });
    }
    res.json({ success: true, message: 'OTP verified.' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/auth/reset-password ────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Email, OTP, and new password are required.',
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters.',
      });
    }

    // Hash the incoming OTP and find matching user
    const hashedOtp = crypto.createHash('sha256').update(otp).digest('hex');

    const user = await User.findOne({
      email: email.toLowerCase().trim(),
      resetPasswordToken: hashedOtp,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset code.',
      });
    }

    // Update password and clear reset fields
    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    // Generate a fresh login token
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      success: true,
      message: 'Password reset successfully!',
      data: {
        user: user.toJSON(),
        token,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

router.post('/merchant-login', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone || typeof phone !== 'string' || phone.trim().length < 6 || phone.trim().length > 20) {
      return res.status(400).json({ success: false, message: 'Valid phone number is required' });
    }

    const user = await User.findOne({ phone: phone.trim() });
    if (!user || user.role !== 'merchant') {
      return res.status(401).json({ success: false, message: 'No merchant account found with this phone number.' });
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    user.resetPasswordToken = crypto.createHash('sha256').update(otp).digest('hex');
    user.resetPasswordExpires = otpExpiry;
    await user.save({ validateBeforeSave: false });

    // OTP is logged to server console only — never returned in the HTTP response
    console.log(`🔑 Merchant OTP for ${phone}: ${otp}`);

    res.json({
      success: true,
      message: 'OTP sent successfully.',
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/merchant-verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ success: false, message: 'Phone and OTP are required.' });
    }

    const hashedOtp = crypto.createHash('sha256').update(otp).digest('hex');
    const user = await User.findOne({
      phone: phone.trim(),
      role: 'merchant',
      resetPasswordToken: hashedOtp,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
    }

    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save({ validateBeforeSave: false });

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      success: true,
      message: 'Verification successful!',
      data: { user: user.toJSON(), token },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/auth/social ────────────────────────────────
// Find-or-create a user from a social provider (Google / Facebook / Apple / Phone).
// Client sends: { idToken, provider }
// `idToken` is a Firebase ID token for the signed-in user; it is verified
// server-side with the Firebase Admin SDK and all identity fields (uid,
// email, phone) are taken from the verified claims — never from the
// request body — so a caller cannot forge someone else's identity.
router.post('/social', async (req, res) => {
  try {
    const { idToken, provider } = req.body;

    if (!idToken) {
      return res.status(400).json({ success: false, message: 'idToken is required' });
    }

    let decoded;
    try {
      decoded = await verifyFirebaseIdToken(idToken);
    } catch (err) {
      console.error('[auth/social] verifyFirebaseIdToken failed:', err.code || err.name, '-', err.message);
      return res.status(401).json({ success: false, message: 'Invalid or expired sign-in token.' });
    }

    const providerUid = decoded.uid;
    const socialEmail = (decoded.email || '').toLowerCase().trim() || `${providerUid}@social.vips.app`;
    const socialPhone =
      provider === 'phone' && decoded.phone_number
        ? decoded.phone_number.trim()
        : `social_${providerUid}`;

    let user = await User.findOne({ $or: [{ email: socialEmail }, { phone: socialPhone }] });

    if (!user) {
      user = await User.create({
        fullName : decoded.name || 'VIPs User',
        email    : socialEmail,
        phone    : socialPhone,
        password : crypto.randomBytes(32).toString('hex'),
        role     : 'customer',
      });
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    res.json({ success: true, message: 'Social login successful!', data: { user: user.toJSON(), token } });
  } catch (error) {
    console.error('[auth/social] unexpected error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/auth/merchant-social ───────────────────────
// Sign in an EXISTING merchant via Google / Facebook / Apple, matched by
// email. Unlike /social this never creates a new account — merchants must
// already exist via business registration, matching the same "must already
// exist" rule /merchant-login enforces for phone+OTP sign-in.
// Client sends: { idToken }. The Firebase ID token is verified server-side
// and the email used to look up the merchant comes from the verified
// claims, never from the request body.
router.post('/merchant-social', async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ success: false, message: 'idToken is required' });
    }

    let decoded;
    try {
      decoded = await verifyFirebaseIdToken(idToken);
    } catch (err) {
      console.error('[auth/merchant-social] verifyFirebaseIdToken failed:', err.code || err.name, '-', err.message);
      return res.status(401).json({ success: false, message: 'Invalid or expired sign-in token.' });
    }

    const email = (decoded.email || '').toLowerCase().trim();
    if (!email) {
      return res.status(400).json({ success: false, message: 'This sign-in method has no verified email.' });
    }

    const user = await User.findOne({ email });
    if (!user || user.role !== 'merchant') {
      return res.status(401).json({ success: false, message: 'No merchant account found with this email.' });
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    res.json({ success: true, message: 'Social login successful!', data: { user: user.toJSON(), token } });
  } catch (error) {
    console.error('[auth/merchant-social] unexpected error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/verify-token', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    res.json({ success: true, data: { user: user.toJSON() } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
