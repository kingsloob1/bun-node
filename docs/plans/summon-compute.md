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

**Updated 2026-09-25: the Phase 1.5 design check**, against `origin/develop`
at `0a8e580`, after Phase 0 and Phase 1 (the worker `target` option, #164)
merged. **Status: design reconciled; 1.5a/1.5b sliced into seven PRs;
names approved the same day (§13.9).** What changed:

- **Every code claim §1–§6 rests on was re-read at `0a8e580`.** Lines that
  moved are updated in place; where the reading changed the design, §4.0 lists
  the correction, its source and what it changes. Every `file:line` in this
  document is now at `0a8e580` and relative to `packages/bun-jobs/lib/` unless
  it says otherwise; read `BunQueueWorker.ts:2162` as
  `0a8e580:packages/bun-jobs/lib/queue/BunQueueWorker.ts:2162`. Citations of
  lines a slice will change are written in that pinned form, so they cannot
  drift once the slice lands.
- **§6.4 is now the `countDemand` spec** the bun-jobs session asked for before
  any code: exactly which states count, why due work is counted directly
  rather than through promotion, what the cap returns, and an index plan per
  driver, **marked unmeasured**, whose measurement is that slice's first task.
- **§13 slices 1.5a and 1.5b into seven PRs** (PR-1 to PR-7), with order,
  parallelism, owners, gates, hot-path exposure and revised effort (~19.75 d,
  was ~17.5 d).
- **§13.9 records every public name 1.5a/1.5b introduces, as approved by the
  user on 2026-09-25** (S1–S18): every recommendation was accepted, and the
  plan uses the approved names throughout. §13.1 records who implements and
  who reviews each PR.

**Updated 2026-09-26: the bun-jobs session's review of §6.4** (the
`countDemand` spec): three corrections, each checked against the code and
recorded in §6.4's [review corrections](#review-corrections-2026-09-26).

**Updated 2026-09-26: the shutdown budget, per #166 (pending its merge).**
The bun-jobs session's #166 fix measures a target's close (≤ 4,500 ms
graceful; `force` in milliseconds) and adds `close({ force })` for targets.
§5.3 now derives the target's share of the budget from those constants and
specifies **the close rule** (graceful while the budget covers it, `force`
otherwise, with Fly and Railway worked through); Q38 is narrowed; PR-4 depends
on #166's `force` option specifically.

**Updated 2026-09-26: the identity channel is arguments only** (the bun-jobs session's review of #178, 2026-09-26,
and the user's decisions the same day). `Bun.spawn` with no `env` hands a
child the environment the process *started* with, so summon identity in the
environment leaked to every `Bun.spawn` descendant. Identity now travels only
as `--bun-jobs-summon-*=` arguments: `summonedFromArgs()` and `SUMMON_ARGS`
replace `summonedFromEnv()` and `SUMMON_ENV` (S8 superseded). Also: `id` is
what makes a worker summoned; `mode` is never defaulted; the handle has its own
API switch, `exposeSummonHandles` (default `false`); `summon` on a driver that
cannot store worker records is a `ConfigError`; PR-3 gains **claim-once**. See
§5.5; the open questions are Q42 and Q43.

**Updated 2026-09-26: Railway VMs, researched 2026-09-26 (user-prompted).**
A fourth evidence file, [`railway-vms-2026-09.md`](evidence/summon-compute/railway-vms-2026-09.md),
covers Railway's VM products, which `paas-ssh.md` did not examine. Its tags are
carried unchanged as **[V/V-src/I/U, railway-vms §n]**; none is upgraded. What
changed:

- **Railway is no longer blocked.** Its status is **candidate — via Railway
  Sandboxes; the service path is still conditional on Q25** (§7.1): a
  documented recipe now, and a first-party summoner candidate once start
  latency, the signal and grace on destroy or idle teardown, and the maximum
  lifetime under an exec are measured (Q40).
- **Q25 no longer blocks a Railway recipe**; Q40 (Sandboxes) and Q41 (cloud
  agents, low priority) are new (§12.1).
- **Cloud agents** are at most a recipe, labelled beta; **the free unclaimed
  VM** is a human-run "try it" docs path, never automated (§7.1).
- **The SSH recipe** assumes no `systemd-run --user` on Railway VMs (§7.7).
- **The cost table** gains Railway VM pricing (§10.1).

**Updated 2026-09-26: `countDemand` built (PR-1), and §6.4 corrected by it.**
D4 is measured on all eight backends, each `[U]` replaced by a plan and a
median; the numbers are also beside each implementation. Five corrections,
in §6.4's [implementation corrections](#implementation-corrections-2026-09-26):
`stalled` is exactly what each engine's `recoverStalled` would recover (the
earlier null-guard rule was wrong on Redis and file), so the lockless contract
case asserts agreement with the sweep; memory keeps an active-id `Set`;
`nextDueAt` is a per-state `MIN`; the file driver's work is bounded by the
backlog, not by `cap`. Q10 is closed.

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

This plan rests on four evidence files, indexed in
[`evidence/summon-compute/README.md`](evidence/summon-compute/README.md):
`aws.md`, `google-azure.md` and `paas-ssh.md` (2026-09-25), and
`railway-vms-2026-09.md` (2026-09-26, cited as `railway-vms`). Their tags are
copied here unchanged, with the file they came from, for example **[V, aws
§4.1]**. No tag has been promoted: an [I] or a [U] in the evidence is still an
[I] or a [U] here.

| Tag | Meaning in this plan |
|---|---|
| **[S]** | I read it from this repository's source today (2026-09-25). The file and line are given. |
| **[V, file §n]** / **[V~, …]** / **[V-plan, …]** / **[P, …]** | Verified by the evidence file named, as that file defines the tag. `V~` means it was read through a summarising fetch. `V-plan` and `P` mean it was verified on 2026-09-22 by `worker-runtimes.md` and not re-read. |
| **[M, file §n]** | Measured by the evidence file named. |
| **[V-src, railway-vms §n]** | Read by that evidence file from Railway's own open-source code (`railwayapp/cli`, `railwayapp/railway-ts-sdk`). Primary, but a code comment is not a documented contract. |
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
`BunQueueWorker` under **`runSummoned()`**, which owns the idle threshold,
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
| 2 | **The trigger is `demand > 0`, and demand is not "waiting > 0".** | With no worker, due delayed jobs and due retries never reach `waiting`: every claim path requires `state = 'waiting'` (SQL `claimWindowFilter`, `drivers/sql/dialect.ts:866-879`; memory `#firstClaimable`) [S], and `promoteDelayed` has exactly one caller, `queue/BunQueueWorker.ts:2162` (was `:2119` at `d54d1fe`; `git grep 'promoteDelayed('` over `lib/`, `examples/`, `playground/`, `bun-jobs-ui/lib` and `bun-nest/lib` finds no other) [S]. Stalled recovery is a worker sweep too (`#armMaintenance`, `BunQueueWorker.ts:4368-4424`) [S]. So demand = waiting + due + stalled, zero while paused, and "active jobs with no live worker" also calls for a worker. §4.2 |
| 3 | **An in-flight marker in queue state guards every summon.** Platform dedupe is only a second line. | A worker writes its heartbeat record only after `connect()` (`BunQueueWorker.ts:1310`), `ensureQueue()` (`:1311`) and a report that is not awaited (`:1329`), whose **first** write is preceded by a duplicate-id read (`#detectDuplicateId`, `:4161-4164`, a `listWorkerRecords`) before `registerWorkerRecord` (`:4177`) [S]. Throughout a platform's cold start, "work and no live worker" stays true. Several platforms have no dedupe at all: Cloud Run `jobs.run` [V~, google-azure §3.2], ACA `jobs/start` [V, google-azure §4.2], Render jobs [V, paas-ssh §4.2], Lambda async [V, aws §4.4]. §4.3 |
| 4 | **Prefer "set a count" to "launch one".** | A scale-a-service call is idempotent. A launch-a-task call doubles up on a race. So the marker is written *before* the call, and every launch request is a pure function of its dedupe key (ECS `clientToken` only dedupes identical requests: [V, aws §4.1]). §4.6 |
| 5 | **The summoned worker installs the signal handlers. The package does not install them globally.** | Nothing in `lib/` handles SIGTERM, SIGINT or SIGTSTP: `git grep 'process\.on(\|process\.once(\|SIGTERM\|SIGINT\|SIGTSTP'` over `packages/bun-jobs/lib` finds only the runner child's IPC listener (`runner/bootstrap/spawn-entry.ts:19`) and the executors *sending* `SIGTERM` to their children (`runner/executors/spawn.ts:182`) [S; re-checked at `0a8e580`]. Shutdown budgets differ by about 60×. `runSummoned()` takes the budget as an input. §5 |
| 6 | **`countDemand` is an optional driver method, bounded by a cap.** | `countJobs` on SQL is a `GROUP BY state` over the queue's whole retained history, plus, since #159, a `UNION ALL` branch per guarded state (`drivers/sql/sql-driver.ts:4320-4340`; the guard is `#countNotNull`, `:4570-4580`) [S]. Polling that every 30 s is the wrong cost. §6.4 |
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
| What bun-jobs ships | controller, summoners, `runSummoned` | the depth endpoint (§6), `runSummoned`, recipes | `SummonController.check()` as a one-shot, `runSummoned` |
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

- **`add()` in this process**: immediate. The hook listens to the local
  **`added`** event, not `waiting`/`delayed`: `addBulk` emits only a local
  `added` (or `duplicate`) per job and publishes nothing
  (`queue/BunQueue.ts:715-726`), and a repeatable's first add emits only
  `added` locally (`:2872-2873`), so a `waiting`/`delayed` listener would miss
  both [S; corrected 2026-09-25 — the plan said `waiting`/`delayed`,
  `BunQueue.ts:646-657`, which only `#addSimple` emits, `:645-656`]. The
  `Job` view `added` carries has `state` and `runAt`, which is all the §4.8
  fast path reads. Listening costs one callback per add and no driver call
  while a worker is known to be live (§4.8).
- **Driver events from other processes**: `BunQueue` publishes `added`,
  `waiting` and `delayed` from `#addSimple` (`BunQueue.ts:647`, `:653`,
  `:656`) and from flows (`:1426-1437`), and also `promoted` (`:1687`),
  `resumed` (`:2099`), `retried` (`:2647`, `:2671`) and `repeatScheduled`
  (`:2867`) — every one of which can create demand, so the events trigger
  listens to all seven [S; the plan listed three]. **Two limits, both read
  from source:** a producer publishes only when asked, since `publishEvents`
  defaults to `false` (`BunJobs.ts:92-99`, resolved at `:377`) and a queue's
  own `publish` defaults to its `subscribe` (`queue/types.ts:850-863`); and
  `addBulk` publishes nothing at all. So the events trigger hears another
  process's adds only from producers that publish, and never a bulk add. The
  poll is what makes the placement correct; events only make it faster. The
  README must say so.
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
the worker it summoned. When `summonedFromArgs()` (§5.5) finds a summon id,
`BunJobs` creates controllers disabled unless `summon.fromSummoned: true`
[D]. **Revised 2026-09-26 (§5.5):** identity is on the command line, which no
descendant inherits, so a summoned worker's descendants read as *not
summoned*, and this rule does not reach them. Whether it should, and how they
would know, is Q42. `summonedFromArgs()` still answers `undefined` inside a
runner child (`BUN_JOBS_CHILD === "1"`, `runner/protocol.ts:213`), as a
refuse-only guard [D].

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

### 4.0 Reconciliation with the code at `0a8e580` (2026-09-25)

The plan was written at `d54d1fe`/`ca3ed21`. Phases 0 and 1 have landed since.
Every code claim below was re-read at `0a8e580`; each row is what the source
says, and the last column is what it changes here. **Inference is marked [I];
everything else was read.**

| # | The plan said | The source says (at `0a8e580`) | What changes |
|---|---|---|---|
| R1 | `promoteDelayed`'s one caller is `BunQueueWorker.ts:2119` | Still exactly one caller, now `queue/BunQueueWorker.ts:2162` (`#promote`), run on the 1 Hz promotion timer (`#armPromotion`, `:4542-4567`) and before an empty pass. Checked by `git grep 'promoteDelayed('` over every package's `lib/`, `examples/` and `playground/`: the only hit outside the drivers' own definitions is that line | Citation only. The claim stands |
| R2 | Registration: `connect` `:1303`, `ensureQueue` `:1304`, unawaited report `:1322` → `registerWorkerRecord` `:4139`; "released about one driver round trip after connect" | `run()` (`:1301-1350`): `connect` `:1310`, `ensureQueue` `:1311`, `#armMaintenance` `:1322`, `#startedAt` `:1323`, `void this.#report()` `:1329`. The **first** report calls `#detectDuplicateId` (`:4161-4164`), a `listWorkerRecords`, before `registerWorkerRecord` (`:4177`) | **Two** round trips after `ensureQueue`, not one (§5.4). Cheap, but the release latency and `bootBudget` arithmetic say so now |
| R3 | (not considered) | `#report` returns without writing when `reportInterval === 0` or the driver has no worker records (`supportsWorkers`, `:4141-4146`; `drivers/readApis.ts:574-581`) | A summoned worker with `reportInterval: 0` never registers, so every attempt ends `lost` and the circuit opens. **`summon` on a worker with `reportInterval: 0` is a `ConfigError`**, and so is a controller on a driver without worker records (§4.9) [D] |
| R4 | No signal handling in `lib/queue/` | None anywhere in `lib/` (grep in decision 5) | Stands |
| R5 | `setReservedState` at `windows.ts:79`; the token check at `driver.ts:2618-2637` | `setReservedState` `queue/windows.ts:79-92`; `assertWritableStateName` `:58-71`; the `options.internal` parameter `drivers/driver.ts:2640-2660`. **All five drivers** implement `getQueueState`/`setQueueState`/`listQueueState` and call `assertWritableStateName` first: memory `drivers/memory-driver.ts:2452-2476`, file `drivers/file-driver.ts:3708-3753` (one lock file per entry, `O_EXCL`), SQL `drivers/sql/sql-driver.ts:6654-6721` (conditional `INSERT`/`UPDATE`/`DELETE` on the version), Redis `drivers/redis/redis-driver.ts:3118-3142` (one script), Mongo `drivers/mongo/mongo-driver.ts:5408-5465` (`insertOne` on a unique `_id`, `updateOne`/`deleteOne` filtered by version). The shared contract suite asserts the CAS (`__tests__/helpers/driverContract.ts:4100-4345`) | The marker's CAS exists with the semantics §4.3 needs, on every driver. No driver work for the marker |
| R6 | The request id is SHA-256 over `(namespace, queue, marker version at claim)` | "A deleted then re-created entry starts again from `1`", and "purging the namespace removes every entry" (`drivers/driver.ts:2634-2638`) | **A real bug in the design** [I from S]: after a purge, or anything that deletes the marker, versions restart and a new claim reissues an old id. ECS remembers a `clientToken` for up to 24 h [V, aws §4.1], so the new attempt comes back `deduped` with the *old* task's handles, starts nothing, and is `lost` a `bootBudget` later. **Fix:** the marker gains `epoch`, a random string written when the entry is created, and the id hashes `(namespace, queue, epoch, version)` (§4.3, §4.6) [D] |
| R7 | The windows sweep cannot touch `__win:summon` | `sweepWindows` removes only `__win:debounce:` and `__win:throttle:` names and passes over everything else (`queue/windows.ts:200-206`). Reserved names in use: `fheal`, `msweep` (`BunQueueWorker.ts:140`, `:147`), `jdef` (`queue/jobDefaults.ts:60`), `repeat-disabled:` (`queue/repeatControl.ts:38`), `wcfg:`, `wctl:`, `wstop:` (`queue/workerControl.ts:48-54`), `debounce:`, `throttle:` | `__win:summon` is unused and no sweep deletes it. Stands |
| R8 | `countJobs` on SQL `sql-driver.ts:4302-4313`; Mongo `mongo-driver.ts:4277-4287` | SQL `:4320-4340`, now the grouped count **plus a `UNION ALL` branch per guarded state** (#159). Mongo `:4277-4287`, a `$group` over the queue, unchanged | Citations; the cost claim stands and is stronger on SQLite, where #159 measured `countJobs` +62% |
| R9 | Mongo's due index is `ns_1_queue_1_state_1_runAt_1` (`mongo-driver.ts:204-205`, via google-azure §1.1); whether a `lockExpiresAt` index exists: check (Q33) | **That index is retired** (`RETIRED_INDEXES`, `drivers/mongo/mongo-driver.ts:245-256`, with the `lockExpiresAt` one). Current: `PROMOTION_INDEX` `{ ns, queue, state, runAt, _id }` (`:1127-1133`), `LOCK_INDEX` `{ ns, queue, state, lockExpiresAt, _id }` (`:1136-1142`), `CLAIM_INDEX` (`:1117-1124`), created on connect (`:5982-5997`) | §6.4's Mongo row names the current indexes. **Q33 is closed**: the stalled count has an index, no `syncSchema` change is needed |
| R10 | `nextDelayedAt` covers delayed and failed on Redis and SQL | On all five: memory (`memory-driver.ts:2531-2542`, over `SCHEDULED_STATES = ["delayed", "failed"]`, `:438`), file (`file-driver.ts:3852-3873`, `:234`), SQL (`sql-driver.ts:6818-6850`, per-state `MIN`, `SCHEDULED` `:292`), Redis (`redis-driver.ts:3258-3279`), Mongo (`mongo-driver.ts:5569-5580`, `SCHEDULED` `:328`). `failed` is "another attempt is due at `runAt`", distinct from `dead` (`drivers/driver.ts:788-805`) | Stands, now for five drivers rather than two |
| R11 | `listWorkerRecords` at `readApis.ts:657` | `drivers/readApis.ts:667-709`; native `listWorkers` on all five drivers (memory `:1587`, file `:2834`, SQL `:4848`, Redis `:2405`, Mongo `:4520`) | Citation only |
| R12 | The sweep lease: "90 s at the defaults" (`BunQueueWorker.ts:2869-2877`, `SWEEP_LEASE_LIFETIMES` `:167`) | `#holdsSweepLease` `:2932-2981`, its doc `:2900-2931`; `SWEEP_LEASE_LIFETIMES = 2` `:174`; takeover factor `:209`. `#every` runs each sweep once at `t = 0` and then every cadence (`:4656-4677`). A graceful `close()` or `stop()` releases the leases at once (`:1602`, `:1415`) | Stands. **Two consequences for summoned workers** [I]: a summoned worker sweeps immediately on start, so one that inherits a *released* lease recovers stalled jobs at once; one that follows a worker killed without grace waits out up to two of the dead holder's cadences (60 s at the default `stalledInterval` of 30 s, `shared/constants.ts:138`). A summoned worker given a `stalledInterval` under half the holder's takes the lease at once (`SWEEP_LEASE_TAKEOVER_FACTOR`) — a documented lever for the orphan case, not a default |
| R13 | `drained` fires after `drainDelay`, default `0` (`BunQueueWorker.ts:1926-1953`, `types.ts:1049-1050`) | `#announceDrained` `:1968-1997`; with `drainDelay <= 0` it fires **on every empty pass** (its own doc, `:1971-1974`); default `0` at `:974`, option `queue/types.ts:1054-1055` | Stands, and is a stronger reason not to exit on `drained` (§5.1) |
| R14 | `close()` holds the process (`:1554-1574`) and hands the sweep leases over (`:1592-1595`) | `close()` `:1568-1579`; `#releaseSweepLeases` `:1602`. **`close({ timeout })` bounds only the wait for jobs in flight** (`:1652-1671`). After it: `#closeTarget` (Phase 1, `:1708-1733`, bounded by `DEFAULT_CLOSE_TIMEOUT` = 5,000 ms, `shared/constants.ts:28`), then `#unregister`, the throughput flush, metrics, dead letters, the limiter and `driver.close()`, none of them bounded (`:1683-1697`) | **`runSummoned`'s `timeout: grace − 1_000` can overrun the platform's grace**: a custom target whose `close()` hangs costs 5 s, which is Fly's whole default grace. §5.3 now arms a hard exit backstop. **Issue #166** (a `"child-process"` attempt orphaned by `close()`) will give `FileTargetExecutor` a `close()` too, so every file target will pay that bound: `runSummoned` is sequenced after #166 (§13.5, PR-4). **Per #166, pending its merge:** a graceful target close is ≤ 4,500 ms (SIGKILL at 4,000 ms + ≤ 500 ms reaping), and `close({ force: true })` kills the children at once; §5.3's close rule budgets on those |
| R15 | `GET /queues/:queue/counts` at `api/routes/queues.ts:609-624` | Unchanged (`:609-624`, action `queues.read`) | Stands |
| R16 | `readOnly`/`actions` at `api/config.ts:520`, `:562` | `:527`, `:569`. There is also `JOBS_API_OPT_IN_ACTIONS` (`api/contract/constants.ts:136-144`), the default-off list, and `JOBS_API_MUTATIONS` (`:84-117`), removed by `readOnly` | `queues.summon` joins **both** sets (§6.2) |
| R17 | A paused worker writes `paused` and `state` (`BunQueueWorker.ts:4148-4149`) | `:4186-4187`; `WorkerInfo.state` is optional ("absent on a record written before this existed", `drivers/driver.ts:1466-1470`); states `running`, `paused`, `stopping`, `stopped`, `restarting` (`shared/workers.ts:25-31`) | "Serving" is `state` in `running` or `restarting` (a transient of milliseconds, `shared/workers.ts:22-23`), or, on a record with no `state`, `paused === false` (§4.2) [D] |
| R18 | The bench's `enqueue` scenario runs "with a live worker" once a controller is attached (§4.8) | `enqueue` and `enqueue-bulk` are "producer only … no consumer running" (`bench/queue.ts:48-49`) | The guard as written measured the wrong path. §4.8 and PR-3's gate now attach a controller to **all six** scenarios: the producer-only two measure the no-worker path (debounced checks), `throughput`/`roundtrip`/`payload`/`contention` the `servedUntil` fast path |
| R19 | `summonedFromEnv()` reads `BUN_JOBS_NAMESPACE` and `BUN_JOBS_QUEUE` | `BUN_JOBS_NAMESPACE` is already `CHILD_ENV.namespace` (`runner/protocol.ts:25-38`), exported from the root (`lib/index.ts:702`), and set on every runner and file-target child | A name collision; every key is under `BUN_JOBS_SUMMON_*` (§13.9 S8, approved) |
| R20 | `WorkerTarget` is taken (Q35) | Phase 0 renamed the addressee type to `WorkerSelector` (`queue/WorkerController.ts:41`); Phase 1 shipped `WorkerTarget` meaning "where attempts run" | Q35 closed |

### 4.1 Components and where they live [D]

| Piece | File | Exported from |
|---|---|---|
| `SummonController`, `SummonPolicy`, `defineSummoner` | `lib/summon/controller.ts`, `lib/summon/types.ts` | `lib/summon/index.ts`, and the package root |
| the provider core and the `summon` facet types (`defineComputeProvider`, `ProviderError`, `SummonFacet`, `SummonCapabilities`, …) | `lib/provider/` | `./provider` ([`compute-provider-plugins.md`](compute-provider-plugins.md) §6–§7, §11) |
| the conformance kit and `fakePlatform()` | `lib/provider/testing/` | `./provider/testing` (plugins §12) |
| demand reading (`readDemand`, the fallback formula) | `lib/drivers/readApis.ts` beside `listWorkerRecords` (`:667`) [S] | `./lib/drivers`; the public read is `queue.getDemand()` (S10) |
| `countDemand` driver method | each driver, contract in `lib/drivers/driver.ts` | — |
| the marker (reserved entry `__win:summon`, S14) | `lib/summon/marker.ts`, written with `setReservedState` (`queue/windows.ts:79-92`) [S] | not exported |
| `runSummoned` (S4), `summonedFromArgs`, `SUMMON_ARGS` (S8, superseded 2026-09-26, §5.5) | `lib/summon/worker.ts`, `lib/summon/args.ts` | root |
| first-party providers | `lib/providers/{aws,google,azure,fly,render,ssh}.ts`, importing only the public entries (plugins §5) | `./providers/*` subpaths (§8.4) |
| signing helpers | `lib/provider/auth/{sigv4,aws-credentials,google-token,azure-token,jwt}.ts` | `./provider/auth`, public (plugins §6.4) |

`setReservedState` writes with the package's internal token. Nothing outside
the package can forge a write to a `__win:` name (`drivers/driver.ts:2640-2660`,
`queue/windows.ts:58-92`; every driver calls `assertWritableStateName` first,
§4.0 R5) [S]. So a user's own `setQueueState` cannot corrupt the
marker by accident.

### 4.2 The trigger predicate

Read from the driver, at `now`:

```
paused      = isQueuePaused(q)
waiting     = jobs in `waiting`
dueNow      = jobs in `delayed` or `failed` with runAt ≤ now          (nextDelayedAt covers both sets)
stalled     = jobs in `active` this engine's recoverStalled would recover at now (a lapsed lock; §6.4 D1)
active      = jobs in `active`
workers     = live records from listWorkerRecords(q, now)

demand      = paused ? 0 : waiting + dueNow + stalled
outstanding = paused ? 0 : demand + (active − stalled)                (a stalled job is in both; the draft counted it twice, §6.4 D1)
orphaned    = !paused && active > 0 && workers == 0                    (lock not lapsed yet, holder gone)

needs a worker ⇔ (demand > 0 || orphaned) && served < wanted
```

- `nextDelayedAt` really does look at both the delayed and the failed
  (retry-pending) sets, on all five drivers (§4.0 R10): Redis walks
  `[keys.delayed, keys.failed]` (`drivers/redis/redis-driver.ts:3258-3279`),
  SQL takes a `MIN(run_at)` per state (`drivers/sql/sql-driver.ts:6818-6850`),
  and memory, file and Mongo read `["delayed", "failed"]` [S]. So
  `nextDelayedAt(q) ≤ now` is a correct *boolean* for "something is due", on
  every driver, today.
- `workers` in `orphaned` counts **every** live record, parked and paused
  included: the question there is whether anything alive may still hold the
  active jobs' locks. `served` below counts only *serving* records. A queue
  whose only live workers are parked (`stopped`: not claiming *and no
  maintenance*, `shared/workers.ts:20-21`) with lapsed locks therefore has
  `stalled > 0` and `served = 0`, and summons, which is right [I].
- `orphaned` covers the window between a worker dying and its lock lapsing.
  That window is up to `lockDuration`, `DEFAULT_LOCK_DURATION = 30_000`
  (`shared/constants.ts:135`) [S]. Summoning then is not wasted: the job will
  be recoverable by the time a cold start finishes.
- **Paused queues demand nothing**, including their orphans. A paused queue's
  stalled jobs wait for the resume, as they do today.
- `served` and `wanted`:
  ```
  wanted = min(maxWorkers, max(1, ceil(outstanding / jobsPerWorker)))
  served = (servedBy == "any-worker" ? serving : servingSummoned) + Σ pending[i].count
  ```
  (`pending.length` in the draft; an attempt may ask for several workers, so
  it is the sum of their `count`s.)
  `jobsPerWorker` defaults to `Infinity`, which means one worker. `pending` is
  the marker's unregistered attempts (§4.3).

**`servedBy: "any-worker"`** is the default: a queue with any live worker
is served. The honest caveat is that a live worker may be paused or parked by
a `WorkerController` (the Phase 0 name). A worker writes `paused` and `state`
on its record (`BunQueueWorker.ts:4186-4187`; states in
`shared/workers.ts:25-31`) [S], so a record is **serving** when its `state`
is `running` or `restarting` (a transient of milliseconds while a
configuration change applies, `shared/workers.ts:22-23`), or, on a record too
old to carry `state` (`drivers/driver.ts:1466-1470`), when `paused` is
`false` [D]. The option is `servedBy` (§13.9 S18).

**A known gap, accepted** [I from S]: a flow parent left in
`waiting-children` by a crash or a failed write is repaired only by a
worker's `#healFlows` (`BunQueueWorker.ts:2873`, run from the stalled sweep),
and demand does not count it. It waits for the next worker that other demand
brings, as it would today with no worker running.

### 4.3 The in-flight marker

One reserved queue-state entry per queue, `__win:summon` (§13.9
S14), written by compare-and-set with `setReservedState`. Every
driver has the CAS this needs (§4.0 R5). Its value:

```ts
/** What `__win:summon` holds: the summon state of one queue, shared by every controller. */
interface SummonMarker {
  /** Shape version, so a later release can migrate it. Always `1` here. */
  v: 1;
  /**
   * A random string written when the entry is created and never changed
   * after. Hashed into every attempt id (§4.6), because the entry's version
   * restarts at `1` whenever the entry is deleted or the namespace purged
   * (`drivers/driver.ts:2634-2638`), and an id built from the version alone
   * would then repeat — which a platform that remembers tokens (ECS, 24 h)
   * answers as `deduped`, starting nothing (§4.0 R6).
   */
  epoch: string;
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

1. Read demand (§4.2: `countDemand` and `isQueuePaused`), live workers
   (`listWorkerRecords`), and the marker entry with its version: four reads,
   all needed anyway. A marker that does not exist yet is created in step 6
   with `expected = null` and a fresh `epoch`.
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
   count: want }`, where `id` hashes `(namespace, queue, epoch, version + 1)`
   (§4.6), and write with `expected = version`. If the CAS fails,
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
cold start, plus Bun boot, plus driver connect and `ensureQueue`, plus the
first report's **two** round trips — a duplicate-id read, then the write
(§4.0 R2) [S for the round trips; I, paas-ssh §7.6 for the rest]. It also belongs with the summoner, because it differs by
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
| lifetime of one summoned worker | `maxLifetime` → the worker's `runSummoned` deadline, and the platform's own cap where the adapter can set one (Cloud Run task timeout, Heroku `time_to_live`, `RuntimeMaxSec`, `activeDeadlineSeconds`, `maximumDurationInSeconds`) | `3_600_000` (1 h) |

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
  `(namespace, queue, marker epoch, the version the claim writes)`, truncated
  [D]. It is deterministic for one claim, so a retried call is
  byte-identical, and unique across claims even after the marker is deleted
  or the namespace purged, which the `epoch` is for (§4.0 R6; the draft hashed
  the version alone).
- **Superseded 2026-09-26 (§5.5): identity travels only in `request.argv`**,
  as `--bun-jobs-summon-*=` arguments; `request.env` carries the policy's
  static `env` and no summon identity. The paragraph below is the draft's, kept
  for the record.
- `request.env` carries only `BUN_JOBS_SUMMON_ID`, `BUN_JOBS_SUMMON_KIND`,
  the namespace, the queue, `BUN_JOBS_SUMMON_MODE` and
  `BUN_JOBS_SUMMON_MAX_LIFETIME_MS` (a *duration*), plus the policy's static
  `env`. The draft named the namespace and queue keys `BUN_JOBS_NAMESPACE`
  and `BUN_JOBS_QUEUE`; the first is already the runner's `CHILD_ENV.namespace`
  (§4.0 R19), so every key is under `BUN_JOBS_SUMMON_*` (§13.9 S8):
  `BUN_JOBS_SUMMON_NAMESPACE` and `BUN_JOBS_SUMMON_QUEUE`. **No
  `summonedAt`.** The worker reads its start time from its own clock, and
  the controller knows `at` from the marker.
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
| Worker mode | `"exit-on-idle"` | `"until-stopped"`: never exits on idle, because the platform would restart it [I, google-azure §5] |
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
  serving live records it last read. While `now < servedUntil`, a local
  `added` event does **nothing**: no timer and no driver call.
  With a worker up, this is the steady state.
- Otherwise the event arms one debounce timer per controller, not per job. A
  bulk add of 5,000 jobs is one check.
- A local `added` event for a job in `delayed` with a `runAt` inside the
  poll interval arms a one-shot timer at `runAt`, so a long-lived producer
  does not wait a whole poll for its own delayed job [D].

**Corrected 2026-09-25** (§4.0 R18): the draft ran `bun queue.ts --compare`
"with a controller attached to the `enqueue` scenario's queue and a live
worker", but `enqueue` and `enqueue-bulk` run no consumer at all
(`bench/queue.ts:48-49`), so the fast path was never what they would have
measured. PR-3 (§13) adds a harness switch that attaches a controller with a
no-op summoner to the bun-jobs contender (`bench/contenders/queue/bun-jobs.ts`)
in **every** scenario, and runs `--compare` against the existing baselines:

- `enqueue`, `enqueue-bulk`: **the no-worker path**. The listener arms one
  debounce timer per burst, and each fire costs four reads (§4.3 step 1) and,
  once, a claim. Against a producer adding thousands of jobs a second that
  should not register [I]; the run is what says so.
- `throughput`, `roundtrip`, `payload`, `contention`: **the fast path**, a
  live worker and `now < servedUntil`, so the listener returns at once.

The baselines are not re-recorded. If a figure moves beyond the guard's
tolerance, or a rival overtakes, that is the finding.

### 4.9 Driver requirements

Summoning needs a driver that **another host** can reach, and queue state for
the marker. The rules at construction [D]:

- `capabilities.multiProcess === false`: `ConfigError`. The memory driver
  cannot be shared with a summoned process (`drivers/memory-driver.ts:461-463`).
  Controller tests therefore run on SQLite or the file driver.
- `multiHost === false` with any summoner except SSH to `localhost`: a
  `warn`. The file driver and SQLite work only on one host
  (`driver.ts:63-65`) [S].
- `getQueueState` or `setQueueState` missing: `ConfigError`. No marker, no
  stampede guard, and decision 3 says that is not optional. All five
  first-party drivers have both (§4.0 R5).
- **No worker records** (`supportsWorkers(driver)` false,
  `drivers/readApis.ts:574-581`): `ConfigError`. Without records no attempt
  is ever released, so every one would end `lost` (§4.0 R3). All five
  first-party drivers have native records. On the worker side,
  `BunQueueWorkerOptions.summon` with `reportInterval: 0` is a `ConfigError`
  for the same reason [D].

### 4.10 Full signatures

Every exported name below was approved on 2026-09-25; §13.9 records each
choice and its reason: `SummonController` (S1), `SummonPolicy` (S2),
`defineSummoner`/`Summoner` (S3), `QueueDemand` and its fields (S12), the
`BunJobs` members (S16).

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
  /**
   * Live workers on the queue, from its heartbeat records: every live record,
   * parked and paused ones included, as §4.2's `workers` counts them (whether
   * anything alive may still hold the active jobs' locks). `0` on a driver
   * that keeps no worker records. (Was "live, running workers"; PR-1 follows
   * §4.2, 2026-09-26.)
   */
  workers: number;
  /** The earliest `runAt` still in the future, or `null` for none. */
  nextDueAt: number | null;
  /** `paused ? 0 : waiting + dueNow + stalled`: work a worker could claim now. For a ScaledJob. */
  demand: number;
  /** `paused ? 0 : demand + (active − stalled)`: everything not finished, each job once (§6.4 D1). For a ScaledObject. */
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
   * call is identical. Reaches the worker as `--bun-jobs-summon-id=` in
   * `argv` (§5.5), and comes back on its heartbeat record as `summon.id`,
   * which is how the attempt is released.
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
   * Environment for the summoned worker, for platforms that pass env per run:
   * the policy's static `env` only, never a timestamp. **Never summon
   * identity** (§5.5): an environment leaks to every descendant.
   */
  env: Readonly<Record<string, string>>;
  /**
   * The summon's identity as `--bun-jobs-summon-*=` arguments
   * ({@link SUMMON_ARGS}): **the only channel for it** (§5.5). A platform that
   * cannot pass arguments passes no identity (`passes: "none"`).
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
  /**
   * How the platform passes per-attempt values. **Revised 2026-09-26 (§5.5):
   * `"argv"` or `"none"`**; the draft's `"env"` is withdrawn, and the default
   * becomes `"argv"`.
   */
  passes?: "argv" | "none";
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
     * Check after an `added`, `waiting`, `delayed`, `promoted`, `resumed`,
     * `retried` or `repeatScheduled` event another process published through
     * the driver. Defaults to `true` where the driver's events cross
     * processes (`capabilities.events !== "local"`). Hears only producers
     * that publish (`publishEvents` defaults to `false`), and never a bulk
     * add, which publishes nothing (§2.1); the poll covers both.
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
   * (its `runSummoned` deadline) and to the platform's own cap where the
   * adapter can set one. Defaults to `3_600_000`.
   */
  maxLifetime?: number;
  /**
   * Which live workers count as serving the queue: any running worker
   * (`"any-worker"`, default) or only summoned ones (`"summoned-only"`, for a
   * queue whose always-on workers are deliberately capped).
   */
  servedBy?: "any-worker" | "summoned-only";
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
   * (`summonedFromArgs()` finds an id). Defaults to `false`, so a shared config
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
summonController(queue: string, policy?: SummonPolicy): SummonController;
```

`BunJobs` hands the controller its driver, namespace and logger, attaches the
`onAdd` hook (an `added` listener, §2.1) to the queue objects it creates
(`#queues`, `BunJobs.ts:322`), and closes controllers in `jobs.close()`
**first**, before the notifiers, workers and queues it closes today
(`#close`, `BunJobs.ts:1225-1246`), so no check is in flight when the driver
goes [D].

---

## 5. The summoned worker's side

### 5.1 Why the existing `drained` event is not the exit signal

The AWS evidence's worker sketch exits on `worker.on("drained", close)` [I,
aws §4]. `drained` fires once the queue has been *continuously* empty for
`drainDelay` (`#announceDrained`, `BunQueueWorker.ts:1968-1997`) [S].
`drainDelay` defaults to `0` (`queue/types.ts:1054-1055`, resolved at
`BunQueueWorker.ts:974`) [S], and at `0` it fires **on every empty pass**,
"once per poll, forever" by its own account (`:1971-1974`), so by default it
fires on the first one. Two cases make that unsafe for a summoned worker [I]:

- **Orphaned jobs.** A worker summoned because a dead worker's jobs are
  `active` sees nothing claimable until those locks lapse. They lapse after up
  to `lockDuration` (30 s) [S]. Then the queue's stalled sweep has to run,
  and it runs under a sweep lease. A dead holder "leaves two of its own
  cadences of lease behind, and the next worker's pass takes it over within
  one more", which is 90 s at the defaults (`BunQueueWorker.ts:2906-2915`,
  `SWEEP_LEASE_LIFETIMES = 2` at `:174`) [S]. A holder that closed
  gracefully released the lease (`:1602`), and every sweep also runs once at
  start (`#every`, `:4656-4677`), so after a *graceful* predecessor the wait is
  only the lock (§4.0 R12). A worker that exits on its first
  empty pass leaves before it can recover them, and the controller summons
  again.
- **Due work in other forms.** An empty claim pass says nothing about a job
  due in 2 s.

So `runSummoned()` decides idleness with the same `countDemand` reading the
controller uses:

```
idle ⇔ ownActive == 0
     ∧ demand.demand == 0
     ∧ ¬(demand.active > 0 ∧ otherLiveWorkers == 0)      // someone else's jobs, and no one alive to finish them
     ∧ (demand.nextDueAt == null ∨ demand.nextDueAt > now + idleFor)
```

It exits after `idle` has held continuously for `idleFor`, checked every
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
pass their platform's default as `--bun-jobs-summon-grace-ms` where they pass arguments,
and the recipe says to set `grace` explicitly otherwise [D]. **Every
first-party worker recipe also tells the user to raise the platform's grace
where it can be raised**: Fly `kill_timeout = 300` with `kill_signal =
"SIGTERM"` [V, paas-ssh §5.1], and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` [V,
paas-ssh §4.1]. A 5-second or 0-second grace against a 5-minute job means the
job is abandoned and recovered as stalled. That is correct, but it is slow and
it runs the job twice.

### 5.3 `runSummoned`

The names were approved on 2026-09-25 (§13.9): `runSummoned` (S4, was
`drainAndExit`), its modes `"exit-on-idle"`, `"until-stopped"` and
`"in-invocation"` (S5), its options with `idleFor` (S6, was `idleTimeout`),
`SummonedExit` (S7, was `DrainExit`), `WorkerSummonProvenance` (S15), and
`SUMMON_ARGS` and `summonedFromArgs` (S8 as superseded on 2026-09-26: §5.5
has the channel, and PR-2's code has the shapes).

```ts
// SUMMON_ARGS, WorkerSummonProvenance and summonedFromArgs() shipped in PR-2
// (lib/summon/args.ts, shared/workers.ts); §5.5 gives the channel and the rules.

/** How a summoned worker drains and stops. */
export interface RunSummonedOptions {
  /**
   * `"exit-on-idle"` (default): exit once idle for `idleFor`. `"until-stopped"`:
   * never exit on idle, only on a signal or the deadline, because the platform
   * restarts an exited service. `"in-invocation"`: as `"exit-on-idle"`, but resolve
   * instead of exiting and install no signal handlers, for a Lambda handler
   * that must return with no lease outliving the invocation [I, aws §2].
   */
  mode?: "exit-on-idle" | "until-stopped" | "in-invocation";
  /** How long the queue must stay idle (§5.1) before an `"exit-on-idle"` worker exits, in ms. Defaults to `30_000`. */
  idleFor?: number;
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
   * After a signal the worker closes gracefully only if the budget covers the
   * target's close and `tailReserve`, and with `force` otherwise (§5.3, the
   * close rule). Defaults to `--bun-jobs-summon-grace-ms`, else `10_000` (Cloud
   * Run's figure, the shortest common non-zero one).
   */
  grace?: number;
  /**
   * How much of the budget to keep for what `close()` does **after the
   * target has closed** (deregistering, flushing, metrics, dead letters, the
   * limiter, the driver), in ms. The target's own close is not part of it: that
   * bound is derived from #166's constants (§5.3, the close rule). Defaults to
   * `1_000` [I], unmeasured (Q38). A hard exit at `grace − 250` backs it up.
   */
  tailReserve?: number;
  /**
   * Signals that start a graceful stop. Defaults to `["SIGTERM", "SIGINT"]`:
   * SIGINT because Fly sends it by default [V, paas-ssh §5.1]. `false`
   * installs none. Ignored in `"in-invocation"` mode.
   */
  signals?: readonly NodeJS.Signals[] | false;
  /**
   * Treat SIGTSTP as "stop claiming" and SIGCONT as "resume", for Cloud Run
   * jobs over an hour [V, google-azure §3.2]. Defaults to `true` outside
   * `"in-invocation"`. Whether catching SIGTSTP delays the platform's pause is
   * unverified [U].
   */
  pauseSignals?: boolean;
  /**
   * Call `process.exit(code)` once closed. Defaults to `true`, except in
   * `"in-invocation"` mode. `0` after an idle drain, a deadline or a signal;
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
export interface SummonedExit {
  /** What ended it. */
  reason: "idle" | "parked" | "signal" | "deadline" | "error";
  /** The signal, when `reason` is `"signal"`. */
  signal?: string;
  /** How long it ran, in ms. */
  ranForMs: number;
  /** Jobs it completed. */
  completed: number;
  /** Attempts it failed. */
  failed: number;
  /** The exit code it used, or would have used in `"in-invocation"` mode. */
  code: 0 | 1;
}

/**
 * Runs a worker until it is no longer needed, then stops it cleanly. Starts
 * `worker.run()`, installs the signal handlers, watches idleness and the
 * deadline, and calls `worker.close({ timeout })` exactly once.
 */
export function runSummoned(
  worker: BunQueueWorker<any, any>,
  options?: RunSummonedOptions,
): Promise<SummonedExit>;
```

The signal path relies on something the worker already does right.
`close()` holds the process open for as long as closing takes, "whatever
`waitToExit` says", precisely so that a caller awaiting it in a signal handler
is not cut off halfway (`BunQueueWorker.ts:1568-1579`) [S]. `close()` also
hands the sweep leases over at once (`:1602`) [S], so the next summoned
worker does not wait out a lease.

**Reconciled 2026-09-25: what `close({ timeout })` bounds, and what it does
not** (§4.0 R14). `timeout` bounds only the wait for jobs in flight
(`BunQueueWorker.ts:1652-1671`). What follows it is not bounded by it:
`#closeTarget` (`:1708-1733`, capped at `DEFAULT_CLOSE_TIMEOUT` = 5,000 ms,
`shared/constants.ts:28`), `#unregister`, the throughput flush, metrics, dead
letters, the limiter and `driver.close()` (`:1683-1697`). The draft's `close
with timeout: grace − 1_000` therefore overruns whenever that tail exceeds a
second: a custom target whose `close()` hangs costs 5 s, which is **all** of
Fly's default grace [I from S]. So, as the design now stands [D]:

- `runSummoned` closes by **the close rule** below: gracefully, with the jobs'
  `timeout` what is left once the target's close and `tailReserve` are
  reserved, or with `force` when that leaves nothing;
- and it arms a **hard backstop** at `grace − 250` ms after the signal that
  calls `process.exit(code)` if `close()` has not returned. Exiting there
  leaves the heartbeat record to lapse (three report intervals) and any
  abandoned job's lock to lapse and be recovered as stalled: the
  at-least-once contract, unchanged (§12.3). Without the backstop the
  platform's SIGKILL does the same thing with no log line;
- `mode: "in-invocation"` arms no backstop, since it must return, not exit; it
  logs at `warn` when `close()` outlives the deadline instead.

**Issue #166 sequences this.** A `"child-process"` attempt that is still being
killed when `close()` returns is orphaned today (#166, reproduced on
`8bc0d1e` and on #164). The fix in progress gives `FileTargetExecutor` a
`close()` that waits for those kills, bounded by the same `#closeTarget` cap.
A summoned worker on a file target that exits via `runSummoned` is exactly
#166's reproduction, so `runSummoned` lands **after** #166, its tests include
a `"child-process"` target whose attempt ignores its signal (no orphan may
survive the exit), and its close rule budgets for #166's measured close times
(below; §13.5, PR-4).

**Per #166, pending its merge: the target's close, measured, and `force`.**
The bun-jobs session's #166 fix (final design, not merged when this was
written) gives these, all to be re-checked against the merged code [per #166,
pending its merge]:

- **`WorkerTargetExecutor.close?()` gains an optional `options?: { force?:
  boolean }`**, additive: a custom target that ignores it keeps working.
  `worker.close({ force: true })` kills a built-in target's children
  **immediately**; an expired `timeout` gives them a grace period first — IPC
  `close`, then `SIGKILL` at **4,000 ms**. `#closeTarget` passes `force`
  through.
- **Measured close times:** after a timeout expires with a runaway child,
  about 4,000 ms plus up to 500 ms of reaping, so **always ≤ 4,500 ms**,
  inside `#closeTarget`'s 5,000 ms bound; a well-behaved child takes about its
  own cleanup time (**510 ms** measured, for 300 ms of cleanup after a 200 ms
  `timeout`); `force` takes **~12 ms** measured, and **at most 500 ms** — the
  only wait after the synchronous `SIGKILL` is the reap, capped at
  `TARGET_CLOSE_REAP` on a ref'd timer (#166's test asserts `< 1,000 ms`). All
  three constants derive from `DEFAULT_CLOSE_TIMEOUT` (5,000 ms,
  `shared/constants.ts:28`) and are asserted in #166's unit test.
- `close({ force: true })` already abandons jobs in flight without waiting:
  their locks lapse and the stalled sweep returns them
  (`BunQueueWorker.ts:1624-1647`) [S]. What #166 adds is that the target's
  children die at once too, instead of after the graceful 4,000 ms.

**The close rule** [D, from the figures above]. When `runSummoned` starts
closing (a signal, the deadline, or idleness), let **`A`** be the time left
until the hard backstop: `grace − 250` after a signal, `deadline − 250 − now`
at the deadline. The target's close is bounded by **`targetClose`**, derived
rather than chosen:

| Target | `targetClose`, graceful | `targetClose`, `force` |
|---|---|---|
| built-in, with children (`"child-process"`; per #166, its other built-in targets with children) | **4,500 ms** = #166's 4,000 ms SIGKILL + ≤ 500 ms reaping, both from `DEFAULT_CLOSE_TIMEOUT` | **≤ 500 ms** (~12 ms measured), #166's reap cap |
| `"in-process"` (no children) | ≈ 0 | ≈ 0 |
| custom (`WorkerTargetFactory`) | 5,000 ms, `#closeTarget`'s cap (`DEFAULT_CLOSE_TIMEOUT`) | 5,000 ms: it may ignore `force` |

Then:

- **graceful** while `A ≥ targetClose(graceful) + tailReserve`: `close({
  timeout: A − targetClose(graceful) − tailReserve })`, so the jobs get
  everything the tail does not need;
- **`force`** otherwise: `close({ force: true })`. The jobs get no wait and are
  recovered as stalled, which is what SIGKILL would have done anyway, but the
  record is unregistered, the leases handed over and the children killed
  first, with a log line;
- **the hard backstop at `grace − 250` stays** in both, for a tail that
  overruns its reserve (a custom target that hangs).

The arithmetic, with `tailReserve` at its 1,000 ms default [I] and `A` at the
moment of the signal:

| Platform (grace) | `A` | Child-process target: needs 4,500 + 1,000 | In-process target: needs 0 + 1,000 |
|---|---|---|---|
| **Railway** (0 s default) | −250 ms | **`force` from the start: the only option**, and SIGKILL may land before it completes; the recipe raises `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (§5.2) | `force` from the start, the same |
| **Fly** (5 s default, sent on SIGINT) | 4,750 ms | 5,500 > 4,750: **`force`**. A graceful close could take 4,500 ms in the target alone, leaving about 0.25 s for everything else before the backstop | graceful; jobs get 3,750 ms |
| Cloud Run (10 s) | 9,750 ms | graceful; jobs get 4,250 ms | graceful; jobs get 8,750 ms |
| ECS, Heroku, Kubernetes (30 s) | 29,750 ms | graceful; jobs get 24,250 ms | graceful; jobs get 28,750 ms |
| Fly with `kill_timeout = 300` | 299,750 ms | graceful; jobs get 294,250 ms | graceful; jobs get 298,750 ms |

A custom target on Fly's default grace needs 5,000 + 1,000 even when forced,
so the backstop at 4,750 ms may fire; that is what the backstop is for. The
rule is evaluated once, when closing starts: the budget only shrinks, so a
graceful choice never needs revisiting except by the backstop.

**Four more rules the reconciliation adds** [D]:

- **Install the signal handlers before `run()` connects.** A platform may stop
  a unit during boot; a signal before `run()` resolves still closes and exits
  0.
- **A second SIGINT exits at once**, with code 130, so a developer's Ctrl-C
  is not held hostage by a drain.
- **SIGCONT resumes only a pause SIGTSTP made.** `resume()` clears the local
  pause unconditionally (`BunQueueWorker.ts:1367-1373`), so without a flag a
  SIGCONT would undo an operator's pause.
- **A parked summoned worker exits.** A worker an operator parked
  (`state: "stopped"`) serves nothing and costs money; it exits with reason
  `"parked"` after `idleFor`, whatever demand says [D].

### 5.4 Registration, so the guard releases

On `BunQueueWorkerOptions` (`queue/types.ts:910`) [D] — the option is
`summon`, the record's name (§13.9 S15):

```ts
/**
 * Where this worker was summoned from, written on its heartbeat record as
 * `summon` so the controller can release the attempt and the Workers page can
 * show a badge. Pass `summonedFromArgs()`. Absent for an ordinary worker.
 * A `ConfigError` whenever the worker could never report — `reportInterval:
 * 0` (§4.0 R3), or a driver that cannot store worker records (added
 * 2026-09-26) — since it could never release its attempt.
 */
summon?: WorkerSummonProvenance | undefined;
```

On `WorkerInfo` (`drivers/driver.ts:1427-1591`, beside Phase 1's `target`,
`:1565-1579`) [D]:

```ts
/**
 * Set when the worker was summoned: the attempt id (required), the
 * summoner's kind, the platform's handle, and the mode and deadline **as the
 * summoner requested them** — each absent when not requested, never
 * defaulted. Absent on an ordinary worker, and on a record from before this
 * existed.
 */
summon?: WorkerSummonProvenance;
```

The first record is written after `ensureQueue` (`BunQueueWorker.ts:1311`),
by a report that is not awaited (`:1329`), whose first write reads the live
records once for a duplicate id (`:4161-4164`) before it writes (`:4177`) [S].
So an attempt is released about **two** driver round trips after the summoned
worker's `ensureQueue`, plus one check interval of the controller's [I; the
draft said one round trip].

**Where it is written, and the precedent.** `#report()` writes `summon`
beside `sweeps` and Phase 1's `target` (`BunQueueWorker.ts:4202-4206`),
always from the value the worker was built with. The type lives in
`shared/workers.ts` beside `WorkerTargetInfo` (`:230-263`), so the change
inside `lib/drivers/**` is additive, exactly as Phase 1's was
(`worker-runtimes.md` §4.2.4). The DTO follows the same six places Phase 1
touched for `target`: `WorkerDto` (`api/contract/types.ts:1789-1898`),
`WorkerSchema` (`api/schemas/workers.ts:185-258`), `toWorkerDto`
(`api/serialize.ts`, which copies each optional field explicitly), the
`DeepEqual` drift assertion in `__tests__/api/api-contract.type-test.ts`, the
round trip in `__tests__/api/api-sources.test.ts`, and the OpenAPI component
list pinned in `__tests__/api/api-workers.test.ts`. `summon.handle` is
infrastructure — an ECS task ARN contains the AWS account id — so the
serializer withholds it unless the new `serialize.exposeSummonHandles` is on
(default `false`). **Revised 2026-09-26:** the draft gated it on `exposeHosts`,
which defaults to `true` [D, the bun-jobs session's review of #178, 2026-09-26].

The recipe:

```ts
// worker.ts: the one file every summoned platform runs
import { BunJobs, runSummoned, summonedFromArgs } from "@kingsleyweb/bun-jobs";
import { handlers } from "./jobs";

const summon = summonedFromArgs();   // --bun-jobs-summon-*= on the command line
const jobs = new BunJobs({ namespace: summon?.namespace ?? "shop", driver: { url: process.env.JOBS_URL! } });
const worker = jobs.worker(summon?.queue ?? "emails", handlers, {
  summon,                    // provenance on the record → the controller releases the attempt
  concurrency: 8,
});
await runSummoned(worker, { idleFor: 30_000 });   // exits the process
```

And for default Lambda, where the worker must live **inside** one invocation
[I, aws §2]:

```ts
export const handler = async (_event: unknown, context: { getRemainingTimeInMillis(): number }) => {
  // A Lambda invocation has no command line: its provenance comes from the
  // invoke payload, whose reader PR-3/1.5c defines (Q43).
  const worker = jobs.worker("emails", handlers, { summon: summonFromEvent(_event) });
  return await runSummoned(worker, {
    mode: "in-invocation",
    deadline: () => Date.now() + context.getRemainingTimeInMillis(),
  });
};
```

Construct the worker in the handler, never at module scope. A worker built
during Init would outlive the invocation into a freeze [V/I, aws §2]. Under
Lambda MicroVMs it would also share its worker id across every restored VM
[V, aws §4.7]. Its lock token is not shared: since #187/#191 a token is minted
per claim, at claim time (`${HOST}:${pid}:${uuid}:${workerId}`, read with
`parseToken`), and the #191 follow-up draws that uuid from an unbuffered
source (`node:crypto`'s `randomUUID({ disableEntropyCache: true })`), so
restored VMs do not repeat one. The global `crypto.randomUUID()` would not
do: it and `getRandomValues` share an entropy cache that a snapshot copies
(measured by the bun-jobs session on Bun 1.4.3). The shared worker id still
makes the restored VMs' heartbeat records collide. PR-3's marker `epoch` uses
the same unbuffered source, for the same reason.


### 5.5 The identity channel: arguments only (revised 2026-09-26)

**The finding** (the bun-jobs session's review of #178, 2026-09-26, reproduced by the coordinator
on Bun 1.4.3). `Bun.spawn` with **no `env`** passes the process's environment
**as it was at startup**, ignoring the live `process.env`. A program that read
`BUN_JOBS_SUMMON_ID` and then deleted it still had a `Bun.spawn` child see it;
with `env: process.env`, or through `node:child_process`, it was unset.
**Command-line arguments are not inherited at all** (control: the child's
argv was `[]`). So the draft's env channel leaked the summon identity to every
`Bun.spawn` descendant — from an in-process processor, from a worker-thread
target's thread, from user code — and each would have claimed the attempt.
The `BUN_JOBS_CHILD` guard covered only bun-jobs' own executors' direct
children, and reading-then-deleting cannot fix a leak of the startup
environment. PR-2's tests reproduce it as their negative control [M].

**The user's decisions (2026-09-26)** [D]:

1. **Identity travels only as command-line arguments**,
   `--bun-jobs-summon-<key>=<value>` (`SUMMON_ARGS`: `id`, `kind`, `mode`,
   `namespace`, `queue`, `max-lifetime-ms`, `grace-ms`). The environment is
   never read for provenance. `summonedFromEnv()` → **`summonedFromArgs(argv
   = process.argv)`**, `SUMMON_ENV` → **`SUMMON_ARGS`**. This supersedes S8's
   keys (§13.9).
2. **`handle` has its own API switch, `exposeSummonHandles`, default
   `false`**, beside `exposeRunnerFiles`/`exposeProcessorFiles`, and is not
   gated on `exposeHosts` (default `true`), because an ECS task ARN contains
   the AWS account id.

**And the review's agreed fixes** [D]:

- **`id` makes a worker summoned.** Without `--bun-jobs-summon-id=`,
  `summonedFromArgs()` is `undefined` whatever other arguments say, and
  `WorkerSummonProvenance.id` is required.
- **`mode` and `deadlineAt` are "as requested by the summoner"** and never
  defaulted: absent when not requested, per the rule behind `target` and
  `sweeps`. PR-4 reports the worker's own resolved mode through a getter, the
  way `#report` writes `sweeps` from what the worker actually arms.
- **`summon` on a driver that cannot store worker records
  (`!supportsWorkers`) is a `ConfigError`**, like `reportInterval: 0`: either
  way the worker could never report, so never release its attempt.
- **The `BUN_JOBS_CHILD` check stays, refuse-only** (amended the same day).
  A `Worker` thread runs in its parent's process; Bun 1.4.3 gives it an empty
  `process.argv` and `Bun.argv` (measured), but **Node copies the parent's
  argv into a worker by default**. If Bun ever adopted that, every
  worker-thread target would claim its parent's attempt. So
  `summonedFromArgs()` returns `undefined` when `BUN_JOBS_CHILD === "1"`,
  whatever the arguments say: the environment is read only to refuse
  provenance, never to grant it, so it cannot reintroduce the leak. It also
  keeps a runner child's own arguments from reading as a summon.

**Consequences for the providers** [I, to be settled per provider in 1.5p
and 1.5c–e]:

- `passes` becomes `"argv" | "none"`. Each launch API must be re-read for a
  per-run argument override (ECS `containerOverrides.command`, Cloud Run jobs'
  and ACA jobs' per-execution args, Render's `startCommand`, SSH's command
  line) [U per platform]. One without it passes `"none"` and is released by
  start time (§4.3 step 2), as Fly already is.
- **Lambda has no command line**: its identity must come from the invoke
  payload (Q43).
- `request.env` keeps the policy's static `env` only.

**Claim-once, added to PR-3** [D]. With arguments a platform double-start can
still start two processes with the same id. PR-3 adds **claim-once**: the
first process to atomically claim an attempt id wins; a second claimant
(a platform double-start, or any descendant that somehow sees the arguments)
loses and runs unsummoned. PR-2 does not build it.

**As built in PR-3 (2026-09-26)** [S, `lib/summon/claim.ts`]:

- **The claim** is a reserved queue-state entry per attempt,
  `__win:summon-claim:<hash of id>`, holding `{ capacity, holders[], at }`,
  written only by compare-and-set. A worker claims in its first report, before
  any record says it was summoned. An attempt for `count > 1` starts all its
  units with one id, so the controller opens the entry with `capacity: count`
  before calling the summoner; otherwise the first claimant creates it with
  capacity 1. "Once" therefore means "at most `count` live processes".
- **A restart is not a double start.** A platform restart (a scale-style
  service, a container restart policy) runs the same arguments in a process
  with a new worker id. **The rule: a claimant may take a holder's place when
  that holder is gone — its worker record is not among the live ones
  (`listWorkerRecords` at the claimant's `now`) and the holder's `until` has
  passed**, `until` being its claim time plus one record lifetime
  (`reportInterval × 3`), so a holder that has claimed but not yet written its
  first record is never taken for dead. The takeover is a compare-and-set on
  the entry, like the claim.
- **A displaced holder steps down.** A summoned worker re-reads its place on
  every later report; if it was taken over (it was only paused, not dead), it
  runs unsummoned from then on, so two live records never carry one id for
  more than a report interval.
- Claim entries are swept, at most hourly, from a controller's poll once
  older than `max(24 h, maxLifetime + bootBudget)`.

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
   (`drivers/sql/sql-driver.ts:4320-4340`, plus #159's `UNION ALL` branches;
   `drivers/mongo/mongo-driver.ts:4277-4287`) [S, re-read at `0a8e580`]. KEDA
   polls every 30 s per scaler.

`paas-ssh.md` also raises one point the route must answer. KEDA counts running
*Jobs*, not bun-jobs workers, so a worker started elsewhere does not reduce
KEDA's count [I, paas-ssh §6.2]. That is open question Q12.

### 6.2 Routes [D]

The paths (S11) and the response fields (S12) are approved as below; the
action is `queues.summon` (S17).

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
(`api/config.ts:527`, `:569`) [S, re-read at `0a8e580`]. The recipe mounts a
**second** `createJobsApi` for the scaler:

```ts
const scalerApi = createJobsApi({
  jobs, basePath: "/scaler", readOnly: true, actions: ["queues.read"],
  authorize: ({ req }) => req.headers.get("authorization") === `Bearer ${process.env.SCALER_TOKEN}`,
});
```

It can read demand and nothing else. `queues.summon` is a write that spends
money, so it is never in a read-only API. It joins `JOBS_API_ACTIONS`
(`api/contract/constants.ts:19-68`), **`JOBS_API_MUTATIONS`** (`:84-117`, so
`readOnly: true` removes it) and **`JOBS_API_OPT_IN_ACTIONS`** (`:136-144`,
so it is off unless `actions` names it, like `workers.configure`) [D; the
draft named only the first, and the other two sets are what "granted on
purpose" means in this code]. The demand routes need no driver feature
(`countDemand` is optional, with a fallback), so they carry no `requires`;
`/meta` gains `features.demand` from `DRIVER_FEATURES` (`api/routes/meta.ts:62`)
saying whether the figures are exact [D].

### 6.3 Prometheus exposition: worth it

It serves three consumers the JSON cannot:

- KEDA's `metrics-api` scaler accepts `format: prometheus` [W: keda.sh
  metrics-api v2.21, 2026-09-25].
- GKE's native HPA scale-to-zero (GA in 1.37, announced 2026-09-24) reads
  Managed Prometheus [V~, google-azure §3.5].
- CREMA has a verified Prometheus scaler [V~, google-azure §3.3].

It is about 40 lines of text rendering [I]:

```
# TYPE bunjobs_queue_demand gauge
bunjobs_queue_demand{ns="shop",queue="emails"} 15
bunjobs_queue_outstanding{ns="shop",queue="emails"} 16
bunjobs_queue_waiting{ns="shop",queue="emails"} 12
bunjobs_queue_due{ns="shop",queue="emails"} 3
bunjobs_queue_stalled{ns="shop",queue="emails"} 0
bunjobs_queue_active{ns="shop",queue="emails"} 1
bunjobs_queue_workers{ns="shop",queue="emails"} 0
bunjobs_queue_paused{ns="shop",queue="emails"} 0
```

How KEDA's `valueLocation` addresses a Prometheus sample was not confirmed by
the re-read (Q13). This is a metric *source*, not a general metrics exporter.
`opentelemetry.md` owns the latter. **Checked 2026-09-25:** its catalogue
(§5) names every instrument under `bunjobs.` (`bunjobs.queue.jobs`,
`bunjobs.worker.count`, …) with the queue as `messaging.destination.name`,
which an OpenTelemetry Prometheus exporter renders as `bunjobs_…`. The
draft's `bun_jobs_…` names would have sat beside those under a different
prefix, so the metrics are `bunjobs_queue_*` (§13.9 S12, approved). A `capped` sample
(`bunjobs_queue_demand_capped`, 0 or 1) says when the figures are lower
bounds (§6.4).

### 6.4 `countDemand`: the driver method, specified before code

**Rewritten 2026-09-25 as the spec for PR-1** (§13.2). The bun-jobs session,
which implements it, asked for four things settled here before any code,
because they are where count work went wrong this month (#159): exactly which
states count; whether due work is read through promotion or counted directly;
what the cap returns; and a measured index plan per driver. The first three
are decided below [D]. The fourth was a plan per driver **marked unmeasured**
until PR-1's first task measured it; D4 now carries the measurements. The name is `countDemand`, its answer `DemandCounts` (§13.9 S9).

**Corrected 2026-09-26 by the bun-jobs session's review** (it implements
PR-1), each checked against the code: D1 now requires an explicit null guard
on the JavaScript drivers (superseded the same day by implementation
correction 1); D2's "counted twice at worst, never missed" is
narrowed to what holds for a claim; and the lockless-row contract case runs on
every driver and asserts agreement with `countJobs`, not a fixed answer. The
[review corrections](#review-corrections-2026-09-26) at the end of this
section give each one's evidence.

**Line references in §6.4 are re-read at PR-1's head (2026-09-26), not at
`0a8e580`,** and each names its symbol, so a later move is easy to follow;
schema references (`schema.ts:596`, `:615`) were unchanged.

**Implemented and measured 2026-09-26 (PR-1).** D4's plans are measured on
every engine, and building to them corrected five points, recorded in the
[implementation corrections](#implementation-corrections-2026-09-26): above
all, `stalled` is defined by each engine's own stalled sweep rather than by a
null-guard rule, which was wrong on Redis and file.

```ts
/** On `QueueDriver` (drivers/driver.ts), beside `countJobs` (:2325). */
/**
 * How much work a worker could claim at `now`, for summoning and the depth
 * endpoint: a few bounded reads, never a scan of retained history.
 *
 * Optional. Without it `readDemand` falls back to `countJobs`,
 * `nextDelayedAt`, `isQueuePaused` and `listWorkerRecords`, which is correct
 * as a trigger but scans history on some backends. Never counts `completed`,
 * `dead` or `waiting-children`, and never writes: it promotes nothing,
 * recovers nothing and publishes nothing.
 */
countDemand?: (
  q: QueueRef,
  now: number,
  options: {
    /** Count each figure up to this many; past it the figure is `cap` and `capped` is `true`. A positive integer. */
    cap: number;
  },
) => Promise<DemandCounts>;

/** What `countDemand` answers. Each figure is at most `cap`. */
export interface DemandCounts {
  /** Jobs in `waiting`, whatever their `runAt` (see D1). */
  waiting: number;
  /** Jobs in `delayed` or `failed` (retry pending) whose `runAt <= now`: due, not yet promoted. */
  dueNow: number;
  /**
   * Jobs in `active` that this driver's own `recoverStalled` would recover at
   * `now` — exactly that set (D1): every lapsed lock, and a lockless job where
   * the sweep takes one (Redis, file) but not where it skips one (memory,
   * SQL, Mongo).
   */
  stalled: number;
  /** Jobs in `active`, lapsed or not — the same figure `countJobs(q).active` reports on this driver. */
  active: number;
  /** The earliest `runAt > now` among `delayed` and `failed` jobs, or `null` for none. Never capped. */
  nextDueAt: number | null;
  /** `true` when at least one figure's true value is above `cap`, so the figures are lower bounds. */
  capped: boolean;
}
```

`paused` and `workers` are not part of it. `readDemand` adds them from
`isQueuePaused` and `listWorkerRecords`, which every driver has.

#### D1. Which states count as demand, exactly

| State, as stored | Counted in | Why |
|---|---|---|
| `waiting` | `waiting` | Claimable now, or within clock skew. **No `runAt` predicate**, although every claim path adds `runAt <= now` (SQL `claimWindowFilter`, `drivers/sql/dialect.ts:867-880`; memory `#firstClaimable`) [S]: a waiting job with a future `runAt` exists only when the process that promoted or added it has a clock ahead of the reader's, it needs a worker all the same, and leaving the predicate off keeps the figure equal to `countJobs(q).waiting` — #159's rule that a count must agree with the count beside it |
| `delayed`, `runAt <= now` | `dueNow` | Due, and waiting only for a worker's promotion (D2) |
| `failed`, `runAt <= now` | `dueNow` | `failed` is "this attempt failed and another is due at `runAt`" (`JobState`, `drivers/driver.ts:857-873`) [S]: a due retry, the same case |
| `delayed` or `failed`, `runAt > now` | nowhere; the earliest is `nextDueAt` | Not yet work; `runSummoned` and the controller's one-shot timer read `nextDueAt` |
| `active`, lock lapsed (`lockExpiresAt` not null and `<= now`) | `stalled` **and** `active` | Its worker died holding it; only a worker's stalled sweep returns it (§4.0 R12). Every engine's sweep recovers it |
| `active`, no lock (`lockExpiresAt` null) | `stalled` **exactly when this engine's `recoverStalled` recovers it** (Redis, file; not memory, SQL, Mongo — see below); `active` **exactly when `countJobs(q).active` counts it** | `stalled` follows the sweep, below. For `active`: #159 added `LOCK_NOT_NULL` (`drivers/sql/schema.ts:596`) to the `active` count only where it buys a partial index — **Postgres and SQLite** (`#listNotNull`, `sql-driver.ts:4504-4508`; `hasPartialIndexes`, `schema.ts:615`). **MySQL, MariaDB, memory, file, Redis and Mongo** count the row. `active` follows `countJobs` on each, which is D1's rule of agreeing with the count beside it |
| `active`, lock live | `active` only | Somebody holds it. Whether that somebody is alive is §4.2's `orphaned` (`active > 0 && workers == 0`), which the controller derives from `QueueDemand.workers`; not the driver's business |
| `completed`, `dead` | never | Finished |
| `waiting-children` | never | Not runnable until its children settle (`drivers/driver.ts:872-873`). The crash-repair case is §4.2's accepted gap |
| any state, **queue paused** | the driver counts as usual | `countDemand` ignores pause. `readDemand` sets `demand = outstanding = 0` when `isQueuePaused`, keeps the raw figures, and reports `paused: true`, so the depth endpoint shows a paused backlog as a backlog that demands nothing |

**`stalled` is exactly the set this engine's `recoverStalled` would recover
at `now`** [D, corrected 2026-09-26]. This replaces the earlier rule that a
lockless `active` row is "never in `stalled`, on every driver", guarded by an
explicit null test on the JavaScript drivers. That rule was wrong: it held
only for memory and SQL (and Mongo). Every engine's sweep takes a job whose
lock has lapsed; they differ on an `active` job with **no** lock, and
`countDemand` mirrors each sweep exactly, lockless jobs included where the
sweep includes them:

| Engine | Its sweep | A lockless `active` job in `stalled` |
|---|---|---|
| Memory | skips `lockExpiresAt === null` before comparing (`null <= now` is `true` in JavaScript) | no |
| SQL, all four | `lock_expires_at <= now`, which `NULL` never matches | no |
| MongoDB | `lockExpiresAt: { $lte: now }`, which `null` never matches | no |
| Redis | `ZRANGEBYSCORE active -inf now` (`RECOVER_STALLED`), over a set that scores a lockless job at `createdAt` (the add script's `stamp()` fallback) | **yes** |
| File | markers prefixed `lockExpiresAt ?? 0` (`#markerFor`), recovered by prefix with no null check | **yes** |

The reason is the trigger's: summoning for a job the sweep will recover is
right, and summoning for one no sweep recovers would summon forever for
nothing. **Issue #185 will make memory and SQL recover lockless jobs too;
defined this way, that fix changes the figure on those engines and this
section not at all.** Each `countDemand`'s predicate is a copy of its sweep's
rather than a call to it, so #185 updates both, and the agreement case (D4's
contract cases) fails until it does.

So `demand = paused ? 0 : waiting + dueNow + stalled` and
`outstanding = paused ? 0 : demand + (active − stalled)`. **The draft's
`outstanding = demand + active` counted a stalled job twice** (it is in both
`stalled` and `active`); the subtraction is the correction [D].

#### D2. Due work is counted directly, never read through promotion

`countDemand` counts `delayed`/`failed` rows with `runAt <= now` where they
stand. It does not call `promoteDelayed`, and does not require promotion to
have run. Why [D]:

- **The controller must not write.** `promoteDelayed` moves jobs (a write per
  batch) and is a worker's liveness duty (`#promote`, `BunQueueWorker.ts:2273`, on a 1 Hz
  timer). A controller in a producer or the API process that promoted would be
  a partial worker: it would move jobs with nobody to claim them, publish
  nothing (`#promote` emits no `promoted`), and add a write to every poll.
- **With no worker, promotion never runs**, so the figures would be wrong in
  exactly the case summoning exists for (decision 2).
- **With a worker, the two paths disagree only transiently**, and the
  controller does not care which side a job is on: `dueNow + waiting` is the
  same total before and after a promotion.

**The one hazard is a read that straddles a promotion**, and it is handled by
order, not by locking. Where the driver's reads are separate statements
(Mongo, file), a job promoted between a `waiting` read and a `dueNow` read is
counted in neither. So **`countDemand` reads the source states before the
destination state**: `stalled` and `active` first (recovery moves `active` →
`waiting`), then `dueNow` (promotion moves `delayed`/`failed` → `waiting`),
then `waiting`. A job that **recovery or promotion** moves mid-call is then
counted twice at worst, never missed; an over-count by the jobs that moved
during one call is harmless to a trigger and to a scaler [I]. On file, a
promotion holds its marker outside both directories for a moment, so
`countDemand` counts the held `delayed`/`failed` markers in `dueNow`, read
with them; without that, the hold would reopen the gap the order closes.

**A claim moves the other way** (`waiting` → `active`), so the order cannot
cover it: a job claimed between the `active` read and the `waiting` read is in
neither (corrected 2026-09-26). Precisely [D]:

- **`demand` is never under-counted.** A claimed job is not demand, so missing
  it is correct, and `runSummoned`'s `demand == 0` exit stays sound.
- **`outstanding` can under-count on the separate-read drivers (Mongo, file)**
  by the jobs claimed during one call: transient and small, and harmless to a
  scaler, which reads again next poll. A contract case built on "never
  missed" for `outstanding` would be wrong in general and flaky under load, so
  there is none.
- **The single-snapshot drivers are unaffected.** Where one statement or one
  script serves all figures (Redis's script, SQL's single `SELECT`), the read
  is one snapshot, so neither a promotion nor a claim can straddle it and
  order does not matter — one reason they are the stronger implementations.
  See the per-driver rows. The contract suite asserts
the order where it matters, with a driver whose reads are interleaved with a
promotion (negative control: reversing the order must lose the job).

#### D3. The cap

- **Each figure is counted up to `cap + 1` and reported as `min(count,
  cap)`.** `capped` is `true` iff at least one figure's count reached `cap +
  1`, which distinguishes "exactly `cap`" from "more than `cap`". A driver
  whose count is O(log n) regardless (Redis) applies the same `min` so the
  contract is uniform.
- **`nextDueAt` is never capped**: it is one probe.
- **`readDemand`'s default `cap` is `10_000`** (`DEFAULT_DEMAND_CAP`), and
  `queue.getDemand({ cap })` takes another. **The summon controller (PR-3),
  not `readDemand`, raises it** to `maxWorkers × jobsPerWorker` when that is
  finite and larger, so a capped `outstanding` can never under-state `wanted`
  [D]. `demand` and `outstanding`
  are sums of capped figures, so they can exceed `cap` (up to 3× and 4×); when
  `capped` they are lower bounds.
- **What the controller does with it:** nothing different. It reads
  `demand > 0` and `ceil(outstanding / jobsPerWorker)` clamped to
  `maxWorkers`, and a lower bound serves both, by the rule above.
  `runSummoned` reads only `demand == 0`, which a cap cannot hide.
- **What the depth endpoint does with it:** returns `capped` in the JSON, and
  `bunjobs_queue_demand_capped` in the exposition (§6.3). The endpoint takes
  no `cap` from the caller [D]: a scaler targeting one pod per 500 jobs needs
  no more than 10,000.

#### D4. The index plan per driver — **measured 2026-09-26**

#159 measured that a *grouped* count cannot absorb a per-state predicate the
way a listing can (`countJobs`: Postgres 10.8 ms → 141.8 ms, SQLite 3.1 ms →
37.7 ms), while a **per-state** count with a predicate cost nothing (1.52 ms
against 1.49 ms) (`#countNotNull`'s comment, `drivers/sql/sql-driver.ts:4521-4571`, and #159's commit)
[S]. So every figure below is a **per-state** count, never a `GROUP BY`.

**Measured** as PR-1's first task [M, 2026-09-26], through each driver's own
client, on #159's fixture (per queue: 64 `active`, 8 of them lapsed; 5,000
`waiting`; 2,000 `delayed`, 1,000 due; 40,000 `completed`; 1,000 `failed`,
500 due; 500 `dead`; 500 `waiting-children` — 49,064 rows; 8 queues on SQL
and MongoDB, one elsewhere, whose per-queue structures are separate) and on a
variant with **10× the `completed` history**, `cap` 10,000, medians,
interleaved rounds. The claim proved: **`countDemand` does not move with
retained history on any engine, while `countJobs` grows 5–11×**, and the
negative control (the index dropped, or hinted away) grows 4–27×, so the flat
line is the index and not a small table. Each engine's numbers are also in a
comment beside its implementation, as `#countNotNull`'s are.

| Driver | Reads, in order (D2) | Index each uses (plan, both fixtures) | `countDemand`, base → 10× history | Controls: `countJobs`; no index |
|---|---|---|---|---|
| **Memory** | synchronous, one pass: `waiting` from the waiting index (its length); `active` from an **active-id `Set`** (its size) and `stalled` from a walk of that set; `dueNow`/`nextDueAt` from a walk of `scheduled` | in-heap sets; **the `Set` is new in PR-1** (below) | **0.089 → 0.131 ms** | 0.58 → 13.1 ms; D4's original walk of every job, 0.49 → 8.99 ms |
| **File** | `readdir` of `index/active`, then `index/delayed`, `index/failed` and the held-marker directory, then `index/waiting`; figures from marker-name prefixes | sorted marker names; no record is opened | **6.75 → 7.50 ms** — **bounded by the backlog, not by `cap`** (below) | 30.6 → 259.4 ms; `readdir` of the record directory, 29.4 → 253.8 ms |
| **SQL**, one `SELECT` of scalar subqueries, each `(SELECT COUNT(*) FROM (SELECT 1 FROM jobs WHERE ns = ? AND queue = ? AND … LIMIT cap + 1) t)` | `stalled`: `state = 'active' AND lock_expires_at <= now` (the predicate `recoverStalled` selects by); `active`: `state = 'active'` plus exactly `#listNotNull(["active"])`; `dueNow`: one subquery per state for `delayed` and `failed`, `run_at <= now`; `waiting`: `state = 'waiting'`; `nextDueAt`: **per-state** `MIN(run_at) … AND run_at > now` (below) | see the rows below. One statement is one snapshot on all four engines, so D2's order is moot here. `cap` bounds the entries read: at `LIMIT 1000` against 5,000 waiting, Postgres, MySQL and MariaDB read 1,000 | | |
| ↳ Postgres 16 | as above | Index Only Scan on the partial `ix_lock` (`stalled`, `active`, 3 buffers, heap fetches 0) and on `ix_due` (`dueNow`, `waiting`, the `MIN`s); the generic plan a cached statement switches to after five runs is identical | **1.59 → 1.64 ms** | 10.2 → 56.2 ms; indexes dropped in a rolled-back transaction, 211 → 5,630 ms |
| ↳ SQLite 3.53 | as above | `COVERING INDEX` `ix_lock` / `ix_due` on every figure | **0.95 → 1.17 ms** | 12.5 → 141.8 ms; `INDEXED BY` the primary key, 18.9 → 164.1 ms |
| ↳ MySQL 8.4 | as above; `LIMIT` inside a derived table is allowed | covering reads of plain `ix_lock`, `ix_due` or `ix_claim` (the planner's pick varies with table size); the `MIN`s resolved from the index at plan time; each `LIMIT` derived table materialised (≤ cap + 1 rows) | **5.97 → 5.05 ms** | 57.3 → 430.5 ms; `FORCE INDEX (PRIMARY)`, 275 → 2,445 ms |
| ↳ MariaDB 11.8 | as MySQL | `using_index` on `ix_lock`, `ix_due`, `ix_claim`; the `MIN`s "Select tables optimized away" | **7.13 → 6.36 ms** | 98.0 → 484.2 ms; `FORCE INDEX (PRIMARY)`, 609 → 2,412 ms |
| **Redis**, one Lua script (`COUNT_DEMAND`) | `ZCOUNT active -inf now` (the range `RECOVER_STALLED` takes), `ZCARD active`, `ZCOUNT delayed -inf now` + `ZCOUNT failed -inf now`, `ZCARD wait`, and `ZRANGEBYSCORE <set> (now +inf WITHSCORES LIMIT 0 1` on `delayed` and on `failed` | sorted-set scores; every key of a queue is in one slot; nothing reads `completed` | **0.049 → 0.046 ms**, one round trip, atomic | 0.045 → 0.046 ms (flat too: neither reads history); no index to drop — walking `completed`, to show the harness would see history, 12.2 → 132.1 ms |
| **Mongo**, one `countDocuments(filter, { limit: cap + 1 })` per figure, in D2's order, plus one `find().sort({ runAt: 1 }).limit(1)` per scheduled state | `active`: `{ state: "active" }`, then `stalled`: `{ state: "active", lockExpiresAt: { $lte: now } }` (the filter `recoverStalled` selects by) — `active` first, so a recovery between the two leaves `stalled ≤ active`; `dueNow`: per state `{ state, runAt: { $lte: now } }`; `waiting`: `{ state: "waiting" }`; `nextDueAt`: `{ state, runAt: { $gt: now } }` per state | covered `IXSCAN`, 0 documents examined: `LOCK_INDEX` for `stalled`, `PROMOTION_INDEX` (the planner's pick) for the rest. **Not** the retired `ns_1_queue_1_state_1_runAt_1` (§4.0 R9) | **6.66 → 6.79 ms**, seven round trips, not atomic, hence D2's order | 50.1 → 397.6 ms; hinted onto the `(ns, queue)` index without `state`, 661 → 5,388 ms |

**Not index-served as first specified: memory `active` and `stalled`.** The
draft read them "over the queue's jobs", which is a walk of every retained
job: 0.49 ms → 8.99 ms at 10× history. PR-1 keeps an **active-id `Set`**
beside `scheduled`, maintained in `#enterIndexes`/`#leaveIndexes` — which
every state change (`#setState`), `addJob` and `#delete` already call, so it
is left however a job leaves `active`: settled, buried, recovered or removed.
With it the call is **0.089 → 0.131 ms**. Its write-side price, claim plus
complete, 20,000 jobs × 10 runs, interleaved: **779k/s without, 770k/s with
(−1.2%, within noise)**. A set that missed one exit would over-count `active`
for good, so the suite checks its figures against a walk after every kind of
exit. **Every other engine is index-served as the draft planned; no new SQL,
MongoDB, Redis or file index was needed.**

**`nextDueAt` is a per-state `MIN` on Postgres, MySQL and MariaDB, never
`state IN ('delayed','failed')`.** The `IN` form reads every *future*
scheduled row (1,500 here, and it grows with the scheduled backlog): Postgres
0.70 ms against 0.12 + 0.12; MySQL 2.0–2.2 ms and MariaDB 1.6–1.9 ms against
~0.2 per state. The per-state form is one probe ("optimized away" on
MySQL/MariaDB). SQLite answers either form with one probe per state (`IN`
0.104–0.109 ms against 0.06–0.12 each), so it shares the per-state form.

**The file driver's work is bounded by the backlog, not by `cap`.** `readdir`
returns a whole directory, so a 1M-job `waiting` backlog is 1M names per
call; `cap` limits only the figure reported. It does not grow with history
(the table), and the driver is single-host.

**The fallback**, for a third-party driver without `countDemand`
[I, google-azure §6.4]:

```
demand = waiting + (nextDelayedAt ≤ now ? 1 : 0) + (active > 0 && workers == 0 ? active : 0)
```

It is correct as a boolean trigger. It under-counts `dueNow`, and its `countJobs`
may scan history. `QueueDemand.exact = false` says so, and the controller's
poll logs one `warn` naming the driver.

**Contract-suite cases** (`__tests__/helpers/driverContract.ts`, run by all
six driver test files, so on memory, file, SQLite, Postgres, MySQL, MariaDB,
Redis and MongoDB): exact figures on a seeded queue (and `waiting`/`active`
equal to `countJobs`'); `capped` at `cap` (false) and at `cap + 1` (true),
per figure, `dueNow` across both states; a paused queue's figures unchanged;
`completed`, `dead` and `waiting-children` never counted; a due `failed` in
`dueNow`; `countDemand` writes nothing (every job of every state, the counts,
pause, `nextDelayedAt` and `listQueues` identical after, an unknown queue not
brought into being, and no event before a sentinel published after); and
D2's order for promotion and recovery on the separate-read drivers (file,
Mongo), with the negative control that the reversed order loses the job.

**`stalled` agrees with `recoverStalled`, on every driver** (corrected
2026-09-26; it was a fixed answer, then agreement with `countJobs`). The seed
holds two lapsed `active` jobs, one whose lock expires **exactly at `now`**
(every sweep takes `<= now`, so a `<` in a mirror shows only there), a live
one, and a **lockless** one. Since
`countDemand` writes nothing, it runs first; then `recoverStalled` runs with a
`limit` above the count, and `stalled` must equal what it recovered
(`requeued` + `dead`) — 4 on Redis and file, 3 elsewhere, from the one
assertion. `active` is compared with `countJobs(q).active` taken before the
sweep. **Planting the lockless row** is a raw write under the API on SQL
(`UPDATE … SET lock_expires_at = NULL`), Mongo (`updateOne`) and Redis (the
hash field emptied and the job rescored at `createdAt`, as the add script
places one), and a driver-level `addJob` of an `active` record with
`lockExpiresAt: null` on memory and file; the factory's `unlockActive` seam
chooses. Breaking the mirror on any engine fails this case, checked by
mutation on all eight backends (memory, file, SQLite, Postgres, MySQL,
MariaDB, Redis, Mongo) two ways: counting the lockless job where the sweep
skips it (or skipping it where the sweep takes it), and turning the `<=` into
`<`.

#### Review corrections (2026-09-26)

The bun-jobs session, which implements PR-1, reviewed this section before any
code and corrected three points. Rows 1 and 2 were superseded the same day by
the implementation corrections below and are kept as history; row 3 stands. Each was checked against the code; the
first was also confirmed independently by the features session.

| # | Where | What the draft said | Correction | Evidence |
|---|---|---|---|---|
| 1 | D1, the lapsed-lock row | "A row with no lock never matches `<=`" | **Superseded 2026-09-26 by implementation correction 1: no longer a rule.** As first corrected: true in SQL, **false in JavaScript**: `null <= now` is `true`. The memory and file drivers need an explicit `lockExpiresAt === null` guard, modelled on `recoverStalled` | `lockExpiresAt: number \| null` (`JobRecord.lockExpiresAt`, `drivers/driver.ts:1187`); `null <= Date.now()` → `true`, `undefined <= Date.now()` → `false`; `memory-driver.ts:2434-2438`. Without the guard, `stalled` reports rows no sweep returns, and the controller summons for them forever |
| 2 | D4, the contract case | a lockless row "(SQL only, planted) in neither `stalled` nor `active`, matching `countJobs`" | **Superseded 2026-09-26 by implementation correction 2: the case now asserts agreement with `recoverStalled`.** As first corrected: on **all** drivers, never in `stalled`; in `active` exactly when `countJobs(q).active` counts it there. A fixed answer is unsatisfiable on four engines. Memory and file plant the row with a driver-level write | `countJobs().active` excludes a lockless row only on Postgres and SQLite (`#listNotNull`, `sql-driver.ts:4504-4508`; `LOCK_NOT_NULL`, `schema.ts:596`; `hasPartialIndexes`, `schema.ts:615`); MySQL, MariaDB, memory and file count it |
| 3 | D2, the read order | "counted twice at worst, never missed" | Holds for recovery and promotion, not for a claim (`waiting` → `active`). `demand` is never under-counted; `outstanding` can under-count by the jobs claimed during one call on Mongo and file; SQL and Redis read one snapshot and are unaffected. D2's negative control (reversing the order must lose a promoted job) stands | the order is source-before-destination for recovery and promotion; a claim's source (`waiting`) is read last |

#### Implementation corrections (2026-09-26)

Found while building PR-1 against the measurements, and made in the code and
in the text above.

| # | Where | What the spec said | Correction | Evidence |
|---|---|---|---|---|
| 1 | D1, `stalled` | a lockless `active` row is "never in `stalled`, on every driver", by an explicit null guard on the JavaScript drivers | **Wrong on two engines.** `stalled` is exactly the set this engine's `recoverStalled` would recover. The **file** driver names a lockless `active` marker `lockExpiresAt ?? 0` and its sweep has no null check; **Redis** scores a lockless `active` job at `createdAt`, which `RECOVER_STALLED`'s `ZRANGEBYSCORE active -inf now` includes. So both count it; memory, SQL and Mongo, whose sweeps skip it, do not. #185 changes the figure on memory and SQL with no change to this definition | `file-driver.ts` `#markerFor` and `recoverStalled`; `redis/scripts.ts` `stamp()` in the add script and `recoverStalled`; the agreement case |
| 2 | D4, the lockless contract case | "never in `stalled`; in `active` exactly when `countJobs(q).active` counts it" | Agreement, not a fixed answer: `countDemand().stalled` equals what `recoverStalled` then recovers, with a lockless row in the seed on every driver | the case, and its mutations |
| 3 | D4, memory | `active`/`stalled` "over the queue's jobs" | An active-id `Set`, maintained wherever a job enters or leaves `active`, removal included | 0.49 → 8.99 ms walking; 0.089 → 0.131 ms with the set; claim+complete 779k/s → 770k/s |
| 4 | D4, `nextDueAt` | "per-state `MIN`, as `nextDelayedAt` does" (which uses `IN` on SQLite) | Per-state on Postgres, MySQL and MariaDB is required, never `IN`; SQLite probes per state either way and shares the form | Postgres 0.70 ms against 0.12 + 0.12; MySQL/MariaDB ~2 ms against ~0.2 |
| 5 | D4, file | "O(entries in those directories)" | The same, said plainly: bounded by the backlog, not by `cap`; `cap` limits the figure only | `readdir` returns whole directories |

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
| 1b | **Lambda `Invoke` (Event)**, same subpath | launch, `"in-invocation"` worker | **none**; async may deliver twice [V, aws §4.4] | 60 s | About 20 lines once the signer exists [I, aws §1]. Short jobs only (900 s [V]). The `"in-invocation"` mode is exactly what Temporal shipped [V-plan] |
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

**Railway: candidate — via Railway Sandboxes; the service path is still
conditional on Q25.** Researched 2026-09-26 (user-prompted) in
[`railway-vms-2026-09.md`](evidence/summon-compute/railway-vms-2026-09.md); the
service path is unchanged from `paas-ssh.md` §4.1.

- **Sandboxes give a launch-style, scale-to-zero summon.** They have a
  documented GraphQL API: `sandboxCreate` (booting "from a copy of the
  checkpointed disk"), a detached exec that "runs on the sandbox independently
  of the client that started it", and `sandboxDestroy` [V, railway-vms §3.2];
  the detached form runs over a WebSocket, `/ws/exec` [V-src, railway-vms
  §3.2]. The idle timeout goes down to 1 minute on Hobby/Pro (1–5 on
  Trial/Free), and idle teardown is deferred while an exec runs [V,
  railway-vms §3.2]. So: create from a checkpoint with Bun installed →
  detached exec of the worker → it drains and exits → idle teardown destroys
  the sandbox, with `sandboxDestroy` as the backstop [I from V, railway-vms
  §3.2].
- **Classification [D]: a documented recipe now** (behind `defineSummoner({
  invoke })`), **and a first-party summoner candidate once three things are
  measured**: start latency from a checkpoint to the first heartbeat [U], the
  signal and grace on `sandboxDestroy` and on idle teardown [U], and the
  maximum lifetime of a sandbox held open by a running exec [U] (all Q40;
  railway-vms §4.2, §7.1).
- **No dedupe.** `SandboxCreateInput` has no name or idempotency field
  [V-src, railway-vms §3.2], so **the in-flight marker (§4.3) carries dedupe
  alone**; the `sandboxes` listing can reconcile, not lock [I, railway-vms
  §7.1].
- **`fetch` + GraphQL, not the `railway` npm SDK**, which declares
  `engines.node >=22` [V-src, railway-vms §7.1] (§8.3's rule).
  **`/ws/exec` is the one real porting job**: its wire format is in the SDK's
  `src/core/exec-ws-client.ts`, authorised by a shell-scoped JWT [V-src,
  railway-vms §3.2, §7.1; I that it is the only non-trivial piece].
- **Region**: a fresh sandbox runs in `us-west2` "regardless of your
  account's preferred region", and a checkpoint pins its region [V,
  railway-vms §3.2], so the recipe passes `region` when it builds the
  checkpoint. **Cost**: VM rates, about 3.3× Railway containers [I
  arithmetic, railway-vms §4.1], so bursty summoning only (§10.1).
- **The service path** (restart a `Completed` deployment) still waits on Q25
  [U, paas-ssh §4.1].

**Railway cloud agents: a recipe at most, labelled beta.** They are Priority
Boarding beta ("Breaking changes may occur"), limited to 25 creations per user
per day, and framed as a development environment ("Deploy a Railway service
for production traffic") [V, railway-vms §1, §3.1]. They are wake-style in
mechanism (`cloudAgentWake`/`cloudAgentSleep`) [V], but **the summon is two
steps**: waking "re-runs its entrypoint" [V-src, railway-vms §3.1], which is
Railway's, not ours, so the recipe wakes the agent and then starts the worker
over SSH (§7.7) [I, railway-vms §3.1]. Which token `cloudAgentWake` accepts is
[U] (Q41).

**Railway's free, unclaimed VM (`ssh railway.new`): never automated.** A
human-run "try it" docs path only [D, following railway-vms §6.2, §7.4]. Its
limits (3 per IP per day, regional caps, 60 minutes to build, deletion at 24
hours, a preview URL only the creating IP can open) [V, railway-vms §6.1] make
it unfit, and Railway's Acceptable Use Policy forbids "reselling compute
resources, evading usage or billing limits" and says "If you are unsure
whether your use case is allowed, ask us before deploying" [V, railway-vms
§6.1, §7.4]. No bun-jobs code or example may create a box by itself.

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
  [V, aws §4.1]. The adapter passes `--bun-jobs-summon-grace-ms` (§5.5) from
  its `stopTimeout` option.
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
  /** The task definition (`family:revision` or ARN) whose container runs `runSummoned`. */
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
[U] (Q27). So attempts release by start time (§4.3). The handle
(`FLY_MACHINE_ID`, name [U]) is not read by `summonedFromArgs()`, which reads
no environment (§5.5); the recipe passes it itself (`{ ...summon, handle }`)
when it has an id to go with it.

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
`scaleDown.after` (§4.7). The worker runs `runSummoned(worker, { mode: "until-stopped" })`.

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

- The attempt travels in `request.argv` (`--bun-jobs-summon-id=…`) through
  `startCommand`, and `summonedFromArgs()` reads it [V/I, paas-ssh §4.2]. Since
  2026-09-26 that is every provider's channel (§5.5).
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
  --collect -p RuntimeMaxSec=<maxLifetime> /abs/bun worker.ts
  --bun-jobs-summon-id=…`. Identity as arguments, not `-E` environment
  (§5.5).
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
- **On Railway VMs, assume `systemd-run --user` is unavailable** [I,
  railway-vms §5.3]: no systemd is documented for either VM [U], and they run
  Railway's own `vm-init`, with sessions as root [V-src, railway-vms §5.3]. So
  the unit-name dedupe does not carry over. On a **cloud agent**, start the
  worker with `setsid nohup … &` and a pidfile or `flock` as the dedupe [I,
  railway-vms §5.3]. On a **sandbox**, do not use SSH at all: use the
  detached exec, because "a background process outside an active session
  doesn't keep the sandbox alive on its own" [V, railway-vms §3.2, §5.3].

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
**every directory with an `index.ts`** (`directoryEntries`,
`__tests__/packaging.test.ts:47-57`, asserted at `:92-96`) [S, re-read at `0a8e580`]. Files need only their short key. The existing `./lib/*.ts`,
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
  "values": ["SummonController", "defineSummoner", "runSummoned", "summonedFromArgs", "SUMMON_ARGS"],
  "types": ["SummonPolicy", "Summoner", "SummonRequest", "SummonResult", "QueueDemand", "RunSummonedOptions", "SummonedExit"] },
{ "spelling": "@kingsleyweb/bun-jobs/providers/aws",    "values": ["ecsRunTask", "lambdaInvoke"] },
{ "spelling": "@kingsleyweb/bun-jobs/providers/google", "values": ["cloudRunJob", "cloudRunWorkerPool"] },
{ "spelling": "@kingsleyweb/bun-jobs/providers/azure",  "values": ["acaJob"] },
{ "spelling": "@kingsleyweb/bun-jobs/providers/fly",    "values": ["flyMachines"] },
{ "spelling": "@kingsleyweb/bun-jobs/providers/render", "values": ["renderJob"] },
{ "spelling": "@kingsleyweb/bun-jobs/providers/ssh",    "values": ["sshSystemdRun"] }
```

`signAwsRequest`, `getGoogleToken` and `getAzureToken` moved to the
`./provider/auth` entry (§8.1, §8.2).

The root spelling's `values` gain `SummonController` and `runSummoned`. Each
new cell set joins bun-jobs' existing 96/96 [per `CLAUDE.md`].

---

## 9. Observability and UI

### 9.1 Events

**One new queue event type, `summon`** [D], with a payload of
`{ id, outcome: SummonOutcomeKind, kind, count?, handles?, reason?, detail? }`.
It is published through the driver like the others (`BunQueue.#publish`,
`queue/BunQueue.ts:2884`) [S] and emitted locally on the controller. The name
is `summon` (§13.9 S13). **It is published whatever `publishEvents`
says** [D]: at most one per attempt state change, bounded by the budget (30 an
hour by default), and it is the only audit trail a lost attempt leaves.

- Why a queue event and not a worker event: an attempt has no worker yet.
  `worker-runtimes.md` §8.4's rule (no remote-specific worker event types)
  still holds.
- It adds one member to `QUEUE_EVENT_TYPES` (`api/contract/constants.ts:230-252`)
  [S], and its payload to both payload maps, `QueueEventPayloads`
  (`shared/events.ts:42`) and the browser-safe `QueueEventPayloadsWire`
  (`api/contract/ws.ts:52`), plus a wire schema, which the type of the
  schema map in `api/ws/events.ts:156` demands for every queue event name;
  and to `BunQueue`'s re-emit of remote events, which builds each type's
  local arguments by hand (the `switch` at `queue/BunQueue.ts:2964`). That changes the AsyncAPI
  document and the UI's event filters, which is the UI session's side of
  1.5f.

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
- the platform handle, shown only with `serialize.exposeSummonHandles`
  (default `false`; added 2026-09-26, §5.5), because a task ARN is
  infrastructure and carries the AWS account id;
- the deadline.

A summoned worker is otherwise an ordinary worker. The Phase 0
`WorkerController` pauses, stops and reconfigures it like any other, and
analytics, limits and events are unchanged.

### 9.3 What the UI needs from the API

| Need | API | Owner |
|---|---|---|
| demand on the queue screen | `GET /queues/:queue/demand` (§6.2) | the features session (PR-5; the bun-jobs session reviews) |
| summon status: pending attempts, failures, backoff, circuit, budget, last outcome, summoner facts | `GET /queues/:queue/summon` → `SummonStatusDto` | the features session (PR-6; the bun-jobs session reviews) |
| the provider behind the summoner: name, version, `apiVersion`, declared capabilities, an experimental badge, "Test connection" | `SummonStatusDto.summoner.provider` and `.capabilities`; `GET /providers`; `POST /providers/:id/validate` (action `providers.validate`) ([`compute-provider-plugins.md`](compute-provider-plugins.md) §14) | the bun-jobs session (routes, DTO); the UI session (card, badge, button) |
| a "Summon now" button, and "Reset" when the circuit is open | `POST …/summon`, `POST …/summon/reset`, gated on `queues.summon` | the features session (routes, PR-6); the UI session (buttons) |
| the badge and handle on the Workers page and worker screen | `WorkerDto.summon` | the features session (DTO, PR-2); the UI session (render) |
| the `summon` events in the event feed and filters | `QUEUE_EVENT_TYPES` + AsyncAPI | the features session (contract, PR-6); the UI session (filters) |
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
| Railway VM (sandbox, cloud agent) | 0.5 vCPU + 0.5 GB in use | ≈ $0.0058 [I arithmetic] | per second [V] | railway-vms §4.1 |
| Cloudflare Containers `basic` | ¼ vCPU / 1 GiB | ≤ $0.0023 | per 10 ms | paas-ssh §8 |
| SSH to your own host | — | $0 | — | paas-ssh §8 |

**Railway VMs cost $50/GB-month of RAM and $50/vCPU-month, metered per
second** [V, railway-vms §4.1]: 5× a Railway container's RAM rate and 2.5× its
CPU rate, **about 3.3× Railway containers** for a typical 0.5 vCPU + 0.5 GB
mix [I arithmetic, railway-vms §4.1]. So a sandbox reads as **bursty-only**: a
worker that stays up belongs on a Railway service.

**Every summoned drain costs about a cent or less on every platform**
[I, all three files]. Two things decide the bill instead:

- **How fast the worker exits once drained.** `idleFor` is the dominant
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
  `request.argv` (§5.5). That fixture runs `runSummoned` against a **shared** driver.
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
- **`runSummoned` tests**, in a child process so that signals are real:
  - exits 0 on idle;
  - on SIGTERM, closes within `grace` and exits 0;
  - on **SIGINT**, the same (Fly);
  - stops claiming at `deadline − shutdownBuffer`;
  - `"in-invocation"` resolves and leaves no timer or lease behind;
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

`bench/queue.ts --compare` runs with a controller attached to the bun-jobs
contender in all six scenarios (§4.8, corrected: the two producer-only
scenarios measure the no-worker path, the other four the fast path), and the
existing baselines must not move. No new scenario and no re-recorded
baseline. The controller is off the claim, settle and limit paths entirely
(`#loop`, `BunQueueWorker.ts:1798`; `#process`, `:2188`), and its only
hot-path presence is one `added` listener on the add path (PR-3, §13).

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

10. ~~**Q10** `EXPLAIN` the §6.2 SQL demand query, and this plan's
    `countDemand` SQL, on a large table.~~ **Closed 2026-09-26:** measured
    on every driver and all four SQL dialects; every figure is index-served,
    memory's after PR-1's active-id `Set` (§6.4 D4).
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
25. **Q25** Railway services: whether `deploymentRestart` restarts a
    `Completed` deployment, the status name it reports, and whether
    `numReplicas: 0` works. Only the service path depends on it; Sandboxes
    do not ([`railway-vms-2026-09.md`](evidence/summon-compute/railway-vms-2026-09.md) §3.2).
26. **Q26** Time from API call to process start on Heroku, Render and Railway.
27. **Q27** Fly: the response to `start` on an already-started Machine,
    per-start env overrides, and the `FLY_MACHINE_ID` variable name.
28. **Q28** SSH: `nohup`/`setsid` session survival with unredirected streams,
    and `ControlMaster` on Windows OpenSSH.
29. **Q29** Kubernetes: the 409 status on a duplicate Job name, and Bun
    `fetch` with a custom CA against an API server.
30. **Q30** Cloudflare Containers' maximum lifetime.

**From `railway-vms-2026-09.md`** (§7.2, added 2026-09-26):

40. **Q40** Railway Sandboxes, before a first-party summoner: start latency
    from a checkpoint to `RUNNING` to the first heartbeat (joins Q26); the
    signal and grace on `sandboxDestroy` and on idle teardown; the maximum
    lifetime of a sandbox held open by a running exec, per plan; whether
    `sandboxCreate` accepts a project token (the SDK implies yes [V-src]);
    and how the `/ws/exec` JWT is minted (`shell.graphql` in the SDK) [U].
41. **Q41** Railway cloud agents, **low priority**: which token type
    `cloudAgentWake` accepts; whether a wake starts anything we control; and
    whether systemd is available [U].

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
33. **Q33** ~~**`countDemand` on Mongo needs a `lockExpiresAt` index**~~
    **Closed 2026-09-25:** it exists, as `LOCK_INDEX` `{ ns, queue, state,
    lockExpiresAt, _id }` (`drivers/mongo/mongo-driver.ts:1136-1142`, created
    on connect at `:5994-5997`). The draft's `runAt` index is the retired one
    (§4.0 R9).
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
    here because it was found while reading for it. **Closed:** Phase 0
    renamed the addressee type to `WorkerSelector`
    (`queue/WorkerController.ts:41`), and Phase 1 shipped `WorkerTarget` as
    "where attempts run" (§4.0 R20).
36. **Q36** **The plugin API's own questions** are in
    [`compute-provider-plugins.md`](compute-provider-plugins.md) §17.2
    (Q-P1–Q-P10). The two that touch summoning directly: whether
    `./provider/auth` is public before Q2 and Q15 close (Q-P2), and whether
    capacity and quota need separate error kinds (Q-P6).
37. **Q37** **Producers publish nothing by default** (`publishEvents:
    false`, `BunJobs.ts:92-99`), and bulk adds never publish (§2.1). So the
    events trigger is silent in a default deployment. Options: leave it and
    document it (recommended: the poll is the correctness mechanism); or have
    `BunJobs` publish the demand-creating events whenever a controller exists
    anywhere, which it cannot know. Raised by the reconciliation.
38. **Q38** **Narrowed 2026-09-26, per #166 (pending its merge).** The
    target's share of the close is now measured and derived (≤ 4,500 ms
    graceful, from `DEFAULT_CLOSE_TIMEOUT`; §5.3, the close rule), so it no
    longer rides on `tailReserve`. #166's `force` figure is now measured:
    **~12 ms, at most 500 ms** (the reap cap). What stays open: measure the
    post-target remainder (`#unregister` … `driver.close()`) that
    `tailReserve`'s 1,000 ms default [I] still guesses; PR-4 measures it.
39. **Q39** **Does a summoned worker want a shorter `stalledInterval`** to take
    the sweep lease over from a crashed predecessor at once (§4.0 R12)? The
    lever exists; making it a `runSummoned` default would change the
    queue's sweep cadence for every worker on it. Recommended: document, do
    not default.
42. **Q42** **Should a summoned worker's descendants treat a
    `SummonController` as inert, and how would they know?** Raised by
    the bun-jobs session's review of #178, 2026-09-26, for PR-3. Under the argument channel (§5.5) a
    descendant has no provenance: `summonedFromArgs()` answers `undefined`,
    which means "not summoned", so §3.2's `fromSummoned` rule does not reach
    it, and a descendant building a `BunJobs` with `summon` configured would
    summon. Not solved in PR-2.
43. **Q43** **Lambda's identity channel.** An invocation has no command line,
    so a Lambda worker's provenance must come from the invoke payload. Which
    field, and which helper reads it, is for PR-3/1.5c (§5.5).

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
- the missing signal handling means `runSummoned`;
- the `countJobs` cost means a bounded read;
- the providers each need an adapter and credentials;
- **the provider plugin system** (added 2026-09-25 at the user's request):
  a public, versioned API, a conformance kit and its documentation, built
  before the first-party providers so that they are written on it
  ([`compute-provider-plugins.md`](compute-provider-plugins.md) §16).

### 13.1 1.5a and 1.5b as seven PRs (**sliced 2026-09-25**)

1.5a and 1.5b are still **the minimum useful ship**: after them every
platform is reachable, through `defineSummoner({ invoke })` or the depth
endpoint. They were two work tables; they are now seven PRs, each of which
ships on its own, passes the full gate on its own, and leaves the package
coherent if the next never lands. If 1.5p has not landed, `defineSummoner`
builds its summoner on an internal stand-in for the provider types, and 1.5p
replaces the stand-in with the public ones (unchanged from the draft).

| PR | Sub-phase | What it ships to users | Depends on | Implements | Effort | Hot path? |
|---|---|---|---|---|---|---|
| **PR-1** `countDemand` | 1.5a | `queue.getDemand()` [S10]: an exact, bounded demand reading on all five drivers, and the optional driver method for third-party drivers | **#166 merged** (sequencing, not code) | **the bun-jobs session**; the features session reviews | ~4.5 d | no |
| **PR-2** provenance | 1.5a | a worker can record where it was summoned from; `WorkerDto.summon`; `summonedFromArgs()`; `exposeSummonHandles` | nothing | **the features session**; the bun-jobs session reviews | ~1.5 d | no |
| **PR-3** controller | 1.5a | `SummonController`, `defineSummoner({ invoke })`, `BunJobs.summon`: summoning end to end on any platform | PR-1, PR-2 | **the features session**; the bun-jobs session reviews | ~6 d | **yes** |
| **PR-4** `runSummoned` | 1.5a | the worker half: one file runs a summoned worker, handles signals, exits 0 | **#166 merged, including its `close({ force })` pass-through**, PR-1, PR-2 | **the features session**; the bun-jobs session reviews (it owns the close path #166 changes) | ~2.5 d | no |
| **PR-5** depth endpoint | 1.5b | `GET /queues/:queue/demand`, `GET /demand`, Prometheus: KEDA, ACA event jobs, CREMA and GKE can scale on bun-jobs | PR-1 | **the features session**; the bun-jobs session reviews | ~2 d | no |
| **PR-6** summon routes | 1.5b | summon status, "summon now", reset; `queues.summon`; the `summon` event across processes | PR-3, PR-5 | **the features session**; the bun-jobs session reviews | ~1.75 d | no |
| **PR-7** recipes | 1.5b | README: placement, worker recipe, shutdown budgets, KEDA/ACA/CREMA/GKE recipes with the measured SQL plans | PR-5, PR-1's measurement | **the features session**; the bun-jobs session reviews | ~1.5 d | no |
| | | | | | **~19.75 d** | |

**Effort: ~19.75 d, was ~17.5 d.** The +2.25 d is work the draft did not
see: PR-1's measure-first task (+0.75 d), the `WorkerDto`/schema/drift
plumbing for `summon` that Phase 1 showed `target` needed (+0.5 d), a bench
harness switch the guard needs because the scenarios it named run no worker
(+0.5 d, §4.0 R18), and `runSummoned`'s hard backstop and #166 tests
(+0.5 d, §5.3). Nothing was removed.

**Ownership (decided 2026-09-25).** **PR-1 (`countDemand`): the bun-jobs
session implements, the features session reviews. PR-2 to PR-7: the features
session implements, the bun-jobs session reviews.** The bun-jobs session keeps
the close path #166 changes; PR-2 and PR-4 are scoped away from it (§13.3,
§13.5), so the split puts no two sessions on the same lines.

**Order and parallelism.**

```
now ──► PR-2 ─────────────────────────┐
#166 ─► PR-1 ──┬──► PR-3 ──────────────┼──► PR-6
               │    (needs PR-2)       │
               ├──► PR-4 (needs PR-2, #166)
               └──► PR-5 ──┬───────────┘
                           └──► PR-7
```

- **PR-2 can start now.** It needs nothing, and it stays out of the lines
  #166 is changing (§13.3).
- **PR-1 starts once #166 lands** (the bun-jobs session's sequencing), and
  its first task is the measurement (§6.4 D4).
- **After PR-1: PR-3, PR-4 and PR-5 run in parallel.** PR-3 can be written
  against the §6.4 fallback while PR-1 is in review, and switched when it
  merges.
- **PR-6 waits for PR-3 and PR-5** (it needs the controller, and it edits the
  same route and contract files as PR-5). **PR-7 waits for PR-5.**
- **The critical path** is #166 → PR-1 → PR-3 → PR-6: about 12.25 d of the
  19.75 d, the rest overlapping it.

**Files more than one PR touches** (conflict risk; the later one rebases):

| File | PRs | Risk |
|---|---|---|
| `drivers/driver.ts` | PR-1 (`QueueDriver`, beside `countJobs` `:2242`), PR-2 (`WorkerInfo`, `:1427-1591`) | low: separate regions |
| `queue/BunQueueWorker.ts` | PR-2 (constructor validation near `resolveWorkerTarget` `:917-920`; `#report` `:4177-4210`); **#166** (the close path, `:1568-1735`, and possibly `#closeTarget`) | low: PR-2 is scoped away from the close path. **PR-4 edits nothing in this file** |
| `queue/BunQueue.ts` | PR-1 (`getDemand()`), PR-6 (the remote re-emit `switch`, `:2964`) | low |
| `lib/index.ts`, `package.json` `exports`, `consumer-check.json` | PR-1, PR-2, PR-3 (adds `lib/summon/index.ts`, hence the `./summon` and `./lib/summon` keys the packaging test demands), PR-4 | low: list merges |
| `lib/summon/index.ts` | PR-3, PR-4 | low: export lists |
| `api/contract/types.ts` | PR-2, PR-5, PR-6 | medium: all three add DTOs; land PR-5 before PR-6 |
| `api/routes/queues.ts`, OpenAPI pinned lists in `__tests__/api/` | PR-5, PR-6 | medium: hence PR-6 after PR-5 |
| `packages/bun-jobs/README.md` | every PR (its own section), PR-7 most | low |

**The hot path, and the benchmark guard.** Only **PR-3** touches it: an
`added` listener on the add path (`BunQueue.#addSimple` `:645-656`, `addBulk`
`:715-726`) and `BunJobs` wiring. PR-3's gate therefore includes `cd
packages/bun-jobs/bench && bun queue.ts --compare` with a controller attached
to all six scenarios (§4.8, §11.2), on every backend in
`baselines/queue.json`, and `bun runner.ts --compare` unchanged. The claim
loop and `#process` (`BunQueueWorker.ts:1798`, `:2188`) are touched by
**no** PR. PR-1 adds one Redis script and no claim script; it needs no
`--compare`, and runs one on Redis only if it touches `scripts.ts`'s shared
prelude.

**The gate every PR passes** (`CLAUDE.md`): `bun scripts/typecheck.ts`;
`CI=1 bunx eslint .` in `packages/bun-jobs` (README linted alone first if a
table is touched); `bun test` and `bun test --randomize` with two seeds,
**with the five server URLs exported** so the driver suites run rather than
skip (and the report quotes what ran, not what was green); `bun
scripts/consumer-check.ts packages/bun-jobs` for any PR that changes an
export; the affected examples on memory plus one server, and the full sweep
once per merge window, not per PR. PRs 2, 5 and 6 change the management API's
contract, so they also run `bun test` in `packages/bun-jobs-ui` and `bun
run-all.ts` in `examples/bun-jobs-ui`.

### 13.2 PR-1 — `countDemand` on the five drivers

- **Owners.** Implemented by **the bun-jobs session** (its user's decision),
  reviewed by the features session. **Sequenced after the bun-jobs session's
  #166 fix lands.**
- **Spec.** §6.4, settled before code: the states (D1), direct counting rather
  than promotion (D2), the cap (D3), and the per-driver index plan (D4),
  measured 2026-09-26 and corrected by the implementation (§6.4's
  implementation corrections).
- **Task 1, before implementation is reviewed: the measurement** (§6.4 D4):
  plans and medians per driver and per SQL dialect on #159's fixture and its
  10× history variant, with `countJobs` as the control and a dropped index as
  the negative control, against the bench databases (`bun_jobs_bench`, Redis
  db 14), never the suites'. **Done 2026-09-26, as a one-off, not a committed
  script.** The method and every result are in §6.4 D4; the raw plans,
  per-sample data and scripts are with the bun-jobs session's findings
  (`count-demand-plans.md`). The draft named `bench/demand.ts`, but the
  scripts measured hand-built statements and a patched copy of the memory
  driver (the active-id `Set` spike) rather than the shipped `countDemand`,
  so committing them would have put a benchmark of code that does not exist
  into the bench package. A `bench/demand.ts` that times the shipped method
  under the bench package's conventions is a follow-up, not part of PR-1.
- **Scope.** `drivers/driver.ts` (the optional member and `DemandCounts`);
  `drivers/memory-driver.ts`; `drivers/file-driver.ts`;
  `drivers/sql/sql-driver.ts` (and `sql/dialect.ts` if a dialect needs its own
  form); `drivers/redis/redis-driver.ts` and `redis/scripts.ts` (one new
  script); `drivers/mongo/mongo-driver.ts`; `drivers/readApis.ts`
  (`readDemand`, the fallback, `QueueDemand`); `queue/BunQueue.ts`
  (`getDemand()` [S10]); `lib/index.ts`; `__tests__/helpers/driverContract.ts`.
- **Ships.** `queue.getDemand()`, useful alone (a health check, a home-made
  scaler), and the driver method a third-party driver may implement.
- **Tests.** The contract cases listed at the end of §6.4, on all six driver
  test files, plus the fallback on a driver without the method.
- **Risk: medium.** Four SQL dialects; the #159 class of bug (a count that
  disagrees with the count beside it), which §6.4 D1's "`active` equals
  `countJobs().active`" rule and its contract case exist to prevent; Mongo's
  non-atomic reads, which D2's order handles.

### 13.3 PR-2 — Summon provenance on the worker record

- **Scope.** `shared/workers.ts` (`WorkerSummonProvenance` [S15], beside
  `WorkerTargetInfo`); `drivers/driver.ts` (`WorkerInfo.summon`, additive);
  `queue/types.ts` (the option); `queue/BunQueueWorker.ts` — constructor
  validation only (the `reportInterval: 0` `ConfigError`, beside
  `resolveWorkerTarget`, `:917-920`) and `#report` (`:4177-4210`), **not** the
  close path; `lib/summon/args.ts` (`SUMMON_ARGS`, `summonedFromArgs` [S8 as
  superseded, §5.5], exported from the root; no `lib/summon/index.ts` yet, so
  no new `exports` key); the API: `WorkerDto.summon` (`api/contract/types.ts`),
  `WorkerSchema` (`api/schemas/workers.ts`), `toWorkerDto` (`api/serialize.ts`,
  `handle` withheld unless `serialize.exposeSummonHandles`, a new switch in
  `api/config.ts`, default `false`).
- **Ships.** A worker says it was summoned, by what and until when; the
  Workers API shows it; `summonedFromArgs()` for any recipe that can pass
  arguments.
- **Tests.** The record carries `summon` on the first report; `reportInterval:
  0` and a driver without worker records each throw with `summon`;
  `summonedFromArgs()` is keyed on the id, never defaults `mode`, and never
  reads the environment; a `Bun.spawn` child with no `env` — from the main
  thread, an in-process processor and a worker-thread target's thread — is not
  summoned, with the env channel's leak as the negative control; the
  worker-thread target's thread itself is not summoned; the marker refuses
  even with the arguments visible (negative control: without it they are
  claimed); a runner child's own arguments never read as a summon; the drift
  assertions and round trip Phase 1 extended for `target` (§5.4), extended
  again; `handle` hidden by default and served with `exposeSummonHandles`.
- **Reworked 2026-09-26** after the bun-jobs session's review of #178, 2026-09-26 (§5.5).
- **Owners.** Implemented by **the features session**, reviewed by the
  bun-jobs session; the UI session is told (a new `WorkerDto` field;
  rendering is 1.5f).
- **Risk: low.**

### 13.4 PR-3 — The marker, `SummonController`, `defineSummoner`, `BunJobs.summon`

- **Scope.** New `lib/summon/types.ts`, `marker.ts`, `controller.ts`,
  `define.ts`, `index.ts`; `lib/index.ts`; `BunJobs.ts` (the `summon` option,
  `summonController()` [S16], closing controllers first); `package.json`
  (`./summon`, `./lib/summon`) and `consumer-check.json`; the bench harness
  switch (`bench/contenders/queue/bun-jobs.ts`, `bench/lib/queue-scenarios.ts`).
  The `summon` event is emitted **locally** here; putting it on the wire is
  PR-6's, because that changes the contract.
- **Ships.** Summoning end to end, for any platform, through `defineSummoner`
  or a bare function; the worker entry passes `summon: summonedFromArgs()` and
  exits however it likes until PR-4.
- **Claim-once (added 2026-09-26, §5.5).** The first process to atomically
  claim an attempt id wins; any later claimant — a platform double-start, or a
  descendant that sees the arguments — loses and runs unsummoned. Tests: two
  processes with the same id, exactly one summoned record; the loser runs
  unsummoned. PR-3 also answers Q42.
- **Tests.** `__tests__/helpers/summon.ts`'s fake platform spawning
  `__tests__/fixtures/summoned-worker.ts` on SQLite and the file driver (Redis
  and Postgres when their URLs are set), and §11.1's controller cases except
  the `runSummoned` ones; the two-process CAS race; the id stays unique across
  a purge (§4.0 R6, with a negative control hashing the version alone); a
  5,000-job `addBulk` makes one check (the `added` listener, §2.1).
- **Gate addition.** The benchmark guard (§13.1).
- **Owners.** Implemented by **the features session**, reviewed by the
  bun-jobs session; a change report to the examples session.
- **Risk: medium-high.** Concurrency (the claim, release and record CASes, and
  three triggers' timers), and the only hot-path change.

### 13.5 PR-4 — `runSummoned` and signal handling

- **Sequencing: after #166.** #166 gives `FileTargetExecutor` a `close()` and
  may touch `#closeTarget`/`#close`. `runSummoned` is scoped to **avoid
  those lines entirely**: it lives in `lib/summon/worker.ts` and uses only the
  worker's public surface — `run()` (`BunQueueWorker.ts:1301`), `close()`
  (`:1568`), `pause()`/`resume()` (`:1354`, `:1367`), `activeCount`
  (`:1206`), `state` (`:1219`) and its events. It still waits for #166,
  because what it must budget for is #166's close behaviour (§5.3, Q38),
  because its no-orphan test is #166's reproduction, and **because the close
  rule needs #166's `force` option specifically**: `close({ force: true })`
  passed through `#closeTarget` to `WorkerTargetExecutor.close({ force })`
  (per #166, pending its merge). Without it a forced close still waits up to
  4,500 ms on a child-process target, which Fly's 5 s grace cannot afford.
- **Scope.** `lib/summon/worker.ts`; `lib/summon/index.ts`; `lib/index.ts`;
  the fixture worker switched to `runSummoned` for the full handoff.
- **Ships.** The worker half, finished: a platform's worker entry is one file.
- **Tests,** in child processes so the signals are real: exit 0 on idle;
  SIGTERM and SIGINT close within grace; a second SIGINT exits 130;
  SIGTSTP/SIGCONT, and SIGCONT leaving an operator's pause alone; the deadline
  minus `shutdownBuffer`; `"in-invocation"` resolves with no timer or lease left; a
  `run()` that cannot connect exits 1; the backstop fires when a custom
  target's `close()` hangs (negative control: without it the process outlives
  the grace); a `"child-process"` attempt that ignores its signal leaves **no
  orphan** after the exit (detected by the child's real command line,
  `…/runner/bootstrap/spawn-entry.ts`, as #166 warns); a parked worker exits
  `"parked"`; the close rule: on a 5 s grace with a `"child-process"` target
  the close is forced and finishes inside the grace (negative control: a
  graceful close there overruns into the backstop), and on a 30 s grace it is
  graceful with the jobs' `timeout` the rule computes; the end-to-end
  handoff.
- **Owners.** Implemented by **the features session**, reviewed by the
  bun-jobs session, which owns the close path this PR budgets for and must
  not edit.
- **Risk: medium.** Signal delivery under Bun, `process.exit` during a close.

### 13.6 PR-5 — The depth endpoint and Prometheus

- **Scope.** `api/routes/queues.ts` (`GET /queues/:queue/demand`) and the
  namespace route `GET /demand` [S11]; `QueueDemandDto`
  (`api/contract/types.ts`, beside `JobCountsDto` `:783`); its schema; a small
  Prometheus renderer (`api/prometheus.ts`, new) [S12]; `DRIVER_FEATURES` and
  `/meta` `features.demand` (`api/routes/meta.ts:62`); the OpenAPI lists.
- **Ships.** Model (b), §2.2, for every platform that polls a metric.
- **Tests.** Route and auth (`queues.read`; `listQueues: "authorized"`
  filtering `/demand`); JSON and `?format=prometheus`/`Accept: text/plain`;
  the contract drift assertions; the pinned OpenAPI lists; the fallback's
  `exact: false`.
- **Owners.** Implemented by **the features session**, reviewed by the
  bun-jobs session; the UI session is told (the demand card is 1.5f).
- **Risk: low.**

### 13.7 PR-6 — Summon routes, `queues.summon`, the `summon` event on the wire

- **Scope.** `api/routes/queues.ts` (`GET`/`POST /queues/:queue/summon`,
  `POST …/summon/reset`); `api/contract/constants.ts` (`queues.summon` [S17]
  in `JOBS_API_ACTIONS`, `JOBS_API_MUTATIONS` and `JOBS_API_OPT_IN_ACTIONS`;
  `summon` [S13] in `QUEUE_EVENT_TYPES`); `shared/events.ts`,
  `api/contract/ws.ts`, `api/ws/events.ts`, `BunQueue`'s re-emit (§9.1);
  `SummonStatusDto`; AsyncAPI; the controller publishing `summon`.
- **Ships.** Operators see and drive summoning through the API; the UI can
  build its card.
- **Tests.** The routes, `409 SUMMON_NOT_CONFIGURED`, the action's gating
  (`readOnly` removes it; the default leaves it off), the pinned AsyncAPI and
  OpenAPI lists, the event across two processes.
- **Owners.** Implemented by **the features session**, reviewed by the
  bun-jobs session. **The UI session and
  the examples session are told before merge**: a new action and event type
  change the AsyncAPI document and the event filters, and the UI's
  `### What each element needs` rows for them (1.5f) are parsed by
  `examples/bun-jobs-ui/04-screens/permissions.ts`.
- **Risk: low-medium** (contract surface).

### 13.8 PR-7 — Recipes

- **Scope.** `packages/bun-jobs/README.md`: placement (§3.2); the worker
  recipe; the shutdown-budget table (§5.2); the depth endpoint with KEDA
  ScaledJob and ScaledObject, ACA event jobs, CREMA and GKE HPA; the scaler's
  second `createJobsApi`; PR-1's measured plans. Each code PR already carries
  its own README section and change report; this one is the recipes.
- **Owners.** Implemented by **the features session**, reviewed by the
  bun-jobs session; the examples session writes the examples (1.5f).
- **Risk: low.** Lint the README alone first: a long table cell can hang
  Prettier.

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

| Scope | bun-jobs and features sessions | Other owners |
|---|---|---|
| 1.5a + 1.5b (minimum useful), PR-1 to PR-7 | **~19.75 d** (was ~17.5 d; §13.1): PR-1 ~4.5 d the bun-jobs session, PR-2 to PR-7 ~15.25 d the features session | UI ~1 d for the demand card |
| All of 1.5 | **~49.25 d** (was ~47 d: +2.25 d from the 1.5a/1.5b reconciliation; before that ~32.5 d, +12.5 d for 1.5p, +1 d for fakes and kit runs in 1.5d–e, +1 d for 1.5s) | UI ~3.5 d, examples ~3 d |

The order is 1.5a → (1.5b ∥ 1.5p) → 1.5c → 1.5d → 1.5e → 1.5g → 1.5s, with
1.5f following each bun-jobs sub-phase it depends on and 1.5g before the
release that ships an adapter. 1.5b is independent of 1.5p and 1.5c. Within
1.5a and 1.5b the PR order is §13.1's: PR-2 now; PR-1 after #166; then PR-3,
PR-4 and PR-5 in parallel; then PR-6 and PR-7. 1.5p can start once PR-3 has
fixed the controller's shape, since its summon facet replaces PR-3's
internal stand-in.

### 13.9 Names approved (2026-09-25)

Every public name 1.5a and 1.5b introduce. **The user approved them on
2026-09-25, accepting every recommendation** the draft of this section made;
the plan above uses these names throughout, and the markers that stood in
for them are gone. "Was" gives the draft's name where the decision changed
it.

**How the collision check was run** (2026-09-25, at `0a8e580`): `git grep -w
-c <name> -- packages examples playground benchmarks scripts`, summed, for
identifiers; `git grep -F -c` for paths, keys and env prefixes; "unused"
below means that count was **0**. Negative controls, run the same way:
`WorkerController` 46, `queues.drain` 18. Case-insensitive `summon` over the
same tree: 0.

| # | What | Approved name | Was | Reason | Collision check |
|---|---|---|---|---|---|
| S1 | the controller class | `SummonController` | (kept) | Since Phase 0 a `…Controller` in bun-jobs acts on a queue's workers from elsewhere (`WorkerController` pauses and stops them, `queue/WorkerController.ts:203`); this one starts them, so the suffix fits | unused |
| S2 | its options type | `SummonPolicy` | (kept) | It is also the value of `BunJobsOptions.summon`'s map, where "options" would read as the controller's constructor argument | unused; no `*Policy` type in `packages/bun-jobs/lib` (only the `Content-Security-Policy`/`Referrer-Policy` headers, `api/docs/html.ts:65-67`) |
| S3 | the escape hatch, and the summoner type | `defineSummoner({ invoke })`, `Summoner` | (kept) | They follow the package's `define*` factories (`defineHandler`, `defineProcessor`, `defineProcessors`); 1.5p's `defineComputeProvider` is the provider-shaped one | unused |
| S4 | the worker-side runner | `runSummoned(worker, options)` | `drainAndExit` | In bun-jobs "drain" means **delete pending jobs** (`jobs.drain()`, `BunJobs.ts:1016-1021`; `queue.drain()`, `queue/BunQueue.ts:2108-2109`; `drainQueue`, `drivers/driver.ts:2615`; the action `queues.drain`), so `drainAndExit` read as "delete the backlog and quit". `runUntilIdle` misdescribed `"until-stopped"`; `runUntilDone` is a test helper (`__tests__/fix-attempt-write-ordering.test.ts:242`). Its options type follows: `RunSummonedOptions` (was `DrainAndExitOptions`) | `runSummoned` unused |
| S5 | its modes | `"exit-on-idle" \| "until-stopped" \| "in-invocation"` | `"launch" \| "service" \| "in-handler"` | The modes say what the worker does; `"launch"` is already a value of `SummonCapabilities.style`, a different axis (a launch-style Lambda runs the in-invocation mode). `WorkerSummonProvenance.mode` and `BUN_JOBS_SUMMON_MODE` carry the same three values | unused; `"launch"` in use as a style (plugins §7.1) |
| S6 | its options | `idleFor`, `idleCheckInterval`, `deadline`, `shutdownBuffer`, `grace`, `tailReserve`, `signals`, `pauseSignals`, `exit`, `logger` | `idleTimeout` | `idleTimeout` is Bun.serve's HTTP idle timeout **in seconds** throughout bun-common and bun-nest (`BunHttpAdapter.ts`, `BunWebSocket.ts`, 6 hits); this one is milliseconds and means something else. The rest are kept | `idleFor`, `idleCheckInterval`, `shutdownBuffer`, `tailReserve`, `pauseSignals` unused; `grace` only in prose |
| S7 | its result | `SummonedExit` | `DrainExit` | Follows S4 | unused |
| S8 | env helpers and keys — **superseded 2026-09-26** | `summonedFromEnv()`, `SUMMON_ENV`; keys `BUN_JOBS_SUMMON_ID`, `…_KIND`, `…_MODE`, `…_NAMESPACE`, `…_QUEUE`, `…_MAX_LIFETIME_MS`, `…_GRACE_MS` | keys `BUN_JOBS_NAMESPACE`, `BUN_JOBS_QUEUE` | Every key under one prefix: `BUN_JOBS_NAMESPACE` is already `CHILD_ENV.namespace` (`runner/protocol.ts:31`), exported from the root (`lib/index.ts:702`) and set on every runner and file-target child (§4.0 R19). `summonedFromEnv()` reads only `BUN_JOBS_SUMMON_*`, and answers `undefined` inside a runner child, which inherits its parent's env | `BUN_JOBS_SUMMON` prefix unused; `summonedFromEnv`, `SUMMON_ENV` unused. **Superseded 2026-09-26 (§5.5):** identity travels only as arguments, so the helper is `summonedFromArgs()` and the names are `SUMMON_ARGS`, `--bun-jobs-summon-<key>=` (the bun-jobs session's review of #178, 2026-09-26; the user's decision) |
| S9 | the driver method and its answer | `countDemand`, `DemandCounts` | (kept) | `readDemand` is the helper above it; "claimable" is wrong for `stalled`, which needs a sweep first | unused |
| S10 | the public demand read | `queue.getDemand()` (added); `QueueDemand`, `readDemand` internal | no public method | Matches `getLimits()`/`getJob()`, so PR-1 ships something usable on its own | `getDemand` unused |
| S11 | the routes | `GET /queues/:queue/demand`, `GET /demand` | (kept) | "Demand" is the figure's name everywhere else | `/demand` unused |
| S12 | the response fields and the metric names | fields `demand`, `outstanding`, `dueNow`, `stalled`, `capped`, `exact`, `nextDueAt`; metrics `bunjobs_queue_*` | metrics `bun_jobs_queue_*` | Fields kept. Metrics take the prefix `opentelemetry.md` §5 uses (`bunjobs.queue.jobs` → `bunjobs_queue_jobs` under an OTel Prometheus exporter). Not `pending` for `outstanding`: "pending" means waiting + delayed in `drain`'s vocabulary | `bun_jobs_queue` unused; `bunjobs_` 3 hits, all the Postgres `LISTEN` channel (`drivers/sql/arrivals.ts:80`), a different namespace |
| S13 | the queue event | `summon` | (kept) | Existing names are past participles of what happened to a job (`api/contract/constants.ts:230-252`); a summon event carries its verb in `outcome`, so `summoned` would be false for most of them | unused |
| S14 | the reserved state key | `__win:summon` | (kept) | Readable, and no existing reserved name begins `summon` (§4.0 R7) | unused |
| S15 | the worker's provenance | option `BunQueueWorkerOptions.summon`, record `WorkerInfo.summon`, DTO `WorkerDto.summon`; type `WorkerSummonProvenance` | option `summoned` | One name everywhere, so `summon: summonedFromEnv()` writes `summon` on the record, as `target` does in Phase 1. The type is kept. A generic `origin` would pre-empt a Phase 2 decision nobody has made | unused |
| S16 | on `BunJobs` | `BunJobsOptions.summon`; `jobs.summonController(queue, policy?)` | `jobs.summoner()` | `summoner()` returning a `SummonController`, not a `Summoner` (S3), was a pun on the package's own type | unused |
| S17 | the API action | `queues.summon` | (kept) | In all three action sets (§6.2) | unused |
| S18 | who counts as serving | `SummonPolicy.servedBy: "any-worker" \| "summoned-only"` | `satisfiedBy` | `satisfiedBy` is already a field of the worker routes' instruction table with another meaning (worker states that satisfy an instruction, `api/routes/workers.ts:192`) | `servedBy` unused |

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
