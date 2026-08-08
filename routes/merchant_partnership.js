/**
 * Merchant Partnership / Business Registration  —  /api/merchant/partnership
 * Register and manage a merchant's business partnership application.
 */

const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const BusinessRegistration = require('../models/BusinessRegistration');
const User = require('../models/User');

const router = express.Router();
router.use(authMiddleware);

// ─── GET /api/merchant/partnership/status ─────────────────
router.get('/status', async (req, res) => {
  try {
    const registration = await BusinessRegistration.findOne({ merchantId: req.user.id })
      .sort({ createdAt: -1 });
    res.json({ success: true, data: registration || null });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/partnership/register ──────────────
router.post('/register', async (req, res) => {
  try {
    const {
      // accept both 'businessName' and 'storeName' field names
      businessName: _bn, storeName: _sn,
      businessType: _bt, category: _cat,
      ownerName, email, phone,
      address, city, country, postalCode,
      taxId, registrationNumber,
      logoUrl, bannerUrl, description, website, socialMedia,
      schedule, loyaltyType, documents: docList,
    } = req.body;

    const businessName = _bn || _sn || '';
    const businessType = _bt || _cat || 'retail';

    if (!businessName || !ownerName || !phone) {
      return res.status(400).json({
        success: false,
        message: 'storeName, ownerName, and phone are required',
      });
    }

    // Block duplicate active submissions
    const existing = await BusinessRegistration.findOne({
      merchantId: req.user.id,
      status: { $in: ['pending', 'under_review', 'approved'] },
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: `A registration already exists with status: ${existing.status}`,
        data: existing,
      });
    }

    const registration = await BusinessRegistration.create({
      merchantId:         req.user.id,
      businessName,
      businessType,
      ownerName,
      email:              email              || '',
      phone,
      address,
      city:               city               || '',
      country:            country            || '',
      postalCode:         postalCode         || '',
      taxId:              taxId              || '',
      registrationNumber: registrationNumber || '',
      logoUrl:            logoUrl            || '',
      bannerUrl:          bannerUrl          || '',
      description:        description        || '',
      website:            website            || '',
      socialMedia:        socialMedia        || {},
      status:             'pending',
    });

    // Mirror business info onto the User document
    await User.findByIdAndUpdate(req.user.id, {
      storeName:     businessName,
      storeCategory: businessType,
    });

    res.status(201).json({ success: true, message: 'Partnership application submitted', data: registration });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/merchant/partnership/update ─────────────────
// Allowed only when status is pending or rejected
router.put('/update', async (req, res) => {
  try {
    const registration = await BusinessRegistration.findOne({
      merchantId: req.user.id,
      status: { $in: ['pending', 'rejected'] },
    }).sort({ createdAt: -1 });

    if (!registration) {
      return res.status(404).json({ success: false, message: 'No editable registration found' });
    }

    const allowed = [
      'businessName', 'businessType', 'ownerName', 'email', 'phone',
      'address', 'city', 'country', 'postalCode',
      'taxId', 'registrationNumber',
      'logoUrl', 'bannerUrl', 'description', 'website', 'socialMedia',
    ];
    allowed.forEach(f => { if (req.body[f] !== undefined) registration[f] = req.body[f]; });
    registration.status          = 'pending';
    registration.rejectionReason = '';
    await registration.save();

    res.json({ success: true, message: 'Application updated and resubmitted', data: registration });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/partnership/upload-doc ────────────
router.post('/upload-doc', async (req, res) => {
  try {
    const { docType, url } = req.body;
    if (!docType || !url) {
      return res.status(400).json({ success: false, message: 'docType and url are required' });
    }

    const registration = await BusinessRegistration.findOne({ merchantId: req.user.id })
      .sort({ createdAt: -1 });
    if (!registration) {
      return res.status(404).json({ success: false, message: 'No registration found. Please register first.' });
    }

    registration.documents.push({ type: docType, url });
    await registration.save();

    res.json({ success: true, message: 'Document added', data: registration });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── DELETE /api/merchant/partnership ─────────────────────
// Withdraw a pending application
router.delete('/', async (req, res) => {
  try {
    const registration = await BusinessRegistration.findOneAndDelete({
      merchantId: req.user.id,
      status: 'pending',
    });
    if (!registration) {
      return res.status(404).json({ success: false, message: 'No pending application to withdraw' });
    }
    res.json({ success: true, message: 'Application withdrawn' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
