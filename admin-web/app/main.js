/**
 * Boot: decide whether to show the sign-in card or the console, build the
 * sidebar from the operator's permissions, register the routes, and keep the
 * chrome (title, breadcrumb, alert dot) in step with the router.
 */

import * as auth from './core/auth.js';
import * as router from './core/router.js';
import * as api from './core/api.js';
import { NAV, byPath } from './nav.js';
import { esc, html, node, raw, toast, toastError } from './core/ui.js';
import { initials } from './core/format.js';

// ── routes ───────────────────────────────────────────────────
// Loaders are dynamic imports, so a screen's code is fetched the first time
// it is opened rather than all of it up front.

const screen = (name) => () => import(`./screens/${name}.js`);

router.route('/', screen('dashboard'));

router.route('/dashboards/sales', screen('dashboard-sales'));
router.route('/dashboards/operations', screen('dashboard-operations'));
router.route('/dashboards/finance', screen('dashboard-finance'));
router.route('/dashboards/marketing', screen('dashboard-marketing'));
router.route('/dashboards/merchants', screen('dashboard-merchants'));
router.route('/analytics', screen('analytics'));

router.route('/customers', screen('customers'));
router.route('/customers/:id', screen('customer-detail'));
router.route('/merchants', screen('merchants'));
router.route('/merchants/:id', screen('merchant-detail'));
router.route('/guarantees', screen('guarantees'));
router.route('/guarantees/requests', screen('guarantee-requests'));

router.route('/orders', screen('orders'));
router.route('/orders/:id', screen('order-detail'));
router.route('/products', screen('products'));
router.route('/offers', screen('offers'));
router.route('/subscriptions', screen('subscriptions'));
router.route('/wallets', screen('wallets'));
router.route('/ads', screen('ads'));
router.route('/broadcasts', screen('broadcasts'));
router.route('/inventory', screen('inventory'));
router.route('/inventory/movements', screen('inventory-movements'));
router.route('/inventory/alerts', screen('inventory-alerts'));

router.route('/pos', screen('pos-till'));
router.route('/pos/sessions', screen('pos-sessions'));
router.route('/pos/invoices', screen('pos-invoices'));

router.route('/reports/:kind', screen('reports'));

router.route('/staff', screen('staff'));
router.route('/roles', screen('roles'));
router.route('/audit', screen('audit'));
router.route('/audit/:id', screen('audit-detail'));
router.route('/settings', screen('settings'));
router.route('/profile', screen('profile'));
router.route('/search', screen('search'));

// ── sidebar ──────────────────────────────────────────────────

const visible = (item) => {
  if (item.group || (item.children && !item.path)) {
    const kids = (item.children || []).filter(visible);
    return kids.length > 0;
  }
  return !item.permission || auth.can(item.permission);
};

function navLink(item, active) {
  return html`
    <li class="sidebar-menu-item ${active === item.path ? 'active' : ''}">
      <a href="#${item.path}">
        <i class="menu-icon ${item.icon || 'las la-circle'}"></i>
        <span class="menu-title">${item.label}</span>
      </a>
    </li>`;
}

function navDropdown(item, active) {
  const children = item.children.filter(visible);
  const open = children.some((c) => c.path === active);
  return html`
    <li class="sidebar-menu-item sidebar-dropdown ${open ? 'active' : ''}">
      <a href="javascript:void(0)">
        <i class="menu-icon ${item.icon || 'las la-folder'}"></i>
        <span class="menu-title">${item.label}</span>
      </a>
      <ul class="sidebar-submenu" ${raw(open ? 'style="display:block"' : '')}>
        <li class="sidebar-menu-item">
          ${children.map((child) => html`
            <a href="#${child.path}" class="nav-link ${active === child.path ? 'active' : ''}">
              <i class="menu-icon las la-ellipsis-h"></i>
              <span class="menu-title">${child.label}</span>
            </a>`)}
        </li>
      </ul>
    </li>`;
}

function buildSidebar(active) {
  const menu = document.getElementById('sidebar-menu');
  const parts = [];

  for (const item of NAV) {
    if (!visible(item)) continue;
    if (item.group) {
      parts.push(html`<li class="sidebar-menu-header">${item.group}</li>`);
      for (const child of item.children.filter(visible)) {
        parts.push(child.children && !child.path ? navDropdown(child, active) : navLink(child, active));
      }
    } else {
      parts.push(navLink(item, active));
    }
  }

  menu.innerHTML = '';
  menu.append(node(html`${parts}`));
}

/** Accordion behaviour, delegated so it survives every sidebar rebuild. */
document.addEventListener('click', (event) => {
  const toggle = event.target.closest('.sidebar-dropdown > a');
  if (toggle) {
    const item = toggle.parentElement;
    const submenu = item.querySelector('.sidebar-submenu');
    const isOpen = item.classList.contains('active');
    document.querySelectorAll('.sidebar-dropdown.active').forEach((other) => {
      if (other === item) return;
      other.classList.remove('active');
      const menu = other.querySelector('.sidebar-submenu');
      if (menu) menu.style.display = 'none';
    });
    item.classList.toggle('active', !isOpen);
    if (submenu) submenu.style.display = isOpen ? 'none' : 'block';
    return;
  }

  if (event.target.closest('.sidebar-menu-bar')) {
    document.querySelector('.page-wrapper')?.classList.toggle('sidebar-collapsed');
    return;
  }

  // On a narrow screen the sidebar overlays the page; picking a destination
  // should put it away again.
  if (event.target.closest('.sidebar a[href^="#/"]') && window.innerWidth < 992) {
    document.querySelector('.page-wrapper')?.classList.remove('sidebar-open');
  }
});

// ── chrome ───────────────────────────────────────────────────

const NAV_BY_PATH = byPath();

function updateChrome({ path, screen: current }) {
  const entry = NAV_BY_PATH[path];
  const title = current?.title || entry?.label || 'VIPs Admin';
  document.getElementById('page-title').textContent = title;
  document.getElementById('page-subtitle').textContent =
    current?.subtitle || 'VIPs loyalty platform — administration';
  document.title = `${title} · VIPs Admin`;

  const crumbs = [
    ...(entry?.trail || []).map((t) => t.label),
  ];
  document.getElementById('breadcrumb').innerHTML =
    `<span class="main-path"><a href="#/">Home</a></span>`
    + crumbs.map((c) => `<i class="las la-angle-right"></i><span class="main-path">${esc(c)}</span>`).join('')
    + `<i class="las la-angle-right"></i><span class="active-path">${esc(title)}</span>`;

  buildSidebar(path);
}

router.onNavigate(updateChrome);

// ── attention badge ──────────────────────────────────────────
// /notifications is the backend's list of things waiting on a human:
// registrations to approve, refund requests, stock at zero.

let alertsTimer = null;

async function refreshAlerts() {
  if (!auth.isSignedIn() || !auth.can('dashboard.read')) return;
  try {
    const data = await api.get('/notifications');
    const dot = document.getElementById('alerts-dot');
    dot.hidden = !(data.urgent > 0 || data.total > 0);
    dot.classList.toggle('is-urgent', data.urgent > 0);
    dot.dataset.count = String(data.total || 0);
  } catch {
    // A background poll must never interrupt what the operator is doing.
  }
}

async function showAlerts() {
  const { default: panel } = await import('./screens/alerts.js');
  await panel.open();
  refreshAlerts();
}

// ── sign-in ──────────────────────────────────────────────────

function showLogin(message) {
  document.getElementById('app-shell').hidden = true;
  const login = document.getElementById('login-screen');
  login.hidden = false;
  const error = document.getElementById('login-error');
  if (message) { error.textContent = message; error.hidden = false; } else { error.hidden = true; }
  login.querySelector('input[name=email]')?.focus();
  if (alertsTimer) { clearInterval(alertsTimer); alertsTimer = null; }
}

function showConsole() {
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app-shell').hidden = false;

  const { user, adminRole } = auth.current();
  document.getElementById('nav-username').textContent = user?.fullName || user?.email || 'Admin';
  document.getElementById('nav-userrole').textContent =
    (adminRole || 'admin').replace(/_/g, ' ');
  document.getElementById('nav-avatar').textContent = initials(user?.fullName || user?.email);

  buildSidebar(router.activePath());
  refreshAlerts();
  if (!alertsTimer) alertsTimer = setInterval(refreshAlerts, 60000);
}

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.getElementById('login-submit');
  const error = document.getElementById('login-error');

  button.disabled = true;
  button.classList.add('is-busy');
  error.hidden = true;
  try {
    await auth.signIn(form.email.value.trim(), form.password.value);
    form.reset();
    showConsole();
    router.refresh();
    toast(`Signed in as ${auth.current().user?.fullName || 'admin'}.`);
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.classList.remove('is-busy');
  }
});

document.getElementById('signout-btn').addEventListener('click', async () => {
  await auth.signOut();
  showLogin();
});

document.getElementById('alerts-btn').addEventListener('click', () => showAlerts().catch(toastError));
document.getElementById('global-search-btn').addEventListener('click', () => router.go('/search'));

// '/' focuses search from anywhere that is not already a text field.
document.addEventListener('keydown', (event) => {
  if (event.key !== '/' || !auth.isSignedIn()) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  event.preventDefault();
  router.go('/search');
});

// A token that stops being valid mid-session drops straight back to sign-in.
auth.onChange((session) => {
  if (!session.user && !document.getElementById('app-shell').hidden) {
    showLogin('Your session ended. Sign in again.');
  }
});

// ── go ───────────────────────────────────────────────────────

(async function boot() {
  router.start();

  if (!api.token.get()) {
    showLogin();
    return;
  }

  try {
    await auth.refresh();
    showConsole();
    router.refresh();
  } catch (error) {
    // An expired or revoked token: not worth an error, just sign in again.
    api.token.clear();
    showLogin(error.status === 401 ? '' : error.message);
  }

  fetch('/api/health')
    .then((r) => r.json())
    .then((health) => {
      const el = document.getElementById('footer-build');
      if (health?.version || health?.commit) {
        el.textContent = `build ${health.version || String(health.commit).slice(0, 7)}`;
      }
    })
    .catch(() => {});
})();
