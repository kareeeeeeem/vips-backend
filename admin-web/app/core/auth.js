/**
 * Who is signed in, and what they are allowed to do.
 *
 * `can()` decides whether a control is drawn. That is presentation only —
 * every one of these actions is gated again server-side, so a hidden button
 * is a courtesy to the operator, never the security boundary. Screens should
 * still expect a 403 and show it.
 */

import * as api from './api.js';

const session = {
  user: null,
  adminRole: null,
  permissions: [],
};

const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn(session));

/** Subscribe to sign-in / sign-out / profile refresh. Returns an unsubscribe. */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const current = () => session;
export const isSignedIn = () => Boolean(session.user);

/**
 * True when the signed-in operator holds `permission`.
 *
 * Mirrors middleware/permissions.js: '*' is everything, 'orders.*' is every
 * action in that module. Kept deliberately identical so the console hides
 * exactly what the server would refuse.
 */
export function can(permission) {
  if (!permission) return true;
  const granted = session.permissions || [];
  if (granted.includes('*')) return true;
  if (granted.includes(permission)) return true;
  const [module] = permission.split('.');
  return granted.includes(`${module}.*`);
}

/** True when the operator holds at least one of these. */
export const canAny = (...permissions) =>
  permissions.length === 0 || permissions.some((p) => can(p));

function adopt(payload) {
  session.user = payload.user || null;
  session.adminRole = payload.adminRole || null;
  session.permissions = payload.permissions || [];
  notify();
}

export async function signIn(email, password) {
  const response = await api.post('/login', { email, password });
  const data = response.data || {};
  if (!data.token) throw new api.ApiError('The server did not return a session token.', 0, data);
  api.token.set(data.token);
  adopt(data);
  return session;
}

/**
 * Re-read the profile from the server.
 *
 * Called on every boot with a stored token: a role change or a disabled
 * account has to take effect the next time the console opens, not whenever
 * the token finally expires.
 */
export async function refresh() {
  if (!api.token.get()) return null;
  const data = await api.get('/me');
  adopt(data);
  return session;
}

export async function signOut({ notifyServer = true } = {}) {
  if (notifyServer && api.token.get()) {
    // Best-effort: the token is being thrown away either way, so a failure
    // here must not keep somebody signed in on a shared machine.
    try { await api.post('/logout'); } catch { /* ignore */ }
  }
  api.token.clear();
  session.user = null;
  session.adminRole = null;
  session.permissions = [];
  notify();
}

/** Wire api.js's 401 handling back to us without creating an import cycle. */
api.setUnauthorizedHandler(() => {
  api.token.clear();
  session.user = null;
  session.adminRole = null;
  session.permissions = [];
  notify();
});
