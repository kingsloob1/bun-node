# bun-node playground

A place to try things by hand and see how they look: `bun-jobs`, its
management API (`createJobsApi`) and the `bun-jobs-ui` app on one
`BunHttpAdapter`, with a small simulation that keeps every screen moving.

```bash
bun playground/index.ts                              # then open http://localhost:4000/jobs
cd playground && bun run dev                         # the same, restarting on file changes
PORT=3000 bun playground/index.ts                    # another port
PLAYGROUND_DRIVER=sqlite bun playground/index.ts     # keeps its state in playground/.data/
PLAYGROUND_DRIVER=memory bun playground/index.ts     # nothing on disk, and no summoning
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

**The default backend is `temp`**: SQLite in a file of the process's own,
`playground/.data/temp-<pid>.db`, deleted when it stops (and, if it was
killed before it could, by the next start). State is gone on restart, as it
was with the old `memory` default, but another process can reach it — which
the summoned workers below need, since the summon controller refuses the
memory driver. `PLAYGROUND_DRIVER=memory` still works; it lists the compute
providers but summons nothing.

It listens on `127.0.0.1` only. Its API allows **every** action to anyone who
can reach it, so never expose it.

## What is running

| Where | What |
|---|---|
| `/jobs` | the UI (Overview, Queues, Workers, Providers, Runners, Events, API docs) |
| `/jobs-api` | the management API, with its live-events socket on the same port |
| `/local-compute` | "Local Compute", the made-up platform the compute provider summons workers on: its API (`/local-compute/v1/…`) and a control page for its units and faults (see "Summoning and compute providers" below) |
| `/` | redirects to `/jobs` |

**Services and workers.** Two `BunJobs` contexts share one driver instance,
so the Workers page has two services to group (`index.ts`, `mailer.ts`):

| Service | Worker (stable key) | What you see |
|---|---|---|
| `api` | `api.emails.transactional`, `api.reports.monthly`, `api.webhooks.delivery`, `api.checksums.hasher`, `api.previews`, `api.previews.2`, `api.imports.wedged`, `api.notifications.scheduler`, `api.dead-letters.archive` | the simulation's own workers; the emails one sets `stopPersistenceOverridable`, so its Stop dialog offers "until somebody starts it again" |
| `mailer` | `mailer.emails.bulk`, `mailer.images.thumbs` | a second deployment on the same queues; `thumbs` slowly eats the `images` backlog, so pausing it is visible |
| `compute` | `compute.renders.render`, `compute.transcodes.transcode` | **summoned**: separate processes a compute provider starts when `renders` or `transcodes` has work, each gone again 10 s after its queue is empty; its Summon card names the attempt |

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
| `target` | `"child-process"` on `api.checksums.hasher`, `api.previews.2` and `api.imports.wedged`, each with its close and kill timeouts; `"worker-thread"` on `api.previews`, with `smol` and a thread name. See below |
| `backoffStrategies` | `"decode-ramp"` on both `previews` workers, `"triage"` on `api.notifications.scheduler` |
| `deadLetterQueue` | `dead-letters`, on the `previews` workers and on `api.notifications.scheduler` |

**Queues** (`simulation.ts`):

| Queue | Worker | What you see |
|---|---|---|
| `emails` | 3 at a time, 0.5–3 s each | logs, progress 0→100, ~15% fail and retry (3 attempts) |
| `reports` | 1 at a time, 6–15 s each | an object progress (`{ step, done, of }`), a backlog |
| `webhooks` | 2 at a time, rate-limited 20/min | retries with exponential backoff; `umbrella` always fails, so dead jobs pile up |
| `images` | none in `api` — its only worker is `mailer.images.thumbs` (see above) | a backlog that drains slowly, one job at a time; pause that worker and it only grows |
| `renders` | none always on — summoned on demand (`summoning.ts`) | a burst of 4–16 jobs every minute, a worker (or two) summoned for it, and back to no worker at all |
| `transcodes` | none always on — summoned under the same policy as `renders` | 1–3 jobs with each burst, one worker summoned for them by the queue's own controller |

Also on `emails`: two repeat series (`weekly-digest`, `daily-summary`: try
Disable/Enable), a delayed `reminder-tomorrow`, and a flow
(`newsletter-2026-09`) that waits (`waiting-children`) on two renders in
`images` until `mailer.images.thumbs` reaches them behind the thumbnail
backlog — pause that worker and it waits for good. A new job arrives
every `PLAYGROUND_INTERVAL_MS` (default 2000).

### Workers on other targets (`targets.ts`, `processors/`)

A worker given a processor **file** instead of a function can run every
attempt somewhere other than its own thread: its `target`. Three queues do,
and each one exists to show a different reason to. The Workers page badges
every worker with where it runs, and a worker's page has a Target card naming
the target and the processor file.

| Queue | Worker | Target | What you see |
|---|---|---|---|
| `checksums` | `api.checksums.hasher` | `child-process` | a CPU-bound processor (`processors/checksum.ts`) that blocks its thread outright. In-process it would hold the claim loop, the heartbeats and every other job on that worker; in a child process the worker carries on. Its `returnValue` records the **pid**, which is not the playground's. |
| `previews` | `api.previews` | `worker-thread` | the *same* file (`processors/preview.ts`) in a fresh `Worker` per attempt — a separate JavaScript context, in this process. `returnValue.mainThread` is `false`. |
| `previews` | `api.previews.2` | `child-process` | and in a child process, side by side on one queue, so the difference is visible rather than described. |
| `imports` | `api.imports.wedged` | `child-process` | a processor that **ignores its abort signal** (`processors/wedge.ts`). The job's 4 s `timeout` fires, the executor asks the child to close, then `SIGTERM` after a second and `SIGKILL` half a second later. The job fails with a `JobTimeoutError` and is retried in a fresh child; the worker never stops claiming. |

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
| flows | `publish-release-2026-09` waits on a child in **another queue** (`previews`, where an off-thread worker runs it) and on one that always fails with `ignoreFailure` — the parent completes anyway, with the failure beside the other child's result |

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

### Summoning and compute providers (`summoning.ts`, `compute/`)

`renders` and `transcodes` have **no** always-on worker. When one has work,
its summon controller asks a **compute provider** for one, and the
provider's platform starts a real worker process on this machine; that
worker drains the queue and exits once there is nothing left for it.

Both queues share one policy, written once as a **summon group** — the
context's `summon` option is `[{ queues: ["renders", "transcodes"], … }]`,
with `overrides` capping `transcodes` at one worker. A group is shorthand:
each queue still gets its own controller, with its own Summon panel, budget,
backoff and circuit. Every unit runs the same `compute/worker.ts`, which
picks its processor by the queue its arguments name.

| File | What it is |
|---|---|
| `compute/provider.ts` | the provider, made with `defineComputeProvider` from `@kingsleyweb/bun-jobs/provider`: identity, a config schema with a JSON Schema for the config form, `apiToken` declared a secret, `describe()` facts, a `validate()` preflight, and a summon facet with `status()` and `cancel()` |
| `compute/platform.ts` | "Local Compute", the made-up platform it talks to over HTTP (through `ctx.fetch`), served on the playground's own port under `/local-compute/v1`. A unit is `bun compute/worker.ts` with the summon's `--bun-jobs-summon-*=` arguments, and the policy's static `env` (how to reach the backend) |
| `compute/worker.ts` | what a unit runs, for either queue: a worker under `runSummoned`, which exits 10 s after the queue is empty and writes the exit mark that tells the controller the attempt ended cleanly |

**Where to look:**

- **Providers** (`/jobs/providers`): three instances of the one provider,
  one per state a card can show.

  | Card | Config | Readiness | Test connection |
  |---|---|---|---|
  | `…~1`, region `local-1` | token read from the playground's secret store, which takes 12 s to answer (`PLAYGROUND_SECRET_DELAY_MS`) | **Pending** for the first 12 s, then **Ready** | ok, with a `warn` check (units are not isolated), and the `credentials` check's detail naming the token — shown `[REDACTED]`, because `apiToken` is a declared secret |
  | `…~2`, region `local-2` | a token the platform does not know | Ready | not ok: `auth`, `InvalidToken` |
  | `…~3`, pool `gpu` | names a secret the store does not hold | Pending for 12 s, then **Failed** | not ok: `misconfigured`, `invalid config: apiTokenSecret` (it validates again first, so it takes 12 s) |

  "Config schema" shows the served JSON Schema: the token's `default`,
  `examples` and `x-ui-widget` in `compute/provider.ts` are gone from it.
- **`renders` → Summon panel** (`/jobs/queues/renders`): the summoner
  (`…~1`), its readiness — **pending** for the first 12 s, so the first
  burst waits for it — its capabilities and facts, the attempts in flight,
  failures, backoff, the circuit, the budget, and the last outcome. "Summon
  now" and "Reset" work. `transcodes` has a panel of its own
  (`/jobs/queues/transcodes`), from the same group: the same summoner, its
  own attempts and budget.
- **Workers** (`/jobs/workers`): `compute.renders.render` appears under
  `compute` while a summoned worker runs, with its summon provenance (the
  attempt's id, `kind: local`, its mode and deadline), and is gone once it
  exits.
- **`/local-compute`**: the platform's own page — every unit, its pid, state,
  exit code and detail, and buttons that queue a fault.

**One cycle.** Every minute (`PLAYGROUND_SUMMON_EVERY_MS`) a burst of 4–16
render jobs arrives. The add triggers a check, the controller summons (two
workers when the burst is more than 8 jobs), the attempt shows as pending
until the worker's first report **registers** it, the queue drains at two
jobs per worker, and 10 s after the last job the worker exits (`idle`). Then
nothing runs until the next burst.

**Faults.** Before some bursts the platform is told to fail the next start,
so the Summon panel shows how each answer is counted. The cycle, one burst a
minute: normal, **throttled**, normal, **auth**, normal, **crash**, normal,
**die**, and again. `PLAYGROUND_SUMMON_FAULTS=off` turns it off. Any fault
can also be queued by hand, spent by the next start: press it on
`/local-compute`, or

```bash
curl -X POST 'http://localhost:4000/local-compute/faults?kind=auth'
curl -X POST 'http://localhost:4000/local-compute/faults/clear'
```

then add a job to `renders` (or press "Summon now") to spend it.

| Fault | The platform answers | The Summon panel shows |
|---|---|---|
| `throttled` | 429, `Retry-After: 8` | last `unavailable`, detail `RateLimited`; failures **unchanged**; backoff 8 s, then a normal summon |
| `quota` | 402 `QuotaExceeded`, `Retry-After: 20` | `unavailable`, but **counted**; backoff 20 s |
| `auth` | 401 `TokenRevoked` | last `failed`; failures jump to 3 and the **circuit opens at once**, for a minute. Reset closes it now |
| `misconfigured` | 404 `PoolNotFound` | as `auth` |
| `transient` | 503 | `failed`, counted, backoff 5 s |
| `crash` | a unit that exits 1 before its worker reports | a pending attempt that never registers; after the 20 s boot budget, **`lost`**, explained by the unit's own detail from `status()`: `ExitCode1: render worker: cannot load the GPU driver…` |
| `die` | a unit `SIGKILL`ed after its first job | registered, then **`lost`**, detail `died`, once its grace has passed; the job it held is recovered as stalled and finished by the next worker |

The policy is tighter than the defaults so a session sees all of it: a poll
every 5 s, a 5 s cooldown, backoff from 5 s to 30 s, a circuit of 3 failures
that half-opens after a minute, and at most 2 workers.

**Stopping.** Ctrl+C (or `SIGTERM`) stops the bursts, sends every unit still
running `SIGTERM` — `runSummoned` closes its worker and exits 0 — and
`SIGKILL`s any that has not exited within 3 s, before the backend closes.
Nothing outlives the playground. Killed with `SIGKILL` itself, it cannot do
that: its units then exit on their own once idle.

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
- Open two completed `previews` jobs, one from each worker: `api.previews` reports `mainThread: false` (a `Worker`), `api.previews.2` a different `pid` (a child process) — one file, two targets. Each result's `mode` is the mode its attempt's process reports in `BUN_JOBS_MODE`.
- Workers page: the State cell of each worker says where it runs. "Child process" on the three child-process workers, "Worker thread" on `api.previews`, "In process" on every function worker. Open `api.previews.2` for its Target card and the processor file it runs.
- Add job on `imports`, then watch it: a log line from the child, progress stuck at `blocked`, and four seconds later a `JobTimeoutError` — the child was killed, and the worker never paused.
- Open `preview-broken-header` on `previews`: dead on attempt 1 of 4, because the processor called `job.fail()` from inside the child.
- Queues → `notifications` → Delayed: the `delay`, `runAt` and `debounce` seeds all waiting, with the option each one demonstrates in its `about`.
- Queues → `notifications` → Repeatables: six series, and `burst-window` counting down from five.
- Queues → `dead-letters`: every job that died, with the queue it died in and why.
- Try any operation from API docs → HTTP, and watch the screens follow.
- Open Providers in the first 12 s: `…~1` and `…~3` say Pending. Then press Test connection on each of the three.
- Open `renders` when a burst lands: a pending attempt, then registered, then a worker under `compute` on the Workers page; a minute later, no worker at all.
- Queue `auth` on `/local-compute`, then press "Summon now" on `renders`: the circuit opens at once. Reset closes it.
- Queue `crash`, add a job to `renders`, and watch the attempt go from pending to lost 20 s later, with the unit's own reason as its detail.
- `PLAYGROUND_DRIVER=sqlite` and restart: everything is still there.

Ctrl+C stops it cleanly (it waits up to 2 s for a running report).
