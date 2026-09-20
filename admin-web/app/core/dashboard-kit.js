/**
 * What the five analytical dashboards share: the period picker, the
 * "vs. previous period" delta chips, and the export button.
 *
 * Every one of these screens reads a `{ window, previous, change, … }`
 * envelope from /api/admin/dashboards/*, so the period control and the delta
 * rendering are written once here rather than five slightly different times.
 */

import * as api from './api.js';
import * as fmt from './format.js';
import * as ui from './ui.js';
import * as auth from './auth.js';

const { html } = ui;

export const PERIODS = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'year', label: 'This year' },
  { value: 'custom', label: 'Custom range' },
];

/**
 * The delta chip beside a headline figure.
 *
 * `higherIsBetter: false` flips the colour, for the figures where a rise is
 * bad — cancellations, churn, fulfilment time. Without that a worsening
 * number would be drawn in green.
 */
export function deltaChip(change, { higherIsBetter = true, suffix = 'vs. previous' } = {}) {
  if (change === null || change === undefined || !Number.isFinite(Number(change))) return null;
  const value = Number(change);
  if (value === 0) return { label: `No change ${suffix}`, tone: 'info' };
  const good = higherIsBetter ? value > 0 : value < 0;
  return {
    label: `${value > 0 ? '▲' : '▼'} ${fmt.percent(Math.abs(value))} ${suffix}`,
    tone: good ? 'success' : 'danger',
  };
}

/** Chips array for statCard, dropping the nulls. */
export const chips = (...maybe) => maybe.filter(Boolean);

/**
 * The period bar every analytical dashboard carries.
 *
 * Custom dates are only shown once "Custom range" is picked — two date
 * inputs that do nothing under a "This month" selection are just confusing.
 */
export function periodBar({ query, onChange, exportName, extra }) {
  const isCustom = query.period === 'custom';
  const fields = [
    { name: 'period', type: 'select', label: 'Period', options: PERIODS, value: query.period || 'month' },
    ...(isCustom ? [
      { name: 'startDate', type: 'date', label: 'From', value: query.startDate || fmt.daysAgoIso(30) },
      { name: 'endDate', type: 'date', label: 'To', value: query.endDate || fmt.isoDate() },
    ] : []),
    ...(extra || []),
  ];

  return ui.filterBar({
    fields,
    values: query,
    onChange,
    actions: exportName && auth.can('reports.export')
      ? ui.button({ label: 'Export CSV', icon: 'las la-file-download', tone: 'secondary', size: 'sm', action: 'export' })
      : '',
  });
}

/** Wire the export button a `periodBar` may have drawn. */
export function wireExport(host, name, query) {
  ui.actions(host, {
    export: async () => {
      const filename = await api.download(`/dashboards/${name}/export`, { ...query, format: 'csv' },
        `${name}-dashboard.csv`);
      ui.toast(`Downloaded ${filename}.`);
    },
  });
}

/** The line under a dashboard title saying exactly what window is in view. */
export function windowNote(w) {
  if (!w) return '';
  const range = `${fmt.date(w.startDate)} → ${fmt.date(w.endDate)}`;
  return html`<p class="window-note">
    <i class="las la-calendar"></i>
    Showing <strong>${range}</strong>, grouped by ${w.groupBy}${w.comparedWith
  ? html`, compared with ${fmt.date(w.comparedWith.startDate)} → ${fmt.date(w.comparedWith.endDate)}` : ''}.
  </p>`;
}

/**
 * Read the period parameters out of the route query, defaulting sensibly.
 * Returned as-is to the API, so the two never disagree about the window.
 */
export const readQuery = (routeQuery) => ({
  period: routeQuery.period || 'month',
  ...(routeQuery.period === 'custom' ? {
    startDate: routeQuery.startDate || fmt.daysAgoIso(30),
    endDate: routeQuery.endDate || fmt.isoDate(),
  } : {}),
});

/** A note explaining a figure the platform genuinely cannot compute yet. */
export const notTracked = (note) => (note ? ui.note(note, 'warning') : '');
