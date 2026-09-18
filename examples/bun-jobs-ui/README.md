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
bun 05-demo/seeded-demo.ts --serve     # every queue screen, seeded, with a URL for each
bun run-all.ts                         # every example; prints ok / skip / FAIL
bun run-all.ts 02 10                   # only folders 02-* and 10-*
```

No install step: `@kingsleyweb/bun-jobs-ui`, `@kingsleyweb/bun-jobs` and
`@kingsleyweb/bun-common` resolve from the repo's root `node_modules`. The
memory driver keeps every job in the process, so no database is needed.

The app's **Overview** and **Queues** screens are real: the queue list, one
queue (its actions, jobs table and panels) and one job. Runners, Events and API
docs are still placeholders. Folders 01–03 and 10 cover the server side: what
`jobsUi()` serves, how it is configured and how it is mounted. Folders 04–06
cover the queue screens: their URLs, the permissions they are drawn from, a
seeded demo to click through, and a browser driving them.

`05-demo/seeded-demo.ts` reads `EXAMPLE_DRIVER` like the
[`bun-jobs` examples](../bun-jobs/README.md#choosing-a-backend) do (`memory` by
default; `file` and `sqlite` need nothing; a server backend needs its URL, and
skips without one).

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
| [`shell-and-assets.ts`](./02-serving/shell-and-assets.ts) | the shell's headers and Content-Security-Policy, a fresh nonce on each request, `connect-src` built per request from the `Host` (`ws://` or `wss://`, the port kept, a dedicated socket port added, a malformed `Host` ignored — never a bare `ws:`/`wss:`), the injected `UiConfig`, deep links, SRI, asset content types and `Cache-Control`, ETag/304, `HEAD`, an unknown asset's 404 problem, what falls through to the host, and `ui.router.fetch()` unmounted. Every request goes through `fetch()` with no socket bound |

### 03 — Deployments

| File | Shows |
|---|---|
| [`cross-origin.ts`](./03-deployments/cross-origin.ts) | the UI and the API on two origins: `apiUrl`, `csrfHeader` set by hand, and the API's `cors`, `csrf.allowedOrigins` and `websocket.allowedOrigins`, each checked with the requests a browser on the UI's origin would send, and the API's origin in `connect-src` as `http(s)` and `ws(s)` (keep the socket on the API's port: a dedicated one is not listed with `apiUrl`) |

For NestJS, see [`bun-nest/06-jobs-ui/mount.ts`](../bun-nest/06-jobs-ui/mount.ts):
`jobsUi()` over the API that `BunJobsApiModule` built, mounted with
`adapter.use(ui.basePath, ui.router)`.

### 04 — The queue screens

| File | Shows |
|---|---|
| [`deep-links.ts`](./04-screens/deep-links.ts) | every Queues URL, `/jobs/queues`, `/jobs/queues/mail`, `?state=failed&panel=workers`, the jobs table's `offset`/`limit`/`total`/`name`/`search`/`order`, the throughput `window`, and a job at `/jobs/queues/mail/jobs/a%2Fb`, answered with the same shell and the same config; a job id as one percent-encoded segment (`/`, `?`, `#`, a space, non-ASCII) that the API finds too; and the API still answering under its own `basePath` on the same host. No socket |
| [`permissions.ts`](./04-screens/permissions.ts) | what each element needs, asserted on the API and against the package README: `screenGates()` restates the UI's rules one entry per row of the README's table "What each element needs", and the example parses that table and fails on any drift in its rows, actions, features or sections. An `authorize` that allows `mail` fully, `audit` read-only and `payroll` nothing; `GET /meta/permissions` (the boot map, which decides the nav, `/` and `/queues*`, and the fallback while a queue's map loads) and `?queue=mail\|audit\|payroll`, which decides everything inside a queue: the header, the jobs table, Pause on a running queue and Resume on a paused one (both need `queues.read`, since the paused flag is the queue detail's), Drain, Clean, Retry all, Add job and its name suggestions, bulk retry/promote/remove (which also need `jobs.list`), each panel and its edit (the limits panel only when the detail carries `limits`), and the job screen (`jobs.read`, else "Job hidden"), its logs, Retry, Promote, Remove and Edit; the server's 403 for every mutation a client sends anyway, and for one the map allowed but `authorize` refuses for a particular job; `readOnly`, where mutations are absent from the map rather than `false`; and Clean's default limit, `/meta`'s `limits.defaultClean`, which is what the API applies to a clean sent without one |

### 05 — A seeded demo

| File | Shows |
|---|---|
| [`seeded-demo.ts`](./05-demo/seeded-demo.ts) | the one to open in a browser: `--serve` seeds four queues with jobs in every state (waiting, delayed, active, completed, failed, dead, waiting-children), failures with a `cause` and stack traces (`serialize.exposeStacks`), logs, a flow, a repeatable, queue limits, a paused queue long enough to page, two workers and this minute's throughput, then prints the URL of every screen and panel and keeps work flowing. Without `--serve` it asserts the seed through the API, the reads the screens make, and exits. Honours `EXAMPLE_DRIVER` |

### 06 — In a browser

| File | Shows |
|---|---|
| [`pause-and-retry.ts`](./06-browser/pause-and-retry.ts) | headless Chrome through `Bun.WebView`, as the package's e2e test drives it: pause a queue from its screen, check that the Clean dialog's Limit starts at `/meta`'s `limits.defaultClean`, then open a dead job (its id carrying `%2F`), retry it through the `dialog[open]` confirmation, and read each result back from the API; a missing job shows `job-not-found`; a job of a queue whose `jobs.read` is refused shows `job-hidden` ("You may not read the jobs of queue vault." and a "Back to vault" link), and a host middleware and an `authorize` spy both prove the job was never requested; no CSP violation throughout. It uses the stable `data-testid` hooks and waits on conditions, never on time. **Skips** when there is no `Bun.WebView` or no Chrome (`BUN_CHROME_PATH` overrides the search; `EXAMPLE_BROWSER=0` skips on purpose) |

### 10 — Option tour

The tour **asserts** every option. It sets each option, checks what changes
and tries every value `jobsUi()` refuses, which must throw a `ConfigError`.
`bun run-all.ts 10` is therefore a test of every option.

| File | Covers |
|---|---|
| [`jobs-ui-options.ts`](./10-options/jobs-ui-options.ts) | the package's exact runtime exports and the exported constants; `logger`, and the one-time in-memory build it hears about; `dev`; `api` or `apiUrl` (exactly one), the root and trailing-slash forms it accepts and every form it rejects (a URL path checked as written, credentials of any kind, a query or fragment even when empty); what the UI reads from `api` (a dedicated socket port, custom docs paths, neither); every `basePath` rule, and an API mounted under the UI in either order; `csrfHeader` by default (none, unless the API reports one), set by hand and `false`; `title` and its escaping; `sections`; `theme`; every `authorize` answer (`true`/`false`, the object form with `status` and `reason`, any status but 401 → 403, async, unrecognised → 403, throw → 500, the `asset` flag, `HEAD`); `middleware` before `authorize`; the frozen result |

## Checking the examples

```bash
bun scripts/typecheck.ts        # from the repo root — includes examples/bun-jobs-ui
cd examples/bun-jobs-ui
bunx eslint .                   # the package's lint rules, minus no-console
bun run-all.ts                  # run them all
```
