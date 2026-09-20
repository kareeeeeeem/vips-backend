/**
 * Merchant health: who is actually trading.
 *
 * "Idle" is the number that matters on a loyalty network. A merchant who
 * signed up and never sold anything still costs support and still shows on
 * the map to customers, so it is reported as prominently as the total.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as kit from '../core/dashboard-kit.js';
import { go } from '../core/router.js';

const { html } = ui;

export default {
  title: 'Merchant health',
  subtitle: 'Who is trading, who is idle, and who needs a decision',
  permission: 'reports.read',

  async render(host, ctx) {
    const query = kit.readQuery(ctx.query);
    const d = await api.get('/dashboards/merchants', query);

    host.append(kit.periodBar({
      query,
      exportName: 'merchants',
      onChange: (values) => ctx.setQuery(values),
    }));

    const idleShare = d.totalMerchants ? (d.idleMerchants / d.totalMerchants) * 100 : 0;

    host.append(ui.node(html`
      ${kit.windowNote(d.window)}

      ${ui.statGrid([
    ui.statCard({
      label: 'Merchants',
      value: fmt.number(d.totalMerchants),
      hint: `${fmt.number(d.activeMerchants)} live · ${fmt.number(d.inactiveMerchants)} hidden`,
      icon: 'las la-store',
      tone: 'navy',
    }),
    ui.statCard({
      label: 'Sold in window',
      value: fmt.number(d.sellingMerchants),
      hint: `${fmt.number(d.idleMerchants)} sold nothing`,
      icon: 'las la-cash-register',
      tone: 'success',
    }),
    ui.statCard({
      label: 'Idle',
      value: fmt.percent(idleShare),
      hint: 'Share of the network that traded nothing in this window',
      icon: 'las la-bed',
      tone: idleShare > 60 ? 'danger' : 'warning',
    }),
    ui.statCard({
      label: 'New merchants',
      value: fmt.number(d.newMerchants),
      hint: `Previously ${fmt.number(d.previous.newMerchants)}`,
      icon: 'las la-store-alt',
      tone: 'info',
      chips: kit.chips(kit.deltaChip(d.change.newMerchants)),
    }),
    ui.statCard({
      label: 'Awaiting approval',
      value: fmt.number(d.pendingApprovals),
      hint: d.pendingApprovals ? 'Registrations that need a decision' : 'Nothing waiting',
      icon: 'las la-gavel',
      tone: d.pendingApprovals ? 'warning' : 'success',
    }),
  ])}

      ${d.unattributedRevenue ? ui.note(
    `${fmt.tnd(d.unattributedRevenue)} across ${fmt.number(d.unattributedOrders)} order(s) belongs `
        + 'to no merchant, so it is excluded from every per-merchant figure below.', 'warning',
  ) : ''}

      ${ui.chartCard({
    id: 'chart-merchants',
    title: 'Revenue by merchant',
    subtitle: 'The ten highest earners in this window.',
    height: 360,
  })}

      ${ui.card({
    title: 'Top merchants',
    actions: ui.button({ label: 'All merchants', tone: 'secondary', size: 'sm', action: 'all' }),
    body: ui.table({
      columns: [
        {
          key: 'name',
          label: 'Merchant',
          cell: (m) => ui.identity({ title: m.name, subtitle: fmt.humanise(m.category) }),
        },
        { key: 'revenue', label: 'Revenue', align: 'end', cell: (m) => ui.money(m.revenue) },
        { key: 'orders', label: 'Orders', align: 'end', cell: (m) => fmt.number(m.orders) },
        {
          key: 'cancellationRate',
          label: 'Cancelled',
          align: 'end',
          cell: (m) => html`${fmt.percent(m.cancellationRate)}
            <span class="cell-sub">${fmt.number(m.cancelled)} order(s)</span>`,
        },
        { key: 'commissionRate', label: 'Commission', align: 'end', cell: (m) => fmt.percent(m.commissionRate) },
        { key: 'isActive', label: 'State', cell: (m) => (m.isActive ? ui.badge('Live', 'success') : ui.badge('Hidden', 'danger')) },
      ],
      rows: d.topMerchants,
      empty: 'No merchant sold anything in this window.',
      rowAttrs: (m) => `data-href="/merchants/${m.merchantId}"`,
    }),
  })}`));

    kit.wireExport(host, 'merchants', query);
    ui.actions(host, { all: () => go('/merchants') });

    host.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-href]');
      if (row && !event.target.closest('button, a')) go(row.dataset.href);
    });

    const top = (d.topMerchants || []).slice(0, 10);
    const chart = top.length
      ? ui.bars(host.querySelector('#chart-merchants'), {
        categories: top.map((m) => m.name),
        series: [{ name: 'Revenue (TND)', data: top.map((m) => m.revenue) }],
        height: 360,
        horizontal: true,
      })
      : ui.render(host.querySelector('#chart-merchants'),
        ui.emptyState('No merchant sold anything in this window.')) && null;

    return () => chart?.destroy();
  },
};
