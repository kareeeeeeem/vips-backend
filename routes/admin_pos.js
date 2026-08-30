const express = require('express');
const mongoose = require('mongoose');

const User       = require('../models/User');
const Product    = require('../models/Product');
const PosSession = require('../models/PosSession');
const PosInvoice = require('../models/PosInvoice');

const router = express.Router();

// Mounted under /api/admin/pos, behind the admin gate applied in routes/admin.js.

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const round = (n) => Number((Number(n) || 0).toFixed(3));

/** The caller's open till, or null. */
const openSessionFor = (userId) =>
  PosSession.findOne({ cashierId: userId, status: 'open' });

/**
 * Price the cart from the stored line prices.
 *
 * Those prices were copied off the Product document when the item was added —
 * a client never gets to state a price. This is the same hole that let a
 * D 12.500 product be ordered for D 0.001 through /order/create.
 */
function priceCart(session) {
  const items = session.cart.map((item) => {
    const lineTotal = round(item.unitPrice * item.quantity);
    const lineTax = round(lineTotal * ((item.vat || 0) / 100));
    return { item, lineTotal, lineTax };
  });

  const subtotal = round(items.reduce((sum, i) => sum + i.lineTotal, 0));
  const tax = round(items.reduce((sum, i) => sum + i.lineTax, 0));

  let discount = 0;
  if (session.cartDiscountType === 'percentage') {
    discount = round(subtotal * (Math.min(session.cartDiscount, 100) / 100));
  } else {
    discount = round(Math.min(session.cartDiscount, subtotal));
  }

  // Never below zero: a discount larger than the bill would otherwise make
  // the till owe the customer money.
  const total = round(Math.max(subtotal - discount + tax, 0));

  return { subtotal, tax, discount, total, lines: items };
}

const cartResponse = (session) => {
  const totals = priceCart(session);
  return {
    sessionId: session._id,
    items: session.cart.map((item) => ({
      _id: item._id,
      productId: item.productId,
      name: item.name,
      code: item.code,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      vat: item.vat,
      lineTotal: round(item.unitPrice * item.quantity),
    })),
    itemCount: session.cart.reduce((sum, i) => sum + i.quantity, 0),
    discount: session.cartDiscount,
    discountType: session.cartDiscountType,
    customerId: session.customerId,
    customerName: session.customerName,
    customerPhone: session.customerPhone,
    totals: {
      subtotal: totals.subtotal,
      discount: totals.discount,
      tax: totals.tax,
      total: totals.total,
    },
  };
};

/** Resolve the caller's open session or answer 409 with what to do about it. */
async function requireOpenSession(req, res) {
  const session = await openSessionFor(req.user.id);
  if (!session) {
    res.status(409).json({
      success: false,
      message: 'No till session is open. Start one before ringing up a sale.',
    });
    return null;
  }
  return session;
}

// ═══════════════════════════════════════════════════════════
// SESSIONS
// ═══════════════════════════════════════════════════════════

/** POST /api/admin/pos/session/start  { merchantId, openingFloat } */
router.post('/session/start', async (req, res) => {
  try {
    const { merchantId } = req.body;
    if (!isValidId(merchantId)) {
      return res.status(400).json({ success: false, message: 'A valid merchant id is required.' });
    }

    const merchant = await User.findOne({ _id: merchantId, role: 'merchant' });
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found.' });
    }
    // Selling from a deactivated store would move stock the storefront has
    // already been told is unavailable.
    if (merchant.isActive === false) {
      return res.status(409).json({
        success: false,
        message: 'This merchant is deactivated. Reactivate it before opening a till.',
      });
    }

    const existing = await openSessionFor(req.user.id);
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'You already have an open till session. Close it first.',
        data: { session: existing.toJSON() },
      });
    }

    const openingFloat = Number(req.body.openingFloat);
    const session = await PosSession.create({
      cashierId: req.user.id,
      merchantId,
      openingFloat: Number.isFinite(openingFloat) && openingFloat > 0 ? openingFloat : 0,
    });

    res.status(201).json({
      success: true,
      message: `Till open for ${merchant.storeName || merchant.fullName}.`,
      data: { session: session.toJSON() },
    });
  } catch (error) {
    // The partial unique index is the real guard against two concurrent
    // start requests both getting past the check above.
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'You already have an open till session.',
      });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/admin/pos/session — the caller's open till plus its cart. */
router.get('/session', async (req, res) => {
  try {
    const session = await openSessionFor(req.user.id);
    if (!session) {
      return res.json({ success: true, message: 'No open session', data: { session: null } });
    }
    const merchant = await User.findById(session.merchantId).select('storeName fullName').lean();
    res.json({
      success: true,
      message: 'Open session',
      data: {
        session: session.toJSON(),
        merchantName: merchant ? (merchant.storeName || merchant.fullName) : '',
        cart: cartResponse(session),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** POST /api/admin/pos/session/end  { closingCount } */
router.post('/session/end', async (req, res) => {
  try {
    const session = await requireOpenSession(req, res);
    if (!session) return;

    if (session.cart.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'There is an unfinished sale in the cart. Complete or clear it first.',
      });
    }

    const counted = Number(req.body.closingCount);
    const expectedCash = round(session.openingFloat + session.totalSales - session.totalRefunds);

    session.status = 'closed';
    session.closedAt = new Date();
    if (Number.isFinite(counted)) {
      session.closingCount = round(counted);
      // Signed on purpose: a negative figure is a short till, and rounding it
      // away would hide exactly what this number exists to reveal.
      session.cashDifference = round(counted - expectedCash);
    }
    await session.save();

    res.json({
      success: true,
      message: 'Till closed.',
      data: {
        session: session.toJSON(),
        expectedCash,
        difference: session.cashDifference,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/admin/pos/sessions — session history. */
router.get('/sessions', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const filter = {};
    if (req.query.merchantId && isValidId(req.query.merchantId)) {
      filter.merchantId = req.query.merchantId;
    }
    if (req.query.status) filter.status = req.query.status;

    const sessions = await PosSession.find(filter)
      .sort({ openedAt: -1 }).limit(limit)
      .populate('merchantId', 'storeName fullName')
      .populate('cashierId', 'fullName')
      .lean();

    res.json({
      success: true,
      message: 'Till sessions',
      data: {
        items: sessions.map((s) => ({
          ...s,
          // The cart is working state, not history — it would be noise here.
          cart: undefined,
          merchantName: s.merchantId ? (s.merchantId.storeName || s.merchantId.fullName) : '',
          cashierName: s.cashierId ? s.cashierId.fullName : '',
        })),
        total: sessions.length,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// CART
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/pos/cart */
router.get('/cart', async (req, res) => {
  try {
    const session = await requireOpenSession(req, res);
    if (!session) return;
    res.json({ success: true, message: 'Cart', data: cartResponse(session) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** POST /api/admin/pos/cart/add  { productId, quantity } */
router.post('/cart/add', async (req, res) => {
  try {
    const session = await requireOpenSession(req, res);
    if (!session) return;

    const { productId } = req.body;
    if (!isValidId(productId)) {
      return res.status(400).json({ success: false, message: 'A valid product id is required.' });
    }
    const quantity = Math.trunc(Number(req.body.quantity) || 1);
    if (quantity < 1) {
      return res.status(400).json({ success: false, message: 'Quantity must be at least 1.' });
    }

    // Scoped to the session's merchant: a till must not be able to sell
    // another store's catalogue.
    const product = await Product.findOne({ _id: productId, merchantId: session.merchantId });
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "That product is not in this merchant's catalogue.",
      });
    }
    if (product.isActive === false) {
      return res.status(409).json({ success: false, message: `${product.name} is not active.` });
    }

    const existing = session.cart.find((i) => String(i.productId) === String(product._id));
    const desired = existing ? existing.quantity + quantity : quantity;

    if (product.stock < desired) {
      return res.status(409).json({
        success: false,
        message: `Only ${product.stock} × ${product.name} left in stock.`,
      });
    }

    if (existing) {
      existing.quantity = desired;
    } else {
      session.cart.push({
        productId: product._id,
        name: product.name,
        code: product.code || '',
        // The live selling price, taken here and frozen on the line.
        unitPrice: product.discountPrice != null && product.discountPrice > 0
          ? product.discountPrice
          : product.price,
        quantity,
        vat: product.taxMethod === 'None' ? 0 : (product.vat || 0),
      });
    }

    await session.save();
    res.json({ success: true, message: `${product.name} added.`, data: cartResponse(session) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** PUT /api/admin/pos/cart/update  { itemId, quantity } */
router.put('/cart/update', async (req, res) => {
  try {
    const session = await requireOpenSession(req, res);
    if (!session) return;

    const line = session.cart.id(req.body.itemId);
    if (!line) return res.status(404).json({ success: false, message: 'Cart line not found.' });

    const quantity = Math.trunc(Number(req.body.quantity));
    if (!Number.isFinite(quantity) || quantity < 0) {
      return res.status(400).json({ success: false, message: 'Quantity must be 0 or more.' });
    }
    // Zero is the natural way to remove a line from a till keypad.
    if (quantity === 0) {
      line.deleteOne();
      await session.save();
      return res.json({ success: true, message: 'Line removed.', data: cartResponse(session) });
    }

    const product = await Product.findById(line.productId).select('stock name');
    if (product && product.stock < quantity) {
      return res.status(409).json({
        success: false,
        message: `Only ${product.stock} × ${product.name} left in stock.`,
      });
    }

    line.quantity = quantity;
    await session.save();
    res.json({ success: true, message: 'Cart updated.', data: cartResponse(session) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** DELETE /api/admin/pos/cart/remove/:id */
router.delete('/cart/remove/:id', async (req, res) => {
  try {
    const session = await requireOpenSession(req, res);
    if (!session) return;

    const line = session.cart.id(req.params.id);
    if (!line) return res.status(404).json({ success: false, message: 'Cart line not found.' });

    line.deleteOne();
    await session.save();
    res.json({ success: true, message: 'Line removed.', data: cartResponse(session) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** DELETE /api/admin/pos/cart/clear */
router.delete('/cart/clear', async (req, res) => {
  try {
    const session = await requireOpenSession(req, res);
    if (!session) return;

    session.cart = [];
    session.cartDiscount = 0;
    session.cartDiscountType = 'fixed';
    session.customerId = null;
    session.customerName = '';
    session.customerPhone = '';
    await session.save();

    res.json({ success: true, message: 'Cart cleared.', data: cartResponse(session) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** POST /api/admin/pos/cart/discount  { amount, type } */
router.post('/cart/discount', async (req, res) => {
  try {
    const session = await requireOpenSession(req, res);
    if (!session) return;

    const amount = Number(req.body.amount);
    const type = req.body.type === 'percentage' ? 'percentage' : 'fixed';
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ success: false, message: 'Discount must be 0 or more.' });
    }
    if (type === 'percentage' && amount > 100) {
      return res.status(400).json({ success: false, message: 'A percentage discount cannot exceed 100.' });
    }

    session.cartDiscount = amount;
    session.cartDiscountType = type;
    await session.save();

    res.json({ success: true, message: 'Discount applied.', data: cartResponse(session) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** POST /api/admin/pos/cart/customer  { customerId } or { name, phone } */
router.post('/cart/customer', async (req, res) => {
  try {
    const session = await requireOpenSession(req, res);
    if (!session) return;

    const { customerId, name, phone } = req.body;

    if (customerId) {
      if (!isValidId(customerId)) {
        return res.status(400).json({ success: false, message: 'Invalid customer id.' });
      }
      const customer = await User.findById(customerId).select('fullName phone');
      if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found.' });
      }
      session.customerId = customer._id;
      session.customerName = customer.fullName;
      session.customerPhone = customer.phone;
    } else if (String(name || '').trim()) {
      // A walk-in: recorded on the invoice without inventing an account.
      session.customerId = null;
      session.customerName = String(name).trim();
      session.customerPhone = String(phone || '').trim();
    } else {
      return res.status(400).json({
        success: false,
        message: 'Give either an existing customer id or a name for a walk-in.',
      });
    }

    await session.save();
    res.json({ success: true, message: 'Customer attached.', data: cartResponse(session) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// INVOICES
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/admin/pos/invoice/create  { paymentMethod, amountPaid, note }
 *
 * Settles the cart: re-checks stock, decrements it, writes the invoice and
 * empties the cart. Totals are recomputed here from the stored line prices —
 * nothing about the money comes from the request body except how much cash
 * was handed over.
 */
router.post('/invoice/create', async (req, res) => {
  try {
    const session = await requireOpenSession(req, res);
    if (!session) return;

    if (session.cart.length === 0) {
      return res.status(400).json({ success: false, message: 'The cart is empty.' });
    }

    const paymentMethod = ['cash', 'card', 'wallet'].includes(req.body.paymentMethod)
      ? req.body.paymentMethod
      : 'cash';

    const totals = priceCart(session);

    // Re-check every line against live stock: the cart may have been sitting
    // open while the merchant app or another till sold the same units.
    const products = await Product.find({
      _id: { $in: session.cart.map((i) => i.productId) },
    });
    const byId = new Map(products.map((p) => [String(p._id), p]));

    for (const line of session.cart) {
      const product = byId.get(String(line.productId));
      if (!product) {
        return res.status(409).json({
          success: false,
          message: `${line.name} is no longer in the catalogue. Remove it from the cart.`,
        });
      }
      if (product.stock < line.quantity) {
        return res.status(409).json({
          success: false,
          message: `Only ${product.stock} × ${product.name} left in stock.`,
        });
      }
    }

    const amountPaid = Number(req.body.amountPaid);
    const paid = Number.isFinite(amountPaid) ? round(amountPaid) : totals.total;
    if (paymentMethod === 'cash' && paid < totals.total) {
      return res.status(400).json({
        success: false,
        message: `Cash tendered (${paid}) is less than the total (${totals.total}).`,
      });
    }

    const invoice = await PosInvoice.create({
      sessionId: session._id,
      merchantId: session.merchantId,
      cashierId: req.user.id,
      customerId: session.customerId,
      customerName: session.customerName,
      customerPhone: session.customerPhone,
      items: session.cart.map((line) => ({
        productId: line.productId,
        name: line.name,
        code: line.code,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        vat: line.vat,
        lineTotal: round(line.unitPrice * line.quantity),
      })),
      subtotal: totals.subtotal,
      discount: totals.discount,
      discountType: session.cartDiscountType,
      tax: totals.tax,
      total: totals.total,
      paymentMethod,
      amountPaid: paid,
      changeDue: paymentMethod === 'cash' ? round(paid - totals.total) : 0,
      paymentStatus: 'paid',
      status: 'completed',
      note: String(req.body.note || '').trim(),
    });

    // Decrement stock. This is what feeds the low-stock alerts, so a till
    // sale shows up there the same as any other movement.
    await Promise.all(
      session.cart.map((line) =>
        Product.updateOne({ _id: line.productId }, { $inc: { stock: -line.quantity } })
      )
    );

    session.totalSales = round(session.totalSales + totals.total);
    session.invoiceCount += 1;
    session.cart = [];
    session.cartDiscount = 0;
    session.cartDiscountType = 'fixed';
    session.customerId = null;
    session.customerName = '';
    session.customerPhone = '';
    await session.save();

    res.status(201).json({
      success: true,
      message: `Invoice ${invoice.invoiceNumber} completed.`,
      data: { invoice: invoice.toJSON() },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'Invoice number collision — try again.',
      });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/admin/pos/invoices — history with filters. */
router.get('/invoices', async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const filter = {};

    if (req.query.merchantId && isValidId(req.query.merchantId)) {
      filter.merchantId = req.query.merchantId;
    }
    if (req.query.sessionId && isValidId(req.query.sessionId)) {
      filter.sessionId = req.query.sessionId;
    }
    if (req.query.status) filter.status = req.query.status;
    if (req.query.paymentMethod) filter.paymentMethod = req.query.paymentMethod;
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(req.query.search.trim()), 'i');
      filter.$or = [
        { invoiceNumber: rx },
        { customerName: rx },
        { customerPhone: rx },
        { 'items.name': rx },
      ];
    }
    if (req.query.from || req.query.to) {
      const range = {};
      const from = req.query.from ? new Date(req.query.from) : null;
      const to = req.query.to ? new Date(req.query.to) : null;
      if (from && !isNaN(from)) range.$gte = from;
      if (to && !isNaN(to)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to))) to.setHours(23, 59, 59, 999);
        range.$lte = to;
      }
      if (Object.keys(range).length) filter.createdAt = range;
    }

    const [items, total, totalsAgg] = await Promise.all([
      PosInvoice.find(filter)
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('merchantId', 'storeName fullName')
        .populate('cashierId', 'fullName')
        .lean(),
      PosInvoice.countDocuments(filter),
      PosInvoice.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            // Refunded invoices must not count toward takings, or the till
            // total would keep money it gave back.
            sales: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$total', 0] } },
            refunded: { $sum: { $cond: [{ $eq: ['$status', 'refunded'] }, '$total', 0] } },
          },
        },
      ]),
    ]);

    const sums = totalsAgg[0] || { sales: 0, refunded: 0 };

    res.json({
      success: true,
      message: 'POS invoices',
      data: {
        items: items.map((i) => ({
          ...i,
          merchantName: i.merchantId ? (i.merchantId.storeName || i.merchantId.fullName) : '',
          cashierName: i.cashierId ? i.cashierId.fullName : '',
        })),
        total, page, limit,
        pages: Math.ceil(total / limit),
        totals: { sales: round(sums.sales), refunded: round(sums.refunded) },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/admin/pos/invoice/:id */
router.get('/invoice/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid invoice id.' });
    }
    const invoice = await PosInvoice.findById(req.params.id)
      .populate('merchantId', 'storeName fullName phone storeAddress')
      .populate('cashierId', 'fullName')
      .lean();
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found.' });

    res.json({
      success: true,
      message: 'Invoice',
      data: {
        invoice: {
          ...invoice,
          merchantName: invoice.merchantId
            ? (invoice.merchantId.storeName || invoice.merchantId.fullName)
            : '',
          cashierName: invoice.cashierId ? invoice.cashierId.fullName : '',
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/admin/pos/invoice/refund  { invoiceId, reason }
 * Full refund: puts the stock back and reverses the session's takings.
 */
router.post('/invoice/refund', async (req, res) => {
  try {
    const { invoiceId } = req.body;
    if (!isValidId(invoiceId)) {
      return res.status(400).json({ success: false, message: 'A valid invoice id is required.' });
    }

    const invoice = await PosInvoice.findById(invoiceId);
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found.' });

    if (invoice.status === 'refunded') {
      return res.status(409).json({ success: false, message: 'This invoice was already refunded.' });
    }
    if (invoice.status === 'cancelled') {
      return res.status(409).json({ success: false, message: 'This invoice was cancelled.' });
    }

    const reason = String(req.body.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ success: false, message: 'A refund reason is required.' });
    }

    invoice.status = 'refunded';
    invoice.paymentStatus = 'refunded';
    invoice.refundedAt = new Date();
    invoice.refundReason = reason;
    invoice.refundedBy = req.user.id;
    await invoice.save();

    // Stock goes back on the shelf.
    await Promise.all(
      invoice.items.map((line) =>
        Product.updateOne({ _id: line.productId }, { $inc: { stock: line.quantity } })
      )
    );

    // Reverse the takings on the session that made the sale — which may not
    // be the one currently open, so it is looked up by the invoice.
    const session = await PosSession.findById(invoice.sessionId);
    if (session) {
      session.totalRefunds = round(session.totalRefunds + invoice.total);
      session.refundCount += 1;
      await session.save();
    }

    res.json({
      success: true,
      message: `Invoice ${invoice.invoiceNumber} refunded.`,
      data: { invoice: invoice.toJSON() },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// CUSTOMERS
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/pos/customers?search= */
router.get('/customers', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const filter = { role: 'customer' };

    if (req.query.search) {
      const rx = new RegExp(escapeRegex(req.query.search.trim()), 'i');
      filter.$or = [{ fullName: rx }, { email: rx }, { phone: rx }];
    }

    const items = await User.find(filter)
      .sort({ createdAt: -1 }).limit(limit)
      .select('fullName email phone walletPoints walletBalance isActive')
      .lean();

    res.json({ success: true, message: 'Customers', data: { items, total: items.length } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/admin/pos/customers  { fullName, phone, email }
 * Creates a real customer account for a walk-in who wants one. The password
 * is random: the customer resets it through the normal forgot-password flow
 * rather than being handed one at the counter.
 */
router.post('/customers', async (req, res) => {
  try {
    const { fullName, phone } = req.body;
    if (!String(fullName || '').trim() || !String(phone || '').trim()) {
      return res.status(400).json({ success: false, message: 'Name and phone are required.' });
    }

    const email = String(req.body.email || '').toLowerCase().trim() ||
      `pos_${Date.now()}@walkin.vips.local`;

    const existing = await User.findOne({ $or: [{ phone: String(phone).trim() }, { email }] });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'A customer with that phone or email already exists.',
        data: { customer: existing.toJSON() },
      });
    }

    const customer = await User.create({
      fullName: String(fullName).trim(),
      email,
      phone: String(phone).trim(),
      password: require('crypto').randomBytes(24).toString('hex'),
      role: 'customer',
    });

    res.status(201).json({
      success: true,
      message: 'Customer created.',
      data: { customer: customer.toJSON() },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
