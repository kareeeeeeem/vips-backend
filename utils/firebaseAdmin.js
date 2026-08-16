const admin = require('firebase-admin');

let initialized = false;

function ensureInitialized() {
  if (initialized) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT env var is not set — social login cannot verify tokens.'
    );
  }
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  initialized = true;
}

// Verifies a Firebase ID token and returns its decoded claims (uid, email,
// name, phone_number, ...). Throws if the token is missing, expired, or
// forged — callers must not fall back to trusting client-supplied fields.
async function verifyFirebaseIdToken(idToken) {
  ensureInitialized();
  return admin.auth().verifyIdToken(idToken);
}

module.exports = { verifyFirebaseIdToken };
