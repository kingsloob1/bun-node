# Summon-compute on Google Cloud and Azure

Evidence for `../../worker-runtimes.md` §3.8.1 and Phase 1.5. Research only,
gathered 2026-09-25. The question on each platform is the same: can bun-jobs
start a process there that runs an ordinary `BunQueueWorker` over the normal
driver connection, holds its leases with a live heartbeat, drains the queue
and exits? And how does that process get started: by a summoner bun-jobs
ships, or by the platform itself?

## How to read this file

Every factual row carries one of these tags. **Treat them as load-bearing.**

| Tag | Meaning |
|---|---|
| **[V]** | Verified today, 2026-09-25, from a primary source (vendor docs, REST reference, pricing page or API, KEDA docs or source). The URL is in §9. |
| **[V~]** | Verified today, but read through the fetch tool's summarising model rather than as raw page text. The fact is right; the *wording* may be a paraphrase. **Re-read before quoting it in the plan.** |
| **[S]** | Read from source in this worktree (`packages/bun-jobs`), with file and line. |
| **[M]** | Measured here, today. |
| **[P]** | Carried over from `worker-runtimes.md` §3.5 (verified 2026-09-22 by the earlier round). Not re-read today. |
| **[I]** | Inference: my reasoning from verified facts. Not a finding. |
| **[U]** | Unverified: plausible, not checked against a primary source. |

Prices are list prices in USD, read on 2026-09-25, with the region named.
Cold-start figures are **vendor-stated**, **measured** or **unknown**. Nothing
was measured on either cloud: no account was used, so every time-to-first-claim
figure below is either a vendor statement or "unknown".

---

## 0. Conclusions

### 0.1 Ranked recommendations

**Google Cloud**

1. **Cloud Run jobs**, launch-a-task. Tasks run for up to 168 h [V]. Pass
   parameters as per-execution env overrides [V]. A task ends when the
   process exits, and billing ends with it [V]. Two flaws matter:
   `jobs.run` has **no request id**, so bun-jobs must own the stampede guard
   (§3.2). And a task that runs longer than an hour can be *paused* around
   maintenance (SIGTSTP/SIGCONT) [V], which the lease must survive.
2. **Cloud Run worker pools**, scale-a-service. Google documents them for
   pull workloads, including Redis task queues [P]. Scaling is manual only:
   you PATCH `scaling.manualInstanceCount` [V], and 0 disables the pool [V].
   The call *sets* a count rather than adding to one, so it is idempotent by
   construction [I]. But the pool never scales itself down: something has to
   set it back to 0. That is either bun-jobs' controller or Google's own
   KEDA-based **CREMA**, which runs as an always-on Cloud Run service [V~].
3. **GKE (and any Kubernetes): write no summoner.** Ship a depth endpoint and
   a KEDA recipe instead (§6). GKE also gained **native HPA scale-to-zero**
   from Prometheus or Cloud Monitoring metrics, GA in GKE 1.37 and announced
   2026-09-24 [V~]. That makes a Prometheus-format depth signal useful even
   without KEDA.

*Worth watching, not yet recommendable:* **Cloud Run instances**, which are
in Preview [V]. They are singletons, created with a client-chosen
`instance_id` [V], and with restart policy `never` they go to STOPPED when the
process exits [V]. That is the closest shape on either cloud to Temporal's
Lambda model, *with* platform-enforced dedupe. But they are unavailable in
us-central1, us-east1 and europe-west1 [V], and their billing and CPU
allocation are not documented anywhere I could find [U].

**Azure**

1. **Azure Container Apps event-driven jobs + KEDA**, platform-driven. The
   platform polls a depth signal (30 s default) and starts executions [V].
   bun-jobs writes no summoner and runs no always-on process, and jobs pay
   the active rate only while an execution runs [V]. The prerequisite is a
   depth signal KEDA can read: either the endpoint in §6.4, or the
   PostgreSQL/MySQL query in §6.2.
2. **ACA manual jobs, started through ARM**, launch-a-task. This is the
   in-process summoner, for when `add()` should summon immediately rather
   than at the next poll. Use `POST …/jobs/{job}/start` with an empty body
   [V]. Two things work against it. The start call has **no dedupe**; its
   response only names the execution the platform generated [V]. And
   overriding anything **replaces the whole template** [V], so configure the
   worker through the job's own env, not per-execution overrides.
3. **AKS**, with the managed KEDA add-on [V] and the same depth endpoint.
   No summoner.

*Fallback:* **Azure Container Instances**, with `restartPolicy: Never`, for
users without an ACA environment. The dedupe key is the group name, since
creation is a `PUT` by name [V]. The group must be deleted afterwards [I].
**Azure Functions cannot be the worker on any plan** [P]. It is fine as the
*checker* (§5.3).

### 0.2 The KEDA verdict

**For Kubernetes-shaped platforms, exposing a depth signal is a better
investment than writing summoners.** One signal serves ACA apps, ACA
event-driven jobs, AKS, GKE with KEDA, GKE's native HPA (via Prometheus) and
Cloud Run worker pools (via CREMA). That is six targets for roughly the cost
of one summoner [I].

**But reading the datastore directly is not the right contract**, and the
reason is in bun-jobs' own source. It is not a matter of taste:

- **With zero workers, due delayed jobs and due retries never become
  waiting.** Only a running worker's `PROMOTE_DELAYED` moves them into the
  wait set [S `drivers/redis/scripts.ts:1094-1106`; both claim scripts
  deliberately do not promote, `scripts.ts:727` and `:790`]. The only caller is
  `BunQueueWorker` [S `queue/BunQueueWorker.ts:2119`]. Stalled-lease recovery,
  repeat healing and pruning are worker sweeps too [S
  `BunQueueWorker.ts:124-139`]. So a scaler reading the wait set **strands
  every delayed job, every retry and every job a dead summoned worker was
  holding**, at exactly the moment summoning is meant to help.
- **KEDA's Redis scaler can count the wait ZSET but cannot express "due".**
  It runs a Lua script that uses `ZCARD` for a zset [V, KEDA source], and
  bun-jobs' wait set is a ZSET [S]. It cannot run a `ZCOUNT … -inf now`.
  Counting the delayed ZSET instead would count jobs due next week, and
  summon forever [I].
- **SQL can express "due" exactly** (§6.2). The cost is coupling to an
  internal table, its column names and its state strings.

**So the endpoint is the contract, and the SQL query is a documented
recipe.** The endpoint needs one thing the recipe does not: a live process
to answer it. When every producer and every worker is scaled to zero, nothing
answers. That is the recipe's one real advantage, and it is why both should
exist (§6.5).

**What the endpoint returns, and what it costs the driver:** §6.4. In short:
`demand` (ready + due + stalled, or 0 when paused) for ScaledJob, and
`outstanding` (demand + active) for ScaledObject. It must never be served from
today's `countJobs` on SQL or Mongo. On those drivers `countJobs` is a
`GROUP BY state` over the queue's *entire retained history*, completed jobs
included [S `sql/sql-driver.ts:4302-4313`, `mongo/mongo-driver.ts:4277-4287`],
and KEDA would run it every 30 s per scaler.

### 0.3 What surprised me

1. The zero-worker blind spot above. It is a fact about bun-jobs, not about
   any cloud, and it shapes the in-process summoner too: its trigger cannot
   be "waiting > 0". It has to include `nextDelayedAt <= now` and "active
   with no live worker" (§6.4).
2. **Cloud Run jobs longer than an hour receive SIGTSTP 10 s before a
   maintenance migration, and SIGCONT after** [V]. The process is stopped in
   between, heartbeat included, for a duration nobody documents [U]. The lease
   TTL must absorb that gap, or the job is re-delivered while its first
   holder is merely paused.
3. **Direct VPC egress: "connection establishment delays of a minute or more
   on instance startup"** [V]. With Cloud NAT, "cold start delays of 30s or
   more" [V]. For a summoned worker whose Redis or Postgres sits in a VPC,
   that is plausibly the dominant term in time-to-first-claim [I].
4. Google ships a KEDA-for-Cloud-Run: **CREMA**, which has verified the
   Redis Lists scaler [V~]. It runs as a Cloud Run service pinned to one
   instance [V~]. Builds before 2026-04-29 leak memory [V~].
5. **Neither cloud's primary launch API dedupes.** Cloud Run `jobs.run` and
   ACA `jobs/start` have no request id [V]. The ones that do are Compute
   Engine (`requestId`) [V~], Cloud Batch (`jobId`, plus a `requestId`
   honoured for 60 min) [V], Cloud Run instances (`instance_id`) [V], ACI
   (the name in the PUT) [V] and Kubernetes Jobs (the name) [U]. Phase 1.5's
   "stampede guard" is therefore not optional.
6. **Granting `Microsoft.App/jobs/start/action` leaks the job's secrets.** An
   identity allowed to start a job can supply an execution template that
   reads them [V]. A summoner's identity must be treated as able to read the
   worker's database credentials.

---

## 1. What bun-jobs gives a summoner today (read from source)

### 1.1 Where waiting work lives

**Redis** [S]. Every key a queue uses sits under
`${prefix}:${ns}:q:${tag(queue)}`
(`drivers/redis/keys.ts:275`). The prefix defaults to `bun-jobs`
(`keys.ts:119`), and `tag(q)` is `{q}` in cluster mode and `q` otherwise
(`keys.ts:403-405`).

| Key | Type | Holds | Score |
|---|---|---|---|
| `…:wait` (`keys.ts:278`) | ZSET | claimable jobs; member `%016d:id` | priority (`scripts.ts:358`, `:449`) |
| `…:delayed` | ZSET | not yet due | `runAt` (`scripts.ts:345`) |
| `…:failed` | ZSET | **retry pending**, not dead | `runAt` (`scripts.ts:347`; `driver.ts:791-794`) |
| `…:active` | ZSET | claimed | `lockExpiresAt` (`scripts.ts:349`) |
| `…:wake` | LIST | one token per ready job, capped at 100 (`scripts.ts:25`, `:206-218`), deleted when the wait set is empty (`:223-226`) and popped by waiting consumers | — |
| `…:meta` | HASH | `paused = '1'` (checked in `CLAIM`) | — |
| `…:workers`, `…:workers-exp` | HASH, ZSET | live-worker registry (`keys.ts:323-326`) | expiry |

**SQL** [S]. The table is `bun_jobs_jobs` by default: the prefix
`bun_jobs_` (`sql/sql-driver.ts:1402`) plus `jobs` (`SQL_TABLES`,
`sql-driver.ts:836-848`). Both are configurable through `tablePrefix` and
`tables`. The relevant columns are `ns`, `queue`, `state`, `priority`,
`run_at` and `lock_expires_at` (`sql/schema.ts:717-723`). Times are
**epoch-milliseconds `BIGINT`** on Postgres and MySQL, `INTEGER` on SQLite
(`sql/dialect.ts:1366`, `:1579`, `:1807`). The indexes are:

- `ix_<t>_claim (ns, queue, state, priority, created_at)` (`schema.ts:913-926`)
- `ix_<t>_due (ns, queue, state, run_at)` (`:929-931`)
- `ix_<t>_lock (ns, queue, state, lock_expires_at)` (`:937-939`)

The states are `waiting | delayed | active | completed | failed | dead |
waiting-children` (`drivers/driver.ts:796-804`). The paused flag is **not a
column**: it is JSON in the `kv` table under `q:<queue>:meta`
(`sql-driver.ts:6597-6611`).

**Mongo** [S]. Collection `jobs`, with the index
`ns_1_queue_1_state_1_runAt_1` (`drivers/mongo/mongo-driver.ts:204-205`,
`:252`).

### 1.2 What does not happen while no worker is running

- **Promotion.** `PROMOTE_DELAYED` moves due members of **both** the `delayed`
  and the `failed` sets into `wait` [S `scripts.ts:1094-1106`]. `CLAIM`
  explicitly leaves promotion to "the worker's own promotion
  (PROMOTE_DELAYED), which every worker runs" [S `scripts.ts:790`; the
  same comment in `CLAIM_MANY` at `:727`].
  Its only caller is `BunQueueWorker.ts:2119` [S].
- **Stalled recovery, flow healing, pruning and repeat healing** are
  worker-run sweeps under sweep leases [S `BunQueueWorker.ts:124-139`,
  `:4341`].

**Consequence [I].** A summoner cannot tell whether work exists by reading
`waiting` alone. With no worker running, work exists when **any** of these
holds:

- `waiting > 0` and the queue is not paused;
- some `delayed` or `failed` job has `runAt <= now`;
- some `active` job's lock has lapsed, meaning a previous summoned worker died
  holding it.

The existing driver contract answers the second through `nextDelayedAt(q)`
(`driver.ts:2676`), which returns the earliest `runAt` among not-yet-due jobs
[S]. When that value is `<= now`, at least one job is due. The third is
answerable as "`active > 0` and `listWorkerRecords` is empty", since
`BunQueue.ts:1053` already exposes that list [S].

### 1.3 The management API

- `GET /queues/:queue/counts` returns `countJobs()` by state [S
  `api/routes/queues.ts:610-624`].
- `GET /queues/:queue` returns the counts, the paused flag and the limits [S
  `:588-607`].
- `GET /workers` lists the namespace's workers [S `api/routes/workers.ts:553`].

**Auth:** `createJobsApi` refuses to start without `authorize` unless
`allowUnauthenticated: true` [S `api/config.ts:1386-1389`]. It supports the
static limits `readOnly` [S `config.ts:520`] and `actions` [S `:562`], and
`authorize` receives the request. That means a KEDA `authMode: bearer` or
`apiKey` [V] can be checked by user code today [I].

**Why these routes do not suffice for KEDA:**

1. No field is "due now": `delayed` counts jobs due next month.
2. The paused flag is not folded into a single number, and KEDA reads exactly
   one numeric value through `valueLocation` [V~].
3. `countJobs` is O(retained rows) on SQL and Mongo [S
   `sql-driver.ts:4302-4313`, a `GROUP BY state` with no state filter;
   `mongo-driver.ts:4277-4287`, a `$group` over the queue]. On Redis it is a
   script of set cardinalities [S `redis-driver.ts:2015-2034`], so the cost
   there is constant.

---

## 2. Authentication with only `fetch` + WebCrypto

The dependency policy rules out `google-auth-library`, `@azure/identity` and
every other cloud SDK in a published package. Both clouds are reachable with
plain HTTP.

### 2.1 Google

| Source of identity | Request | Tag |
|---|---|---|
| Service-account key (off-GCP, or any host) | Sign an RS256 JWT with header `{alg: RS256, typ: JWT}` and claims `iss` (SA email), `scope`, `aud: https://oauth2.googleapis.com/token`, `iat`, and `exp` at most 1 h later. Then `POST https://oauth2.googleapis.com/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>` | [V~] |
| Self-signed JWT, no exchange | Use the JWT itself as the bearer, with `aud` set to the API (`https://SERVICE.googleapis.com/`), for APIs that accept it | [V~]; whether `run.googleapis.com` accepts it is [U] |
| Metadata server (Cloud Run, GCE, GKE) | `GET http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token` with header `Metadata-Flavor: Google`. The response has `access_token`, `expires_in` and `token_type` | [V] (Cloud Run container contract) / [V~] (GCE) |
| Metadata caching | "caches access tokens until they have 5 minutes of remaining time"; more than 50 qps may be rate-limited | [V~] |
| Workload Identity Federation (AWS, Azure, OIDC) | `POST https://sts.googleapis.com/v1/token` with `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `requested_token_type=…:access_token`, a provider-specific `subject_token_type` and `audience=//iam.googleapis.com/projects/N/locations/global/workloadIdentityPools/P/providers/X`. Optionally follow with `iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/SA:generateAccessToken`. The AWS subject token is a SigV4-signed `GetCallerIdentity` (more code); the Azure one is a managed-identity token (easy) | [V~] |

### 2.2 Azure

| Source of identity | Request | Tag |
|---|---|---|
| Entra app, client secret | `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with `client_id`, `scope=https://management.azure.com/.default`, `client_secret` and `grant_type=client_credentials` | [V] |
| Entra app, certificate or federated assertion | The same, with `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and `client_assertion=<jwt>` in place of the secret | [V] |
| AKS workload identity | The assertion is the file at `AZURE_FEDERATED_TOKEN_FILE`. "Read the token path from the AZURE_FEDERATED_TOKEN_FILE environment variable. Don't hard-code a path" | [V] |
| VM / VMSS (IMDS) | `GET http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://management.azure.com/` with header `Metadata: true`. Retry on 404, 429 and 5xx; a 410 means IMDS is updating, for up to 70 s | [V] |
| Container Apps (and App Service) | `GET ${IDENTITY_ENDPOINT}?resource=…&api-version=2019-08-01` with header `X-IDENTITY-HEADER: ${IDENTITY_HEADER}`. Optional `client_id` for a user-assigned identity. The response has `expires_on` (epoch seconds) | [V] |
| Backend token cache | "maintain a cache per resource URI for around 24 hours", so role changes can lag | [V] |

### 2.3 The helper, measured

`getGoogleToken()` and `getAzureToken()`, the helpers every adapter sketch
below calls, were written and checked in the session scratchpad. They are
**not in the repo**. What was measured:

- **65 non-blank, non-comment lines** for both clouds together, including a
  5-minute-skew token cache. **2,608 bytes** after `bun build --minify`. [M]
- **The RS256 path works under Bun 1.4.3 WebCrypto.** A JWT signed by
  `crypto.subtle` with a PKCS#8 key generated by `openssl genpkey` **verifies
  with `openssl dgst -sha256 -verify`** (key import plus sign ≈ 5 ms). [M]
- It typechecks under `tsc --strict` with `types: ["bun"]`. [M]
- **Not tested against either cloud's token endpoint.** No credentials were
  available. [U]

Inputs:

- `getGoogleToken({ key?, scope? })`: a service-account JSON key
  (`client_email`, `private_key`), otherwise the metadata server. The scope
  defaults to `cloud-platform`.
- `getAzureToken(cred, resource?)`: `cred` is `{kind:"secret", tenantId,
  clientId, clientSecret}`, `{kind:"federated", tenantId, clientId,
  tokenFile?}` or `{kind:"managed", clientId?}`. For `managed`, it uses
  `IDENTITY_ENDPOINT` when set and IMDS otherwise.

**WIF for Google is not in the 65 lines.** It adds an STS exchange (~15
lines [I]), plus SigV4 if the subject is AWS (~40 more [I]).

The Google key path, abridged:

```ts
const iat = Math.floor(Date.now() / 1000);
const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const claims = b64url(JSON.stringify({ iss: sa.client_email, scope,
  aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }));
const der = Buffer.from(sa.private_key.replace(/-----[^-]+-----|\s/g, ""), "base64");
const key = await crypto.subtle.importKey("pkcs8", der,
  { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key,
  new TextEncoder().encode(`${head}.${claims}`));
const assertion = `${head}.${claims}.${b64url(sig)}`;
// POST https://oauth2.googleapis.com/token  grant_type=…jwt-bearer&assertion=…
```

---

## 3. Google Cloud

### 3.1 Summary matrix

| Model | 1 Lease-capable? | 2 Max run | 3 Time to first claim | 4 Billing | 8 Style | 12 Fit |
|---|---|---|---|---|---|---|
| **Cloud Run jobs** | **Yes** for the task's life [P]; but see SIGTSTP (§3.2) | Task **10 min default, 168 h max** (GPU 1 h) [V]; "no explicit timeout on a job execution" [V] | Unknown. Direct VPC egress may add "a minute or more" [V] | Instance-based rate, "for the entire lifetime of any instance started, with a **minimum of 1 minute**", rounded up to 100 ms [V] | launch-a-task | **Excellent** |
| **Cloud Run worker pools** | **Yes** [P]; billed "as *active* instances, even if they happen to be idle" [V] | Long-running; no max documented [U] | Unknown | Worker-pool rate (below) [V]; minimum charge not stated [U] | scale-a-service (manual count) | **Good**: must be scaled down by someone |
| **Cloud Run instances** (Preview) | Probably, singleton container [I]; CPU allocation undocumented [U] | `timeout` field in create (example `3600s`) [V]; ~7-day lifecycle when restart policy is `always` or `on-failure` [V] | Unknown | **Not on the pricing page** [U] | launch-a-task, platform dedupe | **Good, later** (Preview, region gaps) |
| **Cloud Run services**, instance-based + min-instances | Only so [P] | 60 min request timeout [P] | n/a | Instance-based, 1-minute minimum [V] | scale-a-service | Poor (the plan's reasons) |
| **Cloud Run services**, request-based | **No**: CPU allocated only while processing requests [V~] | — | — | — | — | **Unsuitable** |
| **Cloud Run functions** | No [P] | 60 min HTTP / 540 s event [P] | — | — | — | **Unsuitable** as worker; OK as checker |
| **Compute Engine VM** (insert/start; Spot) | **Yes** | Unbounded; optional `maxRunDuration` of **30 s to 120 days**, action STOP or DELETE, "might take up to 30 seconds longer" [V~] | Unknown | Per second after a **1-minute minimum** [V] | launch-a-task | Good for VM users; heavy |
| **Spot VM** | Yes, until preempted | Preemption notice **0 s default, 120 s (Preview)**, then ACPI G2 "best effort and up to 30 seconds" [V~] | Unknown | Up to 91% off; prices change up to daily; no charge if preempted within 1 min [V~] | launch-a-task | Fair: short notice, at-least-once |
| **MIG resize (+ standby pool)** | Yes | Unbounded | Standby pool resumes suspended VMs, then starts stopped ones, then creates [V~]; no figure [U] | VM rate; stopped and suspended VMs bill disk, IPs and suspended memory state [V~] | scale-a-service | Good for fleets; overkill for a drain |
| **Cloud Batch** | Yes (VMs) | Per-task `maxRunDuration` [V] | Unknown; VM provisioning [I] | "no additional cost for using Batch", only the underlying resources [V~] | launch-a-task | Fair: heavy for a 5-minute drain |
| **GKE Standard/Autopilot**, Kubernetes Job | Yes | `activeDeadlineSeconds` → `DeadlineExceeded` [V] | Autopilot pod plus node provisioning; unknown. The Sept 2026 blog cites "60-90 second cold-start delays" that capacity buffers remove [V~] | Autopilot: pod requests "in one-second increments … with no minimum duration" [V]; $0.10/cluster/hour fee, one cluster free [V] | launch-a-task or KEDA | Good via KEDA; **no summoner** |
| **App Engine standard** | Automatic scaling: **no** background threads; basic/manual: allowed [V~] | 10 min automatic, 24 h basic/manual [V~] | — | — | — | **Unsuitable** (fixed runtimes; Bun [U]) |
| **App Engine flexible** | Container [U] | [U] | [U] | [U] | scale-a-service | Poor (legacy-shaped; not researched further) |

### 3.2 Cloud Run jobs (recommended #1)

1. **Lease-capable: yes, with a caveat.** A task is a container that runs
   until it exits [P]. For jobs longer than an hour: "These can occur during
   maintenance events that migrate the job from one machine to another. The
   container receives a SIGTSTP signal 10 seconds before the event and a
   SIGCONT signal after the event" [V]. Between those two signals the
   process is stopped, heartbeat included [I], for an undocumented duration
   [U]. A lease TTL shorter than that pause will re-deliver the job [I].
   *Mitigation:* the worker can trap SIGTSTP (Bun can install a handler [U])
   and stop claiming. Better, keep summoned drains under an hour and let the
   next summon continue [I].
2. **Max run:** a task defaults to 10 min and can be set up to 168 h [V].
   The shutdown sequence is "SIGTERM … the start of a 10 second period
   before the actual shutdown occurs, at which point Cloud Run sends a
   SIGKILL" [V]. Whether a task-timeout kill uses the same 10 s grace is not
   stated [U]. **Temporal's `shutdownDeadlineBufferMs` applies:** begin
   draining at `timeout - buffer`.
3. **Time to first claim: unknown** [U]. Vendor-stated contributors: Direct
   VPC egress "connection establishment delays of a minute or more on
   instance startup" [V], and Cloud NAT "cold start delays of 30s or more"
   [V].
4. **Billing:** instance-based, whole instance lifetime, **1-minute minimum**,
   rounded up to 100 ms [V]. us-central1 list price: **$0.000018/vCPU-s,
   $0.000002/GiB-s**. The free tier is 240,000 vCPU-s and 450,000 GiB-s per
   month per billing account [V]. Idle costs nothing, since no execution
   means no instance [I]. *Delayed jobs* (Preview) run at $0.0000126 and
   $0.0000014 in exchange for deferral of up to 12 h [V]. Useless for
   latency, but cheap for a nightly backlog [I].
5. **Start API:** `POST https://run.googleapis.com/v2/projects/{p}/locations/{r}/jobs/{job}:run`
   with body `{ overrides: { containerOverrides: [{ name?, args?, env?, clearArgs? }], taskCount?, timeout? } }`.
   It returns a long-running `Operation` [V~]. Overrides need
   `run.jobs.runWithOverrides` [V~]. Each task also gets
   `CLOUD_RUN_TASK_INDEX`, `CLOUD_RUN_TASK_COUNT` and `CLOUD_RUN_EXECUTION`
   [V~].
6. **Idempotency: none on `:run`** [V~]. The Job resource exposes
   `latestCreatedExecution.completionStatus`, with values including
   `EXECUTION_RUNNING` and `EXECUTION_PENDING` [V~], so a summoner can check
   before running. That check-then-act is racy across controllers [I]. The
   Job also has `startExecutionToken` and `runExecutionToken`: "A unique
   string used as a suffix creating a new execution … The sum of job name and
   token length must be fewer than 63 characters" [V]. Setting one through a
   Job *update* with a deterministic token (say, a backlog epoch) **may**
   give name-based dedupe [I/U]. Nobody has tested it.
7. **Stop:** the task ends when the process exits 0, and billing stops [I
   from "instance lifetime"]. Nothing needs stopping.
8. **Style:** launch-a-task. `taskCount` gives N parallel drainers in one
   call.
9. **Network:** Direct VPC egress or Serverless VPC Access [V]. **10-minute
   idle timeout to VPC destinations, 20 minutes to the internet** [V]. A
   pooled Redis or Postgres connection quieter than that is dead [P].
   1 Gbps per instance [V].
10. **Bun:** any container [P].
11. **Quotas:** **1,000 running executions** per project and region; **Job
    Run: 180 per 60 s** per project and region; 10,000 tasks per execution;
    10 task retries [V].
12. **Fit: Excellent.** The documented shape of "start, drain, exit".
13. **Adapter sketch** [I; not run]:

```ts
export function cloudRunJob(o: { project: string; region: string; job: string;
  key?: GoogleServiceAccountKey; tasks?: number }) {
  const name = `projects/${o.project}/locations/${o.region}/jobs/${o.job}`;
  return async ({ queue }: { queue: string }) => {
    const h = { authorization: `Bearer ${await getGoogleToken({ key: o.key })}` };
    const job = await (await fetch(`https://run.googleapis.com/v2/${name}`, { headers: h })).json();
    const s = job.latestCreatedExecution?.completionStatus;       // cheap pre-check; the real
    if (s === "EXECUTION_RUNNING" || s === "EXECUTION_PENDING")   // guard is bun-jobs' own lock
      return { skipped: "execution in flight" };
    const res = await fetch(`https://run.googleapis.com/v2/${name}:run`, {
      method: "POST", headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ overrides: { taskCount: o.tasks ?? 1,
        containerOverrides: [{ env: [{ name: "BUN_JOBS_QUEUES", value: queue }] }] } }),
    });
    if (!res.ok) throw new Error(`jobs.run ${res.status}: ${await res.text()}`);
    return { operation: (await res.json()).name as string };
  };
}
```

### 3.3 Cloud Run worker pools (recommended #2)

1. **Lease-capable: yes** [P]. "worker pools do not have a load balanced
   endpoint/URL and do not support autoscaling" [V].
2. **Max run:** long-running. The documented maximum is 7 days for Cloud
   Run *instances* only [V]; for worker pools none is documented [U].
   SIGTERM then 10 s [V].
3. **Time to first claim:** unknown [U]; Direct VPC caveats as in §3.2 [V].
4. **Billing:** "all the instances that you requested are billed as
   *active* instances, even if they happen to be idle" [V]. us-central1 list
   price: **$0.000011244/vCPU-s, $0.000001235/GiB-s**, cheaper than jobs.
   The free tier is 384,204 vCPU-s and 728,744 GiB-s [V]. Google's own
   example is 1 vCPU / 512 MiB for a month in europe-west1: $16.83 list, or
   $11.61 after the free tier [V]. The minimum charge per instance start is
   not stated [U]. At 0 instances, cost is 0 [I].
5. **Start API:** `PATCH https://run.googleapis.com/v2/projects/{p}/locations/{r}/workerPools/{w}`
   with `updateMask` [V~] and body `{ "scaling": { "manualInstanceCount": N } }`
   [V~]. "Specify a value of 0 to disable the worker pool" [V]. The exact
   `updateMask` path string is [U]. Parameters come from the pool's own
   revision env. Changing env through PATCH creates a revision [I].
6. **Idempotency: natural.** The call sets a target rather than adding one,
   so repeating it is harmless [I].
7. **Stop: something must PATCH it back to 0.** If the worker exits, the
   platform probably restarts it, since the pool is a service [U]. So the
   worker must **not** exit on idle in this mode. Either bun-jobs' controller
   scales it down after `idleTimeout`, or CREMA does. **This is a different
   worker-file mode from launch-a-task** (§6.3).
8. **Style:** scale-a-service.
9. **Network:** Direct VPC egress; worker pools are the only Cloud Run shape
   with Direct VPC *ingress* [P]. The same 10-minute idle timeout [V].
10. **Bun:** any container [P].
11. **Quotas:** 1,000 worker pools per project and region [V~]. The
    per-pool instance maximum is not recorded here [U].
12. **Fit: Good.** Cheapest per second and purpose-built, but scale-down is
    your job.
13. **Adapter sketch** [I]:

```ts
export function cloudRunWorkerPool(o: { project: string; region: string; pool: string; key?: GoogleServiceAccountKey }) {
  const url = `https://run.googleapis.com/v2/projects/${o.project}/locations/${o.region}/workerPools/${o.pool}`
    + `?updateMask=scaling.manualInstanceCount`;                       // mask path: [U]
  const set = async (n: number) => {
    const res = await fetch(url, { method: "PATCH", headers: {
      authorization: `Bearer ${await getGoogleToken({ key: o.key })}`, "content-type": "application/json" },
      body: JSON.stringify({ scaling: { manualInstanceCount: n } }) });
    if (!res.ok) throw new Error(`workerPools.patch ${res.status}: ${await res.text()}`);
  };
  return { up: (n = 1) => set(n), down: () => set(0) };                // idempotent both ways
}
```

**CREMA** [V~]. CREMA is "Cloud Run External Metrics Autoscaling". It
"leverages KEDA" (v2.20) and is deployed as a Cloud Run service with
`--scaling=1`, so it is always on. It is configured by YAML in Parameter
Manager and needs eight predefined roles. Scalers it has verified: Kafka,
Cron, Pub/Sub, Stackdriver, GitHub runner, Prometheus, RabbitMQ, **Redis
Lists**, Temporal. "The compatibility for any KEDA scaler not listed above is
currently unknown", which covers PostgreSQL and metrics-api. Known issues: a
memory leak in builds before 2026-04-29; "A given Cloud Run service or worker
pool should only be scaled by a single CREMA deployment"; and Cloud Monitoring
metrics lag by 2+ minutes. Without `pollingInterval` set, CREMA polls only
when POSTed to, so Cloud Scheduler could drive it [V~]. Whether that allows
CREMA itself to scale to zero is [U].

### 3.4 Compute Engine, MIGs and Cloud Batch

- **`instances.insert`:** `POST https://www.googleapis.com/compute/v1/projects/{p}/zones/{z}/instances?requestId=…&sourceInstanceTemplate=…`.
  "If you provide the same request ID in multiple calls, the API processes it
  only once" [V~]. Combined with `scheduling.maxRunDuration` and
  `instanceTerminationAction: DELETE` [V~], this gives a **self-deleting VM
  with platform dedupe**. The Bun process exiting does not stop the VM; a
  startup script would have to `shutdown` [I].
- **Start a stopped VM:** billing continues for attached resources while it
  is stopped [V~].
- **MIG resize:** `POST …/zones/{z}/instanceGroupManagers/{m}/resize?size=N&requestId=…`,
  where the `requestId` makes the call idempotent [V~]. With a standby pool
  in `SCALE_OUT_POOL` mode, a scale-out "resumes suspended VMs … then starts
  stopped VMs … then creates new VMs" [V~]. Suspended VMs are terminated
  after 60 days [V~].
- **Spot:** notice is 0 s by default or 120 s in Preview, then up to 30 s of
  ACPI shutdown [V~]. A lease survives only if the worker's SIGTERM path
  releases or finishes within that window. Otherwise stalled recovery takes
  the job [I].
- **Billing:** "a minimum of 1 minute … After 1 minute … per-second" [V].
- **Cloud Batch:** `POST https://batch.googleapis.com/v1/projects/{p}/locations/{r}/jobs?jobId=…&requestId=…`.
  `jobId` is client-chosen, and `requestId` is honoured "for at least 60
  minutes" [V]. `TaskSpec` carries `runnables`, `maxRunDuration` and
  `environment` [V]. "No additional cost" beyond the resources [V~].
  **Fit: Fair.** It provisions VMs per job, which is heavy for a 5-minute
  drain [I].
- **Adapter sketch (MIG)** [I]:

```ts
export function gceMig(o: { project: string; zone: string; mig: string; key?: GoogleServiceAccountKey }) {
  return async (size: number, dedupe: string) => {
    const u = `https://compute.googleapis.com/compute/v1/projects/${o.project}/zones/${o.zone}`
      + `/instanceGroupManagers/${o.mig}/resize?size=${size}&requestId=${dedupe}`; // requestId: a UUID [U format]
    const res = await fetch(u, { method: "POST", headers: { authorization: `Bearer ${await getGoogleToken({ key: o.key })}` } });
    if (!res.ok) throw new Error(`resize ${res.status}: ${await res.text()}`);
  };
}
```

(The REST reference prints the host as `www.googleapis.com/compute/v1` [V~].
`compute.googleapis.com` is [U].)

### 3.5 GKE

- **Auth:** "All GKE clusters are configured to accept Google Cloud user and
  service account identities" [V]. A `getGoogleToken()` bearer should
  therefore reach the API server [I]. It also needs the cluster CA for TLS;
  Bun's `fetch` accepts `tls: { ca }` [U].
- **Launch-a-task:** `POST https://{endpoint}/apis/batch/v1/namespaces/{ns}/jobs`
  with a **deterministic `metadata.name`**, where 409 AlreadyExists is the
  dedupe [U]. Set `activeDeadlineSeconds` [V] and `ttlSecondsAfterFinished`
  [V].
- **Better: no summoner at all.** Install KEDA (Google's tutorial covers
  scale-to-zero with KEDA [V]), or use **native HPA scale-to-zero**: GKE
  1.37, GA, announced 2026-09-24, `minReplicas: 0`, via an
  `AutoscalingMetric` CRD fed by Managed Prometheus, Pub/Sub, Cloud
  Monitoring or load-balancer signals [V~]. A **Prometheus-format** depth
  metric from bun-jobs would plug into that directly [I].
- **Fit: Good**, via §6. Writing a Kubernetes-API summoner means a CA
  bundle, RBAC and a manifest: poor value next to KEDA [I].

### 3.6 Triggering with no always-on process (GCP)

The in-process summoner fires from `add()`. Nothing fires when a *delayed*
job comes due at zero producers and zero workers (§1.2). A periodic external
check covers that case.

| Option | Cost at one check per minute | Tag |
|---|---|---|
| Cloud Scheduler → **Workflows**: GET the depth endpoint, `if` it is non-zero, call the Cloud Run jobs connector | Scheduler $0.10/job/31 days, 3 jobs free per billing account [V]. Workflows internal steps $0.01 per 1,000 after 5,000 free; external HTTP steps $0.025 per 1,000 after 2,000 free [V]. About 6 steps × 43,200 runs ≈ 259k steps ≈ **$2.5/mo internal, ≈ $6.4/mo if the endpoint is outside Google** [I, arithmetic] | [V] prices |
| Cloud Scheduler → **the worker job itself** every N min (it exits at once when the queue is empty) | 1-minute minimum per run: 1 vCPU / 0.5 GiB = $0.00114 per empty run, or ≈ $9.85/mo at every 5 min before the free tier, ≈ $5 after [I, arithmetic on [V] prices] | |
| Cloud Scheduler → CREMA POST | CREMA's own always-on instance [V~] | |
| Eventarc | Not researched; event sources do not include a Redis or Postgres row count [U] | |

---

## 4. Azure

### 4.1 Summary matrix

| Model | 1 Lease-capable? | 2 Max run | 3 Time to first claim | 4 Billing | 8 Style | 12 Fit |
|---|---|---|---|---|---|---|
| **ACA jobs** (manual, schedule, event) | **Yes** per replica; "Platform maintenance … might interrupt long-running job replicas. Set the replica retry limit to at least `1`" [V] | `replicaTimeout`, "the maximum time in seconds to wait for a replica to complete" [V]; **maximum undocumented** [P, and not in quotas today [V]] | Unknown; plus up to `pollingInterval` (30 s default) for event jobs [V] | Per second, **active rate**: "Idle charges don't apply to jobs" [V]. eastus: **$0.000024/vCPU-s, $0.000003/GiB-s** [V]. Free per subscription: 180,000 vCPU-s and 360,000 GiB-s per month [V] | launch-a-task (manual) / **platform-driven** (event) | **Excellent** |
| **ACA apps** + KEDA custom rule | Yes | Long-running | KEDA poll 30 s; scale-up step 1, 4, 8, … [V] | Active rate; idle rate only above 0 min replicas [V]; **0 replicas = no charge** [V] | platform-driven (ScaledObject) | Good: see the scale-in hazard in §6.3 |
| **Azure Functions**, all plans | **No, on every plan** [P] | Flex/Premium: 30 min default, unbounded max; "grace period … 60 minutes during scale in … 10 minutes during platform updates" [V]. Consumption 5/10 min [V]. HTTP 230 s cap [V] | — | Flex: min 1,000 ms per execution, then 100 ms [V] | — | **Unsuitable** as worker; **OK as checker** |
| **Linux Consumption (Functions)** | — | — | — | The table says "Linux – **Retired**"; the text says "retiring on **30 September 2028**"; v3 apps stop after 2026-09-30 [V] | — | Do not target |
| **Azure Container Instances** | Yes (container) [I] | Unbounded [U] | "The size of your container image impacts how long it takes to deploy" [V]; no figure | eastus: $0.0405/vCPU-h, $0.00445/GB-h; Spot $0.01215 / $0.001335 [V]; granularity [U] | launch-a-task | Fair: needs cleanup |
| **VM** / **VMSS** (+ Spot, standby pools) | Yes | Unbounded | Unknown; standby pools keep VMs running, deallocated or hibernated (Preview) [V] | VM rate; deallocated costs disks only [V] | launch-a-task (VM start) / scale-a-service (VMSS capacity) | Fair: heavy for a drain |
| **Azure Spot** | Until evicted: "evict … with 30-seconds notice"; Scheduled Events "best effort … up to 30 seconds" [V] | — | — | Discounted [V] | — | Fair |
| **AKS** + KEDA add-on | Yes | `activeDeadlineSeconds` [V] | Pod plus node [U] | Nodes [U] | platform-driven | Good via §6; **no summoner** |
| **App Service / WebJobs** | Continuous WebJobs with **Always On** (Basic and above) [V]; "A web app can time out after 20 minutes of inactivity" otherwise [V] | Unbounded with Always On [I] | — | Always-on plan [I] | always-on | **Poor**: the opposite of summoning |
| **Azure Batch** | Yes (pool VMs) | [U] | Pool provisioning [U] | "No additional charge" [U] | launch-a-task | Poor: pool plus job model is heavy [I] |

### 4.2 ACA jobs (recommended #1 as event-driven, #2 as manual)

1. **Lease-capable: yes.** A job replica is a container that runs to exit
   [V]. Maintenance may interrupt it [V], and bun-jobs' at-least-once stalled
   recovery covers that [I].
2. **Max run:** `replicaTimeout`, maximum undocumented [P/V]. The shutdown
   grace period is not researched [U].
3. **Time to first claim:** unknown [U]. Event jobs add up to one
   `pollingInterval` (default 30 s) [V].
4. **Billing:** per second at the active rate; request charges do not apply
   to jobs [V]. eastus: $0.000024/vCPU-s and $0.000003/GiB-s [V].
   *Watch:* an **"Environment Management Hour" meter at $0.10/h, effective
   2026-09-01**, appears in the retail price API [V]. The billing page says
   "features such as private endpoints and planned maintenance are subject
   to a Dedicated Plan Management charge regardless of whether you use the
   Consumption or Dedicated plans" [V]. Which environments incur it is [U].
5. **Start API:** `POST https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.App/jobs/{job}/start?api-version=2026-07-01`.
   The body is an optional `JobExecutionTemplate {containers[], initContainers[]}`,
   each with `image`, `name`, `command`, `args`, `env[{name, value | secretRef}]`
   and `resources` [V]. It returns 200 with `{name, id}` (e.g.
   `testcontainerAppsJob0-pjxhsye`) or 202 with `Location` [V]. **Overriding
   replaces everything:** "the job's entire template configuration is
   replaced with the new configuration" [V]. The execution list is `GET
   …/jobs/{job}/executions` [V]. The field names for execution status are
   [U].
6. **Idempotency: none.** The execution name is generated by the platform
   [V]. Pre-check the executions list, and own the guard in bun-jobs [I]. For
   event jobs KEDA's ScaledJob does it: new jobs = `maxScale −
   runningJobCount` [V] (§6.3).
7. **Stop:** the execution completes when the replica exits [V].
8. **Style:** manual is launch-a-task; event is platform-driven.
9. **Network:** a VNet-integrated environment [P]. Whether ACA's KEDA can
   reach a private Redis or Postgres in that VNet is [U]. It must, for a
   datastore scaler to work.
10. **Bun:** any container [P].
11. **Quotas:** "Managed Environment Consumption Cores … the sum of cores
    requested by each active replica across all apps in the environment" [V].
    `maxExecutions` per event job [V]. Execution history keeps 100 [V].
12. **Fit: Excellent.**
13. **Adapter sketch (manual start)** [I]:

```ts
export function acaJob(o: { subscription: string; resourceGroup: string; job: string; cred: AzureCredential }) {
  const base = `https://management.azure.com/subscriptions/${o.subscription}/resourceGroups/${o.resourceGroup}`
    + `/providers/Microsoft.App/jobs/${o.job}`;
  return async () => {
    const h = { authorization: `Bearer ${await getAzureToken(o.cred)}` };
    // no body: keep the job's own template (an override replaces all of it, secrets and env included)
    const res = await fetch(`${base}/start?api-version=2026-07-01`, { method: "POST", headers: h });
    if (res.status === 202) return { pending: res.headers.get("location") };
    if (!res.ok) throw new Error(`jobs/start ${res.status}: ${await res.text()}`);
    return (await res.json()) as { name: string; id: string };
  };
}
```

**Permissions** [V]. The *Container Apps Jobs Operator* role can start jobs,
and a custom role can list `Microsoft.App/jobs/start/action`. But "An
identity that can start a job can use an execution template to reference job
secrets whose names it knows". Scope the summoner's identity to exactly one
job.

### 4.3 ACA apps with a KEDA rule

- A custom rule can use "any **ScaledObject**-based KEDA scaler"; event jobs
  use "any **ScaledJob**-based" scaler [V].
- **Authentication for non-Azure scalers is secrets only.** Managed identity
  in scale rules covers Azure resources: Queue Storage, Service Bus, Event
  Hubs [V].
- Behaviour: poll 30 s; cool-down 300 s, "only when scaling in from the final
  replica to 0"; scale-down stabilisation 300 s; `desiredReplicas =
  ceil(metric / target)`; maximum 1,000 replicas [V].
- **"When you add or edit scaling rules, you create a new revision"** [V].
  Driving `minReplicas` from bun-jobs through ARM would churn revisions [I],
  so an ACA *app* should be scaled by KEDA, not by a summoner.
- "If ingress is disabled and you don't define a `minReplicas` or a custom
  scale rule, your container app scales to zero and has no way of starting
  back up" [V]. That is precisely the worker app without a KEDA rule.

### 4.4 Container Instances (fallback)

- Create: `PUT …/Microsoft.ContainerInstance/containerGroups/{name}?api-version=2026-07-01`.
  It has `restartPolicy` (Always, OnFailure or Never), `subnetIds` and a
  `standbyPoolProfile` field [V].
- **`Never` is not quite never:** "If the container exits with a nonzero exit
  code, the container might still be restarted by the platform" [V]. The
  worker must exit 0 on a clean drain.
- Dedupe comes from the name in the PUT [V]. Whether a PUT on a running group
  restarts it is [U]. The group must be DELETEd after it exits, or it lingers
  [I]; whether a terminated group bills is [U].
- Private registries: "only Azure Container Registry" for network-restricted
  registries [V].
- **Fit: Fair.**

### 4.5 VM, VMSS, App Service, Batch (brief)

- **VM start:** `POST …/Microsoft.Compute/virtualMachines/{vm}/start?api-version=2026-04-01` [V].
- **VMSS:** `PATCH …/virtualMachineScaleSets/{name}?api-version=2026-04-01`
  with `sku.capacity` [V for the endpoint; the body field is U]. Standby
  pools hold VMs running, deallocated or hibernated (Preview), and
  "deallocated … doesn't incur any compute costs" [V]. Setting a capacity is
  idempotent [I].
- **App Service and WebJobs** need an always-on plan to run continuously [V].
  That is the opposite of summoning. Poor.
- **Azure Batch:** not researched in depth [U]. Poor fit on shape alone [I].

### 4.6 Triggering with no always-on process (Azure)

| Option | Notes | Tag |
|---|---|---|
| **ACA event-driven job with a KEDA rule** | The platform polls; no compute runs until there is work. The recommended answer | [V] mechanism |
| ACA scheduled job every N min (cron, UTC) | Per-second billing, no minimum stated; it can run the drain worker directly | [V] |
| Functions Flex timer trigger → ACA start | Bun only through a custom handler (supported on Flex [V]); Node 22 and 24 [V]; host init timeout 30 s [V] | [V] |
| Logic Apps | Not researched | [U] |

---

## 5. Cross-cutting: what a summoned worker has to do

1. **Two worker-file modes** [I]:
   - **launch-a-task** (Cloud Run job, ACA job, ACI, Batch, Kubernetes Job,
     ScaledJob): drain, then exit 0 after `idleTimeout`.
   - **scale-a-service** (worker pool, ACA app, ScaledObject): never exit on
     idle, because the platform would restart it. Stop claiming only on
     SIGTERM.
2. **Begin shutdown before the platform deadline**, as Temporal's
   `shutdownDeadlineBufferMs` does. Cloud Run gives 10 s after SIGTERM [V].
   Functions give 60 min on scale-in [V]. Spot gives 0 to 30 s on GCP [V~]
   and up to 30 s on Azure [V].
3. **Keep-alive under the idle timeout.** Cloud Run drops VPC connections idle
   for 10 minutes [V]. A worker waiting on a quiet Redis must ping inside that
   window [I].
4. **Tolerate a paused process** on Cloud Run jobs longer than an hour
   (SIGTSTP/SIGCONT) [V]. Size the lease TTL for it, or keep drains under
   an hour [I].
5. **Guard against summoning twice** in bun-jobs itself, for example with a
   compare-and-set queue-state entry holding `summonedAt` and `until`, since
   `setQueueState` exists [I]. Only some platforms dedupe (§0.3 item 5).

---

## 6. Platform-driven summoning (KEDA)

### 6.1 What KEDA can read (verified 2026-09-25, KEDA docs v2.21)

| Scaler | Reads | Parameters | Auth | Tag |
|---|---|---|---|---|
| `redis` (lists) | Lua script: `zset→ZCARD`, `set→SCARD`, `hash→HLEN`, `list/none→LLEN` (source, `main`); zset support dates to PR #1006 (2020) | `listName`, `listLength`, `activationListLength` (default 0), `databaseIndex`, `enableTLS` | username/password, TLS | [V] docs; [V] source |
| `postgresql` | "the query must return a single numeric value" | `query`, `targetQueryValue`, `activationTargetQueryValue` | password or `azure-workload` | [V~] |
| `mysql` | the same | `query`, `queryValue`, `activationQueryValue` | connection string or fields | [V~] |
| `mongodb` | counts documents matching a JSON `query` | `dbName`, `collection`, `query`, `queryValue` | connection string | [V~]; a dynamic "now" is **not** documented |
| `metrics-api` | GET a URL, extract one value | `url`, `valueLocation` (GJSON for JSON), `targetValue`, `activationTargetValue`, `format` json/xml/yaml/**prometheus** | `authMode`: apiKey, basic, tls, bearer | [V~] |
| ScaledObject | `pollingInterval` 30 s; `cooldownPeriod` 300 s, to zero only; `minReplicaCount` 0 | | | [V~] |
| ScaledJob | `pollingInterval` 30 s; `maxReplicaCount` 100 per poll; default strategy: new jobs = `maxScale − runningJobCount`, where `maxScale = min(MaxReplicaCount, ceil(queueLength / targetAverageValue))` | | | [V] |

### 6.2 Reading bun-jobs' datastore directly: how brittle?

**Redis: wrong at zero workers.** The trigger would be
`listName: bun-jobs:<ns>:q:<queue>:wait`, with `{<queue>}` in cluster mode and
the `redis-cluster` variant [I]. KEDA would `ZCARD` it [V]. That misses every
due delayed job and every due retry (§1.2), and also stalled jobs. Adding
`…:delayed` as a second trigger counts *future* jobs, keeping or re-summoning
a worker until next week's job runs [I]. The `wake` list approximates ready
work only while nobody is consuming it, and caps at 100 [S]. It is an
implementation detail with no contract. **Verdict: document it only as
"works if you never delay or retry".**

**PostgreSQL / MySQL: exact, but coupled.** A single query can express the
§1.2 definition [I, not run]:

```sql
-- Postgres; $NS / $QUEUE literal; run_at and lock_expires_at are epoch ms (BIGINT)
SELECT COUNT(*) FROM bun_jobs_jobs
 WHERE ns = 'default' AND queue = 'emails' AND (
       state = 'waiting'
    OR (state IN ('delayed','failed') AND run_at <= (EXTRACT(EPOCH FROM now()) * 1000)::bigint)
    OR (state = 'active' AND lock_expires_at < (EXTRACT(EPOCH FROM now()) * 1000)::bigint))
-- MySQL: CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS SIGNED)
```

Each disjunct has an index whose prefix is `(ns, queue, state)` (§1.1) [S].
Whether the planner uses them for an `OR` is not measured [U]. The coupling
is to the table name (configurable through `tablePrefix` and `tables`), to
column names that `syncSchema` exists to evolve, to the state strings, and to
the paused flag, which lives in `kv` JSON and is therefore **ignored** here,
so a paused queue would still summon [I]. The query's own advantage is that
it **needs no bun-jobs process up**.

**Mongo:** plausibly `{"$expr": …"$$NOW"…}` inside `query` [U]. Neither
KEDA's docs nor I verified that the scaler passes `$expr` through.

**SQLite, file and memory drivers:** no KEDA scaler, and none of these can be
reached from another host anyway [I].

### 6.3 ScaledJob vs ScaledObject, for bun-jobs

- **ScaledJob (ACA event jobs, KEDA `ScaledJob`)** pairs with the
  **launch-a-task** worker. With `targetValue` ≈ "jobs one drain should
  take", the default strategy starts `ceil(depth / target) − running`
  executions [V]. So a large target means one drainer at a time, and no
  stampede without any bun-jobs code [I]. Each execution exits when the
  queue is idle [I].
- **ScaledObject (ACA apps, KEDA `ScaledObject`, CREMA)** pairs with the
  **scale-a-service** worker. **Hazard:** scale-to-zero follows the metric
  hitting its activation value for `cooldownPeriod` [V]. If the metric is
  `waiting` only, a worker busy on a 10-minute job while `waiting = 0` is
  **SIGTERMed mid-job** after 300 s [I]. The ScaledObject metric must
  therefore include `active` jobs ("outstanding"), not just "demand".
- **Scale to zero:** both need `minReplicaCount`/`minExecutions` 0 [V].
  Activation defaults to 0, so any non-zero value summons [V].

### 6.4 The depth endpoint: what it returns, what it costs

A proposed route [I; this is design, not a finding]. The name is open:
`GET /queues/:queue/demand`, or `GET /demand?queues=a,b` for many.

```jsonc
{
  "queue": "emails",
  "paused": false,
  "waiting": 12,          // countable today
  "dueNow": 3,            // delayed + failed with runAt <= now  (needs a driver method, or a boolean from nextDelayedAt)
  "stalled": 0,           // active with lapsed lock              (ditto, or "active>0 && workers==0")
  "active": 1,
  "workers": 0,           // live, from listWorkerRecords
  "nextDueAt": 1790341200000,
  "demand": 15,           // paused ? 0 : waiting + dueNow + stalled   -> ScaledJob valueLocation
  "outstanding": 16       // demand + active                          -> ScaledObject valueLocation
}
```

The Prometheus variant for `format: prometheus`, for GKE's native HPA through
Managed Prometheus, and for CREMA's Prometheus scaler:
`bun_jobs_queue_demand{ns="…",queue="…"} 15` and
`bun_jobs_queue_outstanding{…} 16` [I].

**Cost to the driver:**

- **Zero-change version.** `demand = waiting + (nextDelayedAt <= now ? 1 : 0)
  + (active > 0 && workers == 0 ? active : 0)`, from `countJobs`,
  `nextDelayedAt`, `isPaused` and `listWorkerRecords`, all existing [S].
  It is correct as a *boolean* trigger and under-counts `dueNow` [I]. **But
  on SQL and Mongo `countJobs` scans the queue's retained history** [S], so
  polling it every 30 s per scaler is a real load on a large queue.
- **Proper version.** Add one optional driver method, e.g.
  `countDemand(q, now) → { waiting, dueNow, stalled, active }` [I]:
  - Redis: `ZCARD wait` + `ZCOUNT delayed -inf now` + `ZCOUNT failed -inf now`
    + `ZCOUNT active -inf now` (active is scored by `lockExpiresAt` [S]). All
    O(log n), one script [I].
  - SQL: four index range counts on the existing `ix_claim`, `ix_due` and
    `ix_lock` prefixes [S for the indexes, I for the plan].
  - Mongo: the same on the existing compound indexes [S indexes, I plan].
  - A fallback for custom drivers: the zero-change formula.
- **Auth:** KEDA sends a bearer, API key, basic or mTLS [V~]. Serve it from a
  `createJobsApi` restricted to `readOnly: true` and `actions:
  ["queues.read"]` [S options], with `authorize` checking the key [I]. On
  ACA the key is a secret referenced by the rule [V].
- **Effort** [I]: the driver method on the three server drivers plus tests
  is ~2 d; the route, OpenAPI schema and Prometheus rendering ~1 d; recipes
  (ACA job, AKS ScaledJob, CREMA, GKE HPA) ~1 d.

### 6.5 Verdict

| | Direct datastore scaler | Depth endpoint (`metrics-api` / Prometheus) | In-process summoner |
|---|---|---|---|
| Correct at zero workers | Redis **no**; SQL **yes** (with a query); Mongo [U] | **Yes** | **Yes**, if the trigger includes due and stalled (§1.2) |
| Works with zero producers | **Yes**: no bun-jobs process needed | **No**: something must serve it | **No** |
| Latency | poll (30 s default) | poll | **immediate on `add()`** |
| Contract stability | Internal layout | Versioned API | Internal |
| Targets | ACA, AKS, GKE+KEDA, CREMA (Redis only verified) | ACA, AKS, GKE+KEDA, **GKE native HPA**, CREMA (Prometheus verified) | Any API: Cloud Run jobs, ACA jobs, ACI, GCE… |
| bun-jobs work | a README recipe | ~4 d [I] | Phase 1.5 plus one adapter each |

**Recommendation [I]:**

1. **Build the endpoint.** It is the one artefact every Kubernetes-shaped
   platform on both clouds can consume.
2. **Keep the in-process summoner** for immediacy and for the launch-a-task
   APIs that have no KEDA: Cloud Run jobs, ACA manual jobs.
3. **Publish the SQL query as a recipe** for deployments where nothing stays
   up to serve the endpoint. Redis users get the endpoint, not a recipe:
   their direct scaler is wrong.

---

## 7. Cost sanity: one worker draining for 5 minutes

List prices read 2026-09-25, before free tiers; arithmetic [I].

| Model | Shape | Price basis | 5-min drain |
|---|---|---|---|
| Cloud Run job, us-central1 | 1 vCPU / 0.5 GiB, 300 s (+ start) | $0.000018/vCPU-s, $0.000002/GiB-s; 1-min minimum [V] | 300 × 0.000018 + 150 × 0.000002 = **≈ $0.0057** |
| Cloud Run worker pool, us-central1 | 1 vCPU / 0.5 GiB, up 300 s then set to 0 | $0.000011244 / $0.000001235 [V] | **≈ $0.0036**; minimum charge [U] |
| Cloud Run delayed job, us-central1 | same, deferred up to 12 h | $0.0000126 / $0.0000014 [V] | **≈ $0.0040** |
| ACA job, eastus | 0.5 vCPU / 1 GiB, 300 s | $0.000024/vCPU-s, $0.000003/GiB-s [V] | 150 × 0.000024 + 300 × 0.000003 = **≈ $0.0045** |
| ACA job, eastus | 1 vCPU / 2 GiB | same | **≈ $0.0090** |
| ACI, eastus | 1 vCPU / 1 GB, 5 min | $0.0405/vCPU-h, $0.00445/GB-h [V]; per-second granularity [U] | **≈ $0.0037** |
| Always-on alternative (for scale) | CREMA or a Cloud Run service at 1 vCPU / 0.5 GiB for 30 days | $0.000018 + $0.000002 × 0.5 per s | **≈ $49/month** list, if sized so [I]; CREMA's size [U] |

Every summoned drain costs **under one cent** on every recommended model.
Free tiers cover thousands of drains a month on both clouds: Cloud Run jobs
240,000 vCPU-s, ACA 180,000 vCPU-s [V]. The cost that matters is the
**always-on piece**: CREMA's instance, a polling checker, an ACA Environment
Management charge if it applies (§4.2). The event-driven ACA job has none of
these [I].

---

## 8. Risks and gotchas

**Google Cloud**

- `jobs.run` has no dedupe [V~]. Two controllers produce two executions.
- SIGTSTP/SIGCONT pauses on jobs longer than an hour [V]. Lease TTL.
- Direct VPC egress: connection delays of a minute or more at startup; Cloud
  NAT 30 s or more [V]. Time-to-first-claim may be dominated by networking.
- The 10-minute VPC idle timeout kills quiet pooled connections [V].
- Jobs bill a **1-minute minimum** [V]: polling by launching the worker costs
  a minute per empty check.
- **Request-based services** suspend CPU between requests [V~]. Never a
  worker.
- Worker pools do not scale down on their own [V]. A crashed controller leaves
  them billing "as active … even if … idle" [V].
- CREMA is always on, KEDA-version-pinned (2.20), verified for only nine
  scalers, one CREMA per target, and leaked memory before 2026-04-29 [V~].
- Cloud Run instances are Preview and unavailable in us-central1, us-east1
  and europe-west1 [V].
- Admin API writes are capped at 180 per 60 s per project and region [V]. A
  burst of per-queue summons across many queues can hit it [I].

**Azure**

- ACA start has no dedupe [V]; an override replaces the whole template [V];
  start permission can read secrets [V].
- `replicaTimeout` has no documented maximum [P/V].
- Maintenance interrupts long replicas [V]. Use `replicaRetryLimit` ≥ 1, and
  rely on bun-jobs' at-least-once.
- KEDA scale-rule auth for Redis, Postgres and HTTP is **secrets only**;
  managed identity covers only Azure-resource scalers [V].
- Scale-rule edits create revisions [V]. Do not drive an ACA app's replica
  count from bun-jobs.
- A worker app with no ingress, min 0 and no rule never starts [V].
- ACI `Never` still restarts on a non-zero exit [V]; groups need deleting [I].
- Functions cannot hold a lease on any plan [P]. Linux Consumption: the table
  says "Retired", the text says retiring 2028-09-30 [V].
- An "Environment Management Hour" meter appears at $0.10/h, effective
  2026-09-01 [V]. When it applies is [U].

**KEDA-specific**

- The Redis scaler cannot see due delayed jobs, retries or stalled jobs (§6.2).
- A ScaledObject on "waiting" SIGTERMs busy workers after the cooldown
  (§6.3).
- A depth endpoint served by a scaled-to-zero app is unreachable. Serve it
  from something that stays up, or fall back to the SQL recipe (§6.5).

---

## 9. Sources (all accessed 2026-09-25)

**Raw page text** (curl or MS Learn markdown) unless marked *summarised*
(the fetch tool's model read the page; wording may be paraphrase).

**KEDA**

- https://keda.sh/docs/latest/scalers/redis-lists/ (v2.21, *summarised*)
- https://raw.githubusercontent.com/kedacore/keda/main/pkg/scalers/redis_scaler.go (*summarised*; Lua type switch)
- https://github.com/kedacore/keda/pull/1006 (search result)
- https://keda.sh/docs/latest/scalers/postgresql/, /mysql/, /mongodb/, /metrics-api/ (*summarised*)
- https://keda.sh/docs/latest/reference/scaledobject-spec/ (*summarised*)
- https://keda.sh/docs/latest/reference/scaledjob-spec/ (raw for the `maxScale` formula)

**Google Cloud** (docs now at `docs.cloud.google.com`)

- https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/run (*summarised*)
- https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs (raw; last updated 2026-02-10)
- https://docs.cloud.google.com/run/docs/configuring/task-timeout (raw; updated 2026-09-22)
- https://docs.cloud.google.com/run/docs/deploy-worker-pools (raw; 2026-09-21)
- https://docs.cloud.google.com/run/docs/configuring/workerpools/manual-scaling (raw; 2026-09-21)
- https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.workerPools/patch (*summarised*)
- https://docs.cloud.google.com/run/docs/configuring/workerpools/crema-autoscaling (*summarised*; 2026-09-21)
- https://github.com/GoogleCloudPlatform/cloud-run-external-metrics-autoscaling and its README (*summarised*)
- https://cloud.google.com/run/pricing (raw, via curl)
- https://docs.cloud.google.com/run/docs/delayed-jobs (*summarised*; 2026-09-21)
- https://docs.cloud.google.com/run/quotas (raw; 2026-09-21)
- https://docs.cloud.google.com/run/docs/container-contract (raw for SIGTERM; *summarised* for the rest; 2026-09-21)
- https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc (raw; 2026-09-22)
- https://docs.cloud.google.com/run/docs/instances/create-and-manage-instances, /run/docs/instances/instance-lifecycle and /run/docs/configuring/instances/restart-policy (raw; 2026-09-21)
- https://developers.google.com/identity/protocols/oauth2/service-account (*summarised*)
- https://docs.cloud.google.com/compute/docs/access/authenticate-workloads (*summarised*)
- https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-clouds (*summarised*; 2026-09-24)
- https://docs.cloud.google.com/compute/docs/instances/spot and /compute/docs/instances/limit-vm-runtime (*summarised*)
- https://docs.cloud.google.com/compute/docs/instance-groups/suspended-and-stopped-vms-in-mig (*summarised*)
- https://docs.cloud.google.com/compute/docs/reference/rest/v1/instanceGroupManagers/resize and …/instances/insert (*summarised*)
- https://cloud.google.com/compute/vm-instance-pricing (raw)
- https://docs.cloud.google.com/batch/docs/get-started (*summarised*; 2026-09-24)
- https://docs.cloud.google.com/batch/docs/reference/rest/v1/projects.locations.jobs/create (raw)
- https://cloud.google.com/kubernetes-engine/pricing, https://cloud.google.com/scheduler/pricing, https://cloud.google.com/workflows/pricing (raw)
- https://docs.cloud.google.com/appengine/docs/standard/how-instances-are-managed (*summarised*)
- https://docs.cloud.google.com/kubernetes-engine/docs/how-to/api-server-authentication (raw; 2026-09-24)
- https://docs.cloud.google.com/kubernetes-engine/docs/tutorials/scale-to-zero-using-keda (search result)
- https://cloud.google.com/blog/products/containers-kubernetes/gke-adds-native-scale-to-zero-capabilities (*summarised*; published 2026-09-24)

**Microsoft**

- https://learn.microsoft.com/en-us/azure/container-apps/jobs (ms.date 2026-09-16)
- https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/jobs/start (api 2026-07-01; updated 2026-09-22)
- https://learn.microsoft.com/en-us/azure/container-apps/scale-app (2026-05-19)
- https://learn.microsoft.com/en-us/azure/container-apps/quotas (2026-09-23)
- https://learn.microsoft.com/en-us/azure/container-apps/billing (2025-12-09)
- https://learn.microsoft.com/en-us/azure/container-apps/managed-identity (2025-06-03)
- https://prices.azure.com/api/retail/prices (Azure Container Apps and Container Instances, eastus, Consumption)
- https://learn.microsoft.com/en-us/azure/azure-functions/functions-scale (2026-09-16)
- https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan (2026-09-15)
- https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/how-to-use-vm-token (2025-11-11)
- https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow (2026-01-30)
- https://learn.microsoft.com/en-us/azure/aks/workload-identity-overview (2026-09-04)
- https://learn.microsoft.com/en-us/azure/aks/keda-about (2025-05-23)
- https://learn.microsoft.com/en-us/azure/virtual-machine-scale-sets/standby-pools-overview (2026-05-19)
- https://learn.microsoft.com/en-us/azure/virtual-machines/spot-vms (2026-02-06)
- https://learn.microsoft.com/en-us/rest/api/compute/virtual-machine-scale-sets/update and …/virtual-machines/start (api 2026-04-01)
- https://learn.microsoft.com/en-us/rest/api/container-instances/container-groups/create-or-update (api 2026-07-01)
- https://learn.microsoft.com/en-us/azure/container-instances/container-instances-restart-policy and …/container-instances-faq (2026-07-25)
- https://learn.microsoft.com/en-us/azure/app-service/webjobs-create (2025-04-17)
- https://learn.microsoft.com/en-us/azure/batch/batch-technical-overview (2026-09-16)

**Kubernetes**

- https://kubernetes.io/docs/concepts/workloads/controllers/job/

## 10. Not done, and worth doing before relying on this

- **Measure time-to-first-claim** on Cloud Run jobs (with and without Direct
  VPC egress) and on ACA jobs. Every cold-start cell here is "unknown".
- **Test the token helper** against real token endpoints.
- **Run the §6.2 SQL query** with `EXPLAIN` on a large table.
- Confirm the Cloud Run `updateMask` path, the SIGTSTP pause duration,
  whether ACA's KEDA reaches a VNet-private datastore, ACI billing
  granularity, and when the ACA Environment Management meter applies.
- Test whether a Job update with `runExecutionToken` dedupes executions.
- Not researched: App Engine flexible, Eventarc, Logic Apps, Azure Batch in
  depth.
