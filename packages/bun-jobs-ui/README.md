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

Bun runs the shipped TypeScript server source (`main` is `lib/index.ts`). Your
type checker reads the built declarations in `dts/` (`types`), so your compiler
options never apply to this package's source, and they describe `lib/` only:
no React, TanStack or other browser-app type reaches your project.

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
the runner screens in M3, live updates and the Events console in M4, and the
API docs in M5.

The `failed` job state is labelled **Retrying** on every screen (tabs,
badges, counts, filters and dialogs): in bun-jobs it is a job that failed an
attempt and is waiting for its retry, while a job that has used up its
attempts is `dead`. Only the label changed: requests, URLs (`?state=failed`)
and events still say `failed`. The state's badge and tab carry a tooltip
saying so, and pointing to Dead for the jobs that gave up. Counts of failed
*attempts* (the Overview's "Failed attempts", the throughput panel, a
worker's Failed) and a runner's Failed runs keep their names.

| Route | What it shows |
|---|---|
| `/` | The Overview: namespace-wide counts per state (`GET /overview`) and a filterable queue table, with a throughput sparkline per row, then a Runners and a Workers section (`GET /analytics/runners`, `GET /analytics/workers`), all read over a chosen time range (presets from 60 seconds to 24 hours, or a custom start/end span). Each of those two sections shows a summed series with its totals, then a table of rows paged at `meta.analytics.maxSeries`, with sparklines for the visible page only (one batch read per page, whatever the row count). A Workers row is a worker key that did work in the range or is live now — who did the work in this window, not a list of running workers — so a stopped worker with counts in range keeps its row, and a live idle one shows zeros. A runner's Failed counts runs that threw; timeouts and kills are counted apart (the "Timed out / killed" column), so it is not the runner's lifetime failed count. The range control and its "Apply date filter to page" toggle sit at the right of the title row; the toggle decides whether that one control drives every section or each section carries its own. Throughput belongs to the range, so there is no fixed-window figure: a backend recording no analytics shows none rather than one that contradicts the range on screen. The "Over the range" tile keeps two groups apart: "Finished in range", the analytics series' completed jobs and failed attempts, counted when they finished; and, where the backend can count by creation time (`features.addedByState`), "Added in range, where they are now (still stored)": of the jobs added in the range and still stored, how many are in each state now (`GET /overview/added`, polled every 20 s), with a total; its "Retrying" is the `failed` state, not the failed attempts above it. One counts by finish time and the other by creation time, and the second leaves out jobs already removed (a queue that removes finished jobs shows few completed there), so the two are not expected to agree. When the caller has no Overview entry, `/` redirects to the first nav entry, or says there is nothing to show. |
| `/queues` | Every queue, searchable by name (case-insensitive) and paged. Each row links to its queue. |
| `/queues/:queue` | The queue's header (paused badge, job total, last update), its actions, the jobs table (a tab per state, filters, paging, bulk actions; newest added first on every tab where the backend sorts by creation time, `features.addedByState`, and each tab's natural order otherwise; where the backend records it, `features.jobAttribution`, a "Processed by" column naming the worker that ran each job's **last** attempt, its stable key linked to its worker page, the incarnation id when no key was recorded, and "—" when no worker is) and the detail panels: limits, job defaults (every option a job gets when its `add()` does not pass it, what the code asks for and whether the queue's stored override replaces it, and the jobs pending in each state it can be applied to; with Settings… to edit them and Apply to N pending jobs… to rewrite pending jobs, a separate action that walks the queue in batches), workers (the same table and controls as the Workers page, for this queue alone), throughput and repeatables. |
| `/queues/:queue/jobs/:id` | One job: its summary, the failure with its cause chain and the failure history, data, return value, flow parent and children, logs and options, with Retry, Promote, Fail…, Remove and Edit, and Clear logs… in the logs section (`DELETE /queues/:queue/jobs/:id/logs`: the log is emptied for good and its line count starts again from zero; not while the job is `active`, since its worker is still writing the log). The summary's "Held by" names the worker holding the job, shown only while it is `active` (`workerId`). Where the backend records it (`features.jobAttribution`), "Processed by" names the worker that ran the job's **last** attempt (`processedBy`): its stable key, linked to its worker page (the job's queue and the key), its incarnation id, and host and pid when the API exposes them. Earlier attempts are not recorded. With no worker recorded (never claimed, or claimed before the backend recorded attribution) it says so. |
| `/workers` | Every live worker in the namespace (`GET /workers`), grouped by the service that runs them (`service`, with processes that named none last) and then by the server hosting each (host and pid; one group named "Hosts hidden by the API" when `serialize.exposeHosts` is off). A row shows the worker's queue (linked to its screen with `queues.list`), whether it is running or paused, its active jobs against its concurrency, and when it started and last reported. It also has a Memory column: the resident memory of the **process** the worker runs in at its last report (`rssBytes`), so workers sharing a pid repeat one figure and the column must not be added up — to size a host, take one row per pid. A worker that reports none shows "—", never `0 B`, and the column is absent when no worker in the table reports one. Where a worker reports its heartbeat's round trip (`heartbeatRttMs`), the Heartbeat cell's tooltip adds how long that write took: the previous report's sample of the driver round trip, not a network ping and not an average. Each row also carries its controls: Pause, Resume, Stop… and Start (one running worker, by its per-incarnation `id`) and Settings… (the settings of every worker sharing its stable `key`). Filtered on the server by queue, service, host (offered only when the API exposes hosts) and state, each a select over the values the unfiltered list has, and by id, key, service, queue, host or pid in the browser. A row's stable key links to its worker page; every instance of a key leads to the same page, and a worker reporting no key has no link. It follows the `workers` channel: a worker announces its first start (a `state` event with no `previous`: `running`; `paused` when it starts paused; or `stopped` when a stop recorded against its key holds it parked), its state changes (paused, resumed, stopping/stopped, started again, restarting) and config changes, and each refreshes the list. A queue another process creates after the page subscribed is followed from the API's next discovery pass (`discoveryInterval`, 2 s by default); a worker's first start on it comes before that, so the API sends a `gap` (reason `queue-discovered`) instead, which refreshes the list too. The listing itself comes from the worker's heartbeat, written when it starts — at once on a queue the API already knows, and within `limits.queueCacheMs` (2 s by default) on a queue the API has not seen yet — and its row then refreshes every `reportInterval` (10 s by default). So the list also re-reads every 5 seconds, relaxed while live. |
| `/workers/:queue/:key` | One stable worker key, addressed with its queue because a key is unique only within its queue: the key, its queue (linked with `queues.list`) and its service; its live instances (`GET /workers?queue=<queue>&key=<key>&includeOffline=true`) in the Workers page's table, with the same controls, the same Memory column (one figure per process, so two instances in one process repeat it and it must not be added up) and the same heartbeat round-trip tooltip; its full configuration, every setting with the value it runs with, the value its code asks for and whether the key's override replaces it, with Edit settings… (the Settings dialog) and a "Change pending" badge; its throughput and busyness over a chosen range (`GET /queues/:queue/analytics/workers/:key`), each captioned from its own response's range, since busyness is served coarser; and the jobs whose last attempt this key ran (`GET /queues/:queue/jobs?workerKey=<key>`), where the backend records attribution (`features.jobAttribution`). A job that failed on another worker and then ran on this one is listed on this page only. The jobs list has the queue table's state tabs (without counts), name and search filters, order, rows, bulk actions and pager (without a total). It covers a range over `finishedOn`, the last 24 hours by default. A job with no finish time never matches a range, so All lists only completed and dead jobs. On the Waiting, Delayed, Active, Retrying and Waiting-children tabs the range is dropped, with a note saying so, and every job of that state the key last ran is listed. Which worker ran a job is kept only as long as the job is, so jobs removed on completion are not listed. A key containing a comma cannot be sent as one filter value (the API splits values at commas), so for such a key the section says the list cannot be filtered to it and reads nothing. With no live instance it says the configuration cannot be shown until one reports, lists the override stored for the key (the listing's `offline`), and still offers Reset to code values…. |
| `/runners` | Every runner in the namespace (`GET /runners`): local ones first, with their name and status, then remote ones by id. Filtered by id or name in the browser, with no paging. Each row links to its runner. |
| `/runners/:runner` | One runner: its status badges, its actions, a summary (schedule, next run, execution and run mode, queueing, concurrency, which of those are overridden and whether the owner has adopted the override, the run holding its lock, the last error), the lifetime counters, the runs in flight in this process, the last run and the run history. Clear history… sits in the History card's header, beside Runs shown and directly above the runs (not among the actions at the top), and is disabled with "No runs to clear." while the history is empty; it (`DELETE /runners/:runner/history`) removes every finished run and its log and keeps each run in progress whole, toasting how many went and how many were kept; the lifetime counters and charts are untouched, and unlike Kill… and Reset stats… it works on a runner registered in another process. Settings… edits the execution mode, the run mode and the max concurrency through `PUT /runners/:runner/config` (a merge patch, so only what changed is sent), with what the runner's own code asks for beside each one, a way back to it per setting and a Reset to code defaults (`DELETE`) for all of them. Each row of the history — which includes the run in flight — opens that run's captured output in its details (`GET /runners/:runner/runs/:runId/logs`): the lines with their sequence number, time, stream and level, a stream filter, and what the log is not showing (lines the cap dropped, a cap trimming it now, a line capture cut, and the output that escapes capture altogether). The history is the one place a log is hosted, since the run in flight and the last run are rows of it as well as cards of their own. A live run's log is followed by the runner's `logs` event on `runner/<runner>` — a hint carrying only the run id and its newest sequence number — each hint for that run triggering a read with `?since=<cursor>`, with a poll kept underneath as the fallback. |
| `/events` | The Events console: a live tail of the API's socket. Pick a channel (`all` in mode `both`, `queues`, one queue from the queue list, one job by queue and id, every worker (`workers`), one queue's workers, `runners`, or one runner from the runner list) and filter by event type. Worker events travel only on the two worker channels, never on `all` or `queues`; a worker announces its first start (a `state` event with no `previous`) and every later state and config change. Rows show the time, kind and type, the target (linked to its queue or runner; a worker event's target is its queue), the id (a job links to its screen) and the payload. The log keeps the latest 500 rows, newest first; Pause holds up to 500 more (the rest are counted as dropped) until Resume, and Clear empties it. A channel the server refuses shows its code and reason, and a `gap` shows inline as `gap: <reason>` (on the worker channels, `queue-discovered` means a queue another process created is now followed, and events before it may be missing). When the log is empty it says why: producers not publishing, `events: "local"`, or live updates off. |
| `/docs` | The API docs landing page: a card for the HTTP reference, and one for the WebSocket reference when the API serves its AsyncAPI document. |
| `/docs/http` | The HTTP reference, from the API's OpenAPI 3.1 document: a sidebar of operations by tag, searchable, then the document's title, version, description and servers (each resolved against the origin the app talks to, next to the `apiBase` the app sends to), every tag with its operations, and the component schemas, each opening in a side panel. |
| `/docs/http/:operationId` | One operation: method, path and operationId, the permission marker, whether it is a mutation, its CSRF rules and the driver methods it needs, its parameters, body and responses as schema trees, and its try-it panel. An operationId the document lacks shows "No such operation" (the API prunes operations by its mode, read-only setting and actions). |
| `/docs/ws` | The WebSocket reference, from the API's AsyncAPI 3.0 document: the title and version, the server (URL, host, path, protocol, subprotocol) and security panels, then a searchable sidebar of the connection's panels, channels, operations, control messages and event messages. With no item, the connection channel is shown. |
| `/docs/ws/:item` | One item, by slug: `channel-<key>`, `operation-<key>` or `message-<key>` (e.g. `message-queue.completed`), or one of the connection's panels, `limits`, `close-codes` and `upgrade-refusals`. A slug the document has nothing for shows "No such item". |

### Failing a job, and disabling a repeat series

**Fail…** on the job screen sends the job to `dead` for good
(`POST /queues/:queue/jobs/:id/fail`), whatever attempts it has left. It is
offered for a job in any state but `completed` and `dead`, the two the API
refuses, and it is a danger dialog: a **Reason** is required (1 to 4,096
characters, at least one of them not whitespace), sent and recorded as the
job's failure exactly as typed, spaces included, and the job's id must be
typed to confirm. An id longer than 40 characters is confirmed by typing its
last 8 instead, since ids run to 1,024. For an `active` job the dialog warns
that failing it does not stop its code: the worker loses the job's lock at its
next heartbeat and the attempt's signal is aborted, but the processor runs on
until it returns, and whatever it returns or throws is discarded. A 409 says
what state the job is in now, and a 404 that it no longer exists; the job
screen refreshes on the `dead` event that follows, and on the success itself.

The **Repeatables** panel marks a disabled series with a **Disabled** badge,
and its next run reads "paused (disabled)" instead of a time. **Disable**
(`POST /queues/:queue/repeatables/:key/disable`) removes the series' pending
occurrence and schedules nothing more until **Enable**
(`POST …/enable`) schedules the next one from now; occurrences missed
meanwhile are not run. Both are idempotent, so neither asks for a
confirmation. A 404 means the series no longer exists.

Progress is shown as the job reported it: a number as a percentage bar with
its value (the bar clamped to 0–100, the number not), a record of fields as
a JSON tree. Live, a `progress` event writes the new value into the job
screen without a refetch.

### Queue job defaults

The queue screen's **Job defaults** panel (`GET /queues/:queue/job-defaults`)
lists every option a queue may store a default for, in the contract's order
(`JOB_DEFAULT_KEYS`): what a job added now gets when its `add()` does not pass
the option, what the code asks for, and whether the queue's stored override
replaces it. The override beats the code's defaults and a `define()`
definition's; only an option passed explicitly on `add()` wins. "Code" is what
this API's own service is configured with (`codeSource: "api"`): a producer in
another service may be configured differently, and the override replaces them
all alike.

**Settings…** edits them, each input bounded by `JOB_DEFAULTS_BOUNDS`, the
backoff limited to `fixed` and `exponential` (`JOB_DEFAULT_BACKOFF_TYPES`).
Each option shows its value now and the code's, with **Use code value** on an
overridden one. Saving sends a merge patch (`PUT`): only the options that
changed, `null` for one set back to the code's value, and the `seq` it read
as `expectedSeq`. If someone changed the defaults meanwhile, the API answers
409 and nothing is saved; the dialog asks to re-read them. **Reset to code
values** (`DELETE`) clears every override. The note beside it says what a
reset cannot do: jobs already rewritten by an apply keep the values written
to them. A save or reset reaches producers within about `propagationMs`
(about a second), which the confirmation says.

Saving never touches jobs already waiting. **Apply to N pending jobs…** is a
separate action, with its own permission. N is the jobs pending in the states
it rewrites (waiting, delayed, retrying, waiting on children), an upper bound.
Its confirmation lists the values it writes. It has a box for each state,
all ticked, and **Include jobs added before this version**, unticked:
without it, jobs added before bun-jobs recorded which options their `add()`
passed are skipped and counted. When the stored `attempts` is below the
code's, it warns that a job that has already used up the new number of
attempts is not dropped: it gets one final attempt. **Preview (dry run)**
walks the same jobs and writes nothing. The walk runs in batches of 1,000
(`POST /queues/:queue/job-defaults/apply`, each call continuing from the
previous one's `next`), showing how many jobs were examined and rewritten so
far. **Cancel** stops it between batches, and **Continue from where it
stopped** resumes from the cursor. At the end it reports what the walk did:
jobs rewritten (or that would be, for a preview), unchanged, skipped as
explicit, skipped as added before this version, moved, and exhausted, which
is part of rewritten. Every call carries the `seq` confirmed, so if someone
saves or resets the defaults during the walk, the API answers 409
`DEFAULTS_CHANGED`. The walk then stops, says how many jobs had already been
rewritten, and asks to re-read before applying again. The rewrite cannot be
undone.

### Date-time fields

Every date-time field (**Run at** when adding or editing a job, a runner
schedule's **Anchor** and **Once** time) is checked as it changes, against
the API's own rule for a time: epoch milliseconds from 0 up to
`MAX_DATE_MS` (13 September 275760, the last instant a `Date` holds). A
time outside that range, or one the browser could not read, is refused on
the field and the dialog's submit button is disabled until it is fixed or
cleared, rather than being sent for a 400 `VALIDATION`, or dropped as if the
field were empty.

### URL parameters

Everything a screen filters by lives in the query string, so a link
reproduces the view. A value that is missing or invalid falls back to the
default.

| Screen | Parameter | Meaning |
|---|---|---|
| `/` | `q` | Filters the queue table by name. |
| `/` | `range` | The range every section is read over while the page-wide control is in force: `<seconds>s` for a preset (`60s`, `300s`, `600s`, `1800s`, `3600s`, `21600s`, `86400s`) or `<from>-<to>` in epoch ms for a custom span. Absent means the last hour. Anything malformed, a preset nobody offers, or a span that is backwards, under a second or over 31 days falls back to the default rather than being asked for. |
| `/` | `rangeScope` | `section` gives each section its own range control; absent (the default) means one control for the page. |
| `/` | `jobsRange`, `queuesRange`, `runnersRange`, `workersRange` | Each section's own range, in the same form as `range`, used while `rangeScope=section`. |
| `/queues` | `search` | Filters by name, as you type. Changing it resets `offset`. |
| `/queues` | `offset` | Rows skipped. Defaults to `0`. |
| `/queues` | `limit` | Page size, `1` to `limits.maxQueues`. Defaults to the smaller of `limits.defaultPageSize` and `limits.maxQueues`. |
| `/queues/:queue` | `state` | The state tab: `waiting`, `delayed`, `active`, `completed`, `failed` (the tab labelled Retrying), `dead` or `waiting-children`. Absent means All. |
| `/queues/:queue` | `offset` | Jobs skipped. Defaults to `0`. |
| `/queues/:queue` | `limit` | Page size, `1` to `limits.maxPageSize`. Defaults to `limits.defaultPageSize`. |
| `/queues/:queue` | `total=1` | Asks the API to count `page.total` ("Count total"). |
| `/queues/:queue` | `name` | Exact job names as a comma list. The request sends each name as its own `name` key. |
| `/queues/:queue` | `search` | Id or name contains this text. `name` and `search` apply when you press Apply. |
| `/queues/:queue` | `order=asc` | Oldest first. Absent means **newest first**, sent as `order=desc` since the API's own default is oldest first. Where the backend sorts by creation time (`features.addedByState`), every tab is ordered by `createdAt` (sent as `sort=createdAt`, never written into the URL), except a page counting its total (`total=1`), which keeps the natural order below. Otherwise no `sort` is sent and the natural order applies: on the All tab by creation time (`createdAt`), the one key every state shares; a single-state tab by that state's own time — when a delayed or retrying (`failed`) job will run, when a completed or dead one finished, an active one's lock — so "newest" there means most recent by that time. |
| `/queues/:queue` | `panel` | The open detail panel: `limits`, `job-defaults`, `workers`, `throughput` or `repeatables`. Defaults to the first one shown. |
| `/queues/:queue` | `window` | The throughput window in minutes: `15`, `60`, `360` or `1440`. Defaults to `60`. |
| `/workers` | `search` | Filters by worker id, stable key, service, queue, host or pid (case-insensitive; every whitespace-separated word must appear), as you type. Filtered in the browser, so nothing is re-fetched; it narrows what the filters below returned. |
| `/workers` | `queue`, `service`, `host`, `state` | Server-side filters, each sent as the `GET /workers` parameter of the same name (exact, and ANDed together). Each select offers the values the unfiltered list has, plus the one in the link. `state` is `running`, `paused`, `stopping`, `stopped` or `restarting`; anything else is ignored. `host` is offered and sent only when the workers carry a host: with `serialize.exposeHosts` off the API refuses it, so one in a link is ignored, with a note. Clear filters removes all four and keeps `search`. |
| `/workers/:queue/:key` | `range` | The range the key's throughput and busyness are read over, in the same form as the Overview's `range`. Absent means the last hour. |
| `/workers/:queue/:key` | `jobState` | The jobs section's state tab, with the same values as the queue screen's `state`. Absent means All. |
| `/workers/:queue/:key` | `finished` | The range the jobs section lists over, sent as `finishedFrom` (inclusive) and, for a custom span, `finishedTo` (exclusive). It uses the Overview `range` format, but absent means the **last 24 hours**, and a custom span may be any length where the end is after the start. Not sent for the Waiting, Delayed, Active, Retrying and Waiting-children tabs, since those jobs have no finish time. |
| `/workers/:queue/:key` | `jobName`, `jobSearch` | The jobs section's name and search filters, as the queue screen's `name` and `search`. |
| `/workers/:queue/:key` | `jobOrder=asc` | Oldest first. Absent means newest first. |
| `/workers/:queue/:key` | `jobOffset`, `jobLimit` | The jobs section's paging, as the queue screen's `offset` and `limit`. There is no `total`: the section never counts. |
| `/runners` | `search` | Filters by id or name (case-insensitive, trimmed), as you type. The list is filtered in the browser, so nothing is re-fetched. |
| `/runners/:runner` | `logs` | The run id whose log is open, e.g. `logs=run-3`. The run's row in the history is expanded with it, and its log read; an id no run on the screen has opens nothing. Absent means no log is open, and nothing is read. |
| `/runners/:runner` | `logStream` | Only lines from this stream, sent as `GET /runners/:runner/runs/:runId/logs?stream=`: `stdout`, `stderr` or `log` (the logger's own lines). Anything else, and absent, means every stream. Each stream keeps its own tail: `since` is a raw sequence number, so changing the filter re-reads from the start of what is kept. |
| `/runners/:runner` | `history` | Runs shown in the history, sent as `GET /runners/:runner/history?limit=`. Defaults to the smaller of `50` and `limits.maxHistory`. A number outside `1` to `limits.maxHistory` is clamped to that range, not reset. The select offers `10`, `25`, `50`, `100` and `200` up to the cap, plus the default and the cap. Choosing the default removes the parameter. |
| `/events` | `channel` | The channel, as the socket names it: `all`, `queues`, `queue/<queue>`, `queue/<queue>/job/<encoded id>`, `workers`, `queue/<queue>/workers`, `runners` or `runner/<runner>`. One the API's mode lacks, or a malformed one, falls back to `all` in mode `both`, else `queues` or `runners`. |
| `/events` | `types` | Event types as a comma list, e.g. `completed,failed`. A name may carry its family, `queue.completed` or `runner.failed`, and is rewritten bare in the URL; a prefixed name counts only on a channel carrying that family. An unknown name, or one the channel cannot carry, is ignored and named in a note above the log, and stays in the URL so the note survives a reload; if nothing is left, every type shows. Absent means every type. |
| `/docs/http` | `q` | Filters the sidebar, as you type: every whitespace-separated word must appear, ignoring case, in an operation's method, path, operationId, summary or action. Operation links keep it. The tag overview is not filtered. |
| `/docs/ws` | `q` | Filters the sidebar the same way, over each item's slug, label and hint and its keywords (a channel's address and parameters, an operation's permission, the limit names, the close codes, the refusal statuses and codes). The sidebar's links keep it. |

On the queue screen, changing `state`, `name`, `search` or `order` resets
`offset` and clears the selection. On a worker page, changing `jobState`,
`jobName`, `jobSearch`, `jobOrder` or `finished` resets `jobOffset` the same
way.

### What each element needs

The app boots with the untargeted `GET /meta/permissions`. The Queues nav
entry, and so every `/queues*` route, depends on that map's `queues.list`.
Screens under `/queues/:queue` also ask `GET /meta/permissions?queue=<queue>`,
and that per-queue answer refines only the buttons and panels inside that
queue's screens. Until it arrives, or if it fails, those screens' buttons and
panels use the untargeted map; the job screen's read of the job waits for it
instead, and falls back to the untargeted map only if it fails. Runners work
the same way: the Runners nav entry and every `/runners*` route depend on the
untargeted `runners.list`, and `/runners/:runner` asks
`GET /meta/permissions?runner=<runner>` for its own reads and buttons; its
read of the runner waits for that answer too. A worker page,
`/workers/:queue/:key`, is routed with the Workers nav entry and asks
`GET /meta/permissions?queue=<queue>` for its reads and buttons, since worker
actions authorize against the queue; it does not wait for the answer. Because the lists depend on the
untargeted map, `/queues` and `/runners` list every queue and runner, even one
the host's `authorize` refuses entirely; its link then leads to "Jobs hidden",
"Job hidden" or "Runner hidden". An action counts only when the map holds it and it is `true`.
An element that is not allowed is absent, not disabled. "Mutation" below means
the action and `meta.readOnly` false. The API's own 401/403 stays the
authority, since the map is never asked about one particular job.

| Element | Needs |
|---|---|
| Overview nav entry and `/` | `sections.manage`, `meta.mode` `jobs` or `both`, and `metrics.read` or `queues.list` (untargeted) |
| Overview counts | `metrics.read` |
| Overview queue table | `queues.list` |
| Overview sparklines | `metrics.read`, `features.throughput` and `meta.analytics` (a backend that records analytics); without analytics there is no Throughput column |
| Overview "Over the range" figure | `metrics.read` and `meta.analytics`: it is the analytics series' own total, labelled with the resolution the API served. Absent when the backend records no analytics; the whole tile is absent only when the added-by-state group is too |
| Overview "Over the range" added-by-state group ("Added in range, where they are now (still stored)") | `metrics.read` and `features.addedByState`; without the feature nothing is read and the tile shows the analytics series alone. Read over the Jobs section's range |
| Overview Runners section | `metrics.read`, `features.runnerMetrics`, `meta.analytics`, and `meta.analytics.recording.runners` |
| Overview Workers section | `metrics.read`, `features.workerMetrics`, `meta.analytics`, and `meta.analytics.recording.workers` |
| Overview Runners section row links | a row's runner links to its runner page where those pages are routed for the caller (the Runners nav entry's needs, read on the untargeted map); plain text otherwise. A row may name a runner that has since been unregistered, and the link then lands on the runner screen's own "no longer exists" state |
| Overview Workers section row links | a row's worker key links to its worker page where those pages are routed for the caller (the Workers nav entry's needs, read on the untargeted map), and its queue links to the queue screen with `queues.list`; each is plain text otherwise, so a row never offers a route the app did not register |
| Overview Runners / Workers note "Showing the N busiest … of M" | the roll-up's `truncated`: N is the rows it returned (at most 100), M its `totalRows` — for workers every live key plus the stopped keys with counts in the range, for runners every runner the namespace lists |
| Overview range caption ("This is not exactly the range asked for: …") | the Jobs, Runners or Workers read's response has `range.clamped`; worded by its `reason` (`retention`, `maxBuckets`, `resolution`, `driver`), naming the resolution served; an unknown reason says only what was served |
| Overview "No numbers are kept for this range" | the Jobs, Runners or Workers read answered 400 `RANGE_NOT_RETAINED` (the whole range is older than the API keeps): it gives the oldest instant kept when the error carries one, and offers no Retry; a sparkline cell whose own read is answered that way reads "not kept" ("unavailable" for any other failure) |
| Queues nav entry and every `/queues*` route | `sections.manage`, `meta.mode` `jobs` or `both`, and `queues.list` (untargeted) |
| Queue header total and paused badge | `queues.read` |
| Jobs table, and the job links in it | `jobs.list`; without it, "Jobs hidden" |
| Jobs table "Processed by" column | `jobs.list`, and `features.jobAttribution`; without the feature there is no column. Not on a worker page's jobs, where every row is that key |
| Jobs table "Processed by" worker link | the Workers nav entry's needs, read on the untargeted map, and the job's `processedBy` carries a `key`; without them the key is plain text |
| Jobs table and worker page jobs, newest added first on every tab (`sort=createdAt`) | `features.addedByState`; without it no `sort` is sent and each tab keeps its natural order. A page counting its total keeps the natural order too, and "Count total" says so |
| Pause / Resume | mutation `queues.pause` / `queues.resume`, and `queues.read`: Pause shows on a running queue, Resume on a paused one |
| Drain…, Clean…, Retry all… | mutation `queues.drain`, `queues.clean`, `jobs.retryAll` |
| Add job | mutation `jobs.add` (**opt-in**), and `meta.addableNames` is `null` (any name) or non-empty |
| Add job's name suggestions | `definitions.list`, when `addableNames` is `null` |
| Bulk Retry / Promote / Remove selected | `jobs.list`, and mutation `jobs.retry` / `jobs.promote` / `jobs.remove` |
| Limits panel | `queues.read` and `features.limits`; shown with a spinner while the queue's detail loads, then only if the detail carries `limits` |
| Limits panel, editable | the above, and mutation `queues.limits` |
| Job defaults panel | `queues.read`, and `features.jobDefaults` (every built-in backend; false in `runner` mode); without the feature nothing is read |
| Job defaults Settings… | the above, and mutation `queues.defaults` (opt-in) |
| Job defaults Apply to N pending jobs… | the Job defaults panel, `features.jobDefaultsApply`, and mutation `queues.applyDefaults` (opt-in, separate from `queues.defaults`), and the queue has an override and pending jobs in the states it rewrites; otherwise the panel says why |
| Workers panel | `workers.list` and `features.workers`. It also carries the housekeeping note: where a live worker reports `sweeps: false` and none reports `true`, the panel says no worker on the queue runs the housekeeping sweeps — expired results, repeat series and stale queue state — while making plain that jobs still run |
| Throughput panel | `metrics.read` and `features.throughput` |
| Repeatables panel | `repeatables.list` |
| Repeatables panel, Remove | the above, and mutation `repeatables.remove` |
| Job screen | `jobs.read`, as the queue's own permissions answer it: the job is not fetched until they have loaded, and never without `jobs.read` ("Job hidden"). A 401/403 on the job itself shows the same panel with the API's detail. |
| Job logs | `jobs.logs` and `features.logs` |
| Job Clear logs… | mutation `jobs.clearLogs`, inside the Job logs card (so its needs too). Shown for a job in any state, but not clickable while the job is `active` (a worker is still writing the log) or while the log holds no lines; the reason sits beside the button |
| Job Retry | mutation `jobs.retry`, and the job is `completed`, `failed` or `dead` |
| Job Promote | mutation `jobs.promote`, and the job is `delayed` |
| Job Remove | mutation `jobs.remove` |
| Job Edit | mutation `jobs.update` (**opt-in**) and `features.update` |
| Job "Processed by" | the job screen's `jobs.read`, and `features.jobAttribution`; without the feature the line is absent |
| Job "Processed by" worker link | the Workers nav entry's needs, read on the untargeted map, and the job's `processedBy` carries a `key`; without them the key is plain text |
| Runners nav entry and every `/runners*` route | `sections.manage`, `meta.mode` `runner` or `both`, and `runners.list` (untargeted) |
| Runner screen | `runners.read`, as the runner's own permissions answer it: the runner is not fetched until they have loaded, and never without `runners.read` ("Runner hidden"). A 401/403 on the runner itself shows the same panel with the API's detail and stops the polling. A 404 (`RUNNER_NOT_FOUND`) shows "Runner not found". |
| Runner stats and history | the runner screen's `runners.read`; the stats are read once the runner has loaded, and the tiles show the runner's own `stats` until then |
| Runner active runs | the runner is registered in the API's process (`local` is present) |
| Runner run log, and the history's Log column | `runners.logs` (a read, granted by default) and `features.runnerLogs`; without either, no column and no log anywhere on the screen |
| A run's Log button (in the history row, and Show log in its expanded details) | the above, and `logLines > 0`, or the run's status is `running` (a live run's record carries no `logLines` until the run settles, so the status is what offers it), or the run reports no `logLines` at all (the field is optional; the read itself then answers). Only a finished run with `logLines` `0` offers none, and says it logged nothing |
| A history row's "N lines dropped" badge | the run log's needs (it sits in the history's Log column: `runners.logs` and `features.runnerLogs`), and the run's `logsDropped` is above `0` |
| Runner Trigger… | mutation `runners.trigger`; its Arguments field only when `meta.runnerTriggerArgs` |
| Runner Pause / Resume… | mutation `runners.pause` / `runners.resume`: Pause shows while `isPaused` is false, Resume while it is true |
| Runner Reschedule… | mutation `runners.reschedule` |
| Runner Kill… | mutation `runners.kill`, and the runner is local with at least one run in `local.activeRuns` |
| Runner Reset stats… | mutation `runners.resetStats`, and the runner is local (`isLocal`) |
| Runner Clear history… | mutation `runners.clearHistory`, on any runner: unlike Kill… and Reset stats…, a runner registered only in another process gets it too, and it does not bring up the remote hint; it sits in the History card's header, and is disabled, with "No runs to clear.", while the history is empty |
| Runner remote hint | mutation `runners.kill` or `runners.resetStats`, and the runner is not local |
| Workers nav entry and `/workers` | `sections.manage`, `meta.mode` `jobs` or `both`, `meta.features.workers` (the backend keeps a worker registry), and `workers.list` (untargeted) |
| Workers page queue links | `queues.list` (untargeted); without it the queue is plain text |
| Workers page Queue, Service and State filters | `workers.list` (untargeted), as the page itself; each offers the values the unfiltered list returned, plus the one in the link |
| Workers page Host filter | `workers.list` (untargeted), and the workers the unfiltered list returned carry a `host` (`serialize.exposeHosts` on); otherwise it is absent, and a `host` in the link is ignored with a note |
| Workers table key links (the Workers page and a queue's Workers panel) | the Workers nav entry's needs, read on the untargeted map, and the worker reports a `key`; every instance of a key links to the same worker page |
| Worker page (`/workers/:queue/:key`) | the Workers nav entry's needs; the page then asks `GET /meta/permissions?queue=<queue>`, since worker actions authorize against the queue, and its instances need `workers.list` on that answer |
| Worker page queue link | `queues.list` (untargeted); without it the queue is plain text |
| Worker page Edit settings… | `meta.features.workerControl` and mutation `workers.configure` (**opt-in**), and an instance reports `control.enabled`, its `config` and the stable `key`: the same gate as that instance's Settings…. It edits from the first instance that reports a config |
| Worker page Reset to code values… (no live instance) | `meta.features.workerControl` and mutation `workers.configure` (**opt-in**), unless the listing's `offline` says nothing is stored for the key: no entry for it, or an entry with no values (a reset empties the entry and keeps its `seq` rather than deleting it), which counts as nothing stored |
| Worker page "Change pending" badge | some instance of the key reports `control.pending` |
| Worker page throughput and busyness | `metrics.read`, `features.workerMetrics`, `meta.analytics`, and `meta.analytics.recording.workers`: the Overview Workers section's needs |
| Worker page jobs ("Jobs whose last attempt this key ran") | `features.jobAttribution`, and `jobs.list` on the queue's answer; without the feature it says the backend does not record which worker ran a job, and without `jobs.list` it shows "Jobs hidden". Neither case reads anything. Shown even when that answer refuses `workers.list`. A key containing a comma cannot be filtered to (the API splits filter values at commas), and the section says so and reads nothing |
| Worker page jobs' job links | `queues.list` (untargeted), the Queues nav entry the job screen is routed with; without it the ids are plain text |
| Workers table Completed / Failed columns (the Workers page and a queue's Workers panel) | some worker in that table reports `completed` or `failed`; a worker that reports neither shows "—", since absent is not zero. The counts are this incarnation's: a restart starts them again |
| Workers table Memory column (the Workers page and a worker page's Instances table, not a queue's Workers panel) | the table asks for the column — the Workers page and a worker page's Instances table do, a queue's Workers panel does not — and some worker in it reports `rssBytes`; a worker that does not shows "—", since absent is not zero. It is the **process's** resident memory at that report, not the worker's own, so workers sharing a pid repeat one figure and the column is never summed: to size a host, take one row per pid |
| Queue Workers panel housekeeping note | at least one live worker on the queue reports `sweeps: false` **and** none reports `true`. A worker too old to report the field has said nothing, so a panel whose live workers all omit it shows no note; where some omit it and none reports `true`, the note hedges ("there may be nobody doing it"). It is about tidiness, not liveness: delayed jobs are still promoted and stalled ones recovered, so it never says the queue is stuck |
| Worker instruction wording ("Paused X" vs "Asked X to pause") | `WorkerControlResultDto.applied`: the UI sends `?wait=2000`, so a driver that delivers instructions promptly (memory, Redis) answers acknowledged and the message says it is done; on a polling driver it says the instruction was recorded |
| Worker Pause | `meta.features.workerControl` and mutation `workers.pause` — on `/workers` read on the untargeted map, in a queue's Workers panel and on the worker page on that queue's answer — on a worker whose state is `running`, that reports (`control.enabled`, not stale) and is not mid-transition |
| Worker Resume | mutation `workers.resume`, on a worker whose state is `paused`, under the same conditions |
| Worker Stop… | mutation `workers.stop`, on a worker whose state is `running` or `paused`, under the same conditions |
| Worker Start | mutation `workers.start`, on a worker whose state is `stopped`, under the same conditions |
| Worker Stop… persistence choice | `control.stopPersistenceOverridable`; without it the dialog states the deployment's `control.stopPersistence` instead of offering a choice |
| Worker Settings… | `meta.features.workerControl` and mutation `workers.configure` (**opt-in**: a host must list it in `actions`), on the same map as Pause, and the worker reports `control.enabled` and the stable `key` an override is stored against; offered even while the worker is stale or mid-transition, since the override is stored for the next replica |
| Worker "Change pending" badge and the Settings dialog's pending note | the worker reports `control.pending`: a recorded change it has not taken up yet, so the values shown are still the ones it runs with |
| Worker actions column | any of the above on some worker in that table; a caller with none sees the table without it |
| Events nav entry and `/events` | `sections.manage`, `meta.websocket`, and `events.connect` (untargeted) |
| Events queue and job channel pickers' queue list | `meta.mode` `jobs` or `both` (the queue and job channels exist only there), and `queues.list` (untargeted); without it, a text box |
| Events runner channel picker's runner list | `meta.mode` `runner` or `both` (the runner channel exists only there), and `runners.list` (untargeted); without it, a text box |
| API docs nav entry and every `/docs*` route | `sections.docs`, `meta.docs` (the API routes its docs), and `docs.read` (untargeted); `sections.manage` is not needed |
| HTTP API nav entry (under API docs), the HTTP reference (`/docs/http*`) and its card on `/docs` | `meta.docs.openapi`, which the API sends whenever `meta.docs` is set |
| WebSocket API nav entry (under API docs), the WebSocket reference (`/docs/ws*`) and its card on `/docs` | `meta.docs.asyncapi`; without it, the nav has no WebSocket API entry, `/docs/ws` shows "This API has no live-events socket" and `/docs` shows no WebSocket card |
| HTTP operation's permission marker, "You have" / "You lack" | the operation's `x-bun-jobs-action`, looked up in the untargeted map |
| WebSocket channel's and operation's permission markers, "You have this" / "You lack this" | the operation's `x-bun-jobs-action`, looked up in the untargeted map; one the UI does not know shows "Not an action this UI knows" |
| HTTP try-it Send | the method is `GET`, `POST`, `PUT`, `PATCH` or `DELETE`; `meta.readOnly` false for a mutation (`x-bun-jobs-mutation`); and the operation's `x-bun-jobs-action` (untargeted), reads included. Otherwise the panel is disabled, with the reason shown |
| HTTP try-it confirmation | every mutation asks first; a `DELETE`, or an action whose verb is `remove`, `drain`, `clean`, `kill` or `fail`, needs its operationId typed |
| WebSocket try-it, "Open in the Events console" | the Events nav entry: `sections.manage`, `meta.websocket` and `events.connect` (untargeted); otherwise a note says the console is not available. A channel's link also needs each parameter filled and passing the document's `x-bun-jobs-schema` (for an older API without it, the client's name rule), and a channel `meta.mode` offers; a parameter that fails disables the link, with the reason shown. The connection channel has no try-it: there is nothing to subscribe to |
| Job Fail… | mutation `jobs.fail`, and the job is not `completed` or `dead` |
| Repeatables panel, Disable / Enable | `repeatables.list`, and mutation `repeatables.disable` / `repeatables.enable`: Disable shows on an enabled series, Enable on a disabled one |
| Runner Settings… | mutation `runners.configure`, which is opt-in (a host must list it in `actions`), and the runner reports a `config`; a runner without one predates remote configuration, and the API answers 409 `RUNNER_NOT_CONFIGURABLE` |
| Runner summary's override rows | the runner screen's `runners.read`, and the runner reports a `config`: the summary then marks each overridden setting, names what the runner's code asks for, and says when an override is waiting to be adopted or was refused |

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

The docs are the exception to "absent, not disabled": a reference documents
every operation the API serves, so the try-it panel of one the caller may not
send is shown disabled, with its reason ("This API is read-only…", "You do not
have the `<action>` permission."). The permission markers and the try-it gate
read only the untargeted map, since an operation has no one queue or runner:
`authorize` may still decide per target, and the API's answer is final.

### Runners

- **Status is the lifecycle, not activity.** A local runner's badge is its
  instance's `status`: `idle` (registered, not started), `running` (started:
  its schedule is armed and triggers are accepted), `paused` or `stopped`. A
  run in flight is a separate "Run in flight" badge, shown while `isRunning`
  is true or `local.activeRuns` is not empty (the list shows it from the
  item's `isRunning`). A remote runner has no lifecycle status here: the list
  and its screen show Paused or Active from the shared `isPaused` flag.
- **The history includes the run in flight.** A run that has started and not
  finished is the newest row, with status `running`.
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
  authority, and names the part at fault in `issues[].path` in one of two
  errors. A cron expression or time zone the scheduler refuses is 400
  `INVALID_SCHEDULE`, at `schedule.cron`, `schedule.tz`, or `schedule` for a
  bare cron string. An interval below one millisecond, or an anchor or time a
  `Date` cannot hold, is 400 `VALIDATION`, at `schedule.every`,
  `schedule.anchor` or `schedule.at`. The editor treats both alike: each issue
  is shown on the field its path names, and one on `schedule` itself goes to
  the form's main field (with None, which has none, to a banner). An
  `INVALID_SCHEDULE` with no issues, from an older API, is shown as a banner
  with its detail. The anchor and the one-off time are also checked before
  sending, like every [date-time field](#date-time-fields).
- **Kill** stops one active run, or every one, after you type the runner's
  id. Force skips straight to the end of the kill escalation, and a reason
  (at most 200 characters) is recorded on the run. Without Wait the API
  answers 202 at once ("Kill requested"). With Wait (`wait: true`) it answers
  only once the runs have settled, which can take the runner's
  `closeTimeout` plus `killTimeout`, and the dialog says it is waiting.
- **Reset stats** sets every lifetime counter back to zero, for every
  process. The history is kept.
- **Clear history** removes every finished run, its record and its log,
  and keeps each run still in progress whole; the toast says how many went
  and names any kept ("Cleared 12 runs, kept 1 in progress"). A run counts as
  in progress when this process is running it, when its record says
  `running` and the runner's lock names it, or when its record says
  `running` and it started under a day ago; a crashed run (stuck at
  `running`, no lock, over a day old) is removed. The lifetime counters and
  the charts are untouched: that is Reset stats. It works on a runner
  registered in another process too, since it acts on what the backend
  stores. On such a runner in parallel mode, a live run older than a day
  holds no lock to vouch for it and is removed as well; the confirmation
  says so for that case only.
- **A run's log is a tail, and it says what it is not showing.** It is shown
  in the history row's details, and nowhere else on the screen: the run in
  flight and the last run have cards of their own, but both are rows of the
  history too, so this keeps one log per run. Each read
  asks for the lines above the last sequence number the view has
  (`?since=`, an exclusive bound), and the page is folded into what was read
  before. While the run is live, the view subscribes to `runner/<runner>`
  and reads again whenever a `logs` event arrives for its run: a hint that
  the stored log grew, carrying `{ runId, lastSeq }` and never a line
  (the runner sends at most one per run every half second, plus one as the
  run ends). A hint for another run of the same runner reads nothing, and
  neither does one the view has already caught up with. A poll stays
  underneath as the fallback — every 2 seconds with live updates off,
  relaxed like every other poll while they are on — because a hint is at
  most once: missing one only delays a line until the next read, which,
  being `since` the cursor, still returns it. The hint does not refresh the
  runner's detail, stats or history. A gap in the line numbers is
  where a cap dropped lines, and the run's own `dropped` count is stated
  above the log whatever the stream filter shows ("N earlier lines
  dropped"); `capped` adds that a cap is trimming the log right now. A line
  capture cut at its 8 KiB limit is marked "cut at 8 KiB". The defaults
  behind all of that are 1,000 lines and 1 MiB per run, 8 KiB per line.
  Four outcomes are told apart in the copy, because they mean different
  things: a 409 `LOGS_NOT_RETAINED` ("Run logs are not retained" — this API
  keeps no run logs at all, which is exactly `features.runnerLogs` false), a
  404 `RUN_NOT_FOUND` ("No log for this run" — the runner has no record of
  it: it never ran here, or it has aged out of the runs this runner keeps,
  and the API cannot yet tell those two apart), a 200 with no lines ("This
  run logged nothing"), and a finished run whose record already says
  `logLines: 0`, which offers no log and says the same. Every log also states
  what capture sees and what it never does. A run's console output is
  captured whichever way it runs. A spawned run's piped `stdout` and
  `stderr` are captured, unless a stream was explicitly set to `"inherit"`
  or `"ignore"`. A `worker` or `in-process` run's `console.log`, `info` and
  `debug` (as `stdout`) and `warn` and `error` (as `stderr`) are attributed
  to the run that made them, even with two running at once; a listener the
  run triggers synchronously (a `progress` listener that logs, say) counts
  as the run's too. What escapes, in a worker or in-process run:
  `process.stdout.write`/`process.stderr.write` and `Bun.write` to the
  standard streams; native code writing to file descriptors 1 and 2; a
  program the handler launched with its own stdio; console methods other
  than those five (`console.trace`, `dir`, `table`, …); a console method
  taken before the run began (`const log = console.log` at module load,
  called later); and output from work that outlives the run (a timer
  firing after it settled), which is dropped rather than attributed. The
  note on screen names only the gaps a user will actually hit — native
  code, a program the run launched, direct writes to `process.stdout` and
  `process.stderr` — and ends "is not captured here".
- **Some values are redacted.** Capture scrubs every line before storing
  it, by default: the value of a key whose name contains `password`,
  `passwd`, `pwd`, `secret`, `token`, `apikey`/`api_key`/`api-key`,
  `authorization`, `auth`, `credential`, `cookie`, `session`,
  `private_key` or `access_key`, a bearer token, a JSON Web Token, and the
  password in a URL each become `[REDACTED]`. Matching a key by substring
  deliberately over-hides a few harmless values (`max_tokens=100`,
  `author=…`). The log view says only that some values may be redacted and
  lists none of this: the backend owns those rules.
- **One logical message is not one line.** A spawned run's pretty-printed
  logger arrives as several `stdout` lines, and capture stores them as it
  received them; the view shows them in order, monospaced and wrapped, and
  never tries to join them back together. The same call can come out
  differently by mode: `console.error("x", { n: 1 })` is one line in a
  worker or in-process run, but several from a spawned child, because Bun
  prints the object across lines there. The stream filter is what makes
  such a log readable: `logger` alone is the handler's own narrative
  (its `ctx.log()` lines), and `stdout`/`stderr` are what it printed,
  whichever way it ran. A `log` line's fields are already rendered
  into its text as `key=value`, so there is nothing structured to expand, and
  a line may carry no level at all — a bare `ctx.log("x")` in an
  `in-process` run has none.

### API docs

- **Our own viewer.** The references are screens of this app, rendered from
  the API's OpenAPI 3.1 and AsyncAPI 3.0 documents. No Swagger UI or AsyncAPI
  bundle is loaded, and nothing comes from a CDN.
- **The documents come through the app's client.** `meta.docs` gives full
  paths, which include the API's `basePath`, so each is made relative to
  `apiBase` (`/jobs-api/openapi.json` → `/openapi.json`) and requested like
  any other read, with the same credentials and error handling
  (`app/api/docs.ts`).
- **Try-it sends through the app's client too**, so the CSRF header and the
  `Content-Type` rules apply exactly as they do to the app's own buttons. The
  form is built from the path and query parameters (an enum is a select, an
  enum array is checkboxes, an array is a comma list sent as repeated keys, a
  path parameter is percent-encoded as one segment); header parameters are
  the client's to send. A JSON body starts from the schema's required fields
  (a default, `const` or first enum value where there is one). A mutation's
  panel on a read-only API is disabled with "This API is read-only: it
  refuses every change." That shows only for a stale or foreign OpenAPI
  document: a read-only `createJobsApi` neither routes nor documents its
  mutations, so its own document lists none.
- **The result is the real response.** Try-it sends through the client's
  `requestRaw`, which applies the same header, credential and problem+json
  rules as `request` but resolves the whole response: the status received
  (`201` for an added job, `204` for a removed one), its status text, the
  headers the browser lets the page see (`Set-Cookie` never is), the body,
  and the time from sending to the body having been read. An error status is
  a response too: its problem `code` and banner show above its body. When
  the status is not one the operation documents, a note names the documented
  success status. A network failure shows "No response". A successful
  mutation refetches every query outside the docs, so the rest of the app
  shows what it changed.
- **CSRF, stated per operation.** A mutation's `x-bun-jobs-csrf` is shown:
  the header it must carry and whether the app sends it, and, when the API
  requires it, `Content-Type: application/json` even with no body (415
  otherwise). When the UI's
  `csrfHeader` differs from the one the API asks for, or is unset, try-it
  says the API will refuse it with 403 `CSRF_REJECTED`.
- **Snippets.** Beside the form, `curl` and `fetch()` tabs show the exact
  request the form would send: the same URL under `apiBase`, the client's
  headers (`Accept`, `Content-Type` on `POST`/`PUT`/`PATCH`, the CSRF header
  on mutations) and the body. The `fetch()` call uses
  `credentials: "same-origin"`; the `curl` one notes that the browser also
  sends its cookies.
- **Schema trees.** Parameters, bodies, responses and payloads are expandable
  trees showing each field's name, required marker, type, constraints and
  description. A `$ref` shows its name and expands in place; on the HTTP
  reference the name also opens that schema in a side panel. A `$ref`
  already open above a node is marked `recursive` and not expanded again, so
  a cyclic schema renders finitely. `additionalProperties: false` reads "No
  other fields: any field not listed is refused."
- **The WebSocket reference's panels** come from the document's extensions:
  Limits from `x-bun-jobs-limits` (with the replay setting in words), Close
  codes from `x-bun-jobs-close-codes`, and Upgrade refusals from
  `x-bun-jobs-upgrade-refusals`, each with its status, code, content type and
  headers. The refusals panel notes that a browser never sees them: its
  `WebSocket` reports only a close with code 1006.
- **Security notes.** With no security scheme declared, the panel says the
  host's `authorize` decides, on the upgrade (`events.connect`) and on each
  subscription (`events.subscribe`), and that a browser sends its cookies
  with the upgrade. Otherwise it lists the requirements (any one suffices)
  and, per scheme, what a browser cannot send. A requirement naming several
  schemes exists only in `x-bun-jobs-security`, since AsyncAPI 3 lists one
  scheme per requirement; the panel shows that list and says so.
- **Try-it on the socket** opens the Events console. A channel's panel fills
  its address from the fields you type, the job id escaped with the
  contract's `encodeJobId` (as the live client names job channels), and
  links to `/events?channel=<address>`, adding `types` only when the channel
  carries a subset of the types the console offers for it. An event
  message's links to its kind's broad channel (`queues` or `runners`, else
  `all`) with `types=<type>`. The connection channel has no try-it, nor does
  any address that is a socket path rather than a channel name: there is
  nothing to subscribe to.
- **The subprotocol** is read from `x-bun-jobs-subprotocol` (on
  `servers.api`, else the connection channel). An older API that states it
  only in the connection channel's description is read from that prose, and
  a document saying nothing falls back to the client contract's
  `bun-jobs.v1`. The server panel names the source: "from servers.api
  (x-bun-jobs-subprotocol)", "from the connection channel
  (x-bun-jobs-subprotocol)", "from the connection channel's description" or
  "not stated; the client default".
- **Message examples.** Each message's `examples` are shown on its pane:
  name, summary and the frame as JSON, with a button copying it. An event
  example shows its `event.payload` first, highlighted, then the whole frame.
- **Parameter schemas.** A channel parameter's `x-bun-jobs-schema` (AsyncAPI
  3.0 parameters have no `schema` field) is drawn as a schema tree beside its
  description, and try-it holds a queue or runner name to it: a name failing
  its `pattern` or `maxLength` disables "Open in the Events console", with
  the reason. An older API without the extension is held to the client
  contract's name rule instead.

### Refreshing

When the UI manages anything (`sections.manage`), the API has a socket
(`meta.websocket`), the caller holds `events.connect`, and something can
publish events (not `events: "local"` with `publishing: false`), the app
keeps one WebSocket open (subprotocol `bun-jobs.v1`) and each screen
subscribes to the channels it shows. A docs-only UI (`sections.manage`
false) has no live screen, so it opens no socket, and its status is off:
"Live updates are off: this UI shows documentation only", and the badge
reads "Live off". Events
are hints: they are coalesced (about 250 ms) into refetches of the narrowest
queries, and a `gap` refetches everything on its channels. A screen
subscribes only while its own read is allowed, and on the queue, job and
runner screens only once that queue's or runner's own permissions have
answered.

| Screen | Channel | Events | Refetches |
|---|---|---|---|
| Overview | `queues` | every event that moves a job (not `progress`, `duplicate`, `throttled` or `debounced`) | the totals and the queue table |
| Queue list | `queues` | the same | its pages |
| Queue | `queue/<queue>` | the same | the counts and the jobs page; never on `progress` |
| Queue | `queue/<queue>` | `paused`, `resumed`, `drained`, `cleaned`, `retried` | the detail (paused badge, limits) |
| Queue | `queue/<queue>` | `repeatScheduled` | the repeatables |
| Job | `queue/<queue>/job/<id>` | every event but `progress`, `duplicate`, `throttled` | the job, its stack traces, logs and flow children |
| Job | `queue/<queue>/job/<id>` | `progress` | nothing: the value is written into the job on screen |
| Runner list | `runners` | every event | every runner list |
| Runner | `runner/<runner>` | every event | its detail, stats and history |

Every read also polls, at the intervals below while live updates are off
(no socket, refused, or reconnecting), and much slower while they are live,
as a safety net: events are at-most-once. While live, and only while
`meta.publishing` is not `false`, a read's interval becomes
`max(base × 6, 60 s)`, where `base` is its interval below: 5 s and 10 s
become 60 s, 15 s becomes 90 s, 30 s becomes 180 s. A read that is not polling (a
finished job) stays that way. With `publishing: false` the intervals stay at
their base even while connected, since no event would announce a change. The reads no event announces keep
their interval either way: the Overview sparklines, the workers and
throughput panels, a job's logs (a log line publishes nothing) and its flow
children (a child's events are on its own channel).

| What | Interval while not live |
|---|---|
| Overview counts and queue table | 5 s |
| Overview sparklines | 30 s, fetched only once a row scrolls into view |
| Overview Runners and Workers sections | 5 s for the roll-up; 30 s for the visible page's sparklines |
| Overview "Over the range" added-by-state group | 20 s (it counts job records) |
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
permission maps are not polled. Nor are the OpenAPI and AsyncAPI documents:
each is read once and kept for the session (it never goes stale, so focus
does not refetch it either).

The header badge says which it is: `Live`; `Connecting…`; `Reconnecting…`
(a warning, with the reason in its tooltip); or `Polling 5s` when live
updates are off, neutral, or refused, a warning. Its tooltip also gives the
reason, how events reach the API (`meta.events`) and whether producers
publish them (`meta.publishing`). When events are only the API's own process's
(`events: "local"`) or producers do not publish (`publishing: false`), the
badge is a warning in every state and adds `· events: local` or
`· publishing: no`.

### Stack traces

A failure's `stack`, in the failure panel and the failure history, is shown
only when the API sends it. It does that only when you create it with
`createJobsApi({ ..., serialize: { exposeStacks: true } })`, which defaults to
`false`.

### Browser tests

These `data-testid` hooks are stable:

- App: `app-ready` (the frame, once `/meta` and the permissions loaded),
  `bootstrap-loading`, `bootstrap-error`, `live-status` (with `data-state`:
  `off`, `connecting`, `live`, `reconnecting` or `refused`),
  `live-status-announcer` (its polite live region), `not-found`,
  `screen-error` (a screen that crashed), `shortcut-list` (the `?` dialog).
- Overview: `overview`, `state-counts`, `queue-row-<queue>`,
  `queues-truncated`, `jobs-series`, `runners-analytics`,
  `runner-analytics-row-<runner>`, `runners-truncated`, `workers-analytics`,
  `worker-analytics-row-<key>`, `workers-truncated`, `workers-rows-note`, the
  range captions `jobs-range-caption`, `runners-range-caption` and
  `workers-range-caption` (with `data-clamp-reason`), and the not-retained
  notes `jobs-range-not-retained`, `runners-range-not-retained` and
  `workers-range-not-retained`; the "Over the range" tile `range-stat` and
  its added-by-state group `range-stat-added`.
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
- Events: `events-screen`, `events-channel` (the channel watched, as the
  socket names it), `events-types-summary`, `events-types-ignored` (the note
  naming `types` it ignores), `events-rejected` (a channel the server
  refused), `events-count`, `events-held` (while paused), and `event-row`,
  one per row, with `data-type` the event's type, or `gap` on a gap row.
- Runner actions: the buttons sit in a `role="group"` named
  `Runner actions`. Inside it or its dialogs: `runner-remote-hint`,
  `trigger-remote-note`, `kill-waiting`, and `schedule-next-run` in the
  reschedule's success toast.
- API docs: `docs-home`.
- HTTP reference: `http-docs`, `http-servers`, `http-server-url`,
  `http-components`, `http-operation`, `op-path`, `op-permission` (with
  `data-allowed`), `op-mutation`, `op-requires`, `op-csrf`, `op-parameters`,
  `op-body`, `op-responses`.
- HTTP try-it: `tryit`, `tryit-disabled`, `tryit-csrf`, `snippet-curl`,
  `snippet-fetch`, `tryit-result`, `tryit-status`, `tryit-timing`,
  `tryit-documented`, `tryit-headers` (one `data-header="<name>"` row per
  header).
- Schema trees: `schema-closed` ("No other fields").
- WebSocket reference: `ws-docs`, `ws-server-url`, `ws-subprotocol`,
  `ws-subprotocol-source`,
  `ws-security`, `ws-security-conjunctive`, `ws-scheme-<name>`,
  `ws-search-empty`, `ws-group-<title>`, `ws-nav-<slug>` (the shown item
  carries `data-selected`), `ws-main` (its `data-selected` is the shown
  slug), `ws-pane-<slug>`, `ws-channel-address`, `ws-operation-action`,
  `ws-operation-reply`, `ws-message-name`, `ws-event-payload`,
  `ws-message-payload`, `ws-schema`, `ws-permission-<action>` (with
  `data-has`: `true`, `false` or `unknown`), `ws-limit-<name>`,
  `ws-limit-replay`, `ws-close-<code>`, `ws-refusal-<code>`,
  `ws-refusal-1006`, `ws-example`, `ws-example-name`,
  `ws-example-summary`, `ws-example-event-payload`, `ws-example-frame`,
  `ws-parameter-schema-<name>`.
- WebSocket try-it: `ws-try-channel`, `ws-try-address`, `ws-try-link`,
  `ws-try-unavailable`, `ws-try-disabled`, `ws-try-reason`.

`__tests__/e2e/m2-flow.e2e.test.ts` drives the real app in headless Chrome
through `Bun.WebView`, against a real `createJobsApi` with CSRF on. It pauses a
queue, opens a dead job and retries it, reads each step back from the API and
checks that the page raised no CSP violation. It skips visibly when Chrome is
not found. Set `BUN_CHROME_PATH` to point it at one.

The runner screens' Chrome flow is in the examples:
`examples/bun-jobs-ui/06-browser/pause-and-retry.ts` pauses a runner and
checks "Runner hidden" in Chrome. Live events have theirs in
`examples/bun-jobs-ui/06-browser/live-events.ts`: the `live-status` badge,
the Events console tailing a queue while a real worker completes a job, and
the badge staying off, with its reason, on hosts that cannot or may not
connect. The API docs screens have theirs in
`examples/bun-jobs-ui/06-browser/api-docs.ts`: both references in real
Chrome, try-it on the HTTP and WebSocket sides (a disabled one with its
reason, a destructive one that needs its id typed), the WebSocket panels and
"Open in the Events console".
`__tests__/app/pkg/runners.integration.test.ts` and
`runner-actions.integration.test.ts` render them under happy-dom against a
real `createJobsApi` in `runner` mode with a real local `BunRunner`.

### Loaded on demand

The Overview ships in the entry bundle, except its Runners and Workers
sections: they are one split chunk, fetched only when a section may render,
so a deployment recording no runner or worker analytics never loads it. The
"Over the range" tile's added-by-state group is a chunk of its own, fetched
only where `features.addedByState` is true. The queue screen's Job defaults
panel, with its two dialogs, is a chunk of its own too, fetched only when
that tab is opened. The queue, job, runner and worker screens, the
Events console and the API docs are split chunks, fetched the first time one
is opened (a labelled spinner shows meanwhile) and served from the same
assets path, which the CSP's `script-src 'self'` allows. Styles are not split
the same way: Bun's entry stylesheet carries every rule, the lazily loaded
screens' included, so the shell links only that one and never a chunk's
stylesheet, which would repeat its rules (`entryStylesheets` in
`lib/assets.ts`).

The API docs are one chunk for `/docs`, the HTTP reference and the WebSocket
reference together, with the schema tree they share: 62.7 KiB (19.9 KiB
gzipped) when M5 was built.

### Accessibility

- **Keyboard.** A "Skip to content" link leads to the main landmark. `/`
  focuses the screen's search box (Overview, Queues, a queue's jobs,
  Runners, both API references), and `?` lists the shortcuts. Neither fires
  while you type in a field, with Ctrl, Meta or Alt held, or while a dialog
  is open. Tabs move with ←/→/Home/End, the API docs sidebars with
  ↑/↓/Home/End (↓ from their search box), and dialogs keep focus inside
  until they close, then hand it back.
- **Announcements.** Toasts speak through polite (errors: assertive) live
  regions, loading states are `role="status"`, and the live badge's state
  is announced politely on a change of state only, never on the first
  render or a new tooltip.
- **Recovery.** Each routed screen sits in an error boundary: a render
  crash, or a screen chunk that failed to load, shows "Reload this screen"
  in its place while the header and nav keep working. Reloading re-reads
  the screen's data rather than rendering the cached answer again, so a
  crash caused by a bad response recovers once the API answers well;
  `/meta` and the permissions are kept, so the rest of the app does not
  flash. The job, queue and runner detail reads also check the response's
  shape, so a body that is not a job, queue or runner shows the screen's
  error state, with Retry, rather than an empty screen.
- **Reduced motion.** With `prefers-reduced-motion: reduce`, no transition or
  animation runs, except the spinner, which keeps turning slowly so it still
  reads as busy.
- **Contrast.** Every colour pair in `app/styles/tokens.css` meets WCAG AA
  in both themes: 4.5:1 for text, 3:1 for input outlines, the focus ring and
  state colours. `__tests__/app/a11y/contrast.test.ts` reads the real file,
  so a token that stops reading fails the tests.
- **Checked.** `__tests__/app/pkg/a11y.integration.test.ts` renders every
  screen against a real API and audits its structure: one `h1`, no skipped
  heading level, the landmarks, a name on every control, button, link and
  table. `__tests__/e2e/responsive.e2e.test.ts` loads the screens in Chrome
  at 360px and fails if the page scrolls sideways. Wide tables scroll inside
  their own region instead.

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

`bun run build:types` (`scripts/build-declarations.ts`) writes the declarations
for `lib/` into `dts/`, and verifies them. `prepack` runs it too, after the
bundle, so a pack publishes both. `dts/` is gitignored as well: `dist/` is the
browser bundle, `dts/` the server's types.
