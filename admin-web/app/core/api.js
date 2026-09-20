/**
 * The one place this console talks to the backend.
 *
 * Every admin endpoint answers the same envelope — `{ success, message, data }`
 * — so unwrapping it here means no screen ever repeats that dance, and a
 * failure arrives as a thrown ApiError with a message worth showing rather
 * than as `undefined` three frames later.
 */

const BASE = '/api/admin';
const TOKEN_KEY = 'vips.admin.token';

/** Raised for any non-2xx answer, and for a 2xx that carries success:false. */
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export const token = {
  get: () => {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set: (value) => {
    try { localStorage.setItem(TOKEN_KEY, value); } catch { /* private mode */ }
  },
  clear: () => {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
  },
};

/**
 * Called when the server rejects our token. Set by auth.js rather than
 * imported from it, because auth.js imports this module — wiring it the
 * other way round is a cycle.
 */
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

/** Turn `{ page: 2, status: '' }` into `?page=2` — empty values are dropped. */
export function qs(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : '';
}

async function request(method, path, { body, signal, raw = false } = {}) {
  const headers = {};
  const auth = token.get();
  if (auth) headers.Authorization = `Bearer ${auth}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(BASE + path, {
      method,
      headers,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    // fetch only rejects when the request never completed: offline, DNS,
    // CORS, server down. Worth saying so plainly instead of "Failed to fetch".
    throw new ApiError('Cannot reach the server. Check that the backend is running.', 0, null);
  }

  // A file download (report export) is not JSON and must not be parsed.
  if (raw) {
    if (!response.ok) {
      throw new ApiError(`Export failed (${response.status}).`, response.status, null);
    }
    return response;
  }

  let payload = null;
  const text = await response.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { /* leave null; handled below */ }
  }

  if (response.status === 401) {
    onUnauthorized();
    throw new ApiError(payload?.message || 'Your session has expired. Sign in again.', 401, payload);
  }

  if (!response.ok || payload?.success === false) {
    // 403 arrives whenever the operator's role does not carry the permission
    // the route wants. Saying which permission is missing turns a dead end
    // into something the person can actually ask their admin for.
    const fallback = response.status === 403
      ? 'Your role does not allow this action.'
      : `Request failed (${response.status}).`;
    throw new ApiError(payload?.message || fallback, response.status, payload);
  }

  if (payload === null) {
    throw new ApiError('The server sent a response this console could not read.', response.status, null);
  }

  return payload;
}

/** GET, returning the unwrapped `data`. */
export const get = async (path, params, opts) =>
  (await request('GET', path + qs(params), opts)).data;

/** GET, returning the whole envelope — for the handful of routes whose
 *  `message` or top-level extras matter to the caller. */
export const getFull = (path, params, opts) => request('GET', path + qs(params), opts);

export const post = async (path, body, opts) =>
  (await request('POST', path, { ...opts, body: body ?? {} }));

export const put = async (path, body, opts) =>
  (await request('PUT', path, { ...opts, body: body ?? {} }));

/**
 * DELETE, optionally with a body — cancelling an order carries a reason, and
 * express.json() parses a DELETE body like any other.
 */
export const del = async (path, body, opts) =>
  request('DELETE', path, body === undefined ? opts : { ...opts, body });

/**
 * Download whatever a route streams back, under the filename it names in
 * Content-Disposition. Used by the report and dashboard exports.
 */
export async function download(path, params, fallbackName = 'export.csv') {
  const response = await request('GET', path + qs(params), { raw: true });

  const disposition = response.headers.get('content-disposition') || '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const name = match ? decodeURIComponent(match[1]) : fallbackName;

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in Safari; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}
