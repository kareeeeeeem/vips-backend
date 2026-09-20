/**
 * The customer base.
 *
 * Wallet balance (dinars) and points sit in separate columns on purpose:
 * 100 points is 1 TND, and a single "balance" column that mixed them would
 * misstate what a customer holds by two orders of magnitude.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';
import { go } from '../core/router.js';

const { html } = ui;

export default {
  title: 'Customers',
  subtitle: 'Everyone who holds a VIPs wallet',
  permission: 'users.read',

  async render(host, ctx) {
    const query = {
      search: ctx.query.search || '',
      status: ctx.query.status || '',
      from: ctx.query.from || '',
      to: ctx.query.to || '',
      page: ctx.query.page || '1',
    };

    const body = ui.node(html`<div></div>`);

    const filters = ui.filterBar({
      values: query,
      onChange: (values) => ctx.setQuery({ ...values, page: 1 }),
      fields: [
        { name: 'search', type: 'search', label: 'Find', placeholder: 'Name, email or phone' },
        {
          name: 'status',
          type: 'select',
          label: 'Status',
          options: [
            { value: '', label: 'Everyone' },
            { value: 'active', label: 'Active' },
            { value: 'banned', label: 'Suspended' },
          ],
        },
        { name: 'from', type: 'date', label: 'Joined after' },
        { name: 'to', type: 'date', label: 'Joined before' },
      ],
      actions: auth.can('users.create')
        ? ui.button({ label: 'Add customer', icon: 'las la-user-plus', action: 'create' })
        : '',
    });

    host.append(ui.node(ui.card({
      title: 'Customers',
      subtitle: 'Points are shown separately from the cash wallet — 100 points is 1 TND.',
      body: html`${''}`,
    })));

    const cardBody = host.querySelector('.card-body');
    cardBody.append(filters, body);

    async function load() {
      ui.render(body, ui.loadingState('Loading customers…'));
      let data;
      try {
        data = await api.get('/users', { ...query, role: 'customer' });
      } catch (error) {
        ui.render(body, ui.errorState(error, load));
        return;
      }

      ui.render(body, ui.table({
        columns: [
          {
            key: 'fullName',
            label: 'Customer',
            cell: (u) => ui.identity({ title: u.fullName, subtitle: u.email }),
          },
          { key: 'phone', label: 'Phone', cell: (u) => u.phone || '—' },
          { key: 'walletBalance', label: 'Wallet', align: 'end', cell: (u) => ui.money(u.walletBalance) },
          { key: 'walletPoints', label: 'Points', align: 'end', cell: (u) => ui.pointsFigure(u.walletPoints) },
          {
            key: 'isActive',
            label: 'Status',
            cell: (u) => html`
              ${ui.statusBadge(u.isActive === false ? 'banned' : 'active')}
              ${u.isVerified ? '' : ui.badge('Unverified', 'warning')}`,
          },
          { key: 'createdAt', label: 'Joined', cell: (u) => fmt.date(u.createdAt) },
          {
            key: 'actions',
            label: '',
            align: 'end',
            cell: (u) => html`
              ${ui.rowAction({ icon: 'las la-eye', title: 'Open', action: 'open', id: u._id })}
              ${auth.can('users.update')
    ? ui.rowAction({ icon: 'las la-pen', title: 'Edit', action: 'edit', id: u._id })
    : ''}
              ${auth.canAny('users.ban', 'users.unban')
    ? ui.rowAction({
      icon: u.isActive === false ? 'las la-unlock' : 'las la-ban',
      title: u.isActive === false ? 'Reinstate' : 'Suspend',
      action: u.isActive === false ? 'unban' : 'ban',
      id: u._id,
      tone: u.isActive === false ? 'success' : 'danger',
    })
    : ''}
              ${auth.can('users.delete')
    ? ui.rowAction({ icon: 'las la-trash', title: 'Delete', action: 'delete', id: u._id, tone: 'danger' })
    : ''}`,
          },
        ],
        rows: data.items,
        empty: query.search || query.status
          ? 'No customer matches those filters.'
          : 'No customers have signed up yet.',
        rowAttrs: (u) => `data-href="/customers/${u._id}" data-name="${ui.esc(u.fullName)}"`,
      }));

      const pager = ui.pagination(data, (page) => ctx.setQuery({ ...query, page }));
      if (pager) body.append(pager);
    }

    const nameOf = (id) =>
      body.querySelector(`tr[data-href$="/${id}"]`)?.dataset.name || 'this customer';

    ui.actions(host, {
      open: ({ id }) => go(`/customers/${id}`),

      create: async () => {
        const created = await ui.modal({
          title: 'Add a customer',
          submitLabel: 'Create account',
          body: html`
            ${ui.note('The account is created with a random password. They take it over with '
              + '"forgot password" — nobody has to read a password out over a counter.')}
            ${ui.field({ name: 'fullName', label: 'Full name', required: true })}
            ${ui.fieldRow(
    ui.field({ name: 'phone', label: 'Phone', required: true }),
    ui.field({ name: 'email', label: 'Email', type: 'email', hint: 'Optional — one is generated if left blank.' }),
  )}
            ${ui.field({ name: 'city', label: 'City' })}`,
          onSubmit: async (values) => {
            const response = await api.post('/users', values);
            ui.toast(response.message || 'Customer added.');
            return true;
          },
        });
        if (created) load();
      },

      edit: async ({ id }) => {
        const { user } = await api.get(`/users/${id}`);
        const saved = await ui.modal({
          title: `Edit ${user.fullName}`,
          submitLabel: 'Save changes',
          body: html`
            ${ui.field({ name: 'fullName', label: 'Full name', value: user.fullName, required: true })}
            ${ui.fieldRow(
    ui.field({ name: 'email', label: 'Email', type: 'email', value: user.email, required: true }),
    ui.field({ name: 'phone', label: 'Phone', value: user.phone, required: true }),
  )}
            ${ui.field({ name: 'city', label: 'City', value: user.city || '' })}`,
          onSubmit: async (values) => {
            const response = await api.put(`/users/${id}`, values);
            ui.toast(response.message || 'Customer updated.');
            return true;
          },
        });
        if (saved) load();
      },

      ban: async ({ id }) => {
        const ok = await ui.confirm({
          title: 'Suspend this customer?',
          message: `${nameOf(id)} will be signed out and refused at the next sign-in.`,
          detail: 'Their orders and points are kept. You can reinstate them at any time.',
          submitLabel: 'Suspend',
        });
        if (!ok) return;
        const response = await api.put(`/users/${id}/ban`, { banned: true });
        ui.toast(response.message || 'Customer suspended.', 'warning');
        load();
      },

      unban: async ({ id }) => {
        const response = await api.put(`/users/${id}/ban`, { banned: false });
        ui.toast(response.message || 'Customer reinstated.');
        load();
      },

      delete: async ({ id }) => {
        const ok = await ui.confirm({
          title: 'Delete this customer?',
          message: `${nameOf(id)} will be removed permanently. This cannot be undone.`,
          detail: 'Their past orders stay in place — they are financial records, and deleting '
            + 'them would rewrite past revenue figures.',
          submitLabel: 'Delete permanently',
        });
        if (!ok) return;
        const response = await api.del(`/users/${id}`);
        ui.toast(response.message || 'Customer deleted.', 'warning');
        load();
      },
    });

    body.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-href]');
      if (row && !event.target.closest('button, a')) go(row.dataset.href);
    });

    await load();
    return undefined;
  },
};
