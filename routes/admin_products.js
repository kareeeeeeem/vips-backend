const express = require('express');
const mongoose = require('mongoose');

const User    = require('../models/User');
const Product = require('../models/Product');
const Order   = require('../models/Order');

const { requirePermission } = require('../middleware/permissions');
const { paginate, escapeRegex, isValidId, round } = require('../utils/adminHelpers');

const router = express.Router();

// The catalogue across every merchant. The console could already see stock
// levels and what sold, but not the products themselves — so a wrong price
// or a stale listing had to be fixed from the merchant's own app.

/** GET /api/admin/products — ?search= &merchantId= &category= &status= */
router.get('/', requirePermission('products.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req.query);
    const filter = {};

    if (req.query.merchantId && isValidId(req.query.merchantId)) {
      filter.merchantId = req.query.merchantId;
    }
    if (req.query.category) filter.category = req.query.category;
    if (req.query.status === 'active') filter.isActive = true;
    if (req.query.status === 'inactive') filter.isActive = false;
    // Products with no cost recorded are what hold the profit report back,
    // so they are directly filterable.
    if (req.query.status === 'no_cost') filter.costPrice = { $lte: 0 };
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(req.query.search.trim()), 'i');
      filter.$or = [{ name: rx }, { code: rx }, { category: rx }];
    }

    const [items, total, categories] = await Promise.all([
      Product.find(filter)
        .sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate('merchantId', 'storeName fullName')
        .lean(),
      Product.countDocuments(filter),
      Product.distinct('category', filter),
    ]);

    res.json({
      success: true,
      message: 'Products',
      data: {
        items: items.map((p) => ({
          ...p,
          merchantName: p.merchantId
            ? (p.merchantId.storeName || p.merchantId.fullName)
            : '',
          // The price actually charged, matching what the till freezes onto
          // a line — so this list and a receipt agree.
          sellingPrice:
            p.discountPrice != null && p.discountPrice > 0 ? p.discountPrice : p.price,
          hasCost: (p.costPrice || 0) > 0,
        })),
        total, page, limit,
        pages: Math.ceil(total / limit),
        categories: categories.filter(Boolean).sort(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/admin/products/:id */
router.get('/:id', requirePermission('products.read'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid product id.' });
    }
    const product = await Product.findById(req.params.id)
      .populate('merchantId', 'storeName fullName phone')
      .lean();
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    // How it has actually sold, which is the context for changing its price.
    const sales = await Order.aggregate([
      { $match: { status: { $in: ['delivered', 'picked_up'] } } },
      { $unwind: '$items' },
      { $match: { $expr: { $eq: [{ $toString: '$items.productId' }, String(product._id)] } } },
      {
        $group: {
          _id: null,
          units: { $sum: '$items.quantity' },
          revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
        },
      },
    ]);

    res.json({
      success: true,
      message: 'Product',
      data: {
        product: {
          ...product,
          merchantName: product.merchantId
            ? (product.merchantId.storeName || product.merchantId.fullName)
            : '',
        },
        sales: {
          units: sales[0]?.units || 0,
          revenue: round(sales[0]?.revenue || 0),
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** POST /api/admin/products  { merchantId, name, price, category, ... } */
router.post('/', requirePermission('products.create'), async (req, res) => {
  try {
    const { merchantId, name, price, category } = req.body;
    if (!isValidId(merchantId)) {
      return res.status(400).json({ success: false, message: 'A valid merchant id is required.' });
    }
    if (!String(name || '').trim()) {
      return res.status(400).json({ success: false, message: 'A product name is required.' });
    }
    const priceValue = Number(price);
    if (!Number.isFinite(priceValue) || priceValue < 0) {
      return res.status(400).json({ success: false, message: 'Price must be 0 or more.' });
    }
    if (!String(category || '').trim()) {
      return res.status(400).json({ success: false, message: 'A category is required.' });
    }

    const merchant = await User.findOne({ _id: merchantId, role: 'merchant' });
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found.' });
    }

    const product = await Product.create({
      merchantId,
      name: String(name).trim(),
      category: String(category).trim(),
      price: priceValue,
      code: String(req.body.code || '').trim(),
      description: String(req.body.description || '').trim(),
      costPrice: Math.max(Number(req.body.costPrice) || 0, 0),
      stock: Math.max(Math.trunc(Number(req.body.stock) || 0), 0),
      alertQty: Math.max(Math.trunc(Number(req.body.alertQty) || 0), 0),
      vat: Math.max(Number(req.body.vat) || 0, 0),
    });

    res.status(201).json({
      success: true,
      message: `${product.name} added to ${merchant.storeName || merchant.fullName}.`,
      data: { product: product.toJSON() },
    });
  } catch (error) {
    const status = error.name === 'ValidationError' ? 400 : 500;
    res.status(status).json({ success: false, message: error.message });
  }
});

/** PUT /api/admin/products/:id */
router.put('/:id', requirePermission('products.update'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid product id.' });
    }
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    // merchantId is deliberately absent: moving a product to another store
    // would reassign its sales history along with it.
    const numeric = ['price', 'costPrice', 'stock', 'alertQty', 'vat'];
    for (const key of numeric) {
      if (req.body[key] === undefined) continue;
      const value = Number(req.body[key]);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({
          success: false,
          message: `${key} must be a number of 0 or more.`,
        });
      }
      product[key] = value;
    }

    if (req.body.discountPrice !== undefined) {
      const discount = req.body.discountPrice === null ? null : Number(req.body.discountPrice);
      if (discount !== null && (!Number.isFinite(discount) || discount < 0)) {
        return res.status(400).json({ success: false, message: 'Discount price must be 0 or more.' });
      }
      // A discount above the list price is not a discount, and the till would
      // charge it as the selling price.
      if (discount !== null && discount > product.price) {
        return res.status(400).json({
          success: false,
          message: 'The discount price cannot exceed the list price.',
        });
      }
      product.discountPrice = discount;
    }

    for (const key of ['name', 'code', 'description', 'category']) {
      if (typeof req.body[key] === 'string') product[key] = req.body[key].trim();
    }
    for (const key of ['isActive', 'inStock', 'isFeature']) {
      if (typeof req.body[key] === 'boolean') product[key] = req.body[key];
    }

    await product.save();
    res.json({ success: true, message: 'Product updated.', data: { product: product.toJSON() } });
  } catch (error) {
    const status = error.name === 'ValidationError' ? 400 : 500;
    res.status(status).json({ success: false, message: error.message });
  }
});

/** DELETE /api/admin/products/:id */
router.delete('/:id', requirePermission('products.delete'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid product id.' });
    }
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    // Past orders reference this product by id for their line names and the
    // profit report's cost lookup. Deactivating keeps that intact; deleting
    // a product that has sold would blank it out of the history.
    const sold = await Order.countDocuments({
      'items.productId': product._id,
    });
    if (sold > 0) {
      return res.status(409).json({
        success: false,
        message: `${product.name} appears on ${sold} order(s). Deactivate it instead so the history stays readable.`,
      });
    }

    await product.deleteOne();
    res.json({ success: true, message: 'Product deleted.', data: { deletedId: req.params.id } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
