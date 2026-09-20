/**
 * The platform's own numbers, fetched once from /api/admin/config.
 *
 * Plan fees, budget names, the Giftback cap, the refund cycle — all of it
 * comes from config/economics.js on the server. Screens ask for it here
 * instead of restating it, so the console cannot drift from the documents
 * the backend is built on.
 */

import * as api from './api.js';

let cache = null;
let inflight = null;

/** Sensible shapes for the brief moment before the real config arrives, and
 *  for the case where an operator's role somehow cannot read it. */
const FALLBACK = {
  pointsPerTnd: 100,
  diamondsPerTnd: 10000,
  earnRate: { default: 6, max: 100 },
  budgets: [
    { key: 'discount', label: 'ميزانية التخفيض' },
    { key: 'packages', label: 'ميزانية الباقات' },
    { key: 'general', label: 'الرصيد العام' },
  ],
  giftback: { MAX_CHANGE_TND: 5, MONTHLY_CAP_TND: 50, ACTIVATION_DELAY_HOURS: 12 },
  refund: { CYCLE_DAYS: 60, MIN_TND: 100, REVIEW_WORKING_DAYS: 5 },
  editCooldown: { CATALOG_HOURS: 12, STORE_DISCOUNT_HOURS: 24 },
  plans: [],
};

export async function load() {
  if (cache) return cache;
  if (!inflight) {
    inflight = api.get('/config')
      .then((data) => { cache = { ...FALLBACK, ...data }; return cache; })
      .catch(() => { cache = FALLBACK; return cache; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** What has already been loaded — never null, so a render can rely on it. */
export const get = () => cache || FALLBACK;

/** English labels for the three budgets, beside the Arabic ones the
 *  documents use. */
export const BUDGET_ENGLISH = {
  discount: 'Cashback budget',
  packages: 'Packages budget',
  general: 'General balance',
};

/** What each budget is for, shown where an operator has to choose one.
 *  Kept to one short line: these sit in a table column beside two figures. */
export const BUDGET_PURPOSE = {
  discount: 'Cashback — a share of each invoice returned as points',
  packages: 'Bundles priced under the sum of their parts',
  general: 'Receives voucher redemptions',
};

export const clear = () => { cache = null; };
