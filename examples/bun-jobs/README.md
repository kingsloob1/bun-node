# `@kingsleyweb/bun-jobs` examples

Runnable examples for [`@kingsleyweb/bun-jobs`](../../packages/bun-jobs):
background work for Bun — a **queue** for many small jobs across processes and
services, and a **runner** for one file on a schedule or on demand — over
memory, file, SQLite, Postgres, MySQL, MariaDB, MongoDB and Redis.

Each file is a script. Its opening comment says what it shows and how to run
it; its output narrates what happened, with timings.

```bash
cd examples/bun-jobs
bun 01-quick-start/index.ts        # start here
bun run-all.ts                     # every example; prints ok / skip / FAIL
bun run-all.ts 05 06               # only folders 05-* and 06-*
```

No install step: the examples use the workspace packages through the repo's
root `node_modules` (run `bun install` at the root once). Dates in words need
`chrono-node`, which the workspace already has.

## Choosing a backend

Examples that are not about one particular backend read `EXAMPLE_DRIVER`, so
the same script runs on any of them:

```bash
bun 02-queues/job-options.ts                                   # memory (default)
EXAMPLE_DRIVER=file   bun 02-queues/job-options.ts             # a temp directory
EXAMPLE_DRIVER=sqlite bun 02-queues/job-options.ts             # a temp SQLite file
EXAMPLE_DRIVER=redis  EXAMPLE_REDIS_URL=redis://localhost:6379/13 bun 02-queues/job-options.ts
EXAMPLE_DRIVER=postgres EXAMPLE_POSTGRES_URL=postgres://user:pass@localhost/jobs bun run-all.ts
```

| `EXAMPLE_DRIVER` | Needs |
|---|---|
| `memory` (default) | nothing |
| `file`, `sqlite` | nothing — a temporary directory, removed on exit |
| `postgres`, `mysql`, `mariadb` | `EXAMPLE_POSTGRES_URL` / `EXAMPLE_MYSQL_URL` / `EXAMPLE_MARIADB_URL` |
| `redis` | `EXAMPLE_REDIS_URL` |
| `mongodb` | `EXAMPLE_MONGODB_URL`, and `bun add mongodb` |

`bun scripts/setup-databases.ts` at the repo root installs local servers.
Each run uses its own namespace and purges it on the way out, so pointing the
examples at a shared development database leaves nothing behind but the (empty)
tables. Examples that spawn a second process swap the in-process memory
driver for a temporary SQLite file, since memory cannot be shared.

## The examples

### 01 — Quick start

| File | Shows |
|---|---|
| [`index.ts`](./01-quick-start/index.ts) | `BunJobs`: define a job, add it now and in words, process it, read its log, shut down |

### 02 — Queues and workers

| File | Shows |
|---|---|
| [`producer-and-worker.ts`](./02-queues/producer-and-worker.ts) | `BunQueue` and `BunQueueWorker` directly, typed payloads and results, progress, shutdown |
| [`job-options.ts`](./02-queues/job-options.ts) | priority, `delay` / `runAt`, attempts and backoff, per-attempt `timeout`, `jobId` idempotency, retention |
| [`job-lifecycle.ts`](./02-queues/job-lifecycle.ts) | `updateData`, `setPriority`, `reschedule`, `promote`, progress, job logs, retrying a dead job, `remove` |
| [`events.ts`](./02-queues/events.ts) | every queue and worker event, name-scoped events (`completed:refund`), watching another process with `subscribe` / `publish` |
| [`bulk-and-management.ts`](./02-queues/bulk-and-management.ts) | `addBulk`, `count`, `list`, `update`, cluster-wide `pause` / `resume`, `drain`, `clean` |
| [`searching-and-paging.ts`](./02-queues/searching-and-paging.ts) | `list` narrowed by `name` and `search`, `page` with the total a paginated table needs, `getJobs` by id |
| [`workers-and-throughput.ts`](./02-queues/workers-and-throughput.ts) | `listWorkers` and `reportInterval`, `getThroughput` a minute at a time, `getQueueSummaries`, printed as a dashboard |
| [`isolated-processors.ts`](./02-queues/isolated-processors.ts) | a processor **file** run `in-process`, in a `Worker` and in a child process; a runaway processor stopped by its timeout; `defineProcessor` |

### 03 — The job registry

| File | Shows |
|---|---|
| [`define-and-run.ts`](./03-job-registry/define-and-run.ts) | `define` with defaults, `now`, `run().in()`, `process().on()`, `schedule().every().limit()` |
| [`builder-with-options.ts`](./03-job-registry/builder-with-options.ts) | the full builder chain, `withOptions()` for schedules stored as data, what is refused and why, a time zone the runtime does not know among it |
| [`per-name-concurrency.ts`](./03-job-registry/per-name-concurrency.ts) | `define(..., { concurrency })` enforced across two service instances |
| [`jobs-create.ts`](./03-job-registry/jobs-create.ts) | `jobs.create()` drafts: setters, `save()`, saving once (a repeat save, racing saves, a setter after a save), `unique` across drafts, repeating and debounced drafts, a failed save corrected |
| [`process-every.ts`](./03-job-registry/process-every.ts) | `processEvery` as an option and a method: on a running worker, against `start()`'s own options, while paused; a worker's `pollInterval` / `maxBlock` at runtime; what is refused |
| [`typed-registry.ts`](./03-job-registry/typed-registry.ts) | `new BunJobs<Jobs>()` with a declared name → `{ data; result? }` map: `define` / `now` / `schedule().every()` / `create` and the registry queue's `add` checked at compile time (`now`, `add`, a builder's `start()` and a draft's `save()` answering with a `TypedJob` of the name given, which builders and drafts carry as a third type argument), a payload required unless `data: void`, reads (`getJob` / `list` / `page` / `getJobs`) as a `TypedJob` narrowed by `job.name`, `start()`'s typed worker and scoped events (`completed:generate-invoice`), `definitions()`, the `queue<Payload>()` and `add<"audit", Payload>()` escape hatches, the untyped path unchanged — each negative case a live `@ts-expect-error` |
| [`typed-registry-verbs.ts`](./03-job-registry/typed-registry-verbs.ts) | the registry queue's other verbs under a job map: `addBulk` checked per entry and answering with a tuple of per-entry `TypedJob`s (a prebuilt array with `TypedJob<Jobs>[]`), `addFlow` checked at the top and down every registry-queue branch (a child with its own `queue` unchecked) with `flow.job` typed by the top name, `retryAll`'s `name` narrowing `filter`, `update`'s every-payload rule (spelled flattened, `{ month; userId } & void`) and the ways round it (a narrowed job's `updateData`, the untyped view); literal results typed from the map with no annotation (and the `async` bare-literal `as const` exception); a registry queue of its own with `BunJobs<Jobs, "work">`; union names; the untyped verbs unchanged |

### 04 — Scheduling

| File | Shows |
|---|---|
| [`repeatable-jobs.ts`](./04-scheduling/repeatable-jobs.ts) | `repeat`: intervals, six-field cron, `startAt` / `endAt`, `limit`, keys, `listRepeatables`, `removeRepeatable` |
| [`human-schedules.ts`](./04-scheduling/human-schedules.ts) | "tomorrow at 9am", "every 2 weeks starting next monday", "every day from tomorrow until next month" |
| [`custom-date-parser.ts`](./04-scheduling/custom-date-parser.ts) | a `DateParser` that teaches schedules "payday" and "month end" |
| [`cron-helpers.ts`](./04-scheduling/cron-helpers.ts) | `validateCron`, `parseCron`, `nextCronDate` across time zones, `normalizeSchedule`, `nextFireDate` |

### 05 — Flow control

| File | Shows |
|---|---|
| [`debounce.ts`](./05-flow-control/debounce.ts) | many adds → one job with the latest data; `cleanWindows` |
| [`throttle.ts`](./05-flow-control/throttle.ts) | at most one job per id per window |
| [`rate-and-concurrency-limits.ts`](./05-flow-control/rate-and-concurrency-limits.ts) | `setLimits`: a queue-wide rate and concurrency, a per-name cap, enforced by two workers, lifted live |

### 06 — Failures

| File | Shows |
|---|---|
| [`retries-and-backoff.ts`](./06-failures/retries-and-backoff.ts) | every built-in backoff, measured; a custom `defineBackoff` honouring retry-after and giving up |
| [`unrecoverable-errors.ts`](./06-failures/unrecoverable-errors.ts) | `UnrecoverableJobError`: dead now, attempts left or not |
| [`dead-letter-queue.ts`](./06-failures/dead-letter-queue.ts) | `deadLetterQueue` / `deadLetter`, a consumer for `DeadLetter`s, re-driving with `retryAll` |
| [`timeouts-and-cancellation.ts`](./06-failures/timeouts-and-cancellation.ts) | `ctx.signal`, graceful `close`, a consumer process killed with `SIGKILL` and its job recovered as stalled |

### 07 — The runner

| File | Shows |
|---|---|
| [`scheduled-runner.ts`](./07-runner/scheduled-runner.ts) | `BunRunner` on an interval, then cron; events, `history`, `stats`, `info` |
| [`manual-trigger.ts`](./07-runner/manual-trigger.ts) | `trigger()` outcomes: started, queued, skipped; `single` vs `parallel`; pause and `force` |
| [`execution-modes.ts`](./07-runner/execution-modes.ts) | one handler in `in-process`, `worker` and `spawn`, with what differs |
| [`single-run-lock.ts`](./07-runner/single-run-lock.ts) | three instances of one runner: one runs, one skips, one queues for the lock holder |
| [`messages-progress-kill.ts`](./07-runner/messages-progress-kill.ts) | progress, logs and messages across a process boundary; `kill`; run timeouts |
| [`runner-enqueues-jobs.ts`](./07-runner/runner-enqueues-jobs.ts) | a spawned runner fanning work out as queue jobs with `jobsFromContext` |
| [`manager.ts`](./07-runner/manager.ts) | `jobs.runners`: `startAll`, `info`, state shared by a second instance, `remove` |
| [`remote-control.ts`](./07-runner/remote-control.ts) | `remote(id)` from a process that registered nothing: pause, reschedule, resume and trigger a runner another **process** owns ([`helpers/runner-owner.ts`](./07-runner/helpers/runner-owner.ts)); `info`, `history`, `stats`; no remote kill |
| [`handlers/`](./07-runner/handlers) | the handler files the runners run, each written with `defineHandler` |

### 08 — Drivers

| File | Shows |
|---|---|
| [`choosing-a-driver.ts`](./08-drivers/choosing-a-driver.ts) | every config shape (URL or fields), capabilities, one workload on each backend available |
| [`sqlite-and-schema-sync.ts`](./08-drivers/sqlite-and-schema-sync.ts) | `SqlDriver` on SQLite, `tablePrefix`, and `syncSchema` repairing a drifted schema |
| [`postgres-and-mysql.ts`](./08-drivers/postgres-and-mysql.ts) | Postgres / MySQL / MariaDB via `Bun.sql`, connection fields, `NOTIFY` wake-ups — needs a URL |
| [`redis.ts`](./08-drivers/redis.ts) | blocking waits (sub-millisecond pick-up), pushed events, the key layout — needs a URL |
| [`mongodb.ts`](./08-drivers/mongodb.ts) | `MongoDriver`, competing workers, index sync — needs a URL |
| [`cross-process/main.ts`](./08-drivers/cross-process/main.ts) | two producer and three consumer **processes**; every job exactly once; `SIGTERM` shutdown |

### 09 — Integrations

| File | Shows |
|---|---|
| [`http-api.ts`](./09-integrations/http-api.ts) | a `202 Accepted` + status-URL API with bun-common's `BunHttpAdapter` (`--listen` to serve it) |
| [`logging.ts`](./09-integrations/logging.ts) | structured logs with bound job fields; a sink function; plugging in pino, winston or console |
| [`graceful-shutdown.ts`](./09-integrations/graceful-shutdown.ts) | `SIGTERM` / `SIGINT` handling for a worker service |
| [`namespaces.ts`](./09-integrations/namespaces.ts) | two services on one backend with identical queue names and job ids, isolated |
| [`live-dashboard.ts`](./09-integrations/live-dashboard.ts) | `JobsNotifier`: one live stream of every job and runner event in a namespace, from any process; `publishEvents` |

### 10 — Option tours

The examples above *show* behaviour. A tour **asserts** it: each one sets
every option of one part of the API and checks what happens, using
[`shared/check.ts`](./shared/check.ts). A failed check prints what was expected
and what happened and fails the script, so `bun run-all.ts` doubles as a test
of every option on whichever backend `EXAMPLE_DRIVER` names.

| File | Covers |
|---|---|
| [`job-options.ts`](./10-options/job-options.ts) | every `JobOptions`, `RepeatOptions` and `DebounceOptions` field, retention forms, every backoff form; a `repeat.tz` the runtime does not know (or `""`) refused before anything is written |
| [`queue-options.ts`](./10-options/queue-options.ts) | every `BunQueueOptions` field, every `BunQueue` method and option, every queue event — a single `retry()` emits one `retried` with `[id]`, one that changed nothing emits none |
| [`worker-options.ts`](./10-options/worker-options.ts) | every `BunQueueWorkerOptions` field, every worker method and event, the `ProcessorContext` and in-flight `Job` |
| [`worker-isolation.ts`](./10-options/worker-isolation.ts) | `isolation` and `isolationOptions` in each mode, what works inside an isolated job and what does not (`schedule`, `update`, `disable` and `enable` included); `job.fail()` in a child process and a `Worker`, reported when the attempt settles |
| [`job-methods.ts`](./10-options/job-methods.ts) | `job.fail()` inside a processor (dead whatever attempts are left, the reason winning over a later throw, the job's `deadLetter`, no `cause` for a string and the `Error` as the cause) and from outside (a pending job buried at once; an active one buried under its lock, its worker aborting at its next heartbeat, `failed` and `dead` exactly once, locally and published, filed only in its own `deadLetter`); `schedule()`, `update()` with each field and `onlyIn`, `this \| null` for a job that is gone; `disable()` / `enable()` on an occurrence and a `ConfigError` on a one-off; `disableRepeatable()` / `enableRepeatable()` — `listRepeatables()` `disabled`, the pending occurrence removed, the one in flight finishing, maintenance sweeping, enable scheduling from now with no backfill, `add({ repeat })` not re-enabling, `removeRepeatable()` clearing the flag; `remove()` / `promote()` / `retry()` emitting and publishing; `progress` as `RunProgress \| null`; `extendLock()` / `touch()` only from the processor's view |
| [`runner-options.ts`](./10-options/runner-options.ts) | every `BunRunnerOptions` field, `RunContext`, every runner method and event, `BunRunnerManager` and `remote()` |
| [`bunjobs-options.ts`](./10-options/bunjobs-options.ts) | every `BunJobsOptions` field and `BunJobs` method, `jobsFromContext` |
| [`draft-and-process-every.ts`](./10-options/draft-and-process-every.ts) | every `JobDraft` member and `RepeatEveryOptions` field, the series setters (`limit`, `tz`, `endingAt`, `catchUp`, `immediately`), their guard (on `JobBuilder.limit()` too) and the values they refuse, a time zone checked however it is given (`tz()`, `repeatEvery(…, { tz })`, `withOptions({ repeat })`, `""` refused), date phrases read at `save()`, precedence, saving twice, refused combinations; `processEvery` (option and method), `processEveryMs`, and a worker's runtime `pollInterval` / `maxBlock`: limits, precedence, waits in progress per driver, the promotion sweep, pause, a failed `run()`, Redis `maxBlockSeconds` |
| [`read-apis.ts`](./10-options/read-apis.ts) | every `ListJobsOptions` field; `search` taken literally and folded for case per engine; `page` totals; `getJobs` order, gaps and repeats; `listWorkers` fields, `reportInterval` and a lapsed record; `getThroughput` bounds, buckets and retried failures; `getQueueSummaries`; each driver fallback |
| [`notifier.ts`](./10-options/notifier.ts) | every `JobsNotifierOptions` field and member — `hold()` / `unfollow()` reference-counted and `following` listing only live subscriptions among them — every published queue and runner event and its payload, `retried` from a single `retry()` included |
| [`driver-options.ts`](./10-options/driver-options.ts) | every option of every driver and connection helper; the JSON-safe options a `DriverConfig` carries (`pollInterval`, `eventRetentionMs`, `maxBlockSeconds`, `clientOptions`), checked after a trip through JSON; each driver's `capabilities`; reading an unknown runner (or peeking or popping its empty trigger queue) registers nothing; `peekQueuedTrigger` returns the head a pop takes next, `force` included, without removing it; a queued trigger's `force`; a Redis wake an abandoned wait took; server sections run when their URL is set |
| [`errors.ts`](./10-options/errors.ts) | every error class, triggered through the public API, with its `code` and fields; `NotSupportedError` from every feature that needs a missing driver method, its `needs` naming the call (`update()`, `add({ debounce })`, `fail()`, `disable()`, …); `UnrecoverableJobError`'s `{ cause }` option, and the cause surviving storage |
| [`ids-and-keys.ts`](./10-options/ids-and-keys.ts) | what an id may be (`jobId`, flow children, debounce / throttle ids, repeat keys) at every entry point, a lone surrogate included; ids that round-trip; derived ids fitted in bytes and characters, not refused; repeat keys stored as `k:<key>`, shown bare, at most 189 characters, and never merged when long; `removeRepeatable()` preferring the series listed as the key; the file driver refusing a too-wide id or state name before writing; the reserved `__win:` state prefix and its unforgeable token; a debounce pointer confirmed once its job exists, under racing sweeps; MySQL / MariaDB refusing a namespace or queue name over 191 characters |
| [`utilities.ts`](./10-options/utilities.ts) | every exported helper: cron, schedules, repeats, options, backoff, JSON, ids (`assertJobId`, `shortenJobId`, `displayRepeatKey`), keys, reserved state names, connection, constants |
| [`jobs-api-options.ts`](./10-options/jobs-api-options.ts) | every `createJobsApi` option: each `ConfigError` it refuses construction with, `mode` / `readOnly` / `actions` (an allow-list: naming only the two opt-ins turns everything else off) / driver-capability pruning cross-checked against `/meta` and `/meta/permissions`, RFC 9457 problems, `authorize` asked exactly once (and untargeted first), `limits`, `cors` / `csrf` / `trustProxy`, `serialize`, `addableNames`, `runnerTriggerArgs`, `validateResponses`, `docs`, and what a client is told: `/meta` `csrf` / `limits` (with the derived `defaultClean` and `maxRetryAllIds`) / `addableNames` / `runnerTriggerArgs` / `websocket.port`, `api.info`, `/meta/permissions?channel=` (its `key` whenever the channel parsed, refused or not), `POST /queues/:queue/jobs` creating a new queue (and still 403 for a name that is not addable, 404 outside a configured `queues` list), a stale `queueCacheMs` cache re-checked once per window before a 404, `/queues` paging and case-insensitive search, `/overview` `throughputSeries`, the 191 / 1024 job-id caps, 400 `INVALID_ARGUMENT` for an id `assertJobId` refuses (a control character, a leading `.`, a lone surrogate), `/meta` `publishing` (true / false) and the socket warning given only when it is false, the CSRF header and JSON rule in the OpenAPI document, the contract's constants; the fail, disable and enable routes by name (default-on mutations of the jobs half), `POST …/jobs/:id/fail` (200, 409, 404, 400, an active job with `failed` and `dead` published exactly once), `POST …/repeatables/:key/disable` and `…/enable` (idempotent, 404 for an unknown key) and `RepeatableDto.disabled`; `/meta/permissions` costing N + 1 `authorize` calls (N + 2 with a `channel`), each preview carrying the `ctx.route` its real request carries (so a route-based `authorize` answers the map as it answers the request) and `PermissionsDto.actions` typed `Partial<Record<JobsApiAction, boolean>>` (a compile-time check); `listQueues: "authorized"` hiding denied queues from `/queues` (paging counts only what is shown) and `/overview`, one `queues.read` per queue, a 500 for a throwing `authorize`, and the `ConfigError` without `queues.read`; `GET /runners` items' `isLocal` / `isPaused` / `isRunning` for local and remote runners (matching each runner's own read), lifecycle `status` (`idle` = not started, `running` = armed, not a run in flight), and `local` as a copy of `isLocal`, `deprecated: true` in the OpenAPI document and `@deprecated` in the contract; `PUT /runners/:runner/schedule` 400 `INVALID_SCHEDULE` `issues` naming `schedule`, `schedule.cron`, `schedule.tz` or `schedule.at` (a bad cron before a bad zone) |
| [`jobs-api-socket-options.ts`](./10-options/jobs-api-socket-options.ts) | every `websocket` option, subprotocol negotiation on the attached, dedicated and raw `Bun.serve` paths, per-channel subscribe refusals echoing the client's spelling, the cap applied before `authorize`, 256 channels per frame, broad channels authorized per queue, lone-surrogate job ids (`%uXXXX`, via the contract's `encodeJobId` / `decodeJobId`; a new job with one refused), last-subscribe-wins, `seq` / `epoch`, replay and resume (never an event twice for one channel, ahead of the server, while lagging), a resume split over two `subscribe`s (the same `seq` twice, never for the same channel; each replayed event listing only the newly covered channels; why a dropped connection resumes from the same position until every resuming `subscribe` is acked; an ack waiting for replayed events held behind a per-target `authorize`), both `gap` reasons, coalesced progress, the client limits, every documented close code, the AsyncAPI extensions, and a compile-time check that the root's socket frame types are the contract's own |

### 11 — The management API

| File | Shows |
|---|---|
| [`mounting-and-auth.ts`](./11-management-api/mounting-and-auth.ts) | mounting on a `BunHttpAdapter`, an `authorize` hook with roles, a walk through the queue, job (a new queue created by its first job), repeatable, worker and throughput routes, and `close()` |
| [`live-events.ts`](./11-management-api/live-events.ts) | the socket: subscribing to several channels, `seq` / `epoch`, resuming from the replay ring, and two deliberate `gap`s |
| [`live-events-delivery.ts`](./11-management-api/live-events-delivery.ts) | what the socket delivers, on any backend: the first events of a queue or runner nothing has discovered, `retried` / `cleaned` on each job's channel, and `all` / `queues` / `runners` hiding a queue or runner the host denies |
| [`typed-client.ts`](./11-management-api/typed-client.ts) | a client written against `@kingsleyweb/bun-jobs/api/contract` alone: configured by `/meta` (CSRF header, addable names, page size, the socket), paging queues, adding a queue's first job, previewing a channel before subscribing, a lone-surrogate job id's channel built with `encodeJobId` and read back with `decodeJobId`, and a browser build proving the contract brings none of the server |
| [`openapi-and-docs.ts`](./11-management-api/openapi-and-docs.ts) | `openapi()` / `asyncapi()` and their endpoints, `docs.ui` off and on, and how a pruned API documents less |
| [`helpers/jobs-socket.ts`](./11-management-api/helpers/jobs-socket.ts) | the typed socket client those examples and the socket tour use |
| [`helpers/contract-client.ts`](./11-management-api/helpers/contract-client.ts) | the browser-safe client `typed-client.ts` drives, importing only the contract, with `jobChannel` / `jobOfChannel` for job channel names |

## Checking the examples

The examples are a project of their own, held to the same bar as the packages:

```bash
bun scripts/typecheck.ts        # from the repo root — includes examples/bun-jobs
cd examples/bun-jobs
bunx eslint .                   # the package's lint rules, minus no-console
bun run-all.ts                  # run them all
```

`shared/` holds the two helpers every example uses: `backend.ts` (picking a
driver from `EXAMPLE_DRIVER`) and `console.ts` (printing, and waiting on a
condition instead of sleeping).
