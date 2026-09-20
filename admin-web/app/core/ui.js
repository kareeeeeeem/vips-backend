/**
 * The console's building blocks, in the vendor theme's own class vocabulary
 * (`.custom-card`, `.custom-table`, `.badge--success`, `.dashbord-item`), so
 * anything built here inherits the theme instead of fighting it.
 *
 * Everything interpolated through `html` is escaped. A merchant's shop name
 * and a customer's note are attacker-controlled strings that land in these
 * tables; `raw()` is the single, greppable way to opt out of that.
 */

import { ApiError } from './api.js';
import * as fmt from './format.js';

// ── templating ───────────────────────────────────────────────

const RAW = Symbol('raw');

/** Mark a string as already-safe markup. Use it only on markup you built. */
export const raw = (value) => ({ [RAW]: String(value ?? '') });

export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const flatten = (value) => {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(flatten).join('');
  if (typeof value === 'object' && RAW in value) return value[RAW];
  return esc(value);
};

/** Tagged template that escapes every interpolation. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += flatten(values[i]) + strings[i + 1];
  return raw(out);
}

/** Turn markup into a DOM node (a fragment when it has several roots). */
export function node(markup) {
  const template = document.createElement('template');
  template.innerHTML = typeof markup === 'string' ? markup : flatten(markup);
  return template.content.childElementCount === 1
    ? template.content.firstElementChild
    : template.content;
}

/** Replace an element's contents with markup or a node. */
export function render(host, content) {
  host.innerHTML = '';
  if (content === null || content === undefined) return host;
  host.append(content instanceof Node ? content : node(content));
  return host;
}

// ── chrome ───────────────────────────────────────────────────

/** A titled panel. `actions` is markup rendered on the right of the header. */
export const card = ({ title, subtitle, actions, body, className = '' }) => html`
  <div class="card custom-card ${className}">
    ${title || actions ? html`
      <div class="card-header">
        <div class="card-header-left">
          <h6 class="title">${title}</h6>
          ${subtitle ? html`<p class="sub-title">${subtitle}</p>` : ''}
        </div>
        ${actions ? html`<div class="card-header-right">${actions}</div>` : ''}
      </div>` : ''}
    <div class="card-body">${body}</div>
  </div>`;

/**
 * A headline figure. `tone` colours the delta chip; `hint` is the quiet line
 * under the number, which is where a points figure says what it is in dinars.
 */
export const statCard = ({ label, value, hint, chips = [], icon, tone = 'base' }) => html`
  <div class="dashbord-item stat-card stat-card--${tone}">
    <div class="dashboard-content">
      <div class="left">
        <h6 class="title">${label}</h6>
        <div class="user-info"><h2 class="user-count">${value}</h2></div>
        ${hint ? html`<p class="stat-hint">${hint}</p>` : ''}
        ${chips.length ? html`<div class="user-badge">
          ${chips.map((c) => html`<span class="badge badge--${c.tone || 'info'}">${c.label}</span>`)}
        </div>` : ''}
      </div>
      ${icon ? html`<div class="right"><span class="stat-icon"><i class="${icon}"></i></span></div>` : ''}
    </div>
  </div>`;

/** Wrap stat cards in the responsive grid the theme expects. */
export const statGrid = (cards) => html`
  <div class="row stat-grid">
    ${cards.map((c) => html`<div class="col-xxl-3 col-xl-4 col-lg-6 col-md-6 col-sm-12 mb-15">${c}</div>`)}
  </div>`;

const TONES = {
  success: ['active', 'approved', 'completed', 'delivered', 'picked_up', 'paid', 'open', 'granted', 'resolved'],
  warning: ['pending', 'processing', 'under_review', 'handover', 'confirmed', 'partial', 'suspended'],
  danger: ['banned', 'rejected', 'canceled', 'cancelled', 'failed', 'closed', 'expired', 'inactive', 'refunded'],
};

/** Colour a status by what it means, so every table agrees on what red is. */
export function statusTone(status) {
  const key = String(status || '').toLowerCase();
  for (const [tone, values] of Object.entries(TONES)) if (values.includes(key)) return tone;
  return 'info';
}

export const badge = (label, tone) =>
  html`<span class="badge badge--${tone || 'info'}">${label}</span>`;

export const statusBadge = (status) =>
  badge(fmt.humanise(status), statusTone(status));

/** A name with its secondary line — the shape most first columns want. */
export const identity = ({ title, subtitle, initials }) => html`
  <div class="cell-identity">
    <span class="avatar avatar--sm">${initials ?? fmt.initials(title)}</span>
    <div>
      <span class="cell-title">${title || '—'}</span>
      ${subtitle ? html`<span class="cell-sub">${subtitle}</span>` : ''}
    </div>
  </div>`;

/** A figure that says which unit it is in. */
export const money = (value) => html`<span class="figure figure--money">${fmt.tnd(value)}</span>`;
export const pointsFigure = (value) => html`
  <span class="figure figure--points" title="${fmt.pointsAsTnd(value)}">${fmt.points(value)}</span>`;

/**
 * An amount rendered in the unit its record says it is in.
 *
 * Transaction rows carry a `currency`, and the ledger holds all of PTS, TND,
 * DMD and some historic USD. Rendering every row with `money()` printed a
 * 360-point reward as "360.000 TND" — a hundred times its value, which is
 * exactly the confusion format.js exists to prevent.
 */
export function amountIn(value, currency) {
  switch (String(currency || 'TND').toUpperCase()) {
    case 'PTS':
      return pointsFigure(value);
    case 'DMD':
      return html`<span class="figure figure--points"
        title="${fmt.tnd((Number(value) || 0) / fmt.DIAMONDS_PER_TND)}">${fmt.diamonds(value)}</span>`;
    case 'TND':
      return money(value);
    default:
      // An unrecognised code is shown as written rather than assumed to be
      // dinars — some historic rows are labelled USD on dinar amounts, and
      // guessing would restate them as something they are not.
      return html`<span class="figure" title="Recorded as ${currency}">
        ${fmt.number(value)} ${currency}</span>`;
  }
}

// ── tables ───────────────────────────────────────────────────

/**
 * `columns` is `[{ key, label, cell?, align?, width? }]`.
 * `cell(row)` returns markup; without one the raw `row[key]` is escaped.
 */
export function table({ columns, rows, empty = 'Nothing here yet.', rowAttrs }) {
  if (!rows || rows.length === 0) return emptyState(empty);
  return html`
    <div class="table-responsive">
      <table class="custom-table">
        <thead><tr>
          ${columns.map((c) => html`<th class="${c.align ? `text-${c.align}` : ''}"
            ${raw(c.width ? `style="width:${esc(c.width)}"` : '')}>${c.label}</th>`)}
        </tr></thead>
        <tbody>
          ${rows.map((row) => html`<tr ${raw(rowAttrs ? rowAttrs(row) : '')}>
            ${columns.map((c) => html`<td class="${c.align ? `text-${c.align}` : ''}"
              data-label="${c.label}">${c.cell ? c.cell(row) : row[c.key]}</td>`)}
          </tr>`)}
        </tbody>
      </table>
    </div>`;
}

/** A definition list, for detail panes. `rows` is `[[label, value], …]`. */
export const details = (rows) => html`
  <dl class="detail-list">
    ${rows.filter(Boolean).map(([label, value]) => html`
      <div class="detail-row"><dt>${label}</dt><dd>${value ?? '—'}</dd></div>`)}
  </dl>`;

// ── states ───────────────────────────────────────────────────

export const spinner = () => html`<span class="spinner" aria-hidden="true"></span>`;

export const loadingState = (label = 'Loading…') => html`
  <div class="state state--loading">${spinner()}<p>${label}</p></div>`;

export const emptyState = (message, hint) => html`
  <div class="state state--empty">
    <i class="las la-inbox"></i>
    <p>${message}</p>
    ${hint ? html`<span class="state-hint">${hint}</span>` : ''}
  </div>`;

/**
 * A failure the operator can act on: what went wrong, and a way to try again.
 * A 403 is called out as a permissions problem rather than an error, because
 * it is not one — the console simply drew a control this role cannot use.
 */
export function errorState(error, onRetry) {
  const isDenied = error instanceof ApiError && error.status === 403;
  const el = node(html`
    <div class="state state--error">
      <i class="las ${isDenied ? 'la-lock' : 'la-exclamation-triangle'}"></i>
      <p>${error?.message || 'Something went wrong.'}</p>
      ${isDenied
        ? html`<span class="state-hint">Ask a super admin to grant your role this permission.</span>`
        : html`<button type="button" class="btn btn--base btn-sm" data-retry>Try again</button>`}
    </div>`);
  const retry = el.querySelector('[data-retry]');
  if (retry && onRetry) retry.addEventListener('click', onRetry);
  return el;
}

// ── pagination ───────────────────────────────────────────────

/**
 * `meta` is whatever the endpoint returned: `{ page, pages, total, limit }`.
 * Calls `onPage(n)`. Returns a node, or null when there is only one page.
 */
export function pagination(meta, onPage) {
  const page = Number(meta?.page) || 1;
  const pages = Number(meta?.pages) || 1;
  const total = Number(meta?.total) || 0;
  if (pages <= 1) {
    return total
      ? node(html`<div class="pagination-bar"><span class="pagination-count">${fmt.number(total)} in total</span></div>`)
      : null;
  }

  // A window around the current page: first, last, and the neighbours, so a
  // 300-page audit log does not draw 300 buttons.
  const wanted = new Set([1, pages, page, page - 1, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((n) => wanted.add(n));
  if (page >= pages - 2) [pages - 1, pages - 2, pages - 3].forEach((n) => wanted.add(n));
  const numbers = [...wanted].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);

  const items = [];
  let previous = 0;
  for (const n of numbers) {
    if (n - previous > 1) items.push(html`<span class="pagination-gap">…</span>`);
    items.push(html`<button type="button" class="pagination-page ${n === page ? 'active' : ''}"
      data-page="${n}">${n}</button>`);
    previous = n;
  }

  const el = node(html`
    <div class="pagination-bar">
      <span class="pagination-count">Page ${page} of ${pages} · ${fmt.number(total)} in total</span>
      <div class="pagination-pages">
        <button type="button" class="pagination-page" data-page="${page - 1}" ${raw(page === 1 ? 'disabled' : '')}>
          <i class="las la-angle-left"></i></button>
        ${items}
        <button type="button" class="pagination-page" data-page="${page + 1}" ${raw(page === pages ? 'disabled' : '')}>
          <i class="las la-angle-right"></i></button>
      </div>
    </div>`);

  el.addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (!button || button.disabled) return;
    const target = Number(button.dataset.page);
    if (target >= 1 && target <= pages && target !== page) onPage(target);
  });
  return el;
}

// ── filters ──────────────────────────────────────────────────

/**
 * A row of filter controls above a table.
 *
 * `fields` is `[{ name, type, label, options?, placeholder?, value? }]` where
 * type is 'search' | 'select' | 'date'. Search debounces so a fast typist
 * does not fire a request per keystroke; the rest fire on change.
 */
export function filterBar({ fields, values = {}, onChange, actions }) {
  const el = node(html`
    <div class="filter-bar">
      <div class="filter-fields">
        ${fields.map((field) => {
    const value = values[field.name] ?? field.value ?? '';
    if (field.type === 'select') {
      return html`
            <label class="filter-field">
              <span>${field.label}</span>
              <select name="${field.name}">
                ${(field.options || []).map((o) => {
        const optValue = typeof o === 'string' ? o : o.value;
        const optLabel = typeof o === 'string' ? fmt.humanise(o) : o.label;
        return html`<option value="${optValue}" ${raw(String(optValue) === String(value) ? 'selected' : '')}>${optLabel}</option>`;
      })}
              </select>
            </label>`;
    }
    if (field.type === 'date') {
      return html`
            <label class="filter-field">
              <span>${field.label}</span>
              <input type="date" name="${field.name}" value="${value}">
            </label>`;
    }
    return html`
          <label class="filter-field filter-field--search">
            <span>${field.label}</span>
            <span class="search-wrap">
              <i class="las la-search"></i>
              <input type="search" name="${field.name}" value="${value}"
                     placeholder="${field.placeholder || 'Search…'}">
            </span>
          </label>`;
  })}
      </div>
      ${actions ? html`<div class="filter-actions">${actions}</div>` : ''}
    </div>`);

  const collect = () => {
    const out = {};
    el.querySelectorAll('[name]').forEach((input) => { out[input.name] = input.value; });
    return out;
  };

  let timer;
  el.addEventListener('input', (event) => {
    if (event.target.type !== 'search') return;
    clearTimeout(timer);
    timer = setTimeout(() => onChange(collect()), 350);
  });
  el.addEventListener('change', (event) => {
    if (event.target.type === 'search') return;
    onChange(collect());
  });

  return el;
}

// ── toasts ───────────────────────────────────────────────────

const TOAST_ICONS = {
  success: 'las la-check-circle',
  danger: 'las la-times-circle',
  warning: 'las la-exclamation-circle',
  info: 'las la-info-circle',
};

export function toast(message, tone = 'success', { timeout = 4500 } = {}) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const el = node(html`
    <div class="toast-item toast-item--${tone}" role="status">
      <i class="${TOAST_ICONS[tone] || TOAST_ICONS.info}"></i>
      <span>${message}</span>
      <button type="button" class="toast-close" aria-label="Dismiss">&times;</button>
    </div>`);
  const dismiss = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('.toast-close').addEventListener('click', dismiss);
  stack.append(el);
  if (timeout) setTimeout(dismiss, timeout);
}

/** Report a caught failure without swallowing it. */
export const toastError = (error) => {
  if (error?.cancelled || error?.status === 499) return;
  toast(error?.message || 'Something went wrong.', 'danger');
};

// ── modals ───────────────────────────────────────────────────

let openModal = null;

function closeModal() {
  if (!openModal) return;
  const host = document.getElementById('modal-host');
  host.hidden = true;
  host.innerHTML = '';
  document.body.classList.remove('modal-open');
  const { resolve } = openModal;
  openModal = null;
  resolve(null);
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openModal) closeModal();
});

/**
 * Show a dialog. Resolves with whatever `onSubmit` returns, or null when the
 * operator backs out. `onSubmit(values, dialog)` receives the form values.
 */
export function modal({ title, body, submitLabel = 'Save', submitTone = 'base', size = '', onSubmit }) {
  return new Promise((resolve) => {
    const host = document.getElementById('modal-host');
    host.hidden = false;
    document.body.classList.add('modal-open');

    const el = node(html`
      <div class="modal-backdrop-custom">
        <div class="modal-panel ${size ? `modal-panel--${size}` : ''}" role="dialog" aria-modal="true">
          <form class="modal-form">
            <div class="modal-head">
              <h5>${title}</h5>
              <button type="button" class="modal-x" data-close aria-label="Close">&times;</button>
            </div>
            <div class="modal-body-custom">${body}</div>
            <div class="modal-foot">
              <button type="button" class="btn btn--secondary" data-close>Cancel</button>
              <button type="submit" class="btn btn--${submitTone}" data-submit>${submitLabel}</button>
            </div>
          </form>
        </div>
      </div>`);

    host.innerHTML = '';
    host.append(el);

    openModal = { resolve };

    const finish = (value) => {
      host.hidden = true;
      host.innerHTML = '';
      document.body.classList.remove('modal-open');
      openModal = null;
      resolve(value);
    };

    el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => finish(null)));
    el.addEventListener('mousedown', (event) => { if (event.target === el) finish(null); });

    const form = el.querySelector('form');
    const submit = el.querySelector('[data-submit]');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!onSubmit) return finish(true);

      const values = Object.fromEntries(new FormData(form).entries());
      submit.disabled = true;
      submit.classList.add('is-busy');
      try {
        const result = await onSubmit(values, { close: finish, form });
        // `false` means the handler reported a problem and wants the dialog
        // left open with whatever it rendered inside.
        if (result !== false) finish(result === undefined ? true : result);
      } catch (error) {
        toastError(error);
      } finally {
        submit.disabled = false;
        submit.classList.remove('is-busy');
      }
      return undefined;
    });

    // Focus the first thing worth typing into.
    const first = el.querySelector('input:not([type=hidden]), select, textarea');
    if (first) first.focus();
  });
}

/** A yes/no dialog. Resolves true only when the operator confirms. */
export async function confirm({
  title = 'Are you sure?', message, submitLabel = 'Confirm', tone = 'danger', detail,
}) {
  const result = await modal({
    title,
    submitLabel,
    submitTone: tone,
    body: html`
      <p class="confirm-message">${message}</p>
      ${detail ? html`<div class="confirm-detail">${detail}</div>` : ''}`,
    onSubmit: () => true,
  });
  return result === true;
}

// ── form fields, for modal bodies ────────────────────────────

export const field = ({ name, label, type = 'text', value = '', required, placeholder, hint, attrs = '' }) => html`
  <label class="form-field">
    <span class="form-label">${label}${required ? html`<em>*</em>` : ''}</span>
    <input class="form-control" type="${type}" name="${name}" value="${value}"
           placeholder="${placeholder || ''}" ${raw(required ? 'required' : '')} ${raw(attrs)}>
    ${hint ? html`<span class="form-hint">${hint}</span>` : ''}
  </label>`;

export const selectField = ({ name, label, options, value = '', required, hint }) => html`
  <label class="form-field">
    <span class="form-label">${label}${required ? html`<em>*</em>` : ''}</span>
    <select class="form-control" name="${name}" ${raw(required ? 'required' : '')}>
      ${options.map((o) => {
    const v = typeof o === 'string' ? o : o.value;
    const l = typeof o === 'string' ? fmt.humanise(o) : o.label;
    return html`<option value="${v}" ${raw(String(v) === String(value) ? 'selected' : '')}>${l}</option>`;
  })}
    </select>
    ${hint ? html`<span class="form-hint">${hint}</span>` : ''}
  </label>`;

export const textareaField = ({ name, label, value = '', rows = 3, placeholder, hint, required }) => html`
  <label class="form-field">
    <span class="form-label">${label}${required ? html`<em>*</em>` : ''}</span>
    <textarea class="form-control" name="${name}" rows="${rows}"
              placeholder="${placeholder || ''}" ${raw(required ? 'required' : '')}>${value}</textarea>
    ${hint ? html`<span class="form-hint">${hint}</span>` : ''}
  </label>`;

export const checkboxField = ({ name, label, checked, hint }) => html`
  <label class="form-check-field">
    <input type="checkbox" name="${name}" value="1" ${raw(checked ? 'checked' : '')}>
    <span>${label}</span>
    ${hint ? html`<span class="form-hint">${hint}</span>` : ''}
  </label>`;

/** Two fields side by side. */
export const fieldRow = (...fields) => html`<div class="form-row">${fields}</div>`;

// ── buttons ──────────────────────────────────────────────────

export const button = ({ label, icon, tone = 'base', size = '', action, attrs = '' }) => html`
  <button type="button" class="btn btn--${tone} ${size ? `btn-${size}` : ''}"
          ${raw(action ? `data-action="${esc(action)}"` : '')} ${raw(attrs)}>
    ${icon ? html`<i class="${icon}"></i>` : ''}${label}
  </button>`;

/** The small icon buttons that end a table row. */
export const rowAction = ({ icon, title, action, id, tone = 'info' }) => html`
  <button type="button" class="row-action row-action--${tone}" title="${title}"
          data-action="${action}" data-id="${id}"><i class="${icon}"></i></button>`;

/**
 * Delegate clicks on `[data-action]` within a container to named handlers.
 * Survives re-renders, which direct binding does not.
 */
export function actions(container, handlers) {
  container.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target || !container.contains(target)) return;
    const handler = handlers[target.dataset.action];
    if (!handler) return;
    event.preventDefault();
    Promise.resolve(handler(target.dataset, target)).catch(toastError);
  });
  return container;
}

// ── charts ───────────────────────────────────────────────────

const CHART_COLOURS = ['#FA6B25', '#00205C', '#28c76f', '#1e9ff2', '#ff9f43', '#7367f0', '#ea5455'];

/**
 * Draw an ApexChart into `host`, replacing whatever was there.
 *
 * Returns the chart so a caller can destroy it; screens that re-render are
 * expected to, since an orphaned chart keeps its resize listener alive.
 */
export function chart(host, options) {
  if (typeof ApexCharts === 'undefined') {
    render(host, emptyState('Charts are unavailable — apexcharts.js did not load.'));
    return null;
  }
  host.innerHTML = '';
  // `...options` goes first: spreading it last would put the caller's own
  // `chart` object back over the merged one, dropping the shared defaults —
  // which is how every chart ended up drawing Apex's zoom toolbar on top of
  // its legend.
  const instance = new ApexCharts(host, {
    colors: CHART_COLOURS,
    ...options,
    chart: {
      fontFamily: 'Karla, sans-serif',
      toolbar: { show: false },
      animations: { enabled: true, easing: 'easeout', speed: 400 },
      ...options.chart,
    },
    grid: { borderColor: '#eef0f4', strokeDashArray: 4, ...options.grid },
    dataLabels: { enabled: false, ...options.dataLabels },
    tooltip: { theme: 'light', ...options.tooltip },
  });
  instance.render();
  return instance;
}

/** A line/area chart over a date series. */
export const timeSeries = (host, { series, categories, height = 300, type = 'area' }) =>
  chart(host, {
    series,
    chart: { type, height, sparkline: { enabled: false } },
    stroke: { curve: 'smooth', width: 2.5 },
    fill: type === 'area'
      ? { type: 'gradient', gradient: { shadeIntensity: 0.4, opacityFrom: 0.35, opacityTo: 0.02, stops: [0, 90, 100] } }
      : { opacity: 1 },
    xaxis: {
      categories,
      labels: { style: { colors: '#9097a7', fontSize: '12px' }, rotate: -35, hideOverlappingLabels: true },
      axisBorder: { show: false }, axisTicks: { show: false },
    },
    yaxis: { labels: { style: { colors: '#9097a7' }, formatter: (v) => fmt.compact(v) } },
    legend: { position: 'top', horizontalAlign: 'right', markers: { radius: 4 } },
  });

export const donut = (host, { series, labels, height = 280, formatter }) =>
  chart(host, {
    series,
    labels,
    chart: { type: 'donut', height },
    legend: { position: 'bottom' },
    plotOptions: {
      pie: {
        donut: {
          size: '68%',
          labels: {
            show: true,
            total: {
              show: true,
              label: 'Total',
              formatter: (w) => {
                const total = w.globals.seriesTotals.reduce((a, b) => a + b, 0);
                return formatter ? formatter(total) : fmt.compact(total);
              },
            },
          },
        },
      },
    },
  });

export const bars = (host, { series, categories, height = 300, horizontal = false, formatter }) =>
  chart(host, {
    series,
    chart: { type: 'bar', height },
    plotOptions: { bar: { horizontal, borderRadius: 4, columnWidth: '55%' } },
    xaxis: {
      categories,
      labels: { style: { colors: '#9097a7', fontSize: '12px' } },
      axisBorder: { show: false }, axisTicks: { show: false },
    },
    yaxis: { labels: { style: { colors: '#9097a7' }, formatter: formatter || ((v) => fmt.compact(v)) } },
    legend: { position: 'top', horizontalAlign: 'right' },
  });

// ── misc ─────────────────────────────────────────────────────

/** A chart panel with its own host element, ready for `timeSeries` etc. */
export function chartCard({ title, subtitle, actions: headerActions, id, height = 300 }) {
  return card({
    title,
    subtitle,
    actions: headerActions,
    body: html`<div class="chart-host" id="${id}" style="min-height:${height}px"></div>`,
  });
}

/** Section heading between groups of panels. */
export const sectionTitle = (title, hint) => html`
  <div class="section-title">
    <h5>${title}</h5>
    ${hint ? html`<span>${hint}</span>` : ''}
  </div>`;

/** A short explanatory note — used where a screen encodes a business rule. */
export const note = (text, tone = 'info') => html`
  <div class="inline-note inline-note--${tone}"><i class="las la-info-circle"></i><span>${text}</span></div>`;
