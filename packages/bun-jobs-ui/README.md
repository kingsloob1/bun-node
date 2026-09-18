# @kingsleyweb/bun-jobs-ui

A management UI and API documentation viewer for the
[`@kingsleyweb/bun-jobs`](../bun-jobs) management API. It is a React app,
prebuilt into `dist/`, served by a `jobsUi()` router that mounts beside
`createJobsApi` on any bun-common router: a bun-common `BunHttpAdapter`, a
`BunRouter`, or bun-nest's `BunHttpAdapter`.

The UI holds no data of its own and no secrets. Everything it shows comes from
the API, through the API's own `authorize`.

## Install

```bash
bun add @kingsleyweb/bun-jobs-ui @kingsleyweb/bun-jobs
```

Requires Bun >= 1.4.2. `@kingsleyweb/bun-jobs` is a peer dependency. React and
the rest of the app are bundled into `dist/`, so you have no build step.

## Mounting

```ts
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { createJobsApi } from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";

const api = createJobsApi({ jobs, basePath: "/admin/jobs-api", authorize });
const ui = jobsUi({ api, basePath: "/admin/jobs" });

const app = new BunHttpAdapter();
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);
api.websocket?.attach(app);
await app.listen(3000);
```

Mount each router at its own `basePath`. The injected configuration and every
asset URL are built from it. The UI's `basePath` **must not** equal or sit
under the API's: the API answers everything under its `basePath` with a JSON
404, and `jobsUi()` throws a `ConfigError` if you try. The reverse, with the
API under the UI, works whichever router is mounted first. The UI leaves
requests under the API's path alone.

### Mounting on NestJS

On bun-nest's `BunHttpAdapter`, mount the router on the adapter's instance,
which needs no cast:

```ts
const adapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, adapter);
adapter.getInstance().use(ui.basePath, ui.router);
await app.listen(3000);
```

`adapter.use(ui.basePath, ui.router)` works too, typed, with no cast.

**API in another process or origin:** pass `apiUrl` instead of `api`. It can
be a same-origin path (`"/jobs-api"`) or an `http(s)://` URL. The app then
reads the WebSocket and docs paths from the API's `/meta` at runtime. A
cross-origin API needs `cors`, `csrf.allowedOrigins` and
`websocket.allowedOrigins` set on the API side.

## `jobsUi(options)`

It returns `{ router, basePath, config }`, all read-only. `config` is the
exact `UiConfig` the page receives. `jobsUi()` checks every option when you
call it and throws a `ConfigError` for anything unusable.

| Option | Type | Default | Notes |
|---|---|---|---|
| `api` | `JobsApi` | — | The `createJobsApi` result. The UI reads the API's `basePath`, WebSocket path/port and docs paths from it. Exactly one of `api` and `apiUrl` is required. |
| `apiUrl` | `string` | — | A same-origin path or an `http(s)` URL. Its path follows `basePath`'s segment rules, checked on the string as written, so `..`, `.`, a space or `%2F` is refused rather than normalised away. A trailing slash is dropped. A URL's path may be empty (the API at the origin root). Neither form may carry a query or a fragment, and a URL may not carry credentials, a password alone included. When it is a URL, its origin is added to the CSP's `connect-src` in `http(s)` and `ws(s)` form. |
| `basePath` | `string` | `"/jobs"` | Absolute, not `"/"`, with segments of `[\w.~-]`. A trailing slash is dropped. It must not equal or sit under the API's `basePath`. |
| `title` | `string` | `"Jobs"` | The page title and brand text. It is HTML-escaped. |
| `sections` | `{ manage?, docs? }` | both `true` | Turn either one off, for example to serve the docs only. Turning both off is an error. |
| `csrfHeader` | `string \| false` | none* | Must match the API's `csrf.header`. `false` or unset means none, and `config.csrfHeader` is then `null`. \*When the API exposes `api.info.csrf.header`, that value becomes the default. |
| `authorize` | `(req, { asset, path }) => boolean \| { allow, status?, reason? }` | none | Guards the shell and the bundle. It can be sync or async and fails closed, as the API's does: a denial is 401 only for `status: 401` and 403 for any other status (`429` and `500` included), an unrecognised answer gives 403 and a throw gives 500. To answer 429, rate-limit in `middleware`. |
| `middleware` | `RouterHandler[]` | `[]` | Runs before `authorize` on the `GET`/`HEAD` requests the UI answers. An error it raises goes to the host's error handling. |
| `theme` | `"system" \| "light" \| "dark"` | `"system"` | The initial colour scheme. |
| `dev` | `boolean` | unset | Unset: serve `dist/` if it is there, otherwise build in memory on the first request (once per process, logged once). `true`: always build from `app/`. `false`: require `dist/`, or `jobsUi()` throws. |
| `logger` | `LoggerLike` | console | Anything that bun-common's `resolveLogger` accepts. |

Routes, relative to `basePath` (`GET` and `HEAD` only; other methods fall
through to the host):

- `/assets/:file` serves the hashed bundle files. They are sent with
  `Cache-Control: public, max-age=31536000, immutable`, an ETag (a matching
  `If-None-Match` gets 304) and `nosniff`. An unknown file gets a 404
  problem, never the shell.
- `/` and `/*` serve the HTML shell for every client route.

## Testing without a socket

```ts
const ui = jobsUi({ apiUrl: "/jobs-api" });
const page = await ui.router.fetch("/");             // unmounted: paths are relative
const html = await page.text();
const config = JSON.parse(
  /<script type="application\/json" id="bun-jobs-ui-config"[^>]*>(.*?)<\/script>/s.exec(html)![1]!,
);
expect(config.apiBase).toBe("/jobs-api");

app.use(ui.basePath, ui.router);
await app.fetch("/jobs/queues/mail");               // mounted: the shell, as served
```

When your `authorize` denies a request, the UI answers with a 401 or 403
`application/problem+json` body shaped like the API's, with code
`UNAUTHORIZED` or `FORBIDDEN`. Only `status: 401` gives a 401. Every other
status, `429` or `500` included, gives a 403.

## Security notes

- **Shell auth is not API auth.** `authorize` here protects only the page and
  the bundle. The API's own `authorize` protects the data. With no UI
  `authorize`, the only thing exposed is the app's JavaScript.
- **CSP.** Every shell response carries a fresh nonce and this policy:
  `default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self'; img-src 'self' data:; connect-src 'self' <sockets>; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`.
  `connect-src` never allows a socket to just any host. After `'self'` it
  lists, per request:
  - the page's own origin as a socket, `ws://host[:port]`, or `wss://` when
    the page is `https` (from the URL or `X-Forwarded-Proto`). Older WebKit
    does not let `'self'` match `ws:`/`wss:`. The origin is taken from the
    `Host` header and is left out when it is not a plain `host[:port]`, so a
    forged `Host` cannot inject a directive;
  - a dedicated socket port (`config.websocket.port`) on the same hostname,
    `ws(s)://host:port`;
  - a cross-origin `apiUrl`'s origin, in both `http(s)://` and `ws(s)://`
    form.

  For example, `connect-src 'self' wss://jobs.example` for an https page,
  `connect-src 'self' ws://jobs.example:8080 ws://jobs.example:4567` with a
  socket on port 4567, and
  `connect-src 'self' wss://ui.example https://api.example wss://api.example`
  with `apiUrl: "https://api.example/jobs"`.

  With `apiUrl`, the socket's port is only discovered from `/meta` at
  runtime, so a dedicated socket port is not in `connect-src`. Serve the
  socket on the API's own port in that setup.
  The shell also sends `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. Scripts and
  stylesheets carry SRI `integrity` attributes.
- **The config is data.** It is inlined as a nonce'd
  `<script type="application/json">` and escaped for a script context, so a
  title containing `</script>` cannot break out of it. It never carries
  secrets.
- **CSRF.** With an API that exposes `api.info`, the CSRF header, socket
  (including a dedicated port) and docs paths are read from it. With an older
  API, or with `apiUrl`, set `csrfHeader` to the API's `csrf.header` if the API
  has one, or the UI's mutations are refused with `CSRF_REJECTED`.

## Building

`bun scripts/build.ts` writes `dist/assets/*` (content-hashed, minified, with
source maps) and `dist/manifest.json`. `prepack` runs it for you. `dist/` is
gitignored. In the repo, `jobsUi()` builds in memory when `dist/` is absent.
