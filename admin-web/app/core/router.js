/**
 * Hash routing.
 *
 * The hash keeps the console working wherever it is mounted and whatever the
 * server does with unknown paths — no history rewrite rules to get wrong on
 * Render, and a reload of a deep link always lands on the same screen.
 *
 * A screen module exports `{ title, subtitle?, permission?, breadcrumb?, render }`.
 * `render(host, ctx)` may return a cleanup function; it is called before the
 * next screen draws, which is how charts get destroyed and timers cleared.
 */

import * as auth from './auth.js';
import { errorState, loadingState, render as paint } from './ui.js';

const routes = [];
let currentCleanup = null;
let currentPath = null;
let generation = 0;

/**
 * `pattern` is '/users' or '/users/:id'. Order matters only in that the
 * first match wins, so register the specific before the general.
 */
export function route(pattern, loader) {
  const names = [];
  const regex = new RegExp(`^${pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:(\w+)/g, (_, name) => { names.push(name); return '([^/]+)'; })}$`);
  routes.push({ pattern, regex, names, loader });
}

function match(path) {
  for (const entry of routes) {
    const found = entry.regex.exec(path);
    if (!found) continue;
    const params = {};
    entry.names.forEach((name, i) => { params[name] = decodeURIComponent(found[i + 1]); });
    return { entry, params };
  }
  return null;
}

/** The path part of the hash: '#/users?page=2' -> '/users'. */
function parseHash() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  const [path, search = ''] = hash.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(search)) };
}

export function go(path, query) {
  const search = query && Object.keys(query).length
    ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v != null)).toString()}`
    : '';
  window.location.hash = `#${path}${search}`;
}

/** Change the query without adding a history entry or redrawing the screen. */
export function replaceQuery(query) {
  const { path } = parseHash();
  const search = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== '' && v != null),
  ).toString();
  const next = `#${path}${search ? `?${search}` : ''}`;
  window.history.replaceState(null, '', next);
}

export const currentRoute = () => parseHash();

const listeners = new Set();
export function onNavigate(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function draw() {
  const host = document.getElementById('view');
  if (!host) return;

  const { path, query } = parseHash();
  const found = match(path);
  const mine = ++generation;

  if (currentCleanup) {
    try { currentCleanup(); } catch { /* a screen's cleanup must not block the next one */ }
    currentCleanup = null;
  }

  if (!found) {
    paint(host, errorState({ message: `No screen is registered at ${path}.` }));
    listeners.forEach((fn) => fn({ path, query, screen: null }));
    return;
  }

  paint(host, loadingState());

  let screen;
  try {
    screen = await found.entry.loader();
    if (screen && screen.default) screen = screen.default;
  } catch (error) {
    // Tell the chrome where we are even though the module never arrived, or
    // the header keeps naming the previous screen while the body reports a
    // failure — which reads as the old screen having broken.
    listeners.forEach((fn) => fn({ path, query, screen: null }));
    paint(host, errorState({ message: `That screen failed to load. ${error.message}` }));
    return;
  }
  if (mine !== generation) return; // a newer navigation overtook this one

  if (screen.permission && !auth.can(screen.permission)) {
    paint(host, errorState({
      message: `You do not have permission to open ${screen.title || path}.`,
      status: 403,
    }));
    listeners.forEach((fn) => fn({ path, query, screen }));
    return;
  }

  currentPath = path;
  listeners.forEach((fn) => fn({ path, query, screen, params: found.params }));

  try {
    host.innerHTML = '';
    const cleanup = await screen.render(host, {
      params: found.params,
      query,
      path,
      /** Re-run the current screen — used after a mutation. */
      reload: () => { if (mine === generation) draw(); },
      /** Update the URL's query and re-render this screen. */
      setQuery: (next) => {
        replaceQuery(next);
        if (mine === generation) draw();
      },
    });
    if (mine !== generation) {
      if (typeof cleanup === 'function') cleanup();
      return;
    }
    currentCleanup = typeof cleanup === 'function' ? cleanup : null;
  } catch (error) {
    if (mine !== generation) return;
    paint(host, errorState(error, () => draw()));
  }
}

export const activePath = () => currentPath;

export function start() {
  window.addEventListener('hashchange', draw);
  if (!window.location.hash) window.location.hash = '#/';
  else draw();
}

/** Redraw the current screen from scratch. */
export const refresh = () => draw();
