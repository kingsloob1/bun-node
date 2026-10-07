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
PLAYGROUND_CGROUP=auto bun playground/index.ts       # summoned units in a cgroup (Linux, cgroup v2)
PLAYGROUND_SECRET_DELAY_MS=3000 bun playground/index.ts  # Vault Compute's slow secret store answers in 3 s (default 12 s)
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
| `/playground/compute` | the summoned units: every child process the library's `localCompute()` started for the playground, with its provider status, and buttons that inject a fault into one queue's next unit (see "Summoning" below) |
| `/` | redirects to `/jobs` |

**Services and workers.** Two `BunJobs` contexts share one driver instance,
so the Workers page has two services to group (`index.ts`, `mailer.ts`):

| Service | Worker (stable key) | What you see |
|---|---|---|
| `api` | `api.emails.transactional`, `api.reports.monthly`, `api.webhooks.delivery`, `api.checksums.hasher`, `api.previews`, `api.previews.2`, `api.imports.wedged`, `api.notifications.scheduler`, `api.dead-letters.archive` | the simulation's own workers; the emails one sets `stopPersistenceOverridable`, so its Stop dialog offers "until somebody starts it again" |
| `mailer` | `mailer.emails.bulk`, `mailer.images.thumbs` | a second deployment on the same queues; `thumbs` slowly eats the `images` backlog, so pausing it is visible |
| `compute` | `compute.renders.render`, `compute.transcodes.transcode`, `compute.thumbnails.thumbnail`, `compute.marathon.leg`, `compute.ledger.post`, `compute.secure-exports.export`, `compute.obinna-queue.obinna-pinger-local-compute` | **summoned**: child processes the library's `localCompute()` starts when one of those queues has work, each gone again once its queue is idle (or, for `ledger`, once it is released); its Summon card names the attempt |

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
| `renders`, `transcodes`, `thumbnails`, `marathon`, `brittle`, `obinna-queue`, `ledger`, `secure-exports` | none always on — summoned on demand (`summoning.ts`) | see "Summoning" below |

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

### Summoning (`summoning.ts`, `compute/`)

Eight queues have **no** always-on worker. When one has work, its summon
controller asks its summoner for one, and the library's **`localCompute()`**
(from `@kingsleyweb/bun-jobs/provider`) starts a real worker process on this
machine: a child of the playground, in a process group of its own. The worker
drains the queue under `runSummoned` and exits once there is nothing left for
it.

The context's `summon` option is an array that **mixes a group with a
record**:

```ts
export const summon = [
  // A group: one policy for five queues, with per-queue overrides.
  {
    queues: ["renders", "transcodes", "thumbnails", "marathon", "brittle"],
    summoner: media,
    maxWorkers: 2,
    overrides: { transcodes: { maxWorkers: 1, budget: { perHour: 30 } } },
  },
  // A record of policies by queue, beside it.
  {
    "obinna-queue": { summoner: obinna },
    "ledger": { summoner: replicas, scaleDown: { after: 20_000 } },
    "secure-exports": { summoner: vault },
  },
];
```

(abridged: `summoning.ts` has the whole option)

A group is shorthand: each of its queues still gets a controller of its own,
with its own Summon panel, marker, budget, backoff and circuit.

| File | What it is |
|---|---|
| `summoning.ts` | the four `localCompute()` instances, the vault provider, the scale-style summoner, the `summon` option, and the bursts of jobs |
| `compute/worker.ts` | the entry the `media` and `ledger` instances run: **one file serving every queue of the group**, choosing its processor by `summonedFromArgs().queue` |
| `compute/obinna-queue-worker.ts` | the entry the `obinna` instance runs: `obinna-queue`, whose jobs "ping obinna" |
| `compute/units.ts` | the playground's wrapper around each instance's summon facet (a spread of a configured provider keeps its brand and its Providers id): it records the units, injects a fault into one queue's next start, and on shutdown stops every unit and awaits its exit. It also serves `/playground/compute` |
| `compute/provider.ts` | "Vault Compute", a third-party provider made with `defineComputeProvider` whose units are started by the `media` `localCompute()` underneath. It shows what `localCompute()` cannot: a declared secret, an asynchronous config (and so Pending and Failed readiness), and the `throttled`/`quota`/`auth`/`transient` answers of a remote platform |
| `compute/cgroup.ts` | the run's cgroup when `PLAYGROUND_CGROUP` asks for one |

**The `localCompute()` instances** (Providers screen, `@kingsleyweb/bun-jobs:local@0.1.0~1` to `~4`):

| Instance | Options | What to see |
|---|---|---|
| `~1` `media` | `entry: compute/worker.ts`, `cwd: playground/`, `args: ["--tier=standard"]`, `maxUnits: 5`, `bootBudget: 15_000`, `shutdown: { signal: "SIGTERM", graceMs: 3_000 }`, `output: { file: ".data/units-<pid>.log" }`, `env: { PLAYGROUND_POOL: "media" }`, `passEnv: ["PLAYGROUND_REGION"]`, and `cgroup` with `PLAYGROUND_CGROUP` | five units at once across six queues, so a big burst meets `unavailable` (`max-units: 5 of 5 running`); every unit's stdout and stderr in `playground/.data/units-<pid>.log` (`tail -f` it); a job's `returnValue.env` has `region` (passed by name) and `pool` (set), and `hostSecret: "kept out"` — the playground sets `PLAYGROUND_HOST_SECRET` in its own environment, and the allowlist never hands it on; `tier: "standard"` from `args` |
| `~2` `obinna` | `entry: compute/obinna-queue-worker.ts`, `maxUnits: 1`, `maxLifetime: 300_000` (the platform's cap: a policy `maxLifetime` above it is a `ConfigError`), `shutdown: { signal: "SIGINT", graceMs: 5_000 }`, `env: "inherit"`, `output: { logger }` | each unit's `obinna unit up…` line in the playground's terminal, logged by the `obinna-units` logger with the unit's handle; a job's `returnValue.hostEnv` is `"inherited"`: the whole host environment, secret included |
| `~3` `ledger` | the group's entry again, `args: ["--tier=replica"]`, `maxUnits: 2`, `output: "ignore"` | driven by a scale-style summoner, below |
| `~4` | `entry: "compute/not-built-yet.ts"` | it configures (the schema reads no file), and **Test connection** fails its `entry` check. Nothing summons with it: a summon would be a `misconfigured` `ProviderError`, which opens a circuit at once |

**Use cases** — what to watch, and how to make it happen:

| Use case | Where | What to watch in the UI | How to trigger it |
|---|---|---|---|
| A **group** with **overrides**, merged one level deep | `renders`, `transcodes`, `thumbnails`, `marathon`, `brittle` | each queue's Summon panel of its own, all naming the one summoner (Provider: Local processes, `@kingsleyweb/bun-jobs:local 0.1.0`), each with its own failures, backoff, circuit and budget. On screen, the budget line shows the merge: `transcodes` reads "… of 30 this hour, … of 2,000 today" — its override's `perHour` beside the group's `perDay` — where the others read "of 240 this hour". The rest of each policy (triggers, `env`, circuit thresholds, `maxWorkers`) is not on screen yet: read it in `summoning.ts`, and see it act in the rows below | always on: a burst every minute (`PLAYGROUND_SUMMON_EVERY_MS`) |
| **Groups and records mixed** in `summon: [...]` | `obinna-queue`, `ledger`, `secure-exports` | Summon panels like the group's, each naming its own summoner: Local processes (`obinna-queue`), `local-replicas` (`ledger`), Vault Compute (`secure-exports`) | always on |
| **One entry file serving a group's queues** | `compute/worker.ts` | Workers → `compute`: `compute.renders.render`, `compute.thumbnails.thumbnail`, `compute.marathon.leg`… one per queue, all the same file | always on |
| `jobsPerWorker`, `maxWorkers` | `renders` (8 per worker, at most 2), `transcodes` (1), `thumbnails` (4 per worker) | a burst of more than 8 renders gets a second worker | always on |
| `maxPending` | the group: 1 | while an attempt is pending (on the panel, until its worker registers), no second attempt is made for that queue; a burst that needs two workers asks for both in that one attempt (`count: 2`) | a big `renders` burst; or "Summon now" while one is pending, which answers `skipped: pending` |
| `cooldown`, `backoff` | the group: 5 s, then 5–30 s; `poll` every 10 s | after an `unavailable` or a lost attempt, "Backoff until" on the panel, further out per failure in a row | any fault below |
| `maxUnits` → **`unavailable`** | `media`, shared by six queues | a panel's last outcome `unavailable`, detail `max-units: 5 of 5 running`, counted and backed off from (so a queue starved three times in a row opens its circuit too) | a big burst landing while `marathon` holds a unit |
| **`maxLifetime` ending units** | `marathon`: 45 s (its override) | Workers: `compute.marathon.leg` replaced every ~40 s, its last job finishing first — `runSummoned` stops claiming 7 s before the deadline and exits 0 (`deadline`); its unit on `/playground/compute` `exited 0` | always on: a leg every 5 s, so it never goes idle |
| `maxLifetime` **enforced by `localCompute()`** | `marathon` | the unit ignores its stop signal; at 45 s `localCompute()` sends SIGTERM, then SIGKILL 3 s later: `/playground/compute` shows `failed 137`, detail `max-lifetime`. The Summon panel counts nothing: the attempt registered and ran past its watch, so its end is not a lost attempt, and the next check summons a fresh unit | `curl -X POST 'localhost:4000/playground/compute/faults?kind=ignore-stop&queue=marathon'` (also in the fault cycle) |
| `bootBudget` → **`lost`** | `media`: 15 s | an attempt pending for 15 s, then `lost`; 10 s later the slow worker registers anyway and drains the queue | `?kind=slow-boot&queue=renders` |
| A crash before registering | every queue | pending, then `lost` after the boot budget, its detail the unit's last stderr line: `renders worker: cannot load the GPU driver (libvk.so.1)`. The panel's "Boot budget" is the provider's (15 s on `media`); `brittle`'s policy shortens its own to 8 s (`summoning.ts`) | `?kind=crash&queue=renders` |
| A unit dying mid-queue | any queue | registered, then `lost`, detail `SIGKILL` (the unit's own status from `localCompute()`); the queue is finished by the next worker | `?kind=die&queue=transcodes` |
| **`circuit`** opened by a fault queue | `brittle` (every unit crashes) | failures counting up, then "Circuit open until" a minute away (two lost attempts open it: `circuit.failures: 2` in `summoning.ts`), one trial when it passes, open again. Reset closes it now | always on: two seeded jobs no unit ever runs |
| `triggers`: `onAdd` vs `poll` | `thumbnails` (`onAdd: false, events: false`) vs `renders`, in `summoning.ts` | not as settings (not on screen yet), but in when each attempt starts: on `/playground/compute`, a burst's `renders` units start as it lands (the add's check), while `thumbnails`, added 5 s into each burst, start only at the controller's next poll, up to 10 s later | always on |
| **`scaleDown`** (scale-style summoner) | `ledger`: `defineSummoner({ style: "scale" })` over `~3` (on Providers as `custom:local-replicas@0.0.0~1`) | units run `until-stopped`: they stay on the Workers page after `ledger` drains; 20 s later the controller releases them — a `summon` event with outcome `released` on the Events console (`queue/ledger`) — and they exit 0 (`/playground/compute`: `exited 0`) | every other burst adds 4–8 ledger jobs |
| `shutdown` signal and grace | `media` SIGTERM / 3 s, `obinna` SIGINT / 5 s (`summoning.ts`; not on screen yet) | `runSummoned` handles either signal and exits 0 (`exited 0` on `/playground/compute`); with `ignore-stop`, the grace running out: `failed 137` | Ctrl+C, or `ignore-stop` |
| `output` | `media` → file, `obinna` → logger, `ledger` → ignore | `playground/.data/units-<pid>.log`; the playground's terminal; nothing | always on |
| `env` vs `passEnv` | `media` (allowlist + `passEnv`) vs `obinna` (`"inherit"`) | a completed job's `returnValue`: `env.hostSecret: "kept out"` vs `hostEnv: "inherited"` | open any completed job |
| `cgroup` | `media`, with `PLAYGROUND_CGROUP` | Providers → `…~1`: a `cgroup` fact, and Test connection's `cgroup` check passes; each unit in a cgroup of its own under `…/app.slice/bun-node-playground-<pid>` (`memory.max` 1 GiB, `pids.max` 512). Where that cannot be made (no systemd user slice, no cgroup v2, no permission), one warning at startup and the units run without a cgroup | `PLAYGROUND_CGROUP=auto` (Linux, cgroup v2, a user-delegated subtree; `PLAYGROUND_CGROUP_SLICE` names another parent), or a path to an existing cgroup |
| `.toQueue()` (#278) | `obinna-queue` | each burst's `ping-obinna` job: added through the registry's builder, `jobs.schedule("ping-obinna", data).toQueue("obinna-queue")`. Its definition's `attempts: 5` does **not** follow it: the job has the queue's default | always on |
| `jobs.queue(name).schedule()` (#278) | `obinna-queue` | a delayed `ping-obinna` 20 s after each burst, and the `obinna-heartbeat` series (Repeatables: every 2 minutes), each summoning a unit | always on |
| A third-party provider: readiness, a declared secret, platform answers | `secure-exports`, Vault Compute `~1` | Providers: `…vault-compute@0.1.0~1` Pending until the slow secret store answers (`PLAYGROUND_SECRET_DELAY_MS`, default 12 s), then Ready; `~2` Ready but Test connection `auth` (`InvalidToken`); `~3` Pending, then Failed. Test connection on `~1` names the token as `[REDACTED]` and lists the `media` instance's own checks. The queue's Summon panel shows the same readiness | `?kind=throttled&queue=secure-exports` (also `quota`, `auth`, `transient`; only on this queue) |

**Faults, per queue.** `/playground/compute` queues a fault for **one
queue's next start**, spent only by a start that happens (one answered
`unavailable` keeps it queued), and reaching every unit that start asks for
(a big `renders` burst's two):

```bash
curl -X POST 'http://localhost:4000/playground/compute/faults?kind=crash&queue=renders'
curl -X POST 'http://localhost:4000/playground/compute/faults/clear'
curl http://localhost:4000/playground/compute/state     # queued faults and every unit's status
```

| Fault | Queues | What it does | The Summon panel shows |
|---|---|---|---|
| `crash` | every queue | the unit exits 1 before its worker reports | pending, then **`lost`** after the boot budget, detail the unit's last stderr line |
| `die` | every queue | the unit `SIGKILL`s itself after its first job | registered, then **`lost`**, detail `SIGKILL`; `/playground/compute` shows `failed 137` |
| `slow-boot` | every queue but `obinna-queue` | the unit sleeps 25 s before building its worker | **`lost`** at the boot budget (15 s on `media`, 20 s on `ledger`), then a late worker drains the queue |
| `ignore-stop` | every queue but `obinna-queue` (use `marathon`, which never goes idle; elsewhere the unit still exits on idle) | the unit ignores its signals and its deadline | nothing counted (it registered long before); at `maxLifetime`, `localCompute()` stops it, then kills it: `failed 137`, `max-lifetime` on `/playground/compute` |
| `throttled` | `secure-exports` | Vault Compute throws `throttled`, retry after 8 s | `unavailable`, **not counted**; backoff 8 s |
| `quota` | `secure-exports` | `quota`, retry after 20 s | counted; backoff 20 s |
| `auth` | `secure-exports` | `auth` (`TokenRevoked`) | the **circuit opens at once**, for a minute. Reset closes it |
| `transient` | `secure-exports` | `transient` | `failed`, counted, backoff |

Each queue takes only the faults its units act on, and the page offers only
those: `obinna-queue-worker.ts` knows `crash` and `die` alone, and the four
provider faults are what a remote platform answers and `localCompute()` never
does, so they go only to the queue the vault provider summons for. Any other
kind, an unknown queue, or a fourth fault queued for one queue
(`MAX_QUEUED_PER_QUEUE` is 3) is a 400 naming what it takes. On `brittle`,
a queued unit fault replaces its override's `crash` for that one start. Before some bursts the playground queues one
itself, in turn: `renders` crash, `secure-exports` throttled, `transcodes`
die, `secure-exports` auth, `renders` slow-boot, `marathon` ignore-stop, with
a clean burst between each. `PLAYGROUND_SUMMON_FAULTS=off` turns that off.

**Stopping.** Ctrl+C (or `SIGTERM`) stops the bursts and then every unit
still running: `localCompute()` sends each its stop signal as the signal
arrives and starts nothing more, and the playground's shutdown calls each
instance's `cancel()` for every live unit, which resolves only once the
process has exited (`SIGKILL` after the grace), before the backend closes.
`SIGHUP` (a closed terminal) does the same. It prints `waited for N summoned
units to exit`, removes `.data/units-<pid>.log` and, with
`PLAYGROUND_CGROUP=auto`, its cgroup; if any step of the shutdown fails, the
files and the cgroup are still removed. No unit outlives the playground.

Killed with `SIGKILL` itself, it cannot do that: its units then exit on their
own once idle, or at their lifetime (a `ledger` replica only at its
lifetime). The next start removes the log it left and, under
`PLAYGROUND_CGROUP=auto`, kills whatever still runs in the cgroup it left
(`cgroup.kill`) before removing it; without a cgroup, those units run on
until they exit by themselves.

**`bun run dev` (`--watch`).** A reload re-executes the playground in place,
with the same pid, and runs no shutdown at all, and the units are detached:
measured, an earlier incarnation's units kept running after a reload (four
of them, here). So each start looks for children of its own pid running a
unit entry and stops them (`SIGTERM`, `SIGKILL` 5 s later), printing
`stopped N summoned units an earlier run of this process left`, and under
`PLAYGROUND_CGROUP=auto` also kills and removes the cgroup of its own pid
(`compute/leftovers.ts`, `compute/cgroup.ts`). Between the reload and that
sweep, the old units may still take a job or two.

**Stopping counts against a queue.** Once the shutdown begins, a check that
still runs is answered `unavailable` ("the playground is stopping") by the
playground's wrapper. That counts like any `unavailable`: on a backend that
keeps its state (`PLAYGROUND_DRIVER=sqlite`, a server), the next start's
Summon panel may show one failure and a last outcome of `unavailable` with
that detail, until a registration or a Reset clears it.

**Not on develop yet** — hooks for what lands next, to be filled in then:

- TODO(#289): `GET /summon`, every queue's summon status in one call, for a
  table of all eight queues on `/playground/compute`; and `onSummonFailed`,
  `budget: false` and `reset({ budget })` on the policies above (e.g. a
  `brittle` override with `budget: false`, and a reset of `transcodes`'
  budget from the control page).
- TODO(policy visible): the user has decided each queue's policy will be
  shown — triggers, `env` names, circuit thresholds, `maxWorkers`,
  `jobsPerWorker`, `maxPending`, `cooldown`, `bootBudget`, the provider's
  shutdown signal and grace — through an API addition and the Summon panel.
  Then the use-case table above says where each one is on screen, instead of
  pointing at `summoning.ts`.
- TODO(Part A): group budgets and circuits, and status from storage: one
  budget and circuit for the whole media group, where today each of its five
  queues has its own.
- TODO(Part B, #294): multi-queue units — one `localCompute()` unit serving
  several of the group's queues at once, instead of one unit per queue
  choosing its processor by `summonedFromArgs().queue`.

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
- Open Providers in the first 12 s (`PLAYGROUND_SECRET_DELAY_MS`): Vault Compute `…~1` and `…~3` say Pending. Then press Test connection on each of the three, and on the four `Local processes` cards.
- Open `renders` when a burst lands: a pending attempt, then registered, then a worker under `compute` on the Workers page; a minute later, no worker at all.
- Queue `auth` for `secure-exports` on `/playground/compute`, then press "Summon now" on that queue: the circuit opens at once. Reset closes it.
- Queue `crash` for `renders`, add a job to `renders`, and watch the attempt go from pending to lost 15 s later, with the unit's own stderr line as its detail.
- Watch `brittle`'s panel for two minutes: two lost attempts, the circuit open, a trial a minute later, open again.
- Open Workers after a burst that added `ledger` jobs: its `compute.ledger.post` workers (two when the burst brought 5 or more jobs, at `jobsPerWorker: 4`) stay after `ledger` drains, then 20 s later are released and go (Events console, `queue/ledger`: a `summon` event, `released`).
- Open a completed `renders` job and a completed `obinna-queue` job: `env.hostSecret: "kept out"` beside `hostEnv: "inherited"`.
- `tail -f playground/.data/units-*.log`: every media unit's output, as `output: { file }` appends it.
- `PLAYGROUND_DRIVER=sqlite` and restart: everything is still there.

Ctrl+C stops it cleanly (it waits up to 2 s for a running report).
