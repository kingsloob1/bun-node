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

Bun runs the shipped TypeScript source (`main` is `lib/index.ts`), so there is
no build step on your side, and a runner's child-process and `Worker`
bootstraps run straight from `lib/runner/bootstrap/`. Your type checker reads
the built declarations in `dts/` (`types`), so your compiler options never
apply to this package's source. `mongodb` and `chrono-node` stay optional: no
shipped declaration imports either.

## Status

The package is being assembled in phases. What has landed on this branch, and
is documented below:

- the runner, with `BunRunnerManager` and per-run captured logs
- the queue and worker, including repeatable jobs, debounce and throttle,
  limits, dead letters, flows, isolated processors and job logs
- the `BunJobs` context, the job registry and the builder with dates in words
- `JobsNotifier`, one event stream per namespace
- remote control from any process: pausing, stopping, starting and
  reconfiguring workers, and overriding a runner's executor and overlap
  settings
- analytics: per-second and per-minute series of every queue's jobs, each
  runner's runs and durations, and each worker's jobs and busyness, served by
  the management API
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
  - [Queue job defaults](#queue-job-defaults)
- [Workers](#workers)
  - [Worker options](#worker-options)
  - [Retries and backoff](#retries-and-backoff)
  - [Rate and concurrency limits](#rate-and-concurrency-limits)
  - [Dead letters](#dead-letters)
  - [Pause, resume and shutdown](#pause-resume-and-shutdown)
  - [Controlling workers from another process](#controlling-workers-from-another-process)
  - [Stalled jobs](#stalled-jobs)
- [The job API](#the-job-api)
  - [Failing a job](#failing-a-job)
  - [Clearing a job's log](#clearing-a-jobs-log)
- [The BunJobs registry and builder](#the-bunjobs-registry-and-builder)
  - [BunJobs options](#bunjobs-options)
  - [Defining and adding jobs](#defining-and-adding-jobs)
  - [Typed jobs](#typed-jobs)
  - [Builder methods](#builder-methods)
  - [Saved drafts](#saved-drafts)
  - [Registry polling](#registry-polling)
  - [Dates in words](#dates-in-words)
- [Scheduling and repeatable jobs](#scheduling-and-repeatable-jobs)
  - [Disabling a series](#disabling-a-series)
- [Debounce and throttle](#debounce-and-throttle)
- [Flows](#flows)
- [Reading a queue: search, totals, workers and throughput](#reading-a-queue-search-totals-workers-and-throughput)
- [Who ran a job: worker attribution](#who-ran-a-job-worker-attribution)
- [Jobs added in a range, and sorting by creation time](#jobs-added-in-a-range-and-sorting-by-creation-time)
- [Isolated processors](#isolated-processors)
- [BunRunner](#bunrunner)
  - [Runner options](#runner-options)
  - [Triggers and run modes](#triggers-and-run-modes)
  - [Handlers, messages and kills](#handlers-messages-and-kills)
  - [Run logs](#run-logs)
  - [Introspection](#introspection)
  - [Clearing run history](#clearing-run-history)
  - [Changing a runner's configuration remotely](#changing-a-runners-configuration-remotely)
  - [BunRunnerManager](#bunrunnermanager)
- [Events and JobsNotifier](#events-and-jobsnotifier)
- [Analytics](#analytics)
  - [The `metrics` option](#the-metrics-option)
  - [What is recorded](#what-is-recorded)
  - [Analytics per driver](#analytics-per-driver)
  - [Analytics in a driver of your own](#analytics-in-a-driver-of-your-own)
- [Management API](#management-api)
  - [Analytics routes](#analytics-routes)
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
| `mongodb` | `>=6` | the MongoDB driver. Imported only when that driver connects. Needs **MongoDB 4.2 or later**, with a raised [open-file limit](#open-file-limits). |
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
- **When a delayed job runs.** A worker promotes due delayed and retrying
  jobs whenever it runs out of work, and ends its idle wait when the next one
  is due; its promotion sweep also runs every `pollInterval`, at least once a
  second, whatever else the worker is doing. Between promotions a worker
  remembers when the next scheduled job is due, and does not ask the backend
  again before then. Anything this process schedules — added with a delay,
  rescheduled, or failed into a retry, through any queue, job or worker
  sharing the driver instance — clears that memory at once; a job another
  process (or another driver instance) schedules does not.

  That memory saves reads, not time. Every case is bounded by the same sweep:
  a job that comes due earlier than the remembered time runs at most one
  sweep interval (a second by default) late, whoever scheduled it, and the
  same bound already applied to a delayed job added while a worker was
  waiting. Measured across the backends, a job scheduled by another instance
  and due immediately ran 472–512 ms late, and one scheduled through the
  worker's own instance 7–698 ms late: the same bound either way.

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
| `jobId` | `string` | fresh id | The job's id, and also its idempotency key. Adding an existing id returns the stored job untouched (`wasAdded: false`) and emits `duplicate`. Checked — see [What an id may be](#what-an-id-may-be). |
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
- a number keeps that many jobs. On the SQL driver a count of 20 or more is
  enforced once every tenth of it (at most every 500 settles) per process,
  per queue and state, rather than on every settle, so up to that many extra
  jobs can be kept between sweeps (`removeOnComplete: 1000` keeps at most
  about 1,099 per process). A smaller count is exact;
- `{ count, ttl }` does both.

A `ttl` is enforced by the workers' maintenance: every minute a worker sweeps
expired jobs in batches of 100 while batches come back full, up to 5,000 jobs
or 500 ms per tick, and runs a catch-up pass a second later while a backlog
remains. On Redis the sweep also reaches expired jobs queued behind
long-lived ones, resuming from a saved cursor.

A flow child is never removed before its parent has recorded its outcome.

#### What an id may be

**Breaking change.** Ids you choose are now checked, and a bad one throws
`ConfigError` at the call that supplied it rather than being written. This
applies to `jobId`, a flow child's `jobId`, `debounce.id` / `throttle.id`, and
`repeat.key` (see [below](#repeat-keys-you-choose-are-namespaced)), checked
before anything is written.

An id is rejected when it is:

| Rejected | Why |
|---|---|
| empty | an id is an identity, and `""` names nothing |
| longer than **191 characters** | MySQL and MariaDB store ids as `VARCHAR(191)` and used to **truncate** silently, merging two jobs into one — after which neither id resolved |
| a control character (C0 `U+0000`–`U+001F`, NUL included; DEL and C1 `U+007F`–`U+009F`) | PostgreSQL rejects NUL outright while every other driver accepted it, so the same id worked on one backend and failed on another |
| starting with `.` | `.` and `..` are directories, and a dotfile hides from the tools people use to inspect a queue's directory |
| not well-formed UTF-16 (a lone surrogate) | it has no UTF-8 spelling, so a backend storing UTF-8 replaces it with U+FFFD — two different ids then collide — or refuses it |

Everything else is allowed, punctuation and unicode included — `:`, `|`, `@`,
`*`, `,`, spaces, emoji, **and `/`** all pass. The rule is a denylist on
purpose: this package builds its own ids by joining text with `:` and `|`, and
an ordinary cron series contributes spaces, `*`, `,` and `@`, so anything
tidier would reject the library's own ids.

Slashes are allowed deliberately. It is tempting to refuse them because the
file driver turns an id into a file name, but `encodeName` escapes every
character, so a slash was never a path hazard there — what actually bounds a
file name is the encoded *byte* length, which that driver checks itself (see
below). Tenant-scoped ids like `tenant/7` work, and the management API
URL-encodes them (`GET /queues/mail/jobs/tenant%2F7`).

The cap is **one number for every driver**, set by the tightest of them. 191
characters is itself the widest a `utf8mb4` id column can be while the
composite claim index stays inside InnoDB's 3,072-byte key limit
(191 × 4 × 4 + 12 = 3,068), so it is a ceiling rather than a preference.

Ids and names this package *derives* — a dead-letter copy's id, a repeat
occurrence's, a debounced job's, a window pointer's name, a generated series
key — are shortened to fit rather than refused, so a long but legal id never
makes a later step throw. They are fitted to the tightest store: 191 characters
*and* the file driver's 201-byte encoded budget below. Shortening keeps the
start and appends `~` and a hash of the whole, so two long names stay distinct,
and it is deterministic, so every process derives the same one.

**One more limit, on the file driver only.** The character cap does not bound a
*file name*. `encodeName` expands per character — 9 bytes for a character
outside Latin such as `漢`, 12 for an emoji — so 120 perfectly legal
characters can encode to over 1,000 against a budget of 201 (`NAME_MAX` 255,
less 54 for the marker and temp-file suffixes). The file driver refuses such an id — and a queue-state name of
yours, from `setQueueState` — before writing anything, naming the encoded byte
size and the limit. Lowercase letters and digits encode to one byte each, so
an id of those alone never comes near it; an uppercase letter takes two (the
encoding is case-proof), so 101 capitals already exceed it. Repeat keys are
exempt: the file driver fits their file names itself.

**On MySQL and MariaDB, namespaces and queue names are limited to 191
characters** — the width of those columns — although the shared check allows
200. A longer one throws `ConfigError` instead of being truncated, as it used
to be. A long queue name also leaves less room in the 191-character key under
which that driver stores a queue's state and repeat entries: names that no
longer fit are fitted as above, and a queue name that leaves no room at all is
refused with `ConfigError`.

#### Reserved queue-state names

**Breaking change.** Debounce and throttle pointers are now stored under
`__win:` — `__win:debounce:<id>` and `__win:throttle:<id>` — and that prefix is
reserved: `setQueueState` throws `ConfigError` for any name beginning with it.
The library's own writes carry a private token that no option you can pass
reproduces, so the reservation cannot be bypassed from outside.

This fixes a data-loss bug. Pointers used to be named `debounce:<id>`, a name an
application could choose too, and the window sweep deleted whatever it found
under it — so a `debounce:`-prefixed entry of your own silently vanished at the
next sweep.

*Migration: wait one window.* Pointers written by an earlier version are
orphaned under the old names. Nothing reads them, and each expires by its own
TTL, so they clear themselves once every window that was open at upgrade has
passed. Debounced adds during that time open a fresh window rather than joining
the orphan, which at worst means one extra job per id.

#### Repeat keys you choose are namespaced

A `repeat.key` you supply is **stored** namespaced, as `k:<your key>`, so one
job can no longer pass another job's generated key and take that series over.
Generated keys — `<name>|<schedule>|<start>` — are unchanged, except that one
longer than 191 characters is now shortened to fit (it is stored in a column of
that width on MySQL and MariaDB). Such a series registers again under the
shortened key on its next `add`, and the old one stays until removed.

A key you supply is checked by the same rules as an id
([above](#what-an-id-may-be)), at `add()` and before anything is written, with
one tighter bound: at most **189 characters**, since it is stored with the
two-character `k:` in front.

**For almost everyone this is invisible.** The prefix is hidden everywhere it
would surface: `job.repeatKey`, `listRepeatables()[].key`, the
`repeatScheduled` event payload, and the occurrence id
(`repeat:<key>:<runAt>`). `removeRepeatable()` takes either spelling, and a
series that is *listed* as the key you pass wins over one merely *stored* that
way: with series keyed `nightly` and `k:nightly`, listed as exactly that,
`removeRepeatable("k:nightly")` removes the second.

**The one exception**, and the reason for it: if your key itself contains `|`,
the prefix stays visible. A generated key always contains `|`, so a key like
`report|every:60000|` could be either — and hiding the prefix would make two
genuinely different series display identically. That is not merely confusing:
the occurrence id is built from the key and is the idempotency key for
scheduling, so two series that displayed alike would derive the *same*
occurrence id at the same instant and silently merge into one job, losing one
series' run. Keys without `|` can never collide with a generated key, which is
why they are safe to show bare.

*Migration:* a series with a custom key re-registers under the new name on its
next `add`, and the old series stays until you remove it. `listRepeatables()`
shows both; `removeRepeatable(key)` accepts either spelling — the key as listed,
or the one you originally supplied — so removing the stale one is
`await queue.removeRepeatable("<your key>")` against the old, unprefixed entry.

### Queue options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `namespace` | `string` | required | The namespace the queue belongs to. |
| `driver` | `JobsDriver \| DriverConfig` | a new memory driver | Where jobs live. A config is built and closed here; an instance is shared. |
| `logger` | `LoggerLike` | no-op | See [Logging](#logging). |
| `defaultJobOptions` | `JobOptions` | | Merged under every `add()`. |
| `jobDefaultsRefreshInterval` | `number` | `1000` | How long the queue's stored job defaults are trusted before being re-read, in ms: how long a saved change takes to reach this producer, plus one read. `0` reads them on every add. See [Queue job defaults](#queue-job-defaults). |
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
| `list(state \| states, { offset, limit = 100, order = "asc", sort = "natural" })` | Returns jobs in the given state or states. Also takes `name`, `search`, and the worker and finish-time filters `workerKey`, `workerId`, `finishedFrom` and `finishedTo`. See [Who ran a job](#who-ran-a-job-worker-attribution). `sort: "createdAt"` orders by creation time on memory, SQL and MongoDB; see [sorting by creation time](#jobs-added-in-a-range-and-sorting-by-creation-time). |
| `count()` / `count(state)` | Returns counts for every state, or for one. |
| `countAdded({ from, to })` | Of the jobs added in `[from, to)`, how many are in each state now. Memory, SQL and MongoDB only; see [Jobs added in a range](#jobs-added-in-a-range-and-sorting-by-creation-time). |
| `update(id, { data?, priority?, runAt?, onlyIn? })` | Patches a stored job. `runAt` moves only a waiting or delayed job. `onlyIn` makes the change conditional on the job's state. |
| `remove(id)` | Removes a job. Refused while the job is active. |
| `retry(id, { resetAttempts = true })` | Returns a finished job to the queue. |
| `retryJobs(ids, opts?)` | Retries several jobs, and returns the ids that went. |
| `retryAll(state, { name?, reason?, filter?, limit?, resetAttempts? })` | Re-drives every matching `dead`, `failed` or `completed` job, walking the state one page at a time. |
| `promote(id)` | Makes a delayed or retry-pending job claimable now. |
| `getJobLogs(id, { offset, limit, order })` | Returns a page of a job's log. |
| `clearJobLogs(id)` | Empties a job's log, and answers `{ status: "cleared", removed }`, `{ status: "active" }` (refused, nothing removed) or `{ status: "missing" }`. See [Clearing a job's log](#clearing-a-jobs-log). |
| `pause()` / `resume()` / `isPaused()` | Pauses or resumes claiming for every worker in every process. |
| `drain({ delayed = false })` | Drops pending jobs and returns the count. It never touches jobs that are running. |
| `clean(state, { olderThan, limit = 1000 })` | Removes jobs in `state` older than `olderThan` ms. |
| `setLimits(limits \| null)` / `getLimits()` | Cluster-wide limits. See [Rate and concurrency limits](#rate-and-concurrency-limits). |
| `getJobDefaults()` | The queue's job defaults: `code`, the stored `override`, `effective`, `overridden`, `seq`. See [Queue job defaults](#queue-job-defaults). |
| `setJobDefaults(patch, { expectedSeq? })` / `resetJobDefaults({ expectedSeq? })` | Merges into, or clears, the queue's stored job defaults. `null` clears one key. |
| `applyJobDefaults({ seq, keys?, states?, limit?, cursor?, dryRun?, includeUnmarked? })` | Rewrites jobs already pending with the stored job defaults, one bounded call of a resumable walk. |
| `cleanWindows({ limit = 1000 })` | Removes stale debounce and throttle pointers. Workers also do this once a minute. |
| `listRepeatables()` / `removeRepeatable(key)` | Lists repeat series, each with `disabled`, or removes one along with its scheduled occurrence. Removing a series clears its disabled flag. |
| `disableRepeatable(key)` / `enableRepeatable(key)` | Stops a series without removing it, or restarts it. See [Disabling a series](#disabling-a-series). |
| `close()` | Closes the subscription, and the driver if the queue built it. |

### Queue job defaults

A queue's job options can be changed while it runs: store an override on the
queue, and every producer in every process adds under it. The override lives
in queue state, beside [limits](#rate-and-concurrency-limits), so every
built-in driver can hold one.

```ts
await queue.setJobDefaults({
  attempts: 5,
  backoff: { type: "exponential", delay: 1_000, max: 60_000 },
  removeOnComplete: { count: 1_000 },
});
await queue.setJobDefaults({ attempts: null }); // one key back to the code's value
await queue.resetJobDefaults(); // all of them
```

**Precedence**, highest first, key by key:

1. an option passed explicitly on the job's own `add()`;
2. the stored override;
3. a [`define()`](#defining-and-adding-jobs) definition's options, for its
   name;
4. the queue's `defaultJobOptions`;
5. the built-ins.

The override beats a `define()` default: only `add()` wins. Each key is
replaced whole — an override's `backoff` replaces the code's whole object.
The editable keys are `attempts`, `backoff`, `timeout`, `priority`,
`removeOnComplete`, `removeOnFail`, `keepLogs` and `keepStacktraces`
(`JOB_DEFAULT_KEYS`). Each is bounded by `JOB_DEFAULTS_BOUNDS`: `attempts`
1–1,000, `timeout` at most a day, `keepLogs` at least 1 (a stored override
cannot turn on "keep every line"), `keepStacktraces` at most 100, a retention
`ttl` at most a year. `backoff` may name only `fixed` or `exponential`, which
need no strategy registered on the worker. A value outside them is a
`ConfigError`, and nothing is written.

`getJobDefaults()` answers `code` (this instance's `defaultJobOptions` over
the built-ins), the stored `override`, `effective` (what a job passing none of
the options gets), `overridden`, `seq` and `updatedAt`. The writes take
`expectedSeq` for a safe read-modify-write: a write that finds the override
moved on changes nothing and answers `contended: true`. A reset stores an
empty override rather than deleting it, so `seq` keeps rising.

**Propagation.** A producer trusts its read for `jobDefaultsRefreshInterval`
(1,000 ms by default), then reads again before its next add. A producer
adding steadily renews that read in the background once three quarters of the
interval have passed, so its adds do not wait for it; nothing older than the
interval is ever used. So a change
reaches every producer within about a second, plus one read, on every driver.
The instance that wrote it uses it at once. A warm add reads nothing, and
`addBulk` reads at most once per call. A worker reads the override the same
way, to build a repeat series' next occurrence. A job added inside that
window keeps the old values.

**Explicit options are recorded.** Every job added from this version on
stores which of the editable options its own `add()` passed. The management
API shows them as `opts.explicit`, key names in `JOB_DEFAULT_KEYS` order. A
job added before this version has no record, and no `explicit`.

#### Rewriting jobs already pending

A save changes only jobs added afterwards. `applyJobDefaults()` rewrites the
backlog with the stored override's values:

```ts
const { seq } = await queue.getJobDefaults();
let cursor: string | null = null;
do {
  const step = await queue.applyJobDefaults({ seq, cursor, limit: 1_000 });
  console.log(step.rewritten, step.exhausted);
  cursor = step.next;
} while (cursor !== null);
```

- **States.** It walks `waiting`, `delayed`, `failed` (retry pending) and
  `waiting-children`, in claim order (`states` narrows them). Never `active`:
  its worker already holds its own copy. Never `completed` or `dead`.
- **Keys.** It writes only keys the override sets (`keys` narrows them), and
  never a key the job's own `add()` passed: a job with an explicit `priority`
  keeps it and still gets the new `attempts`. A job all of whose changing keys
  are explicit is counted `skippedExplicit`.
- **Older jobs.** A job added before the explicit record existed is skipped
  and counted `skippedUnmarked`, unless `includeUnmarked: true`, which treats
  every option of it as defaulted, including ones its `add()` may have passed.
- **`attempts` below `attemptsMade`** is written, not clamped. The job runs
  once more, and dies if that attempt fails. Such jobs are counted
  `exhausted`, within `rewritten`.
- **`priority`** reorders the backlog as the walk goes, keeping FIFO among
  equals.
- **Pinned.** Each call re-reads the override and throws
  `JobDefaultsChangedError` (API: 409 `DEFAULTS_CHANGED`) when its `seq` is no
  longer the one passed, writing nothing. A walk of many calls applies one
  version, or stops.
- **Bounded and resumable.** One call examines at most `limit` jobs (default
  1,000) and answers `next`; pass it back as `cursor`. A cursor names the walk
  that issued it: one from another namespace or queue, another `seq`, or other
  `keys` or `states` is a `ConfigError` (API: 400 `INVALID_ARGUMENT`), never
  resumed.
- **Atomic per job.** A job claimed meanwhile is skipped, never half-written:
  its options, `maxAttempts` and priority change in one write that re-checks
  its state.
- **`dryRun: true`** walks and counts exactly as a real call, and writes
  nothing.
- An override that sets nothing, or `keys` naming one it does not set, is a
  `ConfigError`.

**It is irreversible.** A rewritten job's earlier values are not kept, and
the server never knows the code's values, which live in each producer. So a
reset changes new jobs only: the jobs a walk rewrote keep the override's
values, and after a reset the override sets nothing, so there is nothing left
to apply.

`examined` can exceed the backlog: a job whose new priority moves it later in
the walk is met again, and counted `unchanged`. On Redis that can reach about
twice the backlog. `moved` counts jobs that left the walked states between a
batch's read and its write. It is a lower bound, since drivers that lock or
run a batch atomically never see one.

What one rewrite costs, per driver (measured on a loaded development machine;
the SQL figures on 20,000 waiting jobs):

| Driver | Unit of work | Per job | Against claims |
|---|---|---|---|
| memory | the whole call, in one synchronous pass | in-process | atomic: it runs without yielding |
| Redis | one Lua script per batch of at most 200 jobs, and at most 1 MiB of stored job blobs | about 15 µs (200 small jobs ≈ 3 ms a script) | a script blocks every client while it runs, so a claim waits at most one script |
| Postgres, MySQL, MariaDB | one transaction per 500 jobs, on the claim index (MySQL and MariaDB force it with `FORCE INDEX`, and fall back when it is missing) | 38–57 µs | row locks, which a claim skips (`SKIP LOCKED`) rather than waits on |
| SQLite | one transaction per 200 jobs | 7–12 µs | the transaction is the database's write lock, so claims wait for each batch |
| MongoDB | one `find` of 500 jobs on the claim index, then one unordered `bulkWrite` of compare-and-set updates | not measured | nothing locked; a job changed between the read and the write fails its filter and counts `moved` |
| file | each job under its own hold, 16 in flight | about a millisecond or more, growing with the queue (a single job update measured 0.9–5 ms) | a claim finding a job held moves on to the next |

A dry run costs 3–8 µs per job on SQL. A `priority` change also moves each
job it writes in the claim index.

In the management API these are `GET`, `PUT` and `DELETE
/queues/:queue/job-defaults` and `POST /queues/:queue/job-defaults/apply`.
Saving (`queues.defaults`) and applying (`queues.applyDefaults`) are separate
actions, both off by default, so a host can let operators tune defaults for
new work without letting them rewrite a backlog. `limits.maxApplyDefaults`
caps one call's `limit`.

Example:
[`10-options/job-defaults.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/job-defaults.ts).

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
| `key` | `string` | `[service.]queue[.name\|.ordinal]`, or `id` when one is given | The worker's **stable** identity: a remote configuration override is keyed by it, so the override survives restarts and redeploys and reaches every replica. Analytics record under it too. Set it to name a worker something an operator will recognise. |
| `service` | `string` | `BunJobs`'s `service` | The service the worker belongs to: reported in its record, and the first segment of the derived `key`. |
| `name` | `string` | | What to call the worker within its queue when a service runs more than one there, so they can be configured apart. The last segment of the derived `key`; prefer it over the ordinal `BunJobs` assigns, which shifts once a worker's creation becomes conditional. |
| `concurrency` | `number` | `1` | Jobs processed at once. Can also be set at runtime via `worker.concurrency`. |
| `lockDuration` | `number` | `30000` | How long a claim's lock lives. |
| `heartbeatInterval` | `number` | `lockDuration / 3` (min 250) | How often the lock is renewed. |
| `reportInterval` | `number` | `10000` | How often the worker writes its heartbeat record, which `queue.listWorkers()` and the management API's worker routes read: once per interval, and on start, pause, resume and a concurrency change, never per job. A record lapses three intervals after its last write. `0` turns reporting off. See [Workers](#reading-a-queue-search-totals-workers-and-throughput). |
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
| `jobDefaultsRefreshInterval` | `number` | `1000` | How long the queue's stored job defaults are trusted before being re-read. The worker reads them only to build a repeat series' next occurrence. See [Queue job defaults](#queue-job-defaults). |
| `waitToExit` | `boolean` | `true` | Keep the process alive while waiting for work. `false` lets a script exit when its own work is done. The Redis, Postgres and MongoDB clients hold the process on their own, so close the driver in that case. |
| `publish` | `boolean` | `false` | Publish job events (active, progress, completed, failed, stalled, and so on) for other processes. |
| `publishGate` | `() => Promise<void>` | | Awaited before each publish. |
| `remoteControl` | `boolean \| WorkerRemoteControlOptions` | `false`; `true` for a worker `BunJobs` builds | Obey pause, resume, stop, start and configuration overrides written by another process, such as the [management API](#routes). `true` subscribes where the driver pushes events and polls where it does not (one change counter per queue per driver instance every `interval`, shared by all its workers there; a worker reads its own instructions only when that counter moves); `{ enabled, subscribe, interval }` overrides either choice, `interval` defaulting to `2000`. The heartbeat re-reads the stored instructions too, so a lost event costs at most one `reportInterval`. On a driver without queue state the worker reports `control.enabled: false` and simply runs. |
| `stopPersistence` | `"process" \| "key"` | `"process"` | How long a remote `stop` lasts. `"process"` records it against this incarnation, so a restart brings the worker back running; `"key"` also records it against `key`, so every worker with that key applies it at startup until somebody starts it. |
| `stopPersistenceOverridable` | `boolean` | `false` | Whether one instruction may ask for the other `stopPersistence`. Off, the process rather than the caller decides whether a stop outlives it. On, the worker also obeys a stop recorded against its key at startup (as a `persist: "key"` stop writes), and any start clears that record. |
| `metrics` | `MetricsOptions` | everything on | What this worker records for [analytics](#analytics): its jobs completed and failed, under its stable key, and a busyness sample on each heartbeat report. `{ workers: false }` stops both, whatever the driver, and is the first lever for a large fleet. `resolution` and `secondRetentionMs` reach only a driver built here from a config. See [The `metrics` option](#the-metrics-option). |

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

The lease is short and kept alive by a heartbeat, not by a long timeout: a
claim's lock lives `lockDuration` (30 s by default) and the worker renews it
every `lockDuration / 3` (10 s, floored at 250 ms). So a worker that dies —
crash, `SIGKILL`, a machine that disappears — stops renewing at once, its
locks lapse 30 s later, and the next [stalled sweep](#stalled-jobs), which
runs every `stalledInterval` (30 s), hands its jobs back to the queue. With
the defaults that is under a minute from death to retry, and both numbers are
yours to shorten.

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

A job failed from outside its processor with `job.fail()` is copied only to
its own `deadLetter` queue, since no worker is involved; failed from inside
its processor, it is filed like any other death on that worker.

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
- `worker.stop({ timeout?, reason? })` parks the worker instead: it stops
  claiming and running maintenance, drains its jobs in flight, and keeps
  heartbeating, so `worker.start()` (or a
  [remote `start`](#controlling-workers-from-another-process)) can bring it
  back. `run()` stays pending while it is parked. `timeout` abandons the jobs
  still running after that many milliseconds, which `close()` also does.
  `worker.state` reads `running`, `paused`, `stopping`, `stopped` or
  `restarting` (a moment while a configuration override is applied), and
  `worker.isStopped()` is true while stopping or stopped.

Examples:

- [`09-integrations/graceful-shutdown.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/09-integrations/graceful-shutdown.ts)
- [`06-failures/timeouts-and-cancellation.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/06-failures/timeouts-and-cancellation.ts)

### Controlling workers from another process

`jobs.workers.remote(queue)` returns a `RemoteWorker`, which pauses, resumes,
stops and starts the workers of one queue, and overrides their settings,
wherever they run. It works the way [`RemoteRunner`](#bunrunnermanager) does:
each call stores what it asks for in the driver and publishes a worker
`control` event, and the worker applies it when it hears the event, at its
next control poll, or at its next heartbeat report if the event is lost. No
worker has to be reachable for the call to succeed.

```ts
const jobs = new BunJobs({ namespace: "shop", driver, service: "billing" });
jobs.worker("mail", sendMail); // key "billing.mail"

// In any process sharing the driver and namespace:
const mail = jobs.workers.remote("mail");

await mail.pause({ key: "billing.mail" }); // every replica with that key
await mail.resume({ key: "billing.mail" });

const [oldest] = await mail.list();
if (oldest) {
  await mail.stop({ id: oldest.id }, { timeout: 60_000 }); // one process only
  await mail.start({ id: oldest.id });
}

export const stored = await mail.setConfig("billing.mail", { concurrency: 16 });
await mail.resetConfig("billing.mail"); // back to what the code asks for
```

A worker has two identities, and the two kinds of call use different ones:

- **Pause, resume, stop and start** take a `WorkerTarget`: `{ id }` for one
  incarnation, or `{ key }`, which reaches every live worker carrying that
  stable key. The instruction records the incarnation it was written for, so
  the process that replaces a worker never applies it: a deployment comes
  back running. A stop outlives a restart only when it is recorded against
  the key: on a worker whose `stopPersistence` is `"key"`, or one sent with
  `persist: "key"` to a worker whose `stopPersistenceOverridable` is on (see
  [Worker options](#worker-options)).
- **Configuration** is stored against the stable key alone, so it survives
  restarts and reaches every replica, including one started tomorrow. The
  key is `[service.]queue[.name|.ordinal]` unless you set `key`; `BunJobs`'s
  `service` option supplies the first segment.

| Method | What it does |
|---|---|
| `list()` | Every live worker on the queue, oldest first, as `WorkerInfo` records carrying `key`, `service`, `state`, `config` and `control`. Throws `NotSupportedError` on a driver that keeps neither worker records nor queue state, as `queue.listWorkers()` does. |
| `get(id)` | One live worker by its incarnation id, or `null`. |
| `listConfigs()` | Every override stored on the queue, including those whose workers are gone. |
| `getConfig(key)` | The override stored for one key: `{ queue, key, values, seq, updatedAt }`, with `values: {}` and `seq: 0` when there is none. |
| `pause(target)` | Stops the target claiming. Jobs in flight carry on. Throws `WorkerStateConflictError` (code `WORKER_STATE_CONFLICT`), and writes nothing, when a target worker is `stopped` or `stopping`: start it first. For a `{ key }` target, one parked replica refuses the whole call, so address the running ones by id. |
| `resume(target)` | Resumes a paused target. Refused the same way from `stopped` or `stopping`: use `start()`, which also clears `paused` and calls off a stop still draining. |
| `stop(target, { persist?, timeout? })` | Parks the target, as `worker.stop()` does. `timeout` (ms, at most `WORKER_STOP_TIMEOUT_MAX`, one hour) abandons the jobs still running when it expires: their locks lapse and another worker runs them again from the start as stalled jobs, which is why waiting is the default. A worker ignores a timeout outside that range, stops anyway, and says why in `control.lastError`. `persist` asks for the other `stopPersistence`, and only a worker whose `stopPersistenceOverridable` is on honours it. |
| `start(target)` | Brings a parked target back and clears `paused`. A stop still draining is called off. |
| `setConfig(key, values, { expectedSeq? })` | Merges `values` into the key's override, and a field given as `null` is removed. With `expectedSeq`, it writes nothing and reports `contended: true` if the stored version is no longer that one. Without it, two callers editing different fields both land. An unknown key, or a value outside `WORKER_CONFIG_BOUNDS` (or a fraction for `concurrency`/`maxStalledCount`), throws a `ConfigError` naming the key and the bound, and nothing is written. |
| `resetConfig(key)` | Empties the key's override, so its workers go back to their own options. |

The lifecycle calls resolve to a `WorkerControlResult`,
`{ desired, instances: [{ id, seq, applied }] }`, and the configuration calls
to a `WorkerConfigResult`,
`{ queue, key, values, seq, updatedAt, contended, instances: [{ id, applied }] }`.
`applied` says whether the worker had **already** reported that version, so
right after a call it is usually `false`. To confirm, read the worker again and
compare its `control.appliedSeq` (lifecycle) or `control.configSeq`
(configuration) with `seq`.

An override may set the settings in `WORKER_CONFIG_KEYS`: `concurrency`,
`pollInterval`, `maxBlock`, `lockDuration`, `heartbeatInterval`,
`stalledInterval`, `maxStalledCount`, `reportInterval` and `drainDelay`, each
within `WORKER_CONFIG_BOUNDS`. A worker applies it in place, without a
restart. `setConfig()` refuses a value outside those bounds. The worker still
drops any stored field it cannot accept (a `heartbeatInterval` over half its
effective `lockDuration`, or an entry written by hand or by a newer version),
keeps its own value for that field, and reports why in `control.lastError`. An override never stops a worker from
running.

**`RemoteWorker` checks less than the [management API](#routes).** It is the
lower-level call, and the API's checks sit on top of it:

- A target that matches no live worker is not an error: `instances` is empty.
  The API answers 404 `WORKER_NOT_FOUND`.
- It does not check that the worker obeys. One built with `remoteControl`
  off never applies the instruction, and its record says
  `control.enabled: false`. The API answers 409 `WORKER_NOT_CONTROLLABLE`.
- `pause()` and `resume()` refuse a `stopped` or `stopping` worker with
  `WorkerStateConflictError`, before writing anything, as the API answers
  409 `WORKER_STATE_CONFLICT`. A parked worker comes back through `start()`.
- `setConfig()` refuses an unknown key or an out-of-bounds value with a
  `ConfigError`. The API answers 400 `VALIDATION`, with the issue on the
  field, before it gets that far.

Every call except `list()`, `get()`, `listConfigs()` and `getConfig()` throws
`NotSupportedError` on a driver without queue state (`getQueueState`,
`setQueueState` and `listQueueState`). Every built-in driver has it.

**On the worker's side.** A worker obeys only with `remoteControl` on, which
`BunJobs` turns on for every worker it builds (`workerRemoteControl: false`
opts a context out) and which is off for a `BunQueueWorker` you construct. It
subscribes to its instructions where the driver pushes events (Redis,
memory) and polls every `remoteControl.interval` elsewhere. It exposes:

- `key`, `service` and `processStartedAt`, the start time that identifies
  this incarnation;
- `state` and `isStopped()`;
- `config`: `effective`, `code` (what its own options asked for),
  `overridden`, `derived` (settings whose code value was computed rather
  than given: `heartbeatInterval` when the options left it out), `seq` and
  `updatedAt`;
- `control`: `enabled`, `mode` (`"subscribe"` or `"poll"`), `appliedSeq`,
  `configSeq`, `pending`, `stopPersistence`, `stopPersistenceOverridable` and
  `lastError`;
- `syncControl()`, which reads its stored instructions now instead of
  waiting for the next event or poll. A `RemoteWorker` in the same process
  calls it after each lifecycle call.

A worker with `publish` on (or `publishEvents` on its `BunJobs`) publishes a
worker `state` event on each change of state and a `config` event when it
adopts an override. A first start is announced with no `previous`: the first
`run()` publishes one `state` event with the state the worker came up in —
`running`, `paused` when it was paused before `run()`, or `stopped` (reason
`"stopped persistently"`) under a stop recorded against its key. Nothing is
published before `run()`, and every later change carries `previous`, a
`start()` after a stop included. The `control` events are always published. A
`JobsNotifier` hears worker events only for the queues in its
[`workers`](#events-and-jobsnotifier) option.

Example:
[`10-options/remote-control.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/remote-control.ts).

### Stalled jobs

A worker that dies while holding a job stops renewing its lock. Every
`stalledInterval`, some worker's maintenance returns jobs with expired locks
to the queue and emits `stalled` with their ids. A job that has stalled more
than `maxStalledCount` times is buried in `dead` instead.

A recovered job keeps the dead worker's [`processedBy`](#who-ran-a-job-worker-attribution)
until another worker claims it, so you can still see which worker died holding it.

## The job API

`Job<TData, TResult>` is an immutable view of the stored record. Its mutating
methods go to the driver and return what the driver decided. Those that answer
with a job answer `this` type, or `null`: a job narrowed by a
[typed registry](#typed-jobs) stays narrowed.

| Member | Meaning |
|---|---|
| `id`, `name`, `data`, `opts`, `state`, `priority`, `runAt`, `createdAt` | Identity and placement. |
| `processedOn`, `finishedOn`, `expiresAt` | Timestamps (epoch ms), or `null`. |
| `attemptsMade`, `maxAttempts`, `stalledCount` | Attempt bookkeeping. |
| `progress`, `returnValue`, `failedReason`, `stacktrace` | Outcome. `progress` is a `RunProgress` (a number or a record), or `null`. Errors are rehydrated as `Error`s. |
| `workerId`, `lockToken`, `repeatKey`, `isRepeat`, `wasAdded`, `parent`, `queue` | Context. `workerId` is the worker holding the job right now: set while `active`, `null` once the attempt settles. |
| `processedBy` | The worker that claimed the current or last attempt, as `{ id, key?, host?, pid? }`. It is kept after the job settles, and it is `null` for a job never claimed. See [Who ran a job](#who-ran-a-job-worker-attribution). |
| `updateProgress(value)` | Records a number or an object, and emits `progress`. Inside a processor the value is written before the worker records how the job ended, whichever way it ended — see [Isolated processors](#isolated-processors). |
| `log(line)` / `getLogs({ offset, limit, order })` | The job's persistent log, capped at `keepLogs`. A line a processor logged is stored before the worker records how the job ended, as its progress is. |
| `clearLogs()` | Empties the log, as `queue.clearJobLogs(id)` does. Refused while the job is active. See [Clearing a job's log](#clearing-a-jobs-log). |
| `updateData(data)` | Replaces the data in any state. A running attempt keeps the data it started with. |
| `setPriority(n)` | Changes the priority. A waiting job moves in claim order. |
| `reschedule(when)` / `schedule(when)` | Moves a waiting or delayed job to a `Date`, epoch ms, or words (`"in 10 minutes"`). The two are one method. |
| `update({ data?, priority?, runAt?, onlyIn? })` | Changes several of those in one step, as `queue.update` does. `runAt` also takes words. |
| `fail(reason)` | Fails the job for good: it goes to `dead` whatever attempts it has left. See [Failing a job](#failing-a-job). |
| `disable()` / `enable()` | Stops or restarts the repeat series this job is an occurrence of. Throws `ConfigError` on a job in no series. |
| `promote()` | Makes a delayed or retry-pending job claimable now, and emits and publishes `promoted`. |
| `retry({ resetAttempts })` | Returns a finished job to the queue, and emits and publishes `retried`. |
| `remove()` | Removes the job, and emits and publishes `removed`. Refused while it is active. |
| `extendLock(ms?)` / `touch(ms?)` | Extends the lock, from the job the processor was handed only. Returns `false` once the lock is no longer yours, and always from any other view. |
| `refresh()` | Re-reads the job, or returns `null` if it is gone. |
| `getChildrenValues()` / `getChildrenFailures()` | Flow results, keyed `queue:id`. |
| `toJSON()` | The stored record. |

`remove()`, `promote()` and `retry()` announce themselves as the queue's
methods of the same name do: the queue or worker the job came from emits the
event locally, and publishes it when it publishes.

Example:
[`02-queues/job-lifecycle.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/job-lifecycle.ts).

### Failing a job

`job.fail(reason)` takes a string or an `Error` and sends the job to `dead`
for good, with an `UnrecoverableJobError` carrying `reason` (an `Error` is
kept as its `cause`). To have a job retried, throw from the processor instead.

- **From its own processor**, the attempt ends dead once the processor
  returns or throws. The reason given to `fail()` wins over anything thrown
  after it, and a second `fail()` call changes nothing. The job gets the
  worker's usual `failed` and `dead` events and dead letter.
- **From anywhere else**, the job is buried at once: a waiting, delayed,
  retry-pending or `waiting-children` job, or an active one still under the
  lock the view was read with. The worker running an active one loses its lock
  at the next heartbeat, and whatever the attempt returns or throws is
  discarded: that worker emits `lockLost`, never a second `failed` or `dead`. The
  job gets `failed` and `dead`, and a copy in its own `deadLetter` queue. A
  flow child's failure reaches its parent on the next maintenance pass.
  `fail()` answers `false` for a job that is finished, gone, or active under
  another lock, and throws `NotSupportedError` on a driver without `buryJob`.

```ts
const job = await queue.getJob(id);
await job?.fail("customer cancelled"); // dead now; no more attempts
```

In an isolated processor, `fail()` is kept by the child and sent as the
attempt's error when it settles.

### Clearing a job's log

`queue.clearJobLogs(id)` and `job.clearLogs()` delete every line a job has
logged, for good. Afterwards the log reads as one never written: `getLogs()`
counts `0`, the next `job.log()` answers `1`, and `keepLogs` trims from that
new first line. The job itself, its state, its data and every counter,
throughput figure and analytics series are untouched, and no event is sent.

```ts
const result = await queue.clearJobLogs(id);
// { status: "cleared", removed: 12 } | { status: "active" } | { status: "missing" }
if (result.status === "active") {
  // a worker is running it: nothing was removed; try again once it settles
}
```

- **Refused while the job is active**, with `{ status: "active" }` and nothing
  removed: its worker is still writing the log, and clearing it would leave a
  log that looks whole while missing its start. The driver checks the state in
  the same step as the removal, so a job claimed after you read it is refused
  too. `remove()` refuses an active job by the same rule.
- `{ status: "missing" }` for a job that does not exist.
- A driver without `clearJobLogs` throws `NotSupportedError`; nothing falls
  back to anything else.

In an isolated processor, `clearLogs()` is unavailable, as the other methods
that act on a job from outside its attempt are. Over the management API it is
`DELETE /queues/:queue/jobs/:id/logs` — see [Routes](#routes).

Example:
[`10-options/run-logs-and-clears.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/run-logs-and-clears.ts).

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
| `service` | `string` | | What this service is called. Every worker created here reports it, and it is the first segment of each worker's stable key, `[service.]queue[.name\|.ordinal]`. Set it whenever several services share a backend and a namespace: otherwise a [configuration override](#controlling-workers-from-another-process) written for `mail` reaches whichever of them consumes a queue called `mail`. |
| `workerRemoteControl` | `boolean` | `true` | Whether the workers created here obey pause, resume, stop, start and configuration overrides written by another process. It is passed as each worker's `remoteControl`, and a worker's own `remoteControl` option wins. On by default here, unlike on a `BunQueueWorker` you construct. It costs one subscription per worker where the driver pushes events, and, where it does not, one read per queue per driver instance every `remoteControl.interval` (2 seconds by default), plus each worker's two reads only when an instruction or override was written. See [Controlling workers from another process](#controlling-workers-from-another-process). |
| `metrics` | `MetricsOptions` | everything on, per-second, 5 minutes of it | What is recorded for [analytics](#analytics). Handed to the driver the context builds from a config (a config naming its own `metrics` wins), and merged field by field under every runner and worker created here, whose own `metrics` wins. See [The `metrics` option](#the-metrics-option). |

The context has these members:

| Member | What it does |
|---|---|
| `namespace` | The context's namespace. |
| `driver` | The backend everything here shares. |
| `logger` | The context's logger. |
| `driverConfig` | The config form of the backend, if the context was built from one. |
| `service` | The `service` option, or `undefined`. |
| `runners` | The context's [`BunRunnerManager`](#bunrunnermanager). |
| `workers` | The context's `RemoteWorkerManager`: `workers.remote(queue)` returns the [`RemoteWorker`](#controlling-workers-from-another-process) for that queue's workers, in any process. |
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
| `processEveryMs` | That interval in milliseconds, or `undefined` when it was never set. Readable before `start()`. |
| `publishesEvents` | Whether what the context creates publishes its events: the resolved `publishEvents` option, `false` when unset. The management API reports it as `publishing` on `GET /meta`. |
| `start(workerOpts?)` | Starts consuming the defined jobs. |
| `stop({ force?, timeout? })` | Stops consuming, letting in-flight jobs finish. |
| `drain({ delayed? })` | Drops pending jobs from the registry's queue. |
| `notifier(opts?)` | Opens a [`JobsNotifier`](#events-and-jobsnotifier). |
| `listQueues()` / `listRunners()` | Queue names and runner ids the backend knows about in this namespace. |
| `listWorkers()` | The workers consuming any queue in this namespace, from any process. See [Reading a queue](#reading-a-queue-search-totals-workers-and-throughput). |
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

### Typed jobs

Declare the service's job names and payloads once, as a map, and `define`,
`now`, `schedule`/`run`/`process`, `create` and the registry queue's `add`
check them at compile time:

```ts
interface Jobs {
  "send-report": { data: { month: string }; result: string };
  reindex: { data: void }; // `result` is optional; omitted means `unknown`
}

const jobs = new BunJobs<Jobs>({ namespace: "reports", driver });

// job.data is { month: string }, and the handler must answer with a string
jobs.define("send-report", async (job) => render(job.data.month));

await jobs.now("send-report", { month: "2026-08" }); // TypedJob<Jobs, "send-report">
await jobs.now("reindex"); // no payload declared, none needed

jobs.now("nope"); // error: not a declared name
jobs.now("send-report", { month: 8 }); // error: month is a string
jobs.now("send-report"); // error: the payload is required
```

An entry is always `{ data; result? }`. `data` is required — a job with no
payload declares `data: void` — and a bare payload type is deliberately not
accepted, because `{ data: Buffer }` would be ambiguous between an entry and a
payload that happens to have a `data` field.

`now()`, the registry queue's `add()`, a builder's `start()` and a draft's
`save()` (and its `job`) answer with a `TypedJob` of the name they were given:
a `Job` of that name's payload and result, whose `name` is the literal. A handler is typed by its name's `result`, literals included, so
`() => ({ via: "email" })` satisfies `result: { via: "email" }`. (A bare
literal from an `async` handler, `async () => "done"`, widens to `string` before
it is checked, as it would with any function type; write `"done" as const`.)

**The payload is required on `now()` and `add()`** unless leaving it out is a
valid payload — `void`, `undefined`, or a type that includes `undefined`.
`schedule`/`run`/`process` and `create` keep it optional, because the builder's
and the draft's `withData()` can supply it later.

**A union name takes a payload valid for every name in it.**
`jobs.now(name as "notify-email" | "notify-sms", { userId })` compiles when
both carry `{ userId: string }`; `name as "send-report" | "reindex"` accepts
nothing, since no payload is both `{ month: string }` and `void`. The job
answered with is a `TypedJob` of either name. A handler defined for a union
name must answer with a value valid for every name's result.

**Only the registry queue is typed by the map.** `jobs.queue("jobs")` — or the
name declared with `BunJobs<Jobs, "work">` — hands back the registry's queue
type: `add` takes a declared name and that name's payload. Every other name,
including a plain `string` known only at runtime, is a plain queue exactly as on
an untyped context. A registry queue other than `"jobs"` is declared as the
second type argument and must be passed as the option too; the two are checked
against each other:

```ts
const jobs = new BunJobs<Jobs, "work">({ namespace, driver, registryQueue: "work" });
jobs.queue("work"); // RegistryQueue<Jobs>
jobs.queue("jobs"); // a plain queue
```

**Reads are discriminated by name.** `getJob`, `getJobs`, `list` and `page` on
the registry queue answer with a `TypedJob<Jobs>`, so checking `job.name`
narrows `job.data` and `job.returnValue`. So do the handler `define` is given,
the queue's and the `start()` worker's event listeners, and `definitions()`.
Name-scoped events carry that name's own types:

```ts
const job = await jobs.queue("jobs").getJob(id);
if (job?.name === "send-report") job.data.month; // string

const worker = await jobs.start();
worker.on("completed:send-report", (job, result) => result); // result: string
```

The unscoped `completed` listener's `result` is the union of every declared
result, which is `unknown` as soon as one entry leaves `result` out — narrow
`job.name` and read `job.returnValue`, or listen on the scoped event, instead.
A read assumes every job on the registry queue is one the map declares.

**The registry queue's other writes follow the same rules.**

- `addBulk` entries are discriminated by name, so each payload is checked
  against its own entry. An array literal answers with a tuple, each job a
  `TypedJob` of its own entry's name; an array built elsewhere answers with
  `TypedJob<Jobs>[]`. The escape hatch below is `add` only: a bulk entry must
  be a declared name.
- `addFlow`'s `flow.job` is a `TypedJob` of the top node's name. It checks
  the top of the flow and every child that inherits the
  registry queue by leaving `queue` out. A child that names another queue is
  unchecked, as it would be on any untyped queue, and so are its children. That
  includes a child that names the registry queue itself: leave `queue` out for
  a node that belongs there.
- `update(id, { data })` is given an id, not a name, so the job could be any
  declared name, and `data` must be valid for all of them: object payloads
  that differ need every field of each (`{ id: string; width: number }`), and
  one beside `void` accepts nothing (`{ ... } & void`). When only the data changes and the job is in
  hand, narrow its name and call `updateData`, which is checked against that
  name's payload:

  ```ts
  const job = await queue.getJob(id);
  if (job?.name === "send-report") await job.updateData({ month: "2026-10" });
  ```

  For the other fields together, or with only an id, use the untyped view of
  the same queue, `jobs.queue<unknown>("jobs").update(...)`, after checking the
  job's name yourself.
- `retryAll`'s `filter` is handed a `TypedJob`, narrowed by `name` when one is
  given. A name the map does not declare, or a plain `string`, hands it a
  plain `Job<unknown, unknown>`, since nothing describes that job.

```ts
const queue = jobs.queue("jobs");
const [report] = await queue.addBulk([
  { name: "send-report", data: { month: "2026-08" } },
  { name: "reindex" },
]); // [TypedJob<Jobs, "send-report">, TypedJob<Jobs, "reindex">]
report.data.month; // string
queue.addBulk([{ name: "reindex", data: { month: "x" } }]); // error

await queue.addFlow({
  name: "send-report",
  data: { month: "2026-08" },
  children: [
    { name: "reindex" }, // inherits the registry queue: checked
    { name: "welcome", data: { to: "ops" }, queue: "mail" }, // unchecked
  ],
});

await queue.retryAll("dead", {
  name: "send-report",
  filter: (job) => job.data.month < "2026-06", // job.data: { month: string }
});
```

Two escape hatches keep other work possible:

| Escape hatch | For |
|---|---|
| `jobs.queue<Payload>("scratch")` with a `jobs.worker("scratch", ...)` | Ad-hoc work this service runs itself. A queue of its own, typed as you name it. |
| `queue.add<"audit", Payload>("audit", data)` | A name the map does not declare, on the registry queue, **for a deployment that defines it**. This service's own registry worker claims every job on that queue and fails one it has no definition for (`ConfigError: No job is defined for "audit"`), so only a service that defines the name can run it. Both type arguments are required: the name is spelled twice because TypeScript cannot infer one type argument while being told another. A declared name, or a plain `string`, is refused, so this can never carry the wrong payload for a declared name. |

A `BunQueue` built directly with `new BunQueue(...)` never knows a registry.

**Without the type argument nothing changes.** `new BunJobs({ ... })` accepts
any name and any `registryQueue`, still takes `TData` from `create<TData>()` or
from the payload passed in, and adds no new errors. Runtime behaviour is
identical either way: a name that was never defined throws `ConfigError`
whether or not the types would also have caught it.

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
| `limit(n)`, `tz(zone)`, `catchUp(on?)`, `immediately(on?)` | Repeat options. `limit` needs a series first (`every()` / `repeatEvery()`) and a whole number of at least 1; `tz` must be a zone `Intl` knows. Both throw `ConfigError` at the call otherwise. |
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
| `limit(n)`, `tz(zone)`, `endingAt(when)`, `catchUp(on?)`, `immediately(on?)` | Change one option of the series `repeatEvery` described, leaving the rest. Each throws `ConfigError` if there is no series yet, and `limit`/`tz` throw one for a limit that is not a whole number of at least 1 or a zone `Intl` does not know. |
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
- Date phrases are read at `save()`, not when they are set — so `"tomorrow"`
  means tomorrow from the save, and a phrase that cannot be read fails at
  `save()` too, naming the method it was given to and quoting it. Durations
  and intervals are still read at the setter.
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
`processEvery` option to `BunJobs` does the same before `start()`, and
`jobs.processEveryMs` reads back what was asked for — milliseconds, or
`undefined` when it was never set.

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
| `tz` | `string` | | The IANA time zone the cron expression is read in. It must be a zone `Intl` knows: `add()` throws `ConfigError` naming it otherwise (`repeat.tz does not know the time zone "…"`), before anything is written, and `repeatEvery(interval, { tz })` throws at the call. |
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

### Disabling a series

`queue.disableRepeatable(key)`, or `job.disable()` on an occurrence, stops a
series without removing it: its pending occurrence is removed and nothing
schedules another. `listRepeatables()` reports it with `disabled: true`, and
with `nextRunAt` and `nextJobId` both `null` — so does the management API.
`enableRepeatable(key)`, or `job.enable()`, restarts it from now; occurrences
it missed while disabled are not run. Both take either spelling of the key,
and answer whether they changed anything.

An occurrence already running when its series is disabled finishes. A worker
scheduling the next occurrence at that same moment may add one more, which
maintenance removes. The flag lives in reserved queue state, so both need a
driver with queue state (every built-in one), and removing a series clears
it.

Adding a disabled series again does not re-enable it, and schedules nothing.
`add(name, data, { repeat })` still replaces the series' stored definition —
its `every` or `cron`, `tz`, `limit`, payload and options — so enabling it
later schedules from the new definition. But it adds no occurrence, and
announces nothing: no `repeatScheduled` is emitted locally or published to
any other instance. It returns the occurrence that would have been scheduled,
unstored, with `wasAdded: false` — so code that adds its series on every start
keeps working after one is disabled, and `job.enable()` restarts it.

```ts
await queue.disableRepeatable("nightly-report");
await queue.enableRepeatable("nightly-report");
```

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

  Example:
  [`10-options/remote-control.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/remote-control.ts).

  A failed child that has since been removed counts as unsettled, so
  maintenance fails the parent again (see below).
- **Retention waits for delivery.** A child's `removeOnComplete` or
  `removeOnFail` never removes it before its parent has recorded its outcome.
  This includes a count or TTL applied by any other job.

**Healing.** Recording a child on its parent and applying the child's
retention are two separate steps, and both are safe to repeat. A delivery that
fails is retried within a few seconds by the worker that started it. One
worker per queue (whichever holds the queue's heal lease, handed over within
two `stalledInterval`s when it stops or dies) finishes, every
`stalledInterval`, whatever a crash left half done:

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

- **MongoDB** needs 4.2 or later for flows. It keeps every child's result on
  the parent's document, which MongoDB caps at 16 MB. A child whose result
  would take the parent past that can never be recorded, however often it is
  delivered, so rather than leave the parent waiting forever the driver buries
  it in `dead` with a `ChildFailedError` naming the child: its message says the
  result would take the parent past MongoDB's 16 MB document limit, and its
  `context` carries `limit: "16MB"` and `bytes`, the result's size as JSON.
  The same goes for the failure an `ignoreFailure` child records. From there
  it is an ordinary buried parent, and it travels up the flow. A parent already buried that cannot keep
  such a result for its retry stores nothing: a retry waits on that child
  again, and its delivery then buries the parent the same way. In a wide
  flow, return a reference to a large result rather than the result itself.
- **Redis in cluster mode**, with a child on another queue than its parent:
  whether a child's failure is stale (the child was retried, or already
  recorded) is read one round trip before the script that would bury the
  parent, not inside it, because the child's hash is in another slot.
  Everywhere else that check is inside the same atomic step.
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
concurrency, jobs in flight, jobs completed and failed since it started,
paused, started, last heartbeat, `rssBytes` and `heartbeatRttMs` — when it
starts,
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

**Two samples ride that write**, so neither costs a timer or a driver call of
its own, and both are **optional**: a record from an older worker, or one whose
first write has not returned yet, simply has no such field — absent, never `0`.

| Field | What it is |
|---|---|
| `rssBytes` | Resident set size in bytes at the last report, from `process.memoryUsage.rss()`. |
| `heartbeatRttMs` | How long the heartbeat write took, in milliseconds. |

- **`rssBytes` is the *process's* memory, not the worker's.** Two workers
  running in one process report the same number, and nothing apportions it
  between them, so **never sum the column**. To size a host, take one row per
  `pid` (with `host`) and add those.
- **`heartbeatRttMs` is a driver round trip, not a network ping** — the Redis
  script, the SQL upsert, the MongoDB replace or the file rename, plus whatever
  was queued in front of it. It is the **last sample, not an average**: a write
  cannot time itself, so the record carries the *previous* report's figure, and
  one slow number is as likely to be a single stalled write as a trend. Only a
  write that landed updates it; a failed one leaves the last good sample alone.

Examples:

- [`10-options/read-apis.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/read-apis.ts)
- [`10-options/jobs-api-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/jobs-api-options.ts)

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

Throughput is a minute per bucket, for one queue at a time. Per-second
buckets, the namespace total in one read, and series for runners and
workers are [analytics](#analytics).

## Who ran a job: worker attribution

Every job records the worker that claimed its current or last attempt as
`processedBy`: the worker's incarnation `id`, its stable `key`, and the `host`
and `pid` it ran on. The claim writes it in the statement or script it already
runs, so it costs no round trip of its own, and nothing that settles the job
clears it. It lasts as long as the job is retained.

```ts
const job = await mail.getJob("a41");
export const ranOn = job?.processedBy; // { id, key, host, pid }, or null

// What one worker key finished in the last hour, most recent first.
export const lastHour = await mail.list("completed", {
  workerKey: "mail.sender",
  finishedFrom: Date.now() - 3_600_000,
  order: "desc",
});

// Two incarnations over one day, with a total.
export const { jobs: day, total: dayTotal } = await mail.page(["completed", "dead"], {
  workerId: ["w-1a2b", "w-3c4d"],
  finishedFrom: new Date("2026-09-21T00:00:00Z"),
  finishedTo: new Date("2026-09-22T00:00:00Z"),
});
```

**What it means.**

- **Last attempt only.** Each claim replaces the whole stamp, so a job that
  failed on worker A and then completed on worker B names B alone. "The jobs a
  key processed" means the jobs whose last attempt it ran. While a retry is
  pending, the stamp names the worker whose attempt just failed.
- **A stalled job keeps the dead worker's stamp** until its next claim
  replaces it. "Last touched by the worker that died" is the diagnostic.
- **`null`** for a job that was never claimed, and for one last claimed
  before attribution existed.
- **A rolling upgrade can misattribute, for a while.** The stamp is a field
  of its own, and a worker still on an older version neither writes nor
  clears it. A job such a worker claims keeps whatever an earlier claim
  stored, so if a newer worker ran an earlier attempt, `processedBy` names
  that worker, which did not run the last attempt. Upgrade a queue's workers
  together, or treat attribution as reliable only once every worker runs the
  new version.
- **`workerId` means only "holding it right now", as it always has.** It is
  set while the job is `active` and `null` once the attempt settles, stalls or
  is released, so a finished job's `workerId` is `null` on every driver. To
  find who ran a finished job, read `processedBy`, which is new.
- The management API hides `host` and `pid` under `serialize.exposeHosts:
  false`, as it does on worker records. The driver stores them either way:
  the switch is about exposure, not recording.

**Which jobs have a `finishedOn`.** Only `completed` and `dead` ones. A
`failed` job is waiting to retry, so it has not finished and has no
`finishedOn`. The same is true of waiting, delayed, active and
waiting-children jobs.

**The four filters.** `queue.list()` and `queue.page()` take them alongside
`name` and `search`, and they AND with each other and with the states asked
for:

| Option | Matches |
|---|---|
| `workerKey` | `processedBy.key`, exactly: one key or an array. A job never claimed, or stamped without a key, never matches. An empty array matches nothing. |
| `workerId` | `processedBy.id`, exactly: one incarnation or an array. An empty array matches nothing. |
| `finishedFrom` | `finishedOn` at or after this instant (**inclusive**), as a `Date` or epoch ms. |
| `finishedTo` | `finishedOn` before this instant (**exclusive**), as a `Date` or epoch ms. |

Only `completed` and `dead` jobs can match a range, because no other state has
a `finishedOn`. Both filter families narrow the jobs before the page is cut,
so `offset` counts matches.

Three mistakes throw a `ConfigError` rather than answer an empty page, which
would read as "that worker ran nothing". They are the requests the management
API refuses with 400 `INVALID_ARGUMENT`:

- a bound that is not a valid date or timestamp;
- a range whose end is not after its start, an inverted or empty range. A
  range one millisecond wide is fine;
- `workerKey` or `workerId` on a driver whose `capabilities.jobAttribution`
  is `false`, since no job there carries a stamp to match. The message says to
  run `syncSchema()` on SQL. A range alone needs no stamp and works on every
  driver.

The API's cap of 100 values per worker filter is the API's alone: it bounds
what one request may ask, and `queue.list()` takes any number.

**Pair `workerKey` with a date range.** No backend indexes the key, and a
queue usually has one key shared by all its replicas, so a key alone reads
every job in the states asked for. A range narrows that to finished jobs in the
window first:

| Driver | A worker filter | A `finishedOn` range |
|---|---|---|
| memory | one pass over the queue | the same pass |
| file | reads each record in those states | lists only the finished markers whose names fall in the window, and opens those |
| sql | `processed_by_key`/`processed_by_id IN (…)` within the `(ns, queue, state)` index range | `finished_on` bounds on `completed`/`dead` only. On SQLite a partial index on finished jobs serves them; elsewhere they are conditions within the same range |
| mongodb | `processedBy.key`/`processedBy.id` `$in`, within the same index range | a bounded scan of the existing `(ns, queue, state, finishedOn)` index |
| redis | matched in Lua, 500 jobs a call, reading only the fields it needs | a rank window on the completed and dead sorted sets, found with two `ZCOUNT`s |

**Where the stamp is stored.**

- **SQL**: four nullable columns, `processed_by_id`, `processed_by_key`,
  `processed_by_host` and `processed_by_pid`. `worker_id` stays holder-only
  and is still cleared on settle. A table created before those columns needs
  [`syncSchema()`](#schema-sync) before anything is stamped (see below).
- **Redis**: one packed hash field, `wk`, holding the id, key, host and pid
  with a length prefix on each part, so no character in a key or host can
  move a boundary. One field rather than four because a hash stores every
  field name beside its value, and on Redis that is RAM paid by every
  retained job. The `workerId` field stays holder-only.
- **MongoDB**: a `processedBy` sub-document on the job, set whole by the
  claim. `workerId` stays holder-only.
- **File**: in the job's record, beside everything else.
- **Memory**: on the record.

**SQL tables from before attribution.** The driver's
`capabilities.jobAttribution` is **live** on SQL. It reads `false` until
connecting has confirmed the four columns, so it is `false` before
`connect()`, and stays `false` on a jobs table without them. It turns `true`
once `syncSchema()` adds them, whether on connect (`syncSchema: true`) or
explicitly. While it is `false`, claims run without the stamp and nothing is
recorded. A process that did not run the sync itself notices another
process's sync within about 60 seconds. Until then, `queue.list()` and
`queue.page()` throw a `ConfigError` on a worker filter, and the management
API refuses one with a 400. Both tell you to run the sync. A `finishedOn`
range is answered throughout.

**Custom drivers.** Declaring `capabilities.jobAttribution: true` promises
three things, which the shared driver contract checks:

- every claim path, singular and plural, stores `processedBy` from
  `ClaimOptions.workerId` and `ClaimOptions.worker`, in the write the claim
  already makes;
- no settle, stall recovery or retry clears it, and only the next claim
  replaces it. A record added with a stamp, restored from elsewhere, keeps it;
- `findJobs` honours `workerKeys`, `workerIds`, `finishedFrom` and
  `finishedTo` exactly as the built-in drivers do.

Without the declaration, a query using any of the four is never handed to the
driver's `findJobs`, since one written before them would ignore them and return
every job. `workerKey` and `workerId` throw a `ConfigError`, because such a
driver has no stamp to match, and a `finishedOn` range is answered by a scan,
which is correct but linear. The
package root exports the definitions the built-in drivers share, so a
driver of your own matches exactly as they do: `JobWorkerRef`,
`attributionOf` (the stamp a claim writes), `matchesAttribution` (the one
definition every backend is compared against), `attributionFilter` and
`AttributionFilter`, `usesAttribution`, `supportsAttributionQuery`,
`matchesNothing` (answer without a read), `canMatchState`, `hasRange`,
`inFinishedRange`, `FINISHED_STATES`, and `holderOf`, which reports
`workerId` as the holder for a driver that keeps the claimer's id after a
settle.

Example:
[`10-options/analytics-and-attribution.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/analytics-and-attribution.ts).

## Jobs added in a range, and sorting by creation time

Two reads by **when a job was added** (`createdAt`), for a dashboard that asks
"of what came in this hour, where is it now?" and a job list that shows the
newest arrivals first on every tab:

```ts
// Of the jobs added in the last hour, how many are in each state now.
export const added = await mail.countAdded({
  from: Date.now() - 3_600_000,
  to: Date.now(),
});
// { waiting: 3, delayed: 1, active: 1, completed: 40, failed: 0, dead: 2, "waiting-children": 0 }

// One state, newest arrival first, rather than in that state's own order.
export const newest = await mail.list("delayed", {
  sort: "createdAt",
  order: "desc",
});
```

Both are served on the **memory, SQL and MongoDB** drivers, and on neither the
Redis nor the file driver: their stored order and markers are by priority,
due time or finish time, so the only answer there is reading every job, which a
dashboard polling it must not do. `/meta.features.addedByState` says which,
and one flag covers both reads because the same backends serve both.

**What the counts mean.**

- The range is **`createdAt` in `[from, to)`**: `from` inclusive, `to`
  exclusive. Each state is the one the job is in **now**, so `active` and
  `waiting` move on every read.
- Only jobs **still stored** are counted. A job removed since, by
  `removeOnComplete`/`removeOnFail` retention or a remove, clean or drain, is
  not, so on a queue that removes finished jobs `completed` and `dead`
  undercount and the states sum to less than what was added. The defaults
  lose nothing in a range no older than a day: a completed job is kept a day
  after it finishes (`removeOnComplete: { ttl: 24h }`), and a dead one until
  removed (`removeOnFail: false`).
- They are **not** the [analytics](#analytics) series and never add up to it.
  The series counts completions and **failed attempts** when they happen, by
  **finish** time, over every job whenever it was added — retention or not.
  Here `failed` is the **state**: an attempt failed and a retry is waiting.
  `dead` is the jobs that gave up. So label the series' figure "failed
  attempts" and the state "retrying" (or "failed, will retry"), and show the
  two apart.
- A job scheduled for later counts as added **when it was added**, in
  `delayed`: a `delay`ed job, and a repeatable's next run, which is created
  ahead of its run time — so tomorrow's scheduled instance of a series can
  appear in today's range.
- `createdAt` is the **producer's clock**: a job added from a host whose clock
  is off lands in the range that clock says. A re-add with an existing id adds
  nothing, so the counts are distinct stored ids.

`queue.countAdded({ from, to })` takes `Date`s or epoch ms and throws a
`ConfigError` for a bound that is not a valid time or a `to` not after `from`,
and a `NotSupportedError` (a `ConfigError` too) on a driver without the read.
It has no span limit; the management API caps its routes at a day.

**From the management API.** `GET /overview/added` (`metrics.read`) sums
every queue the caller may see — the `queues` allowlist and, under
`listQueues: "authorized"`, only the queues `authorize` allows `queues.read`
on; a queue the caller may not see is never counted. It is one grouped read
whatever the queue count, so nothing is truncated. `GET
/queues/:queue/counts/added` (`queues.read`) is one queue's. Both take `from`
and `to` as epoch ms or RFC 3339 date-times, `to` defaulting to now and `from`
to an hour before `to`; `to` not after `from`, a span over a day
(`MAX_ADDED_BY_STATE_SPAN_MS`) or under a second (`MIN_ANALYTICS_SPAN_MS`) is
400 `INVALID_ARGUMENT`. There are no buckets and no retention clamp. Both
answer an `AddedByStateDto`:

```ts
import type { AddedByStateDto } from "@kingsleyweb/bun-jobs/api/contract";

// GET /overview/added?from=2026-09-21T10:00:00Z&to=2026-09-21T11:00:00Z
export const body: AddedByStateDto = {
  from: 1_789_984_800_000, // inclusive, epoch ms
  to: 1_789_988_400_000, // exclusive
  at: 1_789_988_412_345, // when the states were read
  counts: {
    waiting: 3,
    delayed: 1,
    active: 1,
    completed: 40,
    failed: 0,
    dead: 2,
    "waiting-children": 0,
  },
  total: 47, // the sum of counts: added in the range and still stored
  queues: 4, // queues summed; 1 on the per-queue route
};
```

Where `features.addedByState` is `false` both routes are pruned (a JSON 404,
never a 501).

**The sort.** `ListJobsOptions.sort` (the API's `?sort=`) is one of
`JOB_LIST_SORTS`:

- `"natural"`, the default, is each state's own order, the one the list has
  always used: `waiting` by priority then `createdAt` (claim order),
  `delayed` and `failed` by `runAt` (when they are due), `active` by lock
  expiry, `completed` and `dead` by `finishedOn`, `waiting-children` by
  `createdAt`. Several states, or every state, are by `createdAt`.
- `"createdAt"` is by `createdAt` whatever the states, ties within a
  millisecond broken by `id` (by code point), so "newest first" means the same
  on every tab. `order: "desc"` reverses both keys.

`list()` and `page()` throw a `ConfigError` for `sort: "createdAt"` on a driver
that cannot serve it (Redis, file) rather than return a page in the natural
order, and the management API answers it with 400 `INVALID_ARGUMENT` and a
`detail` saying why. `"natural"` is accepted everywhere.

**What it costs.** Memory walks the queue's jobs in process. SQL and MongoDB
answer the counts from the index the claim already uses —
`(ns, queue, state, priority, created_at)` — with `created_at` as a filter, so
a count reads every job the namespace (or the queue) stores in that index: the
same cost as the counts `/overview` already reads, and no new index is added
on enqueue. For the same reason a **`createdAt` sort over one large state**
(`completed`, `dead`) is a top-N sort over every job in that state rather than
an index walk: keep its pages modest. Several states cost what they always
did, since that view is already by `createdAt`. From the management API, poll
the counts every **15–30 seconds**, not at the overview's pace.

**Custom drivers.** Implementing the optional `countAddedJobs(ns, range,
queue?)` is a promise to honour `sort: "createdAt"` in `findJobs` too; without
the method, the count routes are pruned and the sort is refused. Implement it
only where an index or memory bounds the read. The package root exports the
definitions the built-in drivers share: `AddedRange`, `countAdded` (the read
made whole, every state of every queue present), `countAddedByScan` (the one
definition every backend is compared against), `inAddedRange`,
`rangeMatchesNothing`, `emptyAddedCounts`, `compareCreated`, `sortByCreated`,
`sortsByCreated` and `supportsCreatedSort`, beside `JOB_LIST_SORTS`,
`JobListSort` and `MAX_ADDED_BY_STATE_SPAN_MS`.

Example:
[`10-options/analytics-and-attribution.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/analytics-and-attribution.ts).

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
  `reschedule`, `schedule`, `update`, `remove`, `retry`, `promote`,
  `disable`, `enable` and `refresh`.
- `job.fail(reason)` is kept by the child and sent as the attempt's error when
  it settles, so the job goes to `dead` as it would in-process.

**Progress is sent, not asked for.** `job.updateProgress()` in a child does
not wait for a reply, so reporting progress costs no round trip however often
a processor does it. Awaiting it means the worker has the value and will write
it — in the order the processor reported it — not that the driver has it
already.

**What a job wrote lands before the record of how it ended.** Its progress and
its log lines, in every isolation mode and on every ending: a completion, a
`job.fail()`, a thrown error, an overrun `opts.timeout`. An attempt keeps a
record of the writes it has asked for, and the worker settles that record
before it writes the job's ending — so a reader that waits for
`state === "completed"` never reads the value the job had before its last
update, and a line a processor logged is in the log by the time the job says it
is finished. Progress writes are ordered against one another, because a job has
one progress value; log lines are not, because each is appended with its own
sequence and chaining them would cost a chatty processor a round trip a line.
The price is that a slow write delays the ending by whatever is left of it, and
that what a child sends once its attempt is over is dropped rather than written
over the finished job's own.

**The wait is always capped**, because a driver that hangs rather than
rejects would otherwise hold a worker's concurrency slot for good — the ending
write is not awaited, so before this ordering existed a write that never
answered cost the job nothing, and it must not start costing a slot now. Past
the cap the ending is recorded anyway and a write still in flight may land
after it. There are two caps, because the two endings are not in the same
situation:

- An attempt that **reached its own end** gets a quarter of `lockDuration` —
  7.5 seconds at the default, and the same budget the ending write itself is
  given. Past the lock the job is the stalled sweep's to recover, so waiting
  longer buys nothing.
- An attempt the worker **gave up on** — a deadline, a lost lock, a closing
  worker — gets a flat 250ms. Its *run* is abandoned: not waiting for it is
  what a deadline is for, and the child may be wedged. The writes it already
  handed over are still written, but a job that is already dying must not sit
  `active` for seconds waiting on writes nothing will read.

Every other job-channel call — `job.log`, `job.extendLock`/`touch`,
`job.getChildrenValues`, `job.getChildrenFailures` and `ctx.heartbeat` — is a
real round trip, and answers only once the worker's own write has returned;
`job.log` answers with the line count. A child that does not wait for its line
is covered by the ordering above rather than by its own reply.

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
| `keepHistory` | `number` | `50` | Run records kept — and, since a run's log is kept for exactly as long as its record, how many runs keep a log. |
| `maxResultBytes` | `number` | `16384` | Cap on a stored run result. |
| `driver` | `JobsDriver \| DriverConfig` | a new memory driver | Where state lives. Memory cannot coordinate across processes. |
| `childDriver` | `DriverConfig` | `driver`, when that is a config | Handed to handlers as `ctx.driverConfig`. |
| `logger` | `LoggerLike` | no-op | Logger. |
| `args` | `TArgs` | | Default arguments for scheduled runs. |
| `autostart` | `boolean` | `false` | Start on construction. |
| `startPaused` | `boolean` | `false` | Start paused. |
| `syncInterval` | `number` | `30000` | How often to re-read the shared paused flag and schedule. |
| `forwardLogs` | `boolean` | `false` | Forward a child's `ctx.logger` calls to the parent's `log` event. |
| `captureLogs` | `boolean \| RunLogCaptureOptions` | `true` | Store each run's output per run, so the history row has a log to link to. See [Run logs](#run-logs) — it also changes the default stdio of a spawned run. |
| `publish` | `boolean` | `false` | Publish `started`, `succeeded`, `failed`, `timeout`, `killed`, `queued` and `skipped` for other processes, and the `logs` hint while a run's log grows (see [Following a run's log live](#following-a-runs-log-live)). |
| `publishGate` | `() => Promise<void>` | | Awaited before each publish. |
| `metrics` | `MetricsOptions` | everything on | What this runner records for [analytics](#analytics): its runs by outcome and their durations, each run in the bucket it finished in. `runners: false` stops the series and `durations: false` the durations, whatever the driver; `resolution` and `secondRetentionMs` reach only a driver built here from a config. The lifetime `stats()` counters are kept either way. See [The `metrics` option](#the-metrics-option). |
| `remoteControl` | `boolean \| "auto"` | `"auto"` | Subscribe to `control` events, so a change made through `BunRunnerManager.remote()` applies within the driver's event latency instead of at the next `syncInterval`. `"auto"` listens where it is cheap — on a driver whose events are pushed (Redis) or held in this process (memory) — and not on one that polls (SQL, MongoDB, the file driver), where a subscription is a query every few dozen milliseconds per runner on the file driver, and on SQL and MongoDB one more channel in the namespace's shared poll (one query per `pollInterval` per namespace, however many subscribe). `true` subscribes on every backend, `false` on none. The sync adopts every change either way, so this decides latency, never whether remote control works. |
| `remoteConfig` | `{ executionModes?: ExecutionMode[] }` | every mode | What a [remote configuration override](#changing-a-runners-configuration-remotely) may choose. `executionModes` lists the execution modes an override may switch to: list only `"spawn"` and `"worker"` to keep the handler out of the owner's own process. A runner built from a driver instance, with no `childDriver`, has nothing to hand a child. So of the modes listed it publishes, and a controller or the management API accepts, only `in-process` and its code's own mode; the other child mode is refused up front (a `ConfigError` with `reason: "not-allowed"`; over the API, 409 `CONFIG_NOT_ALLOWED`). An empty list, or a mode that does not exist, is a `ConfigError`. Leaving the option out does not turn remote configuration off; over the management API it needs `runners.configure`, which is off by default. |
| `spawn` | `SpawnOptions` | | `cwd`, `env`, `args`, `execPath`, `stdout`/`stderr` (`"pipe"` by default while `captureLogs` is on, `"inherit"` when it is off, or `"ignore"`), and `startTimeout` (`10000`). |
| `worker` | `WorkerOptions` | | `smol`, `name`, `env`, `argv`. |
| `inProcess` | `InProcessOptions` | | `reloadOnEachRun`: re-import the file on every run. This is for development, and it leaks one module instance per run. |

**Upgrading: two runner defaults changed.**

- `remoteControl` was `false` and is now `"auto"`, so a runner on Redis or
  memory subscribes to its `control` events without being asked. Pass
  `remoteControl: false` for the old behaviour. On SQL, MongoDB and the file
  driver nothing changes.
- `spawn.stdout` and `spawn.stderr` were `"inherit"` and are now `"pipe"`
  while `captureLogs` is on, which it is by default. The output still reaches
  this process's stdout and stderr. See
  [It changes the default stdio of a spawned run](#it-changes-the-default-stdio-of-a-spawned-run).
  Pass `captureLogs: false`, or `"inherit"` for either stream, to go back.

### Triggers and run modes

`trigger({ args?, force?, source? })` reports what happened instead of
throwing. It resolves to one of these outcomes:

- `{ outcome: "started", runId }`;
- `{ outcome: "queued", position }`;
- `{ outcome: "skipped", reason }`, where `reason` is `paused`, `busy`,
  `lock-held`, `max-concurrency`, `queue-full` or `stopped`.

`force` runs even while paused. A manual trigger on a stopped runner throws
`RunnerStoppedError`.

`pause()` also holds back what is already queued. While paused, a drain looks
at the head of the queue and runs it only if it was forced; otherwise it
leaves the queue exactly as it is, in order, until `resume()` drains it.

- A forced trigger that has to wait — behind a run in flight, the lock held
  elsewhere, or `maxConcurrency` in `parallel` mode — records `force: true`,
  so it still runs while paused when it reaches the head.
- It is strict FIFO and looks at the head only. A forced trigger queued
  behind an unforced one waits for the resume too. Unforced triggers are
  refused while paused, so an unforced head can only be one queued before the
  pause.
- A paused runner with nothing it may run does not take the lock.
- The drainer goes by the paused flag as it last read it, the same one
  `trigger()` checks. A pause set in another process applies at its next
  sync, or at once where the runner subscribes to `control` events — on Redis
  and memory by default, elsewhere with `remoteControl: true`.
- `resume()` drains the held-back triggers, oldest first, before a
  `triggerNow` run, which queues behind them.

**Upgrading:** triggers queued by a version before `force` was recorded have
no `force` field. They count as unforced, so they wait for `resume()`. Those
versions ran every queued trigger, paused or not.

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
- `log(message, { level?, fields? })`, and `flushLogs()` — see
  [Run logs](#run-logs)
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
- `configured`, when a [configuration override](#changing-a-runners-configuration-remotely)
  changes a value this instance runs with
- `paused`, `resumed`
- `stopped`
- `error`

Examples:

- [`07-runner/messages-progress-kill.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/messages-progress-kill.ts)
- [`07-runner/execution-modes.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/execution-modes.ts)
- [`07-runner/runner-enqueues-jobs.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/runner-enqueues-jobs.ts)

### Run logs

A runner retains its runs' output the way a queue retains a job's logs:
captured as it is produced, stored against the run id, and read back a page at
a time. It is on by default, on every backend that can store run logs.

```ts
const runner = new BunRunner({
  id: "reindex",
  namespace: "app",
  file: "./reindex.ts",
  captureLogs: { maxLines: 5000, maxLineBytes: 4096 },
});
await runner.start();
```

`captureLogs` is `true` (the default), `false`, or a `RunLogCaptureOptions`
object setting the caps, console capture and redaction. Each of the four
numeric caps is **`0` means unbounded**, the convention `keep` takes throughout the package, and a
negative or non-finite one is a `ConfigError` at construction.

| Cap | Default | Bounds |
|---|---|---|
| `enabled` | `true` | Whether to capture at all. A driver with no run-log storage captures nothing whatever this says. |
| `maxLines` | `1000` | Lines one run's log keeps; the oldest go first. |
| `maxBytes` | `1048576` | Bytes of line text one run's log keeps, counted as UTF-8 bytes of the text alone — not the stream, the timestamp, the level or whatever framing the backend stores around them, so every backend bounds the same number. |
| `maxLineBytes` | `8192` | The longest a single line may be, in UTF-8 bytes. A longer one is cut on a character boundary and marked `truncated`, never dropped: a megabyte written without a newline — a progress bar, a base64 blob — would otherwise spend the whole per-run byte cap by itself. |
| `captureBytes` | `8388608` | The most one run may hand to the store over its whole life. The three caps above bound what is *kept*; this bounds what is *written*, so a run in a hot loop costs the backend a bounded number of writes instead of one per line of the million it produced. At the ceiling capture stops and stores one last `log` line saying so. |
| `console` | `true` | Whether an `in-process` or `worker` run's `console.log`, `info` and `debug` (stored as `stdout`) and `warn` and `error` (stored as `stderr`) are captured. A spawned run's console is captured through its pipes whatever this says. See [What is captured](#what-is-captured). |
| `redact` | `true` | How secrets are scrubbed from each line before it is stored: `true` for the built-in rules, `false` to store lines verbatim, or `{ keys?, patterns?, defaults?, replacement? }`. Applied before any cap counts the line. See [Secrets are redacted](#secrets-are-redacted). |

**There is no `keepRuns`.** How many runs keep a log is the runner's
`keepHistory`, deliberately, so that a run in the history and a run with a log
are the same set; `clearHistory()` removes the log of every run it removes,
and leaves a run still in progress with its log whole (see
[Clearing run history](#clearing-run-history)).

The caps are applied by the store on every append, not by a sweeper — there is
no background task to schedule and nothing to forget to run, and a log cannot
be over its cap at a moment a reader could observe it. **They are also honest
about what they cut.** Lines are numbered from one per run and the numbering
survives a trim, so how many a run has lost is known exactly and reported as
`dropped`: a reader is told its log is a tail rather than shown a silently
short one. A line the per-line cap cut carries `truncated: true` rather than
passing for a whole line.

Example:
[`10-options/run-logs-and-clears.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/run-logs-and-clears.ts).

#### Writing a line

```ts
export default defineHandler(async (ctx) => {
  ctx.log("rebuilding the index", { level: "info", fields: { shard: 3 } });
  await rebuild(ctx.signal);
  await ctx.flushLogs();
});
```

`ctx.log(message, options?)` writes one line to the `log` stream, beside the
`stdout` and `stderr` lines a spawned run's pipes produce. It is **fire and
forget**: it returns `void`, never throws and is never awaited, so a store
that is down, a run past its `captureBytes` ceiling and a driver that cannot
hold run logs at all each drop the line quietly. Nothing a handler writes can
fail its run, which is the whole reason it is not a promise.

`options.level` is one of the logger's six levels and is stored alongside the
line; `options.fields` are rendered onto the end of the text as `key=value`
pairs in the order given, so

```ts
ctx.log("done", { fields: { rows: 12, note: "a b" } });
```

stores `done rows=12 note="a b"`. A value with whitespace, a quote or an `=`
is JSON-quoted, and anything that is not a string is JSON. They are rendered
rather than stored apart because a run log is a log, not a table: one text
column is what every backend holds and what a reader greps. In `spawn` and
`worker` mode the call crosses the existing IPC `log` channel, so it also
surfaces as the runner's `log` event — whether or not `forwardLogs` is on.

`ctx.flushLogs()` resolves once the buffered lines have reached the store, and
never rejects. It is rarely needed: capture flushes on its own thresholds and
again when the run settles. It is there for a handler about to do something
drastic — `process.exit`, a deliberate crash — that wants its last words
stored first. **What it waits for depends on the mode, and the honest version
is worth knowing.** In `in-process` mode it awaits the append itself. In
`spawn` and `worker` mode the lines are stored by the *parent*, so it resolves
once they are on the ordered IPC channel rather than on an acknowledgement
from the store — the parent has them before the run's outcome reaches it, and
the flush at settle stores them.

#### It changes the default stdio of a spawned run

Capture needs the pipes, so with `captureLogs` on, `spawn.stdout` and
`spawn.stderr` default to `"pipe"` instead of `"inherit"`. **Nothing
disappears:** every piped chunk is written straight through to this process's
own stdout and stderr as well as captured, so a child's output still lands in
your terminal and your log collector. An explicit `spawn.stdout: "inherit"` or
`"ignore"` still wins, and that stream is then simply not captured.

#### What is captured

Everywhere, anything the handler writes with `ctx.log()`. Beyond that it
depends on where the run executes:

- a **`spawn`** run's `stdout` and `stderr` are captured line by line from its
  pipes;
- a **`worker`** or **`in-process`** run has no pipes of its own, so its
  console is captured instead: `console.log`, `console.info` and
  `console.debug` are stored as `stdout`, and `console.warn` and
  `console.error` as `stderr` — the streams Bun itself writes them to. Each
  call is formatted the way the console formats it, so an object logged after
  a message stays on that line. The console still prints exactly as before;
  capture is a copy, never a redirect. `captureLogs.console: false` turns this
  off and keeps the rest.

An in-process run shares this process's `console` with the host and with every
other in-process run, so the patch is process-wide and each call is
**attributed by async context**: a call made by the run's code, or by anything
it scheduled — a timer, a callback, the next step after an `await` — lands in
that run's log, and a call from outside every run, including the host
application, is never captured. Two runs at once each get their own lines.
The patch is installed by a runner's first captured in-process run and stays
in place until the runner stops; between runs it passes every call straight
through, and nothing is captured. A
listener the run triggers synchronously counts as code the run caused: a
`progress` listener that calls `console.log` is attributed to that run. Output
from work the run scheduled that outlives it is dropped, because its capture
has closed. A worker run has a realm of its own and only that run in it, so
everything its console prints while the run is live is that run's; no async
context is needed there.

Captured console lines go to the store only; they do not surface as the
runner's `output` event, which stays "a child wrote to a piped stream".

What still escapes, and reaches only the terminal:

- `process.stdout.write`, `process.stderr.write` and `Bun.write` to the
  standard streams;
- native code writing to file descriptors 1 and 2 directly;
- a program the handler launches with its own stdio;
- console methods other than those five — `console.trace`, `console.dir`,
  `console.table` and the rest;
- a reference to a console method taken before the patch was installed
  (in-process, before the runner's first captured run), such as a
  `const log = console.log` at host start-up that the run then calls.

#### Secrets are redacted

A run's output is a place secrets end up by accident — a config dumped at
start-up, a connection string in an error, an `Authorization` header in a
debug line — and a stored log outlives the run and is served over the
management API. So capture scrubs every line, on every stream, before it is
stored. It is **on by default**.

The built-in rules below err on the side of hiding a value: a harmless number
hidden is cheaper than a secret stored. To depend on exactly what is caught,
pin your own rules with `defaults: false`.

- **Sensitive keys.** A key whose name contains one of these words, in any
  case, has its value replaced: `password`, `passwd`, `pwd`, `secret`,
  `token`, `apikey`, `api_key`, `api-key`, `authorization`, `auth`,
  `credential`, `cookie`, `session`, `private_key`, `privatekey`,
  `access_key`, `accesskey` (`DEFAULT_REDACT_KEYS`). A substring match, so
  `DB_PASSWORD`, `x-api-key`, `githubToken` and `client_secret` all count.
  `key` alone is not on the list; it would take every `cacheKey` with it.
- **Value forms.** `key=value` and `key: value` (an unquoted value runs to
  whitespace or one of `, ; & " ' } ]`), `key="…"` and `key='…'` (quotes
  kept), and JSON's `"key": "…"` and `"key": 123`. The key and separator stay.
  An auth scheme stays readable: `Authorization: Bearer abc` becomes
  `Authorization: Bearer [REDACTED]` (Bearer, Basic, Token, Digest). A quoted
  value with no closing quote is scrubbed to the end of the line.
- **Whole-line patterns.** A bare `Bearer <token>` anywhere; the password in a
  URL's credentials, `scheme://user:pass@host` becoming
  `scheme://user:[REDACTED]@host`; and a JSON Web Token (`eyJ….….…`)
  anywhere.

What is not caught: a secret in prose ("the password is hunter2"), token
shapes other than a JWT, and in an unquoted `key=value`, the words after the
first space. Add your own shapes with `patterns`.

Matching keys by substring accepts some false positives in exchange for not
leaking: `max_tokens=100`, `author=ada` and `session_count=3` are scrubbed
too.

```ts
const billing = new BunRunner({
  id: "billing",
  namespace: "app",
  file: "./billing.ts",
  captureLogs: {
    redact: {
      keys: ["ssn"],               // added to the built-in words
      patterns: [/sk_live_\w+/],   // every match replaced, whole
      // defaults: false,          // drop the built-in rules, keep only yours
      // replacement: "***",       // default "[REDACTED]"
    },
  },
});
await billing.start();
```

`redact: false` stores lines verbatim. A `patterns` entry gets the `g` flag
when it lacks one, so every match on a line is scrubbed. It runs on every
captured line, so keep it free of heavy backtracking. The built-in expressions
run in time linear in the line.

Redaction runs **before** the caps. `maxLineBytes`, `maxBytes` and
`captureBytes` measure a line exactly as it is stored, and a long line is cut
after its secrets are gone rather than before, when the cut could leave half a
secret behind. If redaction itself fails on a line, the line is not stored as
it was: it becomes `[bun-jobs] line withheld: redaction failed`. The run is
never failed by it.

#### Following a run's log live

A runner that publishes (`publish: true`, or `publishEvents` on its `BunJobs`)
also publishes a `logs` event while a run's stored log grows. It is a **hint,
never the lines**: its payload is `{ runId, lastSeq }`, the run and the `seq`
of the last line the store now holds, and no text. On the management API's
socket it arrives on `runner/{runner}`, `runners` and `all`, like every runner
event.

It is throttled per run to one every 500 ms (`RUN_LOG_HINT_MS`): the first
growth is announced at once, and later ones inside the window collapse into
one carrying the newest `lastSeq`. One more goes out when the run ends, so the
final `lastSeq` is always announced. A growth the store did not keep
announces nothing.

To tail a run, hold the last `seq` you have, and on each hint re-read
`GET /runners/:runner/runs/:runId/logs?since=<that seq>`. Because the hint
carries a position and not content, a hint that is missed or dropped costs
only delay: the next one, or the one at the end, still leads to every line.
The runner's own emitter does not raise it; it is published for other
processes.

Example:
[`10-options/run-logs-and-clears.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/run-logs-and-clears.ts).

#### Where they are stored, and how to read them

All eight backends store run logs: memory, file, SQL (SQLite, Postgres, MySQL,
MariaDB), Redis and MongoDB. A run's log never rides its `RunRecord` — a
runner's history is one document on the file, SQL and MongoDB drivers, and
lines kept on it would be rewritten with every history append — so it lives in
its own table (`run_logs`) or collection (`runLogs`), keyed by run id alone.

A run's record carries `logLines` and `logsDropped` once it settles — the
store's own counters, written with the rest of the outcome, so the history row
and the log agree. Both are **absent** on a backend that stores no run logs and
`0` when the run was simply quiet, which are different facts and so are two
different answers rather than one defaulted number.

The management API serves the lines at
`GET /runners/:runner/runs/:runId/logs` — see [Routes](#routes).

### Introspection

- `history(limit?)` returns run records, newest first.
- `stats()` returns lifetime counters (`success`, `failed`, `timeout`,
  `killed`, `skipped`, `queued`, `total`). `resetStats()` zeroes them.
- `clearHistory({ staleAfter? })` removes the finished runs, record and log,
  and keeps the ones in progress. See
  [Clearing run history](#clearing-run-history).
- `info()` returns a snapshot that merges this process's view with the
  driver's. Its `isRunning` and `runningOn` (`{ host, pid, runId, since }`)
  describe the whole cluster.
- `status`, `activeRuns`, `schedule` and `nextRunAt()` describe this instance.
- `config` describes this instance's executor and overlap settings: what it
  runs with, what its code asked for, and which settings an override
  replaces. See
  [Changing a runner's configuration remotely](#changing-a-runners-configuration-remotely).

Example:
[`07-runner/scheduled-runner.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/07-runner/scheduled-runner.ts).

### Clearing run history

`runner.clearHistory()` removes every **finished** run — its history record
and its run log — and leaves every run **still in progress** untouched, record
and log whole. A live run's log keeps growing after the clear and never loses
its start, and when the run settles its record is updated as usual.

```ts
const { removed, kept } = await runner.clearHistory();
// removed: runs deleted, each with its log; kept: the run ids still in progress
logger.info("history cleared", { removed, kept });

// From any process sharing the driver and namespace:
const remote = await jobs.runners.remote("cleanup");
await remote.clearHistory({ staleAfter: 3 * 86_400_000 });
```

`RemoteRunner.clearHistory()` works on a runner registered in **another
process**: it acts on what the backend stores, so it needs no owner to be
reachable — unlike `kill()`, which only the executing process can do. For a
runner registered here it delegates to the runner itself.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `staleAfter` | `number` | `86400000` (`DEFAULT_STALE_RUN_AFTER`, one day) | How long, in ms, a run whose record still says `running` counts as in progress when nothing else vouches for it. Negative, `NaN` or `Infinity` is a `ConfigError`. |

**Which runs are in progress.** A run is kept when any of these holds:

1. this process is executing it — known only where the runner is registered,
   and kept however old it is;
2. its record says `running` and the runner's lock is held with the run as its
   `lastRunId` — a single-mode run's holder renews the lock for as long as the
   run lasts;
3. its record says `running` and it started less than `staleAfter` ago.

Everything else is removed: every settled run, and a `running` record nothing
vouches for. That is **a run whose process crashed**: its record never
settles, so it would otherwise say `running` for good. It stops being vouched
for once it is older than `staleAfter` and — if it was the lock holder's run —
once the lock expires, `lockTtl` after the crash; the next clear removes it.
(Like any record, it also leaves once `keepHistory` newer runs push it out.)
`planHistoryClear()` is the rule on its own, pure, if you want to preview a
clear.

**The limit: a long parallel run in another process.** A `parallel` run holds
no lock, so from outside its process the stored status and its age are all
there is. **A live parallel run in another process that started more than
`staleAfter` ago is cleared, and when it settles it finds no record to
update** — its outcome still reaches the lifetime counters and analytics, but
not the history. Raise `staleAfter` above your longest run for such runners
(the management API accepts up to thirty days). A run executing in the process
that does the clear is never affected, and neither is a single-mode run under
a live lock.

The lifetime counters (`stats()`), the analytics series and the runner's
state — paused flag, schedule, lock, queued triggers — are untouched:
resetting the counters is `resetStats()`. A driver without `removeRuns` throws
`NotSupportedError`; it never falls back to the driver's `clearHistory`, which
would drop the runs in progress too. Over the management API it is
`DELETE /runners/:runner/history` — see [Routes](#routes).

Example:
[`10-options/run-logs-and-clears.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/run-logs-and-clears.ts).

### Changing a runner's configuration remotely

A runner's executor and overlap settings, `executionMode`, `runMode` and
`maxConcurrency`, can be overridden without changing its code or restarting
it. The override is stored in the driver against the runner's id, so every
process that owns the runner adopts it, and so does one started later.

```ts
const report = jobs.runner({
  id: "report",
  file: "./jobs/report.ts",
  remoteConfig: { executionModes: ["spawn", "worker"] }, // never in-process
});
await report.start();

// In any process sharing the driver and namespace:
const remote = await jobs.runners.remote("report");
await remote.updateConfig({ executionMode: "worker" });
await remote.updateConfig({ concurrency: { runMode: "parallel", maxConcurrency: 3 } });
export const config = await remote.config(); // effective, code, overridden, seq, ...
await remote.resetConfig(); // back to what the code asks for
```

`updateConfig(patch)` takes a merge patch: a field left out is untouched, and
`null` clears that override.

- `executionMode` is `"spawn"`, `"worker"` or `"in-process"`, and must be one
  the runner's `remoteConfig.executionModes` permits.
- `concurrency` writes `runMode` and `maxConcurrency` together, because a cap
  only means something in `parallel` mode: `{ runMode: "single" }`, or
  `{ runMode: "parallel", maxConcurrency }` with a whole number from 1 to 1000,
  or `null` for unlimited.

`resetConfig()` clears every override. Both resolve to a `RunnerConfigInfo`:

| Field | Meaning |
|---|---|
| `effective` | What the owner runs with now: `{ executionMode, runMode, maxConcurrency }`, `null` meaning unlimited. |
| `code` | What the owner's own options asked for. |
| `overridden` | Which settings an override is stored for, including one the owner refused. |
| `allowed` | The execution modes the owner's `remoteConfig` permits. |
| `seq` | The override's version, `0` when nothing was ever stored. |
| `appliedSeq` | The version an owner has adopted. Below `seq`, no owner has picked it up yet. |
| `error` | `{ at, message, keys }`, when an owner refused all or part of the override. `keys` names the refused settings in `executionMode, runMode, maxConcurrency` order; every other overridden setting was adopted. A whole refusal names every overridden key, and an error stored by an older owner reads as `keys: []`. |
| `updatedAt` | When the override was last written, epoch ms. |

The same three members are on `BunRunner` itself: `runner.updateConfig(patch)`
and `runner.resetConfig()` store the override, adopt it in this process at
once, and publish the same `control` event a `RemoteRunner` does, so owners in
other processes adopt it as described under **When it applies**.
`runner.config` is this instance's own view, read without a driver round trip.
`jobs.runners.remote(id)` on a local runner delegates to it and publishes
nothing more. On a `RemoteRunner`, `config()` is a method and reads what the
owners stored. It resolves to `undefined` for a runner no owner has started
since remote configuration shipped.

**When it applies.** An owner adopts an override at its next sync
(`syncInterval`, 30 seconds by default), or as soon as it hears the `control`
event, which `remoteControl: "auto"` means on Redis and memory. It applies from
the **next** run. A run in flight keeps the mode it started with, a lower
`maxConcurrency` only holds back new runs, and switching from `parallel` to
`single` never kills a run. That switch is not immediate across processes
either, because a parallel run holds no lock. Pause the runner first when
exclusivity matters.

**What an owner refuses.** An owner that cannot honour a field drops it, keeps
its code's value, records why in `error` (naming the field in `error.keys`),
and logs a warning. That happens for
a mode its `remoteConfig` does not permit, and for `"spawn"` or `"worker"` on a
runner built from a driver instance with no `childDriver`, whose handler would
then reach no backend. Both are refused up front by `updateConfig()` and the
management API (the owner publishes only the modes it can adopt), so an owner
meets them only in an override stored before it started. Moving an `"in-process"` handler out of the process
also costs it `ctx.driver`, which the owner logs as a warning.

**Errors.** A refused call throws a `ConfigError` whose `context.reason` says
why:

- `"empty"`: the patch sets neither field (`updateConfig()`);
- `"invalid"`: an unknown mode or `runMode`, or a `maxConcurrency` out of
  bounds (`updateConfig()`);
- `"not-allowed"`: an execution mode the runner's `remoteConfig` forbids, or
  one it cannot adopt for want of a `childDriver` (`updateConfig()`);
- `"not-configurable"`: from a `RemoteRunner` for a runner registered in
  another process, when no owner has started since remote configuration
  shipped, so nothing would ever adopt the override (`updateConfig()` and
  `resetConfig()`).

A `RemoteRunner` for a runner the backend does not know throws
`RunnerNotFoundError`. Over the management API this is
`PUT` and `DELETE /runners/:runner/config`, with the action `runners.configure`,
which is off by default. See [Routes](#routes).

Example:
[`10-options/remote-control.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/remote-control.ts).

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
| `pause()`, `resume()` | Write the shared paused flag. | Immediately on Redis and memory, where `remoteControl: "auto"` subscribes. Elsewhere at its next sync (`syncInterval`, 30s by default), or with `remoteControl: true` within the driver's event latency: about 25ms on the file driver, 50ms on SQL and MongoDB. |
| `updateSchedule(schedule)` | Validates the schedule, then writes it. | Same as `pause()`. The owner re-arms its ticker. |
| `trigger({ args?, force? })` | Pushes a trigger onto the runner's queue in the driver, whatever `queueRuns` says, up to the owner's `maxQueuedRuns`. Resolves to `queued`, or `skipped` with `paused` or `queue-full`. | An idle owner drains it at once where it subscribes to `control` events (Redis and memory by default, elsewhere with `remoteControl: true`), and otherwise at its next sync. A busy one drains it when its run finishes. The run has source `queued` and the owner's default `args` when none are given. |
| `history(limit?)`, `stats()` | Read the shared history and counters. | Nothing to act on. |
| `clearHistory({ staleAfter? })` | Removes the finished runs, record and log, keeping those in progress. See [Clearing run history](#clearing-run-history). | Nothing to act on: it works on what the backend stores. A run the owner is executing stays in progress by its record — `running`, under the live lock or younger than `staleAfter`. |
| `updateConfig(patch)`, `resetConfig()` | Validate the patch against the modes the owner permits, then write the override (or clear it). See [Changing a runner's configuration remotely](#changing-a-runners-configuration-remotely). | Same as `pause()`. The owner applies it from its next run. |
| `config()` | Reads the configuration the owners persisted, or `undefined` when no owner has started since remote configuration shipped. | Nothing to act on. |

The calls publish a `control` runner event, whether or not the runner
publishes its own. An owner subscribed to them re-reads its state when it
hears one — which `remoteControl: "auto"`, the default, means on Redis and
memory, and `remoteControl: true` means everywhere. Every owner also re-reads
at each sync and drains triggers queued while it was idle. It does the same on
`start()`, so a trigger queued while no owner was running waits for one to
start.

Limits:

- **There is no remote kill.** Only the process executing a run can stop it,
  with `BunRunner.kill()`. `RemoteRunner` has no `kill` or `send`.
- A remote `trigger({ force: true })` records `force` on the queued trigger,
  so a paused owner drains it. The head-only rule in
  [Triggers and run modes](#triggers-and-run-modes) applies: a forced trigger
  behind an unforced one waits for the resume.
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
| `workers` | `"all" \| string[]` | `[]` (none) | Which queues' **worker** events to follow, by queue name: `control`, `state` and `config` (see [Controlling workers from another process](#controlling-workers-from-another-process)). Off unless asked for, because it is a second subscription per queue: on the file driver, a second query every few dozen milliseconds per queue; on SQL and MongoDB, one more channel in the namespace's single shared poll. |
| `discoveryInterval` | `number` | `2000` | How often to look for new queues and runners, with `"all"` in any of the three lists. |
| `bufferSize` | `number` | `10000` | How many events an async iterator buffers for a slow consumer before dropping the oldest. `dropped` counts the losses. |

- **Constructing and lifecycle.** Construct a notifier directly with
  `new JobsNotifier(driver, namespace, options)`, then call `start()`.
  `close()` ends it and any iterators.
- **Members.** `follow(kind, target)` starts following a queue or runner
  before it exists, so nothing is missed, and for good. `following` lists
  the **live** subscriptions, as `<kind>:<target>`: a target whose subscribe
  is still in flight, or failed (reported as `error`), is not in it yet.
  `followedForGood(kind)` lists what discovery, the configured lists, a
  `BunJobs` creating it or `follow()` follows, live or not; a `hold()` alone is
  not in it. The emitted events are `event`, `subscribed`, `followed` and
  `error`. `followed(kind, target, source)` fires once when a target becomes
  followed for good, before its subscription is live: `source` is
  `"discovery"` for a discovery pass (or the configured lists it follows) and
  `"follow"` for `follow()`, which is what a `BunJobs` calls for what it
  creates. A `hold("worker", queue)` a listener starts there is live before
  that queue's own follow resolves.
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
  `pause`, `resume`, `schedule`, `trigger` or `config`) is published by
  `BunRunnerManager.remote()` whenever it changes a runner. It is addressed
  to the runner's owners, which follow it wherever `remoteControl` subscribes:
  on Redis and memory by default, elsewhere with `true`. A notifier following
  that runner hears it too.
- **Worker events.** An event with `kind: "worker"` has the queue as its
  `target` and one of three types: `control` (`payload.action`: `pause`,
  `resume`, `stop`, `start`, `config` or `reset`, with the `worker` id or the
  `key` it is addressed to), `state` (`worker`, `key`, `state`, `previous?`,
  `reason?`, `at`) and `config` (`worker`, `key`, `seq`, `overridden`, `error?`).
  A worker's first start is announced with no `previous`; every later `state`
  event carries it. Only a notifier whose
  `workers` option names the queue, or `"all"`, hears them.
  `follow("worker", queue)` and `hold("worker", queue)` also work.
- **Discovery has a gap.** Anything a newly used queue published before the
  next discovery pass is missed. Name the queues and runners, or `follow()`
  them, to hear every event from the start. Objects created by the same
  `BunJobs` are followed the moment they are created.

Examples:

- [`02-queues/events.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/02-queues/events.ts)
- [`09-integrations/live-dashboard.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/09-integrations/live-dashboard.ts)
- [`10-options/notifier.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/notifier.ts)

## Analytics

Every queue's jobs, each runner's runs and their durations, and each worker's
jobs and busyness are counted into time buckets as they happen: a second wide
and a minute wide, on every built-in driver. The management API's
[analytics routes](#analytics-routes) read them back as series over a range
you choose; a queue, worker or runner has no reading method of its own.

Recording is on by default, and what it costs grows with the number of
**entities** — queues, workers, runners — not with the job rate. Counts are
gathered in memory and written once a second onto one bucket per series, so a
second in which one job finished and a second in which five thousand did cost
the same write. No round trip is added per job or per run; on Redis a
queue's own count is one more `HINCRBY` inside the script that already settles
the job.

Example:
[`10-options/analytics-and-attribution.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/analytics-and-attribution.ts).

### The `metrics` option

`BunJobs`, `BunRunner`, `BunQueueWorker` and every `DriverConfig` take the
same `MetricsOptions`, and every field is on unless you turn it off:

```ts
import { BunJobs } from "@kingsleyweb/bun-jobs";

export const jobs = new BunJobs({
  namespace: "shop",
  driver: { type: "redis", url: "redis://localhost:6379/0" },
  metrics: {
    secondRetentionMs: 15 * 60_000, // the most there is
    workers: false, // a large fleet: no per-worker series
  },
});
```

| Field | Default | Meaning |
|---|---|---|
| `resolution` | `"second"` | The finest width counts are written at. Every count is written at a second **and** a minute — a dual write, never a background roll-up that would need a leader and lose a minute when it died. `"minute"` turns the per-second buckets off. The file driver keeps minutes whatever this says. |
| `secondRetentionMs` | `300000` (5 minutes) | How long per-second buckets are kept: at least a second, at most `900000` (15 minutes, `MAX_SECOND_RETENTION_MS`). Minute buckets are kept for a day, and that is not configurable. |
| `workers` | `true` | Per-worker series: the jobs each worker finished, and its busyness. **The first lever for a large fleet** — workers are the term that grows with the fleet, so a namespace with 300 workers pays most of its analytics cost here. |
| `runners` | `true` | Per-runner series of runs by outcome. |
| `durations` | `true` | Run durations, and the histograms their percentiles come from. |

Five minutes is deliberately short. It covers the 60-second and 5-minute
views, which are what per-second buckets are for; a 10-minute range then comes
back at 60 seconds, with `clamped: true` and `reason: "retention"` saying so.
The retention, not the job rate, is what the storage is made of: a namespace
of 20 queues and 40 workers holds about 19,500 buckets at five minutes and
about 58,500 at fifteen.

**Where each field takes effect.**

- **On a driver.** `resolution` and `secondRetentionMs` belong to whoever
  builds the driver. A component passes its `metrics` to a driver it builds
  from a config — a config naming its own `metrics` wins — and to the memory
  driver it builds when given none. A driver **instance** you pass in keeps
  whatever it was constructed with (`new SqlDriver({ url, metrics })`).
- **On a runner or worker.** `runners`, `durations` and `workers` also gate
  the component's own writes, so they work on a shared driver instance too:
  `workers: false` on a worker stops it writing either of its series, whatever
  the driver.
- **Through `BunJobs`.** The context's `metrics` goes to the driver it builds,
  and is merged **field by field** under every runner and worker it creates:
  the context's, then `runnerDefaults.metrics` for a runner, then the
  component's own, the more specific winning. So a context's
  `{ workers: false }` is not undone by a worker that only asked for
  `resolution: "minute"`. A field given as `undefined` does not hide the one
  beneath it.

What is in force is reported as `GET /meta` →
`analytics.recording`.

### What is recorded

| Series | Counts | Keyed by | Written by |
|---|---|---|---|
| queue jobs | `completed`, `failed` | the queue | the driver, as each job settles — the same events as [throughput](#reading-a-queue-search-totals-workers-and-throughput) |
| runner runs | `started`, `succeeded`, `failed`, `timeout`, `killed`, `skipped` | the runner's id | the runner |
| runner durations | `count`, min, max, mean, a 25-bin histogram | the runner's id | the runner, with the outcome |
| worker jobs | `completed`, `failed` | the queue and the worker's **stable key** | the worker, from memory, once a second |
| worker busyness | jobs in flight against `concurrency`, per sample | the queue and the worker's stable key | the worker, on each heartbeat report |
| namespace roll-up | queue jobs, runner runs, worker jobs | the namespace | every per-entity count, in the same write |

**A jobs series' `failed` is failed attempts, not the `failed` state.** It
counts every attempt that failed, including one that will be retried and one
that later succeeds, by when it failed. The `failed` *state* is a job whose
attempt failed and whose retry is waiting, and `dead` a job that gave up — the
states [the added-by-state counts](#jobs-added-in-a-range-and-sorting-by-creation-time)
report. Label the series' figure "failed attempts" and the state "retrying",
so the two are never read as one number.

**Runs.** A run counts in `started` in the bucket it started in, and in its
outcome and its duration in the bucket it **finished** in. A series' `failed`
means the run **threw**; a timeout counts in `timeout` and a kill in `killed`
only. That is unlike the lifetime `stats().failed`, which counts timeouts and
kills as failures too — so do not add the two together. The lifetime counters
are kept exactly as before: cumulative and resettable is a different thing from
a series.

**Durations.** `minMs`, `maxMs` and `meanMs` are exact. `p50Ms` and `p95Ms`
are read off a fixed log histogram, 24 edges doubling from 1 ms to 2²³ ms
(about 2.3 hours) plus an overflow bin, interpolated inside the bin: always
within a factor of 2 of the truth, typically 20–30%. A fixed histogram is what
lets two processes' buckets merge by adding them.

**Workers.** A worker's series is keyed by its stable `key`, never its
per-incarnation `id` (the id, only when a record has no key): keyed by
incarnation, a rolling redeploy would shred it into a new series per replica.
`failed` counts every failed attempt whose write landed, retried or not. A job
the worker lost the lock on, a job buried from outside, and a parent buried
by a failed child are not this worker's attempts, and do not count. The worker
buffers its counts itself and writes once a second while it is busy — never
while it is idle.

**Busyness.** Sampled, not counted: each heartbeat report (`reportInterval`,
10 seconds by default) that lands also records the jobs in flight and
`concurrency`, and the driver writes the sample with the rest of that second's
counts, so it adds no round trip of its own. There is deliberately
no second timer — an idle worker would then write once a second forever.
With reporting off (`reportInterval: 0`), no busyness is recorded. Because a
sample comes only every report interval, a busyness series is never
served finer than that (`meta.analytics.busynessIntervalMs`): at today's widths
of one second and one minute, it comes back a minute per bucket. A bucket with
`samples: 0` means the worker was not reporting, not that it was idle.

**Totals on the worker record.** The heartbeat record also carries
`completed` and `failed` — this incarnation's jobs completed and attempts
failed since it started — as `WorkerInfo` and the API's `WorkerDto`. They ride
a write that happens anyway, so they cost nothing and are written whatever
`metrics` says. They restart from `0` with the worker, and are absent on a
record written by an older version; the series that survives restarts is the
one keyed by `key`.

The record's `rssBytes` and `heartbeatRttMs` ride the same write, but they are
**not** recorded as analytics: a gauge is a different shape from these
counters, so there is no memory or round-trip series to read back — only the
last value each live record carries. See
[Workers](#reading-a-queue-search-totals-workers-and-throughput).

**Recording never changes a job or a run.** A driver without the analytics
methods records nothing, and one whose write throws is logged once and
ignored. A runner, worker or queue that closes writes what it had gathered —
even on a driver it does not own, since a process sharing one driver may exit
without ever closing it.

### Analytics per driver

| Driver | Widths kept | How counts reach the backend | How old buckets go |
|---|---|---|---|
| memory | 1 s, 60 s | straight into the driver's maps; no buffer | a sweep by range, once a minute |
| file | **60 s only** | a JSONL line per series per flush, once a second per process | a sweep by range, once a minute per process |
| sql | 1 s, 60 s | gathered in memory; once a second, one multi-row upsert per table onto **one shared row** per series and bucket, however many processes counted | `DELETE … WHERE bucket < cutoff` per table and width, once a minute per process |
| mongodb | 1 s, 60 s | gathered in memory; once a second, one `bulkWrite` of upserts onto one shared document per series and bucket | one `deleteMany` by range per width, once a minute per process |
| redis | 1 s, 60 s | a queue's own jobs inside the existing `COMPLETE`/`FAIL` script; everything else gathered in memory and written once a second | each hash expires itself (`PEXPIREAT`); nothing to sweep |

Old buckets are removed **by range**, not per series: a sweep driven by new
writes would never reach a worker that stopped, whose buckets would then stay
for good.

**The file driver keeps minutes only.** Per-second buckets there would mean a
directory listing per queue on every flush and hundreds of file opens per
read, so the driver serves 60-second buckets whatever `resolution` asks for,
and reports it: `meta.analytics.resolutions` is `[60]` and
`recording.resolution` is `"minute"`. A request for one-second buckets comes
back at a minute, with `reason: "driver"`.

**The Redis namespace roll-up is up to a second behind.** A queue's own counts
ride the script that settles the job, but the namespace keys sit outside every
queue's hash tag, and one script may not touch both — in Cluster that is
cross-slot, and refused. So the roll-up is gathered in memory and written once
a second, like every buffered backend, and a process killed outright loses the
second it had not written. An overview refreshed on a timer never notices; a
test that settles a job and reads the roll-up in the same tick calls
`driver.flushMetrics()` first.

**SQL** adds three tables — `queue_metrics`, `worker_metrics` and
`runner_metrics` — created on connect like the rest, each keeping the
namespace roll-up under an empty entity rather than in a table of its own. A
run's duration histogram is 25 integer columns, which the upsert adds together;
no portable SQL can add two JSON arrays. The grouped worker read behind
`GET /analytics/workers` and `GET /overview` uses a window function, which sets
this package's
[minimum versions](#minimum-database-versions): MySQL 8, MariaDB 10.2,
SQLite 3.25. **MongoDB** adds one collection, `metrics`, with an index for
reads and one for the sweep.

### Analytics in a driver of your own

Every analytics method is optional on the driver contract, and a driver with
none of them simply has every analytics route pruned — never a 501:

| Methods | Half | What they enable |
|---|---|---|
| `getMetricsSupport`, `getNamespaceMetrics`, `getQueueMetrics` | both; `getQueueMetrics` queue only | every analytics route; without all three, `meta.analytics` is `null` |
| `countRunnerRun`, `getRunnerMetrics` | runner | runner analytics (`features.runnerMetrics`) |
| `countWorkerJobs`, `getWorkerMetrics` | queue | worker analytics (`features.workerMetrics`), on a driver that also keeps worker records |
| `sampleWorkerBusyness` | queue | busyness; without it a worker's series carries its jobs only |
| `getRunnerMetricsTotals`, `getRunnerMetricsMany`, `getWorkerMetricsTotals`, `getWorkerMetricsMany` | runner, queue | the grouped reads, used only when **all four** are present: a roll-up in a fixed number of reads, and the Runners and Workers sections of `GET /overview` |
| `flushMetrics` | both | writing what is gathered in memory; awaited by a closing runner, worker or queue |

The rules the built-in five keep, and a sixth must too:

- **Count only a write that took effect, and never add a round trip per job or
  per run.** Gather in memory and write once a second.
- **Write every width the driver records, and the namespace roll-up, in the
  same batch.** Second and minute are a dual write.
- **Remove old buckets by range**, once a minute, not per series.
- **There is no fallback.** Counts that were never kept cannot be rebuilt.

The package root exports what the built-in drivers share, so a driver of your
own buckets, merges and resolves a range exactly as they do:
`MetricsBuffer` and `PendingBuffer` (the once-a-second buffers),
`MetricsPruneClock` and `metricsPruneCutoff`, `resolveMetricsOptions` and
`metricsSupportOf`, `resolveAnalyticsRange`, `bucketStart`, `fillBuckets`, the
`merge*Buckets` and `merge*Stats` helpers, `durationBin`, `histogramQuantile`,
`readDurations`, `readBusyness`, `NAMESPACE_ENTITY`, and for the grouped reads
`runnerTotalsOf`, `workerTotalsOf`, `hasMetricBuckets`, `workerMetricsEntity`,
`splitWorkerMetricsEntity` and `uniqueWorkerRefs` — with their types
(`MetricsOptions`, `MetricsSupport`, `MetricsQuery`, `RunnerMetricsTotals`,
`WorkerMetricsTotals`, …) and the contract's constants (`ANALYTICS_RESOLUTIONS`,
`DURATION_HISTOGRAM_BOUNDS`, `MAX_ANALYTICS_BUCKETS`, …). Each method's JSDoc
states exactly what it must return.

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
    worker?: string;
    workerKey?: string;
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

A request that fails a check — a body or query that does not validate,
malformed JSON, a missing CSRF token — is still authorized first, once, and
only a caller `authorize` allows is told what was wrong. When the path is
valid, `authorize` is asked with the target the path names (`queue`, `jobId`,
`runner`, and `route`), just as for a well-formed request; a bulk route's
`jobIds` come from the body, so they are absent. A host that refuses one queue
therefore answers 403 there, and one that refuses untargeted requests still
lets its caller see the 400. Only a request whose path is itself invalid is
asked about with no target.

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
| `queues.defaults` | mutation | off by default |
| `queues.applyDefaults` | mutation | off by default |
| `metrics.read` | read | |
| `workers.list` | read | |
| `workers.read` | read | |
| `workers.pause` | mutation | |
| `workers.resume` | mutation | |
| `workers.stop` | mutation | |
| `workers.start` | mutation | |
| `workers.configure` | mutation | off by default |
| `jobs.list` | read | |
| `jobs.read` | read | |
| `jobs.logs` | read | |
| `jobs.add` | mutation | off by default |
| `jobs.update` | mutation | off by default |
| `jobs.retry` | mutation | |
| `jobs.retryAll` | mutation | |
| `jobs.remove` | mutation | |
| `jobs.clearLogs` | mutation | |
| `jobs.promote` | mutation | |
| `jobs.fail` | mutation | |
| `repeatables.list` | read | |
| `repeatables.remove` | mutation | |
| `repeatables.disable` | mutation | |
| `repeatables.enable` | mutation | |
| `definitions.list` | read | |
| `runners.list` | read | |
| `runners.read` | read | |
| `runners.logs` | read | |
| `runners.trigger` | mutation | |
| `runners.pause` | mutation | |
| `runners.resume` | mutation | |
| `runners.kill` | mutation | |
| `runners.reschedule` | mutation | |
| `runners.resetStats` | mutation | |
| `runners.clearHistory` | mutation | |
| `runners.configure` | mutation | off by default |
| `events.connect` | read | |
| `events.subscribe` | read | |

**`actions` is an allow-list, not a list of extras.** Left unset, it
defaults to every action except `jobs.add` and `jobs.update`, which write
payloads your handlers trust, `workers.configure` and `runners.configure`,
which reconfigure a process from outside it, and `queues.defaults` and
`queues.applyDefaults`, where one write changes the retries, timeout and
retention of every job every producer adds to a queue, or of its whole
backlog (`JOBS_API_OPT_IN_ACTIONS`). Once
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
hide what it may not do. Its `actions` is typed
`Partial<Record<JobsApiAction, boolean>>`: an action whose routes are pruned
is absent, not `false`.

It costs **N + 1** `authorize` calls, N being the number of actions in the
answer: one for the request itself (`meta.read` on `GET /meta/permissions`,
as every route asks), then one per action. The first is not reused for the
map's `meta.read` entry, because that entry previews `GET /meta`, a different
route. `?channel=` adds one more when the channel parses and is available.

Each call is shaped like the real request it previews, so an `authorize`
that decides by route gives the map the answer the request gets:

- an HTTP action carries `transport: "http"` and `route` — the method and
  pattern of one of its routes. Where an action has several, the first
  registered (in `api.routes` order) whose pattern names what was asked
  about: `?queue=` picks a route with `:queue` (`metrics.read` →
  `GET /queues/:queue/throughput`), `?runner=` one with `:runner`, and
  neither picks one with neither (`metrics.read` → `GET /overview`,
  `workers.list` → `GET /workers`); failing that, the action's first route
  (`jobs.read` untargeted → `POST /queues/:queue/jobs/lookup`, a read);
- `events.connect` and `events.subscribe` carry `transport: "ws"` and no
  `route`, as the upgrade and a `subscribe` frame do;
- no call names a job, so a rule on `jobId` cannot be previewed.

#### Showing only the queues a caller may read

By default `GET /queues`, `GET /overview` and `GET /workers` show every
reachable queue to anyone allowed `queues.list` (or `metrics.read`,
`workers.list`). With `listQueues: "authorized"` they also ask `authorize`
about `queues.read` for each queue — with the context `GET /queues/:queue`
carries, `route` included — and leave out the queues it denies:

```ts
createJobsApi({
  ...options,
  listQueues: "authorized", // default "all"
  authorize: (req, ctx) => !(ctx.queue === "payroll" && !isFinance(req)),
});
```

`GET /queues` pages the filtered list: `offset`, `limit`, `page.total`,
`page.hasMore` and `truncated` all count only the queues shown. `/overview`
sums only those, and `/workers` drops workers of hidden queues.

That costs one `authorize` call per queue matching the request's `search` —
every one, not just the page's, because the total needs them all — made at
most 16 at a time and never twice for one queue within a request. An
`authorize` that throws fails the request with a 500, as it does on any
route. The option needs `queues.read` enabled: otherwise every queue would
be hidden, so construction throws `ConfigError`. It filters the HTTP reads
only; the socket's broad channels (`all`, `queues`) already ask
`events.subscribe` per queue.

### Modes and pruning

`mode` selects which half is exposed — `"jobs"`, `"runner"` or `"both"`
(the default when both sources exist). One predicate prunes the router, both
documents and `/meta/permissions` together, so a route that is absent is
absent everywhere: wrong mode, a mutation under `readOnly`, an action outside
`actions`, a driver missing the methods the route needs, or a route that
needs a `jobs` source without one. A pruned route answers the API's JSON 404,
never a 405.

`/meta` reports what the backend supports and this API serves
(`features.logs`, `update`, `limits`, `flows`, `search`, `workers`,
`workerControl`, `throughput`, `runnerLogs`, `runnerMetrics`, `workerMetrics`,
and `analytics` beside `features` for what the analytics routes can serve), so
a UI can explain a missing button rather than hide it silently. A feature
whose routes the mode prunes reads `false`; see
[Features that need driver support](#features-that-need-driver-support).

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
| GET | `/overview/added` | `metrics.read` | no |
| GET | `/queues` | `queues.list` | no |
| GET | `/queues/:queue` | `queues.read` | no |
| GET | `/queues/:queue/counts` | `queues.read` | no |
| GET | `/queues/:queue/counts/added` | `queues.read` | no |
| POST | `/queues/:queue/pause` | `queues.pause` | yes |
| POST | `/queues/:queue/resume` | `queues.resume` | yes |
| POST | `/queues/:queue/drain` | `queues.drain` | yes |
| POST | `/queues/:queue/clean` | `queues.clean` | yes |
| GET | `/queues/:queue/limits` | `queues.read` | no |
| PUT | `/queues/:queue/limits` | `queues.limits` | yes |
| GET | `/queues/:queue/job-defaults` | `queues.read` | no |
| PUT | `/queues/:queue/job-defaults` | `queues.defaults` | yes |
| DELETE | `/queues/:queue/job-defaults` | `queues.defaults` | yes |
| POST | `/queues/:queue/job-defaults/apply` | `queues.applyDefaults` | yes |
| GET | `/queues/:queue/workers` | `workers.list` | no |
| GET | `/workers` | `workers.list` | no |
| GET | `/queues/:queue/workers/:worker` | `workers.read` | no |
| POST | `/queues/:queue/workers/:worker/pause` | `workers.pause` | yes |
| POST | `/queues/:queue/workers/:worker/resume` | `workers.resume` | yes |
| POST | `/queues/:queue/workers/:worker/stop` | `workers.stop` | yes |
| POST | `/queues/:queue/workers/:worker/start` | `workers.start` | yes |
| GET | `/queues/:queue/worker-configs` | `workers.read` | no |
| PUT | `/queues/:queue/worker-configs/:key` | `workers.configure` | yes |
| DELETE | `/queues/:queue/worker-configs/:key` | `workers.configure` | yes |
| GET | `/queues/:queue/throughput` | `metrics.read` | no |
| GET | `/queues/:queue/analytics/jobs` | `metrics.read` | no |
| GET | `/queues/:queue/analytics/workers/:key` | `metrics.read` | no |
| GET | `/analytics/jobs` | `metrics.read` | no |
| GET | `/analytics/workers` | `metrics.read` | no |
| GET | `/queues/:queue/jobs` | `jobs.list` | no |
| POST | `/queues/:queue/jobs/lookup` | `jobs.read` | no |
| GET | `/queues/:queue/jobs/:id` | `jobs.read` | no |
| GET | `/queues/:queue/jobs/:id/logs` | `jobs.logs` | no |
| GET | `/queues/:queue/jobs/:id/children` | `jobs.read` | no |
| PATCH | `/queues/:queue/jobs/:id` | `jobs.update` | yes |
| DELETE | `/queues/:queue/jobs/:id` | `jobs.remove` | yes |
| DELETE | `/queues/:queue/jobs/:id/logs` | `jobs.clearLogs` | yes |
| POST | `/queues/:queue/jobs/:id/retry` | `jobs.retry` | yes |
| POST | `/queues/:queue/jobs/:id/promote` | `jobs.promote` | yes |
| POST | `/queues/:queue/jobs/:id/fail` | `jobs.fail` | yes |
| POST | `/queues/:queue/jobs/retry` | `jobs.retry` | yes |
| POST | `/queues/:queue/jobs/remove` | `jobs.remove` | yes |
| POST | `/queues/:queue/jobs/promote` | `jobs.promote` | yes |
| POST | `/queues/:queue/jobs/retry-all` | `jobs.retryAll` | yes |
| POST | `/queues/:queue/jobs` | `jobs.add` | yes |
| GET | `/queues/:queue/repeatables` | `repeatables.list` | no |
| DELETE | `/queues/:queue/repeatables/:key` | `repeatables.remove` | yes |
| POST | `/queues/:queue/repeatables/:key/disable` | `repeatables.disable` | yes |
| POST | `/queues/:queue/repeatables/:key/enable` | `repeatables.enable` | yes |
| GET | `/definitions` | `definitions.list` | no |
| GET | `/runners` | `runners.list` | no |
| GET | `/runners/:runner` | `runners.read` | no |
| GET | `/runners/:runner/history` | `runners.read` | no |
| DELETE | `/runners/:runner/history` | `runners.clearHistory` | yes |
| GET | `/runners/:runner/runs/:runId/logs` | `runners.logs` | no |
| GET | `/runners/:runner/stats` | `runners.read` | no |
| GET | `/runners/:runner/analytics` | `metrics.read` | no |
| GET | `/analytics/runners` | `metrics.read` | no |
| POST | `/runners/:runner/trigger` | `runners.trigger` | yes |
| POST | `/runners/:runner/pause` | `runners.pause` | yes |
| POST | `/runners/:runner/resume` | `runners.resume` | yes |
| PUT | `/runners/:runner/schedule` | `runners.reschedule` | yes |
| POST | `/runners/:runner/kill` | `runners.kill` | yes |
| POST | `/runners/:runner/stats/reset` | `runners.resetStats` | yes |
| PUT | `/runners/:runner/config` | `runners.configure` | yes |
| DELETE | `/runners/:runner/config` | `runners.configure` | yes |

Runner routes reach runners registered in *any* process sharing the driver
and namespace; `kill` and `stats/reset` are local-only and answer 409
`RUNNER_NOT_LOCAL` for a runner owned elsewhere. `DELETE
/runners/:runner/history` is not: it works on what the backend stores.

**The two clear routes.** Both are mutations, on by default (`readOnly`
removes them, and an `actions` list must name them), and both delete for good.

- `DELETE /queues/:queue/jobs/:id/logs` (`clearJobLogs`, action
  `jobs.clearLogs`) empties a job's log and answers 200 `{ removed }`, the
  number of lines it held; the next line the job logs is its first. It is 409
  `JOB_ACTIVE` while a worker runs the job — the same rule and code as
  `DELETE /queues/:queue/jobs/:id` — with nothing removed, and 404
  `JOB_NOT_FOUND` for a job that does not exist. `authorize` sees `queue` and
  `jobId`. See [Clearing a job's log](#clearing-a-jobs-log).
- `DELETE /runners/:runner/history` (`clearRunnerHistory`, action
  `runners.clearHistory`) removes the finished runs, each with its log, keeps
  the runs in progress, and answers 200 `{ removed, kept }`, `kept` being the
  run ids left in place, newest first. It works for a runner registered in
  another process, answers 404 `RUNNER_NOT_FOUND` for an unknown one, and
  `authorize` sees `runner`. `?staleAfter=` (ms) raises how long an unvouched
  `running` record counts as in progress: at least one day, which is also the
  default, and at most thirty days; out of range is 400 `VALIDATION`. The API
  cannot lower it, so no caller can clear a live run sooner than the library's
  default would. See [Clearing run history](#clearing-run-history) for which
  runs are kept, and the limit on long parallel runs in another process.

Neither touches a counter or an analytics series. A backend without the
driver method each needs — `clearJobLogs`, `removeRuns` — has the route
pruned, so it is absent from `GET /meta/permissions` and never answers 501.

`PUT /runners/:runner/config` overrides a runner's executor and overlap
settings from outside its process, as a merge patch: a field left out is
untouched, and `null` clears that override. `DELETE` drops every override, so
the runner goes back to what its own code asks for. Each owner adopts the
override when it hears of it and applies it from the **next** run, so a run in
flight is never killed. An execution mode the runner's code does not permit is
409 `CONFIG_NOT_ALLOWED`, and a runner no owner has started since remote
configuration shipped is 409 `RUNNER_NOT_CONFIGURABLE`. Both routes need
`runners.configure`, which is off by default, and a driver that keeps runner
state; every built-in driver does. See
[Changing a runner's configuration remotely](#changing-a-runners-configuration-remotely).

A worker is listed by `GET /workers` from its first heartbeat, written when it
starts, even on a queue created a moment ago: a queue a live worker consumes
but the cached queue list (`limits.queueCacheMs`) does not have yet is checked
with a fresh read. Its row then refreshes every `reportInterval` (10 s by
default). A first start is announced as a `state` event with no `previous`.

Each row is the worker's record plus the `stale` flag the server computes, so
`rssBytes` and `heartbeatRttMs` are on it as well — both optional, and absent
rather than `0` on a worker that does not report them. **`rssBytes` is the
memory of the *process*, not of the worker**: two workers in one process report
the same number, so a table must never sum the column — group by `pid` (with
`host`, which needs `serialize.exposeHosts`) and add one row per process.
`heartbeatRttMs` is the worker's own last write to the driver, a round trip and
not a network ping, so it reads the path the worker depends on; it is the last
sample, not an average. See
[Workers](#reading-a-queue-search-totals-workers-and-throughput).

The socket's broad `workers` channel follows queues that appear after it was
subscribed. A queue this API's own `BunJobs` creates, for instance through a
worker's first `run()`, is followed at once, and that worker's first-start
`state` event arrives. A queue created in another process is followed from the
API notifier's next discovery pass, within its `discoveryInterval` (2 s by
default). What that queue's workers published before the pass, a first start
among it, is not delivered, so the session receives one `gap` with reason
`queue-discovered` and `channels: ["workers"]` per pass: refetch the workers
over HTTP. A new worker in another process is therefore seen within
`discoveryInterval` plus that refetch. Each queue is authorized on its own, as
on every broad channel: a queue `authorize` refuses is neither followed for
the session nor announced by a gap.

Example:
[`11-management-api/live-events-delivery.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/11-management-api/live-events-delivery.ts).

Worker routes reach workers in any process too. `:worker` is one
**incarnation**, the id a worker's record carries, and `authorize` sees it as
`worker`; `:key` on the configuration routes is the **stable key**, which
reaches every replica carrying it, and `authorize` sees it as `workerKey`.
Both come with `queue`. A lifecycle action is stored and announced rather
than applied in place, so it reaches the worker within milliseconds when the
worker subscribes to its instructions, within `remoteControl.interval` (2
seconds by default) when it polls, and within one `reportInterval` even if
the announcement is lost; `?wait=` (ms) waits for the acknowledgement and answers 200 once it
lands, or 202 when the wait runs out. A worker built without `remoteControl`
answers 409 `WORKER_NOT_CONTROLLABLE` (`BunJobs` turns it on for the workers
it builds). `workers.configure` is off by default, like `jobs.add`: one write
reaches every replica, and its lock settings decide whether a job can run
twice. The library call underneath is
[`RemoteWorker`](#controlling-workers-from-another-process), which makes
fewer of these checks.

`GET /runners/:runner/runs/:runId/logs` serves one run's captured output — see
[Run logs](#run-logs) for what is captured and what bounds it. It is a read,
`runners.logs`, enabled by default like every other read, and it is authorized
on the *runner*: `AuthorizeTarget` has no run field, and `POST
/runners/:runner/kill`, the only other route naming a run, authorizes the same
way. It answers `{ items, page, dropped, capped, live, lastSeq }`:

- each item is a `RunLogLineDto`: `seq` (the line's 1-based place in the
  run's output, never reused), `at` (epoch ms), `stream` (`stdout`, `stderr`
  or `log`), `message`, the line's text with its trailing newline removed
  (the field is `message`, not `text`), `level` on a `log` line that carried
  one, and `truncated`.
- `?since=` is an **exclusive** lower bound on `seq`. Send the previous page's
  `lastSeq` back to tail without repeating a line or skipping one.
- `dropped` and `lastSeq` are the run's own, never filtered by `since` or
  `stream`, which is what lets a filtered tail resume correctly. `dropped`
  tells a reader its page is a tail of a longer log rather than leaving it to
  read a silently short one, and a line the per-line cap cut carries
  `truncated: true`.
- `capped` and `live` are derived by the route, not stored: `live` is the
  run's status, and `capped` is `dropped` in the present tense — a cap
  dropping the oldest lines *as new ones arrive*, so what you are holding is a
  moving tail.
- `?stream=` narrows to `stdout`, `stderr` or `log`; `?order=desc` reads
  newest first; a page is at most `limits.maxLogPage` lines.

**409 `LOGS_NOT_RETAINED` is not the same as a 200 with no items.** The 409
says this backend keeps no log for this run to read at all —
`meta.features.runnerLogs` is `false`. A 200 with an empty `items` says the
run is known, its log is retained, and it simply logged nothing. A run neither
the history nor the log store has heard of is 404 `RUN_NOT_FOUND`, as `kill`
answers for one. A backend that cannot read run logs at all has the route
pruned, so it never answers 501.

### Analytics routes

Seven reads serve the [analytics](#analytics) series. Every one is
`metrics.read` — no new action, so a host passing an `actions` allow-list
loses nothing — and `authorize` sees the target the path names, so a host can
still split them by `queue`, `runner` or `workerKey`. Each is pruned where the
backend cannot serve it, never answered with a 501.

| Route | Answers | Authorized with |
|---|---|---|
| `GET /analytics/jobs` | jobs completed and attempts failed across the namespace | |
| `GET /queues/:queue/analytics/jobs` | one queue's; supersedes `/queues/:queue/throughput` | `queue` |
| `GET /analytics/runners` | every runner's outcomes summed, a row per runner, and `?ids=` series | |
| `GET /runners/:runner/analytics` | one runner's runs by outcome, its durations, and `runningNow` | `runner` |
| `GET /analytics/workers` | every worker's jobs summed, a row per worker key, and `?keys=` series | |
| `GET /queues/:queue/analytics/workers/:key` | one worker key's jobs and busyness | `queue`, `workerKey` |
| `GET /overview` | its `analytics` block, beside what it always answered | |

**The range.** Every one takes `from`, `to` and `resolution`:

- `from` is **inclusive**, `to` is **exclusive**. Each is epoch milliseconds or
  an RFC 3339 date-time. `to` defaults to now and `from` to an hour before `to`.
- `resolution` is `1` or `60` seconds — anything else is 400 `VALIDATION`. It
  is a **hint and an upper bound on fineness**: the answer is never finer, and
  may be coarser. Left out, the answer is the finest the backend can give.
- `to` not after `from`, a span over a day (`MAX_ANALYTICS_SPAN_MS`) or under a
  second is 400 `INVALID_ARGUMENT`.

The response describes what it actually covers in `range`:

```ts
import type { AnalyticsRangeDto } from "@kingsleyweb/bun-jobs/api/contract";

// GET /analytics/jobs?from=2026-09-21T10:00:00Z&to=2026-09-21T10:05:00Z&resolution=60
export const range: AnalyticsRangeDto = {
  resolution: 60, // what was served, in seconds
  interval: 60_000, // the same, in ms
  from: Date.parse("2026-09-21T10:00:00Z"), // the first bucket's start
  to: Date.parse("2026-09-21T10:04:00Z"), // the LAST bucket's start
  end: Date.parse("2026-09-21T10:05:00Z"), // the exclusive end: to + interval
  requested: {
    from: Date.parse("2026-09-21T10:00:00Z"),
    to: Date.parse("2026-09-21T10:05:00Z"),
    resolution: 60,
  },
  clamped: false,
};
```

**The request's `to` is exclusive; the response's `range.to` is the start of
the last bucket, and `range.end` the exclusive end.** It is the easiest thing
here to get wrong. An axis runs `range.from` to `range.end`, with the last
bucket plotted at `range.to`; a five-minute request at a minute is five
buckets, not six. Buckets are contiguous — an interval in which nothing
happened is present, with zeros.

**One resolution per response.** The served width is the finest the backend
keeps for the **whole** span within 1,500 buckets (`MAX_ANALYTICS_BUCKETS`). A
span reaching past the per-second retention is served entirely at a minute,
never half and half, since mixed widths cannot be plotted honestly. When the
answer differs from the request, `clamped` is `true` and `reason` says why:

| `reason` | Means |
|---|---|
| `retention` | The bucket `from` falls in is older than the finer width is kept for, so the range was served coarser, or its first bucket was moved forward to the oldest bucket kept. It is compared by bucket, not by instant: "the last 24 hours" asked for by a clock a few ms behind the server's is not clamped. |
| `maxBuckets` | The finer width would have held more than 1,500 buckets. |
| `resolution` | The series cannot be observed that finely — busyness, which is sampled on the heartbeat. |
| `driver` | The backend does not record that width at all — the file driver, asked for seconds. |

**Partly retained is clamped; wholly unretained is an error.** A range whose
first bucket is older than the oldest bucket kept is clamped forward, `reason:
"retention"`. A range **entirely** older is 400 `RANGE_NOT_RETAINED`, with
`context.retainedFrom` (the oldest instant kept) and `context.resolution`:
a 200 with an empty series would read as "nothing happened", and only one of
the two is true.

**Rows and batches.** `GET /analytics/runners` and `GET /analytics/workers`
answer a summed `series`, a row of totals per runner or per worker key, and on
request the series for the page on screen:

- `rows` holds at most 100 (`MAX_ANALYTICS_ROWS`), with `truncated` saying
  when there were more and `totalRows` how many. Runner rows are sorted by
  runs started, descending, then id; worker rows by `completed`, descending,
  then key. Every reachable runner, and every live worker key, has a row —
  zeros when it did nothing in the range. On a backend with the grouped reads
  (below), a worker key **no longer live that still has counts in the range
  keeps its row**: the rows answer "who did the work in this window", and a
  worker that has since stopped did some of it.
- `?ids=` (runners) or `?keys=` (worker keys) names up to 20 series
  (`MAX_ANALYTICS_SERIES`, reported as `meta.analytics.maxSeries`), repeated
  or comma-separated, which come back in `seriesByRunner` or `seriesByKey` in
  the order asked. More than 20 is 400 `BULK_LIMIT` — naming series is an
  explicit ask, so it is refused rather than cut short. A key on two queues
  comes back twice; an id or key the API cannot reach is left out.
- `series` is the namespace roll-up — one read, whatever the fleet — when the
  caller sees the whole namespace. Under a restriction (a `queues` list or
  `listQueues: "authorized"` for workers, a fixed runner list for runners) the
  roll-up would count what the caller may not see, so the visible entities are
  summed instead. `GET /analytics/jobs` follows the same rule.

**What a roll-up costs.** On a backend with the four grouped reads — every
built-in driver — the rows are **one** read of every entity's totals, a
restricted series one more, and a batch **exactly one** read of its kind,
however many runners or workers there are: 20 sparklines are one request and
one read. A backend without them keeps a read per listed runner or live worker
key, and serves the batch from those same reads.

**`runningNow`** is state, not a bucket, so no series holds it. For each
runner it is one read of the runner's lock, together with the runs a runner
registered in this process holds in memory: at least this many, since a
`parallel` run in another process holds no lock to see. `GET /analytics/runners`
reads locks only for the rows it returns (at most 100); its envelope's
`runningNow` adds the in-process runs of local runners beyond that cap, and
reads no remote runner beyond it.

**One worker key.** `GET /queues/:queue/analytics/workers/:key` answers by the
stable key, so a key with nothing counted reads as zeros, not 404 — a worker
that has since stopped still has its history. `jobs` resolves like any series;
`busyness` carries **its own `range`**, never finer than the heartbeat, so
usually a minute per bucket while `jobs` is a second. `busyness` is absent
where the backend records none.

**`/overview`.** Beside what it always answered, `GET /overview` carries
`analytics`: its `range`, and `jobs`, the namespace's jobs series — one read
from the roll-up, whatever the queue count, or the queues summarised summed
under a restriction. On a backend with the grouped reads it also carries
`runners` and `workers`, the roll-ups `GET /analytics/runners` and
`GET /analytics/workers` answer, without a batch. Each costs a fixed number of
reads whatever the fleet, plus a lock read per runner row returned, so a
namespace with 5 workers and one with 200 cost the overview the same metrics
reads. Without them the two sections are left out, because each row would
cost a read on every poll. `analytics` is absent where the backend records no
analytics.

**`minutes` is deprecated.** `/overview` and `/queues/:queue/throughput`
accept `from`, `to` and `resolution` too, and when `from` or `to` is given it
decides the window instead — clamped to what is kept, and 400
`RANGE_NOT_RETAINED` when wholly older. Their `throughput` and
`throughputSeries` stay a minute per bucket, as they always were.
`/queues/:queue/analytics/jobs` is the same count at the width the range
resolves to.

**`GET /meta` → `analytics`** says what can be asked for, and is `null` when
the backend serves no analytics:

| Field | Meaning |
|---|---|
| `resolutions` | The widths served, in seconds: `[1, 60]`, or `[60]` on the file driver. |
| `retentionMs` | How long each width is kept, keyed `"1"` and `"60"`. |
| `maxSpanMs` | The longest span one request may cover: a day. A range picker clamps itself to this. |
| `maxBuckets` | The most buckets one series may hold: 1,500. |
| `maxSeries` | The most series `ids=`/`keys=` may name: 20. Also the page size for a Runners or Workers table, so one page's sparklines are one request. |
| `recording` | What is being recorded: `resolution`, `secondRetentionMs`, `workers`, `runners`, `durations` — the [`metrics` option](#the-metrics-option) in force. |
| `busynessIntervalMs` | How often busyness is sampled: 10,000, the workers' default `reportInterval`. |

The contract exports the same caps and the range presets a picker offers:
`ANALYTICS_RESOLUTIONS`, `ANALYTICS_PRESETS`, `DEFAULT_ANALYTICS_PRESET`,
`MAX_ANALYTICS_SPAN_MS`, `MAX_ANALYTICS_BUCKETS`, `MAX_ANALYTICS_SERIES`,
`MAX_ANALYTICS_ROWS`, `DEFAULT_SECOND_RETENTION_MS`, `MAX_SECOND_RETENTION_MS`
and `DURATION_HISTOGRAM_BOUNDS`.

### Pagination, filtering and `include`

Lists are offset-based: `?offset=0&limit=20`, answering
`{ items, page: { offset, limit, total?, hasMore } }`. Ask for `total=true`
only when you need a count — it costs a second query. Jobs can be filtered by
`state` (repeated or comma-separated), by `name`, and by `search` (a substring
of id or name, never the payload).

Jobs can also be filtered by
[who ran them and when they finished](#who-ran-a-job-worker-attribution):
`workerKey`, `workerId`, `finishedFrom` and `finishedTo`, as on
`queue.list()`. `workerKey` and `workerId` take at most 100 values each,
repeated or split at commas, so a key containing a comma cannot be sent as a
single value. `finishedFrom` and `finishedTo` are epoch ms or RFC 3339
date-times, `finishedFrom` inclusive and `finishedTo` exclusive, and only
`completed` and `dead` jobs match a range. The API refuses two requests with
400 `INVALID_ARGUMENT` rather than answer an empty page that would read as
"this worker ran nothing". `queue.list()` and `queue.page()` refuse the same
two with a `ConfigError`; the 100-value cap is the API's alone:

- a `finishedTo` that is not after `finishedFrom`, an inverted or empty range;
- a `workerKey` or `workerId` when `/meta.features.jobAttribution` is
  `false`, because the backend has no stamp to match. The `detail` says to run
  `syncSchema()` on a SQL backend.

A range alone is answered on every backend. Pair `workerKey` with one: a queue
usually has one key shared by its replicas, and no backend indexes it.

`sort` orders the page: `natural` (the default) is each state's own order, and
`createdAt` is by creation time whatever the states, ties by `id`, so
`order=desc` is newest first on every tab. `sort=createdAt` is served where
`/meta.features.addedByState` is `true` (memory, SQL, MongoDB) and is 400
`INVALID_ARGUMENT` with a `detail` elsewhere — never a page silently in the
natural order. See
[sorting by creation time](#jobs-added-in-a-range-and-sorting-by-creation-time)
for each state's natural order and the cost on SQL and MongoDB.

Every job, listed or read, carries `processedBy`, the worker that claimed its
current or last attempt (`{ id, key?, host?, pid? }`, or `null`), and
`host` and `pid` are left out under `serialize.exposeHosts: false`.

`GET /queues` pages the same way (`?offset=&limit=`, `limit` at most and by
default `limits.maxQueues`) and answers `page` beside `items`; `truncated` is
`page.hasMore`. Its `search` matches a substring of the queue name ignoring
case, as job search does.

A new job's `opts.jobId` is at most 191 characters, the cap bun-jobs applies
to every id a caller chooses; more is 400 `VALIDATION`. That schema is only a
first check: bun-jobs' own `assertJobId` is the authority — it counts UTF-16
units rather than characters, and refuses control characters, a leading `.`
and a lone surrogate — so an id the schema passes can still be refused, answered 400
`INVALID_ARGUMENT`. An id that *addresses* a job (a path, a bulk body, a
lookup) may be up to 1024 characters, so a job stored with a longer id by an
earlier version stays readable, retryable and removable.

Lists omit the heavy fields; ask for them with `include=data,returnValue,stacktrace,opts`.
A single read includes `data`, `returnValue` and `opts` by default. Despite its
name, `stacktrace` holds stack traces only when the API is created with
`serialize: { exposeStacks: true }`, which is off by default: otherwise each
entry, like `failedReason`, is the error's `name` and `message`, plus `code`,
`data` and `cause` when it had them. Timestamps
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

Every time a request gives — a job's `runAt`, a schedule's `anchor` or `at` —
is epoch milliseconds a `Date` can hold (0 to `MAX_DATE_MS`, 8.64e15, exported
from the contract) or an RFC 3339 date-time; anything else is 400 `VALIDATION`
at that field.

`PUT /runners/:runner/schedule` refuses a schedule in two steps. A malformed
field — an interval below 1, a time a `Date` cannot hold (epoch ms above
8.64e15, or a string that is not an RFC 3339 date-time) — is 400 `VALIDATION`
at that field. A cron expression or time zone the scheduler refuses is 400
`INVALID_SCHEDULE` with one issue, whose `path` is `schedule.cron`,
`schedule.tz`, or `schedule` for a bare cron string.

| Code | Status | | Code | Status |
|---|---|---|---|---|
| `UNAUTHORIZED` | 401 | | `VALIDATION` | 400 |
| `FORBIDDEN` | 403 | | `SERIALIZATION` | 400 |
| `QUEUE_NOT_FOUND` | 404 | | `INVALID_ARGUMENT` | 400 |
| `JOB_NOT_FOUND` | 404 | | `INVALID_NAME` | 400 |
| `RUNNER_NOT_FOUND` | 404 | | `INVALID_JSON` | 400 |
| `RUN_NOT_FOUND` | 404 | | `INVALID_SCHEDULE` | 400 |
| `REPEATABLE_NOT_FOUND` | 404 | | `BULK_LIMIT` | 400 |
| `WORKER_NOT_FOUND` | 404 | | `ARGS_NOT_ALLOWED` | 400 |
| `ROUTE_NOT_FOUND` | 404 | | `RANGE_NOT_RETAINED` | 400 |
| `WORKER_GONE` | 410 | | `UNSUPPORTED_SUBPROTOCOL` | 400 |
| `JOB_STATE_CONFLICT` | 409 | | `NAME_NOT_ADDABLE` | 403 |
| `JOB_ACTIVE` | 409 | | `CSRF_REJECTED` | 403 |
| `RUNNER_NOT_LOCAL` | 409 | | `ORIGIN_REJECTED` | 403 |
| `OPERATION_IN_PROGRESS` | 409 | | `UNSUPPORTED_MEDIA_TYPE` | 415 |
| `LIMITS_CONTENDED` | 409 | | `PAYLOAD_TOO_LARGE` | 413 |
| `RUNNER_STOPPED` | 409 | | `CONNECTION_LIMIT` | 429 |
| `LOCK_UNAVAILABLE` | 409 | | `NOT_SUPPORTED` | 501 |
| `LOCK_LOST` | 409 | | `QUEUE_CLOSED` | 503 |
| `LOGS_NOT_RETAINED` | 409 | | `WORKER_CLOSED` | 503 |
| `WORKER_STATE_CONFLICT` | 409 | | `QUEUE_FULL` | 503 |
| `WORKER_NOT_CONTROLLABLE` | 409 | | `DRIVER_ERROR` | 503 |
| `WORKER_PERSISTENCE_NOT_ALLOWED` | 409 | | `DEFAULTS_CHANGED` | 409 |
| `CONTROL_CONTENDED` | 409 | | | |
| `CONFIG_NOT_ALLOWED` | 409 | | | |
| `RUNNER_NOT_CONFIGURABLE` | 409 | | | |
| `INTERNAL` | 500 | | | |

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
| `workers` | every queue's worker events: `control`, `state`, `config` (mode `jobs` or `both`) |
| `queue/{queue}/workers` | one queue's worker events |

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
live, an event matching several of your channels arrives **once**.

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

A connection subscribed to `workers` can also receive a `gap` with reason
`queue-discovered`, `channels: ["workers"]` and `fromSeq: 0`: the server's
discovery pass found a queue another process created, and what its workers
published before then was missed. One per pass, however many queues it found;
a queue created in the server's own process causes none.

Example:
[`11-management-api/live-events-delivery.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/11-management-api/live-events-delivery.ts).

A resume may be split over several `subscribe`s — a different `events` filter
per group of channels, or more than 256 channels — each carrying the same
`resume`. Each one's replay covers its own channels in full, and its `resumed`
speaks for them.

**`seq` and duplicates.** `seq` increases within an `epoch`, across every
channel, and live events arrive in `seq` order. One connection never sends the
same event twice **for the same channel**: a replay skips the channels an event
already reached, live or in an earlier frame's replay, and re-sends it for the
others, listing just those in `subscriptions`. So de-duplicate on
`(seq, channel)`, not on `seq` alone — an event can arrive a second time, for a
channel it had not reached.

The last `seq` processed, with its `epoch`, is all a client needs to resume —
with one caveat for a split resume: a later frame's replay can carry `seq`s
below ones an earlier frame's replay already delivered, so if the connection
drops before every resuming `subscribe` is acked, resume again from the
position that resume used, not the highest `seq` seen. `heartbeat.seq` is the
server's latest across *all* connections, so a jump in it says nothing about
missed events — only `gap` frames do.

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
from a new target can be delayed by one `authorize` call — and a held event is
never overtaken by a later one. A resume's replay settles the decisions it
needs first; one still pending then delays the `ack`, so the replay still
precedes it. At most 1000 events are held; past that the connection is treated
as a slow consumer — it stops receiving events and gets a `slow-consumer`
`gap` once the backlog clears.

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
  host/pid (`exposeHosts`, on worker records and on a job's `processedBy`
  alike) are switches. Run-log lines are scrubbed earlier,
  as they are captured (see [Secrets are redacted](#secrets-are-redacted)).
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
| `maxLogPage` | `500` | largest log page, for a job's logs and a run's alike |
| `maxHistory` | `200` | largest runner history page |
| `maxQueues` | `500` | queues summarised by `/queues` and `/overview` |
| `queueCacheMs` | `2000` | how long the known-queue and known-runner lists are cached; a queue name or runner id missing from one is checked against the backend once more (at most once per window) before a 404, so a runner another process started is found at once, and a queue a live worker consumes is re-read whenever it is missing |
| `maxJobDataBytes` | `1048576` | body accepted by `jobs.add`/`jobs.update` |
| `maxApplyDefaults` | `1000` | largest `limit` of one `job-defaults/apply` call; at most `10000` |

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
- `analytics` — what the [analytics routes](#analytics-routes) can serve, or
  `null` when the backend records none;
- `websocket.port` — present when the socket has its own port;
- `driver.capabilities` — `blockingWait`, `events`, `multiProcess`,
  `multiHost` and `jobAttribution`, which is required. They are picked field
  by field, so a capability this version does not know, from a newer or
  custom driver, is not echoed.

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
says which. A flag is `true` only where this API serves every route in its
row, by the same test that prunes the router: under `mode: "jobs"` the runner
features read `false`, and under `mode: "runner"` the queue ones do. `readOnly`
and `actions` do not turn a flag off. They are permissions, which
`/meta.readOnly` and `/meta/permissions` answer, so a UI can tell "this backend
cannot" from "you may not":

| Feature | Routes | Needs |
|---|---|---|
| `logs` | `/jobs/:id/logs` | `getJobLogs` |
| `runnerLogs` | `/runners/:runner/runs/:runId/logs` | `appendRunLog` and `getRunLog` |
| `update` | `PATCH /jobs/:id` | `updateJob` |
| `limits` | `/queues/:queue/limits` | queue state |
| `flows` | `/jobs/:id/children` | `recordChild` |
| `search` | `?search=` on job lists | `findJobs` |
| `workers` | `/workers`, `/queues/:queue/workers`, `/queues/:queue/workers/:worker` | worker records |
| `workerControl` | `/queues/:queue/workers/:worker/pause`, `resume`, `stop` and `start`; `/queues/:queue/worker-configs` and `/queues/:queue/worker-configs/:key` | worker records and queue state (`getQueueState`, `setQueueState`, `listQueueState`) |
| `throughput` | `/queues/:queue/throughput`, `/overview` | `getThroughput` |
| `runnerMetrics` | `/analytics/runners`, `/runners/:runner/analytics`, `/overview`'s `analytics.runners` | `countRunnerRun` and `getRunnerMetrics`, plus the three every analytics route needs |
| `workerMetrics` | `/analytics/workers`, `/queues/:queue/analytics/workers/:key`, `/overview`'s `analytics.workers` | `countWorkerJobs` and `getWorkerMetrics` and worker records, plus the three every analytics route needs |
| `jobAttribution` | `processedBy` on every job, and `?workerKey=` and `?workerId=` on `/queues/:queue/jobs` | `capabilities.jobAttribution: true` (on SQL, the stamp columns `syncSchema()` adds) |
| `addedByState` | `/overview/added`, `/queues/:queue/counts/added`, and `?sort=createdAt` on `/queues/:queue/jobs` | `countAddedJobs` (memory, SQL and MongoDB; not Redis or file) |
| `jobDefaults` | `GET`, `PUT` and `DELETE /queues/:queue/job-defaults` | queue state (`getQueueState`, `setQueueState`); every built-in driver |
| `jobDefaultsApply` | `POST /queues/:queue/job-defaults/apply` | queue state and `rewritePendingOptions`; every built-in driver |

`jobAttribution` has no route of its own, like `search`: it is a field on
every job and two filters on the job list, so it reads `false` under
`mode: "runner"`, where the list is not served. It follows the driver's
declared capability, not a list of methods, since `findJobs` exists on drivers
that record nothing. On SQL it is read on every request, so it turns `true`
once a sync adds the stamp's columns, without a restart. While it is `false`,
the job list is still served, a job nothing stamped reads `processedBy:
null`, `?finishedFrom=` and `?finishedTo=` still work (by scanning the states
asked for), and
`?workerKey=` and `?workerId=` are 400 `INVALID_ARGUMENT`.

`POST /jobs/:id/fail` also needs `buryJob`, and the repeatable `disable` and
`enable` routes need queue state; every built-in driver has both, so neither
has a feature flag. `DELETE /jobs/:id/logs` needs `clearJobLogs` and
`DELETE /runners/:runner/history` needs `removeRuns`; every built-in driver
has both too, so neither has a flag. A custom driver without one has that
route pruned, and whether the action appears in `GET /meta/permissions`
answers it.

The two analytics jobs routes, `/analytics/jobs` and
`/queues/:queue/analytics/jobs`, have no flag of their own: every analytics
route needs `getMetricsSupport`, `getNamespaceMetrics` and `getQueueMetrics`,
and `meta.analytics` is `null` exactly when those are missing — which means
every analytics route is pruned. `/overview`'s `analytics.runners` and
`analytics.workers` also need the four grouped reads (see
[Analytics routes](#analytics-routes)). Every built-in driver has all of them.

`runnerLogs` is the one feature whose route is pruned on less than it reports.
The route needs only `getRunLog`, so a backend that can read run logs but never
write them keeps it — and answers 409 `LOGS_NOT_RETAINED`, which is exactly
what `runnerLogs: false` means, rather than an empty page a client would read
as "the run was quiet". All eight built-in backends have both methods.

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
- [`11-management-api/live-events-delivery.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/11-management-api/live-events-delivery.ts)
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
`driver.capabilities`: `{ blockingWait, events, multiProcess, multiHost }`,
plus `jobAttribution`, which is `true` on every built-in driver: it records
[who ran each job](#who-ran-a-job-worker-attribution). On SQL it is live: it
reads `false` until connecting has confirmed the stamp's columns, so before
`connect()` and on a jobs table from before attribution until `syncSchema()`
adds them.

The file driver's `multiHost` is `false` on purpose: its guarantees rest on
POSIX `rename` and `O_EXCL`, which network filesystems do not reliably provide.

**The file driver survives a process crash, not a power cut.** It never calls
`fsync`. Every record is written to a temporary file and renamed into place,
and every job moves between states by renaming a marker, so a process killed
at any point leaves each record whole and every half-finished move is repaired
the next time the job is touched. What a rename or a create cannot promise is
that the data has reached the disk. After a power loss or a kernel crash, a
job added or finished in the last few seconds can be missing, or back in its
previous state, and a newly created record can come back empty, which the
driver treats as never written. If an acknowledged add must survive power
loss, use Redis with AOF `fsync`, or a SQL backend.

**Custom drivers.** A driver of your own implements `JobsDriver`. Its
queued-trigger methods include **`peekQueuedTrigger(ns, key)`, which is
required**: it returns the head of a runner's queued-trigger list, meaning the
trigger `popQueuedTrigger` would take next, without taking it, or `null` when
the list is empty. A paused runner uses it to see whether the head was forced
before popping it. It must be read-only: nothing removed, reordered or
created, and a runner nobody has written to stays out of `listRunners`.

**`popQueuedTriggerIf(ns, key, expectedId)` is required too.** It is a
compare-and-pop: it removes and returns the head only if the head's `id` is
`expectedId`, and otherwise returns `null` and changes nothing. That covers an
empty list, a different head, and a runner the backend does not know, which it
must not create. A paused drainer peeks at the head, decides whether it may run,
then pops it by id and peeks again on `null`. That way drainers in several
processes never pop a record they did not inspect. The check and the removal
must be one atomic step against every other process: of N callers racing with
the same id, exactly one gets the record. The built-in drivers do it with a
synchronous check-and-shift (memory), the state lock file (file), a locked
transaction (SQL), a Lua script (Redis) and a conditional `$pop` on the exact
head (MongoDB).

#### Minimum database versions

Some backends need a server at least this new; the rest state no minimum.

| Backend | Minimum | Why |
|---|---|---|
| MongoDB | 4.2 | See [Installation](#installation). |
| MySQL | 8.0 | A window function (`MAX(…) OVER (PARTITION BY …)`) in the grouped worker read with busyness, behind the management API's `GET /analytics/workers` and `GET /overview` (see [Analytics per driver](#analytics-per-driver)). |
| MariaDB | 10.2 | The same window function. |
| SQLite | 3.25 | The same window function. |

#### Open-file limits

**MongoDB needs a raised open-file limit.** WiredTiger keeps each collection
and each index in a file of its own, and a queue's collections carry several
indexes each. At the soft limit of 1,024 that Docker gives a container by
default, a few test runs in a row were enough: WiredTiger failed with
"Too many open files" (errno 24), panicked, and `mongod` aborted. MongoDB
recommends at least **64,000** open files and warns at startup below that. We
use 65,536. Measured here: the test database holds about 1,800 WiredTiger
files, and `mongod` held 1,286 descriptors after three back-to-back runs of
the MongoDB suites.

The SQL servers did not hit the limit here, and raising theirs as well does no
harm:

- **Postgres** limits itself. Each server process keeps at most
  `max_files_per_process` files open (default 1,000) and closes others as it
  needs to, so it stays under 1,024 on its own.
- **MySQL** raises its own limit. It works out how many files it needs from
  `max_connections` and `table_open_cache` (8,161 with the `mysql:8.4`
  defaults) and raised the limit from Docker's 1,024 to that. Given 65,536,
  it kept 65,536.
- **MariaDB** raises its own limit too. In the `mariadb:11` image it went
  from Docker's 1,024 to 32,198, and `open_files_limit` read 32,198 again
  with 65,536 available.

How to set it:

```bash
# Docker
docker run --ulimit nofile=65536:65536 … mongo:7
```

```yaml
# Docker Compose
services:
  mongodb:
    image: mongo:7
    ulimits:
      nofile:
        soft: 65536
        hard: 65536
```

```ini
# systemd, for a native install: a drop-in (systemctl edit mongod)
[Service]
LimitNOFILE=64000
```

Docker applies `--ulimit` only when it creates a container. A container that
already exists has to be recreated to pick it up, and `--volumes-from` on the
old one keeps its data. For a native install, MongoDB's documentation
recommends `LimitNOFILE=64000` in the `mongod` unit; don't assume a package
set it. Check what a running server actually got with
`grep "open files" /proc/<pid>/limits`.

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
| every type | `metrics` | What the driver records for analytics, and how long it keeps per-second buckets. See [The `metrics` option](#the-metrics-option). |

The `sql` fields:

- The engine is detected from the URL scheme: `postgres`/`postgresql`,
  `mysql`, `mariadb`, or `sqlite`/`file`. A bare path or `:memory:` is also
  SQLite. With `connection` fields, `adapter` is required.
- `tablePrefix` defaults to `bun_jobs_`.
- `tables` gives exact names for `jobs`, `locks`, `kv`, `events`, `logs`,
  `run_logs`, `workers`, `metrics`, `queue_metrics`, `worker_metrics` and
  `runner_metrics`; these ignore the prefix. `metrics` holds the per-minute
  [throughput](#reading-a-queue-search-totals-workers-and-throughput); the
  three after it hold the [analytics](#analytics-per-driver) series.
- `notify` (Postgres `LISTEN`/`NOTIFY`) is on by default, with polling
  underneath.
- **A transaction-pooling connection pooler cannot carry those
  notifications.** `LISTEN` belongs to a session, and a pooler that hands each
  transaction whichever backend connection is free has no session to keep it
  on — so behind PgBouncer in transaction mode, AWS RDS Proxy or Cloudflare
  Hyperdrive, notifications do not arrive. Hyperdrive does not support
  `LISTEN`/`NOTIFY` at all; RDS Proxy answers a `LISTEN` by pinning the
  session for the connection's life, with no opt-out on Postgres, which costs
  the pooling you went there for. **The driver stays correct either way**: a
  notification is an optimisation, never the only path, and the polling
  underneath it is the correctness floor — the same floor that already covers
  a notification missed while a listener reconnects, or a job promoted by
  another process's maintenance sweep, which is never announced at all. Only
  wakeup latency changes. So leave `notify` on, where it is harmless, or set
  it `false` to skip the listen attempt and the connection it would hold, and
  set `pollInterval` to the latency you want.
- Hyperdrive's 60-second query cap does not bind a wait. A wait here is polled
  rather than held open, so `maxBlock` is spent over many short statements
  instead of one long one. What the cap can bind is a bulk statement on a
  large table: a [schema sync](#schema-sync)'s index build, or a `drain()` of
  a very large queue.
- Events (the API socket, `BunQueue` subscriptions, worker control) are read
  from the `events` table by one poll per namespace per driver, every
  `pollInterval`, however many channels it follows — not one query per
  subscription.
- `syncSchema` is off by default. Without it, an existing table gets no new
  columns or indexes after an upgrade. See [Schema sync](#schema-sync).

The `redis` fields:

- The host defaults to `127.0.0.1:6379`; `rediss` is used with TLS.
- `keyPrefix` defaults to `bun-jobs`.
- `cluster: true` hash-tags keys per queue and per runner.
- Each driver opens up to two extra connections, only once used: one blocking
  connection serving every queue it waits on (one per queue name with
  `cluster: true`), and one for pub/sub. In Cluster the add path writes the
  namespace's queue list beside its script, so every queue script stays in
  one slot.
- `drain()` and `clean()` on pending states work in bounded batches of 1,000,
  so a large queue never stalls the server for long; a job added while a
  drain runs may or may not be removed with it.
- A count retention (`removeOnComplete: 10`) that was lowered trims at most
  100 jobs past the cap per completion, so the excess clears over the next
  few completions.

The `mongodb` fields:

- `database` defaults to the URL's path, then to `bun_jobs`.
- `collectionPrefix` defaults to `bun_jobs_`.
- `collections` gives exact names for `jobs`, `locks`, `kv`, `events`,
  `jobLogs`, `runLogs` and `metrics`, which holds the
  [analytics](#analytics-per-driver) series.
- `syncSchema` is off by default.
- The server needs an open-file limit of at least 64,000. At Docker's default
  of 1,024 it crashes. See [Open-file limits](#open-file-limits).

Constructing a driver class directly (`new SqlDriver`, `new RedisDriver`,
`new MongoDriver`, `new FileDriver`) accepts everything a config does, plus
options that cannot be JSON or are rarely needed:

| Option | Driver | Default | Meaning |
|---|---|---|---|
| `sql` | SQL | | An already-open `Bun.SQL` to share. |
| `client` | Redis | | An already-connected `RedisClient` for commands. `url` is still required, for the blocking and pub/sub connections. |
| `client`, `clientOptions` | MongoDB | | A shared `MongoClient`, or options for the client the driver creates. Every collection is read from the primary, whatever the client's `readPreference`: the reads that decide a write (a failure checking the lock, a flow delivery) must not see a lagging secondary. On a standalone server this changes nothing. |
| `maxBlockSeconds` | Redis | `5` | Longest blocking wait: it bounds each wait, and the shared blocking pop. |
| `pollInterval` | SQL, MongoDB / file | `50` / `25` ms | How often a wait re-checks. On SQL and MongoDB it also paces event subscriptions, and every subscription a driver holds in one namespace shares one poll: one query per interval, however many channels it follows. |
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
| `add` | `true` | Add missing columns and indexes. On SQL this is the only way a table that already exists gets a new index: connect builds indexes only with a table it creates. |
| `indexes` | `true` | Drop indexes the driver no longer defines, and rebuild any whose predicate changed. Only touches indexes the driver named. |
| `alterColumns` | `false` | Change column types. This rewrites the table under a lock that blocks every reader and writer. |
| `dryRun` | `false` | Report every change without applying any. |

It is **safe by default**, SQLite's index builds aside:

- Adding columns and dropping indexes cannot stall a running queue. Building
  an index cannot either on Postgres, where it is `CONCURRENTLY`, or on MySQL
  and MariaDB, where InnoDB builds it online. There it takes a brief lock at
  the start and end, which waits for a transaction still open on the table,
  and statements arriving meanwhile wait with it.
- On **SQLite** an index build locks out writers until it finishes, since
  SQLite has one writer and no concurrent build. Its `create-index` changes
  report `blocking: true`. The default sync still makes them. Run it in a
  quiet moment, or plan first with `dryRun`.
- A type change is reported with `blocking: true` and `applied: false` unless
  `alterColumns` asks for it.
- Every `SchemaChange` comes back either way, with fields `kind`, `table`,
  `target`, `statement`, `reason`, `blocking` and `applied`.

**Connect creates tables, and indexes only with them.** On SQL, connect runs
`CREATE TABLE IF NOT EXISTS` for every table and builds a table's indexes only
when it has just created that table. An index a new version defines on a table
that already exists is left to `syncSchema()`, which reports it as a
`create-index` change and builds it without blocking writes on Postgres
(`CONCURRENTLY`), MySQL and MariaDB (online). Connect never does this,
because a plain `CREATE INDEX` on Postgres or SQLite blocks every write to a
large, busy table for the whole build, and the first upgraded process to
connect would do it before anyone asked. This applies to **every** index, not
only new ones for a particular feature. **A deployment that never runs
`syncSchema()` won't get new indexes**, only new tables. Turn on
`syncSchema: true`, or run it once per upgrade. SQLite has no concurrent build
and locks out writers while an index is built, so its `create-index` changes
report `blocking: true`.

The same goes for columns. The four `processed_by_*` columns that record
[who ran a job](#who-ran-a-job-worker-attribution) reach an existing jobs
table only through a sync. Until then the driver reports
`capabilities.jobAttribution: false` and stamps nothing. It reads `false`
before `connect()` too, until connecting has confirmed the columns. It notices a sync run
by another process within about 60 seconds. The partial index on finished jobs
that serves a `finishedOn` range exists on **SQLite only**. On Postgres it cost
25-35% of completion throughput when completed jobs are kept, and MySQL and
MariaDB have no partial indexes.

It also **never drops what it did not create**:

- SQL only drops indexes matching the driver's own `ix_` naming convention.
- MongoDB has no column types, so `alterColumns` means nothing there. It drops
  only indexes on an explicit retired list, because an index it no longer
  defines is indistinguishable from one somebody added by hand.
- MongoDB's retired list names six indexes, each with a successor. Connect
  creates the successors, so after an upgrade both generations exist, and
  every write pays for both, until a sync (`indexes`, on by default) drops the
  old ones:

  | Retired | Replaced by |
  |---|---|
  | `jobs` `ns_1_queue_1_state_1_priority_1_createdAt_1` | `ns_1_queue_1_state_1_priority_1_createdAt_1__id_1` |
  | `jobs` `ns_1_queue_1_state_1_runAt_1` | `ns_1_queue_1_state_1_runAt_1__id_1` |
  | `jobs` `ns_1_queue_1_state_1_lockExpiresAt_1` | `ns_1_queue_1_state_1_lockExpiresAt_1__id_1` |
  | `jobs` `ns_1_queue_1_state_1_finishedOn_1` | `ns_1_queue_1_state_1_finishedOn_1__id_1` |
  | `jobs` `expiresAt_1` (global) | `ns_1_queue_1_expiresAt_1` |
  | `events` `ns_1_channel_1__id_1` | `ns_1_at_1` (the age prune); channels are followed by `ns_1_channel_1_seq_1` |

  With `_id` in the key, a claim and a page sorted by `runAt`,
  `lockExpiresAt` or `finishedOn` walk the index instead of sorting the whole
  state in memory.
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
| `JobDefaultsChangedError` | `DEFAULTS_CHANGED` | `queue.applyJobDefaults()` was asked to apply a `seq` that is no longer the stored one (`queue`, `expectedSeq`, `seq`). Nothing was written. |
| `SerializationError` | `SERIALIZATION` | A value (job data, a result) is not JSON-serialisable. |
| `WorkerStateConflictError` | `WORKER_STATE_CONFLICT` | `RemoteWorker.pause()` or `resume()` addressed a worker that is `stopped` or `stopping` (`action`, and `workers`: each refused worker's `id` and `state`). Nothing was written. The management API answers 409 `WORKER_STATE_CONFLICT`. |
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
| [`examples/bun-jobs`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs) | This package: queues, workers, the registry, scheduling, flow control, failures, the runner, every driver, integrations, and 20 option tours that assert every option. |
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
| | [`live-events-delivery.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/11-management-api/live-events-delivery.ts) | what the socket delivers on any backend: a queue or runner nothing has discovered, `retried` / `cleaned` on a job's channel, broad channels hiding what the host denies, and the `workers` channel following new queues (one `queue-discovered` gap for another process's) |
| | [`openapi-and-docs.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/11-management-api/openapi-and-docs.ts) | `openapi()` / `asyncapi()` and their endpoints; `docs.ui` off and on, pinned and locked down |
| | [`typed-client.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/11-management-api/typed-client.ts) | a typed client built on `@kingsleyweb/bun-jobs/api/contract` alone: `GET /meta` as its configuration, `/meta/permissions?channel=` before a socket, `encodeJobId` for a job channel, and a browser build proving the contract drags no server code along |
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
| [`worker-isolation.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/worker-isolation.ts) | `isolation` and `isolationOptions` in each mode; what works inside an isolated job; an awaited `updateProgress` is in the store before the completion is |
| [`job-methods.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/job-methods.ts) | `job.fail()` inside a processor and from outside (a pending job buried at once, an active one's worker aborting at its next heartbeat); `schedule()`, `update()` and `this \| null`; `disable()` / `enable()` on an occurrence; the queue's `disableRepeatable()` / `enableRepeatable()`; `remove()` / `promote()` / `retry()` emitting and publishing; `progress` as `RunProgress \| null` and `extendLock()` only from the processor's view |
| [`runner-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/runner-options.ts) | every `BunRunnerOptions` field, `RunContext`, runner method and event, `BunRunnerManager` and `remote()` |
| [`bunjobs-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/bunjobs-options.ts) | every `BunJobsOptions` field and `BunJobs` method, `jobsFromContext` |
| [`draft-and-process-every.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/draft-and-process-every.ts) | every `JobDraft` member and `RepeatEveryOptions` field, saving twice; `processEvery` and a worker's runtime `pollInterval` / `maxBlock`, per driver |
| [`read-apis.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/read-apis.ts) | every `ListJobsOptions` field; `search` taken literally and folded for case per engine; `page` totals; `getJobs` order, gaps and repeats; `listWorkers` fields, `reportInterval` and a lapsed record; `getThroughput` bounds, buckets and retried failures; `getQueueSummaries`; each driver fallback |
| [`notifier.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/notifier.ts) | every `JobsNotifierOptions` field and member, every published event and payload |
| [`driver-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/driver-options.ts) | every option of every driver and connection helper |
| [`errors.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/errors.ts) | every error class, triggered through the public API, with its `code` and fields |
| [`utilities.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/utilities.ts) | every exported helper: cron, schedules, repeats, options, backoff, JSON, ids, keys, connection, constants |
| [`ids-and-keys.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/ids-and-keys.ts) | job ids and repeat keys at every entry point: what is refused, derived ids fitted to the tightest store, repeat keys as listed and removed, debounce and throttle windows, per-engine name limits |
| [`jobs-api-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/jobs-api-options.ts) | every `createJobsApi` option: construction `ConfigError`s, `mode` / `readOnly` / `actions` / capability pruning against `/meta` and `/meta/permissions`, RFC 9457 problems, `authorize` asked once, a request failing a check still against the target its path names, `limits`, `cors` / `csrf` / `trustProxy`, `serialize`, `docs` |
| [`jobs-api-socket-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/jobs-api-socket-options.ts) | every `websocket` option, per-channel subscribe refusals, replay and resume, coalesced progress, the client limits and every close code |
| [`job-defaults.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/job-defaults.ts) | queue job defaults: the stored override and its precedence, propagation, the `applyJobDefaults()` walk and its refusals, and the four API routes with their opt-ins |
| [`analytics-and-attribution.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/analytics-and-attribution.ts) | the `metrics` option, what is recorded, range resolution and every clamp reason, the analytics routes; `processedBy` and the worker filters; `countAdded()` and `sort: "createdAt"`, and their fallbacks per driver |
| [`run-logs-and-clears.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/run-logs-and-clears.ts) | run-log capture per execution mode, the `logs` hint, the caps and redaction; clearing a job's log and a runner's history, on every driver |
| [`remote-control.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-jobs/10-options/remote-control.ts) | `RemoteWorker` lifecycle and configuration, how long a stop lasts, the API's 409s, a runner's configuration changed by one owner and adopted by another; a buried flow retried in either order |

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
