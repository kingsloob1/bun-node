# Summon-compute: starting a worker when a queue needs one

Implementation plan for **summon-compute** in `@kingsleyweb/bun-jobs`. When a
queue has work and no live worker, something starts compute (an ECS task, a
Fly Machine, a Cloud Run job, a process on a host reached over SSH). That
compute runs an ordinary `BunQueueWorker` against the normal driver, drains the
queue and exits.

This is Phase 1.5 of [`worker-runtimes.md`](worker-runtimes.md#11-phased-delivery).
It comes after the control-plane rename (Phase 0,
[`control-plane-rename.md`](control-plane-rename.md)) and the local `target`
option (Phase 1). It comes before real remote execution (Phase 2).

Written 2026-09-25 against `develop` at `d54d1fe`. **No code was changed.**

**Updated 2026-09-25: summoners are now provider plugins.** Every summoner,
first-party or third-party, is a *compute provider* with a `summon` facet,
written against one public, versioned plugin API. That design lives in
[`compute-provider-plugins.md`](compute-provider-plugins.md), which also covers
the `execute` facet of Phases 2–4. §14 below summarises what it changes here.
Sections 4.1, 4.10, 7, 8, 9.3, 11.1 and 13 have been updated to match.

### Contents

1. [Executive summary](#1-executive-summary)
2. [Three summon models](#2-three-summon-models)
3. [Where the summoner runs](#3-where-the-summoner-runs)
4. [Core design](#4-core-design)
5. [The summoned worker's side](#5-the-summoned-workers-side)
6. [The depth endpoint](#6-the-depth-endpoint)
7. [First-party summoners](#7-first-party-summoners)
8. [Credentials without SDKs, and packaging](#8-credentials-without-sdks-and-packaging)
9. [Observability and UI](#9-observability-and-ui)
10. [Cost](#10-cost)
11. [Testing](#11-testing)
12. [Risks and open questions](#12-risks-and-open-questions)
13. [Phased delivery](#13-phased-delivery)
14. [Provider plugins](#14-provider-plugins)

### How to read the markings

This plan rests on three evidence files, indexed in
[`evidence/summon-compute/README.md`](evidence/summon-compute/README.md):
`aws.md`, `google-azure.md` and `paas-ssh.md`. Their tags are copied here
unchanged, with the file they came from, for example **[V, aws §4.1]**. No tag
has been promoted: an [I] or a [U] in the evidence is still an [I] or a [U]
here.

| Tag | Meaning in this plan |
|---|---|
| **[S]** | I read it from this repository's source today (2026-09-25). The file and line are given. |
| **[V, file §n]** / **[V~, …]** / **[V-plan, …]** / **[P, …]** | Verified by the evidence file named, as that file defines the tag. `V~` means it was read through a summarising fetch. `V-plan` and `P` mean it was verified on 2026-09-22 by `worker-runtimes.md` and not re-read. |
| **[M, file §n]** | Measured by the evidence file named. |
| **[R, paas-ssh]** / **[S, google-azure]** | Read from source by the evidence file named. Where I re-read the same line myself, the tag is **[S]**. |
| **[W]** | I re-read it today from a primary source with WebFetch. The URL is given. Both reads this plan relies on went through the summarising fetch model, so treat them like `V~`. |
| **[I]** | Inference: reasoning from the facts above. It is not a finding. |
| **[U]** | Unverified. Nothing may rest on it without a check. |
| **[D]** | A design proposal of this plan. Nothing tags it true or false yet. |

Most of this document is [D]. The tags are there so that nobody mistakes a
design choice, or an inference, for something that was observed. Three claims
in this plan's history were withdrawn because an inference was presented as a
finding (`worker-runtimes.md` §3.8.2 and §3.8.3).

---

## 1. Executive summary

### The one-paragraph version

bun-jobs gains a **`SummonController`**, one per queue that wants it. It runs
in any bun-jobs process that is already awake. It is triggered by that
process's own `add()` calls, by a poll, and by the driver's cross-process
events. On each trigger it reads the queue's **demand** through a new optional
driver method, `countDemand`. When demand exists and no worker is serving it,
it **claims a summon slot by compare-and-set** on a reserved queue-state entry.
Only then does it call a **`Summoner`**. A summoner is a small object that
makes one HTTP call, or runs one `ssh`. The summoned process runs an ordinary
`BunQueueWorker` under **`drainAndExit()`**, which owns the idle threshold,
the deadline, the signal handlers and the exit code. When that worker's first
heartbeat record appears carrying the summon's id, the slot is released.

Two more ways in share the same core. The **depth endpoint** lets a platform
(KEDA, ACA event jobs, GKE's HPA, CREMA) do the summoning. A **one-shot
`check()`** lets a cloud scheduler do it with nothing of ours always on. There
are six first-party summoners, all written with `fetch` and WebCrypto, or
`Bun.spawn(["ssh", …])`. Each is a **provider plugin** written against the same
public API a third party uses ([`compute-provider-plugins.md`](compute-provider-plugins.md)).
Every other platform goes through a third-party plugin or the
`defineSummoner({ invoke })` escape hatch, which now builds an anonymous
provider.

### The decisions it rests on

| # | Decision | Why |
|---|---|---|
| 1 | **Build summon-compute, and later real remote execution too.** | The user's decision. `worker-runtimes.md` §11 used to advise choosing one or the other. That advice is overridden, and §11 there now plans both. |
| 2 | **The trigger is `demand > 0`, and demand is not "waiting > 0".** | With no worker, due delayed jobs and due retries never reach `waiting`. `promoteDelayed` has exactly one caller, `BunQueueWorker.ts:2119` [S]. Stalled recovery is a worker sweep too (`#armMaintenance`, `BunQueueWorker.ts:4326-4356`) [S]. So demand = waiting + due + stalled, zero while paused, and "active jobs with no live worker" also calls for a worker. §4.2 |
| 3 | **An in-flight marker in queue state guards every summon.** Platform dedupe is only a second line. | A worker writes its heartbeat record only after `connect()` (`:1303`), `ensureQueue()` (`:1304`) and a report that is not awaited (`:1322` → `registerWorkerRecord` at `:4139`) [S]. Throughout a platform's cold start, "work and no live worker" stays true. Several platforms have no dedupe at all: Cloud Run `jobs.run` [V~, google-azure §3.2], ACA `jobs/start` [V, google-azure §4.2], Render jobs [V, paas-ssh §4.2], Lambda async [V, aws §4.4]. §4.3 |
| 4 | **Prefer "set a count" to "launch one".** | A scale-a-service call is idempotent. A launch-a-task call doubles up on a race. So the marker is written *before* the call, and every launch request is a pure function of its dedupe key (ECS `clientToken` only dedupes identical requests: [V, aws §4.1]). §4.6 |
| 5 | **The summoned worker installs the signal handlers. The package does not install them globally.** | Nothing in `lib/queue/` handles SIGTERM or SIGINT [R, paas-ssh §2; re-checked: no `process.on` in `BunQueueWorker.ts`] [S]. Shutdown budgets differ by about 60×. `drainAndExit()` takes the budget as an input. §5 |
| 6 | **`countDemand` is an optional driver method, bounded by a cap.** | `countJobs` on SQL is a `GROUP BY state` over the queue's whole retained history (`sql-driver.ts:4302-4313`) [S]. Polling that every 30 s is the wrong cost. §6.4 |
| 7 | **The depth endpoint returns `demand` and `outstanding`, and does not reuse `/counts`.** | Reading `waiting` has the blind spot in decision 2. On an app-style scaler, a `waiting`-only metric also SIGTERMs a busy worker after cooldown [I, google-azure §6.3]. §6 |
| 8 | **No cloud SDK. Providers ship as subpaths with no dependencies.** | `CLAUDE.md`'s dependency policy. A SigV4 signer reproduced AWS's published signatures for 5 vectors and differed on 2 [M, aws §5.2]. The Google and Azure token helper is 65 lines [M, google-azure §2.3], and was never run against either cloud [U]. §8 |
| 9 | **Six first-party summoners, in this order: ECS `RunTask`, Fly Machines, Cloud Run (jobs and worker pools), ACA manual jobs, Render one-off jobs, SSH via `systemd-run`.** Lambda ships beside ECS because it costs little once the signer exists. Everything else is a recipe on `invoke()` or a third-party plugin. | Drawn from the three evidence rankings. §7 |
| 10 | **Summoners are provider plugins with declared capabilities, and the first-party ones get no privileged internals.** The plugin API and its conformance kit are built (sub-phase 1.5p) before the first-party summoners, and stay `experimental` until those six and one outside provider pass the kit. | The platforms differ on every axis the controller reads (style, dedupe, boot budget, shutdown), so the controller must read declarations rather than know platforms by name. Building the API first means six real implementations test it before it is promised. §14, and [`compute-provider-plugins.md`](compute-provider-plugins.md) §5, §10.4, §16 |

### What it is not

- **Not a way onto an edge isolate.** The summoned process must reach the
  driver and hold its own lease. That is exactly the list of hosts in
  `worker-runtimes.md` §3.5 that can do so [P].
- **Not a replacement for Phase 2.** Summoning answers "I do not want a
  worker running 24/7". Phase 2 (`RemoteWorker` / `RemoteRunner`) answers "my
  code can only run on Cloudflare".
- **Not an autoscaler.** It starts workers from zero and, optionally, up to
  `maxWorkers`. Steady-state scaling of a busy fleet stays with the platform
  (§2.2).

---

## 2. Three summon models

Keep these three apart throughout. They differ in who notices the work, who
starts the compute, and what must be awake.

| | (a) bun-jobs-driven | (b) platform-driven | (c) schedule-driven |
|---|---|---|---|
| Who notices depth | a `SummonController` in a bun-jobs process | the platform's scaler polling a depth signal | a cloud scheduler waking a small check |
| Who starts compute | bun-jobs, through a `Summoner` | the platform (KEDA ScaledJob/ScaledObject, ACA event job, GKE HPA, CREMA) | the check, through a `Summoner` (it is model (a) run once) |
| What bun-jobs ships | controller, summoners, `drainAndExit` | the depth endpoint (§6), `drainAndExit`, recipes | `SummonController.check()` as a one-shot, `drainAndExit` |
| Where "something must be awake to notice" is solved | in bun-jobs processes that are already awake: producers at the moment of `add()`, and any long-lived process by poll | in the platform's always-on scaler. But the **metric source** must also be awake: the endpoint needs a live process [I, google-azure §6.5] | in someone else's always-on scheduler |
| Latency, add → summon call | debounce (250 ms default [D]) on the adding process. Up to one poll (30 s default [D]) for due, stalled or remote adds | up to one `pollingInterval`, 30 s by default [V, google-azure §6.1; W: keda.sh scaledobject-spec, 2026-09-25] | up to one schedule period. EventBridge Scheduler has a 1-minute floor and 60-second precision [V-plan, aws §8] |
| Standing cost | none beyond processes that already run | KEDA or CREMA and the endpoint's server. CREMA is an always-on Cloud Run service [V~, google-azure §3.3]. ACA event jobs have none [I, google-azure §7] | one small check per period (§10) |
| Dedupe | our marker (§4.3), plus platform tokens | ScaledJob: new jobs = `maxScale − runningJobCount` [V, google-azure §6.1] | our marker |

Latency *after* the summon call is the platform's cold start plus Bun boot
plus driver connect. It is the same in all three models, and it is **unknown
for every platform** except where a vendor states a figure: Fly start is "well
under a second" [V, paas-ssh §5.1], and Cloudflare Containers take 1–3 s
[V, paas-ssh §5.2]. Direct VPC egress on Cloud Run can add "a minute or more"
[V, google-azure §3.2]. Every time-to-first-claim figure is an open item
(§12).

### 2.1 (a) bun-jobs-driven

The controller lives in a process that already exists. Its three triggers
cover different gaps:

- **`add()` in this process**: immediate. `BunQueue` already emits a local
  `waiting` or `delayed` event for every job added (`BunQueue.ts:646-657`)
  [S]. Listening costs one callback per add and no driver call while a worker
  is known to be live (§4.8).
- **Driver events from other processes**: `BunQueue` also publishes `added`,
  `waiting` and `delayed` through the driver (`BunQueue.ts:647`, `:653`,
  `:656`) [S]. A controller in the management API's process can therefore
  hear another producer's adds, on drivers whose events cross processes.
- **Poll**: the only trigger that sees a delayed job come due, or a dead
  worker's lock lapse. No `add()` happens at that moment, so without a poll
  nothing notices. This is where a controller needs a **long-lived** process.

### 2.2 (b) platform-driven

bun-jobs exposes demand. The platform decides. Pair a **ScaledJob** (ACA
event jobs, KEDA `ScaledJob`) with the launch-a-task worker mode and
`valueLocation: demand`. Pair a **ScaledObject** (ACA apps, KEDA
`ScaledObject`, CREMA for Cloud Run worker pools) with the service worker mode
and `valueLocation: outstanding` [I, google-azure §6.3]. Why `outstanding`:
KEDA's `cooldownPeriod` "only applies when scaling to 0". It waits 300 s by
default after "the last trigger reported active" [W: keda.sh scaledobject-spec,
2026-09-25]. A metric that ignores active jobs therefore reports inactive while
a worker is busy on a long job, and after the cooldown that worker is scaled
away [I, google-azure §6.3].

This is the right answer for anyone already on Kubernetes or ACA. It is one
artefact for six targets: ACA apps, ACA event jobs, AKS, GKE with KEDA, GKE's
native HPA via Prometheus, and Cloud Run worker pools via CREMA [I,
google-azure §0.2]. bun-jobs writes no summoner for it.

### 2.3 (c) schedule-driven

A scheduled function or container runs `SummonController.check()` once, then
exits (§3.3). It holds no lease, so a default Lambda is fine as the checker
[I, aws §8]. So are Cloud Run functions and Azure Functions [V/P,
google-azure §3.1, §4.1]. It is the only model that works with **zero**
always-on bun-jobs processes *and* no Kubernetes. It trades latency for that:
a burst between ticks waits for the next tick [I, aws §8].

A degenerate form needs no bun-jobs code at all: schedule the *worker itself*
every N minutes. The worker exits at once on an empty queue. That costs one
minimum bill per empty tick. It is ≈ $0.0008 per empty Fargate minute
[I, aws §8], and ≈ $0.00114 per empty Cloud Run job run [I, google-azure §3.6].
Document it as the zero-code fallback.

---

## 3. Where the summoner runs

### 3.1 Options

| Placement | Extra processes | Sees `add()` at once | Sees due and stalled | Credentials live in |
|---|---|---|---|---|
| **Enqueue-side hook** (a controller on the producer's `BunJobs`) | none | yes, for adds in this process | only if the producer is long-lived and polls | every producer process |
| **Summoner in one long-lived process** (the management API server, or any service with a `BunJobs`) | none if one exists | via driver events, where the driver carries them across processes | yes, by poll | that one process |
| **Scheduled check** (model c) | a scheduled function | no | yes, at the schedule's resolution | the scheduled function |

### 3.2 Recommendation [D]

**One API, three placements, and a default to recommend in the README:**

1. **Where a long-lived bun-jobs process exists** (the management API server
   is the usual one), register the controller there with `poll` and `events`
   on. That one process holds the cloud credentials, and it catches due,
   stalled and remote adds. This is the recommended default.
2. **Add the enqueue-side hook on producers only when latency matters.**
   `triggers.onAdd` in a producer gives zero-debounce summoning for that
   producer's own adds. It also puts platform credentials in every producer.
   That is a real cost (§12.3), so it is opt-in per process, not a global
   default.
3. **With no long-lived process, use model (b) or (c).** On Kubernetes or
   ACA, use (b). Elsewhere, use (c), optionally plus the producer hook for
   immediacy.

**Why not "enqueue-side only"?** It cannot see a delayed job come due, a retry
come due, or a dead worker's lock lapse. No `add()` happens at those moments,
and they are exactly the cases of decision 2. A producer-only deployment
strands them until the next add. That is acceptable only for queues that
never delay, retry or crash. The README must say so rather than imply full
coverage.

**A controller in a summoned worker's process is inert by default.** An app
that builds its `BunJobs` in a shared module would otherwise summon from inside
the worker it summoned. When `summonedFromEnv()` (§5.3) finds a summon id,
`BunJobs` creates controllers disabled unless `summon.fromSummoned: true`
[D].

### 3.3 The one-shot form

```ts
// check.ts: run by EventBridge Scheduler → Lambda, Cloud Scheduler → Cloud Run job, cron, …
import { SummonController } from "@kingsleyweb/bun-jobs";
import { ecsRunTask } from "@kingsleyweb/bun-jobs/providers/aws";

const controller = new SummonController({
  driver, namespace: "shop", queue: "emails",
  summoner: ecsRunTask({ region: "eu-west-1", cluster: "jobs", taskDefinition: "emails-worker",
    container: "worker", subnets: [...], securityGroups: [...] }),
  triggers: { onAdd: false, poll: false, events: false },
});
const result = await controller.check({ reason: "schedule" });
await controller.close();
console.log(result);          // { action: "summoned" | "none" | "skipped", … }
```

---

## 4. Core design

### 4.1 Components and where they live [D]

| Piece | File | Exported from |
|---|---|---|
| `SummonController`, `SummonPolicy`, `defineSummoner` | `lib/summon/controller.ts`, `lib/summon/types.ts` | `lib/summon/index.ts`, and the package root |
| the provider core and the `summon` facet types (`defineComputeProvider`, `ProviderError`, `SummonFacet`, `SummonCapabilities`, …) | `lib/provider/` | `./provider` ([`compute-provider-plugins.md`](compute-provider-plugins.md) §6–§7, §11) |
| the conformance kit and `fakePlatform()` | `lib/provider/testing/` | `./provider/testing` (plugins §12) |
| demand reading (`readDemand`, the fallback formula) | `lib/drivers/readApis.ts` beside `listWorkerRecords` (`:657`) [S] | `./lib/drivers` |
| `countDemand` driver method | each driver, contract in `lib/drivers/driver.ts` | — |
| the marker (reserved entry `__win:summon`) | `lib/summon/marker.ts`, written with `setReservedState` (`queue/windows.ts:79`) [S] | not exported |
| `drainAndExit`, `summonedFromEnv`, `SUMMON_ENV` | `lib/summon/worker.ts` | root |
| first-party providers | `lib/providers/{aws,google,azure,fly,render,ssh}.ts`, importing only the public entries (plugins §5) | `./providers/*` subpaths (§8.4) |
| signing helpers | `lib/provider/auth/{sigv4,aws-credentials,google-token,azure-token,jwt}.ts` | `./provider/auth`, public (plugins §6.4) |

`setReservedState` writes with the package's internal token. Nothing outside
the package can forge a write to a `__win:` name (`driver.ts:2618-2637`,
`windows.ts:79-92`) [S]. So a user's own `setQueueState` cannot corrupt the
marker by accident.

### 4.2 The trigger predicate

Read from the driver, at `now`:

```
paused      = isQueuePaused(q)
waiting     = jobs in `waiting`
dueNow      = jobs in `delayed` or `failed` with runAt ≤ now          (nextDelayedAt covers both sets)
stalled     = jobs in `active` whose lock_expires_at ≤ now
active      = jobs in `active`
workers     = live records from listWorkerRecords(q, now)

demand      = paused ? 0 : waiting + dueNow + stalled
outstanding = paused ? 0 : demand + active
orphaned    = !paused && active > 0 && workers == 0                    (lock not lapsed yet, holder gone)

needs a worker ⇔ (demand > 0 || orphaned) && served < wanted
```

- `nextDelayedAt` really does look at both the delayed and the failed
  (retry-pending) sets. Redis walks `[keys.delayed, keys.failed]`
  (`redis-driver.ts:3258-3276`). SQL takes a `MIN(run_at)` per state
  (`sql-driver.ts:6662-6690`) [S]. So `nextDelayedAt(q) ≤ now` is a correct
  *boolean* for "something is due", on every driver, today.
- `orphaned` covers the window between a worker dying and its lock lapsing.
  That window is up to `lockDuration`, `DEFAULT_LOCK_DURATION = 30_000`
  (`shared/constants.ts:135`) [S]. Summoning then is not wasted: the job will
  be recoverable by the time a cold start finishes.
- **Paused queues demand nothing**, including their orphans. A paused queue's
  stalled jobs wait for the resume, as they do today.
- `served` and `wanted`:
  ```
  wanted = min(maxWorkers, max(1, ceil(outstanding / jobsPerWorker)))
  served = (satisfiedBy == "any-worker" ? workers : summonedWorkers) + pending.length
  ```
  `jobsPerWorker` defaults to `Infinity`, which means one worker. `pending` is
  the marker's unregistered attempts (§4.3).

**`satisfiedBy: "any-worker"`** is the default: a queue with any live worker
is served. The honest caveat is that a live worker may be paused by a
`WorkerController` (the Phase 0 name). A paused worker writes `paused: true`
and `state` on its record (`BunQueueWorker.ts:4148-4149`; states in `shared/workers.ts:25-31`) [S], so only records
in state `running` count as serving [D].

### 4.3 The in-flight marker

One reserved queue-state entry per queue, `__win:summon`, written by
compare-and-set with `setReservedState`. Its value:

```ts
/** What `__win:summon` holds: the summon state of one queue, shared by every controller. */
interface SummonMarker {
  /** Shape version, so a later release can migrate it. Always `1` here. */
  v: 1;
  /**
   * Attempts started and not yet matched to a live worker record, oldest
   * first. Each counts as a worker on its way until its `until` passes.
   */
  pending: PendingSummon[];
  /** When the last attempt was started, epoch ms; the cooldown counts from here. */
  lastAttemptAt?: number;
  /** Consecutive failed or never-registered attempts; reset by a registration. */
  failures: number;
  /** No attempt before this epoch ms: the backoff after a failure. */
  backoffUntil?: number;
  /** While set and in the future, the circuit is open and nothing is summoned. */
  circuitOpenUntil?: number;
  /** Attempts started in the current hour and day, for the budget (§4.5). */
  budget: {
    /** Start of the current hour window, epoch ms. */
    hourStart: number;
    /** Attempts started in it. */
    hour: number;
    /** Start of the current day window, epoch ms. */
    dayStart: number;
    /** Attempts started in it. */
    day: number;
  };
  /** The most recent outcome, for the status route and the UI. */
  last?: {
    /** The attempt it concerns. */
    id: string;
    /** What happened. */
    outcome: SummonOutcomeKind;
    /** When, epoch ms. */
    at: number;
    /** A short, secret-free explanation: an error code, a platform reason. */
    detail?: string;
  };
}

/** One summon attempt in flight. */
interface PendingSummon {
  /** The attempt id, `SummonRequest.id`. */
  id: string;
  /** When the attempt was claimed, epoch ms. */
  at: number;
  /** When it stops counting as a worker on its way: `at + bootBudget`. */
  until: number;
  /** How many workers it asked for. */
  count: number;
  /** The summoner's `kind`, e.g. `"ecs"`. */
  kind: string;
  /** Platform identifiers the summoner returned (task ARNs, a Machine id), once known. */
  handles?: string[];
}
```

**The check, step by step** [D]:

1. Read demand (§4.2), live workers, and the marker entry with its version.
   That is three reads, and all of them are needed anyway.
2. **Release.** For each pending attempt:
   - It is **registered** if a live record carries `summon.id === attempt.id`
     (§5.4). Drop it and reset `failures`.
   - When the platform cannot pass the id (Fly start with a fixed config;
     §7), fall back to a live record whose `startedAt ≥ attempt.at − 5 s`
     and which is not already attributed to another attempt.
   - It is **lost** if `until ≤ now` and it never registered. Drop it,
     increment `failures`, set `backoffUntil`, and emit `summon` with outcome
     `lost` (§9.1). When the summoner's facet has `status()`, ask it once and
     put the platform's reason in `last.detail`; when it also has `cancel()`
     and the unit is still pending, cancel it so it cannot start late
     ([`compute-provider-plugins.md`](compute-provider-plugins.md) §7.3).
3. If `paused`, or there is no demand and no orphan: if the marker changed,
   write it back. Otherwise return `none`. Scale-style summoners get their
   scale-down check here (§4.7).
4. Compute `want = wanted − served`. If `want ≤ 0`, return `skipped: served`
   or `skipped: pending`.
5. Gates, in order: `circuitOpenUntil`, `backoffUntil`, `cooldown` since
   `lastAttemptAt`, budget, `maxPending`. Any hit returns `skipped` with that
   reason.
6. **Claim.** Append `PendingSummon { id, at: now, until: now + bootBudget,
   count: want }` and write with `expected = version`. If the CAS fails,
   another controller moved first: return `skipped: contended`. **Nothing has
   been called yet, so a lost race costs nothing.**
7. **Call** the summon facet, `summoner.summon.summon(request, context)`,
   under `summonTimeout`. A thrown `ProviderError`'s kind decides step 8's
   backoff and whether the circuit opens at once
   ([`compute-provider-plugins.md`](compute-provider-plugins.md) §6.5).
8. **Record** the result with a second CAS (retried against a fresh read, up to
   three times [D]). `started`, `deduped` and `already-running` keep the
   pending entry and add its handles. `unavailable` or a throw removes it,
   increments `failures` and sets `backoffUntil`.

**The marker's TTL is `bootBudget`**, per attempt. It must cover platform
cold start, plus Bun boot, plus driver connect, plus one report round trip
[I, paas-ssh §7.6]. It also belongs with the summoner, because it differs by
about two orders of magnitude between a Fly start and a Kubernetes image pull
[I, paas-ssh §9]. So each first-party summoner declares a default (§7), and
`SummonPolicy.bootBudget` overrides it. **Every default is an [I]**: no cold
start has been measured on any platform (§12).

**Why the marker is not the heartbeat record.** A record written before the
process exists would make every other reader of `listWorkerRecords` see a
worker that is not there: the Workers page, `jobs.workers`, the limiter
[I]. The marker is private to summoning, and the worker record stays a fact.

**The marker survives controllers dying.** It lives in the driver, not a
process. A controller that crashes after step 6 leaves an attempt that expires
at `until` and counts as `lost`. It never leaves a permanent block [I].

### 4.4 Stampede guard, cooldowns, concurrency

| Guard | Default [D] | Protects against |
|---|---|---|
| the CAS claim (step 6) | always on | two controllers summoning for the same backlog |
| `pending` counted as served | always on | re-summoning through a cold start (decision 3) |
| `maxPending` | `maxWorkers` | more unregistered attempts than workers wanted |
| `maxWorkers` | `1` | runaway scale-out: the ceiling on summoned workers per queue |
| `cooldown` | `10_000` ms | a flapping predicate starting attempts back to back |
| `debounce` (onAdd, events) | `250` ms | a bulk `add()` turning into N checks |
| backoff after a failure | `30_000` ms doubling to `900_000` ms | hammering a failing platform API |
| circuit | opens after `5` consecutive failures, for `900_000` ms | a broken deploy summoning into a crash loop, paid per start |

**Platform dedupe as the second line.** Where a platform has a real token, the
summoner passes `request.dedupeKey`: ECS `clientToken` [V, aws §4.1], EC2
`ClientToken` [V, aws §4.8], Nomad `idempotency_token` [V, paas-ssh §6.3],
Compute Engine `requestId` [V~, google-azure §3.4], a Kubernetes Job name
[V/U, paas-ssh §6.1]. A systemd unit name is also a dedupe key [M, paas-ssh
§4.4]. So is a Fly Machine id [I, paas-ssh §5.1]. The token catches a retry of
**the same** attempt after a network error. It does not catch two attempts,
and it is not meant to. The CAS catches those.

### 4.5 Cost ceilings

| Ceiling | Option | Default [D] |
|---|---|---|
| attempts per hour, per queue | `budget.perHour` | `30` |
| attempts per day, per queue | `budget.perDay` | `300` |
| summoned workers at once, per queue | `maxWorkers` | `1` |
| lifetime of one summoned worker | `maxLifetime` → the worker's `drainAndExit` deadline, and the platform's own cap where the adapter can set one (Cloud Run task timeout, Heroku `time_to_live`, `RuntimeMaxSec`, `activeDeadlineSeconds`, `maximumDurationInSeconds`) | `3_600_000` (1 h) |

A budget hit returns `skipped: budget`, emits `summon` with outcome
`budget-exhausted` once per window, and shows on the status route. **It never
fails a job.** Jobs wait, exactly as they would with no summoner.

The 1-hour lifetime default is deliberate. It keeps Cloud Run jobs under the
hour past which SIGTSTP/SIGCONT maintenance pauses begin [V, google-azure
§3.2]. It also bounds a forgotten worker's bill [I]. A queue with jobs longer
than that sets it higher, and reads §5.2's pause handling.

### 4.6 What goes over the wire: requests must be pure functions of the key

ECS: "Requests with the same token … are idempotent", and a same-token request
with different parameters is a `ConflictException` [V, aws §4.1]. EC2's
behaviour is the same (`IdempotentParameterMismatch`) [V, aws §4.8]. So
**nothing in a request may depend on the clock or on randomness beyond the
attempt id** [I, aws §1 item 5]. Concretely:

- `request.id` is `sm_` + base32 of SHA-256 over
  `(namespace, queue, marker version at claim)`, truncated [D]. It is
  deterministic for one claim, so a retried call is byte-identical.
- `request.env` carries only `BUN_JOBS_SUMMON_ID`, `BUN_JOBS_SUMMON_KIND`,
  `BUN_JOBS_NAMESPACE`, `BUN_JOBS_QUEUE`, `BUN_JOBS_SUMMON_MODE` and
  `BUN_JOBS_SUMMON_MAX_LIFETIME_MS` (a *duration*), plus the policy's static
  `env`. **No `summonedAt`.** The worker reads its start time from its own
  clock, and the controller knows `at` from the marker.
- `request.dedupeKey` is `request.id` clipped to the summoner's declared
  `dedupe.maxLength` and `dedupe.charset`, and to 64 characters of
  `[A-Za-z0-9-]` when it declares none. The controller computes it, so no
  provider builds its own key. 64 fits ECS `clientToken` (≤ 64, ASCII
  33–126), EC2 `ClientToken` (≤ 64) [V, aws §4.1, §4.8] and a Kubernetes name.
  Cloud Run's `runExecutionToken` needs job name + token < 63 characters [V,
  google-azure §3.2], so that provider declares a `maxLength` computed from its
  configured job name ([`compute-provider-plugins.md`](compute-provider-plugins.md) §7.1).

### 4.7 Launch-style and scale-style summoners

A third style, **`wake`**, is declared by a provider that starts one of a fixed
pool of pre-created units (Fly Machines, a stopped VM). It behaves as launch
here, except that starting a started unit is harmless and `maxWorkers` is
clamped to the declared `poolSize` ([`compute-provider-plugins.md`](compute-provider-plugins.md) §7.1).

| | launch (`style: "launch"`) | scale (`style: "scale"`) |
|---|---|---|
| Call | start N units: `RunTask`, `jobs:run`, `POST /jobs`, `systemd-run` | set the count to `target`: worker pool `manualInstanceCount`, ECS `desiredCount`, ASG `SetDesiredCapacity` |
| Duplicate on a race | yes | no, idempotent by construction [I, aws §4.3; google-azure §3.3] |
| Worker mode | `launch`: exits on idle | `service`: never exits on idle, because the platform would restart it [I, google-azure §5] |
| Who scales to zero | nobody: the unit ends when the process exits | **the controller**, via the facet's `release({ target: 0 }, context)`, once `outstanding == 0` has held for `scaleDown.after` (default `300_000` ms) [D] |

A scale-style release uses `outstanding`, never `demand`. So it never sets a
count to zero while a job is active, which is the ScaledObject hazard of §2.2
[I]. A job added between the check and the release reaches a worker that is
already draining on SIGTERM. That worker settles or releases it within its
grace, and the next check scales up again [I]. Scale-style is supported so that
Cloud Run worker pools have a first-party path. The README recommends
launch-style everywhere a platform offers both, because a crashed controller
leaves a scale-style pool billing "as active … even if … idle" [V,
google-azure §8].

### 4.8 Hot-path cost of the enqueue hook

`benchmark regression guard` (`CLAUDE.md`) runs `enqueue` and `enqueue-bulk`
against a baseline. The hook must not move them. Design [D]:

- The controller keeps `servedUntil`: the earliest `expiresAt` among the
  running live records it last read. While `now < servedUntil`, a local
  `waiting` or `delayed` event does **nothing**: no timer and no driver call.
  With a worker up, this is the steady state.
- Otherwise the event arms one debounce timer per controller, not per job. A
  bulk add of 5,000 jobs is one check.
- A local `delayed` event with a `runAt` inside the poll interval arms a
  one-shot timer at `runAt`, so a long-lived producer does not wait a whole
  poll for its own delayed job [D].

Phase 1.5a runs `bun queue.ts --compare` with a controller attached to the
`enqueue` scenario's queue and a live worker. The existing baselines must come
back unchanged. If they move, that is the finding.

### 4.9 Driver requirements

Summoning needs a driver that **another host** can reach, and queue state for
the marker. The rules at construction [D]:

- `capabilities.multiProcess === false`: `ConfigError`. The memory driver
  cannot be shared with a summoned process.
- `multiHost === false` with any summoner except SSH to `localhost`: a
  `warn`. The file driver and SQLite work only on one host
  (`driver.ts:63-65`) [S].
- `getQueueState` or `setQueueState` missing: `ConfigError`. No marker, no
  stampede guard, and decision 3 says that is not optional.

### 4.10 Full signatures

```ts
/** Why a check ran. */
export type SummonReason = "add" | "event" | "poll" | "schedule" | "manual" | "timer";

/** What one attempt ended as, as recorded on the marker and in `summon` events. */
export type SummonOutcomeKind =
  | "started"          // the platform accepted it
  | "deduped"          // the platform reports this attempt already ran (same token)
  | "already-running"  // the unit or Machine was already up; counts as served
  | "registered"       // the summoned worker's record appeared
  | "unavailable"      // the platform declined: capacity, quota, an inactive function
  | "failed"           // the call threw or timed out
  | "lost"             // accepted, but no worker registered within `bootBudget`
  | "budget-exhausted" // a ceiling stopped it
  | "released";        // a scale-style summoner was set back to zero

/** A queue's demand at one instant: what the trigger and the depth endpoint read. */
export interface QueueDemand {
  /** The instant it describes, epoch ms: the `now` it was computed at. */
  at: number;
  /** Whether claiming is paused. A paused queue demands nothing. */
  paused: boolean;
  /** Jobs in `waiting`. */
  waiting: number;
  /** Jobs in `delayed` or `failed` (retry pending) whose `runAt` has passed. */
  dueNow: number;
  /** Jobs in `active` whose lock has lapsed: their worker died holding them. */
  stalled: number;
  /** Jobs in `active`, lapsed or not. */
  active: number;
  /** Live, running workers on the queue, from its heartbeat records. */
  workers: number;
  /** The earliest `runAt` still in the future, or `null` for none. */
  nextDueAt: number | null;
  /** `paused ? 0 : waiting + dueNow + stalled`: work a worker could claim now. For a ScaledJob. */
  demand: number;
  /** `paused ? 0 : demand + active`: everything not finished. For a ScaledObject. */
  outstanding: number;
  /**
   * `true` when a count reached the driver's cap (`countDemand`'s `cap`), so
   * the true figure is at least this one. A scaler only needs the magnitude.
   */
  capped: boolean;
  /**
   * `false` when the driver has no `countDemand` and the figures come from the
   * fallback formula: `dueNow` is then `1` or `0` (from `nextDelayedAt`) and
   * `stalled` is `active` when no worker is live. Correct as a trigger,
   * approximate as a count.
   */
  exact: boolean;
}

/** Everything a summoner is told about one attempt. */
export interface SummonRequest {
  /** The namespace of the queue that needs a worker. */
  namespace: string;
  /** The queue that needs a worker. */
  queue: string;
  /**
   * This attempt's id, deterministic for one marker claim (§4.6), so a retried
   * call is identical. Reaches the worker as `BUN_JOBS_SUMMON_ID`, and comes
   * back on its heartbeat record as `summon.id`, which is how the attempt is
   * released.
   */
  id: string;
  /**
   * `id` clipped to the summoner's declared `dedupe.maxLength` and
   * `dedupe.charset` (64 characters of `[A-Za-z0-9-]` when it declares
   * none): fit for ECS `clientToken`, EC2 `ClientToken` and a Kubernetes name.
   * Computed by the controller, never by the provider. Pass it wherever the
   * platform offers idempotency.
   */
  dedupeKey: string;
  /** How many workers a launch-style summoner should start. At least `1`. */
  count: number;
  /**
   * For a scale-style summoner: the absolute count the platform should run
   * after this call. Setting it twice is harmless, which is the point.
   */
  target: number;
  /** The demand reading that prompted the attempt. */
  demand: QueueDemand;
  /** Why the check ran. */
  reason: SummonReason;
  /**
   * Environment for the summoned worker, for platforms that pass env per run.
   * A pure function of `id` and the policy's static `env`: never a timestamp.
   * {@link SUMMON_ENV} names the keys.
   */
  env: Readonly<Record<string, string>>;
  /**
   * The same values as `--bun-jobs-summon-*=` arguments, for platforms that
   * take only a command line (Render's `startCommand`).
   */
  argv: readonly string[];
  /**
   * How long the summoned worker may live, in ms: the policy's `maxLifetime`.
   * An adapter maps it onto the platform's own cap where one exists.
   */
  maxLifetimeMs: number;
  // `signal` and `logger` moved to `ProviderCallContext`, the second argument
  // of every facet call (compute-provider-plugins.md §6.2), with `fetch` and `now`.
}

/** What a scale-style summoner is asked to do when demand has gone. */
export interface SummonReleaseRequest {
  /** The namespace of the queue. */
  namespace: string;
  /** The queue. */
  queue: string;
  /** The count to set. `0` scales to zero. */
  target: number;
  // `signal` and `logger` are on `ProviderCallContext`, as for `SummonRequest`.
}

/** What a summoner reports back. A throw means `failed`. */
export type SummonResult =
  | {
      /** The platform accepted the request and is starting compute. */
      status: "started";
      /** Platform identifiers of what it started: task ARNs, execution names, a Machine id. */
      handles: string[];
    }
  | {
      /** The platform's idempotency token says this attempt already ran. */
      status: "deduped";
      /** What the platform says that earlier call started, when it says. */
      handles?: string[];
    }
  | {
      /** The unit was already up: a started Machine, an active systemd unit. Counts as served. */
      status: "already-running";
      /** Identifiers of what is running, when known. */
      handles?: string[];
    }
  | {
      /** The platform declined without an error: no capacity, a quota, an inactive function. */
      status: "unavailable";
      /** A short, secret-free reason, shown on the status route. */
      reason: string;
      /** Try no sooner than this many ms from now. Overrides the backoff when larger. */
      retryAfterMs?: number;
    };

/**
 * Something that can start compute for a queue: a configured compute provider
 * that has a `summon` facet. Made by a provider plugin (`ecsRunTask(options)`,
 * a third party's factory) or by `defineSummoner`. The facet's types —
 * `SummonFacet`, `SummonCapabilities` (style `"launch" | "scale" | "wake"`,
 * `dedupe`, `passes`, `bootBudgetMs`, `shutdown`, `maxLifetimeMs`, …),
 * `ProviderCallContext`, `ProviderError` — are defined once, in
 * compute-provider-plugins.md §6–§7, and exported from `./provider`.
 *
 * What used to be top-level fields here (`kind`, `style`, `bootBudget`,
 * `passes`, `summon`, `release`, `describe`) now live on the provider's
 * identity (`kind`), its facet's `capabilities`, and the facet's hooks.
 */
export type Summoner = ConfiguredProvider & {
  /** The summon facet the controller calls. */
  readonly summon: SummonFacet;
};

/**
 * The escape hatch: a summoner from a plain function, for any platform with
 * no provider plugin. It builds an anonymous provider (`name: "custom:" +
 * kind`, the host's own `apiVersion`, no schema) and configures it in one
 * call. A function that returns nothing counts as
 * `{ status: "started", handles: [] }`.
 */
export function defineSummoner(options: {
  /** The kind shown in logs and the UI. Defaults to `"custom"`. */
  kind?: string;
  /** `"launch"` (default), `"scale"` or `"wake"`. A scale summoner must also give `release`. */
  style?: "launch" | "scale" | "wake";
  /** The in-flight TTL in ms. Defaults to `180_000`: a conservative guess, since nothing was measured. */
  bootBudget?: number;
  /** How the platform passes per-attempt values. Defaults to `"env"`. */
  passes?: "env" | "argv" | "none";
  /** How the platform dedupes. Defaults to `{ kind: "none" }`: the marker is the whole guard. */
  dedupe?: SummonDedupe;
  /** The stop signal and grace. Defaults to `{ signal: "SIGTERM", graceMs: 10_000 }`. */
  shutdown?: SummonCapabilities["shutdown"];
  /** Starts compute. Throw a `ProviderError` to say how the controller should back off (plugins §6.5). */
  invoke: (request: SummonRequest, context: ProviderCallContext) => Promise<SummonResult | void>;
  /** Scale-style only: sets the count. */
  release?: (request: SummonReleaseRequest, context: ProviderCallContext) => Promise<void>;
  /** Secret-free description for the UI. Defaults to `{ kind }`. */
  describe?: () => Record<string, string>;
}): Summoner;

/** How a queue is summoned for. */
export interface SummonPolicy {
  /**
   * What starts compute: a configured provider with a summon facet. A bare
   * function is shorthand for `defineSummoner({ invoke })`.
   */
  summoner: Summoner | ((request: SummonRequest, context: ProviderCallContext) => Promise<SummonResult | void>);
  /** What makes the controller check. */
  triggers?: {
    /**
     * Check after a job is added through this process's `BunJobs` or queue.
     * Defaults to `true`. It costs nothing while a live worker is known (§4.8).
     */
    onAdd?: boolean;
    /**
     * Check after an `added`/`waiting`/`delayed` event another process
     * published through the driver. Defaults to `true` where the driver's
     * events cross processes (`capabilities.events !== "local"`).
     */
    events?: boolean;
    /**
     * Check every this many ms, which is the only trigger that sees a delayed
     * job come due or a dead worker's lock lapse. Defaults to `30_000`;
     * `false` turns it off (the one-shot form, §3.3).
     */
    poll?: number | false;
    /** Coalesce add and event triggers for this many ms. Defaults to `250`. */
    debounce?: number;
  };
  /**
   * How long an attempt counts as a worker on its way, in ms. Defaults to the
   * summoner's declared `capabilities.bootBudgetMs`. Too short summons twice; too long delays the
   * retry of a start that silently failed.
   */
  bootBudget?: number;
  /** The most summoned workers the queue may have at once. Defaults to `1`. */
  maxWorkers?: number;
  /**
   * Outstanding jobs one worker should take before another is summoned.
   * Defaults to `Infinity`, which means one worker regardless of depth.
   */
  jobsPerWorker?: number;
  /** The most unregistered attempts at once. Defaults to `maxWorkers`. */
  maxPending?: number;
  /** The least time between two attempts, in ms. Defaults to `10_000`. */
  cooldown?: number;
  /** The wait after a failed or lost attempt, doubling per consecutive failure. */
  backoff?: {
    /** The first wait, in ms. Defaults to `30_000`. */
    initial?: number;
    /** The longest wait, in ms. Defaults to `900_000`. */
    max?: number;
  };
  /** When to stop summoning altogether after repeated failures. */
  circuit?: {
    /** Consecutive failed or lost attempts that open it. Defaults to `5`. */
    failures?: number;
    /** How long it stays open, in ms, before one trial attempt. Defaults to `900_000`. */
    resetAfter?: number;
  };
  /** Cost ceilings, per queue. */
  budget?: {
    /** Attempts per hour. Defaults to `30`. */
    perHour?: number;
    /** Attempts per day. Defaults to `300`. */
    perDay?: number;
  };
  /**
   * The longest a summoned worker may live, in ms. It is passed to the worker
   * (its `drainAndExit` deadline) and to the platform's own cap where the
   * adapter can set one. Defaults to `3_600_000`.
   */
  maxLifetime?: number;
  /**
   * Which live workers count as serving the queue: any running worker
   * (`"any-worker"`, default) or only summoned ones (`"summoned-only"`, for a
   * queue whose always-on workers are deliberately capped).
   */
  satisfiedBy?: "any-worker" | "summoned-only";
  /** Scale-style only: when to set the count back to zero. */
  scaleDown?: {
    /** How long `outstanding` must stay `0` first, in ms. Defaults to `300_000`. */
    after?: number;
  };
  /** How long one `summon()` or `release()` call may take, in ms. Defaults to `30_000`. */
  summonTimeout?: number;
  /**
   * Static environment added to every request's `env`. It must not vary per
   * attempt (§4.6). Never put a secret here that the platform can read from
   * its own secret store instead.
   */
  env?: Record<string, string>;
  /**
   * Whether a controller may run in a process that was itself summoned
   * (`BUN_JOBS_SUMMON_ID` set). Defaults to `false`, so a shared config
   * module cannot make a worker summon more workers (§3.2).
   */
  fromSummoned?: boolean;
}

/** Why a check did not summon. */
export type SummonSkipReason =
  | "served" | "pending" | "cooldown" | "backoff" | "circuit-open"
  | "budget" | "contended" | "closed";

/** What one check did. */
export type SummonCheckResult =
  | {
      /** Nothing needs a worker: no demand, or the queue is paused. */
      action: "none";
      /** The reading it decided on. */
      demand: QueueDemand;
    }
  | {
      /** A worker is needed, but a guard held the attempt back. */
      action: "skipped";
      /** Which guard. */
      reason: SummonSkipReason;
      /** The reading it decided on. */
      demand: QueueDemand;
    }
  | {
      /** An attempt was claimed and the summoner called. */
      action: "summoned";
      /** The attempt's id. */
      id: string;
      /** What the summoner answered, or `failed` when it threw. */
      outcome: SummonOutcomeKind;
      /** The reading it decided on. */
      demand: QueueDemand;
    }
  | {
      /** A scale-style summoner was set back to zero. */
      action: "released";
      /** The reading it decided on. */
      demand: QueueDemand;
    };

/** What the status route and the UI read: the marker plus the local policy, if any. */
export interface SummonStatus {
  /** The queue. */
  queue: string;
  /** Whether a controller runs in *this* process (so a manual summon is possible here). */
  local: boolean;
  /**
   * The summoner, when local: its provider's identity (`name`, `version`,
   * `kind`, `apiVersion`), its declared capabilities, and its `describe()`
   * facts with secrets redacted (compute-provider-plugins.md §14.1).
   */
  summoner?: {
    /** Who the provider is. */
    provider: ProviderIdentity;
    /** What it declared. */
    capabilities: SummonCapabilities;
    /** Secret-free facts from `describe()`. */
    facts: Record<string, string>;
  };
  /** Attempts in flight. */
  pending: readonly PendingSummon[];
  /** Consecutive failures. */
  failures: number;
  /** When the backoff ends, epoch ms, if one is running. */
  backoffUntil?: number;
  /** When the circuit closes, epoch ms, if it is open. */
  circuitOpenUntil?: number;
  /** Attempts used against the budget, when local: this hour and today, with the limits. */
  budget?: { hour: number; perHour: number; day: number; perDay: number };
  /** The most recent outcome. */
  last?: SummonMarker["last"];
}

/** Watches one queue and summons compute when it has work and no worker. */
export class SummonController {
  constructor(options: SummonPolicy & {
    /** The driver the queue lives on. Must be multi-process, with queue state (§4.9). */
    driver: JobsDriver;
    /** The queue's namespace. */
    namespace: string;
    /** The queue to watch. */
    queue: string;
    /** Where it logs. Any `LoggerLike`; defaults to the package's logger, named `"summon"`. */
    logger?: LoggerLike;
  });
  /** The queue it watches. */
  readonly queue: string;
  /** Runs one check now. Every trigger ends up here. */
  check(options?: {
    /** Recorded on the attempt and in events. Defaults to `"manual"`. */
    reason?: SummonReason;
    /** Skip the cooldown (never the circuit, the budget or the CAS). For the manual route. */
    force?: boolean;
  }): Promise<SummonCheckResult>;
  /** The marker as it stands, plus this controller's policy. */
  status(): Promise<SummonStatus>;
  /** Clears failures, backoff and an open circuit. Pending attempts are kept. */
  reset(): Promise<void>;
  /** Stops the triggers and waits for a check in flight. Leaves the marker as it is. */
  close(): Promise<void>;
}
```

On `BunJobs` [D]:

```ts
/** On `BunJobsOptions`: summon compute for these queues, keyed by queue name. */
summon?: Record<string, SummonPolicy>;

/** On `BunJobs`: the controller for a queue, created on first use from `summon` or from `policy`. */
summoner(queue: string, policy?: SummonPolicy): SummonController;
```

`BunJobs` hands the controller its driver, namespace and logger, attaches the
`onAdd` hook to the queue objects it creates, and closes controllers in
`jobs.close()` [D].

---

## 5. The summoned worker's side

### 5.1 Why the existing `drained` event is not the exit signal

The AWS evidence's worker sketch exits on `worker.on("drained", close)` [I,
aws §4]. `drained` fires once the queue has been *continuously* empty for
`drainDelay` (`BunQueueWorker.ts:1926-1953`) [S]. `drainDelay` defaults to
`0` (`types.ts:1049-1050`) [S], so by default it fires on the first empty
claim pass. Two cases make that unsafe for a summoned worker [I]:

- **Orphaned jobs.** A worker summoned because a dead worker's jobs are
  `active` sees nothing claimable until those locks lapse. They lapse after up
  to `lockDuration` (30 s) [S]. Then the queue's stalled sweep has to run,
  and it runs under a sweep lease. A dead holder "leaves two of its own
  cadences of lease behind, and the next worker's pass takes it over within
  one more", which is 90 s at the defaults (`BunQueueWorker.ts:2869-2877`,
  `SWEEP_LEASE_LIFETIMES = 2` at `:167`) [S]. A worker that exits on its first
  empty pass leaves before it can recover them, and the controller summons
  again.
- **Due work in other forms.** An empty claim pass says nothing about a job
  due in 2 s.

So `drainAndExit()` decides idleness with the same `countDemand` reading the
controller uses:

```
idle ⇔ ownActive == 0
     ∧ demand.demand == 0
     ∧ ¬(demand.active > 0 ∧ otherLiveWorkers == 0)      // someone else's jobs, and no one alive to finish them
     ∧ (demand.nextDueAt == null ∨ demand.nextDueAt > now + idleTimeout)
```

It exits after `idle` has held continuously for `idleTimeout`, checked every
`idleCheckInterval`. That costs one `countDemand` plus one `listWorkerRecords`
per interval per summoned worker. At a 5 s interval it is small next to the
worker's own claim polling [I].

### 5.2 Shutdown budgets and signals

| Platform | Signal | Grace before SIGKILL | Source |
|---|---|---|---|
| Railway | SIGTERM | **0 s** by default (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`) | [V, paas-ssh §4.1] |
| Fly Machines | **SIGINT** by default (`kill_signal`) | 5 s default, 300 s max (`kill_timeout`) | [V, paas-ssh §5.1] |
| Cloud Run (jobs, pools) | SIGTERM | 10 s | [V, google-azure §3.2] |
| Cloud Run jobs > 1 h | **SIGTSTP** 10 s before a maintenance migration, **SIGCONT** after; paused in between for an undocumented time | — | [V, google-azure §3.2]; duration [U] |
| Heroku | SIGTERM | 30 s | [V, paas-ssh §4.3] |
| Kubernetes pod | SIGTERM | 30 s default | [V, paas-ssh §6.1] |
| ECS / Fargate | SIGTERM | `stopTimeout` 30 s default, 120 s max | [V, aws §4.1] |
| Fargate Spot, EC2 Spot | SIGTERM (+ EventBridge) | 2 min | [V, aws §4.1, §4.8] |
| AWS Batch | SIGTERM | 30 s | [V, aws §4.12] |
| Lambda (default) | none usable: the shutdown phase is 0–2,000 ms, then SIGKILL | stop *inside* the invocation | [V, aws §4.4] |
| Render | SIGTERM | 30 s default, up to 300 s (services). Whether job cancellation uses it: [U] | [V, paas-ssh §4.2] |
| Cloudflare Containers | SIGTERM | up to 15 min | [V, paas-ssh §5.2] |
| systemd unit | `KillSignal=`, SIGTERM by default | `TimeoutStopSec=` | recipe, §7.6 |

The worker cannot learn the grace from the platform. The first-party adapters
pass their platform's default as `BUN_JOBS_SUMMON_GRACE_MS` where they set env,
and the recipe says to set `grace` explicitly otherwise [D]. **Every
first-party worker recipe also tells the user to raise the platform's grace
where it can be raised**: Fly `kill_timeout = 300` with `kill_signal =
"SIGTERM"` [V, paas-ssh §5.1], and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` [V,
paas-ssh §4.1]. A 5-second or 0-second grace against a 5-minute job means the
job is abandoned and recovered as stalled. That is correct, but it is slow and
it runs the job twice.

### 5.3 `drainAndExit`

```ts
/** The environment keys a summon passes, and `summonedFromEnv` reads. */
export const SUMMON_ENV = {
  /** The attempt id; comes back on the heartbeat record. */
  id: "BUN_JOBS_SUMMON_ID",
  /** The summoner's kind. */
  kind: "BUN_JOBS_SUMMON_KIND",
  /** `"launch"`, `"service"` or `"in-handler"`. */
  mode: "BUN_JOBS_SUMMON_MODE",
  /** The namespace to consume. */
  namespace: "BUN_JOBS_NAMESPACE",
  /** The queue to consume. */
  queue: "BUN_JOBS_QUEUE",
  /** The longest the worker may live, as a duration in ms (never a timestamp, §4.6). */
  maxLifetimeMs: "BUN_JOBS_SUMMON_MAX_LIFETIME_MS",
  /** The platform's grace after the stop signal, in ms, when the adapter knows it. */
  graceMs: "BUN_JOBS_SUMMON_GRACE_MS",
} as const;

/** Where a summoned worker came from, as its heartbeat record carries it. */
export interface WorkerSummonProvenance {
  /** The attempt id, when the platform could pass it. */
  id?: string;
  /** The summoner's kind, e.g. `"ecs"`. */
  kind?: string;
  /**
   * The platform's own name for this unit, read from the platform's env where
   * it provides one: `CLOUD_RUN_EXECUTION` on Cloud Run jobs [V~, google-azure
   * §3.2]. Others are unverified and read only when present.
   */
  handle?: string;
  /** The worker mode. */
  mode: "launch" | "service" | "in-handler";
  /** When the worker will stop at the latest, epoch ms, computed by the worker at start. */
  deadlineAt?: number;
}

/**
 * The summon provenance in the environment and argv, or `undefined` when this
 * process was not summoned. Reads {@link SUMMON_ENV} and the matching
 * `--bun-jobs-summon-*=` arguments (for platforms that pass only a command
 * line).
 */
export function summonedFromEnv(
  env?: Record<string, string | undefined>,
  argv?: readonly string[],
): (WorkerSummonProvenance & { namespace?: string; queue?: string; maxLifetimeMs?: number; graceMs?: number }) | undefined;

/** How a summoned worker drains and stops. */
export interface DrainAndExitOptions {
  /**
   * `"launch"` (default): exit once idle for `idleTimeout`. `"service"`: never
   * exit on idle, only on a signal or the deadline, because the platform
   * restarts an exited service. `"in-handler"`: as `"launch"`, but resolve
   * instead of exiting and install no signal handlers, for a Lambda handler
   * that must return with no lease outliving the invocation [I, aws §2].
   */
  mode?: "launch" | "service" | "in-handler";
  /** How long the queue must stay idle (§5.1) before a launch worker exits, in ms. Defaults to `30_000`. */
  idleTimeout?: number;
  /** How often idleness is checked, in ms. Defaults to `5_000`. */
  idleCheckInterval?: number;
  /**
   * The latest the worker may run to, as epoch ms or a function returning it
   * (Lambda: `() => Date.now() + context.getRemainingTimeInMillis()`).
   * Defaults to start + `maxLifetime` from the environment, else none.
   */
  deadline?: number | (() => number);
  /**
   * Stop claiming this long before `deadline`, in ms, so jobs in flight can
   * settle before the platform kills the process. Defaults to `7_000`,
   * Temporal's `shutdownDeadlineBufferMs` [V-plan, aws §2].
   */
  shutdownBuffer?: number;
  /**
   * How long the platform waits after its stop signal before SIGKILL, in ms.
   * After a signal the worker closes with `timeout: grace − 1_000`. Defaults to
   * `BUN_JOBS_SUMMON_GRACE_MS`, else `10_000` (Cloud Run's figure, the
   * shortest common non-zero one).
   */
  grace?: number;
  /**
   * Signals that start a graceful stop. Defaults to `["SIGTERM", "SIGINT"]`:
   * SIGINT because Fly sends it by default [V, paas-ssh §5.1]. `false`
   * installs none. Ignored in `"in-handler"` mode.
   */
  signals?: readonly NodeJS.Signals[] | false;
  /**
   * Treat SIGTSTP as "stop claiming" and SIGCONT as "resume", for Cloud Run
   * jobs over an hour [V, google-azure §3.2]. Defaults to `true` outside
   * `"in-handler"`. Whether catching SIGTSTP delays the platform's pause is
   * unverified [U].
   */
  pauseSignals?: boolean;
  /**
   * Call `process.exit(code)` once closed. Defaults to `true`, except in
   * `"in-handler"` mode. `0` after an idle drain, a deadline or a signal;
   * `1` only when `run()` itself failed. Exit 0 matters: ACI may restart a
   * non-zero exit even under `Never` [V, google-azure §4.4], Fly's default
   * policy restarts on non-zero [V, paas-ssh §5.1], and Railway's does too
   * [V, paas-ssh §4.1].
   */
  exit?: boolean;
  /** Where it logs its decisions. Defaults to the worker's logger. */
  logger?: LoggerLike;
}

/** Why and how a summoned worker stopped. */
export interface DrainExit {
  /** What ended it. */
  reason: "idle" | "signal" | "deadline" | "error";
  /** The signal, when `reason` is `"signal"`. */
  signal?: string;
  /** How long it ran, in ms. */
  ranForMs: number;
  /** Jobs it completed. */
  completed: number;
  /** Attempts it failed. */
  failed: number;
  /** The exit code it used, or would have used in `"in-handler"` mode. */
  code: 0 | 1;
}

/**
 * Runs a worker until it is no longer needed, then stops it cleanly. Starts
 * `worker.run()`, installs the signal handlers, watches idleness and the
 * deadline, and calls `worker.close({ timeout })` exactly once.
 */
export function drainAndExit(
  worker: BunQueueWorker<any, any>,
  options?: DrainAndExitOptions,
): Promise<DrainExit>;
```

The signal path relies on something the worker already does right.
`close()` holds the process open for as long as closing takes, "whatever
`waitToExit` says", precisely so that a caller awaiting it in a signal handler
is not cut off halfway (`BunQueueWorker.ts:1554-1574`) [S]. `close()` also
hands the sweep leases over at once (`:1592-1595`) [S], so the next summoned
worker does not wait out a lease.

### 5.4 Registration, so the guard releases

On `BunQueueWorkerOptions` [D]:

```ts
/**
 * Where this worker was summoned from, written on its heartbeat record as
 * `summon` so the controller can release the attempt and the Workers page can
 * show a badge. Pass `summonedFromEnv()`. Absent for an ordinary worker.
 */
summoned?: WorkerSummonProvenance;
```

On `WorkerInfo` (`drivers/driver.ts:1426`) [D]:

```ts
/**
 * Set when the worker was summoned: the attempt id, the summoner's kind, the
 * platform's handle, the mode and the deadline. Absent on an ordinary worker,
 * and on a record from before this existed.
 */
summon?: WorkerSummonProvenance;
```

The first record is written right after `ensureQueue` (`:1304`), by a report
that is not awaited (`:1322`) [S]. So an attempt is released about one driver
round trip after the summoned worker connects [I, paas-ssh §2].

The recipe:

```ts
// worker.ts: the one file every summoned platform runs
import { BunJobs, drainAndExit, summonedFromEnv } from "@kingsleyweb/bun-jobs";
import { handlers } from "./jobs";

const summon = summonedFromEnv();
const jobs = new BunJobs({ namespace: summon?.namespace ?? "shop", driver: { url: process.env.JOBS_URL! } });
const worker = jobs.worker(summon?.queue ?? "emails", handlers, {
  summoned: summon,          // provenance on the record → the controller releases the attempt
  concurrency: 8,
});
await drainAndExit(worker, { idleTimeout: 30_000 });   // exits the process
```

And for default Lambda, where the worker must live **inside** one invocation
[I, aws §2]:

```ts
export const handler = async (_event: unknown, context: { getRemainingTimeInMillis(): number }) => {
  const worker = jobs.worker("emails", handlers, { summoned: summonedFromEnv() });
  return await drainAndExit(worker, {
    mode: "in-handler",
    deadline: () => Date.now() + context.getRemainingTimeInMillis(),
  });
};
```

Construct the worker in the handler, never at module scope. A worker built
during Init would outlive the invocation into a freeze [V/I, aws §2]. Under
Lambda MicroVMs it would also share its id and lock token across every
restored VM [V, aws §4.7].

---

## 6. The depth endpoint

### 6.1 Why a new route and not `/counts`

`GET /queues/:queue/counts` exists (`api/routes/queues.ts:609-624`, action
`queues.read`) [S]. `paas-ssh.md` §6.2 says it is "already a usable
`metrics-api` source" [R][I, paas-ssh]. `google-azure.md` §1.3 and §6.4 say it
does not suffice [S/I, google-azure]. **The evidence files disagree, and this
plan sides with `google-azure.md`**, for three reasons:

1. `waiting` excludes due delayed jobs, due retries and stalled jobs, which is
   decision 2's blind spot. `paas-ssh.md`'s recipe is correct only for a queue
   that never delays, never retries and never loses a worker.
2. `counts` returns a record by state, so a paused queue still reports
   `waiting`, and KEDA reads exactly one number [V~, google-azure §1.3].
3. On SQL and Mongo, `count()` is a `GROUP BY` over retained history
   (`sql-driver.ts:4302-4313`; `mongo-driver.ts:4277-4287` per [S,
   google-azure]). KEDA polls every 30 s per scaler.

`paas-ssh.md` also raises one point the route must answer. KEDA counts running
*Jobs*, not bun-jobs workers, so a worker started elsewhere does not reduce
KEDA's count [I, paas-ssh §6.2]. That is open question Q12.

### 6.2 Routes [D]

| Method | Path | Action | Answers |
|---|---|---|---|
| `GET` | `/queues/:queue/demand` | `queues.read` | `QueueDemandDto` as JSON. With `?format=prometheus` or `Accept: text/plain`, the exposition below |
| `GET` | `/demand` | `queues.list`, then per queue `queues.read` when `listQueues: "authorized"` | `{ queues: QueueDemandDto[] }`, for `?queues=a,b` or every queue. `?format=prometheus` gives one scrape for the namespace |
| `GET` | `/queues/:queue/summon` | `queues.read` | `SummonStatusDto` (§9.3) |
| `POST` | `/queues/:queue/summon` | **`queues.summon`** (new) | runs `check({ reason: "manual", force: true })`. `409 SUMMON_NOT_CONFIGURED` when no controller runs in the API's process |
| `POST` | `/queues/:queue/summon/reset` | `queues.summon` | `reset()`. It works from any process, since the marker lives in the driver |

`QueueDemandDto` is `QueueDemand` (§4.10) with `queue` added. It lives in the
browser-safe `api/contract/types.ts`, beside `JobCountsDto`.

**Auth.** The scaler sends a bearer, an API key, basic auth or mTLS
[W: keda.sh metrics-api, 2026-09-25]. `createJobsApi` refuses to start
without `authorize` unless `allowUnauthenticated: true` [S, google-azure
§1.3]. It has static `readOnly` and `actions` restrictions
(`api/config.ts:520`, `:562`) [S]. The recipe mounts a
**second** `createJobsApi` for the scaler:

```ts
const scalerApi = createJobsApi({
  jobs, basePath: "/scaler", readOnly: true, actions: ["queues.read"],
  authorize: ({ req }) => req.headers.get("authorization") === `Bearer ${process.env.SCALER_TOKEN}`,
});
```

It can read demand and nothing else. `queues.summon` is a write that spends
money, so it is never in a read-only API. It joins `JOBS_API_ACTIONS` as a
separate action that an operator grants on purpose [D].

### 6.3 Prometheus exposition: worth it

It serves three consumers the JSON cannot:

- KEDA's `metrics-api` scaler accepts `format: prometheus` [W: keda.sh
  metrics-api v2.21, 2026-09-25].
- GKE's native HPA scale-to-zero (GA in 1.37, announced 2026-09-24) reads
  Managed Prometheus [V~, google-azure §3.5].
- CREMA has a verified Prometheus scaler [V~, google-azure §3.3].

It is about 40 lines of text rendering [I]:

```
# TYPE bun_jobs_queue_demand gauge
bun_jobs_queue_demand{ns="shop",queue="emails"} 15
bun_jobs_queue_outstanding{ns="shop",queue="emails"} 16
bun_jobs_queue_waiting{ns="shop",queue="emails"} 12
bun_jobs_queue_due{ns="shop",queue="emails"} 3
bun_jobs_queue_stalled{ns="shop",queue="emails"} 0
bun_jobs_queue_active{ns="shop",queue="emails"} 1
bun_jobs_queue_workers{ns="shop",queue="emails"} 0
bun_jobs_queue_paused{ns="shop",queue="emails"} 0
```

How KEDA's `valueLocation` addresses a Prometheus sample was not confirmed by
the re-read (Q13). This is a metric *source*, not a general metrics exporter.
`opentelemetry.md` owns the latter, and the names here should be checked
against it before 1.5b lands.

### 6.4 `countDemand`: the driver method

```ts
/** On `QueueDriver`. */
/**
 * How much work a worker could claim at `now`, for summoning and the depth
 * endpoint: one bounded read, never a scan of retained history.
 *
 * Optional. Without it `readDemand` falls back to `countJobs`,
 * `nextDelayedAt`, `isQueuePaused` and `listWorkers`, which is correct as a
 * trigger but scans history on some backends. A driver must never count
 * `completed`, `dead` or `failed`-and-exhausted jobs here.
 */
countDemand?: (
  q: QueueRef,
  now: number,
  options: {
    /** Stop counting each figure at this many; the answer then reports `capped`. */
    cap: number;
  },
) => Promise<DemandCounts>;

/** What `countDemand` answers. */
export interface DemandCounts {
  /** Jobs in `waiting`, up to `cap`. */
  waiting: number;
  /** Jobs in `delayed` or `failed` (retry pending) with `runAt <= now`, up to `cap`. */
  dueNow: number;
  /** Jobs in `active` with `lockExpiresAt <= now`, up to `cap`. */
  stalled: number;
  /** Jobs in `active`, up to `cap`. */
  active: number;
  /** The earliest `runAt > now` among delayed and retry-pending jobs, or `null`. */
  nextDueAt: number | null;
  /** Whether any figure reached `cap`. */
  capped: boolean;
}
```

`paused` and `workers` are not part of it. `readDemand` adds them from
`isQueuePaused` and `listWorkerRecords`, which every driver has.

| Driver | Implementation | Cost per call |
|---|---|---|
| **Redis** | One script: `ZCARD wait`; `ZCOUNT delayed -inf now` + `ZCOUNT failed -inf now`; `ZCOUNT active -inf now` (active is scored by `lockExpiresAt` [S, google-azure §1.1]); `ZCARD active`; the first member ≥ now of `delayed` and `failed` for `nextDueAt` | O(log n) per figure, one round trip [I, google-azure §6.4]. No cap needed, but it is honoured for a uniform contract |
| **SQL** (Postgres, MySQL, MariaDB, SQLite) | Four counts, each a range on an existing index prefix: `waiting` on `ix_claim (ns, queue, state, …)`; due on `ix_due (ns, queue, state, run_at)` for `delayed` and `failed`; stalled on `ix_lock (ns, queue, state, lock_expires_at)` [S, google-azure §1.1]. Each is written as `SELECT COUNT(*) FROM (SELECT 1 … LIMIT cap)` | **O(min(matching rows, cap))**, not O(log n). A B-tree range count still walks the range. That is still bounded by the *backlog*, not the retained history, and the cap bounds it absolutely [I]. The plan is [U] until `EXPLAIN`ed (Q10) |
| **Mongo** | `countDocuments` with `limit: cap` on `ns_1_queue_1_state_1_runAt_1` [S, google-azure §1.1] for waiting and due. Stalled and active need a `lockExpiresAt` index. Whether one exists: check in 1.5a | O(min(n, cap)) where indexed [I] |
| **Memory** | Walk the queue's in-heap sets | in-process; irrelevant, since summoning refuses it (§4.9) |
| **File** | The same over its index | one host only |

`cap` defaults to `10_000` in `readDemand` [D]. A scaler targeting "one pod
per 500 jobs" needs no more resolution than that.

**The fallback**, for a third-party driver without `countDemand`
[I, google-azure §6.4]:

```
demand = waiting + (nextDelayedAt ≤ now ? 1 : 0) + (active > 0 && workers == 0 ? active : 0)
```

It is correct as a boolean trigger. It under-counts `dueNow`, and its `countJobs`
may scan history. `QueueDemand.exact = false` says so, and the controller's
poll logs one `warn` naming the driver.

---

## 7. First-party summoners

Every summoner below is a **provider plugin** under `lib/providers/`, built
with `defineComputeProvider` and importing only the public entries, so a third
party could have written it ([`compute-provider-plugins.md`](compute-provider-plugins.md)
§5). The columns of §7.1 are what each declares in its `SummonCapabilities`
(plugins §7.1), not facts the controller knows about platforms. Each is tested
with the published conformance kit against a `fakePlatform()` fake (§11.1).

### 7.1 The order, and why

| # | Summoner | Style | Dedupe | Default `bootBudget` [I] | Why here |
|---|---|---|---|---|---|
| 1 | **ECS `RunTask`**, `./providers/aws` | launch | `clientToken`, per cluster, ≤ 24 h [V, aws §4.1] | 180 s | One adapter covers Fargate, Fargate Spot, ECS Managed Instances and ECS-on-EC2, which differ only in `launchType`/`capacityProviderStrategy` [V, aws §1]. It has the best dedupe of any launch API here. It exercises the SigV4 signer, the largest shared piece |
| 1b | **Lambda `Invoke` (Event)**, same subpath | launch, in-handler worker | **none**; async may deliver twice [V, aws §4.4] | 60 s | About 20 lines once the signer exists [I, aws §1]. Short jobs only (900 s [V]). The in-handler mode is exactly what Temporal shipped [V-plan] |
| 2 | **Fly Machines**, `./providers/fly` | **wake**: start one of a pool of pre-created Machines | Machine id; Machines lease [V, paas-ssh §5.1] | 60 s | Every row verified and favourable: REST start, a vendor-stated sub-second wake, stops on exit, per-second billing [V, paas-ssh §9]. The smallest adapter. It exercises the SIGINT and 5-second grace path |
| 3 | **Cloud Run jobs** and **worker pools**, `./providers/google` | jobs: launch. Pools: **scale** | jobs: **none** [V~]. Pools: idempotent count [I] | 180 s: Direct VPC may add "a minute or more" [V, google-azure §3.2] | Google documents both for this workload [P]. Pools are the first-party scale-style path. Exercises the token helper |
| 4 | **ACA manual jobs**, `./providers/azure` | launch | **none**; the name is platform-generated [V, google-azure §4.2] | 180 s | For immediacy on Azure. **The recommended Azure path is ACA event jobs on the depth endpoint (§2.2)**, which needs no summoner |
| 5 | **Render one-off jobs**, `./providers/render` | launch | **none** [V, paas-ssh §4.2] | 180 s | The nicest PaaS launch API. Bun is native, and the base can be the existing web service [V, paas-ssh §4.2] |
| 6 | **SSH + `systemd-run`**, `./providers/ssh` | launch on a host | fixed unit name [M, paas-ssh §4.4] | 60 s | Serves "I already have a box". It ships last because it alone adds a system dependency and a security surface [I, paas-ssh §9] |

The evidence rankings put Fly first on PaaS [I, paas-ssh §9], ECS first on AWS
[V/I, aws §1], and Cloud Run jobs, then worker pools, first on Google
[I, google-azure §0.1]. The order across files is this plan's own [D]:

- ECS first, because the signer is the biggest shared cost, and the more
  users sit behind it, the sooner it is proven.
- Fly second, because it is the cheapest adapter and has the best fit.
- Google and Azure next, because they share the token helper.
- Render, then SSH.

**Behind `defineSummoner({ invoke })`, as documented recipes, or as
third-party provider plugins** (sketches exist in the evidence). Each is a
candidate for the "provider written outside the bun-jobs session" that the
summon facet's stability gate needs ([`compute-provider-plugins.md`](compute-provider-plugins.md) §10.4):

- EC2 `RunInstances` with terminate-on-shutdown [V, aws §4.8], and ASG
  `SetDesiredCapacity` [V, aws §4.10].
- AWS Batch (no token [V, aws §4.12]).
- Kubernetes Job with a deterministic name, for EKS, GKE, AKS and
  self-hosted clusters [V/U, paas-ssh §6.1; aws §4.11].
- Heroku one-off dynos (sustaining engineering [V, paas-ssh §4.3]).
- Nomad dispatch (`idempotency_token` [V, paas-ssh §6.3]).
- Northflank job runs [V, paas-ssh §5.5].
- Cloudflare Containers via a user-deployed Worker shim [I, paas-ssh §5.2].
- Compute Engine insert or MIG resize with `requestId` [V~, google-azure
  §3.4].
- Cloud Batch [V, google-azure §3.4].
- ACI [V, google-azure §4.4].
- Lambda MicroVMs, once their endpoint is known [U, aws §4.7].

**Railway** waits until someone confirms that `deploymentRestart` works on a
Completed deployment [U, paas-ssh §4.1].

**Unsuitable, and the README says so:**

- App Runner is closed to new customers [V, aws §4.13].
- Elastic Beanstalk worker environments and Lightsail [V/I, aws §4.14–4.15].
- LMI as a summon *target*: a three-environment floor by default [V, aws §4.5].
- Lambda durable functions [V/I, aws §4.6].
- DigitalOcean App Platform and Koyeb [V, paas-ssh §5.3–5.4].
- Azure Functions as the worker [P, google-azure §0.1].
- Request-based Cloud Run services [V~, google-azure §3.1].
- App Engine standard [V~, google-azure §3.1].

### 7.2 ECS `RunTask` (and Lambda)

- **Fit** [V, aws §4.1]:
  - The task runs to completion and never freezes.
  - Per-second billing with a 1-minute minimum.
  - `clientToken` ≤ 64 characters, idempotent per cluster, TTL ≤ 24 h. The
    same token with different parameters is a `ConflictException`, whose
    `resourceIds` name the existing tasks.
  - Env overrides are limited to 8,192 characters in total.
- **Two traps in the response**:
  - A `200` carrying only `failures` (capacity) is a failure [V, aws §7 item
    6]. It maps to `unavailable`.
  - `ConflictException` maps to `deduped`. The `__type` error-body shape is
    [U, aws §4.1] until the first live call.
- **Shutdown**: SIGTERM, then `stopTimeout` (30 s default, 120 s max)
  [V, aws §4.1]. The adapter sets `BUN_JOBS_SUMMON_GRACE_MS` from its
  `stopTimeout` option.
- **Quotas that bite first**: Fargate On-Demand vCPU is **6** on a new account
  [V, aws §1 item 4]. `RunTask` burst is 100, refilling 40/s [V, aws §4.1].
- **Sketch**: `aws.md` §4.1, verbatim apart from two changes. `r.dedupeKey`
  becomes `request.dedupeKey`, and the env list becomes `request.env` mapped to
  `{ name, value }` pairs.

```ts
/** Starts an ECS task per attempt: Fargate, Fargate Spot, Managed Instances or EC2 capacity. */
export function ecsRunTask(options: {
  /** The AWS region, e.g. `"eu-west-1"`. */
  region: string;
  /** The cluster name or ARN. Idempotency tokens are scoped to it. */
  cluster: string;
  /** The task definition (`family:revision` or ARN) whose container runs `drainAndExit`. */
  taskDefinition: string;
  /** The container in it that receives the env overrides. */
  container: string;
  /** Subnets for `awsvpc`: put them in the database's VPC. */
  subnets: string[];
  /** Security groups that may reach the driver's datastore. */
  securityGroups: string[];
  /** `"FARGATE"` (default), `"FARGATE_SPOT"`, or a capacity provider name. */
  capacity?: string;
  /** Whether the task gets a public IP, for a subnet with no NAT. Defaults to `false`. */
  assignPublicIp?: boolean;
  /** The task definition's `stopTimeout`, in ms, passed to the worker as its grace. Defaults to `30_000`. */
  stopTimeout?: number;
  /** Where credentials come from. Defaults to the chain in §8.1. */
  credentials?: AwsCredentialSource;
  /** The API origin, for tests and non-standard partitions. Defaults to `https://ecs.<region>.amazonaws.com`. */
  endpoint?: string;
  /** Overrides the default `bootBudget` of `180_000` ms. */
  bootBudget?: number;
}): Summoner;
```

`lambdaInvoke({ region, functionName, qualifier?, credentials?, endpoint?,
bootBudget? })` follows `aws.md` §4.4. It uses the function **name**, never an
ARN, until the path-encoding question is closed (§8.1). Two failures have
specific meanings:

- An `Inactive` function's failed invoke becomes `unavailable` with
  `retryAfterMs: 30_000` [V, aws §4.4].
- A `202` becomes `started` with the `x-amzn-requestid` header as its handle.
  That header name is [U].

The README tells the user to set the function's async retries to 0 [V/U,
aws §4.4].

### 7.3 Fly Machines

Sketch: `paas-ssh.md` §5.1. Walk a **pool of pre-created Machines**:

- `started` → `already-running`.
- `stopped` or `suspended` → `POST …/start` → `started`.
- `429` → next Machine.
- Pool exhausted → `unavailable`.

The pool size is the concurrency ceiling by construction [I, paas-ssh §5.1].
`passes: "none"`: Machine env is fixed at create, and per-start overrides are
[U] (Q27). So attempts release by start time (§4.3), and
`summonedFromEnv()` reads `FLY_MACHINE_ID` as the handle *when present*. That
variable name is [U].

- **Rate limits**: 1 request per second per action per Machine, burst 3
  [V, paas-ssh §5.1].
- **Recipe musts**: `kill_signal = "SIGTERM"` or keep the default SIGINT
  handler, `kill_timeout = 300`, no `services` block (so Fly Proxy never
  auto-stops it) [V/I, paas-ssh §5.1], and exit 0 on a drain (the default
  restart policy restarts only non-zero exits) [V, paas-ssh §5.1].

### 7.4 Cloud Run jobs and worker pools

**Jobs.** Sketch in `google-azure.md` §3.2. It calls `POST …/jobs/{job}:run`
with `overrides.containerOverrides[].env` and `taskCount` [V~].

- There is no dedupe, so the marker is the whole guard [V~, google-azure
  §3.2]. The adapter also pre-checks `latestCreatedExecution.completionStatus`
  and answers `already-running` for `EXECUTION_RUNNING` or
  `EXECUTION_PENDING` [V~]. That check is racy across controllers, but the CAS
  already serialised us [I].
- `request.maxLifetimeMs` maps to the per-execution `timeout` override. It must
  stay ≤ 168 h [V].
- Quota: 180 job runs per 60 s per project and region [V].

**Worker pools** use `style: "scale"`. `PATCH …/workerPools/{p}` sets
`scaling.manualInstanceCount = target`, and `0` disables the pool
[V/V~, google-azure §3.3]. The `updateMask` path string is [U] (Q17).
`summon()` sets the count to `target`, and `release()` sets it to 0 after
`scaleDown.after` (§4.7). The worker runs `drainAndExit({ mode: "service" })`.

### 7.5 ACA manual jobs

Sketch in `google-azure.md` §4.2. It calls
`POST …/Microsoft.App/jobs/{job}/start?api-version=2026-07-01` with **no
body**. The response is `200 { name, id }` or `202` with a `Location` header
[V].

- **Do not send per-execution env.** An override replaces the job's entire
  template, secrets included [V]. So `passes: "none"`, and attempts release by
  start time.
- **Scope the summoner's identity to exactly one job.** "An identity that can
  start a job can use an execution template to reference job secrets whose
  names it knows" [V, google-azure §4.2]. The README must say this plainly:
  that identity can read the worker's database credentials.

### 7.6 Render one-off jobs

Sketch in `paas-ssh.md` §4.2. It calls `POST /v1/services/{id}/jobs` with a
`startCommand`.

- There is no env override, so the attempt travels in `request.argv`
  (`--bun-jobs-summon-id=…`), and `summonedFromEnv()` reads argv
  [V/I, paas-ssh §4.2].
- `429` becomes `unavailable` with `retryAfterMs` from `Ratelimit-Reset`. The
  limit is 100/min for `POST /v1/jobs` [V].
- Gotcha for the README: the job runs the base service's **last successful
  build**, and the env as it was when the job was created [V/I, paas-ssh
  §4.2].

### 7.7 SSH via `systemd-run`

Sketch in `paas-ssh.md` §7.5. It checks `Bun.which("ssh")` at construction
and throws a `ConfigError` if it is missing [I, paas-ssh §7.1].

- **Pinned options**: `BatchMode=yes`, `StrictHostKeyChecking=yes`, a
  bun-jobs-owned `UserKnownHostsFile` written from a configured `hostKey`,
  `IdentitiesOnly=yes`, `ConnectTimeout=10`, and optional `ControlMaster` on
  POSIX [V, paas-ssh §7.3].
- **Remote command**: `systemd-run --user --unit=bun-jobs-<ns>-<queue>
  --collect -p RuntimeMaxSec=<maxLifetime> -E BUN_JOBS_SUMMON_ID=… /abs/bun
  worker.ts`.
- **Answers**: a second start fails with "already loaded", exit 1 [M,
  paas-ssh §4.4]. That maps to `already-running`. Exit 255 maps to `failed`
  [V, paas-ssh §7.1].
- **Server posture**: the recipe ships the `restrict,from=…,command=…` line for
  `authorized_keys` and the 10-line `bun-jobs-summon` script. With them, a
  leaked key can only start workers [V/I, paas-ssh §7.4].
- **Host choice**: round-robin, or the host with the fewest live workers by
  `WorkerInfo.host` [I, paas-ssh §7.6].
- **Must not** default to `StrictHostKeyChecking=accept-new` [I, paas-ssh
  §7.3].
- **Queue names cross a remote shell.** The adapter validates them against
  `^[a-z0-9._-]{1,64}$` [I, paas-ssh §7.5].

---

## 8. Credentials without SDKs, and packaging

### 8.1 AWS: SigV4 plus a credential chain

- **Signer**: `crypto.subtle` HMAC-SHA256 and SHA-256. The sketch is 36 lines.
  Against the AWS signing test suite it **matched 5 vectors**: `get-vanilla`,
  `post-x-www-form-urlencoded`, `get-vanilla-query-order-key-case`,
  `get-vanilla-query-unreserved` and `get-vanilla-with-session-token`. It
  **differed on 2**: `get-utf8` and `get-space-normalized` [M, aws §5.2]. The
  differing pair feed a raw, unencoded path, and the sketch double-encodes the
  path `fetch` sends. AWS documents that for non-S3 services [V/U, aws §5.4].
  **One live `Invoke` by ARN settles it** (Q2). Until then the adapters use
  names, so every path is plain ASCII [I, aws §5.4].
  - The signer matches **5 of the 7** vectors its harness runs (Q3, **resolved 2026-09-25:** re-running the harness independently gave 5 matches out of the 7 vectors it runs; `aws.md` §1 now says so).
- **One algorithm** covers JSON 1.1 (ECS), REST-JSON (Lambda) and Query (EC2,
  STS) [V, aws §5.1].
- **Credential chain**, 36 lines: env vars, the ECS task role, EKS Pod
  Identity, IMDSv2, IRSA (unsigned STS) and `AssumeRole`. It compiles and
  **has not been run against AWS** [M/U, aws §5.3].
- **What a real implementation adds** [I, aws §5.3]:
  - clock-skew retry;
  - backoff on `ThrottlingException`;
  - XML error parsing for Query APIs;
  - a credential cache that refreshes five minutes before expiry.
- **Cross-account** copies Temporal: a role trusted with an `ExternalId`
  condition [V-plan, aws §7 item 14].
- **Where it lives**: `lib/provider/auth/sigv4.ts` and
  `lib/provider/auth/aws-credentials.ts`. Both are **public**, from
  `./provider/auth`, as `signAwsRequest` and `resolveAwsCredentials`, for
  plugin authors and for users writing their own `invoke()` against another AWS
  API. Being public makes them API: they freeze with the plugin core at 1.0,
  which waits on Q2 ([`compute-provider-plugins.md`](compute-provider-plugins.md) §6.4, §10.4) [D].

### 8.2 Google and Azure: one token helper

`getGoogleToken()` and `getAzureToken()` together are **65 non-blank,
non-comment lines**, including a 5-minute-skew cache, and 2,608 bytes minified
[M, google-azure §2.3]. What has been checked:

- The Google RS256 path signs a JWT under Bun 1.4.3 WebCrypto that verifies
  with `openssl` [M].
- It typechecks under `--strict` [M].
- **It has never been sent to either cloud's token endpoint** [U].

Sources it reads:

- **Google**: a service-account key (JWT bearer), or the metadata server.
- **Azure**: a client secret, a federated assertion (AKS workload identity via
  `AZURE_FEDERATED_TOKEN_FILE`), ACA's `IDENTITY_ENDPOINT`, or IMDS
  [V/V~, google-azure §2.1–2.2].

Google Workload Identity Federation is **not** in the 65 lines. It adds about
15 lines, plus SigV4 for an AWS subject [I, google-azure §2.3], and is
deferred.

Where it lives: `lib/provider/auth/jwt.ts` (base64url and RS256 signing,
shared), `google-token.ts` and `azure-token.ts`, all public from
`./provider/auth` as `getGoogleToken`, `getAzureToken` and `signJwtRs256`, on
the same terms as the AWS helpers (Q15 must close before the core's 1.0).

### 8.3 Nothing new in `dependencies`

Every provider uses only `fetch`, `crypto.subtle`, `TextEncoder`,
`process.env` and, for SSH, `Bun.spawn` and `Bun.which`. So no provider adds
a `dependency` or a `peerDependency`, and `checkPeerScopes` has nothing to
check. That is the outcome `worker-runtimes.md` §6.2 aimed for, and it is
cheaper here because summoners are server-side (no browser entry to protect).

### 8.4 The exact `package.json` shape

**One subpath per provider, not one `./summoners` entry** [D]. The subpaths
are named for the **provider**, `./providers/<name>`, not for summoning,
because a provider may carry both facets: AWS's entry holds `ecsRunTask` and
`lambdaInvoke` to summon, and later `lambdaExecute` to carry remote attempts
([`compute-provider-plugins.md`](compute-provider-plugins.md) §11.1). The
reasons for one per provider:

- Importing `./providers/fly` should not load the SigV4 signer, the JWT code or
  `Bun.spawn`. Bun runs `lib/` as source, so there is no tree-shaking at run
  time. (The credential helpers live in `./provider/auth`, which the Fly
  provider does not import.)
- The SSH provider's system dependency stays behind a spelling that says
  what it is.
- A provider's docs, its `consumer-check.json` entry, its fake platform and its
  conformance run map one to one.

Providers are **files**, not directories: `lib/providers/<provider>.ts`. That
matters because the packaging test requires an explicit `./lib/<dir>` key for
**every directory with an `index.ts`** (`__tests__/packaging.test.ts:46-56`,
`:92`) [S]. Files need only their short key. The existing `./lib/*.ts`,
`./lib/*.js` and `./lib/*` patterns already cover the long spellings. The new
directories with an index are `lib/summon/` here, and `lib/provider/`,
`lib/provider/auth/` and `lib/provider/testing/` from the plugin API (plugins
§11.1), each with its `./lib/…` key.

```jsonc
{
  "exports": {
    ".": { "@kingsleyweb/source": "./lib/index.ts", "types": "./dts/index.d.ts", "default": "./lib/index.ts" },
    "./api/contract": { "...": "unchanged" },

    // New: the core (also re-exported from the root). A directory with an index,
    // so it takes both a short key and its `./lib/…` key.
    "./summon": {
      "@kingsleyweb/source": "./lib/summon/index.ts",
      "types": "./dts/summon/index.d.ts",
      "default": "./lib/summon/index.ts"
    },
    // New, from the plugin API (compute-provider-plugins.md §11.1): same shape.
    "./provider":         { "...": "same shape → ./lib/provider/index.ts" },
    "./provider/auth":    { "...": "same shape → ./lib/provider/auth/index.ts" },
    "./provider/testing": { "...": "same shape → ./lib/provider/testing/index.ts" },

    "./providers/aws": {
      "@kingsleyweb/source": "./lib/providers/aws.ts",
      "types": "./dts/providers/aws.d.ts",
      "default": "./lib/providers/aws.ts"
    },
    "./providers/google": { "...": "same shape → ./lib/providers/google.ts" },
    "./providers/azure":  { "...": "same shape → ./lib/providers/azure.ts" },
    "./providers/fly":    { "...": "same shape → ./lib/providers/fly.ts" },
    "./providers/render": { "...": "same shape → ./lib/providers/render.ts" },
    "./providers/ssh":    { "...": "same shape → ./lib/providers/ssh.ts" },

    "./lib": { "...": "unchanged" },
    "./lib/api": { "...": "unchanged" },
    "./lib/api/contract": { "...": "unchanged" },
    "./lib/drivers": { "...": "unchanged" },
    "./lib/queue": { "...": "unchanged" },
    "./lib/runner": { "...": "unchanged" },
    "./lib/summon": {
      "@kingsleyweb/source": "./lib/summon/index.ts",
      "types": "./dts/summon/index.d.ts",
      "default": "./lib/summon/index.ts"
    },
    "./lib/provider":         { "...": "same shape → ./lib/provider/index.ts" },
    "./lib/provider/auth":    { "...": "same shape → ./lib/provider/auth/index.ts" },
    "./lib/provider/testing": { "...": "same shape → ./lib/provider/testing/index.ts" },
    "./lib/*.ts": { "...": "unchanged" },
    "./lib/*.js": { "...": "unchanged" },
    "./lib/*": { "...": "unchanged" },
    "./package.json": "./package.json"
  }
}
```

Every entry uses the order `@kingsleyweb/source`, `types`, `default`, and no
entry is a fallback array (`CLAUDE.md`). `lib/summon/**`, `lib/provider/**`
and `lib/providers/**` sit under `rootDir: lib`, so
`scripts/build-declarations.ts` covers them unchanged, including its "every
`lib` module has a declaration" check.

`consumer-check.json` gains one entry per new spelling. **None is `"browser":
true`**: they read `process.env` and run under Bun. None lists `"peers"`. The
`./provider*` entries, including a snippet that writes a provider against the
packed tarball, are in plugins §11.1:

```jsonc
{ "spelling": "@kingsleyweb/bun-jobs/summon",
  "values": ["SummonController", "defineSummoner", "drainAndExit", "summonedFromEnv", "SUMMON_ENV"],
  "types": ["SummonPolicy", "Summoner", "SummonRequest", "SummonResult", "QueueDemand", "DrainAndExitOptions"] },
{ "spelling": "@kingsleyweb/bun-jobs/providers/aws",    "values": ["ecsRunTask", "lambdaInvoke"] },
{ "spelling": "@kingsleyweb/bun-jobs/providers/google", "values": ["cloudRunJob", "cloudRunWorkerPool"] },
{ "spelling": "@kingsleyweb/bun-jobs/providers/azure",  "values": ["acaJob"] },
{ "spelling": "@kingsleyweb/bun-jobs/providers/fly",    "values": ["flyMachines"] },
{ "spelling": "@kingsleyweb/bun-jobs/providers/render", "values": ["renderJob"] },
{ "spelling": "@kingsleyweb/bun-jobs/providers/ssh",    "values": ["sshSystemdRun"] }
```

`signAwsRequest`, `getGoogleToken` and `getAzureToken` moved to the
`./provider/auth` entry (§8.1, §8.2).

The root spelling's `values` gain `SummonController` and `drainAndExit`. Each
new cell set joins bun-jobs' existing 96/96 [per `CLAUDE.md`].

---

## 9. Observability and UI

### 9.1 Events

**One new queue event type, `summon`** [D], with a payload of
`{ id, outcome: SummonOutcomeKind, kind, count?, handles?, reason?, detail? }`.
It is published through the driver like the others (`BunQueue.#publish`,
`BunQueue.ts:2879`) [S] and emitted locally on the controller.

- Why a queue event and not a worker event: an attempt has no worker yet.
  `worker-runtimes.md` §8.4's rule (no remote-specific worker event types)
  still holds.
- It adds one member to `QUEUE_EVENT_TYPES` (`api/contract/constants.ts:230`)
  [S]. That changes the AsyncAPI document and the UI's event filters, which is
  the UI session's side of 1.5f.

The controller also logs every outcome, at these levels:

- `info`: `started` and `registered`.
- `warn`: `lost`, `unavailable` and `budget-exhausted`.
- `error`: `failed` and circuit-open.

It logs through the structured `Logger` (`logger.warn("…", { queue, id, kind
})`).

### 9.2 The worker record

`WorkerInfo.summon` (§5.4) is the "summoned" provenance. The Workers page
shows:

- a badge naming the kind (`ecs`, `fly`);
- the platform handle, shown only behind the existing `exposeHosts`-style
  switch, because a task ARN is infrastructure;
- the deadline.

A summoned worker is otherwise an ordinary worker. The Phase 0
`WorkerController` pauses, stops and reconfigures it like any other, and
analytics, limits and events are unchanged.

### 9.3 What the UI needs from the API

| Need | API | Owner |
|---|---|---|
| demand on the queue screen | `GET /queues/:queue/demand` (§6.2) | the bun-jobs session |
| summon status: pending attempts, failures, backoff, circuit, budget, last outcome, summoner facts | `GET /queues/:queue/summon` → `SummonStatusDto` | the bun-jobs session |
| the provider behind the summoner: name, version, `apiVersion`, declared capabilities, an experimental badge, "Test connection" | `SummonStatusDto.summoner.provider` and `.capabilities`; `GET /providers`; `POST /providers/:id/validate` (action `providers.validate`) ([`compute-provider-plugins.md`](compute-provider-plugins.md) §14) | the bun-jobs session (routes, DTO); the UI session (card, badge, button) |
| a "Summon now" button, and "Reset" when the circuit is open | `POST …/summon`, `POST …/summon/reset`, gated on `queues.summon` | the bun-jobs session (routes); the UI session (buttons) |
| the badge and handle on the Workers page and worker screen | `WorkerDto.summon` | the bun-jobs session (DTO); the UI session (render) |
| the `summon` events in the event feed and filters | `QUEUE_EVENT_TYPES` + AsyncAPI | the bun-jobs session (contract); the UI session (filters) |
| the element-rules table | `packages/bun-jobs-ui/README.md` `### What each element needs`, parsed by `examples/bun-jobs-ui/04-screens/permissions.ts` (`CLAUDE.md`) | the UI session writes the rows; **the examples session must be told before merge** |
| an example per first-party summoner, run against a fake platform (§11) | `examples/bun-jobs/` | the examples session |

`SummonStatusDto` mirrors `SummonStatus` (§4.10). `summoner.facts` comes only
from `describe()`, which the contract says is secret-free. The serializer
additionally drops any fact whose key matches `/token|secret|key|password/i`,
as a belt-and-braces guard [D].

### 9.4 What the UI cannot know

- **Whether the platform actually started anything** after `started`, until
  the record appears. The UI shows `pending (started 40 s ago, lost after
  180 s)`, not "running".
- **Why a lost attempt was lost.** The worker never reported, so bun-jobs has
  no logs from it. The UI links the handle to nothing, and says "check the
  platform's logs for `<handle>`".
- **Platform-driven summons (model b).** KEDA's decisions are invisible to
  bun-jobs, apart from the workers they produce, which carry no `summon.id`.
  The UI shows the demand the scaler reads, and nothing about the scaler.

---

## 10. Cost

### 10.1 One worker draining for 5 minutes

Arithmetic from the evidence files. Every figure is [I] on [V] list prices read
2026-09-25, in USD, before free tiers.

| Platform | Shape | 5 min | Minimum bill | Source |
|---|---|---|---|---|
| Fargate x86 | 1 vCPU / 2 GB | $0.0041 | 1 min; image pull billed | aws §6 |
| Fargate Arm | 1 vCPU / 2 GB | $0.0033 | 1 min | aws §6 |
| Fargate Spot | 1 vCPU / 2 GB | ≥ $0.0012 ("up to 70%") | 1 min | aws §6 |
| Lambda x86 / Arm | 2,048 MB | $0.0100 / $0.0080 | 1 ms | aws §6 |
| Lambda MicroVM (Arm) | 1 vCPU / 2 GB | $0.0105 | [U] | aws §6 |
| EC2 t4g.small / c7g.large | 2 vCPU | $0.0014 / $0.0060 | 60 s + boot | aws §6 |
| Cloud Run job (us-central1) | 1 vCPU / 0.5 GiB | ≈ $0.0057 | 1 min | google-azure §7 |
| Cloud Run worker pool | 1 vCPU / 0.5 GiB | ≈ $0.0036 | [U] | google-azure §7 |
| Cloud Run delayed job | 1 vCPU / 0.5 GiB, deferred ≤ 12 h | ≈ $0.0040 | 1 min | google-azure §7 |
| ACA job (eastus) | 0.5 vCPU / 1 GiB · 1 vCPU / 2 GiB | ≈ $0.0045 · ≈ $0.0090 | none stated | google-azure §7 |
| ACI (eastus) | 1 vCPU / 1 GB | ≈ $0.0037 | [U] | google-azure §7 |
| Fly shared-cpu-1x | 512 MB · 1 GB | $0.00038 · $0.00068 | per second | paas-ssh §8 |
| Render job | Starter · Standard | $0.0008 · $0.0029 | per second | paas-ssh §8 |
| Heroku one-off | Basic · Standard-1X | $0.0008 · $0.0029 | per second | paas-ssh §8 |
| Railway | 0.5 vCPU + 0.5 GB average use | $0.0017 | per minute | paas-ssh §8 |
| Cloudflare Containers `basic` | ¼ vCPU / 1 GiB | ≤ $0.0023 | per 10 ms | paas-ssh §8 |
| SSH to your own host | — | $0 | — | paas-ssh §8 |

**Every summoned drain costs about a cent or less on every platform**
[I, all three files]. Two things decide the bill instead:

- **How fast the worker exits once drained.** `idleTimeout` is the dominant
  knob [I, paas-ssh §8]. At Fargate x86 rates, a 30 s idle tail adds ≈ $0.0004
  per summon.
- **The standing costs below.**

### 10.2 The standing costs that actually dominate

| Item | Cost | Tag | When you pay it |
|---|---|---|---|
| Lambda Managed Instances floor | 3 execution environments by default. Three m7g.large at +15% ≈ **$205/month** (instance types are Lambda's choice) | [V] floor; [I] $ (aws §4.5, §6) | if LMI were chosen as a target: it should not be |
| EKS control plane | $0.10/h ≈ **$73/month** per cluster | [V] price; [I] arithmetic (aws §6) | a Kubernetes-Job summoner or KEDA on EKS |
| GKE cluster fee | $0.10/cluster/hour, one cluster free | [V] (google-azure §3.1) | KEDA or HPA on GKE |
| CREMA | an always-on Cloud Run service. **≈ $49/month** if sized 1 vCPU / 0.5 GiB (its real size is [U]) | [V~] always-on; [I] $ (google-azure §7) | Cloud Run worker pools driven by a platform |
| ACA "Environment Management Hour" | $0.10/h effective 2026-09-01 (≈ $73/month [I]); **when it applies is [U]** | [V] meter (google-azure §4.2) | possibly any ACA environment |
| Fly pool disks | $0.15/GB/30 days per stopped Machine (≈ $0.08/month for 0.5 GB [I]); static egress IP $3.60/month if needed | [V] (paas-ssh §5.1, §8) | the Fly summoner's pool |
| Scheduler polling (model c), Google | Cloud Scheduler $0.10/job/31 days, 3 jobs free; Workflows checker ≈ $2.5–6.4/month at one check a minute | [V] prices; [I] arithmetic (google-azure §3.6) | model (c) on Google |
| Scheduler launching the worker itself | ≈ $9.85/month at every 5 min on Cloud Run jobs before the free tier (≈ $5 after); ≈ $0.0008 per empty Fargate tick | [I] (google-azure §3.6; aws §8) | the zero-code fallback |
| Lambda as the model (c) checker | 43,200 invocations a month at one a minute: ≈ $0.009 in requests plus ≈ $0.018 in duration at 128 MB for 200 ms | [I] on [V] prices (aws §4.4); EventBridge Scheduler's own price is [U] | model (c) on AWS |
| PaaS subscriptions | Railway Hobby $5 / Pro $20 a month, usage included; Render's workspace fee [U] | [V] (paas-ssh §4.1, §8) | Railway, Render |

The cheapest standing arrangement is model (a), running in a process that
already exists. It costs $0. Model (b) on ACA event jobs costs $0 unless the
management meter applies. Model (c) costs cents a month. Everything else in
this table is an **always-on thing somebody chose**, and the README should
say which choice incurs which line.

---

## 11. Testing

### 11.1 No cloud credentials in `bun test`

**Tier 1: in-repo, always run.** It needs no network beyond loopback.

- **A fake platform.** `__tests__/helpers/summon.ts` provides
  `fakePlatform({ coldStartMs, fail?, neverRegister?, crashAfterMs?, passes,
  style })`, a real `Summoner`. On `summon()`, after `coldStartMs`, it
  `Bun.spawn`s `bun __tests__/fixtures/summoned-worker.ts` with
  `request.env`. That fixture runs `drainAndExit` against a **shared** driver.
  - Which driver: SQLite or file on one host, and Redis or Postgres when their
    URLs are set, skipping visibly under the repo's existing rule.
  - Failure injection: throws, `unavailable`, a start that never registers, a
    worker that crashes holding a job, and a slow boot longer than
    `bootBudget`.
- **Controller tests**:
  - one summon per backlog, not per job, across a 5,000-job `addBulk`;
  - no summon while a running worker is live;
  - no summon for a paused queue;
  - **a delayed job coming due with zero workers summons**, on the poll;
  - a retry coming due summons;
  - **an orphaned active job summons**, and its worker waits out the lock and
    the sweep lease before exiting (§5.1);
  - a slow cold start within `bootBudget` does not summon twice;
  - one past `bootBudget` is `lost` and backs off;
  - two controllers in two processes racing produce one attempt (the CAS);
  - failures open the circuit;
  - the budget stops summoning without failing a job;
  - a scale-style summoner is released only after `outstanding` has been 0 for
    `scaleDown.after`;
  - a controller in a summoned process is inert;
  - requests are byte-identical for one attempt id (§4.6).
- **`drainAndExit` tests**, in a child process so that signals are real:
  - exits 0 on idle;
  - on SIGTERM, closes within `grace` and exits 0;
  - on **SIGINT**, the same (Fly);
  - stops claiming at `deadline − shutdownBuffer`;
  - `in-handler` resolves and leaves no timer or lease behind;
  - SIGTSTP pauses claiming and SIGCONT resumes it;
  - a `run()` that fails to connect exits 1.
- **`countDemand` in the driver contract suite**, on every driver: exact
  figures on a seeded queue, `capped` at the cap, paused ignored (the caller
  adds it), and no counting of `completed` or `dead`.
- **Provider tests with the published conformance kit**, one per first-party
  provider. Each provider's stub is a `FakePlatform` built with
  `fakePlatform()` on port 0, and its test is `assertConformance(await
  runProviderConformance(…))` plus the cases below, so first-party providers
  pass exactly the checks a third party's must ([`compute-provider-plugins.md`](compute-provider-plugins.md)
  §12). The fakes ship in `./provider/testing` as worked examples. The
  fixture worker and the fake platform above move there too, so the kit's
  end-to-end handoff check is this tier's. Each fake asserts the request shape
  and maps every documented answer:
  - **ECS** (JSON 1.1): `x-amz-target`, a signed `content-type`,
    `clientToken` = `dedupeKey`. It answers `tasks`, `failures`-only and
    `ConflictException`.
  - **Lambda**: `202`, and the inactive-function failure.
  - **Cloud Run**: `GET` job plus `:run`, and the worker-pool `PATCH` with
    `updateMask`.
  - **Google token endpoint**: verifies our RS256 JWT with the matching public
    key through WebCrypto.
  - **Azure token and ACA start**: `200` and `202` with `Location`.
  - **Fly**: a Machine state machine, including `429`.
  - **Render**: `201`, and `429` with `Ratelimit-Reset`.

  Every adapter takes an `endpoint` override for this. The same override
  serves sovereign and partner partitions [D].
- **The signer against AWS's own vectors**: the five that match must keep
  matching. The two path vectors are recorded as a known difference until
  Q2 closes. A self-consistency test (sign with our signer, verify with our
  signer) proves nothing and is not written (the lesson of
  `worker-runtimes.md` §7.3).
- **Randomised**: the new suites must pass under `bun test --randomize`, like
  the rest.

**Tier 2: a real host, skipped visibly.**

- **systemd**: `systemd-run --user --unit=…` against the local user manager.
  It is available where the evidence measured it (systemd 259 [M, paas-ssh
  header]). This tests the unit-name dedupe and `--collect` for real.
- **SSH**: `ssh localhost` only when an sshd answers. The evidence machine had
  none [M, paas-ssh §4.4], which is exactly why this skips rather than fails.
- **KEDA**: a `kind` cluster with KEDA's `metrics-api` scaler reading the
  demand endpoint, and a ScaledJob starting the fixture worker. It is
  worth one manual run per release. It is not in `bun test`: its tooling goes
  in an unpublished package, like `bench/` (`worker-runtimes.md` §7.2).

**Tier 3: live platforms, by hand, before the release that ships each
adapter.** This is a script under an unpublished `packages/bun-jobs/e2e/`. For
each first-party summoner it makes one real summon against a small queue and
records:

- whether the documented answers match (the [U] error shapes);
- **time-to-first-claim, three runs**. No figure exists for any platform
  (Q1, Q14);
- that the worker exits 0 and the platform stops billing.

It costs cents per platform (§10.1). The checks that are worth this money:

- ECS by name and Lambda by **ARN** (closes Q2);
- the Cloud Run and Azure token paths (closes Q15);
- Fly `start` on a started Machine (closes Q27);
- Render cancel semantics (Q24).

### 11.2 The benchmark guard

`bench/queue.ts --compare` runs with a controller attached (§4.8), and the
existing six scenarios must not move. No new scenario is proposed. The
controller is off the claim, settle and limit paths entirely, and its only
hot-path presence is one listener on `add()`.

---

## 12. Risks and open questions

### 12.1 Carried from the evidence files

Each item is attributed to the file that raised it. None is closed by this
plan unless it says so.

**From `aws.md`** (§"Open items", §5.4, and [U] rows):

1. **Q1** Time-to-first-claim for Fargate (small `oven/bun` image) and for a
   Bun Lambda container image. No AWS figure exists.
2. **Q2** SigV4 canonical-path encoding. The 2 failing vectors (`get-utf8`,
   `get-space-normalized`), and whether double-encoding is right for Lambda
   ARNs. One live `Invoke` by ARN settles it.
3. **Q3** ~~The vector count.~~ Closed — **resolved 2026-09-25:** re-running the harness independently gave 5 matches out of the 7 vectors it runs; `aws.md` §1 now says so. The two differences are the
   path-encoding question, which remains open as Q2.
4. **Q4** The JSON 1.1 error-body shape (`__type`, `resourceIds`) for
   `ConflictException`.
5. **Q5** Lambda MicroVMs: the endpoint host and SigV4 service name, what an
   omitted `idlePolicy` does, and whether process exit terminates the MicroVM.
6. **Q6** How long EC2 remembers a `ClientToken`.
7. **Q7** LMI scale-up time from a reactivated function, if LMI is ever
   summoned.
8. **Q8** Smaller [U] items:
   - the `x-amzn-requestid` header name;
   - the `LaunchTemplate.LaunchTemplateName` spelling;
   - the Fargate Spot rate;
   - the EKS bearer-token format;
   - Bun as a Lambda custom runtime, including on LMI;
   - whether "task stops when its essential container exits";
   - the App Runner closing date.
9. **Q9** Not researched: CodeBuild `StartBuild`, Bedrock AgentCore,
   SageMaker Processing, Glue, ECS Anywhere and EKS Hybrid.

**From `google-azure.md`** (§10 and [U] rows):

10. **Q10** `EXPLAIN` the §6.2 SQL demand query, and this plan's
    `countDemand` SQL, on a large table.
11. **Q11** Whether KEDA's MongoDB scaler passes `$expr`/`$$NOW` through.
12. **Q12** A KEDA ScaledJob counts running Jobs, not bun-jobs workers
    (raised by `paas-ssh.md` §6.2). Should the demand route offer a
    `?minus=workers` variant, or an `unserved` field?
13. **Q13** How KEDA's `valueLocation` addresses a sample under `format:
    prometheus`. The re-read confirmed that the format exists, not the
    addressing.
14. **Q14** Time-to-first-claim on Cloud Run jobs (with and without Direct
    VPC egress) and on ACA jobs.
15. **Q15** The token helper has never been run against a real token
    endpoint.
16. **Q16** The Cloud Run SIGTSTP pause duration, and whether catching
    SIGTSTP changes it.
17. **Q17** The Cloud Run worker-pool `updateMask` path, and whether a pool
    restarts a worker that exits.
18. **Q18** Whether a Job update with `runExecutionToken` dedupes executions.
19. **Q19** Whether ACA's KEDA can reach a VNet-private datastore. It must,
    for a datastore scaler to work.
20. **Q20** When the ACA Environment Management meter applies, the maximum
    `replicaTimeout`, and the field names for ACA execution status.
21. **Q21** ACI billing granularity, and whether a terminated group bills.
22. **Q22** Whether a self-signed JWT works against `run.googleapis.com`,
    whether CREMA can scale to zero via Cloud Scheduler, the
    `compute.googleapis.com` host, whether Bun's `fetch` accepts `tls.ca`,
    and whether a task-timeout kill gets the same 10 s grace.
23. **Q23** Not researched: App Engine flexible, Eventarc, Logic Apps, and
    Azure Batch in depth.

**From `paas-ssh.md`** (§10 and [U] rows):

24. **Q24** Render: the signal and grace on job cancel, job start latency,
    List-jobs filters, and whether `numInstances: 0` is accepted.
25. **Q25** Railway: whether `deploymentRestart` restarts a `Completed`
    deployment, the status name it reports, and whether `numReplicas: 0`
    works. **This blocks a Railway recipe.**
26. **Q26** Time from API call to process start on Heroku, Render and Railway.
27. **Q27** Fly: the response to `start` on an already-started Machine,
    per-start env overrides, and the `FLY_MACHINE_ID` variable name.
28. **Q28** SSH: `nohup`/`setsid` session survival with unredirected streams,
    and `ControlMaster` on Windows OpenSSH.
29. **Q29** Kubernetes: the 409 status on a duplicate Job name, and Bun
    `fetch` with a custom CA against an API server.
30. **Q30** Cloudflare Containers' maximum lifetime.

### 12.2 Raised by this plan

31. **Q31** **`bootBudget` defaults are guesses.** They are 60 s for Fly,
    Lambda and SSH, and 180 s for everything else, and they wait on Q1, Q14
    and Q26. Too short summons twice. Too long delays recovery from a start
    that silently failed.
32. **Q32** **Idle check cost at scale.** Each summoned worker runs a
    `countDemand` and a `listWorkerRecords` every 5 s. With `maxWorkers: 50`
    that is 20 reads/s against the backend. It is probably fine, but it should
    be measured in 1.5a, and the interval should widen with the number of live
    summoned workers if it is not.
33. **Q33** **`countDemand` on Mongo needs a `lockExpiresAt` index** for the
    stalled count. It may need one added (and a `syncSchema` retired-index
    note), or it may already exist. Check in 1.5a.
34. **Q34** **Release by start time** (for `passes: "none"`) can mis-attribute
    an ordinary worker that happens to start during a pending summon. The
    effect is benign: the attempt is released one worker early, and the next
    check summons again if still needed. It should still be tested.
35. **Q35** **`WorkerTarget` is taken.** It is already exported as "which
    workers a control instruction addresses" (`queue/RemoteWorker.ts:41`,
    `queue/index.ts:103`, `index.ts:590`) [S]. `control-plane-rename.md` keeps
    that name (§3.1). `worker-runtimes.md` §4.2 proposes a *new* exported
    `WorkerTarget` meaning "where attempts run". One of them must be renamed,
    in Phase 0 or Phase 1. This does not touch summoning, but it is recorded
    here because it was found while reading for it. (The rename's decided
    names settle it: the existing type becomes `WorkerSelector`.)
36. **Q36** **The plugin API's own questions** are in
    [`compute-provider-plugins.md`](compute-provider-plugins.md) §17.2
    (Q-P1–Q-P10). The two that touch summoning directly: whether
    `./provider/auth` is public before Q2 and Q15 close (Q-P2), and whether
    capacity and quota need separate error kinds (Q-P6).

### 12.3 Risks

- **Credentials in producers.** The enqueue hook in a producer means that
  producer holds a credential that can start compute. On ACA, that credential
  can also read the job's secrets [V, google-azure §4.2]. Mitigation: the
  README recommends the single-process placement (§3.2), and scoped
  identities per summoner.
- **A crash-looping deploy.** A worker that crashes on import never registers,
  so each attempt is `lost`. The backoff and the circuit bound the damage to 5
  starts, then 15 minutes of silence [D]. Without them, one bad deploy is a
  start every `bootBudget`, forever.
- **At-least-once widens slightly.** A summoned worker killed without enough
  grace leaves its job to lapse and be recovered, so the job runs twice. That
  is today's contract, unchanged. The README should state it next to the
  shutdown-budget table.
- **Scale-style pools billing when idle.** A controller that dies with a pool
  at N leaves it billing "as active … even if … idle" [V, google-azure §8].
  Mitigation: prefer launch-style, and give every scale-style recipe a
  platform-side backstop (a scheduled scale-to-zero).
- **A third-party summoner that lies about its capabilities.** A
  `bootBudgetMs` that is too short summons twice; a dedupe token declared
  non-strict that is strict turns retries into `conflict`s. The kit catches
  what a fake can show; the rest appears as `lost` and `conflict` outcomes
  naming the provider ([`compute-provider-plugins.md`](compute-provider-plugins.md) §12.5, §17.1).
- **Platform quotas on new accounts**: Fargate vCPU 6 [V, aws §1], Lambda
  concurrency "reduced" on new accounts [V, aws §7], Cloud Run admin writes
  180/60 s [V, google-azure §8], and Render's 100 jobs/min [V, paas-ssh
  §4.2]. A burst across many queues can hit them. Each maps to `unavailable`,
  never to a job failure.

---

## 13. Phased delivery

These are the sub-phases of `worker-runtimes.md`'s Phase 1.5. Each one ships
on its own and leaves the package coherent if the next never happens. Effort
is in focused days for someone who wrote this code.

**The estimate has grown from `worker-runtimes.md`'s earlier ~4.5 d.** The
growth is not padding, and each of these adds real work:

- the zero-worker blind spot means a driver method on five drivers;
- the late registration means the marker and its CAS;
- the missing signal handling means `drainAndExit`;
- the `countJobs` cost means a bounded read;
- the providers each need an adapter and credentials;
- **the provider plugin system** (added 2026-09-25 at the user's request):
  a public, versioned API, a conformance kit and its documentation, built
  before the first-party providers so that they are written on it
  ([`compute-provider-plugins.md`](compute-provider-plugins.md) §16).

### 1.5a — Core: controller, marker, demand, `drainAndExit` (**the minimum useful ship**)

It works on every platform through `defineSummoner({ invoke })`. If 1.5p has
not landed yet, `defineSummoner` builds its summoner on an internal stand-in
for the provider types, and 1.5p replaces the stand-in with the public ones.

| Work | Effort |
|---|---|
| `countDemand` on Redis, SQL (4 engines), Mongo, memory and file, plus the contract-suite cases and the fallback | 3 d |
| `SummonController`: predicate, marker and CAS, release, backoff, circuit, budget, three triggers, `servedUntil` fast path, `BunJobs.summon`/`summoner()` | 3.5 d |
| `drainAndExit`, `summonedFromEnv`, `SUMMON_ENV`, `WorkerInfo.summon` and `BunQueueWorkerOptions.summoned` | 2 d |
| the `summon` queue event, logging, the `ConfigError`s of §4.9 | 0.5 d |
| tier-1 tests: the fake platform and the controller, `drainAndExit` and driver suites | 3 d |
| README section, the benchmark `--compare` run, the change report to the examples session | 1 d |
| **Total** | **~13 d** |

### 1.5b — The depth endpoint and summon routes

| Work | Effort |
|---|---|
| `/queues/:queue/demand`, `/demand`, the DTO and schema, Prometheus rendering | 1.5 d |
| `/queues/:queue/summon` (status, manual, reset), `queues.summon` action | 1 d |
| Recipes: KEDA ScaledJob and ScaledObject, ACA event job, CREMA, GKE HPA, and the SQL query with its `EXPLAIN` (Q10) | 1.5 d |
| Tests: route, auth, OpenAPI | 0.5 d |
| **Total** | **~4.5 d** |

After 1.5a and 1.5b (**~17.5 d**), every platform in the evidence is reachable:
Kubernetes and ACA by the endpoint, everything else by `invoke()`.

### 1.5p — The provider plugin API, `experimental` (new)

The core and the `summon` facet of
[`compute-provider-plugins.md`](compute-provider-plugins.md), its conformance
kit, its documentation and its starter template, all at `apiVersion` `0.1`.
It comes **before 1.5c**, so every first-party summoner is built on it.

| Work | Effort |
|---|---|
| `lib/provider/`: identity, brand, `defineComputeProvider`, config validation (sync and async Standard Schema), the per-facet version check and the per-process name map, `ProviderError` and its mapping into the controller's gates, contexts, redaction (plugins §6, §9, §10, §13) | 2.5 d |
| The summon facet: capabilities read by the controller (dedupe key, `wake`, shutdown → grace env, lifetime cap), `status`/`cancel`, `Summoner` redefined, `defineSummoner` as a wrapper (plugins §7) | 1.5 d |
| `./provider/testing`: report, `assertConformance`, `fakePlatform()`, the summon checks, the handoff harness moved from `__tests__/helpers/summon.ts` (plugins §12) | 3.5 d |
| The first-party import test; `exports`, `dts`, `consumer-check.json` and the packaging test for `./provider`, `./provider/auth`, `./provider/testing`, `./providers/*` (plugins §5, §11) | 1 d |
| Docs: author guide (summon half) with its worked example, the API reference and its drift test, the user guide, the security page (plugins §15) | 3 d |
| `templates/compute-provider/` (summon half), wired into the gate (plugins §11.3) | 1 d |
| **Total** | **~12.5 d** |

### 1.5c — AWS and Fly, on the provider API

| Work | Effort |
|---|---|
| SigV4 signer + AWS vector tests; credential chain with cache, skew retry, throttling backoff, in `./provider/auth` | 2 d |
| `ecsRunTask` + `lambdaInvoke`, their `fakePlatform()` fakes and kit runs | 2.25 d |
| `flyMachines` (the `wake` style), its fake and kit run | 1.25 d |
| `exports` and `consumer-check.json` rows for `./providers/aws` and `./providers/fly` (the wiring itself is 1.5p's) | 0.5 d |
| Recipes: worker Dockerfile, ECS task definition notes, Fly `fly.toml` (`kill_signal`, `kill_timeout`) | 0.5 d |
| **Total** | **~6.5 d** |

### 1.5d — Google and Azure, on the provider API

| Work | Effort |
|---|---|
| Token helper: JWT, Google key and metadata, Azure secret, federated and managed identity, in `./provider/auth` | 1.5 d |
| `cloudRunJob` + `cloudRunWorkerPool` (the scale path, `release`), fakes and kit runs | 1.75 d |
| `acaJob`, its fake and kit run, and the scoped-identity README section | 1.25 d |
| **Total** | **~4.5 d** |

### 1.5e — Render and SSH, on the provider API

| Work | Effort |
|---|---|
| `renderJob` (the `argv` path), its fake and kit run | 0.75 d |
| `sshSystemdRun`: pinned options, known-hosts file from `hostKey`, host choice, the `authorized_keys` and `bun-jobs-summon` recipe, a fake `ssh` for the kit, tier-2 systemd test | 2.75 d |
| **Total** | **~3.5 d** |

### 1.5f — UI and examples (other owners)

| Work | Owner | Effort |
|---|---|---|
| Queue screen demand and summon card; Workers-page badge; "Summon now" and "Reset"; event filter; `### What each element needs` rows | the UI session | ~3 d |
| The provider card, the experimental badge, "Test connection", the Providers section (plugins §14) | the UI session | ~0.5 d |
| One example per first-party summoner against the fake platform; the invoke recipe; the model (c) one-shot | the examples session | ~2 d |
| A custom summon provider against a local fake that passes the kit (plugins §15.5). It is also the outside provider the stability gate needs | the examples session | ~1 d |

### 1.5g — Live verification

| Work | Effort |
|---|---|
| The tier-3 script and one run per first-party summoner, closing the [U]s it can (Q2 and Q15 among them) and recording time-to-first-claim | 1.5 d + cents |

### 1.5s — The summon facet's stability gate (new)

| Work | Effort |
|---|---|
| Confirm the six first-party providers and one outside provider pass the kit, across all three styles and all three `passes` values; review the API; move `summon` to `1.0`; move `core` to `1.0` only if the execute gate has also passed (plugins §10.4) | ~1 d |

### Totals

| Scope | bun-jobs session | Other owners |
|---|---|---|
| 1.5a + 1.5b (minimum useful) | ~17.5 d | UI ~1 d for the demand card |
| All of 1.5 | **~47 d** (was ~32.5 d; +12.5 d for 1.5p, +1 d for fakes and kit runs in 1.5d–e, +1 d for 1.5s) | UI ~3.5 d, examples ~3 d |

The order is 1.5a → (1.5b ∥ 1.5p) → 1.5c → 1.5d → 1.5e → 1.5g → 1.5s, with
1.5f following each bun-jobs sub-phase it depends on and 1.5g before the
release that ships an adapter. 1.5b is independent of 1.5p and 1.5c.

---

## 14. Provider plugins

Summary of [`compute-provider-plugins.md`](compute-provider-plugins.md) as it
bears on summoning. That document is the design; this section only says what
it changes here.

- **A summoner is a configured provider with a `summon` facet** (§4.10). A
  provider plugin is made with `defineComputeProvider` from `./provider`: an
  identity (`name`, `version`, `kind`), an `apiVersion` per facet, a config
  schema as a Standard Schema, declared secret fields, `describe()` and an
  optional `validate()`.
- **The controller reads declared capabilities**, not platform names: style
  (`launch`, `scale`, and the new `wake`), dedupe kind and key limits,
  `passes`, `bootBudgetMs`, the shutdown signal and grace, the platform's
  lifetime cap. §4.6, §4.7 and §7 now point at those declarations (plugins
  §7.1).
- **Errors come back as one of six kinds** (`transient`, `throttled`,
  `quota`, `auth`, `misconfigured`, `conflict`), which set §4.4's backoff and
  whether the circuit opens at once (plugins §6.5).
- **Optional hooks** `status()` and `cancel()` explain a lost attempt and stop
  a late one (§4.3 step 2; plugins §7.3).
- **`defineSummoner({ invoke })` stays**, as a wrapper that builds an
  anonymous provider (plugins §7.4).
- **First-party summoners get no privileged internals**: they live in
  `lib/providers/`, import only the public entries, and a test fails on any
  other import (plugins §5). Their subpaths are `./providers/*`, not
  `./summon/*` (§8.4), and the credential helpers are public from
  `./provider/auth` (§8.1, §8.2).
- **A published conformance kit** (`./provider/testing`) runs any provider
  against a local fake of its platform, with no cloud credentials. The
  first-party providers are tested with it (§11.1; plugins §12).
- **The API is `experimental` (`0.x`)** until the six first-party summoners
  and one provider written outside the bun-jobs session pass the kit (1.5s;
  plugins §10.4).
- **Documentation is a deliverable**: an author guide with a worked example,
  an API reference with a drift test, a user guide, a security page and a
  starter template (1.5p; plugins §15).
- **Cost**: ~14.5 d more in Phase 1.5 (§13).
