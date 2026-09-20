/**
 * Marketing: the customer base and how it is growing.
 *
 * Churn is reported with its definition attached. "Churn" means something
 * different in every company, and a percentage whose rule is not written
 * down is a number people argue about rather than act on.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as kit from '../core/dashboard-kit.js';
import { go } from '../core/router.js';

const { html } = ui;

export default {
  title: 'Marketing',
  subtitle: 'The customer base, growth and segments',
  permission: 'reports.read',

  async render(host, ctx) {
    const query = kit.readQuery(ctx.query);
    const d = await api.get('/dashboards/marketing', query);

    host.append(kit.periodBar({
      query,
      exportName: 'marketing',
      onChange: (values) => ctx.setQuery(values),
    }));

    const verifiedShare = d.totalCustomers
      ? (d.verifiedCustomers / d.totalCustomers) * 100
      : 0;

    host.append(ui.node(html`
      ${kit.windowNote(d.window)}

      ${ui.statGrid([
    ui.statCard({
      label: 'Customers',
      value: fmt.number(d.totalCustomers),
      hint: `${fmt.number(d.enabledCustomers)} able to sign in`,
      icon: 'las la-users',
      tone: 'navy',
    }),
    ui.statCard({
      label: 'New in window',
      value: fmt.number(d.newCustomers),
      hint: `Previously ${fmt.number(d.previous.newCustomers)}`,
      icon: 'las la-user-plus',
      tone: 'success',
      chips: kit.chips(kit.deltaChip(d.change.newCustomers)),
    }),
    ui.statCard({
      label: 'Bought in window',
      value: fmt.number(d.activeCustomers),
      hint: `Previously ${fmt.number(d.previous.activeCustomers)}`,
      icon: 'las la-shopping-basket',
      tone: 'info',
      chips: kit.chips(kit.deltaChip(d.change.activeCustomers)),
    }),
    ui.statCard({
      label: 'Verified',
      value: fmt.number(d.verifiedCustomers),
      hint: `${fmt.percent(verifiedShare)} of the base has confirmed their contact details`,
      icon: 'las la-user-check',
      tone: verifiedShare < 50 ? 'warning' : 'success',
    }),
    ui.statCard({
      label: 'Churn',
      value: d.churnRate === null ? '—' : fmt.percent(d.churnRate),
      hint: d.churnRate === null
        ? 'Not computable for this window'
        : `${fmt.number(d.churnedCustomers)} of ${fmt.number(d.churnBaseline)} who bought last period`,
      icon: 'las la-user-minus',
      tone: 'base',
    }),
  ])}

      ${d.churnDefinition ? ui.note(`How churn is counted here: ${d.churnDefinition}`) : ''}

      <div class="row">
        <div class="col-xl-7 col-lg-12">
          ${ui.chartCard({
    id: 'chart-growth',
    title: 'Customer growth',
    subtitle: 'New sign-ups per bucket across the window.',
    height: 320,
  })}
        </div>
        <div class="col-xl-5 col-lg-12">
          ${ui.chartCard({ id: 'chart-segments', title: 'Segments', height: 320 })}
        </div>
      </div>

      ${ui.card({
    title: 'Segments',
    subtitle: 'How the base divides up in this window.',
    actions: ui.button({ label: 'All customers', tone: 'secondary', size: 'sm', action: 'customers' }),
    body: ui.table({
      columns: [
        { key: 'segment', label: 'Segment', cell: (s) => ui.identity({ title: fmt.humanise(s.segment) }) },
        { key: 'count', label: 'Customers', align: 'end', cell: (s) => fmt.number(s.count) },
        {
          key: 'share',
          label: 'Share',
          align: 'end',
          cell: (s) => fmt.percent(d.totalCustomers ? (s.count / d.totalCustomers) * 100 : 0),
        },
      ],
      rows: d.customerSegments,
      empty: 'No segment data for this window.',
    }),
  })}`));

    kit.wireExport(host, 'marketing', query);
    ui.actions(host, { customers: () => go('/customers') });

    const growth = d.customerGrowthChart || [];
    const growthChart = ui.timeSeries(host.querySelector('#chart-growth'), {
      categories: growth.map((p) => p.date),
      height: 320,
      series: [{ name: 'New customers', data: growth.map((p) => p.value) }],
    });

    const segments = d.customerSegments || [];
    const segmentChart = segments.length
      ? ui.donut(host.querySelector('#chart-segments'), {
        series: segments.map((s) => s.count),
        labels: segments.map((s) => fmt.humanise(s.segment)),
        height: 320,
        formatter: (total) => `${fmt.number(total)} customers`,
      })
      : ui.render(host.querySelector('#chart-segments'), ui.emptyState('No segment data.')) && null;

    return () => {
      growthChart?.destroy();
      segmentChart?.destroy();
    };
  },
};
