# Where a `BunQueueWorker` can run

Research and implementation plan for making `BunQueueWorker` in
`@kingsleyweb/bun-jobs` runnable somewhere other than the process that defines
it — as a configurable execution target, and as a published contract a foreign
system can implement.

Written 2026-09-22 against `develop` (`feat/ui-followups`, `8396815`).
**No code was changed.** Platform facts are marked verified or unverified; see
§3.5 for the provenance of each.

### Contents

1. [Executive summary](#1-executive-summary)
2. [What exists today](#2-what-exists-today)
3. [Taxonomy: two orthogonal axes](#3-taxonomy-two-orthogonal-axes) — including
   [the platform comparison](#35-the-platform-comparison),
   [Cloudflare](#36-cloudflare-in-detail--the-platform-that-decides-the-design),
   [AWS Lambda](#37-aws-lambda-in-detail--the-freeze-and-the-2026-exception) and
   [prior art](#38-how-comparable-systems-solve-this)
4. [Execution-target API design](#4-execution-target-api-design)
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
or a child process through the runner's executors, and `RemoteWorker.ts`
already controls workers in other processes. What does not exist is a *data*
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
| 4 | **The new target is an `Executor`** — the existing `runner/executors/executor.ts` interface — **but not the existing executors and not the existing IPC protocol.** | `ExecutorHandle { done, stop, send }` is exactly right. `ParentToChild`/`ChildToParent` is a stateful duplex channel with a `ready` handshake, and stretching it over HTTP would force every implementer to re-model framing a request/response transport already has. §2.4 |
| 5 | **The contract is its own surface, not an extension of `createJobsApi`.** | Opposite direction, incompatible auth model (cookies+CSRF+48 admin actions vs a shared secret), and `lib/api/` cannot load in a V8 isolate. It *reuses* `api/schema`, `ProblemDto` and the OpenAPI emitter. §5.1 |
| 6 | **Signing is Stripe/Inngest-shaped: HMAC-SHA256 over `t + "." + rawBody`, 300 s replay window, responses signed too.** | It is the scheme implementers already know, and response signing is what stops a DNS hijack marking jobs complete. §5.6 |
| 7 | **Adapters ship as `./adapters/*` subpaths with zero cloud dependencies** — the platform types are declared structurally and checked against the real SDK types in a devDependency type-test. | `CLAUDE.md`'s dependency rule, satisfied by not needing an exception. Every new entry is `"browser": true` in `consumer-check.json`, and `checkPeerScopes` has nothing to check. §6.2-6.3 |
| 8 | **There is a cheaper fourth option — *summon-compute* — that this plan does not build, and the maintainer should rule it in or out before phase 2.** | Temporal shipped serverless workers on 2026-07-17 by making the *scheduler* able to invoke compute, while the worker contract stayed exactly what it was. The bun-jobs analogue is: notice queue depth with no live worker, invoke a Lambda or Cloud Run job that runs an ordinary `BunQueueWorker`, let it drain and exit. No protocol, no signing, no adapters — and it works on every host in §3.5 that can hold its own lease. §3.8.1 |
| 9 | **Phase 1 is the `target` option, local only, and it should ship on its own.** | It is a widening of something already shipped, carries no protocol and no security surface, and the `WorkerTargetFactory` escape hatch it adds is the market research for whether phase 2 is worth building. §11 |

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
it is currently undersold. Two adjacent improvements are in §3.8.2 (BullMQ's
two-pass stalled check) and §5.8 (Trigger.dev's snapshot-id fencing).

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
has one of those. Deciding whether that case is real is §10.11's first open
question, and it should be answered before phase 2, not after.

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

### 2.2 `RemoteWorker.ts` is **not** a remote worker

This is the most important finding for the ask, and it is a naming collision.
`packages/bun-jobs/lib/queue/RemoteWorker.ts` is a **remote control plane for
local workers**: `pause`, `resume`, `stop`, `start`, `setConfig`,
`resetConfig`, `list`, `get`, `listConfigs`, `getConfig`. It writes
queue-state entries (`workerControl.ts`) that a `BunQueueWorker` running
somewhere else reads and applies. It never runs a job, never claims, never
carries a payload. `RemoteRunner.ts` is its twin for runners.

So: **the control plane for off-process workers is done.** What does not exist
is a *data* plane — anything that moves a job to a process that is not holding
the driver.

Naming consequence: the new thing cannot be called `RemoteWorker`. This plan
uses **worker gateway** (the bun-jobs side) and **remote executor** (the
foreign side).

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
| `RemoteRunner.ts` | control plane, like `RemoteWorker` |

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
  ordinals, creates `RemoteWorkerManager` with `locals: () => this.#workers`,
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
| Control a worker from another process | **Done** — `RemoteWorker`, `workerControl.ts`, API routes, UI |
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
See §3.8.1.

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
   Hyperdrive**, and session advisory locks are unusable behind RDS Proxy.
   Both are present-day limitations of the existing `SqlDriver`, independent of
   this plan, and belong in the driver documentation now.
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
| RDS Proxy pinning | PostgreSQL pins the session on `SET`, `PREPARE`/`EXECUTE`, temp objects, **declaring cursors**, **`LISTEN`**, and **`pg_advisory_lock`** — but *not* `pg_advisory_xact_lock`. *"RDS Proxy doesn't support session pinning filters for PostgreSQL"* — no opt-out. Also: no `CancelRequest` for PostgreSQL |

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
5. **`sql.listen` cannot be used behind RDS Proxy**, and neither can session
   advisory locks. bun-jobs' `SqlDriver` uses `sql.listen` for push events on
   Postgres. A worker behind RDS Proxy must fall back to polling. **This is a
   real, present-day limitation of the existing SQL driver, independent of
   this plan**, and belongs in the driver documentation regardless.
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
| **Graphile Worker** (verified — v0.18.0, 2026-09-08) | **No remote contract; the contract is the SQL schema.** A batched `UPDATE … FROM (… FOR UPDATE SKIP LOCKED)` CTE against `_private_jobs`; the stable public interface is the `graphile_worker.jobs` **view**, which deliberately omits `payload`. **An exhaustive grep of the v0.18.0 tree for a non-Node worker story returns exactly one hit** — *"Executes tasks written in Node.js (these can call out to any other language or networked service)"*. The **producer** side is language-agnostic: anything that can `select graphile_worker.add_job(...)`, including a trigger | Pull, woken by `NOTIFY`, with a 2,000 ms poll as the safety net | `locked_at`/`locked_by` — and `locked_by` is the **pool** id, not the worker's. **No heartbeat at all**; the only recovery is `locked_at < now() - interval '4 hours'` | Postgres credentials | **`LISTEN`/`NOTIFY` for latency plus a short poll for safety — and a random `r` field in the NOTIFY payload to defeat Postgres' in-transaction NOTIFY coalescing** (§3.8.3). Also the `job_key` + `job_key_mode` triad — `replace` = debounce, `preserve_run_at` = throttle — the clearest idempotency vocabulary here. And it publishes *measured* throughput for four locking strategies, which is unusual and worth reading before writing any SQL driver | A **4-hour** fixed stale-lock window with no heartbeat: a crashed pool strands its jobs for hours |
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

**What this means for bun-jobs, honestly.** There is a fourth option this plan
does not offer, and it is cheaper than §5:

> **Summon-compute.** A `BunQueue` (or a small controller beside it) notices
> the queue has depth and no live worker, and invokes *something* — a Lambda,
> a Cloud Run job, a container — whose only job is to run an ordinary
> `BunQueueWorker` against the real driver until the queue drains, then exit.
> No wire protocol, no signing, no fencing, no adapters. One option shaped
> like `onDemand: { invoke, idleTimeout }`, and a documented worker file.

It **only works where the summoned thing can reach the driver** — so Lambda
(VPC), Cloud Run jobs and worker pools, ACA jobs and Cloudflare Containers,
but never an edge isolate. That is precisely the §3.5 list of hosts that can
hold their own lease. It is strictly less capable than the push contract and
**perhaps a tenth of the work**. It belongs in §10.11 as an open question the
maintainer should answer before phase 2, and arguably as a phase 1.5.

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

### 3.8.2 BullMQ's stalled check, which is better than ours

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

**The property that makes it better than what bun-jobs does today:** a job is
declared stalled only if it was in `active` **at the previous sweep** *and* its
lock is gone **now**. That is one full interval of grace *plus* the lock TTL,
and it requires two independent observations. A plain "lock expired ⇒ stalled"
check — which is what `#armMaintenance()` and the drivers' stall recovery
implement — can kill a job on a single slow tick.

bun-jobs' `maxStalledCount` defaults to 1, exactly as BullMQ's does, so it
inherits the same sharp edge with none of the grace. Two things follow, and
both are **independent of everything else in this plan**:

- The single-sweeper guard key is nearly free and would replace "every worker
  does maintenance, each operation is idempotent" with "one worker does it per
  interval" — the same correctness, a fraction of the load. Note the existing
  `FLOW_HEAL_LEASE` in `BunQueueWorker.ts` is already this idea, applied to
  flow healing only.
- The mark-then-sweep grace is a behaviour change and needs its own decision,
  but it is the cheapest available fix for the "a CPU-bound processor starves
  its own heartbeat and loses its job" failure.

Neither belongs in this plan's phases. Both belong in an issue.

### 3.8.3 Four things the survey turned up that have nothing to do with this plan

Each is independent of every decision above, and each is cheaper than
anything in §11. They belong in issues, not in this plan's phases.

#### (a) A latency bug in the shipped SQL driver, found via Graphile Worker

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
N.** Workers wake once, claim a batch, and the remainder of the backlog waits
for `pollInterval` (1,000 ms by default) instead of being announced.

Scope, stated honestly: **read from the source, not measured.** It is a latency
bug, not a correctness one — polling finds the jobs regardless, and the driver
already documents notifications as best-effort. `addJob` (singular) is
unaffected. The fix is Graphile's: put something varying in the payload, which
costs nothing and is already the pattern the driver's own arrivals channel
could carry a count on. **Worth a benchmark against `enqueue-bulk` before and
after**, since that scenario is exactly where it would show.

#### (b) bun-jobs already dodged a Bun `worker_threads` trap — keep it that way

BullMQ carries a source comment citing `bullmq#2232`: **Bun ignores
`worker_threads` `stdin`/`stdout`/`stderr` options.** Anything that plans to
pipe a thread's stdio on Bun is building on sand.

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

1. **A file path both sides can resolve** — what `IsolatedProcessor` already
   does. Works for `"thread"`, `"process"`, `{ file }`.
2. **A name both sides agreed on beforehand** — the registry. `JobDefinitions`
   already keys handlers by name; a remote executor publishes the names it can
   run and the gateway matches `record.name` against them. Works for
   `{ endpoint }`.
3. **Code shipped at deploy time** — out of scope; that is Trigger.dev's
   business model, not a library's.

So `{ file }` resolves through `Bun.resolveSync` (as `resolveProcessorFile`
already does) and `{ endpoint }` resolves through **names**. Two different
resolution stories, and the API must not pretend otherwise.

### 4.2 The new option

`isolation` is kept and deprecated-in-docs, not removed: it is shipped, it is
in the README, and it is in `WORKER_CONFIG_KEYS`-adjacent documentation. The
new option is `target`, and `isolation: m` is exactly `target: m`.

```ts
/**
 * Where each attempt actually runs.
 *
 * The worker always owns the claim, the lease and the settle — only the
 * *processor* moves. `"in-process"` is the default and is byte-for-byte the
 * behaviour every worker has had: the processor is called on the claim
 * loop's own thread.
 *
 * - `"in-process"` — call it here. A function processor only ever does this.
 * - `"thread"` — a fresh `Worker` per attempt: a separate JavaScript context
 *   that can be terminated, in this process. Needs a file processor.
 * - `"process"` — a fresh child process per attempt: the only mode where a
 *   processor that ignores its signal can be killed for certain. Needs a
 *   file processor.
 * - `{ file }` — a file processor with per-target options, so the file can
 *   be given here rather than to the constructor.
 * - `{ endpoint }` — **push mode**: the attempt is sent over HTTP to a
 *   conforming remote executor (§5) and its answer is the outcome. The
 *   worker still holds the lease for the whole round trip.
 * - a {@link WorkerTargetFactory} — anything else, including a transport
 *   this package does not ship.
 *
 * `"spawn"` and `"worker"` are accepted as the previous spellings of
 * `"process"` and `"thread"`; {@link BunQueueWorkerOptions.isolation} is the
 * previous name of this option and means the same thing. Giving both is a
 * `ConfigError`.
 */
target?: WorkerTarget;
```

```ts
/** Where a worker's attempts run. */
export type WorkerTarget =
  | WorkerTargetMode
  | LocalFileTarget
  | RemoteEndpointTarget
  | WorkerTargetFactory;

/**
 * The three local modes, plus the two previous spellings.
 * `"spawn"` === `"process"`, `"worker"` === `"thread"`.
 */
export type WorkerTargetMode =
  | "in-process"
  | "thread"
  | "process"
  | "spawn"
  | "worker";

/** A file processor run locally, with its own executor options. */
export interface LocalFileTarget {
  /** Marks the variant. */
  kind: "file";
  /**
   * The processor file: a path relative to the working directory, or a URL.
   * Default-exports `(job, ctx) => result`; `defineProcessor` types it.
   * Resolved with `Bun.resolveSync` at construction, so a bad path is a
   * `ConfigError` at once rather than on the first claim.
   */
  file: string | URL;
  /** Where each attempt runs. Defaults to `"process"`. */
  mode?: "in-process" | "thread" | "process";
  /** Executor tuning: close/kill timeouts, spawn and `Worker` options. */
  options?: IsolationOptions;
}

/** A conforming remote executor reached over HTTP. See §5. */
export interface RemoteEndpointTarget {
  /** Marks the variant. */
  kind: "endpoint";
  /**
   * Absolute URL of the remote executor's invoke endpoint, e.g.
   * `https://worker.example.com/bun-jobs`. The gateway POSTs an
   * `invoke` envelope here and reads the outcome from the response.
   */
  url: string;
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
   * in milliseconds. Defaults to `min(lockDuration, job.opts.timeout || ∞)`
   * minus one `heartbeatInterval`, so the worker still owns a live lease when
   * it decides the remote is gone. A value above `lockDuration` is a
   * `ConfigError`: the lease would lapse mid-call and a second worker would
   * run the same job.
   */
  timeout?: number;
  /**
   * How many attempts may be in flight to this endpoint at once. Defaults to
   * the worker's `concurrency`. Lower it when the endpoint's own concurrency
   * is the scarce resource — a Lambda reserved-concurrency cap, say.
   */
  maxInFlight?: number;
  /**
   * How many attempts to send in one request. `1` (the default) is one job
   * per HTTP call. Above that, the gateway fills a batch for up to
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
  /** Extra headers on every request — a platform's own auth, a trace header. */
  headers?: Record<string, string>;
  /**
   * How a failed *transport* is retried before the attempt is failed:
   * a connect error, a 5xx, a 429 with `Retry-After`. Defaults to three
   * tries with jittered backoff, bounded by `timeout`. A transport retry is
   * **not** a job attempt: `attemptsMade` does not move, and the idempotency
   * key is unchanged, so a remote that already ran it answers from its cache
   * (§5.8).
   */
  transportRetry?: { attempts?: number; maxDelay?: number };
}

/**
 * Builds an executor for a transport this package does not ship — gRPC, a
 * message bus, a platform-specific SDK a published package must not depend on.
 * Called once per worker, at construction.
 */
export type WorkerTargetFactory = (context: {
  /** The namespace the worker consumes from. */
  namespace: string;
  /** The queue it consumes. */
  queue: string;
  /** The worker's incarnation id. */
  workerId: string;
  /** The worker's logger, already bound. */
  logger: Logger;
}) => Executor;
```

`Executor` is the existing `runner/executors/executor.ts` interface, unchanged.
That is the whole extension point: a custom target is an `Executor` whose
`mode` is a string of its own.

### 4.3 What changes inside `BunQueueWorker`

Small, and localised:

| Where | Change |
|---|---|
| constructor | resolve `target` ?? `isolation`; a `ConfigError` when both are given, or when a non-`"in-process"` target is paired with a function processor *and* no `{ endpoint }` |
| `#isolated` field | becomes `#target: JobTarget \| undefined` — `IsolatedProcessor` grows an `endpoint` mode, or a sibling `RemoteTarget` implementing the same `run(job, record, context, controller, runner)` |
| `#process()` | unchanged apart from which object `run()` is called on. The timeout, the abort, the heartbeat interval, the settle path are all untouched |
| `#report()` | the heartbeat record gains `target: { mode, endpoint? }` so the Workers page can show it (§8) |
| nothing else | claim, lease, settle, control, limits, maintenance are unaware |

**That is the whole point of the design.** The lease stays with the process
that holds the driver. No new failure mode is introduced into claiming.

### 4.4 The `{ file }` / registry resolution story

A file target and the definition registry are two ways of answering "what runs
this job", and they compose:

- **One file, one processor.** `export default defineProcessor(...)`. The
  worker dispatches on nothing; every claimed job goes to that function. This
  is what ships today.
- **One file, many names.** The file imports the app's `defineJob` calls and
  default-exports a dispatcher. Nothing new is needed — but it is boilerplate
  everybody writes, so add:

```ts
/**
 * A processor file that dispatches on the job's name.
 *
 * Takes the same {@link JobDefinition}s `BunJobs.define()` takes, so one
 * module of definitions can be imported by the producer (which needs the
 * names and options) and default-exported here (which needs the handlers).
 * A name with no definition throws {@link HandlerNotFoundError}, which is
 * unrecoverable: no number of retries will find a handler that was not
 * deployed.
 */
export function defineProcessors(
  definitions: readonly JobDefinition<any, any>[] | JobDefinitions,
): JobProcessor<unknown, unknown>;
```

- **A separate Bun process from a runner file.** Already composable and should
  stay that way rather than becoming an option — a file that builds a
  `BunJobs`, calls `jobs.worker(...)`, and `await worker.run()`, started by
  `BunRunner` with `mode: "spawn"` and `single: true`. Add it to the README
  and to `examples/bun-jobs/07-runner/` rather than to the API. A `target`
  value that forked *the whole worker* would have to move the driver config,
  the control subscription and the heartbeat record into the child, and would
  then be a second, worse `BunRunner`.

### 4.5 Backward compatibility, precisely

- `target` absent → `IsolationMode` path exactly as today.
- `isolation: "in-process" | "spawn" | "worker"` → maps to `target` with no
  behaviour change; `runner-modes.test.ts`-style parity test asserts it.
- `IsolationMode`, `IsolationOptions`, `IsolatedProcessor`, `defineProcessor`
  stay exported with their current types. `consumer-check.json` keeps
  `defineProcessor`.
- `ExecutionMode` in `drivers/driver.ts` (`"spawn" | "worker" | "in-process"`)
  is **not** changed: it is stored in `RunRecord.mode` and a driver's rows.
  The new spellings are a worker-level alias only. This is deliberate and the
  plan should not be talked out of it — renaming a persisted enum is a
  migration for no gain.
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

- **HTTP/1.1 or HTTP/2, `application/json`, UTF-8.** One URL; the method
  selects the operation. No path structure to agree on — a remote may mount it
  at `/bun-jobs`, at `/api/jobs`, or at `/`.
- **`GET`** — handshake. Idempotent, cacheable-by-us for `introspectTtl`.
- **`POST`** — every other operation, discriminated by `envelope.op`.
- **Long-lived response.** The gateway holds the connection for the whole
  attempt; that is what lets it own the lease. Keep-alive is required in
  practice and the gateway must reuse connections (§9).
- **WebSocket is a later phase, for one specific problem**: a remote with no
  public URL. The remote dials the gateway and the gateway pushes invokes down
  the socket. The message bodies are the same envelopes; only the framing
  changes. The management API's WS unit (`api/ws/`) is the model for session
  handling, but **not** the same socket — see §5.1.
- **SSE / chunked NDJSON is how progress comes back** (§5.10), on the *same*
  response as the invoke. That is deliberate: it means the remote never needs
  to call bun-jobs, so bun-jobs never has to expose an inbound write surface
  to the internet (§10.6).

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
| `deadlineAt` | yes | epoch ms after which the gateway stops caring. Derived from the lease, never above it |
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
is a `ConfigError` at construction, not a runtime warning.

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
| D. The remote streams progress frames, each of which renews | the gateway extends the lease on every frame it reads | **good, additive**: it is option A plus liveness evidence. Phase 4 (§5.10) |

So: **the answer is that the frozen-process problem does not arise in push
mode, because the process that holds the lease is never frozen.** That is the
strongest single argument for push over pull and it should lead the README
section.

What *does* need care: the gateway's `heartbeatInterval` (default
`lockDuration / 3`) must be comfortably shorter than the network timeout, and
the endpoint's `timeout` must be below `lockDuration` (§4.2, enforced as a
`ConfigError`). And a job whose `timeoutMs` exceeds the remote's
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
could hold a lease indefinitely.

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

The signature covers the **whole** streamed body, which cannot be verified
until it ends. So: progress frames are applied optimistically and the final
`invoke-result` is applied only after verification. A stream whose signature
fails to verify at the end invalidates nothing already written (progress and
log lines are not job outcomes) and the attempt is failed as
`SIGNATURE_INVALID`. Document that trade-off rather than pretending it does
not exist. A remote that is not comfortable with it does not advertise
`progress-stream` and gets a single verified response.

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
## 7. Conformance test kit

### 7.1 For a third-party implementer

Ship a **runnable conformance suite** as part of the package, not a document.
It is the only thing that makes "a documented contract" real.

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
third job never appears in the answer.

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

**It is not a worker.** The `WorkerInfo` record (`drivers/driver.ts:1339`) is
written by `#report()` from a process that holds the driver: `id`, `key`,
`service`, `host`, `pid`, `concurrency`, `active`, `state`, `processStartedAt`,
`version`, `completed`, `failed`, `config`, `control`. A Cloudflare Worker
writes none of that, and cannot — it has no driver.

So in push mode the **gateway** is the worker, exactly as it is today, and the
endpoint is an attribute of it. Three additions:

```ts
/** Where this worker's attempts run. Absent means in-process, as before. */
target?: {
  /** `"in-process" | "thread" | "process" | "endpoint"`, or a custom mode. */
  mode: string;
  /** For `"endpoint"`: the URL, origin only — never the path or a query. */
  endpoint?: string;
  /** For `"endpoint"`: what the remote said about itself at the last handshake. */
  remote?: {
    /** The remote's declared name, e.g. `"orders-cf"`. */
    name?: string;
    /** Protocol version it negotiated. */
    protocol: number;
    /** Runtime it reported, e.g. `"workerd"`, `"nodejs22.x"`, `"bun"`. */
    runtime?: string;
    /** Job names it said it can run. */
    names?: string[];
    /** When the last successful invoke or handshake was, epoch ms. */
    lastSeenAt: number;
    /** Consecutive transport failures; `0` while it is answering. */
    failures: number;
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
| `endpointTimeout` | yes, for the next invoke | add, bounded by `lockDuration` |
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
  `in-flight, response overdue`, not `failed`.
- **How many instances are behind the endpoint.** One URL may be a thousand
  Lambda containers. The "worker" is the gateway; instance count is the
  platform's console, not ours.
- **Logs from the remote**, unless it sends them back on the `progress`
  channel (§5.10) or in its final response. `job.log()` works either way
  because the gateway writes it.

Concretely: `WorkerTable.tsx` gets a target badge; `WorkerScreen.tsx` gets a
"Target" card showing mode, origin, last handshake, negotiated protocol,
advertised names, consecutive failures; `WorkerConfigCard.tsx` picks up the
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
| `"thread"` | `Worker` spawn + structured clone | already measured by `worker-isolation`; dominated by spawn, so batch-per-worker would help and does not exist |
| `"process"` | `Bun.spawn` + JSON IPC | worst of the local three; a process per attempt |
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
| Endpoint hangs past `timeout` | gateway aborts the fetch, fails the attempt, retries per the job's backoff | `timeout` is forced below `lockDuration` (§4.2), so the lease is still live when the decision is made |
| Endpoint hangs, gateway *crashes* | lease lapses, stalled sweep re-claims after `lockDuration + stalledInterval`, the remote may still be running | fencing token (§5.8); `maxStalledCount` |
| Endpoint answers after the gateway gave up | response is discarded; the job already failed | idempotency key + the remote's result cache means the *retry* is answered from cache rather than re-run |
| Endpoint is dead for everyone | every attempt fails, every job burns attempts, the queue drains into dead-letter | **circuit breaker**: after N consecutive transport failures the gateway pauses claiming rather than failing jobs. This is not optional; without it, one bad deploy buries a day of work in ten minutes |
| Gateway is pausedmid-call | the in-flight call completes; `pause()` only stops claiming, as today | already correct |

The circuit breaker is the single most important operational feature in §5/§6
and it is easy to forget because it is not part of the wire protocol.

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
- **The `RemoteWorker` name collision** (§2.2) will cause a documentation
  accident if the new work is not named deliberately from day one.

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

1. **Is push-remote worth it at all, versus documenting "run a second Bun
   process"?** The honest case for it is narrow: code that can only run on
   that platform, or a team that only has that platform. Worth deciding
   before phase 2, not after.
1b. **Or versus *summon-compute*?** (§3.8.1.) An `onDemand: { invoke,
   idleTimeout }` option that invokes a Lambda or Cloud Run job running an
   ordinary `BunQueueWorker` is perhaps a tenth of phase 2's work, needs no
   protocol, no signing, no fencing and no adapters, and covers every host
   that can reach the driver. It cannot reach an edge isolate. **If the real
   demand turns out to be "I do not want a worker running 24/7" rather than
   "my code only runs on Cloudflare", this is the answer and §5 is not.**
   Establish which before committing to phase 2.
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
## 11. Phased delivery

Each phase is independently shippable, independently testable, and leaves the
package in a coherent state if the next one never happens. Effort is in
focused days for someone who wrote this code.

### Phase 1 — the `target` option, local only (**recommended first ship**)

**Scope.** `target` on `BunQueueWorkerOptions`, the `"thread"`/`"process"`
spellings, `LocalFileTarget`, `WorkerTargetFactory`, `defineProcessors()`,
`target` on the heartbeat record, the Workers-page badge, the "worker in a
second Bun process via `BunRunner`" documentation + example.

**Why first.** It is the API the other phases hang off, it is almost entirely
a rename and a widening of something already shipped, it carries no protocol,
no security surface and no network, and it is useful on its own — the
`WorkerTargetFactory` escape hatch alone lets a user build anything this plan
defers.

| Work | Effort |
|---|---|
| `target` resolution + `ConfigError`s + JSDoc | 1 d |
| `IsolatedProcessor` → target dispatch; `Executor`-based custom target | 1 d |
| `defineProcessors()` + registry-dispatch file | 0.5 d |
| `WorkerInfo.target` + serializer switch + API DTO + schema | 1 d |
| UI badge + Target card | 1 d |
| Tests: parity (the `runner-modes.test.ts` shape), config errors, custom target | 1.5 d |
| README section, option tour example, `examples/bun-jobs/07-runner/` worker-file example | 1 d |
| **Total** | **~7 d** |

**Ships nothing that can break an existing user.** No new dependency, no new
`exports` key, no `consumer-check.json` change beyond `defineProcessors`.

### Phase 1.5 — summon-compute (optional, and possibly instead of phases 2–4)

**Scope.** An `onDemand` option on `BunQueue` or a small controller beside it:
watch queue depth and the live-worker inventory (`listWorkerRecords` already
provides both), and when there is work and no worker, call a user-supplied
`invoke()` — a Lambda invocation, a Cloud Run Jobs `run`, a container start.
The invoked process runs an ordinary `BunQueueWorker` from a worker file until
`idleTimeout` of quiet, then exits. Take `shutdownDeadlineBufferMs` from
Temporal: begin the graceful stop *before* the platform's deadline.

| Work | Effort |
|---|---|
| `onDemand` option, depth/worker check, debounce, and a stampede guard | 2 d |
| Worker-file recipe + `examples/bun-jobs/` tour + README | 1 d |
| Tests: invokes once, not per job; does not invoke when a worker is live; exits on idle | 1.5 d |
| **Total** | **~4.5 d** |

**No protocol, no signing, no fencing, no adapters, no new dependency**, and
the summoned worker is a first-class `BunQueueWorker` — so remote control, the
Workers page, limits and analytics all work unchanged. It cannot reach an edge
isolate. See §3.8.1 and §10.11 question 1b: **if this is what people actually
want, phases 2–4 do not need to happen.**

### Phase 2 — the remote contract and the gateway

**Scope.** `remote/protocol.ts` (the versioned wire spec), `RemoteTarget`
implementing `Executor`, signing/verification over `crypto.subtle`, handshake
+ caching, batching, the circuit breaker, `HandlerNotFoundError`, the three
new `WORKER_CONFIG_KEYS`, `PROTOCOL.md`, and `createRemoteExecutor()` — the
framework-agnostic `Request → Response` reference implementation, which is
both the thing adapters wrap and the thing tier-1 tests point at.

| Work | Effort |
|---|---|
| Protocol types + schemas (reuse `api/schema/builder`) | 2 d |
| Signing, replay window, nonce cache, key rotation | 1.5 d |
| `RemoteTarget` executor: invoke, timeout, transport retry, breaker | 2.5 d |
| Batching + the batch/outcome mapping | 1.5 d |
| `createRemoteExecutor()` reference handler | 2 d |
| Tier-1 test suite (§7.2) incl. adversarial cases | 3 d |
| `PROTOCOL.md` (RFC 2119, with literal request/response transcripts) + `LIMITATIONS.md` (typed "this transport cannot do that" errors, per Hatchet) + README + OpenAPI emission | 2.5 d |
| **Total** | **~15.5 d** |

**Decision gate before starting:** §10.11 question 1. If the answer is "a
second Bun process is enough", phases 2–4 do not happen and phase 1 is the
whole project.

### Phase 3 — the conformance kit and the first two adapters

**Scope.** `conformRemoteExecutor()` + the CLI, then Cloudflare Workers and
AWS Lambda adapters — the two that motivated the ask — plus the generic
`Request → Response` one (which covers Cloud Run, Next.js route handlers,
Vercel, Netlify, Deno Deploy and Hono/Elysia in one export).

| Work | Effort |
|---|---|
| Conformance suite + report + CLI | 3 d |
| `./adapters/http` (generic) — mostly re-export | 0.5 d |
| `./adapters/cloudflare` + `workerd` smoke test + its unpublished test package | 2.5 d |
| `./adapters/lambda` + event-mapping unit tests | 1.5 d |
| `exports`/`dts`/`consumer-check.json`/`checkPeerScopes` wiring for the new subpaths | 1.5 d |
| Docs + a 15-line snippet per platform | 1.5 d |
| **Total** | **~11 d** |

### Phase 4 — benchmarks, remaining adapters, hardening

**Scope.** The four bench scenarios in §9.3 and their baselines; Azure and
Deno adapters if anyone asks; cancellation; streaming progress/logs back;
large-payload handling; the tier-3 manual e2e script.

| Work | Effort |
|---|---|
| Bench scenarios + baselines + `bench/README.md` honesty note | 3 d |
| Cancellation + progress/log streaming (SSE or chunked) | 3 d |
| Remaining adapters | 2 d |
| Tier-3 script | 1 d |
| **Total** | **~9 d** |

### Explicitly out of scope

- **An HTTP driver** (pull mode from a foreign runtime) — §10.1.
- **Async/callback completion** — §10.4, §10.6. It is a second state machine
  and a public write surface; it deserves its own plan.
- **Running the whole worker loop remotely.** There is no such thing: a worker
  loop needs a driver. What people mean by it is either pull (needs a driver)
  or push (this plan).
- **A hosted service.** Trigger.dev's model is a product, not a library
  feature.

### Recommendation

**Ship phase 1 alone, then stop and decide.** It closes most of the ask's
"where can it run" half at low risk, and it makes the answer to the second
half visible: once `WorkerTargetFactory` exists, whether anyone builds an
endpoint target with it is the market research for phase 2.

**And when you do decide, decide between phase 1.5 and phase 2 rather than
scheduling both.** They answer different questions — "I do not want a worker
running 24/7" versus "my code can only run on Cloudflare" — and only the
second justifies a wire protocol. ~4.5 days against ~15.5, plus a protocol to
version and defend for as long as anyone implements it. Hatchet shipped a
serverless transport in 2024, let it go undocumented, and is rebuilding it
this month; that is the cost of getting this decision wrong.
