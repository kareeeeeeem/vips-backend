/**
 * One audit entry, including exactly what was sent.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import { go } from '../core/router.js';

const { html } = ui;

/** Where a target of this type lives in the console. */
const TARGET_ROUTE = {
  user: (id) => `/customers/${id}`,
  customer: (id) => `/customers/${id}`,
  merchant: (id) => `/merchants/${id}`,
  order: (id) => `/orders/${id}`,
};

export default {
  title: 'Audit entry',
  permission: 'settings.read',

  async render(host, ctx) {
    const { entry: log } = await api.get(`/audit/logs/${ctx.params.id}`);

    document.getElementById('page-title').textContent = log.action || 'Audit entry';
    document.getElementById('page-subtitle').textContent =
      `${log.actorName || 'Unknown operator'} · ${fmt.dateTime(log.createdAt)}`;

    const targetLink = log.targetType && log.targetId && TARGET_ROUTE[log.targetType]
      ? TARGET_ROUTE[log.targetType](log.targetId)
      : null;

    host.append(ui.node(html`
      <div class="row">
        <div class="col-xl-6 col-lg-12">
          ${ui.card({
    title: 'What happened',
    actions: ui.button({ label: 'Back to the log', icon: 'las la-arrow-left', tone: 'secondary', size: 'sm', action: 'back' }),
    body: ui.details([
      ['Result', log.success
        ? ui.badge(`${log.statusCode} — succeeded`, 'success')
        : ui.badge(`${log.statusCode} — refused`, 'danger')],
      log.message ? ['Server said', log.message] : null,
      ['Request', html`<code>${log.method} ${log.path}</code>`],
      ['Target', log.targetType
        ? html`${fmt.humanise(log.targetType)} <code>${log.targetId}</code>
                    ${targetLink ? html` <button type="button" class="row-action" data-action="open-target"
                      title="Open"><i class="las la-external-link-alt"></i></button>` : ''}`
        : '—'],
      ['When', fmt.dateTime(log.createdAt)],
      ['Entry id', html`<code>${log._id}</code>`],
    ]),
  })}
        </div>

        <div class="col-xl-6 col-lg-12">
          ${ui.card({
    title: 'Who',
    body: ui.details([
      ['Operator', log.actorName || 'Unknown'],
      ['Email', log.actorEmail || '—'],
      ['Role', fmt.humanise(log.actorRole)],
      ['Address', log.ip || '—'],
      ['Operator id', log.actorId ? html`<code>${log.actorId}</code>` : '—'],
    ]),
  })}

          ${ui.card({
    title: 'What was sent',
    subtitle: 'The request body, as the server recorded it.',
    body: log.changes && Object.keys(log.changes).length
      ? html`<pre class="code-block">${JSON.stringify(log.changes, null, 2)}</pre>`
      : ui.emptyState('This request carried no body.'),
  })}
        </div>
      </div>`));

    ui.actions(host, {
      back: () => go('/audit'),
      'open-target': () => targetLink && go(targetLink),
    });

    return undefined;
  },
};
