# Where a `BunQueueWorker` can run

Research and implementation plan for making `BunQueueWorker` in
`@kingsleyweb/bun-jobs` runnable somewhere other than the process that defines
it — as a configurable execution target, and as a published contract a foreign
system can implement.

Written 2026-09-22 against `develop` (`feat/ui-followups`, `8396815`).
**No code was changed.** Platform facts are marked verified or unverified; see
§3.5 for the provenance of each.

**Updated 2026-09-25** against `develop` at `d54d1fe`, after two decisions by
the user:

- **Both summon-compute and real remote execution will be built.** This plan
  used to recommend choosing one of them.
- **The control planes are renamed first**, in a new Phase 0. `RemoteWorker`
  becomes `WorkerController` and `RemoteRunner` becomes `RunnerController`;
  [`control-plane-rename.md`](control-plane-rename.md) has the detail. That
  frees the names `RemoteWorker` and `RemoteRunner` for Phase 2.

The phase plan in §11 now has Phases 0, 1, 1r, 1.5, 2, 3 and 4. Summon-compute has
its own plan, [`summon-compute.md`](summon-compute.md).

**Updated again 2026-09-25: a plugin system for compute providers.** At the
user's request, third-party compute providers can publish plugins for both
summoning and remote execution. The design is
[`compute-provider-plugins.md`](compute-provider-plugins.md). For this plan it
adds an **`execute` facet** (the host-side transport a `RemoteWorker` or
`RemoteRunner` uses) and a **runtime-adapter kit** (how the platform side is
written), both on the public API that bun-jobs' own adapters must use. §4.6
summarises it; §4.2, §6, §7 and §11 have been updated to match. References below use
the post-rename names, and name the old one where it helps a reader find the
code as it stands today.

**Updated again 2026-09-25: the Phase 1 design check**, against `develop` at
`688d376`, after Phase 0 merged (`a29b06e`). §4.2–§4.5 and the Phase 1 section
of §11 are rewritten to be implementation-ready under four decisions by the
user:

- the local targets are `"in-process"`, `"worker-thread"` and `"child-process"`;
- `isolation` is replaced, not aliased, because the packages are unpublished.
  The draft's premise that it had to be kept "because it is shipped" was
  false;
- runners keep `"spawn"`/`"worker"` for now. Their spellings are a new,
  migration-bearing Phase 1r;
- `{ endpoint }` is Phase 2.

The names were approved by the user on 2026-09-25; §4.2.7 records each
choice and its reason.

**Phase 1 is implemented, awaiting merge** (2026-09-25, on
`feat/bun-jobs-worker-target`). §4.2–§4.5 were reconciled with the code: they
describe what was built, every citation points into the implementation (or is
pinned to `688d376` where it describes the code before), and the Phase 1
section of §11 records the gate as measured.

**Updated again 2026-09-25: multiple transports.** At the user's request,
Phase 2 carries remote attempts over HTTP request/response, HTTP with a
streamed response, SSE, WebSocket (forward and reversed), TCP (with TLS and
Unix sockets), UDP and HTTP/2, with health checks, progress and heartbeats on
every one, and lets a provider plugin add gRPC, QUIC or a message broker. The
design is [`remote-transports.md`](remote-transports.md), resting on the
evidence in [`evidence/remote-transports/`](evidence/remote-transports/README.md).
It separates one message protocol from the bindings that carry it; §5 here is
now the HTTP binding plus what every binding shares. §4.2.8, §4.6, §5, §6,
§7, §8.1, §10 and §11 were updated to match. Two decisions by the user, the
same day: **Phase 2 is all of sub-phases 2a–2f, committed, in that order**
(~77.5 d; `remote-transports.md` Q-T1), and **a target `timeout` is no longer
bounded by `lockDuration`**, because the lease is renewed for the whole remote
call; the draft's `ConfigError` for it is removed (§4.2.8,
`remote-transports.md` Q-T12).

### Contents

1. [Executive summary](#1-executive-summary)
2. [What exists today](#2-what-exists-today)
3. [Taxonomy: two orthogonal axes](#3-taxonomy-two-orthogonal-axes) — including
   [the platform comparison](#35-the-platform-comparison),
   [Cloudflare](#36-cloudflare-in-detail--the-platform-that-decides-the-design),
   [AWS Lambda](#37-aws-lambda-in-detail--the-freeze-and-the-2026-exception) and
   [prior art](#38-how-comparable-systems-solve-this)
4. [Execution-target API design](#4-execution-target-api-design) — including
   [provider plugins](#46-provider-plugins-the-execute-facet)
5. [The remote-worker contract](#5-the-remote-worker-contract)
6. [First-party adapter utilities](#6-first-party-adapter-utilities)
7. [Conformance test kit](#7-conformance-test-kit)
8. [Observability and the management UI](#8-observability-and-the-management-ui)
9. [Performance](#9-performance)
10. [Bottlenecks, risks and open questions](#10-bottlenecks-risks-and-open-questions)
11. [Phased delivery](#11-phased-delivery)

**A note on provenance.** Every claim about this repository was read from the
source on 2026-09-22 and names the file it came from. Every platform limit was
fetched from the vendor's own documentation the same day, and where a vendor
publishes no figure the document says **undocumented** rather than guessing —
several do, and that is itself a finding. **Every comparable system in §3.8 was read from a
primary source** — spec documents, protobuf definitions, Lua scripts, SQL
migrations, fetch implementations and in-flight pull requests, at a pinned
version named in each row. Where a specific figure inside a row could not be
closed (a closed-source key format, a docs page that is now a deprecation
stub) the row says so in place. Nothing here was measured;
the performance figures in §9 are predictions, and §9.3 says how to measure
them.

---

## 1. Executive summary

### The one-paragraph version

Half of this is already built and is not called what the ask calls it.
`isolation: "worker" | "spawn"` already runs a job's processor in a `Worker`
or a child process through the runner's executors, and the control plane
(`WorkerController`, `lib/queue/WorkerController.ts`, since Phase 0) already
controls workers in other processes. What does not exist is a *data*
plane: any way for a job to reach code that does not hold the driver
connection. That is the whole of the new work, and it resolves into one
option (`target: { endpoint }`), one wire specification, and a set of adapters
that are mostly type declarations.

### The nine decisions everything hangs on

| # | Decision | Why |
|---|---|---|
| 1 | **Keep two axes apart: *where the attempt runs* and *who owns the claim*.** | They have different failure modes and different phases. Conflating them is how this design goes wrong. §3 |
| 2 | **The remote never claims. bun-jobs claims and pushes.** | No edge runtime can reach a built-in driver, and no frozen FaaS can hold a lease. Verified: Cloudflare gives six simultaneous outbound connections per isolate and timers "only inside the Request Context". §3.5 |
| 3 | **The gateway keeps the lease for the whole round trip, and this needs no new code.** | `#heartbeat()` already runs on an interval for every in-flight job. In push mode the job is in flight for the duration of the HTTP call, so the process holding the lease is by construction the one that is awake. §5.9 |
| 4 | **The new target is a `WorkerTargetExecutor`: one `run(attempt)` returning a promise, cancelled through the attempt's signal.** It is not the runner's `Executor`, not the existing executors, and not the existing IPC protocol. *(Revised 2026-09-25 by the Phase 1 design check; the draft said "an `Executor`". The name is pending, N5.)* | `Executor.mode` is the closed, persisted `ExecutionMode` and `ExecutorStartOptions.file` is required, so a custom target cannot be one without fabricating a runner's context (§4.2.6). `ParentToChild`/`ChildToParent` is a stateful duplex channel with a `ready` handshake, and stretching it over HTTP would force every implementer to re-model framing a request/response transport already has. §2.4 |
| 5 | **The contract is its own surface, not an extension of `createJobsApi`.** | Opposite direction, incompatible auth model (cookies+CSRF+48 admin actions vs a shared secret), and `lib/api/` cannot load in a V8 isolate. It *reuses* `api/schema`, `ProblemDto` and the OpenAPI emitter. §5.1 |
| 6 | **Signing is Stripe/Inngest-shaped: HMAC-SHA256 over `t + "." + rawBody`, 300 s replay window, responses signed too.** | It is the scheme implementers already know, and response signing is what stops a DNS hijack marking jobs complete. §5.6 |
| 7 | **Adapters ship as `./adapters/*` subpaths with zero cloud dependencies** — the platform types are declared structurally and checked against the real SDK types in a devDependency type-test. | `CLAUDE.md`'s dependency rule, satisfied by not needing an exception. Every new entry is `"browser": true` in `consumer-check.json`, and `checkPeerScopes` has nothing to check. §6.2-6.3 |
| 8 | **Summon-compute is built as Phase 1.5, and real remote execution as Phase 2. Both are committed** (the user's decision, 2026-09-25). | Temporal shipped serverless workers on 2026-07-17 by making the *scheduler* able to invoke compute, while the worker contract stayed exactly what it was. The bun-jobs analogue: notice demand with no live worker, start compute that runs an ordinary `BunQueueWorker`, let it drain and exit. It works on every host in §3.5 that can hold its own lease. Phase 2 covers the hosts that cannot. §3.8.1, [`summon-compute.md`](summon-compute.md) |
| 9 | **Phase 0 renames the control planes; Phase 1 is the `target` option, local only.** Each ships on its own. | The rename frees `RemoteWorker`/`RemoteRunner` for the Phase 2 feature ([`control-plane-rename.md`](control-plane-rename.md)). Phase 1 replaces `isolation` with `target` (unpublished, so no alias) and carries no protocol and no security surface. Runner spellings follow in Phase 1r. §11 |
| 10 | **Third-party compute providers plug in through one versioned API with facets**: `summon` (Phase 1.5) and `execute` (Phase 2), plus a runtime-adapter kit for the platform side (Phase 3). bun-jobs' own adapters use only that API. | A real provider offers both summoning and remote execution from one account and one credential; the platform side runs elsewhere and is governed by the wire protocol. [`compute-provider-plugins.md`](compute-provider-plugins.md) §4, §4.6 below |

### One finding worth putting in the README, not just the plan

Across fourteen systems read from source, **almost nobody ships a short,
renewed lease.** Graphile Worker resets stale locks after **4 hours** with no
heartbeat at all. River's `state='running'` never expires and its Rescuer
defaults to **1 hour** — River Pro sells "active job rescue" as the fix. Oban's
Lifeline sweeps at **60 minutes**. Sidekiq Pro's own wiki says super_fetch
*"might recover jobs in 5 minutes or 3 hours, there's no guarantee"*, and OSS
Sidekiq has no lease whatsoever — `acknowledge` is literally a no-op. Cloud
Tasks and Quirrel have no lease. `bullmq-proxy`'s remote worker cannot extend
anything and gets a **3-second** default.

Only four do it properly: BullMQ (30 s lock, renewed at 15 s, compare-and-set
on the token), Temporal (the heartbeat *is* the renewal), Hatchet (an explicit
`RefreshTimeout` RPC) and Inngest Connect (a server-dictated extend interval
that rotates the lease id).

**bun-jobs is already in the second group** — 30 s `lockDuration`, renewed at
`lockDuration / 3`, every settle conditional on the lock token so a stale
worker's `completeJob` returns `false`. That is a genuine differentiator and
it is currently undersold. One adjacent improvement is in §5.8
(Trigger.dev's snapshot-id fencing); §3.8.2 records a second that was
**investigated and rejected**, with the measurements that killed it.

### The two things to be honest about up front

**There is no such thing as "running the worker loop on Cloudflare".** A
worker loop needs a driver, a driver needs a socket the whole time, and an
isolate gets six connections opened inside a handler with no timers between
invocations. Push mode is not a preference; it is the only thing that works.
The counterpart is that push costs one network round trip per attempt and
lands throughput in the hundreds/s, against 40,000+/s for a local Redis
worker — so the targets are for jobs whose work dominates, and for code that
can only live on that platform. §9.

**If what you actually want is "run the worker somewhere else", the answer
today is a container, and it costs no code.** Verified 2026-09-22: Cloudflare
Containers went GA on 2026-04-13 and runs an arbitrary linux/amd64 image;
**Cloud Run worker pools** are GA and are documented for *precisely* this
workload — Google's own examples are Kafka consumers, Pub/Sub pull subscribers
and **Redis task queues** — and are the only Cloud Run shape with Direct VPC
ingress; Azure Container Apps jobs run any container too. `bun-jobs` runs on
all three **unchanged**, with a real driver, a real lease and a real loop. So
does Fly, so does a VM. The protocol work in §5 is for the case where that is
not available — an edge isolate, a per-invocation FaaS, or a team that only
has one of those. Making that container start *only when there is work* is
Phase 1.5, summon-compute ([`summon-compute.md`](summon-compute.md)).

One more piece of luck worth knowing before choosing where to validate:
**Vercel now supports Bun as a first-class function runtime (public beta)**,
with an 1800 s extended duration tier. A Vercel function is still not a worker
— it is suspended between invocations and `waitUntil` shares the function's
timeout — but it is a place a *remote executor* can run with no transpilation
at all, which makes it the cheapest adapter to prove the contract against.
## 2. What exists today

A candid inventory. Line numbers are from `develop` at the time of writing.

### 2.1 `BunQueueWorker` — the loop, and every place it is in-process

`packages/bun-jobs/lib/queue/BunQueueWorker.ts`, 4,251 lines. The lifecycle,
method by method:

| Step | Method | What it does |
|---|---|---|
| start | `run()` / `start()` | sets phase, arms maintenance, reports, control subscription, holds the process open (`#holdProcess`) |
| loop | `#loop()` → `#iterate()` | until `#closing`: check stopped/paused/queue-paused, claim, wait |
| claim | `#claimUpToConcurrency()` | reserves capacity from `QueueLimiter`, then `claimJobBatch(driver, ref, { workerId, worker, token, lockMs, now, excludeNames }, grant)` |
| run | `#process(record)` | builds a `Job` bound to the driver, an `AbortController`, a `setInterval` heartbeat at `heartbeatInterval`, a `ProcessorContext`, then calls the processor (or `IsolatedProcessor.run`) under `withTimeout` |
| renew | `#heartbeat(record, controller)` | `driver.extendJobLock(ref, id, token, lockDuration, now)`; `false` → emit `lockLost`, `controller.abort()` |
| settle | `#settle()` → `CompletionBatcher` | **not awaited** — deliberately off the critical path; `close()` waits via `#settling` |
| fail | `#recordFailure()` | backoff, `driver.failJob(...)`, dead-letter, flow bury |
| report | `#report()` every `reportInterval` (10 s) | `registerWorkerRecord` — the heartbeat *record* the Workers page reads |
| control | `#adoptControl()` / `#subscribeControl()` | reads `__win:wctl:<id>` / `__win:wcfg:<key>` queue-state entries |
| maintenance | `#armMaintenance()` | promote delayed, recover stalled, prune expired, heal flows |

**Every in-process assumption, named:**

1. **`this.driver` is a live object.** `claimJobBatch`, `extendJobLock`,
   `completeJob`/`completeJobs`, `failJob`, `addJobLog`, `getQueueState`,
   `publish`, `subscribe` are all called directly. There is no indirection
   between the loop and the driver — no transport seam at all.
2. **The processor is a closure.** `#processor!(job, context)` where
   `JobProcessor<TData, TResult>` is a function value held in a field. A
   closure cannot be serialised; this is the single hardest constraint on
   "run it elsewhere".
3. **`Job` holds the driver.** `packages/bun-jobs/lib/queue/Job.ts`: 21
   readonly fields plus `updateProgress`, `extendLock`, `log`, `getLogs`,
   `retry`, `promote`, `fail`, `update`, `getChildrenValues`,
   `getChildrenFailures`, `refresh`. Everything but the fields needs a driver.
4. **Timers.** `setInterval` for the per-job heartbeat, `setInterval` for
   reports and maintenance, `Pulse`/`waitForAny` for the idle wait. All assume
   a process that stays awake between ticks.
5. **`AbortController` identity.** `#aborts`, `#heartbeats` are `Map`s keyed by
   job id holding live objects. Cancellation is a local method call.
6. **`#active: Map<string, Promise<void>>`.** Concurrency is "how many promises
   are pending in this heap".
7. **The lock token.** `#token = newToken()` once per worker incarnation. Every
   settle is conditional on it. It is process-scoped by construction.
8. **`close()`** drains `#active`, `#settling`, `#publishing` — all local
   promise sets.

### 2.2 `WorkerController` is a control plane, not a remote worker

This was the most important finding for the ask, and it was a naming
collision. Before Phase 0 the class lived in
`packages/bun-jobs/lib/queue/RemoteWorker.ts` under the name `RemoteWorker`;
Phase 0 renamed it `WorkerController` (`lib/queue/WorkerController.ts`). It is
a **control plane for workers
wherever they run**: `pause`, `resume`, `stop`, `start`, `setConfig`,
`resetConfig`, `list`, `get`, `listConfigs`, `getConfig`. It writes
queue-state entries (`workerControl.ts`) that a `BunQueueWorker` in any
process reads and applies. It never runs a job, never claims, never carries a
payload. `RunnerController` (`lib/runner/RunnerController.ts`, named `RemoteRunner` before Phase 0) is its twin for runners.

So: **the control plane for non-local workers is done.** What does not exist
is a *data* plane — anything that moves a job to a process that is not holding
the driver.

Naming consequence, now settled: Phase 0 renames the control planes
([`control-plane-rename.md`](control-plane-rename.md)), and after it,
**`RemoteWorker` and `RemoteRunner` mean a worker or runner that executes on
another machine or platform**. That is the Phase 2 feature. Inside it this plan
still uses **worker gateway** for the bun-jobs half of the push contract and
**remote executor** for the foreign half. `RemoteWorker` is the user-facing
name of a worker whose gateway pushes to a remote executor (§11, Phase 2).
After Phase 0, "remote" in an identifier means **executes elsewhere**. "Lives
in another process" is **non-local**.

### 2.3 `IsolatedProcessor` — off-thread execution already ships

`packages/bun-jobs/lib/queue/isolation.ts` + the `isolation` /
`isolationOptions` options on `BunQueueWorkerOptions` (types.ts:1071-1089).
A worker constructed with a **file** instead of a function runs each attempt
through `runner/executors`:

- `IsolationMode = "in-process" | "spawn" | "worker"` — the same three words as
  `ExecutionMode` in `drivers/driver.ts:160`, used by `BunRunner`.
- `SpawnExecutor` / `WorkerExecutor` are shared verbatim with the runner
  (`ExecutorStartOptions.kind: "run" | "job"`, `.job: JobRecord`).
- The child gets a **structural `IsolatedJob`** (`executors/executor.ts`:
  `Pick<Job, keyof Job>`), reconstructed in
  `runner/bootstrap/child-runtime.ts`.
- The child talks back over `JOB_CHANNEL` (`runner/protocol.ts`), four
  operations: `log`, `heartbeat` (with optional `ms`), `childrenValues`,
  `childrenFailures`. Replies are `{ value }` or `{ error }`.
- `defineProcessor<TData, TResult>()` types the file's default export.

**The worker keeps the driver, keeps the claim, keeps the lease.** The child
only executes. **BullMQ's sandboxed processors are the same design, verified
from source** (§3.8): the child receives `job.asJSONSandbox()` — a plain
object, *not* a live `Job` — and every mutating method on it is replaced by an
IPC sender the parent executes. That is a stronger statement than "the child
has no Redis credentials", and it is the one worth making about
`IsolatedProcessor` too: the child holds neither the datastore nor a live
`Job`, only the four `JOB_CHANNEL` verbs. That is already a *push* architecture — over an IPC channel
rather than a network — and it is the exact shape the remote contract should
generalise.

### 2.4 The runner's executor abstraction

`packages/bun-jobs/lib/runner/`:

| File | What it gives |
|---|---|
| `executors/executor.ts` | `Executor { mode, start(opts): ExecutorHandle }`, `ExecutorHandle { done, stop, send }`, `ExecutorEvents { onProgress, onMessage, onLog, onOutput, onOutputEnd?, onConsole?, onPid }`, `RunOutcome`, `toHandler()` |
| `executors/{in-process,spawn,worker}.ts` | the three implementations |
| `protocol.ts` | `PROTOCOL_VERSION = 1`, `CHILD_ENV`, `SerializableContext`, `ParentToChild` (`start`/`message`/`close`), `ChildToParent` (`ready`/`started`/`progress`/`message`/`log`/`output`/`done`/`error`), `JOB_CHANNEL` |
| `bootstrap/{spawn,worker}-entry.ts`, `child-runtime.ts` | the child side |
| `RemoteRunner.ts` (`RunnerController.ts` after Phase 0) | control plane, like `WorkerController` |

**Verdict on reuse: reuse the `Executor` *shape*, do not reuse the
executors, and do not extend `ParentToChild`/`ChildToParent` over the
network.** Reasons, concretely:

- `ExecutorHandle` is exactly the right interface for a target: start a unit of
  work, get `done`, be able to `stop` and `send`. A `RemoteExecutor`
  implementing `Executor` drops into `IsolatedProcessor` with almost no change.
- But `protocol.ts` is a **stateful, ordered, duplex, lossless** channel with a
  `ready` handshake and a shared `runId`. HTTP to a Lambda is none of those.
  Stretching it over the network would mean every conforming implementer has
  to model `ready`/`started`/`done`/`error` framing *and* a request/reply
  `seq` channel on top of a transport that has request/reply built in.
- `SerializableContext` carries `driverConfig` — how a child builds its **own**
  driver. That is the pull model, and it is exactly what a Cloudflare Worker
  cannot do.

So: a new `remote/protocol.ts` with an HTTP-shaped spec; a new
`RemoteExecutor implements Executor` that speaks it; `IsolatedProcessor`
grows a fourth mode. `runner/executors` is untouched.

### 2.5 The drivers — the crux

`lib/drivers/driver.ts` (2,740 lines). `JobsDriver = DriverLifecycle &
RunnerDriver & QueueDriver`. What a claim actually needs:

```
claimJob(q, opts) / claimJobs(q, opts, limit)   atomic move to `active` + stamp
extendJobLock(q, id, token, lockMs, now)        lease renewal
completeJob / completeJobs / failJob / buryJob  settle, conditional on token
waitForJob(q, timeoutMs, signal)                blocking wait where supported
publish / subscribe                             cross-process events
getQueueState / setQueueState / listQueueState  CAS — limits, control, windows
```

`DriverCapabilities` already carries `blockingWait`, `events:
"push"|"poll"|"local"`, `multiProcess`, `multiHost`, `jobAttribution`. There is
no capability for "reachable over HTTP", and no HTTP driver.

Reachability per target is the wall. Verified constraints are in §3.4; the
short version: **every built-in driver needs a raw TCP socket or a
filesystem.** `MemoryDriver` is in-heap. `FileDriver` needs `Bun.file` and a
directory. `RedisDriver` uses `Bun.RedisClient` (`eval`, `xadd`, blocking
`BLMOVE`). `SqlDriver` uses `Bun.sql` including `sql.listen` (LISTEN/NOTIFY).
`MongoDriver` uses the `mongodb` driver (an optional peer). Not one of them
runs on a V8-isolate edge runtime, and `Bun.sql`/`Bun.RedisClient` do not run
on Node at all.

Two rules the driver contract states that matter here and must survive:

- **Namespace everything** — every method takes the namespace.
- **Never read the clock** — times arrive as parameters. A remote executor
  therefore never decides `now`; the gateway does. This is a gift for clock
  skew (§5.11).

### 2.6 The management API

`lib/api/`: `createJobsApi(config): JobsApi` with `router`, `basePath`, `mode`,
`info`, `routes`, `websocket`, `openapi()`, `asyncapi()`, `close()`. 48
authorizable actions (`JOBS_API_ACTIONS`), `authorize` + static
`enabledActions`/`readOnly` + Origin/CSRF (`auth.ts`), a schema builder
(`api/schema/builder.ts`) that both validates and emits OpenAPI, a WS protocol
(`api/ws/protocol.ts`) with `subscribe`/`ack`/`gap`/`heartbeat`, and a
browser-safe contract entry (`api/contract/`, exported as
`@kingsleyweb/bun-jobs/api/contract`, checked with `"browser": true` in
`consumer-check.json`).

`routes/workers.ts` already exposes the control plane over HTTP, queue-scoped,
with `?wait=` acknowledgement polling.

**Verdict: build the worker gateway as its own router, mountable beside
`createJobsApi`, reusing `api/schema`, `api/errors` (`ProblemDto`),
`api/body`, the OpenAPI emitter and the route-definition machinery — but
*not* the admin auth model or the `JOBS_API_ACTIONS` list.** Justification in
§5.1.

### 2.7 `BunJobs`, definitions, notifier

- `BunJobs.ts` fixes namespace + driver, owns `#workers`, assigns worker
  ordinals, creates the worker control-plane manager (`WorkerControllerManager`,
  named `RemoteWorkerManager` before Phase 0) with `locals: () => this.#workers`,
  and holds `JobDefinitions`.
- `queue/definitions.ts`: `JobDefinition { name, handler, options }`,
  `JobDefinitions` map, `names()`, `all()`. **This is the registry a remote
  executor's "what can you run" answer maps onto** — it is already the thing
  that can be asked *what jobs exist*.
- `notifier.ts`: one event stream per namespace, driver-backed.

### 2.8 Tests, bench, playground

- Closest existing tests: `__tests__/worker-isolation.test.ts`,
  `worker-control.test.ts`, `worker-control-store.test.ts`,
  `worker-reporting.test.ts`, `worker-close.test.ts`,
  `runner-modes.test.ts` (asserts the three modes are interchangeable — the
  template for asserting a fourth), `runner-crossprocess.test.ts`,
  `followups-remote-u4.test.ts`.
- `bench/queue.ts` scenarios: `enqueue`, `enqueue-bulk`, `throughput`,
  `roundtrip`, `payload`, `contention`. `baselines/queue.json` records `ours`
  and, per scenario/backend, the leading `rival`.
- `playground/index.ts` (136 lines) runs two services on one adapter and drives
  the Workers page.

### 2.9 How much of the ask is already built

| Part of the ask | State |
|---|---|
| Run the *processor* off-thread / off-process | **Done** — `isolation: "worker" \| "spawn"` |
| Run the *processor* from a file | **Done** — file processor + `defineProcessor` |
| Control a worker from another process | **Done** — `WorkerController` (named `RemoteWorker` before Phase 0), `workerControl.ts`, API routes, UI |
| Run the whole *worker loop* in a separate Bun process from a runner file | **Not built**, but trivially composable today (a `.ts` file that constructs a `BunQueueWorker`, run by `BunRunner`) — needs sugar, not machinery |
| A documented wire contract a non-Bun system implements | **Nothing** |
| Push a claimed job to an HTTP endpoint | **Nothing** |
| Adapters for Cloudflare / Lambda / Cloud Run / Next.js | **Nothing** |
| A driver reachable from an edge runtime | **Nothing** |

Roughly: the *placement* axis is 70% built; the *claim-ownership* axis is 0%
built. The plan is mostly about the second.
## 3. Taxonomy: two orthogonal axes

The ask conflates two questions that must stay apart for the rest of this
document, because the answers have different failure modes, different tests
and different delivery phases.

### 3.1 Axis A — where the *attempt* runs

bun-jobs still owns the driver connection, the claim and the lease. Only the
processor call moves.

| Placement | Boundary | Serialisation | Killable | Ships today |
|---|---|---|---|---|
| in-process | none | none | no (cooperative `AbortSignal` only) | yes |
| thread (`Worker`) | JS realm | structured clone (pre-cloned to JSON shape) | yes, `terminate()` | yes (`isolation: "worker"`) |
| child process | OS process | JSON over IPC | yes, `SIGTERM`→`SIGKILL` | yes (`isolation: "spawn"`) |
| separate Bun process from a runner file | OS process, own worker loop | — (it claims for itself) | yes | composable today, undocumented |
| separate machine | network | JSON over HTTP | **no** — you can ask, not compel | no |

The first three are a spectrum of isolation at constant semantics: a claimed
job is claimed exactly once, the lease is renewed by the process that claimed
it, and a lost lock aborts the attempt. `runner-modes.test.ts` asserts the
three are interchangeable; a fourth row joins that test.

The fourth row is different in kind: it is not "the processor moved", it is
"there is a second worker". It needs no protocol, and should be documentation
and an example, not an option (§4.4).

The fifth row cannot keep the third guarantee. **You cannot kill a remote
attempt.** You can send a cancel and hope. §5.10 says what the contract does
about it.

### 3.2 Axis B — who owns the claim

| | Pull | Push |
|---|---|---|
| Who calls `claimJob` | the remote | bun-jobs |
| Who holds the lock token | the remote | bun-jobs |
| Who renews the lease | the remote | bun-jobs |
| Driver connection needed at the remote | **yes** | no |
| Works on an edge isolate | no | yes |
| Works on a per-invocation-billed FaaS | badly (you pay to poll) | yes |
| Needs the remote to be publicly reachable | no | **yes**, unless the remote dials out |
| Latency per job | one claim round trip | one claim + one invoke round trip |
| Exactly-once under a partition | driver's guarantee, unchanged | needs fencing (§5.8) |
| bun-jobs can enforce queue limits | yes (`QueueLimiter` already cluster-wide) | yes |
| bun-jobs can report the worker | yes (it writes its own heartbeat record) | it is the gateway's worker, not the remote's |

**Push is what the ask actually needs.** Cloudflare Workers and Lambda force
it: neither can hold a raw Postgres or Redis socket usefully, and neither can
hold a 30-second lease across a freeze. §3.4 is the evidence.

**Pull is what a Node worker or a second Bun process wants**, and it is nearly
free: it is `BunQueueWorker` with a driver, in another process. The only new
work for pull is a driver that a non-Bun runtime can implement — which is a
different project (an HTTP driver, §10.1).

### 3.3 The four combinations, and which this plan ships

| | Axis A: local | Axis A: remote |
|---|---|---|
| **Pull** | today's worker; a worker in a second Bun process | a Node/Deno worker over an HTTP driver — **deferred**, §10.1 |
| **Push** | `isolation: "worker"`/`"spawn"` (already: the child is push over IPC) | `target: { endpoint }` + the remote contract — **the centrepiece** |

Push-remote is the one genuinely new quadrant, and it is a strict
generalisation of push-local: `IsolatedProcessor` is the same design with IPC
as the transport.

**A fifth cell sits outside the grid: *summon-compute*.** It is pull-remote
with the scheduling problem solved by invoking the remote rather than by
giving it a protocol — Temporal's 2026 answer, and the cheapest thing on this
page. It needs the summoned process to reach the driver, so it covers exactly
the hosts in §3.5 that can hold their own lease and none of the edge runtimes.
See §3.8.1. It is Phase 1.5, with its own plan in
[`summon-compute.md`](summon-compute.md).

### 3.4 What the platforms force

*(The table in §3.5 is the research. The design consequences:)*

1. **No edge isolate can reach a built-in driver.** Cloudflare's
   `connect()` from `cloudflare:sockets` gives raw TCP, and Hyperdrive gives
   pooled Postgres/MySQL, but `Bun.sql`, `Bun.RedisClient` and the `mongodb`
   driver are not portable to it, and `sql.listen` (LISTEN/NOTIFY) certainly
   is not. Push is therefore mandatory for Cloudflare, not preferred.
2. **A frozen or suspended FaaS cannot hold a lease**, and the failure is
   silent. AWS: a background callback *"resume[s] if Lambda reuses the
   execution environment"* — so the heartbeat fires **out of time**, after an
   invisible gap, while the process believes it is renewing. Cloud Run with
   request-based billing: *"any subsequent request to the same container
   instance resumes any suspended background activity"* — the same failure,
   which means a lease renewer appears to work under load and lapses when
   idle. Azure, on **every** plan: *"Functions doesn't track these background
   threads… site shutdown can occur regardless."* Vercel: *"Promises passed to
   `waitUntil()` will have the same timeout as the function itself."* So the
   lease must be held by whoever is *awake*: in push mode, the gateway — which
   is awake because it is blocked on the HTTP response. This is the single
   cleanest argument for push, and it is why §5.9 recommends what it does.
   **The 2026 exception is AWS Lambda Managed Instances**, documented not to
   freeze, with a 90-minute async timeout — the one FaaS configuration where a
   pull-mode worker is sound.
3. **Per-invocation billing makes polling absurd.** A Lambda polling a queue
   every second costs 86,400 invocations a day to do nothing.
4. **A 15-minute ceiling is a job timeout, not a worker lifetime.** Any target
   with a max execution time bounds `job.opts.timeout`, and the gateway must
   refuse a job whose timeout exceeds the endpoint's advertised
   `maxDurationMs` (§5.4) rather than discover it by timing out.
### 3.5 The platform comparison

All rows verified 2026-09-22 against primary vendor documentation unless the
cell says otherwise. Where a vendor publishes no figure, the cell says
**undocumented** rather than a guess — several do, and that is itself a
finding. AWS pages carry no "last updated" stamp, so AWS citations are
"content as fetched 2026-09-22".

| Platform | Long-lived process? | Outbound raw TCP? | Max execution time | Can hold a lease? | Filesystem | Reach a driver directly? | Push or pull | Runtime |
|---|---|---|---|---|---|---|---|---|
| **Cloudflare Workers** | **No** — isolate; *"Timers are only available inside of the Request Context"* | Yes, `connect()` from `cloudflare:sockets` + `node:net`'s client half (`net.Server` unsupported). **Only 6 simultaneous connections** | CPU 10 ms free / 5 min paid (30 s default). Wall: unlimited for HTTP while the client stays connected; **15 min** for cron, Queue consumers, DO alarms | Only within one invocation; `waitUntil` adds ≤30 s | None writable | Yes over `connect()`; Hyperdrive is **Postgres+MySQL only**, and kills `LISTEN`/`NOTIFY` and advisory locks, 60 s max query | Both | V8 isolate; `nodejs_compat`+`_v2` **on by default** for compat date ≥2026-08-04 |
| **CF Durable Objects** | Nearest CF equivalent; hibernates after 10 s idle **only if no timer is pending**, evicted after 70–140 s | Yes; an open socket pins it alive **≤15 min** and bills GB-s | CPU 30 s default → 5 min (SQLite backend) | **Yes, in practice** — alarm chaining, at-least-once, ≤6 retries, 2 s backoff | SQLite storage, 10 GB/object paid | Yes | Both | Same isolate |
| **CF Containers** (GA 2026-04-13) | **Yes** — real Linux | Yes (egress); no inbound non-HTTP TCP | `sleepAfter` 10 min idle default; SIGTERM then ≤15 min. **Max lifetime undocumented** | **Yes** | Ephemeral 2–20 GB | Yes | Via a Durable Object | Any linux/amd64 image — **Bun runs** |
| **AWS Lambda** (default) | **No** — frozen at quiescence | Yes via VPC Hyperplane ENI | **900 s** | **No** — `setInterval` is suspended and *"resume[s] if Lambda reuses the execution environment"* | `/tmp` 512 MB–10,240 MB; EFS; S3 Files | Yes (RDS Proxy advised — and it **pins** on `LISTEN` and session advisory locks) | Push (ESM pollers, or HTTP) | `nodejs22/24.x` GA, `26.x` preview, `provided.al2023`. **Bun only via custom runtime or container** |
| **AWS Lambda Managed Instances** | **Yes** — *"remains continuously active… without freezing between invocations"* | Yes | **5,400 s (90 min)** async + ESM (sync still 900 s), announced 2026-09-09 | **Yes** — the only Lambda type where a heartbeat keeps ticking | Same | Yes | Same | Same; handler code must be thread-safe across runtime workers |
| **Cloud Run service** | Only with instance-based billing **and** min-instances — and still *"never stay idle for more than 15 minutes"*; 10 s SIGTERM | Yes, Direct VPC egress | **60 min** request timeout | Request-based billing: **no**, and *"any subsequent request to the same container instance resumes any suspended background activity"* | In-memory FS + GCS FUSE / NFS mounts | Yes (Cloud SQL: **100 connections per instance**) | Push | Any container — **Bun runs** |
| **Cloud Run jobs** | Yes, batch-shaped | Yes (connections may break past 1 h during maintenance) | Task **10 min default, up to 168 h (7 days)**; no execution-level timeout | **Yes** for the task's life | In-memory + volume mounts | Yes | No HTTP endpoint — started via the Admin API | Any container — Bun runs |
| **Cloud Run worker pools** (GA) | **Yes — purpose-built for pull-based queue workers** (Google's own examples: Kafka consumers, Pub/Sub pull, **Redis task queues**) | Yes; the only shape with Direct VPC **ingress** | n/a — long-running | **Yes** (strongly implied — *"all the instances that you requested are billed as active… even if they happen to be idle"* — but *"CPU is always allocated"* is never stated in those words) | Volume mounts | Yes | **Pull**; no URL | Any container — Bun runs. 8 vCPU / 32 GiB. **Manual scaling only** |
| **Cloud Run functions** (gen2) | No | Yes | **60 min HTTP / 1800 s scheduled / 540 s event-driven** | No | In-memory | Yes | Push | `nodejs26` preview / 24 / 22 / 20 (**20 decommissioned 2026-10-30**); no Bun |
| **Azure Functions** | Dedicated+Always On is closest; Premium has a **60-minute idle kill** | Yes with VNet integration (Flex/Premium/Dedicated); **not on Consumption**; port 25 blocked | Flex/Premium/Dedicated "unbounded"; Consumption 5/10 min. **But HTTP responses are capped at 230 s by the Azure Load Balancer regardless** | **No, on every plan** — *"Functions doesn't track these background threads… site shutdown can occur regardless of background thread status"*. Use a Durable eternal orchestration | Flex temp 0.8 GB, Premium 11–61 GB; Azure Files SMB only | Yes | Triggers are a polled in-host listener + an out-of-process scale controller | Node 22 & 24 **only**; Bun via a custom handler (unverified) or a Linux container on Premium/Dedicated/ACA |
| **Azure Container Apps jobs** | Yes, per replica | Yes (VNet) | `replicaTimeout` — examples use 1800 s, **maximum undocumented** | Yes for the replica's life; maintenance can interrupt | Container FS + ACA mounts | Yes | **No ingress** — CLI/ARM/KEDA scale rule | Any container — **Bun runs unmodified** |
| **Vercel Functions** | **No** — Fluid warms instances and **suspends** them | Node runtime **yes** (`net`/`tls`; port 25 blocked, 465/587 open); Edge no | Hobby 300 s; Pro/Enterprise **800 s GA, 1800 s beta** | **No** — *"Promises passed to `waitUntil()` will have the same timeout as the function itself. If the function times out, the promises will be cancelled."* Use `getDeadline()` | Read-only + `/tmp` 500 MB; functions **archived after 2 weeks** idle | Node runtime yes — but **1,024 file descriptors shared across all concurrent executions on an instance** | Push (HTTP); **Vercel Queues** (public beta) incl. a **poll mode with `ExtendLease`**; Cron | Node 20/22/24; **Bun is a first-class runtime (public beta)** — but not in the optimized-concurrency list |
| **Netlify Functions** | No | **Undocumented** (Lambda underneath; the docs never say `net`/`tls`) | Sync **60 s**, scheduled **30 s**, background **15 min** — none configurable | No (Edge `waitUntil` exists but is inside a **50 ms CPU** budget) | `/tmp` **undocumented** | Probably, unverified | Push; **Async Workloads** extension (FIFO, priorities, DLQ, 4 retries) | Node (fallback 24, set via `AWS_LAMBDA_JS_RUNTIME`); Edge = Deno; **no Bun** |
| **Deno Deploy** (new; GA 2026-02-03, **Classic shut down 2026-07-20**) | **Yes — a real process** under `--allow-all`; but stopped when idle and **evictable mid-request with 5 s grace** | Effectively yes (never stated by name; external Postgres by host/port/SSL is documented) | **No published max request duration or CPU cap** | Only while traffic or an active WebSocket keeps it alive | **Full read/write** (limits undocumented) | Yes | Push (HTTP) + `Deno.cron`. **Deno Queues removed — the migration guide tells you to bring your own** | Deno 2.5.0, FFI, subprocesses; **no Bun** |
| **Node.js process** | Yes | Yes, unrestricted | Unbounded | **Yes** | Full | `pg` / `node-redis` (`ioredis` is now *"maintenance on a best-effort basis"*) / `mongodb`; `node:sqlite` built in | Both | Node 26 Current (2026-05-05), 24 & 22 LTS; 25/23/20/18 EOL |
| **Bun process** | Yes | Yes, unrestricted | Unbounded | **Yes** | Full | **Built in** — `Bun.sql` (PG/MySQL/SQLite; `sql.listen`/`notify` PG-only), `Bun.redis` (auto-pipelining, RESP3, **no Cluster or Sentinel**) | Both | Bun ≥1.4.2 |
| **Browser / Web Worker** | Tab lifetime, throttled when backgrounded | **No** — `fetch`/WebSocket/WebTransport only. Direct Sockets is Isolated-Web-Apps/ChromeOS only | Tab lifetime | Only over a socket to a server that owns the real lease | OPFS only | **No** | Pull over HTTP/WS | Browser JS |

**The one-sentence conclusion, and it decides the whole plan:**

> **Exactly four kinds of host let a worker hold its own lease with a live
> heartbeat** — a plain Node or Bun process, a Cloudflare Container / Cloud Run
> job or worker pool / ACA job, AWS Lambda Managed Instances, and (with
> caveats about eviction) a Deno Deploy instance. **Everywhere else the correct
> design is to let something else own the lease**, and every one of those
> systems is at-least-once by contract.

For bun-jobs that "something else" is the gateway (§5.9). For the platforms'
own queues it is the visibility timeout — SQS's `ReportBatchItemFailures`,
Cloudflare Queues' `ack()`/`retry()` and its pull API's `lease_id`, Vercel
Queues' `ExtendLease`, Netlify Async Workloads' retries and DLQ. Those are
*drivers*, not targets, and are out of scope (§10.1) — but the symmetry is
worth noticing: every one of them is the same protocol this plan specifies,
with their storage instead of ours.

**Three findings that change what the README should recommend, ahead of any
protocol:**

1. **Cloudflare Containers (GA 2026-04-13), Cloud Run worker pools (GA) and
   Azure Container Apps all run an arbitrary container, so today's `bun-jobs`
   runs on them unchanged.** Cloud Run worker pools are *documented for
   exactly this workload* — Google's own examples are Kafka consumers,
   Pub/Sub pull subscribers and Redis task queues — and are the only Cloud Run
   shape with Direct VPC ingress. If the question is "where can I run a
   worker", the answer in 2026 is a container, and it costs no code.
2. **Vercel supports Bun as a first-class function runtime (public beta)**,
   with the extended 1800 s duration tier. A Vercel function is still not a
   worker (it is suspended between invocations and `waitUntil` cannot outlive
   the invocation), but it *is* a place a bun-jobs **remote executor** can run
   with no transpilation. That makes Vercel the cheapest adapter to validate.
3. **`sql.listen` is unusable behind AWS RDS Proxy and behind Cloudflare
   Hyperdrive.** This is a present-day limitation of the existing `SqlDriver`,
   independent of this plan, and belongs in the driver documentation now.
   (An earlier draft added "and session advisory locks". **Corrected
   2026-09-22:** bun-jobs uses no Postgres advisory locks — verified, the only
   "advisory" in the package is unrelated prose in the file driver — so that
   half of the RDS Proxy restriction, though true of the proxy, does not touch
   this driver.)
4. **Cloud Run kills idle connections on a clock nobody expects**: *"there is a
   timeout after 10 minutes of idle time for requests from your container to
   VPC"*, and 20 minutes to the internet. A pooled Postgres or Redis
   connection quieter than that is dead with no notice — which affects a
   *pull-mode* bun-jobs worker running in a Cloud Run service or worker pool,
   not the protocol. Worth a line in the driver docs beside the RDS Proxy note.
### 3.6 Cloudflare in detail — the platform that decides the design

Verified 2026-09-22 against the live docs; page dates as shown by Cloudflare.

| Fact | Value | Source page (its stated date) |
|---|---|---|
| Simultaneous open connections **per invocation** | **6**, both plans | `workers/platform/limits/` (2026-09-05) |
| CPU time | Free 10 ms/request; Paid **5 min max, 30 s default** (`cpu_ms`) | same; raised 2025-03-25, not 2024 |
| Wall clock | **No limit** for an HTTP request while the client stays connected; **15 min** for cron, Queue consumers and DO alarms | same |
| Timers | `setTimeout`/`setInterval` exist but are **"only available inside of the Request Context"** | `runtime-apis/web-standards/` (2026-04-23) |
| `ctx.waitUntil` | extends execution **up to 30 s** after the response | `runtime-apis/context/` (2026-09-10) |
| Memory | 128 MB per isolate | limits (2026-09-05) |
| Raw TCP | `connect()` from `cloudflare:sockets`; **must be created inside a handler**, not at module scope. Port 25, Cloudflare's own IPs, private networks and localhost are blocked | `runtime-apis/tcp-sockets/` (2026-06-19) |
| `node:net` | client half supported on top of `connect()`; **`net.Server` unsupported** | `runtime-apis/nodejs/net/` (2026-04-23) |
| `nodejs_compat` | **on by default** for compatibility date ≥ **2026-08-04**; `fs`, `net`, `http`, `crypto`, `stream` supported; `tls` partial; **`node:dgram` is a non-functional stub that imports fine and throws at call time** | `runtime-apis/nodejs/` (2026-08-12) |
| Hyperdrive | **PostgreSQL 9.0–17.x and MySQL 5.7–8.x/MariaDB only. No Redis.** MySQL GA 2026-08-07 | `hyperdrive/reference/supported-databases-and-features/` (2026-04-21) |
| Hyperdrive caveats | **`LISTEN`/`NOTIFY` not supported. Advisory locks not supported.** Max query duration **60 s**; ~20 origin connections free / ~100 paid | same + `hyperdrive/platform/limits/` (2026-06-09) |
| Smart Placement | **fetch handlers only** — explicitly does **not** apply to Durable Objects, Queue consumers or Cron Triggers | `workers/configuration/smart-placement/` (2026-04-23) |
| Cron Triggers | five-field, **minimum interval 1 minute**. Delivery guarantee not stated (unverified) | `workers/configuration/cron-triggers/` (2026-09-04) |
| Durable Objects | hibernation-eligible after **10 s idle**, and **hibernation requires no pending `setTimeout`/`setInterval`**; eviction after **70–140 s** idle otherwise; an outbound socket pins the object alive **at most 15 min** and bills GB-s throughout | `durable-objects/concepts/durable-object-lifecycle/` (2026-07-03) |
| DO alarms | **one alarm per object**, `setAlarm` overwrites; at-least-once with **up to 6 retries**, exponential backoff from 2 s | `durable-objects/api/alarms/` (2026-04-21) |
| Queues (push consumer) | message 128 KB, batch ≤100, `max_batch_timeout` ≤60 s, retries ≤100, 5,000 msg/s per queue, **concurrent consumer invocations ≤250**, consumer wall clock 15 min. **Any throw fails the whole batch**; `ack()`/`retry()` are per message; **`retry()` explicitly does not count as a failed invocation** for autoscaling | `queues/platform/limits/` (2026-04-21), `queues/configuration/javascript-apis/` (2026-07-06), `.../consumer-concurrency/` (2026-04-21) |
| Queues (pull consumer) | HTTP `…/messages/pull` + `/ack`, `visibility_timeout_ms` default 30 s **max 12 h**, batch ≤100, messages carry a **`lease_id`** | `queues/configuration/pull-consumers/` (2026-07-01) |
| **Containers** | **GA 2026-04-13.** Real linux/amd64 process, `sleepAfter` default 10 min idle, SIGTERM then ≤15 min to exit, cold start 1–3 s, all disk ephemeral, **no inbound non-HTTP TCP from end users**. Max lifetime not documented (unverified) | `containers/platform-details/` (2026-08-28) |
| Workflows | unlimited instance lifetime, sleep up to 365 days, 1,024 steps free / 10,000 paid, CPU per step 30 s default → 5 min | `workflows/reference/limits/` (2026-09-21) |

**What this forces, point by point:**

1. **Six connections.** A claim loop, a heartbeat and a settle on one isolate
   would spend three of six, and `Bun.sql`'s pool assumes more. Pull is dead
   on arrival, not merely awkward.
2. **Timers only inside the request context.** There is no tick between
   invocations. A lease cannot be renewed by the remote. This is the single
   fact that makes §5.9's answer ("the gateway heartbeats, because it is the
   one that is awake") the only correct one.
3. **`connect()` inside a handler only.** Even a per-request connection costs
   a TCP+TLS handshake per invocation. The SQL driver's model — a pool, a
   `LISTEN` session, prepared statements — cannot be reproduced.
4. **Hyperdrive has no Redis and no `LISTEN`/`NOTIFY`.** So the two drivers
   with the best wakeup latency (`RedisDriver`'s blocking `BLMOVE`,
   `SqlDriver`'s `sql.listen`) are exactly the two Hyperdrive cannot serve.
   A Cloudflare-side driver would be a polling SQL driver with a 60 s query
   cap: strictly worse than pushing.
5. **Smart Placement does not apply to queue consumers or cron triggers.** The
   "put the Worker next to the database" argument evaporates precisely where a
   worker would live.
6. **Durable Objects are the only CF primitive that could hold a lease**, by
   chaining alarms — and a pending timer prevents hibernation, so the object
   stays resident and bills GB-s continuously. That is a paid, always-on
   single-threaded process with a ~1,000 req/s ceiling. If you are going to
   pay for an always-on process, pay for a container.
7. **Cloudflare Containers is the actual answer to "run a worker on
   Cloudflare".** GA since 2026-04-13, arbitrary linux/amd64, so today's
   `bun-jobs` runs there with no new code at all. This belongs in the README
   as the first recommendation, ahead of the protocol.
8. **`node:dgram` imports fine and throws at call time.** A general warning
   for anything shipped to Workers: capability probing by `try { import }`
   does not work there. The bundle-safety test (§6.3) is the defence.

One adjacent finding worth recording even though it is out of scope:
**Cloudflare Queues' pull consumers are themselves a lease protocol**
(`visibility_timeout_ms`, `lease_id`, HTTP pull/ack) and could be driven by a
`bun-jobs` worker running anywhere. That is a *driver*, not a target, and it is
a different project.
### 3.7 AWS Lambda in detail — the freeze, and the 2026 exception

Verified 2026-09-22 against `docs.aws.amazon.com`. **AWS renders no
"last updated" stamp**, so every AWS citation here is "content as fetched
2026-09-22"; dated *What's New* posts are called out.

**There are three Lambda compute types in 2026 that did not exist a year
ago**, and one of them changes the analysis: **Lambda Managed Instances
(LMI)**, **Lambda Durable Functions**, **Lambda MicroVMs**.

| Fact | Value |
|---|---|
| Timeout, default Lambda | **900 s (15 min)**, sync and async |
| Timeout, **LMI** | **5,400 s (90 min)** for async and event-source-mapping invokes; sync still 900 s. Announced **2026-09-09** |
| Durable Functions | checkpoint/replay up to **one year**; ≤3,000 durable operations per execution (not raisable); waits suspend without compute charges |
| MicroVMs | 8 h max, ARM64 only; viability as a worker host unverified |
| Freeze | *"Lambda freezes the execution environment when the runtime and each extension have completed and there are no pending events."* Triggered by **quiescence**, not by the handler returning |
| Timers across the freeze | *"Background processes or callbacks… that did not complete when the function ended **resume** if Lambda reuses the execution environment."* |
| **LMI exception** | *"Unlike Lambda (default), the execution environment remains continuously active, processing invocations as they arrive **without freezing between invocations**."* |
| Outbound TCP | yes, in a VPC via a Hyperplane ENI (65,000 connections each); internet egress needs NAT |
| **14-day idle reclaim** | an idle VPC function's ENI is reclaimed, the function goes `Inactive`, and **the next invocation fails** |
| Filesystem | `/tmp` 512 MB–10,240 MB, per environment; EFS; new "S3 Files" (mutually exclusive with EFS) |
| Payloads | sync **6 MB** request/response; response streaming **200 MB**. Async invoke is **contested**: two independent reads of the 2026 quotas page gave 256 KB and 1 MB. Not load-bearing here — push mode uses synchronous invokes, where both agree on 6 MB |
| Response streaming | Node managed runtimes; *"streamed responses are not interrupted… when the invoking client connection is broken. Customers are billed for the full function duration."* Not supported on function URLs inside a VPC |
| SnapStart | Java 11+, Python 3.12+, .NET 8+ — **explicitly not Node**; and *"unique IDs, unique secrets, and entropy"* generated at init are duplicated across restored environments |
| Runtimes | `nodejs22.x`, `nodejs24.x` GA; `nodejs26.x` **public preview**, GA targeted Nov 2026; `provided.al2` deprecated 2026-07-31 → target `provided.al2023`. **Bun is not a supported runtime** (custom runtime or container image) |
| Concurrency scaling | 1,000 environments per 10 s per function; **and a separate ceiling of 10 requests/s per unit of concurrency** |
| SQS event source mapping | batch ≤10,000 (FIFO 10); batching window 0–300 s but *"Lambda might wait for up to 20 seconds"* on a quiet queue; `MaximumConcurrency` 2–1,000; `ReportBatchItemFailures` for partial acks |
| SQS partial-failure trap | a malformed `batchItemFailures` response — bad JSON, wrong key, empty or unknown `itemIdentifier` — **silently retries the whole batch** |
| EventBridge Scheduler | 1-minute floor, and *"All schedule types… invoke their targets with 60 second precision"* |
| RDS Proxy pinning | PostgreSQL pins the session on `SET`, `PREPARE`/`EXECUTE`, temp objects, **declaring cursors**, **`LISTEN`**, and **`pg_advisory_lock`** — but *not* `pg_advisory_xact_lock`. *"RDS Proxy doesn't support session pinning filters for PostgreSQL"* — no opt-out. Also: no `CancelRequest` for PostgreSQL. **Only the `LISTEN` row binds bun-jobs** — it uses no advisory locks, cursors or `PREPARE` (verified 2026-09-22) |

**What this forces:**

1. **A lease cannot be held on default Lambda, and the failure mode is the
   worst possible one.** A `setInterval` heartbeat does not fire *late*; it
   fires **out of time**, after an unbounded invisible gap, while the process
   believes it is renewing a lease that expired and was stolen. Extensions do
   not rescue it — they run only until the Invoke phase ends, and the Shutdown
   hook gets 2,000 ms and is not guaranteed to run. Provisioned concurrency
   removes Init latency, not the freeze (strongly supported by the docs;
   **not** stated verbatim anywhere, so flagged).
2. **So push mode is right here too**, for the same reason as Cloudflare: the
   gateway is the process that is awake.
3. **LMI is the one 2026 configuration where a pull-mode Lambda worker is
   sound** — continuously active, 90-minute invokes. It taxes you back:
   multiple runtime workers share one environment (so worker code must be
   thread-safe), a timed-out invocation's code *keeps running* and can produce
   duplicate side effects after Lambda has reported failure, and extensions
   there cannot register for Invoke at all. Worth one paragraph in the README
   and nothing in the code.
4. **SnapStart is disqualifying for a worker even where it is supported.**
   `#token = newToken()` and the derived worker id are minted at construction;
   under SnapStart every restored environment would carry the *same* token —
   which corrupts the heartbeat record, the lock token and the concurrency
   lease simultaneously. `BunQueueWorkerOptions.id` already warns that two
   workers sharing an id corrupt all three; this is that hazard, industrialised.
5. **`sql.listen` cannot be used behind RDS Proxy.** bun-jobs' `SqlDriver`
   uses `sql.listen` for push events on Postgres, so a worker behind RDS Proxy
   must fall back to polling. **This is a real, present-day limitation of the
   existing SQL driver, independent of this plan**, and belongs in the driver
   documentation regardless. RDS Proxy also pins the session on
   `pg_advisory_lock`, but **bun-jobs uses no advisory locks** (verified
   2026-09-22), so only the `LISTEN` half binds here.
6. **The 6 MB synchronous payload limit** is the binding value for
   `maxBodyBytes` on a Lambda adapter behind a function URL — not 1 MiB, and
   not 200 MB.
7. **Response streaming bills the full duration after a client disconnect.**
   So §5.10's NDJSON progress stream, on Lambda, means a gateway that walks
   away leaves the invoice running. The Lambda adapter should default
   `progress-stream` **off** and say why.
8. **The SQS event source mapping is itself a lease protocol** — visibility
   timeout is the lease, `ReportBatchItemFailures` is the partial ack,
   `MaximumConcurrency` is the backpressure valve. Like Cloudflare Queues'
   pull consumers (§3.6), that is a *driver*, not a target, and out of scope.

**One unverified gap that directly bounds this design.** Neither an
independent check of `urls-configuration.html`, `urls-invocation.html` nor the
quotas page states a **maximum request timeout for a Lambda Function URL**. A
push-mode gateway holding a connection open for a 10-minute job behind a
Function URL may therefore be cut by an undocumented edge timeout rather than
by the function's own 900 s. **Measure it before shipping the Lambda adapter**
(§7.2 tier 3), and until then document `InvokeWithResponseStream` or API
Gateway as the supported path for long jobs. Two further Lambda notes from the
same pass: a Function URL's throughput ceiling is 10 RPS per unit of reserved
concurrency, with 429 beyond it; and a VPC-attached function's outbound path
loses default internet access, so an endpoint on the public internet needs NAT.

**Could not verify** (AWS): the long-quoted "visibility timeout = 6× function
timeout" guidance (absent from the four SQS pages fetched); the SQS poller
ramp figures (the live page says 300/min → 1,250 max, contradicting the
long-published 60/min → 1,000, and is undated); `MaximumPollers`' upper bound
(AWS's own pages say 2–10,000 and 2–2,000); Kinesis/DDB `BatchSize` maxima;
the classic EventBridge Rules 1-minute floor; Lambda MicroVM viability; S3
Files limits; LMI's launch date; whether `oven-sh/bun`'s `packages/bun-lambda`
supports `provided.al2023`.
### 3.8 How comparable systems solve this

Verification status is per row. **Inngest** and **Faktory** were read from
primary sources on 2026-09-22 (`inngest/inngest/docs/SDK_SPEC.md` at HEAD,
2,259 lines; `contribsys/faktory/docs/protocol-specification.md`, 518 lines,
v1.10.0 released 2026-08-10) together with implementation source. Cloud Tasks
and SQS+Lambda were verified against primary vendor docs the same day.
**Temporal** and **Hatchet** were subsequently verified from primary sources
(protobuf definitions, server source, docs and in-flight pull requests) and
their rows below are corrected accordingly — **both were wrong in ways that
matter**; see §3.8.1. **BullMQ** (`master` @ v6.3.8), **`bullmq-proxy`**
(`main` @ v1.5.3), **Trigger.dev** (`main` @ v4.6.4) and **Quirrel** (through
its `secure-webhooks` package) were then verified from source the same day —
Lua scripts, IPC enums, route tables and the signing implementation, not docs
summaries.

**Graphile Worker** (v0.18.0), **River** (v0.47.0), **Oban** (v2.24.0) and
**Sidekiq** (v8.1.7) were verified last, from SQL, migrations, fetch
implementations and official docs.

**Every row in the table is now primary-source verified.** Where a specific
figure inside a row could not be closed — Sidekiq's closed-source `super_fetch`
key format, Oban's current `rescue_after` default, River's non-pgx drivers —
the row says so in place. Four of these corrected claims the earlier draft made
from model knowledge, which is why the distinction is worth keeping visible:
**Temporal can be serverless, Oban does have a cross-language worker, Sidekiq
OSS uses `BRPOP` rather than `BRPOPLPUSH`, and Quirrel's signature is
`v=<ms>,d=<digest>` rather than a Stripe-style header.**

| System | Contract | Push/pull | Lease | Auth | Copy | Avoid |
|---|---|---|---|---|---|---|
| **Inngest** (verified) | One URL, three methods: `GET` introspect, `PUT` sync doorbell, `POST` invoke. `200` done / `206` + step opcodes / `4xx`+`X-Inngest-No-Retry` | Push (HTTP); Connect adds an outbound WebSocket for unreachable workers, still server-dispatched | HTTP mode: **none** — the request *is* the lease. Connect: a `lease_id` extended at a **server-dictated** interval that returns a **new** id each time | One `signkey-<env>-<hex>`, HMAC for inbound + its SHA-256 as outbound bearer; primary + fallback key, response signed by whichever key validated | The whole shape. Signature-gated introspection that returns **key hashes** so an operator can identify a deployment's key without the key. Per-feature `capabilities` version map. `Retry-After` + explicit no-retry header. The **two-sided** replay clamp | Using the same secret two ways (ASCII for HMAC, hex-decoded for the bearer hash) |
| **Faktory** (verified) | CRLF verbs over TCP/7419, RESP responses. `HELLO`/`FETCH`/`ACK`/`FAIL`/`BEAT`/`END`. A job is **three required fields**: `jid`, `jobtype` (a string discriminator), `args` | Pull, blocking `FETCH` | `reserve_for` (default 1800 s, clamped 60 s–24 h), expiry-scored sorted set swept by a reaper | Salted, iterated SHA-256 of the password; server sends `{i, s}` in `HI` | **The `BEAT` response as the control channel** — liveness up, `{"state":"quiet"\|"terminate"}` down, one round trip, no server push. Structured `FAIL` with `errtype`. Queue priority by argument order. A terminating worker `FAIL`s its own in-flight jobs. Literal `C:`/`S:` transcripts in the spec | **A silently-ignored late `ACK`** — `jid` is not a fencing token; a stale ack logs and returns success. Also: its normative spec has drifted behind its implementation |
| **Temporal** (verified) | One gRPC service. Long-poll `PollActivityTaskQueue` (server-side cap **60 s**; an empty poll returns an empty `task_token`), work, then `RespondActivityTaskCompleted`. All user data is opaque `Payloads` the server never interprets | **Pull** — but with two push-shaped optimisations *inside* it (a completion can return the next task and eagerly dispatched activities in the same round trip), and **since 2026-07-17 a genuine push _trigger_** (§3.8.1) | Four named timeouts; **start-to-close is the lease**, shortened in practice to the heartbeat timeout. **There is no extend-lease RPC — the heartbeat _is_ the renewal**, and it also carries `heartbeat_details` (handed to the next attempt as resumable progress) and `cancel_requested`. SDKs throttle to 80% of the heartbeat timeout | mTLS or Bearer + `temporal-namespace`; self-hosted `ClaimMapper`/`Authorizer` | **One RPC that is simultaneously lease renewal, progress checkpoint and cancellation channel.** A task token fenced by `attempt` + `activity_attempt_stamp`, so a superseded attempt's completion is rejected — **and the token is not the credential**: auth is per-connection, the token only identifies and fences. Sticky queues as cache affinity with a short-timeout fallback, never a correctness mechanism | Four overlapping timeouts as the only knobs, and unsafe defaults — an unconfigured self-hosted server uses `noopAuthorizer`, which allows every API request with no authentication or access control |
| **BullMQ** (verified) | In-process Redis client driven by Lua. A **sandboxed** processor (`new Worker(q, "/abs/path.js")`) forks a child process or a `Worker` thread whose contract is a **numeric-enum IPC protocol** — `ChildCommand` (`Init`, `Start`, `Stop`, `Cancel`, `…Response`) down, `ParentCommand` (`Completed`, `Failed`, `Progress`, `Log`, `MoveToDelayed`, `GetChildrenValues`, …) up. The child receives `job.asJSONSandbox()` — **a plain object, not a live `Job`** — and every mutating method on it is replaced by an IPC sender that the *parent* executes against Redis | Pull, then push to the child | Lock key `<prefix>:<queue>:<jobId>:lock` holding the worker's token, `lockDuration` 30,000 ms, renewed at `lockRenewTime` (`lockDuration / 2` = 15,000 ms), swept every `stalledInterval` 30,000 ms, `maxStalledCount` 1 | Redis credentials. No per-worker identity or authz | **The fencing, done right — verified on both halves.** `extendLock-2.lua` is `if rcall("GET", KEYS[1]) == ARGV[1]` → `1`, else `0`; and `moveToFinished-14.lua` calls `removeLock`, which returns **`-6` when the lock exists but the token differs** (*Lock mismatch for job …*) and **`-2` when it is gone** (*Missing lock for job …*). An ack that can *fail*. Also: the **two-pass mark-and-sweep** (§3.8.2) and the sandbox rule that the child touches neither the datastore nor a live `Job` | `maxStalledCount: 1` as a default against a lock a CPU-bound child can starve; and `ParentCommand.Error` carrying its payload under `err` while every sibling uses `value`, forcing `msg.value ?? msg.err` at every call site |
| **`bullmq-proxy`** (verified) | v1.5.3. **Written in Bun** (`Bun.serve`), for *"much better HTTP and WebSocket performance and memory consumption than … NodeJS"*. A REST control plane plus a **webhook registration, not a connection**: `POST /workers` with `{ queue, endpoint: { url, method, headers?, timeout? }, opts? }`, one worker per queue, replaced on re-POST. The proxy runs a real BullMQ `Worker` in-process whose processor is `fetch(url, { body: JSON.stringify({ job: job.toJSON(), token }) })` | **Push**, strictly. The remote never dequeues | **All leasing stays server-side** — standard BullMQ lock, renewed by the proxy. `opts` deliberately withholds `lockDuration`, `lockRenewTime`, `stalledInterval` and `connection`, so **the remote cannot extend anything**. Its only deadline is the endpoint `timeout`, **default 3,000 ms** | Static shared bearers from `AUTH_TOKENS` for the control plane; **`authForWorkers` compares the request's bearer against `GET <prefix>:<queue>:<jobId>:lock`** | **The per-job capability token** — a remote worker's credential *is* the job's lease token, so its authority is exactly one job wide and dies with the lease. One Redis `GET`, and the cleanest example of the idea in this table | Making the HTTP response the only completion signal with a **3-second default** and no ack or heartbeat — a job longer than one request is literally unrepresentable. Its WebSocket transport sends **only `job.data`** (no id, no attempts, no token), so the two transports are not semantically equivalent — the exact failure Inngest and Hatchet avoided. **Status: a working prototype, last feature release 2025-02-15, roadmap still unchecked** — cite as a design reference, not a maintained product |
| **Cloud Tasks** (verified) | Your HTTPS URL, one request per attempt, attempt metadata in `X-CloudTasks-*` headers. **2xx is the ack** | Push only — **pull queues were removed** | No lease, no heartbeat, no extend. `dispatchDeadline` 15 s–30 min, fixed at creation. *"when the request is cancelled, Cloud Tasks will stop listening for the response, but whether the worker stops processing depends on the worker"* | Per-dispatch minted OIDC/OAuth tokens, not a shared secret | Attempt metadata in headers so the worker needs no SDK. **`TaskRetryCount` (dispatches) vs `TaskExecutionCount` (dispatches that responded)** — two counters make timeouts distinguishable from failures for free. The five-field declarative retry policy | A deadline that can neither be extended nor actually stop the worker. Named-task dedup with a 24 h–9 d tombstone and a sequential-id performance cliff |
| **SQS + Lambda ESM** (verified) | Raw SQS is `ReceiveMessage`/`DeleteMessage` with a per-receive `ReceiptHandle`. The Lambda integration is **a hosted poller plus a response-shaped ack** — no second protocol | Pull, disguised as push | Visibility timeout, extendable — **but capped at 12 h from first receive**, and the ESM's managed role has **no `ChangeMessageVisibility`**, hence the folklore "6× the function timeout" | SigV4/IAM | The partial-batch ack shape `{batchItemFailures:[{itemIdentifier}]}`, and its strictness (empty list = all good, unknown id = whole batch fails) | **Receipt handles are not fencing tokens**: *"If you use an old ReceiptHandle, the request will succeed, but the message might not be deleted."* A 200 that does nothing |
| **Trigger.dev** (verified) | v4.6.4. Two nested contracts. **Outer** (supervisor ↔ platform, and it *is* in the open-source repo): `POST /engine/v1/worker-actions/{connect,dequeue,heartbeat}` and `runs/:runId/snapshots/:snapshotId/{attempts/start,attempts/complete,suspend,continue}`. **Inner** (runner ↔ supervisor): a local Workload API on :8020. The *code* contract is "an OCI image our CLI built from your TypeScript" | **Pull** for work — a **short-poll** at 250 ms busy / 1,000 ms idle, ≤10 runs per dequeue, with a `preDequeue` hook that reports free CPU/memory and **can skip the poll entirely when full**. Push only for `run:notify` over socket.io, about runs it already holds | **There is no lock token — the lease is the execution snapshot.** Every action is addressed `(runId, snapshotId)`, so a stale worker acting on an old snapshot is rejected: optimistic concurrency instead of a lock. Plus per-status heartbeat timeouts — 60 s for `EXECUTING`, 600 s for `SUSPENDED` | `Bearer tr_wgt_…` (admin-minted worker-group token) + `x-trigger-worker-managed-secret` + instance name; per-run calls add a runner id and a deployment-derived environment id. **Runners get a separate workload token and never hold the group token** | **Address every worker action as `(runId, snapshotId)` so a stale or duplicated worker is rejected by construction**, and make the dequeue carry the worker's free resources so the *server* right-sizes the batch | **Binding the work unit to a container image built by your own CLI.** It is what makes their worker un-implementable by anyone else — and why their own self-hosted tier loses checkpoints, warm starts and auto-scaling, which remain cloud-only |
| **Hatchet** (verified) | gRPC `Dispatcher`: `Register` declaring `actions`, **`slots`** (capacity) and per-action `slot_config`, then `ListenV2` — a server stream of `AssignedAction` on which **cancellation is a pushed message**, not a poll result — then unary `SendStepActionEvent`. `PutLog` and `PutStreamEvent` are first-class RPCs on the same channel | Worker dials out; server pushes | Heartbeat every ~4 s, **liveness keyed by session id rather than a timestamp**. **`RefreshTimeout(taskId, increment_timeout_by)` is an explicit extend-lease RPC** — exactly what Temporal deliberately does not have — plus `ReleaseSlot` and `RestoreEvictedTask`, so a durable task waiting seven days is *evicted* rather than holding a slot | Tenant-scoped `HATCHET_CLIENT_TOKEN` in gRPC metadata | Declaring capacity at registration (which is what makes push safe), `should_not_retry` as a field rather than a header, and logs and streamed output as protocol rather than a side channel | **Shipping a serverless transport (2024), leaving it undocumented across a major version, and reusing its name for an unrelated feature.** Hatchet is now rebuilding from scratch what it had in 2024 — see §3.8.1 |
| **Quirrel** (verified) | A queue bound to one of your own API routes. `POST` is hard-coded, as is `Content-Type: text/plain`; the body *is* the payload string; an **`x-quirrel-meta` header carries `{id, count, exclusive, retry, nextRepetition}` as a JSON string**. 2xx acks, non-2xx retries — and **HTTP 404 means `dontReschedule: true`** | Push. The worker holds no connection and no queue state | **None — no lease, no heartbeat, no visibility timeout.** The HTTP request's lifetime *is* the lease, which is exactly why it fits serverless and why long jobs do not fit at all | `x-quirrel-signature`, via the `secure-webhooks` package written for it. Format `v=<ms>,d=<digest>`; the signed input is **`body + timestamp` concatenated with no separator**; symmetric is HMAC-SHA256 hex, **and there is an asymmetric mode** (`createSign('sha256')`, base64) where the receiver holds only a *public key*. Window `FIVE_MINUTES`, compared with **`Math.abs`** — two-sided, arrived at independently of Inngest. Rotation tries `token` then `quirrelOldToken` | **`404` ⇒ never retry** — it distinguishes *"your handler failed"* from *"your handler isn't there"*, which a pure 2xx/non-2xx contract cannot (§5.5). **The asymmetric mode**: a remote holding only a public key cannot forge a request (§5.6). And end-to-end payload encryption with a 4-char key descriptor so the secret can be rotated | **Signature verification is skipped entirely unless `NODE_ENV === "production"`.** Digest comparison is `===` on hex, not constant-time. The no-separator concatenation is ambiguous — `body="a"`+`ts=11` and `body="a1"`+`ts=1` sign identical bytes. And the auth token doubles as the HMAC key, entangling rotation with blast radius. **Status: not archived, but the last release and the last `main` commits are all 2023-06-26, and the hosted service shut down in 2022** — unmaintained, not dead-lettered |
| **Graphile Worker** (verified — v0.18.0, 2026-09-08) | **No remote contract; the contract is the SQL schema.** A batched `UPDATE … FROM (… FOR UPDATE SKIP LOCKED)` CTE against `_private_jobs`; the stable public interface is the `graphile_worker.jobs` **view**, which deliberately omits `payload`. **An exhaustive grep of the v0.18.0 tree for a non-Node worker story returns exactly one hit** — *"Executes tasks written in Node.js (these can call out to any other language or networked service)"*. The **producer** side is language-agnostic: anything that can `select graphile_worker.add_job(...)`, including a trigger | Pull, woken by `NOTIFY`, with a 2,000 ms poll as the safety net | `locked_at`/`locked_by` — and `locked_by` is the **pool** id, not the worker's. **No heartbeat at all**; the only recovery is `locked_at < now() - interval '4 hours'` | Postgres credentials | **`LISTEN`/`NOTIFY` for latency plus a short poll for safety.** It also puts a random `r` field in the NOTIFY payload to defeat Postgres' in-transaction coalescing — **do not copy that one**: bun-jobs measured it and the coalescing costs nothing here, because its claim loop re-claims after a success rather than waiting (§3.8.3(a)). Also the `job_key` + `job_key_mode` triad — `replace` = debounce, `preserve_run_at` = throttle — the clearest idempotency vocabulary here. And it publishes *measured* throughput for four locking strategies, which is unusual and worth reading before writing any SQL driver | A **4-hour** fixed stale-lock window with no heartbeat: a crashed pool strands its jobs for hours |
| **River** (verified — v0.47.0, 2026-08-31) | Go over a `river_job` table; `JobGetAvailable` is a `FOR UPDATE SKIP LOCKED` CTE. Non-Go languages get a documented, deliberately **insert-only** client tier — `riverqueue-python` is literally described as *"Python insert-only client for River"*, and both it and the Ruby client state they *"don't support working jobs"* | Pull, woken by `pg_notify('river_insert', …)`, with a Scheduler tick every 5 s | **No lease column and no heartbeat: `state='running'` *is* the lease and it never expires.** Recovery is an out-of-process **Rescuer** at `RescueStuckJobsAfter`, **default 1 hour**, on top of an in-process `JobTimeout` (1 min) and `JobStuckThreshold` (10 s). Worst-case recovery ≈ 1 h 1 min — and River Pro sells *"active job rescue"* to shorten it | Postgres credentials | **The explicit insert-only tier**: a sanctioned producer contract for other languages that does not pretend to be a worker contract — much cheaper than a full protocol and still valuable. Plus `attempted_by` as a **bounded ring** of client ids, so *who touched this job* stays debuggable without unbounded growth | Letting `state='running'` be the lease with an hour-scale rescuer as the only backstop — River's own acknowledged weak spot, which it sells the fix for. *(Only the pgx driver's SQL was read; the sqlite and database/sql drivers may differ.)* |
| **Oban** (verified — v2.24.0, 2026-08-25) | Elixir; the row names a **worker module**. **Correction to the common belief: Oban Pro for Python (v0.6.4, 2026-09-03) both enqueues *and* executes**, so the runtime welding is no longer absolute — though it is commercial, and whether Elixir and Python workers interoperate on one database is unverified. There is still no HTTP or remote worker protocol in OSS | Pull, `FOR UPDATE SKIP LOCKED`, with `pg_notify` wakeups and a leader-only Stager | `:executing` + **`attempted_by`, which records node + queue + producer nonce**. Liveness comes from the Lifeline plugin's heartbeats and a rescue sweep (`rescue_after`, **60 min** per the 2.23 docs — the 2.24 page is a deprecation stub, so treat the current default as unconfirmed). Leadership itself re-elects every 30 s | Database credentials (plus a shared cookie for `Oban.Peers.Global`) | **`attempted_by` binding a job to node + queue + producer nonce**, which makes orphan rescue *provably* safe — *"guaranteed to only rescue jobs that belong to dead queue processes or nodes"* — rather than time-based guessing. And `Oban.Peer` leader election so sweeping and scheduling run exactly once with no separate coordinator | Naming the job by a language-native module path; and putting orphan rescue behind a leader-elected plugin with an hour-scale default |
| **Sidekiq** (verified — v8.1.7 on `main`, 2026-09-22) | The *accidental* language-agnostic protocol: JSON on a Redis LIST, format published on a wiki so non-Ruby clients exist — but `class` is a Ruby class name, and **the official wiki lists only *client* (enqueue-side) libraries**. A cross-language *worker* exists (`jrallison/go-workers`) but is unofficial and apparently unmaintained. **Note for any pre-8.0 client: `created_at`/`enqueued_at` became epoch *milliseconds as integers* in Sidekiq 8.0**, having been float seconds | Pull — `BRPOP` with a 2 s timeout so shutdown stays responsive, and `@queues.shuffle` on *every* call for weighting | **OSS has no lease at all: the correction is that it uses `BRPOP`, not `BRPOPLPUSH`, and `UnitOfWork#acknowledge` is literally a no-op** — the job is already gone from Redis, so a `kill -9` loses it. The `LMOVE`-into-a-private-queue reliable fetch is Pro's `super_fetch` only, whose own wiki says *"super_fetch might recover jobs in 5 minutes or 3 hours, there's no guarantee"* | Redis credentials only. Anything that can reach Redis can push a `class` name your workers will instantiate | **The process registry**: `SADD processes <host:pid:nonce>` plus a self-expiring `<identity>` hash rewritten every 10 s with a **60 s TTL**, carrying `busy`, `concurrency`, `rss` and `rtt_us` — and a `<identity>-signals` LIST the process `RPOP`s each beat for remote quiet/stop. Liveness, a live dashboard and remote control in about thirty lines (§3.8.3) | A no-op acknowledge (at-most-once on crash); selling reliable fetch as the paid tier rather than making the durable path the default; and orphan recovery that leans on an hourly full `SCAN`. *(super_fetch's private-queue key format is closed-source and unconfirmed.)* |

**The eight ideas this plan actually takes, and where each lands:**

| Idea | From | Lands in |
|---|---|---|
| Pull is the core; push is an adapter over it, not a second specification | SQS+Lambda ESM | §3.2 — and bun-jobs is already this shape: the gateway *is* the hosted poller, and the invoke response *is* the ack |
| One execution semantics, two transports — map the statuses exactly | Inngest (`DONE/ERROR/NOT_COMPLETED` ↔ `200/500/206`) | §5.2's WebSocket note: a future socket transport is a **re-framing**, never a re-specification |
| The ack must be able to fail with an explicit "you lost the lease" | BullMQ (token compared in Lua); against SQS and Faktory | §5.8 — and bun-jobs already has it on the gateway side: `completeJob(q, id, token, …)` returns `false` |
| A rotating lease token | Inngest Connect (`new_lease_id` on every extension) | §5.8's fencing note — a monotonic `fence` is the cheaper form for a stateless remote |
| Control on the heartbeat/response channel, never a second connection | Faktory `BEAT`, Temporal heartbeat | §5.5's `capacity` on every invoke response; §5.9's backpressure layers |
| Signature-gated introspection returning **key hashes**, and per-feature capability versions | Inngest `GET` | §5.4 |
| Two counters — deliveries vs attempts | Cloud Tasks `TaskRetryCount`/`TaskExecutionCount` | §5.5's `delivery` field; a transport retry must not burn a job attempt |
| An RFC-2119 spec with literal wire transcripts, and a conformance suite so it cannot rot | Faktory's spec, and Faktory's spec drift | §5, §7 |
### 3.8.1 Two findings that arrived late and matter more than the rest

Both were verified from primary sources on 2026-09-22, and both correct a
claim made earlier in this document.

#### Temporal shipped serverless workers — by changing who *starts* the process, not by defining a second protocol

Announced **2026-07-17**, public preview on Temporal Cloud. The earlier claim
in this plan's draft — that Temporal workers cannot be serverless — was wrong.

The model is **push-to-start, then pull, and it required no protocol change at
all**. A *Worker Controller Instance* (itself a system workflow) watches
task-queue conditions; when a task cannot sync-match to an existing poller, it
invokes the configured compute provider, and the resulting Lambda **creates an
ordinary Temporal client and polls the task queue as usual**, works, and exits:

```
task submitted → Matching tries sync match → no poller
              → Worker Controller signalled → provider invoked
              → worker starts, polls, works, exits
```

Three details worth keeping:

- **Auth to your compute is IAM role assumption, not a token.** Temporal
  assumes a role in your AWS account with `lambda:InvokeFunction`, and the
  trust policy uses an `ExternalId` condition against confused-deputy attacks.
- **Configuration is environment variables, not the invocation event.** The
  event carries no task data — the worker polls for it.
- **`shutdownDeadlineBufferMs` (default 7,000).** The worker begins graceful
  shutdown *before* the platform's deadline, not at it. Small, obvious in
  hindsight, and directly applicable to any serverless worker this plan
  produces. Providers: AWS Lambda (preview); Bedrock AgentCore and **GCP Cloud
  Run worker pools** (pre-release) — the same worker pools §3.5 already
  identifies as the right container shape.

**This is a third independent arrival at the same conclusion**, after AWS's
Lambda ESM (a hosted poller with a response-shaped ack) and this plan's own
§3.2: *make the pull/lease protocol the only protocol, and solve serverless by
changing who starts the process.* Inngest is the counter-example — it started
with HTTP push and had to define a whole second protobuf protocol (Connect)
later to get unreachable workers back.

**What this means for bun-jobs.** The 2026-09-22 draft called this "a fourth
option this plan does not offer". It is now Phase 1.5:

> **Summon-compute.** A controller beside the queue notices that it has
> demand and no live worker, and starts *something* — an ECS task, a Fly
> Machine, a Cloud Run job, a process on a host over SSH. The only job of that
> compute is to run an ordinary `BunQueueWorker` against the real driver
> until the queue drains, then exit. No wire protocol, no signing, no fencing.

It **only works where the summoned thing can reach the driver**: ECS, Lambda
(in a VPC, and inside one invocation), Cloud Run jobs and worker pools, ACA
jobs, Fly, Render, a host of your own, and Cloudflare Containers through a
shim. Never an edge isolate. That is the §3.5 list of hosts that can hold their
own lease.

The draft's sketch, `onDemand: { invoke, idleTimeout }`, turned out to be too
small, for four reasons the evidence found in bun-jobs' own source:

- **Demand is not `waiting`.** With no worker running, due delayed jobs, due
  retries and stalled jobs never become `waiting`.
- **A summoned worker registers late**, so each summon needs an in-flight
  marker.
- **Nothing in `lib/queue/` handles signals.**
- **`countJobs` scans retained history** on SQL and Mongo.

The design, the six first-party summoners, the depth endpoint for
KEDA-shaped platforms, and the re-estimate are in
[`summon-compute.md`](summon-compute.md). The evidence it rests on is indexed
in [`evidence/summon-compute/README.md`](evidence/summon-compute/README.md).

#### Hatchet is building this exact project, right now, and its design corroborates §5

Two in-flight pull requests, both read today:

| PR | State | What it adds |
|---|---|---|
| #4910 — engine-side gRPC operator support | **merged 2026-09-22 (today)** | `OperatorService` with two bidi streams; operators are *"basically just workers with some special and lower-level capabilities"*, gated by `SERVER_GRPC_OPERATORS_ENABLED` |
| #4949 — serverless TypeScript SDK | **open, marked draft** | `sdks/typescript-serverless/`, a Cloudflare adapter, `LIMITATIONS.md`, and a public demo repo. **Do not cite as shipped** |

Its draft protocol and §5 of this document were designed independently and
agree on the load-bearing decisions: **HMAC-SHA256 over the raw body**, a
timestamp header, a **five-minute window clamped in both directions**, one
endpoint with the transport's own status codes as the result, and one task
representation carried over both transports (it reuses `AssignedAction`
verbatim, the same move as Inngest's `DONE/ERROR/NOT_COMPLETED` ↔
`200/500/206`). That convergence is the best evidence available that §5 is the
conventional design rather than an invention.

**Four of its ideas are better than what §5 currently specifies**, and should
be folded in:

| Idea | Why it is better | Where it goes |
|---|---|---|
| **Healthcheck-as-registration** — the endpoint returns its workflows, actions, a `durable` flag and its runtime, and the server *pulls* that | Inngest's outbound `POST /fn/register` needs the worker to hold a credential and reach the server. Pulling it needs **no outbound credential at all** | §5.4 already pulls a handshake — adopt the framing explicitly, and let the handshake carry richer per-name declarations |
| **`422` = "wrong route, upgrade me"** — a durable task sent to the plain trigger route answers 422 rather than failing | A typed, actionable protocol answer instead of a generic error | §5.3's `UNSUPPORTED_OP`, and any future socket transport |
| **A per-upgrade nonce consumed from a bounded in-memory set** | Replay protection that is affordable without a store | §5.6's nonce cache, which currently says only "SHOULD" |
| **A written `LIMITATIONS.md` of typed errors** — child spawning, streaming, cancellation, worker slots and labels each throw an explicit `ServerlessLimitationError` | An explicit *"this transport cannot do that"* beats silent divergence. It also pairs with a CI guard (`check-edge-entry.mjs`) that is the same idea as this plan's bundle-safety test (§6.3) | A deliverable of phase 2, beside `PROTOCOL.md` |

And one warning, which is the strongest single argument for this plan's
phasing: **Hatchet shipped webhook workers in 2024 (PR #542, merged
2024-06-25), never formally removed them, left `webhook_id` in
`WorkerRegisterRequest` to this day, let the feature go undocumented across a
major version, reused the name "webhooks" for an unrelated inbound-trigger
feature, and is now rebuilding the capability from scratch.** Whether the v0
wire protocol was ever fully specified could not be verified — no signature
header, no signing code and no webhook POST exist in the v0 dispatcher source.
If bun-jobs ships a remote contract, it ships with `PROTOCOL.md`, the
conformance kit (§7) and a version, or it should not ship.

### 3.8.2 BullMQ's stalled check — the sweep guard is worth taking, the grace is not

Verified from `src/commands/moveStalledJobsToWait-9.lua` on 2026-09-22, and
called out separately because **bun-jobs should probably adopt it**.

It is a **two-pass mark-and-sweep**, not an expiry check:

1. **Guard.** `SET <stalled-check> ts PX maxCheckTime` with an early `return {}`
   if it already exists. With N workers, **only one runs the sweep per
   interval** — no thundering herd, no leader election, no coordination
   service. One key.
2. **Sweep.** `SMEMBERS stalled; DEL stalled`. For each id, *re-check that the
   lock key is gone* (a live lock means it was never stalled), then `LREM` it
   from `active`, `HINCRBY` its `stc`, and if `stc > maxStalledCount` fail it
   with `"job stalled more than allowable limit"`.
3. **Mark.** `LRANGE active 0 -1` and `SADD stalled <every active id>`, in
   batches of 7,000.

**An earlier draft of this section claimed bun-jobs "inherits the same sharp
edge with none of the grace", and that a CPU-bound processor "loses its job on
one slow tick". Both claims were wrong. Corrected 2026-09-22** after the
bun-jobs session challenged the premise; the code was then re-read
independently, and its objection holds on every point:

- **A stall requires the lock to have *already* expired.** `recoverStalled`
  (`lib/drivers/sql/sql-driver.ts:6009`) selects on
  `state = 'active' AND lock_expires_at <= now`. With
  `DEFAULT_LOCK_DURATION = 30_000` renewed at `lockDuration / 3`, a processor
  must starve its heartbeat for a **full 30 s** before the job is eligible at
  all. That is a grace period; it is simply expressed as a lock TTL rather
  than as a second sweep.
- **A first stall requeues; it does not bury.** Same function:
  `count = stalled_count + 1; buried = count > maxStalledCount`, and the row is
  written `state = buried ? "dead" : "waiting"`. With
  `DEFAULT_MAX_STALLED = 1`, the first stall sets `waiting` — the job runs
  again. Only a second stall buries it. "Loses its job" was wrong twice over:
  not on one tick, and not lost.
- **The real difference is one `stalledInterval`.** BullMQ's second pass adds
  roughly one sweep interval on top of the same lock lifetime.
  `DEFAULT_STALLED_INTERVAL` is also `30_000`, so the gap is ~30 s of
  additional tolerance before a *first* requeue — not grace versus no grace.

Where the survey went wrong is instructive: it compared the `maxStalledCount`
**default** (1 in both systems) and inferred equivalent exposure, without
reading how each system reaches the point of counting a stall. Matching
defaults over different mechanisms is not a finding.

**The honest conclusion: bun-jobs chose a different point on the same axis.**
Practical exposure before work is actually lost is ~2 stall cycles — on the
order of a minute of heartbeat starvation — not one tick. So what remains:

- **Worth taking: the single-sweeper guard key.** This stands on its own and
  is unaffected by the correction above. Confirmed against
  `BunQueueWorker.ts` on 2026-09-22: **every** worker runs `recoverStalled`
  (`:3844`) and flow healing each `stalledInterval`, and `#pruneExpired`,
  `#healRepeats`, `#sweepWindows` and `#sweepWorkerControls` (`:3864-3867`)
  every 60 s — all unconditionally. Only flow healing takes a lease
  (`FLOW_HEAL_LEASE`, `:2571`/`:2586`). So with N workers on a queue those
  sweeps are duplicated N times, and the lease mechanism to fix it already
  exists in the file. Same correctness, a fraction of the driver load.

  **Two conditions on it.** It is evidence-gated like everything else here —
  measure driver calls per second at 1, 5 and 20 workers, before and after.
  And **a lease must never delay recovery when its holder dies**: the
  hand-over has to be bounded the way the flow-heal one is, or this trades
  duplicated work for stalled jobs nobody sweeps, which is a far worse
  failure than the one it fixes.
- **Not worth taking: the mark-then-sweep grace.** A behaviour change across
  five drivers to buy one `stalledInterval` of tolerance on a failure that
  already requeues rather than buries. The cheap improvement is documentation
  instead — a long synchronous handler should call `job.touch()` — which costs
  nothing and addresses the actual failure mode.

Neither belongs in this plan's phases. The guard key belongs in an issue; the
`job.touch()` guidance belongs in the queue documentation.

### 3.8.3 Four things the survey turned up that have nothing to do with this plan

Each is independent of every decision above. None belongs in this plan's
phases. **(a) closed as a null result** and needs nothing; the rest are
issue-sized and cheaper than anything in §11.

#### (a) The `pg_notify` collapse in the SQL driver — measured, and it costs nothing

Graphile emits `pg_notify('jobs:insert', '{"r":<random>,"count":<n>}')`. The
random `r` exists for one reason: **Postgres de-duplicates identical
`(channel, payload)` notifications within a transaction**, so a constant
payload collapses N notifications into one.

`SqlDriver` emits a constant empty payload. Verified by reading
`lib/drivers/sql/dialect.ts`:

```sql
notifyingInsert: (statement, channel) =>
  `WITH written AS (${statement} RETURNING id)
   SELECT id, pg_notify('${channel}', '') FROM written`
```

and `#announce()` in `lib/drivers/sql/sql-driver.ts`, which sends
`SELECT pg_notify('<channel>', '')`.

`#insertRows` applies `notifyingInsert` to a **multi-row** insert, so a chunk
of N jobs calls `pg_notify` N times with an identical payload inside one
implicit transaction. **A bulk enqueue therefore delivers one notification, not
N.**

**That much is true. The latency consequence this section originally drew from
it is not — measured 2026-09-22, and the answer is a clean null.** The
conclusion below replaces it; the numbers now live beside the code, in the
comment above `notifyingInsert` in `lib/drivers/sql/dialect.ts`.

The objection came from the bun-jobs session and it holds in the code:
`LISTEN` delivers to **every** listening session and `Arrivals.#listen` fires
*every* waiter on the channel, so one notification wakes every idle worker
everywhere. Each then claims, and `BunQueueWorker.#iterate` returns as soon as
`claimed > 0` and claims again at once — **only an empty claim reaches
`#idle`**. One wake therefore drains a whole backlog, and `mark`/`take` covers
the race where a notification lands between an empty claim and the wait
registration.

Measured on PostgreSQL 16.15, four rounds interleaved against a unique-payload
variant (`pg_notify(channel, id::text)`), W idle workers × concurrency C, one
`addBulk` of N, medians in ms of add → first claim and add → last completion:

| | constant payload | unique payload |
|---|---|---|
| W1 C1 N50 *(1 vs 50 notifies)* | 12.2 / 59.4 | 12.6 / 62.1 |
| W1 C1 N500 | 23.5 / 547.6 | 23.7 / 564.0 |
| W4 C8 N500 | 23.8 / 73.6 | 23.5 / 74.0 |
| W16 C1 N500 | 23.4 / 129.6 | 28.3 / 119.2 |
| W16 C8 N500 | 24.0 / 61.1 | 28.8 / 62.6 |

**All 12 pairs tied inside the noise, in both directions**, across exactly the
two axes the objection said would decide it — claim batch against chunk size,
and how many workers listen. The `W1 C1 N500` row is the most informative:
547 ms to drain 500 jobs one at a time is the re-claim-after-success path
working. A `pollInterval` dependency would put a floor under that row, and
there is none.

A tie can hide a rare miss, so a second test was built to expose a lost wake —
four workers about to wait, three overlapping `addBulk`s per round with jitter,
and `pollInterval`/`maxBlock` at **10 s** so any missed wake would show as a
ten-second tail. 1,200 jobs over 240 adds: p50 4.7 ms, p99 14.7 ms, max
23.9 ms, nothing over a second, unique variant matching. **Caveat worth
keeping:** the collapse is *per transaction*, so those 240 adds were 240
notifications either way — that test stresses the wake path, not the collapse.
The collapse itself is exercised by the N50/N500 rows.

Two facts that finish it off: **nothing reads the payload** — `Arrivals.#listen`
registers a zero-argument callback that only counts — and MySQL, MariaDB and
SQLite have no `NOTIFY` at all, their `notifyingInsert` being the identity, so
none of this ever reached them.

**Verdict: no action. Leave the payload constant**, and do not "fix" it later
without re-reading this. The unique variant was, if anything, slightly *worse*
at W16 first-claim (28.3/28.8 against 23.4/24.0) — not real either, but it is
not a free change made for tidiness.

**Why this item is kept rather than deleted.** It is the third claim from this
survey to fall to someone reading the code instead of the summary, after
§3.8.2's stalled-grace premise and the advisory-lock lead that did not exist
anywhere in the codebase. The pattern across all three is worth more than any
one of them: **the survey's *observations* held up and its *consequences* did
not.** Graphile really does randomise its payload, Postgres really does
coalesce, and `SqlDriver` really does send a constant — every observable fact
was right. What was wrong every time was the inference about what those facts
cost in a system whose claim loop nobody had read. Treat a cross-project
comparison as a source of questions, not of conclusions.

#### (b) bun-jobs already dodged a Bun `worker_threads` trap — keep it that way

BullMQ carries a source comment citing `bullmq#2232`: **Bun ignores
`worker_threads` `stdin`/`stdout`/`stderr` options.**

**Corrected 2026-09-22, and the correction matters.** That is no longer true of
`node:worker_threads`: measured on Bun 1.4.3 by the bun-jobs session, a `Worker`
created there with `{ stdout: true }` yields a real stream carrying the child's
output, 3/3 runs, so `bullmq#2232` appears fixed for that API. **The trap is
still real for bun-jobs, for a different reason** — `runner/executors/worker.ts:56`
constructs the **global** `Worker`, whose `Bun.WorkerOptions` declares no
`stdin`/`stdout`/`stderr` at all (verified against bun-types 1.4.2: zero stdio
fields on the interface), so passing them leaves the streams `undefined`.
Anything that plans to pipe a *global* `Worker`'s stdio on Bun is building on
sand; `node:worker_threads` is no longer the cited hazard.

bun-jobs is already correct here, and for the stated reason —
`runner/protocol.ts` documents `captureConsole` as *"Set only for a `worker`
run, which shares no pipe with its parent"*, and `ExecutorEvents.onConsole`
exists precisely so a `worker`-mode run reports console output over the message
channel instead of a pipe, while `spawn` uses its pipes. That is the right
design arrived at independently. **The note here is defensive: do not
"simplify" `onConsole` into `onOutput` later.** A regression test that asserts
a `worker`-mode run still reports console output would lock it in.

#### (c) Sidekiq's process registry validates the worker inventory

Sidekiq's liveness is: `SADD processes <hostname:pid:nonce>`, plus a
self-expiring `<identity>` hash rewritten every **10 s** with a **60 s TTL**
carrying `busy`, `concurrency`, `rss` and `rtt_us` — and each beat `RPOP`s a
`<identity>-signals` list for remote quiet/stop.

That is `registerWorkerRecord` plus `workerControl.ts`, feature for feature,
including the three-intervals-then-lapse rule (`reportInterval` 10 s, record
lapses after three). Two details bun-jobs does not have and could take
cheaply: **an RTT measurement on each beat** (Sidekiq pings and warns above
50 ms — a direct read on driver health that costs one round trip per 10 s),
and **`rss`**, which makes "which replica is about to OOM" answerable from the
Workers page.

#### (d) `404` should not be retryable

Quirrel treats **HTTP 404 as `dontReschedule: true`**: a missing endpoint is
permanent, not transient. It is the one thing a pure 2xx/non-2xx contract
cannot express, and it costs one line.

§5.5 already has `handler-not-found` as a non-retryable *outcome*; this is the
transport-level twin — a `404` from the endpoint itself means the route is
gone, which no number of retries will fix. Fold it into §5.5's transport error
handling: `404` and `405` are configuration errors, and should trip the
circuit breaker and alert rather than burn a job's attempts.

## 4. Execution-target API design

### 4.1 The constraint that decides the shape

A processor is a closure. `#processor!(job, context)` holds a function value.
Nothing can serialise it, and no amount of protocol design changes that. So
there are exactly three ways for a job to reach code on the other side of a
boundary:

1. **A file path both sides can resolve** — what `FileTargetExecutor` does
   (it was `IsolatedProcessor` before Phase 1). Works for `"worker-thread"` and `"child-process"`, and for a file run
   `"in-process"`.
2. **A name both sides agreed on beforehand** — the registry. `JobDefinitions`
   already keys handlers by name; a remote executor publishes the names it can
   run and the gateway matches `record.name` against them. Works for
   `{ endpoint }`.
3. **Code shipped at deploy time** — out of scope; that is Trigger.dev's
   business model, not a library's.

So a processor file resolves through `Bun.resolveSync` (as
`resolveProcessorFile` does, `queue/workerTarget.ts:891-915`) and
`{ endpoint }` resolves through **names**. Two different
resolution stories, and the API must not pretend otherwise.

### 4.2 The new option

**Rewritten 2026-09-25 by the Phase 1 design check**, against `origin/develop`
at `688d376` (Phase 0 merged at `a29b06e`), and **reconciled the same day with
the implementation** on `feat/bun-jobs-worker-target` (base `688d376`). §4.2–§4.5
now describe what was built, not a proposal. Every `file:line` in them is
against that implementation; paths are under `packages/bun-jobs/` unless they
say otherwise. A citation of the code as it stood *before* Phase 1 is pinned
to its commit and written `688d376:<path>:<line>`, so it cannot drift. Four
decisions by the user frame it:

| # | Decision (the user's) | Consequence here |
|---|---|---|
| U1 | The local targets are **`"in-process"` \| `"worker-thread"` \| `"child-process"`** | JavaScript may yet gain real threads, and `"thread"` would then be ambiguous. `worker-thread` names what bun-jobs actually uses, a Web `Worker` (`runner/executors/worker.ts:68`). `child-process` is the symmetric name. The pair mirrors `node:worker_threads` and `node:child_process`, which is where a reader has met both words before |
| U2 | **`isolation` is replaced by `target`, not aliased.** Its worker-level spellings `"worker"` and `"spawn"` go with it | The text that stood here kept `isolation`, deprecated in docs, "because it is shipped". **That premise was false**: the packages are unpublished, which is the same fact `control-plane-rename.md` §1 built Phase 0 on. There is no compatibility obligation, so there is no alias, no deprecation and no dual-option `ConfigError` |
| U3 | **Runners are out of scope.** `ExecutionMode` (`"spawn" \| "worker" \| "in-process"`, `drivers/driver.ts:163`) does not change | It is persisted (`RunRecord.mode`, `driver.ts:179`; the stored `config:executionMode` and `config:allowed`) and on the wire (`EXECUTION_MODES`, `api/contract/constants.ts:564`; `ExecutionModeDto`, `api/contract/types.ts:2305`). The two vocabularies coexist until the runner follow-up (Phase 1r, §11), and §4.2.5 says where a user meets both |
| U4 | **`{ endpoint }` is Phase 2** | `WorkerTarget` ships without it, but every object form carries a `kind` discriminant, so Phase 2 widens the union without breaking a `switch` |

**The name `WorkerTarget` is free.** Phase 0 renamed the old addressee type
to `WorkerSelector` (decision D4 in `control-plane-rename.md`), and `git grep
-w WorkerTarget -- packages examples playground` finds nothing on `688d376`.

Every name below was approved by the user on 2026-09-25 (N1–N9, §4.2.7, which
records each choice, the alternatives it was chosen over, and why).

#### 4.2.1 The option

```ts
// On BunQueueWorkerOptions (queue/types.ts:1091-1129), replacing `isolation`
// and `isolationOptions` (688d376:packages/bun-jobs/lib/queue/types.ts:1091-1109).

/**
 * Where each attempt runs. Defaults to `"in-process"`.
 *
 * The worker always owns the claim, the lease and the settle; only the
 * *processor call* moves. Every write an attempt makes (progress, a log line,
 * a lock extension, `job.fail()`) still goes through the worker's own `Job`,
 * so it lands before the record of how the job ended, whichever target ran it.
 *
 * - `"in-process"`: call it on the claim loop's own thread. A function
 *   processor does this; a processor *file* is imported once and then called
 *   the same way.
 * - `"worker-thread"`: a fresh Web `Worker` per attempt, in this process. A
 *   separate JavaScript context that can be terminated. Needs a processor file.
 * - `"child-process"`: a fresh child process per attempt. The only target
 *   where a processor that ignores its signal is certain to be killed
 *   (`SIGTERM`, then `SIGKILL`). Needs a processor file.
 * - `{ kind, … }`: one of the three above, with its tuning. See
 *   {@link LocalWorkerTarget}.
 * - a {@link WorkerTargetFactory}: anything else, including a transport this
 *   package does not ship.
 *
 * Runners name the same two mechanisms differently: a runner's
 * `executionMode` says `"worker"` and `"spawn"`, a worker's target
 * `"worker-thread"` and `"child-process"` — different fields, in different
 * vocabularies. Inside the processor the runner's spelling survives: an
 * attempt on a worker thread runs with `BUN_JOBS_MODE=worker`, one in a
 * child process with `BUN_JOBS_MODE=spawn`.
 *
 * Not remotely configurable: changing where code runs is a rebuild.
 */
target?: WorkerTarget;
```

#### 4.2.2 The types

As implemented, abridged to the declarations (`lib/queue/workerTarget.ts:75-252`;
the file's own JSDoc is the fuller text):

```ts
// lib/queue/workerTarget.ts  (N4)

/**
 * The three places this machine can run an attempt. The string form of
 * {@link WorkerTarget}, the `kind` of its object form, and three of the
 * values of the heartbeat record's `target.kind`. (N1)
 */
export type WorkerTargetMode = "in-process" | "worker-thread" | "child-process";

/**
 * Where a worker's attempts run: the `target` option.
 * Phase 2 adds `RemoteEndpointTarget` (`{ kind: "endpoint", … }`, §4.2.8).
 */
export type WorkerTarget =
  | WorkerTargetMode
  | LocalWorkerTarget
  | WorkerTargetFactory;

/**
 * A local target with its tuning. The string `"child-process"` is exactly
 * `{ kind: "child-process" }`. (N2)
 */
export type LocalWorkerTarget =
  | InProcessTarget
  | WorkerThreadTarget
  | ChildProcessTarget;

/** `"in-process"` as an object, so every local mode has one. */
export interface InProcessTarget {
  /** Marks the variant: the processor runs on the claim loop's own thread. */
  kind: "in-process";
}

/** A fresh Web `Worker` per attempt. */
export interface WorkerThreadTarget {
  /** Marks the variant: a fresh `Worker` per attempt, in this process. */
  kind: "worker-thread";
  /**
   * After the worker asks an attempt to stop (a timeout, a lost lock, a
   * close), how long the attempt has to unwind before its `Worker` is
   * terminated, in milliseconds. Defaults to 5000 (`DEFAULT_CLOSE_TIMEOUT`,
   * `shared/constants.ts:28`).
   */
  closeTimeout?: number;
  /**
   * Options for each `Worker`: `env`, `argv`, `smol` and the rest. The
   * runner's `WorkerOptions` (`runner/types.ts:519`), unchanged.
   */
  worker?: WorkerOptions;
}

/** A fresh child process per attempt. */
export interface ChildProcessTarget {
  /** Marks the variant: a fresh child process per attempt. */
  kind: "child-process";
  /**
   * After the worker asks an attempt to stop, how long the child has to
   * unwind before it is sent `SIGTERM`, in milliseconds. Defaults to 5000.
   */
  closeTimeout?: number;
  /**
   * After `SIGTERM`, how long before `SIGKILL`, in milliseconds. Defaults to
   * 2000 (`DEFAULT_KILL_TIMEOUT`, `shared/constants.ts:31`).
   */
  killTimeout?: number;
  /**
   * Options for each child: `cwd`, `env`, `args` and the rest. The runner's
   * `SpawnOptions` (`runner/types.ts:495`), unchanged. `cwd` is also where a
   * relative processor file is resolved from, as it was for `isolation`
   * (`resolveWorkerTarget`, `queue/workerTarget.ts:482-489`).
   */
  spawn?: SpawnOptions;
}

/**
 * Builds the executor for a target this package does not ship: a gRPC pool,
 * a message bus, a platform SDK a published package must not depend on.
 * Called once, from the worker's constructor, after its `id` and logger
 * exist. Synchronous, because the constructor is; connect lazily in `run()`.
 */
export type WorkerTargetFactory = (
  context: WorkerTargetContext,
) => WorkerTargetExecutor;

/**
 * What a {@link WorkerTargetFactory} is told about the worker it serves.
 *
 * **There is deliberately no driver here, nor any driver configuration.** A
 * custom target reaches the store only through `attempt.job`, whose driver is
 * private to it (`Job`'s `readonly #driver`) — which is what keeps every write
 * an attempt makes on the attempt's own write lane, so I1–I3 (§4.5) hold for
 * a custom target by construction. Do not add one.
 */
export interface WorkerTargetContext {
  /** The namespace the worker consumes from. */
  namespace: string;
  /** The queue it consumes. */
  queue: string;
  /** The worker's incarnation id, `worker.id`. */
  workerId: string;
  /** The worker's logger, already bound to it. */
  logger: Logger;
  /**
   * What the worker was constructed with: a function, or the absolute path
   * a processor file resolved to. A target that ships attempts to code
   * deployed elsewhere may ignore it; one that wraps a processor (a warm
   * `Worker` pool, a tracing shim) runs it.
   */
  processor:
    | {
        /** The processor is a function. */
        kind: "function";
        /** The function itself. */
        fn: JobProcessor<unknown, unknown>;
      }
    | {
        /** The processor is a file. */
        kind: "file";
        /** Its absolute path, resolved at construction. */
        path: string;
      };
}

/**
 * Runs a worker's attempts somewhere this package does not know about.
 * What a {@link WorkerTargetFactory} returns. (N5)
 */
export interface WorkerTargetExecutor {
  /**
   * What this target is called, reported as the heartbeat record's
   * `target.name` and in log lines: `"grpc-pool"`, say. Free text, 1 to 64
   * characters. It is **not** an `ExecutionMode`, and it is never written to
   * run history.
   */
  readonly name: string;
  /**
   * Runs one attempt. Resolves with the processor's result; rejects with its
   * error. An error named `UnrecoverableJobError` ends the job's retries,
   * whether or not it is an instance of the class (`BunQueueWorker.ts:3231-3237`
   * matches by name for exactly this reason). Must stop promptly when
   * `attempt.context.signal` aborts: the worker aborts it on a timeout, a
   * lost lock or a close, and waits only a bounded time after that.
   */
  run: (attempt: WorkerTargetAttempt) => Promise<unknown>;
  /**
   * Releases what the target holds between attempts: a connection, a pool.
   * Optional. Called once from `worker.close()`, after the worker's attempts
   * have settled or been abandoned, and **bounded** like the built-in kinds'
   * stop: after `DEFAULT_CLOSE_TIMEOUT` (5000 ms) the worker logs a warning
   * and finishes closing without it, so a drain that never ends cannot hang a
   * shutdown. A rejection is logged the same way.
   */
  close?: () => void | Promise<void>;
}

/** One attempt, as a {@link WorkerTargetExecutor} is handed it. */
export interface WorkerTargetAttempt {
  /**
   * The worker's own `Job` for this attempt. **Every write the attempt makes
   * goes through it, never through the driver**: progress, a log line, a
   * lock extension, `fail()`. That is what puts those writes on the attempt's
   * `AttemptWrites` lane, which the worker settles before it records how the
   * job ended (§4.5, invariant I1).
   */
  job: Job<unknown, unknown>;
  /**
   * The claimed record, as stored: the serialisable view to send across a
   * boundary. The same value `job.toJSON()` returns (`queue/Job.ts:692`),
   * without the copy. Do not mutate it.
   */
  record: JobRecord;
  /**
   * The processor context: `signal`, `logger`, `heartbeat`, `log`,
   * `workerId`, `attempt`. `signal` is the worker's own abort signal for the
   * attempt.
   */
  context: ProcessorContext;
}
```

Every type these reference is a root export: `Job` (`lib/index.ts:515`),
`JobRecord` (`:286`), `JobProcessor` (`:536`), `ProcessorContext` (`:549`),
`Logger` (`:868`), `SpawnOptions` (`:756`) and `WorkerOptions` (`:762`). The
new names are exported beside them (`lib/index.ts:508` `defineProcessors`;
`:500`, `:514`, `:543` and `:592-598` the target types; `:892`
`WORKER_TARGET_KINDS`; `:905-906` `WorkerTargetInfo`/`WorkerTargetKind`; and
`queue/index.ts:209-222`), and each is listed in `consumer-check.json`.

**Why the tuning moved into the target.** `isolationOptions` was a sibling
option that applied to two of three modes, and its type let a `"worker"`
worker carry `spawn` options that were silently ignored
(`688d376:packages/bun-jobs/lib/queue/isolation.ts:64-76` was one flat
interface). A per-kind object makes `spawn` a type error on a `worker-thread`
target (asserted, with a negative control, in
`__tests__/workerTarget.type-test.ts`) and removes one option name. From plain
JavaScript the same mistake is a `ConfigError` (§4.2.3). The alternatives it
was chosen over are in §4.2.7, N2.

**No `file` on the target.** The draft's `LocalFileTarget` carried a `file`,
"so the file can be given here rather than to the constructor". The
constructor's `processor` argument already takes a path or a URL
(`BunQueueWorker.ts:906-911`, and `BunJobs.worker`, `BunJobs.ts:568-571`), so
a second place would buy only a rule for when the two disagree. Phase 2 can
revisit it, since an endpoint target needs no processor at all.

#### 4.2.3 Resolution and errors

Validation is `resolveWorkerTarget` (`queue/workerTarget.ts:434-490`), called
at the top of the constructor (`BunQueueWorker.ts:917-920`), before the worker
has any side effects. It builds nothing. In this order:

1. **A leftover `isolation` key** (plain JavaScript, or a cast) throws
   `ConfigError`: *`isolation was replaced by target: use target:
   "child-process" (was "spawn") or "worker-thread" (was "worker")`*
   (`:446-451`). This is not an alias, which U2 rules out. It exists because
   the silent alternative is dangerous: a file meant for a child process would
   run on the claim loop's thread, with nothing to say so. It costs one
   property read. **Implemented and tested**
   (`__tests__/worker-target.test.ts:728`). A leftover **`isolationOptions`**
   key throws too (`:452-457`): *`isolationOptions was replaced by target: give
   the settings on the target itself, as { kind: "child-process",
   closeTimeout, killTimeout, spawn } or { kind: "worker-thread",
   closeTimeout, worker }`*.
2. **A string or object target** must be one of the three modes
   (`toLocalTarget`, `:493-539`; the message is built by `notATarget`,
   `:408-427`). The old spellings get their own hint, because they are the
   runner's `executionMode` values, and a user who knows runners will type
   them:
   - `target must be "in-process", "worker-thread" or "child-process", not "thread"`
   - `target must be "in-process", "worker-thread" or "child-process", not "spawn": "spawn" is a runner's executionMode; a worker's is "child-process"`
   - the same for `"worker"`, pointing to `"worker-thread"`;
   - an object is described by its kind: `… not { kind: "remote" }`.

   These keep one prefix, `target must be`, so one pattern matches all of
   them. The old message was `isolation must be …`
   (`688d376:packages/bun-jobs/lib/queue/isolation.ts:128`), which
   `688d376:examples/bun-jobs/10-options/worker-isolation.ts:1102` asserts with
   `/isolation must be/`. That assertion moves to `/target must be/` in the
   examples PR.

   **Plain-JavaScript guards on the object form**, the runtime half of N2's
   type error: a setting that belongs to another kind throws *`target { kind:
   "worker-thread" } does not take spawn: it takes closeTimeout, worker`* (an
   in-process target "takes no settings"), and a `closeTimeout` or
   `killTimeout` that is not a finite, non-negative number throws *`target
   killTimeout must be a number of milliseconds, not …`* (`:510-534`). An
   `undefined` setting is ignored, and a `null` or `undefined` target is the
   default. **The object is copied** (`:536-538`), so a caller changing it
   later cannot retune a running worker.
3. **`"worker-thread"` or `"child-process"` with a function processor**
   throws: `target "child-process" needs a processor file: a function cannot
   be sent to another process or Worker`, with context `{ target:
   "child-process" }` (`:472-480`). The wording deliberately keeps `needs a
   processor file`, the old phrase
   (`688d376:packages/bun-jobs/lib/queue/BunQueueWorker.ts:907`), because
   three example checks match on exactly that and nothing else:
   `688d376:examples/bun-jobs/10-options/errors.ts:333` and
   `688d376:examples/bun-jobs/10-options/worker-isolation.ts:1072,1082`. With that phrase kept, they pass
   unchanged. Only their labels and the option keys they build with move.
4. **A factory** is accepted with either kind of processor (`:462-468`), and
   is called by `buildTargetExecutor` (`:717-767`) from the constructor at
   `BunQueueWorker.ts:1057`, once `this.id` (`:945`) and `#logger` (`:1047`)
   exist. Before Phase 1 the `IsolatedProcessor` was built before both
   (`688d376:packages/bun-jobs/lib/queue/BunQueueWorker.ts:916`), so the
   construction moved down while validation (steps 1–3, 5) stayed at the top.
   **What the factory returns is validated**: anything but `{ name, run,
   close? }` with a `name` of 1 to 64 characters and functions for `run` and
   `close` throws *`A target factory must return { name, run, close? }, with a
   name of 1 to 64 characters`* (`:740-758`).
5. **A file processor that does not resolve** keeps its message, `Cannot
   resolve the processor file …` (`queue/workerTarget.ts:907-914`), asserted by
   `688d376:examples/bun-jobs/10-options/worker-isolation.ts:1112`. A
   processor that is **neither a function nor a path or URL** (plain
   JavaScript) throws *`A worker's processor must be a function, or a
   processor file's path or URL`* (`:892-897`) rather than a `TypeError` from
   inside the resolver.

Every message above is asserted in `__tests__/worker-target.test.ts:638-768`
("target: resolution and errors"), and the factory's in `:917-938`.

`jobs.start()` (`BunJobs.ts:915-919`) takes the same options minus
`namespace`, `driver` and `concurrency`, and its processor is a function
(`:933-948`). So `target: "worker-thread"` there fails at step 3, as
`isolation: "worker"` did. The way to run a registry off-thread is a
`defineProcessors()` file (§4.4) given to `jobs.worker(...)`.

#### 4.2.4 The heartbeat record and `WorkerDto`: `target`

**This is the only new wire field in Phase 1.** `isolation` was never
persisted or sent anywhere. On `688d376`, `git grep -i isolat` finds nothing in
`lib/api/**` (the contract, `serialize.ts`, the schemas, the OpenAPI and
AsyncAPI emitters), nothing in `WorkerInfo`
(`688d376:packages/bun-jobs/lib/drivers/driver.ts:1426-1574`; now
`drivers/driver.ts:1427-1591`), nothing in `WORKER_CONFIG_KEYS`
(`shared/workers.ts:44-54`, `api/contract/constants.ts:488-498`), and nothing in the config-override
store (`WorkerConfigOverride`, `queue/workerControl.ts:206-217`). So its
removal needs no reader, and nothing stored changes.

It also needs no driver change. All five drivers store the record as one JSON
value: SQL `info` column (`drivers/sql/sql-driver.ts:4806-4817`), Redis
`JSON.stringify` (`drivers/redis/redis-driver.ts:2371-2386`), MongoDB `value`
(`drivers/mongo/mongo-driver.ts:4479-4494`), file (`drivers/file-driver.ts:2809-2813`)
and memory (`drivers/memory-driver.ts:1570-1580`). The queue-state fallback
stores the whole object too (`drivers/readApis.ts:601-625`).

**Where the types live.** `WorkerTargetInfo`, `WorkerTargetKind` and the
runtime copy of `WORKER_TARGET_KINDS` live in **`lib/shared/workers.ts`**
(`:220-263`), beside `WORKER_CONFIG_KEYS`, not in `driver.ts`. So the one
change inside `lib/drivers/**` is additive: `driver.ts` imports the type
(`:14`) and declares the field on `WorkerInfo` (`:1565-1579`). The contract
keeps its own browser-safe copy of the constant and the DTO, and drift tests
hold the two copies equal (below). As implemented:

```ts
// drivers/driver.ts:1565-1579, on WorkerInfo:

/**
 * Where this worker's attempts run, as it is actually running them.
 *
 * Written on every report from the same resolved target the worker dispatches
 * to, the way `sweeps` is written from the value maintenance branches on, so
 * the record cannot disagree with what the worker does.
 *
 * **Absent on a record from a worker older than this field, and absent is
 * not `"in-process"`.** `"in-process"` is the default, so reading absence as
 * in-process would confidently mislabel every worker that has not been
 * upgraded. Absent means "too old to say". Show it as unknown, never as a
 * default.
 */
target?: WorkerTargetInfo;

// shared/workers.ts:230-263
/**
 * A worker's target as its heartbeat record describes it: what it is, never
 * the option it was built from. A factory cannot be serialised, and a path is
 * deployment detail. (N6)
 *
 * The combinations that occur, since a function cannot be sent to a thread
 * or a process: `"in-process"` with `"function"` or `"file"`;
 * `"worker-thread"` and `"child-process"` with `"file"` only; `"custom"`
 * with `"function"` or `"file"`.
 */
export interface WorkerTargetInfo {
  /**
   * Where the attempts run: `"in-process"`, `"worker-thread"`,
   * `"child-process"` or `"custom"` (a {@link WorkerTargetFactory}). A closed
   * list, `WORKER_TARGET_KINDS`, that a reader can switch on. Phase 2 adds
   * `"endpoint"`, which widens it. A reader meeting a kind it does not know
   * shows the raw string.
   */
  kind: WorkerTargetKind;
  /**
   * Whether the attempts run a function or a processor file. The pairs that
   * occur: `"in-process"` + `"function"` | `"file"`; `"worker-thread"` +
   * `"file"`; `"child-process"` + `"file"`; `"custom"` + `"function"` |
   * `"file"`. (Checked against `resolveWorkerTarget` and `describeTarget`,
   * `queue/workerTarget.ts:434-490,773-785`, and asserted pair by pair in
   * `__tests__/worker-target.test.ts:1111`.)
   */
  processor: "function" | "file";
  /** For `"custom"`: the executor's own `name`. Absent for every other kind. */
  name?: string;
  /**
   * For a file processor: the absolute path it resolved to. The management
   * API omits it unless `serialize.exposeProcessorFiles` is on. (N7)
   */
  file?: string;
}

/** One of {@link WORKER_TARGET_KINDS}. (N8) */
export type WorkerTargetKind = (typeof WORKER_TARGET_KINDS)[number];

// shared/workers.ts:220-228 (runtime) and api/contract/constants.ts:473-481
// (browser-safe), each beside its WORKER_CONFIG_KEYS:
/** Every value a worker record's `target.kind` can take, for a UI to enumerate. */
export const WORKER_TARGET_KINDS = [
  "in-process",
  "worker-thread",
  "child-process",
  "custom",
] as const;
```

Why these choices, including where they depart from the bun-jobs session's
proposal:

- **A kind, not the option.** The record reports a descriptor with a closed
  `kind` and optional detail. That follows the bun-jobs session's point 8.
- **`"file"` is not a kind.** The bun-jobs session proposed `kind: "in-process"
  | "worker-thread" | "child-process" | "file" | "custom"`, and noted that a
  `"file"` kind would also need to say which mode it runs in. That note is the
  argument against it. A file processor runs in one of the three modes (an
  `"in-process"` file is imported once and called on the claim thread,
  `queue/workerTarget.ts:592-599`), so `"file"` answers a different question from
  the others. `kind` says where; `processor` says what. A UI then needs no
  second lookup to place a file worker.
- **A different field name from the runner's.** Workers report `target`, and
  runners keep `executionMode`/`mode` until Phase 1r. Calling the worker field
  `executionMode` for symmetry would make one field's vocabulary depend on who
  wrote it (the bun-jobs session's point 5).
- **The path is gated by a flag that defaults to `false`, not by
  `exposeHosts`.** The bun-jobs session proposed `exposeHosts`
  (`api/config.ts:192-197`). That defaults to `true`, so every deployment
  would publish filesystem paths. The precedent for exactly this information
  is the runner's handler file, gated by `exposeRunnerFiles`, default `false`
  (`api/config.ts:183-184`, applied at `api/serialize.ts:708`). The worker's
  processor file gets the same treatment under its own name (N7):
  `exposeProcessorFiles` sits beside it (`api/config.ts:185-191`), resolves to
  `false` (`:1490`), and is one of the four defaulted switches of
  `ResolvedJobsApiSerializers` (`:737-748`).

The DTO and the schema mirror it:

- `WorkerDto.target?: WorkerTargetInfoDto` in `api/contract/types.ts`
  (`:1886-1898`), right after `sweeps` (`:1863-1885`). Its JSDoc carries the
  same "absent is not `"in-process"`" paragraph that `sweeps` carries for
  "absent is not `false`", and says it is unrelated to a worker event
  envelope's `target`. `WorkerTargetInfoDto` itself is `:1716-1747`, with the
  reachable pairs in its JSDoc.
- The server's `WorkerDto` (`api/serialize.ts:353`) extends
  `Omit<WorkerInfo, "host" | "pid">`, so it inherits the field.
- `toWorkerDto` (`api/serialize.ts:813-894`) copies `kind`, `processor` and
  `name`, and copies `file` only with the flag (`:873-882`). It copies the
  field only when the record carries it, the same rule as `rssBytes` and
  `sweeps` (`:860-870`). **Its options type takes `exposeProcessorFiles` as
  optional** — `Pick<…, "exposeHosts"> & Partial<Pick<…,
  "exposeProcessorFiles">>` (`:814-816`) — and absent means off, so existing
  callers that pass only `exposeHosts` compile unchanged and withhold the path.
- The schema is `target: s.optional(WorkerTargetInfoSchema)` (`:246`) in
  `WorkerSchema` (`api/schemas/workers.ts:185-258`); the component itself is
  `:148-178`. It is **optional, not required**. The builder has no
  per-property description for a `$ref`, so the absent-is-unknown sentence and
  the reachable pairs live in the component's own `description`. It is
  named `"WorkerTargetInfo"`, not `"WorkerTarget"`: the repo's convention
  (`WorkerControlInfo` ↔ `WorkerControlDto` ↔ schema `"WorkerControl"`) would
  give the component the name of the *option* type, a different shape under
  the same name in the generated document.
- **Drift guards, updated:** the `DeepEqual<Contract.WorkerDto,
  Infer<typeof WorkerSchema>>` assertion
  (`__tests__/api/api-contract.type-test.ts:539`), now joined by
  `WorkerTargetInfoOk` (`:544`), `WorkerTargetKindsValueOk` (`:1513`) and
  `WorkerTargetInfoRuntimeOk` (`:1520`), which hold the runtime and contract
  copies equal; the value check in `api-contract.test.ts`; and the round trip
  (`__tests__/api/api-sources.test.ts:731-737`), whose fixture now carries
  `target` with a `file` and passes `exposeProcessorFiles: true`, and whose
  second assertion checks the path is withheld without it. The OpenAPI
  component list pinned in `__tests__/api/api-workers.test.ts` gains
  `"WorkerTargetInfo"`.
- **A near-collision to know about.** A worker *event*'s envelope already has
  a `target` field, holding the **queue name** (`api/contract/ws.ts:243-253`,
  `shared/events.ts:148`). No worker event payload carries a `WorkerDto`
  (`ws.ts:151-162`), so the two never nest in one object. But a client reads
  both, and the `WorkerDto.target` JSDoc and the schema description say that
  it is unrelated to the envelope's `target`.

The UI renders absent as "—" (the UI session's rule). Nothing in Phase 1 adds
a `?target=` filter to `GET /workers`; the UI filters client-side if it wants
to.

#### 4.2.5 Two vocabularies, until Phase 1r

A worker says `worker-thread`/`child-process`; a runner still says
`worker`/`spawn`. Both describe the same executors, so a reader meets both:

| Worker `target` | Runner `executionMode`, `RunRecord.mode`, `EXECUTION_MODES` | `BUN_JOBS_MODE` in the child |
|---|---|---|
| `"in-process"` | `"in-process"` | unset |
| `"worker-thread"` | `"worker"` | `worker` (`runner/executors/worker.ts:76`) |
| `"child-process"` | `"spawn"` | `spawn` (`runner/executors/spawn.ts:110`) |

What stays in the runner's vocabulary on purpose, because it is the runner's
protocol and U3 leaves it alone:

- the `BUN_JOBS_MODE` value a job child sees;
- the internal `RunContext.mode` the target builds for the shared executors.
  Before Phase 1 it was `mode: this.mode`
  (`688d376:packages/bun-jobs/lib/queue/isolation.ts:167`), which worked only
  because the two vocabularies were identical. It is now `mode:
  RUNNER_MODE[target.kind]` (`queue/workerTarget.ts:613`), where `RUNNER_MODE`
  (`:371-376`) maps `"worker-thread"` → `"worker"` and `"child-process"` →
  `"spawn"`, and the executor choice in `#executorFor` (`:698-709`) switches on
  the target's kind;
- `SerializableContext.mode` (`runner/protocol.ts:55`).

A job's processor never sees `RunContext`. It gets a `ProcessorContext`, built
in the child by `isolatedJob` (`runner/bootstrap/child-runtime.ts:545-556`),
which carries no mode. So the only runner spelling a processor can observe is
the environment variable. `__tests__/worker-target.test.ts:103` asserts it per
target: `spawn` for child-process, `worker` for worker-thread, unset
in-process.

**The mapping sentence must appear, verbatim in meaning, in:**

- the `target` JSDoc (§4.2.1, `queue/types.ts:1120-1125`) and the
  `WorkerTargetMode` JSDoc (`queue/workerTarget.ts:71-73`) — done;
- the README's target section (`README.md:2410-2422`, with the table), and
  the runner's `executionMode` row (`README.md:2592`) — both done;
- `examples/bun-jobs/10-options/worker-isolation.ts` and
  `examples/bun-jobs/07-runner/execution-modes.ts`, which show a worker's
  target beside a runner's mode (the examples session's requirement; the
  stacked examples PR). `688d376:examples/bun-jobs/10-options/worker-isolation.ts:237-239` asserts `BUN_JOBS_MODE === mode`, which goes
  from true to false once `mode` is `"worker-thread"`. That is a runtime
  coupling the compiler cannot see; it must compare against the mapped value.
  `:1158` and `:1164` compare `BUN_JOBS_MODE` with the literals `"spawn"` and
  `"worker"`, stay correct, and are the natural place to show the mapping;
- the playground's `processors/checksum.ts:77` and `processors/preview.ts:66`,
  which report `BUN_JOBS_MODE` under a field called `isolation` (the UI
  session's rewrite).

#### 4.2.6 Why the factory does not return the runner's `Executor`

The draft said a custom target "is an `Executor` whose `mode` is a string of
its own". That does not type-check. `Executor.mode` is the closed,
persisted `ExecutionMode` (`runner/executors/executor.ts:136`), and
`ExecutorStartOptions.file` is required (`:101`). Widening either would widen
a persisted enum or make every runner executor handle a missing file.

Wrapping `Executor` was considered and rejected, because what a job needs from
a target is much smaller than what `Executor` carries:

- `Executor.start()` takes a runner's `RunContext`: `runId`, `runnerId`,
  `source`, `args`, `deadline` and run-log callbacks. For a job the target has
  to fabricate all of it with no-op functions. `FileTargetExecutor.run` does
  exactly that (`queue/workerTarget.ts:604-627`), and its comment at
  `:619-621` says so.
- `ExecutorEvents` are runner-shaped: `onOutput`, `onPid`, `onConsole`
  (`executor.ts:47-84`).
- The job-channel request/reply (`JOB_CHANNEL`, `answer()` and `valueFor()`,
  `queue/workerTarget.ts:788-888`) is internal protocol that no third party
  should implement.
- `ExecutorHandle.stop` duplicates the abort signal the worker already owns.
  `FileTargetExecutor.run()` only ever turns the signal into `stop()`
  (`:669-675`, removed again at `:693`).

What the worker actually needs is visible in `#process()`
(`BunQueueWorker.ts:2260-2274`): a promise of the result, cancelled through
the attempt's signal, with `withTimeout` and the settle path left to the
worker. `WorkerTargetExecutor.run()` is that and nothing more. It has no
`mode` (the record's `kind` is `"custom"`, and `name` carries the free text),
and it has no `file` (the factory gets the processor in its context if it
wants it). Both of the draft's problems go away by construction.

The built-in file targets are one internal implementation of the same
interface: `FileTargetExecutor` (`queue/workerTarget.ts:556-710`, N3; it was
`IsolatedProcessor`), whose `name` is its kind (`"child-process"`, say,
`:558`). So `#process()` has one call for every non-function path. The Phase 2 gateway (`RemoteTarget`) implements it
too, rather than the runner's `Executor`, and §4.6's `execute` facet sits
behind it.

#### 4.2.7 Names approved (2026-09-25)

The "Replaces" column cites the code as it stood before Phase 1, pinned to
`688d376`; every name in the "Approved" column is implemented as written.

The user approved every name the replacement forces, in each case the
candidate this check recommended. "Unused" in the last column means `git grep
-I -i -w '<name>' -- packages examples playground` printed nothing on
`688d376`.

| # | Replaces | **Approved** | Chosen over | Reason | Collision check |
|---|---|---|---|---|---|
| **N1** | `IsolationMode` (`688d376:packages/bun-jobs/lib/queue/isolation.ts:61`, root export `688d376:packages/bun-jobs/lib/index.ts:513`), and the worker-level spellings `"worker"`/`"spawn"` | **`WorkerTargetMode`** = `"in-process" \| "worker-thread" \| "child-process"`; `IsolationMode` is **removed**, not renamed in place | `LocalTargetMode`; `WorkerTargetKind` | Its values change (U1), so it is a new type, not a rename. `WorkerTargetMode` keeps the `WorkerTarget*` family and is the name the draft already used. `WorkerTargetKind` is kept for the record's wider union (N8) | unused in code |
| **N2** | `IsolationOptions` (`688d376:packages/bun-jobs/lib/queue/isolation.ts:64`, root export `688d376:packages/bun-jobs/lib/index.ts:514`) and the option `isolationOptions` | **Per-kind target objects, no options type**: `LocalWorkerTarget` = `InProcessTarget` \| `WorkerThreadTarget` (`closeTimeout?`, `worker?`) \| `ChildProcessTarget` (`closeTimeout?`, `killTimeout?`, `spawn?`), with the string modes as shorthand. The target has no `file` field: the processor file is the constructor's processor argument | (b) the draft's `{ kind: "file", file, mode, options }` with `LocalTargetOptions`; (c) a sibling `targetOptions: WorkerTargetOptions` | Removes an option, makes options for the wrong kind (`spawn` on a `worker-thread` target) a type error where today they are silently ignored, and gives Phase 2's `{ kind: "endpoint", … }` a uniform place. (b) mixes *where* with *what* and needs a rule for a file given twice; (c) is the smallest diff and keeps the flaw | all unused |
| **N3** | `IsolatedProcessor` (`688d376:packages/bun-jobs/lib/queue/isolation.ts:105`; root export `688d376:packages/bun-jobs/lib/index.ts:512`, `688d376:packages/bun-jobs/lib/queue/index.ts:29`) | **`FileTargetExecutor`, internal** (not exported from `lib/index.ts` or `lib/queue/index.ts`); now `queue/workerTarget.ts:556`, and its `name` is its kind | `LocalTargetExecutor`, internal; public `ProcessorFileExecutor` | It was exported as a value, but no consumer could use it: `run()` took a `Runner` whose type is not exported (`688d376:packages/bun-jobs/lib/queue/isolation.ts:95-102`). Nothing outside `lib/` constructed it, and `consumer-check.json` did not list it. Making it internal removes a public name instead of renaming one | unused |
| **N4** | the file `lib/queue/isolation.ts` | **`lib/queue/workerTarget.ts`**, moved with `git mv` as its own step | `lib/queue/target.ts`; `lib/queue/targets.ts` | Matches its neighbours `workerControl.ts`, `workerMetrics.ts`, `attemptWrites.ts`; a separate move keeps blame following the file | no such file in the repo |
| **N5** | (new) what a `WorkerTargetFactory` returns | **`WorkerTargetExecutor`** (`{ readonly name; run(attempt); close?() }`), with **`WorkerTargetAttempt`** and **`WorkerTargetContext`**; the factory is `(ctx: WorkerTargetContext) => WorkerTargetExecutor` | `TargetExecutor` / `TargetAttempt`; `AttemptRunner` | Keeps the family prefix, so `WorkerTarget`, `WorkerTargetFactory` and `WorkerTargetExecutor` read as one API. `TargetExecutor` reads as the runner's `Executor` family (`SpawnExecutor`, `WorkerExecutor`) | all unused |
| **N6** | (new) the record's field and its types | field **`target`**; types **`WorkerTargetInfo`** (runtime, in `shared/workers.ts`; §4.2.4) / **`WorkerTargetInfoDto`** (contract); OpenAPI schema **`"WorkerTargetInfo"`** | `WorkerTargetDto` with schema `"WorkerTarget"`; a field named `runtime` | The field has the option's name. `Info`/`Dto` keeps the house pairing while avoiding a schema component that shares its name with the option type (§4.2.4). `runtime` would collide with Phase 2's `remote.runtime` and with "runtime" meaning Bun | types unused. `target` exists on event envelopes (the queue name) and validation issues, never on a worker record |
| **N7** | (new) the flag that exposes the processor file path | **`exposeProcessorFiles`**, default `false`, beside `exposeRunnerFiles` in `api/config.ts` | reuse `exposeRunnerFiles`; reuse `exposeHosts`; no `file` on the record | The runner's handler path is the same kind of information and is off by default. `exposeRunnerFiles` would misname it; `exposeHosts` defaults to `true` and would publish paths everywhere | unused |
| **N8** | (new) the record's `kind` union and its constant | **`WorkerTargetKind`** / **`WORKER_TARGET_KINDS`** | `WorkerTargetInfoKind` / `WORKER_TARGET_INFO_KINDS` | Mirrors `WorkerConfigKey` / `WORKER_CONFIG_KEYS` | both unused |
| **N9** | the child-side `IsolatedJob`, `IsolatedJobProcessor` (`runner/executors/executor.ts:157,168`) and the message `job.X() is not available in an isolated job` (`runner/bootstrap/child-runtime.ts:434`) | **kept, unchanged** | `TargetJob` / `TargetJobProcessor` | They live in `lib/runner/**`, and the child's job *is* isolated from the driver. The message is asserted at runtime by `__tests__/worker-target.test.ts:568,594` (renamed from `worker-isolation.test.ts`) and the examples. Keeping them keeps a runner-owned surface out of this PR | — |

Also new and unambiguous, so never a choice: `defineProcessors` (§4.4) and
`WorkerTargetFactory`.

#### 4.2.8 Phase 2, not shipped in Phase 1: `RemoteEndpointTarget`

Kept here because the union above must leave room for it. It joins
`WorkerTarget` as `{ kind: "endpoint", … }`, and `WORKER_TARGET_KINDS` gains
`"endpoint"`, which is a contract change the UI must handle. Its shape and
JSDoc are as the 2026-09-22 draft wrote them, **revised 2026-09-25 for
multiple transports**: `url`'s scheme now picks the binding, a reversed
binding uses `listen` instead of `url`, and the transport fields (`listen`,
`binding`, `tls`, `sessions`, `heartbeat`, `health`, `httpVersion`) come from
`RemoteEndpointTransportOptions`, whose definition and JSDoc are
[`remote-transports.md`](remote-transports.md) §8.2. Only `url`/`listen`,
`secret` and the `kind` are settled; the rest is Phase 2's to confirm against
§5 and `remote-transports.md`. A plugin transport is passed as `provider`
instead (`compute-provider-plugins.md` §8.2), of which this target is the
shorthand.

```ts
/**
 * A conforming remote executor, reached over any first-party binding. See §5
 * and `remote-transports.md`. PHASE 2.
 */
export interface RemoteEndpointTarget extends RemoteEndpointTransportOptions {
  /** Marks the variant. */
  kind: "endpoint";
  /**
   * Where the remote executor is. Its scheme picks the binding:
   * `https://worker.example.com/bun-jobs` (streamed where the executor
   * advertises it, else unary), `wss://…`, `tcp+tls://host:port`,
   * `tcp://host:port` (frames sealed), `unix:///path`, `udp://host:port`
   * (frames sealed; experimental). `http:` and `ws:` for loopback only.
   * Exactly one of `url` and `listen` (a reversed binding, where executors
   * dial this worker) is given (`remote-transports.md` §8.1).
   */
  url?: string;
  /**
   * The shared secret used to sign every request and verify every response,
   * as `WORKER_PROTOCOL_VERSION` §5.6 defines. At least 32 bytes. Read it
   * from the environment; never commit one.
   *
   * An array rotates keys: requests are signed with the first, and a
   * response signed with any of them verifies. Rotate by prepending, deploy,
   * then drop the old one.
   */
  secret: string | string[];
  /**
   * How long one invoke may take before the worker gives up on the response,
   * in milliseconds. Defaults to the endpoint's reconciled `maxDurationMs`:
   * the smaller of the transport's declared limit and the remote's handshake
   * (§5.4, `compute-provider-plugins.md` §8.3). For a batch, it applies to
   * the whole invoke.
   *
   * It is independent of `lockDuration`, and may be larger (decided
   * 2026-09-25, `remote-transports.md` Q-T12): the worker renews
   * the lease on its own timer for the whole call
   * (`BunQueueWorker.ts:2228-2232`, `#heartbeat()` at `:3429-3458`; §5.9
   * option A), so no lease lapses while an invoke is in flight. The job's own
   * `timeout` still bounds each attempt, because the worker already wraps
   * the target's `run()` in it (`BunQueueWorker.ts:2269-2274`), and a job
   * whose `timeout` exceeds `maxDurationMs` is refused at claim time (§5.9).
   * So the effective bound is `min(job timeout, this)`.
   *
   * On `http` (unary) this is the only thing that detects a remote that
   * hangs; on the streaming and session bindings heartbeat loss detects it
   * sooner (`remote-transports.md` §5.6).
   *
   * **Implementer to confirm** (proposed 2026-09-25): the default. The
   * draft's `min(lockDuration, job.opts.timeout || ∞) − heartbeatInterval`
   * rested on the lease lapsing mid-call, which it does not. The alternative
   * considered was a fixed ceiling (15 min, say): rejected as a default
   * because it is wrong for both a 30 s Lambda and a 60 min Cloud Run
   * request, while `maxDurationMs` is already the platform's own figure.
   * Where `maxDurationMs` is large and the binding is unary, set this
   * explicitly: a hung remote holds a slot, bounded by `maxInFlight`, until
   * it passes (§10.4).
   */
  timeout?: number;
  /**
   * How many attempts may be in flight to this endpoint at once. Defaults to
   * the worker's `concurrency`. Lower it when the endpoint's own concurrency
   * is the scarce resource — a Lambda reserved-concurrency cap, say.
   */
  maxInFlight?: number;
  /**
   * How many attempts to send in one invoke. `1` (the default) is one job
   * per invoke (per HTTP call, on the HTTP bindings). Above that, the gateway fills a batch for up to
   * `batchWindow` ms and the remote answers one outcome per job — which is
   * what makes a per-invocation-billed target affordable (§9).
   * Capped by the remote's advertised `maxBatch` (§5.4).
   */
  batch?: number;
  /** How long to wait to fill a batch, in ms. Defaults to `0`. */
  batchWindow?: number;
  /**
   * Job names this endpoint may run. Unset, the gateway asks the endpoint
   * (`GET`, §5.3) and caches the answer for `introspectTtl`. A claimed job
   * whose name is on no endpoint fails with `HandlerNotFoundError`, which is
   * not retryable.
   */
  names?: string[];
  /** How long an introspection answer is trusted, in ms. Defaults to `60_000`. */
  introspectTtl?: number;
  /** Extra headers on every request of the HTTP bindings, and on a WebSocket upgrade — a platform's own auth, a trace header. Ignored by `tcp`, `unix` and `udp`. */
  headers?: Record<string, string>;
  /**
   * How a failed *transport* is retried before the attempt is failed:
   * a connect error, a 5xx, a 429 with `Retry-After`, an invoke never
   * `accepted` on a streaming or session binding. Defaults to three
   * tries with jittered backoff, bounded by `timeout`. A transport retry is
   * **not** a job attempt: `attemptsMade` does not move, and the idempotency
   * key is unchanged, so a remote that already ran it answers from its cache
   * (§5.8).
   */
  transportRetry?: {
    /** Tries in all, the first included. Defaults to `3`. */
    attempts?: number;
    /** The longest backoff between two tries, in ms. */
    maxDelay?: number;
  };
}
```

Phase 2 also adds `endpoint` (the origin only) and `remote` (with the
binding and the endpoint's health, `remote-transports.md` §12) to
`WorkerTargetInfo` (§8.1). The endpoint's `processor` question does not arise:
a Phase 2 endpoint worker is built by `jobs.remoteWorker(queue, endpoint)`,
which needs no processor argument.

### 4.3 What changes inside `BunQueueWorker`

Small and localised. As implemented: the left column pins the code before
Phase 1 to `688d376`, the right one cites the implementation.

| Where, before (`688d376`) | Change, as implemented |
|---|---|
| `688d376:packages/bun-jobs/lib/queue/types.ts:28` imported `IsolationMode`, `IsolationOptions` from `./isolation`; `:1091-1109` declared `isolation?` and `isolationOptions?` | one option, `target?: WorkerTarget` (`queue/types.ts:1091-1129`, §4.2.1), imported from `./workerTarget` (`:30`, N4) |
| constructor, `688d376:packages/bun-jobs/lib/queue/BunQueueWorker.ts:900-921`: the function-processor check (`:901-911`), then `new IsolatedProcessor(processor, options.isolation ?? "in-process", options.isolationOptions)` (`:916-920`) | validation (§4.2.3 steps 1–3 and 5) at the top, `resolveWorkerTarget` (`BunQueueWorker.ts:917-920`). The executor is built **after `this.id` (`:945`) and `#logger` (`:1047`)**, by `buildTargetExecutor` (`:1057-1062`), because a factory's context needs both. Two fields result: `#target: WorkerTargetExecutor \| undefined` (`:601`; undefined only for a function processor with an in-process target) and `#targetInfo: WorkerTargetInfo` (`:606`), derived once by `describeTarget` from the same resolved target (`:1063`) |
| `#isolated` field, `688d376:packages/bun-jobs/lib/queue/BunQueueWorker.ts:589` | became `#target` (above) |
| `#process()`, `688d376:packages/bun-jobs/lib/queue/BunQueueWorker.ts:2217-2229`: `this.#isolated ? this.#isolated.run(job, record, context, controller, { namespace, queue, workerId }) : Promise.resolve(this.#processor!(job, context))` | `this.#target ? this.#target.run({ job, record, context }) : Promise.resolve(this.#processor!(job, context))` (`BunQueueWorker.ts:2260-2266`). **The function-processor branch is byte-identical**: it is the hot path the bench guard measures, and an attempt object per job there buys nothing. The diff touches only the condition and the target branch, and `#target` is undefined in exactly the case `#isolated` was. `controller` is no longer passed: `context.signal` *is* `controller.signal` (`:2240`), and it was the only use of `controller` inside the target. The per-worker runner identity moved to `FileTargetExecutor`'s constructor and the factory's context, given once |
| the timeout, the abort, the heartbeat interval, `AttemptWrites` and the settle path (`688d376:packages/bun-jobs/lib/queue/BunQueueWorker.ts:2160`, `:2231-2248`, `#awaitWrites` `:2334-2360`) | **untouched** (now `BunQueueWorker.ts:2203`, `:2267-2290`, `#awaitWrites` `:2371-2397`). See §4.5's invariants |
| `close()`: `#unregister()` on both paths (`688d376:packages/bun-jobs/lib/queue/BunQueueWorker.ts:1623` forced, `:1675` normal) | `await this.#closeTarget()` just before each (`BunQueueWorker.ts:1630` forced, `:1683` normal), once the active attempts have settled or been abandoned. `#closeTarget` (`:1708-1733`) calls the target's optional `close()` **bounded by `DEFAULT_CLOSE_TIMEOUT`** (5000 ms, the built-in kinds' `closeTimeout` default): **on expiry or rejection it logs at `warn` and continues closing**, since the worker's own state has settled by then. It is new: `IsolatedProcessor` held executors and never released them — harmless for the built-in ones (`FileTargetExecutor` has no `close`), but not for a custom target holding a connection. **Gate test:** `__tests__/worker-target.test.ts:983`, a target whose `close()` never resolves, must not stop `worker.close()` returning; its negative control, run side by side, is the same `close()` awaited without a bound, which must still be pending when the bounded close has returned. Removing the bound was measured to fail it ("closed" expected, "hung" received). A rejecting `close()` is covered at `:1040`, and close ordering and once-only at `:940` |
| `#report()`, the `registerWorkerRecord` call at `688d376:packages/bun-jobs/lib/queue/BunQueueWorker.ts:4139-4165` | `target: this.#targetInfo` (`BunQueueWorker.ts:4206`) beside `sweeps: this.#sweeps` (`:4202`), which is the precedent: written from the value the worker acts on. It is always written, so absence means only an older worker |
| `688d376:packages/bun-jobs/lib/queue/isolation.ts` → `queue/workerTarget.ts` | moved with `git mv` first. `IsolatedProcessor` became the internal `FileTargetExecutor` (`queue/workerTarget.ts:556-710`, N3), implementing `WorkerTargetExecutor`, with `name` set to its kind (`:558`). Its constructor validation (`688d376:packages/bun-jobs/lib/queue/isolation.ts:126-131`) became §4.2.3's messages in `resolveWorkerTarget`; its executor choice (`#executorFor`, `:698-709`) switches on the kind; `RunContext.mode` is mapped to the runner vocabulary (`:613`, §4.2.5). `defineProcessor` (`:271-275`) moved with it, unchanged, beside the new `defineProcessors` (§4.4) |
| `688d376:packages/bun-jobs/lib/queue/index.ts:27-32`, `688d376:packages/bun-jobs/lib/index.ts:506-514` | export `defineProcessors`, `WorkerTarget`, `WorkerTargetMode`, `LocalWorkerTarget` and its three members, `WorkerTargetFactory`, `WorkerTargetContext`, `WorkerTargetExecutor` and `WorkerTargetAttempt` (`queue/index.ts:209-222`; `lib/index.ts`, §4.2.2), plus `WORKER_TARGET_KINDS`, `WorkerTargetKind` and `WorkerTargetInfo` from `shared/workers.ts`. `IsolatedProcessor`, `IsolationMode` and `IsolationOptions` are no longer exported (removed, not aliased) |
| `drivers/driver.ts` `WorkerInfo`, `api/contract/constants.ts`, `api/contract/types.ts` `WorkerDto`, `api/schemas/workers.ts` `WorkerSchema`, `api/serialize.ts` `toWorkerDto`, `api/config.ts` (the N7 flag) | §4.2.4, with every citation there. `lib/drivers/**` changed only additively (`driver.ts:14` import, `:1565-1579` the field) |
| nothing else | claim, lease, settle, control, limits, maintenance and `WORKER_CONFIG_KEYS` are unaware. `target` is **not** a remotely configurable key: changing where code runs is a rebuild, and `WORKER_CONFIG_KEYS` admits only what "can be applied to a running worker in place" (`shared/workers.ts:36-43`) |

**That is the whole point of the design.** The lease stays with the process
that holds the driver. No new failure mode is introduced into claiming.

### 4.4 The processor file / registry resolution story

A file target and the definition registry are two ways of answering "what runs
this job", and they compose:

- **One file, one processor.** `export default defineProcessor(...)`. The
  worker dispatches on nothing; every claimed job goes to that function. This
  is what shipped before Phase 1.
- **One file, many names.** The file imports the app's definitions and
  default-exports a dispatcher. Nothing new is needed — but it is boilerplate
  everybody writes, so Phase 1 adds `defineProcessors`
  (`queue/workerTarget.ts:277-351`, root export `lib/index.ts:508`). As
  implemented:

```ts
/**
 * One entry defineProcessors dispatches to: a name and its handler, which is
 * the part of a JobDefinition a processor file needs. Any handler fits — its
 * job's data and result types are its own.
 */
interface ProcessorDefinition {
  readonly name: string;
  /**
   * A method, deliberately: its parameter is then checked both ways, so a
   * handler typed for its own data fits, and an inline one is still handed a
   * `Job` rather than `never`.
   */
  // eslint-disable-next-line ts/method-signature-style
  handler(job: Job<unknown, unknown>, ctx: ProcessorContext): unknown;
}

/**
 * A processor that dispatches on the job's name: one processor file for many
 * job names. Takes what `BunJobs.define()` records — `jobs.definitions()`, a
 * JobDefinitions, or plain `{ name, handler }` objects. A job whose name has no
 * definition fails with an UnrecoverableJobError. A name given twice keeps the
 * later handler, as a second `define()` does.
 */
export function defineProcessors(
  definitions: readonly ProcessorDefinition[] | JobDefinitions,
): JobProcessor<unknown, unknown>;
```

  **Why this input type.** The draft's `readonly JobDefinition<any, any>[]`
  needs a lazy `any`. `JobDefinition<never, never>` rejects any handler that
  returns something (`Promise<number>` is not `Promise<never>`), and a
  property typed `(job: never, …) => unknown` accepts every handler but hands
  an inline one `job: never`. A method signature is bivariant in its
  parameter under `strictFunctionTypes`, so a handler written for
  `Job<{ to: string }, number>` fits, `jobs.definitions()` fits, and an inline
  `async (job) => job.name.length` gets a real `Job`. All three are asserted in
  `__tests__/workerTarget.type-test.ts`, beside a negative control (a
  definition without a handler). Entries are checked at runtime too: a missing
  or empty `name`, or a `handler` that is not a function, throws `ConfigError`
  (`:323-332`).

  **Why `UnrecoverableJobError`, not `HandlerNotFoundError`.** An unknown name
  throws `new UnrecoverableJobError('No processor is defined for "<name>" in
  this processor file', { name, defined })` (`:343-348`). `HandlerNotFoundError`
  does not exist until Phase 2 (§11), and `UnrecoverableJobError` is what the
  worker already recognises **by name** as well as by class
  (`BunQueueWorker.ts:3231-3237`) — which is what makes an error rebuilt on
  the far side of a child process stop the retries. Measured: an unknown name
  with `attempts: 3` dies after one attempt, in-process and under
  `target: "child-process"` (`__tests__/worker-target.test.ts:1205`).

- **A separate Bun process from a runner file.** Already composable and should
  stay that way rather than becoming an option — a file that builds a
  `BunJobs`, calls `jobs.worker(...)`, and `await worker.run()`, started by
  `BunRunner` with `mode: "spawn"` and `single: true`. Add it to the README
  and to `examples/bun-jobs/07-runner/` rather than to the API. A `target`
  value that forked *the whole worker* would have to move the driver config,
  the control subscription and the heartbeat record into the child, and would
  then be a second, worse `BunRunner`.

### 4.5 Backward compatibility, and what must not change

**There is no compatibility to keep for `isolation`.** The 2026-09-22 text
here kept `isolation`, `IsolationMode`, `IsolationOptions` and
`IsolatedProcessor` exported "with their current types", mapped
`isolation: m` to `target: m`, and made giving both a `ConfigError`. All of
that rested on the premise that `isolation` is shipped. It is not: the
packages are unpublished (U2, and `control-plane-rename.md` §1 for the same
fact). So in Phase 1 `isolation`, `isolationOptions`, `IsolationMode`,
`IsolationOptions` and the worker-level spellings `"worker"`/`"spawn"` are
**removed**, not aliased, and `IsolatedProcessor` became internal (N3). The
only trace left is the guard in §4.2.3 step 1 — implemented and tested, for
both `isolation` and `isolationOptions` — which throws; it does not
translate.

**Nothing persisted or on the wire changes because of the removal.**
`isolation` was never written anywhere (§4.2.4). The one wire change in
Phase 1 is an **addition**, the optional `target` on the worker record and
`WorkerDto`. A reader older than Phase 1 ignores it, and a reader newer than a
worker sees it absent.

**The runner's `ExecutionMode` is untouched, and this plan should not be
talked out of that inside Phase 1.** `"spawn" | "worker" | "in-process"`
(`drivers/driver.ts:163`) is stored in `RunRecord.mode` (`:179`) inside every
driver's history blob. It is stored in the runner's `config:executionMode` and
`config:allowed` entries (`runner/config.ts:38-58`, the do-not-change list in
`control-plane-rename.md` §6.1). It is the API's `EXECUTION_MODES`
(`api/contract/constants.ts:564`) and `ExecutionModeDto`
(`api/contract/types.ts:2305`, used at `:2329,2421,2439,2478,2522`). It is the
value of `BUN_JOBS_MODE` in every child (`runner/executors/spawn.ts:110`,
`worker.ts:76`). Renaming it is a migration: a reader that accepts both
spellings, a DTO change, and a sweep of the UI and the examples. That is
Phase 1r (§11), deliberately separate so that Phase 1 carries no migration.

#### Do not change: strings

- **The runner vocabulary:** `ExecutionMode`, `EXECUTION_MODES`,
  `ExecutionModeDto`, `RunRecord.mode`, `config:executionMode`,
  `config:allowed`, `SerializableContext.mode` (`runner/protocol.ts:55`),
  `CHILD_ENV` and the `BUN_JOBS_MODE` values, and the internal check
  `ctx.mode === "worker"` at `runner/bootstrap/child-runtime.ts:306`.
- **SQL transaction isolation**, a different sense of the word, one of them
  live SQL:
  - `lib/drivers/sql/dialect.ts:1684`: `"SET TRANSACTION ISOLATION LEVEL READ COMMITTED"`;
  - comments at `dialect.ts:522,1028,1676` and `sql-driver.ts:6399,7348,7349`.

  **`lib/drivers/**` is out of the sweep's scope entirely.** The sweep's
  mapping is scoped by file and by exact identifier, and **never a bare,
  case-insensitive `isolation` word rule**: one would break MySQL
  transactions at runtime, not just prose. **Verified after the change:** the
  eight `isolat` lines in `lib/drivers/**` (the seven SQL transaction lines
  above and `mongo-driver.ts:484`) are identical in text and line number, and
  `driver.ts` has only additions (§4.2.4).
- **Other senses, never renamed:**
  - *test isolation*, which is every match in `packages/bun-jobs-ui` (7 lines:
    `__tests__/app/queryIsolation.test.ts`, `__tests__/app/isolation/*`,
    `domLeak.test.ts:105`, `e2e/profile.ts:23`), in `packages/bun-nest` (13
    lines), and `bun-jobs/__tests__/namespace.test.ts:84,194` and
    `helpers/driverContract.ts:7449-7450`;
  - English in `bun-common` and `benchmarks/`, `CLAUDE.md:460,587`,
    `mongo-driver.ts:484` and `README.md:4824,5428` (`:4722,5325` on
    `688d376`);
  - the runner's own "isolation" prose in `bench/**`,
    `688d376:examples/bun-jobs/07-runner/execution-modes.ts:9` and
    `scheduled-runner.ts:32`.

  §11's inventory counts them.
- **The child-side names** `IsolatedJob`, `IsolatedJobProcessor` and the
  message `job.X() is not available in an isolated job`
  (`runner/bootstrap/child-runtime.ts:434`, asserted at runtime by
  `__tests__/worker-target.test.ts:568,594` — the renamed
  `worker-isolation.test.ts` — and
  `688d376:examples/bun-jobs/10-options/worker-isolation.ts:20,792`). Kept, as
  N9 decided.
- **Every existing `WorkerInfo`/`WorkerDto` field**, and the do-not-change
  list of `control-plane-rename.md` §6.

#### Do not change: behaviour (the invariants the swap must keep)

These come from the bun-jobs session, which worked in these paths this week.
They were verified against the tree before the change, and hold after it
(cited against the implementation):

- **I1. One write funnel for every target.** A child's progress arrives as
  `void job.updateProgress(value)` (`queue/workerTarget.ts:646-654`). A log
  line arrives through `job.log` (`:859`). Both join the attempt's
  `AttemptWrites` lane (`queue/attemptWrites.ts:39`, built per attempt at
  `BunQueueWorker.ts:2203`), which `#awaitWrites` (`:2371`) settles before the
  job's ending is recorded. **Every target, the custom one included, writes
  through `Job` and never through the driver.** Otherwise #122's ordering fix
  silently comes undone for whichever target skips it. `WorkerTargetAttempt`
  hands a custom target the `Job` for exactly this reason, and its JSDoc says
  so. `WorkerTargetContext` carries **no driver**, deliberately
  (`queue/workerTarget.ts:163-171`), so a custom target *cannot* write around
  the `Job`: I1–I3 hold for it by construction.
- **I2. The two write caps differ on purpose.** An attempt that ended itself
  waits `Math.max(WRITE_SETTLE_TIMEOUT, lockDuration / 4)`
  (`BunQueueWorker.ts:2385`). One the worker abandoned waits a flat
  `WRITE_SETTLE_TIMEOUT = 250` (`:237`). An uncapped wait was measured holding
  a concurrency slot for ever on one un-awaited `job.log()` (README "The wait
  is always capped").
- **I3. A progress value reported after an abort is dropped, in every
  target**: no write and no event. The lane reads the attempt's abort signal
  (`new AttemptWrites(controller.signal)`, `:2203`). No new target may surface
  late values. A custom target inherits this by writing through `Job` (I1).
- **I4. Required-green gate tests for the swap**, beyond the suite as a
  whole, each re-pointed to the new spellings and none weakened:
  - `__tests__/fix-attempt-write-ordering.test.ts`
  - `__tests__/fix-progress-ordering.test.ts`
  - `__tests__/fix-progress-timeout.test.ts`
  - `__tests__/worker-target.test.ts` (renamed from `worker-isolation.test.ts`
    with `git mv`)

  `fix-attempt-write-ordering` gained three **custom-target** cases
  (`:563-635`): a factory whose `run()` reports progress after the abort sees
  it dropped, with no write and no event; one whose unawaited writes are slow
  sees the completion wait for them; and one whose write hangs sees the
  completion wait only up to the ended-itself cap (500 ms at a 2 s
  `lockDuration`). All four files passed; see Phase 1's gate record (§11).

### 4.6 Provider plugins: the `execute` facet

Summary of [`compute-provider-plugins.md`](compute-provider-plugins.md) §8 as
it bears on remote execution. That document is the design. **Revised
2026-09-25** for multiple transports ([`remote-transports.md`](remote-transports.md)):
the facet is now transport-agnostic.

- **Four layers, one of them pluggable.** The gateway (`RemoteTarget`: claim,
  lease, envelope, settle) and the **protocol core** (messages, per-frame
  signing and sealing, the reliability layer, health) stay bun-jobs' and are
  the same for everyone. The **transport**, how the bytes reach the platform,
  is the `execute` facet of a provider plugin. The **remote executor** on the
  platform is written with the runtime-adapter kit or the per-transport
  servers (`remote-transports.md` §3).
- **Two shapes.** An **exchange** facet implements `send(request, ctx) →
  Response`, unchanged: one signed HTTP-shaped request, one response, which
  may stream (`http`, `http-stream`, a Lambda `Invoke`). A **session** facet
  implements `open(ctx)` (forward or brokered) or `listen(ctx)` (reversed,
  where executors dial in), each yielding a `DuplexSession` of opaque frames:
  `send(frame)`, which rejects rather than drops, a `frames` stream,
  `closed`, `close()`, `bufferedBytes()` and an optional `reconnect()`
  (WebSocket, TCP, UDP, a message broker). An optional `locate()` turns a
  named endpoint into an address; an optional `probe()` reads the executor's
  `/healthz` for the Workers page.
- **Declared capabilities.** `TransportCapabilities`: the binding, shape and
  direction; whether it streams, is duplex, ordered, reliable,
  flow-controlled or confidential; frame and message size limits; the
  encoding; resumability; `maxDurationMs`, `maxConcurrency` and the shortest
  idle timeout on its path. The core reads them instead of knowing
  transports by name: it retransmits for an unreliable one, seals frames for
  one that is not confidential, fragments above its frame size. A platform
  failure is a `ProviderError` of one of six kinds; a status the *remote*
  answered comes back as a `Response` (exchange) or a message (session), so
  §5.5's rules still apply to it.
- **The facet never sees the signing secret.** bun-jobs signs the request or
  each frame, seals frames where the transport is not confidential, and
  verifies everything that comes back (§5.6), so a transport can fail to
  deliver an outcome but cannot forge one. `RemoteEndpointTarget.secret`
  stays on the target, not in the provider's config.
- **Limits are reconciled**: the gateway uses the smaller of the facet's
  declaration and the remote's handshake (§5.4), and warns when they differ.
- **`{ kind: "endpoint", url, secret }`** is shorthand for a built-in
  provider chosen by the URL's scheme: `httpsExecute` (`https:`),
  `wsExecute` (`wss:`), `tcpExecute` (`tcp+tls:`, `tcp:`, `unix:`),
  `udpExecute` (`udp:`), or `wsListen`/`tcpListen` for a `listen` address.
  Each is written on the API. `jobs.remoteWorker(queue, { provider, secret,
  … })` takes any provider with an `execute` facet. `RemoteRunner` uses the
  same facet with `kind = "run"`.
- **The platform side is not a facet.** A FaaS runtime adapter is made with
  `defineRuntimeAdapter()` from the browser-safe `./remote` entry; it maps the
  platform's invocation to a `Request` (raw body bytes intact) and the core's
  `Response` back. A long-running executor uses a per-transport server from
  the Bun-only `./remote/serve` entry (`serveHttp`, `serveWebSocket`,
  `serveTcp`, `serveUdp`, `dialWebSocket`, `dialTcp`), each built on
  `RemoteExecutor.acceptSession()`, which a third-party runtime transport
  calls too. A plugin package ships its runtime half as a second entry
  (`./runtime`) beside its host entry.
- **Versioning**: the `execute` facet has its own `apiVersion`, independent of
  `summon`'s, so it can change during Phase 2 without breaking summon plugins
  shipped in Phase 1.5. The runtime-adapter helper has `RUNTIME_ADAPTER_API`;
  the wire protocol keeps `WORKER_PROTOCOL_VERSION` and its per-feature
  strings.
- **Conformance**: `runExecuteConformance` for the host side (including the
  session shape's capability checks against fault-injecting fakes),
  `runRuntimeAdapterConformance` for the event mapping, and §7's
  `conformRemoteExecutor`, now run over every binding, for the platform side.
- **`WorkerTargetFactory` stays** as the low-level hook for a target that
  should not use the protocol at all. gRPC streams and message buses, which
  this bullet used to send here, are now session-shape facets and get the
  core's signing, reliability, health and breaker. Since the Phase 1 design
  check it returns a `WorkerTargetExecutor`, not the runner's `Executor`
  (§4.2.6), and the gateway, `RemoteTarget`, implements the same interface.
- **Stability**: `execute` is `experimental` (`0.x`) until the Cloudflare,
  Lambda and generic HTTP adapters, `httpsExecute`, `lambdaExecute` and one
  outside provider pass both kits, **and** one session-shape transport written
  outside the bun-jobs session does too (Phase 4's gate).
## 5. The remote-worker contract

This is the centrepiece: a versioned wire specification precise enough to
implement in Python with no access to this repo. Everything below is
**push** (§3.2). Pull needs a driver and is out of scope (§10.1).

Working name for the spec document: `packages/bun-jobs/PROTOCOL.md`, emitted
into the OpenAPI document the same way `api/spec/` already emits the
management API's. It ships with a `LIMITATIONS.md` beside it (§3.8.1).

**This section and Hatchet's in-flight serverless SDK were designed
independently and agree on every load-bearing decision** — HMAC-SHA256 over
the raw body, a timestamp header, a five-minute window clamped in both
directions, one endpoint whose status codes are the result, and one task
representation carried over both transports. Read §3.8.1 before implementing:
four of its specifics are better than what follows, and are marked below where
they land.

**Revised 2026-09-25: more than one transport.** At the user's request, Phase
2 carries the contract over HTTP request/response, HTTP with a streamed
response, SSE, WebSocket (forward and reversed), TCP (with TLS and Unix
sockets), UDP and HTTP/2, and lets a provider plugin add others (gRPC, QUIC,
message brokers). The design is [`remote-transports.md`](remote-transports.md).
It separates the **message protocol** from the **binding** that carries it:
what follows in §5 is the HTTP binding plus the parts every binding shares,
and `remote-transports.md` §4.13 lists every place it changes §5. Where the
two disagree about transports, `remote-transports.md` is newer. §4.6 now
summarises the `execute` facet's two shapes: *exchange* (`send(request) →
Response`, what this section describes) and *session*
(`compute-provider-plugins.md` §8.2).

### 5.1 Why this is a separate surface from `createJobsApi`

The management API is the obvious candidate and it is the wrong one. Five
concrete reasons, in order of weight:

1. **Direction.** `createJobsApi` is a *server* bun-jobs mounts and an operator
   calls. The worker contract is a *client* bun-jobs calls and a remote
   serves. Putting both in one module means one of them is inside out.
2. **Auth model.** `auth.ts` is built for a browser admin session: `authorize`
   returning a decision per action, Origin checks, CSRF double-submit,
   cookies. A worker endpoint is machine-to-machine with a shared secret and
   no cookies, no origin, no CSRF — and the 48-entry `JOBS_API_ACTIONS` list
   has no place for `invoke`, because invoking is not an administrative
   action anybody should be able to grant from a dashboard.
3. **Bundle.** The reference executor must load in a V8 isolate. `lib/api/`
   imports `@kingsleyweb/bun-common` (`BunRouter`), the drivers and `node:*`.
   `api/contract/` is browser-safe precisely because it is *not* `api/`.
4. **Blast radius.** A bug in the invoke path must not be able to reach
   `jobs.remove` or `queues.drain`. Separate router, separate secret, separate
   mount — or, as here, not mounted by bun-jobs at all.
5. **Versioning.** `JOBS_API_PROTOCOL_VERSION` moves when the admin API
   changes. Tying a worker fleet's upgrade cadence to a dashboard's is a
   mistake you only make once.

**What it does reuse**, and should: `api/schema/builder.ts` (one schema, both
validation and OpenAPI), `api/errors.ts`'s `ProblemDto` shape so every error
in the package looks the same, `api/body.ts`'s bounded JSON reading, and
`shared/errors.ts`. New directory `lib/remote/`, browser-safe like
`lib/api/contract/` and `packages/bun-jobs-ui/lib/shared/`.

### 5.2 Transport

**HTTP is the default binding and the only one every platform supports**
(`remote-transports.md` §1.4, from
[`evidence/remote-transports/platform-transports.md`](evidence/remote-transports/platform-transports.md)
§1.1). The bullets below are the HTTP binding (`http` and `http-stream`). The
other bindings carry the same messages in frames of their own
(`remote-transports.md` §4.3, §7), and the URL's scheme picks one: `https:`,
`wss:`, `tcp+tls:`, `tcp:`, `unix:`, `udp:`, or `listen:` for a reversed
binding (`remote-transports.md` §8.1).

- **HTTP/1.1 or HTTP/2, `application/json`, UTF-8.** One URL; the method
  selects the operation. No path structure to agree on — a remote may mount it
  at `/bun-jobs`, at `/api/jobs`, or at `/`.
- **`GET`** — handshake. Idempotent, cacheable-by-us for `introspectTtl`.
- **`POST`** — every other operation, discriminated by `envelope.op`.
- **Long-lived response.** The gateway holds the connection for the whole
  attempt; that is what lets it own the lease. Keep-alive is required in
  practice and the gateway must reuse connections (§9).
- **WebSocket is now two bindings of Phase 2** (sub-phases 2b and 2d,
  §11): forward (`ws`, the gateway dials) and reversed (`ws-reverse`, the
  remote dials the gateway, for a remote with no public URL; not on FaaS, and
  it makes the gateway a server; `remote-transports.md` §7.5–§7.6). The
  message bodies are the same; only the framing changes. The management
  API's WS unit (`api/ws/`) is the model for session handling, but **not**
  the same socket — see §5.1.
- **A streamed response is how progress comes back over HTTP** (§5.10), on
  the *same* response as the invoke, **SSE-framed by default** (a Cloudflare
  Tunnel buffers any other content type [V cf-tunnel, in the evidence file]).
  That is deliberate: it means the remote never needs to call bun-jobs, so
  bun-jobs never has to expose an inbound write surface to the internet
  (§10.6).
- **Heartbeats are application data**, every 10 s by default, on every
  binding, and every liveness deadline is an application timer: Bun's own
  network timers fire in 4-second ticks
  ([`bun-transports.md`](evidence/remote-transports/bun-transports.md)
  cross-cutting 1), and several platforms ignore HTTP/2 PING or TCP
  keepalive (`remote-transports.md` §2).

### 5.3 Endpoints

| Method | Body | Answers | Purpose |
|---|---|---|---|
| `GET` | — | `HandshakeEnvelope` | who are you, what can you run, what are your limits |
| `POST` | `InvokeEnvelope` | `InvokeResultEnvelope` (or an NDJSON stream ending in one) | run these jobs |
| `POST` | `CancelEnvelope` | `CancelResultEnvelope` | stop these, if you can |
| `POST` | `PingEnvelope` | `PongEnvelope` | liveness + clock exchange, no side effects |

**Two error shapes, deliberately.** A *transport* error — bad signature,
unsupported op, body too large, 429 — is an RFC 9457 `ProblemDto`, the exact
shape `lib/api/contract/types.ts` already defines (`type:
"urn:bun-jobs:error:<CODE>"`, `title`, `status`, `code`, `detail?`,
`context?`), so every error the package emits looks the same to a client. A
*job* error — the handler threw — is a `SerializedError` inside an outcome
(§5.5) and never an HTTP status: a job that failed is a successful invoke.
Conflating the two is the most common bug in systems of this shape, because it
makes "the handler threw" indistinguishable from "the endpoint is broken", and
a circuit breaker then trips on ordinary job failures.

Only `GET` and invoke are **MUST**. Cancel and ping are **SHOULD**; a remote
that does not implement an `op` answers `415`-equivalent
`{ error: { code: "UNSUPPORTED_OP" } }` with HTTP 400, and the gateway records
the capability as absent.

**On a session binding** (WebSocket, TCP, UDP, SSE session mode, a broker)
there are no methods: the same operations are messages — `hello`/`welcome`
for the handshake, `invoke`, `cancel`, `health`, `status`, `ping` — among the
twenty of `remote-transports.md` §4.1, and an unknown one is answered with a
non-fatal `problem` carrying `UNSUPPORTED_OP`. Two HTTP operations are added
for every binding's sake: `POST { op: "health" }` (readiness, with the
remote's own checks) and `POST { op: "status" }` (what happened to these
attempts, for a response that was lost), both SHOULD.

### 5.4 Handshake

`GET https://remote.example.com/bun-jobs`

```json
{
  "v": 1,
  "op": "handshake",
  "protocols": [1],
  "name": "orders-cf",
  "runtime": "workerd",
  "sdk": "@kingsleyweb/bun-jobs/remote@2.3.0",
  "names": ["resize-image", "send-welcome"],
  "maxBatch": 25,
  "maxDurationMs": 25000,
  "maxBodyBytes": 1048576,
  "features": {
    "cancel": "v1",
    "idempotency": "v1",
    "fencing": "v1",
    "progress-stream": "v1",
    "replay-protection": "v1"
  },
  "secretHash": "b2ed9921…916c",
  "now": 1790000000123
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | `1` | yes | envelope version of *this document* |
| `protocols` | `number[]` | yes | every protocol version the remote can speak; the gateway picks the highest it also speaks |
| `name` | `string` | no | a display name for the Workers page |
| `runtime` | `string` | no | free text, for diagnostics |
| `sdk` | `string` | no | free text |
| `names` | `string[]` | yes | job names it can run. `["*"]` means "anything"; the gateway then never pre-filters |
| `maxBatch` | `number` | yes | most jobs per invoke; `1` is legal |
| `maxDurationMs` | `number` | yes | the longest one invoke may run here. The gateway refuses to send a job whose `opts.timeout` exceeds it, at claim time, with `HandlerCapacityError` |
| `maxBodyBytes` | `number` | no | request-body ceiling; defaults to 1 MiB |
| `features` | `Record<string, string>` | no | opt-in capabilities, **each with its own version string** — not one protocol number. Unknown keys are ignored. Taken from Inngest's `capabilities` (`{"connect":"v1","in_band_sync":"v1"}`): a third-party implementation lags feature by feature, never all at once |
| `secretHash` | `string` | no | `sha256(secret)`, hex, **only in the signed response** (below) — so an operator can confirm *which* key a deployment is running without the key leaving the box. Inngest returns `signing_key_hash` for exactly this |
| `now` | `number` | yes | the remote's clock, epoch ms — for skew detection (§5.11) |

**Handshake-as-registration.** The handshake is the *only* registration step:
the remote declares what it can run and the gateway pulls that, rather than
the remote pushing a manifest to us. Inngest does the opposite (an outbound
`POST /fn/register`), which requires the remote to hold a credential and reach
us; Hatchet's draft pulls, and pulling is right — **a conforming remote needs
no outbound credential at all**, which is what lets it run somewhere with no
egress configuration.

**Signature-gated disclosure.** The handshake answers two documents. An
unsigned `GET` gets the public one — `protocols`, `maxBatch`, `maxDurationMs`,
`now` — and nothing that identifies the deployment. A `GET` carrying a valid
signature also gets `name`, `runtime`, `sdk`, `names`, `features` and
`secretHash`. A `GET` carrying an *invalid* signature gets the public document
with `authenticated: false`, distinguished from the unsigned case's
`authenticated: null` — Inngest's two-valued "no", which tells an operator
"your key is wrong" apart from "you did not send one". This costs nothing and
turns the handshake into the first thing to curl when a deployment misbehaves.

**Negotiation rule:** the gateway sends `bun-jobs-protocol: <n>` on every
request, where `<n>` is the highest version in both sets. A remote receiving a
version it does not speak answers HTTP 400
`{ error: { code: "UNSUPPORTED_PROTOCOL", supported: [1] } }` — never a 500,
so the gateway can fall back rather than trip its breaker.

**On a session binding** the same document arrives in `welcome`, answering
the gateway's `hello`, with the session's nonces, timings and capacity
(`remote-transports.md` §4.2). `features` gains `session`, `health`,
`canary`, `attempt-status`, `stream-resume`, `resume` and `udp-aead`. Every
remote also serves unauthenticated `GET /healthz` and `/readyz` for its
platform's own checks, which cannot see a WebSocket or UDP flow
(`remote-transports.md` §5.5).

### 5.5 Invoke

`POST` with headers (§5.6) and body:

```json
{
  "v": 1,
  "op": "invoke",
  "id": "inv_01JB7Q2M9S0P",
  "now": 1790000000456,
  "deadlineAt": 1790000025456,
  "namespace": "shop",
  "queue": "media",
  "worker": { "id": "api.media.h7f3-4211-1789", "key": "api.media" },
  "jobs": [
    {
      "id": "01JB7Q2M8ZRT9V",
      "name": "resize-image",
      "data": { "url": "https://cdn.example.com/a.png", "width": 320 },
      "attempt": 1,
      "maxAttempts": 3,
      "createdAt": 1789999999000,
      "priority": 0,
      "timeoutMs": 20000,
      "idempotencyKey": "shop:media:01JB7Q2M8ZRT9V:1",
      "fence": "h7f3-4211-1789:1790000000400",
      "repeatKey": null,
      "parent": null
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | the envelope's own id. Unique per request, including transport retries — the *idempotency key* is per job and does **not** change on a transport retry |
| `now` | yes | the **gateway's** clock. Authoritative. The driver contract's rule "never read the clock" carries over: a remote uses this, not its own, for anything it records |
| `deadlineAt` | yes | epoch ms after which the gateway stops caring: `now` plus the invoke's `timeout` (§4.2.8), capped by the job's own `timeoutMs`. Not derived from the lease, which the gateway renews for the whole call (§5.9) |
| `worker` | yes | incarnation id and stable key, so a remote's logs can be correlated with the Workers page |
| `jobs[]` | yes | 1..`maxBatch` entries |
| `jobs[].data` | yes | arbitrary JSON, as stored |
| `jobs[].attempt` | yes | 1-based; `JobRecord.attemptsMade` |
| `jobs[].timeoutMs` | no | the job's own timeout; absent means only `deadlineAt` applies |
| `jobs[].idempotencyKey` | yes | `${ns}:${queue}:${jobId}:${attempt}` — stable across transport retries of the same attempt, different on a *new* attempt |
| `jobs[].fence` | yes | `${lockToken}:${claimedAt}` — monotonic per job (§5.8) |
| `jobs[].delivery` | yes | how many times **this attempt** has been sent, 1-based. A transport retry increments it and leaves `attempt` alone. Two counters rather than one, as Cloud Tasks separates `TaskRetryCount` from `TaskExecutionCount`: `delivery > 1` with an unchanged `attempt` means "we tried to hand you this and did not hear back", which is a different diagnosis from "your handler failed" and must be visible to the remote |

Deliberately **not** sent: `opts` in full, `stacktrace`, `progress`,
`returnValue`, `processedBy`, flow children. They are the gateway's business
and shipping them is payload for nothing. A remote that needs a job option can
read it from `data`.

Response, HTTP 200:

```json
{
  "v": 1,
  "op": "invoke-result",
  "id": "inv_01JB7Q2M9S0P",
  "now": 1790000003111,
  "outcomes": [
    {
      "id": "01JB7Q2M8ZRT9V",
      "status": "completed",
      "result": { "bytes": 20481 },
      "logs": [{ "at": 1790000001200, "line": "resizing https://cdn…/a.png" }],
      "progress": 100,
      "durationMs": 2655
    }
  ],
  "capacity": { "inFlight": 3, "max": 25 }
}
```

**Outcomes are keyed by job id, not by position.** A remote may answer in any
order and may omit a job entirely — an omitted job is treated as
`status: "unknown"` and the gateway leaves the lease to lapse rather than
guessing.

`status` is one of:

| `status` | Gateway does | Counts as an attempt |
|---|---|---|
| `completed` | `completeJob` with `result` | yes |
| `failed` | `failJob`; retried per the job's `attempts`/`backoff` | yes |
| `failed-fatal` | `failJob` with `retry: false` → `dead` | yes |
| `handler-not-found` | `failJob` with `retry: false`; logged distinctly; the gateway drops the name from its cached `names` and re-handshakes | yes |
| `rejected` | **not an attempt.** The job is released (lock expired) and re-claimable at once; the gateway backs off this endpoint | **no** |
| `unknown` | nothing. The lease lapses; the stalled sweep recovers it | counts as a stall |

`rejected` is the backpressure path (§5.9) and the reason it must not burn an
attempt is the whole point: a busy remote must not consume a job's retries.

**Transport statuses are not job outcomes, and `404` is special.** A `404` or
`405` from the endpoint means the route is gone or the method is wrong — a
configuration error no number of retries will fix. Quirrel encodes exactly
this as `dontReschedule: true` on a 404, and it is the one thing a pure
2xx/non-2xx contract cannot express. So: `401`/`403` (signature), `404`/`405`
(routing) and `400` (unsupported protocol or op) **trip the circuit breaker
and alert without burning a job attempt**; `429` and `5xx` are transport
retries; only a `200` carrying an outcome moves `attemptsMade`.

A failed outcome carries an error:

```json
{
  "id": "01JB7Q2M8ZRT9X",
  "status": "failed",
  "error": {
    "name": "FetchError",
    "message": "upstream returned 503",
    "code": "UPSTREAM_UNAVAILABLE",
    "stack": "FetchError: upstream returned 503\n    at …"
  },
  "retryAfterMs": 30000
}
```

`error` is exactly bun-common's `SerializedError` shape, so
`deserializeError()` reconstructs it on the gateway unchanged and
`UnrecoverableJobError` round-trips by name — which is how
`IsolatedProcessor` already rebuilds errors that crossed a process boundary.
`retryAfterMs` overrides the job's backoff for this attempt only.

**On a streaming or session binding** the outcome is not one response but a
sequence of messages per job: `accepted` (or `rejected`) at once, then
`progress`, `log` and `heartbeat` while it runs, then `result` or `fail`,
whose bodies are exactly the outcome objects above plus `attempt` and
`fence` (`remote-transports.md` §4.1–§4.2). The invoke body gains `kind:
"job" | "run"`, which is how `RemoteRunner`'s run envelope (§11 Phase 2) rides
the same message. An attempt the remote accepted and then stopped reporting
on fails fast as `RemoteAttemptLostError` (retryable, counts as an attempt);
one it never accepted is a transport retry (`remote-transports.md` §4.7).

### 5.6 Authentication and signing

Stripe/Inngest-shaped, deliberately: it is the design implementers already
know, and "HMAC over a timestamp and the raw body" is the only part that
matters.

**Headers on every request:**

```
bun-jobs-protocol: 1
bun-jobs-signature: t=1790000000,v1=6f1c…c8
bun-jobs-id: inv_01JB7Q2M9S0P
content-type: application/json
```

**Exactly what is signed.** Let `t` be the Unix timestamp **in seconds** as a
decimal string, and `raw` the request body **as the exact bytes sent** —
before any parsing, after any compression is undone. Then:

```
payload   = t || "." || raw            (ASCII "." as the separator)
signature = hex( HMAC-SHA256(key = secret, message = payload) )
header    = "t=" || t || ",v1=" || signature
```

Three things this gets right and most home-grown schemes get wrong:

- **The raw bytes, never the re-serialised object.** `JSON.stringify` of a
  parsed body is not the body. Every implementation must capture the body once
  and both verify and parse *that*.
- **The timestamp is inside the MAC.** Signing only the body lets an attacker
  replay forever.
- **Constant-time comparison.** Say so normatively; a `===` on hex strings is
  a timing oracle. `crypto.subtle.verify` does it for you.

**One escape hatch, because it is genuinely needed.** Some hosts hand a
handler a *parsed* body and no raw bytes — a Next.js route that has already
consumed the stream, an API Gateway proxy event. Inngest's spec answers this
with: *"if the raw bytes of the request body are inaccessible, the body should
first be parsed using the JSON Canonicalization Scheme (JCS) as specified in
RFC 8785."* Take the same answer, and require a conforming implementation to
try raw bytes first: JCS is a well-specified last resort, not the default,
because a canonicalisation mismatch is a signature failure nobody can debug.
On the platforms in §6.4 the raw body *is* available (Cloudflare's `Request`,
Lambda's `event.body`), so this is a corner, not the main path.

**Replay window: 300 seconds** by default, configurable down, never up
without a written reason. A request whose `t` is more than the window from the
receiver's clock **in either direction** is rejected.

That "either direction" is load-bearing and is the one line to copy verbatim
from Inngest, whose implementation carries a comment recording the bug it
fixes: a one-sided `delta > window` check lets an attacker replay a captured
request **forever** with a future-dated `t`. The check is
`Math.abs(now - t * 1000) > window`, never `now - t * 1000 > window`.

**401, not 500 — deliberately, and against Inngest.** Inngest answers every
signature failure with `500`, for two stated reasons: it gives an attacker no
oracle distinguishing "wrong signature" from "no key configured", and it makes
the platform retry, so a deploy that lands its key late self-heals. Neither
applies here. The caller is *our own gateway*, not an attacker, so there is no
oracle to protect; and a signature failure means **our** configuration is
wrong, so retrying is wasted work that a circuit breaker will then mistake for
a dead endpoint. A distinct `401` with a distinct code is what lets the gateway
log "check `BUN_JOBS_SECRET`" and stop, instead of burning a job's attempts on
a typo. Codes: `SIGNATURE_MISSING`, `SIGNATURE_INVALID`,
`SIGNATURE_TIMESTAMP`, `REPLAYED`.

**Nonce cache (SHOULD).** Within the window, remember `bun-jobs-id` and reject
a repeat with 401 `{ code: "REPLAYED" }`. Only meaningful where the remote has
somewhere to remember — an isolate needs a KV or a Durable Object, which is
why it is SHOULD and advertised as the `replay-protection` feature. **A
bounded in-memory set is enough and costs nothing** (Hatchet's draft consumes
a per-upgrade nonce from exactly that): it protects a warm instance, degrades
to no protection on a cold one, and never needs a store. Note the
interaction with §5.8: a *transport retry* reuses the idempotency key but
**must** use a fresh `bun-jobs-id`, or the nonce cache would reject the very
retry idempotency exists to make safe.

**Key rotation.** `secret` may be a list. A signer uses the first; a verifier
accepts any. Rotate by prepending the new key everywhere, deploying, then
removing the old one. The gateway's `RemoteEndpointTarget.secret` and
`createRemoteExecutor`'s `secret` both take `string | string[]` for this.

**Response signing (MUST).** The remote signs its response body the same way,
with the same secret, and the gateway verifies before acting on it. Without
this, anything that can MITM or DNS-hijack the endpoint can mark jobs
complete. Inngest does this and it is the right call.

**Provenance, verified 2026-09-22.** Inngest's SDK spec
(`github.com/inngest/inngest`, `docs/SDK_SPEC.md`) defines
`X-Inngest-Signature` as a **query string** — `t=<unix seconds>&s=<hex>` —
where `s` is *"a hex-encoded HMAC with SHA256 of the body of the request plus
the timestamp"*, the maximum signature time delta is **5 minutes**, and an SDK
*"MUST validate this signature"* and reject a mismatch. Stripe's is the same
idea with a comma-separated header (`t=…,v1=…`) and an explicit `.`
separator in the signed payload.

This spec takes **Stripe's punctuation and Inngest's semantics**: a
comma-separated header with a versioned `v1=` element, so a future `v2=`
can be added alongside without breaking a verifier, and an explicit `.`
separator so the signed payload is unambiguous for an implementer who has to
reproduce it from prose. Inngest's `&` form is a query string that is not a
query string, and its concatenation order is only discoverable from the Go
source.

**An asymmetric mode is worth offering, and is nearly free.** Quirrel's
`secure-webhooks` signs with `createSign('sha256')` and verifies with a
**public key**, so a remote holds no secret capable of *producing* a valid
request. With a shared secret, anyone who compromises one remote can forge
invokes to every other remote sharing it; with a keypair they can only read.
`crypto.subtle` does Ed25519 and ECDSA P-256 natively on every target in §3.5,
so this costs one extra `secret` variant (`{ publicKey }` on the remote,
`{ privateKey }` on the gateway) and no dependency. **Recommended as an opt-in
for phase 2 and the default for anything multi-tenant.**

Two cautions taken directly from that implementation, both of which this spec
already avoids and should keep avoiding:

- It concatenates `body + timestamp` **with no separator**, so `body="a"` with
  `ts=11` and `body="a1"` with `ts=1` sign identical bytes. The explicit `.`
  in §5.6's payload costs nothing and closes it.
- It compares digests with `===` on hex. §5.6 requires constant-time
  comparison; that is why.

**A per-job capability token, for the callback direction.** If an async or
callback mode is ever built (§10.4, §10.6), `bullmq-proxy` has the right
answer and it is one line: **the remote's bearer token *is* the job's lease
token**, checked against the stored lock. Its authority is then exactly one
job wide and expires with the lease. bun-jobs already has that value — the
`fence`'s `lockToken` — so the callback endpoint would authorise by comparing
it against the job's current lock rather than by issuing a second credential.

**Transport security.** `https` is required; the gateway refuses an `http:`
URL unless the host is `localhost`/`127.0.0.1` (tests, `wrangler dev`). This
is a `ConfigError` at construction, not a runtime warning. The same rule
covers `wss:`/`ws:`.

**Per-frame authentication, for bindings with no request boundary**
(revised 2026-09-25). A WebSocket, TCP or UDP session, or a streamed
response, has no single body to sign. There, every frame carries its own
HMAC-SHA256 under the same secret, over the session id (both sides' nonces),
the direction, the sequence number, the acknowledgement and the message, so
a frame verifies only in its own session, direction and position
(`remote-transports.md` §4.4.1). On a transport that is not confidential
(UDP, which has no DTLS in Bun; plaintext `tcp://`), frames are also
**sealed** with AES-256-GCM under keys derived by HKDF from the secret and the
nonces (§4.4.3 there). Measured cost: ~10–12 µs per frame for HMAC and ~12 µs
per 1,200 bytes for AES-GCM with `crypto.subtle` (Appendix A there). The
signing and sealing happen in the core; a transport never holds the secret.

### 5.7 State machine

Push mode has a much smaller state machine than a pull worker, which is its
main virtue.

```
                 ┌──────────────┐
   construct ──▶ │  unhandshook │
                 └──────┬───────┘
                        │ GET ok (protocol agreed, names cached)
                        ▼
                 ┌──────────────┐  transport failures ≥ breakerThreshold
   ┌──────────▶  │    ready     │ ─────────────────────────────┐
   │             └──────┬───────┘                              ▼
   │                    │ claim → POST invoke              ┌────────┐
   │                    ▼                                  │  open  │ (breaker)
   │             ┌──────────────┐                          └───┬────┘
   │             │  in-flight   │                              │ cooldown
   │   ┌─────────┴──────┬───────┴─────────┐                    │ half-open probe
   │   │                │                 │                    │
   │   ▼                ▼                 ▼                    │
   │ 2xx+valid sig   4xx/5xx/timeout   rejected                │
   │   │                │                 │                    │
   │   ▼                ▼                 ▼                    │
   │ settle per      transport retry   release job,            │
   │ status          (same idem key)   back off                │
   │   │                │                 │                    │
   └───┴────────────────┴─────────────────┴────────────────────┘
```

The **job's** state machine is unchanged — `waiting → active → completed |
failed → delayed | dead` — because the gateway performs every transition with
the same driver calls it makes today. That is the property to preserve above
all others: **push mode adds no new job states and no new driver methods.**

Registration/deregistration in the classic sense (Temporal, Faktory) does not
exist here, and should not be added: the remote is stateless, the gateway is
the worker, and `registerWorkerRecord` already covers the inventory.

**For session bindings** the endpoint states above become a session state
machine (`closed → handshaking → proving → ready ⇄ suspect → resuming |
lost`, plus `draining`), and each attempt gets its own (`sent → accepted →
running → settled`, with `rejected`, an accept timeout and a lost path); both
are in `remote-transports.md` §4.6–§4.7. `proving` is new and applies to
every binding: a session takes no work until a functional canary has passed
through it (§5.3 there). Neither adds a job state.

### 5.8 Idempotency, at-least-once and fencing

**The contract is at-least-once and always has been.** Push widens the window
(§10.3) but does not change the promise. Three mechanisms, layered:

1. **Idempotency key** — `${namespace}:${queue}:${jobId}:${attempt}`. Stable
   across transport retries of the same attempt; different for attempt 2. A
   remote with a `store` remembers the outcome for `idempotencyTtl` and
   answers a duplicate from the cache without re-running. **SHOULD**, because
   an isolate with no store cannot.
2. **Fencing token** — `fence = "${lockToken}:${claimedAt}"`. `lockToken` is
   the gateway's `#token`, `claimedAt` the epoch ms of the claim. It is
   monotonic per job: a re-claim after a stall always has a larger
   `claimedAt`. A remote that writes anything durable records the highest
   `fence` it has seen per job id and **rejects** an invoke carrying a lower
   one with `status: "rejected"`, code `STALE_FENCE`. **SHOULD.** This is the
   only mechanism that helps when two gateways are running the same job
   concurrently, which no idempotency cache can fix.
   A stronger variant, worth knowing about and probably not worth building:
   Inngest Connect rotates the lease — every successful extension returns a
   **new** `lease_id` that replaces the old one, so a stale holder's token is
   invalid by construction rather than by comparison. That needs a duplex
   channel and a remote that keeps a token between messages; a monotonic
   `fence` is the stateless equivalent and is what a single HTTP round trip can
   carry.

   **A cleaner alternative, if the fence ever needs to be more than advisory:**
   Trigger.dev has **no lock token at all** — every worker action is addressed
   `runs/:runId/snapshots/:snapshotId/…`, so a stale worker acting on an old
   snapshot id is rejected *by construction*. Optimistic concurrency rather
   than a lock. The equivalent here would be addressing every invoke by
   `(jobId, claimSeq)` and refusing an outcome whose `claimSeq` is not
   current — strictly better than a string the remote is trusted to compare,
   and what to reach for if §10.3's double-execution window proves to matter.

3. **The lock token itself**, on the gateway side. Every settle is already
   conditional on it (`completeJob(q, id, token, …)` returns `false` when
   somebody else owns the job), so a gateway that comes back from a long
   stall and tries to complete a re-claimed job **fails to**, silently and
   correctly. That mechanism exists today and needs no change.

**The case to be honest about in the README:** a remote that keeps no state
and is handed the same job twice will do the work twice. Idempotency is the
handler's responsibility. Say it in those words.

**Re-attach before retry** (revised 2026-09-25). Three platforms time out the
caller but not the work: Azure Functions answers 502 at 230 s while "the
function will continue running", Cloud Run answers 504 and does not terminate
the instance, and a Lambda stream keeps running and billing after a
disconnect ([`platform-transports.md`](evidence/remote-transports/platform-transports.md)
§1.3 item 3). A lost response is therefore **re-attached** before it is
retried: a session resumes and replays, a stream re-attaches with
`Last-Event-ID`, or the same invoke is re-sent with the same idempotency key;
a remote retains each outcome until the gateway acknowledges it, and answers
`status` from it (`remote-transports.md` §4.9). That guarantees one
settlement. It does not stop a store-less remote from running the handler
again, which is the sentence above.

### 5.9 Leases under a frozen serverless process — the hard case

The problem, stated precisely: a Lambda may run for 15 minutes; the default
`lockDuration` is 30 seconds; and between invocations the sandbox is frozen,
so a timer inside the remote is not a reliable lease renewer.

Four options considered:

| Option | How | Verdict |
|---|---|---|
| **A. The gateway heartbeats** — it is awake, blocked on the response | `#heartbeat()` already runs on `setInterval(heartbeatInterval)` for every in-flight job and calls `driver.extendJobLock`. In push mode the job is in flight for the whole HTTP call, so this already works with **zero changes** | **Recommended.** It is what the code does today |
| B. The remote calls back to renew | needs an inbound write endpoint, inbound auth, and a remote that can reach us | rejected — §10.6 |
| C. Long `lockDuration`, no renewal | a 15-minute lock means a crashed gateway strands a job for 15 minutes | rejected as a default; legitimate as an operator choice |
| D. The remote streams progress frames, each of which renews | the gateway extends the lease on every frame it reads | **Adopted in Phase 2a as liveness evidence only** (revised 2026-09-25): heartbeats and progress prove the remote attempt is alive and let the gateway fail fast when they stop, but the lease is still renewed by option A's timer alone (`remote-transports.md` §5.6) |

So: **the answer is that the frozen-process problem does not arise in push
mode, because the process that holds the lease is never frozen.** That is the
strongest single argument for push over pull and it should lead the README
section.

What *does* need care: the gateway's `heartbeatInterval` (default
`lockDuration / 3`) must be comfortably shorter than `lockDuration`, as it
is for any worker. The endpoint's `timeout` is **not** bounded by
`lockDuration` (decided 2026-09-25, `remote-transports.md` Q-T12): the
gateway renews the lease for the whole call (`BunQueueWorker.ts:2228-2232`,
`:3429-3458`), so a `timeout` above `lockDuration` lets no lease lapse. An
earlier draft made that a `ConfigError`; the rule is removed. And a job
whose `timeoutMs` exceeds the remote's
`maxDurationMs` must be refused **at claim time**, not discovered at minute
14.

**Backpressure.** Three layers, all necessary:

- `maxBatch` in the handshake — a static cap.
- `capacity: { inFlight, max }` on every response — a live hint; the gateway
  narrows `maxInFlight` toward it.
- `status: "rejected"` per job, or HTTP 429 with `Retry-After` for the whole
  envelope — the hard "no". Neither burns an attempt.

A remote saying "I can take 5" is `capacity: { inFlight: 20, max: 25 }`.

### 5.10 Cancellation, progress, logs, large payloads

**Cancellation.** `POST { op: "cancel", ids: [...], reason }`. Best-effort by
construction: the gateway aborts its fetch anyway, and the cancel is a
courtesy so the remote can stop billing. A remote that implements it
advertises `cancel`. The gateway does **not** wait for the cancel to be
acknowledged before failing the attempt — waiting would mean a dead endpoint
could hold a lease indefinitely. On a session binding the cancel is a `cancel`
frame on the same session, and a lost lock (`#heartbeat()` getting `false`
from `extendJobLock`) sends one too (`remote-transports.md` §4.11).

**Progress and logs — one mechanism, on the response.** When the remote
advertises `progress-stream`, it may answer `content-type:
application/x-ndjson` and write one JSON object per line:

```
{"op":"progress","id":"01JB7Q2M8ZRT9V","progress":40}
{"op":"log","id":"01JB7Q2M8ZRT9V","level":"info","message":"frame 400/1000"}
{"op":"invoke-result","id":"inv_01JB7Q2M9S0P","outcomes":[…]}
```

The terminal frame is always `invoke-result`; a stream that ends without one
is `unknown` for every job it did not report. The gateway turns `progress`
into `job.updateProgress()` (which already emits and publishes) and `log` into
`job.log()` — both of which it can do because it holds the driver.

~~The signature covers the **whole** streamed body, which cannot be verified
until it ends. So: progress frames are applied optimistically and the final
`invoke-result` is applied only after verification.~~ **Superseded
2026-09-25.** Each streamed frame now carries its own MAC, bound to the
invoke's id, the direction and a sequence number, and is verified before it
is applied (`remote-transports.md` §4.4.1, §7.3); the trade-off this
paragraph documented is gone. The stream is SSE-framed by default, NDJSON
accepted: one text frame per event or line, with per-job `accepted`,
`progress`, `log`, `heartbeat`, then `result`/`fail`, then `close` with
`COMPLETE`. The remote writes its first frame at once, because `Bun.serve`
sends no complete header block until the first body chunk
([`bun-transports.md`](evidence/remote-transports/bun-transports.md) §1.4).
A path that buffers the stream is detected by the canary and downgraded to
unary, and shown as `degraded` (`remote-transports.md` §5.7).

**Large payloads.** Hard rules, because silent truncation is the worst
possible behaviour:

- The remote advertises `maxBodyBytes` (default 1 MiB).
- The gateway measures the serialised envelope before sending. Over the cap,
  the job fails as `PayloadTooLargeError`, non-retryable, naming the byte
  count and the cap — at the *first* attempt, not the third.
- Batching shrinks the batch to fit before it gives up on a single job.
- Results are bounded the same way by `stringifyBounded` (already in
  `shared/json.ts`).
- The documented pattern for a big payload is the same one every queue system
  ends up with: put the bytes in object storage, put the key in `data`.

### 5.11 Clock skew

Two clocks matter and they are handled differently:

- **Signature freshness** uses each side's own clock with a ±300 s window.
  Unavoidable; it is what the window is for.
- **Everything else uses the gateway's clock.** `now` and `deadlineAt` in the
  envelope are authoritative, and the driver contract's existing rule ("times
  arrive as parameters; a driver's own `NOW()` is never authoritative") is
  extended verbatim to remotes. A remote computing a deadline from its own
  `Date.now()` is non-conforming.
- The handshake's `now` lets the gateway **measure** skew: it logs a warning
  above 30 s and refuses to proceed above the replay window, because at that
  point every request would fail signature verification anyway and the clear
  error is worth more than the 401s.

### 5.12 Conformance checklist

A third-party implementer can tick these off; `conformRemoteExecutor()` (§7)
checks every one marked MUST.

**Transport**
- [ ] MUST answer `GET` with a handshake envelope, HTTP 200, `application/json`
- [ ] MUST answer `POST` with `op: "invoke"` synchronously with `invoke-result`
- [ ] MUST answer an unknown `op` with HTTP 400 `UNSUPPORTED_OP`, never 5xx
- [ ] MUST answer a `bun-jobs-protocol` it cannot speak with HTTP 400 `UNSUPPORTED_PROTOCOL` listing what it supports
- [ ] MUST tolerate unknown fields in every envelope (forward compatibility)

**Signing**
- [ ] MUST verify `bun-jobs-signature` over `t + "." + rawBody` with HMAC-SHA256, constant-time
- [ ] MUST reject a `t` outside the replay window with 401 `SIGNATURE_TIMESTAMP`
- [ ] MUST reject a missing or malformed signature with 401 `SIGNATURE_MISSING`
- [ ] MUST verify against **any** configured key, and sign with the first
- [ ] MUST sign its own response body the same way
- [ ] SHOULD reject a repeated `bun-jobs-id` within the window (`replay-protection`)

**Invoke**
- [ ] MUST return exactly one outcome per job id it accepted, keyed by id
- [ ] MUST NOT return an outcome for an id it was not sent
- [ ] MUST use `status: "handler-not-found"` for an unknown name, never a generic failure
- [ ] MUST use `status: "rejected"` for backpressure, never a failure (it must not burn an attempt)
- [ ] MUST NOT accept more than its advertised `maxBatch`
- [ ] MUST NOT accept a body above its advertised `maxBodyBytes`
- [ ] MUST serialise errors as `{ name, message, code?, stack? }`
- [ ] SHOULD honour `jobs[].timeoutMs` and `deadlineAt`, and not answer `completed` after the deadline
- [ ] SHOULD set `capacity` on every response

**Semantics**
- [ ] MUST treat `now` as authoritative and not substitute its own clock
- [ ] SHOULD de-duplicate by `idempotencyKey` for `idempotencyTtl`
- [ ] SHOULD reject a lower `fence` than it has seen for a job id (`STALE_FENCE`)
- [ ] SHOULD implement `op: "cancel"` if it advertises `cancel`
- [ ] SHOULD implement NDJSON progress if it advertises `progress-stream`, terminating with `invoke-result`

**Operational**
- [ ] MUST be reachable over `https` (except `localhost`)
- [ ] MUST advertise a `maxDurationMs` at or below its platform's real ceiling
- [ ] SHOULD log the `worker.id` and each `jobs[].id` so its logs join up with the Workers page

**Every binding** (added 2026-09-25; `remote-transports.md` §4, §5, §10)
- [ ] MUST serve unauthenticated `GET /healthz` and `/readyz` over HTTP, disclosing nothing
- [ ] MUST verify every frame's MAC (or open every sealed frame) before acting on it, and drop a replayed `seq`/`pn`
- [ ] MUST send `accepted` or `rejected` for each job within `acceptTimeoutMs` on a streaming or session binding
- [ ] MUST send `heartbeat` every `heartbeatMs` listing its running attempts, and answer `ping` with `pong`
- [ ] MUST answer `health` with `health-result`
- [ ] MUST write its first stream frame immediately, and send `Content-Type: text/event-stream` and `X-Accel-Buffering: no` on an SSE stream
- [ ] MUST refuse a `hello` outside the replay window or with a repeated nonce (session bindings)
- [ ] SHOULD run the `bun-jobs:canary` job if it advertises `canary`
- [ ] SHOULD retain each outcome until acknowledged, and answer `status` from it (`attempt-status`)
- [ ] SHOULD replay its outbox on a resume (`resume`), and announce a shutdown with `close` and `drain: true`
- [ ] Binding-specific MUSTs are in each `PROTOCOL.md` appendix (`remote-transports.md` §11.5)
## 6. First-party adapter utilities

### 6.1 The shape: one core, thin wrappers

Every target on the list is, underneath, `Request → Response`. Cloudflare
Workers, Cloud Run, Deno Deploy, Next.js route handlers, Vercel, Netlify,
Hono, Elysia and `Bun.serve` all speak it natively; Lambda and Azure speak an
event shape that maps onto it in a few dozen lines.

So there is exactly **one** implementation and a set of adapters that are
almost entirely type declarations:

```ts
/**
 * The conforming remote executor, as a fetch handler.
 *
 * Answers the handshake (`GET`) and the invoke (`POST`) of
 * `WORKER_PROTOCOL_VERSION`, verifies every request's signature, signs every
 * response, de-duplicates by idempotency key and dispatches each job to the
 * handler registered for its name.
 *
 * It imports nothing platform-specific, nothing from `node:*` or `bun:*`, and
 * nothing from this package's server half — only `Request`, `Response`,
 * `crypto.subtle`, `TextEncoder` and JSON. That is what makes one
 * implementation serve every target.
 */
export function createRemoteExecutor(options: {
  /**
   * What this executor can run, by job name. The same
   * `(job, ctx) => result` shape a processor has, with a reduced `job`
   * (§5.5): a remote has no driver, so `job.retry()`, `job.remove()` and the
   * rest are absent rather than present and broken.
   */
  handlers: Record<string, RemoteJobHandler>;
  /**
   * The shared secret every request is verified against and every response
   * signed with. An array accepts any of them and signs with the first, for
   * rotation. At least 32 bytes.
   */
  secret: string | string[];
  /** Reported in the handshake, so a dashboard can name this deployment. */
  name?: string;
  /** How many jobs this executor will accept in one batch. Defaults to `1`. */
  maxBatch?: number;
  /**
   * The longest one invoke may run here, in ms — the platform's own ceiling
   * minus a margin. The gateway refuses to send a job whose timeout exceeds
   * it, so getting this right is what turns a silent platform kill into a
   * clean `ConfigError` at enqueue time.
   */
  maxDurationMs?: number;
  /**
   * Remembers each idempotency key's outcome for this long, in ms, so a
   * duplicate delivery is answered rather than re-run. Defaults to `0` — off,
   * because an isolate has nowhere to remember it. Give a `store` to make it
   * mean something.
   */
  idempotencyTtl?: number;
  /**
   * Where idempotency records and fencing tokens live. A `Map` is correct for
   * a long-lived process and useless for an isolate; on Cloudflare pass a KV
   * namespace or a Durable Object stub wrapped in this interface.
   */
  store?: RemoteExecutorStore;
  /** Called for each log line a handler writes, for the platform's own logger. */
  onLog?: (level: LogLevel, message: string, fields?: LogFields) => void;
}): (request: Request) => Promise<Response>;
```

**The wrappers are built with the public runtime-adapter kit** (added
2026-09-25). `defineRuntimeAdapter()`, exported from `./remote`, is what
`createCloudflareHandler`, `createLambdaHandler` and `createAzureHandler` are
made with, and what a third party uses for a platform bun-jobs does not
cover. The first-party adapters may import only `./remote`, and a test fails
on any other import ([`compute-provider-plugins.md`](compute-provider-plugins.md)
§5, §8.4).

**Revised 2026-09-25 for more transports.** `createRemoteExecutor()` now
returns a `RemoteExecutor`: still callable as the fetch handler above, so
every snippet in §6.4 is unchanged, and also able to run the protocol over a
session transport (`acceptSession(io)`), report its readiness and drain. A
new Bun-only entry, `./remote/serve`, has one server per binding —
`serveHttp`, `serveWebSocket`, `serveTcp`, `serveUdp`, and the reversed
`dialWebSocket`/`dialTcp` — each handling the Bun behaviour its binding must
(the header flush, `send()` returning `0`, unbuffered TCP writes, UDP's
missing flow control) and serving `/healthz` and `/readyz`. The options gain
`health.check`, `resultRetentionMs`, `resumeBufferBytes`, `maxConcurrency` and
`heartbeatMs`. The design is `remote-transports.md` §9; a complete worked
executor for each binding is in its executor guide (§11.3 there).

`RemoteJobHandler` is `(job: RemoteJob, ctx: RemoteContext) => unknown`, where
`RemoteJob` is a **reduced** `Job` — the readonly fields plus `log()`,
`updateProgress()` and `heartbeat()`, which travel back in the response or on
the progress channel. Everything on `Job` that needs a driver is absent. That
is a deliberate divergence from `IsolatedJob` (`Pick<Job, keyof Job>`), which
can keep the full surface because it has an IPC channel to a worker that does
hold the driver.

### 6.2 Where the code lives, and the dependency rule

**The rule, from `CLAUDE.md`: no cloud SDK enters a published package's
dependency tree.** `packages/bun-jobs/bench/` is a separate unpublished
package with its own `package.json`, lockfile and `node_modules` precisely so
BullMQ, pg-boss, Agenda and the rest never reach a published tree.

Three options, and the recommendation:

| Option | Dependency isolation | Discovery | Packaging cost |
|---|---|---|---|
| A new package `@kingsleyweb/bun-jobs-adapters` | perfect | poor — another thing to find and version | a fifth `dts/`, `consumer-check.json`, release |
| `./adapters/*` subpaths of `@kingsleyweb/bun-jobs` with optional peers | good, *if no adapter needs a runtime dep* | best | one `exports` block, `checkPeerScopes` wiring |
| Examples only, no shipped adapters | perfect | worst | none |

**Recommendation: option B, and make it cost nothing by writing the platform
types by hand instead of depending on them.**

The insight that makes this work: **not one adapter needs a runtime
dependency.** They need *types*.

- Cloudflare: `export default { fetch(request, env, ctx) }`. `ExecutionContext`
  and `ScheduledEvent` come from `@cloudflare/workers-types`. Structurally,
  `ExecutionContext` is `{ waitUntil(p: Promise<unknown>): void; passThroughOnException(): void }` — three lines to declare.
- Lambda: the handler takes an API Gateway v2 / Function URL event. The fields
  actually needed are `rawPath`, `rawQueryString`, `headers`, `body`,
  `isBase64Encoded`, `requestContext.http.method`. `@types/aws-lambda` is a
  types-only devDependency at most; declaring the subset is ~20 lines.
- Azure: `HttpRequest`/`HttpResponseInit` from `@azure/functions` — that one
  *is* a runtime import in the v4 programming model
  (`app.http(...)`), so ship the mapper and let the user call `app.http`.
- Cloud Run, Deno, Next.js, Vercel, Netlify, Hono, Elysia, `Bun.serve`: no
  types needed at all. They pass a `Request`.

So the shipped adapters declare **no** `dependencies` and **no**
`peerDependencies`, and `checkPeerScopes` has nothing to check — which is the
cheapest possible outcome under the packaging rules. If a future adapter does
need a peer, the precedent is bun-nest's `./jobs` entry: the peer is optional,
`consumer-check.json` lists it as `"peers": [...]`, and the root entry must
not reach it.

A hand-written structural type has one documented failure mode — the platform
changes its shape and our declaration silently disagrees. Mitigate with a
type-test file per adapter that imports the *real* types as a devDependency
and asserts assignability, in the style of
`__tests__/bunValidate.libraries.type-test.ts` (checked by the tests
typecheck, not `bun test`). The real SDK types are devDependencies of
`bun-jobs` alone; nothing imports them at runtime.

### 6.3 The exact `package.json` shape

Following `CLAUDE.md` to the letter — every entry is
`{ "@kingsleyweb/source": lib, "types": dts, "default": lib }` in that order,
one explicit key per directory with an `index.ts`, never a fallback array:

```jsonc
{
  "exports": {
    ".": { "@kingsleyweb/source": "./lib/index.ts", "types": "./dts/index.d.ts", "default": "./lib/index.ts" },
    "./api/contract": { "...": "unchanged" },

    // New. `./remote` is the protocol + the reference executor: browser-safe,
    // like `./api/contract`, because it must load inside an isolate.
    "./remote": {
      "@kingsleyweb/source": "./lib/remote/index.ts",
      "types": "./dts/remote/index.d.ts",
      "default": "./lib/remote/index.ts"
    },
    "./adapters/cloudflare": {
      "@kingsleyweb/source": "./lib/remote/adapters/cloudflare.ts",
      "types": "./dts/remote/adapters/cloudflare.d.ts",
      "default": "./lib/remote/adapters/cloudflare.ts"
    },
    "./adapters/lambda":  { "...": "same shape" },
    "./adapters/azure":   { "...": "same shape" },
    "./adapters/http":    { "...": "same shape" },

    // The existing deep-import patterns are unchanged and already cover
    // `./lib/remote/...`, so nothing else moves.
    "./lib": { "...": "unchanged" },
    "./lib/*.ts": { "...": "unchanged" },
    "./lib/*.js": { "...": "unchanged" },
    "./lib/*":    { "...": "unchanged" },
    "./package.json": "./package.json"
  }
}
```

`consumer-check.json` gains one entry per new spelling, and **every one of them
is `"browser": true`**:

```jsonc
{
  "spelling": "@kingsleyweb/bun-jobs/remote",
  "browser": true,
  "values": ["createRemoteExecutor", "WORKER_PROTOCOL_VERSION", "signEnvelope", "verifyEnvelope"],
  "types": ["RemoteJobHandler", "InvokeEnvelope", "InvokeResultEnvelope", "HandshakeEnvelope"]
},
{
  "spelling": "@kingsleyweb/bun-jobs/adapters/cloudflare",
  "browser": true,
  "values": ["createCloudflareHandler"]
}
```

Two further entries come from the plugin system
([`compute-provider-plugins.md`](compute-provider-plugins.md) §11.1):
`./remote/testing` (the conformance kits, not browser-safe: it is run by an
author, not deployed) and the host-side `./providers/*` entries that Phase 1.5
introduces, which gain `execute` facets here (`httpsExecute`,
`lambdaExecute`). `./remote`'s values also gain `defineRuntimeAdapter` and
`RUNTIME_ADAPTER_API`.

**Transport entries** (added 2026-09-25, `remote-transports.md` §8.1, §9):
`./remote/serve` (Bun only, **not** `"browser": true`, like
`./remote/testing`), and the first-party host-side transports as providers,
`./providers/ws`, `./providers/tcp` and `./providers/udp`, beside
`./providers/https`, which now covers `http`, `http-stream` and SSE. None
imports anything but Bun and Web APIs: WebSocket, `fetch`, `Bun.listen`,
`Bun.connect`, `Bun.udpSocket` and `crypto.subtle` cover every first-party
binding, so the dependency rule holds with no exception. The protocol core
(`lib/remote/protocol/`) stays inside `./remote` and browser-safe.

`"browser": true` is the load-bearing bit: `CLAUDE.md` records that it checks
the entry "with no ambient Node/Bun types", which is exactly the property an
edge adapter must have. bun-jobs is already at 96/96 cells; each new entry
adds its own column set.

Because `./remote` must stay browser-safe, it gets the same treatment
`lib/shared/` gets in bun-jobs-ui: a **bundle-safety test** that builds the
adapter entry with `Bun.build` targeting `browser` and fails on any server
marker, with a negative control. The existing precedent is
`packages/bun-jobs-ui/__tests__/app/pkg/bundle-safety.test.ts`.

One `dts/` consequence: `lib/remote/**` is new source under `rootDir: lib`, so
`scripts/build-declarations.ts` picks it up with no change, and its "every
`lib` module has a declaration" check covers it automatically.

### 6.4 Usage snippets

**Cloudflare Workers** (`src/index.ts`, plus `wrangler.toml`):

```ts
import { createCloudflareHandler } from "@kingsleyweb/bun-jobs/adapters/cloudflare";

interface Env { BUN_JOBS_SECRET: string; JOBS_KV: KVNamespace }

export default createCloudflareHandler<Env>({
  secret: (env) => env.BUN_JOBS_SECRET,
  name: "orders-cf",
  maxBatch: 25,
  // Workers' CPU ceiling is the real bound; leave headroom for the response.
  maxDurationMs: 25_000,
  // KV makes idempotency mean something in an isolate that remembers nothing.
  store: (env) => kvStore(env.JOBS_KV),
  idempotencyTtl: 600_000,
  handlers: {
    "resize-image": async (job, ctx) => {
      ctx.log(`resizing ${job.data.url}`);
      const res = await fetch(job.data.url);
      return { bytes: (await res.arrayBuffer()).byteLength };
    },
  },
});
```

**AWS Lambda** (Function URL or API Gateway v2):

```ts
import { createLambdaHandler } from "@kingsleyweb/bun-jobs/adapters/lambda";

export const handler = createLambdaHandler({
  secret: process.env.BUN_JOBS_SECRET!,
  name: "reports-lambda",
  maxBatch: 10,
  // 15 min is the platform ceiling; the gateway refuses a longer job rather
  // than letting Lambda kill it mid-write.
  maxDurationMs: 14 * 60_000,
  // A synchronous Lambda invoke caps request AND response at 6 MB, so this is
  // the real ceiling behind a function URL — not the protocol's 1 MiB default.
  maxBodyBytes: 6 * 1024 * 1024,
  handlers: {
    "monthly-report": async (job, ctx) => {
      await ctx.heartbeat();          // tells the gateway to renew the lease
      return await buildReport(job.data.month, { signal: ctx.signal });
    },
  },
});
```

**Google Cloud Run / any container** (`server.ts`, run under Bun, Node or Deno
— it is just an HTTP server):

```ts
import { createRemoteExecutor } from "@kingsleyweb/bun-jobs/remote";

const execute = createRemoteExecutor({
  secret: process.env.BUN_JOBS_SECRET!,
  name: "media-run",
  maxBatch: 50,
  maxDurationMs: 55 * 60_000,       // Cloud Run request timeout, minus margin
  handlers: { transcode: async (job) => await transcode(job.data) },
});

Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  // The gateway may hold a request open for the whole job.
  idleTimeout: 255,
  fetch: (request) => execute(request),
});
```

**Next.js route handler** (`app/api/jobs/route.ts` — also Vercel, Netlify,
Deno Deploy, Hono, Elysia, verbatim). On Vercel this is the **cheapest place
to prove the contract**, because Vercel now runs Bun as a first-class function
runtime (public beta, `"bunVersion": "1.4.x"` in `vercel.json`), so the
adapter runs there with no transpilation and no shims:

```ts
import { createRemoteExecutor } from "@kingsleyweb/bun-jobs/remote";

const execute = createRemoteExecutor({
  secret: process.env.BUN_JOBS_SECRET!,
  name: "web",
  handlers: {
    "send-welcome": async (job) => await sendWelcome(job.data.to),
  },
});

export const POST = (request: Request) => execute(request);
export const GET = (request: Request) => execute(request);   // the handshake
export const maxDuration = 300;   // Vercel: seconds, plan-dependent
```

**And the bun-jobs side, once, wherever the driver lives:**

```ts
const worker = jobs.worker("media", undefined, {
  concurrency: 64,                      // 64 in-flight HTTP calls
  lockDuration: 60_000,
  target: {
    kind: "endpoint",
    url: "https://orders.example.workers.dev/bun-jobs",
    secret: process.env.BUN_JOBS_SECRET!,
    maxInFlight: 20,                    // what the *remote* can take
    batch: 25,
    batchWindow: 50,
  },
});
await worker.run();
```

**Other transports** use the same target with another scheme —
`wss://`, `tcp+tls://`, `unix://`, `udp://`, or `listen:` for executors that
dial in — plus `tls`, `sessions`, `heartbeat` and `health` options. The
host-side snippets for each are `remote-transports.md` §8.3, and the matching
executors are its §9 and executor guide.
## 7. Conformance test kit

### 7.1 For a third-party implementer

Ship a **runnable conformance suite** as part of the package, not a document.
It is the only thing that makes "a documented contract" real. It is exported
from `./remote/testing`, beside `runRuntimeAdapterConformance` (the
platform-event mapping) and, from `./provider/testing`, `runExecuteConformance`
(the host-side transport). All three return the same `ConformanceReport`
shape as the summon kit ([`compute-provider-plugins.md`](compute-provider-plugins.md) §12).

```ts
/**
 * Drives a candidate remote executor through every rule the contract states
 * and reports which it satisfies.
 *
 * Stands up nothing: it needs only a URL and the shared secret, so it runs
 * against a local `bun run worker.ts`, a `wrangler dev`, a deployed Lambda
 * behind a function URL, or anything else that answers HTTP.
 *
 * ```bash
 * bunx --bun @kingsleyweb/bun-jobs conform https://localhost:8787/bun-jobs \
 *   --secret $BUN_JOBS_SECRET --name echo
 * ```
 */
export async function conformRemoteExecutor(options: {
  /** The candidate's invoke endpoint. */
  url: string;
  /** The shared secret, as the candidate is configured with. */
  secret: string;
  /**
   * A job name the candidate can run whose handler echoes its input. The
   * suite needs one cooperating handler; everything else it drives through
   * the protocol.
   */
  echoName: string;
  /** A job name the candidate does *not* know, for the not-found case. */
  unknownName?: string;
  /** Skip checks a candidate has declared it does not implement. */
  skip?: ConformanceCheckId[];
}): Promise<ConformanceReport>;
```

The checks, grouped, each with a stable id so a report is diffable:

| Group | Checks |
|---|---|
| handshake | `GET` answers; advertises `protocol`, `names`, `maxBatch`, `maxDurationMs`; unknown fields tolerated; unsigned `GET` rejected if the implementation claims signed introspection |
| signing | valid signature accepted; wrong signature 401; missing header 401; timestamp outside the window 401; body mutated after signing 401; replayed nonce rejected (if `replayProtection` advertised); response signed and verifiable |
| invoke | success shape; result round-trips JSON exactly; `HandlerNotFound` → the documented fatal code; thrown error → retryable by default; `nonRetryable: true` honoured; `retryAfterMs` honoured |
| timeouts | a job that outlives its deadline answers or closes; the remote does not answer success after its own deadline |
| idempotency | the same idempotency key twice within the window answers identically and (SHOULD) does not re-execute |
| fencing | an invoke with a stale `fence` is rejected with the documented code (SHOULD) |
| batching | `maxBatch` respected; one outcome per input job; order-independent (outcomes keyed by id, not position); a partial failure does not fail the batch |
| cancellation | a cancel for an in-flight id is accepted (SHOULD) |
| limits | a body above the advertised cap answers the documented error, not a 413 from the platform |
| versioning | an envelope with a higher `v` is rejected with a negotiable error, not a 500 |

`ConformanceReport` should be printable as a checklist and serialisable, so a
third party can paste it into a PR. Precedent in this repo: the driver contract
suite under `__tests__/` that every driver runs.

**Per binding** (revised 2026-09-25, `remote-transports.md` §10).
`conformRemoteExecutor` takes an endpoint of any scheme (`https:`, `wss:`,
`tcp+tls:`, `tcp:`, `unix:`, `udp:`) or a plugin's transport, and runs **one
protocol suite over every binding**, whose groups extend the table above:
frame security (a flipped byte, a replayed sequence number, a frame from
another session or reflected back, a forged acknowledgement), accept and
reject, progress and logs arriving *during* the attempt, heartbeats, health
(liveness, readiness, the canary), duplicate delivery, a lost response,
reconnection and resume, and the platform probe. Each binding then adds its
own checks against a fault-injecting fake shipped in `./remote/testing`:
`bufferingHttpProxy` (SSE buffering detection and downgrade),
`idleCuttingProxy` and paused peers (WebSocket backpressure and liveness),
`tcpChunker` (framing splits, a paused reader), `lossyUdpProxy` (seeded loss,
reordering, duplication, MTU, rebinding), and `spawnExecutor` (an executor
frozen with SIGSTOP must be detected within `attemptSilenceMs`). All of it
runs on loopback with no cloud.

### 7.2 How bun-jobs tests its *own* adapters

The rule: **no cloud credentials in `bun test`, ever.** Three tiers.

**Tier 1 — in-repo, always run, no network.** A `MemoryDriver`, a
`BunQueueWorker` with `target: { endpoint }` pointed at a `Bun.serve` on port
0 running the reference `createRemoteExecutor()` handler. This is the
`testServer` pattern from `packages/bun-common/__tests__/helpers.ts` and it
covers the entire protocol, both halves, including signing, batching,
idempotency and fencing. Use `router.fetch()`/adapter `fetch()` where no
socket is needed — `CLAUDE.md` is emphatic that this is the production path,
not an approximation.

This tier is where 90% of the value is. It is also the one that catches the
bugs, because it can inject: a signature that arrives 400 s late, a response
that arrives after the gateway aborted, a duplicate delivery, a batch whose
third job never appears in the answer. Since 2026-09-25 it runs once per
binding, each against its local server (`Bun.serve` for HTTP, SSE and
WebSocket, `Bun.listen` for TCP and Unix sockets, `Bun.udpSocket` for UDP)
and its fault-injecting fake, and a Python stdlib executor over `tcp+tls`
proves `PROTOCOL.md` is implementable without this repo, skipped visibly
when `python3` is absent (`remote-transports.md` §10, §11.3).

**Tier 2 — platform emulators, skipped visibly.** Following the repo's existing
convention (the Chrome E2E tests skip with a visible message when
`BUN_CHROME_PATH` finds nothing; the DB suites skip when their URL is unset):

| Platform | Emulator | Worth it? |
|---|---|---|
| Cloudflare Workers | `workerd` via `miniflare`/`wrangler dev --local` | **Yes.** The whole Cloudflare premise is "does this run without `node:*`?", and only a real isolate answers that. One smoke test: handshake + one invoke + one failure. |
| AWS Lambda | AWS SAM local / `aws-lambda-ric` in a container | **Marginal.** The adapter is 40 lines of event→`Request` mapping; a unit test over the mapping is cheaper and catches the same bugs. Skip the emulator. |
| Cloud Run / Cloud Functions gen2 | it is just a container serving HTTP | **No.** Tier 1 already is this. |
| Azure Functions | Core Tools | **No.** Same reason. |
| Vercel / Netlify / Next.js route handler | — | **No.** They are `Request → Response`; a unit test over the wrapper suffices. |
| Deno Deploy | `deno` binary locally | **Marginal.** One smoke test if `deno` is on PATH, same skip convention. |

Cloudflare's emulator dependency (`miniflare` / `wrangler`) must **not** enter
`packages/bun-jobs/package.json`. It goes where the third-party comparators
already go — a separate, unpublished package with its own `package.json`,
lockfile and `node_modules`, excluded from the root `workspaces` list. The
`bench/` precedent is exactly this, and `scripts/typecheck.ts` and
`bunx eslint .` already cover such a directory.

**Tier 3 — real platforms.** A manual script under `packages/bun-jobs/e2e/`
(unpublished, same shape) that deploys the reference adapter and runs
`conformRemoteExecutor` against it. Run before a release, by hand, by
somebody with credentials. **Not in CI.** The cost is real money and real
flakiness, and the thing it uniquely catches — a platform changing its
limits — is caught faster by reading a changelog.

### 7.3 What the suite must *not* do

Do not fake a Cloudflare Worker by running the adapter under Bun with some
globals deleted. It proves nothing: Bun's `node:*` shims are present, its
`fetch` is different, and the failure mode being tested (a bundler pulling
`node:crypto` in) happens at build time, not run time. The bundle-safety test
in `packages/bun-jobs-ui/__tests__/app/pkg/bundle-safety.test.ts` is the right
model for that specific concern — build the adapter entry with `Bun.build`
targeting `browser`, and fail on any server marker in the output.
## 8. Observability and the management UI

### 8.1 What a push-mode remote is, in the inventory

**It is not a worker.** The `WorkerInfo` record (`drivers/driver.ts:1426` on `688d376`) is
written by `#report()` from a process that holds the driver: `id`, `key`,
`service`, `host`, `pid`, `concurrency`, `active`, `state`, `processStartedAt`,
`version`, `completed`, `failed`, `config`, `control`. A Cloudflare Worker
writes none of that, and cannot — it has no driver.

So in push mode the **gateway** is the worker, exactly as it is today, and the
endpoint is an attribute of it. Phase 1 already puts `target` on the record,
as `WorkerTargetInfo` (§4.2.4: `kind`, `processor`, `name?`, `file?`; absent
means a worker too old to say, **not** in-process). Phase 2 adds `"endpoint"`
to `kind` and two fields. **Revised 2026-09-25** for multiple transports: the
`remote` block also carries the binding, the endpoint's health, and session
counts ([`remote-transports.md`](remote-transports.md) §5.4, §12). This is the
one definition; `remote-transports.md` §12 points here.

```ts
/** Phase 2's additions to WorkerTargetInfo (§4.2.4). */
target?: {
  /** Phase 1's closed list, plus `"endpoint"` from Phase 2. */
  kind: "in-process" | "worker-thread" | "child-process" | "custom" | "endpoint";
  /**
   * For `"endpoint"`: where the executor is, with nothing past the authority —
   * `https://media.example.run.app`, `wss://gpu.internal:8443`,
   * `tcp+tls://inference.svc:7443`, `udp://10.0.3.7:7000` — or, for a reversed
   * binding, the listen address. Never a path, a query or credentials; a
   * `unix:` socket is shown as `unix:` alone. Gated by `exposeEndpoints`.
   */
  endpoint?: string;
  /** For `"endpoint"`: what the remote said about itself, and how it is doing. */
  remote?: {
    /** The binding in use: `"http"`, `"http-stream"`, `"sse"`, `"ws"`, `"ws-reverse"`, `"tcp"`, `"udp"`, or a plugin's id such as `"nats"`. */
    binding: string;
    /** The remote's declared name, e.g. `"orders-cf"`. For a reversed binding with several executors connected, the names joined, most recent first. */
    name?: string;
    /** Protocol version it negotiated. */
    protocol: number;
    /** Runtime it reported, e.g. `"workerd"`, `"nodejs22.x"`, `"bun"`, `"python"`. */
    runtime?: string;
    /** Job names it said it can run. */
    names?: string[];
    /** When the last verified message arrived: an invoke's answer, a heartbeat, a pong, a handshake. Epoch ms. */
    lastSeenAt: number;
    /** Consecutive transport failures; `0` while it is answering. */
    failures: number;
    /** The endpoint's health state and the evidence for it (`remote-transports.md` §5.4). */
    health: {
      /** `healthy`, `degraded`, `unhealthy` (the breaker is open) or `unknown` (not probed yet). */
      state: "healthy" | "degraded" | "unhealthy" | "unknown";
      /** Why, when not `healthy`: e.g. `"buffering"`, `"no-in-attempt-reporting"`, `"canary-failed"`, `"breaker-open"`, `"not-functionally-probed"`. */
      reason?: string;
      /** Round-trip time of the last `pong`, in ms. Absent on `http`, which has no ping. */
      rttMs?: number;
      /** The capacity the executor last reported. */
      capacity?: { inFlight: number; max: number; accepting: boolean };
      /** The last functional canary: when, whether it passed, how long it took, and a secret-free detail when it failed. */
      canary?: { at: number; ok: boolean; latencyMs: number; detail?: string };
    };
    /** For the session bindings: sessions open now, and how many were resumed or lost since the worker started. */
    sessions?: { open: number; resumed: number; lost: number };
  };
};
```

`serialize.ts`'s `exposeHosts` switch has an exact analogue: the endpoint URL
is infrastructure, so gate it behind `exposeEndpoints` (default `false`, like
`exposeRunnerFiles`) and show origin-only when it is on.

### 8.2 `workerControl.ts` and remote workers

It extends **completely, and for free**, because it never touched the
processor. `pause` stops the gateway claiming, so nothing reaches the
endpoint. `stop` parks the gateway. `setConfig` changes `concurrency`,
`lockDuration`, `heartbeatInterval` on the gateway.

Two new config keys are worth adding to `WORKER_CONFIG_KEYS` — and only if
they satisfy that list's stated rule ("every one of them can be applied to a
running worker in place"):

| Key | In-place? | Verdict |
|---|---|---|
| `endpointMaxInFlight` | yes — it is a semaphore bound | add |
| `endpointBatch` | yes | add |
| `endpointTimeout` | yes, for the next invoke | add. Any positive value, not bounded by `lockDuration`, because the lease is renewed for the whole call (`BunQueueWorker.ts:2228-2232`, `:3429-3458`; Q-T12, decided 2026-09-25) |
| `endpointUrl` | **no** — it changes what code runs | do not add. Changing where jobs execute from a dashboard is a remote-code-execution control panel |

That last row is a security decision, not an ergonomics one. Say so in the
README.

### 8.3 What the UI cannot know

Be explicit about this on the Workers page rather than showing an empty card:

- **The remote's own concurrency, CPU, memory or queue depth.** Only what it
  advertises in its handshake, which it may be lying about or may have
  changed since.
- **Whether a job is still running there after a transport timeout.** The
  gateway timed out; the remote may be mid-flight. The UI should show
  `in-flight, response overdue`, not `failed`. On a streaming or session binding the heartbeat narrows this: an
  attempt the remote still lists in its heartbeats is running, and one it
  stopped listing is lost (`remote-transports.md` §5.6).
- **How many instances are behind the endpoint.** One URL may be a thousand
  Lambda containers. The "worker" is the gateway; instance count is the
  platform's console, not ours.
- **Logs from the remote**, unless it sends them back on the `progress`
  channel (§5.10) or in its final response. `job.log()` works either way
  because the gateway writes it.

Concretely: `WorkerTable.tsx` gets a target badge; `WorkerScreen.tsx` gets a
"Target" card showing kind, processor (function or file), a custom target's name, and in Phase 2 the origin, last handshake, negotiated protocol,
advertised names, consecutive failures, and (since the transports,
`remote-transports.md` §12) the binding, the health state with its reason,
the last canary and the session counts; `WorkerConfigCard.tsx` picks up the
three new keys automatically since it renders `WORKER_CONFIG_KEYS`.

**README parse note:** `packages/bun-jobs-ui/README.md`'s
`### What each element needs` table is read by
`examples/bun-jobs-ui/04-screens/permissions.ts`. A new element on the Workers
page is a change to that table and therefore to that example — report it to the
examples session before merging (per `CLAUDE.md`).

### 8.4 Events

`WORKER_EVENT_TYPES` is `["control", "state", "config"]`. Do **not** add a
remote-specific event type; a remote going unreachable is a property of the
gateway's state. Reuse `state` with a reason, and let the existing
`lastError` field on `WorkerControlInfo` carry the transport failure. One less
thing for the AsyncAPI document and the UI's event filters to learn.
## 9. Performance

### 9.1 What the numbers will look like

Measured baselines today (`bench/baselines/queue.json`, Bun 1.4.3, linux-x64,
5,000 jobs) give the frame: enqueue 118,669/s on memory, 15,461/s on Redis,
1,564/s on Postgres; contention on Redis around 40–51k jobs/s across four runs
of one unchanged build.

Expected, per target. **These are predictions, not measurements** — every one
of them is a bench scenario to be written (§9.3):

| Target | Added cost per attempt | Expected throughput vs in-process |
|---|---|---|
| in-process | 0 | 1× |
| `"worker-thread"` | `Worker` spawn + structured clone | already measured by `worker-isolation`; dominated by spawn, so batch-per-worker would help and does not exist |
| `"child-process"` | `Bun.spawn` + JSON IPC | worst of the local three; a process per attempt |
| `{ endpoint }`, batch 1, same region | 1 RTT + TLS session resumption + remote cold-start | hundreds/s, not tens of thousands. The RTT is the throughput, not the CPU |
| `{ endpoint }`, batch 25 | 1 RTT per 25 | ~25× the above, minus the tail: a batch is as slow as its slowest job |
| `{ endpoint }`, cross-region | +60–150 ms RTT | do not do this |

The honest summary for the README: **push mode trades one to two orders of
magnitude of throughput for the ability to run anywhere.** Nobody should move
a 40,000 jobs/s Redis queue onto a Cloudflare Worker. The targets are for
jobs whose *work* dominates — a 4-second image resize does not care about a
15 ms RTT — and for code that can only live on that platform.

### 9.2 Where the concurrency actually is

A subtlety the design has to get right: with `target: { endpoint }`, the
gateway's `concurrency` is **the number of in-flight HTTP requests**, not CPU
work. A gateway at `concurrency: 200` is 200 open sockets and ~200 live
leases, and costs the gateway almost nothing. So the sensible default changes:
an endpoint worker wants a high concurrency and a `maxInFlight` that reflects
the *remote's* capacity, which is why `maxInFlight` is a separate knob from
`concurrency` in §4.2.

Second subtlety: `lockDuration` (default 30,000 ms) now has to cover an HTTP
round trip to a possibly-cold Lambda. The gateway's heartbeat keeps renewing
it during the call, so a long job is fine — but a *cold start* of 3–10 s
against a `lockDuration` of 30 s with `heartbeatInterval` of 10 s is fine only
because the heartbeat is running. Verify that in a test with a deliberately
slow endpoint.

### 9.3 Bench scenarios to add

`packages/bun-jobs/bench/` is a separate unpublished package with its own
`package.json`, lockfile and `node_modules` — exactly the right place for any
comparator that pulls in a cloud SDK or `miniflare`.

New scenarios in `bench/queue.ts`:

| Scenario | What it measures | Backends |
|---|---|---|
| `target-local` | in-process vs `thread` vs `process` on one backend, same job | memory, redis |
| `push-loopback` | `{ endpoint }` against a local Bun server running the reference adapter — isolates protocol + HMAC + JSON cost from network | memory, redis |
| `push-batch` | the same at batch 1, 5, 25, 100 — finds the knee | redis |
| `push-workerd` | against a real `workerd`/miniflare instance, if the cost is acceptable | memory |

Comparators worth adding to `bench/contenders/queue/`: **none initially.** The
honest comparison for push mode is Inngest and Trigger.dev, and both are
hosted services — a benchmark against somebody's cloud measures their network,
not their code, and cannot be re-run offline. Say that in `bench/README.md`
rather than shipping a misleading rival. **`bullmq-proxy` is the one fair local
comparator**, and now that it is verified (§3.8) the comparison is genuinely
apples-to-apples: it is *also* written in Bun (`Bun.serve`), it also has a
gateway holding a real worker and pushing each job to an HTTP endpoint, and it
runs in a container offline. Two caveats to state in `bench/README.md` rather
than discover: its endpoint timeout **defaults to 3,000 ms** and must be raised
or it fails every job longer than one request; and it has had no feature
release since 2025-02-15, so it measures a frozen prototype — a fair reference
point, not a moving target to chase.

### 9.4 The regression guard

`CLAUDE.md`'s rule: `baselines/*.json` record the figure **and who led it**,
the tolerance is a blunt 35% calibrated to the 28% spread real contention
runs show, and the overtaken check is the sharper of the two.

Two consequences:

1. **`push-loopback` has no rival**, so it only has the self-comparison — the
   weaker check. Its value is catching factor-level regressions (a `Keep-Alive`
   lost, a signature recomputed per job, a batch that went serial), which is
   exactly the class the guard has historically caught.
2. **Do not re-baseline the existing six scenarios for this work.** Nothing in
   §4.3 touches the claim, settle or limit paths, so `enqueue`,
   `enqueue-bulk`, `throughput`, `roundtrip`, `payload` and `contention` must
   come back unchanged. If they move, that is the finding, not the noise.
   Re-baseline only after a deliberate change, with `--save-baseline`, on the
   machine that recorded the last one.
## 10. Bottlenecks, risks and open questions

### 10.1 The driver-reachability wall

The hard one, and the reason the whole design is push-first. Every built-in
driver needs a raw socket or a filesystem: `Bun.RedisClient` (`eval`, `xadd`,
blocking `BLMOVE`), `Bun.sql` (including `sql.listen`), the `mongodb` peer,
`Bun.file`. None of that exists on a V8-isolate edge runtime, and `Bun.sql` /
`Bun.RedisClient` do not exist on Node either.

The escape hatch that keeps being suggested and should be **explicitly
deferred**: an **HTTP driver** — `class HttpDriver implements JobsDriver` that
proxies the whole contract — 97 method members across `DriverLifecycle`, `RunnerDriver` and `QueueDriver` — to a bun-jobs gateway over HTTP. It would
make pull mode work everywhere. It is also a second complete implementation of
the driver contract, a second surface to authorise, and it re-introduces
per-claim latency on every method a worker calls in a loop. It belongs in a
later phase, if ever, and only for the queue half of the contract.

Deferring it has a real cost, and this is the cost: **a pull-mode Node worker
is not deliverable in this plan.** Say so plainly in the README rather than
implying "bun-jobs works on Node" once adapters ship.

### 10.2 Push mode: who owns the lease while the call is in flight

The gateway does, and it keeps heartbeating — that is the design. The failure
cases:

| Case | What happens | Mitigation |
|---|---|---|
| Endpoint hangs past `timeout` | gateway aborts the fetch, fails the attempt, retries per the job's backoff | the gateway renews the lease for the whole call (`BunQueueWorker.ts:2228-2232`, `:3429-3458`), so it is still live when the decision is made, whatever `timeout` is. There is no `lockDuration` bound on `timeout`: an earlier draft forced it below `lockDuration`, and that rule was removed on 2026-09-25 (`remote-transports.md` Q-T12). On a streaming or session binding a *silent* remote is detected sooner, by heartbeat loss (`remote-transports.md` §5.6) |
| Endpoint hangs, gateway *crashes* | lease lapses, stalled sweep re-claims after `lockDuration + stalledInterval`, the remote may still be running | fencing token (§5.8); `maxStalledCount` |
| Endpoint answers after the gateway gave up | response is discarded; the job already failed | idempotency key + the remote's result cache means the *retry* is answered from cache rather than re-run |
| Endpoint is dead for everyone | every attempt fails, every job burns attempts, the queue drains into dead-letter | **circuit breaker**: after N consecutive transport failures the gateway pauses claiming rather than failing jobs. This is not optional; without it, one bad deploy buries a day of work in ten minutes |
| Gateway is pausedmid-call | the in-flight call completes; `pause()` only stops claiming, as today | already correct |

The circuit breaker is the single most important operational feature in §5/§6
and it is easy to forget because it is not part of the wire protocol.

**Health feeds it** (revised 2026-09-25). On every binding the gateway
checks liveness (`ping`/`pong`, periodic heartbeats), readiness (`health`,
and the capacity on every heartbeat) and function (a canary job through the
remote's real dispatch path, at session open, every 5 min, and as the
half-open probe). A failed canary at open keeps the session out of use; two
failed periodic canaries open the breaker; a frozen remote is detected in
25–30 s by default and its attempts fail fast instead of at their timeout
(`remote-transports.md` §5).

### 10.3 Double execution

At-least-once was always the contract, but push widens the window:

- Local: a stall means the process died, so the attempt almost certainly
  stopped.
- Push: a stall means the *gateway* died. The remote is still running, and
  bun-jobs has no way to stop it. A second worker claims and invokes again.

Two jobs now run the same work concurrently on the same remote. The contract's
answers: the **fencing token** (§5.8), which lets a remote detect and reject
the stale invoke *if it stores anything*, and the **idempotency key**, which
lets it de-duplicate. Neither is free — both need the remote to keep state —
so the conformance checklist marks them **SHOULD**, and the README says in
plain words: *a push-mode handler must be idempotent, full stop.*

### 10.4 A remote that never reports back

Distinguish three:

1. **Connect refused / DNS** — fast, retry transport-level, count toward the
   breaker.
2. **Accepted, never responds** — the expensive one; holds a lease and a slot
   for the whole `timeout`. `maxInFlight` bounds the damage.
3. **202 Accepted, promises a callback, never calls back** — this is why §5
   should ship with the **synchronous** response shape first and treat the
   callback/async shape as a later phase. A callback mode needs a reaper, an
   inbound-auth surface exposed to the internet, and a whole second state
   machine.

### 10.5 Cost of polling from a serverless target

Nobody should build it, but somebody will. A Cron-triggered Lambda that wakes
every minute, claims a batch, runs it and exits is a legitimate *pull*
pattern — with a long `lockDuration`, no heartbeat, and the acceptance that a
job's latency floor is the cron period. Document it as a pattern; do not
build an adapter for it, because it needs a driver connection (§10.1).

### 10.6 Accepting completion callbacks from the internet

If and when async/callback mode ships, bun-jobs is accepting
`complete`/`fail` for arbitrary job ids from the public internet. Required:
HMAC over the body *including the job id and the fencing token*, a replay
window, a nonce cache, and — the one that is always forgotten — the callback
must be rejected unless that job is currently `active` under *this* gateway's
token. Anything less is "anyone who learns a job id can mark it complete".

The reversed bindings of Phase 2 (`ws-reverse`, reverse TCP) do accept
inbound connections, but not callbacks in this sense: an executor must first
authenticate its session with the secret, and it can report only on attempts
pushed to it on that session, with a matching fence
(`remote-transports.md` §7.6). A job id alone gets an attacker nothing.

### 10.7 Version skew between the enqueuer and the remote

The realest risk in day-to-day operation, and the one the design can do most
about:

- A producer enqueues `resize-image` with `{ url, width }`. The Cloudflare
  Worker deployed last week expects `{ path, width }`. Nothing catches it.
- Mitigations available cheaply: the remote advertises its names **and an
  optional schema version per name** in its handshake (§5.4); the gateway
  records what it negotiated on the heartbeat record; a name the remote does
  not advertise fails as `HandlerNotFoundError` (unrecoverable) rather than
  retrying 5 times into a dead-letter.
- Mitigation *not* recommended: shipping payload schemas over the wire and
  validating. That is a job for the producer's own `defineJob` options and is
  out of scope.

### 10.8 Ordering and rate limits across heterogeneous workers

`QueueLimiter` (`queue/limits.ts`) is already cluster-wide and lease-based and
is enforced **before** the claim, so a push-mode gateway is subject to it
identically. Good. But:

- A batched invoke claims N jobs at once and reserves N at once. The rate limit
  is then enforced at claim granularity, not at execution granularity — a
  burst of 25 "starts" lands in one instant. Already true of local batching;
  just louder.
- **Per-name concurrency does not bound the remote.** Two gateways on the same
  queue each at `maxInFlight: 50` put 100 concurrent requests on one Lambda
  alias. The cluster-wide limit that *would* bound it is the queue's
  `concurrency`, so document "set the queue's concurrency to the remote's
  capacity", not the worker's.
- bun-jobs has no FIFO guarantee today and push does not change that.

### 10.9 Smaller ones, named

- **`AbortSignal` semantics change meaning.** In-process, abort stops the
  work. Over HTTP, abort closes a socket; a Lambda keeps running and keeps
  billing. `ProcessorContext.signal` on the remote side is the *remote's own*
  signal, not the gateway's.
- **Large payloads.** `JobRecord.data` is arbitrary JSON. Cloudflare and
  Lambda both cap request bodies. §5.12 needs a documented ceiling and an
  explicit failure, not a truncation.
- **HMAC cost.** Signing every request with `crypto.subtle` is an async call
  per invoke. At batch 1 and thousands/s that is measurable; measure it in
  `push-loopback` before optimising.
- **Clock skew** breaks the replay window in both directions. §5.11.
- **`Bun.serve`'s `idleTimeout`** on the gateway side is irrelevant (it is the
  client here), but a reference adapter served by `Bun.serve` has a default
  idle timeout that will cut a long job. Name it in the adapter docs.
  *Measured since* (2026-09-25): it fires in 4-second ticks, and a quiet
  stream survives only with `server.timeout(req, 0)`
  ([`bun-transports.md`](evidence/remote-transports/bun-transports.md) §1.7,
  cross-cutting 1). `serveHttp` sets it (`remote-transports.md` §9); for a
  hand-written server the docs say so. Reverse mode makes it relevant on the
  gateway too, which is then the server.
- **The `RemoteWorker` name collision** (§2.2) is resolved by Phase 0, which
  renames the control plane `WorkerController` and frees `RemoteWorker` for
  Phase 2. One related collision remains, `WorkerTarget` (§4.2).

### 10.10 The adjacent project this keeps colliding with: platform queues as drivers

Noted here so it is a deliberate non-decision rather than an oversight. Five
platforms ship a queue whose contract is *the same shape as this one*, with
their storage instead of ours:

| Platform queue | Its lease | Its partial ack |
|---|---|---|
| SQS + Lambda ESM | visibility timeout, extendable, capped at 12 h from first receive | `{batchItemFailures:[{itemIdentifier}]}` |
| Cloudflare Queues | consumer invocation; pull API has `lease_id` + `visibility_timeout_ms` ≤12 h | per-message `ack()` / `retry({delaySeconds})` |
| Vercel Queues (beta) | `visibilityTimeoutSeconds`, `ExtendLease` | per-message ack from the SDK retry callback; **no built-in DLQ** |
| Netlify Async Workloads | platform-managed | FIFO + priorities, 4 retries, dead-letter state |
| Google Cloud Tasks | none — `dispatchDeadline` only, 15 s–30 min, not extendable | 2xx is the ack |

Each could be a `JobsDriver` rather than a target. That would give bun-jobs a
worker that runs natively on each platform with its lease held by the
platform — which is the *other* way to answer this ask, and arguably the more
honest one per platform. It is also five implementations of a 97-member
contract, each supporting a different subset (none of them has `getQueueState`, so
limits, windows and worker control would all be unavailable). **Out of scope,
and worth revisiting only if one platform's queue turns out to be where the
demand actually is.**

### 10.11 Open questions for the maintainer

1. ~~**Is push-remote worth it at all, versus documenting "run a second Bun
   process"?**~~ **Decided 2026-09-25: yes.** Real remote execution is built as
   Phase 2, under the freed names `RemoteWorker` and `RemoteRunner`.
1b. ~~**Or versus *summon-compute*?**~~ **Decided 2026-09-25: both.**
   Summon-compute is Phase 1.5 ([`summon-compute.md`](summon-compute.md)).
   The two answer different needs — "I do not want a worker running 24/7"
   and "my code can only run on this platform" — and the user chose to serve
   both rather than pick one.
2. **Sync-only, or sync + async callback?** This plan recommends sync-only for
   phases 1–3 and treats async as a separate project (§10.4, §10.6).
3. **Does the contract get a spec document of its own** (a versioned
   `PROTOCOL.md` in the package, emitted into the OpenAPI document), or is the
   README enough? A third-party implementer needs the former.
4. **Where do adapters live** — §6 recommends `./adapters/*` subpaths with no
   cloud SDK dependencies at all. The alternative (a second published package)
   is cleaner for dependency isolation and worse for discovery.
5. **Is `workerd`/miniflare in CI worth its weight?** §7 says one smoke test,
   skipped visibly when absent, in the style of the Chrome E2E tests.
6. **The plugin system's own questions** are in
   [`compute-provider-plugins.md`](compute-provider-plugins.md) §17.2. The one
   that touches this plan most: whether the shared core (one provider object
   for both facets) earns its keep if no provider ships both facets by the
   execute gate (Q-P1).
7. **The transports' own questions** are in
   [`remote-transports.md`](remote-transports.md) §15 (Q-T1–Q-T12). Two are
   decided (2026-09-25): all of 2a–2f is committed, in order (Q-T1), and a
   target `timeout` is not bounded by `lockDuration` (Q-T12). The open one
   that touches this plan most: whether a lost remote attempt counts as an
   attempt or as a stall (Q-T11).

### 10.12 Multiple transports (added 2026-09-25)

The full list is [`remote-transports.md`](remote-transports.md) §14. The ones
that change this plan's risk picture:

- **UDP's reliability layer and its sealing are a small transport protocol
  and a hand-rolled secure channel.** Both are kept minimal, measured only on
  loopback, and `experimental` until a real-network run and a review.
- **Everything measured is loopback on a canary Bun** (`1.4.3-canary.1`).
  Each Phase 2 sub-phase re-runs its binding's spikes on the shipped release
  first
  ([`evidence/remote-transports/`](evidence/remote-transports/README.md)).
- **Reverse mode makes the gateway a server** with a listener, a certificate
  and an address, which §5.2 chose HTTP push to avoid; and there is no
  first-party relay for the case where neither side can accept a connection.
- **A CPU-bound handler blocks its executor's heartbeats** and is declared
  lost while working. `attemptSilenceMs` is configurable and the docs say so.
- **Double execution after a lost response** (§5.8's re-attach) prevents a
  second settlement, not a second run on a store-less remote.
- **The surface**: seven bindings times one conformance suite. One protocol
  core is the mitigation; a binding is framing and I/O.
## 11. Phased delivery

Each phase is independently shippable, independently testable, and leaves the
package in a coherent state if the next one never happens. Effort is in
focused days for someone who wrote this code.

**The sequence changed on 2026-09-25.** The 2026-09-22 draft recommended
shipping Phase 1, then choosing *between* summon-compute (1.5) and the remote
contract (2). The user has decided to build both. A rename now comes first,
so that the Phase 2 feature can take the names `RemoteWorker` and
`RemoteRunner`. The draft's decision gate before Phase 2 is removed, and the
rest of the phases are as before.

**Revised again on 2026-09-25 for the compute-provider plugin system**
([`compute-provider-plugins.md`](compute-provider-plugins.md) §16): its core,
`summon` facet and kit land in Phase 1.5 (new sub-phase 1.5p, before the
first-party summoners); the `execute` facet with Phase 2; the runtime-adapter
kit and the execute kits with Phase 3; the execute stability gate in Phase 4.
The first-party summoners and adapters are built on the public API.

**Revised again on 2026-09-25 for multiple transports**
([`remote-transports.md`](remote-transports.md) §13). Phase 2 now carries
the contract over HTTP (unary and streamed), SSE, WebSocket in both
directions, TCP (with TLS and Unix sockets), UDP and HTTP/2, with health
checks, progress and heartbeats on every one, and it is split into
sub-phases 2a–2f, **all committed and built in order, 2a to 2f** (the
user's decision, 2026-09-25, `remote-transports.md` Q-T1). 2a is the first
milestone: HTTP, streamed HTTP with SSE framing, the health model and the
session-capable `execute` facet (~38 d). Phase 3 gains the per-binding conformance and its fakes; Phase 4
loses the streaming work (now in 2a) and gains per-binding benchmarks and the
real-network script.

| Phase | What | Effort (bun-jobs session) | Other owners |
|---|---|---|---|
| **0** | Rename the control planes | ~1.5 d | examples PR; UI copy |
| **1** | `target` option, local only, replacing `isolation` — **implemented, awaiting merge** | **~7 d** (was ~7.5 d, which included the UI badge) | examples ~1.5 d (stacked PR); UI ~2 d (badge, Target card, playground prose) |
| **1r** | Runner spellings: `worker-thread`/`child-process` for runners, a reader that accepts the old stored values, the DTO change | ~3 d | examples ~1.5 d, UI ~1 d |
| **1.5** | Summon-compute, including the provider plugin API (1.5p) and the summon stability gate (1.5s) | **~47 d** (was ~32.5 d; the minimum useful ship, 1.5a + 1.5b, is still ~17.5 d) | UI ~3.5 d, examples ~3 d |
| **2** | Real remote execution: the contract, the gateway, `RemoteWorker`, `RemoteRunner`, the `execute` facet, and **the transports** (2a HTTP + streamed HTTP + health; 2b WebSocket; 2c TCP/TLS/Unix; 2d reversed + SSE session; 2e UDP; 2f HTTP/2) | **~77.5 d**, all committed (was ~22.5 d before the transports; 2a, the first milestone, is ~38 d) | examples ~6 d (one example and one failure demo per binding); UI ~2 d (binding, health) |
| **3** | Conformance kits, the runtime-adapter kit, the first adapters built on it, and **per-binding conformance with its fakes** | **~22.5 d** (was ~17 d) | examples ~1 d |
| **4** | Benchmarks (now per binding), remaining adapters, hardening, the real-network script, the execute stability gate | **~11 d** (was ~10 d) | — |
| | **Total** | **~169.5 d** (was ~108 d before the transports; ~105.5 d before the Phase 1 design check; ~80.5 d in the draft) | **~22.5 d + the rename's PRs** (was ~14.5 d) |

### Phase 0 — rename the control planes

**Scope.** Everything in [`control-plane-rename.md`](control-plane-rename.md),
under the user's decisions:

- `RemoteWorker` → `WorkerController`, `RemoteWorkerManager` →
  `WorkerControllerManager`, `RemoteRunner` → `RunnerController`, and the
  accessor `.remote(x)` → `.controller(x)`.
- The options `remoteControl` → `control`, and `remoteConfig` →
  `allowedOverrides`.
- "Remote" in the sense of *registered by another process* → *non-local*.

The packages are unpublished, so there are no aliases and no deprecation
cycle. **After it, `RemoteWorker` and `RemoteRunner` are free**, and in this
plan they mean only a worker or runner that executes on another machine or
platform (Phase 2).

**Also decide here: the `WorkerTarget` collision (§4.2).** The existing
exported `WorkerTarget` (the addressee of a control instruction) moves with
the renamed file under its old name. Phase 1 needs the name for something
else. Renaming the existing one in this window costs one more row in the
rename's mapping.

| Work | Effort |
|---|---|
| Mechanical rename, prose pass, the non-local strings, and the two option families (`control-plane-rename.md` §8.1: roughly 8–10 h across (a), D3 and D2 (b)) | ~1 d |
| Gate: `scripts/typecheck.ts`, lint, suites, `examples/bun-jobs` on 8 backends | ~0.5 d |
| **Total** | **~1.5 d**, plus the examples session's own PR |

### Phase 1 — the `target` option, local only

**Status: implemented, awaiting merge** (2026-09-25). PR 1, the library, is
built on `feat/bun-jobs-worker-target` (base `688d376`) and passes its own gate
(the gate record below). It is not green alone, by design: it lands together
with the stacked examples PR (Sequencing, step 3).

**Revised 2026-09-25 by the Phase 1 design check** (against `688d376`), and
reconciled with the implementation the same day. The design is §4.2–§4.5,
which now describe what was built, and the names, approved 2026-09-25, are
§4.2.7 (N1–N9).

**Scope.**

- `target` on `BunQueueWorkerOptions`, **replacing** `isolation` and
  `isolationOptions` (U2): the three local modes `"in-process"`,
  `"worker-thread"` and `"child-process"` (U1), their object forms with
  tuning, and `WorkerTargetFactory` with its `WorkerTargetExecutor` (§4.2.6).
- `defineProcessors()` (§4.4).
- `target` on the heartbeat record and `WorkerDto`, optional, with absence
  meaning "too old to say" (§4.2.4).
- The README section, and the vocabulary mapping wherever a user meets both
  vocabularies (§4.2.5).
- **Out of scope:** runners (U3; that is Phase 1r), `{ endpoint }` (U4;
  Phase 2), a `?target=` filter on `GET /workers`, and `target` as a remotely
  configurable key (§4.3, last row).

**Why here.** It is the API the later phases hang off, it carries no
protocol, no security surface and no network, and the `WorkerTargetFactory`
escape hatch alone lets a user build anything this plan defers.

#### The inventory: everything `isolation` touches

The scan is case-insensitive (`git grep -i isolat`), plus the worker-level
literals `"spawn"`/`"worker"`/`"in-process"` in every file that uses the
option. That is **508 lines**. Each line is classified by **sense** first,
because the word has at least four, and only one of them is renamed:

| Sense | Files | Lines | Occ. | Treatment |
|---|--:|--:|--:|---|
| **W** the worker option (`isolation`, `isolationOptions`, `IsolationMode`, `IsolationOptions`, `IsolatedProcessor`, `isolation.ts`, the values `"worker"`/`"spawn"`, and prose about them) | 35 | 353 | 439 | **the sweep** |
| J the child-side job (`IsolatedJob`, `IsolatedJobProcessor`, "not available in an isolated job") | 15 | 53 | 54 | keep (N9) |
| R the runner's execution modes, and "isolation" prose about runners | 9 | 47 | 45 | never (U3, Phase 1r) |
| T test isolation | 10 | 24 | 24 | never |
| X SQL transaction isolation, one line live SQL | 4 | 9 | 9 | **do not change** (§4.5) |
| E other English ("isolates serialization", namespaces, `--linker isolated`) | 11 | 15 | 15 | never |
| N a literal match that is not about isolation (`kind: "worker"` events, `ClaimStatementOptions["worker"]`) | 3 | 7 | 8 | never |

**Is it persisted or on the wire? No.** See §4.2.4. The new `target` field is
Phase 1's only wire change.

The **W** lines, by package and coupling. COUPLED-compile means the
compiler rejects the line once the option changes. COUPLED-runtime means
only a run shows the mismatch. UNCOUPLED lines are names a consumer chose.
"Survives" means an `"in-process"`-only line whose value is unchanged.

| Area | Owner (role) | Compile | Runtime | Uncoupled | Survives | Prose | **Total lines / occ. / files** |
|---|---|--:|--:|--:|--:|--:|---|
| `packages/bun-jobs/lib` | the bun-jobs session | 28 | 2 (the two messages, §4.2.3) | 3 (`#isolated`) | 1 | 16 | **50 / 62 / 6** |
| `packages/bun-jobs/__tests__` | the bun-jobs session | 31 | 0 | 15 | 4 | 10 | **60 / 63 / 6** |
| `packages/bun-jobs/README.md` | the bun-jobs session | — | — | — | — | 24 (including the option table, `:775-776`, and the sample, `:2373-2374`) | **24 / 40 / 1** |
| `examples/bun-jobs` | the examples session | 46 | 2 (`10-options/worker-isolation.ts:239`, `:1102`) | 58 | 3 | 43 | **154 / 189 / 15** (plus 2 lines to keep: `:1158`, `:1164`) |
| `playground` | the UI session | 8 (`isolated.ts:87-88,123-124,156-157,183-184`) | 0 | 16 | 0 | 41 | **65 / 85 / 7** |
| `packages/bun-jobs-ui` | the UI session | 0 | 0 | 0 | 0 | 0 | **0**: every match is test isolation. Excluded from the rename table |
| `packages/bun-nest`, `bun-common`, `benchmarks/`, `bench/` | — | 0 | 0 | 0 | 0 | 0 | **0 W**. All other senses |

`consumer-check.json` has no isolation entry; it lists `defineProcessor`
(`:24`) and gains `defineProcessors`. `lib/runner/**` has one W line, the
comment at `runner/bootstrap/child-runtime.ts:507` that names
`IsolatedProcessor.run`. Its other matches are J. So the examples session's
review of `lib/runner/**` public surface is triggered only if N9 renames.

**Reading the examples half.** The examples session measured **91 lines /
102 occurrences in 14 files** with its own pattern. The table above is 154
lines / 189 occurrences in 15 files because it also counts two things. First,
the worker-level literal values on lines that do not say "isolation" (for
example `mode: "worker"` at `worker-isolation.ts:144`, and the `for (const
mode of ["spawn", "worker"] …)` loops at `:341,749,808,853`). Second, the
uncoupled local names in `10-options/errors.ts:1126-1179`
(`isolatedQueue`, `isolatedWorker`, `isolatedDead`, `isolatedStored`). Size
the work by the coupled columns (48 lines, 68 occurrences) and read it by
lines. `10-options/worker-isolation.ts` alone is 84 of the lines.

**Runtime-only couplings the compiler will not catch:**

- `examples/bun-jobs/10-options/worker-isolation.ts:237-239` asserts
  `BUN_JOBS_MODE === mode`. That is false once `mode` is `"worker-thread"`
  (§4.2.5). It must compare against the runner spelling.
- `worker-isolation.ts:1102` asserts `/isolation must be/`, which becomes
  `/target must be/`.
- `errors.ts:333` and `worker-isolation.ts:1072,1082` assert `/needs a
  processor file/`. They **pass unchanged**, because §4.2.3 keeps the phrase.
- **Seven files named after the concept**, loaded by path string: the
  example `10-options/worker-isolation.ts` (in `RUN_ALONE`, `run-all.ts:60`),
  and the processors `10-options/processors/isolation-{report,slow-write,unavailable,fail,job-fail,hang}.ts`.
  They are referenced by eight path strings in `worker-isolation.ts`,
  including the bare `processor: "./isolation-report.ts"` at `:159`. **The
  examples session's proposal**, and its call: keep the processor file names,
  because running a job isolated from its caller is still what they
  demonstrate, in plain English. "Isolation" is not being given a new meaning,
  unlike "remote" in Phase 0. Rename `worker-isolation.ts` after its subject
  in a follow-up, not in this window.
- The playground's `processors/checksum.ts:77,113` and
  `processors/preview.ts:66,86,111` put `BUN_JOBS_MODE` into a job result
  field named `isolation`. That is user data, uncoupled, and it shows the
  runner spelling next to a worker built with the new one.

**The playground split** (the UI session's, accepted):

- The library PR takes the **8 compile-coupled lines** in
  `playground/isolated.ts` mechanically, so the playground typechecks in the
  same window.
- The UI session rewrites the rest afterwards: the 16 uncoupled code lines
  (`IsolatedWorld`, `startIsolated`, the `isolation` result fields, the
  imports in `simulation.ts:2,135,142,231-232`) and the 41 prose lines (the
  `isolated.ts` header, three processor files' doc comments, the README's
  worker table and its "Isolated workers" section at `playground/README.md:64,84-90`).
  It will probably rename `isolated.ts` → `targets.ts`.
- The UI session's own count was "18 code uses, about 37 prose". The
  difference is classification: 8 lines are compile-coupled, and the rest of
  the code lines are names the playground chose.

#### Work and effort

| Work | Owner | Effort |
|---|---|---|
| `target` types, resolution, the `ConfigError` messages of §4.2.3, JSDoc on every property | bun-jobs | 1 d |
| `isolation.ts` → `workerTarget.ts` (`git mv`); `IsolatedProcessor` → internal `FileTargetExecutor`; `WorkerTargetExecutor` / factory / `close()`; the `RunContext.mode` mapping | bun-jobs | 1.5 d |
| `defineProcessors()` + a registry-dispatch fixture | bun-jobs | 0.5 d |
| `WorkerInfo.target`, `WORKER_TARGET_KINDS`, both `WorkerDto`s, the schema, `toWorkerDto` + the N7 flag, and the two drift tests (§4.2.4) | bun-jobs | 1 d |
| Tests: the four I4 files re-pointed; parity across the three targets (the `688d376:packages/bun-jobs/__tests__/worker-isolation.test.ts:82` loop, now `worker-target.test.ts:103`); every `ConfigError`; a custom target, including the I1–I3 cases; the record's `target`, present and absent | bun-jobs | 1.5 d |
| README: the target section replacing "Isolated processors" (`688d376:packages/bun-jobs/README.md:2347-2469`; now `README.md:2361-2571`), the option table (`:775-776`; now `:778`), the mapping sentence, the TOC (`:98`; now `:98-101`) | bun-jobs | 0.5 d |
| The mechanical sweep of `__tests__` (60 lines) and the 8 playground lines | bun-jobs | 0.5 d |
| Gate (below) | bun-jobs | 0.5 d |
| **Total, the library PR** | | **~7 d** (was ~7.5 d including the UI's 1 d; the `WorkerTarget` row is gone, Phase 0 settled it) |
| The examples' sweep: 48 coupled lines and the prose, the mapping sentence in `worker-isolation.ts` and `07-runner/execution-modes.ts`, and a `defineProcessors` / worker-file example in `07-runner/` | examples | ~1.5 d |
| The Workers-page target badge and the Target card; absent renders as "—"; the `What each element needs` row, reported to the examples session because `examples/bun-jobs-ui/04-screens/permissions.ts` parses it | UI | ~1.5 d |
| The playground's prose and names rewrite | UI | ~0.5 d |

#### Sequencing

1. **The user approves N1–N9** (§4.2.7). Done 2026-09-25: every name is
   the recommended candidate, and §4.2.7 records the choices.
2. **PR 1, the library** (the features session, on
   `feat/bun-jobs-worker-target`): bun-jobs `lib/`, `__tests__/`, `README.md`,
   `consumer-check.json`, and the 8 compile-coupled playground lines. Sign-offs:
   the bun-jobs session for `lib/**`, `__tests__/**` and the README; the UI
   session for the 8 playground lines and for the `WorkerDto.target` shape it
   will render; the examples session only if N9 renames a `lib/runner/**` name.
3. **PR 2, the examples** (the examples session, stacked on PR 1): the
   `examples/**` sweep, including the two runtime couplings and the mapping
   sentence. `scripts/typecheck.ts` typechecks the examples, so **neither PR is
   green alone**. As in Phase 0, run the gate on PR 2's head, merge PR 2 into
   PR 1's branch, and land PR 1 as one merge commit, so `develop` never
   carries a red commit.
4. **PR 3, the UI** (the UI session, a separate feature *after* PR 1 lands the
   API field): the badge, the Target card and the playground prose. It depends
   only on the `WorkerDto.target` contract, so it can be built against PR 1's
   branch while PR 1 is in review.

**Gate** (PR 2's head, a fresh worktree, `@kingsleyweb/*` resolving inside
it):

- `bun scripts/typecheck.ts`;
- `CI=1 bunx eslint .` in `packages/bun-jobs`, `examples/bun-jobs` and
  `playground`;
- `bun run build:types` and `bun scripts/consumer-check.ts packages/bun-jobs`,
  where the baseline is 96/96 and `defineProcessors` is added;
- `bun test` in `packages/bun-jobs` with every database URL exported, with
  **the four I4 files named as required-green**;
- `bun run-all.ts` in `examples/bun-jobs` on memory plus one server, and the
  full 8-backend sweep once (71 of 71 per backend, all five URLs exported),
  quoting what ran;
- the §4.5 do-not-change check: the X lines and the runner vocabulary
  unchanged, run as `git grep -c` on the base and on the head.

**Gate record — PR 1 alone, measured 2026-09-25** on
`feat/bun-jobs-worker-target` (base `688d376`), after `bun install` at the
root and in the three bench directories, with every `@kingsleyweb/*` package
resolving inside the worktree and no `dts/` or `bun-jobs-ui/dist` present:

| Check | Result |
|---|---|
| `bun scripts/typecheck.ts` | **15 of 16 projects clean.** The one failure is `examples/bun-jobs`: 23 errors, every one an isolation name (`isolation` as an option key ×21 in `02-queues/isolated-processors.ts`, `10-options/errors.ts` and `10-options/worker-isolation.ts`; the removed `IsolationMode` and `IsolationOptions` imports ×2). Closed by the stacked examples PR, as Sequencing step 3 expects |
| `CI=1 bunx eslint .` | `packages/bun-jobs`: 0 errors (31 `no-console` warnings, none from this change's code); `playground`: 0 errors, 0 warnings |
| bun-jobs `bun test`, all five URLs exported (MariaDB 3306, MySQL 3307, Postgres, Redis, MongoDB) | **5,147 pass, 20 skip, 0 fail** (5,167 tests, 185 files), first run. The 20 skips are `skipIf` guards unrelated to the backends (an opt-in docs-network suite, optional validators); a set but unreachable URL would have failed the run |
| The four I4 files (§4.5), required-green | `fix-attempt-write-ordering`, `fix-progress-ordering`, `fix-progress-timeout` and `worker-target`: green in the full run, and 82 of 82 on a re-run of the four alone |
| bun-jobs-ui `bun test` | **1,566 pass, 0 fail** in file order, under `--randomize --seed=1234`, and under `--seed=98765`. The optional `WorkerDto.target` needed no fixture change |
| `bun run build:types`, then `bun scripts/consumer-check.ts packages/bun-jobs` | declarations verified; **96/96 cells OK**, every spelling loading under Bun, with the new names added to `consumer-check.json` |
| Mutation checks | removing the bound in `#closeTarget` makes the close gate test fail ("closed" expected, "hung" received); removing the `@ts-expect-error` from the wrong-kind case in `workerTarget.type-test.ts` makes the typecheck fail (`TS2353`, `spawn` does not exist on `WorkerThreadTarget`) |
| Stale identifiers | a scoped grep for the worker-sense names finds 71 lines on `688d376` (the negative control) and, after, only the intentional ones: the leftover-key guard, its test, the type-test's negative control, and three playground prose lines the UI session owns |
| §4.5 do-not-change | the eight `isolat` lines in `lib/drivers/**` identical in text and line number; the runner vocabulary and child-side name counts identical in every file but the moved one, whose extra lines are the new mapping code |
| Function-processor hot path | byte-identical: the `#process()` diff touches only the condition and the target branch (§4.3) |

Not yet run, because it needs PR 2's head: the typecheck with the examples
green, `CI=1 bunx eslint .` in `examples/bun-jobs`, and the `run-all.ts`
sweeps. The benchmarks were not run; peers schedule quiet windows for them.

**Nothing in it can break a user who upgrades everything at once**, because
there are no published users. It is a breaking change for the user's own
running `playground/` only in its option spellings. Its stored data is
untouched.

### Phase 1r — runner spellings (a separate, migration-bearing follow-up)

**Not part of Phase 1** (U3). It gives runners the same words as workers, so
that the vocabulary table in §4.2.5 can be deleted. It is a migration because
the old spellings are stored and on the wire:

- **New public spellings.** `executionMode` and `allowedOverrides.executionModes`
  take `"in-process" | "worker-thread" | "child-process"`. `ExecutionMode`
  (`drivers/driver.ts:162`) and `RunContext.mode` (`runner/types.ts:103`,
  which a handler *does* see) change with them. `BUN_JOBS_MODE`'s value is
  decided here too.
- **A reader that accepts both.** Normalise `"spawn"` → `"child-process"` and
  `"worker"` → `"worker-thread"` wherever a stored value is read: run history
  (`RunRecord.mode`, JSON inside every driver's state blob, e.g.
  `sql-driver.ts:1840-1851`), `config:executionMode` and `config:allowed`
  (`runner/config.ts:38-58`). Write only the new spellings. No
  rolling-upgrade guarantee is needed (unpublished), but the user's running
  playground and any deployment's history must read cleanly.
- **The API DTO change.** `EXECUTION_MODES` (`api/contract/constants.ts:547`)
  and `ExecutionModeDto` (`api/contract/types.ts:2258`, used at
  `:2282,2374,2392,2431,2475`) move to the new spellings. The config route
  accepts the old ones on input for one release, since a UI tab open across
  the upgrade will send them.

**Size, measured on `688d376`** (`git grep -E
'executionModes?|ExecutionMode|EXECUTION_MODES|BUN_JOBS_MODE|ctx\.mode|context\.mode'`,
before classification, so an upper bound):

| Area | Files | Lines |
|---|--:|--:|
| `packages/bun-jobs/lib` | 22 | 175 |
| `packages/bun-jobs/__tests__` | 44 | 257 |
| `packages/bun-jobs/README.md` | 1 | 9 |
| `packages/bun-jobs-ui` | 17 | 133 |
| `examples` | 36 | 137 |
| `playground` | 4 | 9 |

**Effort:** bun-jobs ~3 d (spellings, the normalising reader on every driver
with old-value fixtures, the DTO and OpenAPI, tests), examples ~1.5 d, UI
~1 d. It needs the same stacked-PR merge as Phase 1, and its own
do-not-change list: the `r:` key, the `config:` state *names* and the
cursors stay exactly as `control-plane-rename.md` §6 lists them. **Place:**
after Phase 1, independent of 1.5 and 2. It can run whenever the examples and
UI sessions have a window.

### Phase 1.5 — summon-compute (committed)

**Scope, in one paragraph.** A `SummonController` per queue runs in a
bun-jobs process that is already awake. It is triggered by `add()`, by driver
events and by a poll.

- It reads **demand** through a new optional driver method, `countDemand`:
  waiting + due + stalled, zero while paused, plus "active jobs and no live
  worker".
- It claims a summon slot by **compare-and-set** on a reserved queue-state
  entry, and only then calls a **`Summoner`**.
- The summoned process runs an ordinary `BunQueueWorker` under
  **`drainAndExit()`**, which owns the idle threshold, the deadline, the signal
  handlers and the exit code.
- When its first heartbeat record appears carrying the summon id, the slot is
  released.
- A **depth endpoint** (`demand`, `outstanding`, with Prometheus exposition)
  serves KEDA-shaped platforms.
- A one-shot `check()` serves scheduled checkers.

The full plan is [`summon-compute.md`](summon-compute.md).

| Sub-phase | What | Effort |
|---|---|---|
| 1.5a | Core: `countDemand` on every driver, the controller, the marker, `drainAndExit`, provenance on the worker record, and `defineSummoner({ invoke })` for any platform | ~13 d |
| 1.5b | Depth endpoint, summon status/manual/reset routes, KEDA/ACA/CREMA/GKE recipes | ~4.5 d |
| **1.5p** | **The provider plugin API, `experimental`**: core, `summon` facet, conformance kit, first-party import test, `./provider*` entries, author guide, reference with drift test, user guide, security page, starter template | **~12.5 d** |
| 1.5c | SigV4 + credentials in `./provider/auth`; ECS `RunTask`, Lambda `Invoke`, Fly Machines as providers on the API, each with a fake and a kit run; the `./providers/*` subpaths | ~6.5 d |
| 1.5d | Google/Azure token helper; Cloud Run jobs and worker pools; ACA manual jobs; fakes and kit runs | ~4.5 d |
| 1.5e | Render one-off jobs; SSH via `systemd-run`; fakes and kit runs | ~3.5 d |
| 1.5f | UI (the UI session, ~3.5 d) and examples (the examples session, ~3 d, including a custom summon provider) | — |
| 1.5g | Live verification, one summon per adapter, time-to-first-claim | ~1.5 d |
| **1.5s** | **Summon stability gate**: six first-party providers and one outside provider pass the kit; `summon` → `1.0` | **~1 d** |
| | **Total (bun-jobs session)** | **~47 d** |

**Why the estimate grew from the draft's ~4.5 d.** The draft's
`onDemand: { invoke, idleTimeout }` did not know four things the 2026-09-25
evidence found in bun-jobs' own source:

- **Demand is not `waiting`.** `promoteDelayed`'s only caller is the worker
  (`BunQueueWorker.ts:2119`).
- **A worker registers late.** Its record follows `connect()` and
  `ensureQueue()` (`:1303-1304`), so each summon needs an in-flight marker.
- **Nothing in `lib/queue/` handles signals.**
- **`countJobs` on SQL scans retained history** (`sql-driver.ts:4302-4313`).

It also did not include first-party summoners, credentials or the depth
endpoint, and, since 2026-09-25, the provider plugin API (+14.5 d: 1.5p, the
fakes and kit runs in 1.5d–e, and 1.5s). 1.5a + 1.5b (~17.5 d) are still the
**minimum useful ship**: every platform reachable, through `invoke()` or the
endpoint.

**Still no protocol, no signing, no fencing, and no new dependency.** The
summoned worker is a first-class `BunQueueWorker`, so the control plane, the
Workers page, limits and analytics all work unchanged. It cannot reach an edge
isolate; Phase 2 exists for that.

### Phase 2 — real remote execution: the contract, the gateway, `RemoteWorker` and `RemoteRunner`

**Scope.** Everything the draft put in Phase 2:

- `remote/protocol.ts` (the versioned wire spec);
- `RemoteTarget` implementing `WorkerTargetExecutor` (§4.2.6; the draft said
  the runner's `Executor`);
- signing and verification over `crypto.subtle`;
- handshake + caching, batching, the circuit breaker;
- `HandlerNotFoundError`, and the three new `WORKER_CONFIG_KEYS`. **The
  worker's unrecoverable check must learn the new name**: it matches
  `UnrecoverableJobError` by class *and by name*
  (`BunQueueWorker.ts:3231-3237`, as of Phase 1), because an error rebuilt
  from a wire format or a child process is no longer an instance of any
  class. A `HandlerNotFoundError` that extends `UnrecoverableJobError` is still
  caught by `instanceof` in-process, but once serialised its name is
  `"HandlerNotFoundError"`, which the by-name half would not match, so a
  remote "no such handler" would be retried. Add the name to that check (or
  match on the error's `code`), with a test that crosses a boundary. Decide
  then whether `defineProcessors` (§4.4), which throws
  `UnrecoverableJobError` in Phase 1, should switch to it;
- `PROTOCOL.md`;
- `createRemoteExecutor()`: the framework-agnostic `Request → Response`
  reference implementation, which is both the thing adapters wrap and the
  thing tier-1 tests point at, and which since 2026-09-25 also runs the
  protocol over a session transport (`acceptSession`, §6.1);
- the **`execute` facet** of the provider plugin API (§4.6), exchange and
  session shapes, so the transport is pluggable from the first release of
  `RemoteWorker`;
- the **transports** of `remote-transports.md`, in sub-phases 2a–2f (below).

The phase now also delivers the user-facing names that Phase 0 freed:

- **`RemoteWorker`**: a worker whose attempts run on a remote executor. It is
  a thin, named construction over `BunQueueWorker` with `target: { kind:
  "endpoint", … }`, reached as `jobs.remoteWorker(queue, endpoint)`. Its
  gateway holds the claim and the lease exactly as §5.9 describes.
- **`RemoteRunner`**: a runner whose run executes on a remote executor. The
  §5 envelope carries a job attempt. A run needs a second, small envelope
  kind (`kind: "run"`, keyed by runner id, with no lease to renew, because a
  run is not claimed from a queue). **This is new design beyond §5 and must be
  specified in `PROTOCOL.md` before it is built.**

| Work | Effort |
|---|---|
| Protocol types + schemas (reuse `api/schema/builder`) | 2 d |
| Signing, replay window, nonce cache, key rotation | 1.5 d |
| `RemoteTarget` executor: invoke, timeout, transport retry, breaker | 2.5 d |
| Batching + the batch/outcome mapping | 1.5 d |
| `createRemoteExecutor()` reference handler | 2 d |
| `RemoteWorker` (named construction, `jobs.remoteWorker`, JSDoc, README) | 0.5 d |
| `RemoteRunner`: the `run` envelope in `PROTOCOL.md`, the runner-side executor, the reference handler's run path | 3 d |
| Tier-1 test suite (§7.2) incl. adversarial cases, both kinds | 3.5 d |
| `PROTOCOL.md` (RFC 2119, with literal request/response transcripts) + `LIMITATIONS.md` (typed "this transport cannot do that" errors, per Hatchet) + README + OpenAPI emission | 2.5 d |
| **The `execute` facet, host side** (§4.6): types, `send()` inside `RemoteTarget` (core signs, facet sends, core verifies), `locate()`, limit reconciliation with the handshake, `ProviderError` into the breaker, `httpsExecute` as the built-in for `{ endpoint }`, `lambdaExecute` if Q2 is closed (else Phase 3) | 2.5 d |
| The author guide's execute-host chapter and its reference entries | 1 d |
| **Total, before the transports** | **~22.5 d** |

**The transports, added 2026-09-25** ([`remote-transports.md`](remote-transports.md)
§13.1 has each line item). The table above becomes the first part of 2a.

| Sub-phase | What | Effort |
|---|---|---|
| **2a** | The table above, plus: the message protocol v1 (twenty message types), the text frame codec with per-frame MAC and test vectors; the attempt state machine (accept timeout, re-attach by re-POST); the health model (liveness, readiness, canary, breaker inputs, health on the worker record); the execute facet's session shape; `http-stream` with SSE framing, the first-frame rule and the buffering probe; `serveHttp`; tests with buffering and idle-cutting fakes and a SIGSTOP executor; `PROTOCOL.md` appendices A–B, the transport selection guide, two user guides and three worked executors; re-measuring the HTTP/SSE spikes on the shipped Bun | **~38 d** (22.5 + 15.5) |
| **2b** | WebSocket forward, and the reliability layer's outbox, resume and `status` | ~9.5 d |
| **2c** | TCP, TLS and Unix sockets; the binary codec and AEAD sealing; the Python stdlib executor | ~10 d |
| **2d** | Reversed WebSocket and TCP (the gateway listens, capacity-gated claiming); SSE session mode and `Last-Event-ID` re-attachment | ~8.5 d |
| **2e** | UDP: retransmission, window and fragmentation in the reliability layer; `connId`, stateless reset; the lossy proxy; `experimental` | ~10 d |
| **2f** | HTTP/2 as an experimental flag on the HTTP bindings; the informative gRPC `.proto` | ~1.5 d |
| | **Phase 2 total** | **~77.5 d** |

**The committed schedule** (the user's decision, 2026-09-25,
`remote-transports.md` Q-T1): **2a, 2b, 2c, 2d, 2e, 2f**, in that order,
all of them. 2b's reliability layer is what 2c–2e build on; 2f depends only on
2a but is scheduled last. gRPC, HTTP/3, QUIC and message brokers
are not first-party: gRPC and brokers are third-party plugins on the session
shape, HTTP/3 and QUIC are deferred until Bun marks them stable
(`remote-transports.md` §7.9–§7.12).

There is no longer a decision gate before starting: the user has decided.
What remains worth watching, as the draft said, is whether anyone builds an
endpoint target with Phase 1's `WorkerTargetFactory` first. That is still the
best early evidence of which adapters Phase 3 should ship.

### Phase 3 — the conformance kit and the first two adapters

**Scope.** `conformRemoteExecutor()` + the CLI, then Cloudflare Workers and
AWS Lambda adapters — the two that motivated the ask — plus the generic
`Request → Response` one (which covers Cloud Run, Next.js route handlers,
Vercel, Netlify, Deno Deploy and Hono/Elysia in one export). Since 2026-09-25
also the runtime-adapter kit those adapters are built with, and the two
further kits a third party runs on its execute provider (§4.6).

| Work | Effort |
|---|---|
| Conformance suite + report + CLI | 3 d |
| `./adapters/http` (generic) — mostly re-export | 0.5 d |
| `./adapters/cloudflare` + `workerd` smoke test + its unpublished test package | 2.5 d |
| `./adapters/lambda` + event-mapping unit tests | 1.5 d |
| `exports`/`dts`/`consumer-check.json`/`checkPeerScopes` wiring for the new subpaths | 1.5 d |
| Docs + a 15-line snippet per platform | 1.5 d |
| **`defineRuntimeAdapter` + `RUNTIME_ADAPTER_API`**; the three adapters above built on it, with the first-party import test extended to `lib/remote/adapters/` | 1.5 d |
| `runRuntimeAdapterConformance` (event mapping) | 1.5 d |
| `runExecuteConformance` (host transport) and its fake | 1.5 d |
| The runtime-adapter guide, the Acme Functions worked example, the template's execute half | 1.5 d |
| **Per-binding conformance** (added 2026-09-25): `conformRemoteExecutor` over every scheme and the CLI; the fakes shipped in `./remote/testing` (`bufferingHttpProxy`, `idleCuttingProxy`, `tcpChunker`, `lossyUdpProxy`, `spawnExecutor`) | 3 d |
| `runExecuteConformance`'s session-shape and capability checks | 1.5 d |
| The author guide's "Writing a transport" chapter, the Acme Queue transport in the template, the broker mapping guide | 1 d |
| **Total** | **~22.5 d** (was ~17 d) |

Phase 1.5 will already have added the host-side `./providers/*` subpaths by
then (they were `./summon/*` in an earlier draft). The two families stay
separate: `./providers/*` run in the bun-jobs process and may carry both a
`summon` and an `execute` facet; `./adapters/*` are browser-safe runtime
adapters that run on the platform. The examples session writes a custom
execute provider and runtime adapter against a local fake that passes both
kits (~1 d, [`compute-provider-plugins.md`](compute-provider-plugins.md) §15.5).

### Phase 4 — benchmarks, remaining adapters, hardening

**Scope.** The four bench scenarios in §9.3 and their baselines; Azure and
Deno adapters if anyone asks; large-payload handling; the tier-3 manual e2e
script. Cancellation and streaming progress/logs moved into Phase 2a on
2026-09-25, because every binding's health and progress depend on them.

| Work | Effort |
|---|---|
| Bench scenarios + baselines + `bench/README.md` honesty note | 3 d |
| ~~Cancellation + progress/log streaming (SSE or chunked)~~ — moved to 2a | ~~3 d~~ 0 |
| `push-loopback` per binding (`http`, `http-stream`, `ws`, `tcp`, `udp`) | 2 d |
| Remaining adapters | 2 d |
| Tier-3 script | 1 d |
| The real-network measurements the transports rest on (`remote-transports.md` Appendix B: UDP loss and MTU, keep-alive under partition, proxy buffering, idle cuts) | 2 d |
| **Execute stability gate**: the first-party adapters, `httpsExecute`, `lambdaExecute` and one outside provider pass both kits; `execute` → `1.0`, and `core` → `1.0` if the summon gate has passed | 1 d |
| **Total** | **~11 d** (was ~10 d) |

### Explicitly out of scope

- **An HTTP driver** (pull mode from a foreign runtime) — §10.1.
- **Async/callback completion** — §10.4, §10.6. It is a second state machine
  and a public write surface; it deserves its own plan.
- **Running the whole worker loop remotely.** There is no such thing: a worker
  loop needs a driver. What people mean by it is either pull (needs a driver
  — summon-compute, Phase 1.5, starts such a process) or push (Phase 2).
- **A hosted service.** Trigger.dev's model is a product, not a library
  feature.

### Recommendation

**Ship in order: 0, 1, 1.5a–b, then the rest of 1.5 and Phase 2 in parallel
if two people are available.** Phases 0 and 1 are small and unblock
everything else. Phase 1r (runner spellings) depends only on Phase 1 and fits
any window the examples and UI sessions have. Until it lands, §4.2.5's
vocabulary table is the documented bridge.

Phase 1.5's minimum useful ship (1.5a + 1.5b, ~17.5 d) serves the commonest
request, "I do not want a worker running 24/7", on every host that can reach
the driver. Phase 2 then serves the hosts that cannot, with every binding
the user asked for, committed and built in order, 2a to 2f (~77.5 d). Its
first milestone, 2a (~38 d), already reaches every platform with an inbound
HTTP path, with health, live progress and heartbeats; 2b–2f follow in order.
TCP and UDP reach nothing HTTP and WebSocket do not, and are built for
polyglot executors and private networks (`remote-transports.md` §1.3).

The one lesson from the draft that still applies to Phase 2 is Hatchet's:
it shipped a serverless transport in 2024, let it go undocumented, and is
rebuilding it this month. **Phase 2 ships with `PROTOCOL.md`, the conformance
kit (Phase 3) and a version, or it does not ship.** The same lesson is why the
plugin system ships its author guide, reference and kit in the same
sub-phase as its API ([`compute-provider-plugins.md`](compute-provider-plugins.md) §15).

---

## Appendix: evidence

The fourteen-system comparison in §3.8 is a summary. The full survey it was
drawn from — transports, lease mechanics, auth, what to steal and what to
avoid, each at a pinned version with file paths — is in
[`evidence/worker-runtimes/prior-art-survey.md`](evidence/worker-runtimes/prior-art-survey.md),
about 1,080 lines. Inngest's `SDK_SPEC.md` is normative for the artifact §5
describes and should be read in full before phase 2.

**Read the provenance markers.** Every row is tagged as read-by-me, read by a
delegated agent at a pinned version, or unverified, and the distinction is
load-bearing rather than decorative. Three claims that reached an earlier draft
of this plan were later withdrawn, disproved or re-attributed — the
stalled-grace recommendation in §3.8.2, the `pg_notify` latency consequence in
§3.8.3(a) (measured, null), and the `worker_threads` stdio trap — and every one failed the same way: a
plausible inference from a secondary source that nobody had checked against the
code it described.

That is the argument for keeping the workings rather than the conclusions. The
survey is what made those reversals possible to find.

**Summon-compute (Phase 1.5)** rests on three further evidence files, all
gathered on 2026-09-25 and indexed in
[`evidence/summon-compute/README.md`](evidence/summon-compute/README.md):

- [`aws.md`](evidence/summon-compute/aws.md): ECS, Lambda, EC2, EKS, Batch
  and the rest, plus a measured SigV4 signer.
- [`google-azure.md`](evidence/summon-compute/google-azure.md): Cloud Run,
  GKE, ACA, ACI and KEDA, plus a token helper. It is also where the
  zero-worker blind spot was found.
- [`paas-ssh.md`](evidence/summon-compute/paas-ssh.md): Fly, Render, Heroku,
  Railway, SSH, Kubernetes and Nomad. It is also where the late-registration
  finding was made.

They use the same provenance tags, and
[`summon-compute.md`](summon-compute.md) carries those tags into every fact it
quotes.

**The transports of Phase 2** rest on two further evidence files, gathered on
2026-09-25 and indexed in
[`evidence/remote-transports/README.md`](evidence/remote-transports/README.md):

- [`bun-transports.md`](evidence/remote-transports/bun-transports.md): what
  Bun provides per transport, **measured** by 27 re-runnable spikes (in
  `spikes/` beside it), on loopback and on a canary build
  (`1.4.3-canary.1`), so each must be re-run on the shipped release.
- [`platform-transports.md`](evidence/remote-transports/platform-transports.md):
  which of ~35 platform shapes accept which transport, their idle and
  lifetime limits, their health mechanisms, and where intermediaries silently
  break a protocol. It recommends against specifying TCP and UDP; the design
  specifies them at the user's request and records why
  ([`remote-transports.md`](remote-transports.md) §1.3).

[`remote-transports.md`](remote-transports.md) carries both files' tags into
every fact it quotes, and adds one spike of its own (its Appendix A).
