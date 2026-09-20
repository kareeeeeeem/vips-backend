/**
 * Console operators — admin accounts and what each may do.
 *
 * "Staff" here means people who sign into this console. A merchant's own
 * employees are a different thing entirely, managed from the Merchant app.
 *
 * Deleting an operator is refused by the server once they are recorded on
 * stock movements or receipts: those records would be left attributed to
 * nobody. The screen offers "disable" as the thing to do instead.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';

const { html, raw } = ui;

export default {
  title: 'Operators',
  subtitle: 'Who can sign into this console, and what they may do',
  permission: 'staff.read',

  async render(host, ctx) {
    const query = {
      search: ctx.query.search || '',
      adminRole: ctx.query.adminRole || '',
      page: ctx.query.page || '1',
    };

    const catalogue = await api.get('/permissions').catch(() => null);
    const roles = catalogue
      ? [...catalogue.builtInRoles.map((r) => r.name), ...catalogue.customRoles.map((r) => r.name)]
      : ['super_admin', 'admin', 'manager', 'cashier', 'viewer'];

    const panel = ui.node(ui.card({
      title: 'Operators',
      subtitle: 'A role is a bundle of permissions; extras can be granted on top of one.',
      body: html`${''}`,
    }));
    host.append(panel);

    const cardBody = panel.querySelector('.card-body');
    const body = ui.node(html`<div></div>`);

    cardBody.append(ui.filterBar({
      values: query,
      onChange: (values) => ctx.setQuery({ ...values, page: 1 }),
      fields: [
        { name: 'search', type: 'search', label: 'Find', placeholder: 'Name or email' },
        {
          name: 'adminRole',
          type: 'select',
          label: 'Role',
          options: [{ value: '', label: 'Any role' }, ...roles],
        },
      ],
      actions: auth.can('staff.create')
        ? ui.button({ label: 'Add operator', icon: 'las la-user-plus', action: 'create' })
        : '',
    }), body);

    /** The permission checkbox grid, grouped by module. */
    const permissionPicker = (granted = []) => {
      if (!catalogue) return ui.note('The permission catalogue could not be loaded.', 'warning');
      const has = (key) => granted.includes(key) || granted.includes('*')
        || granted.includes(`${key.split('.')[0]}.*`);
      return html`
        <div class="permission-grid">
          ${catalogue.modules.map((mod) => html`
            <div class="permission-module">
              <h6>${fmt.humanise(mod.name)}</h6>
              ${catalogue.catalogue.filter((c) => c.module === mod.name).map((c) => html`
                <label class="form-check-field ${c.enforced ? '' : 'is-unenforced'}">
                  <input type="checkbox" name="permissions" value="${c.key}" ${raw(has(c.key) ? 'checked' : '')}>
                  <span>${c.label}${c.enforced ? '' : html` <em class="cell-sub">— declared, not yet enforced</em>`}</span>
                </label>`)}
            </div>`)}
        </div>`;
    };

    /** Checkbox groups do not survive FormData when nothing is checked, so
     *  the list is read off the form directly. */
    const pickedPermissions = (form) =>
      [...form.querySelectorAll('input[name=permissions]:checked')].map((i) => i.value);

    async function load() {
      ui.render(body, ui.loadingState('Loading operators…'));
      let data;
      try {
        data = await api.get('/staff', query);
      } catch (error) {
        ui.render(body, ui.errorState(error, load));
        return;
      }

      ui.render(body, ui.table({
        columns: [
          {
            key: 'fullName',
            label: 'Operator',
            cell: (s) => ui.identity({ title: s.fullName, subtitle: s.email }),
          },
          {
            key: 'adminRole',
            label: 'Role',
            cell: (s) => ui.badge(fmt.humanise(s.adminRole || 'viewer'),
              s.adminRole === 'super_admin' ? 'danger' : 'base'),
          },
          {
            key: 'permissions',
            label: 'Extras',
            align: 'end',
            cell: (s) => (s.permissions?.length
              ? ui.badge(`+${s.permissions.length}`, 'info')
              : html`<span class="cell-sub">none</span>`),
          },
          {
            key: 'signedRecords',
            label: 'Records',
            align: 'end',
            cell: (s) => (s.signedRecords
              ? html`<span title="Stock movements and receipts attributed to this operator">${fmt.number(s.signedRecords)}</span>`
              : '—'),
          },
          {
            key: 'isActive',
            label: 'Status',
            cell: (s) => ui.statusBadge(s.isActive === false ? 'inactive' : 'active'),
          },
          { key: 'lastLogin', label: 'Last seen', cell: (s) => (s.lastLogin ? fmt.ago(s.lastLogin) : 'Never') },
          {
            key: 'actions',
            label: '',
            align: 'end',
            cell: (s) => html`
              ${auth.can('staff.update')
    ? ui.rowAction({ icon: 'las la-pen', title: 'Edit', action: 'edit', id: s._id })
    : ''}
              ${auth.can('staff.assign_permissions')
    ? ui.rowAction({ icon: 'las la-key', title: 'Permissions', action: 'permissions', id: s._id })
    : ''}
              ${auth.can('staff.delete')
    ? ui.rowAction({ icon: 'las la-trash', title: 'Remove', action: 'delete', id: s._id, tone: 'danger' })
    : ''}`,
          },
        ],
        rows: data.items,
        empty: 'No operator matches those filters.',
        rowAttrs: (s) => `data-id="${s._id}" data-name="${ui.esc(s.fullName)}"`,
      }));

      const pager = ui.pagination(data, (page) => ctx.setQuery({ ...query, page }));
      if (pager) body.append(pager);
    }

    const nameOf = (id) => body.querySelector(`tr[data-id="${id}"]`)?.dataset.name || 'this operator';

    ui.actions(host, {
      create: async () => {
        const created = await ui.modal({
          title: 'Add an operator',
          submitLabel: 'Create operator',
          size: 'lg',
          body: html`
            ${ui.note('They sign into this console with the password you set here. Give the '
              + 'narrowest role that covers their job — a role is easier to widen later than a '
              + 'mistake is to notice.')}
            ${ui.field({ name: 'fullName', label: 'Full name', required: true })}
            ${ui.fieldRow(
    ui.field({ name: 'email', label: 'Email', type: 'email', required: true }),
    ui.field({ name: 'phone', label: 'Phone', required: true }),
  )}
            ${ui.fieldRow(
    ui.field({
      name: 'password',
      label: 'Password',
      type: 'password',
      required: true,
      attrs: 'minlength="6"',
      hint: 'At least 6 characters.',
    }),
    ui.selectField({ name: 'adminRole', label: 'Role', options: roles, value: 'viewer', required: true }),
  )}`,
          onSubmit: async (values) => {
            const response = await api.post('/staff', values);
            ui.toast(response.message || 'Operator added.');
            return true;
          },
        });
        if (created) load();
      },

      edit: async ({ id }) => {
        const staff = await api.get(`/staff/${id}`);
        const saved = await ui.modal({
          title: `Edit ${staff.fullName}`,
          submitLabel: 'Save changes',
          body: html`
            ${ui.field({ name: 'fullName', label: 'Full name', value: staff.fullName, required: true })}
            ${ui.selectField({
    name: 'adminRole',
    label: 'Role',
    options: roles,
    value: staff.adminRole || 'viewer',
    hint: 'Only a super admin can grant super admin, and the last one cannot be demoted.',
  })}
            ${ui.checkboxField({
    name: 'isActive',
    label: 'Can sign in',
    checked: staff.isActive !== false,
    hint: 'Disabling takes effect on their next request, not when their token expires.',
  })}`,
          onSubmit: async (values) => {
            const response = await api.put(`/staff/${id}`, {
              fullName: values.fullName,
              adminRole: values.adminRole,
              isActive: values.isActive === '1',
            });
            ui.toast(response.message || 'Operator updated.');
            return true;
          },
        });
        if (saved) load();
      },

      permissions: async ({ id }) => {
        const staff = await api.get(`/staff/${id}`);
        const saved = await ui.modal({
          title: `Permissions — ${staff.fullName}`,
          submitLabel: 'Save permissions',
          size: 'xl',
          body: html`
            ${ui.note(`These are granted on top of the ${fmt.humanise(staff.adminRole || 'viewer')} role, `
              + 'which already carries its own bundle. Unticking one the role grants does not take it away.')}
            ${permissionPicker(staff.permissions || [])}`,
          onSubmit: async (values, dialog) => {
            const response = await api.put(`/staff/${id}`, {
              permissions: pickedPermissions(dialog.form),
            });
            ui.toast(response.message || 'Permissions updated.');
            return true;
          },
        });
        if (saved) load();
      },

      delete: async ({ id }) => {
        const ok = await ui.confirm({
          title: 'Remove this operator?',
          message: `${nameOf(id)} will lose access to the console.`,
          detail: 'If they are recorded on stock movements or receipts, the server will refuse and '
            + 'ask you to disable the account instead — those records must keep someone attached.',
          submitLabel: 'Remove operator',
        });
        if (!ok) return;
        const response = await api.del(`/staff/${id}`);
        ui.toast(response.message || 'Operator removed.', 'warning');
        load();
      },
    });

    await load();
    return undefined;
  },
};
