/**
 * Till sessions, open and closed.
 *
 * The column that matters is the cash difference: what was counted at close
 * against what the session says should have been in the drawer. It is
 * coloured, because a session that came up short is the one worth opening.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';

const { html } = ui;

const difference = (s) => {
  if (s.status === 'open' || s.closingCount === null || s.closingCount === undefined) return null;
  return Number(s.cashDifference || 0);
};

export default {
  title: 'Till sessions',
  subtitle: 'Every shift, and how the drawer reconciled',
  permission: 'pos.read',

  async render(host, ctx) {
    const query = { status: ctx.query.status || '', page: ctx.query.page || '1' };

    const panel = ui.node(ui.card({ title: 'Sessions', body: html`${''}` }));
    host.append(panel);

    const cardBody = panel.querySelector('.card-body');
    const body = ui.node(html`<div></div>`);

    cardBody.append(ui.filterBar({
      values: query,
      onChange: (values) => ctx.setQuery({ ...values, page: 1 }),
      fields: [{
        name: 'status',
        type: 'select',
        label: 'Status',
        options: [{ value: '', label: 'All sessions' }, { value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }],
      }],
    }), body);

    async function load() {
      ui.render(body, ui.loadingState('Loading sessions…'));
      let data;
      try {
        data = await api.get('/pos/sessions', query);
      } catch (error) {
        ui.render(body, ui.errorState(error, load));
        return;
      }

      ui.render(body, ui.table({
        columns: [
          {
            key: '_id',
            label: 'Session',
            cell: (s) => ui.identity({
              title: fmt.shortId(s._id),
              subtitle: fmt.dateTime(s.createdAt),
              initials: '⌗',
            }),
          },
          { key: 'status', label: 'Status', cell: (s) => ui.statusBadge(s.status) },
          { key: 'openingFloat', label: 'Float', align: 'end', cell: (s) => ui.money(s.openingFloat) },
          {
            key: 'totalSales',
            label: 'Sales',
            align: 'end',
            cell: (s) => html`${ui.money(s.totalSales)}
              <span class="cell-sub">${fmt.number(s.invoiceCount)} receipt(s)</span>`,
          },
          {
            key: 'totalRefunds',
            label: 'Refunds',
            align: 'end',
            cell: (s) => html`${ui.money(s.totalRefunds)}
              <span class="cell-sub">${fmt.number(s.refundCount)} refund(s)</span>`,
          },
          {
            key: 'closingCount',
            label: 'Counted',
            align: 'end',
            cell: (s) => (s.status === 'open' ? '—' : ui.money(s.closingCount)),
          },
          {
            key: 'cashDifference',
            label: 'Difference',
            align: 'end',
            cell: (s) => {
              const diff = difference(s);
              if (diff === null) return ui.badge('Still open', 'info');
              if (Math.abs(diff) < 0.001) return ui.badge('Balanced', 'success');
              return ui.badge(
                `${diff > 0 ? 'Over' : 'Short'} ${fmt.tnd(Math.abs(diff))}`,
                diff > 0 ? 'warning' : 'danger',
              );
            },
          },
          { key: 'closedAt', label: 'Closed', cell: (s) => (s.closedAt ? fmt.ago(s.closedAt) : '—') },
        ],
        rows: data.items,
        empty: 'No till session has been opened yet.',
      }));

      const pager = ui.pagination(data, (page) => ctx.setQuery({ ...query, page }));
      if (pager) body.append(pager);
    }

    await load();
    return undefined;
  },
};
