# @kingsleyweb/bun-ui

Every bun-node browser UI in one package, each behind its own subpath. A UI is
a React app prebuilt into `dist/<ui>/` and served by a bun-common router you
mount on any bun-common `BunHttpAdapter`, `BunRouter` or bun-nest's
`BunHttpAdapter`: hash-named immutable assets, computed Subresource Integrity
and a strict Content-Security-Policy. React and TanStack Query are bundled, so
the host installs neither and has no build step.

| Subpath | What | Needs |
|---|---|---|
| `@kingsleyweb/bun-ui/jobs` | `jobsUi()`: the management UI for the `@kingsleyweb/bun-jobs` management API. [Guide](guides/jobs.md) | `@kingsleyweb/bun-jobs` |
| `@kingsleyweb/bun-ui/jobs/browser` | the jobs UI's browser-safe config contract (`JobsUiConfig`, `JOBS_UI_CONFIG_ELEMENT_ID`, …) | nothing |
| `@kingsleyweb/bun-ui/jobs/mount`, `/jobs/mount.css` | `mountJobsUi()`: the jobs UI in your own page's layout, prebuilt with React bundled in ([Mounting a UI in your page](#mounting-a-ui-in-your-page)) | nothing |
| `@kingsleyweb/bun-ui/security` | `securityUi()`: the management UI for `@kingsleyweb/bun-security`'s control plane. [Guide](guides/security.md) | `@kingsleyweb/bun-security` |
| `@kingsleyweb/bun-ui/security/browser` | the security UI's browser-safe config contract (`SecurityUiConfig`, `SECURITY_UI_CONFIG_ELEMENT_ID`, …) | nothing |
| `@kingsleyweb/bun-ui/security/mount`, `/security/mount.css` | `mountSecurityUi()`: the security UI in your own page's layout, prebuilt with React bundled in ([Mounting a UI in your page](#mounting-a-ui-in-your-page)) | nothing |
| `@kingsleyweb/bun-ui/docs` | `docsUi()`: a self-hosted viewer for one OpenAPI 3.1 or AsyncAPI 3.0 document. [Guide](guides/docs.md) | nothing |
| `@kingsleyweb/bun-ui/docs/browser` | the docs viewer's browser-safe config contract and the `unauthorized` helpers | nothing |
| `@kingsleyweb/bun-ui/docs/mount`, `/docs/mount.css` | `mountDocsUi()`: the docs viewer in your own page's layout, prebuilt with React bundled in ([Mounting a UI in your page](#mounting-a-ui-in-your-page)) | nothing |
| `@kingsleyweb/bun-ui/docs/hosted` | what bun-common's `docsRouter` `"self-hosted"` viewer loads to serve the viewer itself | nothing |
| `@kingsleyweb/bun-ui/docs/embed`, `/docs/embed/{routing,router,context,permissions,client,errors,unauthorized}` | the viewer's screens as source, for a React app that bundles them into its own UI | the host's `react` and `@tanstack/react-query` |
| `@kingsleyweb/bun-ui` | what every UI shares, browser-safe: `UiTheme`, the `unauthorized` option's types and defaults, `ASSET_CACHE_CONTROL` | nothing |

Each UI's domain package is an **optional** peer that only its own subpath
needs: install `@kingsleyweb/bun-jobs` to use `/jobs`. An app that mounts one
UI never loads another's code or bundle.

## Contents

- [Install](#install)
- [The jobs UI: `/jobs`](#the-jobs-ui-jobs)
- [The security UI: `/security`](#the-security-ui-security)
- [The docs viewer: `/docs`](#the-docs-viewer-docs)
- [Serving the viewer from `docsRouter`: `/docs/hosted`](#serving-the-viewer-from-docsrouter-docshosted)
- [Embedding the docs screens: `/docs/embed`](#embedding-the-docs-screens-docsembed)
- [The browser entries](#the-browser-entries)
- [Authorization and sign-in redirects](#authorization-and-sign-in-redirects)
- [Colour themes](#colour-themes)
- [Layout](#layout)
- [Frame and sections](#frame-and-sections)
- [Forms](#forms)
- [The mount stylesheet](#the-mount-stylesheet)
- [Mounting a UI in your page](#mounting-a-ui-in-your-page)
- [What a UI serves](#what-a-ui-serves)
- [Tree-shaking](#tree-shaking)
- [Troubleshooting](#troubleshooting)
- [Guides and examples](#guides-and-examples)

## Install

```bash
bun add @kingsleyweb/bun-ui                              # for /docs
bun add @kingsleyweb/bun-ui @kingsleyweb/bun-jobs       # for /jobs
bun add @kingsleyweb/bun-ui @kingsleyweb/bun-security   # for /security
```

Requires Bun >= 1.4.2. `@kingsleyweb/bun-common` is a dependency and is
installed with it; `@kingsleyweb/bun-jobs`, `@kingsleyweb/bun-security` and
`@types/bun` (>= 1.4.2) are optional peers. Bun runs the shipped TypeScript source in `lib/`; your type
checker reads the built declarations in `dts/`, which describe `lib/` only,
so no React or TanStack type reaches your project.

## The jobs UI: `/jobs`

A management UI and API documentation viewer for the bun-jobs management API
(`createJobsApi`). It holds no data and no secrets of its own: everything it
shows comes from the API, through the API's own `authorize`.

```ts
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { createJobsApi } from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-ui/jobs";

const api = createJobsApi({ jobs, basePath: "/admin/jobs-api", authorize });
const ui = jobsUi({ api, basePath: "/admin/jobs" });

const app = new BunHttpAdapter();
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);
api.websocket?.attach(app);
await app.listen(3000);
```

`jobsUi(options)` returns `{ router, basePath, config }`, all read-only;
`config` is the exact `JobsUiConfig` the page receives. It checks every
option when called and throws bun-jobs' `ConfigError` for anything unusable.

| Option | Default | Notes |
|---|---|---|
| `api` | — | The `createJobsApi` result; the UI reads the API's `basePath`, socket and docs paths from it. Exactly one of `api` and `apiUrl` is required. |
| `apiUrl` | — | An API in another process or origin: a same-origin path (`"/jobs-api"`) or an `http(s)://` URL, with no query, fragment or credentials. A URL's origin is added to the CSP's `connect-src`. A cross-origin API needs `cors`, `csrf.allowedOrigins` and `websocket.allowedOrigins` set on its side. |
| `basePath` | `"/jobs"` | Absolute, not `"/"`. It must not equal or sit under the API's `basePath`. |
| `title` | `"Jobs"` | Page title and brand text, HTML-escaped. |
| `sections` | both on | `{ manage?, docs? }`: turn one off (both off is an error). |
| `csrfHeader` | the API's | Must match the API's `csrf.header`; defaults to it when the API exposes it, `false` for none. |
| `authorize` | none | `(req, { asset, path }) => boolean \| { allow, status?, reason? }`, sync or async, guarding the shell and the bundle. Fails closed: 401 only for `status: 401`, otherwise 403; a throw gives 500. |
| `unauthorized` | off | `{ redirectTo, returnParam?, statuses? }`: send the browser to a sign-in page ([below](#authorization-and-sign-in-redirects)). |
| `middleware` | `[]` | Handlers run before `authorize` on the requests the UI answers. |
| `theme` | `"system"` | `"system"`, `"light"` or `"dark"`, or `{ mode?, light?, dark? }` to set your own colours too ([Colour themes](#colour-themes)). |
| `layout` | centred, 1400px | `{ align?, scope?, maxWidth? }`: where the content sits on a wide screen ([Layout](#layout)). |
| `shell` | `"full"` | `"full"`, `"tabs"` or `"none"`: how much of its own frame the UI draws ([Frame and sections](#frame-and-sections)). |
| `dev` | unset | Unset or `false`: serve the prebuilt `dist/jobs/` (`false` throws without it). `true` rebuilds from the app's source, which the published package does not ship for `/jobs`: leave it unset. |
| `logger` | console | Any `LoggerLike` bun-common's `resolveLogger` accepts. |

On NestJS, mount the router on bun-nest's adapter:
`adapter.getInstance().use(ui.basePath, ui.router)` (or
`adapter.use(ui.basePath, ui.router)`). The guide,
[guides/jobs.md](guides/jobs.md), has every option in full, the screens, the
permissions each element needs, testing with `router.fetch()` and the
[security notes](guides/jobs.md#security-notes).

## The security UI: `/security`

The management UI of `@kingsleyweb/bun-security`'s control plane
(`createSecurityApi`): services and groups, each scope's policy with drafts,
versions and approvals, rules, lists, bans, events, analytics, audit,
agents and alerts. Like the jobs UI it holds no data and no secrets: every
call goes to the API, which authenticates the operator and checks each
permission itself; the UI only hides what `/meta/permissions` says the
operator may not use.

```ts
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { createSecurityApi } from "@kingsleyweb/bun-security/control";
import { securityUi } from "@kingsleyweb/bun-ui/security";

const api = createSecurityApi({ store, authenticate, owners, stepUp, signing, audit, bans, basePath: "/admin/security-api" });
const ui = securityUi({ api, basePath: "/admin/security" });

const app = new BunHttpAdapter();
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);
await app.listen(3000);
```

Each sits at its own `basePath`: the UI's may not equal or sit under the
API's (a `ConfigError`), while the API's may sit under the UI's (the UI's
router leaves the API's paths to it). With the API elsewhere, name it:
`securityUi({ apiUrl: "https://sec.example.com/api", breakGlass: true })`.

`securityUi(options)` returns `{ router, basePath, config }`; `config` is
the exact `SecurityUiConfig` the page receives. It checks every option when
called and throws bun-common's `ConfigError` for anything unusable.

| Option | Default | Notes |
|---|---|---|
| `api` | — | The `createSecurityApi` result: its `basePath` and whether it has a break-glass account are read from it. Exactly one of `api` and `apiUrl` is required. |
| `apiUrl` | — | An API in another process or origin: a same-origin path or an `http(s)://` URL; a URL's origin is added to the CSP's `connect-src`. |
| `breakGlass` | `false` | With `apiUrl`: whether that API has a break-glass account (the sign-in form is offered only then). |
| `basePath` | `"/security"` | Absolute, not `"/"`. It must not equal or sit under the API's `basePath`. |
| `title` | `"Security"` | Page title and brand text. |
| `csrfHeader` | `"x-bun-security-csrf"` | The header every change carries, as the API's (`/meta` reports the real one once signed in). |
| `authorize` | none | Guards the shell and the bundle, with the same shape and fail-closed rules as `jobsUi()`'s; the API checks every call itself. |
| `unauthorized` | off | As for `jobsUi()` ([below](#authorization-and-sign-in-redirects)). |
| `middleware` | `[]` | Handlers run before `authorize` on the requests the UI answers. |
| `theme` | `"system"` | As for `jobsUi()` ([Colour themes](#colour-themes)). |
| `layout` | centred, 1400px | As for `jobsUi()` ([Layout](#layout)). |
| `shell` | `"full"` | `"full"`, `"tabs"` or `"none"`; under `"none"` a thin bar keeps the scope picker and the break-glass badge ([Frame and sections](#frame-and-sections)). |
| `dev` | unset | Unset or `false`: serve the prebuilt `dist/security/`. `true` rebuilds from the app's source, which the published package does not ship for `/security`: leave it unset. |
| `logger` | console | Any `LoggerLike`. |

The screens, each a section of the nav (`SECURITY_SECTIONS`, shown only
to an operator with its permission on the scope on screen):

- **Analytics** (`/`): the scope's traffic, refusals, top offenders and
  intel, live.
- **Services** (`/services`, `/groups`): services, groups and their
  effective policy.
- **Policies** (`/policies`, `/policies/versions`): the policy editor, a
  draft's impact, publishing and versions.
- **Rules** (`/rules`, `/rules/test`): the request rules, and a request
  tested against them.
- **Lists** (`/lists`): allow and deny entries.
- **Bans** (`/bans`, `/bans/auto`): bans, automatic bans and lifting them.
- **Events** (`/events`): every stored event, filtered.
- **Audit** (`/audit`): the audit log and its verification.
- **Approvals** (`/approvals`): the approvals a dangerous change opened.
- **Agents** (`/agents`): the agents on other hosts and their state.
- **Alerts** (`/alerts`): open alerts, rules, channels and deliveries.
- **API reference** (`/api`): the management API's documents.

Step-up and the break-glass sign-in are built in. The guide,
[guides/security.md](guides/security.md), has every screen, the scopes,
what each element needs, the live updates, step-up and break-glass.

## The docs viewer: `/docs`

A self-hosted viewer for one **OpenAPI 3.1** or **AsyncAPI 3.0** document,
under a strict self-only CSP. Nothing comes from a CDN. The document's own
`openapi` or `asyncapi` field decides which reference is shown: operations
by tag (with `x-tagGroups` sections and a try-it panel) for OpenAPI;
channels, operations, messages, limits and close codes for AsyncAPI.

```ts
import { BunRouter } from "@kingsleyweb/bun-common";
import { docsUi } from "@kingsleyweb/bun-ui/docs";

const app = new BunRouter();

// Point at a document your API already serves…
const ui = docsUi({ document: "/api/openapi.json", basePath: "/docs" });
app.use(ui.basePath, ui.router);

// …or hand it a thunk, which the router serves at <basePath>/document.json.
const events = docsUi({
  document: () => buildAsyncApiDocument(),
  basePath: "/events-docs",
  title: "Events API",
});
app.use(events.basePath, events.router);
```

`docsUi(options)` returns `{ router, basePath, config }` and throws
bun-common's `ConfigError` for an unusable option. Every URL under
`basePath` is a client-routed deep link the router answers with the shell.

| Option | Default | Notes |
|---|---|---|
| `document` | — (required) | A same-origin path or an `http(s)://` URL the viewer fetches (a URL's origin joins `connect-src`), or a `() => document` thunk (sync or async) served at `<basePath>/document.json` (`DOCUMENT_SUBPATH`). |
| `basePath` | `"/docs"` | Absolute, not `"/"`, no trailing slash. |
| `title` | `"API docs"` | Page title. |
| `theme` | `"system"` | `"system"`, `"light"` or `"dark"`, or `{ mode?, light?, dark? }` to set your own colours too ([Colour themes](#colour-themes)). |
| `layout` | centred, 1400px | `{ align?, scope?, maxWidth? }`: where the content sits on a wide screen ([Layout](#layout)). |
| `shell` | `"full"` | `"tabs"` names the document's section in a compact bar; `"full"` and `"none"` draw no frame ([Frame and sections](#frame-and-sections)). |
| `extensions` | `["x-bun-common", "x-bun-jobs"]` | Specification-extension prefixes the viewer reads, first hit winning (`DEFAULT_EXTENSION_PREFIXES`). |
| `csrfHeader` | none | A header the try-it panel adds on every mutation, or `false`. |
| `authorize` | none | Guards the shell, the bundle and a thunk's document (not the documented API). Same shape and fail-closed rules as `jobsUi()`'s. |
| `unauthorized` | off | As for `jobsUi()` ([below](#authorization-and-sign-in-redirects)). |
| `middleware` | none | Runs before every route. |
| `dev` | unset | Unset or `false`: serve the prebuilt `dist/docs/` (`false` throws a `ConfigError` without it). `true` rebuilds the bundle in memory from `app/docs/` on the first request, which needs `react`, `react-dom` and `@tanstack/react-query` installed in your app: leave it unset. |
| `logger` | console | Any `LoggerLike`. |

[guides/docs.md](guides/docs.md) has the full options and the embedding
guide.

## Serving the viewer from `docsRouter`: `/docs/hosted`

bun-common's `docsRouter` can serve this viewer instead of a CDN one, from
your own origin, once `@kingsleyweb/bun-ui` is installed:

```ts
import { docsRouter } from "@kingsleyweb/bun-common";

app.use("/docs", docsRouter({
  openapi: document,
  viewer: { openapi: "self-hosted" },
}));
```

`viewer.asyncapi: "self-hosted"` does the same for an AsyncAPI document.
bun-common loads `@kingsleyweb/bun-ui/docs/hosted` lazily, only for that
viewer; without the package installed, it throws a `ConfigError` saying
`bun add @kingsleyweb/bun-ui`. Each page takes the same `theme` as
`docsUi()`, colours included (`viewer: { openapi: { name: "self-hosted",
theme: { … } } }`; a theme object needs bun-ui 3.2.0 or later), and the
same `layout` (bun-ui 3.3.0 or later). The entry itself is server-side
(`resolveHostedAssets`, `createShellRenderer`, `cspHeader`, `createNonce`
and the asset types): an app rarely imports it directly.

## Embedding the docs screens: `/docs/embed`

`docsUi()` needs nothing beyond this package. The `/docs/embed` entries are
different: they export the viewer's screens (`HttpReference`,
`WsReference`, the schema renderer, the models) as **TSX source**, for a
React app that renders them inside its own UI and bundles them with its own
copies of React and TanStack Query, which you install:

```bash
bun add react@^19.2.0 @tanstack/react-query@^5.90.0
bun add -d @types/react@^19.2.0   # for TypeScript
```

The screens import their `.css` files, so your bundler must handle CSS
(`Bun.build` does). Because they are source, your `tsconfig.json` checks
them and needs `"allowImportingTsExtensions": true` and a
`declare module "*.css";` in a `.d.ts` it includes. An embedding app passes
`unauthorized: null` in the `DocsUiConfig` it provides and handles sign-in
itself, with `/docs/embed/unauthorized`'s `createUnauthorizedRedirect` and
`watchAuthFailures`. [Embedding the screens](guides/docs.md#embedding-the-screens-docsembed)
lists what each entry imports.

## The browser entries

These import no server code and no peer, so a browser bundle (or a host
reading the injected config) may import them:

- **`@kingsleyweb/bun-ui`**: `UiTheme`, `ASSET_CACHE_CONTROL`
  (`"public, max-age=31536000, immutable"`), the `unauthorized` option's
  types (`UnauthorizedOptions`, `UiUnauthorized`, `UiUnauthorizedStatus`)
  and defaults (`DEFAULT_RETURN_PARAM`, `"returnTo"`;
  `DEFAULT_UNAUTHORIZED_STATUSES`, `[401]`).
- **`@kingsleyweb/bun-ui/jobs/browser`**: `JobsUiConfig`, `JobsUiSections`,
  `UiTheme` and `JOBS_UI_CONFIG_ELEMENT_ID` (`"bun-jobs-ui-config"`, the id
  of the `<script type="application/json">` the shell inlines the config
  in), and `JOBS_SECTIONS`.
- **`@kingsleyweb/bun-ui/security/browser`**: `SecurityUiConfig`,
  `SECURITY_UI_CONFIG_ELEMENT_ID` and `SECURITY_SECTIONS`.
- **Every `/<ui>/browser` entry** also carries the kit's frame and mount
  contract: `UiSection` and `sectionsFor` ([Frame and
  sections](#frame-and-sections)); `UiShell`, `UI_SHELLS`,
  `isUiShell`, `MountOptions`, `MountedUi`, `MountElement`, `MountTheme`,
  `MountLayout` and their defaults and resolvers, which the mount functions
  take ([Mounting a UI in your page](#mounting-a-ui-in-your-page)).
- **`@kingsleyweb/bun-ui/docs/browser`**: `DocsUiConfig`, `DocsUiTheme`,
  `DOCS_UI_CONFIG_ELEMENT_ID`, `DEFAULT_EXTENSION_PREFIXES`, `DOCS_SECTIONS`,
  and the
  redirect helpers: `unauthorizedRedirectUrl(redirect, returnPath)` (the
  target with the return parameter set), `relativeReturnPath(location)`
  (a location made safe to hand back: always starting with exactly one `/`)
  and `isUiUnauthorized(value)` (a shape check of the config's
  `unauthorized`), with the root's defaults.

## Authorization and sign-in redirects

A UI's `authorize` protects only its page and bundle; the API's own
`authorize` protects the data. A denial answers an
`application/problem+json` 401 or 403 (code `UNAUTHORIZED` or
`FORBIDDEN`).

With `unauthorized: { redirectTo: "/login" }`, a page navigation that
`authorize` denies answers `303 See Other` to
`/login?returnTo=<path and query>` instead, and the app sends the browser
there once per page load when an API call (or, in the docs viewer, the
document read) fails the same way. Bundle files and scripts' `fetch` calls
keep the problem answer.

| Field | Default | Notes |
|---|---|---|
| `redirectTo` | — (required) | A path starting with one `/`, or an absolute `http(s)` URL. A path inside the UI's own `basePath` is a `ConfigError` (a redirect loop); `javascript:`, `data:`, `//host`, a `\`, whitespace, control characters and credentials are refused. |
| `returnParam` | `"returnTo"` | The query parameter carrying the page the user was on, always a relative path; `false` for none. |
| `statuses` | `[401]` | Which failures redirect: `401`, `403` or both. |

The target is fixed by the option, never read from the request, but the
sign-in page must still check `returnTo` before sending the user back to it.
Details: [jobs](guides/jobs.md#sending-the-browser-to-sign-in),
[docs](guides/docs.md#sending-the-browser-to-sign-in).

## Colour themes

Every UI here (the jobs UI, the security UI, the docs viewer, and `docsRouter`'s
`"self-hosted"` viewer) draws with one set of colour tokens, a light and a
dark palette. `theme` takes your own colours for either, by token:

```ts
jobsUi({
  api,
  theme: {
    mode: "system",                                   // where it starts, as the string form
    light: { accent: "#0f766e", focus: "#0f766e" },
    dark: { accent: "#2dd4bf", accentContrast: "#04201c", bg: "#0b1220" },
  },
});
docsUi({ document: "/api/openapi.json", theme: { light: { accent: "#0f766e" } } });
```

- **Tokens** (the `UiColorToken` type): `bg`, `surface`, `surface2`,
  `border`, `borderStrong`, `text`, `textMuted`, `accent`, `accentContrast`
  (text on accent: primary buttons), `focus`, `danger`, `dangerContrast`,
  the badge and notice pairs `infoBg`/`infoText`, `successBg`/`successText`,
  `warningBg`/`warningText`, `dangerBg`/`dangerText`, `neutralBg`/`neutralText`,
  and the job-state colours `stateWaiting`, `stateDelayed`, `stateActive`,
  `stateCompleted`, `stateFailed`, `stateDead`, `stateWaitingChildren`.
  Each is optional; one left out keeps the built-in colour, so changing the
  accent alone is one line.
- **Values are `#rgb` or `#rrggbb`.** Anything else (a name, `rgb()`, an
  unknown token, an unknown key) throws the UI's `ConfigError` when the UI
  is created, so nothing you pass reaches the CSS unchecked.
- **The scheme still switches.** `mode` is where the page starts, and the
  header's toggle still cycles system, light and dark: your `light` colours
  show in the light scheme, your `dark` ones in the dark scheme (the
  system's preference, or the toggle).
- **The CSP is unchanged.** The colours are served as a stylesheet of their
  own, `<basePath>/assets/theme-<hash>.css`, linked after the bundle's with
  SRI and cached like the bundle; the pages still allow styles from their
  own origin only.
- **Contrast is checked.** Each text/background pair the UIs draw that your
  colours touch is checked against WCAG AA (4.5:1 for text, 3:1 for
  outlines, the focus ring and state dots), and one below it is logged as a
  warning at startup, naming the pair and where it is drawn:
  `theme.light: accentContrast #ffffff on accent #8ab4f8 is 2.11:1, below
  4.5:1 (primary buttons, accent badges)`. It warns rather than refuses:
  the palette is yours.
- Not themed: the dialog backdrop and the card shadow (translucent black),
  and the spacing, radius and type scale.

## Layout

On a screen wider than the content's width cap, `layout` decides where the
content sits. Every UI takes it (the jobs UI, the security UI, the docs viewer, and
`docsRouter`'s `"self-hosted"` viewer), and the docs screens the jobs UI
embeds follow the jobs UI's:

```ts
jobsUi({ api, layout: { align: "center" } });                 // the default
jobsUi({ api, layout: { align: "right", scope: "page" } });
docsUi({ document: "/api/openapi.json", layout: { align: "left", maxWidth: 1200 } });
```

- **`align`**: `"center"` (the default), `"left"` or `"right"`.
  `{ align: "left" }` is the layout before this option existed (3.2.0 and
  earlier).
- **`scope`**: what moves. `"content"` (the default) keeps the jobs UI's
  side nav at the window's edge and places the screen in the space beside
  it; `"page"` places the side nav and the screen as one block, and the
  header's items line up with it (its background still spans the window).
  The docs viewer has no side nav, so both look the same there.
- **`maxWidth`**: the content's width cap in CSS pixels, a whole number of
  at least 320. Default 1400. With `scope: "page"` the block is the nav's
  200px, the cap and the main area's padding.
- **A narrower screen looks the same** whatever the alignment: the content
  fills it, as before.
- **Checked when the UI is created.** An unknown key, an `align` or `scope`
  outside those values, or a `maxWidth` that is not a whole number of at
  least 320 throws the UI's `ConfigError`.
- **The CSP is unchanged.** The page applies it from its config before the
  first render (two attributes on `<html>` and one custom property); no
  inline style is served.

## Frame and sections

`shell` decides how much of its own frame a UI draws. Every UI takes it,
like `layout`:

```ts
jobsUi({ api });                      // "full", the default: header and side nav
securityUi({ api, shell: "tabs" });  // a compact bar of the sections above the screen
jobsUi({ api, shell: "none" });      // the screen alone: the page's own menu is the nav
```

- **`"full"`** is the frame as before: the header (brand, chips, live
  status, theme toggle) and the side nav.
- **`"tabs"`** draws one compact bar: the sections the caller may use, as
  tabs, and the UI's working controls (the security UI's scope picker,
  break-glass badge and live status; the jobs UI's live status). No brand,
  chips or theme toggle. The jobs UI's API docs is one tab; its HTTP and
  WebSocket pages are reached from it. The docs viewer's bar names the one
  section matching its document.
- **`"none"`** draws no nav and no header. The security UI keeps a thin bar
  with the scope picker and the break-glass badge, so the operator can
  change scope and always sees an elevated session; the jobs UI and the docs
  viewer show the screen alone.
- **The keyboard shortcuts** work in every mode.
- **Checked when the UI is created**: anything else throws the UI's
  `ConfigError`. The CSP is unchanged.

**The sections are data**, from each UI's browser entry, so a page's own
side menu lists what the UI's nav lists:

```ts
import { JOBS_SECTIONS, sectionsFor } from "@kingsleyweb/bun-ui/jobs/browser";

// { id, label, path, needs }: `path` is under the UI's basePath.
const menu = sectionsFor(JOBS_SECTIONS, (action) => permissions.actions[action] === true);
```

- `JOBS_SECTIONS`, `SECURITY_SECTIONS` and `DOCS_SECTIONS`, each
  `{ id, label, path, needs }`, in the UI's nav order.
- `needs` is the permission the section needs (a bun-jobs action, a
  bun-security permission), a list of which any one is enough (the jobs
  UI's Overview: `metrics.read` or `queues.list`), or `null`.
- `sectionsFor(sections, can)` keeps those needing nothing and those whose
  permission `can` grants, the filter the UI's own nav applies. The jobs UI
  then also leaves out a section its API does not serve (its mode and
  features, the `sections` option), so a menu built from permissions alone
  may link to a page the UI answers with its not-found screen.
- The docs viewer's two sections need nothing; it shows only the one
  matching its document.

## Forms

Every text field in every UI shows a concrete example of what to type
(`e.g. checkout-api`, `203.0.113.0/24`, `e.g. */5 * * * *`, the JSON's
shape) beside its label, which stays: a placeholder is a hint, never the
label. A select that can be empty shows a "Choose a …" option first (or
an "Any" choice); one that always holds a value (a sort order, a page size)
shows none, since a placeholder is for an empty field. Checkboxes, dates and
files have none. The kit's `TextInput`, `NumberInput` and `JsonEditor`
require a `placeholder`, and `Select` either a `placeholder` or `alwaysSet`;
a test reads every app's fields so no raw one goes without.

## The mount stylesheet

Each UI also ships its stylesheet **scoped to a mount element**, for a page
that shows the UI inside its own layout ([Mounting a UI in your
page](#mounting-a-ui-in-your-page)):

```ts
import "@kingsleyweb/bun-ui/jobs/mount.css";     // a bundling host
// also /security/mount.css and /docs/mount.css
```

It is the UI's own page stylesheet, rewritten when the package is built:

- **Every rule sits under the UI's root**, `[data-bun-ui="jobs"]`, an
  element the UI creates inside the host's: nothing of the UI's reaches the
  host's page.
- **A guard comes first**: the root starts from initial values and every
  element in it from the browser's own styles, so the host's universal and
  element rules (`* { font }`, `button { … }`) do not reach in. A host rule
  more specific than that (`.card p` around the root) still does.
- **`rem` is the reader's size**, not the host's: a host with
  `html { font-size: 62.5% }` does not shrink the UI.
- **Its keyframes are renamed** (`bun-ui-jobs-spin`), so a host's `spin`
  does not replace the UI's.
- **Not in a cascade layer**: the CSS spec ranks a host's unlayered rules
  above every layer, so a layered UI would lose to any global rule.

**To restyle a mounted UI on purpose**, set the theme's custom properties on
the root (`[data-bun-ui="jobs"] { --accent: #0f766e; }`, or the `theme`
option's colours), or write a selector at least as specific as the UI's
(`[data-bun-ui="jobs"] .btn { … }`) in a stylesheet linked after it. The
kit's class names are not a public API.

Within a UI's own page nothing changes: the page links its usual
stylesheet, byte for byte the same, and never the mount one. The router
serves the mount stylesheet as a hashed asset under `<basePath>/assets/`
like the rest (a custom theme's colours get a scoped copy too).

## Mounting a UI in your page

A page of your own (an admin app with its own header and side menu) can show
a UI in its content area instead of linking to the UI's page. One function
per UI, from its own entry:

```ts
import { mountJobsUi, type MountedUi } from "@kingsleyweb/bun-ui/jobs/mount";
import "@kingsleyweb/bun-ui/jobs/mount.css";

const ui: MountedUi = mountJobsUi(document.getElementById("content")!, {
  apiBase: "/admin/jobs-api",   // the management API
  basePath: "/admin/jobs",      // where your page routes the UI's paths
  // optional, all of them:
  shell: "none",                // "none" (default): your menu is the nav; "tabs"; "full"
  theme: "inherit",             // (default) your page's; or "system", "light", "dark"
  themeSource: () => (darkMode() ? "dark" : "light"),
  layout: { align: "left" },    // default left, no width cap: your area decides
  headers: () => ({ authorization: `Bearer ${token()}` }), // per request
  credentials: "include",       // default "same-origin"
  csrfHeader: "x-jobs-csrf",
  onNavigate: (path, { replace }) => router.go(path, { replace }), // your router owns history
  onUnauthorized: (status) => signIn(),
});
ui.navigate("/queues/emails");  // when your router moves
ui.setTheme("dark");
ui.unmount();                   // nothing is left behind
```

`mountSecurityUi` (`/security/mount`, with `apiBase`, `basePath`) and
`mountDocsUi` (`/docs/mount`, with `documentUrl`, `basePath`) take the same
options. A page that already serves the UI with `jobsUi()` can pass its
`ui.config` as it is (`mountJobsUi(el, { ...ui.config })`): the fields only
the UI's own page needs are accepted and ignored.

- **The UI renders in a `<div data-bun-ui="jobs">` it creates** inside your
  element, which it leaves exactly as you styled it; `unmount()` removes the
  div, and every timer, listener, socket and request with it.
- **History**: by default the UI pushes your page's history and follows
  back and forward. With `onNavigate`, it hands you every navigation (the
  full path, and whether it replaces the entry) and shows the screen at
  once; call `navigate()` when your own route changes. A URL outside
  `basePath` renders nothing: that page is yours.
- **Its sections** for your menu are `JOBS_SECTIONS` and the rest
  ([Frame and sections](#frame-and-sections)).
- **Text size** follows the reader's browser default, whatever your
  `<html>` font size: the module measures it once.
- **Keyboard shortcuts** act only when the key is pressed inside the UI.
- **The live updates** of the security UI read through `headers()`; the jobs
  UI's are a WebSocket, which cannot carry headers, so it authenticates by
  cookie.
- **React is bundled in** (any page, React or not, any React version).
- **Give it a plain element**, not a `<main>`: the UI renders its own
  `<main>` landmark and its screen's `<h1>`, so your page keeps its own
  header and navigation landmarks beside them, as in the [host-shell
  demo](../../playground/README.md).

**Without a bundler**, load the module from the UI's router: `jobsUi()`
serves `<basePath>/mount.js` and `<basePath>/mount.css` (revalidated on
every load), and `jobsUiMountTags(ui)` (with `securityUiMountTags` and
`docsUiMountTags`) gives the hashed files with their SRI digests, for your
page's `<head>`:

```ts
const tags = await jobsUiMountTags(ui, { nonce });
// <head>: tags.html, the stylesheet links and a modulepreload of the module
// your script: const { mountJobsUi } = await import(tags.module.href);
```

Your page's CSP must allow the module and its chunks (`script-src` your
origin), the stylesheet (`style-src`) and the API (`connect-src`).

## What a UI serves

Each router answers `GET` and `HEAD`, relative to its `basePath` (other
methods fall through to the host):

- `/assets/:file`: the hashed bundle files (and a [colour theme](#colour-themes)'s
  `theme-<hash>.css`), with
  `Cache-Control: public, max-age=31536000, immutable`, an ETag (a matching
  `If-None-Match` gets 304) and `nosniff`. An unknown file gets a 404
  problem, never the shell.
- `/` and every other path: the HTML shell, with a fresh CSP nonce,
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, SRI
  `integrity` on every script and stylesheet, and the UI's config inlined as
  escaped JSON (never a secret).
- `/mount.js` and `/mount.css`: the [mount module](#mounting-a-ui-in-your-page)
  (re-exporting its hashed file) and the scoped
  [mount stylesheet](#the-mount-stylesheet), revalidated on every load
  (`Cache-Control: no-cache` and an ETag), for a page that cannot know the
  hashed names; `jobsUiMountTags()`, `securityUiMountTags()` and
  `docsUiMountTags()` give those, with SRI.
- `/document.json`: the docs viewer's document, when `document` is a thunk.

This holds for each UI (`jobsUi()` at `/jobs`, `securityUi()` at
`/security`, `docsUi()` at `/docs` by default). The jobs and security UIs'
routers leave their API's paths to it when the API is mounted under the
UI's `basePath`.

The published package ships each UI's prebuilt bundle in `dist/<ui>/`
(hashed files and a `manifest.json` with each file's SRI digest), so a UI
serves it with no build step and no build at runtime.

## Tree-shaking

The package is ESM with named exports and one subpath per UI and layer.
`sideEffects` lists only the stylesheets and each UI's browser entry
(`["**/*.css", "./app/*/main.tsx"]`), so a bundle importing one export from
a browser entry keeps only what it uses, and a bundler keeps the
stylesheets the `/docs/embed` screens import.

## Troubleshooting

- **`Cannot find module "@kingsleyweb/bun-jobs"`** importing
  `@kingsleyweb/bun-ui/jobs` (or `@kingsleyweb/bun-security` importing
  `/security`): install the optional peer, `bun add @kingsleyweb/bun-jobs`
  (or `@kingsleyweb/bun-security`). No other entry needs it.
- **`jobsUi()` throws a `ConfigError` about `basePath`**: the UI's
  `basePath` equals or sits under the API's. Mount the UI elsewhere; the API
  under the UI works.
- **The UI's mutations fail with `CSRF_REJECTED`**: with `apiUrl`, or an API
  that does not expose `api.info`, set `csrfHeader` to the API's
  `csrf.header`.
- **No live updates with `apiUrl` and a dedicated socket port**: the port is
  only discovered at runtime, so it is not in the CSP's `connect-src`. Serve
  the socket on the API's own port in that setup.
- **`docsRouter` says the `"self-hosted"` viewer needs `@kingsleyweb/bun-ui`**:
  install it beside bun-common.
- **TypeScript errors inside `/docs/embed`**: set
  `allowImportingTsExtensions` and declare `*.css` modules
  ([Embedding the docs screens](#embedding-the-docs-screens-docsembed)).

## Guides and examples

- [guides/jobs.md](guides/jobs.md): the jobs UI in full (screens, URL
  parameters, what each element needs, runners, API docs, security).
- [guides/security.md](guides/security.md): the security UI in full
  (screens, scopes, what each element needs, live updates, step-up,
  break-glass, accessibility).
- [guides/docs.md](guides/docs.md): the docs viewer and embedding.
- [examples/bun-ui/jobs](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-ui/jobs):
  runnable examples, from a quick start to deployments and options.
- [examples/bun-ui/security](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-ui/security):
  the security UI's permissions table checked against its API.
- [examples/bun-common/13-api-docs](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-common/13-api-docs):
  `docsRouter`, including the self-hosted viewer.
