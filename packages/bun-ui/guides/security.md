# The security UI: `@kingsleyweb/bun-ui/security`

`securityUi()` serves the management UI of `@kingsleyweb/bun-security`'s
control plane (`createSecurityApi()`): a React app on bun-ui's kit, mounted
beside the API on the same adapter. Built so far: the frame, the scope
picker, the Overview, the API reference, the live updates, step-up and the
break-glass sign-in (PR-U1 of the bun-security plan); the bans, the
allow and deny lists and the events (PR-U3). The screens of later parts
(analytics, policy, approvals, audit) join the nav as they are built.

## Install

```sh
bun add @kingsleyweb/bun-ui @kingsleyweb/bun-security
```

`@kingsleyweb/bun-security` is an optional peer of bun-ui that only the
`/security` entries need.

## Mounting

Beside the API, each at its own `basePath`; the UI's may not equal or sit
under the API's (a `ConfigError`). The API's own paths may sit under the
UI's: the UI's router leaves them to the API.

```ts
import { createSecurityApi } from "@kingsleyweb/bun-security/control";
import { securityUi } from "@kingsleyweb/bun-ui/security";

const api = createSecurityApi({ store, authenticate, signing, audit, bans, basePath: "/security/api" });
const ui = securityUi({ api, basePath: "/security" });
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);
```

With the API elsewhere, name it: `securityUi({ apiUrl: "https://sec.example.com/api", breakGlass: true })`.
`breakGlass` says whether that API has a break-glass account; with `api` it
is read from the API.

## `securityUi(options)`

| Option | Default | What it does |
|---|---|---|
| `api` | — | A `createSecurityApi()` result. Its `basePath`, its CSRF header and whether it has a break-glass account come from it. One of `api` and `apiUrl`. |
| `apiUrl` | — | The API's base, a path or an absolute `http(s)` URL. A cross-origin one is added to the page's `connect-src`. |
| `breakGlass` | `false` | With `apiUrl`: whether the API has a break-glass account (with `api`, read from it). The sign-in view offers the break-glass form only when it is true. |
| `basePath` | `"/security"` | Where the UI is mounted. |
| `title` | `"Security"` | The page title. |
| `csrfHeader` | `"x-bun-security-csrf"` | The header every change carries (the API's default). |
| `authorize` | none | Guards the shell and the assets, as every bun-ui UI's. The API checks every call itself whatever this says. |
| `unauthorized` | none | Where the browser goes for a `401` (the kit's option, as the jobs UI's). |
| `theme`, `layout` | `"system"`, centred 1400px | The kit's: the theme, and where the content sits on a wide screen. |
| `middleware`, `dev`, `logger` | | As every bun-ui UI's. |

The page's CSP is the kit's strict nonce policy. The live updates are
server-sent events, so `connect-src` allows no `ws(s)` origin.

## Screens

- **Overview** (`/`), the landing screen: the scope's published policy, its
  active bans, the agents' health and the audit chain's check. Each card
  shows only when the operator may read it, reads on its own, and is left
  out when the deployment does not run that part (no agents).
- **Lists** (`/lists`, `/lists/new`): the scope's allow and deny entries
  (addresses and ranges, users, API keys, countries, ASNs), from its draft
  when there is one, else its published version, with the entries a
  service or group inherits from the scopes above shown read-only (and
  locked ones marked). Filter by kind, action and expiry; search by value
  (an address finds the ranges holding it). Changes collect in the draft:
  **Save draft**, **Discard draft**, then **Publish** (an impact estimate
  first if you like; a dangerous change asks you to type the scope's name
  and lists why; a step-up, or an approval). **Import CSV** (up to 10,000
  rows, checked before anything is written) and **Export CSV**. An account
  entry is keyed by the control plane on save: what you typed is shown
  once, then only its key.
- **Bans** (`/bans`): the control plane's bans on the scope and under it,
  filtered by state, subject kind, source, rule and subject (an address
  finds the ranges holding it), sorted by start or end, a page at a time.
  A new ban never moves the page: it is counted in an **N new — show**
  chip. **Lift matching…** lifts every active ban the filter matches,
  after a count ("1,204 active bans match"), behind a step-up or, under
  two-person approvals, by opening an approval. The source filter offers
  **Automatic** once the control plane holds automatic bans: the bans the
  services' engines write themselves, which their agents report; an
  automatic ban shows its rule and, for the ladder's, its step. Lifting one
  lifts it on the service's engines too.
- **A ban** (`/bans/:id`): its subject (with its country and ASN when
  known), state and writes; its history (the audit entries on it); the
  subject's events that led to it and its hits since; its bans in other
  scopes; the escalation ladder's step for a ladder ban; and, with
  `bans:write` on its scope, **Extend**, **Make
  permanent**, **Widen to the /24** (or /64) and **Lift**. Extending works
  on an account's key: no raw id is asked for.
- **New ban** (`/bans/new`): an address or range, an account id (keyed by
  the control plane: what you typed is shown once, then only its key), or
  an account key; the action, how long (24 h by default, or until lifted)
  and why. It warns when the subject holds your own address (as the API
  sees it).
- **Automatic bans** (`/bans/auto`): the engines' bans as the events show
  them, by rule, each with **Make a fleet ban**.
- **Events** (`/events`, `/events/:id`): every stored event, filtered,
  paginated, with an **N new — show** chip, and an event's detail with its
  redacted request.
- **API reference** (`/api`): the management API's OpenAPI document, read
  only (no try-it: these calls change what protects the services).

Account subjects (users, API keys, usernames) appear everywhere as the keys
the API returns, never as the ids the services know.

### Links into the forms

Other screens (and other tools) open the forms pre-filled. One subject
parameter per link; a bad value opens the form with that field empty and
flagged, and nothing is sent until the operator confirms.

| Link | Parameters |
|---|---|
| `/bans/new` | `scope`; `ip` (an address or CIDR range), `userHash` or `apiKeyHash` (a key as the API reports it); optional `action` (`ban`, `challenge`), `duration` (`1h`, `24h`, `7d`, `30d`, `permanent`), `reason` |
| `/lists/new` | `scope`; `ip`, `country` (ISO 3166-1 alpha-2), `asn`, `userHash` or `apiKeyHash`; optional `action` (`allow`, `block`, `challenge`, `drop`), `reason` |
| `/events/:id` | an event's id: its detail over the events list |

The nav shows only the sections that are built and that the operator may
use on the scope. A link to a section they may not use shows **No access**:
which section, which scope, and the permission it needs.

### Scopes

Every screen shows one scope: `global`, a group (`group:<id>`) or a service
(`service:<id>`), named in the URL's `scope` parameter, so a link shares
what its sender saw. With no `scope`, the screen shows `global` when the
operator can read it, else their first readable group, then service. The
picker lists only the scopes the operator can read: global and every group
and service for a global reader; otherwise the scopes their roles are bound
on.

### What each element needs

The app boots with `GET /meta`, `GET /meta/permissions?scope=global` and
`GET /operators/me`. A screen asks `GET /meta/permissions?scope=<scope>` for
the scope on screen, and its elements read that answer. An element the
operator may not use is absent, not disabled.

| Element | Needs |
|---|---|
| Overview (nav and route) | `policy:read` on the scope |
| Overview: Policy card | `policy:read` on the scope |
| Overview: Active bans card | `bans:read` on the scope |
| Overview: Agents card | `agents:read` on global |
| Overview: Audit chain card | `audit:read` on global |
| API reference (nav and route) | signing in |
| Scope picker: every group and service | `policy:read`, `groups:read`, `services:read` on global |
| Live updates: `bans:<scope>` topic | `bans:read` on the scope |
| Live updates: `policy:<scope>` topic | `policy:read` on the scope |
| Bans (nav and route), the list, a ban's detail | `bans:read` on the scope |
| Bans: New ban, Lift matching…, the New ban form | `bans:write` on the scope |
| A ban: Extend, Make permanent, Widen, Lift | `bans:write` on the ban's scope |
| A ban: what led to it, hits since (an address) | `analytics:read` on the ban's scope |
| A ban: what led to it, hits since (an account) | `analytics:read` and `events:read` on the ban's scope |
| A ban: its bans in other scopes | `bans:read` on each of them |
| Bans: Automatic bans link | `analytics:read` on the scope |
| Live updates: `events:<scope>` topic (while the events list is open) | `analytics:read` on the scope |
| Lists (nav and route), the entries, CSV export | `policy:read` on the scope |
| Lists: entries inherited from the scopes above (a service's or a group's) | `policy:read` on the scope |
| Lists: New entry, Remove, CSV import, Save draft, Discard draft | `policy:draft` on the scope |
| Lists: Estimate impact | `rules:test` on the scope |
| Lists: Publish | `policy:publish` on the scope (a step-up, or an approval under two-person approvals) |
| Events (nav and route), the list | `analytics:read` on the scope |
| Events: user key, API key key and username key filters | `events:read` on the scope |
| An event's detail (`/events/:id`) | `events:read` on the event's service (else "No access" in the drawer) |
| An event: Ban this address / user key / API key key | `bans:write` on the scope |
| An event: Allow / deny in lists (an address) | `policy:draft` on the scope |
| Automatic bans (`/bans/auto`) | `analytics:read` on the scope (the Bans section needs `bans:read`) |
| Automatic bans: Make a fleet ban | `bans:write` on the scope |

### Lists

A list's position is in the URL: `page` is the trail of cursors walked (so
Previous goes back one, and the browser's back button too) and `limit` the
page size, up to 200. Changing the size or the scope starts the list again.

### Live updates

The UI subscribes to the API's `GET /live` (server-sent events) for the
scope's topics the operator may read, resuming with `Last-Event-ID` after a
drop. An event refetches what the screen shows, coalesced over 250 ms. The
header's badge says **Live**, **Connecting…**, **Reconnecting…**, or
**Polling 15s** when the stream is refused or off: the screen then refreshes
every 15 seconds.

## Step-up

An action the API answers `401 step_up_required` opens the problem's
`stepUpUrl` in a popup. The host's step-up page does its check, then tells
the UI and closes:

```js
// On the step-up page, once the check passed:
window.opener?.postMessage(
  { type: "bun-security:step-up", ok: true },
  "https://admin.example.com", // the UI's origin, never "*"
);
window.close();
```

The UI accepts the message only from the step-up page's origin, and then
runs the action **once** more. A popup closed without the message (cancelled
or failed), a message with `ok: false`, or a blocked popup retries nothing:
the action's `step_up_required` error stands.

## Break-glass sign-in

When the API has a break-glass account, the **Sign in required** view (a
`401` on loading) offers **Break-glass sign-in**: the account's password and
an authenticator code, sent to `POST /break-glass/session`. The session's
token is kept in `sessionStorage` (gone when the tab closes) and sent in
`x-bun-security-break-glass` on every call. The header shows **Break-glass
session until <time>** while it lasts. The token is cleared when it expires
or when the API answers `401`. Too many failed attempts lock the account
(`429`), which the form says. Every use is audited and alerted by the API.

## Testing without a socket

`ui.router.fetch("/")` serves the shell, as every bun-ui router does.
