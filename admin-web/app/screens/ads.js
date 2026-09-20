import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';

const { html } = ui;

export default {
  title: 'Advertisements', subtitle: 'Merchant campaign moderation', permission: 'ads.read',
  async render(host, ctx) {
    const query = { search: ctx.query.search || '', status: ctx.query.status || '', moderation: ctx.query.moderation || '', page: ctx.query.page || '1' };
    const panel = ui.node(ui.card({ title: 'Campaigns', body: html`${''}` })); const body = panel.querySelector('.card-body'); const table = ui.node(html`<div></div>`); host.append(panel);
    body.append(ui.filterBar({ values: query, onChange: (values) => ctx.setQuery({ ...values, page: 1 }), fields: [
      { name: 'search', type: 'search', label: 'Find', placeholder: 'Title, description or audience' },
      { name: 'status', type: 'select', label: 'Campaign', options: [{ value: '', label: 'All campaign states' }, 'draft', 'active', 'paused', 'ended', 'scheduled'] },
      { name: 'moderation', type: 'select', label: 'Moderation', options: [{ value: '', label: 'All reviews' }, 'pending', 'approved', 'rejected'] },
    ] }), table);
    async function load() { ui.render(table, ui.loadingState('Loading advertisements…')); try { const data = await api.get('/ads', query); ui.render(table, ui.table({ columns: [
      { key: 'title', label: 'Campaign', cell: (a) => ui.identity({ title: a.title, subtitle: a.description || a.adType }) }, { key: 'merchantName', label: 'Merchant', cell: (a) => a.merchantName }, { key: 'budget', label: 'Budget', align: 'end', cell: (a) => html`${ui.money(a.spentAmount || 0)}<span class="cell-sub">of ${fmt.tnd(a.budget || 0)}</span>` }, { key: 'endDate', label: 'Schedule', cell: (a) => `${fmt.date(a.startDate)} – ${fmt.date(a.endDate)}` }, { key: 'moderationStatus', label: 'Review', cell: (a) => ui.statusBadge(a.moderationStatus) },
      { key: 'actions', label: '', align: 'end', cell: (a) => auth.can('ads.moderate') && a.moderationStatus === 'pending' ? html`${ui.rowAction({ icon: 'las la-check', title: 'Approve', action: 'approve', id: a._id })}${ui.rowAction({ icon: 'las la-times', title: 'Reject', action: 'reject', id: a._id, tone: 'danger' })}` : '' },
    ], rows: data.items, empty: 'No advertisement matches those filters.', rowAttrs: (a) => `data-id="${a._id}" data-title="${ui.esc(a.title)}"` })); const pager = ui.pagination(data, (page) => ctx.setQuery({ ...query, page })); if (pager) table.append(pager); } catch (error) { ui.render(table, ui.errorState(error, load)); } }
    const moderate = async (id, decision) => { const title = table.querySelector(`tr[data-id="${id}"]`)?.dataset.title || 'this advertisement'; const result = await ui.modal({ title: `${decision === 'approved' ? 'Approve' : 'Reject'} advertisement`, submitLabel: decision === 'approved' ? 'Approve' : 'Reject', submitTone: decision === 'approved' ? 'base' : 'danger', body: html`${ui.textareaField({ name: 'reason', label: decision === 'approved' ? 'Moderator note' : 'Rejection reason', required: decision === 'rejected', hint: decision === 'rejected' ? 'Required so the merchant can correct the campaign.' : 'Optional.' })}`, onSubmit: async (values) => { const response = await api.put(`/ads/${id}/moderate`, { decision, reason: values.reason }); ui.toast(response.message || `${title} reviewed.`); return true; } }); if (result) load(); };
    ui.actions(host, { approve: ({ id }) => moderate(id, 'approved'), reject: ({ id }) => moderate(id, 'rejected') }); await load();
  },
};
