# `@kingsleyweb/bun-jobs-ui` examples

Runnable examples for [`@kingsleyweb/bun-jobs-ui`](../../packages/bun-jobs-ui):
the React management UI for the
[`@kingsleyweb/bun-jobs`](../../packages/bun-jobs) management API. `jobsUi()`
returns a bun-common router that serves the app's HTML shell for every client
route under its `basePath` and the hashed bundle under `<basePath>/assets/`.
Mount it beside `createJobsApi` and the page does the rest through the API.

Each file is a script that sets up a UI, checks what it serves and closes it.
Its opening comment says what it shows and how to run it. Every file also
**asserts** what it shows with [`shared/check.ts`](./shared/check.ts), so a
wrong answer fails the script.

```bash
cd examples/bun-jobs-ui
bun 01-quick-start/index.ts            # start here
bun 01-quick-start/index.ts --serve    # and keep serving, to open it in a browser
bun run-all.ts                         # every example; prints ok / skip / FAIL
bun run-all.ts 02 10                   # only folders 02-* and 10-*
```

No install step: `@kingsleyweb/bun-jobs-ui`, `@kingsleyweb/bun-jobs` and
`@kingsleyweb/bun-common` resolve from the repo's root `node_modules`. The
memory driver keeps every job in the process, so no database is needed.

In 0.1.0 only the app's **Overview** screen is real. Queues, Runners, Events
and API docs are placeholders, so these examples cover the server side: what
`jobsUi()` serves, how it is configured and how it is mounted.

The repo has no prebuilt `dist/`, so the first request in each process bundles
the app in memory. That takes tens of milliseconds and logs one line. A
published package ships `dist/` and never builds.

## The examples

### 01 — Quick start

| File | Shows |
|---|---|
| [`index.ts`](./01-quick-start/index.ts) | `createJobsApi` and `jobsUi({ api })` mounted on a `BunHttpAdapter` on port `0`, the shell and bundle served over a real socket, and `--serve` to keep it running for a browser |

### 02 — Serving

| File | Shows |
|---|---|
| [`shell-and-assets.ts`](./02-serving/shell-and-assets.ts) | the shell's headers and Content-Security-Policy, a fresh nonce on each request, the injected `UiConfig`, deep links, SRI, asset content types and `Cache-Control`, ETag/304, `HEAD`, an unknown asset's 404 problem, what falls through to the host, and `ui.router.fetch()` unmounted. Every request goes through `fetch()` with no socket bound |

### 03 — Deployments

| File | Shows |
|---|---|
| [`cross-origin.ts`](./03-deployments/cross-origin.ts) | the UI and the API on two origins: `apiUrl`, `csrfHeader` set by hand, and the API's `cors`, `csrf.allowedOrigins` and `websocket.allowedOrigins`, each checked with the requests a browser on the UI's origin would send |

For NestJS, see [`bun-nest/06-jobs-ui/mount.ts`](../bun-nest/06-jobs-ui/mount.ts):
`jobsUi()` over the API that `BunJobsApiModule` built, mounted with
`adapter.use()` or `adapter.getInstance().use()`.

### 10 — Option tour

The tour **asserts** every option. It sets each option, checks what changes
and tries every value `jobsUi()` refuses, which must throw a `ConfigError`.
`bun run-all.ts 10` is therefore a test of every option.

| File | Covers |
|---|---|
| [`jobs-ui-options.ts`](./10-options/jobs-ui-options.ts) | the exported constants; `logger`, and the one-time in-memory build it hears about; `dev`; `api` or `apiUrl` (exactly one) and every rejected `apiUrl` form; what the UI reads from `api` (a dedicated socket port, custom docs paths, neither); every `basePath` rule, and an API mounted under the UI in either order; `csrfHeader` by default, set by hand and `false`; `title` and its escaping; `sections`; `theme`; every `authorize` answer (`true`/`false`, the object form with `status` and `reason`, async, unrecognised → 403, throw → 500, the `asset` flag, `HEAD`); `middleware` before `authorize`; the frozen result |

## Checking the examples

```bash
bun scripts/typecheck.ts        # from the repo root — includes examples/bun-jobs-ui
cd examples/bun-jobs-ui
bunx eslint .                   # the package's lint rules, minus no-console
bun run-all.ts                  # run them all
```
