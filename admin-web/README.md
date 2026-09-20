# VIPs Admin Dashboard

The platform's administration console. It runs in a browser, is served by the
VIPs backend itself, and drives the `/api/admin` API that backend already
exposes.

```
http://localhost:3000/admin/
```

## Running it

There is no build step and no separate process. Start the backend and the
console is there:

```bash
cd lib/vips-backend
npm install
npm start          # or: npm run dev
open http://localhost:3000/admin/
```

The first admin account cannot be created over HTTP — an unauthenticated
"make me an admin" endpoint would make the console pointless — so mint one
from a shell with database access:

```bash
npm run create-admin -- --email=ops@vips.tn --password='…' \
  --name='Ops Team' --phone=+21600000000 --role=super_admin
```

Every further operator is created from inside the console, on **Operators**.

## Where it came from

The look and the information architecture are lifted from the QRPayPro admin
theme in `lib/admin_dashboard/`. That product is a Laravel/MySQL wallet
application, and its data layer has nothing to do with this platform — the
VIPs backend is Node and MongoDB, and it already implements the business
documents. So what was reused is what was actually valuable and portable:

- `assets/css/style.css` — the vendor stylesheet, kept **byte-for-byte** as
  shipped so it stays updatable.
- `assets/css/bootstrap.css`, `line-awesome.css`, `fontawesome-all.css`,
  `animate.css`, the icon fonts, `apexcharts.js`, `bootstrap.bundle.js`.
- The markup vocabulary: `.custom-card`, `.custom-table`, `.badge--*`,
  `.sidebar-menu`, `.dashboard-title-part`, and the theme's own
  `dark-sidebar` mode.

`assets/css/vips-theme.css` restates only the brand-coloured declarations in
the VIPs palette (`#5a5278 → #00205C`, `#7367f0 → #FA6B25`). It is generated
from `style.css` rather than hand-listed, so a colour buried in a rule nobody
thought to check is not missed. `assets/css/app.css` adds the pieces the
vendor theme has no markup for — sign-in, stat tiles, filter bars, toasts,
modals, empty and error states.

The vendor's `main.js`, jQuery, select2 and nice-select were **not** taken:
they bind on page load, and this console re-renders. What is needed instead
is a few dozen lines of delegated handling in `app/main.js`.

## How it is built

No bundler, no framework, no build. Native ES modules, loaded by the browser.

```
index.html              sign-in card + app chrome
app/main.js             boot, routing table, sidebar, session
app/nav.js              the sidebar, and the single list of what exists
app/core/
  api.js                the only place that talks to the backend
  auth.js               session and permission checks
  router.js             hash routing, per-screen cleanup
  ui.js                 cards, tables, modals, toasts, charts, states
  format.js             money, points and diamonds — kept apart on purpose
  config.js             the platform's own numbers, from /api/admin/config
  dashboard-kit.js      the period picker the five dashboards share
app/screens/*.js        one module per screen
assets/                 vendor theme + brand layer
```

A screen module exports `{ title, subtitle?, permission?, render(host, ctx) }`
and may return a cleanup function, which the router calls before the next
screen draws — that is how charts get destroyed rather than leaking a resize
listener each time you navigate.

## What is on it

| Area | Screens |
|---|---|
| Overview | Dashboard |
| Insight | Sales, Operations, Finance, Marketing, Merchant health, Visitors |
| People | Customers, Merchants, Guarantee balances, Refund requests |
| Commerce | Orders, Products, Offers, Subscriptions, Wallets & points, Advertisements, Broadcasts, Stock, Movements, Low stock, Till, Sessions, Receipts |
| Reports | Sales, Profit, Commission, Products, Customers, Merchants, Orders |
| Administration | Operators, Roles, Audit log, Settings, My profile, Search |

The console covers the platform's operational admin endpoints. The integration
suite asserts that every call the console makes has a route and every protected
admin route has a usable console flow, so a new endpoint with no screen fails
the build rather than quietly becoming a feature nobody can use.

## Things worth knowing before changing it

**Units are kept apart.** Dinars, loyalty points (100 = 1 TND) and club
diamonds (10,000 = 1 TND) all look like numbers on a screen. `format.js` has
a function per unit and every figure goes through one. Printing one in the
shape of another overstates a balance by two orders of magnitude.

A `Transaction` row carries its own `currency` — the ledger holds PTS, TND,
DMD and some historic USD together — so render those with
`ui.amountIn(amount, currency)`, never `ui.money()`. Money figures are shown
to three decimals because the dinar has three: the millime is a real unit
here, and the platform documents price in it.

**The business rules come from the server.** Plan fees, budget names, the
Giftback cap, the refund cycle — `core/config.js` reads them from
`/api/admin/config`, which reads `config/economics.js`, which cites the
platform documents. Do not restate a number here.

**Permissions hide, they do not protect.** `auth.can()` mirrors
`middleware/permissions.js` so the console shows an operator only what they
can use. Every action is still checked server-side; a hidden button is a
courtesy. Screens are expected to receive a 403 and render it.

**Everything interpolated is escaped.** `ui.html` escapes by default; `raw()`
is the single greppable way to opt out. Shop names and customer notes reach
these tables straight from user input.

**Financial records are not deleted.** An order cancels, a receipt refunds, a
stock line writes a "removed" movement before it goes. The controls say what
actually happens rather than what the HTTP verb is called.

## Assets and caching

Nothing in `assets/` is content-hashed, so the backend serves this folder with
`Cache-Control: no-cache` — meaning *revalidate*, not *do not store*. An
unchanged file costs a 304 with no body; a changed one arrives immediately. A
long `max-age` here would leave operators on yesterday's stylesheet with
today's markup.
