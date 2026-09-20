/**
 * The catalogue across every merchant.
 *
 * "Selling price" is the discount price when one is set, otherwise the list
 * price — the same figure the till freezes onto a receipt line, so this
 * screen and a printed receipt cannot disagree.
 *
 * Products with no cost recorded are directly filterable: they are what
 * holds the profit report back, since margin cannot be computed without one.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';
import { go } from '../core/router.js';

const { html } = ui;

export default {
  title: 'Products',
  subtitle: 'Every product on the platform',
  permission: 'products.read',

  async render(host, ctx) {
    const query = {
      search: ctx.query.search || '',
      category: ctx.query.category || '',
      status: ctx.query.status || '',
      merchantId: ctx.query.merchantId || '',
      page: ctx.query.page || '1',
    };

    const panel = ui.node(ui.card({ title: 'Catalogue', body: html`${''}` }));
    host.append(panel);

    const cardBody = panel.querySelector('.card-body');
    const body = ui.node(html`<div></div>`);
    const filterHost = ui.node(html`<div></div>`);
    cardBody.append(filterHost, body);

    async function load() {
      ui.render(body, ui.loadingState('Loading products…'));
      let data;
      try {
        data = await api.get('/products', query);
      } catch (error) {
        ui.render(body, ui.errorState(error, load));
        return;
      }

      // Categories come back with the results, so the filter offers exactly
      // what exists rather than a guessed list.
      ui.render(filterHost, '');
      filterHost.append(ui.filterBar({
        values: query,
        onChange: (values) => ctx.setQuery({ ...values, merchantId: query.merchantId, page: 1 }),
        fields: [
          { name: 'search', type: 'search', label: 'Find', placeholder: 'Name, code or category' },
          {
            name: 'category',
            type: 'select',
            label: 'Category',
            options: [{ value: '', label: 'All categories' }, ...(data.categories || [])],
          },
          {
            name: 'status',
            type: 'select',
            label: 'Show',
            options: [
              { value: '', label: 'Everything' },
              { value: 'active', label: 'Listed' },
              { value: 'inactive', label: 'Unlisted' },
              { value: 'no_cost', label: 'Missing a cost price' },
            ],
          },
        ],
        actions: auth.can('products.create')
          ? ui.button({ label: 'Add product', icon: 'las la-plus', action: 'create' })
          : '',
      }));

      ui.render(body, ui.table({
        columns: [
          {
            key: 'name',
            label: 'Product',
            cell: (p) => ui.identity({
              title: p.name,
              subtitle: [p.code, p.category].filter(Boolean).join(' · ') || null,
            }),
          },
          { key: 'merchantName', label: 'Merchant', cell: (p) => p.merchantName || '—' },
          {
            key: 'sellingPrice',
            label: 'Sells at',
            align: 'end',
            cell: (p) => html`${ui.money(p.sellingPrice)}
              ${p.discountPrice > 0 && p.discountPrice !== p.price
    ? html`<span class="cell-sub">list ${fmt.tnd(p.price)}</span>` : ''}`,
          },
          {
            key: 'costPrice',
            label: 'Cost',
            align: 'end',
            cell: (p) => (p.hasCost
              ? ui.money(p.costPrice)
              : ui.badge('Not set', 'warning')),
          },
          {
            key: 'stock',
            label: 'Stock',
            align: 'end',
            cell: (p) => html`<span class="figure">${fmt.number(p.stock)}</span>
              <span class="cell-sub">alert at ${fmt.number(p.alertQty)}</span>`,
          },
          {
            key: 'isActive',
            label: 'Listing',
            cell: (p) => html`${p.isActive ? ui.badge('Listed', 'success') : ui.badge('Unlisted', 'danger')}
              ${p.isFeature ? ui.badge('Featured', 'info') : ''}`,
          },
          {
            key: 'actions',
            label: '',
            align: 'end',
            cell: (p) => html`
              ${auth.can('products.update')
    ? ui.rowAction({ icon: 'las la-pen', title: 'Edit', action: 'edit', id: p._id })
    : ''}
              ${auth.can('products.delete')
    ? ui.rowAction({ icon: 'las la-trash', title: 'Delete', action: 'delete', id: p._id, tone: 'danger' })
    : ''}`,
          },
        ],
        rows: data.items,
        empty: 'No product matches those filters.',
        rowAttrs: (p) => `data-id="${p._id}" data-name="${ui.esc(p.name)}"`,
      }));

      const pager = ui.pagination(data, (page) => ctx.setQuery({ ...query, page }));
      if (pager) body.append(pager);
    }

    const productForm = (p = {}) => html`
      ${ui.field({ name: 'name', label: 'Name', value: p.name || '', required: true })}
      ${ui.fieldRow(
    ui.field({ name: 'code', label: 'Code / SKU', value: p.code || '' }),
    ui.field({ name: 'category', label: 'Category', value: p.category || '', required: !p._id }),
  )}
      ${ui.fieldRow(
    ui.field({
      name: 'price',
      label: 'List price (TND)',
      type: 'number',
      value: p.price ?? '',
      required: true,
      attrs: 'min="0" step="0.001"',
    }),
    ui.field({
      name: 'discountPrice',
      label: 'Discount price (TND)',
      type: 'number',
      value: p.discountPrice ?? '',
      attrs: 'min="0" step="0.001"',
      hint: 'Leave blank for none. Cannot exceed the list price.',
    }),
  )}
      ${ui.fieldRow(
    ui.field({
      name: 'costPrice',
      label: 'Cost price (TND)',
      type: 'number',
      value: p.costPrice ?? '',
      attrs: 'min="0" step="0.001"',
      hint: 'Without this, the product contributes no margin to the profit report.',
    }),
    ui.field({ name: 'vat', label: 'VAT (%)', type: 'number', value: p.vat ?? 0, attrs: 'min="0" step="0.1"' }),
  )}
      ${ui.fieldRow(
    ui.field({ name: 'stock', label: 'Stock', type: 'number', value: p.stock ?? 0, attrs: 'min="0"' }),
    ui.field({ name: 'alertQty', label: 'Alert at', type: 'number', value: p.alertQty ?? 0, attrs: 'min="0"' }),
  )}
      ${ui.textareaField({ name: 'description', label: 'Description', value: p.description || '' })}`;

    const numeric = (values) => {
      const out = { ...values };
      for (const key of ['price', 'costPrice', 'stock', 'alertQty', 'vat']) {
        if (out[key] === '' || out[key] === undefined) delete out[key];
        else out[key] = Number(out[key]);
      }
      // An empty discount means "no discount", which the API spells as null.
      out.discountPrice = values.discountPrice === '' ? null : Number(values.discountPrice);
      return out;
    };

    ui.actions(host, {
      create: async () => {
        const created = await ui.modal({
          title: 'Add a product',
          submitLabel: 'Add product',
          size: 'lg',
          body: html`
            ${ui.field({
    name: 'merchantId',
    label: 'Merchant id',
    required: true,
    value: query.merchantId,
    hint: 'Copy this from the merchant\'s own screen.',
  })}
            ${productForm()}`,
          onSubmit: async (values) => {
            const response = await api.post('/products', numeric(values));
            ui.toast(response.message || 'Product added.');
            return true;
          },
        });
        if (created) load();
      },

      edit: async ({ id }) => {
        const { product } = await api.get(`/products/${id}`);
        const saved = await ui.modal({
          title: `Edit ${product.name}`,
          submitLabel: 'Save changes',
          size: 'lg',
          body: html`
            ${ui.note('A product cannot be moved to another shop — that would reassign its sales '
              + 'history along with it.')}
            ${productForm(product)}`,
          onSubmit: async (values) => {
            const response = await api.put(`/products/${id}`, numeric(values));
            ui.toast(response.message || 'Product updated.');
            return true;
          },
        });
        if (saved) load();
      },

      delete: async ({ id }) => {
        const name = body.querySelector(`tr[data-id="${id}"]`)?.dataset.name || 'this product';
        const ok = await ui.confirm({
          title: 'Delete this product?',
          message: `${name} will be removed from the catalogue.`,
          submitLabel: 'Delete product',
        });
        if (!ok) return;
        const response = await api.del(`/products/${id}`);
        ui.toast(response.message || 'Product deleted.', 'warning');
        load();
      },
    });

    await load();
    return undefined;
  },
};
