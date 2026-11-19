# The security UI: `@kingsleyweb/bun-ui/security`

`securityUi()` serves the management UI of `@kingsleyweb/bun-security`'s
control plane (`createSecurityApi()`): a React app on bun-ui's kit, mounted
beside the API on the same adapter. Built so far: the frame, the scope
picker, the API reference, the live updates, step-up and the break-glass
sign-in (PR-U1 of the bun-security plan); the bans, the allow and deny
lists and the events (PR-U3); the analytics page (PR-U2), the landing
screen in place of U1's Overview. The screens of later parts (policy,
approvals, audit) join the nav as they are built.

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
| `shell` | `"full"` | The kit's: `"full"` the header and side nav; `"tabs"` a compact bar of the sections, the scope picker, the break-glass badge and the live badge; `"none"` the screen under a thin bar of the scope picker and the break-glass badge. The sections are `SECURITY_SECTIONS` (`/security/browser`). See [Frame and sections](../README.md#frame-and-sections). |
| `middleware`, `dev`, `logger` | | As every bun-ui UI's. |

The page's CSP is the kit's strict nonce policy. The live updates are
server-sent events, so `connect-src` allows no `ws(s)` origin.

## Screens

- **Analytics** (`/`), the landing screen (PR-U2, in place of U1's
  Overview): the scope's panels over a time range (the last 15 minutes to
  30 days, or a custom span; `?range=` in the URL, the default 24 hours).
  A range ending now refreshes as it goes, and the traffic chart and the
  activity feed follow the live stream. The panels: headline totals,
  traffic over time (stacked by action, with the dry run's would-block),
  the outcome mix (by action and by status class), top offenders (with an
  hourly sparkline, an address's highest offence score, its ban state, and
  links to the ban and allow-list forms), the activity feed (paused while
  hovered or focused, "N new" while paused, each row opening the event),
  per-rule hits (hits, blocks, would-blocks, false positives; sortable, with
  a trend), services and routes (with each service's p95 decision latency),
  geography and ASN (tables), the ban timeline, sign-in figures (the failure
  ratio against the same hours of the seven days before, successes after
  failures, the most usernames tried from one address in a minute),
  identifier patterns, agent health and IP-intel sources. Each panel loads
  on its own and fails on its own; one a deployment does not record says
  so. Every chart is an image with a text summary and a **Table** button
  that shows the same data as a table.
- **Services** (`/services`, `/services/new`, `/services/:id`): every
  service a page at a time, with its groups, environment and topology, its
  agents' health (their states, the bundle version they enforce against
  the latest, the signing key), its requests a minute and blocked share
  over the last hour, and its policy's mode with how many of its items run
  in dry run (read for the first 50 rows of a page). A service's form: its
  name, groups, environment, hosts, topology, labels and whether
  publishing it asks for a step-up; saved at the revision read (someone
  else's change since is shown with **Reload**); **Delete…** once its id is
  typed.
- **Groups** (`/groups`): the groups as a tree, each with its services and
  a link to its policy; **New group**, **Edit** (its name, parent and
  labels; a parent cannot be the group itself or one under it) and
  **Delete**, each at the revision read.
- **Policies** (`/policies`): the scope's policy editor, a tab per layer
  (General, Identity and trust, Lists, Crawlers, Connections, Rate limits,
  Counted rules and ladder, Request shape, Request rules, Deception, Bot
  signals, Sign-in, API keys) and the whole policy as JSON. Each field says
  whether it is **set here** (with **Reset to inherited**), **inherited
  from** a scope (a link to it, with **Override**), or at its default; a
  limit, counted rule or rule a scope above locked is greyed, **Locked by**
  that scope, with no override. Rate limits, counted rules, rules, the
  ladder and the crawler allowance are tables and forms of their own; the
  simple sections are forms made from the policy's JSON Schema (the API's
  OpenAPI document); a list of objects or a map is JSON; and every tab can
  switch to **Edit as JSON**. Changes collect as unsaved changes over the
  draft (else the published version): **Save draft** (a `422`'s issues show
  on their fields; someone else's save since is shown with **Reload**),
  **Forget changes**, **Discard draft**, and **Publish…** (U3's dialog: an
  impact estimate, a typed confirmation for a dangerous change, a step-up,
  or an approval). The draft's changes against the published version are
  listed above the tabs, and for a group's or global's draft, what it does to
  each service under it: each one's effective policy as published against
  with the draft (at most 200 services; a service the draft would not
  compile for says why; one you may not read is named as skipped). It
  shares the impact estimate's budget (6 a minute): past it, a notice with
  **Try again**. The **Crawlers** tab lists the conflicts the
  services' agents report (an allowed crawler's published range covered by
  a refusing entry or a manual ban), which the publish dialog repeats: they
  are the published policy's, since only the agents hold the ranges, so a
  draft's new conflicts show once it is published. Below them, a switch per
  registry crawler, the allowance's settings, and each verified crawler's
  requests, 404s, 429s from its own limit and the probe and honeypot hits
  its allowance lifted over the last 24 hours, and the spoofed claimants
  under the crawler each claimed.
  The **Request rules** tab holds the rule editor (PR-U5's, embedded here):
  each of the scope's rules edited in place with the matcher builder and
  saved with the rest of the draft, the inherited ones read-only with their
  locks, the managed probe set's settings, and a link to **Test a request**.
- **Versions** (`/policies/versions`): a scope's published versions, newest
  first. Tick any two to compare them, or compare one with the published
  version; **Roll back to this** publishes that version's content again as
  a new version, through the publish dialog.
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
- **Rules** (`/rules`, `/rules/new`, `/rules/edit/:id`): the scope's request
  rules (its draft's when there is one, else its published version's), each
  with its mode, what a hit does, its hits and dry-run would-blocks in the
  last 24 hours and how the draft changes it; the rules it inherits, with
  the scope each came from and whether it is locked; and the managed probe
  set as it applies here, which ships with bun-security's release (the
  version `GET /meta` names). **New rule** and **Edit** open the rule
  editor: its id, what a hit does (block, challenge, ban, drop, log), mode,
  weight, refusal status and code, a ban's length, verified crawlers,
  whether the scopes below may override it, and its condition in the
  matcher builder (**all** or **any** of a list, **not** one, tests of one
  target each; a regex is checked as you type with the control plane's own
  check, and a refused one is not saved). A save writes the scope's draft
  at the revision read; a draft changed meanwhile is read again. **Remove**,
  **Publish** and **Discard** act on the draft as on the Lists screen.
- **Test a request** (`/rules/test`): a request described in a form, or
  pasted as a raw HTTP request or a `curl` command, with the socket peer,
  the service's trust-proxy setting, the caller's identity, and what to
  assume of the address (country, ASN, classes) and the counters ("as if
  this address had counted 299 on `per-ip`"), run through a service's
  effective policy, or with the scope's draft in its place. It shows the
  decision, every rule that matched, how the client was resolved and
  through which hops, the keys it counts against, the crawler verdict,
  every step, and what the test could not evaluate. Nothing is counted,
  banned or kept.
- **Audit** (`/audit`, `/audit/:n`): the audit log, newest first, filtered
  by actor, action, time and (off `global`) the scope on screen; the latest
  signed checkpoint, and **Verify the chain** (every hash recomputed, the
  first problem first, the external sinks, intents with no done entry); an
  entry's changes, its state before and after, and the entry as hashed.
  **Export (JSON Lines)** downloads the filter's time range behind a
  step-up; the export is itself an audit entry.
- **Approvals** (`/approvals`, `/approvals/:id`): every approval with what
  it would do, where, who asked, when it expires and where it stands. A
  policy change shows its own diff (the policy it would publish against the
  version it expects, not the scope's draft, which may have moved on) and,
  on demand, its impact estimate; another change shows its summary.
  **Approve** (or **Close the review** for an emergency publish) and
  **Reject**, with a reason, are offered to an operator who may make the
  change on its scope and did not ask for it; approving carries the change
  out, behind its step-up.
- **Agents** (`/agents`, `/agents/new`, `/agents/:id`): every agent's state
  (OK, late, offline, signature failing, revoked, never seen), last
  heartbeat, the bundle version and signing key it last verified, the bans
  it holds and what it reported wrong (warnings, ban reports dropped); an
  agent's warnings, IP feeds and dropped ban reports. **New agent** makes a
  key for a service (a step-up) and shows its secret once; **Rotate** (a
  step-up) shows the new secret once and until when the old one is
  accepted (its first use of the new one, or 24 hours); **Revoke** ends the
  key at once.
- **Alerts** (`/alerts` and its tabs): the alerts open now (read-only: one
  closes when its rule's condition stops holding); the rules (what each
  watches, its channels; made and changed in a form by kind: a metric's
  total or rate, a baseline spike, a metric counting in every one of the
  last hours, a ban storm, an agent gone silent or
  reporting a warning); the channels (webhook, Slack-compatible webhook,
  email; the URL is write-only, a webhook's signing secret is shown once
  when made or rotated behind a step-up; **Send a test**); the delivery log
  and the dead letters (**Replay**). The channels, the log and the dead
  letters are the control plane's own: their tabs need `alerts:read` on
  `global`.
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

This table is parsed and checked by
[`examples/bun-ui/security/01-screens/permissions.ts`](../../../examples/bun-ui/security/01-screens/permissions.ts):
every row must have a gate there, every permission it names is one the API
checks, the nav gates as the table says, and each element that makes one
call is refused by the API without its permission. A row changed here is a
change to that example.

The app boots with `GET /meta`, `GET /meta/permissions?scope=global` and
`GET /operators/me`. A screen asks `GET /meta/permissions?scope=<scope>` for
the scope on screen, and its elements read that answer. An element the
operator may not use is absent, not disabled.

| Element | Needs |
|---|---|
| Analytics (nav and route) | `analytics:read` on the scope |
| Analytics: every panel but those below | `analytics:read` on the scope |
| Analytics: headline's ban tiles, ban timeline, top offenders' ban state | `bans:read` on the scope |
| Analytics: top offenders by user, username or API key | `events:read` on the scope |
| Analytics: top offenders' Ban link | `bans:write` on the scope |
| Analytics: top offenders' Allow link | `policy:draft` on the scope |
| Analytics: agent health, IP-intel sources | `agents:read` on global |
| API reference (nav and route) | signing in |
| Scope picker: every group and service | `policy:read`, `groups:read`, `services:read` on global |
| Live updates: `bans:<scope>` topic | `bans:read` on the scope |
| Live updates: `policy:<scope>` topic | `policy:read` on the scope |
| Services (nav and route), the services list, a service's form, the groups | `services:read` on the scope |
| Services: agents column | `agents:read` on global |
| Services: requests/min and blocked columns | `analytics:read` on global |
| Services: mode column | `policy:read` on global |
| Services: the latest bundle beside an agent's | `bundles:read` on global |
| Services: New service | `services:write` on global |
| Services: a service's Save and Delete… | `services:write` on the service (a binding on a group above it covers it) |
| Groups: New group | `groups:write` on global |
| Groups: a group's Edit and Delete | `groups:write` on the group (a binding on a group above it covers it) |
| Policies (nav and route), the editor, Versions | `policy:read` on the scope |
| Policies: a field's or an item's origin and lock (a service's or a group's) | `policy:read` on the scope |
| Policies: Override, Reset to inherited, Turn off here, New limit (and the other tables' New), Edit as JSON's changes, Save draft, Forget changes, Discard draft | `policy:draft` on the scope |
| Policies: Publish…, Versions' Roll back to this | `policy:publish` on the scope (a step-up, or an approval under two-person approvals) |
| Policies: Estimate impact (in the publish dialog), Request rules' Test a request link | `rules:test` on the scope |
| Policies: Crawlers' conflicts (in the tab and the publish dialog) | `agents:read` on global |
| Policies: Crawlers' traffic and spoofed claimants | `analytics:read` on the scope |
| Policies: what a draft does to each service | `policy:read` on the scope, and on each service shown |
| Bans (nav and route), the list, a ban's detail | `bans:read` on the scope |
| Bans: New ban, Lift matching…, the New ban form | `bans:write` on the scope |
| A ban: Extend, Make permanent, Widen, Lift | `bans:write` on the ban's scope |
| A ban: what led to it, hits since (an address) | `analytics:read` on the ban's scope |
| A ban: what led to it, hits since (an account) | `analytics:read` and `events:read` on the ban's scope |
| A ban: its bans in other scopes | `bans:read` on each of them |
| Bans: Automatic bans link | `analytics:read` on the scope |
| Live updates: `events:<scope>` topic (while the events list or the analytics page is open) | `analytics:read` on the scope |
| Live updates: `overview:<scope>` topic (while the analytics page is open) | `analytics:read` on the scope |
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
| Rules (nav and route), the list, inherited rules, the managed set | `policy:read` on the scope |
| Rules: hits and would-blocks | `analytics:read` on the scope |
| Rules: New rule, Edit, Remove, Discard draft, the rule editor's Save | `policy:draft` on the scope |
| Rules: Publish | `policy:publish` on the scope (a step-up, or an approval under two-person approvals) |
| Rules: Test a request link, the test | `rules:test` on the scope (and the service's) |
| Audit (nav and route), the list, an entry, the checkpoint, Verify the chain | `audit:read` on the scope (the API reads it on `global`) |
| Audit: Export | `audit:export` on the scope (the API checks `global`; a step-up) |
| Approvals (nav and route), the list, an approval | `approvals:read` on the scope |
| An approval: its diff | `approvals:read` and `policy:read` on its scope |
| An approval: Estimate impact | `rules:test` on its scope |
| An approval: Approve, Reject, Close the review | the change's permission on its scope (`policy:publish`, `roles:write`, `identities:write` or `bans:write`), and not its author |
| Agents (nav and route), the list, an agent | `agents:read` on the scope (the API reads it on `global`) |
| Agents: New agent | `agents:write` on the scope (the API checks the service's; a step-up) |
| An agent: Rotate, Revoke | `agents:write` on its service |
| Alerts (nav and route), open alerts, the rules | `alerts:read` on the scope (each rule shown on its own scope's) |
| Alerts: New rule | `alerts:write` on the scope |
| An alert rule: Save, Delete | `alerts:write` on its scope |
| Alerts: Channels, Delivery log, Dead letters tabs | `alerts:read` on global |
| Alerts: New channel, a channel's Save, Send a test, Rotate, Delete; a dead letter's Replay | `alerts:write` on global (a webhook's secret: a step-up) |

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

## Accessibility and layout

Every screen is checked in Chrome (`__tests__/security/e2e/a11y.e2e.test.ts`)
for one `main`, a `nav`, a banner and one `h1`; a name on every control,
image and link (a placeholder is a hint, and never stands in for a label);
an example placeholder in every text field and a "Choose a …" option in
every select that can be empty (one that always holds a value shows none); text contrast of WCAG AA (4.5:1, 3:1 for large text) in the
light and the dark theme; a visible focus indicator on every control the
Tab key reaches, in document order; and no sideways scroll at 375 px and
1440 px (a wide table scrolls inside its own labelled region). A dialog
opens, keeps focus and closes from the keyboard alone, giving focus back to
what opened it. The flows an operator runs (publishing behind a step-up, a
draft changed meanwhile, bans, lists, rules and testing a request, a second
operator's approval, agents, alert channels and rules, paging events while
they arrive) run end to end in `flows.e2e.test.ts`.

## Mounting it in your own page

`mountSecurityUi()` from `@kingsleyweb/bun-ui/security/mount` shows the security UI in your
page's content area (`apiBase, basePath`, plus the kit's options: `shell`,
`theme`, `layout`, `headers`, `credentials`, `onNavigate`,
`onUnauthorized`). See [Mounting a UI in your
page](../README.md#mounting-a-ui-in-your-page); `securityUiMountTags(ui)` gives
the tags for a page without a bundler.

## Styling it when mounted

A page that mounts the UI in its own layout links its mount stylesheet
(`@kingsleyweb/bun-ui/security/mount.css`). It keeps the host's global rules
out and its own rules in; to restyle it on purpose, set the theme's custom
properties on `[data-bun-ui="security"]`, or write a selector at least as
specific as the UI's (`[data-bun-ui="security"] .btn`) in a stylesheet linked
after it. See [The mount stylesheet](../README.md#the-mount-stylesheet).

## Testing without a socket

`ui.router.fetch("/")` serves the shell, as every bun-ui router does.
