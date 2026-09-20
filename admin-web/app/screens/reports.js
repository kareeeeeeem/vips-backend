/**
 * The seven reports, on one screen with seven shapes.
 *
 * They share a filter bar (date range, grouping, export) because they share
 * a query contract; what differs is only how each payload is laid out, which
 * is what REPORTS below describes. One screen keeps the date handling and
 * the export button identical across all of them — a report whose range
 * behaved differently from its neighbour would be the bug worth avoiding.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';
import { go } from '../core/router.js';

const { html } = ui;

const GROUPINGS = ['day', 'week', 'month', 'year'];

/** Small helpers so each report body stays about layout, not plumbing. */
const tile = (label, value, hint, icon, tone) => ui.statCard({ label, value, hint, icon, tone });

const seriesChart = (id, title, subtitle, height = 320) =>
  ui.chartCard({ id, title, subtitle, height });

const REPORTS = {
  sales: {
    title: 'Sales report',
    subtitle: 'Revenue by period, payment method and merchant',
    render: (d) => ({
      tiles: [
        tile('Revenue', fmt.tnd(d.summary.revenue), `${fmt.number(d.summary.orders)} orders`, 'las la-coins', 'success'),
        tile('Average order', fmt.tnd(d.summary.averageOrderValue), 'Across the whole range', 'las la-receipt', 'navy'),
        tile('Online', fmt.tnd(d.summary.onlineRevenue), `${fmt.tnd(d.summary.posRevenue)} taken at the till`, 'las la-globe', 'info'),
        tile('Given away', fmt.tnd(d.summary.discounts), `${fmt.tnd(d.summary.tax)} tax · ${fmt.tnd(d.summary.deliveryCharges)} delivery`, 'las la-tags', 'warning'),
      ],
      chart: {
        host: 'chart-report',
        card: seriesChart('chart-report', 'Revenue over time', `Grouped by ${d.groupBy}.`),
        draw: (host) => ui.timeSeries(host, {
          categories: d.series.map((s) => s.period),
          series: [
            { name: 'Revenue (TND)', data: d.series.map((s) => s.revenue) },
            { name: 'Orders', data: d.series.map((s) => s.orders) },
          ],
        }),
      },
      tables: [
        {
          title: 'By payment method',
          columns: [
            { key: 'method', label: 'Method', cell: (r) => fmt.humanise(r.method) },
            { key: 'orders', label: 'Orders', align: 'end', cell: (r) => fmt.number(r.orders) },
            { key: 'revenue', label: 'Revenue', align: 'end', cell: (r) => ui.money(r.revenue) },
          ],
          rows: d.byPaymentMethod,
        },
        {
          title: 'Top merchants',
          columns: [
            { key: 'name', label: 'Merchant', cell: (r) => ui.identity({ title: r.name }) },
            { key: 'orders', label: 'Orders', align: 'end', cell: (r) => fmt.number(r.orders) },
            { key: 'revenue', label: 'Revenue', align: 'end', cell: (r) => ui.money(r.revenue) },
          ],
          rows: d.topMerchants,
          href: (r) => `/merchants/${r.merchantId}`,
        },
      ],
    }),
  },

  profit: {
    title: 'Profit report',
    subtitle: 'Margin, and how much of revenue it can actually be measured over',
    render: (d) => ({
      notes: d.summary.costCoverage < 100 ? [
        `Margin is computed over the ${fmt.percent(d.summary.costCoverage)} of revenue whose products `
        + `carry a cost price — ${fmt.number(d.summary.productsWithCost)} of `
        + `${fmt.number(d.summary.productsTotal)} products. The rest contributes revenue but no measurable cost.`,
      ] : [],
      tiles: [
        tile('Revenue', fmt.tnd(d.summary.revenue), `${fmt.number(d.summary.unitsSold)} units sold`, 'las la-coins', 'success'),
        tile('Cost of goods', fmt.tnd(d.summary.cost), `On ${fmt.tnd(d.summary.costedRevenue)} of costed revenue`, 'las la-dolly', 'info'),
        tile('Gross profit', fmt.tnd(d.summary.grossProfit), `Margin ${fmt.percent(d.summary.margin)}`, 'las la-chart-line', 'navy'),
        tile('Cost coverage', fmt.percent(d.summary.costCoverage), 'Share of revenue with a cost behind it', 'las la-tags',
          d.summary.costCoverage < 60 ? 'warning' : 'success'),
      ],
      chart: {
        card: seriesChart('chart-report', 'Revenue against cost', `Grouped by ${d.groupBy}.`),
        draw: (host) => ui.timeSeries(host, {
          categories: d.series.map((s) => s.period),
          type: 'line',
          series: [
            { name: 'Revenue', data: d.series.map((s) => s.revenue) },
            { name: 'Cost', data: d.series.map((s) => s.cost) },
            { name: 'Gross profit', data: d.series.map((s) => s.grossProfit) },
          ],
        }),
      },
      actions: [{ label: 'Products missing a cost price', action: 'no-cost', icon: 'las la-tags' }],
    }),
  },

  commission: {
    title: 'Commission report',
    subtitle: 'What the platform earned, and what merchants kept',
    render: (d) => ({
      notes: d.summary.merchantsOnZeroRate ? [
        `${fmt.number(d.summary.merchantsOnZeroRate)} merchant(s) are on a zero rate, so their sales `
        + 'contribute revenue but no commission. §5.3 puts commission between 0.5% and 3%.',
      ] : [],
      tiles: [
        tile('Revenue through VIPs', fmt.tnd(d.summary.revenue), `${fmt.number(d.summary.sellingMerchants)} merchants sold`, 'las la-coins', 'success'),
        tile('Commission earned', fmt.tnd(d.summary.commission), `Effective rate ${fmt.percent(d.summary.effectiveRate)}`, 'las la-percentage', 'base'),
        tile('Merchants kept', fmt.tnd(d.summary.merchantEarnings), 'Revenue net of commission', 'las la-store', 'navy'),
        tile('Rates set', fmt.number(d.summary.merchantsWithRateSet), `${fmt.number(d.summary.merchantsOnZeroRate)} on zero`, 'las la-sliders-h',
          d.summary.merchantsOnZeroRate ? 'warning' : 'success'),
      ],
      tables: [{
        title: 'By merchant',
        columns: [
          { key: 'name', label: 'Merchant', cell: (r) => ui.identity({ title: r.name }) },
          { key: 'orders', label: 'Orders', align: 'end', cell: (r) => fmt.number(r.orders) },
          { key: 'revenue', label: 'Revenue', align: 'end', cell: (r) => ui.money(r.revenue) },
          { key: 'commissionRate', label: 'Rate', align: 'end', cell: (r) => fmt.percent(r.commissionRate) },
          { key: 'commission', label: 'Commission', align: 'end', cell: (r) => ui.money(r.commission) },
          { key: 'merchantEarnings', label: 'Merchant kept', align: 'end', cell: (r) => ui.money(r.merchantEarnings) },
        ],
        rows: d.byMerchant,
        href: (r) => `/merchants/${r.merchantId}`,
      }],
    }),
  },

  products: {
    title: 'Products report',
    subtitle: 'What sold, and what did not',
    render: (d) => ({
      tiles: [
        tile('Products sold', fmt.number(d.summary.productsSold), `${fmt.number(d.summary.unitsSold)} units`, 'las la-box', 'success'),
        tile('Revenue', fmt.tnd(d.summary.revenue), 'From products in this range', 'las la-coins', 'navy'),
        tile('Sold nothing', fmt.number(d.summary.notSold), 'Listed products with no sale in this range', 'las la-box-open',
          d.summary.notSold ? 'warning' : 'success'),
      ],
      tables: [
        {
          title: 'Top by revenue',
          columns: [
            { key: 'name', label: 'Product', cell: (r) => ui.identity({ title: r.name }) },
            { key: 'units', label: 'Units', align: 'end', cell: (r) => fmt.number(r.units) },
            { key: 'orders', label: 'Orders', align: 'end', cell: (r) => fmt.number(r.orders) },
            { key: 'revenue', label: 'Revenue', align: 'end', cell: (r) => ui.money(r.revenue) },
          ],
          rows: d.topByRevenue,
        },
        {
          title: 'Top by units',
          columns: [
            { key: 'name', label: 'Product', cell: (r) => ui.identity({ title: r.name }) },
            { key: 'units', label: 'Units', align: 'end', cell: (r) => fmt.number(r.units) },
            { key: 'revenue', label: 'Revenue', align: 'end', cell: (r) => ui.money(r.revenue) },
          ],
          rows: d.topByUnits,
        },
        {
          title: 'Nothing sold',
          subtitle: 'Listed, in stock, and moved not a single unit in this range.',
          columns: [
            { key: 'name', label: 'Product', cell: (r) => ui.identity({ title: r.name, subtitle: r.category }) },
            { key: 'price', label: 'Price', align: 'end', cell: (r) => ui.money(r.price) },
            { key: 'stock', label: 'Stock', align: 'end', cell: (r) => fmt.number(r.stock) },
          ],
          rows: d.notSold,
          empty: 'Every listed product sold at least once.',
        },
      ],
    }),
  },

  customers: {
    title: 'Customers report',
    subtitle: 'Sign-ups, buyers and repeat business',
    render: (d) => ({
      tiles: [
        tile('Customers', fmt.number(d.summary.customers), `${fmt.number(d.summary.verified)} verified`, 'las la-users', 'navy'),
        tile('Signed up', fmt.number(d.summary.signupsInRange), 'New in this range', 'las la-user-plus', 'success'),
        tile('Bought', fmt.number(d.summary.buyers), `Conversion ${fmt.percent(d.summary.conversionRate)}`, 'las la-shopping-basket', 'info'),
        tile('Repeat buyers', fmt.number(d.summary.repeatBuyers), `${fmt.percent(d.summary.repeatRate)} of buyers came back`, 'las la-redo', 'base'),
        tile('Lifetime value', fmt.tnd(d.summary.lifetimeValue), 'Average spend per buying customer', 'las la-gem', 'success'),
      ],
      chart: {
        card: seriesChart('chart-report', 'Sign-ups', `Grouped by ${d.groupBy}.`),
        draw: (host) => ui.bars(host, {
          categories: d.signupsByPeriod.map((s) => s.period),
          series: [{ name: 'Sign-ups', data: d.signupsByPeriod.map((s) => s.signups) }],
        }),
      },
      tables: [{
        title: 'Top spenders',
        columns: [
          { key: 'name', label: 'Customer', cell: (r) => ui.identity({ title: r.name, subtitle: r.email }) },
          { key: 'orders', label: 'Orders', align: 'end', cell: (r) => fmt.number(r.orders) },
          { key: 'averageOrder', label: 'Average', align: 'end', cell: (r) => ui.money(r.averageOrder) },
          { key: 'spent', label: 'Spent', align: 'end', cell: (r) => ui.money(r.spent) },
        ],
        rows: d.topSpenders,
        href: (r) => `/customers/${r.userId}`,
      }],
    }),
  },

  merchants: {
    title: 'Merchants report',
    subtitle: 'Registration state, categories and performance',
    render: (d) => ({
      tiles: [
        tile('Merchants', fmt.number(d.summary.total), `${fmt.number(d.summary.registered)} submitted a registration`, 'las la-store', 'navy'),
        tile('Approved', fmt.number(d.summary.approved), `${fmt.number(d.summary.pending)} pending · ${fmt.number(d.summary.rejected)} rejected`, 'las la-check-circle', 'success'),
        tile('Never registered', fmt.number(d.summary.unregistered), 'Accounts with no business registration at all', 'las la-question-circle',
          d.summary.unregistered ? 'warning' : 'success'),
      ],
      chart: {
        card: seriesChart('chart-report', 'By category', 'How the network divides up.', 340),
        draw: (host) => (d.byCategory.length
          ? ui.bars(host, {
            categories: d.byCategory.map((c) => fmt.humanise(c.category)),
            series: [{ name: 'Merchants', data: d.byCategory.map((c) => c.count) }],
            height: 340,
            horizontal: true,
          })
          : ui.render(host, ui.emptyState('No categories recorded.')) && null),
      },
      tables: [{
        title: 'Performance',
        columns: [
          { key: 'name', label: 'Merchant', cell: (r) => ui.identity({ title: r.name, subtitle: fmt.humanise(r.category) }) },
          { key: 'orders', label: 'Orders', align: 'end', cell: (r) => fmt.number(r.orders) },
          { key: 'revenue', label: 'Revenue', align: 'end', cell: (r) => ui.money(r.revenue) },
          {
            key: 'cancellationRate',
            label: 'Cancelled',
            align: 'end',
            cell: (r) => html`${fmt.percent(r.cancellationRate)}<span class="cell-sub">${fmt.number(r.cancelled)}</span>`,
          },
          { key: 'commissionRate', label: 'Commission', align: 'end', cell: (r) => fmt.percent(r.commissionRate) },
          { key: 'isActive', label: 'State', cell: (r) => (r.isActive ? ui.badge('Live', 'success') : ui.badge('Hidden', 'danger')) },
        ],
        rows: d.performance,
        href: (r) => `/merchants/${r.merchantId}`,
      }],
    }),
  },

  orders: {
    title: 'Orders report',
    subtitle: 'Volume, cancellations and fulfilment',
    render: (d) => ({
      tiles: [
        tile('Orders', fmt.number(d.summary.total), 'In this range', 'las la-shopping-bag', 'navy'),
        tile('Cancelled', fmt.number(d.summary.cancelled), `${fmt.percent(d.summary.cancellationRate)} of the total`, 'las la-times-circle',
          d.summary.cancellationRate > 10 ? 'danger' : 'base'),
        tile('Average fulfilment',
          d.summary.deliveredSampleSize ? `${fmt.number(d.summary.averageFulfilmentMinutes)} min` : '—',
          d.summary.deliveredSampleSize
            ? `Over ${fmt.number(d.summary.deliveredSampleSize)} delivered order(s)`
            : 'No order was delivered in this range',
          'las la-stopwatch', 'info'),
      ],
      chart: {
        card: seriesChart('chart-report', 'By status', 'Where orders ended up.'),
        draw: (host) => (d.byStatus.length
          ? ui.donut(host, {
            series: d.byStatus.map((s) => s.count),
            labels: d.byStatus.map((s) => fmt.humanise(s.status)),
            formatter: (t) => `${fmt.number(t)} orders`,
          })
          : ui.render(host, ui.emptyState('No orders in this range.')) && null),
      },
      tables: [
        {
          title: 'By status',
          columns: [
            { key: 'status', label: 'Status', cell: (r) => ui.statusBadge(r.status) },
            { key: 'count', label: 'Orders', align: 'end', cell: (r) => fmt.number(r.count) },
            { key: 'value', label: 'Value', align: 'end', cell: (r) => ui.money(r.value) },
          ],
          rows: d.byStatus,
        },
        {
          title: 'By payment status',
          columns: [
            { key: 'status', label: 'Payment', cell: (r) => ui.statusBadge(r.status) },
            { key: 'count', label: 'Orders', align: 'end', cell: (r) => fmt.number(r.count) },
            { key: 'value', label: 'Value', align: 'end', cell: (r) => ui.money(r.value) },
          ],
          rows: d.byPaymentStatus,
        },
        {
          title: 'By type',
          columns: [
            { key: 'type', label: 'Type', cell: (r) => fmt.humanise(r.type) },
            { key: 'count', label: 'Orders', align: 'end', cell: (r) => fmt.number(r.count) },
          ],
          rows: d.byType,
        },
      ],
    }),
  },
};

export default {
  title: 'Reports',
  permission: 'reports.read',

  async render(host, ctx) {
    const kind = ctx.params.kind;
    const spec = REPORTS[kind];
    if (!spec) {
      ui.render(host, ui.errorState({
        message: `There is no "${kind}" report. Pick one from the Reports menu.`,
      }));
      return undefined;
    }

    this.title = spec.title;
    document.getElementById('page-title').textContent = spec.title;
    document.getElementById('page-subtitle').textContent = spec.subtitle;

    const query = {
      from: ctx.query.from || fmt.daysAgoIso(30),
      to: ctx.query.to || fmt.isoDate(),
      groupBy: ctx.query.groupBy || 'day',
    };

    host.append(ui.filterBar({
      values: query,
      onChange: (values) => ctx.setQuery(values),
      fields: [
        { name: 'from', type: 'date', label: 'From' },
        { name: 'to', type: 'date', label: 'To' },
        { name: 'groupBy', type: 'select', label: 'Group by', options: GROUPINGS },
      ],
      actions: auth.can('reports.export')
        ? ui.button({ label: 'Export CSV', icon: 'las la-file-download', tone: 'secondary', size: 'sm', action: 'export' })
        : '',
    }));

    const data = await api.get(`/reports/${kind}`, query);
    const view = spec.render(data);

    host.append(ui.node(html`
      ${(view.notes || []).map((n) => ui.note(n, 'warning'))}
      ${view.tiles ? ui.statGrid(view.tiles) : ''}
      ${view.chart ? view.chart.card : ''}
      ${(view.actions || []).length ? ui.card({
    title: 'Next steps',
    body: html`<div class="filter-actions">
          ${view.actions.map((a) => ui.button({ ...a, tone: 'secondary', size: 'sm' }))}
        </div>`,
  }) : ''}
      ${(view.tables || []).map((t) => ui.card({
    title: t.title,
    subtitle: t.subtitle,
    body: ui.table({
      columns: t.columns,
      rows: t.rows,
      empty: t.empty || 'Nothing in this range.',
      rowAttrs: t.href ? (r) => `data-href="${t.href(r)}"` : undefined,
    }),
  }))}`));

    let chart = null;
    if (view.chart) {
      const chartHost = host.querySelector('#chart-report');
      if (chartHost) chart = view.chart.draw(chartHost);
    }

    host.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-href]');
      if (row && !event.target.closest('button, a')) go(row.dataset.href);
    });

    ui.actions(host, {
      'no-cost': () => go('/products', { status: 'no_cost' }),
      export: async () => {
        const filename = await api.download('/reports/export',
          { ...query, type: kind, format: 'csv' }, `${kind}-report.csv`);
        ui.toast(`Downloaded ${filename}.`);
      },
    });

    return () => chart?.destroy();
  },
};
