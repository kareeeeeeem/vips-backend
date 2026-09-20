/**
 * Visitors and conversion.
 *
 * Sessions here are anonymous by design, and the backend says so in
 * `trackingNote`. That note is shown rather than hidden, because a
 * conversion rate whose denominator nobody understands invites exactly the
 * wrong decisions.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';

const { html } = ui;

export default {
  title: 'Visitors',
  subtitle: 'App sessions, screens and conversion',
  permission: 'analytics.read',

  async render(host, ctx) {
    const days = ctx.query.days || '30';
    const d = await api.get('/analytics/overview', { days });

    host.append(ui.filterBar({
      values: { days },
      onChange: (values) => ctx.setQuery(values),
      fields: [{
        name: 'days',
        type: 'select',
        label: 'Window',
        options: [
          { value: '7', label: 'Last 7 days' },
          { value: '30', label: 'Last 30 days' },
          { value: '90', label: 'Last 90 days' },
        ],
      }],
    }));

    const conv = d.conversion || {};

    host.append(ui.node(html`
      ${d.trackingNote ? ui.note(d.trackingNote) : ''}
      ${d.tracking === false
    ? ui.note('No visitor data has been recorded yet, so the figures below are empty rather than zero.',
      'warning')
    : ''}

      ${ui.statGrid([
    ui.statCard({
      label: 'Sessions',
      value: fmt.number(d.visitors.total),
      hint: `${fmt.number(d.visitors.inWindow)} in this window · ${fmt.number(d.visitors.today)} today`,
      icon: 'las la-eye',
      tone: 'navy',
    }),
    ui.statCard({
      label: 'Screen views',
      value: fmt.number(d.visitors.screenViews),
      hint: `${fmt.number(d.visitors.signedIn)} sessions belonged to a signed-in person`,
      icon: 'las la-mobile',
      tone: 'info',
    }),
    ui.statCard({
      label: 'Conversion',
      value: conv.measurable === false ? '—' : fmt.percent(conv.rate),
      hint: conv.measurable === false
        ? (conv.reason || 'Not measurable for this window')
        : `${fmt.number(conv.orders)} orders from ${fmt.number(conv.visitors)} sessions`,
      icon: 'las la-funnel-dollar',
      tone: 'base',
    }),
    ui.statCard({
      label: 'Buyers',
      value: fmt.number(d.customers.buyersInWindow),
      hint: `${fmt.number(d.customers.newInWindow)} new customers · `
        + `${fmt.percent(conv.buyerRate)} of sessions bought`,
      icon: 'las la-shopping-basket',
      tone: 'success',
    }),
    ui.statCard({
      label: 'Merchants',
      value: fmt.number(d.merchants.total),
      hint: `${fmt.number(d.merchants.active)} live · ${fmt.number(d.merchants.pendingApproval)} awaiting approval`,
      icon: 'las la-store',
      tone: d.merchants.pendingApproval ? 'warning' : 'base',
    }),
  ])}

      ${ui.chartCard({
    id: 'chart-visitors',
    title: 'Sessions per day',
    subtitle: conv.trackingStartedAt
      ? `Tracking began ${fmt.date(conv.trackingStartedAt)}.`
      : undefined,
    height: 320,
  })}

      <div class="row">
        <div class="col-xl-7 col-lg-12">
          ${ui.card({
    title: 'Most visited screens',
    body: ui.table({
      columns: [
        { key: 'screen', label: 'Screen', cell: (s) => ui.identity({ title: s.screen, initials: '▤' }) },
        { key: 'views', label: 'Views', align: 'end', cell: (s) => fmt.number(s.views) },
        { key: 'sessions', label: 'Sessions', align: 'end', cell: (s) => fmt.number(s.sessions) },
        {
          key: 'perSession',
          label: 'Views per session',
          align: 'end',
          cell: (s) => (s.sessions ? (s.views / s.sessions).toFixed(1) : '—'),
        },
      ],
      rows: d.topScreens,
      empty: 'No screen views recorded yet.',
    }),
  })}
        </div>
        <div class="col-xl-5 col-lg-12">
          ${ui.card({
    title: 'By app',
    body: ui.table({
      columns: [
        { key: 'app', label: 'App', cell: (a) => fmt.humanise(a.app) },
        { key: 'sessions', label: 'Sessions', align: 'end', cell: (a) => fmt.number(a.sessions) },
      ],
      rows: d.byApp,
      empty: 'No sessions recorded.',
    }),
  })}

          ${ui.card({
    title: 'By platform',
    body: ui.table({
      columns: [
        { key: 'platform', label: 'Platform', cell: (p) => fmt.humanise(p.platform) },
        { key: 'sessions', label: 'Sessions', align: 'end', cell: (p) => fmt.number(p.sessions) },
      ],
      rows: d.byPlatform,
      empty: 'No sessions recorded.',
    }),
  })}
        </div>
      </div>`));

    const byDay = d.visitorsByDay || [];
    const chart = ui.timeSeries(host.querySelector('#chart-visitors'), {
      categories: byDay.map((p) => fmt.date(p.date)),
      series: [{ name: 'Sessions', data: byDay.map((p) => p.value) }],
      height: 320,
    });

    return () => chart?.destroy();
  },
};
