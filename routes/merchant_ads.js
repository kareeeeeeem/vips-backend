/**
 * Merchant Ads Routes  —  /api/merchant/ads
 * Advertisement campaign management for merchants.
 */

const express  = require('express');
const mongoose = require('mongoose');
const { authMiddleware } = require('../middleware/auth');
const MerchantAd = require('../models/MerchantAd');
const Transaction = require('../models/Transaction');
const User        = require('../models/User');

const router = express.Router();
router.use(authMiddleware);

// ─── GET /api/merchant/ads ────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, adType, page = 1, limit = 20 } = req.query;
    const filter = { merchantId: req.user.id };
    if (status) filter.status = status;
    if (adType) filter.adType = adType;

    const [ads, total] = await Promise.all([
      MerchantAd.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit)),
      MerchantAd.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: {
        ads,
        total,
        pagination: { page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/merchant/ads/stats ──────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const merchantOid = new mongoose.Types.ObjectId(req.user.id);
    const [stats, totalAds] = await Promise.all([
      MerchantAd.aggregate([
        { $match: { merchantId: merchantOid } },
        {
          $group: {
            _id:              '$status',
            count:            { $sum: 1 },
            totalBudget:      { $sum: '$budget' },
            totalSpent:       { $sum: '$spentAmount' },
            totalImpressions: { $sum: '$impressions' },
            totalClicks:      { $sum: '$clicks' },
          },
        },
      ]),
      MerchantAd.countDocuments({ merchantId: req.user.id }),
    ]);

    res.json({ success: true, data: { totalAds, stats } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/ads ───────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      title, description, imageUrl, targetAudience,
      budget, startDate, endDate, adType, targetUrl,
    } = req.body;

    if (!title || !startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'title, startDate, and endDate are required' });
    }

    const start = new Date(startDate);
    const status = start <= new Date() ? 'active' : 'scheduled';

    const ad = await MerchantAd.create({
      merchantId:     req.user.id,
      title,
      description:    description    || '',
      imageUrl:       imageUrl       || '',
      targetAudience: targetAudience || 'all',
      budget:         parseFloat(budget || 0),
      startDate:      start,
      endDate:        new Date(endDate),
      adType:         adType    || 'banner',
      targetUrl:      targetUrl || '',
      status,
    });

    res.status(201).json({ success: true, message: 'Ad campaign created', data: ad });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/merchant/ads/:id ────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const ad = await MerchantAd.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      req.body,
      { new: true }
    );
    if (!ad) return res.status(404).json({ success: false, message: 'Ad not found' });
    res.json({ success: true, message: 'Ad updated', data: ad });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── DELETE /api/merchant/ads/:id ─────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const ad = await MerchantAd.findOneAndDelete({ _id: req.params.id, merchantId: req.user.id });
    if (!ad) return res.status(404).json({ success: false, message: 'Ad not found' });
    res.json({ success: true, message: 'Ad deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/ads/:id/boost ─────────────────────
// Boost an existing ad with extra budget; deducts from merchant wallet
router.post('/:id/boost', async (req, res) => {
  try {
    const { boostBudget } = req.body;
    if (!boostBudget || boostBudget <= 0) {
      return res.status(400).json({ success: false, message: 'boostBudget must be > 0' });
    }

    const [ad, merchant] = await Promise.all([
      MerchantAd.findOne({ _id: req.params.id, merchantId: req.user.id }),
      User.findById(req.user.id),
    ]);

    if (!ad) return res.status(404).json({ success: false, message: 'Ad not found' });
    if (merchant.walletBalance < boostBudget) {
      return res.status(400).json({ success: false, message: 'Insufficient wallet balance' });
    }

    merchant.walletBalance -= parseFloat(boostBudget);
    ad.isBoost     = true;
    ad.boostBudget = parseFloat(boostBudget);
    ad.status      = 'active';

    await Promise.all([
      merchant.save(),
      ad.save(),
      Transaction.create({
        userId:      req.user.id,
        merchantId:  req.user.id,
        type:        'expense',
        amount:      parseFloat(boostBudget),
        currency:    'GMD',
        description: `Ad Boost — ${ad.title}`,
        status:      'completed',
        reference:   `BOOST-${ad._id}`,
      }),
    ]);

    res.json({ success: true, message: 'Ad boosted successfully', data: ad });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/merchant/ads/:id/pause ──────────────────────
router.put('/:id/pause', async (req, res) => {
  try {
    const ad = await MerchantAd.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      { status: 'paused' },
      { new: true }
    );
    if (!ad) return res.status(404).json({ success: false, message: 'Ad not found' });
    res.json({ success: true, message: 'Ad paused', data: ad });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/merchant/ads/:id/resume ─────────────────────
router.put('/:id/resume', async (req, res) => {
  try {
    const ad = await MerchantAd.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      { status: 'active' },
      { new: true }
    );
    if (!ad) return res.status(404).json({ success: false, message: 'Ad not found' });
    res.json({ success: true, message: 'Ad resumed', data: ad });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
