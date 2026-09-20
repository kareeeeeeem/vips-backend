import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';

const { html } = ui;

export default {
  title: 'Wallets & points', subtitle: 'Balances and audited adjustments', permission: 'wallets.read',
  async render(host, ctx) {
    const query = { role: ctx.query.role || '', search: ctx.query.search || '', page: ctx.query.page || '1' };
    const stats = ui.node(html`<div></div>`); const panel = ui.node(ui.card({ title: 'Accounts', body: html`${''}` }));
    const body = panel.querySelector('.card-body'); const table = ui.node(html`<div></div>`); host.append(stats, panel);
    body.append(ui.filterBar({ values: query, onChange: (values) => ctx.setQuery({ ...values, page: 1 }), fields: [
      { name: 'search', type: 'search', label: 'Find', placeholder: 'Name, shop, email or phone' },
      { name: 'role', type: 'select', label: 'Account type', options: [{ value: '', label: 'Customers and merchants' }, 'customer', 'merchant'] },
    ] }), table);
    async function load() {
      ui.render(table, ui.loadingState('Loading wallets…'));
      try {
        const data = await api.get('/wallets', query);
        ui.render(stats, ui.statGrid([
          ui.statCard({ label: 'Wallet balance', value: fmt.tnd(data.totals?.walletBalance || 0), icon: 'las la-wallet', tone: 'success' }),
          ui.statCard({ label: 'Loyalty points', value: fmt.pointsBare(data.totals?.walletPoints || 0), icon: 'las la-star', tone: 'navy' }),
          ui.statCard({ label: 'Accounts', value: fmt.number(data.total || 0), icon: 'las la-users', tone: 'base' }),
        ]));
        ui.render(table, ui.table({ columns: [
          { key: 'name', label: 'Account', cell: (u) => ui.identity({ title: u.storeName || u.fullName, subtitle: [fmt.humanise(u.role), u.email || u.phone].filter(Boolean).join(' · ') }) },
          { key: 'walletBalance', label: 'Wallet', align: 'end', cell: (u) => ui.money(u.walletBalance || 0) },
          { key: 'walletPoints', label: 'Points', align: 'end', cell: (u) => ui.pointsFigure(u.walletPoints || 0) },
          { key: 'isActive', label: 'Account', cell: (u) => ui.badge(u.isActive ? 'Active' : 'Inactive', u.isActive ? 'success' : 'warning') },
          { key: 'actions', label: '', align: 'end', cell: (u) => html`${ui.rowAction({ icon: 'las la-history', title: 'Ledger', action: 'ledger', id: u._id })}${auth.can('wallets.adjust') ? ui.rowAction({ icon: 'las la-edit', title: 'Adjust balance', action: 'adjust', id: u._id }) : ''}` },
        ], rows: data.items, empty: 'No wallet matches those filters.', rowAttrs: (u) => `data-id="${u._id}" data-name="${ui.esc(u.storeName || u.fullName)}"` }));
        const pager = ui.pagination(data, (page) => ctx.setQuery({ ...query, page })); if (pager) table.append(pager);
      } catch (error) { ui.render(table, ui.errorState(error, load)); }
    }
    ui.actions(host, {
      ledger: async ({ id }) => { const data = await api.get(`/wallets/${id}/transactions`, { limit: 50 }); await ui.modal({ title: `Ledger — ${table.querySelector(`tr[data-id="${id}"]`)?.dataset.name || 'account'}`, submitLabel: 'Close', size: 'lg', body: html`${ui.table({ columns: [
        { key: 'createdAt', label: 'Date', cell: (t) => fmt.dateTime(t.createdAt) }, { key: 'description', label: 'Description', cell: (t) => t.description || '—' }, { key: 'amount', label: 'Amount', align: 'end', cell: (t) => ui.amountIn(t.amount, t.currency) }, { key: 'status', label: 'State', cell: (t) => ui.statusBadge(t.status) },
      ], rows: data.items, empty: 'No ledger entries yet.' })}`, onSubmit: () => true }); },
      adjust: async ({ id }) => { const name = table.querySelector(`tr[data-id="${id}"]`)?.dataset.name || 'account'; const saved = await ui.modal({ title: `Adjust wallet — ${name}`, submitLabel: 'Record adjustment', body: html`${ui.note('Each adjustment creates a ledger entry. Negative values cannot take a balance below zero.')}${ui.fieldRow(ui.selectField({ name: 'unit', label: 'Unit', options: [{ value: 'points', label: 'Loyalty points' }, { value: 'wallet', label: 'Wallet (TND)' }] }), ui.field({ name: 'delta', label: 'Change', type: 'number', required: true, attrs: 'step="0.001"' }))}${ui.textareaField({ name: 'reason', label: 'Reason', required: true, hint: 'At least five characters for the audit trail.' })}`, onSubmit: async (values) => { const delta = Number(values.delta); if (!Number.isFinite(delta) || delta === 0) throw new Error('Enter a non-zero adjustment.'); const response = await api.post(`/wallets/${id}/adjust`, { ...values, delta }); ui.toast(response.message || 'Wallet adjustment recorded.'); return true; } }); if (saved) load(); },
    }); await load();
  },
};
