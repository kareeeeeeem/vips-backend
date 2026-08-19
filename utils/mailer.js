// SendGrid email integration. Mirrors utils/firebaseAdmin.js's pattern:
// lazy-init, never throws into a request handler for a missing key, and
// exposes a status getter for /api/health. Until SENDGRID_API_KEY is set,
// sendEmail() logs the would-be email to the console and returns
// { sent: false } instead of failing the request that triggered it (e.g.
// registration/forgot-password must still succeed even if delivery can't
// happen yet) — no code changes needed once the key is added, it just
// starts actually sending.
const sgMail = require('@sendgrid/mail');

let configured = false;
let configError = null;

function ensureConfigured() {
  if (configured) return true;
  if (configError) return false;
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    configError = 'SENDGRID_API_KEY env var is not set — emails will be logged, not sent.';
    return false;
  }
  sgMail.setApiKey(apiKey);
  configured = true;
  return true;
}

// For /api/health — mirrors firebaseAdmin.getInitStatus().
function getInitStatus() {
  if (configured) return { configured: true };
  ensureConfigured();
  return { configured: false, error: configError };
}

// Returns { sent: boolean, error?: string }. Never throws — callers should
// treat a failed send as non-fatal to whatever real action triggered it.
async function sendEmail({ to, subject, text, html }) {
  if (!ensureConfigured()) {
    console.log(`📧 [mailer] SendGrid not configured — would have sent to ${to}: "${subject}"\n${text}`);
    return { sent: false, error: configError };
  }
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;
  if (!fromEmail) {
    const err = 'SENDGRID_FROM_EMAIL env var is not set.';
    console.error(`📧 [mailer] ${err}`);
    return { sent: false, error: err };
  }
  try {
    await sgMail.send({ to, from: fromEmail, subject, text, html: html || `<p>${text}</p>` });
    return { sent: true };
  } catch (err) {
    const detail = err.response?.body?.errors?.map((e) => e.message).join('; ') || err.message;
    console.error(`📧 [mailer] SendGrid send to ${to} failed: ${detail}`);
    return { sent: false, error: detail };
  }
}

async function sendOtpEmail(to, otp, purpose = 'verify your email') {
  return sendEmail({
    to,
    subject: 'Your VIPs verification code',
    text: `Your code to ${purpose} is: ${otp}\n\nThis code expires in 15 minutes. If you didn't request this, you can ignore this email.`,
  });
}

module.exports = { sendEmail, sendOtpEmail, getInitStatus };
