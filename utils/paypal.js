// PayPal Orders v2 integration (international payments — PayPal doesn't
// support TND, so this path is only offered for currencies PayPal actually
// settles, per PAYPAL_CURRENCY, default USD). Mirrors utils/mailer.js's
// graceful-degrade pattern: never throws for missing config, exposes
// getInitStatus() for /api/health.
let cachedToken = null;
let cachedTokenExpiry = 0;

function baseUrl() {
  return process.env.PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

let configError = null;
function ensureConfigured() {
  if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) return true;
  configError = 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET env vars are not set — PayPal payments are disabled.';
  return false;
}

function getInitStatus() {
  const ok = ensureConfigured();
  return ok
    ? { configured: true, mode: process.env.PAYPAL_MODE === 'live' ? 'live' : 'sandbox' }
    : { configured: false, error: configError };
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const creds = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${baseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description || 'PayPal OAuth failed');

  cachedToken = body.access_token;
  cachedTokenExpiry = Date.now() + (body.expires_in - 60) * 1000;
  return cachedToken;
}

// Returns { ok: true, id, approveUrl } or { ok: false, error }.
async function createOrder({ amount, currency, orderId, returnUrl, cancelUrl }) {
  if (!ensureConfigured()) return { ok: false, error: configError };

  try {
    const token = await getAccessToken();
    const res = await fetch(`${baseUrl()}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: String(orderId),
            amount: { currency_code: currency || process.env.PAYPAL_CURRENCY || 'USD', value: Number(amount).toFixed(2) },
          },
        ],
        application_context: {
          return_url: returnUrl,
          cancel_url: cancelUrl,
          user_action: 'PAY_NOW',
        },
      }),
    });
    const body = await res.json();
    if (!res.ok) return { ok: false, error: body.message || `PayPal create-order failed (HTTP ${res.status})` };

    const approveUrl = (body.links || []).find((l) => l.rel === 'approve')?.href || null;
    return { ok: true, id: body.id, approveUrl };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Returns { ok: true, status, captureId } or { ok: false, error }.
async function captureOrder(paypalOrderId) {
  if (!ensureConfigured()) return { ok: false, error: configError };

  try {
    const token = await getAccessToken();
    const res = await fetch(`${baseUrl()}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    const body = await res.json();
    if (!res.ok) return { ok: false, error: body.message || `PayPal capture failed (HTTP ${res.status})` };

    const capture = body.purchase_units?.[0]?.payments?.captures?.[0];
    return { ok: true, status: body.status, captureId: capture?.id || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Verifies an inbound webhook via PayPal's verify-webhook-signature API.
// Requires PAYPAL_WEBHOOK_ID (from the webhook's settings page in the
// PayPal developer dashboard). Without it, webhooks are accepted
// unverified — same posture as most gateways in sandbox before the
// merchant has registered a production webhook.
async function verifyWebhookSignature(headers, body) {
  if (!process.env.PAYPAL_WEBHOOK_ID) return true;
  try {
    const token = await getAccessToken();
    const res = await fetch(`${baseUrl()}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        transmission_id: headers['paypal-transmission-id'],
        transmission_time: headers['paypal-transmission-time'],
        cert_url: headers['paypal-cert-url'],
        auth_algo: headers['paypal-auth-algo'],
        transmission_sig: headers['paypal-transmission-sig'],
        webhook_id: process.env.PAYPAL_WEBHOOK_ID,
        webhook_event: body,
      }),
    });
    const result = await res.json();
    return result.verification_status === 'SUCCESS';
  } catch (_) {
    return false;
  }
}

module.exports = { createOrder, captureOrder, verifyWebhookSignature, getInitStatus };
