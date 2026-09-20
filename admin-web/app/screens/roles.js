/**
 * Roles: the named permission bundles.
 *
 * Built-in roles are shown but cannot be edited — they are defined in
 * middleware/permissions.js and are what the server falls back to. Custom
 * roles are stored and editable. Both are listed together because an
 * operator choosing a role does not care which kind it is.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';

const { html, raw } = ui;

export default {
  title: 'Roles',
  subtitle: 'Named bundles of permissions',
  permission: 'staff.read',

  async render(host, ctx) {
    const [rolesData, catalogue] = await Promise.all([
      api.get('/roles'),
      api.get('/permissions'),
    ]);

    const builtIn = rolesData.builtIn || [];
    const custom = rolesData.items || [];

    const permissionPicker = (granted = []) => html`
      <div class="permission-grid">
        ${catalogue.modules.map((mod) => html`
          <div class="permission-module">
            <h6>${fmt.humanise(mod.name)}</h6>
            ${catalogue.catalogue.filter((c) => c.module === mod.name).map((c) => html`
              <label class="form-check-field ${c.enforced ? '' : 'is-unenforced'}">
                <input type="checkbox" name="permissions" value="${c.key}" ${raw(granted.includes(c.key) ? 'checked' : '')}>
                <span>${c.label}${c.enforced ? '' : html` <em class="cell-sub">— declared, not yet enforced</em>`}</span>
              </label>`)}
          </div>`)}
      </div>`;

    const picked = (form) =>
      [...form.querySelectorAll('input[name=permissions]:checked')].map((i) => i.value);

    const summarise = (permissions) => {
      if (permissions.includes('*')) return ui.badge('Everything', 'danger');
      const byModule = {};
      for (const p of permissions) {
        const [mod] = p.split('.');
        byModule[mod] = (byModule[mod] || 0) + 1;
      }
      const parts = Object.entries(byModule).slice(0, 5)
        .map(([mod, n]) => `${fmt.humanise(mod)} ${n}`);
      const rest = Object.keys(byModule).length - parts.length;
      return html`${parts.join(' · ')}${rest > 0 ? ` · +${rest} more` : ''}`;
    };

    host.append(ui.node(html`
      ${ui.note('A role decides what an operator sees and may do. The console hides controls a role '
        + 'cannot use, but every action is checked again on the server — hiding a button is a '
        + 'courtesy, not the boundary.')}

      ${ui.card({
    title: 'Built-in roles',
    subtitle: 'Defined in the backend and always available. They cannot be edited here.',
    body: ui.table({
      columns: [
        { key: 'name', label: 'Role', cell: (r) => ui.identity({ title: fmt.humanise(r.name) }) },
        {
          key: 'count',
          label: 'Permissions',
          align: 'end',
          cell: (r) => (r.permissions.includes('*') ? 'All' : fmt.number(r.permissions.length)),
        },
        { key: 'summary', label: 'Covers', cell: (r) => summarise(r.permissions) },
      ],
      rows: builtIn,
    }),
  })}

      ${ui.card({
    title: 'Custom roles',
    subtitle: 'Bundles you define on top of the catalogue.',
    actions: auth.can('staff.assign_role')
      ? ui.button({ label: 'New role', icon: 'las la-plus', size: 'sm', action: 'create' })
      : '',
    body: ui.table({
      columns: [
        {
          key: 'name',
          label: 'Role',
          cell: (r) => ui.identity({ title: fmt.humanise(r.name), subtitle: r.description || null }),
        },
        { key: 'count', label: 'Permissions', align: 'end', cell: (r) => fmt.number((r.permissions || []).length) },
        { key: 'summary', label: 'Covers', cell: (r) => summarise(r.permissions || []) },
        {
          key: 'actions',
          label: '',
          align: 'end',
          cell: (r) => (auth.can('staff.assign_role') ? html`
                ${ui.rowAction({ icon: 'las la-pen', title: 'Edit', action: 'edit', id: r._id })}
                ${ui.rowAction({ icon: 'las la-trash', title: 'Delete', action: 'delete', id: r._id, tone: 'danger' })}`
            : ''),
        },
      ],
      rows: custom,
      empty: 'No custom role yet — the built-in five cover most needs.',
      rowAttrs: (r) => `data-id="${r._id}" data-name="${ui.esc(r.name)}"`,
    }),
  })}`));

    ui.actions(host, {
      create: async () => {
        const created = await ui.modal({
          title: 'New role',
          submitLabel: 'Create role',
          size: 'xl',
          body: html`
            ${ui.fieldRow(
    ui.field({ name: 'name', label: 'Role name', required: true, placeholder: 'e.g. support' }),
    ui.field({ name: 'description', label: 'What it is for' }),
  )}
            ${permissionPicker()}`,
          onSubmit: async (values, dialog) => {
            const response = await api.post('/roles', {
              name: values.name,
              description: values.description,
              permissions: picked(dialog.form),
            });
            ui.toast(response.message || 'Role created.');
            return true;
          },
        });
        if (created) ctx.reload();
      },

      edit: async ({ id }) => {
        const role = custom.find((r) => String(r._id) === id);
        if (!role) return;
        const saved = await ui.modal({
          title: `Edit ${fmt.humanise(role.name)}`,
          submitLabel: 'Save role',
          size: 'xl',
          body: html`
            ${ui.note('Changing a role changes what every operator holding it may do, at once.',
    'warning')}
            ${ui.field({ name: 'description', label: 'What it is for', value: role.description || '' })}
            ${permissionPicker(role.permissions || [])}`,
          onSubmit: async (values, dialog) => {
            const response = await api.put(`/roles/${id}`, {
              description: values.description,
              permissions: picked(dialog.form),
            });
            ui.toast(response.message || 'Role updated.');
            return true;
          },
        });
        if (saved) ctx.reload();
      },

      delete: async ({ id }) => {
        const name = host.querySelector(`tr[data-id="${id}"]`)?.dataset.name || 'this role';
        const ok = await ui.confirm({
          title: 'Delete this role?',
          message: `${fmt.humanise(name)} will be removed.`,
          detail: 'Operators holding it fall back to the viewer bundle until they are given another role.',
          submitLabel: 'Delete role',
        });
        if (!ok) return;
        const response = await api.del(`/roles/${id}`);
        ui.toast(response.message || 'Role deleted.', 'warning');
        ctx.reload();
      },
    });

    return undefined;
  },
};
