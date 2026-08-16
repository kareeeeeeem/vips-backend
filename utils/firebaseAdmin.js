const admin = require('firebase-admin');

let initialized = false;
let initError = null;

function ensureInitialized() {
  if (initialized) return;
  if (initError) throw initError;
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT env var is not set — social login cannot verify tokens.'
      );
    }
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    initialized = true;
  } catch (err) {
    // Cache the failure so every request doesn't re-attempt (and
    // re-log) a doomed initialization, and so /api/health can report
    // exactly why without needing Render dashboard/log access.
    initError = err;
    throw err;
  }
}

// Verifies a Firebase ID token and returns its decoded claims (uid, email,
// name, phone_number, ...). Throws if the token is missing, expired, or
// forged — callers must not fall back to trusting client-supplied fields.
async function verifyFirebaseIdToken(idToken) {
  ensureInitialized();
  return admin.auth().verifyIdToken(idToken);
}

// For /api/health — reports whether the service account loaded, and if
// not, why (message only, never the raw env var value).
function getInitStatus() {
  if (initialized) return { configured: true };
  try {
    ensureInitialized();
    return { configured: true };
  } catch (err) {
    return { configured: false, error: err.message };
  }
}

module.exports = { verifyFirebaseIdToken, getInitStatus };
