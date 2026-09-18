# @kingsleyweb/bun-jobs

Background work for Bun, built on
[`@kingsleyweb/bun-common`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md).
Two subsystems share one storage contract and one required namespace:

- **Queue** (`BunQueue` / `BunQueueWorker`). Queue and process many small jobs
  across processes and services. It supports priorities, delays, retries with
  backoff, per-attempt timeouts, stalled-job recovery, repeatable jobs,
  debounce and throttle, cluster-wide rate and concurrency limits, dead
  letters, flows (parents waiting on children), job logs, retention and events.
- **Runner** (`BunRunner`). Run one JS/TS file on a schedule (cron with
  optional seconds, an interval, or a one-shot) or on demand. It runs in a
  child process, a `Worker` or in-process. Single-run mode holds a
  cluster-wide lock and queues extra triggers. A stuck run is killed with a
  close, then `SIGTERM`, then `SIGKILL`.
- **Drivers**: memory, file, SQL (`Bun.sql`: SQLite, Postgres, MySQL, MariaDB),
  MongoDB and Redis, all behind one contract. Producers, consumers and runners
  in different processes can share a backend.

`BunJobs` ties them together for one service. It sets a namespace and a
backend once, and every queue, worker and runner is derived from it. It also
adds a registry of named jobs with a fluent builder that reads schedules
written in words (`"every 2 weeks starting next monday"`).

**Requires Bun ≥ 1.4.2.** The Redis and SQL drivers use `RedisClient` and
`Bun.sql` APIs that 1.4.2 is the first release to declare.

## Status

The package is being assembled in phases. What has landed on this branch, and
is documented below:

- the runner, with `BunRunnerManager`
- the queue and worker, including repeatable jobs, debounce and throttle,
  limits, dead letters, flows, isolated processors and job logs
- the `BunJobs` context, the job registry and the builder with dates in words
- `JobsNotifier`, one event stream per namespace
- the memory, file, SQL, MongoDB and Redis drivers, with schema sync for SQL
  and MongoDB

The generated API reference lands with the final phase. Until then this README,
the JSDoc on every export, and the [option tours](#bun-jobs-examples) are the
reference.

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
  - [A queue and a worker](#a-queue-and-a-worker)
  - [The job registry](#the-job-registry)
  - [A runner](#a-runner)
- [Concepts](#concepts)
- [Queues and adding jobs](#queues-and-adding-jobs)
  - [Job options](#job-options)
  - [Queue options](#queue-options)
  - [Queue methods](#queue-methods)
- [Workers](#workers)
  - [Worker options](#worker-options)
  - [Retries and backoff](#retries-and-backoff)
  - [Rate and concurrency limits](#rate-and-concurrency-limits)
  - [Dead letters](#dead-letters)
  - [Pause, resume and shutdown](#pause-resume-and-shutdown)
  - [Stalled jobs](#stalled-jobs)
- [The job API](#the-job-api)
- [The BunJobs registry and builder](#the-bunjobs-registry-and-builder)
  - [BunJobs options](#bunjobs-options)
  - [Defining and adding jobs](#defining-and-adding-jobs)
  - [Builder methods](#builder-methods)
  - [Saved drafts](#saved-drafts)
  - [Registry polling](#registry-polling)
  - [Dates in words](#dates-in-words)
- [Scheduling and repeatable jobs](#scheduling-and-repeatable-jobs)
- [Debounce and throttle](#debounce-and-throttle)
- [Flows](#flows)
- [Reading a queue: search, totals, workers and throughput](#reading-a-queue-search-totals-workers-and-throughput)
- [Isolated processors](#isolated-processors)
- [BunRunner](#bunrunner)
  - [Runner options](#runner-options)
  - [Triggers and run modes](#triggers-and-run-modes)
  - [Handlers, messages and kills](#handlers-messages-and-kills)
  - [Introspection](#introspection)
  - [BunRunnerManager](#bunrunnermanager)
- [Events and JobsNotifier](#events-and-jobsnotifier)
- [Drivers](#drivers)
  - [Choosing a driver](#choosing-a-driver)
  - [Driver configs](#driver-configs)
  - [Connection fields](#connection-fields)
- [Schema sync](#schema-sync)
- [Errors](#errors)
- [Logging](#logging)
- [Benchmarks](#benchmarks)
- [Examples](#examples)
  - [Example projects](#example-projects)
  - [bun-jobs examples](#bun-jobs-examples)
- [Related packages](#related-packages)
- [Development](#development)
- [License](#license)

## Installation

```bash
bun add @kingsleyweb/bun-jobs
```

The memory, file, SQL and Redis drivers use only Bun's built-in clients. The
remaining features rely on optional peer dependencies, which you install only
if you use them:

| Peer | Range | Needed for |
|---|---|---|
| `mongodb` | `>=6` | the MongoDB driver. Imported only when that driver connects. Needs **MongoDB 4.2 or later**. |
| `chrono-node` | `>=2.7.0 <3` | reading **dates** in words (`"tomorrow at 9am"`, `"every 2 weeks starting 1st december"`). Durations (`"5 minutes"`) and cron do not need it. You can also supply your own [`dateParser`](#dates-in-words). |
| `@types/bun` | `>=1.4.2` | types. The package ships raw `.ts`, so your project compiles it. |

```bash
bun add mongodb        # MongoDB driver
bun add chrono-node    # dates in words
```

## Quick start

### A queue and a worker

```ts
import { BunQueue, BunQueueWorker, MemoryDriver } from "@kingsleyweb/bun-jobs";

interface Email {
  to: string;
}

// The memory driver keeps jobs inside the instance, so producer and worker
// must share one. On any other backend each side can build its own.
const driver = new MemoryDriver();
const namespace = "shop";

const emails = new BunQueue<Email, string>("emails", { namespace, driver });

const worker = new BunQueueWorker<Email, string>(
  "emails",
  async (job, ctx) => {
    await ctx.log(`sending to ${job.data.to}`);
    return `sent to ${job.data.to}`;
  },
  { namespace, driver, concurrency: 5 },
);

worker.on("completed", (job, result) => {
  console.log(job.id, result);
});
void worker.run(); // resolves once the worker is closed

await emails.add("welcome", { to: "ada@example.com" }, { attempts: 3 });
```

### The job registry

```ts
import { BunJobs } from "@kingsleyweb/bun-jobs";

const jobs = new BunJobs({
  namespace: "shop",
  driver: { type: "redis", url: "redis://localhost:6379" },
});

jobs.define<{ to: string }>(
  "sendEmail",
  async (job) => {
    await deliver(job.data.to);
  },
  { attempts: 5 },
);

await jobs.start({ concurrency: 2 }); // one worker for every defined name

await jobs.now("sendEmail", { to: "ada@example.com" });
await jobs.run("sendEmail", { to: "grace@example.com" }).in("5 minutes").start();
await jobs.schedule("sendEmail", { to: "ops@example.com" }).every("1 day").start();

await jobs.close(); // stops workers and runners, closes the driver it built
```

### A runner

```ts
// jobs/cleanup.ts
import { defineHandler } from "@kingsleyweb/bun-jobs";

export default defineHandler<{ days: number }, number>(async (ctx) => {
  ctx.logger.info("cleaning", { days: ctx.args.days });
  ctx.progress(50);
  return 42; // stored in the run's history
});
```

```ts
import { BunRunner } from "@kingsleyweb/bun-jobs";

const runner = new BunRunner({
  id: "cleanup",
  namespace: "shop",
  file: new URL("./jobs/cleanup.ts", import.meta.url),
  schedule: "0 */10 * * * *", // six fields: every ten minutes, at second 0
  args: { days: 30 },
});

runner.on("finished", (run, result) => {
  console.log(run.runId, result);
});
await runner.start();

await runner.trigger({ args: { days: 7 } }); // { outcome: "started", runId }
```

## Concepts

- **Namespace.** Every queue, worker and runner requires one. The same queue
  name or runner id in two namespaces refers to two separate things, so
  services sharing a backend cannot collide.
  `BunJobs` makes the namespace structural: set it once, and everything
  derived from the context uses it.
- **Queue.** A queue is just a name inside a namespace, with no server and no
  registration step. Producers and workers find each other by naming the same
  namespace and queue on the same backend.
- **Driver.** Where state lives. You can pass either an instance, which is
  shared and never closed by whoever borrowed it, or a
  [config](#driver-configs), which is built and closed by the object it was
  given to. A spawned child process can only receive a config.
- **Job states.** A job moves through these states:
  - `waiting` or `delayed`, then `active`;
  - from `active`, to `completed`, to `failed` (an attempt failed and a retry
    is scheduled), or to `dead` (attempts exhausted, or unrecoverable);
  - a flow parent sits in `waiting-children` until its children settle.
- **Maintenance needs no leader.** Every worker promotes delayed jobs,
  recovers stalled ones, prunes expired results, heals repeat series and flows,
  and sweeps stale debounce and throttle windows. Each of these is
  idempotent, so no single process is load-bearing.

## Queues and adding jobs

```ts
const mail = new BunQueue<Mail, void, "welcome" | "digest">("mail", {
  namespace: "account",
  driver: { type: "sql", url: "postgres://user:pass@db/jobs" },
  defaultJobOptions: { attempts: 3 },
});

const job = await mail.add("welcome", { userId: 7 }, { priority: -1, delay: 5_000 });
job.wasAdded; // false when `jobId` already existed

await mail.addBulk([
  { name: "welcome", data: { userId: 8 } },
  { name: "digest", data: { userId: 9 }, opts: { runAt: new Date("2026-12-01") } },
]);
```

The third type parameter narrows the job names that `add` accepts.

Examples:

- [`02-queues/producer-and-worker.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/producer-and-worker.ts)
- [`02-queues/job-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/job-options.ts)
- [`02-queues/bulk-and-management.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/bulk-and-management.ts)
- [`10-options/job-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/job-options.ts)
- [`10-options/queue-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/queue-options.ts)

### Job options

Queue `defaultJobOptions` are merged under the options of each `add()`. The
built-in defaults are exported as `DEFAULT_JOB_OPTIONS`.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `jobId` | `string` | fresh id | The job's id, and also its idempotency key. Adding an existing id returns the stored job untouched (`wasAdded: false`) and emits `duplicate`. |
| `priority` | `number` | `0` | Lower runs first; ties break FIFO. Clamped to ±1,048,576. |
| `delay` | `number` | `0` | Milliseconds before the job may run. |
| `runAt` | `Date \| number` | | An absolute time the job may run. Takes precedence over `delay`. |
| `attempts` | `number` | `1` | Total attempts, including the first. Must be a whole number ≥ 1. |
| `backoff` | `number \| JobBackoffOptions` | exponential from 1s, max 5 min, jitter 0.1 | Delay between attempts. See [Retries and backoff](#retries-and-backoff). |
| `timeout` | `number` | `0` (none) | Per-attempt timeout in ms. The attempt's `ctx.signal` is aborted, and it fails with `JobTimeoutError`. |
| `removeOnComplete` | `Retention` | `{ ttl: 86_400_000 }` | How long a completed job is kept (see below). |
| `removeOnFail` | `Retention` | `false` | The same, for a dead job. |
| `keepStacktraces` | `number` | `5` | How many failure stack traces the record keeps. |
| `keepLogs` | `number` | `1000` | How many log lines the job keeps, newest last. `0` keeps every line. |
| `deadLetter` | `string` | | The queue, in the same namespace, that receives a copy of the job when it dies. Takes precedence over the worker's `deadLetterQueue`. |
| `debounce` | `{ id, ttl }` | | Keep one pending job per id. See [Debounce and throttle](#debounce-and-throttle). |
| `throttle` | `{ id, ttl }` | | At most one job per id per window. |
| `repeat` | `RepeatOptions` | | Makes this a repeatable job. See [Scheduling](#scheduling-and-repeatable-jobs). |
| `ignoreFailure` | `boolean` | `false` | For a flow child: if it fails for good, its parent carries on anyway. |

**Retention** (`Retention = boolean | number | { count?, ttl? }`) takes these
forms:

- `true` removes the job immediately;
- `false` keeps it forever;
- a number keeps that many jobs;
- `{ count, ttl }` does both.

A flow child is never removed before its parent has recorded its outcome.

### Queue options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `namespace` | `string` | required | The namespace the queue belongs to. |
| `driver` | `JobsDriver \| DriverConfig` | a new memory driver | Where jobs live. A config is built and closed here; an instance is shared. |
| `logger` | `LoggerLike` | no-op | See [Logging](#logging). |
| `defaultJobOptions` | `JobOptions` | | Merged under every `add()`. |
| `subscribe` | `boolean` | `false` | Re-emit events published by other processes, so a producer can watch jobs a worker elsewhere runs. Costs a subscription. |
| `publish` | `boolean` | value of `subscribe` | Publish this queue's events for other processes. |
| `publishGate` | `() => Promise<void>` | | Awaited before each publish. `BunJobs` sets it so events are not lost while its notifiers subscribe. |
| `dateParser` | `DateParser` | `chrono-node` | Reads dates written in words. See [Dates in words](#dates-in-words). |

### Queue methods

Every method connects the driver on first use. After `close()`, calls throw
`QueueClosedError`.

| Method | What it does |
|---|---|
| `add(name, data, opts?)` | Adds a job, and returns a `Job`. |
| `addBulk([{ name, data, opts? }])` | Adds several jobs in one call. Entries with `repeat` are added one at a time. |
| `addFlow(node)` | Adds a job together with the jobs it waits on. See [Flows](#flows). |
| `getJob(id)` | Returns one job, or `null`. |
| `list(state \| states, { offset, limit = 100, order = "asc" })` | Returns jobs in the given state or states. |
| `count()` / `count(state)` | Returns counts for every state, or for one. |
| `update(id, { data?, priority?, runAt?, onlyIn? })` | Patches a stored job. `runAt` moves only a waiting or delayed job. `onlyIn` makes the change conditional on the job's state. |
| `remove(id)` | Removes a job. Refused while the job is active. |
| `retry(id, { resetAttempts = true })` | Returns a finished job to the queue. |
| `retryJobs(ids, opts?)` | Retries several jobs, and returns the ids that went. |
| `retryAll(state, { name?, reason?, filter?, limit?, resetAttempts? })` | Re-drives every matching `dead`, `failed` or `completed` job, walking the state one page at a time. |
| `promote(id)` | Makes a delayed or retry-pending job claimable now. |
| `getJobLogs(id, { offset, limit, order })` | Returns a page of a job's log. |
| `pause()` / `resume()` / `isPaused()` | Pauses or resumes claiming for every worker in every process. |
| `drain({ delayed = false })` | Drops pending jobs and returns the count. It never touches jobs that are running. |
| `clean(state, { olderThan, limit = 1000 })` | Removes jobs in `state` older than `olderThan` ms. |
| `setLimits(limits \| null)` / `getLimits()` | Cluster-wide limits. See [Rate and concurrency limits](#rate-and-concurrency-limits). |
| `cleanWindows({ limit = 1000 })` | Removes stale debounce and throttle pointers. Workers also do this once a minute. |
| `listRepeatables()` / `removeRepeatable(key)` | Lists repeat series, or removes one along with its scheduled occurrence. |
| `close()` | Closes the subscription, and the driver if the queue built it. |

## Workers

```ts
const worker = new BunQueueWorker<Mail, void>(
  "mail",
  async (job, ctx) => {
    ctx.signal.throwIfAborted(); // aborted on timeout, shutdown or a lost lock
    await job.updateProgress(50);
    await send(job.data);
  },
  { namespace: "account", driver, concurrency: 10, deadLetterQueue: "mail-dead" },
);

await worker.run(); // or `autorun: true`
```

The processor receives the [`Job`](#the-job-api) and a `ProcessorContext`:

| Field | Type | Meaning |
|---|---|---|
| `signal` | `AbortSignal` | Aborted when the attempt times out, the worker closes, or the job's lock is lost. |
| `logger` | `Logger` | A logger bound to the job's ids. |
| `workerId` | `string` | The worker's id. |
| `attempt` | `number` | The attempt number, starting at 1. |
| `heartbeat()` | `() => Promise<void>` | Extends the lock now, for a step longer than `lockDuration`. |
| `log(line)` | `(line) => Promise<number>` | Appends to the job's persistent log, and returns how many lines it keeps. |

Examples:

- [`10-options/worker-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/worker-options.ts)
- [`06-failures/`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/06-failures)

### Worker options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `namespace` | `string` | required | Must match the producer's namespace. |
| `driver` | `JobsDriver \| DriverConfig` | a new memory driver | Where jobs live. |
| `logger` | `LoggerLike` | no-op | Logger. |
| `id` | `string` | fresh id | Identifies the worker in job records and logs. |
| `concurrency` | `number` | `1` | Jobs processed at once. Can also be set at runtime via `worker.concurrency`. |
| `lockDuration` | `number` | `30000` | How long a claim's lock lives. |
| `heartbeatInterval` | `number` | `lockDuration / 3` (min 250) | How often the lock is renewed. |
| `stalledInterval` | `number` | `30000` | How often to sweep for jobs whose worker died. |
| `maxStalledCount` | `number` | `1` | How many stalls a job may have before it is buried. |
| `pollInterval` | `number` | `1000` | Wait between claim attempts on a polling driver. |
| `maxBlock` | `number` | `5000` | Longest blocking wait on a blocking driver. |
| `maintenance` | `boolean` | `true` | Run the maintenance sweeps (see [Concepts](#concepts)). |
| `autorun` | `boolean` | `false` | Start consuming on construction. |
| `drainDelay` | `number` | `0` | Milliseconds of quiet before `drained` is emitted. |
| `isolation` | `"in-process" \| "worker" \| "spawn"` | `"in-process"` | Where a processor file runs. See [Isolated processors](#isolated-processors). |
| `isolationOptions` | `IsolationOptions` | | Timeouts and executor options for isolated processors. |
| `backoffStrategies` | `BackoffStrategies \| Record<string, BackoffStrategy>` | | Named custom backoffs. |
| `deadLetterQueue` | `string` | | The dead-letter queue for jobs that do not name their own. |
| `limitsRefreshInterval` | `number` | `1000` | How long stored limits are trusted before being re-read. |
| `waitToExit` | `boolean` | `true` | Keep the process alive while waiting for work. `false` lets a script exit when its own work is done. The Redis, Postgres and MongoDB clients hold the process on their own, so close the driver in that case. |
| `publish` | `boolean` | `false` | Publish job events (active, progress, completed, failed, stalled, and so on) for other processes. |
| `publishGate` | `() => Promise<void>` | | Awaited before each publish. |

The worker's events are:

- `ready`
- `active`
- `progress`
- `completed`
- `failed`, emitted on every failed attempt
- `retrying`
- `dead`
- `deadLettered`
- `stalled`
- `lockLost`
- `drained`
- `paused`, `resumed`
- `closing`, `closed`
- `error`

The job events can also be scoped to a job name, such as
`worker.on("completed:sendEmail", ...)`.

### Retries and backoff

An attempt that throws is retried while attempts remain. Throwing an
`UnrecoverableJobError` sends the job straight to `dead`, even if attempts are
left.

`backoff` accepts either of two forms:

- a number of milliseconds, meaning a fixed delay;
- an object `{ type, delay, factor, max, jitter }`.

The built-in `type` values are `fixed` (the default when you give an object),
`exponential`, `linear`, `fibonacci`, `full-jitter` and `decorrelated-jitter`.
Any other `type` is the name of a custom strategy registered on the worker:

```ts
jobs.defineBackoff("retryAfter", ({ attempt, error }) =>
  error.message.includes("quota") ? false : attempt * 30_000, // false: stop retrying
);

await jobs.now("sync", data, { attempts: 5, backoff: { type: "retryAfter", max: 300_000 } });
```

The job stores only the strategy's name, and each consuming process resolves
it. A worker that does not know the name falls back to the default backoff and
logs a warning. It never loses the job's remaining attempts.

For a worker you construct yourself, pass `backoffStrategies`. Workers created
by `BunJobs` receive every strategy registered with `defineBackoff`.

Example:
[`06-failures/retries-and-backoff.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/06-failures/retries-and-backoff.ts).

### Rate and concurrency limits

Limits are stored on the queue, so every worker in every process enforces the
same numbers. A change reaches running workers within their
`limitsRefreshInterval`.

```ts
await queue.setLimits({
  rate: { max: 100, duration: "1 minute" }, // queue-wide start rate
  concurrency: 20, // jobs running at once, across every worker
  names: { sendEmail: { concurrency: 5, rate: { max: 10, duration: 1_000 } } },
});
await queue.setLimits(null); // lift them all
```

When a name reaches its limit, it is skipped rather than waited behind, so
other names keep running.

Enforcement is approximate by design. Concurrency is held as leases that
expire `lockDuration` after a worker stops renewing them. In exchange, no claim
waits on a global lock.

`define(name, handler, { concurrency })` in the registry stores a per-name
concurrency the same way. Every built-in driver can store limits.

Examples:

- [`05-flow-control/rate-and-concurrency-limits.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/05-flow-control/rate-and-concurrency-limits.ts)
- [`03-job-registry/per-name-concurrency.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/03-job-registry/per-name-concurrency.ts)

### Dead letters

A job that dies can be copied to a dead-letter queue, named by the job's
`deadLetter` option or by the worker's `deadLetterQueue`. The copy is a
`DeadLetter` with these fields:

- `queue`
- `id`
- `name`
- `data`
- `failedReason`
- `attemptsMade`
- `diedAt`

It is added under the original job's name, so a worker on the dead-letter
queue can dispatch on it as the original worker did. Its id is derived from
the original's, so one death files exactly one letter. The dead job itself is
kept or removed according to `removeOnFail`.

Once the cause is fixed, re-drive a backlog with, for example,
`queue.retryAll("dead", { reason: /ECONNREFUSED/ })`.

Example:
[`06-failures/dead-letter-queue.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/06-failures/dead-letter-queue.ts).

### Pause, resume and shutdown

- `worker.pause({ waitActive? })`, `worker.resume()` and `worker.isPaused()`
  affect this worker only.
- `queue.pause()` and `queue.resume()` affect every worker in every process.
- `worker.close({ force?, timeout? })` stops claiming and waits for in-flight
  jobs. A job still running at `timeout` has its signal aborted, and its lock
  is left to expire, so another worker recovers it as stalled instead of the
  job being lost. `close()` holds the process open until it finishes, so it is
  safe to await in a `SIGTERM` handler.

Examples:

- [`09-integrations/graceful-shutdown.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/09-integrations/graceful-shutdown.ts)
- [`06-failures/timeouts-and-cancellation.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/06-failures/timeouts-and-cancellation.ts)

### Stalled jobs

A worker that dies while holding a job stops renewing its lock. Every
`stalledInterval`, some worker's maintenance returns jobs with expired locks
to the queue and emits `stalled` with their ids. A job that has stalled more
than `maxStalledCount` times is buried in `dead` instead.

## The job API

`Job<TData, TResult>` is an immutable view of the stored record. Its mutating
methods go to the driver and return what the driver decided.

| Member | Meaning |
|---|---|
| `id`, `name`, `data`, `opts`, `state`, `priority`, `runAt`, `createdAt` | Identity and placement. |
| `processedOn`, `finishedOn`, `expiresAt` | Timestamps (epoch ms), or `null`. |
| `attemptsMade`, `maxAttempts`, `stalledCount` | Attempt bookkeeping. |
| `progress`, `returnValue`, `failedReason`, `stacktrace` | Outcome. Errors are rehydrated as `Error`s. |
| `workerId`, `lockToken`, `repeatKey`, `isRepeat`, `wasAdded`, `parent`, `queue` | Context. |
| `updateProgress(value)` | Records a number or an object, and emits `progress`. |
| `log(line)` / `getLogs({ offset, limit, order })` | The job's persistent log, capped at `keepLogs`. |
| `updateData(data)` | Replaces the data in any state. A running attempt keeps the data it started with. |
| `setPriority(n)` | Changes the priority. A waiting job moves in claim order. |
| `reschedule(when)` | Moves a waiting or delayed job to a `Date`, epoch ms, or words (`"in 10 minutes"`). |
| `promote()` | Makes a delayed or retry-pending job claimable now. |
| `retry({ resetAttempts })` | Returns a finished job to the queue. |
| `remove()` | Removes the job. Refused while it is active. |
| `extendLock(ms?)` / `touch(ms?)` | Extends the lock. Returns `false` once the lock is no longer yours. |
| `refresh()` | Re-reads the job, or returns `null` if it is gone. |
| `getChildrenValues()` / `getChildrenFailures()` | Flow results, keyed `queue:id`. |
| `toJSON()` | The stored record. |

Example:
[`02-queues/job-lifecycle.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/job-lifecycle.ts).

## The BunJobs registry and builder

```ts
const jobs = new BunJobs({ namespace: "account", driver: { type: "redis", url } });

export const mail = jobs.queue("mail"); // the same instance on every call
export const worker = jobs.worker("mail", processor, { concurrency: 4 });
export const cleanup = jobs.runner({ id: "cleanup", file: "./jobs/cleanup.ts" });
```

Examples:

- [`01-quick-start/index.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/01-quick-start/index.ts)
- [`03-job-registry/`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/03-job-registry)
- [`10-options/bunjobs-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/bunjobs-options.ts)
- [`10-options/draft-and-process-every.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/draft-and-process-every.ts)

### BunJobs options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `namespace` | `string` | required | One per service. |
| `driver` | `JobsDriver \| DriverConfig` | a new memory driver | A config is built here and closed with the context. An instance is never closed by it. |
| `logger` | `LoggerLike` | no-op | Passed to everything created here. |
| `defaultJobOptions` | `JobOptions` | | Merged under every job added through a queue from here. |
| `runnerDefaults` | `Partial<BunRunnerOptions>` | | Merged under every runner created here (everything except `id`, `namespace` and `file`). |
| `registryQueue` | `string` | `"jobs"` | The queue that `define`, `now`, `schedule`, `run`, `process` and `start` use. |
| `dateParser` | `DateParser` | `chrono-node` | Reads dates in words for every queue created here. |
| `publishEvents` | `boolean` | `false` | Every queue, worker and runner created here publishes its events. A `publish` option on an individual object still wins. |
| `processEvery` | `number \| string` | | How often the registry worker looks for due work. The same as calling `processEvery()` before `start()`. See [Registry polling](#registry-polling). |

The context has these members:

| Member | What it does |
|---|---|
| `namespace` | The context's namespace. |
| `driver` | The backend everything here shares. |
| `logger` | The context's logger. |
| `driverConfig` | The config form of the backend, if the context was built from one. |
| `runners` | The context's [`BunRunnerManager`](#bunrunnermanager). |
| `queue(name, opts?)` | The queue by that name. |
| `worker(name, processor, opts?)` | Creates a worker on a queue. |
| `runner(opts)` | Creates a runner. |
| `define(name, handler, opts?)` | Defines a job by name. |
| `defineBackoff(name, fn)` | Registers a named backoff strategy. |
| `definitions()` | Every defined name, with how to run it. |
| `schedule(name, data?)` / `run(...)` / `process(...)` | Three names for the same method; each returns a builder. |
| `now(name, data?, opts?)` | Adds a defined job to run now. |
| `create(name, data?)` | Returns a [draft](#saved-drafts), which is added only when saved. |
| `processEvery(interval)` | Sets how often the registry worker looks for due work. See [Registry polling](#registry-polling). |
| `start(workerOpts?)` | Starts consuming the defined jobs. |
| `stop({ force?, timeout? })` | Stops consuming, letting in-flight jobs finish. |
| `drain({ delayed? })` | Drops pending jobs from the registry's queue. |
| `notifier(opts?)` | Opens a [`JobsNotifier`](#events-and-jobsnotifier). |
| `listQueues()` / `listRunners()` | Queue names and runner ids the backend knows about in this namespace. |
| `purge()` | Deletes everything in this namespace, and nothing outside it. |
| `close({ timeout? })` | Stops runners and workers, closes queues, then the driver if the context built it. |

`jobsFromContext(ctx)` builds a `BunJobs` inside a runner's handler, on the
runner's namespace and backend. It works in every execution mode:

- in-process, it reuses the runner's driver instance;
- in a child process or `Worker`, it builds a driver from `ctx.driverConfig`.

### Defining and adding jobs

```ts
jobs.define("sendEmail", async (job) => send(job.data), { attempts: 5, concurrency: 3 });

await jobs.start(); // one worker; dispatches on job.name
await jobs.now("sendEmail", { to });
```

The options given to `define` are defaults for every job of that name, wherever
it is added from. `concurrency` is stored as the name's limit when you call
`start()`.

Defining a name again replaces the earlier definition. Adding a name that
was never defined throws `ConfigError`. A worker that claims a name its process
does not define fails the job, leaving it for a deployment that does define
it.

### Builder methods

Nothing is added until `start()`, which returns the `Job`.

```ts
await jobs.schedule("sendMails").every("2 days").withData(list).start();
await jobs.run("sendMail", mail).in("5 minutes").attempts(3).start();
await jobs.process("report").on("2nd december 2026 at 9am").start();
await jobs.schedule("sync").every("0 */6 * * *").tz("Europe/London").limit(10).start();
await jobs.schedule("sendMails").withOptions({ every: "2 days", data: list, attempts: 5 }).start();
```

| Method | Meaning |
|---|---|
| `withData(data)` | Sets the payload. |
| `every(interval)` | Repeats the job. Accepts milliseconds, a duration (`"2 days"`, `"every 2 days"`), words (`"daily"`, `"every monday"`), a cron expression, or a phrase with a window (`"every day from 1 dec 2026 until 31 dec"`). |
| `on(when)` | Runs at a moment: a `Date`, epoch ms, or words. On a repeating job, this is when the series begins. |
| `in(delay)` | Runs after a delay: `"5 minutes"` or milliseconds. |
| `startingAt(when)` / `endingAt(when)` | The window of a repeating series. `on()` and `startingAt()` set the same start, so whichever was called last wins. |
| `repeatEvery(interval, opts?)` | Repeats the job, replacing the whole series description. Options from an earlier call are dropped unless given again. |
| `limit(n)`, `tz(zone)`, `catchUp(on?)`, `immediately(on?)` | Repeat options. |
| `priority(n)`, `attempts(n)`, `timeout(ms \| "30 seconds")`, `backoff(b)` | Job options. |
| `unique(id)` | The job's id and idempotency key. On a repeating job, it names the series instead. |
| `deadLetter(queue)`, `debounce(id, ttl)`, `throttle(id, ttl)`, `keepLogs(n)` | Job options. |
| `withOptions(obj)` | All of the above as one object. It accepts builder names and raw `JobOptions` names. Giving both `in` and `delay`, `on` and `runAt`, or `unique` and `jobId` throws. |
| `start()` | Adds the job. |

Example:
[`03-job-registry/builder-with-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/03-job-registry/builder-with-options.ts).

### Saved drafts

`create()` describes a job in Agenda's shape. The job is added only when you
call `save()`, which returns the `Job`.

```ts
const draft = jobs
  .create("sendEmail", { to: "ops@example.com" })
  .unique("welcome-7")
  .priority(1)
  .schedule("in 10 minutes");

export const job = await draft.save();
```

| Method | Meaning |
|---|---|
| `withData(data)` | Sets the payload. |
| `unique(id)` / `jobId(id)` | The job's id and idempotency key. On a repeating job, it names the series instead. |
| `schedule(when)` | Runs at a moment: a `Date`, epoch ms, or words. On a repeating job, this is when the series begins. It wins over `delay`. |
| `delay(ms \| "5 minutes")` | Runs after a delay. |
| `repeatEvery(interval, opts?)` | Repeats the job, as the builder's `repeatEvery` does. |
| `priority(n)`, `attempts(n)`, `backoff(b)`, `timeout(ms \| "30 seconds")` | Job options. |
| `removeOnComplete(r)`, `removeOnFail(r)`, `keepStacktraces(n)`, `keepLogs(n)` | Retention. |
| `deadLetter(queue)`, `debounce(id, ttl)`, `throttle(id, ttl)` | Job options. |
| `withOptions(obj)` | The builder's `withOptions`. |
| `save()` | Adds the job. |
| `isSaved`, `job` | Whether a save has succeeded, and the job it returned. |

- The definition's options sit under whatever the draft sets, with the same
  precedence as `now()`.
- A name with no definition throws `ConfigError` at `create()`.
- A combination the queue refuses throws `ConfigError` at `save()`, and
  nothing is written. Examples: `repeatEvery` with `debounce` or
  `throttle`, or `unique` with either.
- **Saving twice.** A second `save()` with nothing changed returns the job
  the first one returned and writes nothing, even while the first is still in
  flight. `save()` throws `ConfigError` if any setter was called since a
  save began, even one that set the value it already had. To change the
  stored job, use its own methods, or `create()` another draft.
- A save that threw was not saved and can be retried. Give `unique(id)` if a
  retry must never add a second job.
- It differs from Agenda in three ways: `priority` is lower-runs-first,
  `unique` takes an id, and `repeatEvery` runs immediately only with
  `immediately: true`.

Examples:

- [`03-job-registry/jobs-create.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/03-job-registry/jobs-create.ts)
- [`10-options/draft-and-process-every.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/draft-and-process-every.ts)

### Registry polling

`jobs.processEvery(interval)` sets how often the registry worker looks for
due work. The interval is milliseconds or a duration such as `"30 seconds"`,
at most 2,147,483,647ms; a longer one throws `ConfigError`. The
`processEvery` option to `BunJobs` does the same before `start()`.

- It applies to a running worker and to every later `start()`.
- Explicit `pollInterval` or `maxBlock` passed to `start()` win over it.
  A later `processEvery()` call wins over both.
- It sets the worker's `pollInterval`, and with it the delayed-job promotion
  sweep, which still runs at least once a second. On a blocking driver it
  also sets `maxBlock`.
- The stalled-job sweep and housekeeping keep their own intervals.

A new job still wakes an idle worker at once on every driver. The interval
bounds only work that nothing announces, such as a delayed job coming due, and
it controls idle load rather than latency.

What happens to the wait in progress depends on the driver:

| Driver | Current wait | A lower interval takes effect |
|---|---|---|
| SQL, MongoDB, file (polling) | cut short | at once |
| Redis, memory (blocking) | left to finish | from the next wait |

A blocking pop cannot be called off, and a pop abandoned mid-wait would
swallow the wake a new job sends. On Redis a single block is also capped by the
driver's `maxBlockSeconds`.

Examples:

- [`03-job-registry/process-every.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/03-job-registry/process-every.ts)
- [`10-options/draft-and-process-every.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/draft-and-process-every.ts)

### Dates in words

Durations (`"90s"`, `"1h 30m"`, `"2 weeks"`) and cron expressions are parsed by
the package itself. **Dates** in words (`"tomorrow at 9am"`, `"next monday"`)
need `chrono-node` (`CHRONO_VERSION_RANGE` is `>=2.7.0 <3`), which is loaded
the first time a phrase needs it.

To read dates that chrono does not understand, or to avoid installing it, pass
a `dateParser` to `BunJobs` or `BunQueue`. A parser is synchronous and
implements `parse(text, reference, options)`, plus optionally `parseDate`.
Parsers are checked with `assertDateParser` when the queue is built.

Phrases are read when the job is added, so `"starting tomorrow"` means tomorrow
relative to that moment.

Examples:

- [`04-scheduling/human-schedules.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/04-scheduling/human-schedules.ts)
- [`04-scheduling/custom-date-parser.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/04-scheduling/custom-date-parser.ts)

## Scheduling and repeatable jobs

`repeat` makes a job one occurrence of a series. When an occurrence completes,
the next one is scheduled.

```ts
await queue.add("digest", {}, { repeat: { cron: "0 9 * * 1", tz: "Europe/London" } });
await queue.add("poll", {}, { repeat: { every: 30_000, immediately: true } });
await queue.add("report", {}, { repeat: { every: "1 hour", startAt: "tomorrow at 9am", limit: 24 } });
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `cron` | `string` | | Five-field cron, or six-field with seconds first. |
| `tz` | `string` | | The IANA time zone the cron expression is read in. |
| `every` | `number \| string` | | Milliseconds, a duration, a cron expression, or a phrase that may also name a start and end. Dates in the phrase fill `startAt` and `endAt` only when those are not given. |
| `startAt` / `endAt` | `Date \| number \| string` | | The window, as a date, epoch ms, or words. |
| `limit` | `number` | | Stop after this many occurrences. |
| `key` | `string` | derived from the options | Identifies the series. Set it when re-adding a series must update it rather than create a new one. |
| `immediately` | `boolean` | | Run once as soon as the series is created. |
| `catchUp` | `boolean` | `false` | If the series fell behind while nothing was consuming, replay every missed occurrence, one per completion. When off, the series skips to the next real occurrence. |

Occurrence ids are derived from the series key and the due time
(`repeatJobId`), so several producers adding the same series schedule each
occurrence only once. A `jobId` on a repeating job is ignored. Use `key`
instead; `unique()` in the builder maps to it.

Every worker's maintenance heals repeat series.

Cron helpers:

- `validateCron(expr, { tz? })`
- `parseCron(expr, { tz? })`
- `nextCronDate(expr, from?, { tz? })`

Schedule helpers, shared with the runner:

- `normalizeSchedule(input)`
- `nextFireDate(schedule, from?)`

Examples:

- [`04-scheduling/repeatable-jobs.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/04-scheduling/repeatable-jobs.ts)
- [`04-scheduling/cron-helpers.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/04-scheduling/cron-helpers.ts)

## Debounce and throttle

```ts
// Many edits, one reindex: the latest data, 30 seconds after the last add.
await queue.add("reindex", { doc }, { debounce: { id: doc.id, ttl: "30 seconds" } });

// At most one digest per user per hour.
await queue.add("digest", { userId }, { throttle: { id: `digest:${userId}`, ttl: "1 hour" } });
```

- **Debounce** keeps one pending job per `id`. While that job has not started,
  another add replaces its data and pushes its run time back to `ttl` from
  now, then emits `debounced`. The first add's other options stay. Once the
  job has started, the next add creates a new job.
- **Throttle** adds at most one job per `id` per `ttl`. An add inside the
  window adds nothing, returns the job that opened the window, and emits
  `throttled`.
- `ttl` is milliseconds or a duration. Neither option combines with `repeat`,
  `jobId`, or the other option, and neither is allowed in a flow.

Examples:

- [`05-flow-control/debounce.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/05-flow-control/debounce.ts)
- [`05-flow-control/throttle.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/05-flow-control/throttle.ts)

## Flows

A flow is a job that runs once the jobs it waits on (its children) have
settled. Children may be in any queue of the same namespace, and may have
children of their own.

```ts
const reports = new BunQueue("reports", { namespace, driver });

export const flow = await reports.addFlow({
  name: "monthly-report",
  data: { month: "2026-08" },
  children: [
    { name: "orders", data: {}, queue: "fetch" },
    { name: "refunds", data: {}, queue: "fetch", opts: { ignoreFailure: true } },
  ],
});

export const worker = new BunQueueWorker("reports", async (job) => {
  const values = await job.getChildrenValues(); // { "fetch:<id>": result, ... }
  const failures = await job.getChildrenFailures(); // ignored failures, as Errors
  return summarise(values, failures);
}, { namespace, driver });
```

A `FlowNode` has these fields:

- `name`
- `data`
- `opts?`
- `queue?`, which defaults to the parent's queue, or for the top of the flow to
  the queue `addFlow` is called on
- `children?`

`addFlow` returns the tree it added, `{ job, children: [...] }`, with the
parent in `waiting-children` until its children settle.

- **Adding.** The whole tree is checked first. A `queue:id` that appears twice,
  or a child with the id of one of its ancestors, throws a `ConfigError` and
  nothing is written. `repeat`, `debounce` and `throttle` are not allowed in a
  flow.

  Jobs are then added children first, each parent after its children, so a
  parent's `createdAt` follows every child it lists. A child that finishes
  before its parent exists is delivered as soon as the parent arrives.

  Running the same `addFlow` again with the same ids adds only what is
  missing. A job whose `jobId` already exists keeps the children it has.
  `added` is published on each job's own queue.
- **Results.** `job.getChildrenValues()` returns each completed child's return
  value, keyed `queue:id`. `job.getChildrenFailures()` returns the failures of
  children marked `ignoreFailure`.
- **Failing by default.** A child that fails for good fails its parent. The
  parent goes to `dead` with a `ChildFailedError` naming the child, and that
  failure travels on up the flow.

  A buried parent gets what any dead job gets: `failed` and `dead` events, its
  dead-letter queue, and its `removeOnFail` when it is the top of the flow.
  With `removeOnFail: true`, a buried top-level parent is removed, so it cannot
  be retried. A nested parent's retention waits until its own parent has
  recorded it, like any child's.

  A child marked `ignoreFailure` lets its parent carry on.
- **Retrying a buried parent** (with `queue.retry`, `retryJobs`, `retryAll` or
  `job.retry()`) returns it to `waiting-children`, waiting on every child it
  has no outcome for.

  Retry the failed child too, in either order. A child that completes while
  its parent is still buried has its result kept there. A failure that has
  already buried the parent once does not bury the retried parent again.

  A failed child that has since been removed counts as unsettled, so
  maintenance fails the parent again (see below).
- **Retention waits for delivery.** A child's `removeOnComplete` or
  `removeOnFail` never removes it before its parent has recorded its outcome.
  This includes a count or TTL applied by any other job.

**Healing.** Recording a child on its parent and applying the child's
retention are two separate steps, and both are safe to repeat. A delivery that
fails is retried within a few seconds by the worker that started it. Workers'
maintenance (every `stalledInterval`) finishes whatever a crash left half done:

- a parent waiting on a child that settled without the parent knowing is told
  again;
- a child that finished and was never recorded is delivered again;
- a parent listing a child that does not exist counts that child as failed,
  once the parent is older than the grace period (one minute);
- a child whose parent does not exist is released to its own retention, once
  it finished more than the grace period ago.

Each pass reads at most a page of parents, a hundred of their children and a
page of finished jobs. The next pass resumes where it stopped, so a queue of
any size is covered over successive passes.

**Backend notes:**

- **MongoDB** needs 4.2 or later for flows.
- **SQL** stores a flow in one `flow` column. A table created before flows
  needs [`syncSchema()`](#schema-sync) before a flow can be added, and the
  error says so.

  Recording a child rewrites its parent's whole flow document, so on SQL a
  very wide flow costs O(n²) over its n children. Measured on Postgres, that
  was 1.4ms per record on a 100-child parent and 3.1ms on a 2,000-child one.
  Keep very wide fan-outs to nested flows, or use Redis or MongoDB, which
  update one entry per record.

## Reading a queue: search, totals, workers and throughput

What a dashboard needs, on every driver:

```ts
// Narrow by exact name (one or several) and search id and name, ignoring case.
export const failed = await mail.list("dead", { name: "sendEmail", search: "acme" });

// A page and how many matched in all.
export const { jobs: page, total } = await mail.page(["waiting", "delayed"], {
  offset: 40,
  limit: 20,
});

// Several jobs by id: in the order asked, `null` for one that does not exist.
export const picked = await mail.getJobs(["a1", "b2", "c3"]);

// The workers consuming the queue right now, in any process.
export const workers = await mail.listWorkers();

// Completed jobs and failed attempts per minute, current minute last.
export const { buckets, completed } = await mail.getThroughput({ minutes: 15 });

// Every queue in the namespace with its counts and pause flag, and every worker.
export const queues = await jobs.getQueueSummaries();
export const everyone = await jobs.listWorkers();
```

Runnable on any backend:
[`searching-and-paging.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/searching-and-paging.ts)
for the filters, totals and `getJobs`, and
[`workers-and-throughput.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/workers-and-throughput.ts)
for workers, throughput and a queue dashboard. The
[`read-apis.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/read-apis.ts)
tour asserts every option and edge below, including each driver fallback.

**Search and name filters.** `name` is exact — case and accents count — and an
empty array matches nothing. `search` is a case-insensitive substring of the
job's **id or name**, taken literally (`%`, `_`, `*`, quotes and regular
expression characters match themselves), and never looks at the payload. Case
is folded for ASCII everywhere; beyond ASCII it follows the engine, and SQLite
folds ASCII only. Both narrow the jobs before the page is cut, so `offset`
counts matches. Without either, `list()` is exactly the read it always was.

No index serves a substring, and a name index would cost every insert a
write, so a filter reads **the jobs in the states asked for** — pair it with a
small state, or a name, on a large backlog:

| Driver | A filtered page | Its total | `getJobs` |
|---|---|---|---|
| memory | one pass over the queue | the same pass | map lookups |
| file | reads each record in those states, 16 at a time, stopping once the page is full | reads every one | parallel reads |
| sql | `LOWER(id)`/`LOWER(name) LIKE` within the `(ns, queue, state)` index range | `COUNT(*)`, same conditions | one `IN (…)` per 500 ids |
| mongodb | escaped case-insensitive regex on `id`/`name`, within the same index range | `countDocuments` | one `find` |
| redis | walks those sets in chunks of 500; names are cut from each job's hash in Lua, so payloads never leave the server | walks every one | pipelined `HGETALL` |

Unfiltered totals are counts on every driver: `COUNT(*)`, `ZCARD`, a directory
listing.

**Workers.** Each worker writes a heartbeat record — id, host, pid,
concurrency, jobs in flight, paused, started, last heartbeat — when it starts,
every `reportInterval` (10 seconds by default; `0` turns it off), and on pause,
resume or a concurrency change. **Never per job.** A record lapses three
intervals after its last write, so a worker that dies drops out of the list
within 30 seconds; one that closes removes its record at once, and one that
never ran touches nothing. Lapsed records are removed whenever any worker on
the queue reports, not only when somebody lists. The record is a row in the
`workers` table on SQL, a `kv` document on MongoDB, a hash plus an
expiry-scored sorted set on Redis, and a file on the file driver. On Redis the
registry's own lifetime is relative (`PEXPIRE`), so a client whose clock runs
behind the server cannot expire it.

`queue.listWorkers()` and `jobs.listWorkers()` behave alike: on a driver with no
worker registry both keep records in queue state, and on one with neither both
throw `NotSupportedError`.

**Aggregates.** `jobs.getQueueSummaries()` lives on `BunJobs` because it is a
question about the namespace, which the context owns; a `BunQueue` knows only
itself. Counting is one grouped query on SQL and MongoDB and one count per queue
elsewhere, plus one pause read per queue.

**Throughput.** Counted by the driver as jobs finish, so it covers every worker
in every process and outlives retention removing the jobs themselves. `failed`
counts every failure: each failed attempt, including one that will be
retried (a job retried twice before dying counts three), each job the stalled
sweep buries, and each flow parent a child's failure buries. Minutes are kept
for a day. What a completion costs, per driver:

| Driver | Where the count happens | Added per job |
|---|---|---|
| memory | in `completeJob`/`failJob` | a `Map` update |
| redis | inside the existing `COMPLETE`/`FAIL` script | one `HINCRBY` (and a `PEXPIREAT` once a minute); no new keys in the script's `KEYS` |
| sql (postgres) | inside the completion or failure statement itself, as a data-modifying CTE | one counter-row upsert in the same round trip, on one of eight counter rows the process takes in turn, so settles running at the same time rarely share a row |
| sql (mysql, mariadb, sqlite), mongodb, file | gathered in memory, written once a second per process | a `Map` update, no I/O |

The last row is the honest trade for engines that cannot touch two tables in
one statement: a count reaches the backend up to a second after the job
finished, and a process that dies hard loses at most that second. A reader in
the same process always sees its own counts — reading writes them first — and
a worker or queue writes what is pending when it closes, even on a driver it
does not own. A write that fails part-way is retried for the counts that did
not land, never for the ones that did.

Burials by the stalled sweep and by a failed child happen in maintenance rather
than per job, so they are counted in the same script on Redis, in place on
memory, and through that once-a-second write everywhere else, Postgres
included.

SQL gets two tables for this, `workers` and `metrics`, created on connect like
the rest. Nothing is added to `jobs`, so an existing install needs no
`syncSchema`.

**Custom drivers.** Every method behind these is optional on the contract. A
driver without `findJobs` is paged through `listJobs` and filtered; without
`getJobs`, read one id at a time; without the worker methods, workers are kept
in queue state; without `countJobsByQueue`, counted queue by queue; and when
`findJobs` answers without a total, the total is counted by the scan. A driver
that gathers counts in memory implements `flushThroughput`, which a closing
worker or queue awaits. Only throughput has no fallback — counts that were
never kept cannot be rebuilt.

## Isolated processors

Give a worker a processor **file** instead of a function, and `isolation`
decides where each attempt runs:

- `"in-process"` (the default) imports the file once and calls it on the
  worker's thread.
- `"worker"` runs each attempt in a fresh `Worker`: a separate JavaScript
  context in the same process, which can be terminated.
- `"spawn"` runs each attempt in a child process. This is the only mode where a
  processor that ignores its signal is certain to be killed.

```ts
// processors/resize.ts
import { defineProcessor } from "@kingsleyweb/bun-jobs";

export default defineProcessor<{ path: string }, { width: number }>(async (job, ctx) => {
  await job.log(`resizing ${job.data.path}`);
  return await resize(job.data.path, ctx.signal);
});
```

```ts
export const worker = new BunQueueWorker("images", new URL("./processors/resize.ts", import.meta.url), {
  namespace,
  driver,
  isolation: "spawn",
  isolationOptions: { closeTimeout: 2_000, spawn: { env: { SHARP_CONCURRENCY: "1" } } },
});
```

`isolationOptions` accepts:

| Option | Default | Meaning |
|---|---|---|
| `closeTimeout` | `5000` | After asking the processor to stop, how long it has before being terminated. |
| `killTimeout` | `2000` | After `SIGTERM`, how long before `SIGKILL` (spawn only). |
| `spawn` | | `SpawnOptions`, as in the [runner options](#runner-options). |
| `worker` | | `WorkerOptions`, as in the [runner options](#runner-options). |

Only a file can be isolated: an `isolation` other than `"in-process"` with a
function processor throws `ConfigError`.

The worker keeps the driver, so a child receives an `IsolatedJob`: a plain
object with every public member of `Job`.

- **Through the worker**, these work: `job.log`, `job.updateProgress`,
  `job.extendLock`/`touch`, `job.getChildrenValues`, `job.getChildrenFailures`
  and `ctx.heartbeat`. Every read-only field is present, including `parent`.
- **Unavailable**, because they would change the stored job directly, and they
  reject with an error saying so: `getLogs`, `updateData`, `setPriority`,
  `reschedule`, `remove`, `retry`, `promote` and `refresh`.

A reply on the job channel that is malformed rejects with a `ProtocolError`.
Errors thrown in a child are rebuilt by name, so `UnrecoverableJobError` still
sends the job to `dead`.

Examples:

- [`02-queues/isolated-processors.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/isolated-processors.ts)
- [`10-options/worker-isolation.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/worker-isolation.ts)

## BunRunner

A runner runs one handler file, whose default export is a `RunnerHandler`
typed with `defineHandler`. Nothing starts in the constructor; call `start()`.

Examples:

- [`07-runner/`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/07-runner)
- [`10-options/runner-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/runner-options.ts)

### Runner options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `id` | `string` | required | Identifies the runner within its namespace. |
| `namespace` | `string` | required | Namespace. |
| `name` | `string` | `id` | Display name. |
| `file` | `string \| URL` | required | The handler file, resolved once, relative to `spawn.cwd` or the cwd. |
| `schedule` | `ScheduleInput` | none (manual only) | A cron string (five or six fields), interval ms, a `Date`, `{ cron, tz }`, `{ every, anchor }` or `{ at }`. |
| `executionMode` | `"spawn" \| "worker" \| "in-process"` | `"spawn"` | Where runs execute. |
| `runMode` | `"single" \| "parallel"` | `"single"` | `single` holds a cluster-wide lock. `parallel` lets runs overlap up to `maxConcurrency`, with no lock. |
| `queueRuns` | `boolean` | `false` | Queue a trigger that cannot start now, instead of dropping it. |
| `maxQueuedRuns` | `number` | `100` | Trigger queue cap. |
| `maxConcurrency` | `number` | unlimited | Concurrency cap in `parallel` mode. |
| `timeout` | `number` | `0` (none) | Per-run timeout in ms. |
| `closeTimeout` | `number` | `5000` | Grace after asking a run to stop, before `SIGTERM`. |
| `killTimeout` | `number` | `2000` | Grace after `SIGTERM`, before `SIGKILL`. |
| `waitToExit` | `boolean` | `true` | Keep the process alive for the schedule. `false` unrefs timers and children. |
| `lockTtl` | `number` | `30000` | How long the single-run lock lives. |
| `heartbeatInterval` | `number` | `lockTtl / 3` (min 1000) | How often the lock is renewed. |
| `onLockLost` | `"abort" \| "continue"` | `"abort"` | What to do when the lock is lost mid-run. |
| `keepHistory` | `number` | `50` | Run records kept. |
| `maxResultBytes` | `number` | `16384` | Cap on a stored run result. |
| `driver` | `JobsDriver \| DriverConfig` | a new memory driver | Where state lives. Memory cannot coordinate across processes. |
| `childDriver` | `DriverConfig` | `driver`, when that is a config | Handed to handlers as `ctx.driverConfig`. |
| `logger` | `LoggerLike` | no-op | Logger. |
| `args` | `TArgs` | | Default arguments for scheduled runs. |
| `autostart` | `boolean` | `false` | Start on construction. |
| `startPaused` | `boolean` | `false` | Start paused. |
| `syncInterval` | `number` | `30000` | How often to re-read the shared paused flag and schedule. |
| `forwardLogs` | `boolean` | `false` | Forward a child's `ctx.logger` calls to the parent's `log` event. |
| `publish` | `boolean` | `false` | Publish `started`, `succeeded`, `failed`, `timeout`, `killed`, `queued` and `skipped` for other processes. |
| `publishGate` | `() => Promise<void>` | | Awaited before each publish. |
| `remoteControl` | `boolean` | `false` | Subscribe to `control` events, so a change made through `BunRunnerManager.remote()` applies within the driver's event latency instead of at the next `syncInterval`. Off by default, because a subscription holds a poll, a change stream or a pub/sub connection per runner. |
| `spawn` | `SpawnOptions` | | `cwd`, `env`, `args`, `execPath`, `stdout`/`stderr` (`"inherit"` by default, or `"pipe"`/`"ignore"`), and `startTimeout` (`10000`). |
| `worker` | `WorkerOptions` | | `smol`, `name`, `env`, `argv`. |
| `inProcess` | `InProcessOptions` | | `reloadOnEachRun`: re-import the file on every run. This is for development, and it leaks one module instance per run. |

### Triggers and run modes

`trigger({ args?, force?, source? })` reports what happened instead of
throwing. It resolves to one of these outcomes:

- `{ outcome: "started", runId }`;
- `{ outcome: "queued", position }`;
- `{ outcome: "skipped", reason }`, where `reason` is `paused`, `busy`,
  `lock-held`, `max-concurrency`, `queue-full` or `stopped`.

`force` runs even while paused. A manual trigger on a stopped runner throws
`RunnerStoppedError`.

In `single` mode, the lock lives in the driver, so one run happens at a time
across every process sharing the backend. Queued triggers are also stored in
the driver, so they survive the lock holder crashing, and whoever holds the
lock drains them when its run finishes.

`pause()` and `resume({ triggerNow? })` are persisted flags, shared across
processes. `updateSchedule(schedule)` replaces and persists the schedule.

Examples:

- [`07-runner/manual-trigger.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/manual-trigger.ts)
- [`07-runner/single-run-lock.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/single-run-lock.ts)

### Handlers, messages and kills

A handler receives a `RunContext` with these fields:

- `runId`
- `runnerId`
- `runnerName`
- `namespace`
- `attempt`
- `source`: `schedule`, `manual`, `queued` or `resume`
- `mode`
- `startedAt`
- `deadline`
- `args`
- `signal`
- `logger`
- `progress(value)`
- `send(message)`
- `onMessage(listener)`
- `driverConfig`
- `driver`, in-process only

Messages cross the process boundary as JSON in `spawn` and `worker` mode:

- `runner.send(message, runId?)` delivers to `ctx.onMessage`;
- `ctx.send(message)` surfaces as the runner's `message` event.

`kill(runId?, { force?, reason? })` aborts the run's signal, then escalates to
`SIGTERM` after `closeTimeout` and to `SIGKILL` after `killTimeout`. `force`
skips to the end of that escalation.

An in-process run can only be stopped through its signal. If it ignores the
signal, it may be reported `detached`.

`stop({ timeout?, force? })` stops the ticker, waits for runs in flight
(killing them at `timeout`), releases the lock, and closes an owned driver.

Runner events:

- `scheduled`
- `started`
- `progress`
- `message`
- `log`
- `output`, when the child's streams are piped
- `finished`
- `failed`
- `timeout`
- `killed`
- `skipped`
- `queued`, `dequeued`
- `lockLost`
- `paused`, `resumed`
- `stopped`
- `error`

Examples:

- [`07-runner/messages-progress-kill.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/messages-progress-kill.ts)
- [`07-runner/execution-modes.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/execution-modes.ts)
- [`07-runner/runner-enqueues-jobs.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/runner-enqueues-jobs.ts)

### Introspection

- `history(limit?)` returns run records, newest first.
- `stats()` returns lifetime counters (`success`, `failed`, `timeout`,
  `killed`, `skipped`, `queued`, `total`). `resetStats()` zeroes them.
- `info()` returns a snapshot that merges this process's view with the
  driver's. Its `isRunning` and `runningOn` (`{ host, pid, runId, since }`)
  describe the whole cluster.
- `status`, `activeRuns`, `schedule` and `nextRunAt()` describe this instance.

Example:
[`07-runner/scheduled-runner.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/scheduled-runner.ts).

### BunRunnerManager

A registry of the runners in one namespace. `jobs.runners` is one.

| Member | What it does |
|---|---|
| `add(runnerOrOptions)` | Registers a runner, or builds one using the manager's namespace, driver and logger. A duplicate id, or a runner from another namespace, is a `ConfigError`. |
| `get(id)` | Returns one registered runner. |
| `list()` | Returns every registered runner. |
| `size` | How many runners are registered. |
| `remove(id, { stop = true })` | Unregisters a runner, stopping it first unless told not to. |
| `startAll()` | Starts every registered runner. |
| `stopAll({ timeout?, force? })` | Stops every runner. Failures are collected into one `AggregateError`. |
| `info()` | Returns a snapshot of every registered runner. |
| `discover()` | Runner ids the backend knows about, including other processes' runners. |
| `remote(id)` | A `RemoteRunner` that controls a runner registered by any process sharing the driver and namespace. Rejects with `RunnerNotFoundError` for an id that is neither registered here nor known to the backend. |

`get()`, `list()` and `info()` only see this process's runners. `remote(id)`
reaches the others, through what every runner already keeps in the driver:
its state, its lock, its history and its trigger queue.

```ts
const cleanup = await jobs.runners.remote<CleanupArgs, CleanupResult>(
  "cleanup",
);

await cleanup.pause();
await cleanup.updateSchedule({ cron: "0 3 * * *", tz: "UTC" });
await cleanup.resume();
await cleanup.trigger({ args: { olderThanDays: 30 } }); // { outcome: "queued", position: 1 }

const info = await cleanup.info(); // isPaused, isRunning, runningOn, queuedTriggers, ...
const [lastRun] = await cleanup.history(1);
const stats = await cleanup.stats();
console.log(info.runningOn?.host, lastRun?.status, stats.failed);
```

How each call reaches the process that owns the runner:

| Call | What it does | When the owner acts on it |
|---|---|---|
| `info()` | Reads the persisted configuration, paused flag and schedule, the lock (`runningOn`: host, pid, run id, since when), the queue depth, the counters and the last run. | Nothing to act on. |
| `pause()`, `resume()` | Write the shared paused flag. | At its next sync (`syncInterval`, 30s by default). With `remoteControl: true`, within the driver's event latency: about 25ms on the file driver, 50ms on SQL and MongoDB, immediately on Redis and memory. |
| `updateSchedule(schedule)` | Validates the schedule, then writes it. | Same as `pause()`. The owner re-arms its ticker. |
| `trigger({ args?, force? })` | Pushes a trigger onto the runner's queue in the driver, whatever `queueRuns` says, up to the owner's `maxQueuedRuns`. Resolves to `queued`, or `skipped` with `paused` or `queue-full`. | An idle owner drains it at its next sync, or at once with `remoteControl`. A busy one drains it when its run finishes. The run has source `queued` and the owner's default `args` when none are given. |
| `history(limit?)`, `stats()` | Read the shared history and counters. | Nothing to act on. |

The calls publish a `control` runner event, whether or not the runner
publishes its own. An owner started with `remoteControl` re-reads its state
when it hears one. Every owner also re-reads at each sync and drains triggers
queued while it was idle. It does the same on `start()`, so a trigger queued
while no owner was running waits for one to start.

Limits:

- **There is no remote kill.** Only the process executing a run can stop it,
  with `BunRunner.kill()`. `RemoteRunner` has no `kill` or `send`.
- The pause is checked when a trigger is requested. A queued trigger does not
  record `force`, so the owner runs whatever it drains, paused or not. The
  lock holder's own drain has always done the same.
- A remote controller cannot tell whether any owner is alive. `info().isRunning`
  comes from the lock.
- For a runner registered in this process, `isLocal` is `true` and every call
  delegates to it. A local `trigger()` may then start the run at once instead
  of queuing it, and `info().local` adds the instance's own status.

Examples:

- [`07-runner/manager.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/manager.ts)
- [`07-runner/remote-control.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/remote-control.ts)

## Events and JobsNotifier

Queues, workers and runners are typed emitters.

- Local listeners hear what that instance did.
- To hear another process, the producing side must **publish**. Set
  `publish: true` on it, or `publishEvents` on its `BunJobs`.
- The listening side must **subscribe**. A `BunQueue` can set
  `subscribe: true`, or you can open a `JobsNotifier`.

`JobsNotifier` is one stream of every queue and runner event in a namespace,
from whichever process published it:

```ts
const notifier = await jobs.notifier({ queues: ["mail"], runners: "all" });

notifier.on("event", (event) => {
  if (event.kind === "runner" && event.type === "failed") alert(event.target, event.payload.error);
});

for await (const event of notifier) {
  if (event.kind === "queue" && event.type === "completed") {
    console.log(event.target, event.payload.id, event.payload.returnValue);
  }
}
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `queues` | `"all" \| string[]` | `"all"` | Which queues to follow. |
| `runners` | `"all" \| string[]` | `"all"` | Which runners to follow. |
| `discoveryInterval` | `number` | `2000` | How often to look for new queues and runners, with `"all"`. |
| `bufferSize` | `number` | `10000` | How many events an async iterator buffers for a slow consumer before dropping the oldest. `dropped` counts the losses. |

- **Constructing and lifecycle.** Construct a notifier directly with
  `new JobsNotifier(driver, namespace, options)`, then call `start()`.
  `close()` ends it and any iterators.
- **Members.** `follow(kind, target)` starts following a queue or runner
  before it exists, so nothing is missed, and for good. `following` lists
  the **live** subscriptions, as `<kind>:<target>`: a target whose subscribe
  is still in flight, or failed (reported as `error`), is not in it yet. The
  emitted events are `event`, `subscribed` and `error`.
- **Holding a target.** `hold(kind, target)` follows a queue or runner like
  `follow()`, but reference-counted: each `hold` needs its own
  `unfollow(kind, target)`, and the subscription is closed when the last
  holder lets go. It is for followers whose names come from outside — the
  live-events socket holds each `queue/<q>` and `runner/<r>` channel's target
  while a client is subscribed, since a client may name a queue that does not
  exist yet, or never will. What discovery, the configured `queues`/`runners`
  lists or `follow()` follow stays followed for good: `unfollow()` never drops
  it, and releasing something not held does nothing.
- **Event shape.** Each event is a `DriverEvent`, with fields `kind`, `type`,
  `ns`, `target`, `at`, `origin` and `payload`. A `switch` on `kind`, then
  `type`, narrows the payload.
- **Control events.** A runner event of type `control` (`payload.action`:
  `pause`, `resume`, `schedule` or `trigger`) is published by
  `BunRunnerManager.remote()` whenever it changes a runner. It is addressed
  to the runner's owners, which follow it with `remoteControl`; a notifier
  following that runner hears it too.
- **Discovery has a gap.** Anything a newly used queue published before the
  next discovery pass is missed. Name the queues and runners, or `follow()`
  them, to hear every event from the start. Objects created by the same
  `BunJobs` are followed the moment they are created.

Examples:

- [`02-queues/events.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/events.ts)
- [`09-integrations/live-dashboard.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/09-integrations/live-dashboard.ts)
- [`10-options/notifier.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/notifier.ts)

## Management API

`createJobsApi()` serves an HTTP API and a live-events WebSocket over a
`BunJobs` context, with OpenAPI 3.1 and AsyncAPI 3.0 documents describing
exactly what it routes — the backend a dashboard is written against.

Nothing is exposed by accident: every request passes an `authorize` hook you
supply, the routes are pruned by mode and by what the driver supports, and
mutating routes can be removed outright. It is an admin surface — mount it
behind your own authentication, never on the public internet.

```ts
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi } from "@kingsleyweb/bun-jobs";

const jobs = new BunJobs({ namespace: "shop", driver: { type: "redis", url }, publishEvents: true });
const app = new BunHttpAdapter();

const api = createJobsApi({
  jobs,
  basePath: "/admin/jobs",
  authorize: async (req, { mutation }) => {
    const session = await sessionFrom(req);
    if (!session) return { allow: false, status: 401 };
    return session.roles.includes(mutation ? "jobs:admin" : "jobs:read");
  },
});

app.use(api.basePath, api.router);   // HTTP
api.websocket?.attach(app);          // live events, same port
await app.listen(3000);
```

`api.openapi()` and `api.asyncapi()` return the documents as plain objects;
`api.routes` lists what was actually registered; `api.close()` releases what
the API opened — its sessions, its event notifier and a dedicated socket
server — and never the `BunJobs`, queues, runners or driver you passed in.

### Mounting

**A plain `BunRouter` under raw `Bun.serve`.** `upgrade()` answers `null` when
a request is not for the socket, so the host keeps its own routing:

```ts
const root = new BunRouter();
root.use(api.basePath, api.router);

Bun.serve({
  port: 3000,
  async fetch(req, server) {
    const answer = await api.websocket?.upgrade(req, server);
    if (answer !== null && answer !== undefined) return answer; // refused
    if (answer === undefined) return;                           // upgraded
    return root.fetch(req);
  },
  websocket: api.websocket!.handler,
});
```

**NestJS, without the module** — mount on the adapter, attach after `init()`:

```ts
const adapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, adapter);
const api = createJobsApi({ jobs: app.get(BunJobs), basePath: "/admin/jobs", authorize });
adapter.use(api.basePath, api.router);
await app.init();
api.websocket?.attach(adapter.getInstance());
await app.listen(3000);
```

Nest's `setGlobalPrefix` does not apply to this mount, and Nest guards, pipes
and interceptors do not run for these routes — use `authorize` and
`middleware` instead.

**NestJS, with the module** (`@kingsleyweb/bun-nest/jobs`) does the mounting,
attaching and shutdown for you:

```ts
import { BunJobsApiModule } from "@kingsleyweb/bun-nest/jobs";

@Module({
  imports: [
    BunJobsApiModule.forRootAsync({
      inject: [BunJobs, AuthService],
      useFactory: (jobs: BunJobs, auth: AuthService) => ({
        jobs,
        basePath: "/admin/jobs",
        authorize: (req, context) => auth.can(req, context),
      }),
    }),
  ],
})
export class AppModule {}
```

> **That subpath needs bun-jobs installed.** `@kingsleyweb/bun-nest` declares
> `@kingsleyweb/bun-jobs` as an *optional* peer, and both packages ship raw
> `.ts` — so a consumer compiles their sources. Importing
> `@kingsleyweb/bun-nest/jobs` without bun-jobs installed fails `tsc` with
> `TS2307` (three of them), which `skipLibCheck` cannot suppress, even though
> the import path itself resolves. Importing the bun-nest **barrel** without
> bun-jobs is clean — 0 errors — which is the point of keeping the module on
> its own subpath.

### Authorization

`authorize` is required — `createJobsApi` throws `ConfigError` without it,
unless you pass `allowUnauthenticated: true` (local development only, and it
warns on every start). It is asked once per request, before the handler runs,
and again per channel on the socket — and, on the broad channels `all`,
`queues` and `runners`, once per queue or runner an event comes from, with
`channel` plus that `queue` or `runner` (see
[Live events](#live-events)):

```ts
export type Authorize = (
  req: BunRequest,
  context: {
    action: JobsApiAction;
    mutation: boolean;
    transport: "http" | "ws";
    queue?: string;
    jobId?: string;
    jobIds?: readonly string[];
    runner?: string;
    channel?: string;
    route?: { method: string; path: string };
  },
) =>
  | boolean
  | { allow: true }
  | { allow: false; status?: 401 | 403; reason?: string }
  | Promise<boolean | { allow: true } | { allow: false; status?: 401 | 403; reason?: string }>;
```

Anything unrecognised — a forgotten `return`, a string — is a denial: failing
open is how an admin API becomes public. `readOnly: true` and an `actions`
allow-list are *static* limits applied before `authorize`, so no hook can
re-enable what configuration removed.

| Action | Kind | |
|---|---|---|
| `meta.read` | read | |
| `docs.read` | read | |
| `queues.list` | read | |
| `queues.read` | read | |
| `queues.pause` | mutation | |
| `queues.resume` | mutation | |
| `queues.drain` | mutation | |
| `queues.clean` | mutation | |
| `queues.limits` | mutation | |
| `metrics.read` | read | |
| `workers.list` | read | |
| `jobs.list` | read | |
| `jobs.read` | read | |
| `jobs.logs` | read | |
| `jobs.add` | mutation | off by default |
| `jobs.update` | mutation | off by default |
| `jobs.retry` | mutation | |
| `jobs.retryAll` | mutation | |
| `jobs.remove` | mutation | |
| `jobs.promote` | mutation | |
| `repeatables.list` | read | |
| `repeatables.remove` | mutation | |
| `definitions.list` | read | |
| `runners.list` | read | |
| `runners.read` | read | |
| `runners.trigger` | mutation | |
| `runners.pause` | mutation | |
| `runners.resume` | mutation | |
| `runners.kill` | mutation | |
| `runners.reschedule` | mutation | |
| `runners.resetStats` | mutation | |
| `events.connect` | read | |
| `events.subscribe` | read | |

**`actions` is an allow-list, not a list of extras.** Left unset, it
defaults to every action except `jobs.add` and `jobs.update`
(`JOBS_API_OPT_IN_ACTIONS`), which write payloads your handlers trust. Once
you pass it, *only* the actions it names are enabled: `actions: ["jobs.add",
"jobs.update"]` alone turns those two on and every other action — reads,
`meta.read` and `docs.read` included — off. To enable the two on top of the
defaults, list the defaults too:

```ts
import { JOBS_API_ACTIONS } from "@kingsleyweb/bun-jobs";

createJobsApi({ ...options, actions: [...JOBS_API_ACTIONS] }); // everything
```

`jobs.add` is further restricted to `addableNames` (by default, the names in
`jobs.definitions()`). The queue it names need not exist yet: the first job
added creates it, as `BunQueue.add` does. With `queues` set to a list, a
queue outside the list is still 404 `QUEUE_NOT_FOUND`.
`GET /meta/permissions` evaluates the whole table for the caller, so a UI can
hide what it may not do.

### Modes and pruning

`mode` selects which half is exposed — `"jobs"`, `"runner"` or `"both"`
(the default when both sources exist). One predicate prunes the router, both
documents and `/meta/permissions` together, so a route that is absent is
absent everywhere: wrong mode, a mutation under `readOnly`, an action outside
`actions`, a driver missing the methods the route needs, or a route that
needs a `jobs` source without one. A pruned route answers the API's JSON 404,
never a 405.

`/meta` reports what the backend supports (`features.logs`, `update`,
`limits`, `flows`, `search`, `workers`, `throughput`), so a UI can explain a
missing button rather than hide it silently.

### Routes

Every route below is registered only when its action is enabled and its
driver support is present. Paths are relative to `basePath`.

| Method | Path | Action | Mutation |
|---|---|---|---|
| GET | `/meta` | `meta.read` | no |
| GET | `/meta/permissions` | `meta.read` | no |
| GET | `/openapi.json` | `docs.read` | no |
| GET | `/asyncapi.json` | `docs.read` | no |
| GET | `/overview` | `metrics.read` | no |
| GET | `/queues` | `queues.list` | no |
| GET | `/queues/:queue` | `queues.read` | no |
| GET | `/queues/:queue/counts` | `queues.read` | no |
| POST | `/queues/:queue/pause` | `queues.pause` | yes |
| POST | `/queues/:queue/resume` | `queues.resume` | yes |
| POST | `/queues/:queue/drain` | `queues.drain` | yes |
| POST | `/queues/:queue/clean` | `queues.clean` | yes |
| GET | `/queues/:queue/limits` | `queues.read` | no |
| PUT | `/queues/:queue/limits` | `queues.limits` | yes |
| GET | `/queues/:queue/workers` | `workers.list` | no |
| GET | `/workers` | `workers.list` | no |
| GET | `/queues/:queue/throughput` | `metrics.read` | no |
| GET | `/queues/:queue/jobs` | `jobs.list` | no |
| POST | `/queues/:queue/jobs/lookup` | `jobs.read` | no |
| GET | `/queues/:queue/jobs/:id` | `jobs.read` | no |
| GET | `/queues/:queue/jobs/:id/logs` | `jobs.logs` | no |
| GET | `/queues/:queue/jobs/:id/children` | `jobs.read` | no |
| PATCH | `/queues/:queue/jobs/:id` | `jobs.update` | yes |
| DELETE | `/queues/:queue/jobs/:id` | `jobs.remove` | yes |
| POST | `/queues/:queue/jobs/:id/retry` | `jobs.retry` | yes |
| POST | `/queues/:queue/jobs/:id/promote` | `jobs.promote` | yes |
| POST | `/queues/:queue/jobs/retry` | `jobs.retry` | yes |
| POST | `/queues/:queue/jobs/remove` | `jobs.remove` | yes |
| POST | `/queues/:queue/jobs/promote` | `jobs.promote` | yes |
| POST | `/queues/:queue/jobs/retry-all` | `jobs.retryAll` | yes |
| POST | `/queues/:queue/jobs` | `jobs.add` | yes |
| GET | `/queues/:queue/repeatables` | `repeatables.list` | no |
| DELETE | `/queues/:queue/repeatables/:key` | `repeatables.remove` | yes |
| GET | `/definitions` | `definitions.list` | no |
| GET | `/runners` | `runners.list` | no |
| GET | `/runners/:runner` | `runners.read` | no |
| GET | `/runners/:runner/history` | `runners.read` | no |
| GET | `/runners/:runner/stats` | `runners.read` | no |
| POST | `/runners/:runner/trigger` | `runners.trigger` | yes |
| POST | `/runners/:runner/pause` | `runners.pause` | yes |
| POST | `/runners/:runner/resume` | `runners.resume` | yes |
| PUT | `/runners/:runner/schedule` | `runners.reschedule` | yes |
| POST | `/runners/:runner/kill` | `runners.kill` | yes |
| POST | `/runners/:runner/stats/reset` | `runners.resetStats` | yes |

Runner routes reach runners registered in *any* process sharing the driver
and namespace; `kill` and `stats/reset` are local-only and answer 409
`RUNNER_NOT_LOCAL` for a runner owned elsewhere.

### Pagination, filtering and `include`

Lists are offset-based: `?offset=0&limit=20`, answering
`{ items, page: { offset, limit, total?, hasMore } }`. Ask for `total=true`
only when you need a count — it costs a second query. Jobs can be filtered by
`state` (repeated or comma-separated), by `name`, and by `search` (a substring
of id or name, never the payload).

`GET /queues` pages the same way (`?offset=&limit=`, `limit` at most and by
default `limits.maxQueues`) and answers `page` beside `items`; `truncated` is
`page.hasMore`. Its `search` matches a substring of the queue name ignoring
case, as job search does.

A new job's `opts.jobId` is at most 191 characters, the cap bun-jobs applies
to every id a caller chooses; more is 400 `VALIDATION`. That schema is only a
first check: bun-jobs' own `assertJobId` is the authority — it counts UTF-16
units rather than characters, and refuses control characters and a leading
`.` — so an id the schema passes can still be refused, answered 400
`INVALID_ARGUMENT`. An id that *addresses* a job (a path, a bulk body, a
lookup) may be up to 1024 characters, so a job stored with a longer id by an
earlier version stays readable, retryable and removable.

Lists omit the heavy fields; ask for them with `include=data,returnValue,stacktrace,opts`.
A single read includes `data`, `returnValue` and `opts` by default. Timestamps
are epoch milliseconds throughout. `serialize.job` (and the `repeatable`,
`runner`, `run` and `event` hooks) is where you redact before anything leaves
the process.

### Errors

Every failure is RFC 9457 `application/problem+json`:

```json
{
  "type": "urn:bun-jobs:error:JOB_NOT_FOUND",
  "title": "Job not found",
  "status": 404,
  "code": "JOB_NOT_FOUND",
  "detail": "Job \"a41\" was not found",
  "instance": "/admin/jobs/queues/mail/jobs/a41"
}
```

A 5xx never carries the underlying message — `detail` is the generic title —
and nothing is matched on message text. Validation failures add `issues`
(`{ target, path, message }`).

| Code | Status | | Code | Status |
|---|---|---|---|---|
| `UNAUTHORIZED` | 401 | | `VALIDATION` | 400 |
| `FORBIDDEN` | 403 | | `SERIALIZATION` | 400 |
| `QUEUE_NOT_FOUND` | 404 | | `INVALID_ARGUMENT` | 400 |
| `JOB_NOT_FOUND` | 404 | | `INVALID_NAME` | 400 |
| `RUNNER_NOT_FOUND` | 404 | | `INVALID_JSON` | 400 |
| `RUN_NOT_FOUND` | 404 | | `INVALID_SCHEDULE` | 400 |
| `REPEATABLE_NOT_FOUND` | 404 | | `BULK_LIMIT` | 400 |
| `ROUTE_NOT_FOUND` | 404 | | `ARGS_NOT_ALLOWED` | 400 |
| `JOB_STATE_CONFLICT` | 409 | | `NAME_NOT_ADDABLE` | 403 |
| `JOB_ACTIVE` | 409 | | `CSRF_REJECTED` | 403 |
| `RUNNER_NOT_LOCAL` | 409 | | `ORIGIN_REJECTED` | 403 |
| `OPERATION_IN_PROGRESS` | 409 | | `UNSUPPORTED_MEDIA_TYPE` | 415 |
| `LIMITS_CONTENDED` | 409 | | `PAYLOAD_TOO_LARGE` | 413 |
| `RUNNER_STOPPED` | 409 | | `NOT_SUPPORTED` | 501 |
| `LOCK_UNAVAILABLE` | 409 | | `QUEUE_CLOSED` | 503 |
| `LOCK_LOST` | 409 | | `WORKER_CLOSED` | 503 |
| `INTERNAL` | 500 | | `QUEUE_FULL` | 503 |
| | | | `DRIVER_ERROR` | 503 |

### Live events

The socket is at `<basePath>/ws` (`websocket.path`). Connect, then subscribe
by channel name — the channels are multiplexed over one connection:

```ts
const ws = new WebSocket("wss://app.example/admin/jobs/ws");
ws.onopen = () =>
  ws.send(
    JSON.stringify({
      op: "subscribe",
      id: "1",
      channels: ["queues", "queue/mail", "runner/nightly"],
    }),
  );
```

| Channel | Receives |
|---|---|
| `all` | every event (mode `both` only) |
| `queues` | every queue event |
| `queue/{queue}` | one queue's events |
| `queue/{queue}/job/{jobId}` | one job's events (the id escaped with `encodeJobId`, below) |
| `runners` | every runner event |
| `runner/{runner}` | one runner's events |

**Naming a job channel.** Escape the id with `encodeJobId(id)`, exported by
`@kingsleyweb/bun-jobs/api/contract` (and the root): it is
`encodeURIComponent`, except that a lone UTF-16 surrogate — which
`encodeURIComponent` throws on — becomes `%uXXXX` (upper-case hex), so every
job id has a channel. `decodeJobId` reverses either form. The two cannot be
confused, because `encodeURIComponent` escapes `%` itself as `%25`. The `ack`
lists each channel in canonical form, the id re-encoded this way.

One `subscribe` or `unsubscribe` names at most 256 channels
(`JOBS_API_WS_MAX_CHANNELS_PER_FRAME`); more is refused whole, with an
`error` frame of code `VALIDATION`. A connection holds at most
`maxSubscriptions` (default 50); channels past that are refused in the `ack`
as `SUBSCRIPTION_LIMIT`, without asking `authorize`.

The server sends `hello` on open, `ack` for each `subscribe`/`unsubscribe`
(with per-channel `rejected` entries, so one refused channel does not close
the connection), `event`, `gap`, `heartbeat`, `pong` and `error`. Each `event`
carries a `seq` within an `epoch`, and lists every subscription it matched —
an event matching several of your channels arrives **once**.

**Resuming.** After a reconnect, `subscribe` with `resume: { epoch, afterSeq }`
replays what the server still holds (`websocket.replay`, by default 1000
events or five minutes), for the channels that frame accepted, **before** the
`ack`, and answers `ack { resumed: true }`. `resumed: false` means some events
could not be replayed and a `gap` covers them: right after the `ack`, or — if
the connection fell behind during the replay — when it drains. Refetch over
HTTP what a gap covers. The gap's `reason` says why:

- `resume-expired` — the events after `afterSeq` are older than the server
  still holds; the gap runs from `afterSeq + 1`.
- `epoch-changed` — a different server instance (normal behind a load
  balancer without sticky sessions), or an `afterSeq` **ahead** of anything
  this instance has stamped in that epoch, which can only come from another
  instance; the gap runs from `0`.

**`seq` and duplicates.** `seq` increases within an `epoch`, across every
channel, and one connection never sends the same `seq` twice — an event
already delivered live is skipped by a replay. So the last `seq` processed,
with its `epoch`, is all a client needs to keep; drop anything at or below it
if you replay from your own buffer too. `heartbeat.seq` is the server's
latest across *all* connections, so a jump in it says nothing about missed
events — only `gap` frames do.

**Authorizing broad channels.** Subscribing to a channel asks `authorize` for
`events.subscribe` once, with `channel` (and `queue`, `runner` or `jobId` for
a named channel). The broad channels — `all`, `queues` and `runners` — reach
every queue or runner, so each target is also authorized on its own: the
first event from a queue or runner on a broad channel asks `authorize` again,
with `channel` plus that `queue` or `runner`, and events from a target the
host denies are dropped from that channel without a frame. Each answer is
remembered for the subscription (an `authorize` that threw is asked again for
the next event), and forgotten on `unsubscribe`. While a decision is pending,
that connection's events are held back, in `seq` order, so the first event
from a new target can be delayed by one `authorize` call. At most 1000 events
are held; past that the connection is treated as a slow consumer — it stops
receiving events and gets a `slow-consumer` `gap` once the backlog clears.

**Backpressure.** A client that cannot keep up stops receiving events, gets one
`gap` when its socket drains, and is closed `4008` after
`slowConsumerTimeoutMs`. Frames over `maxMessageBytes` close `1009`, binary
frames close `1003`, exceeding `messagesPerSecond` twice within ten seconds
closes `1008`, and `api.close()` closes sessions `1001`. `progress` events are
coalesced per job to one per `coalesceProgressMs`.

**Events only carry what producers publish.** The socket hears whatever reaches
the notifier, which hears only what is published: set `publishEvents: true` on
the `BunJobs` (or `publish` on individual queues, workers and runners) **in
every process that produces events**. On a memory driver events are
process-local, and transports like Redis pub/sub are at-most-once. Treat
events as invalidation hints and HTTP as the source of truth.

### Documentation endpoints

The JSON documents are always served (behind `docs.read`) and cost nothing:
`/openapi.json` describes exactly the routes registered, and `/asyncapi.json`
the socket's channels and messages — both pruned the same way the router is,
so they never describe a route that does not exist. `api.openapi()` and
`api.asyncapi()` return the same documents in process.

HTML viewers are **off by default** (`docs.ui: false`) and deliberately so:
they load third-party script into an origin holding admin cookies, and "try it
out" is a mutation console. With `docs.ui: true` you get Swagger UI at
`/docs` and the AsyncAPI viewer at `/docs/asyncapi`, both behind `docs.read`.

Those pages are pinned and locked down: exact CDN versions (never a range)
with `sha384` Subresource Integrity on every asset, and a Content Security
Policy of `default-src 'none'` with `script-src` limited to one per-request
nonce plus the CDN origin, `connect-src 'self'`, and `base-uri`,
`form-action`, `frame-ancestors` and `object-src` all `'none'`, alongside
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Point
`docs.cdn.baseUrl` at a mirror to self-host — supply your own hashes if the
mirror re-encodes anything — or leave the pages off and use the JSON.

### Security checklist

- **Mount behind your own authentication.** This is an admin surface; nothing
  here belongs on the public internet.
- **`authorize` is mandatory** and fails closed. Use `readOnly` and `actions`
  as static limits that no hook can re-enable.
- **Leave `jobs.add` and `jobs.update` off** unless a UI genuinely needs
  them: they write payloads your handlers trust. Enabling them means passing
  `actions`, which is an allow-list — name every action you want, not just
  these two.
- **CSRF, for cookie sessions.** Mutations require `Content-Type:
  application/json` by default, and cross-site `Origin`/`Sec-Fetch-Site` are
  refused; add `csrf.header` to force a preflight. CORS is off by default, and
  `credentials: true` with a wildcard origin is refused outright.
- **The socket's `Origin` is checked** on upgrade (same-origin by default),
  because browsers send cookies on cross-site WebSocket handshakes. Set
  `trustProxy: true` only behind a proxy you control.
- **Redact with the `serialize` hooks.** `lockToken`, event `origin` tokens,
  `driverConfig` and handler functions are never serialised; stacks
  (`exposeStacks`), runner file paths (`exposeRunnerFiles`) and worker
  host/pid (`exposeHosts`) are switches.
- **Keep `docs.ui` off in production** unless the prefix is private.

### Limits

Every cost is bounded, and a request that exceeds a cap is refused rather than
served slowly. Override any of them through `limits`.

| Limit | Default | Bounds |
|---|---|---|
| `maxPageSize` | `100` | largest `limit` on a job list |
| `defaultPageSize` | `20` | `limit` when none is given |
| `maxBulkIds` | `1000` | ids in a bulk body |
| `maxRetryAll` | `10000` | jobs one `retry-all` may move |
| `maxClean` | `10000` | largest `clean` limit |
| `maxLogPage` | `500` | largest log page |
| `maxHistory` | `200` | largest runner history page |
| `maxQueues` | `500` | queues summarised by `/queues` and `/overview` |
| `queueCacheMs` | `2000` | how long the known-queue list is cached; a queue missing from it is checked against the backend once more (at most once per window) before a 404 |
| `maxJobDataBytes` | `1048576` | body accepted by `jobs.add`/`jobs.update` |

The socket has its own (`websocket`): `maxConnections` `1000`,
`maxSubscriptions` `50` per connection, `maxMessageBytes` `16384`,
`messagesPerSecond` `20`, `maxBufferedBytes` `1048576`,
`slowConsumerTimeoutMs` `30000`, `heartbeatMs` `25000`,
`coalesceProgressMs` `250`, and `replay` of `1000` events or five minutes.

`GET /meta` reports every cap above except `queueCacheMs` as `limits`, read
from the very values the routes enforce, so a client can size pages and bulk
selections without meeting a 400. Two more are reported there though they are
not options: `defaultClean`, the `limit` a `clean` uses when none is given
(`min(1000, maxClean)`), and `maxRetryAllIds`, the most ids a `retry-all`
answers with (`1000`; past it `ids` holds the first `1000` and `truncated` is
`true`).

### Writing a client

`GET /meta` tells a client everything it needs before its first write:

- `csrf: { header, requireJson }` — the header every mutation must carry
  (lower case, or `null`), and whether every `POST` must be sent as
  `Content-Type: application/json` *even with no body*;
- `limits` — the caps above;
- `addableNames` — the names `POST /queues/:queue/jobs` accepts right now:
  `null` for any name, `[]` when adding is not routed, else the list (by
  default, the names of `jobs.definitions()`);
- `runnerTriggerArgs` — whether a trigger may carry `args`;
- `websocket.port` — present when the socket has its own port.

`GET /meta/permissions?channel=queue/mail` previews a WebSocket subscription:
the channel is parsed and checked as a `subscribe` frame's would be, and
`authorize` is asked about `events.subscribe` on it. The answer's `key` is the
channel's canonical name whenever it parsed — refused afterwards or not
(`CHANNEL_NOT_AVAILABLE`, `QUEUE_NOT_FOUND`, `RUNNER_NOT_FOUND`, `FORBIDDEN`,
…); only an `INVALID_CHANNEL` has none. `GET /overview` adds
`throughputSeries`, the namespace's per-minute throughput in the shape of
`GET /queues/:queue/throughput`.

On the server, `api.info` holds the same resolved values without a request:
`{ basePath, namespace, mode, readOnly, csrf, docs, websocket }`.

The OpenAPI document states the CSRF header as a required header parameter
on every mutation, marks bodiless `POST`s as still needing
`application/json`, and gives `:queue` and `:runner` the name pattern the
routes enforce.

For a browser client, `@kingsleyweb/bun-jobs/api/contract` exports the
constants (`JOBS_API_ACTIONS`, `JOBS_API_MUTATIONS`,
`JOBS_API_PROTOCOL_VERSION`, `JOBS_API_WS_SUBPROTOCOL`, `JOBS_API_WS_CLOSE`,
`EVENT_TYPES`, `JOB_STATES`, …) and a named type for every request and
response (`MetaDto`, `OverviewDto`, `QueueListDto`, `JobDto`, `AddJobBody`,
`TriggerOutcomeDto`, …), and for the socket every frame
(`JobsApiClientMessage`, `JobsApiServerMessage` and their members) and every
event (`EventWire`, with payload errors as `ErrorWire`), plus
`JOBS_API_WS_MAX_CHANNELS_PER_FRAME` and `encodeJobId`/`decodeJobId` for job
channel names. The server defines none of the socket types itself: the root
entry's `JobsApiEventMessage` and the rest *are* the contract's, so the two
imports mix freely. It imports nothing outside itself — no driver, no
bun-common, no `node:*` — so it bundles for the browser, and the server takes
its constants from it, so the two cannot disagree.

```ts
import type { MetaDto, QueueListDto } from "@kingsleyweb/bun-jobs/api/contract";
import { JOBS_API_WS_SUBPROTOCOL } from "@kingsleyweb/bun-jobs/api/contract";

const meta: MetaDto = await (await fetch("/admin/jobs/meta")).json();
const queues: QueueListDto = await (
  await fetch(`/admin/jobs/queues?limit=${meta.limits.maxQueues}`)
).json();
const socket = new WebSocket(`wss://${location.host}${meta.websocket!.path}`, [
  JOBS_API_WS_SUBPROTOCOL,
]);
socket.addEventListener("open", () => console.log(queues.page.total));
```

### Features that need driver support

Some routes exist only where the backend can serve them, and `/meta.features`
says which:

| Feature | Routes | Needs |
|---|---|---|
| `logs` | `/jobs/:id/logs` | `getJobLogs` |
| `update` | `PATCH /jobs/:id` | `updateJob` |
| `limits` | `/queues/:queue/limits` | queue state |
| `flows` | `/jobs/:id/children` | `recordChild` |
| `search` | `?search=` on job lists | `findJobs` |
| `workers` | `/workers`, `/queues/:queue/workers` | worker records |
| `throughput` | `/queues/:queue/throughput`, `/overview` | `getThroughput` |

A route whose support is missing is not registered, not documented, and
answers the API's JSON 404 — so a UI can ask `/meta` once and explain the
absence rather than guessing from a failure.

### Live events alongside NestJS gateways

The socket is a per-path route handler, not a Nest gateway, and every
connection it upgrades is marked `ws.data.custom.bunJobsApi === true`. The API
ignores any connection without that marker, so another handler's clients can
never drive it.

The overlap runs the other way too. A gateway declared with a `"/*"` (or
`"*"`) namespace matches **every** path beneath it, including
`<basePath>/ws`, so on the shared HTTP server that gateway also receives these
connections and will try to read their frames as its own. Two ways to avoid
it:

- **Give the socket its own port** — `websocket: { port: 9230 }`. The
  recommendation for any app that uses gateways: the isolation is structural,
  and `api.close()` stops that server. It costs a second listener, its own TLS
  configuration, and a cross-origin `Origin` allow-list for browsers.
- **Filter on the marker** in the gateway, ignoring clients whose
  `ws.data.custom.bunJobsApi` is `true`.

Give every gateway an explicit namespace either way: one declared without a
namespace binds to `/`, which cannot be told apart from anything else.

**Attach before any catch-all gateway.** Both the socket's route and a
gateway's are middleware on one router, and whichever upgrades first ends the
request — so a `"/*"` gateway registered first would leave the socket
reachable but permanently silent. Rather than mount into a path that can never
answer, `attach()` refuses with `ConfigError`, naming the pattern that already
claims it:

```text
attach(): a WebSocket route for "/*" is already registered on this router and
covers the socket's path "/admin/jobs/ws".
```

Order against `app.useWebSocketAdapter()` does **not** matter. The socket
resolves the serving `BunWebSocket` when a client upgrades, not when it is
attached, so an adapter installed afterwards still receives its connections —
attaching early used to leave sockets that connected and then did nothing.

Examples:

- [`11-management-api/mounting-and-auth.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/11-management-api/mounting-and-auth.ts)
- [`11-management-api/live-events.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/11-management-api/live-events.ts)
- [`11-management-api/openapi-and-docs.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/11-management-api/openapi-and-docs.ts)
- [`10-options/jobs-api-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/jobs-api-options.ts)
- [`10-options/jobs-api-socket-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/jobs-api-socket-options.ts)

## Drivers

Examples:

- [`08-drivers/`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/08-drivers)
- [`10-options/driver-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/driver-options.ts)

### Choosing a driver

| Driver | Cross-process | Cross-host | Waiting | Events | How exclusivity is won |
|---|---|---|---|---|---|
| memory | no | no | blocking (local) | local | one process; for tests and single-process apps |
| file | yes | no | poll | poll | `open(…, "wx")` and atomic `rename` |
| sql (sqlite) | yes | one file, so in practice one host | poll | poll | `BEGIN IMMEDIATE`, WAL, busy timeout |
| sql (postgres/mysql/mariadb) | yes | yes | poll (Postgres also `LISTEN`/`NOTIFY`) | poll | `FOR UPDATE SKIP LOCKED` |
| mongodb | yes | yes | poll | poll | one conditional `findOneAndUpdate` |
| redis | yes | yes | **blocking** | **push** | a Lua script, which runs uninterrupted |

Redis is the only driver that waits rather than polls: a worker blocks on the
queue's wake list and hears about a job in about a millisecond. It is also the
only driver whose events are pushed rather than polled.

Each driver reports these figures as
`driver.capabilities`: `{ blockingWait, events, multiProcess, multiHost }`.

The file driver's `multiHost` is `false` on purpose: its guarantees rest on
POSIX `rename` and `O_EXCL`, which network filesystems do not reliably provide.

### Driver configs

A `DriverConfig` is plain JSON. That means a spawned child can receive it, and
it can come from a config file. `createDriver(config)` builds one, and
`resolveDriver` decides ownership.

Every networked driver takes its connection **either way**: a URL, or
[connection fields](#connection-fields). A URL takes precedence when both are
given.

```ts
import type { DriverConfig } from "@kingsleyweb/bun-jobs";

export const drivers: DriverConfig[] = [
  { type: "memory" },
  { type: "file", root: "/var/lib/myapp/jobs" },
  { type: "sql", url: "sqlite:///var/lib/myapp/jobs.db" },

  // A URL, with a prefix applied to every table name.
  { type: "sql", url: "postgres://user:pass@db/jobs", tablePrefix: "jobs_" },

  // The same connection as fields, naming a table that already exists.
  {
    type: "sql",
    adapter: "postgres",
    connection: { host: "db", user: "jobs", password: "secret" },
    tables: { jobs: "legacy_work_items" },
  },

  { type: "redis", url: "redis://localhost:6379/0", keyPrefix: "myapp" },
  { type: "mongodb", connection: { host: "db", database: "work" }, collections: { jobs: "work_items" } },
];
```

| Config `type` | Fields | Defaults and notes |
|---|---|---|
| `memory` | | In-process only. Jobs live in the instance, so share one instance. |
| `file` | `root` | A directory the driver owns, created on demand. |
| `sql` | `url`, `connection`, `adapter`, `tablePrefix`, `tables`, `notify`, `syncSchema` | See below. |
| `redis` | `url`, `connection`, `cluster`, `keyPrefix` | See below. |
| `mongodb` | `url`, `connection`, `database`, `collectionPrefix`, `collections`, `syncSchema` | See below. |

The `sql` fields:

- The engine is detected from the URL scheme: `postgres`/`postgresql`,
  `mysql`, `mariadb`, or `sqlite`/`file`. A bare path or `:memory:` is also
  SQLite. With `connection` fields, `adapter` is required.
- `tablePrefix` defaults to `bun_jobs_`.
- `tables` gives exact names for `jobs`, `locks`, `kv`, `events` and `logs`;
  these ignore the prefix.
- `notify` (Postgres `LISTEN`/`NOTIFY`) is on by default, with polling
  underneath.
- `syncSchema` is off by default.

The `redis` fields:

- The host defaults to `127.0.0.1:6379`; `rediss` is used with TLS.
- `keyPrefix` defaults to `bun-jobs`.
- `cluster: true` hash-tags keys per queue and per runner.

The `mongodb` fields:

- `database` defaults to the URL's path, then to `bun_jobs`.
- `collectionPrefix` defaults to `bun_jobs_`.
- `collections` gives exact names for `jobs`, `locks`, `kv`, `events` and
  `jobLogs`.
- `syncSchema` is off by default.

Constructing a driver class directly (`new SqlDriver`, `new RedisDriver`,
`new MongoDriver`, `new FileDriver`) accepts everything a config does, plus
options that cannot be JSON or are rarely needed:

| Option | Driver | Default | Meaning |
|---|---|---|---|
| `sql` | SQL | | An already-open `Bun.SQL` to share. |
| `client` | Redis | | An already-connected `RedisClient` for commands. `url` is still required, for the blocking and pub/sub connections. |
| `client`, `clientOptions` | MongoDB | | A shared `MongoClient`, or options for the client the driver creates. |
| `maxBlockSeconds` | Redis | `5` | Longest blocking wait. |
| `pollInterval` | SQL, MongoDB / file | `50` / `25` ms | How often a wait re-checks. |
| `eventRetentionMs` | SQL, MongoDB, file | one hour | How long stored events are kept. `0` keeps everything. |

### Connection fields

`ConnectionOptions` is used by `connection` on the SQL, Redis and MongoDB
drivers:

| Field | Type | Meaning |
|---|---|---|
| `host` | `string` | Host. Defaults to the driver's default. |
| `port` | `number` | Port. Defaults to the backend's standard port. |
| `user` / `password` | `string` | Credentials. |
| `database` | `string \| number` | The database, or for Redis the numbered database. |
| `tls` | `boolean` | Connect over TLS. |
| `params` | `Record<string, string \| number \| boolean>` | Extra query parameters (`authSource`, `replicaSet`, `sslmode`, and so on). |
| `hosts` | `{ host, port? }[]` | Additional hosts, for a replica set or cluster. |
| `allowPublicKeyRetrieval` | `boolean` | MySQL and MariaDB only; defaults to `false`. Lets the client fetch the server's RSA key to send a password without TLS. Prefer `tls: true` in production. |

`toConnectionUrl`, `resolveConnectionUrl`, `databaseFromUrl` and `resolveNames`
are exported for building the same URLs yourself.

## Schema sync

The SQL schema is created with `IF NOT EXISTS`, so a table an earlier version
created keeps its original shape for good. Without intervention, schema
improvements that ship with an upgrade reach new installs only. `syncSchema`
is how a deployment that already has tables gets them.

```ts
const driver = new SqlDriver({ url, syncSchema: true }); // on connect

await driver.syncSchema(); // or explicitly
const plan = await driver.syncSchema({ dryRun: true }); // plan, change nothing
await driver.syncSchema({ alterColumns: true }); // including table rewrites

for (const change of plan) {
  console.log(change.blocking ? "needs a window" : "safe", change.kind, change.target, change.reason);
}
```

| Option | Default | Meaning |
|---|---|---|
| `add` | `true` | Add missing columns and indexes. |
| `indexes` | `true` | Drop indexes the driver no longer defines, and rebuild any whose predicate changed. Only touches indexes the driver named. |
| `alterColumns` | `false` | Change column types. This rewrites the table under a lock that blocks every reader and writer. |
| `dryRun` | `false` | Report every change without applying any. |

It is **safe by default**:

- Adding columns and dropping or rebuilding indexes cannot stall a running
  queue. On Postgres the index work is `CONCURRENTLY`.
- A type change is reported with `blocking: true` and `applied: false` unless
  `alterColumns` asks for it.
- Every `SchemaChange` comes back either way, with fields `kind`, `table`,
  `target`, `statement`, `reason`, `blocking` and `applied`.

It also **never drops what it did not create**:

- SQL only drops indexes matching the driver's own `ix_` naming convention.
- MongoDB has no column types, so `alterColumns` means nothing there. It drops
  only indexes on an explicit retired list, because an index it no longer
  defines is indistinguishable from one somebody added by hand.
- A column whose declared type does not match what the engine reports back
  is exempt from retyping. For example, `BIGSERIAL` comes back as `bigint`.

The memory, file and Redis drivers have no schema, and do not implement
`syncSchema`.

Example:
[`08-drivers/sqlite-and-schema-sync.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/08-drivers/sqlite-and-schema-sync.ts).

## Errors

Everything the package throws extends `JobsError`, which has a stable
`code` and an optional `context` object that is safe to log. You can branch on
`code` without matching message text, and it survives crossing a process
boundary. An error's own context fields are applied after any caller detail,
so a caller can add to them but never overwrite them.

| Class | `code` | Raised when |
|---|---|---|
| `ConfigError` | `CONFIG` | An option is missing, malformed or contradictory. A feature that needs an optional driver method the driver lacks raises `NotSupportedError`, which is one of these. |
| `NotSupportedError` | `CONFIG` | A `ConfigError` subclass with `context.driver` and `context.method`, meaning a driver does not implement a method. It keeps the `CONFIG` code, so a branch on `CONFIG` catches both. Every built-in optional-method check raises it — `queue.cleanWindows()`, `queue.getThroughput()`, `queue.listWorkers()`, `job.log()` and the rest — with `context.needs` naming the feature that wanted the method. |
| `DriverError` | `DRIVER_ERROR` | A driver operation failed. `driver` and `operation` are set, and the backend's error is the `cause`. |
| `LockUnavailableError` | `LOCK_UNAVAILABLE` | A lock is held elsewhere (`context.key`). |
| `LockLostError` | `LOCK_LOST` | A lock expired or was taken mid-work. |
| `JobTimeoutError` | `JOB_TIMEOUT` | A run or attempt outlived its timeout (`ms`). |
| `UnrecoverableJobError` | `UNRECOVERABLE_JOB` | Thrown by your processor: the job goes to `dead` now. |
| `ChildFailedError` | `CHILD_FAILED` | A flow child failed for good and buried its parent (`child` as `queue:id`). |
| `ChildExitError` | `CHILD_EXIT` | A child process exited without reporting a result (`exitCode`, `signalCode`). |
| `RunKilledError` | `RUN_KILLED` | A run was stopped on request (`reason`). |
| `InvalidHandlerError` | `INVALID_HANDLER` | A handler or processor file has no usable default export. |
| `RunnerStoppedError` | `RUNNER_STOPPED` | A runner was triggered manually after `stop()`. |
| `RunnerNotFoundError` | `RUNNER_NOT_FOUND` | `BunRunnerManager.remote(id)`, or a `RemoteRunner` call, names a runner that is neither registered in this process nor known to the backend (`context.id`, `context.namespace`). |
| `QueueClosedError` | `QUEUE_CLOSED` | A queue was used after `close()`. |
| `WorkerClosedError` | `WORKER_CLOSED` | A worker was used after `close()`. |
| `QueueFullError` | `QUEUE_FULL` | A bounded queue of triggers or jobs is full (`what`, `max`). |
| `SerializationError` | `SERIALIZATION` | A value (job data, a result) is not JSON-serialisable. |
| `ProtocolError` | `PROTOCOL` | A message between processes did not have the shape its protocol promises, such as a malformed job-channel reply. It means the two sides disagree (a rolling upgrade, a bug), not that the operation failed. |

`ErrorContext<Reserved>` types the extra detail you can pass to the
constructors.

Example:
[`10-options/errors.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/errors.ts).

## Logging

Every `logger` option accepts a `LoggerLike`, from
[bun-common's structured logger](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md). It can
be any of these:

- a bun-common `Logger`;
- a bare sink function;
- a pino, bunyan, winston, consola, log4js, tslog, NestJS or console-like
  logger, detected and wrapped structurally.

Each queue, worker and runner binds its identity (`namespace`, `queue`,
`workerId`, `runnerId`). A processor's `ctx.logger` is also bound to the job.

A child's `ctx.logger` is forwarded to the parent's `log` event when
`forwardLogs` is on (and always for isolated processors). `createJobsLogger`
and `resolveLogger` are exported.

```ts
import pino from "pino";

export const jobs = new BunJobs({ namespace: "shop", driver, logger: pino() });
```

Example:
[`09-integrations/logging.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/09-integrations/logging.ts).

## Benchmarks

[`bench/`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-jobs/bench/README.md) compares both halves of the package against
established alternatives, on Bun:

- the **queue** against BullMQ, bee-queue, node-resque, pg-boss,
  graphile-worker and Agenda, on Redis, Postgres, MongoDB, MySQL, MariaDB,
  SQLite, file and memory;
- the **runner** against Bree, Agenda, croner, node-cron, node-schedule and
  toad-scheduler.

It is a separate, unpublished package, so none of those libraries reach this
package's dependency tree.

Results are ranked only **within a backend**: a Redis figure beside a Postgres
one measures the database, not the library. Each contender runs in its own
process, and `--verify` checks that each one delivers every job exactly once
before any timing.

```bash
cd bench && bun install
bun queue.ts --verify     # every contender must deliver each job exactly once
bun queue.ts              # enqueue, drain, round-trip, payload, contention
bun runner.ts             # dispatch, cycle, schedule drift, exclusivity
bun queue.ts --compare    # fail if a figure regressed or a rival overtook us
```

[`bench/baselines/queue.json`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-jobs/bench/baselines/queue.json) and
[`bench/baselines/runner.json`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-jobs/bench/baselines/runner.json) record each
scenario's figure and who led it, along with the platform and Bun version.
`--save-baseline` re-records them after a deliberate change.

The [bench README](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-jobs/bench/README.md) explains setup, scenarios and how the
configurations are kept comparable.

## Examples

### Example projects

| Project | What it covers |
|---|---|
| [`examples/bun-jobs`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs) | This package: queues, workers, the registry, scheduling, flow control, failures, the runner, every driver, integrations, and 12 option tours that assert every option. |
| [`examples/bun-common`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-common) | The HTTP layer: routing, the HTTP adapter, requests and responses, validation, CORS and static files, multipart uploads, WebSockets, logging and utilities, with option tours. |
| [`examples/bun-nest`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-nest) | NestJS on Bun: the HTTP adapter, file upload interceptors and the WebSocket adapter, with option tours. |

See [`examples/README.md`](https://github.com/kingsloob1/bun-node/blob/develop/examples/README.md)
for the conventions they share.

### bun-jobs examples

Each file is a script whose opening comment says what it shows. The examples
use the workspace packages through the root `node_modules`, so run
`bun install` at the repo root once.

```bash
cd examples/bun-jobs
bun 01-quick-start/index.ts        # start here
bun run-all.ts                     # every example; prints ok / skip / FAIL
bun run-all.ts 05 06               # only folders 05-* and 06-*
```

Examples that are not about one backend read `EXAMPLE_DRIVER`, so the same
script runs on any backend. An example that needs a server skips itself when
that server's URL is unset.

| `EXAMPLE_DRIVER` | Needs |
|---|---|
| `memory` (default) | nothing |
| `file`, `sqlite` | nothing; uses a temporary directory, removed on exit |
| `postgres` | `EXAMPLE_POSTGRES_URL` |
| `mysql` | `EXAMPLE_MYSQL_URL` |
| `mariadb` | `EXAMPLE_MARIADB_URL` |
| `redis` | `EXAMPLE_REDIS_URL` |
| `mongodb` | `EXAMPLE_MONGODB_URL`, and `bun add mongodb` |

```bash
EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 bun 02-queues/job-options.ts
EXAMPLE_DRIVER=postgres EXAMPLE_POSTGRES_URL=postgres://user:pass@localhost/jobs bun run-all.ts
```

Each run uses its own namespace and purges it on exit.

| Folder | File | Shows |
|---|---|---|
| [`01-quick-start`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/01-quick-start) | [`index.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/01-quick-start/index.ts) | `BunJobs`: define a job, add it now and in words, process it, read its log, shut down |
| [`02-queues`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/02-queues) | [`producer-and-worker.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/producer-and-worker.ts) | `BunQueue` and `BunQueueWorker` directly, typed payloads and results, progress, shutdown |
| | [`job-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/job-options.ts) | priority, `delay` / `runAt`, attempts and backoff, `timeout`, `jobId` idempotency, retention |
| | [`job-lifecycle.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/job-lifecycle.ts) | `updateData`, `setPriority`, `reschedule`, `promote`, progress, job logs, retrying a dead job, `remove` |
| | [`events.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/events.ts) | every queue and worker event, name-scoped events, `subscribe` / `publish` |
| | [`bulk-and-management.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/bulk-and-management.ts) | `addBulk`, `count`, `list`, `update`, cluster-wide `pause` / `resume`, `drain`, `clean` |
| | [`searching-and-paging.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/searching-and-paging.ts) | `list` narrowed by `name` and `search`, `page` with the total a paginated table needs, `getJobs` by id |
| | [`workers-and-throughput.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/workers-and-throughput.ts) | `listWorkers` and `reportInterval`, `getThroughput` a minute at a time, `getQueueSummaries`, printed as a dashboard |
| | [`isolated-processors.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/isolated-processors.ts) | a processor file run in-process, in a `Worker` and in a child process; a runaway stopped by its timeout |
| | [`processors/`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/02-queues/processors) | `thumbnail.ts`, `runaway.ts`: the processor files it runs |
| [`03-job-registry`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/03-job-registry) | [`define-and-run.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/03-job-registry/define-and-run.ts) | `define` with defaults, `now`, `run().in()`, `process().on()`, `schedule().every().limit()` |
| | [`builder-with-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/03-job-registry/builder-with-options.ts) | the full builder chain, `withOptions()`, what is refused and why |
| | [`per-name-concurrency.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/03-job-registry/per-name-concurrency.ts) | `define(..., { concurrency })` enforced across two service instances |
| | [`jobs-create.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/03-job-registry/jobs-create.ts) | `jobs.create()` drafts: setters, `save()`, saving once, `unique` across drafts, repeating and debounced drafts, a failed save corrected |
| | [`process-every.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/03-job-registry/process-every.ts) | `processEvery` as an option and a method, against `start()`'s options, while paused; a worker's runtime `pollInterval` / `maxBlock` |
| [`04-scheduling`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/04-scheduling) | [`repeatable-jobs.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/04-scheduling/repeatable-jobs.ts) | `repeat`: intervals, six-field cron, `startAt` / `endAt`, `limit`, keys, `listRepeatables`, `removeRepeatable` |
| | [`human-schedules.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/04-scheduling/human-schedules.ts) | "tomorrow at 9am", "every 2 weeks starting next monday", windows in words |
| | [`custom-date-parser.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/04-scheduling/custom-date-parser.ts) | a `DateParser` that understands "payday" and "month end" |
| | [`cron-helpers.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/04-scheduling/cron-helpers.ts) | `validateCron`, `parseCron`, `nextCronDate` across time zones, `normalizeSchedule`, `nextFireDate` |
| [`05-flow-control`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/05-flow-control) | [`debounce.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/05-flow-control/debounce.ts) | many adds become one job with the latest data; `cleanWindows` |
| | [`throttle.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/05-flow-control/throttle.ts) | at most one job per id per window |
| | [`rate-and-concurrency-limits.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/05-flow-control/rate-and-concurrency-limits.ts) | `setLimits`: rate, concurrency and a per-name cap, enforced by two workers, lifted live |
| [`06-failures`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/06-failures) | [`retries-and-backoff.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/06-failures/retries-and-backoff.ts) | every built-in backoff, measured; a custom `defineBackoff` |
| | [`unrecoverable-errors.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/06-failures/unrecoverable-errors.ts) | `UnrecoverableJobError`: dead now, attempts left or not |
| | [`dead-letter-queue.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/06-failures/dead-letter-queue.ts) | `deadLetterQueue` / `deadLetter`, a `DeadLetter` consumer, re-driving with `retryAll` |
| | [`timeouts-and-cancellation.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/06-failures/timeouts-and-cancellation.ts) | `ctx.signal`, graceful `close`, a consumer killed with `SIGKILL` and its job recovered as stalled |
| | [`helpers/crashing-consumer.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/06-failures/helpers/crashing-consumer.ts) | the consumer process that example kills |
| [`07-runner`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/07-runner) | [`scheduled-runner.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/scheduled-runner.ts) | `BunRunner` on an interval, then cron; events, `history`, `stats`, `info` |
| | [`manual-trigger.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/manual-trigger.ts) | `trigger()` outcomes; `single` vs `parallel`; pause and `force` |
| | [`execution-modes.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/execution-modes.ts) | one handler in `in-process`, `worker` and `spawn` |
| | [`single-run-lock.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/single-run-lock.ts) | three instances of one runner: one runs, one skips, one queues |
| | [`messages-progress-kill.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/messages-progress-kill.ts) | progress, logs and messages across a process boundary; `kill`; run timeouts |
| | [`runner-enqueues-jobs.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/runner-enqueues-jobs.ts) | a spawned runner fanning work out as queue jobs with `jobsFromContext` |
| | [`manager.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/manager.ts) | `jobs.runners`: `startAll`, `info`, state shared by a second instance, `remove` |
| | [`remote-control.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/remote-control.ts) | `remote(id)`: pause, reschedule, resume and trigger a runner owned by another process (`helpers/runner-owner.ts`); `info`, `history`, `stats`; no remote kill |
| | [`handlers/`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/07-runner/handlers) | `cleanup.ts`, `long-task.ts`, `nightly-report.ts`, `whoami.ts`: handler files written with `defineHandler` |
| [`08-drivers`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/08-drivers) | [`choosing-a-driver.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/08-drivers/choosing-a-driver.ts) | every config shape, capabilities, one workload on each available backend |
| | [`sqlite-and-schema-sync.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/08-drivers/sqlite-and-schema-sync.ts) | `SqlDriver` on SQLite, `tablePrefix`, `syncSchema` repairing a drifted schema |
| | [`postgres-and-mysql.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/08-drivers/postgres-and-mysql.ts) | Postgres, MySQL and MariaDB via `Bun.sql`, connection fields, `NOTIFY` wake-ups |
| | [`redis.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/08-drivers/redis.ts) | blocking waits, pushed events, the key layout |
| | [`mongodb.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/08-drivers/mongodb.ts) | `MongoDriver`, competing workers, index sync |
| | [`cross-process/main.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/08-drivers/cross-process/main.ts) | two producer and three consumer processes (`producer.ts`, `consumer.ts`); every job exactly once; `SIGTERM` shutdown |
| [`09-integrations`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/09-integrations) | [`http-api.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/09-integrations/http-api.ts) | a `202 Accepted` plus status-URL API with bun-common's `BunHttpAdapter` |
| | [`logging.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/09-integrations/logging.ts) | structured logs with bound job fields; a sink; pino, winston or console |
| | [`graceful-shutdown.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/09-integrations/graceful-shutdown.ts) | `SIGTERM` / `SIGINT` handling for a worker service |
| | [`namespaces.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/09-integrations/namespaces.ts) | two services on one backend with identical queue names and job ids, isolated |
| | [`live-dashboard.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/09-integrations/live-dashboard.ts) | `JobsNotifier`: one live stream of every event in a namespace, from any process |
| [`11-management-api`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/11-management-api) | [`mounting-and-auth.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/11-management-api/mounting-and-auth.ts) | mounting on a `BunHttpAdapter`, an `authorize` hook with roles, a walk through the route groups, `close()` |
| | [`live-events.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/11-management-api/live-events.ts) | the socket: several channels at once, `seq` / `epoch`, resuming from the replay ring, two deliberate gaps |
| | [`openapi-and-docs.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/11-management-api/openapi-and-docs.ts) | `openapi()` / `asyncapi()` and their endpoints; `docs.ui` off and on, pinned and locked down |
| [`shared`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/shared) | [`backend.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/shared/backend.ts), [`console.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/shared/console.ts), [`check.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/shared/check.ts) | picking a driver from `EXAMPLE_DRIVER`; printing and waiting on conditions; the assertions the tours use |
| | [`run-all.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/run-all.ts) | runs every example, or the folders named |

The **option tours** in `10-options` assert behaviour rather than just showing
it. A failed check prints what was expected and what happened, then fails the
script. That makes `bun run-all.ts` a test of every option on whichever backend
`EXAMPLE_DRIVER` names.

| Tour | Covers |
|---|---|
| [`job-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/job-options.ts) | every `JobOptions`, `RepeatOptions` and `DebounceOptions` field, retention forms, every backoff form |
| [`queue-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/queue-options.ts) | every `BunQueueOptions` field, `BunQueue` method and queue event |
| [`worker-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/worker-options.ts) | every `BunQueueWorkerOptions` field, worker method and event, `ProcessorContext`, the in-flight `Job` |
| [`worker-isolation.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/worker-isolation.ts) | `isolation` and `isolationOptions` in each mode; what works inside an isolated job |
| [`runner-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/runner-options.ts) | every `BunRunnerOptions` field, `RunContext`, runner method and event, `BunRunnerManager` and `remote()` |
| [`bunjobs-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/bunjobs-options.ts) | every `BunJobsOptions` field and `BunJobs` method, `jobsFromContext` |
| [`draft-and-process-every.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/draft-and-process-every.ts) | every `JobDraft` member and `RepeatEveryOptions` field, saving twice; `processEvery` and a worker's runtime `pollInterval` / `maxBlock`, per driver |
| [`read-apis.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/read-apis.ts) | every `ListJobsOptions` field; `search` taken literally and folded for case per engine; `page` totals; `getJobs` order, gaps and repeats; `listWorkers` fields, `reportInterval` and a lapsed record; `getThroughput` bounds, buckets and retried failures; `getQueueSummaries`; each driver fallback |
| [`notifier.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/notifier.ts) | every `JobsNotifierOptions` field and member, every published event and payload |
| [`driver-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/driver-options.ts) | every option of every driver and connection helper |
| [`errors.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/errors.ts) | every error class, triggered through the public API, with its `code` and fields |
| [`utilities.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/utilities.ts) | every exported helper: cron, schedules, repeats, options, backoff, JSON, ids, keys, connection, constants |
| [`jobs-api-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/jobs-api-options.ts) | every `createJobsApi` option: construction `ConfigError`s, `mode` / `readOnly` / `actions` / capability pruning against `/meta` and `/meta/permissions`, RFC 9457 problems, `authorize` asked once and untargeted first, `limits`, `cors` / `csrf` / `trustProxy`, `serialize`, `docs` |
| [`jobs-api-socket-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/jobs-api-socket-options.ts) | every `websocket` option, per-channel subscribe refusals, replay and resume, coalesced progress, the client limits and every close code |

Supporting files for the tours:

- [`handlers/`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/10-options/handlers):
  runner handlers
- [`processors/`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/10-options/processors):
  isolated processors
- [`helpers/`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs/10-options/helpers):
  child scripts for the error and notifier tours

The full list of files is in the
[examples README](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/README.md).

## Related packages

- [`@kingsleyweb/bun-common`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md):
  the HTTP layer and utilities this package builds on (logging, backoff, error
  serialisation).
- [`@kingsleyweb/bun-nest`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-nest/README.md):
  a NestJS adapter built on bun-common.

## Development

From the repo root:

```bash
bun install
bun scripts/typecheck.ts                   # every project in the repo; must be clean
bun scripts/setup-databases.ts             # provide Redis, Postgres, MySQL, MariaDB, MongoDB
bun scripts/setup-databases.ts --docker    # containers instead, no root needed
bun scripts/setup-databases.ts --dry-run   # see the plan first
bun scripts/setup-databases.ts --print-env # just the env vars for the suites
```

Then, in `packages/bun-jobs`:

```bash
bunx eslint .    # lint the whole package; 0 errors
bun test         # tests
```

The setup script is safe to run repeatedly. It never reinstalls a server, and
it configures one only when connecting with the expected credentials fails.

The Redis, Postgres, MySQL, MariaDB and MongoDB integration suites skip
visibly unless their URL is set:

- `BUN_JOBS_TEST_REDIS_URL`
- `BUN_JOBS_TEST_POSTGRES_URL`
- `BUN_JOBS_TEST_MYSQL_URL`
- `BUN_JOBS_TEST_MARIADB_URL`
- `BUN_JOBS_TEST_MONGODB_URL`

The benchmarks use their own databases (Redis database 14 and
`bun_jobs_bench`), so they never disturb the test suite. See
[Benchmarks](#benchmarks).

## License

MIT
