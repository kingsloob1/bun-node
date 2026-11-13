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
| `@kingsleyweb/bun-ui/docs` | `docsUi()`: a self-hosted viewer for one OpenAPI 3.1 or AsyncAPI 3.0 document. [Guide](guides/docs.md) | nothing |
| `@kingsleyweb/bun-ui/docs/browser` | the docs viewer's browser-safe config contract and the `unauthorized` helpers | nothing |
| `@kingsleyweb/bun-ui/docs/hosted` | what bun-common's `docsRouter` `"self-hosted"` viewer loads to serve the viewer itself | nothing |
| `@kingsleyweb/bun-ui/docs/embed`, `/docs/embed/{routing,router,context,permissions,client,errors,unauthorized}` | the viewer's screens as source, for a React app that bundles them into its own UI | the host's `react` and `@tanstack/react-query` |
| `@kingsleyweb/bun-ui` | what every UI shares, browser-safe: `UiTheme`, the `unauthorized` option's types and defaults, `ASSET_CACHE_CONTROL` | nothing |

Each UI's domain package is an **optional** peer that only its own subpath
needs: install `@kingsleyweb/bun-jobs` to use `/jobs`. An app that mounts one
UI never loads another's code or bundle.

## Contents

- [Install](#install)
- [The jobs UI: `/jobs`](#the-jobs-ui-jobs)
- [The docs viewer: `/docs`](#the-docs-viewer-docs)
- [Serving the viewer from `docsRouter`: `/docs/hosted`](#serving-the-viewer-from-docsrouter-docshosted)
- [Embedding the docs screens: `/docs/embed`](#embedding-the-docs-screens-docsembed)
- [The browser entries](#the-browser-entries)
- [Authorization and sign-in redirects](#authorization-and-sign-in-redirects)
- [Colour themes](#colour-themes)
- [What a UI serves](#what-a-ui-serves)
- [Tree-shaking](#tree-shaking)
- [Troubleshooting](#troubleshooting)
- [Guides and examples](#guides-and-examples)

## Install

```bash
bun add @kingsleyweb/bun-ui                          # for /docs
bun add @kingsleyweb/bun-ui @kingsleyweb/bun-jobs   # for /jobs
```

Requires Bun >= 1.4.2. `@kingsleyweb/bun-common` is a dependency and is
installed with it; `@kingsleyweb/bun-jobs` and `@types/bun` (>= 1.4.2) are
optional peers. Bun runs the shipped TypeScript source in `lib/`; your type
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
| `dev` | unset | Unset or `false`: serve the prebuilt `dist/jobs/` (`false` throws without it). `true` rebuilds from the app's source, which the published package does not ship for `/jobs`: leave it unset. |
| `logger` | console | Any `LoggerLike` bun-common's `resolveLogger` accepts. |

On NestJS, mount the router on bun-nest's adapter:
`adapter.getInstance().use(ui.basePath, ui.router)` (or
`adapter.use(ui.basePath, ui.router)`). The guide,
[guides/jobs.md](guides/jobs.md), has every option in full, the screens, the
permissions each element needs, testing with `router.fetch()` and the
[security notes](guides/jobs.md#security-notes).

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
theme: { … } } }`; a theme object needs bun-ui 3.2.0 or later). The entry itself is server-side
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
  in).
- **`@kingsleyweb/bun-ui/docs/browser`**: `DocsUiConfig`, `DocsUiTheme`,
  `DOCS_UI_CONFIG_ELEMENT_ID`, `DEFAULT_EXTENSION_PREFIXES`, and the
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

Every UI here (the jobs UI, the docs viewer, and `docsRouter`'s
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
- `/document.json`: the docs viewer's document, when `document` is a thunk.

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
  `@kingsleyweb/bun-ui/jobs`: install the optional peer,
  `bun add @kingsleyweb/bun-jobs`. No other entry needs it.
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
- [guides/docs.md](guides/docs.md): the docs viewer and embedding.
- [examples/bun-ui/jobs](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-ui/jobs):
  runnable examples, from a quick start to deployments and options.
- [examples/bun-common/13-api-docs](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-common/13-api-docs):
  `docsRouter`, including the self-hosted viewer.
