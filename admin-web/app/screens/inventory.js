/**
 * Stock across every merchant.
 *
 * A change made here writes to the same ledger the merchant app writes to,
 * so the movement history stays one continuous record regardless of who
 * made the change or from where.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';
import { go } from '../core/router.js';

const { html } = ui;

export default {
  title: 'Stock',
  subtitle: 'Every stock line on the platform',
  permission: 'inventory.read',

  async render(host, ctx) {
    const query = {
      search: ctx.query.search || '',
      location: ctx.query.location || '',
      lowStock: ctx.query.lowStock || '',
      page: ctx.query.page || '1',
    };

    const locations = await api.get('/inventory/locations').catch(() => ({ items: [] }));

    const summary = ui.node(html`<div></div>`);
    host.append(summary);

    const panel = ui.node(ui.card({ title: 'Stock lines', body: html`${''}` }));
    host.append(panel);

    const cardBody = panel.querySelector('.card-body');
    const body = ui.node(html`<div></div>`);

    cardBody.append(ui.filterBar({
      values: query,
      onChange: (values) => ctx.setQuery({ ...values, page: 1 }),
      fields: [
        { name: 'search', type: 'search', label: 'Find', placeholder: 'Item, category or location' },
        {
          name: 'location',
          type: 'select',
          label: 'Location',
          options: [
            { value: '', label: 'Everywhere' },
            ...(locations.items || []).map((l) => ({
              value: l.location ?? l.name ?? l,
              label: `${l.location ?? l.name ?? l}${l.items ? ` (${l.items})` : ''}`,
            })),
          ],
        },
        {
          name: 'lowStock',
          type: 'select',
          label: 'Level',
          options: [{ value: '', label: 'All levels' }, { value: 'true', label: 'At or below threshold' }],
        },
      ],
      actions: auth.can('inventory.create')
        ? ui.button({ label: 'Open a stock line', icon: 'las la-plus', action: 'create' })
        : '',
    }), body);

    async function load() {
      ui.render(body, ui.loadingState('Loading stock…'));
      let data;
      try {
        data = await api.get('/inventory', query);
      } catch (error) {
        ui.render(body, ui.errorState(error, load));
        return;
      }

      ui.render(summary, ui.statGrid([
        ui.statCard({
          label: 'Stock value',
          value: fmt.tnd(data.totalValue),
          hint: 'Units on hand at their unit price',
          icon: 'las la-warehouse',
          tone: 'navy',
        }),
        ui.statCard({
          label: 'Units on hand',
          value: fmt.number(data.totalUnits),
          hint: `Across ${fmt.number(data.total)} stock lines`,
          icon: 'las la-boxes',
          tone: 'info',
        }),
      ]));

      ui.render(body, ui.table({
        columns: [
          {
            key: 'name',
            label: 'Item',
            cell: (i) => ui.identity({ title: i.name, subtitle: `${i.category} · ${i.location}` }),
          },
          { key: 'merchantName', label: 'Merchant', cell: (i) => i.merchantName || '—' },
          {
            key: 'currentStock',
            label: 'On hand',
            align: 'end',
            cell: (i) => html`
              <span class="figure ${i.isLowStock ? 'text--danger' : ''}">${fmt.number(i.currentStock)}</span>
              <span class="cell-sub">threshold ${fmt.number(i.lowStockThreshold)}</span>`,
          },
          { key: 'unitPrice', label: 'Unit price', align: 'end', cell: (i) => ui.money(i.unitPrice) },
          {
            key: 'value',
            label: 'Value',
            align: 'end',
            cell: (i) => ui.money((i.currentStock || 0) * (i.unitPrice || 0)),
          },
          {
            key: 'isLowStock',
            label: 'Level',
            cell: (i) => (i.isLowStock ? ui.badge('Low', 'danger') : ui.badge('Healthy', 'success')),
          },
          {
            key: 'actions',
            label: '',
            align: 'end',
            cell: (i) => html`
              ${auth.canAny('inventory.update', 'inventory.adjust')
    ? ui.rowAction({ icon: 'las la-pen', title: 'Adjust', action: 'edit', id: i._id })
    : ''}
              ${auth.can('inventory.transfer')
    ? ui.rowAction({ icon: 'las la-exchange-alt', title: 'Transfer', action: 'transfer', id: i._id })
    : ''}
              ${ui.rowAction({ icon: 'las la-history', title: 'Movements', action: 'history', id: i._id })}
              ${auth.can('inventory.delete')
    ? ui.rowAction({ icon: 'las la-trash', title: 'Remove line', action: 'delete', id: i._id, tone: 'danger' })
    : ''}`,
          },
        ],
        rows: data.items,
        empty: 'No stock line matches those filters.',
        rowAttrs: (i) => `data-id="${i._id}" data-name="${ui.esc(i.name)}" `
          + `data-stock="${i.currentStock}" data-threshold="${i.lowStockThreshold}" `
          + `data-price="${i.unitPrice}" data-location="${ui.esc(i.location)}"`,
      }));

      const pager = ui.pagination(data, (page) => ctx.setQuery({ ...query, page }));
      if (pager) body.append(pager);
    }

    const rowData = (id) => body.querySelector(`tr[data-id="${id}"]`)?.dataset || {};

    ui.actions(host, {
      history: ({ id }) => go('/inventory/movements', { stockId: id }),

      create: async () => {
        const created = await ui.modal({
          title: 'Open a stock line',
          submitLabel: 'Open line',
          body: html`
            ${ui.note('The opening balance is written to the ledger as an "initial" movement, so the '
              + 'line has a history from the moment it exists.')}
            ${ui.field({
    name: 'merchantId',
    label: 'Merchant id',
    required: true,
    hint: 'Copy this from the merchant\'s own screen.',
  })}
            ${ui.field({ name: 'name', label: 'Item name', required: true })}
            ${ui.fieldRow(
    ui.field({ name: 'category', label: 'Category', value: 'General' }),
    ui.field({ name: 'location', label: 'Location', value: 'Main' }),
  )}
            ${ui.fieldRow(
    ui.field({ name: 'currentStock', label: 'Opening balance', type: 'number', value: '0', attrs: 'min="0"' }),
    ui.field({ name: 'lowStockThreshold', label: 'Low-stock threshold', type: 'number', value: '10', attrs: 'min="0"' }),
  )}
            ${ui.field({ name: 'unitPrice', label: 'Unit price (TND)', type: 'number', value: '0', attrs: 'min="0" step="0.001"' })}`,
          onSubmit: async (values) => {
            const response = await api.post('/inventory', {
              ...values,
              currentStock: Number(values.currentStock),
              lowStockThreshold: Number(values.lowStockThreshold),
              unitPrice: Number(values.unitPrice),
            });
            ui.toast(response.message || 'Stock line opened.');
            return true;
          },
        });
        if (created) load();
      },

      edit: async ({ id }) => {
        const row = rowData(id);
        const saved = await ui.modal({
          title: `Adjust ${row.name || 'stock line'}`,
          submitLabel: 'Save adjustment',
          body: html`
            ${ui.note('Setting a new on-hand figure records an adjustment in the ledger against your '
              + 'name, with the reason you give here.')}
            ${ui.fieldRow(
    ui.field({ name: 'currentStock', label: 'On hand', type: 'number', value: row.stock || '0', attrs: 'min="0"' }),
    ui.field({ name: 'lowStockThreshold', label: 'Threshold', type: 'number', value: row.threshold || '0', attrs: 'min="0"' }),
  )}
            ${ui.field({ name: 'unitPrice', label: 'Unit price (TND)', type: 'number', value: row.price || '0', attrs: 'min="0" step="0.001"' })}
            ${ui.textareaField({ name: 'reason', label: 'Reason', placeholder: 'Stock count, damage, correction…' })}`,
          onSubmit: async (values) => {
            const response = await api.put(`/inventory/${id}`, {
              currentStock: Number(values.currentStock),
              lowStockThreshold: Number(values.lowStockThreshold),
              unitPrice: Number(values.unitPrice),
              reason: values.reason,
            });
            ui.toast(response.message || 'Stock line updated.');
            return true;
          },
        });
        if (saved) load();
      },

      transfer: async ({ id }) => {
        const row = rowData(id);
        const done = await ui.modal({
          title: `Transfer ${row.name || 'stock'}`,
          submitLabel: 'Move stock',
          body: html`
            ${ui.note(`Moving out of ${row.location || 'this line'}. Both halves of the movement are `
              + 'written under one reference, so the two sides can always be matched up.')}
            ${ui.field({
    name: 'quantity',
    label: 'Units to move',
    type: 'number',
    required: true,
    attrs: `min="1" max="${row.stock || 0}"`,
    hint: `${fmt.number(Number(row.stock || 0))} on hand.`,
  })}
            ${ui.field({
    name: 'toLocation',
    label: 'Destination location',
    required: true,
    hint: 'The sibling line for this item at that location is found, or opened if it does not exist.',
  })}
            ${ui.textareaField({ name: 'reason', label: 'Reason' })}`,
          onSubmit: async (values) => {
            const response = await api.post('/inventory/transfer', {
              fromStockId: id,
              quantity: Number(values.quantity),
              toLocation: values.toLocation,
              reason: values.reason,
            });
            ui.toast(response.message || 'Stock transferred.');
            return true;
          },
        });
        if (done) load();
      },

      delete: async ({ id }) => {
        const row = rowData(id);
        const ok = await ui.confirm({
          title: 'Remove this stock line?',
          message: `${row.name || 'This line'} will be removed.`,
          detail: 'A "removed" movement is written to the ledger first, so the history of what was '
            + 'held here survives the line itself.',
          submitLabel: 'Remove line',
        });
        if (!ok) return;
        const response = await api.del(`/inventory/${id}`);
        ui.toast(response.message || 'Stock line removed.', 'warning');
        load();
      },
    });

    await load();
    return undefined;
  },
};
