/**
 * The attention panel behind the bell.
 *
 * The backend decides what is waiting on a human and where each item leads;
 * this only draws it. That keeps "what counts as urgent" in one place rather
 * than duplicating the thresholds in the browser.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import { go } from '../core/router.js';

const { html } = ui;

const TONE = { danger: 'danger', warning: 'warning', info: 'info', muted: 'base' };

const ICON = {
  merchant_approvals: 'las la-gavel',
  low_stock: 'las la-boxes',
  pending_orders: 'las la-hourglass-half',
  pending_payouts: 'las la-hand-holding-usd',
  banned_users: 'las la-user-slash',
  guarantee_requests: 'las la-shield-alt',
};

/**
 * The backend names routes as its own API paths; the console's own paths
 * differ in a couple of places. Mapped here rather than renaming the API,
 * which the merchant and customer apps also read.
 */
const ROUTE_MAP = {
  '/users': '/customers',
};

export default {
  async open() {
    const data = await api.get('/notifications');
    const items = data.items || [];

    await ui.modal({
      title: 'Needs attention',
      submitLabel: 'Done',
      size: 'lg',
      body: items.length
        ? html`
          ${data.urgent
    ? ui.note(`${fmt.number(data.urgent)} of these are urgent.`, 'danger')
    : ui.note('Nothing here is urgent.')}
          <div class="alert-list">
            ${items.map((item) => html`
              <button type="button" class="alert-item alert-item--${TONE[item.severity] || 'info'}"
                      data-action="go" data-route="${item.route}"
                      data-args="${encodeURIComponent(JSON.stringify(item.args || {}))}">
                <span class="alert-icon"><i class="${ICON[item.key] || 'las la-bell'}"></i></span>
                <span class="alert-body">
                  <span class="alert-title">${item.title}</span>
                  <span class="alert-sub">Go to the screen that handles this</span>
                </span>
                <span class="alert-count">${fmt.number(item.count)}</span>
              </button>`)}
          </div>`
        : ui.emptyState('Nothing is waiting on anyone.', 'Approvals, stock and payouts are all clear.'),
      onSubmit: () => true,
    });
  },
};

// Clicking an item navigates and closes the dialog. Bound once, on the
// document, because the dialog's own DOM is replaced each time it opens.
document.addEventListener('click', (event) => {
  const button = event.target.closest('.alert-item[data-route]');
  if (!button) return;
  event.preventDefault();

  let args = {};
  try { args = JSON.parse(decodeURIComponent(button.dataset.args || '{}')); } catch { /* no filters */ }

  const route = ROUTE_MAP[button.dataset.route] || button.dataset.route;
  // Close whatever dialog we are inside before navigating.
  document.querySelector('.modal-panel [data-close]')?.click();
  go(route, Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])));
});
