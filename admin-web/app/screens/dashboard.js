/**
 * The landing screen: how the platform is doing right now, and what is
 * waiting on somebody.
 *
 * Every figure here comes from /dashboard/stats, /dashboard/charts and
 * /dashboard/recent — no arithmetic is redone in the browser, so the console
 * and the reports can never disagree about a number.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import { go } from '../core/router.js';

const { html, raw } = ui;

const RANGE_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

export default {
  title: 'Dashboard',
  subtitle: 'Platform overview',
  permission: 'dashboard.read',

  async render(host, ctx) {
    const days = ctx.query.days || '30';

    const [stats, charts, recent] = await Promise.all([
      api.get('/dashboard/stats'),
      api.get('/dashboard/charts', { days }),
      api.get('/dashboard/recent', { limit: 8 }),
    ]);

    const tiles = [
      ui.statCard({
        label: 'Customers',
        value: fmt.number(stats.users.total),
        hint: `${fmt.number(stats.users.newLast30Days)} joined in the last 30 days`,
        icon: 'las la-users',
        tone: 'base',
        chips: [
          { label: `${fmt.number(stats.users.active)} active`, tone: 'success' },
          ...(stats.users.banned ? [{ label: `${fmt.number(stats.users.banned)} suspended`, tone: 'danger' }] : []),
        ],
      }),
      ui.statCard({
        label: 'Merchants',
        value: fmt.number(stats.merchants.total),
        hint: stats.merchants.pendingApproval
          ? `${fmt.number(stats.merchants.pendingApproval)} waiting for approval`
          : 'No registrations waiting',
        icon: 'las la-store',
        tone: 'navy',
        chips: [
          { label: `${fmt.number(stats.merchants.active)} live`, tone: 'success' },
          ...(stats.merchants.pendingApproval
            ? [{ label: `${fmt.number(stats.merchants.pendingApproval)} pending`, tone: 'warning' }] : []),
        ],
      }),
      ui.statCard({
        label: 'Revenue',
        value: fmt.tnd(stats.revenue.total),
        hint: `${fmt.tnd(stats.revenue.last30Days)} in the last 30 days`,
        icon: 'las la-coins',
        tone: 'success',
        chips: [{ label: `${fmt.tnd(stats.revenue.averageOrderValue)} average order`, tone: 'info' }],
      }),
      ui.statCard({
        label: 'Orders',
        value: fmt.number(stats.orders.total),
        hint: `${fmt.number(stats.orders.completed)} completed`,
        icon: 'las la-shopping-bag',
        tone: 'info',
        chips: [
          ...(stats.orders.pending ? [{ label: `${fmt.number(stats.orders.pending)} pending`, tone: 'warning' }] : []),
          ...(stats.orders.cancelled ? [{ label: `${fmt.number(stats.orders.cancelled)} cancelled`, tone: 'danger' }] : []),
        ],
      }),
      ui.statCard({
        label: 'Catalogue',
        value: fmt.number(stats.catalog.products),
        hint: stats.catalog.lowStockItems
          ? `${fmt.number(stats.catalog.lowStockItems)} stock lines at or below their threshold`
          : 'No stock line is running low',
        icon: 'las la-box',
        tone: stats.catalog.lowStockItems ? 'warning' : 'base',
        chips: stats.catalog.lowStockItems
          ? [{ label: `${fmt.number(stats.catalog.lowStockItems)} low`, tone: 'warning' }] : [],
      }),
      ui.statCard({
        label: 'Guarantee refunds',
        value: fmt.number(stats.payouts.pending),
        hint: stats.payouts.pending
          ? 'Merchant refund requests awaiting review'
          : 'Nothing waiting for review',
        icon: 'las la-shield-alt',
        tone: stats.payouts.pending ? 'warning' : 'base',
      }),
    ];

    const series = charts.series || [];
    const categories = series.map((p) => fmt.date(p.date));

    host.append(ui.node(html`
      ${ui.statGrid(tiles)}

      <div class="row">
        <div class="col-xl-8 col-lg-12">
          ${ui.chartCard({
      id: 'chart-revenue',
      title: 'Revenue and orders',
      subtitle: 'Revenue counts only orders that reached delivered or picked up.',
      actions: html`
              <select class="form-control" data-range style="width:auto;padding:7px 12px">
                ${RANGE_OPTIONS.map((o) => html`
                  <option value="${o.value}" ${raw(o.value === String(days) ? 'selected' : '')}>${o.label}</option>`)}
              </select>`,
      height: 320,
    })}
        </div>
        <div class="col-xl-4 col-lg-12">
          ${ui.chartCard({ id: 'chart-signups', title: 'Sign-ups', subtitle: 'New customers and merchants per day.', height: 320 })}
        </div>
      </div>

      <div class="row">
        <div class="col-xl-7 col-lg-12">
          ${ui.card({
      title: 'Latest orders',
      actions: ui.button({ label: 'All orders', tone: 'secondary', size: 'sm', action: 'all-orders' }),
      body: ui.table({
        columns: [
          {
            key: 'orderNumber',
            label: 'Order',
            cell: (o) => ui.identity({
              title: o.orderNumber || fmt.shortId(o._id),
              subtitle: o.customerName || 'Unknown customer',
              initials: '#',
            }),
          },
          { key: 'merchantName', label: 'Merchant', cell: (o) => o.merchantName || '—' },
          { key: 'totalAmount', label: 'Total', align: 'end', cell: (o) => ui.money(o.totalAmount) },
          { key: 'status', label: 'Status', cell: (o) => ui.statusBadge(o.status) },
          { key: 'createdAt', label: 'Placed', cell: (o) => fmt.ago(o.createdAt) },
        ],
        rows: recent.orders,
        empty: 'No orders yet.',
        rowAttrs: (o) => `data-href="/orders/${o._id}"`,
      }),
    })}
        </div>

        <div class="col-xl-5 col-lg-12">
          ${ui.card({
      title: 'Waiting for approval',
      subtitle: 'Business registrations that need a decision.',
      actions: ui.button({ label: 'Merchants', tone: 'secondary', size: 'sm', action: 'all-merchants' }),
      body: ui.table({
        columns: [
          {
            key: 'businessName',
            label: 'Business',
            cell: (r) => ui.identity({ title: r.businessName, subtitle: r.ownerName }),
          },
          { key: 'status', label: 'Status', cell: (r) => ui.statusBadge(r.status) },
          { key: 'createdAt', label: 'Applied', cell: (r) => fmt.ago(r.createdAt) },
        ],
        rows: recent.pendingRegistrations,
        empty: 'Nothing waiting — every registration has been dealt with.',
        rowAttrs: (r) => (r.merchantId ? `data-href="/merchants/${r.merchantId}"` : ''),
      }),
    })}

          ${ui.card({
      title: 'Newest customers',
      body: ui.table({
        columns: [
          { key: 'fullName', label: 'Customer', cell: (u) => ui.identity({ title: u.fullName, subtitle: u.email }) },
          { key: 'isActive', label: 'Status', cell: (u) => ui.statusBadge(u.isActive === false ? 'banned' : 'active') },
          { key: 'createdAt', label: 'Joined', cell: (u) => fmt.ago(u.createdAt) },
        ],
        rows: recent.users.slice(0, 5),
        empty: 'No customers yet.',
        rowAttrs: (u) => `data-href="/customers/${u._id}"`,
      }),
    })}
        </div>
      </div>`));

    // ── charts ──
    const revenueChart = ui.timeSeries(host.querySelector('#chart-revenue'), {
      categories,
      height: 320,
      series: [
        { name: 'Revenue (TND)', type: 'area', data: series.map((p) => p.revenue) },
        { name: 'Orders', type: 'line', data: series.map((p) => p.orders) },
      ],
    });

    const signupChart = ui.bars(host.querySelector('#chart-signups'), {
      categories,
      height: 320,
      series: [
        { name: 'Customers', data: series.map((p) => p.users) },
        { name: 'Merchants', data: series.map((p) => p.merchants) },
      ],
    });

    // ── interaction ──
    host.querySelector('[data-range]')?.addEventListener('change', (event) => {
      ctx.setQuery({ days: event.target.value });
    });

    host.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-href]');
      if (row && !event.target.closest('button, a')) go(row.dataset.href);
    });

    ui.actions(host, {
      'all-orders': () => go('/orders'),
      'all-merchants': () => go('/merchants'),
    });

    return () => {
      revenueChart?.destroy();
      signupChart?.destroy();
    };
  },
};
