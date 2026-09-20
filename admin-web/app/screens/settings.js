/**
 * Platform settings.
 *
 * The integration panel reports what is actually live in the running
 * process, not what someone hopes is configured — the same signal
 * /api/health exposes. A service shown as unavailable here is genuinely
 * unavailable to the apps.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';
import * as config from '../core/config.js';
import { go } from '../core/router.js';

const { html } = ui;

const INTEGRATIONS = {
  firebaseAdmin: {
    label: 'Firebase Admin',
    what: 'Verifies Google, Facebook and Apple sign-ins server-side.',
    without: 'Social login is refused; email and password still work.',
  },
  sendgrid: {
    label: 'SendGrid',
    what: 'Delivers password-reset and verification emails.',
    without: 'Codes are written to the server log instead of being emailed.',
  },
  paymee: {
    label: 'Paymee',
    what: 'Card payments in Tunisian dinars.',
    without: 'Card checkout returns a clear error; cash on delivery still works.',
  },
  paypal: {
    label: 'PayPal',
    what: 'International payments.',
    without: 'PayPal checkout is disabled.',
  },
};

export default {
  title: 'Settings',
  subtitle: 'What this deployment has configured',
  permission: 'settings.read',

  async render(host, ctx) {
    const [settings, cfg] = await Promise.all([api.get('/settings'), config.load()]);

    const env = settings.environment;
    const integrationRows = Object.entries(settings.integrations).map(([key, on]) => ({
      key, on, ...(INTEGRATIONS[key] || { label: fmt.humanise(key), what: '', without: '' }),
    }));

    host.append(ui.node(html`
      ${ui.statGrid([
    ui.statCard({
      label: 'Environment',
      value: fmt.humanise(env.nodeEnv),
      hint: env.backendUrl || 'No public URL configured',
      icon: 'las la-server',
      tone: env.nodeEnv === 'production' ? 'danger' : 'info',
    }),
    ui.statCard({
      label: 'Database',
      value: fmt.humanise(env.database),
      hint: env.database === 'connected' ? 'Reads and writes are working' : 'The platform cannot store anything',
      icon: 'las la-database',
      tone: env.database === 'connected' ? 'success' : 'danger',
    }),
    ui.statCard({
      label: 'Operators',
      value: fmt.number(settings.adminCount),
      hint: 'Accounts that can sign into this console',
      icon: 'las la-user-shield',
      tone: 'navy',
    }),
    ui.statCard({
      label: 'Integrations live',
      value: `${integrationRows.filter((i) => i.on).length} of ${integrationRows.length}`,
      hint: 'External services this deployment can reach',
      icon: 'las la-plug',
      tone: integrationRows.every((i) => i.on) ? 'success' : 'warning',
    }),
  ])}

      <div class="row">
        <div class="col-xl-7 col-lg-12">
          ${ui.card({
    title: 'Integrations',
    subtitle: 'Read from the running process — this is what the apps actually get.',
    body: ui.table({
      columns: [
        { key: 'label', label: 'Service', cell: (i) => ui.identity({ title: i.label, subtitle: i.what }) },
        {
          key: 'on',
          label: 'State',
          cell: (i) => (i.on ? ui.badge('Configured', 'success') : ui.badge('Not configured', 'warning')),
        },
        { key: 'without', label: 'While unconfigured', cell: (i) => (i.on ? '—' : i.without) },
      ],
      rows: integrationRows,
    }),
  })}

          ${ui.card({
    title: 'Business rules in force',
    subtitle: 'Read from the backend, which reads them from the platform documents.',
    body: ui.details([
      ['Points to the dinar', `${fmt.number(cfg.pointsPerTnd)} points = 1 TND`],
      ['Club diamonds', `${fmt.number(cfg.diamondsPerTnd)} diamonds = 1 TND`],
      ['Default earn rate', `${cfg.earnRate.default} points per dinar spent`],
      ['Giftback', `Change under ${cfg.giftback.MAX_CHANGE_TND} TND, capped at `
        + `${cfg.giftback.MONTHLY_CAP_TND} TND per customer per month, active after `
        + `${cfg.giftback.ACTIVATION_DELAY_HOURS} hours`],
      ['Guarantee refunds', `Once every ${cfg.refund.CYCLE_DAYS} days, minimum `
        + `${cfg.refund.MIN_TND} TND, reviewed within ${cfg.refund.REVIEW_WORKING_DAYS} working days`],
      ['Offer edit cooldown', `${cfg.editCooldown.CATALOG_HOURS}h on catalogue offers, `
        + `${cfg.editCooldown.STORE_DISCOUNT_HOURS}h on the shop-wide discount`],
      ['Plans', html`${(cfg.plans || []).map((p) => html`
                  <div>${fmt.humanise(p.key)} — ${p.monthlyFeeTnd} TND/month, ${p.commissionPercent}% commission</div>`)}`],
    ]),
  })}
        </div>

        <div class="col-xl-5 col-lg-12">
          ${ui.card({
    title: 'Admin roster',
    subtitle: settings.adminsTruncated
      ? `Showing ${settings.admins.length} of ${fmt.number(settings.adminCount)} — the full list is on the Operators screen.`
      : 'Everyone who can sign into this console.',
    actions: html`
              ${auth.can('settings.update')
    ? ui.button({ label: 'Add admin', icon: 'las la-user-plus', size: 'sm', action: 'add-admin' })
    : ''}
              ${auth.can('staff.read')
    ? ui.button({ label: 'Operators', tone: 'secondary', size: 'sm', action: 'staff' })
    : ''}`,
    body: ui.table({
      columns: [
        { key: 'fullName', label: 'Admin', cell: (a) => ui.identity({ title: a.fullName, subtitle: a.email }) },
        { key: 'isActive', label: 'Status', cell: (a) => ui.statusBadge(a.isActive === false ? 'inactive' : 'active') },
        { key: 'lastLogin', label: 'Last seen', cell: (a) => (a.lastLogin ? fmt.ago(a.lastLogin) : 'Never') },
        {
          key: 'actions',
          label: '',
          align: 'end',
          cell: (a) => (auth.can('settings.update')
            ? ui.rowAction({ icon: 'las la-trash', title: 'Remove', action: 'remove-admin', id: a._id, tone: 'danger' })
            : ''),
        },
      ],
      rows: settings.admins,
      empty: 'No admin accounts.',
      rowAttrs: (a) => `data-id="${a._id}" data-name="${ui.esc(a.fullName)}"`,
    }),
  })}
        </div>
      </div>`));

    ui.actions(host, {
      staff: () => go('/staff'),

      'add-admin': async () => {
        const created = await ui.modal({
          title: 'Add an admin',
          submitLabel: 'Create admin',
          body: html`
            ${ui.note('This creates a full admin account. For a narrower role — a cashier, a '
              + 'viewer — use the Operators screen instead.')}
            ${ui.field({ name: 'fullName', label: 'Full name', required: true })}
            ${ui.fieldRow(
    ui.field({ name: 'email', label: 'Email', type: 'email', required: true }),
    ui.field({ name: 'phone', label: 'Phone', required: true }),
  )}
            ${ui.field({
    name: 'password',
    label: 'Password',
    type: 'password',
    required: true,
    attrs: 'minlength="6"',
  })}`,
          onSubmit: async (values) => {
            const response = await api.post('/settings/admins', values);
            ui.toast(response.message || 'Admin added.');
            return true;
          },
        });
        if (created) ctx.reload();
      },

      'remove-admin': async ({ id }) => {
        const name = host.querySelector(`tr[data-id="${id}"]`)?.dataset.name || 'this admin';
        const ok = await ui.confirm({
          title: 'Remove this admin?',
          message: `${name} will lose access to the console.`,
          detail: 'The last remaining admin cannot be removed, and you cannot remove yourself.',
          submitLabel: 'Remove admin',
        });
        if (!ok) return;
        const response = await api.del(`/settings/admins/${id}`);
        ui.toast(response.message || 'Admin removed.', 'warning');
        ctx.reload();
      },
    });

    return undefined;
  },
};
