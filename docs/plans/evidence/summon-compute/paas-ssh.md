# Summon-compute on PaaS, SSH and self-managed compute

Evidence for `../../worker-runtimes.md` §3.8.1 and Phase 1.5. Researched
**2026-09-25**. Scope: Railway, Render, Heroku and SSH (required); Fly.io
Machines, Cloudflare Containers, DigitalOcean App Platform, Koyeb, Northflank,
generic Kubernetes (Job + KEDA) and Nomad (briefer). Lambda, Cloud Run, ACA and
KEDA-on-Azure/GCP are covered elsewhere.

## How to read the markings

Every factual cell carries one of these. Treat them as load-bearing: this
round's predecessor was corrected three times for presenting inferences as
findings.

| Mark | Meaning |
|---|---|
| **[V]** | Verified: read today (2026-09-25) from the vendor's own docs, API reference, pricing page or a `man` page. The source is in the section's source list. |
| **[M]** | Measured here today, on this machine (OpenSSH 10.2p1, systemd 259, Bun 1.4.3). |
| **[R]** | Read today from this repository's source (`packages/bun-jobs/lib`). |
| **[U]** | Unverified: not found in a primary source today, or found only in a forum/third party. Do not build on it without checking. |
| **[I]** | Inference: my reasoning from the verified facts, not a fact about the platform. |

Prices are as shown on the vendor page on 2026-09-25 and are in USD.

---

## 1. Bottom line

**Ranked for a first-party summoner** (reasoning in §9):

1. **Fly.io Machines**: Excellent. A plain REST `POST …/machines/{id}/start` with a bearer token; start
   "usually … well under a second" (vendor-stated); the Machine **stops by itself when the process exits**; per-second billing;
   a stopped Machine costs only its root filesystem; no documented run-time cap. The Machine ID doubles as a dedupe key.
2. **Render one-off jobs**: Excellent for launching one task. `POST /v1/services/{id}/jobs {startCommand}` runs a command
   against an existing service's last build, runs for up to 30 days, bills per second, and ends when the command exits.
   Bun is a native runtime. It has no idempotency key, so bun-jobs has to dedupe on its own side.
3. **SSH to the user's own host, via `systemd-run --user --unit=<fixed name>`**: Good. It costs nothing to run, and the
   unit name dedupes the summon for free (measured). It adds a **system** dependency (`ssh` on PATH), and host-key and
   key management falls to the user.
4. **Kubernetes Job with a deterministic name** (or **KEDA ScaledJob**, with bun-jobs as the metrics source): Good,
   for people already on Kubernetes. With KEDA, bun-jobs needs no invoker at all: the
   management API's existing `GET /queues/:queue/counts` is already a usable `metrics-api` source [R][I].
5. **Heroku one-off dynos**: technically Good, strategically Poor. The API is clean (`POST /apps/{app}/dynos`), but
   Heroku entered "sustaining engineering" on 2026-02-06, Fir exists only in Private Spaces, and Heroku has no
   official Bun buildpack.
6. **Railway**: Conditional. The summon would be `deploymentRestart` on a worker service whose last deployment exited
   `0` and is `Completed`. Nothing I found documents that restarting a *Completed* deployment works. The default drain
   before SIGKILL is **0 s**, so it must be raised. Replicas cannot go to 0 through a documented setting.
7. **Nomad** (native `idempotency_token`, the best dedupe story here), **Northflank** (a run-job API with env
   overrides) and **Cloudflare Containers** (needs a user-deployed Worker + Durable Object shim) are all workable.
   Build them as documented recipes on a generic `invoke()`, not as first-party adapters.
8. **DigitalOcean App Platform and Koyeb: Unsuitable.** Neither has a documented way to start a background process
   on demand without a redeploy.

**Recommended SSH shape:** start a transient **`systemd-run --user --unit=bun-jobs-<queue> --collect`** unit with
`RuntimeMaxSec` as a hard cap, on a host with lingering enabled, reached with
`ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<pinned file> -o IdentitiesOnly=yes -i <dedicated key>`.
On the server side, lock the key down with `restrict,command="…"` in `authorized_keys`. Use a template unit
(`systemctl start bun-jobs-worker@<queue>`) when the host owner wants the unit definition under their own control.
Avoid `nohup`/`setsid`: it has no dedupe, no cap and no log capture. Details in §7.

**The one cross-cutting finding that matters most** [R][I]: the worker record that `listWorkerRecords` reads
appears only **after** the summoned process has booted and connected to the driver. `BunQueueWorker.run()` connects,
calls `ensureQueue`, then writes the first report without awaiting it (`BunQueueWorker.ts` ~L1303–1322). So between
`invoke()` and that first report there is a window as long as the platform's cold start plus Bun boot plus driver
connect, and in that window "depth > 0 and no live worker" is still true. **Every summoner needs a
"summon in flight" marker of its own**, with a TTL. The driver's existing versioned queue-state write
(`setQueueState(q, name, value, version)`, already used for worker records) is the natural place for it. Platform
dedupe (a unit name, a Machine ID, a Job name, a Nomad token) is a second line of defence, not a replacement.

---

## 2. What bun-jobs already gives a summoner [R]

| Fact | Where | Consequence for summon |
|---|---|---|
| A worker writes its record right after `driver.connect()` + `ensureQueue()`, not awaited, then every `reportInterval` (default **10 000 ms**) | `lib/queue/BunQueueWorker.ts` `run()`, `DEFAULT_REPORT_INTERVAL` L365 | The summoned process becomes visible about one driver round-trip after it connects [I] |
| A record's `expiresAt = now + reportInterval × 3` (`REPORT_LIFETIMES = 3`) | `BunQueueWorker.ts` L445, L4153 | A worker that dies silently stays "live" for up to ~30 s by default. The summoner will not re-summon during that time, which is correct behaviour but adds latency [I] |
| `listWorkerRecords` returns records with `expiresAt > now` and deletes lapsed ones conditionally on version | `lib/drivers/readApis.ts` L657 | "Is a worker alive?" is answered by the driver and nothing else. **That is sufficient once the worker has started, but not during the boot window** (§1) [I] |
| `WorkerInfo` carries `host`, `pid`, `service`, `key`, `startedAt`, `processStartedAt` | `lib/drivers/driver.ts` ~L1425 | A summoner can tell which host a live worker is on, which is enough for SSH round-robin by capacity (§7.6) [I] |
| `BunQueueWorker` installs **no** `SIGTERM`/`SIGINT` handler | grep of `lib/` | The worker file in the recipe must handle signals itself, and on Fly it must handle **SIGINT** (Fly's default kill signal, §5.1) [I] |
| `GET {basePath}/queues/:queue/counts` returns `Record<JobState, number>` (`waiting`, `delayed`, `active`, …) | `lib/api/routes/queues.ts` L609–624 | This is already a KEDA `metrics-api` source with `valueLocation: waiting` (§6.2) [I] |

---

## 3. Summary matrix

"Lease-capable" means the platform can run a long-lived Bun process that keeps heartbeating without being frozen
between requests.

| Target | Lease-capable | Max run | Time to first claim | Billing (idle) | Summon style | Dedupe primitive | Fit |
|---|---|---|---|---|---|---|---|
| **Fly Machines** | Yes [V] | None documented [U] | Start "well under a second"; create "low double digit seconds" (vendor) [V] | Per second; stopped = rootfs $0.15/GB/30 d [V] | Wake a stopped Machine (or create with `auto_destroy`) | Machine ID + Machines lease [V] | **Excellent** |
| **Render one-off job** | Yes [V] | 30 days [V] | Unknown [U] | Per second at plan rate; nothing between jobs [V] | Launch a task | None; own marker | **Excellent** |
| **SSH + systemd** | Yes (own host) | Your choice (`RuntimeMaxSec`) | ssh handshake + Bun boot; not measured here (no sshd) [U] | Zero marginal | Launch a task on a host | Fixed unit name [M] / `flock` [M] | **Good** |
| **Kubernetes Job / KEDA** | Yes [V] | `activeDeadlineSeconds` (yours) [V] | Pod scheduling + image pull [U] | The cluster's | Launch a task / platform-driven | Deterministic `metadata.name` [V]/[U] | **Good** |
| **Heroku one-off dyno** | Yes [V] | ~24 h + up to 216 min (daily cycling) [V] | Unknown [U] | Per second [V] | Launch a task | None; own marker | Good (tech), **Poor** (strategy) |
| **Railway** | Yes, unless Serverless sleep is on [V] | None documented [U] | Unknown [U] | Usage per minute [V] | Restart a completed deployment [U] | None | **Conditional** |
| **Nomad dispatch** | Yes | Yours | Scheduler + driver [U] | The cluster's | Launch a task | `idempotency_token` [V] | Good (niche) |
| **Northflank job run** | Yes [U] | `activeDeadlineSeconds` [V] | Unknown [U] | Unchecked | Launch a task | None (manual runs ignore concurrency policy) [V] | Good (niche) |
| **Cloudflare Containers** | Conditional [V] | Undocumented [U] | 1–3 s (vendor) [V] | Per 10 ms while running; stops billing on sleep [V] | Wake via Worker/DO shim | DO identity [I] | Good (indirect) |
| **DO App Platform** | Yes, but no on-demand start [V] | n/a | Redeploy [V] | Min 1 instance for workers [V] | None usable | n/a | **Unsuitable** |
| **Koyeb** | Yes, but no on-demand start for workers [V] | n/a | Resume = redeploy [V] | n/a | None usable | n/a | **Unsuitable** |

---

## 4. Required targets

### 4.1 Railway

**Model.** A service has deployments. A long-running service stays up. A **cron service** runs its start command
on a schedule. **Serverless** ("app sleeping") puts a service to sleep after it stops sending outbound traffic. The
public API is GraphQL.

| # | Question | Answer |
|---|---|---|
| 1 | Lease-capable? | **Yes** for an ordinary service [V]. **Serverless sleep does not fight a live worker**: "Railway automatically detects inactivity based on outbound traffic", and "private network" traffic "will prevent the service from being put to sleep" [V]. A worker heartbeating its driver keeps sending outbound traffic, so it will not sleep while it runs [I]. |
| 2 | Max run duration | None documented [U]. Cron: none stated, but "if a previous execution is still running when the next scheduled execution is due, Railway will skip the new cron job" [V]. On redeploy/stop: SIGTERM, then SIGKILL after `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, and **"By default, it is given 0 seconds to gracefully shutdown before being forcefully stopped with a SIGKILL"** [V]. |
| 3 | Cold start | Unknown for restart [U]. Sleep: "It may take a small amount of time for the service to spin up again … the first request sent to a slept service may return a 502 Bad Gateway" [V]. |
| 4 | Billing | Usage-based: RAM "$10 / GB / month ($0.000231 / GB / minute)", CPU "$20 / vCPU / month ($0.000463 / vCPU / minute)" [V]. Subscriptions: Hobby $5/mo and Pro $20/mo, each including that much usage [V]. Slept services "still consume a slot" [V]. Whether a `Completed` deployment accrues anything: unknown [U], probably not since nothing runs [I]. |
| 5 | Start API | `POST https://backboard.railway.com/graphql/v2` [V]. Tokens: account/workspace token as `Authorization: Bearer`, project token as `Project-Access-Token` [V]. Mutations [V]: `deploymentRestart(id)`, `deploymentRedeploy(id)`, `serviceInstanceRedeploy(serviceId, environmentId)`, `serviceInstanceDeployV2(serviceId, environmentId, commitSha?)`, `serviceInstanceUpdate(serviceId, environmentId, input:{ numReplicas, startCommand, cronSchedule, sleepApplication, restartPolicyType, … })`, `deploymentStop(id)`. "Restarting a crashed Deployment restores the exact image containing the code & configuration of the original build" [V]. **Whether `deploymentRestart` works on a `Completed` (exit 0) deployment is not documented [U].** Parameters reach the process only through service variables; there is no per-run override [I]. |
| 6 | Dedupe | None native. A restart of a deployment that is already running is not documented [U]. Use your own marker [I]. |
| 7 | Stop / exit | Exit 0 gives status `Completed` [V]. With the default restart policy ("On Failure … exits with a non-zero code", default, max 10 restarts) it stays stopped [V]. `Always` would restart it forever, so do not use it [I]. |
| 8 | Style | *Restart a completed service*, a variant of wake. Scale-a-service is not an option: `numReplicas: 0` is not documented [U], and a community thread asks for exactly that as a feature [U]. |
| 9 | Network | Private network over WireGuard, `SERVICE.railway.internal`, "Each environment has its own isolated network" [V]. Static outbound IPs: "customers on the Pro plan", and "may be shared with other customers" [V]. |
| 10 | Bun | Railpack detects Bun from `bun.lock`/`bun.lockb` [V], but the page describes it as the package manager and does not say it is the runtime [V]; a Dockerfile (`FROM oven/bun`) removes the question [I]. |
| 11 | Rate limits | 100 / 1,000 / 10,000 requests per hour (Free / Hobby / Pro); 10 RPS Hobby, 50 RPS Pro [V]. |
| 12 | **Fit** | **Conditional.** Viable only if restarting a Completed deployment is confirmed. The 0 s default drain is a trap for a lease holder. |

**Adapter sketch** (`fetch`, GraphQL):

```ts
const RW = "https://backboard.railway.com/graphql/v2";
async function gql<T>(token: string, query: string, variables: object): Promise<T> {
  const r = await fetch(RW, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }) });
  const j = await r.json() as { data?: T; errors?: { message: string }[] };
  if (!r.ok || j.errors?.length) throw new Error(j.errors?.[0]?.message ?? `railway ${r.status}`);
  return j.data!;
}
export const railwaySummoner = (o: { token: string; projectId: string; serviceId: string; environmentId: string }) => ({
  async summon() {
    const d = await gql<{ deployments: { edges: { node: { id: string; status: string } }[] } }>(o.token,
      `query($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { id status } } } }`,
      { input: { projectId: o.projectId, serviceId: o.serviceId, environmentId: o.environmentId } });
    const last = d.deployments.edges[0]?.node;
    if (!last) throw new Error("no deployment to restart");
    if (last.status === "SUCCESS") return { id: last.id, already: true }; // running; status names [U]
    await gql(o.token, `mutation($id: String!) { deploymentRestart(id: $id) }`, { id: last.id });
    return { id: last.id, already: false };
  },
});
```

**Gotchas.**
- **The 0 s default drain.** Set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` to at least the job timeout plus a buffer. Otherwise a redeploy kills the worker with jobs in flight, which then wait out their lease.
- The documented "latest deployment" query filters with `status: { successfulOnly: true }` [V]. Whether a `Completed` deployment counts as successful is unknown [U]. The sketch leaves the filter off for that reason.
- **Serverless wake as a summon** [I]: a sleeping service is "woken when it receives traffic … from another service in the same project through the private network" [V]. In principle a producer on Railway could wake a worker with an HTTP ping. But the worker falls asleep only after 5–10 minutes with no outbound traffic, so it would have to close its driver connection while idle. That is a new worker mode, not a summoner. Not recommended.
- Cron services cannot serve as the summon: the minimum interval is 5 minutes, and no API trigger is documented [V].

Sources: <https://docs.railway.com/reference/app-sleeping>, <https://docs.railway.com/reference/cron-jobs>,
<https://docs.railway.com/reference/public-api>, <https://docs.railway.com/guides/manage-deployments>,
<https://docs.railway.com/guides/manage-services>, <https://docs.railway.com/deployments/deployment-actions>,
<https://docs.railway.com/deployments/reference>, <https://docs.railway.com/deployments/deployment-teardown>,
<https://docs.railway.com/deployments/restart-policy>, <https://docs.railway.com/reference/pricing/plans>,
<https://docs.railway.com/reference/private-networking>, <https://docs.railway.com/networking/static-outbound-ips.md>,
<https://docs.railway.com/reference/scaling>, <https://railpack.com/languages/node>. All accessed 2026-09-25.
Forum only [U]: <https://station.railway.com/feedback/railway-should-allow-0-replicas-scale-d-66ba8c7c>.

### 4.2 Render

**Model.** Background workers are "services that run continuously … but they don't receive any incoming network
traffic" [V]. **One-off jobs** run a command against an existing service's build.

| # | Question | Answer |
|---|---|---|
| 1 | Lease-capable? | **Yes.** A one-off job is an ordinary process that runs until its command exits, for up to 30 days [V]. |
| 2 | Max run duration | One-off job: **30 days**, then "Render automatically terminates it" [V]. Services on redeploy: SIGTERM, then SIGKILL after the "shutdown delay (default 30 seconds)", configurable "up to a maximum of 300 seconds" via `maxShutdownDelaySeconds` [V]. **Whether cancelling a job sends SIGTERM with that delay is not documented [U].** |
| 3 | Cold start | Unknown [U]. The job reuses the base service's last successful build artifact, so there is no build step [V]. |
| 4 | Billing | Jobs bill at the "per-second rate for its specified compute plan" [V]. Compute is "prorated to the second" [V]. Plans on the pricing page: Starter $7/mo (0.5 CPU, 512 MB), Standard $25/mo (1 CPU, 2 GB), Pro $85/mo (2 CPU, 4 GB) [V]. Nothing is billed between jobs [I]. Workspace plan fees were not checked [U]. |
| 5 | Start API | `POST https://api.render.com/v1/services/{serviceId}/jobs`, `Authorization: Bearer <API key>`, body `{ "startCommand": "bun worker.ts", "planId"?: "…" }`, response `201 { id, status: pending\|running\|succeeded\|failed\|canceled, createdAt, startedAt?, finishedAt? }` [V]. Works against "web services, private services, background workers, and cron jobs" [V]. **Env: the base service's variables as of job creation** [V]; the job has no env override, so a queue name goes in `startCommand` arguments [I]. |
| 6 | Dedupe | None native. A List jobs endpoint exists [V]; its filter parameters were not checked [U]. Use your own marker, optionally reconciled with a list of `pending`/`running` jobs [I]. |
| 7 | Stop / exit | "Automatic when the `startCommand` exits", or by the Cancel running job endpoint [V]. |
| 8 | Style | **Launch a task.** A background worker can also be scaled with `POST /services/{id}/scale {numInstances}` (202) [V], but whether `numInstances: 0` is accepted is not documented [U], and "Render ignores this value as long as autoscaling is enabled" [V]. Autoscaling is CPU/memory-based, for Pro workspaces and up, and the page names web and private services only [V]. Suspend/resume endpoints exist [V]. |
| 9 | Network | "Workflows, background workers, and cron jobs can *send* private network requests"; private-network scope is same region and same workspace [V]. That a one-off job gets the base service's private network is not stated, but likely [I]. **A one-off job "cannot access its base service's persistent disk"** [V]. |
| 10 | Bun | **Native runtime**, set by `BUN_VERSION`, `.bun-version` or a `bun.lock` [V]. |
| 11 | Rate limits | **`POST /v1/jobs`: 100/minute**. Deploy, resume and suspend: 10/minute/service. Other POSTs: 30/minute [V]. |
| 12 | **Fit** | **Excellent.** Launch-a-task, per-second billing, ends on exit, native Bun, and any existing service (even the web app) can be the base. |

**Adapter sketch:**

```ts
export const renderSummoner = (o: { apiKey: string; serviceId: string; command: string; planId?: string }) => ({
  async summon(ctx: { queue: string }) {
    const r = await fetch(`https://api.render.com/v1/services/${o.serviceId}/jobs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        startCommand: `${o.command} --queue ${JSON.stringify(ctx.queue)}`, // env cannot be overridden per job
        ...(o.planId ? { planId: o.planId } : {}),
      }),
    });
    if (r.status === 429) throw new Error(`render rate-limited; reset ${r.headers.get("Ratelimit-Reset")}`);
    if (!r.ok) throw new Error(`render ${r.status}: ${await r.text()}`);
    const job = await r.json() as { id: string; status: string };
    return { id: job.id, already: false };
  },
});
```

**Gotchas.** The job runs the base service's **most recent successful build**, so a failed deploy means summoned
workers run the previous code [V][I]. The job gets env vars as they were when it was created, so a rotated secret
does not reach a job that is already running [V][I]. The shutdown delay is a service setting, and it is undocumented
whether it governs job cancellation [U].

Sources: <https://render.com/docs/jobs>, <https://api-docs.render.com/reference/post-job>,
<https://api-docs.render.com/reference/rate-limiting>, <https://api-docs.render.com/reference/scale-service>,
<https://render.com/docs/scaling>, <https://render.com/docs/deploys>, <https://render.com/docs/background-workers>,
<https://render.com/docs/private-network>, <https://render.com/docs/compute-plans>, <https://render.com/pricing>
(read from the page HTML), and the Bun native-runtime pages found via search (<https://render.com/docs/native-runtimes>,
<https://render.com/docs/bun-version>). All accessed 2026-09-25.

### 4.3 Heroku

**Model.** Dynos run process types from a Procfile. The **formation** sets how many of each run. **One-off dynos**
run an arbitrary command and are what Heroku Scheduler uses [V].

| # | Question | Answer |
|---|---|---|
| 1 | Lease-capable? | **Yes.** "Detached dynos have no connection, so they have no timeout" [V]. Eco dynos sleep [V]. **Do not use Eco for a summoned worker** [I]. |
| 2 | Max run duration | "Most one-off dynos are cycled every 24 hours" [V]. Cycling is every "24 hours plus up to 216 random minutes" [V]. Fir apps can bypass it with the Labs flag `fir-bypass-daily-dyno-restarts` [V]. Shutdown: "The application processes have 30 seconds to shut down cleanly … the dyno manager terminates them forcefully with `SIGKILL`" [V]. `time_to_live` on dyno create is a hard cap you choose [V]. |
| 3 | Cold start | Not documented [U]. |
| 4 | Billing | "Heroku prorates all costs to the second", measured on wall-clock time [V]. Basic $7/mo, Standard-1X $25/mo, Standard-2X $50/mo; Fir `dyno-1c-0.5gb` $25/mo (Private Spaces only) [V]. One-off time "accrues usage" [V]. No minimum is stated [V]. |
| 5 | Start API | `POST https://api.heroku.com/apps/{app}/dynos`, body `{ command, env?, size?, time_to_live?, attach? }`, headers `Accept: application/vnd.heroku+json; version=3` and `Authorization: Bearer <token>` [V]. **`env` is a per-dyno override**, the cleanest parameter channel of the PaaS targets here [V]. Scale instead: `PATCH /apps/{app}/formation/{type} {quantity}` or batch `PATCH /apps/{app}/formation {updates:[{type,quantity,size}]}` [V]. Tokens: `heroku authorizations:create` for a non-expiring token; `heroku auth:token` is "only valid for a maximum of 1 year by default" [V]. |
| 6 | Dedupe | One-off: none native; use your own marker [I]. Formation: `quantity` is a **level**, so setting 1 twice gives one dyno. It is naturally idempotent [I]. |
| 7 | Stop / exit | "One-off dynos never automatically restart, whether the process ends on its own or whether you manually disconnect" [V]. A formation dyno whose command exits **is restarted** ("The dyno command exits" is listed as an auto-restart trigger) [V]. So scale-a-service needs an explicit scale-down, and one-off does not [I]. |
| 8 | Style | **Launch a task** (one-off) is the right one. |
| 9 | Network | Not checked today [U]. From memory, Common Runtime egress IPs are dynamic and static IPs need Private Spaces or an add-on [U]. |
| 10 | Bun | **No official Bun buildpack**; community buildpacks exist (e.g. `jakeg/heroku-buildpack-bun`) [U, from search, not a Heroku page]. |
| 11 | Limits | Platform API "4500 calls per hour", a token bucket refilling ~75/min [V]. Concurrent one-off dynos per app: 50 Basic, 50 Standard, 5 Performance, 5 Private, 5 Shield, 255 Fir [V]. Eco/Basic: "a maximum of one running dyno *per process type*" [V]. |
| 12 | **Fit** | **Good technically, Poor strategically.** On 2026-02-06 Heroku announced it is "transitioning to a sustaining engineering model … rather than introducing new features" and "Enterprise Account contracts will no longer be offered to new customers" [V]. Fir dynos are "dedicated compute in Private Spaces only" [V], so a new non-enterprise user is on Cedar [I]. |

**Adapter sketch:**

```ts
export const herokuSummoner = (o: { token: string; app: string; command: string; size?: string; ttlSeconds?: number }) => ({
  async summon(ctx: { queue: string }) {
    const r = await fetch(`https://api.heroku.com/apps/${encodeURIComponent(o.app)}/dynos`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.heroku+json; version=3",
        Authorization: `Bearer ${o.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: o.command,
        env: { BUN_JOBS_QUEUE: ctx.queue },         // per-dyno env override
        size: o.size ?? "standard-1x",
        time_to_live: o.ttlSeconds ?? 6 * 3600,     // hard cap, independent of idleTimeout
      }),
    });
    if (!r.ok) throw new Error(`heroku ${r.status}: ${await r.text()}`);
    const dyno = await r.json() as { id: string; name: string };
    return { id: dyno.id, already: false };
  },
});
```

Sources: <https://devcenter.heroku.com/articles/platform-api-reference>, <https://devcenter.heroku.com/articles/one-off-dynos>,
<https://devcenter.heroku.com/articles/dyno-shutdown-behavior>, <https://devcenter.heroku.com/articles/dyno-restarts>,
<https://devcenter.heroku.com/articles/dyno-types>, <https://devcenter.heroku.com/articles/usage-and-billing>,
<https://devcenter.heroku.com/articles/limits>, <https://devcenter.heroku.com/articles/platform-api-quickstart>,
<https://www.heroku.com/blog/an-update-on-heroku/> (dated 2026-02-06), <https://www.heroku.com/blog/march-2026-update/>
(2026-03-19; nothing on dyno retirements). All accessed 2026-09-25. None of these pages announced a dyno-type
retirement [V: absence on the pages read, not proof there is none].

### 4.4 SSH to a machine the user already has

The full design is in §7. The per-target template:

| # | Question | Answer |
|---|---|---|
| 1 | Lease-capable? | **Yes**, provided the host does not suspend. That holds for a server, not a laptop [I]. |
| 2 | Max run | Yours: `RuntimeMaxSec=` on the unit [I] (a systemd property passed with `-p`) [V: `-p` sets "a property on the scope or service unit"]. |
| 3 | Cold start | One SSH handshake (skipped with a `ControlMaster` socket) plus Bun boot plus driver connect. Not measured: there is no sshd on this machine [U]. |
| 4 | Billing | Zero marginal [I]. |
| 5 | Start API | `Bun.spawn(["ssh", …opts, host, "systemd-run", "--user", "--unit=bun-jobs-<q>", "--collect", …, "bun", "worker.ts"])`. Params go in as `-E NAME=VALUE` [V] or arguments. |
| 6 | Dedupe | **A fixed unit name.** The second `systemd-run --unit=X` while X is active fails: `Failed to start transient service unit: Unit X.service was already loaded or has a fragment file.`, exit 1 [M]. `systemctl start` on an active unit returns 0 and does not restart it (`NRestarts=0`, same `InvocationID`) [M]. `flock -n` on a held lock exits 1, or a chosen code with `-E` [M]. |
| 7 | Stop / exit | The unit ends when the process exits. `--collect` unloads it even on failure [V]. |
| 8 | Style | Launch a task on a host. |
| 9 | Network | Whatever the host has. Usually the best case, since the host is often next to the database [I]. |
| 10 | Bun | Whatever is installed on the host. The unit needs an absolute path, or `PATH` set, because a user manager does not source the login shell [I]. |
| 11 | Limits | sshd `MaxStartups`/`MaxSessions` [U, sshd man page not on this machine]. |
| 12 | **Fit** | **Good.** Free, fast, and dedupe is built in. The cost is a system `ssh` dependency and key and host-key management. |

---

## 5. Also-covered targets

### 5.1 Fly.io Machines (the best fit)

| # | Question | Answer |
|---|---|---|
| 1 | Lease-capable? | **Yes.** A Machine is a VM running your process. Auto-stop is driven by the Fly Proxy, and "Requests to apps without services configured … don't get routed through Fly Proxy and so Machines can't be automatically stopped or started by Fly Proxy" [V]. So **a worker Machine with no `services` is never auto-stopped under it** [I]. |
| 2 | Max run | None documented [U]. On stop: sends `kill_signal`, **default `SIGINT`**; `kill_timeout` **default 5 s, maximum 300 s** [V]. |
| 3 | Cold start | Start: "Usually this takes *well under a second*". Create: "maybe low double digit seconds" (vendor-stated) [V]. Starting from `suspended` "is faster than … from a `stopped` state" [V]. |
| 4 | Billing | Per second while running. Stopped: root filesystem only, "$0.15 per GB per 30 days". shared-cpu-1x: 256 MB $0.00000078/s (~$2.01/mo), 512 MB $0.00000128/s, 1 GB $0.00000228/s, in the 1.0× regions; others run up to 3.0× [V]. |
| 5 | Start API | Base `https://api.machines.dev`, `Authorization: Bearer <token>` (e.g. `fly tokens deploy`) [V]. **Wake:** `POST /v1/apps/{app}/machines/{id}/start` [V]. **Create:** `POST /v1/apps/{app}/machines` with `config.image`, `config.env`, `config.init.cmd`, `config.auto_destroy`, `config.restart.policy`, `region`, `skip_launch` [V]. **Wait:** `GET …/{id}/wait?state=started` [V]. **Stop:** `POST …/{id}/stop` (with `signal`, `timeout`) [V]. Env goes in at create time. Per-start env overrides were not checked [U]. |
| 6 | Dedupe | **A pool of pre-created Machines. Their IDs are the dedupe key**: starting "machine #1" twice cannot give two workers [I]. Leases (`POST …/lease`, `fly-machine-lease-nonce`) give the summoner a mutex over a Machine [V]. What `start` returns on an already-started Machine: not checked [U]. |
| 7 | Stop / exit | "Stop automatically when a program exits" [V]. Default restart policy `on-failure` retries only on "non-zero exit code", so **exit 0 leaves it stopped** [V]. `auto_destroy`: "the Machine destroys itself once it's complete" [V]. |
| 8 | Style | **Wake a stopped Machine** (preferred), or create an `auto_destroy` Machine per summon. |
| 9 | Network | Private 6PN to Fly-hosted databases [U: not re-read today]. Static egress for allow-lists: app-scoped IPs at "$3.60/mo, billed hourly", "up to 64 Machines" per IP [V]. |
| 10 | Bun | `fly launch` supports Bun (flyctl ≥ 0.1.54); Dockerfile-based [V, from Fly blog/community via search]. |
| 11 | Rate limits | "1 request, per second, per action" per machine, burst 3; Get Machine 5/s, burst 10 [V]. For a pool of N machines that means N starts/s [I]. |
| 12 | **Fit** | **Excellent.** The closest match to the summon model: sub-second wake, stops on exit, pay only while running. |

**Adapter sketch:**

```ts
const FLY = "https://api.machines.dev/v1";
export const flySummoner = (o: { token: string; app: string; pool: string[] }) => {
  const headers = { Authorization: `Bearer ${o.token}`, "Content-Type": "application/json" };
  return {
    async summon() {
      for (const id of o.pool) {
        const m = await (await fetch(`${FLY}/apps/${o.app}/machines/${id}`, { headers })).json() as { state: string };
        if (m.state === "started") return { id, already: true };
        if (m.state !== "stopped" && m.state !== "suspended") continue; // starting/destroyed/…
        const r = await fetch(`${FLY}/apps/${o.app}/machines/${id}/start`, { method: "POST", headers });
        if (r.ok) return { id, already: false };
        if (r.status !== 429) throw new Error(`fly start ${id}: ${r.status} ${await r.text()}`);
      }
      throw new Error("no startable machine in the pool");
    },
  };
};
```

**Gotchas.**
- **SIGINT, not SIGTERM, and 5 s.** Set `kill_signal = "SIGTERM"` and `kill_timeout = 300`, or make the worker file handle SIGINT. A worker with a 5-minute job gets killed mid-job otherwise [V][I].
- Pool size caps concurrency by design. That is good for a summoner, but the pool has to be created ahead of time (`skip_launch`) [I].
- A stopped Machine's rootfs is billed. The pool's standing cost is (pool size × image size × $0.15/GB/30 d) [V][I].
- Host failures: a Machine is tied to a host [U, not re-read today].

Sources: <https://docs.fly.io/machines/api/machines-resource/>, <https://docs.fly.io/machines/api/working-with-machines-api/>,
<https://docs.fly.io/about/pricing/>, <https://docs.fly.io/launch/autostop-autostart/>, <https://docs.fly.io/machines/overview/>,
<https://docs.fly.io/machines/guides-examples/machine-restart-policy/>, <https://docs.fly.io/reference/configuration/>,
<https://docs.fly.io/networking/egress-ips/>. All accessed 2026-09-25.

### 5.2 Cloudflare Containers

The facts in the prior plan still hold as of today (pages last updated 2026-08-28): **cold start "1-3 second range"**;
**SIGTERM, "Waits up to 15 minutes", then SIGKILL**; **`sleepAfter` "10 minutes by default"**; "All disk is ephemeral";
"end-users cannot make non-HTTP TCP or UDP requests to a Container instance" [V]. Maximum lifetime is still
undocumented [U].

| # | Question | Answer |
|---|---|---|
| 1 | Lease-capable? | **Conditional.** Activity is "Incoming requests"; background work must call `renewActivityTimeout()` or the container stops after `sleepAfter` [V]. A worker that only makes outbound driver calls generates no activity, so the Durable Object must renew on its behalf (e.g. from an alarm), or `sleepAfter` must exceed the drain time [I]. |
| 2 | Max run | Undocumented [U]. 15-minute SIGTERM grace [V]. |
| 3 | Cold start | 1–3 s, vendor-stated [V]. |
| 4 | Billing | "billed for every 10ms that they are actively running"; "CPU usage is based on *active usage* only"; memory $0.0000025/GiB-s, CPU $0.000020/vCPU-s, disk $0.00000007/GB-s beyond the included 25 GiB-h, 375 vCPU-min and 200 GB-h per month; "Charges stop after the container instance goes to sleep"; Workers and DO usage billed on top [V]. |
| 5 | Start API | **No public "start a container" REST call.** From inside a Worker/DO: `start()` for no-port batch work, with `startOptions: { envVars, entrypoint }` [V]. **The summoner `fetch`es a user-deployed Worker route**, which calls `getContainer(env.W, queue).start({ envVars })` [I]. |
| 6 | Dedupe | Durable Object identity: one DO per name, so one container per queue name [I]. |
| 7 | Stop / exit | `onStop(exitCode, reason)` fires when the container stops [V]; when the process exits, the container stops [I]. |
| 8 | Style | Wake via shim. |
| 9 | Network | Egress yes, no inbound non-HTTP [V]; Hyperdrive/Postgres from a container were not checked [U]. |
| 10 | Bun | Any linux/amd64 image [V from prior plan, still consistent]. |
| 11 | Limits | Account: 6 TiB memory, 1,500 vCPU, 30 TB disk concurrent; instance types lite (1/16 vCPU, 256 MiB) to standard-4 (4 vCPU, 12 GiB) [V]. |
| 12 | **Fit** | **Good, but indirect.** The summoner is a `fetch` to the user's own Worker, so it looks exactly like a generic HTTP `invoke()` [I]. |

Sources: <https://developers.cloudflare.com/containers/platform-details/>, <https://developers.cloudflare.com/containers/pricing/>,
<https://developers.cloudflare.com/containers/platform-details/limits/>, <https://developers.cloudflare.com/containers/container-class/>.
Accessed 2026-09-25.

### 5.3 DigitalOcean App Platform: Unsuitable

- No documented way to trigger a job by API or by hand. The API lists and cancels job invocations only; a public
  feature request asks for manual triggering [V]. Scheduled jobs run at a "Minimum of every 15 minutes" [V].
- Workers cannot autoscale ("Workers and other non-service components are not eligible"). `min_instance_count`: "Use
  a value of 1 or higher". Scale-to-Zero is for "web service components" only. Changing instance count redeploys
  the app [V].

**Fit: Unsuitable.** Summoning would mean a spec update and a redeploy. Sources:
<https://docs.digitalocean.com/products/app-platform/how-to/manage-jobs/index.html.md>,
<https://docs.digitalocean.com/products/app-platform/how-to/scale-app/index.html.md>. Accessed 2026-09-25.

### 5.4 Koyeb: Unsuitable

"Scale-to-Zero works only for Services exposed to the Internet", woken by a request (not HTTP/2) [V]. Worker is a
separate service type [V]. Resuming a paused service redeploys it: "The Service is being redeployed using the latest
Deployment configuration" [V]. **Fit: Unsuitable** for background workers. Sources:
<https://www.koyeb.com/docs/run-and-scale/scale-to-zero>, <https://www.koyeb.com/docs/reference/services>. Accessed 2026-09-25.

### 5.5 Northflank: Good (niche)

`POST /v1/projects/{projectId}/jobs/{jobId}/runs`, `Authorization: Bearer <token>`, with optional
`runtimeEnvironment` (per-run env override), `billing.deploymentPlan` and `deployment` overrides [V]. A job has a time
limit (`activeDeadlineSeconds`) [V]. **"The concurrency policy does not apply when initiating a job run manually"** [V],
so a summoner gets no platform dedupe and needs its own marker. Billing granularity was not checked [U]. Sources:
<https://northflank.com/docs/v1/api/project/jobs/run-job>,
<https://northflank.com/docs/v1/application/run/run-an-image-once-or-on-a-schedule>. Accessed 2026-09-25.

```ts
await fetch(`https://api.northflank.com/v1/projects/${project}/jobs/${job}/runs`, {   // host [U]
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ runtimeEnvironment: { BUN_JOBS_QUEUE: queue } }),
});
```

---

## 6. Self-managed orchestrators

### 6.1 Kubernetes: create a `Job` with a bearer token

- `POST /apis/batch/v1/namespaces/{namespace}/jobs` [V]. `restartPolicy` must be `Never` or `OnFailure`;
  `backoffLimit` defaults to 4; `activeDeadlineSeconds` is the run cap ("the duration in seconds relative to the
  startTime that the job may be continuously active before the system tries to terminate it"); `ttlSecondsAfterFinished`
  cleans up afterwards [V]. Pod termination is SIGTERM, then SIGKILL after the grace period, default 30 s [V].
- **Dedupe:** "All objects you can create via the API have a unique object name to allow idempotent creation" [V].
  A deterministic name such as `bun-jobs-<queue>-<epoch-bucket>` makes a second create fail with a conflict (409
  AlreadyExists is standard but was not read today [U]).
- Auth: a ServiceAccount token as `Authorization: Bearer`. The CA bundle has to be trusted: Bun's `fetch` accepts
  `tls: { ca }` [U: not re-read today].
- **Fit: Good** for Kubernetes users. The cost is RBAC for `create` on `jobs` in one namespace [I].

```ts
const body = { apiVersion: "batch/v1", kind: "Job",
  metadata: { name: `bun-jobs-${queue}-${Math.floor(Date.now() / 60_000)}` },   // one per queue per minute
  spec: { backoffLimit: 0, activeDeadlineSeconds: 3600, ttlSecondsAfterFinished: 300,
    template: { spec: { restartPolicy: "Never", terminationGracePeriodSeconds: 120,
      containers: [{ name: "worker", image, command: ["bun", "worker.ts"], env: [{ name: "BUN_JOBS_QUEUE", value: queue }] }] } } } };
const r = await fetch(`${apiServer}/apis/batch/v1/namespaces/${ns}/jobs`, {
  method: "POST", headers: { Authorization: `Bearer ${saToken}`, "Content-Type": "application/json" },
  body: JSON.stringify(body), tls: { ca },
});
if (r.status === 409) return { already: true };      // [U] status code
```

### 6.2 KEDA ScaledJob: the platform summons, and bun-jobs only reports depth

KEDA's `metrics-api` scaler (docs v2.21) polls a URL and reads a number at `valueLocation` (GJSON for JSON), against
`targetValue`/`activationTargetValue`, with `authMode` of `bearer`, `apiKey`, `basic` or `tls` [V]. `ScaledJob` polls
every 30 s by default, caps at `maxReplicaCount` (default 100), and its default strategy creates
`maxScale - runningJobCount` jobs. `accurate` is "Recommended when queue metrics exclude locked messages" [V].

**bun-jobs needs no new endpoint** [R][I]. The management API already serves
`GET {basePath}/queues/:queue/counts` → `{ waiting, delayed, active, … }`, and `waiting` excludes locked (active)
jobs, which is exactly the case `accurate` targets. A trigger would read:

```yaml
triggers:
  - type: metrics-api
    metadata:
      url: "http://app.default.svc:3000/admin/jobs-api/queues/emails/counts"
      valueLocation: "waiting"
      targetValue: "500"          # one drain pod per 500 waiting jobs [I: tune]
      activationTargetValue: "0"
    authenticationRef: { name: bun-jobs-api-bearer }   # authMode: bearer
```

With this path, summon-compute becomes a documentation page for Kubernetes users and not code: a platform-driven
summoner [I]. One caution [I]: KEDA counts running *Jobs*, not bun-jobs workers, so a worker started elsewhere does
not reduce KEDA's count. It will still summon while a non-KEDA worker is live, unless the metric subtracts live
workers. Offering a `?minus=liveWorkers` style metric is a small, optional addition to consider.

### 6.3 Nomad parameterized dispatch

`PUT`/`POST /v1/job/:job_id/dispatch`. `Payload` is base64 and "limited to 16384 bytes", with `Meta` alongside.
**`idempotency_token` "used to prevent more than one instance of the job from being dispatched. This is specified as
a URL query parameter"** [V]. The ACL needed is `namespace:dispatch-job` [V]. This is the only target here with a
native idempotency key. Pass `?idempotency_token=<queue>:<summon-epoch>` [I]. **Fit: Good (niche).** Source:
<https://developer.hashicorp.com/nomad/api-docs/jobs>, accessed 2026-09-25.

Sources for §6.1–6.2: <https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/job-v1/>,
<https://kubernetes.io/docs/concepts/workloads/controllers/job/>, <https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/>,
<https://kubernetes.io/docs/reference/using-api/api-concepts/>, <https://keda.sh/docs/latest/scalers/metrics-api/>,
<https://keda.sh/docs/latest/reference/scaledjob-spec/>. Accessed 2026-09-25.

---

## 7. SSH in depth

### 7.1 The dependency trade-off, honestly

| For `Bun.spawn(["ssh", …])` | Against |
|---|---|
| No npm dependency, so it satisfies the dependency policy | A **system** dependency: `ssh` must be on `PATH` where the summoner runs. A container image built `FROM oven/bun` may not include it [U] |
| OpenSSH does host-key checking, agent support, `ProxyJump`, certificates, `~/.ssh/config` and hardware keys. Reimplementing any of that would be a liability | Behaviour depends on the user's `ssh_config`. Pin what matters on the command line (§7.3), because `-o` overrides config |
| Exit code semantics are clean: "ssh exits with the exit status of the remote command or with 255 if an error occurred" [V] | Errors come back as stderr text; turning them into typed errors means parsing the remote side's own output [I] |
| `ControlMaster`/`ControlPersist` make the second summon to a host skip the handshake [V] | **Windows:** Microsoft documents the in-box OpenSSH (Windows 10 1809+ / Server 2019+) [V], but that its client lacks `ControlMaster` is from memory [U]. Treat multiplexing as POSIX-only and make it optional |

**Verdict** [I]: acceptable, **provided the adapter is opt-in and says what it needs.** It checks for `ssh` with
`Bun.which("ssh")` at construction and throws a `ConfigError` naming the missing binary. It must not lazily fail at the
first summon.

### 7.2 Process-supervision shape: pick a systemd unit

| Shape | Survives SSH ending? | Dedupe | Hard cap | Logs | Verdict |
|---|---|---|---|---|---|
| `ssh host 'cd app && bun worker.ts'` (foreground) | No. It dies with the session unless the summoner holds the SSH connection open for the whole drain | None | None | Summoner's stdout | Only for a summoner that stays connected. Fragile [I] |
| `nohup bun worker.ts >log 2>&1 </dev/null &` / `setsid -f` | Usually. **All three std streams must be redirected**, or ssh waits on the open channel [U: well known, not measured here, no sshd] | Needs `flock` | Needs `timeout(1)` | A file you rotate | Works; assembles four tools to do a unit's job [I] |
| **`systemd-run --user --unit=bun-jobs-<q> --collect -p RuntimeMaxSec=… bun worker.ts`** | **Yes, with lingering.** Without it, "After the user logs out of the last session, user@.service and all services underneath it are terminated" [V]; fix with `loginctl enable-linger` [V] | **Unit name** [M] | `RuntimeMaxSec` [I] | journald | **Recommended** |
| `systemctl --user start bun-jobs-worker@<q>` (template the host owner installs) | Yes (lingering as above) | `start` on an active unit is a no-op, rc 0 [M] | In the unit file | journald | **Recommended when the host owner wants control** of `ExecStart`, `User`, limits |

Recommendation [I]:
- **Default to `systemd-run` transient units.** They need nothing installed beyond Bun and the app, and the fixed
  `--unit` name is an atomic "already running" check done by the service manager. Measured: the second call fails with
  exit 1 and `Unit … was already loaded`. Treat that exit/message as `already: true`, not as an error.
- **Offer the template unit** as the hardened variant: the host owner writes `bun-jobs-worker@.service` with
  `ExecStart=/usr/local/bin/bun /srv/app/worker.ts --queue %i`, `TimeoutStopSec=` ≥ the job timeout, and
  `KillSignal=SIGTERM`. The SSH key's forced command then becomes `systemctl --user start bun-jobs-worker@…`.
- Fallback for hosts without systemd: `flock -n -E 75 /run/user/$UID/bun-jobs-<q>.lock setsid -f bun worker.ts
  </dev/null >>log 2>&1`. `flock -n` on a held lock gives exit 1, or the chosen code with `-E` [M].

### 7.3 Non-interactive, host-key-verified invocation

Pinned options, all from `ssh_config(5)` [V]:

| Option | Why |
|---|---|
| `BatchMode=yes` | "user interaction such as password prompts and host key confirmation requests will be disabled". A summoner must never hang on a prompt |
| `StrictHostKeyChecking=yes` | "will never automatically add host keys … and refuses to connect to hosts whose host key has changed" |
| `UserKnownHostsFile=<bun-jobs-owned file>` | Pin the host keys the user approved, independent of `~/.ssh/known_hosts` |
| `IdentitiesOnly=yes` + `-i <dedicated key>` | Use only the configured identity "even if ssh-agent … offers more identities" |
| `ConnectTimeout=10` | Bounds connect *and* key exchange |
| `ControlMaster=auto`, `ControlPath=<dir>/%C`, `ControlPersist=60` | Reuse the connection. `%C` and a directory "not writable by other users" is the man page's own advice |
| `ServerAliveInterval=15` | Detect a dead link. Note it defaults to 300 under `BatchMode` on Debian builds |

**Do not** offer `StrictHostKeyChecking=accept-new` as a default: it trusts on first use, and the first use is
unattended [I]. The adapter should take the pinned host key as configuration (e.g. `hostKey: "ssh-ed25519 AAAA…"`)
and write the known-hosts file itself [I].

### 7.4 Server-side posture (`authorized_keys`)

From `sshd(8)` [V]: `command="…"` "is executed whenever this key is used for authentication. The command supplied by
the user (if any) is ignored". `restrict` enables "all restrictions, i.e. disable port, agent and X11 forwarding, as well
as disabling PTY allocation and execution of ~/.ssh/rc", and future restrictions too. `from="pattern-list"` limits
source addresses. The client sees the requested command in `SSH_ORIGINAL_COMMAND` [V, ssh(1)].

```
restrict,from="10.0.0.0/8",command="/usr/local/bin/bun-jobs-summon" ssh-ed25519 AAAA… bun-jobs-summoner
```

`bun-jobs-summon` is a ~10-line script, shipped as a documented recipe and not as package code [I]. It validates
`$SSH_ORIGINAL_COMMAND` against `^[a-z0-9._-]{1,64}$` (the queue name) and runs `exec systemctl --user start
"bun-jobs-worker@$q"`, or the `systemd-run` line. **The key can then start a worker for a named queue and do nothing
else**, so a leaked key's blast radius is "start workers".

### 7.5 Adapter sketch (`Bun.spawn`)

```ts
export function sshSummoner(o: { hosts: string[]; user: string; keyFile: string; knownHostsFile: string;
                                  controlDir?: string; command: (queue: string) => string[] }) {
  if (!Bun.which("ssh")) throw new Error("sshSummoner needs the system `ssh` binary on PATH");
  const base = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${o.knownHostsFile}`,
    "-o", "IdentitiesOnly=yes", "-i", o.keyFile, "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
    ...(o.controlDir ? ["-o", "ControlMaster=auto", "-o", `ControlPath=${o.controlDir}/%C`, "-o", "ControlPersist=60"] : [])];
  let next = 0;
  return {
    async summon(ctx: { queue: string }) {
      const host = o.hosts[next++ % o.hosts.length]!;        // or pick by capacity, §7.6
      // With a forced command on the server this argv is only SSH_ORIGINAL_COMMAND, i.e. the queue name.
      const p = Bun.spawn(["ssh", ...base, `${o.user}@${host}`, "--", ...o.command(ctx.queue)],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
      if (code === 0) return { id: `${host}:${ctx.queue}`, already: false };
      if (/already loaded|already active/.test(err)) return { id: `${host}:${ctx.queue}`, already: true };  // [M] wording
      throw new Error(code === 255 ? `ssh to ${host} failed: ${err.trim()}` : `remote exited ${code}: ${err.trim()}`);
    },
  };
}
// command: q => ["systemd-run", "--user", `--unit=bun-jobs-${q}`, "--collect", "-p", "RuntimeMaxSec=6h",
//                "-E", `BUN_JOBS_QUEUE=${q}`, "--working-directory=/srv/app", "/usr/local/bin/bun", "worker.ts"]
```

(Arguments cross a remote shell. Keep queue names restricted to a safe charset, or use the forced-command shape, where
the argv is never interpreted by a shell [I].)

### 7.6 Liveness and multiple hosts

- **Is "it registers itself through the driver" sufficient to know it is alive?** Once it has reported, yes [R]:
  `listWorkerRecords` is the authority, and `WorkerInfo.host` says where it runs. **Before its first report, no**
  (§1). The summoner must keep its own in-flight marker per (queue, host) with a TTL of about connect + boot +
  one report [I]. If the marker lapses and no record appeared, the start failed silently (bad `PATH`, a crash on
  import). Log it at `warn`, and **do not retry immediately on the same host** [I].
- **Round-robin** is enough for one worker per summon. **By capacity**: count live `WorkerInfo` per `host` and
  summon onto the host with the fewest [I]. Every per-host fact comes from data bun-jobs already stores.

### 7.7 SSH gotchas

- Hosts that suspend (laptops, some dev VMs) break the lease. "SSH to a server" is the supported shape [I].
- A user manager does not read the login shell's profile, so `bun` must be referenced by absolute path, or `PATH` set
  with `-E`/`Environment=` [I].
- `KillUserProcesses=` in `logind.conf` "Defaults to 'no'" but some distros turn it on. Lingering covers both cases [V][I].
- Without a forced command, anything in the queue name reaches a remote shell. Validate on both ends [I].

---

## 8. Cost sanity: one worker draining for 5 minutes

Prices as read on 2026-09-25. The monthly→per-second conversion uses 730 h/month; the vendors do not state which
month length they prorate against [U]. Rows marked [I] are arithmetic on [V] rates.

| Platform / size | Rate [V] | 5 min [I] | Standing cost when idle |
|---|---|---|---|
| Fly shared-cpu-1x 512 MB (1.0× region) | $0.00000128/s | **$0.00038** | rootfs $0.15/GB/30 d per pooled Machine [V] (≈ $0.08/mo for a 0.5 GB image [I]); static egress IP $3.60/mo if needed [V] |
| Fly shared-cpu-1x 1 GB | $0.00000228/s | $0.00068 | as above |
| Render Starter job (0.5 CPU, 512 MB) | $7/mo prorated per second | **$0.0008** | none for jobs [I]; workspace plan fee not checked [U] |
| Render Standard job (1 CPU, 2 GB) | $25/mo | $0.0029 | as above |
| Heroku Basic one-off | $7/mo, prorated per second ("roughly $0.01 per hour") | $0.0008 | none [I] |
| Heroku Standard-1X one-off | $25/mo | $0.0029 | none [I] |
| Railway, 0.5 vCPU + 0.5 GB average use | $0.000463/vCPU-min, $0.000231/GB-min | **$0.0017** | Hobby $5/mo or Pro $20/mo subscription (includes that much usage) [V] |
| Cloudflare Containers `basic` (¼ vCPU, 1 GiB, 4 GB disk), CPU fully busy | mem $0.0000025/GiB-s, CPU $0.00002/vCPU-s, disk $0.00000007/GB-s | **≤ $0.0023** before the included allowance | plus `sleepAfter` tail memory/disk if the process does not exit itself [I]; Workers Paid plan fee not checked [U] |
| SSH to own host | none | $0 | the host |

**Reading it** [I]: per-summon compute is under a cent everywhere. What decides cost is the **standing charge** (plan
subscriptions, a Fly pool's rootfs, a static IP) and, above all, **how quickly the worker exits once drained**.
`idleTimeout` is the dominant cost knob, not the platform.

---

## 9. Ranking rationale and cross-cutting risks

**Why this order** [I]:

1. **Fly first.** It is the only target where every template row is favourable *and* verified: a REST start,
   sub-second (vendor-stated) wake, stop-on-exit, per-second billing, near-zero idle cost, a natural dedupe key, and
   a generous per-machine rate limit. Its two traps (SIGINT with a 5 s kill timeout, and a pre-created pool) are
   configuration, not design.
2. **Render second.** It has the most pleasant launch-a-task API of the PaaS set, and the base service can be the
   user's existing web app, so there is nothing new to deploy. Its gaps (no idempotency key, unknown start latency,
   unknown cancel semantics) are all solvable on bun-jobs' side.
3. **SSH third.** It serves the "I already have a box" user no platform adapter reaches, and it costs nothing.
   It ships last among the three because it is the only one that adds a system dependency and security surface
   (key, known hosts, forced command) that bun-jobs has to document well.
4. **Everything else behind a generic `invoke()`** with recipes: Kubernetes (or KEDA with no code), Nomad, Northflank,
   Cloudflare Containers via a Worker shim, and Heroku. Railway waits until someone confirms that restarting a
   Completed deployment works. DO and Koyeb are out.

**Cross-cutting design consequences** [I]:

- **Level-triggered beats edge-triggered.** Where a platform offers "set N" (Heroku formation, Render scale), a
  duplicate summon is harmless. "Launch one" (Render jobs, Heroku one-off, Northflank, Kubernetes with `generateName`)
  duplicates on a race. Fly's pool and systemd's unit name turn launch-one into set-N, which is why they rank high.
- **The in-flight marker is mandatory** (§1). Its TTL must cover the *platform's* cold start. That differs by two
  orders of magnitude between Fly start (<1 s vendor-stated) and a Kubernetes image pull, so it belongs in each
  summoner's config, with a per-adapter default.
- **Shutdown budgets differ ~60×:** Railway 0 s by default, Fly 5 s by default (SIGINT), Heroku 30 s fixed,
  Kubernetes 30 s by default, Render 30–300 s, Cloudflare 15 min. The worker recipe must take the platform's
  deadline as input (Temporal's `shutdownDeadlineBufferMs`, §3.8.1) and must install its own signal handlers. Nothing
  in `BunQueueWorker` does that today [R].
- **Parameters reach the process in three different ways:** per-run env (Heroku `env`, Northflank
  `runtimeEnvironment`, Kubernetes, `systemd-run -E`), command arguments only (Render `startCommand`), or config fixed
  when the Machine/service was created (Fly start, Railway). A summoner that needs to pass the queue name should
  assume the weakest: **one worker file per queue, or a queue name in argv** [I].

## 10. Open items (unverified; check before building)

- Railway: does `deploymentRestart` restart a `Completed` (exit 0) deployment, and what status name does the API
  report for it?
- Render: cancel-job signal and grace; one-off job start latency; List-jobs filters.
- Fly: the response to `start` on an already-`started` Machine; per-start env overrides.
- Heroku, Render, Railway: time from API call to process start (no vendor figure found). **Measure, don't guess.**
- SSH: session survival of `nohup`/`setsid` with unredirected streams, and `ControlMaster` on Windows OpenSSH. Neither
  was measurable here (no sshd on this machine).
- Kubernetes: the 409 status on a duplicate name, and Bun `fetch` with a custom CA against an API server.
