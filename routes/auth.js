const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const { authMiddleware } = require('../middleware/auth');
const { verifyFirebaseIdToken } = require('../utils/firebaseAdmin');
const { sendOtpEmail } = require('../utils/mailer');

const router = express.Router();

// Generates a 6-digit OTP, saves its hash on the user doc (15 min expiry,
// same mechanism forgot-password already used), and returns the raw code
// so the caller can email/log it. Shared by register + forgot-password so
// both go through the same verified path.
async function issueOtp(user) {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  user.resetPasswordToken = crypto.createHash('sha256').update(otp).digest('hex');
  user.resetPasswordExpires = new Date(Date.now() + 15 * 60 * 1000);
  await user.save({ validateBeforeSave: false });
  return otp;
}

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

    // Send a verification code, but never let email delivery block account
    // creation — the app already lets the user skip verification and
    // retry/resend from the Verification screen.
    try {
      const otp = await issueOtp(user);
      console.log(`🔑 Verification OTP for ${user.email}: ${otp}`);
      await sendOtpEmail(user.email, otp, 'verify your VIPs account');
    } catch (otpError) {
      console.error(`Could not issue verification OTP for ${user.email}: ${otpError.message}`);
    }

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

    // Two-factor: password alone isn't enough — send an OTP and stop
    // short of issuing a token. The client finishes via /auth/2fa/verify.
    if (user.twoFactorEnabled) {
      if (!user.email) {
        return res.status(400).json({
          success: false,
          message: 'Two-factor is enabled but this account has no email to send a code to.',
        });
      }
      const otp = await issueOtp(user);
      console.log(`🔑 2FA OTP for ${user.email}: ${otp}`);
      const { sent, error: mailError } = await sendOtpEmail(user.email, otp, 'sign in to your VIPs account');
      if (!sent) console.error(`2FA OTP email to ${user.email} was not sent: ${mailError}`);

      return res.json({
        success: true,
        message: 'Verification code sent to your email.',
        data: { requires2FA: true, email: user.email },
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

// ─── POST /api/auth/2fa/verify ────────────────────────────
// Second step of login when the account has two-factor enabled — the
// OTP sent by /auth/login above proves identity, so this is the one
// place that issues a token without a password on this request.
router.post('/2fa/verify', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and code are required.' });
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

    // One-time use — unlike /auth/verify-otp (which leaves the token
    // alone for the forgot-password flow's follow-up request), this OTP
    // directly issues a token, so it must not be replayable.
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      success: true,
      message: 'Login successful!',
      data: { user: user.toJSON(), token },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/auth/2fa ─────────────────────────────────────
// Enable/disable two-factor — requires the current password both ways,
// so a stolen unlocked session can't silently turn protection off.
router.put('/2fa', authMiddleware, async (req, res) => {
  try {
    const { enabled, currentPassword } = req.body;
    if (typeof enabled !== 'boolean' || !currentPassword) {
      return res.status(400).json({ success: false, message: '`enabled` and currentPassword are required.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }

    user.twoFactorEnabled = enabled;
    await user.save({ validateBeforeSave: false });

    res.json({
      success: true,
      message: enabled ? 'Two-factor authentication enabled.' : 'Two-factor authentication disabled.',
      data: { twoFactorEnabled: user.twoFactorEnabled },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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
// Generates a 6-digit OTP, saves its hash on the user doc, and emails it
// via SendGrid (utils/mailer.js) — no-ops with a console log until
// SENDGRID_API_KEY is set.
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

    const otp = await issueOtp(user);
    // Also logged to server console so this is verifiable even if
    // SENDGRID_API_KEY isn't configured yet — never returned in the response.
    console.log(`🔑 Reset OTP for ${email}: ${otp}`);
    const { sent, error: mailError } = await sendOtpEmail(user.email, otp, 'reset your VIPs password');
    if (!sent) {
      console.error(`Reset OTP email to ${email} was not sent: ${mailError}`);
    }

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
    // Successfully proving ownership of the OTP also proves email
    // ownership — mark verified regardless of which flow (signup or
    // forgot-password) sent it. Don't clear resetPasswordToken here:
    // the forgot-password → reset-password flow still needs it to be
    // valid for the next request.
    if (!user.isVerified) {
      user.isVerified = true;
      await user.save({ validateBeforeSave: false });
    }
    res.json({ success: true, message: 'OTP verified.', data: { user: user.toJSON() } });
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

// ─── POST /api/auth/pin ────────────────────────────────────
// Sets/overwrites the in-app security PIN. Called right after signup
// (Create PIN screen) and, since it just overwrites, also doubles as the
// "I know my current PIN and want a different one" path from Settings.
router.post('/pin', authMiddleware, async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || !/^\d{4,6}$/.test(pin)) {
      return res.status(400).json({ success: false, message: 'PIN must be 4-6 digits.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    user.pin = pin;
    await user.save();

    res.json({ success: true, message: 'PIN set successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/auth/pin/verify ─────────────────────────────
// Used wherever the app gates a screen behind the PIN (e.g. Wallet).
router.post('/pin/verify', authMiddleware, async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ success: false, message: 'PIN is required.' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (!user.pin) {
      return res.status(400).json({ success: false, message: 'No PIN has been set for this account.' });
    }

    const isMatch = await user.comparePin(pin);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Incorrect PIN.' });
    }

    res.json({ success: true, message: 'PIN verified.' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/auth/pin/reset ───────────────────────────────
// "Forgot my PIN" — the account password (a stronger secret) is proof of
// identity here, so this doesn't require the old PIN.
router.put('/pin/reset', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPin } = req.body;
    if (!currentPassword || !newPin) {
      return res.status(400).json({ success: false, message: 'Current password and new PIN are required.' });
    }
    if (!/^\d{4,6}$/.test(newPin)) {
      return res.status(400).json({ success: false, message: 'PIN must be 4-6 digits.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }

    user.pin = newPin;
    await user.save();

    res.json({ success: true, message: 'PIN reset successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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
        fullName   : decoded.name || 'VIPs User',
        email      : socialEmail,
        phone      : socialPhone,
        password   : crypto.randomBytes(32).toString('hex'),
        role       : 'customer',
        // Firebase already verified this email address to issue the
        // token — no need to make them prove it again via OTP.
        isVerified : decoded.email_verified === true,
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
