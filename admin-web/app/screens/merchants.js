/**
 * The partner network.
 *
 * Two states matter and are easy to confuse, so both are shown: whether the
 * business registration has been approved (§3), and whether the account is
 * live for customers. An approved merchant that is deactivated is invisible
 * in the app; an active one with no approval should not be.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';
import { go } from '../core/router.js';

const { html } = ui;

export default {
  title: 'Merchants',
  subtitle: 'Partner shops on the VIPs network',
  permission: 'merchants.read',

  async render(host, ctx) {
    const query = {
      search: ctx.query.search || '',
      status: ctx.query.status || '',
      approval: ctx.query.approval || '',
      page: ctx.query.page || '1',
    };

    host.append(ui.node(ui.card({
      title: 'Merchants',
      subtitle: 'Approval is the registration decision; status is whether customers can see the shop.',
      body: html`${''}`,
    })));

    const cardBody = host.querySelector('.card-body');
    const body = ui.node(html`<div></div>`);

    cardBody.append(ui.filterBar({
      values: query,
      onChange: (values) => ctx.setQuery({ ...values, page: 1 }),
      fields: [
        { name: 'search', type: 'search', label: 'Find', placeholder: 'Shop, owner, email or phone' },
        {
          name: 'approval',
          type: 'select',
          label: 'Approval',
          options: [
            { value: '', label: 'Any' },
            { value: 'pending', label: 'Pending' },
            { value: 'under_review', label: 'Under review' },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'none', label: 'Never registered' },
          ],
        },
        {
          name: 'status',
          type: 'select',
          label: 'Visibility',
          options: [
            { value: '', label: 'Any' },
            { value: 'active', label: 'Live' },
            { value: 'inactive', label: 'Hidden' },
          ],
        },
      ],
    }), body);

    async function load() {
      ui.render(body, ui.loadingState('Loading merchants…'));
      let data;
      try {
        data = await api.get('/merchants', query);
      } catch (error) {
        ui.render(body, ui.errorState(error, load));
        return;
      }

      ui.render(body, ui.table({
        columns: [
          {
            key: 'storeName',
            label: 'Shop',
            cell: (m) => ui.identity({
              title: m.storeName || m.businessName || m.fullName,
              subtitle: m.fullName || m.email,
            }),
          },
          { key: 'storeCategory', label: 'Category', cell: (m) => fmt.humanise(m.storeCategory) },
          { key: 'phone', label: 'Contact', cell: (m) => m.phone || m.email || '—' },
          {
            key: 'approvalStatus',
            label: 'Approval',
            cell: (m) => (m.approvalStatus === 'none'
              ? ui.badge('Not registered', 'info')
              : ui.statusBadge(m.approvalStatus)),
          },
          {
            key: 'isActive',
            label: 'Visibility',
            cell: (m) => html`
              ${m.isActive ? ui.badge('Live', 'success') : ui.badge('Hidden', 'danger')}
              ${m.isTrending ? ui.badge('Trending', 'warning') : ''}`,
          },
          { key: 'packageName', label: 'Plan', cell: (m) => fmt.humanise(m.packageName || 'basic') },
          { key: 'createdAt', label: 'Joined', cell: (m) => fmt.date(m.createdAt) },
          {
            key: 'actions',
            label: '',
            align: 'end',
            cell: (m) => html`
              ${ui.rowAction({ icon: 'las la-eye', title: 'Open', action: 'open', id: m._id })}
              ${auth.can('merchants.approve') && ['pending', 'under_review'].includes(m.approvalStatus)
    ? ui.rowAction({ icon: 'las la-check', title: 'Approve', action: 'approve', id: m._id, tone: 'success' })
    : ''}
              ${auth.canAny('merchants.activate', 'merchants.deactivate')
    ? ui.rowAction({
      icon: m.isActive ? 'las la-eye-slash' : 'las la-eye',
      title: m.isActive ? 'Hide from customers' : 'Make visible',
      action: m.isActive ? 'deactivate' : 'activate',
      id: m._id,
      tone: m.isActive ? 'danger' : 'success',
    })
    : ''}
              ${auth.can('merchants.delete')
    ? ui.rowAction({ icon: 'las la-trash', title: 'Delete', action: 'delete', id: m._id, tone: 'danger' })
    : ''}`,
          },
        ],
        rows: data.items,
        empty: 'No merchant matches those filters.',
        rowAttrs: (m) => `data-href="/merchants/${m._id}" data-name="${ui.esc(m.storeName || m.fullName)}"`,
      }));

      const pager = ui.pagination(data, (page) => ctx.setQuery({ ...query, page }));
      if (pager) body.append(pager);
    }

    const nameOf = (id) =>
      body.querySelector(`tr[data-href^="/merchants/${id}"]`)?.dataset.name || 'this merchant';

    ui.actions(host, {
      open: ({ id }) => go(`/merchants/${id}`),

      approve: async ({ id }) => {
        const decided = await ui.modal({
          title: `Registration — ${nameOf(id)}`,
          submitLabel: 'Submit decision',
          body: html`
            ${ui.note('Approving also reactivates the account, so an approved merchant can '
              + 'actually sign in and start trading.')}
            ${ui.selectField({
    name: 'decision',
    label: 'Decision',
    options: [{ value: 'approve', label: 'Approve' }, { value: 'reject', label: 'Reject' }],
    required: true,
  })}
            ${ui.textareaField({
    name: 'reason',
    label: 'Reason',
    hint: 'Required when rejecting — the merchant is shown this.',
  })}`,
          onSubmit: async (values) => {
            const approved = values.decision === 'approve';
            if (!approved && !values.reason.trim()) {
              ui.toast('A rejection reason is required.', 'warning');
              return false;
            }
            const response = await api.put(`/merchants/${id}/approve`, {
              approved,
              reason: values.reason,
            });
            ui.toast(response.message || 'Decision recorded.');
            return true;
          },
        });
        if (decided) load();
      },

      activate: async ({ id }) => {
        const response = await api.put(`/merchants/${id}/activate`, { active: true });
        ui.toast(response.message || 'Merchant is live.');
        load();
      },

      deactivate: async ({ id }) => {
        const ok = await ui.confirm({
          title: 'Hide this merchant?',
          message: `${nameOf(id)} will disappear from the customer app.`,
          detail: 'Their products are hidden too, so nobody can order from a shop that cannot serve them.',
          submitLabel: 'Hide merchant',
        });
        if (!ok) return;
        const response = await api.put(`/merchants/${id}/activate`, { active: false });
        ui.toast(response.message || 'Merchant hidden.', 'warning');
        load();
      },

      delete: async ({ id }) => {
        const ok = await ui.confirm({
          title: 'Delete this merchant?',
          message: `${nameOf(id)} will be removed permanently. This cannot be undone.`,
          detail: 'The server refuses while the shop still has orders in progress — deleting then '
            + 'would strand customers holding an order nobody owns. Hiding the merchant is the '
            + 'reversible option.',
          submitLabel: 'Delete permanently',
        });
        if (!ok) return;
        const response = await api.del(`/merchants/${id}`);
        ui.toast(response.message || 'Merchant deleted.', 'warning');
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
