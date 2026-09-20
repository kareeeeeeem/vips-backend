/**
 * The till.
 *
 * Prices are never sent from here. Adding a product sends only its id, and
 * the server copies the price off the Product document — the same rule that
 * stops a 12.500 TND item being rung up for 0.001. Every total on this
 * screen comes back from the server for the same reason.
 */

import * as api from '../core/api.js';
import * as fmt from '../core/format.js';
import * as ui from '../core/ui.js';
import * as auth from '../core/auth.js';

const { html } = ui;

export default {
  title: 'Till',
  subtitle: 'Ring up a counter sale',
  permission: 'pos.read',

  async render(host) {
    const layout = ui.node(html`<div id="till-root"></div>`);
    host.append(layout);

    async function draw() {
      ui.render(layout, ui.loadingState('Checking for an open till…'));

      const { session } = await api.get('/pos/session');

      if (!session) {
        ui.render(layout, ui.card({
          title: 'No till is open',
          subtitle: 'A session ties every receipt to a cashier, a merchant and an opening float.',
          body: html`
            ${ui.emptyState(
    'You have no open till session.',
    'Open one against a merchant to start ringing up sales.',
  )}
            <div class="filter-actions" style="justify-content:center">
              ${auth.can('pos.open_session')
    ? ui.button({ label: 'Open a till', icon: 'las la-cash-register', action: 'open-session' })
    : ui.note('Your role cannot open a till session.', 'warning')}
            </div>`,
        }));
        return;
      }

      const cart = await api.get('/pos/cart');
      const t = cart.totals;

      ui.render(layout, html`
        <div class="row">
          <div class="col-xl-7 col-lg-12">
            ${ui.card({
    title: 'Cart',
    subtitle: cart.customerName
      ? `Serving ${cart.customerName}${cart.customerPhone ? ` · ${cart.customerPhone}` : ''}`
      : 'No customer attached — the sale will be anonymous.',
    actions: html`
                ${auth.can('pos.update')
    ? ui.button({ label: 'Add item', icon: 'las la-plus', size: 'sm', action: 'add-item' })
    : ''}
                ${cart.items.length && auth.can('pos.update')
    ? ui.button({ label: 'Clear', icon: 'las la-trash', tone: 'secondary', size: 'sm', action: 'clear-cart' })
    : ''}`,
    body: ui.table({
      columns: [
        {
          key: 'name',
          label: 'Item',
          cell: (i) => ui.identity({ title: i.name, subtitle: i.code || null }),
        },
        { key: 'unitPrice', label: 'Unit', align: 'end', cell: (i) => ui.money(i.unitPrice) },
        {
          key: 'quantity',
          label: 'Qty',
          align: 'end',
          cell: (i) => (auth.can('pos.update')
            ? html`
                        <span class="qty-control">
                          <button type="button" class="row-action" data-action="qty-down" data-id="${i._id}"
                                  title="One fewer"><i class="las la-minus"></i></button>
                          <span class="figure">${fmt.number(i.quantity)}</span>
                          <button type="button" class="row-action" data-action="qty-up" data-id="${i._id}"
                                  title="One more"><i class="las la-plus"></i></button>
                        </span>`
            : fmt.number(i.quantity)),
        },
        { key: 'lineTotal', label: 'Line', align: 'end', cell: (i) => ui.money(i.lineTotal) },
        {
          key: 'actions',
          label: '',
          align: 'end',
          cell: (i) => (auth.can('pos.update')
            ? ui.rowAction({ icon: 'las la-times', title: 'Remove', action: 'remove-item', id: i._id, tone: 'danger' })
            : ''),
        },
      ],
      rows: cart.items,
      empty: 'The cart is empty. Add an item to begin.',
    }),
  })}
          </div>

          <div class="col-xl-5 col-lg-12">
            ${ui.card({
    title: 'Session',
    actions: auth.can('pos.close_session')
      ? ui.button({ label: 'Close till', icon: 'las la-lock', tone: 'secondary', size: 'sm', action: 'close-session' })
      : '',
    body: ui.details([
      ['Status', ui.statusBadge(session.status)],
      ['Opened', fmt.dateTime(session.createdAt)],
      ['Opening float', ui.money(session.openingFloat)],
      ['Sales so far', ui.money(session.totalSales)],
      ['Refunds', ui.money(session.totalRefunds)],
      ['Receipts', fmt.number(session.invoiceCount)],
      ['Expected in drawer', ui.money(
        (session.openingFloat || 0) + (session.totalSales || 0) - (session.totalRefunds || 0),
      )],
    ]),
  })}

            ${ui.card({
    title: 'To pay',
    actions: auth.can('pos.update')
      ? html`
                  ${ui.button({ label: 'Customer', icon: 'las la-user', tone: 'secondary', size: 'sm', action: 'set-customer' })}
                  ${ui.button({ label: 'Discount', icon: 'las la-percentage', tone: 'secondary', size: 'sm', action: 'set-discount' })}`
      : '',
    body: html`
                ${ui.details([
    ['Subtotal', ui.money(t.subtotal)],
    t.discount ? ['Discount', html`−${ui.money(t.discount)}`] : null,
    t.tax ? ['Tax', ui.money(t.tax)] : null,
    ['Total', html`<strong class="till-total">${fmt.tnd(t.total)}</strong>`],
  ])}
                <div class="filter-actions" style="margin-top:16px">
                  ${cart.items.length && auth.can('pos.create')
    ? ui.button({ label: 'Take payment', icon: 'las la-check-circle', action: 'checkout' })
    : ''}
                </div>`,
  })}
          </div>
        </div>`);
    }

    ui.actions(layout, {
      'open-session': async () => {
        const opened = await ui.modal({
          title: 'Open a till',
          submitLabel: 'Open till',
          body: html`
            ${ui.note('The till is scoped to one merchant: it can only sell that shop\'s products.')}
            ${ui.field({
    name: 'merchantId',
    label: 'Merchant id',
    required: true,
    hint: 'Copy this from the merchant\'s own screen.',
  })}
            ${ui.field({
    name: 'openingFloat',
    label: 'Opening float (TND)',
    type: 'number',
    value: '0',
    attrs: 'min="0" step="0.001"',
    hint: 'Cash already in the drawer, so the closing count can be reconciled.',
  })}`,
          onSubmit: async (values) => {
            const response = await api.post('/pos/session/start', {
              merchantId: values.merchantId.trim(),
              openingFloat: Number(values.openingFloat),
            });
            ui.toast(response.message || 'Till open.');
            return true;
          },
        });
        if (opened) draw();
      },

      'close-session': async () => {
        const closed = await ui.modal({
          title: 'Close the till',
          submitLabel: 'Close till',
          body: html`
            ${ui.note('Count the drawer and enter what is actually in it. The difference against '
              + 'the expected figure is recorded on the session.')}
            ${ui.field({
    name: 'closingCount',
    label: 'Counted cash (TND)',
    type: 'number',
    required: true,
    attrs: 'min="0" step="0.001"',
  })}`,
          onSubmit: async (values) => {
            const response = await api.post('/pos/session/end', {
              closingCount: Number(values.closingCount),
            });
            ui.toast(response.message || 'Till closed.');
            return true;
          },
        });
        if (closed) draw();
      },

      'add-item': async () => {
        const added = await ui.modal({
          title: 'Add an item',
          submitLabel: 'Add to cart',
          body: html`
            ${ui.note('Only the product id is sent — the price is taken from the product record, '
              + 'never from this screen.')}
            ${ui.field({ name: 'productId', label: 'Product id', required: true })}
            ${ui.field({ name: 'quantity', label: 'Quantity', type: 'number', value: '1', attrs: 'min="1"' })}`,
          onSubmit: async (values) => {
            await api.post('/pos/cart/add', {
              productId: values.productId.trim(),
              quantity: Number(values.quantity) || 1,
            });
            return true;
          },
        });
        if (added) draw();
      },

      'qty-up': async ({ id }) => {
        const cart = await api.get('/pos/cart');
        const line = cart.items.find((i) => String(i._id) === id);
        await api.put('/pos/cart/update', { itemId: id, quantity: (line?.quantity || 0) + 1 });
        draw();
      },

      'qty-down': async ({ id }) => {
        const cart = await api.get('/pos/cart');
        const line = cart.items.find((i) => String(i._id) === id);
        const next = (line?.quantity || 1) - 1;
        if (next <= 0) await api.del(`/pos/cart/remove/${id}`);
        else await api.put('/pos/cart/update', { itemId: id, quantity: next });
        draw();
      },

      'remove-item': async ({ id }) => {
        await api.del(`/pos/cart/remove/${id}`);
        draw();
      },

      'clear-cart': async () => {
        const ok = await ui.confirm({
          title: 'Clear the cart?',
          message: 'Every line is removed. Nothing is charged.',
          submitLabel: 'Clear cart',
        });
        if (!ok) return;
        await api.del('/pos/cart/clear');
        draw();
      },

      /**
       * Look the customer up rather than asking the cashier to type an id.
       * Attaching a real account is what earns the customer their points, so
       * the search is the path of least resistance and typing a walk-in name
       * is the fallback.
       */
      'set-customer': async () => {
        const set = await ui.modal({
          title: 'Attach a customer',
          submitLabel: 'Attach',
          size: 'lg',
          body: html`
            ${ui.note('Attaching a real account is what earns the customer their loyalty points. '
              + 'A walk-in name is recorded on the receipt but earns nothing.')}
            <label class="form-field">
              <span class="form-label">Find a customer</span>
              <input class="form-control" type="search" data-customer-search
                     placeholder="Name, phone or email" autocomplete="off">
              <span class="form-hint">Pick a result to attach it, or fill the walk-in fields below.</span>
            </label>
            <div data-customer-results></div>
            <input type="hidden" name="customerId" value="">
            ${ui.sectionTitle('Or record a walk-in')}
            ${ui.fieldRow(
    ui.field({ name: 'name', label: 'Name' }),
    ui.field({ name: 'phone', label: 'Phone' }),
  )}
            ${ui.checkboxField({
    name: 'createAccount',
    label: 'Open a VIPs account for them',
    hint: 'Creates a customer with that name and phone, so this sale and every later one earns points.',
  })}`,
          onSubmit: async (values) => {
            if (values.createAccount === '1') {
              if (!values.name.trim() || !values.phone.trim()) {
                ui.toast('A name and phone are needed to open an account.', 'warning');
                return false;
              }
              const created = await api.post('/pos/customers', {
                fullName: values.name.trim(),
                phone: values.phone.trim(),
              });
              const id = created.data?.customer?._id;
              await api.post('/pos/cart/customer', { customerId: id });
              ui.toast(created.message || 'Customer created and attached.');
              return true;
            }

            await api.post('/pos/cart/customer', {
              customerId: values.customerId.trim() || undefined,
              name: values.name.trim() || undefined,
              phone: values.phone.trim() || undefined,
            });
            return true;
          },
        });
        if (set) draw();
      },

      'set-discount': async () => {
        const set = await ui.modal({
          title: 'Discount the sale',
          submitLabel: 'Apply discount',
          body: html`
            ${ui.selectField({
    name: 'type',
    label: 'Kind',
    options: [{ value: 'fixed', label: 'Fixed amount (TND)' }, { value: 'percentage', label: 'Percentage' }],
  })}
            ${ui.field({ name: 'amount', label: 'Amount', type: 'number', required: true, attrs: 'min="0" step="0.001"' })}`,
          onSubmit: async (values) => {
            await api.post('/pos/cart/discount', {
              amount: Number(values.amount),
              type: values.type,
            });
            return true;
          },
        });
        if (set) draw();
      },

      checkout: async () => {
        const cart = await api.get('/pos/cart');
        const done = await ui.modal({
          title: `Take ${fmt.tnd(cart.totals.total)}`,
          submitLabel: 'Complete sale',
          submitTone: 'success',
          body: html`
            ${ui.details([
    ['Items', fmt.number(cart.itemCount)],
    ['Subtotal', ui.money(cart.totals.subtotal)],
    cart.totals.discount ? ['Discount', html`−${ui.money(cart.totals.discount)}`] : null,
    cart.totals.tax ? ['Tax', ui.money(cart.totals.tax)] : null,
    ['Total', html`<strong>${fmt.tnd(cart.totals.total)}</strong>`],
    ['Customer', cart.customerName || 'Walk-in'],
  ])}
            ${ui.selectField({
    name: 'paymentMethod',
    label: 'Paid by',
    options: [
      { value: 'cash', label: 'Cash' },
      { value: 'card', label: 'Card' },
      { value: 'wallet', label: 'VIPs wallet' },
    ],
    required: true,
  })}`,
          onSubmit: async (values) => {
            const response = await api.post('/pos/invoice/create', {
              paymentMethod: values.paymentMethod,
            });
            ui.toast(response.message || 'Sale complete.');
            return true;
          },
        });
        if (done) draw();
      },
    });

    await draw();
    return undefined;
  },
};

/**
 * Live customer lookup inside the "attach a customer" dialog.
 *
 * Delegated from the document because the dialog's DOM is built fresh each
 * time it opens, so there is nothing to bind to when this module loads.
 */
let searchTimer;
document.addEventListener('input', (event) => {
  const input = event.target.closest('[data-customer-search]');
  if (!input) return;

  const results = input.closest('.modal-form')?.querySelector('[data-customer-results]');
  const hidden = input.closest('.modal-form')?.querySelector('input[name=customerId]');
  if (!results) return;

  clearTimeout(searchTimer);
  const term = input.value.trim();
  if (term.length < 2) {
    results.innerHTML = '';
    return;
  }

  searchTimer = setTimeout(async () => {
    try {
      const { items } = await api.get('/pos/customers', { search: term, limit: 8 });
      ui.render(results, items.length
        ? html`<div class="lookup-list">
            ${items.map((c) => html`
              <button type="button" class="lookup-item" data-pick="${c._id}"
                      data-label="${c.fullName}${c.phone ? ` · ${c.phone}` : ''}">
                <span class="avatar avatar--sm">${fmt.initials(c.fullName)}</span>
                <span class="lookup-body">
                  <span class="cell-title">${c.fullName}</span>
                  <span class="cell-sub">${[c.phone, c.email].filter(Boolean).join(' · ')}</span>
                </span>
                <span class="figure figure--points">${fmt.pointsBare(c.walletPoints)} pts</span>
              </button>`)}
          </div>`
        : html`<p class="form-hint">No customer matches “${term}”.</p>`);
    } catch (error) {
      ui.render(results, html`<p class="form-hint">${error.message}</p>`);
    }
  }, 300);
});

document.addEventListener('click', (event) => {
  const pick = event.target.closest('[data-pick]');
  if (!pick) return;
  event.preventDefault();
  const form = pick.closest('.modal-form');
  form.querySelector('input[name=customerId]').value = pick.dataset.pick;
  form.querySelector('[data-customer-search]').value = pick.dataset.label;
  form.querySelector('[data-customer-results]').innerHTML = '';
  // A picked account and a typed walk-in name are alternatives; clearing the
  // walk-in fields stops the server being sent both.
  form.querySelector('input[name=name]').value = '';
  form.querySelector('input[name=phone]').value = '';
});
