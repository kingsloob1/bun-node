# The security UI: `@kingsleyweb/bun-ui/security`

`securityUi()` serves the management UI of `@kingsleyweb/bun-security`'s
control plane (`createSecurityApi()`): a React app on bun-ui's kit, mounted
beside the API on the same adapter. This is the first part of it (PR-U1 of
the bun-security plan): the frame, the scope picker, the Overview, the API
reference, the live updates, step-up and the break-glass sign-in. The
screens of later parts (analytics, policy, bans, approvals, audit) join the
nav as they are built.

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
- **API reference** (`/api`): the management API's OpenAPI document, read
  only (no try-it: these calls change what protects the services).

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
