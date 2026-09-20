/**
 * Sales: what was sold, through which channel, and what moved.
 *
 * Online and till revenue are shown as separate figures rather than one
 * total, because they arrive from different collections (Order and
 * PosInvoice) and a shop's split between them is the thing worth watching.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as kit from '../core/dashboard-kit.js';

const { html } = ui;

export default {
  title: 'Sales',
  subtitle: 'Revenue, orders and what is selling',
  permission: 'reports.read',

  async render(host, ctx) {
    const query = kit.readQuery(ctx.query);
    const d = await api.get('/dashboards/sales', query);

    host.append(kit.periodBar({
      query,
      exportName: 'sales',
      onChange: (values) => ctx.setQuery(values),
    }));

    host.append(ui.node(html`
      ${kit.windowNote(d.window)}

      ${ui.statGrid([
    ui.statCard({
      label: 'Revenue',
      value: fmt.tnd(d.totalRevenue),
      hint: `Previously ${fmt.tnd(d.previous.totalRevenue)}`,
      icon: 'las la-coins',
      tone: 'success',
      chips: kit.chips(kit.deltaChip(d.change.totalRevenue)),
    }),
    ui.statCard({
      label: 'Orders',
      value: fmt.number(d.totalOrders),
      hint: `Previously ${fmt.number(d.previous.totalOrders)}`,
      icon: 'las la-shopping-bag',
      tone: 'info',
      chips: kit.chips(kit.deltaChip(d.change.totalOrders)),
    }),
    ui.statCard({
      label: 'Average order',
      value: fmt.tnd(d.averageOrderValue),
      hint: `Previously ${fmt.tnd(d.previous.averageOrderValue)}`,
      icon: 'las la-receipt',
      tone: 'navy',
      chips: kit.chips(kit.deltaChip(d.change.averageOrderValue)),
    }),
    ui.statCard({
      label: 'Channel split',
      value: fmt.tnd(d.onlineRevenue),
      hint: `Online · ${fmt.tnd(d.posRevenue)} taken at the till`,
      icon: 'las la-store-alt',
      tone: 'base',
    }),
  ])}

      ${d.conversionRate === null && d.conversionRateNote ? kit.notTracked(d.conversionRateNote) : ''}
      ${d.unattributedRevenue
    ? ui.note(`${fmt.tnd(d.unattributedRevenue)} of this revenue is not attached to any merchant — `
        + 'seeded deals commonly have no shop behind them, so it belongs to the platform rather '
        + 'than to a partner.', 'warning')
    : ''}

      ${ui.chartCard({
    id: 'chart-sales',
    title: 'Revenue over time',
    subtitle: 'Bars are orders; the line is revenue in dinars.',
    height: 340,
  })}

      ${ui.card({
    title: 'Top products',
    subtitle: 'By revenue in this window.',
    body: ui.table({
      columns: [
        { key: 'name', label: 'Product', cell: (p) => ui.identity({ title: p.name }) },
        { key: 'sales', label: 'Units', align: 'end', cell: (p) => fmt.number(p.sales) },
        { key: 'revenue', label: 'Revenue', align: 'end', cell: (p) => ui.money(p.revenue) },
      ],
      rows: d.topProducts,
      empty: 'Nothing sold in this window.',
    }),
  })}`));

    kit.wireExport(host, 'sales', query);

    const series = d.salesChart || [];
    const chart = ui.chart(host.querySelector('#chart-sales'), {
      series: [
        { name: 'Revenue (TND)', type: 'area', data: series.map((p) => p.value) },
        { name: 'Orders', type: 'column', data: series.map((p) => p.orders) },
      ],
      chart: { type: 'line', height: 340, stacked: false },
      stroke: { curve: 'smooth', width: [2.5, 0] },
      plotOptions: { bar: { columnWidth: '45%', borderRadius: 3 } },
      fill: {
        type: ['gradient', 'solid'],
        gradient: { opacityFrom: 0.35, opacityTo: 0.02 },
      },
      xaxis: {
        categories: series.map((p) => p.date),
        labels: { style: { colors: '#9097a7', fontSize: '11px' }, rotate: -40, hideOverlappingLabels: true },
        axisBorder: { show: false }, axisTicks: { show: false },
      },
      yaxis: [
        { labels: { style: { colors: '#9097a7' }, formatter: (v) => fmt.compact(v) }, title: { text: 'Revenue' } },
        { opposite: true, labels: { style: { colors: '#9097a7' }, formatter: (v) => fmt.compact(v) }, title: { text: 'Orders' } },
      ],
      legend: { position: 'top', horizontalAlign: 'right' },
    });

    return () => chart?.destroy();
  },
};
