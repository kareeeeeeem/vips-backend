const express = require('express');
const Order = require('../models/Order');
const User = require('../models/User');
const { authMiddleware } = require('../middleware/auth');
const paymee = require('../utils/paymee');
const paypal = require('../utils/paypal');
const { creditPointsForOrder } = require('../utils/points');

const router = express.Router();

function backendUrl() {
  return process.env.BACKEND_URL || 'https://vips-backend.onrender.com';
}

// Both gateways' checkout happens in an in-app WebView (mobile integration,
// not a website), so return/cancel don't need a deep link back into the
// app — they just need to render something so the WebView isn't left on a
// blank screen while it waits for the app to notice completion. The
// authoritative status update always comes from the webhook below; the app
// itself confirms completion by polling GET /status/:id, exactly as
// documented in utils/paymee.js (Paymee has no server-side status-check API).
router.get('/paymee/return', (req, res) => {
  res.send('<html><body style="font-family:sans-serif;text-align:center;padding-top:40px"><h3>Payment received</h3><p>You can return to the VIPs app now.</p></body></html>');
});
router.get('/paymee/cancel', (req, res) => {
  res.send('<html><body style="font-family:sans-serif;text-align:center;padding-top:40px"><h3>Payment cancelled</h3><p>You can return to the VIPs app now.</p></body></html>');
});

// ─── GET /api/payment/methods ──────────────────────────────
// Lets the app show only gateways that are actually configured, instead of
// hardcoding availability client-side.
router.get('/methods', authMiddleware, (req, res) => {
  res.json({
    success: true,
    data: {
      cash: { enabled: true },
      paymee: paymee.getInitStatus(),
      paypal: paypal.getInitStatus(),
    },
  });
});

// ─── POST /api/payment/paymee/initiate ─────────────────────
router.post('/paymee/initiate', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = await Order.findById(orderId);
    if (!order || String(order.userId) !== req.user.id) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (order.paymentStatus === 'paid') {
      return res.status(400).json({ success: false, message: 'Order is already paid' });
    }

    const user = await User.findById(req.user.id);
    const [firstName, ...rest] = (user?.fullName || 'VIPs Customer').split(' ');

    const result = await paymee.createPayment({
      amount: order.totalAmount,
      note: `VIPs order #${order.orderNumber}`,
      firstName: firstName || 'VIPs',
      lastName: rest.join(' ') || 'Customer',
      email: user?.email || 'no-reply@vips.app',
      phone: user?.phone || '00000000',
      orderId: order.orderNumber,
      returnUrl: `${backendUrl()}/api/payment/paymee/return`,
      cancelUrl: `${backendUrl()}/api/payment/paymee/cancel`,
      webhookUrl: process.env.PAYMEE_WEBHOOK_URL || `${backendUrl()}/api/payment/paymee/webhook`,
    });

    if (!result.ok) {
      return res.status(503).json({ success: false, message: result.error });
    }

    order.paymentMethod = 'paymee';
    order.paymentReference = result.token;
    await order.save();

    res.json({ success: true, data: { paymentUrl: result.paymentUrl, token: result.token } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/payment/paymee/webhook ──────────────────────
// Public (called by Paymee's servers) — no authMiddleware. Integrity is
// verified via the check_sum formula instead, per utils/paymee.js.
router.post('/paymee/webhook', express.json(), async (req, res) => {
  try {
    const { token, payment_status, check_sum } = req.body;
    if (!paymee.verifyChecksum({ token, payment_status, check_sum: check_sum })) {
      return res.status(400).json({ success: false, message: 'Invalid checksum' });
    }

    const order = await Order.findOne({ paymentReference: token });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const paid = payment_status === true || payment_status === 'true';
    order.paymentStatus = paid ? 'paid' : 'failed';
    if (paid && order.status === 'pending') order.status = 'confirmed';
    await order.save();

    if (paid) await creditPointsForOrder(order);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /api/payment/paymee/status/:id ────────────────────
// Paymee has no polling API (see utils/paymee.js) — this reports our own
// Order.paymentStatus, which the webhook above keeps current. The app polls
// this after the WebView reaches the return/cancel page.
router.get('/paymee/status/:id', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order || String(order.userId) !== req.user.id) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    res.json({ success: true, data: { paymentStatus: order.paymentStatus, orderStatus: order.status } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/payment/paypal/create ───────────────────────
router.post('/paypal/create', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = await Order.findById(orderId);
    if (!order || String(order.userId) !== req.user.id) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (order.paymentStatus === 'paid') {
      return res.status(400).json({ success: false, message: 'Order is already paid' });
    }

    const result = await paypal.createOrder({
      amount: order.totalAmount,
      currency: process.env.PAYPAL_CURRENCY || 'USD',
      orderId: order.orderNumber,
      returnUrl: `${backendUrl()}/api/payment/paymee/return`,
      cancelUrl: `${backendUrl()}/api/payment/paymee/cancel`,
    });

    if (!result.ok) {
      return res.status(503).json({ success: false, message: result.error });
    }

    order.paymentMethod = 'paypal';
    order.paymentReference = result.id;
    await order.save();

    res.json({ success: true, data: { approveUrl: result.approveUrl, paypalOrderId: result.id } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/payment/paypal/capture ──────────────────────
// Called by the app right after the user approves in the PayPal WebView —
// PayPal's flow captures on the merchant's explicit call, not automatically.
router.post('/paypal/capture', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = await Order.findById(orderId);
    if (!order || String(order.userId) !== req.user.id) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    // Idempotent: the app polls this while the user is in the PayPal
    // browser tab, so a repeat call after the first successful capture
    // must not re-hit PayPal (it would reject an already-captured order).
    if (order.paymentStatus === 'paid') {
      return res.json({ success: true, data: { paymentStatus: 'paid' } });
    }
    if (!order.paymentReference) {
      return res.status(400).json({ success: false, message: 'No PayPal order to capture' });
    }

    const result = await paypal.captureOrder(order.paymentReference);
    if (!result.ok) {
      return res.status(503).json({ success: false, message: result.error });
    }

    const paid = result.status === 'COMPLETED';
    order.paymentStatus = paid ? 'paid' : 'failed';
    if (paid && order.status === 'pending') order.status = 'confirmed';
    await order.save();

    if (paid) await creditPointsForOrder(order);

    res.json({ success: true, data: { paymentStatus: order.paymentStatus } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /api/payment/paypal/webhook ──────────────────────
// Public (called by PayPal's servers). Handles the case where capture
// happens/settles server-side asynchronously even after our own
// /paypal/capture call already returned — keeps Order in sync either way.
router.post('/paypal/webhook', express.json(), async (req, res) => {
  try {
    const verified = await paypal.verifyWebhookSignature(req.headers, req.body);
    if (!verified) return res.status(400).json({ success: false, message: 'Signature verification failed' });

    const event = req.body;
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' || event.event_type === 'CHECKOUT.ORDER.APPROVED') {
      const paypalOrderId =
        event.resource?.supplementary_data?.related_ids?.order_id || event.resource?.id;
      const order = await Order.findOne({ paymentReference: paypalOrderId });
      if (order && order.paymentStatus !== 'paid') {
        order.paymentStatus = 'paid';
        if (order.status === 'pending') order.status = 'confirmed';
        await order.save();
        await creditPointsForOrder(order);
      }
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
