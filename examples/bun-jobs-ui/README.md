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
bun 05-demo/seeded-demo.ts --serve     # every queue, runner and Events screen, seeded and live, with a URL for each
bun run-all.ts                         # every example; prints ok / skip / FAIL
bun run-all.ts 02 10                   # only folders 02-* and 10-*
```

No install step: `@kingsleyweb/bun-jobs-ui`, `@kingsleyweb/bun-jobs` and
`@kingsleyweb/bun-common` resolve from the repo's root `node_modules`. The
memory driver keeps every job in the process, so no database is needed.

The app's **Overview**, **Queues**, **Runners** and **Events** screens are
real: the queue list, one queue (its actions, jobs table and panels), one job,
the runner list, one runner (its actions, stats, active runs and history), and
the Events console, a live tail of the API's socket. With a socket attached
and events published, the header's live badge reads `Live` and the screens
refresh on events instead of polling every 5 s. API docs are still a
placeholder. The queue, job, runner and Events screens are split chunks,
loaded the first time one is opened. Folders 01–03 and 10 cover the server
side: what `jobsUi()` serves, how it is configured and how it is mounted.
Folders 04–06 cover the screens: their URLs, the permissions they are drawn
from, a seeded demo to click through, and a browser driving them.

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

### 04 — The queue, runner and Events screens

| File | Shows |
|---|---|
| [`deep-links.ts`](./04-screens/deep-links.ts) | every Queues and Runners URL, `/jobs/queues`, `/jobs/queues/mail`, `?state=failed&panel=workers`, the jobs table's `offset`/`limit`/`total`/`name`/`search`/`order`, the throughput `window`, a job at `/jobs/queues/mail/jobs/a%2Fb`, `/jobs/runners` and its `?search=`, a runner and its `?history=`, and an unknown runner, `/jobs/events` and its `?channel=` and `?types=` (a queue's, a runner's and a job's channel, and a type no channel carries), answered with the same shell, config, script and stylesheet; exactly one stylesheet and one module script in the shell, and every screen chunk the entry imports on demand served from `assetsPath` as JavaScript with immutable caching; a job id as one percent-encoded segment (`/`, `?`, `#`, a space, non-ASCII) that the API finds too; and the API still answering under its own `basePath` on the same host, for a runner too. No socket |
| [`permissions.ts`](./04-screens/permissions.ts) | what each element needs, asserted on the API and against the package README: `screenGates()` restates the UI's rules one entry per row of the README's table "What each element needs", and the example parses that table and fails on any drift in its rows, actions, features, sections, `meta.mode` values, the other `/meta` fields a row names (`meta.websocket`, `meta.addableNames`, `meta.runnerTriggerArgs`), which map decides a row and which rows wait for it. An `authorize` that allows queue `mail` fully, `audit` read-only and `payroll` nothing, and runner `nightly` fully, `ledger` read-only, `vault` nothing and `remote-sync` (registered by another `BunJobs` over the same driver) fully; `GET /meta/permissions` (the boot map, which decides the nav, `/`, `/queues*` and `/runners*`, and the fallback while a targeted map loads or if it fails) and `?queue=mail\|audit\|payroll`, which decides everything inside a queue: the header, the jobs table, Pause on a running queue and Resume on a paused one (both need `queues.read`, since the paused flag is the queue detail's), Drain, Clean, Retry all, Add job and its name suggestions, bulk retry/promote/remove (which also need `jobs.list`), each panel and its edit (the limits panel only when the detail carries `limits`), and the job screen (`jobs.read` on the queue's own map, which it waits for, else "Job hidden"), its logs, Retry, Promote, Remove and Edit; `?runner=…` for each runner action, which decides the runner screen (`runners.read`, waited for, else "Runner hidden"), its stats and history, its active runs (only when `local` is present), Trigger… and its Arguments field (`meta.runnerTriggerArgs`), Pause or Resume… by `isPaused`, Reschedule…, Kill… (only with a run in `local.activeRuns`, shown by triggering one and killing it through the API), Reset stats… (local only) and the remote hint; the server's 403 for every queue and runner mutation a client sends anyway, 403 on a denied runner's reads, 409 `RUNNER_NOT_LOCAL` for a kill or stats reset the map allowed on the remote runner, 404 `RUNNER_NOT_FOUND`, and a 403 the map allowed but `authorize` refuses for a particular job; `readOnly`, where mutations are absent from the map rather than `false`; Clean's default limit, `/meta`'s `limits.defaultClean`, which is what the API applies to a clean sent without one; and the Events entry and `/events` (`sections.manage`, `meta.websocket` and an untargeted `events.connect`) with its pickers' queue and runner lists (`queues.list`, `runners.list`, and the mode's scopes), checked on three hosts: one whose map allows `events.connect`, one whose `authorize` refuses it (`meta.websocket` still set, `events.connect` `false`), and one built with `websocket: false` (`meta.websocket` `null`, `events.connect` and `events.subscribe` absent) |

### 05 — A seeded demo

| File | Shows |
|---|---|
| [`seeded-demo.ts`](./05-demo/seeded-demo.ts) | the one to open in a browser, live: `--serve` seeds four queues with jobs in every state (waiting, delayed, active, completed, failed, dead, waiting-children), failures with a `cause` and stack traces (`serialize.exposeStacks`), logs, a flow, a repeatable, queue limits, a paused queue long enough to page, two workers and this minute's throughput, and five runners ([`helpers/runners.ts`](./05-demo/helpers/runners.ts)): one idle on a cron schedule, one paused, one with a finished run in its history and a run in flight, one whose run failed (its `lastError`), and one registered by another `BunJobs` over the same driver (remote). The jobs publish their events (`publishEvents: true`) and the API's socket is attached (`api.websocket.attach(app)`), so the header badge reads `Live` and `/events` tails any channel. It then prints the URL of every screen and panel, the runner list, each runner and three Events channels included, connects to the socket once to prove it answers (`hello`), prints its URL and the Events console's, and keeps work flowing. Without `--serve` it asserts the seed through the API (`/runners`, `/runners/:runner`, its stats and history), the reads the screens make, and what the live badge decides from (`meta.websocket`, `meta.publishing`, `events.connect`), and exits. Honours `EXAMPLE_DRIVER` |

### 06 — In a browser

| File | Shows |
|---|---|
| [`pause-and-retry.ts`](./06-browser/pause-and-retry.ts) | headless Chrome through `Bun.WebView`, as the package's e2e test drives it: pause a queue from its screen, check that the Clean dialog's Limit starts at `/meta`'s `limits.defaultClean`, then open a dead job (its id carrying `%2F`), retry it through the `dialog[open]` confirmation, and read each result back from the API; a missing job shows `job-not-found`; a job of a queue whose `jobs.read` is refused shows `job-hidden` ("You may not read the jobs of queue vault." and a "Back to vault" link), and a host middleware and an `authorize` spy both prove the job was never requested, though `jobs.read` is `true` untargeted; pause a runner from the `Runner actions` group and read `isPaused` back from the API; a runner whose `runners.read` is refused shows `runner-hidden`, and not one request for it reaches the host; no CSP violation throughout. It uses the stable `data-testid` hooks and waits on conditions, never on time. **Skips** when there is no `Bun.WebView` or no Chrome (`BUN_CHROME_PATH` overrides the search; `EXAMPLE_BROWSER=0` skips on purpose) |
| [`live-events.ts`](./06-browser/live-events.ts) | live updates in headless Chrome, over a real `createJobsApi` socket attached with `api.websocket.attach(app)` and jobs built with `publishEvents: true`: the header's `live-status` badge reaches `data-state="live"` (`Live · events: local` on the memory driver) over exactly one upgrade; `/events?channel=queue/mail` renders `events-screen`, and a real worker completing a job makes its `event-row`s appear, newest first (`completed` down to `added`), linked to the job; Pause holds the next job's rows (`events-held`), Resume shows them and Clear empties the log. Three hosts where the badge stays `off`, says `Polling 5s` and gives the reason in its tooltip: one built with `websocket: false` ("The API has no live-events socket"), one whose `authorize` refuses `events.connect` ("You may not connect to live events (events.connect)"), and one whose jobs do not publish on a driver whose events are local (`Polling 5s · events: local · publishing: no`, "Nothing publishes events to this API"); none has an Events nav entry, and none was sent a single upgrade. Waits on conditions, never on time; skips like `pause-and-retry.ts` |

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
