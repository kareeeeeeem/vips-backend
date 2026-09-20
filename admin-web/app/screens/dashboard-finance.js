/**
 * Finance: revenue, margin, commission and what is owed out.
 *
 * Margin is only meaningful over the revenue whose products carry a cost
 * price, so "cost coverage" sits beside it. A 57% margin measured over 5% of
 * revenue is not a 57% margin, and this screen says so rather than letting
 * the headline stand alone.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as kit from '../core/dashboard-kit.js';
import { go } from '../core/router.js';

const { html } = ui;

export default {
  title: 'Finance',
  subtitle: 'Revenue, margin, commission and payouts',
  permission: 'reports.read',

  async render(host, ctx) {
    const query = kit.readQuery(ctx.query);
    const d = await api.get('/dashboards/finance', query);

    host.append(kit.periodBar({
      query,
      exportName: 'finance',
      onChange: (values) => ctx.setQuery(values),
    }));

    const thinCoverage = d.costCoverage < 60;

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
      label: 'Gross profit',
      value: fmt.tnd(d.totalProfit),
      hint: `Margin ${fmt.percent(d.margin)} on costed lines`,
      icon: 'las la-chart-line',
      tone: 'navy',
      chips: kit.chips(kit.deltaChip(d.change.totalProfit)),
    }),
    ui.statCard({
      label: 'Commission earned',
      value: fmt.tnd(d.totalCommissions),
      hint: 'The platform\'s own revenue (§5.3)',
      icon: 'las la-percentage',
      tone: 'base',
    }),
    ui.statCard({
      label: 'Payouts pending',
      value: fmt.tnd(d.pendingPayouts),
      hint: `${fmt.number(d.pendingPayoutCount)} awaiting payment · `
        + `${fmt.number(d.paidPayoutCount)} already paid`,
      icon: 'las la-hand-holding-usd',
      tone: d.pendingPayoutCount ? 'warning' : 'success',
    }),
    ui.statCard({
      label: 'Cost coverage',
      value: fmt.percent(d.costCoverage),
      hint: `${fmt.tnd(d.costedRevenue)} of revenue has a cost price behind it`,
      icon: 'las la-tags',
      tone: thinCoverage ? 'warning' : 'success',
    }),
  ])}

      ${thinCoverage ? ui.note(
    `Margin is computed only over the ${fmt.percent(d.costCoverage)} of revenue whose products `
        + `carry a cost price (${fmt.tnd(d.costedRevenue)} of ${fmt.tnd(d.totalRevenue)}). Treat the `
        + 'margin figure as indicative until more products have a cost recorded.', 'warning',
  ) : ''}

      ${d.merchantsOnZeroRate ? ui.note(
    `${fmt.number(d.merchantsOnZeroRate)} merchant(s) are on a zero commission rate, so their `
        + 'sales contribute revenue but no commission.', 'warning',
  ) : ''}

      <div class="row">
        <div class="col-xl-6 col-lg-12">
          ${ui.chartCard({
    id: 'chart-money',
    title: 'Revenue, profit and commission',
    subtitle: 'The three figures side by side for this window and the previous one.',
    height: 320,
  })}
        </div>
        <div class="col-xl-6 col-lg-12">
          ${ui.card({
    title: 'Where the money stands',
    body: ui.details([
      ['Revenue this window', ui.money(d.totalRevenue)],
      ['Revenue previous window', ui.money(d.previous.totalRevenue)],
      ['Gross profit', ui.money(d.totalProfit)],
      ['Profit previous window', ui.money(d.previous.totalProfit)],
      ['Commission earned', ui.money(d.totalCommissions)],
      ['Revenue with a cost price', html`${ui.money(d.costedRevenue)}
                  <span class="cell-sub">${fmt.percent(d.costCoverage)} of revenue</span>`],
      ['Payouts pending', html`${ui.money(d.pendingPayouts)}
                  <span class="cell-sub">${fmt.number(d.pendingPayoutCount)} request(s)</span>`],
      ['Payouts paid', html`${ui.money(d.paidPayouts)}
                  <span class="cell-sub">${fmt.number(d.paidPayoutCount)} request(s)</span>`],
    ]),
  })}

          ${ui.card({
    title: 'Improve these figures',
    body: html`
              <p>Margin and commission are only as good as the data behind them.</p>
              <div class="filter-actions" style="margin-top:12px">
                ${ui.button({
    label: 'Products missing a cost price',
    icon: 'las la-tags',
    tone: 'secondary',
    size: 'sm',
    action: 'no-cost',
  })}
                ${ui.button({
    label: 'Guarantee balances',
    icon: 'las la-shield-alt',
    tone: 'secondary',
    size: 'sm',
    action: 'guarantees',
  })}
              </div>`,
  })}
        </div>
      </div>`));

    kit.wireExport(host, 'finance', query);
    ui.actions(host, {
      'no-cost': () => go('/products', { status: 'no_cost' }),
      guarantees: () => go('/guarantees'),
    });

    const chart = ui.bars(host.querySelector('#chart-money'), {
      categories: ['Revenue', 'Gross profit', 'Commission'],
      height: 320,
      series: [
        {
          name: 'This window',
          data: [d.totalRevenue, d.totalProfit, d.totalCommissions],
        },
        {
          name: 'Previous window',
          data: [d.previous.totalRevenue, d.previous.totalProfit, null],
        },
      ],
      formatter: (v) => fmt.compact(v),
    });

    return () => chart?.destroy();
  },
};
