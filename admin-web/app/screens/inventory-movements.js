/**
 * The stock ledger: every unit that moved, and who moved it.
 *
 * `quantity` is always a magnitude — direction lives in `type` — so an
 * "in" of 5 and an "out" of 5 both read as 5 here, coloured by what they did.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';

const { html } = ui;

const TYPES = ['initial', 'in', 'out', 'adjustment', 'transfer_in', 'transfer_out', 'removed'];

const TYPE_TONE = {
  initial: 'info',
  in: 'success',
  transfer_in: 'success',
  out: 'danger',
  transfer_out: 'warning',
  removed: 'danger',
  adjustment: 'warning',
};

const SIGN = { in: '+', transfer_in: '+', initial: '+', out: '−', transfer_out: '−', removed: '−' };

export default {
  title: 'Stock movements',
  subtitle: 'Every change to every stock line',
  permission: 'inventory.read',

  async render(host, ctx) {
    const query = {
      search: ctx.query.search || '',
      type: ctx.query.type || '',
      stockId: ctx.query.stockId || '',
      from: ctx.query.from || '',
      to: ctx.query.to || '',
      page: ctx.query.page || '1',
    };

    const summary = ui.node(html`<div></div>`);
    host.append(summary);

    const panel = ui.node(ui.card({
      title: 'Movements',
      subtitle: query.stockId ? 'Filtered to one stock line.' : 'Most recent first.',
      body: html`${''}`,
    }));
    host.append(panel);

    const cardBody = panel.querySelector('.card-body');
    const body = ui.node(html`<div></div>`);

    cardBody.append(ui.filterBar({
      values: query,
      onChange: (values) => ctx.setQuery({ ...values, stockId: query.stockId, page: 1 }),
      fields: [
        { name: 'search', type: 'search', label: 'Find', placeholder: 'Item or reason' },
        { name: 'type', type: 'select', label: 'Type', options: [{ value: '', label: 'Any' }, ...TYPES] },
        { name: 'from', type: 'date', label: 'From' },
        { name: 'to', type: 'date', label: 'To' },
      ],
      actions: query.stockId
        ? ui.button({ label: 'Clear line filter', tone: 'secondary', size: 'sm', action: 'clear-stock' })
        : '',
    }), body);

    async function load() {
      ui.render(body, ui.loadingState('Loading movements…'));
      let data;
      try {
        data = await api.get('/inventory/movements', query);
      } catch (error) {
        ui.render(body, ui.errorState(error, load));
        return;
      }

      const byType = data.byType || {};
      const tiles = TYPES
        .filter((t) => byType[t])
        .map((t) => ui.statCard({
          label: fmt.humanise(t),
          value: fmt.number(byType[t].units),
          hint: `${fmt.number(byType[t].count)} movement${byType[t].count === 1 ? '' : 's'}`,
          icon: 'las la-dolly',
          tone: TYPE_TONE[t] === 'danger' ? 'danger' : (TYPE_TONE[t] === 'success' ? 'success' : 'info'),
        }));
      ui.render(summary, tiles.length ? ui.statGrid(tiles) : '');

      ui.render(body, ui.table({
        columns: [
          {
            key: 'name',
            label: 'Item',
            cell: (m) => ui.identity({ title: m.name, subtitle: `${m.category || 'General'} · ${m.location || 'Main'}` }),
          },
          { key: 'merchantName', label: 'Merchant', cell: (m) => m.merchantName || '—' },
          { key: 'type', label: 'Type', cell: (m) => ui.badge(fmt.humanise(m.type), TYPE_TONE[m.type] || 'info') },
          {
            key: 'quantity',
            label: 'Units',
            align: 'end',
            cell: (m) => html`<span class="figure">${SIGN[m.type] || ''}${fmt.number(m.quantity)}</span>`,
          },
          {
            key: 'balanceAfter',
            label: 'Balance',
            align: 'end',
            cell: (m) => html`${fmt.number(m.balanceAfter)}
              <span class="cell-sub">was ${fmt.number(m.balanceBefore)}</span>`,
          },
          { key: 'reason', label: 'Reason', cell: (m) => m.reason || '—' },
          {
            key: 'performedByName',
            label: 'By',
            cell: (m) => html`${m.performedByName || 'System'}
              ${m.performedByRole ? html`<span class="cell-sub">${fmt.humanise(m.performedByRole)}</span>` : ''}`,
          },
          { key: 'createdAt', label: 'When', cell: (m) => fmt.ago(m.createdAt) },
        ],
        rows: data.items,
        empty: 'No movement matches those filters.',
      }));

      const pager = ui.pagination(data, (page) => ctx.setQuery({ ...query, page }));
      if (pager) body.append(pager);
    }

    ui.actions(host, {
      'clear-stock': () => ctx.setQuery({ ...query, stockId: '' }),
    });

    await load();
    return undefined;
  },
};
