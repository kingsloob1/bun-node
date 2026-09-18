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

## Screens

The app's routes sit under the UI's `basePath`. A path the caller has no
route for shows a not-found screen. The queue and job screens arrived in M2,
the runner screens in M3.

| Route | What it shows |
|---|---|
| `/` | The Overview: namespace-wide counts per state (`GET /overview`) and a filterable queue table, with a 60-minute throughput sparkline per row. When the caller has no Overview entry, `/` redirects to the first nav entry, or says there is nothing to show. |
| `/queues` | Every queue, searchable by name (case-insensitive) and paged. Each row links to its queue. |
| `/queues/:queue` | The queue's header (paused badge, job total, last update), its actions, the jobs table (a tab per state, filters, paging, bulk actions) and the detail panels: limits, workers, throughput and repeatables. |
| `/queues/:queue/jobs/:id` | One job: its summary, the failure with its cause chain and the failure history, data, return value, flow parent and children, logs and options, with Retry, Promote, Remove and Edit. |
| `/runners` | Every runner in the namespace (`GET /runners`): local ones first, with their name and status, then remote ones by id. Filtered by id or name in the browser, with no paging. Each row links to its runner. |
| `/runners/:runner` | One runner: its status badges, its actions, a summary (schedule, next run, execution and run mode, queueing, concurrency, the run holding its lock, the last error), the lifetime counters, the runs in flight in this process, the last run and the run history. |

### URL parameters

Everything a screen filters by lives in the query string, so a link
reproduces the view. A value that is missing or invalid falls back to the
default.

| Screen | Parameter | Meaning |
|---|---|---|
| `/` | `q` | Filters the queue table by name. |
| `/queues` | `search` | Filters by name, as you type. Changing it resets `offset`. |
| `/queues` | `offset` | Rows skipped. Defaults to `0`. |
| `/queues` | `limit` | Page size, `1` to `limits.maxQueues`. Defaults to the smaller of `limits.defaultPageSize` and `limits.maxQueues`. |
| `/queues/:queue` | `state` | The state tab: `waiting`, `delayed`, `active`, `completed`, `failed`, `dead` or `waiting-children`. Absent means All. |
| `/queues/:queue` | `offset` | Jobs skipped. Defaults to `0`. |
| `/queues/:queue` | `limit` | Page size, `1` to `limits.maxPageSize`. Defaults to `limits.defaultPageSize`. |
| `/queues/:queue` | `total=1` | Asks the API to count `page.total` ("Count total"). |
| `/queues/:queue` | `name` | Exact job names as a comma list. The request sends each name as its own `name` key. |
| `/queues/:queue` | `search` | Id or name contains this text. `name` and `search` apply when you press Apply. |
| `/queues/:queue` | `order=desc` | Newest first. Absent means oldest first. |
| `/queues/:queue` | `panel` | The open detail panel: `limits`, `workers`, `throughput` or `repeatables`. Defaults to the first one shown. |
| `/queues/:queue` | `window` | The throughput window in minutes: `15`, `60`, `360` or `1440`. Defaults to `60`. |
| `/runners` | `search` | Filters by id or name (case-insensitive, trimmed), as you type. The list is filtered in the browser, so nothing is re-fetched. |
| `/runners/:runner` | `history` | Runs shown in the history, sent as `GET /runners/:runner/history?limit=`. Defaults to the smaller of `50` and `limits.maxHistory`. A number outside `1` to `limits.maxHistory` is clamped to that range, not reset. The select offers `10`, `25`, `50`, `100` and `200` up to the cap, plus the default and the cap. Choosing the default removes the parameter. |

On the queue screen, changing `state`, `name`, `search` or `order` resets
`offset` and clears the selection.

### What each element needs

The app boots with the untargeted `GET /meta/permissions`. The Queues nav
entry, and so every `/queues*` route, depends on that map's `queues.list`.
Screens under `/queues/:queue` also ask `GET /meta/permissions?queue=<queue>`,
and that per-queue answer refines only the buttons and panels inside that
queue's screens. Until it arrives, or if it fails, those screens use the
untargeted map. Runners work the same way: the Runners nav entry and every
`/runners*` route depend on the untargeted `runners.list`, and
`/runners/:runner` asks `GET /meta/permissions?runner=<runner>` for its own
reads and buttons. An action counts only when the map holds it and it is `true`.
An element that is not allowed is absent, not disabled. "Mutation" below means
the action and `meta.readOnly` false. The API's own 401/403 stays the
authority, since the map is never asked about one particular job.

| Element | Needs |
|---|---|
| Overview nav entry and `/` | `sections.manage`, `meta.mode` `jobs` or `both`, and `metrics.read` or `queues.list` (untargeted) |
| Overview counts | `metrics.read` |
| Overview queue table | `queues.list` |
| Overview sparklines | `metrics.read` and `features.throughput` |
| Queues nav entry and every `/queues*` route | `sections.manage`, `meta.mode` `jobs` or `both`, and `queues.list` (untargeted) |
| Queue header total and paused badge | `queues.read` |
| Jobs table, and the job links in it | `jobs.list`; without it, "Jobs hidden" |
| Pause / Resume | mutation `queues.pause` / `queues.resume`, and `queues.read`: Pause shows on a running queue, Resume on a paused one |
| Drain…, Clean…, Retry all… | mutation `queues.drain`, `queues.clean`, `jobs.retryAll` |
| Add job | mutation `jobs.add`, and `meta.addableNames` is `null` (any name) or non-empty |
| Add job's name suggestions | `definitions.list`, when `addableNames` is `null` |
| Bulk Retry / Promote / Remove selected | `jobs.list`, and mutation `jobs.retry` / `jobs.promote` / `jobs.remove` |
| Limits panel | `queues.read` and `features.limits`; shown with a spinner while the queue's detail loads, then only if the detail carries `limits` |
| Limits panel, editable | the above, and mutation `queues.limits` |
| Workers panel | `workers.list` and `features.workers` |
| Throughput panel | `metrics.read` and `features.throughput` |
| Repeatables panel | `repeatables.list` |
| Repeatables panel, Remove | the above, and mutation `repeatables.remove` |
| Job screen | `jobs.read`, as the queue's own permissions answer it: the job is not fetched until they have loaded, and never without `jobs.read` ("Job hidden"). A 401/403 on the job itself shows the same panel with the API's detail. |
| Job logs | `jobs.logs` and `features.logs` |
| Job Retry | mutation `jobs.retry`, and the job is `completed`, `failed` or `dead` |
| Job Promote | mutation `jobs.promote`, and the job is `delayed` |
| Job Remove | mutation `jobs.remove` |
| Job Edit | mutation `jobs.update` and `features.update` |
| Runners nav entry and every `/runners*` route | `sections.manage`, `meta.mode` `runner` or `both`, and `runners.list` (untargeted) |
| Runner screen | `runners.read`, as the runner's own permissions answer it: the runner is not fetched until they have loaded, and never without `runners.read` ("Runner hidden"). A 401/403 on the runner itself shows the same panel with the API's detail and stops the polling. A 404 (`RUNNER_NOT_FOUND`) shows "Runner not found". |
| Runner stats and history | the runner screen's `runners.read`; the stats are read once the runner has loaded, and the tiles show the runner's own `stats` until then |
| Runner active runs | the runner is registered in the API's process (`local` is present) |
| Runner Trigger… | mutation `runners.trigger`; its Arguments field only when `meta.runnerTriggerArgs` |
| Runner Pause / Resume… | mutation `runners.pause` / `runners.resume`: Pause shows while `isPaused` is false, Resume while it is true |
| Runner Reschedule… | mutation `runners.reschedule` |
| Runner Kill… | mutation `runners.kill`, and the runner is local with at least one run in `local.activeRuns` |
| Runner Reset stats… | mutation `runners.resetStats`, and the runner is local (`isLocal`) |
| Runner remote hint | mutation `runners.kill` or `runners.resetStats`, and the runner is not local |

The job screen waits for the queue's own permissions before its first read
(a spinner shows meanwhile), so a host that grants `jobs.read` in general but
refuses it for one queue is never asked for that queue's jobs. If the
queue's permissions fail to load, the untargeted map applies.

The runner screen does the same with the runner's own permissions, for the
runner, its stats and its history. The runner's actions sit in one group
named `Runner actions`, which is absent when none of them is offered and the
remote hint does not apply.

Kill needs a run in `local.activeRuns`, not just `isRunning`. `isRunning` is
true while a run holds the runner's lock in any process, and only the process
executing a run can kill it: for a runner registered only elsewhere the API
answers 409 `RUNNER_NOT_LOCAL`. Nor does `local.status` `running` mean a run
is in flight (see below).

### Runners

- **Status is the lifecycle, not activity.** A local runner's badge is its
  instance's `status`: `idle` (registered, not started), `running` (started:
  its schedule is armed and triggers are accepted), `paused` or `stopped`. A
  run in flight is a separate "Run in flight" badge, shown while `isRunning`
  is true or `local.activeRuns` is not empty. A remote runner has no status
  of its own here: the list shows none, and its screen shows Paused or Active
  from the shared `isPaused` flag.
- **Remote runners** are registered by another process. Pause, resume,
  reschedule and trigger still work, through the shared state, and the owner
  adopts them at its next sync; the screen says so. A trigger for a remote
  runner always goes through the trigger queue, whatever its `queueRuns`
  says, so it comes back `queued` with its position, or `skipped` with
  `paused` or `queue-full`. A local trigger comes back `started` (with the
  run id), `queued`, or `skipped` with `paused`, `busy`, `lock-held`,
  `max-concurrency`, `queue-full` or `stopped`; `busy`, `lock-held` and
  `max-concurrency` are skips only because the runner does not queue
  triggers.
- **"Run even while paused"** sends `force`, which skips only the pause check.
  A busy runner, a lock held elsewhere, the concurrency cap and a full
  trigger queue still apply.
- **Resume** can also ask for a run at once (`triggerNow`).
- **Reschedule** replaces the stored schedule for every process running the
  runner. The editor is prefilled from it and has four forms: Cron (5 fields,
  6 with seconds first, or a nickname such as `@daily`, at most 200
  characters, plus an optional time zone of at most 100), Every (an amount in
  seconds, minutes or hours, greater than zero, plus an optional anchor
  whose grid the runs keep to), Once (a time; one already past is accepted,
  with a warning that it will not fire) and None (`schedule: null`: it runs
  only when triggered). The time zone is checked against the browser's
  `Intl.supportedValuesOf("timeZone")`, case-insensitively, then against
  `Intl.DateTimeFormat`, so an alias such as `US/Eastern`, which the server's
  `Bun.cron` accepts, is accepted too. A UTC offset such as `+01:00` is
  refused: `Intl` would take it, `Bun.cron` does not. The API stays the
  authority. Its 400 `INVALID_SCHEDULE` is shown on the time zone field when
  its detail names a time zone, on the anchor when it names the anchor, and
  on the schedule's main field otherwise.
- **Kill** stops one active run, or every one, after you type the runner's
  id. Force skips straight to the end of the kill escalation, and a reason
  (at most 200 characters) is recorded on the run. Without Wait the API
  answers 202 at once ("Kill requested"). With Wait (`wait: true`) it answers
  only once the runs have settled, which can take the runner's
  `closeTimeout` plus `killTimeout`, and the dialog says it is waiting.
- **Reset stats** sets every lifetime counter back to zero, for every
  process. The history is kept.

### Refreshing

Until the live WebSocket arrives in a later milestone, the screens poll. The
socket will replace these intervals.

| What | Interval |
|---|---|
| Overview counts and queue table | 5 s |
| Overview sparklines | 30 s, fetched only once a row scrolls into view |
| Queue list | 5 s |
| Queue counts and the jobs page on screen | 5 s |
| Queue detail (paused, limits) | 15 s |
| Workers panel | 10 s |
| Throughput and repeatables panels | 30 s |
| A job, and its flow children | 5 s until it is `completed`, `failed` or `dead`, then not at all |
| A job's logs | 3 s while it is `active` or `waiting`, then not at all |
| Runner list | 10 s |
| A runner, and its stats | 5 s while a run is in flight (`isRunning`, or a run in `local.activeRuns`), else 15 s; not at all after a 404 or a 401/403 |
| A runner's history | 15 s |

Every read also refreshes when the window regains focus. `/meta` and the
permission maps are not polled.

### Stack traces

A failure's `stack`, in the failure panel and the failure history, is shown
only when the API sends it. It does that only when you create it with
`createJobsApi({ ..., serialize: { exposeStacks: true } })`, which defaults to
`false`.

### Browser tests

These `data-testid` hooks are stable:

- App: `app-ready` (the frame, once `/meta` and the permissions loaded),
  `bootstrap-loading`, `bootstrap-error`, `live-status`, `not-found`,
  `placeholder`.
- Overview: `overview`, `state-counts`, `queue-row-<queue>`,
  `queues-truncated`.
- Queues: `queues-list`, `queue-screen`, `queue-total`, `job-row-<id>`,
  `bulk-count`, `retry-all-in-progress`, `worker-row-<id>`,
  `repeatable-row-<key>`.
- Job: `job-screen`, `job-id`, `job-not-found`, `job-hidden`,
  `job-stacktraces`, `logs-follow`, `flow-child-<queue>:<id>`,
  `flow-truncated`.
- Runners: `runners-list`, `runners-count`, `runner-row-<id>`,
  `runner-screen`, `runner-status`, `runner-id` (only when the name differs
  from the id), `runner-schedule`, `runner-concurrency`, `runner-stats`,
  `no-active-runs`, `run-<runId>`, `history-row-<runId>`, `remote-note`,
  `runner-hidden`, `runner-not-found`.
- Runner actions: the buttons sit in a `role="group"` named
  `Runner actions`. Inside it or its dialogs: `runner-remote-hint`,
  `trigger-remote-note`, `kill-waiting`, and `schedule-next-run` in the
  reschedule's success toast.

`__tests__/e2e/m2-flow.e2e.test.ts` drives the real app in headless Chrome
through `Bun.WebView`, against a real `createJobsApi` with CSRF on. It pauses a
queue, opens a dead job and retries it, reads each step back from the API and
checks that the page raised no CSP violation. It skips visibly when Chrome is
not found. Set `BUN_CHROME_PATH` to point it at one.

The runner screens have no Chrome flow yet.
`__tests__/app/pkg/runners.integration.test.ts` and
`runner-actions.integration.test.ts` render them under happy-dom against a
real `createJobsApi` in `runner` mode with a real local `BunRunner`.

### Loaded on demand

The Overview ships in the entry bundle. The queue, job and runner screens are
split chunks, fetched the first time one is opened (a labelled spinner shows
meanwhile) and served from the same assets path, which the CSP's
`script-src 'self'` allows. Styles are not split the same way: Bun's entry
stylesheet carries every rule, the lazily loaded screens' included, so the
shell links only that one and never a chunk's stylesheet, which would repeat
its rules (`entryStylesheets` in `lib/assets.ts`).

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
