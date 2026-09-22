/**
 * The management API's constants: action names, protocol versions, the
 * socket's subprotocol and close codes, job states and event names — and the
 * two pure functions a client needs to name a job channel, `encodeJobId` and
 * `decodeJobId`.
 *
 * **Browser-safe by construction.** This file imports nothing at all, so a
 * client (a React management UI, a CLI) can bundle it without pulling in a
 * driver, bun-common or any `node:*` / `bun:*` module. The server modules
 * import these values from here rather than declaring their own, so there is
 * exactly one definition of each. `__tests__/api/api-contract.test.ts` holds
 * the import graph to that promise.
 */

/** The API protocol version, reported by `/meta` and the socket's `hello`. */
export const JOBS_API_PROTOCOL_VERSION = 1 as const;

/** Every action `authorize` can be asked about. The list is the source of truth for specs and pruning. */
export const JOBS_API_ACTIONS = [
  "meta.read",
  "docs.read",
  "queues.list",
  "queues.read",
  "queues.pause",
  "queues.resume",
  "queues.drain",
  "queues.clean",
  "queues.limits",
  "queues.defaults",
  "queues.applyDefaults",
  "metrics.read",
  "workers.list",
  "workers.read",
  "workers.pause",
  "workers.resume",
  "workers.stop",
  "workers.start",
  "workers.configure",
  "jobs.list",
  "jobs.read",
  "jobs.logs",
  "jobs.add",
  "jobs.update",
  "jobs.retry",
  "jobs.retryAll",
  "jobs.remove",
  "jobs.clearLogs",
  "jobs.promote",
  "jobs.fail",
  "repeatables.list",
  "repeatables.remove",
  "repeatables.disable",
  "repeatables.enable",
  "definitions.list",
  "runners.list",
  "runners.read",
  "runners.logs",
  "runners.trigger",
  "runners.pause",
  "runners.resume",
  "runners.kill",
  "runners.reschedule",
  "runners.resetStats",
  "runners.clearHistory",
  "runners.configure",
  "events.connect",
  "events.subscribe",
] as const;

/** One authorizable action. */
export type JobsApiAction = (typeof JOBS_API_ACTIONS)[number];

/**
 * Actions that change state; all are removed by `readOnly: true`.
 *
 * `queues.limits` is only ever the `PUT`: reading limits is `queues.read`.
 * Likewise `queues.defaults` is the `PUT` and `DELETE` of a queue's job
 * defaults — reading them is `queues.read` — and `queues.applyDefaults` is
 * the rewrite of jobs already pending, `dryRun` included.
 * `jobs.clearLogs` and `runners.clearHistory` delete what they clear for good,
 * and are default-on all the same, as `jobs.remove` and `runners.resetStats`
 * are: they write no caller payload and reconfigure nothing.
 */
export const JOBS_API_MUTATIONS: ReadonlySet<JobsApiAction> =
  new Set<JobsApiAction>([
    "queues.pause",
    "queues.resume",
    "queues.drain",
    "queues.clean",
    "queues.limits",
    "queues.defaults",
    "queues.applyDefaults",
    "workers.pause",
    "workers.resume",
    "workers.stop",
    "workers.start",
    "workers.configure",
    "jobs.add",
    "jobs.update",
    "jobs.retry",
    "jobs.retryAll",
    "jobs.remove",
    "jobs.clearLogs",
    "jobs.promote",
    "jobs.fail",
    "repeatables.remove",
    "repeatables.disable",
    "repeatables.enable",
    "runners.trigger",
    "runners.pause",
    "runners.resume",
    "runners.kill",
    "runners.reschedule",
    "runners.resetStats",
    "runners.clearHistory",
    "runners.configure",
  ]);

/**
 * Actions excluded when `actions` is not given, because they write
 * caller-supplied payloads or reconfigure a process from outside it. Passing
 * `actions` replaces the default entirely: it is an allow-list, so naming only
 * these disables every other action.
 *
 * `workers.configure` and `runners.configure` are here for blast radius rather
 * than payload: one write reaches every replica carrying the key, and the
 * lock-related knobs decide whether a job can be run twice. The lifecycle
 * actions (`workers.pause/resume/stop/start`) are *not* opt-in, because
 * `queues.pause` — which stops every worker on a queue — is already default-on.
 *
 * `queues.defaults` and `queues.applyDefaults` are opt-in for the same reason:
 * one write changes the retries, timeout and retention of every job every
 * producer adds to the queue (and, for the second, of every job already
 * pending), and `removeOnComplete: true` or `attempts: 1` by mistake discards
 * work fleet-wide.
 */
export const JOBS_API_OPT_IN_ACTIONS: ReadonlySet<JobsApiAction> =
  new Set<JobsApiAction>([
    "jobs.add",
    "jobs.update",
    "queues.defaults",
    "queues.applyDefaults",
    "workers.configure",
    "runners.configure",
  ]);

/** Which half of the package the API exposes: routes, channels and spec entries alike. */
export type JobsApiMode = "jobs" | "runner" | "both";

/** The WebSocket subprotocol. A client offering subprotocols must offer this one. */
export const JOBS_API_WS_SUBPROTOCOL = "bun-jobs.v1";

/** Close codes the server uses. */
export const JOBS_API_WS_CLOSE = {
  /** A normal close. */
  NORMAL: 1000,
  /** The API is closing (`api.close()`). */
  GOING_AWAY: 1001,
  /** The client sent a binary frame. */
  UNSUPPORTED_DATA: 1003,
  /** The client broke a policy: rate limit breached twice within 10 s. */
  POLICY: 1008,
  /** The client sent a frame over `maxMessageBytes`. */
  TOO_BIG: 1009,
  /** The client could not keep up for `slowConsumerTimeoutMs`. */
  SLOW_CONSUMER: 4008,
  /** Reserved: the session is no longer authorized. Not sent in protocol 1. */
  UNAUTHORIZED: 4401,
} as const;

/**
 * Most channels one `subscribe` or `unsubscribe` frame may name: well above
 * the default of 50 subscriptions a connection may hold, and small enough that
 * one frame's parsing stays cheap.
 */
export const JOBS_API_WS_MAX_CHANNELS_PER_FRAME = 256;

/** Every job state, in lifecycle order. */
export const JOB_STATES = [
  "waiting",
  "delayed",
  "active",
  "completed",
  "failed",
  "dead",
  "waiting-children",
] as const;

/**
 * Where a job is in its lifecycle. Two are easy to misread: `failed` is a job
 * whose attempt failed and that is **waiting to retry** (a UI may label it
 * "Retrying"), and `dead` is one that **gave up** — out of attempts, or failed
 * for good. Neither is the analytics series' `failed`, which counts failed
 * attempts.
 */
export type JobState = (typeof JOB_STATES)[number];

/** Optional job fields a client asks for with `include=`. */
export const JOB_INCLUDES = [
  "data",
  "returnValue",
  "stacktrace",
  "opts",
] as const;

/** One optional job field. */
export type JobInclude = (typeof JOB_INCLUDES)[number];

/**
 * What `GET /queues/:queue/jobs` can sort by (its `sort`), the default first.
 *
 * - `"natural"` (the default): each state's own order, the one every driver
 *   shares and the list has always used. One state: `waiting` by priority
 *   then `createdAt` (claim order), `delayed` and `failed` by `runAt` (when
 *   they are due), `active` by lock expiry (`lockExpiresAt`), `completed` and
 *   `dead` by `finishedOn`, `waiting-children` by `createdAt`. Several states,
 *   or none named (every state): by `createdAt`.
 * - `"createdAt"`: by `createdAt` whatever the states, so "newest first" means
 *   the same on every tab. Served only where `MetaDto.features.addedByState`
 *   is `true`.
 *
 * `order` reverses either one.
 */
export const JOB_LIST_SORTS = ["natural", "createdAt"] as const;

/** One way to sort the job list. See {@link JOB_LIST_SORTS}. */
export type JobListSort = (typeof JOB_LIST_SORTS)[number];

/** Every queue event name, in the order the server declares them. */
export const QUEUE_EVENT_TYPES = [
  "added",
  "duplicate",
  "waiting",
  "delayed",
  "active",
  "progress",
  "completed",
  "failed",
  "retrying",
  "dead",
  "stalled",
  "removed",
  "promoted",
  "paused",
  "resumed",
  "drained",
  "cleaned",
  "retried",
  "debounced",
  "throttled",
  "repeatScheduled",
] as const;

/**
 * Every runner event name, in the order the server declares them.
 *
 * Every one but `logs` reports a change to the runner or one of its runs.
 * **`logs` is not a state change**: it announces that a run's stored log grew
 * and changes no runner state, so a client caching runner detail, stats or
 * history should not invalidate them on it — it re-reads that run's log with
 * `?since=` instead.
 */
export const RUNNER_EVENT_TYPES = [
  "control",
  "started",
  "succeeded",
  "failed",
  "queued",
  "skipped",
  "timeout",
  "killed",
  "logs",
] as const;

/** The name of any queue event. */
export type QueueEventName = (typeof QUEUE_EVENT_TYPES)[number];

/** The name of any runner event. */
export type RunnerEventName = (typeof RUNNER_EVENT_TYPES)[number];

/**
 * Every distinct event name, queue events first, then the runner's and the
 * worker's: a name shared by two kinds appears once (`failed` is both a queue
 * and a runner event, `control` both a runner and a worker one), because the
 * filter matches on `type` and the envelope's `kind` tells them apart. What a
 * `subscribe` frame's `events` filter accepts.
 */
export const EVENT_TYPES = [
  ...QUEUE_EVENT_TYPES,
  "control",
  "started",
  "succeeded",
  "queued",
  "skipped",
  "timeout",
  "killed",
  "logs",
  "state",
  "config",
] as const satisfies readonly (
  | QueueEventName
  | RunnerEventName
  | WorkerEventName
)[];

/** Any event name a subscription can filter on. */
export type EventName = (typeof EVENT_TYPES)[number];

/* ------------------------------------------------------------------ *
 * Queue job defaults
 * ------------------------------------------------------------------ */

/**
 * Every job option a queue's stored defaults may replace, in the order a form
 * should show them. Build the form from this list, never a hand-written one.
 *
 * Deliberately absent: `deadLetter`, and the options that describe one job
 * rather than a queue's policy — `jobId`, `runAt`, `delay`, `repeat`,
 * `debounce`, `throttle` (and `ignoreFailure`, which only means anything on a
 * flow child).
 */
export const JOB_DEFAULT_KEYS = [
  "attempts",
  "backoff",
  "timeout",
  "priority",
  "removeOnComplete",
  "removeOnFail",
  "keepLogs",
  "keepStacktraces",
] as const;

/** One job option a queue's stored defaults may replace. */
export type JobDefaultKey = (typeof JOB_DEFAULT_KEYS)[number];

/**
 * The backoff strategies a stored default may name. The code may use any
 * strategy (built-in or registered on the worker); a remote edit is limited to
 * these two, which need no worker-side registration and so cannot name a
 * strategy some worker does not have.
 */
export const JOB_DEFAULT_BACKOFF_TYPES = ["fixed", "exponential"] as const;

/** A backoff strategy a stored default may name. */
export type JobDefaultBackoffType = (typeof JOB_DEFAULT_BACKOFF_TYPES)[number];

/**
 * The inclusive bounds stored job defaults are validated against. Exported so
 * a UI builds its inputs from the very numbers the server enforces.
 *
 * **The bounds are the API's, not the queue's.** `resolveJobOptions` accepts
 * any whole `attempts` of at least 1 and imposes no ceiling on the others; a
 * remote caller should not be able to set `attempts: 1e9` with one typo.
 *
 * - `timeout`: ms, `0` meaning none. The ceiling is a day — well inside
 *   `setTimeout`'s 2³¹−1 ms limit, past which a timer fires at once.
 * - `priority`: the range the drivers order on (clamped in code, refused here).
 * - `keepLogs`: at least `1`. In code `0` means *keep every line*, which a
 *   remote edit must not be able to turn on for a whole queue.
 * - `backoffDelay` / `backoffMax`: ms, for `backoff.delay` and `backoff.max`
 *   (and a plain-number backoff, which is a fixed delay).
 * - `backoffJitter`: the fraction of each delay randomised.
 * - `retentionCount` / `retentionTtl`: a `removeOnComplete`/`removeOnFail`
 *   `count` (or bare number) and `ttl` in ms (a year at most).
 */
export const JOB_DEFAULTS_BOUNDS = {
  attempts: { min: 1, max: 1_000 },
  timeout: { min: 0, max: 86_400_000 },
  priority: { min: -1_048_576, max: 1_048_576 },
  keepLogs: { min: 1, max: 100_000 },
  keepStacktraces: { min: 0, max: 100 },
  backoffDelay: { min: 0, max: 86_400_000 },
  backoffMax: { min: 0, max: 86_400_000 },
  backoffJitter: { min: 0, max: 1 },
  retentionCount: { min: 0, max: 1_000_000 },
  retentionTtl: { min: 0, max: 31_536_000_000 },
} as const satisfies Readonly<Record<string, { min: number; max: number }>>;

/**
 * The job states `POST /queues/:queue/job-defaults/apply` may rewrite, in the
 * order it walks them, and what it walks when a call names none — every state
 * a job waits in before it runs. `active` never: its worker already holds its
 * own copy of the job. `completed` and `dead` never: they are finished.
 */
export const JOB_DEFAULTS_APPLY_STATES = [
  "waiting",
  "delayed",
  "failed",
  "waiting-children",
] as const satisfies readonly JobState[];

/** A state the apply action may rewrite. */
export type JobDefaultsApplyState = (typeof JOB_DEFAULTS_APPLY_STATES)[number];

/* ------------------------------------------------------------------ *
 * Workers
 * ------------------------------------------------------------------ */

/**
 * Every state a worker reports, in lifecycle order.
 *
 * - `running`: consuming;
 * - `paused`: the loop runs but takes no new job;
 * - `stopping`: parked, waiting for the jobs in flight to finish;
 * - `stopped`: parked and idle, still registered and still heartbeating, so
 *   `start` can bring it back — unlike `close()` in code, which unregisters it;
 * - `restarting`: a millisecond transient while a config change is applied.
 */
export const WORKER_STATES = [
  "running",
  "paused",
  "stopping",
  "stopped",
  "restarting",
] as const;

/** What a worker is doing. */
export type WorkerState = (typeof WORKER_STATES)[number];

/**
 * The lifecycle instruction a controller may record against a worker: what it
 * should be, rather than what it is. `stopping` and `restarting` are states a
 * worker passes through, never things to ask for.
 */
export type WorkerDesiredState = Exclude<
  WorkerState,
  "stopping" | "restarting"
>;

/**
 * How a worker hears about a control change: a driver subscription (prompt),
 * or only its own polling (up to one `reportInterval` late).
 */
export type WorkerControlMode = "subscribe" | "poll";

/**
 * What a worker `control` event says a controller asked for: the four
 * lifecycle instructions, a configuration override (`config`) and its removal
 * (`reset`).
 */
export const WORKER_CONTROL_ACTIONS = [
  "pause",
  "resume",
  "stop",
  "start",
  "config",
  "reset",
] as const;

/** One thing a controller can ask a worker for. */
export type WorkerControlAction = (typeof WORKER_CONTROL_ACTIONS)[number];

/**
 * How far a `stop` survives.
 *
 * - `"process"`: only this incarnation is stopped, so a redeploy brings the
 *   worker back running;
 * - `"key"`: the stop is stored against the worker's stable `key`, so every
 *   replica carrying it — including one started later — comes up stopped.
 */
export const WORKER_STOP_PERSISTENCE = ["process", "key"] as const;

/** How far a `stop` survives; the default is `"process"`. */
export type WorkerStopPersistence = (typeof WORKER_STOP_PERSISTENCE)[number];

/**
 * Every worker setting a config override may replace, in the order a form
 * should show them. Build the UI's form from this list, never a hand-written
 * one, so a setting added here appears without a UI change.
 */
export const WORKER_CONFIG_KEYS = [
  "concurrency",
  "pollInterval",
  "maxBlock",
  "lockDuration",
  "heartbeatInterval",
  "stalledInterval",
  "maxStalledCount",
  "reportInterval",
  "drainDelay",
] as const;

/** One overridable worker setting. */
export type WorkerConfigKey = (typeof WORKER_CONFIG_KEYS)[number];

/**
 * The inclusive bounds a worker config override is validated against —
 * milliseconds except `concurrency` and `maxStalledCount`, which are counts.
 * Exported so a UI builds its inputs from the very numbers the server
 * enforces, and cannot drift from them.
 *
 * **One rule is not expressible here**: `heartbeatInterval` must also be at
 * most half the *effective* `lockDuration`, since a lock renewed less often
 * than twice per lease can lapse under a slow tick. That cross-field check
 * lives in the server's validation; a UI that wants to pre-empt it should
 * apply the same ceiling.
 *
 * `reportInterval` has a floor of one second rather than `0`: a worker that
 * never reports is invisible in the registry and therefore unreachable by
 * every control route, so turning reporting off remotely is refused.
 */
export const WORKER_CONFIG_BOUNDS: Readonly<
  Record<WorkerConfigKey, { min: number; max: number }>
> = {
  concurrency: { min: 1, max: 1_000 },
  pollInterval: { min: 10, max: 3_600_000 },
  maxBlock: { min: 10, max: 3_600_000 },
  lockDuration: { min: 1_000, max: 86_400_000 },
  heartbeatInterval: { min: 100, max: 43_200_000 },
  stalledInterval: { min: 1_000, max: 86_400_000 },
  maxStalledCount: { min: 0, max: 100 },
  reportInterval: { min: 1_000, max: 600_000 },
  drainDelay: { min: 0, max: 86_400_000 },
};

/**
 * Every worker event name, in the order the server declares them: `control`
 * (an instruction was recorded), `state` (a worker changed state) and
 * `config` (a worker adopted, or refused part of, an override).
 *
 * `control` is also a runner event name; {@link EVENT_TYPES} lists it once,
 * and the envelope's `kind` tells the two apart.
 */
export const WORKER_EVENT_TYPES = ["control", "state", "config"] as const;

/** The name of any worker event. */
export type WorkerEventName = (typeof WORKER_EVENT_TYPES)[number];

/* ------------------------------------------------------------------ *
 * Runners
 * ------------------------------------------------------------------ */

/**
 * Where a run executes, as a list rather than only a union, because a form
 * needs the values at runtime:
 *
 * - `spawn`: a child process per run — the only mode a run can be force-killed
 *   in, and the default;
 * - `worker`: a `Worker` per run, sharing the process's memory limits and file
 *   descriptors;
 * - `in-process`: the owner's own event loop, where a CPU-bound handler stalls
 *   everything else in that process, including its workers' lock renewals.
 *
 * `spawn` and `worker` receive `ctx.driverConfig` rather than `ctx.driver`, so
 * a handler reaching for `ctx.driver` works only `in-process`.
 */
export const EXECUTION_MODES = ["spawn", "worker", "in-process"] as const;

/**
 * The runner settings a remote override may replace, in the order a form
 * should show them. `maxConcurrency` only means anything under
 * `runMode: "parallel"`, so the two are written together.
 */
export const RUNNER_CONFIG_KEYS = [
  "executionMode",
  "runMode",
  "maxConcurrency",
] as const;

/** One overridable runner setting. */
export type RunnerConfigKey = (typeof RUNNER_CONFIG_KEYS)[number];

/**
 * The inclusive bounds a runner config override's numeric settings are
 * validated against. Exported so a UI builds its inputs from the very numbers
 * the API enforces, as it does from `WORKER_CONFIG_BOUNDS`. Only
 * `maxConcurrency` takes a number; the other two settings are enumerations
 * (`EXECUTION_MODES`, and `"single" | "parallel"`).
 *
 * **The maximum is the API's, not the runner's.** `resolveRunnerOptions`
 * (`lib/runner/options.ts:70`) refuses `maxConcurrency` below `1` and imposes
 * no ceiling at all — its default is `Number.POSITIVE_INFINITY`, which is how
 * "unlimited" is spelled in code. A remote caller cannot send infinity over
 * JSON and should not be able to start ten thousand runs with one typo, so the
 * route caps what it accepts and a client asks for unlimited by sending
 * `maxConcurrency: null` instead. The floor is the runner's own.
 */
export const RUNNER_CONFIG_BOUNDS: Readonly<
  Record<"maxConcurrency", { min: number; max: number }>
> = {
  maxConcurrency: { min: 1, max: 1_000 },
};

/* ------------------------------------------------------------------ *
 * Run logs
 * ------------------------------------------------------------------ */

/**
 * The streams a captured run-log line can come from, in the order a filter
 * should offer them.
 *
 * - `stdout` and `stderr`: what a spawned run wrote to its pipes, verbatim;
 * - `log`: a line the run forwarded through the runner's own log call, which
 *   arrives already rendered to text — a separate stream so a reader can tell
 *   deliberate logging from raw output, and so a filter can ask for one.
 *
 * The only definition: the runtime re-exports it from `lib/shared/constants.ts`
 * (the contract imports nothing, but nothing stops the runtime importing it).
 */
export const RUN_LOG_STREAMS = ["stdout", "stderr", "log"] as const;

/** Which stream a run-log line came from. */
export type RunLogStream = (typeof RUN_LOG_STREAMS)[number];

/**
 * The levels a `log`-stream line may carry, in increasing severity: bun-common's
 * six, restated here because the contract cannot import bun-common (a browser
 * bundling this must not pull the HTTP layer in). `stdout` and `stderr` lines
 * have no level at all, and a forwarded line that came without one has none
 * either — `RunLogLineDto.level` is optional for both reasons.
 *
 * A client that colours or filters by severity builds its control from this
 * list, so a level added to the logger appears without a UI change.
 */
export const RUN_LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;

/** The level a `log`-stream run-log line carried. */
export type RunLogLevel = (typeof RUN_LOG_LEVELS)[number];

/**
 * The least time between two `logs` runner events for one run, in
 * milliseconds: the rate a log tail can expect hints at. The first append in
 * a window is announced at once, the rest collapse into one trailing hint
 * carrying the newest `lastSeq`, and a run that settles announces its last
 * `lastSeq` without waiting out the window.
 *
 * The single definition: the runtime's `lib/shared/constants.ts` re-exports
 * this one, and `__tests__/api/api-contract.test.ts` pins the pair.
 */
export const RUN_LOG_HINT_MS = 500;

/**
 * What a scrubbed secret becomes in a stored run-log line, unless the
 * runner's `captureLogs.redact.replacement` says otherwise. A log view can name it
 * to mark redacted spans.
 *
 * The single definition: the runtime's redaction (`lib/runner/redact.ts`)
 * imports this one, and `__tests__/api/api-contract.test.ts` pins the pair.
 */
export const DEFAULT_REDACT_REPLACEMENT = "[REDACTED]";

/* ------------------------------------------------------------------ *
 * Analytics and time ranges
 * ------------------------------------------------------------------ */

/**
 * The bucket widths the analytics routes can serve, in **seconds**, finest
 * first. A client sends one of these as `resolution`; anything else is 400
 * `VALIDATION`.
 *
 * A deployment may serve fewer — the file driver records minutes only — so a
 * picker offers what `MetaDto.analytics.resolutions` reports and falls back to
 * this list when the API reports none.
 */
export const ANALYTICS_RESOLUTIONS = [1, 60] as const;

/** One bucket width an analytics response may be served at, in seconds. */
export type AnalyticsResolution = (typeof ANALYTICS_RESOLUTIONS)[number];

/**
 * A client's default pick of bucket width: a minute, which every driver that
 * records anything keeps for a day.
 *
 * The server never reads it. A request that names no `resolution` is served
 * at the finest width the backend keeps for the whole span within the bucket
 * cap (`resolveAnalyticsRange`), so a 5-minute range comes back at 1 s, not at
 * this. It exists so a picker has something to start from.
 */
export const DEFAULT_ANALYTICS_RESOLUTION: AnalyticsResolution = 60;

/** One second-resolution bucket, in milliseconds. */
export const SECOND_BUCKET_MS = 1_000;

/**
 * One minute-resolution bucket, in milliseconds. The same number as the
 * runtime's `THROUGHPUT_BUCKET_MS` (`lib/drivers/readApis.ts`), restated
 * because the contract may import nothing; `__tests__/api/api-contract.test.ts`
 * holds the two equal.
 */
export const MINUTE_BUCKET_MS = 60_000;

/**
 * How long per-second buckets are kept by default: five minutes.
 *
 * Deliberately short. Per-second bucketing costs O(entities), not O(jobs) —
 * a mid namespace (20 queues, 40 workers) holds about 19,500 buckets at five
 * minutes and about 58,500 at fifteen — so the retention, not the job rate, is
 * what the storage bill is made of. Five minutes covers the two presets the
 * feature exists for (60 s and 5 m); the 10 m preset falls back to 60 s
 * buckets and the response says so (`clamped`, `reason: "retention"`).
 */
export const DEFAULT_SECOND_RETENTION_MS = 5 * 60_000;

/** The longest per-second retention a deployment may configure: fifteen minutes. */
export const MAX_SECOND_RETENTION_MS = 15 * 60_000;

/**
 * How long minute buckets are kept: a day, so 1,440 buckets per series. The
 * same number as the runtime's `THROUGHPUT_RETENTION_MS`
 * (`lib/drivers/readApis.ts`), restated because the contract may import
 * nothing; a test holds the two equal. Not configurable in this round.
 */
export const MINUTE_RETENTION_MS = 24 * 60 * 60 * 1_000;

/**
 * The longest span one analytics request may cover: a day, which is all the
 * minute buckets there are. A wider range is 400 `INVALID_ARGUMENT`, so a
 * picker clamps itself to `MetaDto.analytics.maxSpanMs` (this, unless the
 * deployment says otherwise) rather than sending a request that cannot work.
 */
export const MAX_ANALYTICS_SPAN_MS = 24 * 60 * 60 * 1_000;

/** The shortest span that still holds one bucket: a second. Below it, 400 `INVALID_ARGUMENT`. */
export const MIN_ANALYTICS_SPAN_MS = 1_000;

/**
 * The longest span `GET /overview/added` and `GET /queues/{queue}/counts/added`
 * may cover: a day, the analytics picker's own limit, so one range picker
 * serves both halves of a card that shows these counts beside the analytics
 * series. A wider range is 400 `INVALID_ARGUMENT`.
 *
 * Deliberately its own name: the analytics limit is about the buckets kept,
 * this one about how many job rows one read may count. They agree today.
 */
export const MAX_ADDED_BY_STATE_SPAN_MS = 24 * 60 * 60 * 1_000;

/**
 * Most buckets one series may hold. The cap is what picks the resolution: the
 * finest `r` the driver keeps for the whole span with `span / r` within this.
 * A day at one second would be 86,400 points — more than a chart can draw and
 * more than a response should carry — so such a span is served at 60 s with
 * `clamped: true` and `reason: "maxBuckets"`.
 */
export const MAX_ANALYTICS_BUCKETS = 1_500;

/**
 * Most series one request may ask for by name (`ids=`, `keys=`). An explicit
 * over-ask is 400 `BULK_LIMIT` rather than a silent truncation: a caller that
 * named its series wants those series.
 *
 * It is also the page size the Runners and Workers tables should use, so the
 * sparklines for one visible page are exactly one batch request.
 */
export const MAX_ANALYTICS_SERIES = 20;

/**
 * Most scalar rows an overview section reports, sorted by `completed`
 * descending then by key, with `truncated: true` beyond it. A namespace with
 * 200 workers therefore costs three series and 100 rows, not 200 series.
 */
export const MAX_ANALYTICS_ROWS = 100;

/**
 * The rolling spans a range picker offers, shortest first, in **seconds**.
 * They are the API's rather than a client's so that a preset a deployment
 * cannot serve at the resolution it implies is still described by one honest
 * set of numbers — the response's `clamped`/`reason` explains the difference.
 */
export const ANALYTICS_PRESETS = [
  60, // a minute
  300, // 5 minutes
  600, // 10 minutes
  1800, // 30 minutes
  3600, // an hour
  21600, // 6 hours
  86400, // a day
] as const;

/**
 * One rolling preset, in seconds.
 *
 * The list is written as plain literals rather than as `5 * 60` and friends
 * deliberately: `as const` keeps a literal type only for a literal, so an
 * arithmetic entry would widen this union to `number` and a picker offering
 * any span at all would compile.
 */
export type AnalyticsPreset = (typeof ANALYTICS_PRESETS)[number];

/** The preset a view opens on: the last hour, which is what the Overview always showed. */
export const DEFAULT_ANALYTICS_PRESET: AnalyticsPreset = 3600;

/**
 * The upper edges of the fixed log histogram run durations are counted in, in
 * milliseconds: 24 powers of two, `1` to `2**23` (about 2.3 hours).
 *
 * A bucket's `histogram` is one count **more** than there are edges. Count `0`
 * is everything under the first edge (`[0, 1)` ms), count `i` is
 * `[bounds[i - 1], bounds[i])`, and the last is the overflow, everything at or
 * above the final edge. Fixed bins are what make a histogram mergeable: two
 * histograms over the same edges add element by element, whoever wrote them.
 *
 * How a backend stores it follows from that. A bucket takes many flushes from
 * the same writer, so each flush *adds* its counts: SQL keeps the histogram as
 * 25 integer columns on the bucket's shared row (no portable SQL adds two JSON
 * arrays), MongoDB merges the array atomically, and a read sums what it finds.
 */
export const DURATION_HISTOGRAM_BOUNDS = [
  1, // 2**0 ms
  2,
  4,
  8,
  16,
  32,
  64,
  128,
  256,
  512,
  1_024,
  2_048,
  4_096,
  8_192,
  16_384,
  32_768,
  65_536,
  131_072,
  262_144,
  524_288,
  1_048_576,
  2_097_152,
  4_194_304,
  8_388_608, // 2**23 ms, about 2.3 hours
] as const;

/** The pattern a queue name or runner id must match, besides not being `"."` or `".."`. */
export const NAME_SEGMENT_PATTERN = "^[\\w.-]+$";

/**
 * The same rule as one JSON Schema pattern, `"."` and `".."` excluded: what the
 * routes enforce on a `:queue` or `:runner` path segment (400 `INVALID_NAME`).
 */
export const NAME_PARAM_PATTERN = "^(?!\\.\\.?$)[\\w.-]+$";

/** Longest a queue name or runner id may be, in characters. */
export const MAX_NAME_LENGTH = 200;

/**
 * Longest id a caller may choose for a new job (`opts.jobId`), in
 * characters: the cap bun-jobs' own `assertJobId` applies
 * (`MAX_JOB_ID_LENGTH` in `lib/queue/options.ts`, restated here because the
 * contract must not import the queue; a test pins the two together). MySQL and
 * MariaDB store ids as `VARCHAR(191)`, and one cap everywhere keeps an id that
 * works on one driver from failing on another. `assertJobId` stays the
 * authority: it counts UTF-16 units and refuses control characters, a leading
 * `.` and a lone surrogate, answered 400 `INVALID_ARGUMENT`.
 */
export const MAX_JOB_ID_LENGTH = 191;

/**
 * Longest id that may *address* an existing job — in a path, a bulk body or a
 * lookup. Wider than {@link MAX_JOB_ID_LENGTH} on purpose: a backend may hold
 * jobs whose ids predate that cap, and they must stay reachable.
 */
export const MAX_JOB_REF_LENGTH = 1024;

/**
 * Most values one repeatable worker filter on the job list (`workerKey`,
 * `workerId`) may carry; more is 400 `VALIDATION`. The same bound the worker
 * listing's own filters (`key`, `host`, …) have, so a selection copied from
 * one to the other fits.
 */
export const MAX_JOB_FILTER_VALUES = 100;

/**
 * The latest instant a `Date` can hold, in epoch milliseconds (ECMAScript's
 * range is ±8.64e15). Every time the API accepts as epoch milliseconds — a
 * job's `runAt`, a schedule's `anchor` or `at` — is capped at this, so a later
 * one is 400 `VALIDATION` instead of an invalid `Date` further in.
 */
export const MAX_DATE_MS = 8_640_000_000_000_000;

/* ------------------------------------------------------------------ *
 * Channel names
 * ------------------------------------------------------------------ */

/**
 * Escapes a job id for a channel name: `encodeURIComponent`, except that a
 * lone UTF-16 surrogate — which `encodeURIComponent` refuses with a `URIError`
 * — becomes `%uXXXX` (upper-case hex). A well-formed id is therefore escaped
 * exactly as before, and {@link decodeJobId} reverses either form. The two
 * cannot be confused: `encodeURIComponent` escapes every `%` as `%25`.
 *
 * A client names a job's channel as `queue/<queue>/job/${encodeJobId(id)}`.
 * Pure, with no imports, so it is safe in a browser.
 */
export function encodeJobId(jobId: string): string {
  if (jobId.isWellFormed()) {
    return encodeURIComponent(jobId);
  }
  let out = "";
  let run = 0;
  for (let index = 0; index < jobId.length; index++) {
    const unit = jobId.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) {
      continue;
    }
    const next = jobId.charCodeAt(index + 1);
    if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      index++;
      continue;
    }
    out += `${encodeURIComponent(jobId.slice(run, index))}%u${unit.toString(16).toUpperCase()}`;
    run = index + 1;
  }
  return out + encodeURIComponent(jobId.slice(run));
}

/**
 * Reverses {@link encodeJobId}: the job id a job channel's last segment
 * names. Throws `URIError` on a malformed escape, and on a `%uXXXX` escape of
 * anything but a surrogate.
 */
export function decodeJobId(encoded: string): string {
  return encoded
    .split(/(%u[\dA-Fa-f]{4})/)
    .map((part, index) => {
      if (index % 2 === 0) {
        return decodeURIComponent(part);
      }
      const unit = Number.parseInt(part.slice(2), 16);
      // Only a surrogate needs this form; anything else has a standard one.
      if (unit < 0xd800 || unit > 0xdfff) {
        throw new URIError(`"${part}" is not a surrogate escape`);
      }
      return String.fromCharCode(unit);
    })
    .join("");
}
