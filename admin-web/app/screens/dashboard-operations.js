/**
 * Operations: where the order queue actually is.
 *
 * The figures a rise in is bad — cancellations, fulfilment time — carry
 * flipped delta colouring, so a worsening number never reads as green.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as kit from '../core/dashboard-kit.js';
import { go } from '../core/router.js';

const { html } = ui;

export default {
  title: 'Operations',
  subtitle: 'The order queue and how fast it clears',
  permission: 'dashboard.read',

  async render(host, ctx) {
    const query = kit.readQuery(ctx.query);
    const d = await api.get('/dashboards/operations', query);

    host.append(kit.periodBar({
      query,
      exportName: 'operations',
      onChange: (values) => ctx.setQuery(values),
    }));

    const fulfilment = d.fulfillmentSampleSize
      ? `${fmt.number(d.averageFulfillmentMinutes)} min, over ${fmt.number(d.fulfillmentSampleSize)} completed order${d.fulfillmentSampleSize === 1 ? '' : 's'}`
      : 'No order completed in this window';

    host.append(ui.node(html`
      ${kit.windowNote(d.window)}

      ${ui.statGrid([
    ui.statCard({
      label: 'Orders in window',
      value: fmt.number(d.totalOrders),
      hint: `${fmt.number(d.completedOrders)} completed`,
      icon: 'las la-shopping-bag',
      tone: 'info',
    }),
    ui.statCard({
      label: 'Waiting',
      value: fmt.number(d.pendingOrders),
      hint: `${fmt.number(d.inProgressOrders)} more already in progress`,
      icon: 'las la-hourglass-half',
      tone: d.pendingOrders ? 'warning' : 'success',
    }),
    ui.statCard({
      label: 'Cancellation rate',
      value: fmt.percent(d.cancellationRate),
      hint: `${fmt.number(d.cancelledOrders)} cancelled`,
      icon: 'las la-times-circle',
      tone: d.cancellationRate > 10 ? 'danger' : 'base',
    }),
    ui.statCard({
      label: 'Average fulfilment',
      value: d.fulfillmentSampleSize ? `${fmt.number(d.averageFulfillmentTime)} h` : '—',
      hint: fulfilment,
      icon: 'las la-stopwatch',
      tone: 'navy',
      chips: kit.chips(kit.deltaChip(d.change.averageFulfillmentTime, { higherIsBetter: false })),
    }),
    ui.statCard({
      label: 'Unpaid',
      value: fmt.number(d.unpaidOrders),
      hint: 'Orders with payment still outstanding',
      icon: 'las la-credit-card',
      tone: d.unpaidOrders ? 'warning' : 'success',
    }),
  ])}

      <div class="row">
        <div class="col-xl-5 col-lg-12">
          ${ui.chartCard({ id: 'chart-status', title: 'Where the queue sits', height: 320 })}
        </div>
        <div class="col-xl-7 col-lg-12">
          ${ui.card({
    title: 'Orders by status',
    subtitle: 'Click a status to open it in the order list.',
    body: ui.table({
      columns: [
        { key: 'status', label: 'Status', cell: (s) => ui.statusBadge(s.status) },
        { key: 'count', label: 'Orders', align: 'end', cell: (s) => fmt.number(s.count) },
        { key: 'value', label: 'Value', align: 'end', cell: (s) => ui.money(s.value) },
      ],
      rows: d.orderStatusDistribution,
      empty: 'No orders in this window.',
      rowAttrs: (s) => `data-status="${s.status}"`,
    }),
  })}
        </div>
      </div>`));

    kit.wireExport(host, 'operations', query);

    host.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-status]');
      if (row) go('/orders', { status: row.dataset.status });
    });

    const dist = d.orderStatusDistribution || [];
    const chart = dist.length
      ? ui.donut(host.querySelector('#chart-status'), {
        series: dist.map((s) => s.count),
        labels: dist.map((s) => fmt.humanise(s.status)),
        height: 320,
        formatter: (total) => `${fmt.number(total)} orders`,
      })
      : ui.render(host.querySelector('#chart-status'), ui.emptyState('No orders in this window.')) && null;

    return () => chart?.destroy();
  },
};
