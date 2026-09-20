/**
 * Counter receipts.
 *
 * A receipt is refunded, never deleted — it is a financial record, and the
 * refund is what the session's cash reconciliation is measured against.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';

const { html } = ui;

export default {
  title: 'Receipts',
  subtitle: 'Sales taken at the till',
  permission: 'pos.read',

  async render(host, ctx) {
    const query = {
      search: ctx.query.search || '',
      status: ctx.query.status || '',
      page: ctx.query.page || '1',
    };

    const summary = ui.node(html`<div></div>`);
    host.append(summary);

    const panel = ui.node(ui.card({ title: 'Receipts', body: html`${''}` }));
    host.append(panel);

    const cardBody = panel.querySelector('.card-body');
    const body = ui.node(html`<div></div>`);

    cardBody.append(ui.filterBar({
      values: query,
      onChange: (values) => ctx.setQuery({ ...values, page: 1 }),
      fields: [
        { name: 'search', type: 'search', label: 'Find', placeholder: 'Receipt number or customer' },
        {
          name: 'status',
          type: 'select',
          label: 'Status',
          options: [{ value: '', label: 'All' }, { value: 'completed', label: 'Completed' }, { value: 'refunded', label: 'Refunded' }],
        },
      ],
    }), body);

    async function load() {
      ui.render(body, ui.loadingState('Loading receipts…'));
      let data;
      try {
        data = await api.get('/pos/invoices', query);
      } catch (error) {
        ui.render(body, ui.errorState(error, load));
        return;
      }

      ui.render(summary, ui.statGrid([
        ui.statCard({
          label: 'Till sales',
          value: fmt.tnd(data.totals?.sales ?? 0),
          hint: `${fmt.number(data.total)} receipt(s)`,
          icon: 'las la-cash-register',
          tone: 'success',
        }),
        ui.statCard({
          label: 'Refunded',
          value: fmt.tnd(data.totals?.refunded ?? 0),
          hint: 'Taken back out of the drawer',
          icon: 'las la-undo',
          tone: data.totals?.refunded ? 'warning' : 'base',
        }),
      ]));

      ui.render(body, ui.table({
        columns: [
          {
            key: 'invoiceNumber',
            label: 'Receipt',
            cell: (i) => ui.identity({
              title: i.invoiceNumber || fmt.shortId(i._id),
              subtitle: fmt.dateTime(i.createdAt),
              initials: '#',
            }),
          },
          {
            key: 'customerName',
            label: 'Customer',
            cell: (i) => (i.customerName
              ? html`${i.customerName}${i.customerPhone ? html`<span class="cell-sub">${i.customerPhone}</span>` : ''}`
              : 'Walk-in'),
          },
          {
            key: 'items',
            label: 'Items',
            align: 'end',
            cell: (i) => fmt.number((i.items || []).reduce((sum, l) => sum + (l.quantity || 0), 0)),
          },
          { key: 'discount', label: 'Discount', align: 'end', cell: (i) => (i.discount ? ui.money(i.discount) : '—') },
          { key: 'total', label: 'Total', align: 'end', cell: (i) => ui.money(i.total) },
          { key: 'paymentMethod', label: 'Paid by', cell: (i) => fmt.humanise(i.paymentMethod) },
          { key: 'status', label: 'Status', cell: (i) => ui.statusBadge(i.status || 'completed') },
          {
            key: 'actions',
            label: '',
            align: 'end',
            cell: (i) => html`
              ${ui.rowAction({ icon: 'las la-eye', title: 'Open receipt', action: 'open', id: i._id })}
              ${auth.can('pos.refund') && i.status !== 'refunded'
    ? ui.rowAction({ icon: 'las la-undo', title: 'Refund', action: 'refund', id: i._id, tone: 'danger' })
    : ''}`,
          },
        ],
        rows: data.items,
        empty: 'No receipt matches those filters.',
        rowAttrs: (i) => `data-id="${i._id}" data-total="${i.total}"`,
      }));

      const pager = ui.pagination(data, (page) => ctx.setQuery({ ...query, page }));
      if (pager) body.append(pager);
    }

    ui.actions(host, {
      open: async ({ id }) => {
        const { invoice } = await api.get(`/pos/invoice/${id}`);
        const merchant = invoice.merchantId || {};
        await ui.modal({
          title: `Receipt ${invoice.invoiceNumber || fmt.shortId(invoice._id)}`,
          submitLabel: 'Close',
          size: 'lg',
          body: html`
            ${ui.details([
    ['Shop', merchant.storeName || merchant.fullName || '—'],
    ['Cashier', invoice.cashierId?.fullName || '—'],
    ['Customer', invoice.customerName || 'Walk-in'],
    invoice.customerPhone ? ['Phone', invoice.customerPhone] : null,
    ['Taken', fmt.dateTime(invoice.createdAt)],
    ['Paid by', fmt.humanise(invoice.paymentMethod)],
    ['Status', ui.statusBadge(invoice.status || 'completed')],
  ])}
            ${ui.sectionTitle('Lines')}
            ${ui.table({
    columns: [
      { key: 'name', label: 'Item', cell: (l) => l.name },
      { key: 'quantity', label: 'Qty', align: 'end', cell: (l) => fmt.number(l.quantity) },
      { key: 'unitPrice', label: 'Unit', align: 'end', cell: (l) => ui.money(l.unitPrice) },
      {
        key: 'line',
        label: 'Line',
        align: 'end',
        cell: (l) => ui.money((l.unitPrice || 0) * (l.quantity || 0)),
      },
    ],
    rows: invoice.items || [],
    empty: 'This receipt has no lines.',
  })}
            ${ui.sectionTitle('Money')}
            ${ui.details([
    ['Subtotal', ui.money(invoice.subtotal)],
    invoice.discount ? ['Discount', html`−${ui.money(invoice.discount)}`] : null,
    invoice.tax ? ['Tax', ui.money(invoice.tax)] : null,
    ['Total', html`<strong>${fmt.tnd(invoice.total)}</strong>`],
  ])}`,
          onSubmit: () => true,
        });
      },

      refund: async ({ id }) => {
        const total = body.querySelector(`tr[data-id="${id}"]`)?.dataset.total;
        const ok = await ui.confirm({
          title: 'Refund this receipt?',
          message: `${fmt.tnd(Number(total || 0))} will be recorded as refunded against the till session.`,
          detail: 'The receipt itself is kept — it is a financial record. Refunding is what the '
            + 'session\'s cash reconciliation is measured against.',
          submitLabel: 'Refund',
        });
        if (!ok) return;
        const response = await api.post('/pos/invoice/refund', { invoiceId: id });
        ui.toast(response.message || 'Receipt refunded.', 'warning');
        load();
      },
    });

    await load();
    return undefined;
  },
};
