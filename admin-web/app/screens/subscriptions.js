import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';

const { html } = ui;

export default {
  title: 'Subscriptions', subtitle: 'Customer and merchant plans', permission: 'subscriptions.read',
  async render(host, ctx) {
    const query = { audience: ctx.query.audience === 'merchant' ? 'merchant' : 'customer', search: ctx.query.search || '', status: ctx.query.status || '', paymentStatus: ctx.query.paymentStatus || '', page: ctx.query.page || '1' };
    const panel = ui.node(ui.card({ title: 'Subscriptions', body: html`${''}` }));
    const body = panel.querySelector('.card-body'); const table = ui.node(html`<div></div>`); host.append(panel);
    body.append(ui.filterBar({ values: query, onChange: (values) => ctx.setQuery({ ...values, paymentStatus: values.audience === 'customer' ? values.paymentStatus : '', page: 1 }), fields: [
      { name: 'audience', type: 'select', label: 'Accounts', options: [{ value: 'customer', label: 'Customers' }, { value: 'merchant', label: 'Merchants' }] },
      { name: 'search', type: 'search', label: 'Find', placeholder: 'Name, email, phone or shop' },
      { name: 'status', type: 'select', label: 'State', options: [{ value: '', label: 'All states' }, 'active', 'inactive'] },
      ...(query.audience === 'customer' ? [{ name: 'paymentStatus', type: 'select', label: 'Payment', options: [{ value: '', label: 'All payments' }, 'pending_payment', 'paid', 'rejected'] }] : []),
    ] }), table);
    async function load() {
      ui.render(table, ui.loadingState('Loading subscriptions…'));
      try {
        const data = await api.get('/subscriptions', query);
        ui.render(table, ui.table({ columns: [
          { key: 'ownerName', label: 'Account', cell: (s) => ui.identity({ title: s.ownerName, subtitle: s.owner?.email || s.owner?.phone || null }) },
          { key: 'plan', label: 'Plan', cell: (s) => fmt.humanise(s.planCode || s.tier || s.planName || '—') },
          { key: 'amount', label: 'Paid', align: 'end', cell: (s) => ui.money(s.amountPaid ?? s.price ?? 0) },
          { key: 'endDate', label: 'Ends', cell: (s) => s.endDate ? fmt.date(s.endDate) : 'No expiry' },
          { key: 'state', label: 'State', cell: (s) => html`${ui.badge(s.isActive ? 'Active' : 'Inactive', s.isActive ? 'success' : 'warning')} ${s.paymentStatus ? ui.statusBadge(s.paymentStatus) : ''}` },
          { key: 'actions', label: '', align: 'end', cell: (s) => html`
            ${query.audience === 'customer' && s.paymentStatus === 'pending_payment' && auth.can('subscriptions.review_payment') ? html`${ui.rowAction({ icon: 'las la-check', title: 'Approve payment', action: 'approve', id: s._id })}${ui.rowAction({ icon: 'las la-times', title: 'Reject payment', action: 'reject', id: s._id, tone: 'danger' })}` : ''}
            ${auth.can('subscriptions.update') ? ui.rowAction({ icon: s.isActive ? 'las la-pause' : 'las la-play', title: s.isActive ? 'Deactivate' : 'Activate', action: 'toggle', id: s._id }) : ''}` },
        ], rows: data.items, empty: 'No subscription matches those filters.', rowAttrs: (s) => `data-id="${s._id}" data-name="${ui.esc(s.ownerName)}" data-active="${s.isActive}"` }));
        const pager = ui.pagination(data, (page) => ctx.setQuery({ ...query, page })); if (pager) table.append(pager);
      } catch (error) { ui.render(table, ui.errorState(error, load)); }
    }
    const reviewPayment = async (id, action) => {
      const name = table.querySelector(`tr[data-id="${id}"]`)?.dataset.name || 'this customer';
      const rejected = action === 'reject';
      const done = await ui.modal({
        title: `${rejected ? 'Reject' : 'Approve'} payment — ${name}`,
        submitLabel: rejected ? 'Reject payment' : 'Approve payment',
        submitTone: rejected ? 'danger' : 'base',
        body: html`${ui.textareaField({ name: 'reason', label: rejected ? 'Rejection reason' : 'Review note', required: rejected, hint: rejected ? 'Required so the customer understands what to correct.' : 'Optional.' })}`,
        onSubmit: async (values) => { const response = await api.put(`/subscriptions/customer/${id}/payment`, { action, reason: values.reason }); ui.toast(response.message || 'Payment reviewed.'); return true; },
      });
      if (done) load();
    };

    ui.actions(host, {
      toggle: async ({ id }) => { const row = table.querySelector(`tr[data-id="${id}"]`); const isActive = row?.dataset.active === 'true'; const response = await api.put(`/subscriptions/${query.audience}/${id}`, { isActive: !isActive }); ui.toast(response.message || 'Subscription updated.'); load(); },
      approve: ({ id }) => reviewPayment(id, 'approve'),
      reject: ({ id }) => reviewPayment(id, 'reject'),
    }); await load();
  },
};
