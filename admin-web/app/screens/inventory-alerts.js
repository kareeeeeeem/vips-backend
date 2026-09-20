/**
 * What is about to run out.
 *
 * Two collections carry stock — Stock lines and Product records with their
 * own alert quantity — and either at zero is a real stockout, so both are
 * listed. A screen that read one of them would quietly miss half the problem.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import { go } from '../core/router.js';

const { html } = ui;

const level = (current, threshold) => {
  if (current <= 0) return ui.badge('Out of stock', 'danger');
  if (current <= threshold / 2) return ui.badge('Critical', 'danger');
  return ui.badge('Low', 'warning');
};

export default {
  title: 'Low stock',
  subtitle: 'Everything at or below its alert level',
  permission: 'inventory.read',

  async render(host) {
    const data = await api.get('/inventory/alerts', { limit: 200 });

    const outOfStock = [
      ...data.stock.filter((i) => i.currentStock <= 0),
      ...data.products.filter((p) => p.stock <= 0),
    ].length;

    host.append(ui.node(html`
      ${ui.statGrid([
    ui.statCard({
      label: 'Needing attention',
      value: fmt.number(data.total),
      hint: 'Stock lines and products combined',
      icon: 'las la-exclamation-triangle',
      tone: data.total ? 'warning' : 'success',
    }),
    ui.statCard({
      label: 'Already out',
      value: fmt.number(outOfStock),
      hint: outOfStock ? 'Cannot be sold right now' : 'Nothing is at zero',
      icon: 'las la-times-circle',
      tone: outOfStock ? 'danger' : 'success',
    }),
  ])}

      ${data.total === 0
    ? ui.card({
      title: 'Stock levels',
      body: ui.emptyState('Nothing is running low.', 'Every stock line and product is above its alert level.'),
    })
    : html`
      ${ui.card({
    title: 'Stock lines',
    subtitle: 'Lowest first.',
    body: ui.table({
      columns: [
        {
          key: 'name',
          label: 'Item',
          cell: (i) => ui.identity({ title: i.name, subtitle: i.category }),
        },
        { key: 'merchantName', label: 'Merchant', cell: (i) => i.merchantName || '—' },
        {
          key: 'currentStock',
          label: 'On hand',
          align: 'end',
          cell: (i) => html`<span class="figure">${fmt.number(i.currentStock)}</span>
            <span class="cell-sub">threshold ${fmt.number(i.lowStockThreshold)}</span>`,
        },
        { key: 'unitPrice', label: 'Unit price', align: 'end', cell: (i) => ui.money(i.unitPrice) },
        { key: 'level', label: 'Level', cell: (i) => level(i.currentStock, i.lowStockThreshold) },
        {
          key: 'actions',
          label: '',
          align: 'end',
          cell: (i) => ui.rowAction({ icon: 'las la-history', title: 'Movements', action: 'history', id: i._id }),
        },
      ],
      rows: data.stock,
      empty: 'No stock line is running low.',
    }),
  })}

      ${ui.card({
    title: 'Products',
    subtitle: 'Catalogue entries at or below their own alert quantity.',
    body: ui.table({
      columns: [
        { key: 'name', label: 'Product', cell: (p) => ui.identity({ title: p.name, subtitle: p.category }) },
        { key: 'merchantName', label: 'Merchant', cell: (p) => p.merchantName || '—' },
        {
          key: 'stock',
          label: 'On hand',
          align: 'end',
          cell: (p) => html`<span class="figure">${fmt.number(p.stock)}</span>
            <span class="cell-sub">alert at ${fmt.number(p.alertQty)}</span>`,
        },
        { key: 'level', label: 'Level', cell: (p) => level(p.stock, p.alertQty) },
      ],
      rows: data.products,
      empty: 'No product is running low.',
    }),
  })}`}`));

    ui.actions(host, {
      history: ({ id }) => go('/inventory/movements', { stockId: id }),
    });

    return undefined;
  },
};
