import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';

const { html } = ui;

export default {
  title: 'Broadcasts', subtitle: 'Messages sent to customers and merchants', permission: 'broadcasts.read',
  async render(host, ctx) {
    const query = { page: ctx.query.page || '1' };
    const panel = ui.node(ui.card({ title: 'Sent broadcasts', actions: auth.can('broadcasts.send') ? ui.button({ label: 'New broadcast', icon: 'las la-paper-plane', action: 'send' }) : '', body: html`${''}` }));
    const body = panel.querySelector('.card-body'); const table = ui.node(html`<div></div>`); host.append(panel, table);
    async function load() {
      ui.render(table, ui.loadingState('Loading broadcasts…'));
      try { const data = await api.get('/broadcasts', query); ui.render(table, ui.table({ columns: [
        { key: 'title', label: 'Message', cell: (b) => ui.identity({ title: b.title, subtitle: b.message }) },
        { key: 'audience', label: 'Audience', cell: (b) => html`${ui.badge(fmt.humanise(b.audience), 'info')}<span class="cell-sub">${fmt.number(b.customerCount || 0)} customers · ${fmt.number(b.merchantCount || 0)} merchants</span>` },
        { key: 'type', label: 'Type', cell: (b) => fmt.humanise(b.type) }, { key: 'sentBy', label: 'Sent by', cell: (b) => b.sentBy?.fullName || b.sentBy?.email || '—' }, { key: 'createdAt', label: 'Sent', cell: (b) => fmt.dateTime(b.createdAt) },
      ], rows: data.items, empty: 'No broadcast has been sent yet.' })); const pager = ui.pagination(data, (page) => ctx.setQuery({ ...query, page })); if (pager) table.append(pager); } catch (error) { ui.render(table, ui.errorState(error, load)); }
    }
    ui.actions(host, { send: async () => { const saved = await ui.modal({ title: 'Send a broadcast', submitLabel: 'Send broadcast', size: 'lg', body: html`
      ${ui.note('This sends immediately to every eligible account in the selected audience. Review the message before sending.')}
      ${ui.field({ name: 'title', label: 'Title', required: true, attrs: 'maxlength="100"', hint: '3–100 characters.' })}
      ${ui.textareaField({ name: 'message', label: 'Message', required: true, rows: 5, hint: '3–1,000 characters.' })}
      ${ui.fieldRow(ui.selectField({ name: 'audience', label: 'Audience', required: true, options: [{ value: 'customers', label: 'Customers' }, { value: 'merchants', label: 'Merchants' }, { value: 'all', label: 'Customers and merchants' }] }), ui.selectField({ name: 'type', label: 'Type', options: ['system', 'promotion', 'account'] }))}
      ${ui.field({ name: 'actionUrl', label: 'Internal link (optional)', placeholder: '/offers', hint: 'Must start with /. Leave blank when no action is needed.', attrs: 'maxlength="300"' })}`, onSubmit: async (values) => { const response = await api.post('/broadcasts', values); ui.toast(response.message || 'Broadcast sent.'); return true; } }); if (saved) load(); } });
    await load();
  },
};
