/**
 * Merchant Barcode Routes  —  /api/merchant/barcodes
 * Save, list and delete product barcodes / QR codes.
 */

const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const MerchantBarcode = require('../models/MerchantBarcode');

const router = express.Router();
router.use(authMiddleware);

// ─── GET /api/merchant/barcodes ───────────────────────────
router.get('/', async (req, res) => {
  try {
    const { codeType, isActive } = req.query;
    const filter = { merchantId: req.user.id };
    if (codeType)             filter.codeType = codeType;
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    const barcodes = await MerchantBarcode.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, data: barcodes });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/merchant/barcodes ──────────────────────────
router.post('/', async (req, res) => {
  try {
    const { productId, productName, code, codeType, price, description, qrData } = req.body;
    if (!productName || !code) {
      return res.status(400).json({ success: false, message: 'productName and code are required' });
    }

    const barcode = await MerchantBarcode.create({
      merchantId:  req.user.id,
      productId:   productId   || null,
      productName,
      code,
      qrData:      qrData      || `${productName}|${code}`,
      codeType:    codeType    || 'qrcode',
      price:       parseFloat(price || 0),
      description: description || '',
    });

    res.status(201).json({ success: true, message: 'Barcode saved', data: barcode });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /api/merchant/barcodes/:id ───────────────────────
router.put('/:id', async (req, res) => {
  try {
    const barcode = await MerchantBarcode.findOneAndUpdate(
      { _id: req.params.id, merchantId: req.user.id },
      req.body,
      { new: true }
    );
    if (!barcode) return res.status(404).json({ success: false, message: 'Barcode not found' });
    res.json({ success: true, data: barcode });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── DELETE /api/merchant/barcodes/:id ────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await MerchantBarcode.findOneAndDelete({ _id: req.params.id, merchantId: req.user.id });
    res.json({ success: true, message: 'Barcode deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
