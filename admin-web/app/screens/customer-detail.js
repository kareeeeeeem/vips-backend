/**
 * One customer: who they are, what they hold, and what they have done.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';
import { go } from '../core/router.js';

const { html } = ui;

const ROLES = ['customer', 'merchant', 'agent', 'admin'];

export default {
  title: 'Customer',
  permission: 'users.read',

  async render(host, ctx) {
    const { id } = ctx.params;
    const { user, stats, recentOrders, recentTransactions } = await api.get(`/users/${id}`);

    document.getElementById('page-title').textContent = user.fullName || 'Customer';
    document.getElementById('page-subtitle').textContent = user.email || '';

    const banned = user.isActive === false;

    host.append(ui.node(html`
      ${ui.statGrid([
    ui.statCard({
      label: 'Cash wallet',
      value: fmt.tnd(user.walletBalance),
      hint: 'Held in dinars',
      icon: 'las la-wallet',
      tone: 'navy',
    }),
    ui.statCard({
      label: 'Loyalty points',
      value: fmt.pointsBare(user.walletPoints),
      hint: `Worth ${fmt.pointsAsTnd(user.walletPoints)} at 100 points to the dinar`,
      icon: 'las la-star',
      tone: 'base',
    }),
    ui.statCard({
      label: 'Orders',
      value: fmt.number(stats.orders),
      hint: `${fmt.number(stats.cancelledOrders)} cancelled`,
      icon: 'las la-shopping-bag',
      tone: 'info',
    }),
    ui.statCard({
      label: 'Lifetime spend',
      value: fmt.tnd(stats.totalSpent),
      hint: 'Delivered and picked-up orders only',
      icon: 'las la-coins',
      tone: 'success',
    }),
  ])}

      <div class="row">
        <div class="col-xl-5 col-lg-12">
          ${ui.card({
    title: 'Profile',
    actions: html`
              ${auth.can('users.update') ? ui.button({ label: 'Edit', icon: 'las la-pen', tone: 'secondary', size: 'sm', action: 'edit' }) : ''}
              ${auth.canAny('users.ban', 'users.unban')
    ? ui.button({
      label: banned ? 'Reinstate' : 'Suspend',
      icon: banned ? 'las la-unlock' : 'las la-ban',
      tone: banned ? 'success' : 'danger',
      size: 'sm',
      action: banned ? 'unban' : 'ban',
    })
    : ''}`,
    body: ui.details([
      ['Status', html`${ui.statusBadge(banned ? 'banned' : 'active')}
                        ${user.isVerified ? ui.badge('Verified', 'success') : ui.badge('Unverified', 'warning')}`],
      ['Full name', user.fullName],
      ['Email', user.email],
      ['Phone', user.phone || '—'],
      ['City', user.city || '—'],
      ['Role', html`${ui.badge(fmt.humanise(user.role), 'base')}
                      ${auth.can('users.update')
    ? html` <button type="button" class="row-action" data-action="role" title="Change role">
                            <i class="las la-exchange-alt"></i></button>` : ''}`],
      user.packageName ? ['Package', user.packageName] : null,
      ['Joined', fmt.dateTime(user.createdAt)],
      ['Last sign-in', user.lastLogin ? fmt.dateTime(user.lastLogin) : 'Never'],
      ['Account id', html`<code>${user._id}</code>`],
    ]),
  })}
        </div>

        <div class="col-xl-7 col-lg-12">
          ${ui.card({
    title: 'Recent orders',
    body: ui.table({
      columns: [
        { key: 'orderNumber', label: 'Order', cell: (o) => o.orderNumber || fmt.shortId(o._id) },
        { key: 'orderType', label: 'Type', cell: (o) => fmt.humanise(o.orderType) },
        { key: 'totalAmount', label: 'Total', align: 'end', cell: (o) => ui.money(o.totalAmount) },
        { key: 'status', label: 'Status', cell: (o) => ui.statusBadge(o.status) },
        { key: 'createdAt', label: 'Placed', cell: (o) => fmt.ago(o.createdAt) },
      ],
      rows: recentOrders,
      empty: 'This customer has not ordered yet.',
      rowAttrs: (o) => `data-href="/orders/${o._id}"`,
    }),
  })}

          ${ui.card({
    title: 'Recent transactions',
    subtitle: 'Points and wallet movements on this account.',
    body: ui.table({
      columns: [
        { key: 'type', label: 'Type', cell: (t) => ui.statusBadge(t.type) },
        { key: 'description', label: 'Description', cell: (t) => t.description || '—' },
        // In the unit the row itself records — the ledger mixes points,
        // dinars and diamonds, and they differ by two orders of magnitude.
        { key: 'amount', label: 'Amount', align: 'end', cell: (t) => ui.amountIn(t.amount, t.currency) },
        { key: 'status', label: 'Status', cell: (t) => ui.statusBadge(t.status) },
        { key: 'createdAt', label: 'When', cell: (t) => fmt.ago(t.createdAt) },
      ],
      rows: recentTransactions,
      empty: 'No transactions recorded.',
    }),
  })}
        </div>
      </div>`));

    host.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-href]');
      if (row && !event.target.closest('button, a')) go(row.dataset.href);
    });

    ui.actions(host, {
      edit: async () => {
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
        if (saved) ctx.reload();
      },

      role: async () => {
        const saved = await ui.modal({
          title: 'Change role',
          submitLabel: 'Change role',
          body: html`
            ${ui.note('Changing someone to merchant or admin changes which app they can sign into. '
              + 'The last remaining admin cannot be demoted.', 'warning')}
            ${ui.selectField({ name: 'role', label: 'Role', options: ROLES, value: user.role, required: true })}`,
          onSubmit: async (values) => {
            const response = await api.put(`/users/${id}/role`, values);
            ui.toast(response.message || 'Role updated.');
            return true;
          },
        });
        if (saved) ctx.reload();
      },

      ban: async () => {
        const ok = await ui.confirm({
          title: 'Suspend this customer?',
          message: `${user.fullName} will be signed out and refused at the next sign-in.`,
          detail: 'Their orders and points are kept.',
          submitLabel: 'Suspend',
        });
        if (!ok) return;
        await api.put(`/users/${id}/ban`, { banned: true });
        ui.toast('Customer suspended.', 'warning');
        ctx.reload();
      },

      unban: async () => {
        await api.put(`/users/${id}/ban`, { banned: false });
        ui.toast('Customer reinstated.');
        ctx.reload();
      },
    });

    return undefined;
  },
};
