// Paymee.tn REST integration (primary gateway for Tunisia, TND).
// Endpoints/fields verified against https://www.paymee.tn/mobile-integration-paymee/
// (2026-08). Mirrors utils/mailer.js's graceful-degrade pattern: never throws
// into a request handler for missing config, exposes getInitStatus() for
// /api/health.
//
// Paymee does not offer a server-to-server "check status" polling endpoint —
// per their docs, status is only ever pushed via webhook_url. So
// GET /api/payment/paymee/status/:id (in routes/payment.js) reports OUR
// Order.paymentStatus, which the webhook handler keeps up to date, rather
// than querying Paymee directly.
const crypto = require('crypto');

function baseUrl() {
  // PAYMEE_MODE=live switches to the production host; sandbox by default so
  // nothing can accidentally move real money before it's explicitly flipped.
  return process.env.PAYMEE_MODE === 'live'
    ? 'https://app.paymee.tn/api/v2'
    : 'https://sandbox.paymee.tn/api/v2';
}

let configError = null;
function ensureConfigured() {
  if (process.env.PAYMEE_API_KEY) return true;
  configError = 'PAYMEE_API_KEY env var is not set — Paymee payments are disabled.';
  return false;
}

function getInitStatus() {
  const ok = ensureConfigured();
  return ok
    ? { configured: true, mode: process.env.PAYMEE_MODE === 'live' ? 'live' : 'sandbox' }
    : { configured: false, error: configError };
}

// Returns { ok: true, token, paymentUrl } or { ok: false, error }.
async function createPayment({ amount, note, firstName, lastName, email, phone, orderId, returnUrl, cancelUrl, webhookUrl }) {
  if (!ensureConfigured()) return { ok: false, error: configError };

  try {
    const res = await fetch(`${baseUrl()}/payments/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${process.env.PAYMEE_API_KEY}`,
      },
      body: JSON.stringify({
        amount,
        note: note || `VIPs order ${orderId}`,
        first_name: firstName || 'VIPs',
        last_name: lastName || 'Customer',
        email,
        phone,
        order_id: String(orderId),
        return_url: returnUrl,
        cancel_url: cancelUrl,
        webhook_url: webhookUrl,
      }),
    });
    const body = await res.json();
    if (!res.ok || !body.status) {
      return { ok: false, error: body.message || `Paymee create-payment failed (HTTP ${res.status})` };
    }
    return { ok: true, token: body.data.token, paymentUrl: body.data.payment_url };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Paymee's webhook check_sum formula: MD5(token + payment_status + api_key).
// payment_status must be interpolated as the literal string Paymee sent
// ("true"/"false"), not a JS boolean, since the hash is over raw form text.
function verifyChecksum({ token, payment_status, check_sum }) {
  if (!process.env.PAYMEE_API_KEY) return false;
  const expected = crypto
    .createHash('md5')
    .update(`${token}${payment_status}${process.env.PAYMEE_API_KEY}`)
    .digest('hex');
  return expected === check_sum;
}

module.exports = { createPayment, verifyChecksum, getInitStatus };
