/**
 * Search across customers, merchants and orders in one place.
 *
 * Support questions arrive as "a customer called about order 1042" without
 * saying which of the three things the number belongs to, so all three are
 * searched at once rather than making the operator guess the right screen.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import { go } from '../core/router.js';

const { html } = ui;

export default {
  title: 'Search',
  subtitle: 'Customers, merchants and orders at once',
  permission: 'users.read',

  async render(host, ctx) {
    const term = ctx.query.q || '';

    const results = ui.node(html`<div></div>`);

    const bar = ui.filterBar({
      values: { q: term },
      onChange: (values) => ctx.setQuery(values),
      fields: [{
        name: 'q',
        type: 'search',
        label: 'Search the platform',
        placeholder: 'Name, email, phone, shop or order number',
      }],
    });

    host.append(bar, results);
    bar.querySelector('input[type=search]')?.focus();

    if (!term.trim()) {
      ui.render(results, ui.card({
        title: 'Search',
        body: ui.emptyState(
          'Type to search customers, merchants and orders.',
          'Press / from anywhere in the console to come back here.',
        ),
      }));
      return undefined;
    }

    ui.render(results, ui.loadingState(`Searching for “${term}”…`));

    let data;
    try {
      data = await api.get('/search', { q: term });
    } catch (error) {
      ui.render(results, ui.errorState(error, () => ctx.reload()));
      return undefined;
    }

    if (!data.total) {
      ui.render(results, ui.card({
        title: `Nothing found for “${term}”`,
        body: ui.emptyState(
          'No customer, merchant or order matches that.',
          'Names, emails, phone numbers and order numbers are all searched.',
        ),
      }));
      return undefined;
    }

    ui.render(results, html`
      ${ui.note(`${fmt.number(data.total)} match${data.total === 1 ? '' : 'es'} for “${term}”.`)}

      ${data.users?.length ? ui.card({
    title: `Customers (${fmt.number(data.users.length)})`,
    body: ui.table({
      columns: [
        { key: 'fullName', label: 'Customer', cell: (u) => ui.identity({ title: u.fullName, subtitle: u.email }) },
        { key: 'phone', label: 'Phone', cell: (u) => u.phone || '—' },
        { key: 'walletPoints', label: 'Points', align: 'end', cell: (u) => ui.pointsFigure(u.walletPoints) },
        { key: 'isActive', label: 'Status', cell: (u) => ui.statusBadge(u.isActive === false ? 'banned' : 'active') },
      ],
      rows: data.users,
      rowAttrs: (u) => `data-href="/customers/${u._id}"`,
    }),
  }) : ''}

      ${data.merchants?.length ? ui.card({
    title: `Merchants (${fmt.number(data.merchants.length)})`,
    body: ui.table({
      columns: [
        {
          key: 'storeName',
          label: 'Shop',
          cell: (m) => ui.identity({ title: m.storeName || m.fullName, subtitle: m.email }),
        },
        { key: 'phone', label: 'Phone', cell: (m) => m.phone || '—' },
        { key: 'storeCategory', label: 'Category', cell: (m) => fmt.humanise(m.storeCategory) },
        { key: 'isActive', label: 'Visibility', cell: (m) => (m.isActive ? ui.badge('Live', 'success') : ui.badge('Hidden', 'danger')) },
      ],
      rows: data.merchants,
      rowAttrs: (m) => `data-href="/merchants/${m._id}"`,
    }),
  }) : ''}

      ${data.orders?.length ? ui.card({
    title: `Orders (${fmt.number(data.orders.length)})`,
    body: ui.table({
      columns: [
        { key: 'orderNumber', label: 'Order', cell: (o) => (o.orderNumber ? `#${o.orderNumber}` : fmt.shortId(o._id)) },
        { key: 'totalAmount', label: 'Total', align: 'end', cell: (o) => ui.money(o.totalAmount) },
        { key: 'status', label: 'Status', cell: (o) => ui.statusBadge(o.status) },
        { key: 'createdAt', label: 'Placed', cell: (o) => fmt.ago(o.createdAt) },
      ],
      rows: data.orders,
      rowAttrs: (o) => `data-href="/orders/${o._id}"`,
    }),
  }) : ''}`);

    results.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-href]');
      if (row) go(row.dataset.href);
    });

    return undefined;
  },
};
