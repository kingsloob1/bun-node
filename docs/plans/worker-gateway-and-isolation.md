# Remote workers without the driver, and a sandbox for the job

Research and implementation plan for two additions to
`@kingsleyweb/bun-jobs` that the user asked for on 2026-09-29:

1. **A worker gateway.** A worker on remote or summoned compute that does
   not connect to the driver. It talks to the driver through any active
   queue host, over the wire, on a protocol of the user's choosing. Local-only
   drivers (memory, file, SQLite) can then have remote workers too.
2. **Job isolation.** An optional container around the job on the remote
   compute, so that a malicious or buggy job cannot harm the machine, other
   tenants' jobs, or read sensitive data. The user's emphasis was "possible
   ways to ensure host machine is protected".

Written 2026-09-29 against `develop` at `8d3df4d`. **No code was changed.**
Every `file:line` is at `8d3df4d` and relative to `packages/bun-jobs/`
unless it says otherwise. The evidence is in
[`evidence/worker-gateway-and-isolation/`](evidence/worker-gateway-and-isolation/README.md),
and every measurement there can be re-run with one command.

## Contents

1. [Executive summary](#1-executive-summary)
2. [What exists today](#2-what-exists-today)
3. [The gateway: pull through a queue host, or push from one?](#3-the-gateway-pull-through-a-queue-host-or-push-from-one)
4. [Part 1 design: the worker gateway](#4-part-1-design-the-worker-gateway)
5. [Part 2 design: protecting the host from the job](#5-part-2-design-protecting-the-host-from-the-job)
6. [Security model, both parts together](#6-security-model-both-parts-together)
7. [Measured evidence](#7-measured-evidence)
8. [Risks](#8-risks)
9. [Open questions for the user](#9-open-questions-for-the-user)
10. [PR slicing and effort](#10-pr-slicing-and-effort)
11. [Where it slots in the phase order](#11-where-it-slots-in-the-phase-order)
12. [Names needing approval](#12-names-needing-approval)

## How to read the markings

The same marks as the other plans:

| Mark | Meaning |
|---|---|
| **[S]** | Read in this repo's source at `8d3df4d`; the `file:line` is given |
| **[M]** | Measured here by a spike that can be re-run; the evidence file is named |
| **[V]** | Read on 2026-09-29 in a primary source; the source is in the evidence file |
| **[V-prior]** | Carried from an earlier plan or evidence file in this repo, which is named, and not re-read |
| **[I]** | Inference. A claim to test, never a finding |
| **[U]** | Unverified. Nothing may rest on it |
| **[D]** | A design decision this plan proposes |

Short names for the other plans: **WR** is
[`worker-runtimes.md`](worker-runtimes.md), **RT** is
[`remote-transports.md`](remote-transports.md), **CP** is
[`compute-provider-plugins.md`](compute-provider-plugins.md), and **SC** is
[`summon-compute.md`](summon-compute.md).

---

## 1. Executive summary

### 1.1 The one-paragraph answer

**Yes, today a summoned worker connects to the driver**, and the user is
right that this rules out memory, file and SQLite queues for remote workers
and puts database credentials on the remote. **The pattern the user wants is
already half-designed, as Phase 2's *reversed* direction** (RT §7.6,
`ws-reverse`): the remote dials any queue host, and the host's worker claims
only as much work as the connected remotes have room for. This plan
therefore **does not build a remote driver**. The queue host keeps the
driver, the claim and the lease. The remote becomes an *executor* that dials
in, receives attempts and sends back outcomes, and holds nothing but a
short-lived, queue-scoped key. What is new is:

- a **mountable gateway** (`createWorkerGateway`) that serves many queues
  from an app's existing server;
- a **reversed HTTP long-poll binding** (`http-poll`) beside `ws-reverse`,
  so the dial-out works over HTTP/1.1, HTTPS, HTTP/2 and HTTP/3 wherever
  WebSocket is stripped;
- **scoped executor keys**, and one-time bootstrap codes for summoned
  compute;
- **summoned executors**, so that summon-compute can start one;
- pulling this slice of Phase 2d forward, to right after 2b.

For the host, the answer is a **`container` worker target**: each attempt
runs in a hardened, pre-warmed, single-use container with no network. The
worker talks to it over stdio, so the container holds neither the gateway
key nor any database credential. It depends only on Phase 1's `target`
option, so it can ship first. A **platform-isolation capability** on the
provider API covers the platforms where no container can run inside.

### 1.2 The decisions

| # | Decision | Why |
|---|---|---|
| G1 | **No remote driver**, neither the whole contract nor a "worker subset". | A summoned worker reaches 39 of the 99 driver members, 49 with the processor's `Job` API [S, §2.2], including `setQueueState`, `addJob` and `getJob`. None of those can be scoped to one queue's attempts. WR §10.1 deferred it for the same reasons. §3.2 |
| G2 | **The remote is a Phase 2 executor that dials in. The queue host holds the lease** (reversed push). | The host runs an ordinary `BunQueueWorker`, so flows, dead letters, limits, events, metrics and maintenance work unchanged. Only the processor call crosses the wire. §3 |
| G3 | **"Any active queue host" is literal.** Every host that mounts the gateway for a queue serves any executor of that queue. | Every worker of a queue claims from the same store, so no host is special (RT §7.6 [V-prior]). §4.4 |
| G4 | **The gateway is a mountable router plus a WebSocket handler**, separate from `createJobsApi`, with a bun-nest module. | WR §5.1's five reasons for keeping the worker contract off the management API apply unchanged [V-prior]. §4.3 |
| G5 | **Two reversed bindings: `ws-reverse` (RT §7.6) and a new `http-poll`.** HTTP/2 and HTTP/3 are `fetch` options of `http-poll`; TCP and UDP stay as RT specifies. | Every protocol the user listed has a binding or a flag. Bun 1.4.3 supports all of them, measured (§7.2). "up" is read as an open question (Q1). The transport stays pluggable through CP's `execute` facet. |
| G6 | **Executors hold a derived, scoped, expiring key, never the gateway's master key or a database URL.** Summoned compute gets a one-time bootstrap code as an argument. | A host verifies a derived key with no state, so any host accepts it. Arguments rather than environment follow SC §5.5 [V-prior]. A one-time code survives being readable in `/proc/*/cmdline`. §4.8 |
| G7 | **Summon can start an executor.** Its slot is released by the executor's authenticated `hello`, and the gateway writes the claim-exit mark for it. | An executor has no driver to write either. §4.9 |
| G8 | **A lost link fails the attempt after `resumeWindowMs`, as Phase 2 already says** (`RemoteAttemptLostError`, RT T8). Host-to-host *adoption* of in-flight attempts is designed but deferred (Q5). | Adoption needs a new driver method to hand a lock over atomically; without one, two hosts could settle the same attempt. §4.6 |
| I1 | **Isolation is a worker target, `"container"`, not a transport feature.** | A target already owns "where the processor call runs" (`queue/workerTarget.ts`) [S]. It then works for a local worker and inside a remote executor alike. §5.3 |
| I2 | **By default each attempt gets a fresh, pre-warmed, single-use container.** | The cold start is paid off the critical path, and nothing a job writes survives into the next job. The numbers are in §7.3. |
| I3 | **Hardened by default, with refusals.** `--network none`, read-only root, all capabilities dropped, a non-root user, pids, memory and CPU limits, and an env allowlist. `privileged`, a Docker socket mount and host namespaces are refused. | Each flag was checked against a hostile job (§7.4). |
| I4 | **The job's data crosses the container boundary on stdio**, as framed JSON. The container never gets the network, the gateway key, or the parent's environment. | Today's `child-process` and `worker-thread` targets pass the whole `process.env` to the job (`runner/executors/spawn.ts:106-107`, `runner/executors/worker.ts:71-73`) [S]. §5.7 |
| I5 | **Where Docker cannot run, the option fails fast with a clear error.** A provider can instead declare the isolation its platform gives (a microVM per task, say), and a policy can require it. | The user asked that it never silently degrade. §5.6 |
| I6 | **Containers share the host kernel, and the docs say so first.** gVisor or Kata is a `runtime` choice, verified at start. | A kernel exploit escapes any runc container [I]; neither runtime is installed here, so their claims are [U] (§7.5). |

### 1.3 What it costs, and where it goes

| Part | Effort (bun-jobs session) | Depends on |
|---|---|---|
| Part 2, the `container` target, its pool and policy | ~9.5 d | Phase 1 (merged) |
| Part 2, `child-process` hardening and the docs | ~3 d | Phase 1 |
| Part 2, the platform-isolation capability | ~2 d | 1.5p |
| Part 2, a Docker-free `sandbox` target (bubblewrap) | ~4 d, optional (Q9) | Phase 1 |
| Part 1, the gateway (sub-phase **2r**), with the executor's `container` target | ~22 d, of which ~4 d moves out of 2d: **~18 d net** | 2a and 2b |
| Part 1, attempt adoption | ~4 d, deferred (Q5) | 2r |

§10 has the PRs, and §11 the order. **The recommended order is Part 2's
container target right after 1.5p, then Phase 2 with 2r after 2b.** Part 2
protects every worker, local or remote, and waits on nothing. Part 1 cannot
come before 2a without forking the wire protocol (Q3).

---

## 2. What exists today

### 2.1 A summoned worker is an ordinary worker, and holds the driver

`runSummoned(worker, options)` (`summon/worker.ts:1285`) [S] is handed a
`BunQueueWorker` that the remote entry script built **with its own driver**.
The whole summon lifecycle then runs against that driver:

| Step | Driver use | Where [S] |
|---|---|---|
| Claim, extend, settle | `claimJob(s)`, `extendJobLock`, `completeJob(s)`, `failJob` | `queue/BunQueueWorker.ts:2434`, `:3934`, `:2959`/`:2973`, `:3727` |
| Idle exit | `readDemand` → `isQueuePaused`, `listWorkers`, `countDemand` (or `countJobs` and `nextDelayedAt`) | `summon/worker.ts:1004-1007`; `drivers/readApis.ts:893-979` |
| Claim-once | `getQueueState`, compare-and-set, `listWorkers` | `summon/claim.ts:162-235`, via `claimSummonAttempt` from the worker's report (`BunQueueWorker.ts:4678-4705`) |
| The exit mark | `markSummonClaimExit` → `getQueueState` + compare-and-set | `summon/worker.ts:1167-1178`; `summon/claim.ts:379-422` |
| Its own record | `registerWorker`, or a queue-state fallback | `BunQueueWorker.ts:4760`; `drivers/readApis.ts:602-630` |

So the remote needs a route to the database, and the database credentials
live on the remote. A memory queue exists only inside one process, so it
cannot have a remote worker at all. File and SQLite queues need a shared
disk. **The user's premise is correct** [S].

### 2.2 How much of the driver a worker actually reaches

An inventory of every `JobsDriver` member reachable from a running
`BunQueueWorker`, from `runSummoned`, and from a processor through its `Job`,
following every helper (`claimBatch.ts`, `completeBatch.ts`, `limits.ts`,
`deadLetter.ts`, `retry.ts`, `windows.ts`, `workerControl.ts`,
`workerMetrics.ts`, `repeatControl.ts`, `readApis.ts`, `summon/claim.ts`)
[S]:

- The contract has **99 unique members** (97 methods): `DriverLifecycle`
  (9), `RunnerDriver` (29) and `QueueDriver` (64), with three declared on
  both halves (`drivers/driver.ts:91-121`, `:385-775`, `:1970-2871`).
- **A running worker reaches 37 members, `runSummoned` adds 2, and the
  processor's `Job` API adds 10: 49 in all.**

| Category | Members | Could a gateway scope it to "this executor's attempts"? |
|---|---|---|
| Claim, lease, settle | `claimJob`, `claimJobs`, `extendJobLock`, `completeJob`, `completeJobs`, `failJob` | Yes: each takes the lock token (`driver.ts:2027-2076`) |
| Wakeups | `waitForJob`, `nextDelayedAt`, `isQueuePaused`, `capabilities`, `subscribe`, `publish` | Partly: `publish` writes any event |
| Liveness chores, always on | `promoteDelayed`, `recoverStalled`, flow heal (`listJobs`, `getJob`, `recordChild`, `markChildRecorded`) | No: these act on *other workers'* jobs |
| Housekeeping (`maintenance`) | `pruneExpired`, repeats (`listRepeats`, `getRepeat`, `upsertRepeat`, `addJob`, `removeJob`), window and control sweeps | No: they act on the whole queue |
| Dead letters | `connect`, `ensureQueue`, `addJob` on *another* queue | No: that is an enqueue into any queue |
| Limits, control, records | `getQueueState`, `setQueueState`, `listQueueState`, `registerWorker`, `removeWorker`, `listWorkers` | No: generic key-value writes |
| Metrics | `countWorkerJobs`, `sampleWorkerBusyness`, `flushThroughput`, `flushMetrics` | Partly |
| Processor via `Job` | `updateProgress`, `addJobLog`, `getJobLogs`, `clearJobLogs`, `updateJob`, `promoteJob`, `retryJob`, `requeueParent`, `buryJob`, `getJob` | Only the first two, safely |

Three facts from the same reading decide the design:

1. **The liveness chores cannot be turned off.** `maintenance: false` stops
   only the once-a-minute housekeeping. Stalled recovery, delayed
   promotion and flow healing are armed unconditionally, "because a queue
   whose only worker turned them off stranded all three for ever"
   (`queue/types.ts:1036-1056`; `BunQueueWorker.ts:5003-5032`) [S]. A remote
   `BunQueueWorker` behind a proxy would therefore need `recoverStalled` and
   `promoteDelayed`, which act on jobs that are not its own.
2. **A settle is conditional on the lock token, and a repeat of a
   successful one answers `false`.** Every settle clears `lock_token`
   (memory driver `drivers/memory-driver.ts:1011`, `:1040`; SQL
   `drivers/sql/sql-driver.ts:3281`, `:3494`) [S]. A retried completion therefore cannot
   tell "already done by me" from "lost the lock" at the driver. Whoever
   retries a settle over a network must remember what it already settled.
3. **The token is per claim**: `newClaimToken(worker id)` is drawn once per
   claim pass, and a batch shares it (`shared/ids.ts:65-69`;
   `BunQueueWorker.ts:2430`, `:2483-2485`) [S].

### 2.3 What Phase 2 already designs, and this plan reuses

| Piece | Where it is specified | Used here for |
|---|---|---|
| One message protocol, twenty messages, a session and an attempt state machine | RT §4.1, §4.6–§4.7 | Everything between gateway and executor |
| Per-frame HMAC bound to session, direction and sequence; AEAD where not confidential | RT §4.4 | Unchanged. The key becomes the executor's derived key (§4.8) |
| The reliability layer: acks, outbox, resume, `status` | RT §4.5, §4.9 | Resume after a dropped link; idempotent outcomes |
| Health: liveness, readiness, a functional canary, a breaker | RT §5 | Per executor session |
| `ws-reverse`: the gateway listens, capacity-gated claiming, `resumeAt`, make-before-break drain | RT §7.6 | The first reversed binding, pulled forward (G5) |
| Fencing `lockToken:claimedAt`; idempotency key `ns:queue:jobId:attempt` | WR §5.8 | Outcome dedupe and stale-settle rejection |
| `RemoteAttemptLostError`, retryable, counts as an attempt | RT T8, Q-T11 | Link loss past the resume window |
| The `execute` facet, session shape, `listen()` | CP §8.2, RT T4 | The gateway's transports are pluggable |
| `createRemoteExecutor`, `dialWebSocket`, `/healthz`, `/readyz` | RT §9, WR §6.1 | The remote side, unchanged in shape |
| `jobs.remoteWorker(queue, { listen })` | RT §8.2–§8.3 | The standalone form. The mountable gateway is new (§4.3) |

### 2.4 The seams in the code

- **A custom target** (`WorkerTargetFactory`, `queue/workerTarget.ts:161`)
  receives each attempt as `{ job, record, context }` and returns its
  result. It is deliberately given no driver (`:168`) [S]. The throwaway
  prototype in §7.1 is a factory that pushes the attempt to a dialled-in
  executor, and it ran on the real claim, lease and settle paths unchanged.
- **The target kinds** are `["in-process", "worker-thread", "child-process",
  "custom"]` (`shared/workers.ts:220-225`) [S]. `"container"` would be the
  fifth (I1).
- **A child-process target talks over Bun's IPC channel**
  (`Bun.spawn(..., { serialization: "json", ipc })`,
  `runner/executors/spawn.ts:98-122`) [S]. That channel is an inherited file
  descriptor, which a `docker run` does not pass into the container [I]. A
  container target therefore needs a stdio channel (§5.7).
- **What a child can ask its parent** is a closed list: `log`, `heartbeat`,
  `childrenValues`, `childrenFailures`, plus fire-and-forget progress
  (`workerTarget.ts:1038-1044`, `:1100-1138`, `:741`). "Everything else that
  would change the stored job directly is unavailable in the child"
  (`:49`) [S]. The same rule serves an executor and a container.
- **Today's isolation targets do not isolate secrets.** Both pass
  `...process.env` to the job (`spawn.ts:106-107`, `worker.ts:71-73`) [S].
  A job in a child process can read the worker's database URL.
- **Nothing sets resource limits.** `resourceLimits` appears nowhere in
  `lib/`, and `WorkerThreadTarget` takes only `closeTimeout` and `{ env,
  argv, smol, name }` (`workerTarget.ts:110-124`) [S].

---

## 3. The gateway: pull through a queue host, or push from one?

The coordinator's first question: **how is a remote `BunQueueWorker` that
pulls through a gateway different from Phase 2's push model, and is it still
needed?**

### 3.1 Three shapes

- **(A) Pull through a driver proxy.** The remote runs a real
  `BunQueueWorker` whose driver is a network client, and the host maps each
  call onto its real driver. The remote holds the lock token and renews its
  own lease. This is WR §10.1's deferred `HttpDriver`, or a subset of it.
- **(B) Forward push, Phase 2 as committed** (WR §5, RT §7.2–§7.5). The
  host's worker claims, holds the lease and *dials* the executor. The
  executor needs an inbound path.
- **(C) Reversed push**, RT §7.6 plus this plan. The executor *dials* any
  queue host and advertises capacity; the host's worker claims only that
  much and pushes attempts down the executor's connection. From the
  remote's side it looks like pulling: it asks for work, and gets it.

### 3.2 Compared

| | (A) Driver proxy | (B) Forward push | (C) Reversed push |
|---|---|---|---|
| Who holds the lease | the remote | the queue host | the queue host |
| Who holds DB credentials | the host; the remote holds a proxy credential | the host | the host |
| Inbound path needed on | the host | **the remote** | the host |
| Works on FaaS | badly: it must poll, and a freeze stalls the lease | yes | no, needs a live process (RT §7.6) |
| Drivers | all, if the host owns the store (§4.5) | all, likewise | all, likewise |
| Round trips per batch | claim + complete (+ an extend per lease third) | one invoke | one push + one result |
| Liveness chores | the remote must run them (§2.2 fact 1) | on the host | on the host |
| Flows, dead letters, events | proxied (more members) or lost | unchanged | unchanged |
| Least privilege | poor: `setQueueState`, `addJob`, `getJob` are generic | executor sees only its attempts | same as (B) |
| Versioning | tied to a 99-member contract that changes each phase | one versioned protocol | the same protocol |
| Link drop | lease lapses, stalled sweep re-runs | `RemoteAttemptLostError` after heartbeat loss | after `resumeWindowMs` |
| Host dies mid-attempt | nothing lost: another host proxies the same token | lease lapses, re-run | lease lapses, re-run (adoption, §4.6, would fix) |
| New code | a second driver implementation + an authorizer | Phase 2 | Phase 2 + §4 |

Measured on loopback (§7.1): with batching, putting the hop in costs
little against a real backend. A worker behind `ws-reverse` ran at
22,658 jobs/s on Redis, against 25,770/s for a direct worker (−12%), and at
5,069/s against 4,876/s on Postgres, which is within noise. Only the memory
backend, where the store is free, shows the hop's full cost: 76,580/s
against 140,324/s. The p50 latency added was under 0.1 ms. A raw proxy of
`claimJobs`/`completeJobs` measured faster still, but only because it skips
events, metrics and every chore; it is a lower bound, not a like-for-like
figure (§7.1).

### 3.3 Why (A) is rejected

1. **It cannot be least-privilege.** A worker needs `setQueueState` for
   limits, control and its own record; `addJob` for dead letters and
   repeats; `getJob` and `listJobs` for flows (§2.2). Each is generic. A
   proxy that must allow them allows a compromised remote to rewrite any
   queue-state entry, enqueue into any queue, and read any job. Scoping
   them means re-implementing, per call, the worker's intent on the host,
   which is the worker itself.
2. **It cannot shrink to the core.** The liveness chores are
   unconditional by design (§2.2 fact 1). A remote worker that skips them is
   a new worker mode with its own correctness argument.
3. **It is a second implementation of a moving contract.** The driver
   gained `countDemand` in 1.5a and gains more each phase. A remote driver
   either tracks it forever or is versioned separately from it.
4. **It buys one thing (C) lacks**: surviving a host crash without a
   re-run, because the remote holds the token and any host can proxy it.
   §4.6 gets the same property for (C) with one new driver method, if the
   user wants it (Q5).

### 3.4 So: is the user's pattern still needed, given Phase 2?

**Yes, but as a slice of Phase 2, not a new system.** Phase 2 as committed
already carries a remote attempt with no driver on the remote. What it does
not yet give the user:

| Gap | Where Phase 2 stands | This plan |
|---|---|---|
| Reversed dial-in lands in **2d**, after 2c | ~57.5 d of work before it starts (RT §13.1) | Move `ws-reverse` to **2r**, right after 2b (Q2) |
| A reversed binding over **plain HTTP** | None: SSE session mode is forward (RT §7.4 c) | `http-poll`, so HTTP/1.1, HTTPS, h2 and h3 all work (§4.7) |
| Serving **many queues from one mount** in an existing app | `listen` binds a listener per remote worker (RT §8.2) | `createWorkerGateway` (§4.3) |
| **Scoped** credentials | one shared secret per remote worker (WR §5.6) | derived executor keys and bootstrap codes (§4.8) |
| **Summoned executors** | summon starts a `BunQueueWorker` with a driver | `runSummonedExecutor` (§4.9) |
| Which drivers can serve which hosts | not stated | §4.5 |

---

## 4. Part 1 design: the worker gateway

### 4.1 The shape

```
 queue host (any of several)                       remote or summoned compute
 ┌─────────────────────────────────────────┐        ┌──────────────────────────────────┐
 │ app's Bun.serve (bun-common / bun-nest) │        │ createRemoteExecutor({ handlers })│
 │   /jobs-gateway  ← createWorkerGateway  │◀─dial──│ dialWebSocket / dialHttp          │
 │     one RemoteWorker per queue          │  wss   │   holds: executor key (derived,   │
 │     (BunQueueWorker, reversed target,   │  https │   scoped, expiring) — nothing else│
 │      claims only up to executor credit) │  h2/h3 │ handlers run in-process, or in a  │
 │   driver ── Redis / SQL / Mongo / file  │        │   "container" target (Part 2)     │
 │            / memory (this process only) │        └──────────────────────────────────┘
 └─────────────────────────────────────────┘
```

Every gateway host runs an ordinary `BunQueueWorker` per served queue, as a
Phase 2 `RemoteWorker` with a reversed target. It claims, renews and
settles exactly as a local worker does. That is what keeps every feature
working unchanged. The executor holds no driver and no database URL.

### 4.2 What crosses the wire

Only Phase 2's messages (RT §4.1), in the reversed direction. The executor
dials and sends `hello`; the gateway answers `welcome` (RT §3.4).

| Message | Direction | Carries | Notes |
|---|---|---|---|
| `hello` / `welcome` | e→g / g→e | executor name, credential claims, capacity; session nonces, `resumeAt`, lease cadence | The credential replaces the shared secret (§4.8) |
| `heartbeat` | both | `capacity: { inFlight, max }`, attempts running | The capacity *is* the credit: the gateway claims at most `max − inFlight` for this session (RT §7.6) |
| `invoke` | g→e | the attempt: id, name, data, attempt, fence, `deadlineMs`, `leaseMs` | Relative durations only (§4.6) |
| `accepted` / `rejected` | e→g | per attempt | A rejection burns no attempt (WR §5.9) |
| `progress`, `log` | e→g | per attempt | Become `job.updateProgress()` / `job.log()` on the host |
| `result` / `fail` | e→g | outcome, serialised error | Retained by the executor until acked (RT §4.5) |
| `cancel` | g→e | reason | On a lost lock or a timeout, as today |
| `status` / `status-result` | both | "what happened to these attempts?" | After a resume |
| `close` | both | `drain: true`, a reason | Graceful shutdown, idle exit (§4.9) |
| `rekey` / `rekeyed` | g→e / e→g | a fresh executor key before the old one expires | **New** (§4.8) |
| `poll` | e→g | the `http-poll` binding's request frame | **New**, binding-local (§4.7) |

**What the executor's `job` can do** is the child-process rule
(`workerTarget.ts:49`) [S], unchanged: progress, log, heartbeat, and read its
children's values and failures. Everything that would change the stored job
directly (`updateData`, `promote`, `retry`, `remove`, `bury`) is
unavailable, and says so, as it already does in a child process.

**The features that "need more" stay on the host**, with no protocol:

| Feature | What happens |
|---|---|
| Flows | The host's worker delivers a child's outcome to its parent, heals, and releases (`BunQueueWorker.ts:3050-3243`) [S]. `getChildrenValues`/`getChildrenFailures` cross as the child channel's existing ops |
| Run logs, job logs | `log` frames become `job.log()` on the host |
| Metrics, throughput | Counted by the host worker, as for any worker. The Workers page shows the host's `RemoteWorker` and, beside it, its executor sessions (RT §12) |
| Rate limits, `QueueLimiter` | Reserved by the host at claim. Unchanged, cluster-wide |
| Dead letters | Written by the host worker |
| Events and notifications | Published by the host worker when `publish: true` |
| Wakeups | The host blocks in `waitForJob` as today. An executor never polls the store; it waits on its session |
| Worker control | Pause, stop and concurrency act on the host's `RemoteWorker`; its effective concurrency is `min(concurrency, Σ executor capacity)` |

### 4.3 The host side: a mountable gateway

```ts
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { createWorkerGateway } from "@kingsleyweb/bun-jobs/gateway";

const jobs = new BunJobs({ driver: { type: "sqlite", url: "file:jobs.db" } });

const gateway = createWorkerGateway({
  jobs,
  basePath: "/jobs-gateway",
  keys: [{ kid: "2026-09", secret: process.env.GATEWAY_KEY! }], // rotation list; first signs
  queues: {
    reports: { concurrency: 32 },           // per-queue RemoteWorker options
    thumbnails: { concurrency: 8, names: ["resize"] },
  },
  bindings: ["ws-reverse", "http-poll"],    // default: both
});

app.use(gateway.basePath, gateway.router);  // bun-common BunRouter: http-poll, /healthz
gateway.attach(server);                      // the WebSocket upgrade on the same server
```

- **A router plus a socket, like `createJobsApi`.** `createJobsApi` already
  returns a router and a socket that attaches to the app's server or binds
  its own port (`api/createJobsApi.ts:100-141`) [S]. The gateway follows the
  same shape, so `gateway.info` reports its path and port the same way.
- **In bun-nest**, `BunJobsGatewayModule.forRoot({ gateway })` in the
  existing `./jobs` entry mounts the router in `onModuleInit` and attaches
  the socket in `onApplicationBootstrap`, as `BunJobsApiModule` does
  (`bun-nest/lib/jobs/BunJobsApiModule.ts:164-181`) [S]. bun-jobs stays an
  optional peer of that entry.
- **Separate from the management API**, for WR §5.1's reasons: opposite
  direction, a machine-to-machine auth model with no cookies or CSRF, a
  separate blast radius, and an independent version. The management API
  *reads* the gateway: sessions, executors and their health appear on the
  Workers page (RT §12), through the heartbeat record the host worker
  already writes.
- **Standalone.** `jobs.remoteWorker(queue, { listen })` (RT §8.2) stays for
  a gateway that binds its own port. Both build on one reversed-target
  implementation.

### 4.4 Multiple gateway hosts, and failover

- **Any host that mounts the gateway for a queue serves that queue's
  executors.** They sit behind one DNS name or load balancer. Each executor
  session lands on one host, whose worker claims only up to that session's
  capacity (RT §7.6 [V-prior]).
- **An executor dials one host at a time by default.** With `sessions: n` it
  holds sessions to up to `n` distinct hosts and splits its capacity across
  them. A host that dies takes only its share of the in-flight attempts.
- **`resumeAt`** in `welcome` names the host's direct address, so a dropped
  session is resumed on the same host, where its attempts and lease are.
  The shared address is the fallback (RT §7.6).
- **A graceful host shutdown loses nothing.** `worker.close()` already waits
  for in-flight attempts up to its timeout. The gateway sends `close {
  drain: true }` first, so executors open a session elsewhere for new work
  while finishing the old (make before break). A rolling deploy with a drain
  timeout longer than the jobs re-runs nothing [I, to be a test].
- **A host crash re-runs its in-flight attempts.** The lease lapses, and the
  stalled sweep on any other host re-queues them after `lockDuration +
  stalledInterval` (defaults 30 s + 30 s). The executor, reconnecting
  elsewhere, finds `status` answering "unknown" for them and drops their
  outcomes. §4.6 describes adoption, which would avoid the re-run.

### 4.5 Which hosts may serve which drivers

| Driver | Who may mount its gateway | What is lost when a gateway host dies |
|---|---|---|
| memory | **only the process that owns the driver instance** | **Everything.** The queue itself lives in that process, so waiting jobs, results and schedules die with it. Remote executors only move the processor call. They do not make a memory queue durable |
| file | hosts sharing the directory, on one filesystem with working locks | in-flight attempts re-run after the lease lapses. NFS-style shared mounts are [U] |
| SQLite | hosts sharing the database file on one machine | as file. SQLite over a network filesystem is unsafe [V-prior, SQLite's own guidance, not re-read] |
| Redis, Postgres, MySQL, MariaDB, MongoDB | any host that reaches the server | in-flight attempts of that host re-run |

This is the honest limit of "local-only drivers can have remote workers".
The *work* can be remote; the *queue* is still where the driver is. For a
memory queue, the gateway host is a single point of failure by
construction, as it already is for a memory queue with local workers.

### 4.6 Leases and correctness over a network

**Who holds the lease.** The host, always (G2). Its worker renews every
in-flight attempt's lock on its own timer (`#heartbeat()`,
`BunQueueWorker.ts:3934`; timer `:2694`) [S], whatever the link is doing.

**When the link drops** (RT §4.6–§4.7, applied to the reversed direction):

| Time after the last verified frame | Host | Executor |
|---|---|---|
| 0 to `livenessTimeoutMs` (25 s) | keeps renewing; session `suspect` | keeps running its attempts; redials with backoff (500 ms → 30 s, jitter), `resumeAt` first |
| resumed within `resumeWindowMs` (30 s) | replays unacked frames; outcomes settle | replays retained outcomes; `status` for anything unclear |
| past `resumeWindowMs` | fails each attempt `RemoteAttemptLostError` (retryable, counts as an attempt); sends nothing more | still running: it cannot know the host gave up |
| past `abandonAfterMs` (default `resumeWindowMs + lockDuration`) | — | **aborts** the attempt's signal, drops its outcome, frees the capacity |

**Every gateway unreachable**, from the executor's side, in order:

1. It receives no new attempts. It never claims, because it cannot.
2. It keeps running what it has until each attempt's own budget ends: the
   smaller of the attempt's `deadlineMs` and `abandonAfterMs` since its last
   contact. Both are relative durations on its own monotonic clock.
3. It then aborts those attempts and drops their outcomes. By then the host
   has failed them or their lease has lapsed, so a late outcome could not
   settle anyway: the lock token no longer matches (§2.2 fact 2).
4. A summoned executor unreachable for `orphanTimeoutMs` (default 5 min)
   exits with its own exit code. Nothing on the remote needs cleaning up in
   the store, because it holds nothing there.

**Idempotent outcomes.** A `result` or `fail` is keyed by the attempt's
idempotency key and fence (WR §5.8). The host remembers the attempts it has
settled until acknowledged, and answers a duplicate with an `ack` and no
driver call. This matters because a repeated settle answers `false` from the
driver, indistinguishable from a lost lock (§2.2 fact 2). The executor
retains each outcome until it is acked, and re-sends it after a resume. A
host that restarted answers `status` with "unknown", and the executor drops
the outcome.

**Clocks.** Only three things use a wall clock, and only the host's:

- **Credential expiry** is checked by the host against the host's clock.
  Hosts must agree within the credential's slack (§4.8, 60 s). This is the
  new requirement: **gateway hosts need NTP.** Executors' clocks never
  matter here.
- **Replay protection** on `hello` keeps RT §4.4.1's ±300 s window, so an
  executor whose clock is more than 5 minutes off cannot connect. The
  gateway says so by name in the close reason (`CLOCK_SKEW`), as WR §5.11
  wants.
- **Job times** (`deadlineAt`, retries, delays) stay the host's (WR §5.11).
  Everything sent to an executor is a relative duration.

**Adoption, designed and deferred (Q5).** An executor that resumes on a
*different* host could hand its in-flight attempts over, instead of letting
them re-run. The new host would take the lock with the executor's token and
keep renewing it. The trap is that the old host, if merely partitioned,
still holds the same token and can still settle or fail the job, so two
hosts could settle one attempt. The safe form needs **an atomic token
handover in the driver**:

```ts
export interface QueueDriver {
  /** Replaces an active job's lock token, for its current holder only. Optional. */
  handOverJobLock?: (
    q: QueueRef,
    id: string,
    from: string,
    to: string,
    lockMs: number,
    now: number,
  ) => Promise<boolean>;
}
```

After a handover the old host's settles answer `false`, which is correct.
It is a compare-and-set that every driver already performs in
`extendJobLock`, so it is small per driver [I]. It is still a contract
change across five drivers (~4 d), and at-least-once is already the
contract. So: deferred, with the design kept here.

### 4.7 The transport

**Pluggable, through CP's `execute` facet, session shape, `listen()`**
(RT T4) [V-prior]. The gateway core never knows a transport by name. Two
first-party reversed bindings, and every scheme the user listed maps to one
of them:

| User's word | Binding | How | Status in Bun 1.4.3 (§7.2) |
|---|---|---|---|
| websocket | `ws-reverse` over `wss://` | RT §7.6 as specified | client and server [M] |
| http, https | `http-poll` | executor long-polls `POST <base>/poll`; frames in both bodies | client and server [M] |
| http2 | `http-poll` with `fetch({ protocol: "http2" })` | many polls multiplexed on one connection | client and server, experimental [M] |
| http3 | `http-poll` with `fetch({ protocol: "http3" })` | experimental, off by default | client and server, experimental; no per-request CA pinning [M] |
| TCP, UDP | reverse TCP (RT 2d), UDP (RT 2e) | as RT specifies | [M] |
| "up" | unknown: UDP? gRPC? a typo? | a plugin transport on the session shape needs no core change | Q1 |

**`http-poll`, specified** [D]. The executor opens up to `sessions ×
pollers` concurrent `POST` requests to `<basePath>/poll`. Each body carries
frames the executor wants to send: outcomes, progress, heartbeats and acks.
The gateway answers with whatever frames it has for that session, such as
invokes and cancels, as soon as it has any, or with an empty frame list
after `pollHoldMs` (default 25 s, below the 30 s idle clocks of RT §2.2).
It is a session binding: `hello` rides the first poll, and every frame is
MAC'd with the session's key and sequenced (RT §4.4.1). It inherits the
reliability layer's resume from 2b.

- **Why it exists.** It is the only reversed binding that crosses an
  HTTP-only egress proxy, a proxy that strips `Upgrade`, or an HTTP/2-only
  path. RT's SSE session mode is the forward direction (RT §7.4 c) and does
  not serve this.
- **Why long-poll, not a streamed request body.** A request body stream is
  capped in total by `maxRequestBodySize` [V-prior, RT §2.1], and proxies
  that buffer request bodies break full duplex [U, RT §2.1].
- **Its costs.** One request per round of frames per poller. On loopback
  with batching it matched `ws-reverse`: 79,194/s against 76,580/s on
  memory, and 23,414/s against 22,658/s on Redis (§7.1). Without batching it
  was half as fast as WebSocket on memory (18,476/s against 35,869/s),
  because each poll carried one frame.
- **Bun behaviours it must handle** [V-prior, RT §2.1]: the header block
  flushes only with the first body chunk, which does not matter for a
  unary answer; `idleTimeout` is set to 0 on the poll route, with
  `pollHoldMs` enforced by an application timer; and `fetch`'s `timeout`
  never fires before ~8 s, so the executor's poll deadline is an
  `AbortSignal.timeout()`.
- **A measured side-finding.** `Bun.serve({ http2: true })` without TLS
  serves cleartext h2 to a prior-knowledge client. `curl
  --http2-prior-knowledge` negotiated HTTP/2, and the control server
  without `http2` refused (§7.2). RT recorded h2c only through
  `node:http2`. An `http-poll` gateway behind a TLS-terminating proxy that
  speaks h2c upstream therefore needs no `node:http2`.

**First to ship:** `ws-reverse` and `http-poll`, in that order. Together they
cover every long-running remote with outbound HTTP. TCP and UDP stay where
RT puts them.

### 4.8 Authentication and authorization

**What exists.** Phase 2 authenticates with one shared secret per remote
worker, HMAC per frame (WR §5.6, RT §4.4) [V-prior]. Handing that secret to
summoned compute would give every summoned machine a key that works for
every queue the secret covers, for ever.

**The design** [D]. Three kinds of key, one rule: *a host can verify any of
them without state, and none of them is a database credential.*

| Key | Held by | Lifetime | Scope |
|---|---|---|---|
| gateway key(s) | gateway hosts only | long; a rotation list, first signs (as WR §5.6) | everything this gateway serves |
| executor key | a long-running executor | ≤ 24 h by config; refreshed in-session by `rekey` | claims below |
| bootstrap code | summoned compute, on its command line | ≤ the summon's boot budget (180 s default, `summon/define.ts:20`) [S]; **single use** | one summon id, one queue |

**A derived key**, the shape of SigV4's signing keys:

```
claims   = { v: 1, kid, ns, queues: [...], names?: [...], exec, maxCapacity,
             iat, exp, jti, summon?: <summon id> }          // canonical JSON
key      = HMAC-SHA256(gatewayKey[kid], "bun-jobs/executor-key/v1" LF claims)
credential handed to the executor = base64url(claims) "." base64url(key)
```

- The executor sends `claims` in its `hello` and MACs every frame with
  `key` (RT §4.4.1, with `key` in place of the shared secret). Any host
  recomputes `key` from `claims` and its own gateway key. **No lookup, no
  shared session store, any host.**
- The host enforces the claims on everything: invokes only for `queues`
  and `names`; outcomes only for attempts pushed to *this* session with a
  matching fence (RT §7.6 [V-prior]); capacity at most `maxCapacity`;
  `exp` against the host clock with 60 s slack.
- **Bootstrap codes** have the same shape with `v: "boot"` and a short
  `exp`. The first `hello` that presents one *redeems* it with a
  compare-and-set on a reserved queue-state entry
  (`__gw:boot:<jti>`, the pattern of `summon/claim.ts:40`) [D]. A second
  redemption fails. `welcome` then carries a fresh executor key, which
  travels inside the session: over TLS on `wss`/`https`, or AEAD-sealed
  where the binding is not confidential (RT §4.4.3).
- **Rotation.** A key is re-issued in-session by `rekey` before `exp −
  rekeyLeadMs`, while the session is healthy and the credential is not
  revoked. A long-running executor therefore holds a key that expires
  within the hour by default, even though it runs for days.
- **Revocation.** `gateway.revoke({ jti | exec | summon })` writes a
  reserved queue-state entry (`__gw:revoked`), bounded by the longest
  `exp`, and publishes a driver event. Every host closes matching sessions
  at once (`4403`) and re-reads the list every 10 s as a backstop. Rotating
  the gateway key revokes everything signed with the old one.
- **Why the command line, and why that is acceptable.** SC §5.5 moved summon
  identity to arguments because `Bun.spawn` passes the *startup*
  environment to every descendant [V-prior]. A command line has its own
  exposure: `/proc/<pid>/cmdline` is readable by other processes on the
  machine, and platform consoles show overrides (ECS task overrides, for
  one) [I]. That is why the argument is a **one-time, short-lived** code
  and never the executor key. `runSummonedExecutor` redeems it before it
  imports any handler module, so by the time user code runs, the code on
  the command line is spent.

**The database credentials never leave the host.** Nothing in `hello`,
`welcome`, an invoke, or the summon request carries a driver URL, by
construction: the executor side of the code has no driver type to put one
in. A test asserts that no summon argument and no frame matches the host
driver's URL [D].

**With 1.5p's `ConfiguredProvider` and redaction** (CP §6.1, §13.3):

- The bootstrap code travels in `SummonRequest` as an argument. The
  controller declares it a secret for that call, so the provider's
  redacting logger (1.5p PR-p1) masks it, and it never appears in
  `describe()` facts, in `marker.last.detail`, or in the summon event.
- A provider never sees the gateway key. The controller mints the code;
  the provider only carries it.
- `SummonStatusDto` gains no field for it. The Workers page shows the
  summon id and the executor name, never a credential.

### 4.9 Summoned executors

Summon-compute today starts a process that runs `runSummoned(worker)`.
This adds a second thing it can start:

```ts
// remote entry script, on the summoned compute
import { createRemoteExecutor } from "@kingsleyweb/bun-jobs/remote";
import { runSummonedExecutor } from "@kingsleyweb/bun-jobs/remote/serve";
import handlers from "./handlers";

await runSummonedExecutor(createRemoteExecutor({ handlers, maxConcurrency: 8 }));
// reads --bun-jobs-summon-id=, --bun-jobs-summon-gateway=, --bun-jobs-summon-bootstrap=
```

| Summon step | With a worker (today) | With an executor [D] |
|---|---|---|
| Identity | `--bun-jobs-summon-*` arguments (`summon/args.ts:21-35`) [S] | the same, plus `gateway` (URLs) and `bootstrap` (the code) |
| Release the slot | first worker record carrying the summon id | the redeemed bootstrap `hello`, on whichever host receives it |
| Claim-once | a compare-and-set in the worker's first report (`summon/claim.ts:162`) | the same compare-and-set, **done by the gateway** at redemption |
| Idle exit | `readDemand` in the worker (`summon/worker.ts:1004`) | the gateway, which has the driver, sends `close { drain, reason: "idle" }` when demand has been zero for `idleFor`; the executor also exits after `orphanTimeoutMs` of no gateway |
| Exit mark | `markSummonClaimExit` from the worker | written by the gateway on `close`, or when the session is lost for good |
| Signals, deadline, grace | `runSummoned`'s handlers | the same handlers, factored out and shared |

The controller chooses between the two by the summoner's request: a policy
names `start: "worker" | "executor"` (default `"worker"`, today's behaviour),
and an executor start requires a gateway to be configured for the queue.
Otherwise it is a `ConfigError` at construction.

### 4.10 Performance

Measured on loopback, on a shared 16-thread machine with a load average of
2.5 to 5, which peer sessions were also using (§7.1). Throughput is the median of
three drains of 20,000 (memory) or 10,000 (Redis, Postgres) jobs, at
concurrency 32. Latency is 500 sequential jobs, from `add()` to the
`completed` event.

| Backend | Batching | Direct | `ws-reverse` | `http-poll` | p50 direct → ws → poll (ms) |
|---|---|---|---|---|---|
| memory | on | 140,324/s | 76,580/s | 79,194/s | 0.04 → 0.09 → 0.13 |
| memory | off | 140,398/s | 35,869/s | 18,476/s | 0.04 → 0.10 → 0.16 |
| Redis | on | 25,770/s | 22,658/s | 23,414/s | 0.30 → 0.35 → 0.42 |
| Redis | off | 10,379/s | 8,823/s | 7,324/s | 0.33 → 0.37 → 0.43 |
| Postgres | on | 4,876/s | 5,069/s | 3,202/s | 2.58 → 2.51 → 2.40 |
| Postgres | off | 923/s | 911/s | 947/s | 2.30 → 2.39 → 2.74 |

"Batching off" hides the driver's `claimJobs`/`completeJobs` *and* sends
one attempt per frame. Two readings:

- **Against a real backend the hop is not the bottleneck; the store is.**
  With batching, the gateway costs 9–12% on Redis and nothing measurable on
  Postgres, where `http-poll`'s three runs spread from 2,385 to 3,390/s.
  Frame batching matters more than the binding.
- **Loopback flatters the network.** A real link adds its round trip to
  every *batch*, not every job, as long as capacity covers the RTT. That is
  RT's position (RT §9), and the real-network run is Phase 4's.

The prototype is a throwaway: HMAC per frame through `node:crypto`, no
sequencing, no resume. It sits on the real `BunQueueWorker` through a custom
target, so claim, lease and settle are the production paths.

### 4.11 What a user writes

**On a queue host** (§4.3 has the options). A host that also mounts the
management API mounts both, each at its own path.

**On a long-running remote**, which is not summoned:

```ts
import { createRemoteExecutor } from "@kingsleyweb/bun-jobs/remote";
import { dialHttp, dialWebSocket } from "@kingsleyweb/bun-jobs/remote/serve";

const executor = createRemoteExecutor({ handlers, maxConcurrency: 16 });
const credential = process.env.BUN_JOBS_EXECUTOR_CREDENTIAL!; // minted on a host: gateway.mint({...})

dialWebSocket(executor, { url: "wss://jobs.example.com/jobs-gateway", credential });
// or, through an HTTP-only egress proxy, over HTTP/2:
dialHttp(executor, { url: "https://jobs.example.com/jobs-gateway", credential, protocol: "http2" });
```

A long-running executor is a deliberate deployment, so its credential comes
from the environment or a secret store. The environment-leak finding
(SC §5.5) applies to what its *handlers* spawn, which is exactly what Part 2's
`container` target stops.

**Minting** on a host, for a long-running executor:

```ts
const credential = await gateway.mint({
  exec: "reports-pool",
  queues: ["reports"],
  ttl: "24h",
});
await secrets.put("reports-pool/executor-credential", credential); // your secret store
```

**In a summon policy:**

```ts
jobs.summon("reports", { summoner: ecs(ecsConfig), start: "executor", gateway });
```

---

## 5. Part 2 design: protecting the host from the job

### 5.1 The threat model

A job's code is the attacker: a malicious package in its dependency tree, a
handler that runs a user-supplied script, or plain bugs. It already has code
execution in whatever runs the processor. The question is what else it can
reach.

| # | A hostile job tries to | Today, `in-process` or `child-process` [S] | With the `container` target | Measured |
|---|---|---|---|---|
| T1 | read secrets in the environment: the DB URL, cloud keys | **succeeds**: both targets pass `...process.env` (`spawn.ts:106-107`, `worker.ts:71-73`) | only allowlisted variables; `docker run` inherits nothing | [M] isolation §4 g |
| T2 | read files: app config, `~/.ssh`, `/etc/shadow` | succeeds, as the worker's user | only the image and explicit read-only mounts, as uid 65534 | [M] §4 a, f |
| T3 | reach the database or internal services | succeeds | `--network none`: host and peer containers refused | [M] §4 b, c |
| T4 | reach a metadata endpoint (169.254.169.254) and mint cloud credentials | succeeds | no route at all | [M] §4 b; the cloud answer is [U] |
| T5 | pivot on the network | succeeds | no network namespace to pivot from | [M] §4 b |
| T6 | exhaust CPU | starves the claim loop and heartbeats | `--cpus` | [M] §4 j: share 0.50 |
| T7 | exhaust memory | kills the worker, and every job in it | `--memory` with `--memory-swap` equal: OOM-killed alone | [M] §4 e |
| T8 | fork-bomb | exhausts the host's pids | `--pids-limit` | [M] §4 d: 60 of 64 |
| T9 | fill the disk | fills whatever the worker can write | read-only root, a sized tmpfs | [M] §4 f: `ENOSPC` at 16 MB |
| T10 | escape to the host | it is already on the host | namespaces, no capabilities, seccomp, non-root. **The kernel is shared** | [U]: no escape was attempted |
| T11 | tamper with other jobs' results or leases | in-process it shares memory with the worker and can patch anything | sees only its own attempt, over its own channel; can lie only about its own result | [I] from the channel design (§5.7) |
| T12 | persist into the next job | globals, `/tmp`, the module cache | a fresh container per attempt by default | [M] isolation §3b |
| T13 | control Docker itself | — | the socket is never mounted, and mounting it is refused | [M] §4 i |
| T14 | read other tenants' jobs | a worker for many queues holds all of them | one container per attempt; Part 1 scopes the executor | [I] |

**What no mechanism here stops**: a job can return a wrong result for its
own attempt, and it can read its own input. Those are the job's to begin
with.

### 5.2 Where the boundary sits

| Boundary | What it isolates | Cost measured here | Verdict |
|---|---|---|---|
| **A. A container per attempt**, pre-started and single-use | each job from the worker, the host and every other job | ~1 ms dispatch with a spare ready; at most **~27 jobs/s** per host (8 spares) | **Default** (I2) |
| **B. A warm container per worker slot**, reused | the jobs from the worker and host, **not from each other** | +0.04 ms per job; 12,215/s sequential | Opt-in, `reuse: "worker"`, for trusted code at volume |
| **C. The whole worker in a container** | the host from the worker, **not the job from the worker's secrets** | none: it is how bun-jobs is deployed today | Documentation only. It needs no code |
| **D. The platform's unit** (a microVM or sandbox per task) | as A, with a hardware or gVisor boundary the platform maintains | a platform start per job | Where Docker cannot run inside (§5.6), and the stronger choice where it can |

A process reused across jobs (B) is the dangerous one to get wrong: the Bun
process inside the container survives from one job to the next, so a
hostile job can patch the runner and read every later job's input. B is for
code the operator trusts, and the docs say so in those words.

### 5.3 A new target kind: `"container"`

```ts
const worker = new BunQueueWorker("thumbnails", "./jobs/processor.ts", {
  target: {
    kind: "container",
    image: "ghcr.io/acme/job-runner@sha256:9f2c…",   // required; a digest is recommended
    processor: "/app/jobs/processor.ts",              // the path inside the image
    limits: { memory: "256m", cpus: 1, pids: 128, tmpfs: "64m" },
    env: { NODE_ENV: "production" },                   // values only; never copied from the host
  },
});
await worker.run();
```

- **One more `WorkerTargetKind`** beside `"in-process"`, `"worker-thread"`,
  `"child-process"` and `"custom"` (`shared/workers.ts:220-225`) [S]. The
  heartbeat record reports `target.kind: "container"` with the image digest
  and the runtime, never the env.
- **It moves only the processor call, like every target.** The worker keeps
  the claim, the lease and the settle. The processor's `job` asks its
  parent over the channel for the same closed list of operations a child
  process may (`workerTarget.ts:1038-1044`) [S].
- **The engine is the Docker CLI through `Bun.spawn`**, or Podman's
  compatible CLI (`engine: { cli: "podman" }`). There is no SDK, so there
  is no new dependency. Talking to the Engine API over its socket with
  `fetch({ unix })` would save a process per container but not the
  container's start (§7.3), and attaching to stdio over the API needs a
  hijacked connection. So: the CLI [D].
- **Inside the image** the command is `bun <entry> <processor>`, where the
  entry is a small runner shipped by bun-jobs
  (`@kingsleyweb/bun-jobs/container-entry`) that speaks the channel of §5.7
  and imports the processor. The image is the user's (`FROM oven/bun`, the
  app and its dependencies installed). The docs say to pin by digest.
  `oven/bun:1.4.3` did not exist on 2026-09-29 (`oven/bun:1` was 1.4.2)
  [M isolation, "Host"].
- **A container per attempt, from a pool of spares** (I2). The worker keeps
  `spares` containers started and waiting on stdin (default
  `min(concurrency, 2)`). An attempt takes one, and a replacement starts at
  once. After the attempt the container exits and is removed.
  `reuse: "worker"` keeps one container per concurrency slot instead.
- **Cancellation and timeouts.** An abort (a timeout, a lost lock, a close)
  sends `cancel` on the channel. After `closeTimeout` the worker runs
  `docker kill`, then `docker rm -f`, by the container's name.
- **Orphans.** Every container carries labels `bun-jobs.worker-key` and
  `bun-jobs.worker-id`. A worker starting up removes the containers labelled
  with its key whose worker id is not live (`listWorkers`). A crash
  therefore leaks no container past the next start [D].
- **Also inside an executor** (Part 1): `createRemoteExecutor({ target })`
  takes the same target, so a remote runs each handler in a container
  (PR-i4, after 2a).

### 5.4 The mechanisms, compared

| Mechanism | Boundary | Per-job cost here | Where available | Root needed |
|---|---|---|---|---|
| Docker (runc), hardened | namespaces, seccomp, no capabilities, cgroups. **Shared kernel** | cold 277 ms; spare ~1 ms; warm +0.04 ms; `exec` 165 ms [M] | any host running `dockerd` (§5.6) | the daemon is root, and **the `docker` group is root-equivalent** [V, Docker docs, in isolation §1] |
| Rootless Docker, Podman | as Docker, plus a user namespace: container root is not host root | [U]: not installed | hosts allowing unprivileged userns | no |
| gVisor (`runsc`) | a user-space kernel between the job and the host's syscalls | [U]: not installed | Linux hosts; GKE Sandbox; Cloud Run gen1 [V platform §6–§8] | to install |
| Kata, Firecracker | a hardware VM per container or job | [U]: not installed | needs `/dev/kvm`: `.metal` or nested-virt instances [V platform §4–§5] | yes |
| bubblewrap + a systemd scope | namespaces and cgroups; **no seccomp by default**; its tmpfs can exec | 9.9 ms, or 56 ms with the scope [M] | Linux with unprivileged userns (Ubuntu allows `bwrap` by AppArmor profile) | no |
| `Bun.spawn({ cgroup, uid, gid, timeout })` | resource limits only; no filesystem or network isolation | ~3.8 ms spawn [M] | a delegated cgroup v2 subtree | no, with `Delegate=yes` |
| Landlock, seccomp on their own | filesystem or syscall filters | [U] | kernel support (Landlock ABI 8 here) [M] | no, but Bun has no API for either [I] |
| `Worker` `resourceLimits` | **none: accepted and ignored** | — | — | — |

Four measured facts shape the table:

- **Hardening is free; the network is not.** The hardening flags added
  nothing measurable to a cold start. The default bridge network added
  ~160 ms (437 ms against 273 ms with `--network none`) [M isolation §2].
- **`resourceLimits` is not a limit.** A worker with
  `maxOldGenerationSizeMb: 64` grew its process to ~1,040 MB with no error,
  as a Web `Worker` and through `worker_threads`. Under a cgroup cap the
  kernel killed the whole process, main thread included [M isolation §6].
  bun-types comments the option out [V]. **A `worker-thread` target is
  neither a security nor a resource boundary**, and the docs must say so.
- **`Bun.spawn({ cgroup })` gives per-job memory and pids limits with no
  root and no Docker**, inside a `Delegate=yes` scope: the memory hog was
  OOM-killed alone, and the fork bomb was capped [M isolation §6]. That makes
  a cheap hardening of the existing `child-process` target possible (PR-i0).
- **On snap Docker, `no-new-privileges` breaks every container.** runc runs
  under the snap's AppArmor profile, and NNP forbids its transition to
  `docker-default`. It works only with `apparmor=snap.docker.dockerd`,
  which is a broader profile [M isolation §1]. This is why the target runs
  a **probe container with the exact flags at start**, and fails with the
  engine's own message rather than degrading (§5.6).

### 5.5 The combination with Part 1

With both parts, a job on remote compute runs in a container that has:

- no network;
- no environment but its allowlist;
- a read-only filesystem that is the image;
- no capabilities, and a non-root user;
- its own attempt's input on stdin.

The executor outside it holds the only credential on the machine: a derived
key for one gateway, scoped to named queues, expiring within the hour. No
database URL exists anywhere on the compute.

| What a hostile job gets | Without either part | With Part 2 only | With Parts 1 and 2 |
|---|---|---|---|
| The database | the worker's URL, in its environment | nothing in the container; the worker process still holds the URL | nothing on the machine at all |
| Other jobs' data | anything the worker claims | nothing | nothing |
| The network | everything the instance reaches | nothing | nothing; the executor reaches one gateway |
| Cloud credentials (metadata, env keys) | yes | no route, no env | no route, no env; the instance needs no DB role |
| Its blast radius on a compromise of the executor | the database | the database | the executor's queues, until the key expires or is revoked |

**The residual attack surface** is the kernel's syscall interface, filtered
by Docker's default seccomp profile, and the channel's message parser in the
executor. Both parts together also make **instance-level egress rules
sufficient** on platforms that cannot nest containers. The platform research
found that egress controls apply to a whole instance, never per job, so a
worker that needs its database cannot share a unit with a job that must not
reach it [V/I platform, "What this means"]. With Part 1 the executor needs
only the gateway, so the instance's whole egress can be one address, and no
cloud role is needed [I].

### 5.6 Platform reality

From [`platform-isolation.md`](evidence/worker-gateway-and-isolation/platform-isolation.md)
(17 platforms, ~110 sources, read 2026-09-29):

| Where the worker runs | Container target inside? | The isolation path to recommend |
|---|---|---|
| EC2, a VM over SSH, ECS on EC2 | **yes** [V/I] | `container`, with `runtime: "runsc"` where gVisor is installed; IMDSv2 with hop limit 1 [V] |
| GKE Standard, Kubernetes with privileged pods | yes, if the admin allows it [V] | better: a `RuntimeClass` of gVisor or Kata per job pod [V] |
| Fly Machines | yes: `dockerd` runs in the VM; no KVM [V] | a Machine per job, or `container` with gVisor `systrap` [V/I] |
| Railway Sandboxes | yes: Docker included; egress open [V] | `container`, with `--network none` |
| Cloudflare Containers | rootless Docker, host networking only [V] | the probe fails on `--network none` [I]; use an instance per job |
| Lambda, Fargate, Cloud Run, ACA, ACI, Render, Railway services | **no**: no privileged, no nested containers [V] | the platform's own per-job unit (D), with Part 1 fencing the egress |

**Fail fast, never degrade** (I5). At `run()` a worker with a `container`
target checks, in order, and throws `IsolationUnavailableError` (a
`ConfigError`) naming the failed step and the engine's stderr:

1. the engine answers (`docker version`);
2. the requested `runtime` is listed (`docker info`);
3. the image is present, or can be pulled under `pull` (default
   `"missing"`);
4. **a probe container with the exact argv runs `true`**. This catches the
   snap NNP failure, a rootless engine that cannot do `--network none`, and
   a seccomp profile that does not load.

There is no fallback to in-process. A summoned worker that fails the check
exits non-zero, so the summon counts as failed and the controller's circuit
sees it. A **gateway can refuse an executor whose `hello` does not declare
the required isolation** (`queues.reports.requireIsolation: "container"`).
That is a declaration, not a proof: it stops a misconfigured remote, not a
compromised one (§6).

**Platform-level isolation as a provider capability** (after 1.5p). A
provider's summon capabilities gain
`isolation: { boundary: "microvm" | "vm" | "gvisor" | "container" | "none", perJob, egress }`,
and a policy may say `requireIsolation: "microvm"`. A provider declaring
less is a `ConfigError` when the policy is constructed [D]. Dispatching each
job to a platform sandbox (Lambda MicroVMs, Cloud Run sandboxes, ACA dynamic
sessions, GKE Agent Sandbox, all new in 2026 [V platform]) is Phase 2's
`execute` facet with an adapter per platform, and belongs in Phase 3 or 4's
adapter list, not here (Q10).

### 5.7 The data path across the container boundary

**The channel is the container's stdin and stdout, as framed JSON lines**
[D]. `docker run -i` passes exactly those. Bun's IPC channel is an inherited
file descriptor that `docker run` does not forward [I]. A Unix socket
bind-mounted into the container would work, but snap Docker cannot read
`/tmp` on this machine [M, which is why the evidence mounts only files under
`$HOME`], and a mount is one more thing to validate.

- **Framing.** Each channel line starts with a per-container random prefix,
  passed on the command line: `<prefix> <json>`. A line without it is the
  job's own stdout, which becomes a job log line. So a stray
  `process.stdout.write` or a subprocess's output cannot corrupt the
  channel. A job could forge channel lines, but only for its own attempt,
  and it could lie about its own result anyway [D].
- **Messages** are the child channel's, unchanged (`runner/protocol.ts`,
  `workerTarget.ts:1038-1044`) [S]: `ready`; the attempt (`job`); progress
  (fire-and-forget); `log`; `heartbeat`; `childrenValues` and
  `childrenFailures` (request and answer); `result` or `fail`. `stderr` is
  captured as log lines, bounded by `maxLogBytes`.
- **Bounds.** Every message is bounded by `stringifyBounded`
  (`shared/json.ts:49`) [S] on the way in, and read with a line-length cap
  on the way out. An oversize result fails the attempt with
  `PayloadTooLargeError`, non-retryable, as WR §5.10 says for the wire.
- **Measured**: a warm container adds ~40–60 µs per round trip over a plain
  child process on this channel, and pipelined jobs reach ~355,000/s either
  way [M isolation §3]. The channel is not the cost; the container start is.

### 5.8 The options, with safe defaults and refusals

```ts
/** A worker target that runs each attempt in a container. */
export interface ContainerTarget {
  /** Marks the variant. */
  kind: "container";
  /** The image to run. Required. A digest (`name@sha256:…`) is recommended; a tag can move under you. */
  image: string;
  /** The processor file's path inside the image. Defaults to the worker's processor path. */
  processor?: string;
  /** When to pull: `"never"`, `"missing"` (default) or `"always"`. */
  pull?: "never" | "missing" | "always";
  /** The engine's CLI and endpoint. Defaults to `{ cli: "docker" }` and the CLI's own `DOCKER_HOST`. */
  engine?: { cli?: "docker" | "podman"; host?: string };
  /** The OCI runtime, e.g. `"runsc"` for gVisor. Verified against `docker info` at start. Defaults to the engine's default. */
  runtime?: string;
  /** `"never"` (default): a fresh container per attempt. `"worker"`: one per concurrency slot, reused. Trusted code only. */
  reuse?: "never" | "worker";
  /** Containers kept started and waiting, for `reuse: "never"`. Defaults to `min(concurrency, 2)`. */
  spares?: number;
  /** Resource limits. Defaults: memory 256m with equal swap, 1 CPU, 128 pids, 64m tmpfs at `/tmp`. */
  limits?: { memory?: string; cpus?: number; pids?: number; tmpfs?: string };
  /** `"none"` (default), or an existing engine network by name. A network is the operator's to fence. */
  network?: "none" | { name: string };
  /** Environment for the job, as literal values. Nothing is ever copied from the worker's environment. */
  env?: Record<string, string>;
  /** Bind mounts. Read-only unless `readOnly: false`. Refused: the engine's socket, `/`, `/proc`, `/sys`, `/dev`, `/etc`, `/var/run`. */
  mounts?: { source: string; target: string; readOnly?: boolean }[];
  /** `uid:gid` to run as. Defaults to `65534:65534`. `0` is refused unless `allowRoot` is set. */
  user?: string;
  /** Allows `user` to be root inside the container. Defaults to `false`. */
  allowRoot?: boolean;
  /** Security options. Defaults: the engine's default seccomp profile, `no-new-privileges`. See the snap note in the docs. */
  security?: { seccomp?: string; apparmor?: string; noNewPrivileges?: boolean };
  /** After a cancel, how long the attempt has to stop before `docker kill`. Defaults to 5000 ms. */
  closeTimeout?: number;
  /** The most bytes of stdout/stderr kept as log lines per attempt. Defaults to 1 MiB. */
  maxLogBytes?: number;
}
```

**Fixed, not options:** `--read-only`, `--cap-drop=ALL`, `--ipc none`, no
`-e NAME` without a value, no `--env-file`. `docker run` inherits no
environment, and those two spellings are the only ways it copies host
values in [M isolation §4 g].

**Refused with a `ConfigError`, with no escape hatch:**

- privileged mode, added capabilities and devices;
- host network, PID, IPC or UTS namespaces;
- a mount of the engine's socket, or of `/`, `/proc`, `/sys`, `/dev`,
  `/etc` or `/var/run`;
- `seccomp=unconfined` and `apparmor=unconfined`.

The target builds the argv itself from typed options, so there is no raw
argument list to smuggle a flag through. Whether to add an `unsafe` escape
hatch later is Q8; the recommendation is no.

**`child-process` gets cheaper hardening** (PR-i0): an `env` policy that
stops passing `...process.env` (`spawn.ts:106-107`) by default, and
optional `uid`/`gid`, `cgroup` and per-attempt `maxBuffer`, all native
`Bun.spawn` options [M isolation §6]. The packages are unpublished, so the
default can change without a deprecation (Q7).

---

## 6. Security model, both parts together

| Boundary | What crosses it | Authenticated by | Worst case if the far side is hostile |
|---|---|---|---|
| host ↔ database | driver calls | the driver's own credentials, **only on hosts** | — |
| gateway ↔ executor | Phase 2 frames | per-frame HMAC under the executor's derived key; TLS or AEAD | a hostile executor sees its queues' job payloads and forges their outcomes; it cannot enqueue, read other queues, touch queue state, or reach the store |
| executor ↔ job container | the stdio channel | none needed: the container is the executor's child | a hostile job forges its own outcome and burns its own limits |
| summoner ↔ provider | the summon request, carrying a one-time code | the provider's platform credential | a hostile provider could redeem the code first: it gets one executor session for one queue, and the real remote then fails to connect, loudly |
| operator ↔ gateway | `mint`, `revoke`, key rotation | host code only; no HTTP route in this plan | — |

**What bun-jobs promises** [D]:

- The database credentials never leave a gateway host.
- An executor can act only on attempts pushed to its own session, and only
  on its credential's queues and names.
- A leaked executor key expires; a leaked bootstrap code is single-use and
  expires within the boot budget.
- A `container` job never receives the worker's environment, the gateway
  key or a network, unless the operator configured one.
- The isolation option fails loudly, before any job runs.

**What it does not promise, stated first in the docs:**

- Containers share the host kernel. A kernel exploit escapes runc. Choose
  gVisor, Kata or a microVM platform for hostile multi-tenant code.
- The `docker` group is root-equivalent, so a worker that drives Docker is
  as privileged as root on that host. Rootless Docker or Podman removes
  that, and is not measured here.
- Executors are trusted with their queues' payloads. Put mutually
  distrusting tenants on different queues, with different credentials.
- `requireIsolation` checks what an executor declares, not what it does.

---

## 7. Measured evidence

Everything below re-runs with one command from
[`evidence/worker-gateway-and-isolation/`](evidence/worker-gateway-and-isolation/README.md).
The machine: an i9-11900H, 16 threads, Linux 7.0.0-31, **Bun
`1.4.3-canary.1+5f554969b`** (the same canary RT measured), shared with peer
sessions at a 1-minute load of 1.5 to 5.4. Everything is loopback.

### 7.1 Gateway throughput and latency

`gateway-bench/run-matrix.sh`, summarised by `bun gateway-bench/summarize.ts`
into `results/gateway-bench.md` (96 runs) [M]. The four modes:

- **direct** is a `BunQueueWorker` with an in-process processor, today's
  summoned worker.
- **ws** is the same worker with a custom target pushing each attempt to an
  executor process that dialled in over WebSocket and granted credits.
- **http** is the same with the executor long-polling.
- **pull-proxy** has no worker on the host: the executor claims and
  completes through a thin HTTP proxy of `claimJobs`/`completeJobs`, holding
  the token itself.

Every frame is HMAC'd with `node:crypto`. §4.10 has the table. The
pull-proxy rows are left out of it on purpose: 118,959/s on memory, 29,751/s
on Redis and 40,862/s on Postgres are faster than a real worker because the
proxy skips events, metrics, attribution and every chore, not because
pulling is faster.

### 7.2 Protocols in Bun 1.4.3

`CERT_DIR=… bun protocol-matrix.ts` → `results/protocol-matrix.txt`, and
`bun h2-check.ts` → `results/h2-check.txt` [M]:

| Protocol | Client | Server | Note |
|---|---|---|---|
| HTTP/1.1 | `fetch` | `Bun.serve` | OK |
| HTTPS, pinned CA | `fetch({ tls: { ca } })` | `Bun.serve({ tls })` | OK |
| HTTP/2 over TLS | `fetch({ protocol: "http2" })` | `Bun.serve({ http2: true, tls })` | OK; 5 concurrent requests on **1** connection (default `fetch`: 5) |
| h2c, prior knowledge | `node:http2` | `Bun.serve({ http2: true })`, **no TLS** | OK; control without `http2` refused. **New**: RT had h2c only via `node:http2` |
| HTTP/3 | `fetch({ protocol: "http3" })` | `Bun.serve({ http3: true, tls })` | OK with `rejectUnauthorized: false`; no per-request CA (RT §6.9 [V-prior]) |
| WebSocket, WSS | `WebSocket` (with `tls.ca`) | `Bun.serve` upgrade | OK |
| TCP, TLS over TCP | `Bun.connect` | `Bun.listen` | OK |
| UDP | `Bun.udpSocket` | `Bun.udpSocket` | OK |

The behaviours that matter beyond "it connects" were measured by RT's 27
spikes on the same build and are not repeated
([`../remote-transports/bun-transports.md`](evidence/remote-transports/bun-transports.md)).

### 7.3 Container start and per-job cost

From [`isolation/RESULTS.md`](evidence/worker-gateway-and-isolation/isolation/RESULTS.md)
§2, §3 and §3b [M]:

| Model | Per job | Jobs/s |
|---|---|---|
| `docker run`, default network | 437 ms | — |
| `docker run`, hardened, `--network none` | 277 ms | — |
| `docker exec` into a running container | 165 ms | — |
| single-use spare, 1 / 2 / 4 / 8 spares | 0.5–1.1 ms dispatch | 7.0 / 13.0 / 19.7 / 26.6 |
| warm container, reused, sequential | 0.068 ms | 12,215 |
| warm container, reused, pipelined | — | ~355,000 |
| bubblewrap per job (with a systemd scope) | 9.9 ms (56 ms) | — |
| plain `Bun.spawn` per job | 3.8 ms | — |

### 7.4 Hardening verified against a hostile job

`isolation/hostile.ts`, run by `docker-hostile.sh` and `bwrap-hostile.sh`,
each probe beside a control without the flag [M]. **Every hardening flag
blocked what it claims**, with two exceptions on this host:

- `no-new-privileges` needs the snap AppArmor profile (§5.4);
- `--storage-opt size` is unsupported on overlay2 over zfs, and a read-only
  root with a sized tmpfs is the cap that works.

The default bridge reached host services on `0.0.0.0` and **the repo's own
Postgres and MongoDB test containers**, which is the case for
`--network none` by default.

### 7.5 What stayed unverified, and why

| Claim | Why unverified | The command a later check would run |
|---|---|---|
| gVisor, Kata, Firecracker behaviour and overhead | not installed; installing system packages was out of bounds | `docker run --runtime=runsc …` with `isolation/cold-start.ts` and `docker-hostile.sh` after `runsc install` |
| Rootless Docker, Podman | not set up | `dockerd-rootless-setuptool.sh install`, then the same scripts with `DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock` |
| NNP on a non-snap Docker | only snap Docker here | `docker run --rm --security-opt no-new-privileges oven/bun:1 true` |
| A kernel escape | out of scope for a laptop | — |
| Real networks: RTT, proxies stripping WebSocket, h2 through LBs | loopback only | RT Appendix B's tier-3 script, plus an `http-poll` run through nginx with `proxy_buffering on` |
| Unprivileged userns on Cloud Run gen2, ACA, Fly, Cloudflare | needs an account | `unshare -Ur true && bwrap --unshare-all --ro-bind / / true` in a deployed container |
| The metadata endpoint from a container on a cloud VM | no cloud VM | `curl -m 2 http://169.254.169.254/` from a bridge container, IMDSv2 hop limit 1 and 2 |
| Adoption's `handOverJobLock` on every driver | design only | a two-host test: resume on host B, then host A's settle must answer `false` |

---

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **2r is built before 2c–2e, against the committed order** | certain, if approved | Q2. 2r needs only 2a's core and 2b's reliability layer. 2d keeps reverse TCP and the SSE session mode |
| **`http-poll` is a new binding** RT did not specify | medium | It is a session binding on RT's core: frames, MAC, sequence and resume are unchanged. Only connect and framing are new |
| **A host crash re-runs in-flight remote attempts**, as a crash of any worker does | certain until adoption | at-least-once is the contract (WR §5.8); graceful drains lose nothing; adoption (Q5) |
| **Gateway hosts need synchronised clocks** for credential expiry | low | a 60 s slack; a `CLOCK_SKEW` close reason; a health warning when hosts' `now` differ by > 30 s |
| **Bootstrap codes are visible on the command line and in platform consoles** | certain | one-time, short-lived, redeemed before user code loads (§4.8) |
| **Driving Docker makes the worker root-equivalent** | certain with rootful Docker | the docs say so; recommend rootless or Podman |
| **Single-use containers cap throughput** at tens of jobs/s per host | certain | measured and documented; `spares` tunes it; `reuse: "worker"` for trusted volume |
| **Engine differences** (snap NNP, rootless without `--network none`, Podman flags) | high | the start-up probe runs the exact argv and fails loudly |
| **Containers share the kernel** | inherent | `runtime` selection; the platform path (D); stated first in the docs |
| **`oven/bun` tags lag Bun releases** | observed | image by digest; the entry checks its protocol version on `ready` |
| **Executors can forge outcomes for their queues** | inherent | scoped keys, short expiry, revocation, a queue per trust domain |
| **The loopback numbers flatter a real link** | certain | RT's Phase 4 real-network run; `http-poll` batching keeps RTT per batch |

---

## 9. Open questions for the user

Each has a recommended answer.

**Decided by the user on 2026-09-29:** every recommended answer below was
accepted, Q2 (the new sub-phase 2r) and Q7 (an allowlist for the job
environment by default) included. Q1 stays open, and the design does not
depend on it. The names in §12 still need approval, PR by PR.

1. **What is "up" in the protocol list?** Candidates are UDP, gRPC, or a
   typo for "etc.". **Recommended:** nothing to decide now. UDP is RT 2e,
   gRPC is a plugin on the session shape (RT T10), and the gateway is
   pluggable, so any of them lands without a core change. Tell us which one
   was meant, and we will say where it sits.
2. **Pull `ws-reverse` forward, into a new sub-phase 2r right after 2b,**
   ahead of 2c (TCP)? This changes the order decided on 2026-09-25 (RT
   Q-T1). **Recommended: yes.** It is the user's pattern and needs only 2a
   and 2b. 2c, the rest of 2d, 2e and 2f keep their order after it.
3. **Ship an interim gateway before 2a**, on a protocol of its own? **No.**
   It would fork the wire protocol that Phase 2 versions, and 2a's core is
   most of the gateway's cost anyway.
4. **Add the `http-poll` binding?** **Yes.** It is the only reversed path
   through HTTP-only egress, and it carries HTTP/2 and HTTP/3 with a
   `fetch` option.
5. **Build attempt adoption** (`handOverJobLock` on five drivers, ~4 d)?
   **Not now.** Graceful drains already lose nothing. Revisit if host crashes
   re-running long remote jobs prove costly. Phase 4 is the natural place.
6. **Summoned executors: default `start: "worker"`**, with `"executor"`
   opt-in? **Yes.** Today's behaviour stays the default.
7. **Stop `child-process` and `worker-thread` targets passing the whole
   `process.env`** by default, in favour of an allowlist? **Yes**, for
   `child-process`, with `env: "inherit"` available. The packages are
   unpublished. For `worker-thread` the docs say plainly that it is not a
   boundary: a thread shares the process.
8. **An `unsafe` escape hatch** for privileged or extra Docker flags? **No**
   in v1. Every request can be read then as a missing typed option.
9. **Build the Docker-free `sandbox` target** (bubblewrap plus a delegated
   cgroup, ~4 d)? **Later, if asked.** It works unprivileged and starts in
   ~10 ms, but it has no seccomp filter by default, cannot make its tmpfs
   `noexec`, and needs unprivileged user namespaces, which several platforms
   block [M/U]. Docker's defaults are stronger.
10. **Per-job platform sandboxes** (Lambda MicroVMs, Cloud Run sandboxes,
    ACA dynamic sessions, GKE Agent Sandbox) as `execute` providers?
    **Yes, but in Phase 3/4's adapter list**, not this plan. They are
    Phase 2's push shape with a platform adapter each.
11. **Default of `reuse` for the `container` target**: `"never"`
    (single-use, ~27 jobs/s per host here) or `"worker"` (warm, thousands
    per second, no job-to-job isolation)? **`"never"`.** The user's emphasis
    is protection. The option is one line, and the docs give both numbers.
12. **Where the gateway lives**: a new entry `./gateway`, or inside `./remote`?
    **`./gateway`.** It is host-side and not browser-safe, whereas
    `./remote` is the executor's browser-safe entry (WR §6.2).

---

## 10. PR slicing and effort

Focused days for someone who wrote the code, as in the other plans. Each PR
passes the full gate alone and leaves the package coherent.

### 10.1 Part 2: isolation (can start after 1.5p)

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-i0** `child-process` hardening | `env` policy (allowlist by default, Q7); `uid`/`gid`; `cgroup`; per-attempt `maxBuffer`; docs: `worker-thread` is not a boundary | Phase 1 | ~1.5 d |
| **PR-i1** the `container` target | `WORKER_TARGET_KINDS` + `"container"`; the CLI engine; the stdio channel and `container-entry`; hardened fixed flags and refusals; the start-up probe and `IsolationUnavailableError`; orphan sweep; tests with a fake engine, plus a real-Docker suite that skips visibly | Phase 1 | ~5 d |
| **PR-i2** the pool | single-use spares (default), `reuse: "worker"`, recycling, pool state on the heartbeat record | PR-i1 | ~3 d |
| **PR-i3** policy details | `network: { name }`, mounts validation, `runtime` check, `security` options, the snap NNP message; hostile-job conformance test (the evidence's `hostile.ts`, as a test that skips without Docker) | PR-i1 | ~1.5 d |
| **PR-i5** platform isolation capability | `isolation` in summon capabilities, `requireIsolation` on the policy, first-party providers declare theirs | 1.5p | ~2 d |
| **PR-i7** docs | threat model, hardening guide, platform table, "what this does not promise" | PR-i2 | ~1.5 d |
| *PR-i6* `sandbox` target | bubblewrap + delegated cgroup (only if Q9 says so) | PR-i1 | *~4 d* |
| | **Total** | | **~14.5 d** (+ ~4 d for PR-i6) |

### 10.2 Part 1: the gateway, sub-phase 2r (after 2b)

**Sliced further on 2026-10-01** with 2a and 2b, and reconciled with the
code at `2973212`, in
[`worker-runtimes.md` §11, "Phase 2 as PRs"](worker-runtimes.md#phase-2-as-prs-2a-2b-and-2r):
PR-g1 splits into PR-g1a (the listener and the claim gate, a claim-loop
change) and PR-g1b (the dialler); PR-g4 also depends on PR-g2, whose router
carries its route; `requireIsolation` lands with whichever of PR-g2 and PR-i5
is second. The table below is the design as written on 2026-09-29.

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-g1** reverse listener | the reversed target, executor registry, capacity-gated claiming, `dialWebSocket`, backoff, `resumeAt`, make-before-break drain. **Moved from 2d** | 2a, 2b | ~4.5 d (of which ~4 d from 2d) |
| **PR-g2** `createWorkerGateway` | the mountable router + socket, many queues per mount, `gateway.info`, `requireIsolation`; `BunJobsGatewayModule` in bun-nest's `./jobs` | PR-g1 | ~3 d |
| **PR-g3** scoped keys | derived executor keys, `mint`, `rekey`, `revoke`, bootstrap redemption by compare-and-set, the no-driver-URL test | PR-g2 | ~3.5 d |
| **PR-g4** `http-poll` | the binding on both sides; h2 and h3 as `fetch` options; tests with a buffering-proxy fake | PR-g1 | ~3.5 d |
| **PR-g5** summoned executors | `gateway` and `bootstrap` summon arguments, `runSummonedExecutor`, `start: "executor"`, release on `hello`, gateway-written claim and exit marks, gateway-driven idle close | PR-g3, 1.5p | ~4 d |
| **PR-g6** docs and bench | `PROTOCOL.md` appendix for `http-poll` and credentials; a `gateway-loopback` bench scenario with a baseline; examples handed to the examples session | PR-g5 | ~2 d |
| **PR-i4** executor `target` | `createRemoteExecutor({ target })`, so handlers run in the `container` target | PR-i1, 2a | ~1.5 d |
| | **Total** | | **~22 d**, of which ~4 d moves out of 2d: **~18 d net** |

Deferred: **PR-g7** adoption, `handOverJobLock` on five drivers and the
two-host test, ~4 d (Q5).

**Other owners.** The examples session: a gateway example per binding, a
summoned-executor example, a hostile-job demo against the `container`
target (~3 d). The UI session: executor sessions and their isolation on the
Workers page, and the `container` target badge (~1.5 d). Both are told
before the PRs that change what they read.

---

## 11. Where it slots in the phase order

Restated as of `2973212` (2026-10-01: 1.5p merged, PR-i0 in progress) in
[`worker-runtimes.md` §11, "Phase 2 as PRs"](worker-runtimes.md#phase-2-as-prs-2a-2b-and-2r).

As of `8d3df4d`: Phases 0 and 1 are merged, 1.5a and 1.5b are merged, and
1.5p is being implemented (SC §13.10).

| Order | Phase | Change from today's plan |
|---|---|---|
| 1 | 1.5p (in progress) | none |
| 2 | **Part 2: PR-i0, PR-i1–i3, PR-i7**, beside 1.5c–1.5e | **new**, and independent of them: it touches `workerTarget.ts` and the runner's executors, not the providers |
| 3 | **PR-i5** with 1.5c | new: the first-party providers declare their isolation as they land |
| 4 | 1.5f, 1.5g, 1.5s | none |
| 5 | 2a, 2b | none (PR-i4 lands after 2a) |
| 6 | **2r: PR-g1–g6** | **new; moves ~4 d out of 2d** (Q2) |
| 7 | 2c, 2d (reverse TCP, SSE session mode), 2e, 2f | 2d shrinks by ~4 d |
| 8 | Phase 3 | gains the per-job platform-sandbox adapters (Q10) |
| 9 | Phase 4 | gains adoption, if Q5 says so, and `gateway-loopback` on a real network |

**Totals.** Part 2 adds ~14.5 d (+4 d optional). Part 1 adds ~18 d net. The
bun-jobs session's total rises from ~169.5 d (WR §11) to **~202 d**. The
first protection reaches users right after 1.5p, **without waiting on any
part of Phase 2**.

---

## 12. Names needing approval

Every new public name, for the user's approval. Nothing here is built.

| Name | Kind | Where | Why this name |
|---|---|---|---|
| `createWorkerGateway` | function | `./gateway` (new entry) | mirrors `createJobsApi`; "gateway" is Phase 2's word for the host side |
| `WorkerGateway`, `WorkerGatewayOptions` | types | `./gateway` | its return value and options |
| `gateway.mint`, `gateway.revoke`, `gateway.attach` | methods | `WorkerGateway` | `attach` as the API socket's `attach` |
| `BunJobsGatewayModule` | Nest module | bun-nest `./jobs` | as `BunJobsApiModule` |
| `http-poll` | binding id | `PROTOCOL.md`, `RemoteTransportCapabilities.binding` | RT's naming style (`ws-reverse`) |
| `dialHttp` | function | `./remote/serve` | beside RT's `dialWebSocket` and `dialTcp` |
| `poll`, `rekey`, `rekeyed` | message types | `PROTOCOL.md` | added to RT's twenty |
| `runSummonedExecutor` | function | `./remote/serve` | beside `runSummoned` |
| `--bun-jobs-summon-gateway`, `--bun-jobs-summon-bootstrap` | summon arguments (`SUMMON_ARGS.gateway`, `.bootstrap`) | `summon/args.ts` | the existing prefix |
| `start: "worker" \| "executor"` | policy field | `SummonPolicy` | what the summoned compute starts |
| `requireIsolation` | option | `SummonPolicy`, gateway queue options | one name in both places |
| `isolation` | capability | summon capabilities (1.5p) | beside `dedupe`, `passes` |
| `"container"` | target kind | `WORKER_TARGET_KINDS`, `WorkerTargetKind` | what it is |
| `ContainerTarget` | type | root and `./queue` | as `ChildProcessTarget` |
| `IsolationUnavailableError` | error class (a `ConfigError`) | root | says what failed |
| `@kingsleyweb/bun-jobs/container-entry` | package entry | `exports` | the runner inside the image |
| `handOverJobLock` | optional driver method | `QueueDriver` | **only if Q5 is yes** |
| `abandonAfterMs`, `orphanTimeoutMs`, `pollHoldMs`, `rekeyLeadMs` | options | executor and gateway | timing names in RT's style |

---

## Appendix: evidence

[`evidence/worker-gateway-and-isolation/`](evidence/worker-gateway-and-isolation/README.md)
holds every script, raw output and summary cited above, with the command
that re-runs each. The spikes are not part of any published package and are
not typechecked or linted by the repo's tooling, like the other evidence
folders.
