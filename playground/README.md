# bun-node playground

A place to try things by hand and see how they look: `bun-jobs`, its
management API (`createJobsApi`) and the `bun-jobs-ui` app on one
`BunHttpAdapter`, with a small simulation that keeps every screen moving.

```bash
bun playground/index.ts                              # then open http://localhost:4000/jobs
cd playground && bun run dev                         # the same, restarting on file changes
PORT=3000 bun playground/index.ts                    # another port
PLAYGROUND_DRIVER=sqlite bun playground/index.ts     # keeps its state in playground/.data/
PLAYGROUND_DRIVER=redis PLAYGROUND_URL=redis://localhost:6379/12 bun playground/index.ts
PLAYGROUND_INTERVAL_MS=0 bun playground/index.ts     # seed only, no new jobs
```

**Restart it after changing the UI.** The playground passes `dev: true`, so
`jobsUi()` builds the browser app from the source in memory on the first
request — never from a prebuilt `dist/`, which packing the package leaves
behind — **once per process**, and serves that build for as long as the
process runs. A playground started before a UI
change keeps serving the old screens, whatever the browser reloads. If you
use `bun run dev` and a UI change does not show, the same applies: stop it,
start it again, then reload.

It listens on `127.0.0.1` only. Its API allows **every** action to anyone who
can reach it, so never expose it.

## What is running

| Where | What |
|---|---|
| `/jobs` | the UI (Overview, Queues, Workers, Runners, Events, API docs) |
| `/jobs-api` | the management API, with its live-events socket on the same port |
| `/` | redirects to `/jobs` |

**Services and workers.** Two `BunJobs` contexts share one driver instance,
so the Workers page has two services to group (`index.ts`, `mailer.ts`):

| Service | Worker (stable key) | What you see |
|---|---|---|
| `api` | `api.emails.transactional`, `api.reports.monthly`, `api.webhooks.delivery`, `api.checksums.hasher`, `api.previews`, `api.previews.2`, `api.imports.wedged`, `api.notifications.scheduler`, `api.dead-letters.archive` | the simulation's own workers; the emails one sets `stopPersistenceOverridable`, so its Stop dialog offers "until somebody starts it again" |
| `mailer` | `mailer.emails.bulk`, `mailer.images.thumbs` | a second deployment on the same queues; `thumbs` slowly eats the `images` backlog, so pausing it is visible |

A worker's **settings** are keyed by that stable key, so a change from the UI
survives a restart of the playground and reaches every replica carrying it.

**Worker configuration**, spread across the workers it makes sense on rather
than piled onto one (each is commented where it is set):

| Option | Where, and why |
|---|---|
| `concurrency` | 3 on `api.emails.transactional`, 2 on `api.checksums.hasher` (each one is a *process*), 1 on `api.notifications.scheduler` so job order stays legible |
| `lockDuration`, `heartbeatInterval` | `api.checksums.hasher`: 60 s / 15 s, because a block of hashing holds its thread |
| `stalledInterval`, `maxStalledCount` | `api.previews`: a terminated `Worker` leaves its lock to expire, so sweep at 15 s and allow two stalls |
| `pollInterval`, `maxBlock` | `api.previews.2` and `api.imports.wedged`: a child process costs more to start than a `Worker`, so wait longer between empty claims |
| `drainDelay` | `api.notifications.scheduler`: `drained` after a second of quiet, not in every gap |
| `reportInterval` | `api.notifications.scheduler`: 5 s, so the Workers page keeps up while you drive its buttons |
| `maintenance` | off on `api.previews.2`, where `api.previews` takes part in that queue's housekeeping anyway (the pass is leased, so one worker holds it per pass while the rest stand down), and on `api.dead-letters.archive`, which is its queue's **only** worker — so that queue has nobody doing the housekeeping and its Workers panel says so, which is what the setting is there to show. Since bun-jobs #121 `maintenance` decides the housekeeping pass alone (pruning expired results, healing repeat series, sweeping stale queue state): promoting delayed jobs and recovering stalled ones happen on every worker whatever it says. Before #121 this same line on `imports` stranded jobs — one `active` for 45 minutes with no logs, four frozen at attempt 1 of 2 |
| `autorun` | `api.imports.wedged` starts consuming as it is constructed, instead of waiting for `run()` |
| `metrics` | `{ workers: false }` on `api.dead-letters.archive` |
| `control` | the object form on `api.notifications.scheduler`: `{ enabled, subscribe, interval }` |
| `stopPersistence` / `stopPersistenceOverridable` | `"key"` on `api.notifications.scheduler`, so a Stop from the UI outlives a restart; `api.emails.transactional` keeps the default and only makes it overridable |
| `service` / `name` / `key` / `keyOrdinal` | `service` and `name` on most; `key` set outright on `api.dead-letters.archive`; `keyOrdinal` pinned on `api.previews.2` |
| `isolation` / `isolationOptions` | the three isolated queues above |
| `backoffStrategies` | `"decode-ramp"` on both `previews` workers, `"triage"` on `api.notifications.scheduler` |
| `deadLetterQueue` | `dead-letters`, on the `previews` workers and on `api.notifications.scheduler` |

**Queues** (`simulation.ts`):

| Queue | Worker | What you see |
|---|---|---|
| `emails` | 3 at a time, 0.5–3 s each | logs, progress 0→100, ~15% fail and retry (3 attempts) |
| `reports` | 1 at a time, 6–15 s each | an object progress (`{ step, done, of }`), a backlog |
| `webhooks` | 2 at a time, rate-limited 20/min | retries with exponential backoff; `umbrella` always fails, so dead jobs pile up |
| `images` | none in `api` — its only worker is `mailer.images.thumbs` (see above) | a backlog that drains slowly, one job at a time; pause that worker and it only grows |

Also on `emails`: two repeat series (`weekly-digest`, `daily-summary`: try
Disable/Enable), a delayed `reminder-tomorrow`, and a flow
(`newsletter-2026-09`) that waits (`waiting-children`) on two renders in
`images` until `mailer.images.thumbs` reaches them behind the thumbnail
backlog — pause that worker and it waits for good. A new job arrives
every `PLAYGROUND_INTERVAL_MS` (default 2000).

### Isolated workers (`isolated.ts`, `processors/`)

A worker given a processor **file** instead of a function can run every
attempt somewhere other than its own thread. Three queues do, and each one
exists to show a different reason to:

| Queue | Worker | Isolation | What you see |
|---|---|---|---|
| `checksums` | `api.checksums.hasher` | `spawn` | a CPU-bound processor (`processors/checksum.ts`) that blocks its thread outright. In-process it would hold the claim loop, the heartbeats and every other job on that worker; in a child process the worker carries on. Its `returnValue` records the **pid**, which is not the playground's. |
| `previews` | `api.previews` | `worker` | the *same* file (`processors/preview.ts`) in a fresh `Worker` per attempt — a separate JavaScript context, in this process. `returnValue.mainThread` is `false`. |
| `previews` | `api.previews.2` | `spawn` | and in a child process, side by side on one queue, so the difference is visible rather than described. |
| `imports` | `api.imports.wedged` | `spawn` | a processor that **ignores its abort signal** (`processors/wedge.ts`). The job's 4 s `timeout` fires, the executor asks the child to close, then `SIGTERM` after a second and `SIGKILL` half a second later. The job fails with a `JobTimeoutError` and is retried in a fresh child; the worker never stops claiming. |

**The child needs no driver of its own.** A log line, a lock renewal, a
progress update or a flow's children travel the executor's message channel and
are answered by the worker, which keeps the driver — so these queues behave
identically on the memory driver and on `PLAYGROUND_DRIVER=sqlite`. Everything
that would write the stored job directly (`updateData`, `remove`, `promote`, …)
is unavailable in the child and says so.

Also on `previews`: `preview-broken-header`, which calls `job.fail()` **from
inside the child**. It dies on its first attempt although it has four, because
`fail()` is unrecoverable — and a letter about it turns up in `dead-letters`,
filed by the workers' `deadLetterQueue`.

### Scheduling, every way (`scheduling.ts`)

`notifications` has one worker running one job at a time, so the order the
queue chose is legible, and one seeded job per scheduling option. Its data's
`about` field says which option each job is for:

| Option | The seed |
|---|---|
| `priority` | three jobs added worst-first (20, 10, 1); the two-factor code runs first |
| `delay` | a receipt, 45 s out |
| `runAt` | an absolute instant, given **with** a `delay` to show that `runAt` wins |
| `jobId` | added twice under `welcome-ada`; one job, and a log line on it saying the second add answered with the same one |
| `debounce` | three adds under one id, one job, running 20 s after the *last* of them with the newest payload |
| `throttle` | three adds inside a one-minute window, one job, running now |
| `attempts` + fixed `backoff` | `backoff: 4000`, three attempts |
| `attempts` + exponential | `{ type: "exponential", delay: 2000, max: 30000, jitter: 0.2 }` |
| `attempts` + a **custom strategy** | `{ type: "triage" }`, resolved by name on the worker's `backoffStrategies`: 1 s, 10 s, then `false` — it gives up with an attempt unused |
| `timeout` | 6 s of work against a 1.5 s limit, so every attempt is a `JobTimeoutError` |
| `removeOnComplete` (TTL) | three copies kept two minutes, then swept |
| `removeOnComplete` / `removeOnFail` (`true`) | two jobs that are never in the job list at all — one succeeds, one dies. All the first leaves is a tick on the queue's throughput; the second still files its letter in `dead-letters` before its own copy goes |
| `keepLogs` | writes 21 lines, keeps the last 5 |
| `keepStacktraces` | four attempts, two traces on the failure panel |
| `deadLetter` | the job's own dead-letter queue, which wins over the worker's |
| flows | `publish-release-2026-09` waits on a child in **another queue** (`previews`, where an isolated worker runs it) and on one that always fails with `ignoreFailure` — the parent completes anyway, with the failure beside the other child's result |

Retention as a **count** is on `imports` instead (`removeOnFail: { count: 4 }`),
because a count sweeps the whole queue's finished set rather than one job's own
copies — on a shared queue it would quietly delete the other demonstrations.

**Repeats**, all on `notifications` → Repeatables:

| Series | What it shows |
|---|---|
| `cron-five-minutely` | `cron` with `tz`: `*/5 * * * *`, Europe/London — a wall clock that survives a daylight-saving change, which a fixed interval cannot |
| `every-three-minutes` | `every` as milliseconds |
| `every-other-minute` | `every` as a **phrase**: `"every other minute"` reads as 120000. A phrase naming *dates* needs the optional `chrono-node`; an interval alone never loads it |
| `burst-window` | `startAt`, `endAt` and `limit` together: five occurrences inside a ten-minute window, opening 30 s in |
| `health-check` | `immediately`: runs as the series is created, then every ten minutes |
| `usage-rollup` | `catchUp`: replays occurrences missed while nothing was consuming, one per completion. Nothing is missed on a fresh start — run with `PLAYGROUND_DRIVER=sqlite`, stop for ten minutes, start again, and watch it work through the gap |

`dead-letters` collects what died: from `notifications` (the worker's
`deadLetterQueue`, and one job's own `deadLetter`) and from `previews`. Its
worker is the one with an explicit stable `key` (`api.dead-letters.archive`)
and `metrics: { workers: false }` — the first lever to reach for on a real
fleet, where per-worker series are the term that grows.

**Runners** (`runners.ts`, all running `handlers/work.ts`). `backup` and
`reindex` run in a child process; `sync-crm`, `archive` and `ping` run
in-process. Every run's log carries its `stdout`/`stderr` as well as its
`ctx.log()` lines either way: a spawned run's from its pipes, an in-process
run's because capture attributes each `console` call to the run that made it
(the output still reaches the playground's terminal too):

| Runner | Schedule | What you see |
|---|---|---|
| `backup` | every 30 s | spawned: runs in a child process |
| `sync-crm` | every minute | fails about half the time (`lastError`) |
| `archive` | Sundays 04:30, Europe/London | paused (Resume…) |
| `reindex` | none | spawned; runs only when triggered; Trigger… may pass `{ "ms": 20000 }` for a long run to Kill…, or `{ "failRate": 1 }` |
| `ping` | every 10 s, 5 s timeout | its 2–8 s of work times out about half the time, and one run in five that finishes in time throws; the Overview's Runners section counts the throws as Failed and the timeouts apart, under "Timed out / killed" |

## Things to try

- Open the Overview after a minute: Jobs, Queues, Runners and Workers all show real numbers over the range.
- On the Overview, pick "Last 10 minutes": the sections say they were answered in minute buckets, since per-second numbers are not kept that far back.
- Pause `emails` and watch `waiting` grow, then Resume.
- Open a running `reports` job: the progress bar and logs update live.
- Retry-all on `webhooks` dead jobs; Fail… a waiting `images` job.
- Add job on `images`, then open the Events console on `queue/images`.
- Trigger `reindex` with `{ "ms": 30000 }`, then Kill… it.
- Open Workers: pause `mailer.images.thumbs` and watch the `images` backlog stop falling, then resume it.
- Stop `api.emails.transactional`, watch `emails` slow to the mailer's pace, then start it again.
- Settings… on a worker: raise its concurrency and watch the queue drain faster; Reset to code values puts it back.
- Events console → "Every worker": worker state, config and control events as you drive the buttons.
- Open a `backup` run and read its log: `ctx.log()` lines, its stdout steps, and stderr when it fails.
- Open a `sync-crm` or `ping` run, which is in-process: its `console.warn` ("upstream slow on step 2…") is on `stderr` in its own log, and filtering the log to `stderr` shows just that line (and the failure, when it failed).
- In any run's log, the first `stdout` line prints `apiKey=pk_demo_…`; the stored line has that value redacted.
- Watch a running run's log on the runner screen: new lines appear as the runner announces them on the live socket, not on a timer.
- Open a completed `checksums` job and read its `returnValue`: the `pid` is not the playground's, because a child process hashed it.
- Open two completed `previews` jobs, one from each worker: `api.previews` reports `mainThread: false` (a `Worker`), `api.previews.2` a different `pid` (a child process) — one file, two isolation modes.
- Add job on `imports`, then watch it: a log line from the child, progress stuck at `blocked`, and four seconds later a `JobTimeoutError` — the child was killed, and the worker never paused.
- Open `preview-broken-header` on `previews`: dead on attempt 1 of 4, because the processor called `job.fail()` from inside the child.
- Queues → `notifications` → Delayed: the `delay`, `runAt` and `debounce` seeds all waiting, with the option each one demonstrates in its `about`.
- Queues → `notifications` → Repeatables: six series, and `burst-window` counting down from five.
- Queues → `dead-letters`: every job that died, with the queue it died in and why.
- Try any operation from API docs → HTTP, and watch the screens follow.
- `PLAYGROUND_DRIVER=sqlite` and restart: everything is still there.

Ctrl+C stops it cleanly (it waits up to 2 s for a running report).
