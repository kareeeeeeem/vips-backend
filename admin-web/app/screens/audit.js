/**
 * The audit log: every change an operator made.
 *
 * Reads are not recorded — a hundred page loads between two bans makes the
 * bans harder to find, not easier — so everything here is something that
 * changed, or tried to. Failed attempts are kept and marked, because a
 * refused action is often the more interesting entry.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import { go } from '../core/router.js';

const { html } = ui;

const METHOD_TONE = { POST: 'success', PUT: 'warning', PATCH: 'warning', DELETE: 'danger' };

export default {
  title: 'Audit log',
  subtitle: 'Every change made from this console',
  permission: 'settings.read',

  async render(host, ctx) {
    const query = {
      actorId: ctx.query.actorId || '',
      targetType: ctx.query.targetType || '',
      method: ctx.query.method || '',
      from: ctx.query.from || '',
      to: ctx.query.to || '',
      page: ctx.query.page || '1',
    };

    const panel = ui.node(ui.card({ title: 'Changes', body: html`${''}` }));
    host.append(panel);

    const cardBody = panel.querySelector('.card-body');
    const body = ui.node(html`<div></div>`);
    const filterHost = ui.node(html`<div></div>`);
    cardBody.append(filterHost, body);

    async function load() {
      ui.render(body, ui.loadingState('Loading the audit log…'));
      let data;
      try {
        data = await api.get('/audit/logs', query);
      } catch (error) {
        ui.render(body, ui.errorState(error, load));
        return;
      }

      // The actor and target lists come back with the results, so the filters
      // offer exactly who and what appears in the log.
      ui.render(filterHost, '');
      filterHost.append(ui.filterBar({
        values: query,
        onChange: (values) => ctx.setQuery({ ...values, page: 1 }),
        fields: [
          {
            name: 'actorId',
            type: 'select',
            label: 'Operator',
            options: [
              { value: '', label: 'Anyone' },
              ...(data.actors || []).map((a) => ({
                value: a.actorId,
                label: `${a.name} (${a.entries})`,
              })),
            ],
          },
          {
            name: 'targetType',
            type: 'select',
            label: 'Target',
            options: [{ value: '', label: 'Anything' }, ...(data.targetTypes || []).filter(Boolean)],
          },
          {
            name: 'method',
            type: 'select',
            label: 'Kind',
            options: [
              { value: '', label: 'Any change' },
              { value: 'POST', label: 'Created' },
              { value: 'PUT', label: 'Updated' },
              { value: 'DELETE', label: 'Deleted' },
            ],
          },
          { name: 'from', type: 'date', label: 'From' },
          { name: 'to', type: 'date', label: 'To' },
        ],
      }));

      ui.render(body, ui.table({
        columns: [
          {
            key: 'actorName',
            label: 'Operator',
            cell: (l) => ui.identity({ title: l.actorName || 'Unknown', subtitle: l.actorEmail }),
          },
          {
            key: 'method',
            label: 'Change',
            cell: (l) => html`${ui.badge(l.method, METHOD_TONE[l.method] || 'info')}
              <span class="cell-sub">${l.path}</span>`,
          },
          {
            key: 'targetType',
            label: 'Target',
            cell: (l) => (l.targetType
              ? html`${fmt.humanise(l.targetType)}<span class="cell-sub">${fmt.shortId(l.targetId)}</span>`
              : '—'),
          },
          {
            key: 'success',
            label: 'Result',
            cell: (l) => (l.success
              ? ui.badge(String(l.statusCode), 'success')
              : html`${ui.badge(String(l.statusCode), 'danger')}
                  <span class="cell-sub">${l.message || 'Refused'}</span>`),
          },
          { key: 'createdAt', label: 'When', cell: (l) => fmt.dateTime(l.createdAt) },
          {
            key: 'actions',
            label: '',
            align: 'end',
            cell: (l) => ui.rowAction({ icon: 'las la-eye', title: 'Open', action: 'open', id: l._id }),
          },
        ],
        rows: data.items,
        empty: 'No change matches those filters.',
        rowAttrs: (l) => `data-href="/audit/${l._id}"`,
      }));

      const pager = ui.pagination(data, (page) => ctx.setQuery({ ...query, page }));
      if (pager) body.append(pager);
    }

    ui.actions(host, { open: ({ id }) => go(`/audit/${id}`) });

    body.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-href]');
      if (row && !event.target.closest('button, a')) go(row.dataset.href);
    });

    await load();
    return undefined;
  },
};
