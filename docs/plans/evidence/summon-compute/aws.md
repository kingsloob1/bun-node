# Summon-compute on AWS — which compute models can host a summoned `BunQueueWorker`

Evidence for `../../worker-runtimes.md` §3.8.1 and *Phase 1.5 — summon-compute*.
Researched 2026-09-25 from AWS documentation, API references, pricing pages and
What's New posts. Nothing here is built or run by the repo's tooling.

**The question.** bun-jobs notices a queue with depth and no live worker
(`listWorkerRecords`), calls a user-configurable invoker, and the compute it
starts runs an **ordinary `BunQueueWorker`** that claims over the normal driver
connection, drains, and exits. So the target must (a) be startable by one HTTP
call that we can sign ourselves, (b) reach the driver, and (c) keep a heartbeat
ticking for as long as it holds a lease. (c) is the filter that removes most
of the list.

## How to read the markings

Every fact carries one of these. They are load-bearing: an earlier round of this
research was corrected three times because inferences were written as findings.

| Mark | Meaning |
|---|---|
| **[V]** | Verified: read today (2026-09-25) in a primary AWS source; the URL is given where the fact is used, and in [Sources](#sources) |
| **[V-plan]** | Verified from a primary source on 2026-09-22 by `worker-runtimes.md` §3.7; **not re-read today** |
| **[M]** | Measured here, today (the SigV4 sketch against AWS's own signing test vectors) |
| **[I]** | Inference drawn from verified facts. The reasoning is stated; treat it as a claim to test |
| **[U]** | Unverified: model knowledge or a secondary source. Never load-bearing without a check |

AWS renders no "last updated" stamp on most doc pages, so "[V]" means "content
as fetched 2026-09-25". Prices are **us-east-1** unless stated.

---

## 1. Conclusions first

### Ranked recommendation for a first-party AWS summoner

1. **ECS `RunTask`, one adapter for every ECS capacity type** — Fargate,
   Fargate Spot, ECS Managed Instances and ECS-on-EC2 are all the same call,
   differing only in `launchType` / `capacityProviderStrategy` [V]. **Fit:
   Excellent.** It is the exact shape summon-compute wants: a one-off unit that
   runs a container to completion, never freezes, is billed per second with a
   one-minute minimum and stops billing when the container exits [V], has a
   real idempotency token (`clientToken`, per cluster, TTL ≤ 24 h) [V], takes
   environment and command overrides [V], and lives in the user's VPC next to
   the Redis/Postgres [V]. JSON 1.1 protocol — the simplest thing to sign.
2. **Lambda `Invoke` with `InvocationType: Event`, running the worker _inside_
   one invocation** — covers Lambda (default) and Lambda Managed Instances with
   the same code. **Fit: Good, for short work.** This is the model Temporal
   shipped [V-plan]. It is lease-safe on default Lambda **only** if the handler
   runs the worker to a graceful stop before returning (§2) [I]; the ceiling is
   900 s per summon on default Lambda [V] and 5,400 s on LMI for async
   invokes [V]. No dedupe token exists for plain functions [V], so bun-jobs'
   own stampede guard carries the whole load. REST-JSON.
3. **EC2 `RunInstances` from a launch template, with user data and
   `InstanceInitiatedShutdownBehavior=terminate`** (and, for users who already
   have one, **Auto Scaling `SetDesiredCapacity`**). **Fit: Good.** Cheapest
   per hour, no duration cap, `ClientToken` idempotency [V]. Slower to first
   claim (boot + user data) [U], and the EC2/Auto Scaling **Query** protocol
   (form-encoded body, XML response) is a second request shape to support.

Not first, but worth naming: **AWS Batch** is ECS `RunTask` with a queue in
front and **no idempotency token** [V] — support it only on demand. **EKS**
belongs in a cross-cloud Kubernetes-Job summoner, not an AWS one (the only
AWS-specific part is the bearer token). **Lambda MicroVMs** (GA 2026-06-22) is
lease-capable while `RUNNING` but has three sharp edges for this use (§4.7);
revisit when it has more regions. **Lambda Managed Instances** is lease-capable
but **does not scale to zero** — default minimum three execution environments,
and minimum 0 means *deactivated*, not idle [V] — so it is a poor thing to
*summon*; the Lambda adapter covers it for free anyway. **App Runner is closed
to new customers** [V]. **Elastic Beanstalk worker environments** and
**Lightsail** are unsuitable (§4.12–4.13).

### SigV4 without an SDK: feasible, and small

- **Measured [M]:** a 36-line WebCrypto SigV4 header signer
  (`crypto.subtle` HMAC-SHA256 + SHA-256, nothing else) reproduces the AWS
  signing test-suite signatures for `get-vanilla`,
  `post-x-www-form-urlencoded`, `get-vanilla-query-order-key-case`,
  `get-vanilla-query-unreserved` and `get-vanilla-with-session-token` (**5 of 7
  vectors tried** — re-run independently on 2026-09-25 with the same harness,
  which runs exactly these seven; an earlier draft said "6 of 8"). The two it does not match feed a raw, *un-percent-encoded*
  path (`/ሴ`, `/example space/`); the sketch double-encodes the path `fetch`
  actually sends, which is what AWS documents for non-S3 services [V] — but that
  choice must be confirmed by one live call before it ships (§5.4).
- One signer covers every recommended API: JSON 1.1 (ECS), REST-JSON (Lambda,
  Batch, MicroVMs), Query (EC2, Auto Scaling, STS). Only the request shape
  differs, not the signature. The EKS bearer token needs the **presigned
  query-string** variant of the same algorithm (+~10 lines) [I].
- **Credentials** without an SDK: static env vars, ECS task role and EKS Pod
  Identity (one HTTP GET each), IMDSv2 (PUT + two GETs), IRSA (one **unsigned**
  STS call) and cross-account `AssumeRole` (one signed STS call) — a 36-line
  sketch that compiles; **not run against AWS** (§5.3).
- Total: **~75 lines of code for signing + credential chain, plus ~10–20 per
  adapter.** No dependency, consistent with the repo's dependency policy.

### What surprised me

1. **Default Lambda is not simply "unsuitable".** The freeze is triggered when
   the runtime and extensions have finished and there are no pending
   events [V]. A worker that lives *inside* one invocation, and awaits its own
   `close()` before the handler returns, never holds a lease across a freeze
   [I]. That is precisely Temporal's model, including its
   `shutdownDeadlineBufferMs` [V-plan]. The plan's framing ("a host that freezes
   between invocations is the problem case") is right; the fix is to never be
   *between* invocations while holding a lease.
2. **Lambda Managed Instances cannot be summoned from zero.** It "scales to
   minimum execution environments configured without traffic"; the default
   minimum is 3; `0` is only valid with max `0`, which *deactivates* the
   function, and "a deactivated function does not automatically scale back up
   with traffic" [V]. The one Lambda type that never freezes is also the one
   with an always-on floor.
3. **Lambda MicroVMs exist** (GA 2026-06-22, five regions, ARM64 only) [V] and
   snapshot a *running process* at image-build time: "unique IDs, secrets …
   generated during the build … [are] shared across all MicroVMs from the same
   image version" [V]. That is the SnapStart hazard the plan already flags
   (§3.7 point 4) — a worker constructed during the build would share its
   `id` and lock token across every MicroVM.
4. **The default Fargate On-Demand vCPU quota is 6** per region [V] (AWS
   raises it automatically with usage). A burst of summons of 1-vCPU tasks
   stalls at six on a new account.
5. **ECS `clientToken` only dedupes identical requests**: same token with
   different parameters is a `ConflictException` [V]. So every override must be
   a deterministic function of the dedupe key — a timestamp in an environment
   variable silently turns deduplication into an error.
6. **AWS Batch `SubmitJob` has no idempotency parameter at all** [V].
7. **App Runner**: "we decided to close AWS App Runner to new customers …
   we do not plan to introduce new features"; AWS points migrants at ECS
   Express Mode [V]. The date (2026-04-30) appears only in secondary sources [U].

---

## 2. The lease question on AWS, stated once

A summoned `BunQueueWorker` holds leases (job locks, the worker record's
heartbeat, concurrency tokens) that are renewed by timers. A host is
lease-capable if those timers keep firing for as long as a lease is held.

| Host behaviour | Examples | Lease-safe? |
|---|---|---|
| Process runs until it exits or is signalled; signals come with a documented grace period | EC2, ECS (all capacity), Batch, EKS pods, MicroVM while `RUNNING` | **Yes** [V for each grace period below] |
| Process runs continuously; invocations are delivered into it | Lambda Managed Instances: "the execution environment remains continuously active … without freezing between invocations" [V] | **Yes** |
| Process is frozen when the runtime asks for the next event and none is pending | Lambda (default): "Lambda freezes the execution environment when the runtime and each extension have completed and there are no pending events" [V]; timers "resume if Lambda reuses the execution environment" [V] | **Only while an invocation is in progress** [I] |
| Process is checkpointed and restored | Lambda durable functions (replay) [V]; MicroVM `SUSPENDED` (memory checkpointed) [V] | **No** across the suspension [I] |

**The within-invocation rule for default Lambda [I].** During the Invoke
phase the handler's promise is pending, so the runtime has not called `Next`
and the environment is not frozen [V: freeze condition]. If the handler
(1) starts the worker, (2) stops claiming at `deadline − buffer`, (3) awaits
`worker.close()` — which "stops claiming, waits for jobs in flight, and releases
what it owns" (read in `BunQueueWorker.ts` today) — and only then returns, no
lease outlives the invocation. The failure mode on timeout is a **kill**, not a
freeze: "If the Lambda function crashes or times out during the Invoke phase,
Lambda resets the execution environment" [V]; the lock then lapses and another
worker recovers the job as stalled, which bun-jobs already handles. Jobs longer
than about `timeout − buffer` cannot run there at all.

What must *not* happen: a worker started at module scope (Init phase) and left
running between invocations. That is the plan's "fires out of time" case.

---

## 3. The comparison table

"Idle cost" means cost while no summoned work exists. "Style": **task** =
launch-a-task (one unit drains and exits); **service** = scale-a-service
(set a desired count 0↔N).

| Model | Lease-capable | Max run / at the limit | Time to first claim | Billing, minimum, idle cost | Start API (protocol) | Dedupe | Style | Fit |
|---|---|---|---|---|---|---|---|---|
| **ECS `RunTask` on Fargate** | Yes | No task limit stated; platform-retirement stops tasks with notice (default 7 d, 14 configurable) [V]; stop = SIGTERM, `stopTimeout` default 30 s, max 120 s [V] | Tens of seconds [U]; image pull billed [V] | Per second, 1-min minimum, from image pull to task stop [V]; **idle $0** | `RunTask` (JSON 1.1) [V] | `clientToken` ≤64 chars, per cluster, TTL ≤24 h [V]; `startedBy` + `ListTasks` [V] | task | **Excellent** |
| **Fargate Spot** (same call) | Yes, with 2-min interruption (SIGTERM + EventBridge) [V] | as above | as above; may be delayed when capacity is short [V] | up to 70% off Fargate [V]; idle $0 | `RunTask` + `capacityProviderStrategy` [V] | as above | task | **Excellent** (for retry-safe jobs) |
| **ECS Managed Instances** (same call) | Yes | Instance drained after 14 days [V] | Instance launch when no capacity [U] | Whole EC2 instance billed [V]; management fee [U]; idle = any instance still up | `RunTask` + MI capacity provider [V] | as above | task | **Good** |
| **ECS on EC2 (ASG capacity provider)** | Yes | none [U] | Minutes if the ASG must scale [U] | EC2 per second (60 s min) [V]; idle = ASG floor | `RunTask` + ASG capacity provider [V] | as above | task | **Good** (if a cluster exists) |
| **ECS service `desiredCount`** | Yes | none; retirement replaces service tasks [V] | as Fargate | as Fargate; idle $0 at count 0 [I] | `UpdateService` (JSON 1.1) [V] | Absolute value — idempotent by nature [I] | service | **Good** (needs a scale-in path) |
| **Lambda (default)** | **Conditional** — only inside one invocation (§2) [I] | **900 s** [V]; timeout resets the environment [V] | ms–1 s for managed runtimes [V]; Bun container/custom runtime [U] | Per 1 ms [V]; idle $0 | `Invoke`, `X-Amz-Invocation-Type: Event` (REST-JSON) [V] | **None**; async may deliver twice [V] | task | **Good** (short jobs) |
| **Lambda Managed Instances** | **Yes** [V] | Async/ESM **5,400 s**, sync 900 s [V]; a timed-out invoke *keeps running* [V] | No cold start once active [V] | EC2 price + 15% [V]; **idle ≥ 3 environments by default** [V] | `Invoke` (same) [V] | None | task (into a warm pool) | **Poor** as a summon target |
| **Lambda durable functions** | **No** (checkpoint/replay) [V] | 1 year per execution [V] | as Lambda | per invocation + $8/M operations [V] | `Invoke` + `X-Amz-Durable-Execution-Name` [V] | Execution name [V] | — | **Unsuitable** |
| **Lambda MicroVMs** | Yes while `RUNNING`; **auto-suspend freezes it** unless disabled [V] | `maximumDurationInSeconds` ≤ 28,800 [V]; `/terminate` hook, timeout not stated [U] | "near-instant" (vendor) [V]; no figure | Per second [V]; $0.0000276944/vCPU-s + $0.0000036667/GB-s (Arm) [V]; idle $0 if terminated | `RunMicrovm` (REST-JSON) [V]; endpoint host [U] | `clientToken` ≤128 [V] | task | **Good in principle; not first** |
| **EC2 `RunInstances`** | Yes | none; Spot: 2-min notice [V] | Boot + user data: tens of s to minutes [U] | Per second, **60 s minimum** (Linux) [V]; idle $0 once terminated | `RunInstances` (Query) [V] | `ClientToken` ≤64, regional or zonal [V]; TTL not stated [V] | task | **Good** |
| **EC2 `StartInstances`** (stopped instance) | Yes | none | Boot only [U] | Per second; stopped = EBS (+EIP) only [V] | `StartInstances` (Query) [U] | Starting a running instance is harmless [I] | task (pool of 1..N) | **Fair** |
| **EC2 Auto Scaling `SetDesiredCapacity`** (+ warm pools) | Yes | none | Warm pool: faster start [V]; figure [U] | EC2 per second; warm pool Stopped = EBS only [V] | `SetDesiredCapacity` (Query) [V] | Absolute value [I]; no token [V] | service | **Good** |
| **EKS Job** (EC2 / Karpenter / Auto Mode / Fargate) | Yes | Auto Mode nodes ≤ 21 days [V]; Fargate pods patched/evicted [V] | Pod on existing node: seconds [U]; new node: minutes [U] | EC2 or Fargate per second, 1-min min [V]; **+$0.10/h control plane** [V] | Kubernetes `POST …/jobs` with EKS bearer token [U] | Job `metadata.name` (409 on conflict) [U] | task | **Good only if you already run EKS** |
| **AWS Batch** | Yes | No max; optional `attemptDurationSeconds` ≥ 60, then SIGTERM + 30 s + SIGKILL [V]; Fargate jobs "can't be guaranteed to run for more than 14 days" [V] | Queue + scheduler latency on top of ECS [U] | No Batch fee [V]; underlying Fargate/EC2 | `SubmitJob` (REST-JSON) [V] | **None** [V] | task | **Fair** |
| **App Runner** | Yes [U] | — | — | — | — | — | service | **Unsuitable** — closed to new customers [V] |
| **Elastic Beanstalk worker env** | Yes | — | — | EC2 ASG; no scale-to-zero statement [V] | none suitable | — | service | **Unsuitable** (its own SQS push daemon) |
| **Lightsail container service** | Yes [U] | — | — | Monthly; "charged … whether it's enabled or disabled" [V] | — | — | service | **Unsuitable** |
| **Lightsail instance** | Yes | — | — | Monthly bundle [U] | — | — | — | **Unsuitable** (no fast programmatic scale-to-zero shape) [I] |

---

## 4. Per-model notes

Every sketch below uses the same two helpers and one interface. `signV4` and
`credentials` are in §5; `awsFetch` is:

```ts
interface SummonRequest {
  queue: string;
  backlog: number;
  /** Same for every scheduler that notices the same backlog, e.g. `${queue}:${Math.floor(now / windowMs)}`, hashed to fit. */
  dedupeKey: string;
}
interface SummonResult { id: string; deduped: boolean }
type Summoner = (r: SummonRequest) => Promise<SummonResult>;

async function awsFetch(service: string, region: string, url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const method = init.method ?? "POST";
  const headers = await signV4({ method, url, headers: init.headers, body: init.body,
    region, service, creds: await credentials(region) });   // signing inputs: service, region, host (from url)
  return await fetch(url, { method, headers, body: init.body });
}
```

The summoned side is the same everywhere: a worker file that uses the existing
`BunQueueWorker` API (read in `packages/bun-jobs/lib/queue/BunQueueWorker.ts`
today: `run()` "consumes until closed", `close({ timeout })`, and a `drained`
event after `drainDelay`):

```ts
// worker.ts — the one file every AWS target runs
const worker = new BunQueueWorker(queueName, processors, { driver, drainDelay: idleMs });
worker.on("drained", () => void worker.close());                    // idle → exit
process.on("SIGTERM", () => void worker.close({ timeout: graceMs - 2_000 }));
if (deadlineMs) setTimeout(() => void worker.close({ timeout: bufferMs }), deadlineMs - bufferMs); // Lambda/MicroVM
await worker.run();                                                  // resolves once closed and settled
```

### 4.1 ECS `RunTask` on Fargate and Fargate Spot — **Excellent**

1. **Lease-capable: Yes.** A Fargate task is a container that runs until it
   exits or is stopped; nothing in the docs describes suspension [V, by
   absence — inference that there is none: I]. Stop is SIGTERM, then SIGKILL
   after `stopTimeout` ("default value of 30 seconds … maximum value is 120
   seconds") [V]. Fargate Spot adds "a two-minute warning … as a task state
   change event to Amazon EventBridge and as a SIGTERM signal" [V].
2. **Max duration:** none stated for tasks. Platform retirement: "When a
   revision is retired, all tasks running on that revision are stopped"; for
   standalone tasks "Amazon ECS doesn't launch a replacement"; notice default
   7 days, configurable to 14 [V]. Host failure: "Amazon ECS replaces the host
   without a task retirement notice" [V]. (AWS Batch says Fargate jobs "can't be
   guaranteed to run for more than 14 days" [V] — consistent.) Irrelevant for a
   worker that drains and exits.
3. **Cold start:** no AWS figure found. Tens of seconds is the usual
   report [U]. SOCI lazy loading helps images > 250 MB and can be slower below
   that (search snippet of `fargate-pull-behavior.html`) [U].
4. **Billing:** "per second with a 1-minute minimum. Duration is calculated
   from the time you start to download your container image (Docker pull)
   until the task terminates" [V]. Linux/x86 $0.000011244 per vCPU-second,
   $0.000001235 per GB-second; Linux/ARM $0.0000089944 / $0.0000009889 [V].
   Spot "up to a 70% discount" [V]; the Spot rate itself was not visible [U].
   **Idle: $0.**
5. **Start API:** `POST https://ecs.<region>.amazonaws.com/`,
   `X-Amz-Target: AmazonEC2ContainerServiceV20141113.RunTask`,
   `Content-Type: application/x-amz-json-1.1` [V]. Parameters reach the
   process via `overrides.containerOverrides[].environment` / `command`
   ("A total of 8192 characters are allowed for overrides") [V]. Spot needs
   `capacityProviderStrategy` and must omit `launchType` [V].
6. **Idempotency:** `clientToken`, "up to 64 ASCII characters in the range of
   33-126"; "Requests with the same token in the same cluster are idempotent";
   TTL "24 hours" or "the lifetime of the resource plus one hour", whichever is
   lower; same token + different parameters → `ConflictException`, whose
   `resourceIds` are "the existing task ARNs which are already associated with
   the `clientToken`" [V]. `startedBy` (≤128 chars) filters `ListTasks` [V].
   **Consequence [I]:** derive every override from the dedupe key; treat
   `ConflictException` as `deduped: true`. Once the task has stopped for an
   hour the token is forgotten, which is the right behaviour (a new backlog
   after a drained task *should* summon again).
7. **Stop / exit:** the worker exits → the task stops → billing stops [V for
   billing ending at termination; "task stops when its essential container
   exits" is U]. Nothing else to clean up.
8. **Style:** launch-a-task. `count` up to 10 per call [V] for a larger burst.
9. **Network:** `awsvpc` — each task gets an ENI in the given subnets with the
   given security groups [V: `networkConfiguration` required for `awsvpc`].
   Put it in the database's VPC. Pulling from ECR from a private subnet needs
   NAT or VPC endpoints [U]. **RDS Proxy:** `sql.listen` cannot work through
   it [V-plan] — the worker falls back to polling.
10. **Bun:** any Linux container image; the official `oven/bun` image [U].
11. **Quotas:** Fargate On-Demand vCPU resource count **6** default, Spot 6,
    adjustable, raised automatically with usage [V]; launch rate burst 100 /
    sustained 20 per second in large regions [V]; `RunTask` shares the
    "cluster resource modify" API bucket: burst 100, refill 40/s [V]; 10 tasks
    per `RunTask` [V].
12. **Fit: Excellent** — no freeze, no practical cap, per-second billing,
    a real idempotency token, in-VPC, exit = done.
13. **Adapter sketch** (signing: service `ecs`, host `ecs.<region>.amazonaws.com`):

```ts
export const ecsRunTaskSummoner = (o: { region: string; cluster: string; taskDefinition: string;
  container: string; subnets: string[]; securityGroups: string[]; spot?: boolean }): Summoner => async (r) => {
  const body = JSON.stringify({
    cluster: o.cluster, taskDefinition: o.taskDefinition, count: 1,
    clientToken: r.dedupeKey,                    // ≤64 chars, 33–126; params must be identical on retry
    startedBy: "bun-jobs-summon",
    ...(o.spot ? { capacityProviderStrategy: [{ capacityProvider: "FARGATE_SPOT", weight: 1 }] } : { launchType: "FARGATE" }),
    networkConfiguration: { awsvpcConfiguration: { subnets: o.subnets, securityGroups: o.securityGroups, assignPublicIp: "DISABLED" } },
    overrides: { containerOverrides: [{ name: o.container, environment: [{ name: "BUN_JOBS_QUEUE", value: r.queue }] }] },
  });
  const res = await awsFetch("ecs", o.region, `https://ecs.${o.region}.amazonaws.com/`, { body, headers: {
    "content-type": "application/x-amz-json-1.1", "x-amz-target": "AmazonEC2ContainerServiceV20141113.RunTask" } });
  const out = await res.json() as { tasks?: { taskArn: string }[]; failures?: { reason: string }[]; __type?: string; resourceIds?: string[] };
  if (res.status === 400 && out.__type?.endsWith("ConflictException")) return { id: out.resourceIds![0]!, deduped: true };
  if (!res.ok || !out.tasks?.length) throw new Error(`RunTask: ${out.__type ?? out.failures?.map(f => f.reason).join(", ")}`);
  return { id: out.tasks[0]!.taskArn, deduped: false };  // note: 200 with only `failures` (e.g. capacity) is a failure
};
```

(The `__type` error-body shape of JSON 1.1 services is [U]; confirm on the
first live call.)

### 4.2 ECS Managed Instances and ECS on EC2 — same adapter, **Good**

- ECS Managed Instances: "you must use the `capacityProviderStrategy` request
  parameter and omit the `launchType`" [V]; "billed for the entire Amazon EC2
  instance that runs your tasks"; Bottlerocket only; "ECS Managed Instances
  initiates instance draining after 14 days"; "Long-running tasks (exceeding 14
  days) are not suitable"; places "multiple smaller tasks on larger
  instances"; quotas follow EC2 On-Demand quotas [V]. Whether a management fee
  is charged on top was not on the page read [U].
- ECS on EC2 with an Auto Scaling group capacity provider: `RunTask` with that
  provider puts tasks in `PROVISIONING` while the ASG scales, capped at **500
  PROVISIONING tasks per cluster** [V]; beyond that `RunTask` returns a
  `ClientException` [V].
- Idle cost is whatever instance is still up; time to first claim includes an
  instance launch when none has room [U]. Same signing, same sketch with
  `capacityProviderStrategy: [{ capacityProvider: "<name>" }]`.

### 4.3 ECS service `desiredCount` (scale-a-service) — **Good**, with a scale-in problem

- `UpdateService` with `desiredCount` — "This parameter doesn't trigger a new
  service deployment"; same JSON 1.1 target prefix [V]. Setting an absolute
  count is naturally idempotent [I]; the "service modify" bucket is only
  burst 50 / refill **5 per second** [V].
- **The catch [I]:** a service replaces any task that exits, so a worker that
  exits on idle is simply restarted. Either the worker must *not* exit on idle
  and bun-jobs sets `desiredCount: 0` when the queue is empty (which can kill a
  task mid-job unless it is protected — ECS task protection exists as
  `UpdateTaskProtection` [V: listed in the throttling table]; semantics [U]),
  or use launch-a-task instead. For summon-compute, `RunTask` is the better fit.
- **ECS Express Mode** (App Runner's replacement) provisions "an ECS service on
  Fargate, an Application Load Balancer, auto scaling, and networking" [V] —
  web-service shaped; a load balancer is dead weight for a worker [I].
- Sketch: body `{ cluster, service, desiredCount: n }`, target
  `AmazonEC2ContainerServiceV20141113.UpdateService`; otherwise identical to 4.1.

### 4.4 Lambda (default) — **Conditional lease, Good fit for short jobs**

1. **Lease-capable: Conditional** — see §2. Freeze quote and timer-resume quote
   [V]; the within-invocation rule [I]. Shutdown phase: 0 ms with no
   extensions, 500 ms with an internal one, 2,000 ms with external ones, then
   SIGKILL [V] — so graceful stop must finish *inside* the invocation, never in
   a shutdown hook.
2. **Max:** 900 s [V]. At the limit the invocation fails and the environment is
   reset [V]. Also "Lambda terminates execution environments every few hours"
   [V] — irrelevant inside a ≤15-min invocation.
3. **Cold start:** "from under 100 ms to over 1 second" (vendor, generic) [V];
   Init phase limited to 10 s [V]. Bun as a container image or a custom
   runtime: no figure [U].
4. **Billing:** duration "rounded up to the nearest 1ms"; x86
   $0.0000166667/GB-s, Arm $0.0000133334/GB-s, $0.20 per 1M requests [V].
   **Idle $0.** 1,769 MB = one vCPU [V].
5. **Start API:** `POST /2015-03-31/functions/{FunctionName}/invocations`,
   `X-Amz-Invocation-Type: Event` → 202 [V]; async payload ≤ 1 MB [V]. Host
   `lambda.<region>.amazonaws.com`, signing service `lambda` [U — standard, not
   re-read]. Parameters: the payload (queue name, dedupe key). Temporal's
   choice — "configuration is environment variables, not the invocation
   event" [V-plan] — is the better default; the payload is only a hint.
6. **Idempotency: none for plain functions.** "Occasionally, your function may
   receive the same event multiple times, even if no error occurs", and a
   failing async invoke is retried "up to two more times" [V].
   `X-Amz-Durable-Execution-Name` dedupes *durable* executions only [V]. So
   the bun-jobs stampede guard is the only dedupe; set the function's async
   retries to 0 (`MaximumRetryAttempts` via `PutFunctionEventInvokeConfig`
   [U]). Duplicate summons are harmless beyond cost (two ordinary workers).
7. **Stop:** the handler returns after `close()`; billing stops [V: per-invoke
   duration].
8. **Style:** launch-a-task, bounded by the timeout.
9. **Network:** VPC attachment for a private database; "internet egress needs
   NAT" [V-plan]. **A VPC function idle long enough goes `Inactive`: "When you
   try to invoke a function that is inactive, the invocation fails and Lambda
   sets the function to pending state"** [V] (the plan records the period as 14
   days [V-plan]; the page read today gives no number). A rarely-summoned
   function is exactly the case, so the summoner must treat a failed invoke of
   an inactive function as "retry shortly", or check `State` first (`GetFunction`,
   100 rps [V]). RDS Proxy: no `sql.listen` [V-plan].
10. **Bun:** "You can implement an AWS Lambda runtime in any programming
    language" via an executable `bootstrap` on the OS-only `provided` family
    [V]; or a container image ≤ 10 GB [V]. `oven-sh/bun`'s `bun-lambda` layer
    status is unverified [V-plan says unverified].
11. **Quotas:** 1,000 concurrent executions default; "1,000 execution
    environments every 10 seconds" per function; async invocation rate limited
    only by concurrency [V].
12. **Fit: Good for jobs that finish well inside ~14 minutes; unusable for
    longer ones.**
13. **Adapter sketch** (service `lambda`, host `lambda.<region>.amazonaws.com`):

```ts
export const lambdaSummoner = (o: { region: string; functionName: string; qualifier?: string }): Summoner => async (r) => {
  const q = o.qualifier ? `?Qualifier=${encodeURIComponent(o.qualifier)}` : "";
  // Use the function *name*, not its ARN: an ARN's ':' makes the path double-encoding question (§5.4) live.
  const url = `https://lambda.${o.region}.amazonaws.com/2015-03-31/functions/${o.functionName}/invocations${q}`;
  const res = await awsFetch("lambda", o.region, url, {
    headers: { "x-amz-invocation-type": "Event", "content-type": "application/json" },
    body: JSON.stringify({ queue: r.queue, dedupeKey: r.dedupeKey }),
  });
  if (res.status !== 202) throw new Error(`Invoke ${res.status}: ${await res.text()}`); // incl. inactive-function failure → caller retries
  return { id: res.headers.get("x-amzn-requestid") ?? r.dedupeKey, deduped: false };  // header name [U]
};
// handler side: deadline = context.getRemainingTimeInMillis(); run the worker file above with bufferMs ≈ 7_000 (Temporal's default)
```

### 4.5 Lambda Managed Instances (LMI) — lease-capable, **Poor** to summon

- **Lease: Yes.** "Unlike Lambda (default), the execution environment remains
  continuously active, processing invocations as they arrive without freezing
  between invocations" [V].
- **Max:** "up to 90 minutes for asynchronous and ESM invocations …
  Synchronous invocations retain the existing 15-minute maximum", announced
  **2026-09-09** [V]; quotas page: 5,400 s async/ESM "except Amazon MQ and
  Amazon DocumentDB" [V]. At timeout LMI "does not forcibly terminate your
  code—it continues running" and side effects can happen after the caller was
  told it failed [V] — so the worker must enforce its own deadline (the
  worker-file sketch does).
- **Why Poor:** "It launches three instances by default … and starts three
  execution environments before marking your function version ACTIVE"; scaling
  is "asynchronous … without cold starts. Scales to minimum execution
  environments configured without traffic"; default minimum 3; "A minimum of 0
  is only valid when the maximum is also 0", which deactivates the function, and
  "A deactivated function does not automatically scale back up with traffic.
  You must explicitly reactivate it" with `PutFunctionScalingConfig` [V].
  Summoning *from zero* would therefore be two calls (reactivate, then invoke)
  gated on a scale-up that takes minutes [U], and `PutFunctionScalingConfig` is
  a control-plane call sharing **15 requests per second across all Lambda
  control-plane APIs, not increasable** [V].
- **Billing:** EC2 instance price + "15% management fee" (pricing page: "15%
  premium on the EC2 on-demand instance price") [V]; smallest function 2 GB /
  1 vCPU [V]; multi-concurrent — Node uses worker threads, and a custom runtime
  must "support concurrent `/next` requests" [V].
- **Bun:** the runtimes page lists `provided.al2023` only "for Rust" [V], but
  the custom-runtime page has a section "Building custom runtimes for Lambda
  Managed Instances" [V] — so a Bun custom runtime is documented as possible,
  with JSON-only logs and concurrent invocations [V]. Untested [U].
- **Verdict [I]:** if a user already runs LMI for other reasons, the Lambda
  adapter in 4.4 works unchanged and gets the 90-minute ceiling. Nobody should
  choose LMI *in order to* summon workers.

### 4.6 Lambda durable functions — **Unsuitable**

Checkpoint/replay: "your code runs from the beginning but skips over completed
checkpoints"; waits "suspend execution without incurring compute charges";
executions up to one year; SDKs for JavaScript/TypeScript, Python, Java [V].
A replayed process cannot hold a lease across a suspension [I]; and the
programming model (steps, waits) is a workflow engine, not a host for an
ordinary worker [I]. The only transferable idea is the dedupe header
(`X-Amz-Durable-Execution-Name`, ≤64 chars) [V].

### 4.7 Lambda MicroVMs — **Good in principle, not first**

1. **Lease: Yes while `RUNNING`; No once `SUSPENDED`** (memory checkpointed,
   "No compute charges accrue") [V]. **Idle is defined by inbound traffic**:
   "The presence of traffic through the MicroVM's endpoint signals activity",
   and "For asynchronous applications that do not actively send or receive
   traffic through the endpoint, disable automatic suspension or configure a
   suitable idle duration" [V]. A queue worker makes only outbound connections,
   so it **must** run with auto-suspend disabled or it is frozen mid-lease [I].
   What `RunMicrovm` does when `idlePolicy` is omitted is not stated [U].
2. **Max:** `maximumDurationInSeconds` 1–28,800, "Not adjustable"; the
   platform terminates it, calling the `/terminate` hook first [V]; hook
   timeout not stated [U].
3. **Start:** "near-instant launch" [V, vendor, no figure]; images are
   Firecracker snapshots built from a `Dockerfile` on "a Lambda-published
   managed base image" (Amazon Linux 2023) [V].
4. **Billing:** per second; Arm $0.0000276944/vCPU-s + $0.0000036667/GB-s;
   snapshot storage $0.08/GB-month, reads $0.00155/GB [V]. Minimum billing
   duration not found [U].
5. **Start API:** `POST /2025-09-09/microvms`, JSON body with
   `imageIdentifier`, `clientToken`, `maximumDurationInSeconds`, `idlePolicy`,
   `egressNetworkConnectors`, `executionRoleArn`, `runHookPayload` [V]. The API
   reference pages read show **no host name and no signing service name**; the
   CLI namespace is `lambda-microvms` [V] — endpoint and SigV4 service code [U].
   Per-MicroVM parameters arrive through the `/run` hook body
   `{ microvmId, runHookPayload }` — environment variables are image-level [V].
   (The `runHookPayload` limit is inconsistent in AWS's own reference: "Maximum:
   16,384 bytes" beside "Maximum length of 4096" [V].)
6. **Idempotency:** `clientToken` 1–128 chars [V]; semantics not described [U].
7. **Stop:** the worker exiting does not terminate the MicroVM [U — not
   stated]; call `TerminateMicrovm` (needs the execution role to allow it on
   itself) [I], with `maximumDurationInSeconds` as the backstop.
8. **Style:** launch-a-task.
9. **Network:** "Create your own network connector to route outbound traffic
   through your VPC" [V].
10. **Bun:** install it in the `Dockerfile` on the managed base [I]. **Hazard:**
    the build "captures a snapshot of the disk and memory state, including all
    running processes"; "If your application generates unique content during
    the build (such as unique IDs, secrets, or network connections), that
    content is shared across all MicroVMs run from the same image version …
    generate unique content after the MicroVM starts using the `/run` lifecycle
    hook" [V]. A `BunQueueWorker` must therefore be **constructed in `/run`,
    never at image build** — the plan's SnapStart point 4, again.
11. **Quotas:** memory across all MicroVMs 400 GB per region (1,024 GB in
    us-east-1/us-east-2/us-west-2/Tokyo); `RunMicrovm` **5 TPS**, adjustable;
    ARM64 only; GA 2026-06-22 in five regions [V].
12. **Fit: Good in principle** — isolated VM, 8 h, per-second — but new, five
    regions, an undocumented endpoint for our purposes, and two ways (auto
    suspend, build-time identity) to corrupt a lease by default.
13. **Sketch** (host and service name **unverified**; placeholders):

```ts
export const microvmSummoner = (o: { region: string; endpoint: string /* [U] */; service: string /* [U] */;
  image: string; vpcConnector: string; maxSeconds: number }): Summoner => async (r) => {
  const res = await awsFetch(o.service, o.region, `https://${o.endpoint}/2025-09-09/microvms`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      imageIdentifier: o.image, clientToken: r.dedupeKey, maximumDurationInSeconds: o.maxSeconds,
      idlePolicy: { maxIdleDurationSeconds: o.maxSeconds, autoResumeEnabled: false }, // effectively never auto-suspend [I]
      egressNetworkConnectors: [o.vpcConnector], ingressNetworkConnectors: [/* NO_INGRESS connector ARN */],
      runHookPayload: JSON.stringify({ queue: r.queue }),          // the /run hook constructs the worker
    }),
  });
  if (!res.ok) throw new Error(`RunMicrovm ${res.status}: ${await res.text()}`);
  return { id: ((await res.json()) as { microvmId: string }).microvmId, deduped: false };
};
```

### 4.8 EC2 `RunInstances` (on-demand and Spot) — **Good**

1. **Lease: Yes.** A VM. Spot: "a warning that is issued two minutes before
   Amazon EC2 stops or terminates your Spot Instance", via IMDS
   `spot/instance-action` and EventBridge, "on a best effort basis"; AWS
   recommends polling "every 5 seconds" [V].
2. **Max:** none [U, by absence].
3. **Cold start:** boot + user data; "allow a few minutes of extra time for the
   tasks to complete" (said of package installs in user data) [V]; bake Bun and
   the app into the AMI and it is boot time only [I]; figure [U].
4. **Billing:** "billed per-second for Linux …"; "The minimum billing period is
   60 seconds" [V]. Prices (AWS's own pricing data file, published
   2026-09-24): t4g.small $0.0168/h, t4g.medium $0.0336/h, c7g.large
   $0.0725/h, m7g.large $0.0816/h [V]. Plus EBS [U]. **Idle $0 once terminated.**
5. **Start API:** Query protocol. `POST https://ec2.<region>.amazonaws.com/`
   with a form body `Action=RunInstances&Version=2016-11-15&MinCount=1&MaxCount=1…`
   [V: action, version, parameter spellings `TagSpecification.1.ResourceType`,
   `ClientToken`, `UserData`, `InstanceInitiatedShutdownBehavior`, `LaunchTemplate`];
   `LaunchTemplate.LaunchTemplateName` spelling [U]. XML response. Parameters
   reach the process via **user data** (base64, "limited to 16 KB, in raw
   form", run as root, "only during the boot cycle when you first launch") [V]
   and tags (readable from IMDS if enabled [U]).
6. **Idempotency:** `ClientToken`, "Maximum 64 ASCII characters"; regional,
   or zonal when a subnet/AZ is given ("a request with the same client token
   can complete only once within each Availability Zone"); mismatched
   parameters → `IdempotentParameterMismatch` [V]. **The page gives no TTL**
   [V] — how long a token is remembered is [U].
7. **Stop / exit:** a process exiting does not stop an instance [I]. Launch
   with `InstanceInitiatedShutdownBehavior=terminate` ("Indicates whether an
   instance stops or terminates when you initiate shutdown from the instance",
   default `stop`) [V], and end the user-data script with `shutdown -h now`
   after the worker exits [I]. A forgotten instance bills forever — also set a
   hard backstop (e.g. `shutdown -h +120` at boot) [I].
8. **Style:** launch-a-task.
9. **Network:** launch into the database's subnets and security groups [I].
10. **Bun:** AMI with Bun installed, or install in user data [U].
11. **Quotas:** "`RunInstances` is subject to both request rate limiting and
    resource rate limiting" [V]; vCPU-based On-Demand/Spot limits per region
    [U — not read].
12. **Fit: Good** — universal and cheapest; slower and noisier to clean up.
13. **Sketch** (service `ec2` [V — the SigV4 guide's own example scope is
    `…/us-east-1/ec2/aws4_request`], host `ec2.<region>.amazonaws.com`):

```ts
export const ec2Summoner = (o: { region: string; launchTemplate: string; subnetId: string }): Summoner => async (r) => {
  const script = `#!/bin/bash\nexport BUN_JOBS_QUEUE=${r.queue}\ncd /opt/app && bun worker.ts\nshutdown -h now\n`;
  const body = new URLSearchParams({
    Action: "RunInstances", Version: "2016-11-15", MinCount: "1", MaxCount: "1",
    "LaunchTemplate.LaunchTemplateName": o.launchTemplate, SubnetId: o.subnetId,   // subnet ⇒ zonal idempotency
    ClientToken: r.dedupeKey, InstanceInitiatedShutdownBehavior: "terminate",
    UserData: Buffer.from(script).toString("base64"),
    "TagSpecification.1.ResourceType": "instance",
    "TagSpecification.1.Tag.1.Key": "bun-jobs:queue", "TagSpecification.1.Tag.1.Value": r.queue,
  }).toString();
  const res = await awsFetch("ec2", o.region, `https://ec2.${o.region}.amazonaws.com/`, {
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, body });
  const xml = await res.text();
  if (!res.ok) throw new Error(`RunInstances ${res.status}: ${xml.match(/<Code>(.*?)<\/Code>/)?.[1]}`);
  return { id: xml.match(/<instanceId>(i-[0-9a-f]+)<\/instanceId>/)![1]!, deduped: false }; // response element name [U]
};
```

(`URLSearchParams` encodes spaces as `+`; SigV4 wants `%20` in the canonical
*query*, but this is a body, which is hashed verbatim [V: `HashedPayload` is the
hash of the body as sent], so either is fine.)

### 4.9 EC2 `StartInstances` of a stopped instance — **Fair**

- Keeps a pre-built worker VM stopped; while stopped you pay "only for the
  volumes that you use and the Elastic IP addresses attached" (warm-pool page,
  same mechanism) [V]. Start = boot only [U].
- `Action=StartInstances&InstanceId.1=…` (Query) [U — not re-read].
  Starting an already-running instance is harmless, so it is idempotent by
  construction [I]; `StartInstances` is not in the client-token list [V].
- User data runs only on first boot by default [V], so the worker must be a
  boot service (systemd) that stops the instance when drained
  (`shutdown -h now` with the default `stop` behaviour) [I].
- Fixed pool size = fixed maximum concurrency; each instance is a pet [I]. Fair
  for one or two workers; ASG (4.10) generalises it.

### 4.10 EC2 Auto Scaling `SetDesiredCapacity` (+ warm pools) — **Good**

- `https://autoscaling.amazonaws.com/?Action=SetDesiredCapacity&AutoScalingGroupName=my-asg&HonorCooldown=false&DesiredCapacity=2&Version=2011-01-01` [V]
  (regional host `autoscaling.<region>.amazonaws.com`, service `autoscaling`
  [U]). No client token [V]; an absolute desired value is idempotent [I];
  concurrent updates may fail with `ResourceContention` or
  `ScalingActivityInProgress` [V].
- **Scale-in is the hard part [I].** Lowering desired capacity terminates
  instances by the group's termination policy [V] — possibly one mid-job. The
  clean path is for a drained worker to remove *itself*:
  `TerminateInstanceInAutoScalingGroup` with
  `ShouldDecrementDesiredCapacity=true` ("If you do not specify the option to
  decrement the desired capacity, Amazon EC2 Auto Scaling launches instances to
  replace the ones that are terminated") [V].
- **Warm pools:** pre-initialised instances kept `Stopped`, `Running` or
  `Hibernated`; stopped costs only EBS/EIP; default scale-in *terminates* and
  refills the pool unless an instance reuse policy returns instances to it; not
  with Spot in mixed-instance groups; "the stop or hibernate action can
  interrupt long-running user data" [V]. **Hibernated** instances resume with
  their RAM [V] — a worker must never be hibernated while holding a lease [I].
- Sketch: identical to 4.8 with service `autoscaling` and the parameters above.

### 4.11 EKS — Jobs, Karpenter, Auto Mode, Fargate profiles — **Good only if you already run EKS**

- **Lease: Yes** (a pod is a process). Auto Mode "enforces a 21-day maximum node
  lifetime" and handles Spot interruption notices; it relies "on Karpenter auto
  scaling … monitors for unschedulable Pods" [V]. EKS on Fargate: "Amazon EKS
  must periodically patch Fargate Pods … there are times when Pods must be
  deleted"; "Amazon EKS doesn't support Fargate Spot"; no Arm; private subnets
  only; IMDS unavailable, so credentials via IRSA/Pod Identity [V].
- **Billing:** control plane **$0.10 per cluster-hour** (standard support);
  Auto Mode adds a per-instance management fee "billed per-second, with a
  one-minute minimum"; EKS Fargate per second, 1-minute minimum [V]. The
  control plane alone is ≈ $73/month [I: 0.10 × 730].
- **Start API:** the Kubernetes API (`POST /apis/batch/v1/namespaces/{ns}/jobs`)
  with `Authorization: Bearer k8s-aws-v1.<base64url of a presigned STS
  GetCallerIdentity URL carrying x-k8s-aws-id>`, valid 15 minutes [U — from the
  AWS CLI's `get_token.py` and `aws-iam-authenticator`, found by search; the
  EKS user-guide page read today does not describe the format]. The IAM
  principal needs an EKS access entry [V: access entries are the documented
  mechanism]. The cluster CA must be trusted by `fetch` [U: Bun's `tls.ca`].
- **Dedupe:** the Job's `metadata.name` is unique per namespace — creating it
  twice fails (409 `AlreadyExists`) [U, Kubernetes semantics]; name it from the
  dedupe key. On EKS Fargate, completed Job pods keep billing unless cleaned
  up — set `ttlSecondsAfterFinished` [V].
- **Verdict [I]:** the only AWS-specific code is the presigned token (§5.1).
  Better built as a generic Kubernetes summoner (also GKE/AKS/self-hosted) that
  takes a token provider.

### 4.12 AWS Batch — **Fair**

- `POST /v1/submitjob` on `batch.<region>.amazonaws.com` (REST-JSON), body
  `{ jobName, jobQueue, jobDefinition, containerOverrides: { environment,
  command }, timeout: { attemptDurationSeconds }, tags }` [V]. **No client
  token or other idempotency parameter** in the request syntax [V].
- "By default, AWS Batch doesn't have a job timeout"; with one, "your job's
  container receives a SIGTERM … If the container is still running after 30
  seconds, a SIGKILL"; "There's no maximum timeout value" [V]. "There is no
  additional charge for AWS Batch" [V].
- Adds a scheduler hop (queue, compute environment) on top of ECS/EKS [U for
  the latency]. It earns its keep only for users already on Batch, or who want
  its fair-share queues to throttle summons [I].

### 4.13 App Runner — **Unsuitable (closed)**

"After careful consideration, we decided to close AWS App Runner to new
customers. Existing AWS App Runner customers can continue to use the service as
normal, including creating new resources and services … we do not plan to
introduce new features." AWS recommends ECS Express Mode for migration [V]. The
closing date **2026-04-30** is reported by secondary sources and an AWS Support
tweet in search results, not by the page read [U]. Even before this, App
Runner was a request-driven web-service host [U]; there is nothing to summon.

### 4.14 Elastic Beanstalk worker environments — **Unsuitable**

A worker environment runs `aws-sqsd`, which pulls from SQS and "sends an HTTP
POST request locally to `http://localhost/` on port 80"; the visibility
timeout goes up to 43,200 s, the inactivity timeout up to 36,000 s; scaling is
by CPU through an ASG; periodic tasks via `cron.yaml` with leader election in
DynamoDB [V]. It is a *different* queue with its own push protocol. Running a
`BunQueueWorker` there means ignoring the daemon and paying for an always-on
ASG [I]. No scale-to-zero statement on the page [V].

### 4.15 Lightsail — **Unsuitable**

Container services: "You are charged for your container service whether it's
enabled or disabled, and whether it has a deployment or not. You must delete
your container service to stop being charged"; monthly price = power × scale,
up to 20 nodes [V]. Instances are monthly bundles [U]. Neither has a
launch-a-task or cheap zero↔N shape [I].

### 4.16 Not researched

Named so that absence is not read as coverage: **CodeBuild `StartBuild`**
(runs a container for a bounded time and is a plausible summon target),
**Bedrock AgentCore** (Temporal lists it as a provider [V-plan]), SageMaker
Processing, Glue, and ECS Anywhere/EKS Hybrid (the user's own hardware).

---

## 5. SigV4 without an SDK

### 5.1 Variants needed

| API | Protocol | Request shape | Service code | Host | Notes |
|---|---|---|---|---|---|
| ECS `RunTask` / `UpdateService` | JSON 1.1 | `POST /`, `X-Amz-Target`, `application/x-amz-json-1.1` | `ecs` [U] | `ecs.<r>.amazonaws.com` [V] | Sign `content-type` and `x-amz-target` too [V: "If the Content-Type header is present … you must add it"] |
| Lambda `Invoke` | REST-JSON | `POST /2015-03-31/functions/{name}/invocations` | `lambda` [U] | `lambda.<r>.amazonaws.com` [U] | Path encoding matters for ARNs (§5.4) |
| Lambda MicroVMs `RunMicrovm` | REST-JSON | `POST /2025-09-09/microvms` | [U] | [U] | Neither found today |
| Batch `SubmitJob` | REST-JSON | `POST /v1/submitjob` | `batch` [U] | `batch.<r>.amazonaws.com` [V] | |
| EC2 `RunInstances` / `StartInstances` | Query | form body `Action=…&Version=2016-11-15` | `ec2` [V] | `ec2.<r>.amazonaws.com` [U] | XML response |
| Auto Scaling | Query | `Action=…&Version=2011-01-01` | `autoscaling` [U] | `autoscaling.<r>.amazonaws.com` [U] | XML response |
| STS `AssumeRole` | Query | `Action=AssumeRole&Version=2011-06-15` | `sts` [U] | `sts.<r>.amazonaws.com` [U] | Signed |
| STS `AssumeRoleWithWebIdentity` | Query | same | — | same | **Unsigned**: "does not require the use of AWS security credentials" [V] |
| EKS bearer token | presigned Query | `GET sts…?Action=GetCallerIdentity&Version=2011-06-15&X-Amz-…` | `sts` | | Presigned variant (`X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-SignedHeaders`, `X-Amz-Signature` in the query) [V: format in the SigV4 guide]; token wrapping [U] |

**Only one algorithm is needed: AWS4-HMAC-SHA256.** SigV4a (ECDSA P-256) is for
multi-region access points [V]; none of these APIs need it. Temporary
credentials add `x-amz-security-token`, signed as an `x-amz-*` header [V].

### 5.2 The signer — measured

`crypto.subtle` gives SHA-256 and HMAC-SHA256 natively in Bun. The steps are
exactly the IAM guide's: canonical request → hash → string to sign
(`AWS4-HMAC-SHA256`, timestamp, `YYYYMMDD/region/service/aws4_request`, hash) →
key chain `HMAC("AWS4"+secret, date)` → region → service → `"aws4_request"` →
signature [V]. The sketch kept in the session scratchpad is **36 lines of code**
(39 with comments). Against the AWS signing test suite
(`awslabs/aws-c-auth/tests/aws-signing-test-suite/v4`, fetched today) it
produces the published signature for [M]:

| Vector | Result |
|---|---|
| `get-vanilla` | match (`5fa00fa3…63fbf31`) |
| `post-x-www-form-urlencoded` (content-type, content-length, `x-amz-content-sha256` signed) | match |
| `get-vanilla-query-order-key-case` | match |
| `get-vanilla-query-unreserved` | match |
| `get-vanilla-with-session-token` | match |
| `get-utf8` (`/ሴ`), `get-space-normalized` (`/example space/`) | **differ** — see 5.4 |

The one non-obvious line is URI encoding: `encodeURIComponent` leaves
`!'()*` unescaped, SigV4 requires only `A–Z a–z 0–9 - . _ ~` to be left, so
those five are escaped by hand [V: UriEncode rules; "The standard UriEncode
functions provided by your development platform might not work"].

### 5.3 Credentials, by hosting situation

| Where the summoner runs | Source | Mechanism | Verified |
|---|---|---|---|
| Anywhere with keys; **inside Lambda** | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | read env | [U] for Lambda injecting them |
| ECS task (Fargate, EC2, Managed Instances) | task role | `GET http://169.254.170.2$AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` → JSON | [V] |
| EKS with **Pod Identity** | pod identity agent | `GET $AWS_CONTAINER_CREDENTIALS_FULL_URI` with `Authorization` from `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` | [V] |
| EKS with **IRSA** (and EKS Fargate, where IMDS is unavailable [V]) | projected OIDC token | STS `AssumeRoleWithWebIdentity` with `AWS_ROLE_ARN` + token file, **unsigned**, XML response | [V] for the call; env var names [U] |
| EC2 / ECS-on-EC2 host role | instance profile | IMDSv2: `PUT /latest/api/token` (`X-aws-ec2-metadata-token-ttl-seconds`), then `GET …/iam/security-credentials/<role>` → JSON; "new credentials available at least five minutes before the expiration" | [V] |
| **Cross-account** (bun-jobs in account A summoning into B, Temporal-style with `ExternalId`) | STS `AssumeRole` | signed Query call with base credentials | [U] parameter names (not re-read) |

The credential-chain sketch covering all six rows is **36 lines of code**,
compiles under `bun build` [M], and has **not been run against AWS** [U]. With
the signer that is ~75 lines, plus ~10–20 per adapter — the "size of that
code" answer, measured on the sketch rather than estimated.

Gaps a real implementation must add [I]: `~/.aws/credentials` / SSO profiles
(out of scope — a server process should use roles), XML error parsing per
protocol, clock-skew retry (`RequestTimeTooSkewed` / `InvalidSignatureException`
after a re-read of `Date`), and exponential backoff on throttling (ECS returns
`ThrottlingException` [V]).

### 5.4 The one open signing question

AWS: "URI encode every byte except the unreserved characters" and, for the
canonical URI, non-S3 services encode each path segment **twice** [V: the guide
distinguishes S3; the "twice" wording is from the same guide's element page,
not re-read — U]. The sketch encodes the path `fetch` actually puts on the wire
(already percent-encoded once), which is what botocore does [U]. The two
test-suite vectors that fail feed a *raw* path; the suite's expected canonical
path is the single-encoded form. For every recommended API the path is ASCII
without reserved characters **as long as the summoner uses a function *name*,
not an ARN** [I]. One live `Invoke` with an ARN settles it.

---

## 6. Cost sanity: one worker draining for 5 minutes

us-east-1, list prices read 2026-09-25 (EC2 from AWS's pricing data file
published 2026-09-24). Arithmetic is [I] on [V] prices. One vCPU / 2 GB where
the model allows it.

| Model | Configuration | 5 minutes of work | Also paid | Idle floor |
|---|---|---|---|---|
| Fargate x86 | 1 vCPU, 2 GB | 300 × (0.000011244 + 2 × 0.000001235) = **$0.0041** | image pull time is billed [V]; +30 s ≈ +$0.0004 | $0 |
| Fargate Arm | 1 vCPU, 2 GB | 300 × (0.0000089944 + 2 × 0.0000009889) = **$0.0033** | as above | $0 |
| Fargate Spot | 1 vCPU, 2 GB | ≥ **$0.0012** at the full 70% discount [V: "up to"] | interruption risk | $0 |
| Lambda x86 | 2,048 MB (~1.16 vCPU [V: 1,769 MB = 1 vCPU]) | 300 × 2 × 0.0000166667 = **$0.0100** | $0.0000002 per request | $0 |
| Lambda Arm | 2,048 MB | 300 × 2 × 0.0000133334 = **$0.0080** | | $0 |
| Lambda MicroVM (Arm) | 1 vCPU, 2 GB | 300 × (0.0000276944 + 2 × 0.0000036667) = **$0.0105** | snapshot reads $0.00155/GB [V] | $0 once terminated |
| EC2 t4g.small | 2 vCPU burstable, 2 GB [U specs] | 0.0168 × 300/3600 = **$0.0014** | boot time billed; 60 s minimum [V]; EBS | $0 once terminated |
| EC2 c7g.large | 2 vCPU, 4 GB [U specs] | 0.0725 × 300/3600 = **$0.0060** | as above | $0 |
| LMI | — | ≈ $0 marginal while inside the floor | — | **3 environments by default [V]**; illustratively three m7g.large at 0.0816 × 1.15 = **≈ $205/month** [I — the instance types are Lambda's choice] |
| EKS (any data plane) | — | as Fargate/EC2 | — | **$0.10/h control plane ≈ $73/month** [V price; I arithmetic] |
| Batch | — | as underlying Fargate/EC2 [V: no Batch fee] | — | $0 |

The per-summon cost of every recommended model is **about a cent or less**; the
decision is about lease safety, start latency and idle floors, not unit price.

---

## 7. Risks and gotchas specific to AWS

1. **Default Lambda: never leave the worker running after the handler
   returns** (§2). Construct and close it inside the handler; stop claiming at
   `remainingTime − buffer` (Temporal's default buffer is 7,000 ms [V-plan]);
   set async retries to 0 so a failure does not re-summon twice more [V: "up to
   two more times"].
2. **Snapshots duplicate identity.** Lambda MicroVMs [V] and SnapStart [V-plan]
   both restore a process image; a `BunQueueWorker` constructed before the
   snapshot shares its id and tokens with every restore. Construct after start
   (MicroVM `/run` hook).
3. **Auto-suspend and hibernate are freezes.** MicroVM idle policy keys on
   inbound endpoint traffic, which a worker never receives [V]; ASG warm-pool
   `Hibernated` restores RAM [V]. Neither may happen while a lease is held.
4. **Idempotency tokens only dedupe identical requests** (ECS `clientToken`,
   EC2 `ClientToken`) [V]. Make every parameter a pure function of the dedupe
   key. ECS tokens are per cluster and live ≤ 24 h [V]; EC2's TTL is
   undocumented on the page read [V].
5. **Some targets have no token at all** — Lambda async invoke (and it may
   deliver twice) [V], Batch [V], Auto Scaling [V]. The stampede guard in
   bun-jobs (Phase 1.5's "debounce and a stampede guard") is mandatory, not an
   optimisation; tokens are a second line.
6. **A 200 is not success for `RunTask`**: capacity problems come back as
   `failures` beside an empty `tasks` [V], and Step Functions treats a
   non-empty `Failures` as an error only in `.sync`/token modes [V].
7. **New-account quotas bite first**: Fargate On-Demand vCPU **6** [V]; Lambda
   concurrency 1,000 and "New AWS accounts have reduced concurrency and memory
   quotas" [V]; MicroVM `RunMicrovm` 5 TPS [V]; Lambda control plane 15 rps
   total [V].
8. **Idle VPC Lambda goes `Inactive` and its next invoke fails** [V] — the
   normal state of a summon target that is rarely needed. Retry, or
   `GetFunction` first.
9. **Scale-a-service fights the drain-and-exit worker** (ECS service, ASG):
   the platform replaces a worker that exits, and lowering the count may kill
   one mid-job [V for replacement semantics; I for the conflict]. Prefer
   launch-a-task; if a service is required, let the worker remove itself
   (`TerminateInstanceInAutoScalingGroup` with
   `ShouldDecrementDesiredCapacity=true` [V]).
10. **A forgotten EC2 instance bills forever.** Terminate-on-shutdown, a
    boot-time `shutdown -h +N` backstop, and a tag to sweep by [I].
11. **Graceful windows are short**: Fargate `stopTimeout` ≤ 120 s [V], Spot
    2 minutes [V], Batch 30 s after SIGTERM [V], Lambda shutdown ≤ 2 s [V].
    Size `close({ timeout })` to the host.
12. **RDS Proxy disables `sql.listen`** [V-plan]; any AWS worker behind it
    polls. Worth a line in the adapter docs, as the plan already says.
13. **Private subnets need a way out** for image pulls, STS and the AWS APIs
    the worker itself calls — NAT or VPC endpoints [U for the endpoint list].
    EKS Fargate is private-subnet-only [V].
14. **Cross-account summoning** should copy Temporal: a role in the compute
    account trusted with an `ExternalId` condition against confused-deputy
    [V-plan], assumed per call via STS `AssumeRole`.

---

## 8. The triggering side: checking for work with nothing always on

Summon-compute needs *something* awake to notice depth. If the user has no
always-on bun-jobs process:

- **EventBridge Scheduler** can invoke a small check on a schedule. Templated
  targets include Lambda `Invoke`, ECS `RunTask` and Step Functions
  `StartExecution`, and universal targets reach any API (the LMI docs use one to
  call `lambda:PutFunctionScalingConfig`) [V]. Its precision is 60 seconds with
  a one-minute floor [V-plan]. The natural shape [I]: Scheduler → a *default*
  Lambda (short, frozen-between-invocations is fine, it holds no lease) that
  runs `listWorkerRecords` + depth and calls one of the summoners above.
- **Step Functions** `arn:aws:states:::ecs:runTask.sync` runs a task and waits
  for it to stop [V] — useful for a guaranteed one-at-a-time loop, but the
  state machine does not know queue depth unless a step computes it [I].
- **Directly scheduling the worker** (Scheduler → `RunTask` every N minutes
  regardless of depth) is the zero-code fallback: at most one wasted minimum
  bill per interval when the queue is empty — 1 minute of 1 vCPU/2 GB Fargate
  ≈ $0.0008 [I on V prices] — but no response to a burst between ticks [I].

---

## Sources

All accessed **2026-09-25** unless marked [V-plan] (read 2026-09-22 by
`worker-runtimes.md` §3.7).

**ECS / Fargate**
- RunTask API — https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html
- Ensuring idempotency (ECS) — https://docs.aws.amazon.com/AmazonECS/latest/APIReference/ECS_Idempotency.html
- UpdateService API — https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_UpdateService.html
- Request throttling — https://docs.aws.amazon.com/AmazonECS/latest/APIReference/request-throttling.html
- Fargate capacity providers / Spot — https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-capacity-providers.html
- Task definition parameters (`stopTimeout`) — https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html
- Task retirement — https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-maintenance.html
- ECS Managed Instances — https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ManagedInstances.html
- Task IAM role — https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html
- ECS endpoints and quotas — https://docs.aws.amazon.com/general/latest/gr/ecs-service.html
- Fargate pricing — https://aws.amazon.com/fargate/pricing/

**Lambda**
- Invoke API — https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html
- Execution environment lifecycle — https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html
- Function states — https://docs.aws.amazon.com/lambda/latest/dg/functions-states.html
- Quotas — https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
- Custom runtimes — https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html
- Managed Instances — https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances.html
- LMI execution environment — https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-execution-environment.html
- LMI scaling — https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-scaling.html
- LMI runtimes — https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-runtimes.html
- What's New, 90-minute LMI timeout (posted 2026-09-09) — https://aws.amazon.com/about-aws/whats-new/2026/09/aws-lambda-90-minute-function/
- Durable functions — https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html
- MicroVMs RunMicrovm API — https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html
- MicroVMs core concepts — https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html
- Running and using MicroVMs — https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html
- What's New, Lambda MicroVMs (posted 2026-06-22) — https://aws.amazon.com/about-aws/whats-new/2026/06/aws-lambda-microvms/
- MicroVMs product page — https://aws.amazon.com/lambda/lambda-microvms/
- Lambda pricing (functions, LMI, durable, MicroVMs) — https://aws.amazon.com/lambda/pricing/

**EC2 / Auto Scaling**
- RunInstances API — https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_RunInstances.html
- EC2 API idempotency — https://docs.aws.amazon.com/ec2/latest/devguide/ec2-api-idempotency.html
- User data — https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html
- Spot interruption notices — https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-instance-termination-notices.html
- Instance-metadata credentials — https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-metadata-security-credentials.html
- On-Demand pricing page (billing rule) — https://aws.amazon.com/ec2/pricing/on-demand/
- On-Demand price data (published 2026-09-24) — https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20(N.%20Virginia)/Linux/index.json
- SetDesiredCapacity — https://docs.aws.amazon.com/autoscaling/ec2/APIReference/API_SetDesiredCapacity.html
- TerminateInstanceInAutoScalingGroup — https://docs.aws.amazon.com/autoscaling/ec2/APIReference/API_TerminateInstanceInAutoScalingGroup.html
- Warm pools — https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-warm-pools.html

**EKS, Batch, others**
- EKS Auto Mode — https://docs.aws.amazon.com/eks/latest/userguide/automode.html
- EKS on Fargate — https://docs.aws.amazon.com/eks/latest/userguide/fargate.html
- EKS access control — https://docs.aws.amazon.com/eks/latest/userguide/cluster-auth.html
- IRSA — https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html
- EKS pricing — https://aws.amazon.com/eks/pricing/
- Batch SubmitJob — https://docs.aws.amazon.com/batch/latest/APIReference/API_SubmitJob.html
- Batch job timeouts — https://docs.aws.amazon.com/batch/latest/userguide/job_timeouts.html
- Batch pricing — https://aws.amazon.com/batch/pricing/
- App Runner availability change — https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html
- Elastic Beanstalk worker environments — https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/using-features-managing-env-tiers.html
- Lightsail container services — https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-container-services.html
- EventBridge Scheduler templated targets — https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-targets-templated.html
- Step Functions ECS integration — https://docs.aws.amazon.com/step-functions/latest/dg/connect-ecs.html

**Signing and credentials**
- Create a signed AWS API request (SigV4) — https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
- Container credential provider — https://docs.aws.amazon.com/sdkref/latest/guide/feature-container-credentials.html
- AssumeRoleWithWebIdentity — https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html
- AWS signing test suite (vectors used for [M]) — https://github.com/awslabs/aws-c-auth/tree/main/tests/aws-signing-test-suite/v4

**Secondary, used only for [U] rows**
- App Runner closing date: search results (Encore, dev.to, an @AWSSupport post) — not a primary page
- EKS token format: `aws/aws-cli` `awscli/customizations/eks/get_token.py` and `kubernetes-sigs/aws-iam-authenticator`, seen in search snippets only

## Open items before any of this ships

1. One live call per adapter (ECS `RunTask`, Lambda `Invoke` by name *and* by
   ARN, EC2 `RunInstances`) to close §5.4 and the error-body shapes marked [U].
2. Measure time-to-first-claim for Fargate (small `oven/bun` image) and for a
   Bun Lambda container image — no AWS figure exists for either.
3. Find the Lambda MicroVMs endpoint and signing service name; confirm what an
   omitted `idlePolicy` does and whether process exit terminates the MicroVM.
4. Confirm how long EC2 remembers a `ClientToken`.
5. Confirm LMI scale-up time from a reactivated (min 0 → N) function, if LMI is
   ever to be summoned rather than merely supported.
