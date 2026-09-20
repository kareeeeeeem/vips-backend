/**
 * Platform-wide guarantee exposure.
 *
 * The headline figure is what the platform is holding on merchants' behalf.
 * §5.3 is explicit that this is not revenue and is refundable in full, so it
 * is reported on its own and never rolled into anything the platform earned.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as config from '../core/config.js';
import { go } from '../core/router.js';

const { html } = ui;

export default {
  title: 'Guarantee balances',
  subtitle: 'What the platform holds for merchants, and how it is allocated',
  permission: 'merchants.read',

  async render(host, ctx) {
    const [data, cfg] = await Promise.all([api.get('/guarantees'), config.load()]);
    const search = (ctx.query.search || '').toLowerCase();

    const rows = search
      ? data.items.filter((r) => r.name.toLowerCase().includes(search))
      : data.items;

    host.append(ui.node(html`
      ${ui.statGrid([
    ui.statCard({
      label: 'Held on behalf of merchants',
      value: fmt.tnd(data.totalHeldTnd),
      hint: 'Refundable in full — not platform revenue',
      icon: 'las la-shield-alt',
      tone: 'navy',
    }),
    ui.statCard({
      label: 'Deposited to date',
      value: fmt.tnd(data.totalDepositedTnd),
      hint: 'Every guarantee ever recorded',
      icon: 'las la-arrow-down',
      tone: 'success',
    }),
    ui.statCard({
      label: 'Refunded to date',
      value: fmt.tnd(data.totalRefundedTnd),
      hint: `Paid back on the ${cfg.refund.CYCLE_DAYS}-day cycle`,
      icon: 'las la-arrow-up',
      tone: 'info',
    }),
    ui.statCard({
      label: 'Cannot fund offers',
      value: fmt.number(data.merchantsWithoutGuarantee),
      hint: data.suspendedMerchants
        ? `${fmt.number(data.suspendedMerchants)} suspended for an empty balance`
        : 'Merchants holding no guarantee at all',
      icon: 'las la-exclamation-triangle',
      tone: data.merchantsWithoutGuarantee ? 'warning' : 'base',
    }),
  ])}

      ${ui.note('A merchant funds every offer from these budgets. When one runs dry that offer type '
        + 'stops being accepted at their till until they top the guarantee up (§5.1).')}
    `));

    const panel = ui.node(ui.card({
      title: 'Merchants by guarantee held',
      subtitle: 'Largest first. The three budgets are shown in points, as the merchant holds them.',
      body: html`${''}`,
    }));
    host.append(panel);

    const cardBody = panel.querySelector('.card-body');
    const tableHost = ui.node(html`<div></div>`);

    cardBody.append(ui.filterBar({
      values: { search: ctx.query.search || '' },
      onChange: (values) => ctx.setQuery(values),
      fields: [{ name: 'search', type: 'search', label: 'Find a merchant', placeholder: 'Shop name' }],
    }), tableHost);

    ui.render(tableHost, ui.table({
      columns: [
        {
          key: 'name',
          label: 'Merchant',
          cell: (r) => ui.identity({
            title: r.name,
            subtitle: `${fmt.humanise(r.plan)} plan · ${r.earnRate ?? cfg.earnRate.default} pts per dinar`,
          }),
        },
        {
          key: 'heldTnd',
          label: 'Held',
          align: 'end',
          cell: (r) => html`${ui.money(r.heldTnd)}<span class="cell-sub">${fmt.pointsBare(r.heldPoints)} points</span>`,
        },
        { key: 'discount', label: 'Cashback', align: 'end', cell: (r) => ui.pointsFigure(r.budgets.discount) },
        { key: 'packages', label: 'Packages', align: 'end', cell: (r) => ui.pointsFigure(r.budgets.packages) },
        { key: 'general', label: 'General', align: 'end', cell: (r) => ui.pointsFigure(r.budgets.general) },
        { key: 'depositedTnd', label: 'Deposited', align: 'end', cell: (r) => ui.money(r.depositedTnd) },
        { key: 'refundedTnd', label: 'Refunded', align: 'end', cell: (r) => ui.money(r.refundedTnd) },
        {
          key: 'suspended',
          label: 'State',
          cell: (r) => {
            if (r.suspended) return ui.badge('Suspended', 'danger');
            if (r.heldPoints === 0) return ui.badge('No guarantee', 'warning');
            return ui.badge('Funded', 'success');
          },
        },
      ],
      rows,
      empty: search ? 'No merchant matches that name.' : 'No merchant has deposited a guarantee yet.',
      rowAttrs: (r) => `data-href="/merchants/${r.merchantId}"`,
    }));

    tableHost.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-href]');
      if (row) go(row.dataset.href);
    });

    return undefined;
  },
};
