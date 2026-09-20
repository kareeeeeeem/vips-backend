/**
 * One order: what was bought, what was charged, and everything that has
 * happened to it since.
 *
 * The money breakdown lists each discount separately rather than showing one
 * net total, because they come out of different places: a coupon and a store
 * discount are the merchant's, while points redeemed are the customer's own
 * balance being spent.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';
import { go } from '../core/router.js';

const { html } = ui;

const STATUSES = [
  'pending', 'confirmed', 'processing', 'ready',
  'handover', 'picked_up', 'delivered',
  'cancelled', 'refund_requested', 'refunded',
];

export default {
  title: 'Order',
  permission: 'orders.read',

  async render(host, ctx) {
    const { id } = ctx.params;
    const { order } = await api.get(`/orders/${id}`);

    const customer = order.userId || {};
    const merchant = order.merchantId || {};
    const label = order.orderNumber ? `Order #${order.orderNumber}` : `Order ${fmt.shortId(order._id)}`;

    document.getElementById('page-title').textContent = label;
    document.getElementById('page-subtitle').textContent =
      `${fmt.humanise(order.orderType)} · ${fmt.dateTime(order.createdAt)}`;

    const lineTotal = (item) =>
      (item.price || 0) * (item.quantity || 1)
      + (item.total_add_on_price || 0)
      + (item.tax_amount || 0)
      - (item.discount_on_item || 0);

    // Each row here is a real figure from the order, so a total that does not
    // add up is a data problem worth seeing rather than something to paper over.
    const moneyRows = [
      ['Items', ui.money(order.items.reduce((sum, i) => sum + lineTotal(i), 0))],
      order.totalTaxAmount ? ['Tax', ui.money(order.totalTaxAmount)] : null,
      order.deliveryCharge ? ['Delivery', ui.money(order.deliveryCharge)] : null,
      order.additionalCharge ? ['Additional charges', ui.money(order.additionalCharge)] : null,
      order.couponDiscountAmount
        ? [`Coupon${order.couponDiscountTitle ? ` — ${order.couponDiscountTitle}` : ''}`,
          html`−${ui.money(order.couponDiscountAmount)}`]
        : null,
      order.storeDiscountAmount ? ['Shop discount', html`−${ui.money(order.storeDiscountAmount)}`] : null,
      order.walletPointsRedeemed
        ? ['Points redeemed',
          html`${ui.pointsFigure(order.walletPointsRedeemed)}
               <span class="cell-sub">worth ${fmt.tnd(order.walletDiscountAmount)}</span>`]
        : null,
      ['Total charged', html`<strong>${ui.money(order.totalAmount)}</strong>`],
    ];

    host.append(ui.node(html`
      ${ui.statGrid([
    ui.statCard({
      label: 'Total',
      value: fmt.tnd(order.totalAmount),
      hint: `Paid by ${fmt.humanise(order.paymentMethod)}`,
      icon: 'las la-receipt',
      tone: 'navy',
    }),
    ui.statCard({
      label: 'Status',
      value: fmt.humanise(order.status),
      hint: order.cancellationReason || `${order.items.length} line${order.items.length === 1 ? '' : 's'}`,
      icon: 'las la-tasks',
      tone: order.status === 'delivered' || order.status === 'picked_up' ? 'success' : 'info',
    }),
    ui.statCard({
      label: 'Payment',
      value: fmt.humanise(order.paymentStatus),
      hint: order.paymentReference ? `Ref ${order.paymentReference}` : 'No gateway reference',
      icon: 'las la-credit-card',
      tone: order.paymentStatus === 'paid' ? 'success' : 'warning',
    }),
    ui.statCard({
      label: 'Points credited',
      value: order.pointsCredited ? 'Yes' : 'Not yet',
      hint: order.pointsCredited
        ? 'The customer has been given their loyalty points'
        : 'Points are credited when the order completes',
      icon: 'las la-star',
      tone: order.pointsCredited ? 'success' : 'base',
    }),
  ])}

      <div class="row">
        <div class="col-xl-7 col-lg-12">
          ${ui.card({
    title: 'Items',
    actions: html`
              ${auth.can('orders.update')
    ? ui.button({ label: 'Change status', icon: 'las la-exchange-alt', tone: 'secondary', size: 'sm', action: 'status' })
    : ''}
              ${auth.can('orders.cancel')
    && !['delivered', 'picked_up', 'canceled', 'cancelled', 'refunded'].includes(order.status)
    ? ui.button({ label: 'Cancel order', icon: 'las la-ban', tone: 'danger', size: 'sm', action: 'cancel' })
    : ''}`,
    body: ui.table({
      columns: [
        {
          key: 'item_name',
          label: 'Item',
          cell: (i) => ui.identity({
            title: i.item_name || 'Unnamed item',
            subtitle: [i.variant, ...(i.add_ons || []).map((a) => a.name)].filter(Boolean).join(' · ') || null,
          }),
        },
        { key: 'quantity', label: 'Qty', align: 'end', cell: (i) => fmt.number(i.quantity) },
        { key: 'price', label: 'Unit', align: 'end', cell: (i) => ui.money(i.price) },
        { key: 'total', label: 'Line total', align: 'end', cell: (i) => ui.money(lineTotal(i)) },
      ],
      rows: order.items,
      empty: 'This order has no line items.',
    }),
  })}

          ${ui.card({ title: 'Money', body: ui.details(moneyRows) })}

          ${ui.card({
    title: 'Timeline',
    subtitle: 'Every status this order has been through.',
    body: (order.statusHistory && order.statusHistory.length)
      ? ui.table({
        columns: [
          { key: 'status', label: 'Status', cell: (h) => ui.statusBadge(h.status) },
          { key: 'note', label: 'Note', cell: (h) => h.note || '—' },
          { key: 'byRole', label: 'Changed by', cell: (h) => (h.byRole ? fmt.humanise(h.byRole) : 'System') },
          { key: 'at', label: 'When', cell: (h) => fmt.dateTime(h.at) },
        ],
        rows: [...order.statusHistory].reverse(),
      })
      : ui.emptyState('No status history recorded for this order.'),
  })}
        </div>

        <div class="col-xl-5 col-lg-12">
          ${ui.card({
    title: 'Customer',
    actions: customer._id
      ? ui.button({ label: 'Open', tone: 'secondary', size: 'sm', action: 'open-customer' })
      : '',
    body: ui.details([
      ['Name', customer.fullName || '—'],
      ['Email', customer.email || '—'],
      ['Phone', customer.phone || '—'],
    ]),
  })}

          ${ui.card({
    title: 'Merchant',
    actions: merchant._id
      ? ui.button({ label: 'Open', tone: 'secondary', size: 'sm', action: 'open-merchant' })
      : '',
    body: merchant._id
      ? ui.details([
        ['Shop', merchant.storeName || merchant.fullName],
        ['Phone', merchant.phone || '—'],
        ['Address', merchant.storeAddress || '—'],
      ])
      : ui.emptyState('This order is not attached to a merchant.',
        'Seeded deals commonly have no specific shop behind them.'),
  })}

          ${order.orderType === 'delivery' ? ui.card({
    title: 'Delivery',
    body: ui.details([
      ['Recipient', order.deliveryAddress?.contact_person_name || '—'],
      ['Phone', order.deliveryAddress?.contact_person_number || '—'],
      ['Address', order.deliveryAddress?.address || '—'],
      ['Instruction', order.deliveryInstruction || '—'],
      ['Expected', order.estimatedDeliveryAt ? fmt.dateTime(order.estimatedDeliveryAt) : 'Not given'],
    ]),
  }) : ''}

          ${ui.card({
    title: 'Record',
    body: ui.details([
      ['Order id', html`<code>${order._id}</code>`],
      ['Placed', fmt.dateTime(order.createdAt)],
      ['Last change', fmt.dateTime(order.updatedAt)],
      order.orderNote ? ['Customer note', order.orderNote] : null,
      order.rating ? ['Rating', `${order.rating} / 5`] : null,
      order.review ? ['Review', order.review] : null,
    ]),
  })}
        </div>
      </div>`));

    ui.actions(host, {
      'open-customer': () => go(`/customers/${customer._id}`),
      'open-merchant': () => go(`/merchants/${merchant._id}`),

      status: async () => {
        const saved = await ui.modal({
          title: 'Change order status',
          submitLabel: 'Update status',
          body: html`
            ${ui.selectField({ name: 'status', label: 'New status', options: STATUSES, value: order.status, required: true })}
            ${ui.textareaField({ name: 'note', label: 'Note', placeholder: 'Why the status changed' })}`,
          onSubmit: async (values) => {
            const response = await api.put(`/orders/${id}/status`, values);
            ui.toast(response.message || 'Order updated.');
            return true;
          },
        });
        if (saved) ctx.reload();
      },

      cancel: async () => {
        const cancelled = await ui.modal({
          title: 'Cancel this order?',
          submitLabel: 'Cancel order',
          submitTone: 'danger',
          body: html`
            <p class="confirm-message">The order moves to cancelled. It is kept, not deleted —
            deleting it would silently change past revenue figures.</p>
            ${ui.textareaField({ name: 'reason', label: 'Reason', placeholder: 'Shown on the order timeline' })}`,
          onSubmit: async (values) => {
            const response = await api.del(`/orders/${id}`, { reason: values.reason });
            ui.toast(response.message || 'Order cancelled.', 'warning');
            return true;
          },
        });
        if (cancelled) ctx.reload();
      },
    });

    return undefined;
  },
};
