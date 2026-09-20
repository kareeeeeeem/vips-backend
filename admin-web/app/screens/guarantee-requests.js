/**
 * Bank transfers merchants say they have sent, waiting to be confirmed.
 *
 * Confirming is what mints the points, so it is the one action here that
 * moves money. The server refuses a second confirmation on the same request
 * — this screen states that plainly rather than letting an operator discover
 * it by double-clicking.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';
import * as config from '../core/config.js';
import { go } from '../core/router.js';

const { html } = ui;

export default {
  title: 'Guarantee refund requests',
  subtitle: 'Declared transfers awaiting confirmation',
  permission: 'merchants.read',

  async render(host, ctx) {
    const status = ctx.query.status || 'pending';
    const cfg = await config.load();

    host.append(ui.node(html`
      ${ui.note(`Confirming a transfer converts it to points at ${cfg.pointsPerTnd} to the dinar and `
        + 'credits the merchant immediately. Only confirm once the money is actually in the account — '
        + 'the credit cannot be taken back from this screen.', 'warning')}`));

    const panel = ui.node(ui.card({
      title: 'Declared transfers',
      subtitle: 'Merchants record these from the Merchant app after sending the money.',
      body: html`${''}`,
    }));
    host.append(panel);

    const cardBody = panel.querySelector('.card-body');
    const body = ui.node(html`<div></div>`);

    cardBody.append(ui.filterBar({
      values: { status },
      onChange: (values) => ctx.setQuery(values),
      fields: [{
        name: 'status',
        type: 'select',
        label: 'Status',
        options: [
          { value: 'pending', label: 'Waiting for review' },
          { value: 'confirmed', label: 'Confirmed' },
          { value: 'rejected', label: 'Turned down' },
          { value: 'all', label: 'Everything' },
        ],
      }],
    }), body);

    async function load() {
      ui.render(body, ui.loadingState('Loading requests…'));
      let data;
      try {
        data = await api.get('/guarantee-requests', { status });
      } catch (error) {
        ui.render(body, ui.errorState(error, load));
        return;
      }

      // Clear the spinner before appending: `render` replaces, `append` does
      // not, so building on top of the loading state would leave it showing
      // above the results forever.
      ui.render(body, '');

      if (data.pendingTotalTnd > 0) {
        body.append(ui.node(ui.note(
          `${fmt.tnd(data.pendingTotalTnd)} across the requests still waiting for review.`,
        )));
      }

      body.append(ui.node(ui.table({
        columns: [
          {
            key: 'merchantName',
            label: 'Merchant',
            cell: (r) => ui.identity({ title: r.merchantName, subtitle: r.bankName || 'Bank not given' }),
          },
          {
            key: 'amountTnd',
            label: 'Amount',
            align: 'end',
            cell: (r) => html`${ui.money(r.amountTnd)}
              <span class="cell-sub">${fmt.pointsBare(r.amountTnd * cfg.pointsPerTnd)} points</span>`,
          },
          { key: 'reference', label: 'Reference', cell: (r) => (r.reference ? html`<code>${r.reference}</code>` : '—') },
          { key: 'note', label: 'Merchant note', cell: (r) => r.note || '—' },
          { key: 'status', label: 'Status', cell: (r) => ui.statusBadge(r.status) },
          { key: 'requestedAt', label: 'Declared', cell: (r) => fmt.ago(r.requestedAt) },
          {
            key: 'actions',
            label: '',
            align: 'end',
            cell: (r) => (r.status === 'pending' && auth.can('merchants.update')
              ? html`
                ${ui.rowAction({ icon: 'las la-check', title: 'Confirm', action: 'confirm', id: r.id, tone: 'success' })}
                ${ui.rowAction({ icon: 'las la-times', title: 'Turn down', action: 'reject', id: r.id, tone: 'danger' })}`
              : (r.reviewedAt ? html`<span class="cell-sub">Reviewed ${fmt.ago(r.reviewedAt)}</span>` : '')),
          },
        ],
        rows: data.items,
        empty: status === 'pending'
          ? 'Nothing waiting — every declared transfer has been dealt with.'
          : 'No request in this state.',
        rowAttrs: (r) => (r.merchantId
          ? `data-merchant="/merchants/${r.merchantId}" data-name="${ui.esc(r.merchantName)}" data-amount="${r.amountTnd}"`
          : ''),
      })));
    }

    const rowFor = (id) => body.querySelector(`[data-action][data-id="${id}"]`)?.closest('tr');

    ui.actions(host, {
      confirm: async ({ id }) => {
        const row = rowFor(id);
        const name = row?.dataset.name || 'this merchant';
        const amount = Number(row?.dataset.amount || 0);

        const done = await ui.modal({
          title: 'Confirm this transfer?',
          submitLabel: 'Confirm and credit',
          submitTone: 'success',
          body: html`
            <p class="confirm-message">
              ${fmt.tnd(amount)} will be credited to ${name} as
              ${fmt.pointsBare(amount * cfg.pointsPerTnd)} guarantee points, available at once.
            </p>
            ${ui.note('Check the money has cleared first. This screen has no way to reverse a credit.', 'warning')}
            ${ui.textareaField({ name: 'note', label: 'Review note', placeholder: 'Where you verified the transfer' })}`,
          onSubmit: async (values) => {
            const response = await api.put(`/guarantee-requests/${id}`, {
              action: 'confirm',
              note: values.note,
            });
            ui.toast(response.message || 'Transfer confirmed.');
            return true;
          },
        });
        if (done) load();
      },

      reject: async ({ id }) => {
        const done = await ui.modal({
          title: 'Turn down this request?',
          submitLabel: 'Turn down',
          submitTone: 'danger',
          body: html`
            <p class="confirm-message">No points are credited. The merchant can declare the transfer again.</p>
            ${ui.textareaField({
    name: 'note',
    label: 'Why',
    required: true,
    placeholder: 'e.g. no matching transfer found against that reference',
  })}`,
          onSubmit: async (values) => {
            const response = await api.put(`/guarantee-requests/${id}`, {
              action: 'reject',
              note: values.note,
            });
            ui.toast(response.message || 'Request turned down.', 'warning');
            return true;
          },
        });
        if (done) load();
      },
    });

    body.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      const row = event.target.closest('tr[data-merchant]');
      if (row) go(row.dataset.merchant);
    });

    await load();
    return undefined;
  },
};
