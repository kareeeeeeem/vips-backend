import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';

const { html } = ui;

export default {
  title: 'Offers',
  subtitle: 'Platform coupons and vouchers',
  permission: 'offers.read',

  async render(host, ctx) {
    const query = { search: ctx.query.search || '', type: ctx.query.type || '', status: ctx.query.status || '', page: ctx.query.page || '1' };
    const panel = ui.node(ui.card({ title: 'Offer catalogue', body: html`${''}` }));
    const body = panel.querySelector('.card-body');
    const table = ui.node(html`<div></div>`);
    host.append(panel);
    body.append(ui.filterBar({
      values: query,
      onChange: (values) => ctx.setQuery({ ...values, page: 1 }),
      fields: [
        { name: 'search', type: 'search', label: 'Find', placeholder: 'Code, description or tag' },
        { name: 'type', type: 'select', label: 'Type', options: [{ value: '', label: 'All types' }, 'percentage', 'fixed', 'voucher', 'shipping'] },
        { name: 'status', type: 'select', label: 'Status', options: [{ value: '', label: 'All states' }, 'active', 'inactive'] },
      ],
    }), table);

    async function load() {
      ui.render(table, ui.loadingState('Loading offers…'));
      try {
        const data = await api.get('/offers', query);
        ui.render(table, ui.table({
          columns: [
            { key: 'code', label: 'Offer', cell: (o) => ui.identity({ title: o.code, subtitle: o.description || fmt.humanise(o.type) }) },
            { key: 'merchantName', label: 'Merchant', cell: (o) => o.merchantName || 'Platform' },
            { key: 'discount', label: 'Value', align: 'end', cell: (o) => o.discountUnit === 'tnd' ? ui.money(o.discount) : `${fmt.number(o.discount)}%` },
            { key: 'usageCount', label: 'Use', align: 'end', cell: (o) => `${fmt.number(o.usageCount || o.usedCount || 0)}${o.maxUsage || o.maxUses ? ` / ${fmt.number(o.maxUsage || o.maxUses)}` : ''}` },
            { key: 'expiryDate', label: 'Expires', cell: (o) => fmt.date(o.expiryDate) },
            { key: 'isActive', label: 'State', cell: (o) => ui.badge(o.isActive ? 'Active' : 'Suspended', o.isActive ? 'success' : 'warning') },
            { key: 'actions', label: '', align: 'end', cell: (o) => html`
              ${auth.can('offers.update') ? ui.rowAction({ icon: o.isActive ? 'las la-pause' : 'las la-play', title: o.isActive ? 'Suspend' : 'Activate', action: 'toggle', id: o._id }) : ''}
              ${auth.can('offers.delete') ? ui.rowAction({ icon: 'las la-trash', title: 'Delete', action: 'delete', id: o._id, tone: 'danger' }) : ''}` },
          ], rows: data.items, empty: 'No offer matches those filters.', rowAttrs: (o) => `data-id="${o._id}" data-code="${ui.esc(o.code)}" data-active="${o.isActive}"`,
        }));
        const pager = ui.pagination(data, (page) => ctx.setQuery({ ...query, page }));
        if (pager) table.append(pager);
      } catch (error) { ui.render(table, ui.errorState(error, load)); }
    }

    ui.actions(host, {
      toggle: async ({ id }) => {
        const row = table.querySelector(`tr[data-id="${id}"]`);
        const isActive = row?.dataset.active === 'true';
        const ok = await ui.confirm({ title: `${isActive ? 'Suspend' : 'Activate'} this offer?`, message: `The offer ${row?.dataset.code || ''} will ${isActive ? 'stop' : 'start'} being available to customers.`, submitLabel: isActive ? 'Suspend offer' : 'Activate offer', tone: isActive ? 'danger' : 'base' });
        if (!ok) return;
        const response = await api.put(`/offers/${id}/status`, { isActive: !isActive });
        ui.toast(response.message || 'Offer updated.'); load();
      },
      delete: async ({ id }) => {
        const code = table.querySelector(`tr[data-id="${id}"]`)?.dataset.code || 'this offer';
        const ok = await ui.confirm({ title: 'Delete this offer?', message: `${code} will be removed if it has never been used.`, submitLabel: 'Delete offer' });
        if (!ok) return;
        const response = await api.del(`/offers/${id}`);
        ui.toast(response.message || 'Offer deleted.', 'warning'); load();
      },
    });
    await load();
  },
};
