/**
 * One merchant, including the guarantee that funds everything they offer.
 *
 * §5.1: the cash a merchant deposits converts to points at 100 to the dinar
 * and is split across three budgets. Those points are the merchant's money
 * held by the platform, not revenue — so this screen reports the deposit,
 * what is still held, and what has been refunded as three separate figures
 * rather than one net number that would hide the distinction.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';
import * as config from '../core/config.js';
import { go } from '../core/router.js';

const { html } = ui;

const LEDGER_LABELS = {
  deposit: 'Deposit',
  allocate: 'Allocated to a budget',
  reallocate: 'Moved between budgets',
  fund: 'Offer funded',
  redemption: 'Voucher redeemed',
  refund: 'Refunded to the merchant',
};

export default {
  title: 'Merchant',
  permission: 'merchants.read',

  async render(host, ctx) {
    const { id } = ctx.params;

    const [detail, guarantee, cfg] = await Promise.all([
      api.get(`/merchants/${id}`),
      api.get(`/merchants/${id}/guarantee`).catch(() => null),
      config.load(),
    ]);

    const { merchant, registration, approvalStatus, stats, recentOrders, ads } = detail;
    const shopName = merchant.storeName || merchant.fullName;

    document.getElementById('page-title').textContent = shopName;
    document.getElementById('page-subtitle').textContent =
      `${fmt.humanise(merchant.storeCategory || 'Merchant')} · ${merchant.email || ''}`;

    const budgets = guarantee?.budgets || {};
    const budgetLabels = guarantee?.budgetLabels || {};

    host.append(ui.node(html`
      ${ui.statGrid([
    ui.statCard({
      label: 'Revenue through VIPs',
      value: fmt.tnd(stats.revenue),
      hint: `${fmt.number(stats.orders)} completed orders`,
      icon: 'las la-coins',
      tone: 'success',
    }),
    ui.statCard({
      label: 'Guarantee held',
      value: guarantee ? fmt.tnd(guarantee.totalTnd) : '—',
      hint: guarantee
        ? `${fmt.pointsBare(guarantee.totalPoints)} points, refundable in full`
        : 'No guarantee recorded',
      icon: 'las la-shield-alt',
      tone: guarantee?.suspended ? 'danger' : 'navy',
      chips: guarantee?.suspended ? [{ label: 'Suspended', tone: 'danger' }] : [],
    }),
    ui.statCard({
      label: 'Catalogue',
      value: fmt.number(stats.products),
      hint: `${fmt.number(stats.stockItems)} stock lines`,
      icon: 'las la-box',
      tone: 'info',
    }),
    ui.statCard({
      label: 'Plan',
      value: fmt.humanise(merchant.merchantPlan || 'basic'),
      hint: `${fmt.percent(merchant.commissionRate ?? 3)} commission · `
        + `${merchant.earnRate ?? cfg.earnRate.default} points per dinar earned`,
      icon: 'las la-award',
      tone: 'base',
    }),
  ])}

      <div class="row">
        <div class="col-xl-5 col-lg-12">
          ${ui.card({
    title: 'Shop',
    actions: html`
              ${auth.can('merchants.update')
    ? ui.button({ label: 'Plan', icon: 'las la-award', tone: 'secondary', size: 'sm', action: 'plan' })
    : ''}
              ${auth.canAny('merchants.activate', 'merchants.deactivate')
    ? ui.button({
      label: merchant.isActive ? 'Hide' : 'Make live',
      icon: merchant.isActive ? 'las la-eye-slash' : 'las la-eye',
      tone: merchant.isActive ? 'danger' : 'success',
      size: 'sm',
      action: merchant.isActive ? 'deactivate' : 'activate',
    })
    : ''}`,
    body: ui.details([
      ['Visibility', merchant.isActive ? ui.badge('Live for customers', 'success') : ui.badge('Hidden', 'danger')],
      ['Shop name', shopName],
      ['Owner', merchant.fullName],
      ['Email', merchant.email],
      ['Phone', merchant.phone || '—'],
      ['Category', fmt.humanise(merchant.storeCategory)],
      ['Address', merchant.storeAddress || '—'],
      ['Earn rate', `${merchant.earnRate ?? cfg.earnRate.default} points per dinar spent`],
      ['Commission', fmt.percent(merchant.commissionRate ?? 3)],
      ['Joined', fmt.dateTime(merchant.createdAt)],
      ['Merchant id', html`<code>${merchant._id}</code>`],
    ]),
  })}

          ${ui.card({
    title: 'Business registration',
    actions: auth.can('merchants.approve') && ['pending', 'under_review'].includes(approvalStatus)
      ? ui.button({ label: 'Decide', icon: 'las la-gavel', size: 'sm', action: 'approve' })
      : '',
    body: registration
      ? ui.details([
        ['Status', ui.statusBadge(registration.status)],
        ['Business name', registration.businessName],
        ['Owner', registration.ownerName],
        ['Tax number', registration.taxNumber || '—'],
        ['Submitted', fmt.dateTime(registration.createdAt)],
        registration.rejectionReason ? ['Rejection reason', registration.rejectionReason] : null,
      ])
      : ui.emptyState(
        'This merchant has not submitted a business registration.',
        'They register from the VIPs Merchant app.',
      ),
  })}
        </div>

        <div class="col-xl-7 col-lg-12">
          ${ui.card({
    title: 'Guarantee and budgets',
    subtitle: '§5.1 — cash deposited by the merchant, converted at 100 points to the dinar.',
    actions: auth.can('merchants.update')
      ? ui.button({ label: 'Record a deposit', icon: 'las la-plus', size: 'sm', action: 'deposit' })
      : '',
    body: guarantee ? html`
              ${guarantee.suspended ? ui.note(
    'This merchant is suspended: their budgets ran dry, so the platform stopped accepting '
              + 'points at their tills until a further guarantee is deposited.', 'danger',
  ) : ''}

              ${ui.details([
    ['Deposited to date', ui.money(guarantee.depositedTnd)],
    ['Refunded to date', ui.money(guarantee.refundedTnd)],
    ['Held now', html`${ui.money(guarantee.totalTnd)}
                    <span class="cell-sub">${fmt.pointsBare(guarantee.totalPoints)} points</span>`],
    ['Unallocated', ui.pointsFigure(guarantee.unallocatedPoints)],
  ])}

              ${ui.sectionTitle('The three budgets', 'Each offer type is funded from its own.')}
              ${ui.table({
    columns: [
      { key: 'label', label: 'Budget', cell: (b) => ui.identity({ title: b.english, subtitle: b.arabic, initials: b.english[0] }) },
      { key: 'purpose', label: 'Funds', cell: (b) => b.purpose },
      { key: 'points', label: 'Balance', align: 'end', cell: (b) => html`
                    ${ui.pointsFigure(b.points)}<span class="cell-sub">${fmt.tnd(b.points / cfg.pointsPerTnd)}</span>` },
    ],
    rows: (cfg.budgets || []).map((b) => ({
      english: config.BUDGET_ENGLISH[b.key] || fmt.humanise(b.key),
      arabic: budgetLabels[b.key] || b.label,
      purpose: config.BUDGET_PURPOSE[b.key] || '',
      points: budgets[b.key] || 0,
    })),
  })}

              ${ui.sectionTitle('Refund eligibility', `§5.2 — once every ${cfg.refund.CYCLE_DAYS} days.`)}
              ${guarantee.refund.canRequest
    ? ui.note(`Eligible now: up to ${fmt.tnd(guarantee.refund.availableTnd)} could be refunded on request.`)
    : (guarantee.refund.reasons || []).map((reason) => ui.note(reason, 'warning'))}
            ` : ui.emptyState(
    'No guarantee has been recorded for this merchant.',
    'Until one is, they cannot fund any offer.',
  ),
  })}

          ${ui.card({
    title: 'Guarantee ledger',
    subtitle: 'Every movement, most recent first.',
    body: ui.table({
      columns: [
        { key: 'type', label: 'Movement', cell: (l) => ui.badge(LEDGER_LABELS[l.type] || fmt.humanise(l.type), 'base') },
        { key: 'budget', label: 'Budget', cell: (l) => (l.budget ? (budgetLabels[l.budget] || fmt.humanise(l.budget)) : '—') },
        { key: 'points', label: 'Points', align: 'end', cell: (l) => ui.pointsFigure(l.points) },
        { key: 'note', label: 'Note', cell: (l) => l.note || '—' },
        { key: 'createdAt', label: 'When', cell: (l) => fmt.ago(l.createdAt) },
      ],
      rows: guarantee?.ledger || [],
      empty: 'No guarantee movements recorded yet.',
    }),
  })}

          ${ui.card({
    title: 'Recent orders',
    body: ui.table({
      columns: [
        { key: 'orderNumber', label: 'Order', cell: (o) => o.orderNumber || fmt.shortId(o._id) },
        { key: 'totalAmount', label: 'Total', align: 'end', cell: (o) => ui.money(o.totalAmount) },
        { key: 'status', label: 'Status', cell: (o) => ui.statusBadge(o.status) },
        { key: 'createdAt', label: 'Placed', cell: (o) => fmt.ago(o.createdAt) },
      ],
      rows: recentOrders,
      empty: 'No orders through this shop yet.',
      rowAttrs: (o) => `data-href="/orders/${o._id}"`,
    }),
  })}

          ${(ads && ads.length) ? ui.card({
    title: 'Campaigns',
    body: ui.table({
      columns: [
        { key: 'title', label: 'Campaign' },
        { key: 'status', label: 'Status', cell: (a) => ui.statusBadge(a.status) },
        { key: 'budget', label: 'Budget', align: 'end', cell: (a) => ui.money(a.budget) },
        { key: 'spentAmount', label: 'Spent', align: 'end', cell: (a) => ui.money(a.spentAmount) },
        { key: 'impressions', label: 'Impressions', align: 'end', cell: (a) => fmt.number(a.impressions) },
        { key: 'clicks', label: 'Clicks', align: 'end', cell: (a) => fmt.number(a.clicks) },
      ],
      rows: ads,
    }),
  }) : ''}
        </div>
      </div>`));

    host.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-href]');
      if (row && !event.target.closest('button, a')) go(row.dataset.href);
    });

    ui.actions(host, {
      deposit: async () => {
        const done = await ui.modal({
          title: `Record a guarantee deposit — ${shopName}`,
          submitLabel: 'Record deposit',
          body: html`
            ${ui.note('Record this only once the money has actually arrived. The deposit converts at '
              + `${cfg.pointsPerTnd} points to the dinar and lands unallocated, for the merchant to split `
              + 'across their three budgets.', 'warning')}
            ${ui.field({
    name: 'amount',
    label: 'Amount received (TND)',
    type: 'number',
    required: true,
    attrs: 'min="0" step="0.001"',
    hint: 'The merchant can request this back in full, once every '
      + `${cfg.refund.CYCLE_DAYS} days, above ${cfg.refund.MIN_TND} TND.`,
  })}
            ${ui.textareaField({
    name: 'note',
    label: 'Reference',
    placeholder: 'Bank reference, receipt number, or how the cash arrived',
  })}`,
          onSubmit: async (values) => {
            const response = await api.post(`/merchants/${id}/guarantee/deposit`, {
              amount: Number(values.amount),
              note: values.note || undefined,
            });
            ui.toast(response.message || 'Guarantee recorded.');
            return true;
          },
        });
        if (done) ctx.reload();
      },

      plan: async () => {
        const plans = cfg.plans || [];
        const saved = await ui.modal({
          title: `Plan — ${shopName}`,
          submitLabel: 'Save plan',
          body: html`
            ${ui.note('§8 — the monthly fee buys a lower commission, so the plan is what sets the '
              + 'rate rather than a number typed in by hand.')}
            ${ui.selectField({
    name: 'plan',
    label: 'Subscription plan',
    value: merchant.merchantPlan || 'basic',
    options: plans.map((p) => ({
      value: p.key,
      label: `${fmt.humanise(p.key)} — ${p.monthlyFeeTnd} TND/month, ${p.commissionPercent}% commission`,
    })),
    required: true,
  })}
            ${ui.field({
    name: 'earnRate',
    label: 'Earn rate (points per dinar)',
    type: 'number',
    value: merchant.earnRate ?? cfg.earnRate.default,
    attrs: `min="0" max="${cfg.earnRate.max}" step="0.1"`,
    hint: `What a customer earns per dinar spent here. The documents' worked example is `
      + `${cfg.earnRate.default}. A merchant with no rate set earns their customers nothing.`,
  })}`,
          onSubmit: async (values) => {
            const response = await api.put(`/merchants/${id}/plan`, {
              plan: values.plan,
              earnRate: Number(values.earnRate),
            });
            ui.toast(response.message || 'Plan updated.');
            return true;
          },
        });
        if (saved) ctx.reload();
      },

      approve: async () => {
        const decided = await ui.modal({
          title: `Registration — ${shopName}`,
          submitLabel: 'Submit decision',
          body: html`
            ${ui.selectField({
    name: 'decision',
    label: 'Decision',
    options: [{ value: 'approve', label: 'Approve' }, { value: 'reject', label: 'Reject' }],
    required: true,
  })}
            ${ui.textareaField({ name: 'reason', label: 'Reason', hint: 'Required when rejecting.' })}`,
          onSubmit: async (values) => {
            const approved = values.decision === 'approve';
            if (!approved && !values.reason.trim()) {
              ui.toast('A rejection reason is required.', 'warning');
              return false;
            }
            const response = await api.put(`/merchants/${id}/approve`, { approved, reason: values.reason });
            ui.toast(response.message || 'Decision recorded.');
            return true;
          },
        });
        if (decided) ctx.reload();
      },

      activate: async () => {
        await api.put(`/merchants/${id}/activate`, { active: true });
        ui.toast('Merchant is live.');
        ctx.reload();
      },

      deactivate: async () => {
        const ok = await ui.confirm({
          title: 'Hide this merchant?',
          message: `${shopName} will disappear from the customer app, along with their products.`,
          submitLabel: 'Hide merchant',
        });
        if (!ok) return;
        await api.put(`/merchants/${id}/activate`, { active: false });
        ui.toast('Merchant hidden.', 'warning');
        ctx.reload();
      },
    });

    return undefined;
  },
};
