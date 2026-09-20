/**
 * The signed-in operator: who they are and exactly what they may do.
 *
 * The permission list is spelled out rather than summarised, because "why
 * can't I see the reports screen" is the question this page exists to answer.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';

const { html } = ui;

export default {
  title: 'My profile',
  subtitle: 'Your account and what it can reach',

  async render(host) {
    const me = await api.get('/me');
    const catalogue = await api.get('/permissions').catch(() => null);

    const { user, adminRole, permissions } = me;
    const everything = permissions.includes('*');

    // Group the granted permissions by module so the list reads as
    // capabilities rather than as forty-eight strings.
    const grouped = {};
    if (catalogue && !everything) {
      for (const item of catalogue.catalogue) {
        if (!auth.can(item.key)) continue;
        (grouped[item.module] ||= []).push(item);
      }
    }

    host.append(ui.node(html`
      ${ui.statGrid([
    ui.statCard({
      label: 'Signed in as',
      value: user.fullName || user.email,
      hint: user.email,
      icon: 'las la-user-circle',
      tone: 'navy',
    }),
    ui.statCard({
      label: 'Role',
      value: fmt.humanise(adminRole || 'viewer'),
      hint: everything ? 'Holds the full permission set' : `${permissions.length} permissions in effect`,
      icon: 'las la-user-shield',
      tone: adminRole === 'super_admin' ? 'danger' : 'base',
    }),
    ui.statCard({
      label: 'Last sign-in',
      value: user.lastLogin ? fmt.ago(user.lastLogin) : 'This is your first',
      hint: user.lastLogin ? fmt.dateTime(user.lastLogin) : '',
      icon: 'las la-clock',
      tone: 'info',
    }),
  ])}

      <div class="row">
        <div class="col-xl-5 col-lg-12">
          ${ui.card({
    title: 'Account',
    body: ui.details([
      ['Name', user.fullName],
      ['Email', user.email],
      ['Phone', user.phone || '—'],
      ['Role', ui.badge(fmt.humanise(adminRole || 'viewer'), adminRole === 'super_admin' ? 'danger' : 'base')],
      ['Status', ui.statusBadge(user.isActive === false ? 'inactive' : 'active')],
      ['Account created', fmt.dateTime(user.createdAt)],
      ['Account id', html`<code>${user._id}</code>`],
    ]),
  })}

          ${ui.card({
    title: 'Signing out',
    body: html`
              <p>Signing out clears the session token stored in this browser. It does not affect
              your account or any other device.</p>
              <div class="filter-actions" style="margin-top:12px">
                ${ui.button({ label: 'Sign out', icon: 'las la-sign-out-alt', tone: 'danger', size: 'sm', action: 'signout' })}
              </div>`,
  })}
        </div>

        <div class="col-xl-7 col-lg-12">
          ${ui.card({
    title: 'What you can do',
    subtitle: 'Checked on the server for every request — the console only hides what you cannot use.',
    body: everything
      ? html`
                  ${ui.note('You hold the full permission set (*). Every action in the console is '
        + 'available to you, including granting roles to others.', 'warning')}`
      : (Object.keys(grouped).length
        ? html`
                    <div class="permission-grid permission-grid--readonly">
                      ${Object.entries(grouped).map(([mod, items]) => html`
                        <div class="permission-module">
                          <h6>${fmt.humanise(mod)}</h6>
                          ${items.map((i) => html`
                            <div class="permission-line">
                              <i class="las la-check text--success"></i>
                              <span>${i.label}${i.enforced ? '' : html`
                                <em class="cell-sub">— declared, not yet enforced</em>`}</span>
                            </div>`)}
                        </div>`)}
                    </div>`
        : ui.emptyState('Your role carries no permissions.',
          'Ask a super admin to assign you one.')),
  })}

          ${user.permissions?.length ? ui.card({
    title: 'Granted on top of your role',
    subtitle: 'Extras assigned to you personally.',
    body: html`<div class="chip-list">
              ${user.permissions.map((p) => ui.badge(p, 'info'))}
            </div>`,
  }) : ''}
        </div>
      </div>`));

    ui.actions(host, {
      signout: async () => {
        const ok = await ui.confirm({
          title: 'Sign out?',
          message: 'You will need to sign in again to use the console.',
          submitLabel: 'Sign out',
        });
        if (ok) {
          await auth.signOut();
          window.location.reload();
        }
      },
    });

    return undefined;
  },
};
