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
the runner screens in M3, live updates and the Events console in M4, and the
API docs in M5.

| Route | What it shows |
|---|---|
| `/` | The Overview: namespace-wide counts per state (`GET /overview`) and a filterable queue table, with a 60-minute throughput sparkline per row. When the caller has no Overview entry, `/` redirects to the first nav entry, or says there is nothing to show. |
| `/queues` | Every queue, searchable by name (case-insensitive) and paged. Each row links to its queue. |
| `/queues/:queue` | The queue's header (paused badge, job total, last update), its actions, the jobs table (a tab per state, filters, paging, bulk actions) and the detail panels: limits, workers, throughput and repeatables. |
| `/queues/:queue/jobs/:id` | One job: its summary, the failure with its cause chain and the failure history, data, return value, flow parent and children, logs and options, with Retry, Promote, Fail…, Remove and Edit. |
| `/runners` | Every runner in the namespace (`GET /runners`): local ones first, with their name and status, then remote ones by id. Filtered by id or name in the browser, with no paging. Each row links to its runner. |
| `/runners/:runner` | One runner: its status badges, its actions, a summary (schedule, next run, execution and run mode, queueing, concurrency, the run holding its lock, the last error), the lifetime counters, the runs in flight in this process, the last run and the run history. |
| `/events` | The Events console: a live tail of the API's socket. Pick a channel (`all` in mode `both`, `queues`, one queue from the queue list, one job by queue and id, `runners`, or one runner from the runner list) and filter by event type. Rows show the time, kind and type, the target (linked to its queue or runner), the id (a job links to its screen) and the payload. The log keeps the latest 500 rows, newest first; Pause holds up to 500 more (the rest are counted as dropped) until Resume, and Clear empties it. A channel the server refuses shows its code and reason, and a `gap` shows inline as `gap: <reason>`. When the log is empty it says why: producers not publishing, `events: "local"`, or live updates off. |
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
characters, trimmed, recorded as the job's failure), and the job's id must be
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
| `/events` | `channel` | The channel, as the socket names it: `all`, `queues`, `queue/<queue>`, `queue/<queue>/job/<encoded id>`, `runners` or `runner/<runner>`. One the API's mode lacks, or a malformed one, falls back to `all` in mode `both`, else `queues` or `runners`. |
| `/events` | `types` | Event types as a comma list, e.g. `completed,failed`. A name may carry its family, `queue.completed` or `runner.failed`, and is rewritten bare in the URL; a prefixed name counts only on a channel carrying that family. An unknown name, or one the channel cannot carry, is ignored and named in a note above the log, and stays in the URL so the note survives a reload; if nothing is left, every type shows. Absent means every type. |
| `/docs/http` | `q` | Filters the sidebar, as you type: every whitespace-separated word must appear, ignoring case, in an operation's method, path, operationId, summary or action. Operation links keep it. The tag overview is not filtered. |
| `/docs/ws` | `q` | Filters the sidebar the same way, over each item's slug, label and hint and its keywords (a channel's address and parameters, an operation's permission, the limit names, the close codes, the refusal statuses and codes). The sidebar's links keep it. |

On the queue screen, changing `state`, `name`, `search` or `order` resets
`offset` and clears the selection.

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
read of the runner waits for that answer too. Because the lists depend on the
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
| Events nav entry and `/events` | `sections.manage`, `meta.websocket`, and `events.connect` (untargeted) |
| Events queue and job channel pickers' queue list | `meta.mode` `jobs` or `both` (the queue and job channels exist only there), and `queues.list` (untargeted); without it, a text box |
| Events runner channel picker's runner list | `meta.mode` `runner` or `both` (the runner channel exists only there), and `runners.list` (untargeted); without it, a text box |
| API docs nav entry and every `/docs*` route | `sections.docs`, `meta.docs` (the API routes its docs), and `docs.read` (untargeted); `sections.manage` is not needed |
| HTTP reference (`/docs/http*`) and its card on `/docs` | `meta.docs.openapi`, which the API sends whenever `meta.docs` is set |
| WebSocket reference (`/docs/ws*`) and its card on `/docs` | `meta.docs.asyncapi`; without it, `/docs/ws` shows "This API has no live-events socket" and `/docs` shows no WebSocket card |
| HTTP operation's permission marker, "You have" / "You lack" | the operation's `x-bun-jobs-action`, looked up in the untargeted map |
| WebSocket channel's and operation's permission markers, "You have this" / "You lack this" | the operation's `x-bun-jobs-action`, looked up in the untargeted map; one the UI does not know shows "Not an action this UI knows" |
| HTTP try-it Send | the method is `GET`, `POST`, `PUT`, `PATCH` or `DELETE`; `meta.readOnly` false for a mutation (`x-bun-jobs-mutation`); and the operation's `x-bun-jobs-action` (untargeted), reads included. Otherwise the panel is disabled, with the reason shown |
| HTTP try-it confirmation | every mutation asks first; a `DELETE`, or an action whose verb is `remove`, `drain`, `clean`, `kill` or `fail`, needs its operationId typed |
| WebSocket try-it, "Open in the Events console" | the Events nav entry: `sections.manage`, `meta.websocket` and `events.connect` (untargeted); otherwise a note says the console is not available. A channel's link also needs each parameter filled and passing the document's `x-bun-jobs-schema` (for an older API without it, the client's name rule), and a channel `meta.mode` offers; a parameter that fails disables the link, with the reason shown. The connection channel has no try-it: there is nothing to subscribe to |
| Job Fail… | mutation `jobs.fail`, and the job is not `completed` or `dead` |
| Repeatables panel, Disable / Enable | `repeatables.list`, and mutation `repeatables.disable` / `repeatables.enable`: Disable shows on an enabled series, Enable on a disabled one |

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
  authority. Its 400 `INVALID_SCHEDULE` names the part at fault in
  `issues[].path`, and each issue is shown on that field: `schedule.cron`,
  `schedule.tz`, `schedule.every`, `schedule.anchor` or `schedule.at`. An
  issue on `schedule` itself goes to the form's main field (with None, which
  has none, to a banner). An `INVALID_SCHEDULE` with no issues, from an older
  API, is shown as a banner with its detail.
- **Kill** stops one active run, or every one, after you type the runner's
  id. Force skips straight to the end of the kill escalation, and a reason
  (at most 200 characters) is recorded on the run. Without Wait the API
  answers 202 at once ("Kill requested"). With Wait (`wait: true`) it answers
  only once the runs have settled, which can take the runner's
  `closeTimeout` plus `killTimeout`, and the dialog says it is waiting.
- **Reset stats** sets every lifetime counter back to zero, for every
  process. The history is kept.

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
  `off`, `connecting`, `live`, `reconnecting` or `refused`), `not-found`.
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

The Overview ships in the entry bundle. The queue, job and runner screens, the
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
