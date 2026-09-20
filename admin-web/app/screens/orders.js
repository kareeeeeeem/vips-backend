/**
 * Every order that has gone through the platform.
 *
 * "Delete" is deliberately absent: the backend's DELETE cancels rather than
 * destroys, because an order is a financial record and removing one would
 * silently rewrite past revenue. The control says Cancel, which is what it
 * actually does.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';
import { go } from '../core/router.js';

const { html } = ui;

const STATUSES = [
  'pending', 'confirmed', 'processing', 'ready',
  'handover', 'picked_up', 'delivered',
  'cancelled', 'refund_requested', 'refunded',
];

export default {
  title: 'Orders',
  subtitle: 'Everything bought through VIPs',
  permission: 'orders.read',

  async render(host, ctx) {
    const query = {
      search: ctx.query.search || '',
      status: ctx.query.status || '',
      paymentStatus: ctx.query.paymentStatus || '',
      orderType: ctx.query.orderType || '',
      from: ctx.query.from || '',
      to: ctx.query.to || '',
      page: ctx.query.page || '1',
    };

    const summary = ui.node(html`<div></div>`);
    host.append(summary);

    const panel = ui.node(ui.card({ title: 'Orders', body: html`${''}` }));
    host.append(panel);

    const cardBody = panel.querySelector('.card-body');
    const body = ui.node(html`<div></div>`);

    cardBody.append(ui.filterBar({
      values: query,
      onChange: (values) => ctx.setQuery({ ...values, page: 1 }),
      fields: [
        { name: 'search', type: 'search', label: 'Find', placeholder: 'Order number, customer or item' },
        {
          name: 'status',
          type: 'select',
          label: 'Status',
          options: [{ value: '', label: 'Any status' }, ...STATUSES],
        },
        {
          name: 'paymentStatus',
          type: 'select',
          label: 'Payment',
          options: [{ value: '', label: 'Any' }, 'pending', 'paid', 'failed', 'refunded'],
        },
        {
          name: 'orderType',
          type: 'select',
          label: 'Type',
          options: [{ value: '', label: 'Any' }, 'delivery', 'takeaway', 'dine_in'],
        },
        { name: 'from', type: 'date', label: 'From' },
        { name: 'to', type: 'date', label: 'To' },
      ],
    }), body);

    async function load() {
      ui.render(body, ui.loadingState('Loading orders…'));
      let data;
      try {
        data = await api.get('/orders', query);
      } catch (error) {
        ui.render(body, ui.errorState(error, load));
        return;
      }

      // The status breakdown is what an operator scans first: it says where
      // the queue is stuck without reading a single row.
      const counts = data.statusCounts || {};
      const interesting = ['pending', 'confirmed', 'processing', 'ready', 'handover']
        .map((key) => ({ key, count: counts[key] || 0 }))
        .filter((s) => s.count > 0);

      ui.render(summary, interesting.length
        ? html`<div class="filter-bar" style="margin-bottom:18px">
            <div class="filter-fields" style="gap:8px">
              ${interesting.map((s) => html`
                <button type="button" class="btn btn--secondary btn-sm" data-action="filter-status" data-status="${s.key}">
                  ${fmt.humanise(s.key)} · ${fmt.number(s.count)}
                </button>`)}
            </div>
          </div>`
        : '');

      ui.render(body, ui.table({
        columns: [
          {
            key: 'orderNumber',
            label: 'Order',
            cell: (o) => ui.identity({
              title: o.orderNumber || fmt.shortId(o._id),
              subtitle: o.customerName || 'Unknown customer',
              initials: '#',
            }),
          },
          { key: 'merchantName', label: 'Merchant', cell: (o) => o.merchantName || '—' },
          { key: 'orderType', label: 'Type', cell: (o) => fmt.humanise(o.orderType) },
          { key: 'totalAmount', label: 'Total', align: 'end', cell: (o) => ui.money(o.totalAmount) },
          {
            key: 'paymentStatus',
            label: 'Payment',
            cell: (o) => html`${ui.statusBadge(o.paymentStatus)}
              <span class="cell-sub">${fmt.humanise(o.paymentMethod)}</span>`,
          },
          { key: 'status', label: 'Status', cell: (o) => ui.statusBadge(o.status) },
          { key: 'createdAt', label: 'Placed', cell: (o) => fmt.ago(o.createdAt) },
          {
            key: 'actions',
            label: '',
            align: 'end',
            cell: (o) => html`
              ${ui.rowAction({ icon: 'las la-eye', title: 'Open', action: 'open', id: o._id })}
              ${auth.can('orders.update')
    ? ui.rowAction({ icon: 'las la-exchange-alt', title: 'Change status', action: 'status', id: o._id })
    : ''}
              ${auth.can('orders.cancel') && !['delivered', 'picked_up', 'canceled', 'cancelled', 'refunded'].includes(o.status)
    ? ui.rowAction({ icon: 'las la-ban', title: 'Cancel order', action: 'cancel', id: o._id, tone: 'danger' })
    : ''}`,
          },
        ],
        rows: data.items,
        empty: 'No order matches those filters.',
        rowAttrs: (o) => `data-href="/orders/${o._id}" data-status="${o.status}"`,
      }));

      const pager = ui.pagination(data, (page) => ctx.setQuery({ ...query, page }));
      if (pager) body.append(pager);
    }

    ui.actions(host, {
      open: ({ id }) => go(`/orders/${id}`),
      'filter-status': ({ status }) => ctx.setQuery({ ...query, status, page: 1 }),

      status: async ({ id }) => {
        const current = body.querySelector(`tr[data-href$="/${id}"]`)?.dataset.status || 'pending';
        const saved = await ui.modal({
          title: 'Change order status',
          submitLabel: 'Update status',
          body: html`
            ${ui.note('The matching timestamp is stamped too, so the timeline the customer and the '
              + 'merchant both see stays consistent with this change.')}
            ${ui.selectField({ name: 'status', label: 'New status', options: STATUSES, value: current, required: true })}
            ${ui.textareaField({ name: 'note', label: 'Note', placeholder: 'Why the status changed' })}`,
          onSubmit: async (values) => {
            const response = await api.put(`/orders/${id}/status`, values);
            ui.toast(response.message || 'Order updated.');
            return true;
          },
        });
        if (saved) load();
      },

      /**
       * The backend's DELETE cancels rather than destroys — an order is a
       * financial record and wiping one would rewrite past revenue. The
       * control says what actually happens.
       */
      cancel: async ({ id }) => {
        const cancelled = await ui.modal({
          title: 'Cancel this order?',
          submitLabel: 'Cancel order',
          submitTone: 'danger',
          body: html`
            <p class="confirm-message">The order moves to cancelled. It is kept, not deleted —
            deleting it would silently change past revenue figures.</p>
            ${ui.textareaField({
    name: 'reason',
    label: 'Reason',
    placeholder: 'Shown on the order timeline',
  })}`,
          onSubmit: async (values) => {
            const response = await api.del(`/orders/${id}`, { reason: values.reason });
            ui.toast(response.message || 'Order cancelled.', 'warning');
            return true;
          },
        });
        if (cancelled) load();
      },
    });

    body.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-href]');
      if (row && !event.target.closest('button, a')) go(row.dataset.href);
    });

    await load();
    return undefined;
  },
};
