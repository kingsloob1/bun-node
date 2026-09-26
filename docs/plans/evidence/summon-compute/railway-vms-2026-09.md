# Railway VMs as a summon target (free VM, cloud agents, sandboxes)

Evidence for [`../../summon-compute.md`](../../summon-compute.md) (Railway
recipe status, Q25) and for the Phase 2 platform-transport matrix
(`docs/plans/evidence/remote-transports/platform-transports.md` on `develop`,
Railway rows). Researched **2026-09-26**, prompted by Railway's
[free VMs without an account](https://railway.com/changelog/2026-09-25-free-vms-without-an-account)
(changelog, 2026-09-25). Research only: nothing was created on Railway and
nothing in the repo was built or run.

Earlier Railway findings are in [`paas-ssh.md`](paas-ssh.md) §4.1. They cover
Railway **services**, where a summon had to restart a `Completed` deployment,
which is undocumented (Q25). This file covers Railway's **VM** products, which
`paas-ssh.md` did not examine.

## How to read the markings

| Mark | Meaning |
|---|---|
| **[V]** | Verified: read on 2026-09-26 from a Railway primary source listed in §9: docs (fetched as the docs site's own `.md` rendering), marketing and changelog pages, the Acceptable Use Policy and Terms, or the public GraphQL collection. |
| **[V-src]** | Read on 2026-09-26 from Railway's own open-source code: `railwayapp/cli` (master, pushed 2026-09-25) or `railwayapp/railway-ts-sdk` (main, v3.11.0). This is primary, but a code comment is not a documented contract. |
| **[I]** | Inference: my reasoning from the facts above. It is not a fact about the platform. |
| **[U]** | Unverified: not found in a primary source today. |

Prices are in USD, as shown on 2026-09-26.

---

## 1. Bottom line

1. **Railway has three VM products, and the one that matters for summoning is
   the one nobody asked about: Sandboxes.**
   - **Free VM** (`ssh railway.new`, no account): a trial funnel. **It is not a
     summon target** (§6).
   - **Cloud agents**: persistent personal VMs. They have real GraphQL
     `cloudAgentSleep` and `cloudAgentWake` mutations, so they *are* wake-style
     in mechanism. But they are a **Priority Boarding beta** ("Breaking changes
     may occur"), sized by plan and not configurable, owned per user, and sold
     as a development environment ("Deploy a Railway service for production
     traffic") [V]. Waking "re-runs its entrypoint", not our process [V-src],
     so a summon needs two steps: wake, then start the worker over SSH.
   - **Sandboxes**: "isolated Linux VMs you create on demand", "available on
     every plan", with a GraphQL API (`sandboxCreate`, `sandboxDestroy`,
     `sandboxExec`, `sandboxHeartbeat`, checkpoints), a TypeScript SDK, private
     networking to the environment's databases, and an idle timeout that is
     deferred while a detached command runs [V]. This is a
     **launch-style** target, like ECS `RunTask` or Fly `create`, with a
     checkpoint as the image.
2. **Railway stops being "blocked".** Q25 (restarting a `Completed`
   deployment) no longer gates *a* Railway recipe, because Sandboxes give a
   documented launch path that does not depend on it. Railway becomes
   **Conditional → candidate** through Sandboxes (§7). Q25 stays open only for
   the service path.
3. **The free, unclaimed VM must not be automated for summoning.** Its limits
   (3 per IP per day, regional caps, 60 minutes, deletion at 24 hours, a
   preview URL only the creating IP can open) and the Acceptable Use Policy's
   ban on "evading usage or billing limits" and "reselling compute resources"
   [V] make it a hands-on "try it" path, not infrastructure (§6).

---

## 2. The three products at a glance

| | Free VM (unclaimed) | Cloud agent | Sandbox |
|---|---|---|---|
| Access | `ssh railway.new`, no account; "Railway identifies you by your SSH key" [V] | Account, plus the **Cloud Agents** flag in Priority Boarding [V] | Account; "available on every plan" [V] |
| Size | 2 vCPU / 2 GB [V] | By plan, "isn't configurable": Trial/Free 2 vCPU/1 GB, Hobby 2/2, Pro 4/4 [V] | Plan default, or request up to the plan maximum: Hobby 4/4 default and 8/8 max, Pro 8/8 and 32/32, Trial/Free 2/2 [V] |
| Lifetime | 60 min to build, then 24 h to claim, else "deleted with their files" [V] | Indefinite. "There is no idle timeout" [V] | Destroyed after the idle timeout; Hobby/Pro can set 0 (never) [V] |
| Stop and start | None documented [U] | `cloudAgentSleep(id)` / `cloudAgentWake(id)`; `railway ca sleep` / `wake` [V] | Create and destroy only; no stop/start [V] |
| Disk across a stop | n/a | Kept on sleep, lost on delete [V] | Lost on destroy; keep it with a **checkpoint** [V] |
| API | None documented [U] | GraphQL + CLI [V] | GraphQL + CLI + TS SDK (`railway` on npm) [V] |
| Billing | Free while unclaimed [V] | VM rates while awake; sleeping "stops compute billing" [V] | VM rates while it exists [V] |
| Maturity | Launched 2026-09-25 [V] | Priority Boarding beta [V] | On every plan [V]. The free-VM page lists `railway sandbox` beside an "experimental" label whose scope is ambiguous in the page text [V] |

**What a claimed free VM becomes is not documented [U].** The page says "the box
moves into your account, with the same VM, files, and URL" [V]. Its port-8080
preview URL and preinstalled coding agents resemble a cloud agent, but the
June 2026 changelog described `ssh railway.new` as spinning up "a sandbox"
[V]. The schema has `projectClaim` and `Project.isTempProject` [V-src], which
suggests the box lives in a temporary project that is claimed as a whole [I].
**Do not rely on a claimed box's lifecycle until Railway documents it.**

---

## 3. Question 1: programmatic start and stop

### 3.1 Cloud agents: wake-style, with two steps

| Fact | Tag |
|---|---|
| Mutations: `cloudAgentCreate(input: CloudAgentCreateInput!)`, `cloudAgentSleep(id: ID!)`, `cloudAgentWake(id: ID!)`, `cloudAgentDelete(id: ID!)`, `cloudAgentFork`, `cloudAgentCheckpointCreate`. Queries: `cloudAgent(environmentId, id)`, `cloudAgents(environmentId, mine)`, `myCloudAgents` | [V] collection, [V-src] schema |
| `cloudAgentSleep`: "Sleep a running cloud agent, keeping its volume. Processes on the machine are terminated; **waking re-runs its entrypoint.**" | [V-src] schema description |
| `CloudAgentCreateInput`: `environmentId`, `name?`, `region?`, `variables?`, `source?`, `cloudAgentCheckpointId?`. There is no image, command or size field | [V-src] |
| `CloudAgentStatus`: `STARTING`, `RUNNING`, `SLEEPING`, `CRASHED`, `FAILED`, `DELETING` | [V-src] |
| CLI, non-interactive: `railway ca create NAME --project P --environment E --json` (plus `--variable`, `--env-file`, `--no-wait`); `railway ca wake NAME [--no-wait]`; `railway ca sleep NAME` / `--all`; `railway ca delete NAME --yes`; `railway ca list --json`; `railway ca setup -y` is "used when stdout is not a terminal" | [V] |
| "Sleeping ends running processes and terminal sessions. Files and saved conversation history remain on disk" | [V] |
| Creation limit: "25 agents per user per day" | [V] |
| **Wake latency:** no documented figure. The CLI's readiness wait says "a fresh VM is never routable before ~550ms, a restore before ~1.5s", with a 180 s ready timeout. A wake "restores a checkpoint and is much quicker" than a cold create | [V-src] (a floor, not a typical time) |
| **Token:** the CLI's preflight notes that "a project token … cannot read `me`" and then "lets the real call decide". Whether `cloudAgentWake` accepts a project or workspace token is not documented. "Agents hold your credentials and are owned by you" | [U] token; [V] ownership |
| SSH key management "isn't supported with project tokens (`RAILWAY_TOKEN`); use a workspace API token or run `railway login`" | [V] |

**So:** a cloud agent is mechanically a wake-style target, the same shape as a
stopped Fly Machine: a stable id, `wake`, and a kept disk [V]. Unlike Fly,
though, **the wake does not start our worker**. The entrypoint is Railway's
image, and `CloudAgentCreateInput` has no command field [V-src]. A summoner
would call `cloudAgentWake`, wait until the agent is connectable, and then
start the worker over SSH (§5) [I].

### 3.2 Sandboxes: launch-style

| Fact | Tag |
|---|---|
| Mutations: `sandboxCreate(input: SandboxCreateInput!)`, `sandboxDestroy(environmentId, id)`, `sandboxExec(command, environmentId, id, timeoutSec?)` (returns `exitCode stdout stderr timedOut truncated`), `sandboxHeartbeat(environmentId, id)` ("Extend a sandbox's lifetime"), `sandboxCheckpointCreate/Delete/Rename`, `sandboxTemplateBuild`. Queries: `sandbox`, `sandboxes`, `sandboxSessions`, `sandboxCheckpoints` | [V] collection, [V-src] schema |
| `SandboxCreateInput`: `environmentId`, `idleTimeoutMinutes?` ("Any value <= 0 means never idle out (plan-gated)"), `networkIsolation?` (`ISOLATED` default or `PRIVATE`), `publicDomains?`, `region?`, `sourceSandboxId?` (fork), `template?`, `variables?` (Railway references are resolved at create time) | [V-src] |
| `resources { cpu, memoryGB }` on `sandboxCreate` sets the VM size | [V] docs. It is missing from the SDK's generated types (v3.11.0) [V-src] |
| Boot from a named checkpoint: `Sandbox.create("after-deps")` / `railway sandbox create --checkpoint NAME`. The new sandbox "boots fresh from a copy of the checkpointed disk, so files are preserved but running processes are not" | [V] |
| `SandboxStatus`: `CREATING`, `RUNNING`, `DESTROYING`, `DESTROYED`, `FAILED`. "`Sandbox.create()` resolves once the sandbox is `RUNNING`" | [V-src], [V] |
| **A long-running command:** "A command started with `exec` runs on the sandbox independently of the client that started it"; `exec --detach` "prints its durable session name … and returns immediately" | [V] |
| The detached exec runs over a WebSocket, `/ws/exec`, authorised by a shell-scoped JWT. The GraphQL `sandboxExec` mutation is the synchronous form | [V-src] |
| **Idle timeout:** "Railway also defers idle teardown while an `exec` command is running, including a detached command". But "a background process outside an active session doesn't keep the sandbox alive on its own" | [V] |
| Idle timeout: Hobby/Pro default 30 min, range 1–120, or 0 to disable. Trial/Free default 5 min, range 1–5, and it cannot be disabled | [V] |
| Concurrency cap per **environment**: Trial/Free 10, Hobby 50, Pro 100. "Creating a sandbox past the cap fails with an error." Checkpoints are capped at the same number, counted separately | [V] |
| Region: "Without it, a fresh sandbox runs in US West (`us-west2`), regardless of your account's preferred region." Checkpoint boots stay in the region where the checkpoint was captured. "The CLI has no region flag" | [V] |
| Token: the docs name `RAILWAY_API_TOKEN` + `RAILWAY_ENVIRONMENT_ID`. The SDK also accepts `RAILWAY_TOKEN`, a project token, and calls it "the recommended on-platform credential" | [V] docs, [V-src] SDK |
| API rate limits: 100 / 1,000 / 10,000 requests per hour (Free / Hobby / Pro); 10 RPS Hobby, 50 RPS Pro | [V] |
| Dedupe: `SandboxCreateInput` has **no name or idempotency key** | [V-src] (absent from the schema) |
| Boot latency: no documented figure for sandboxes. The free VM's "about 1.4 seconds" is a marketing figure for a different product | [U] for sandboxes |

**So:** a sandbox gives a documented, token-driven summon: `sandboxCreate`
from a checkpoint that already has Bun and the app, then a detached exec of
`bun worker.ts --queue X` [V for each step]. Two consequences for the recipe:

- **Idle behaviour lines up with "exit when idle".** The sandbox lives while
  the detached worker runs. When the worker exits, the idle timeout (as low as
  1 minute) destroys the sandbox. That is scale to zero without a destroy call
  [I from the [V] rules]. Keep `sandboxDestroy` as a backstop.
- **The worker must be started by `exec`, never by `nohup` inside a shell.** A
  process started outside a session "doesn't keep the sandbox alive" [V].

---

## 4. Questions 2 and 3: billing and long-lived processes

### 4.1 Billing

| Fact | Tag |
|---|---|
| **VM rates** (sandboxes and cloud agents): RAM $50/GB/month ($0.001157/GB-min), CPU $50/vCPU/month ($0.001157/vCPU-min), egress $0.05/GB. Charged on "measured CPU use, memory in use (including the operating system and filesystem cache)". "Memory remains billable while a VM waits for work." Metered per second | [V] |
| Container rates, for comparison: RAM $10/GB/month, CPU $20/vCPU/month | [V] |
| So one unit of VM usage costs **5×** a container's for RAM and **2.5×** for CPU. For 0.5 vCPU + 0.5 GB in use: VM ≈ **$0.00116/min**, container ≈ $0.00035/min, about **3.3×** | [I] arithmetic |
| Cloud agent: "A running agent bills for compute while it is awake, including when no client is connected. Sleeping stops compute billing and keeps the disk" | [V] |
| Whether a sleeping agent's disk is billed: not stated | [U] |
| Sandbox: "Once destroyed, a sandbox incurs no further compute usage." A sandbox with the idle timeout disabled "remains billable until you destroy it" | [V] |
| VM usage "draws from the same included usage": Hobby $5/month, Pro $20/month subscriptions, each including that much usage | [V] |
| No per-start minimum is documented; metering is per second | [V] per second; [U] minimum |
| Free VM: "Compute for an unclaimed box is free", with "a shared AI budget" (the page shows "$3.00 AI budget") | [V] |

### 4.2 A long-lived Bun process that heartbeats

| Fact | Tag |
|---|---|
| Cloud agent: "Disconnecting leaves the cloud agent running. There is no idle timeout." Terminal sessions "survive disconnects while the agent remains running" | [V] |
| Sandbox: no command timeout unless `timeoutSec`/`--timeout` is set, "so you can run long-lived processes like agents, dev servers, and builds" | [V] |
| Suspension or throttling while awake: nothing documented suggests it | [U]; no freeze is described [I] |
| Maximum lifetime of a sandbox kept alive by a running exec: not stated | [U] |
| Bun is not in either image's listed tools. Cloud agents have Node, pnpm/yarn, Python/uv and `mise`; sandboxes have "git, Node, npm, and mise". Install Bun into a checkpoint or template | [V] lists; [I] install |
| **Signals.** Sandbox exec `kill(signal)` sends "`TERM` by default" to "the command's process group". `--timeout` expiry: "the command receives `SIGTERM`" | [V] |
| The signal and grace on **`sandboxDestroy`**, on **idle teardown**, and on **`cloudAgentSleep`** ("Processes on the machine are terminated") are not documented | [U]. Assume none: treat sleep and destroy as SIGKILL and keep the lease timeout the backstop [I] |

---

## 5. Questions 4 and 5: networking, and SSH as a control path

### 5.1 Outbound and private networking

| Fact | Tag |
|---|---|
| Sandbox: "Every sandbox has outbound internet access through a NAT gateway." So an external Postgres or Redis is reachable | [V] |
| Sandbox `PRIVATE` mode "joins the environment's private network", can reach "`postgres.railway.internal`, and they can reach it". `ISOLATED` (the default) has no private network | [V] |
| Cloud agents: outbound is not stated as such. The documented workflows (clone from GitHub, call model providers, `DATABASE_URL=postgres.DATABASE_URL`) imply outbound, and variables can reference services in the same environment | [V] workflows; [I] outbound; [U] whether they join the private network |
| **Limited Trial** accounts (GitHub verification not passed) have "restricted outbound network access and only a limited set of ports". A claimed free VM on such an account may not reach an external database | [V] rule; [I] effect on a claimed box |
| Free VM outbound: not stated | [U] |

### 5.2 Inbound

| Fact | Tag |
|---|---|
| Sandbox public domains: up to 10 HTTPS domains, "unique ports from 1 to 65535", **only with `PRIVATE`**, fixed at creation. "Sandbox domains suit previews, demos, and webhooks. For production traffic, deploy a service" | [V] |
| Cloud agent: "a public HTTPS domain serving port `8080`", "the same across sleep and wake". The CLI docs add that new VMs request a code endpoint on port 4096 for OpenCode | [V] |
| Raw TCP or UDP from the public internet to a sandbox or cloud agent: none documented. The TCP Proxy is documented for services only | [U] |
| SSH port forwarding: `railway sandbox forward PORT` works "with either network mode". For services, `ssh -L` "is limited to the container's loopback and your project's private network. Public destinations are refused" | [V] |
| Free VM preview URL: "Only you, from the IP address that created the box, until you claim it." "Run your app on `$PORT` (8080)" | [V] |

### 5.3 SSH as the summoner's control path

| Fact | Tag |
|---|---|
| Cloud agent SSH: `railway ca ssh <agent> -- bash`. Underneath, plain OpenSSH to the relay `ssh.railway.com` with the username `agent:<environmentId>:<agentId>`. The relay "presents one stable ed25519 key today" | [V] docs; [V-src] username and relay |
| Services: `ssh <service-instance-id>@ssh.railway.com`, or the service's domain as the username; `scp`/`sftp` work | [V] |
| Sandboxes: `railway sandbox ssh --id ID [-- COMMAND]`; the relay username for sandboxes is not documented | [V]; [U] raw username |
| Auth is a registered SSH key: personal, or workspace-owned ("grant SSH access to every service in the workspace"; adding one needs workspace Admin). Keys are managed with an account or workspace token, **not a project token** | [V] |
| `ssh -T` / piped use: "piped input runs without a PTY so output stays clean for scripts and CI" | [V] (`railway ssh`) |
| A probe against an agent that is not yet routable "still opens a real connection (the relay falls through to the dev.new control surface instead of refusing at the transport)". A connection failure is therefore not the readiness signal; the CLI checks a marker in the output | [V-src] |
| **systemd:** nowhere documented for either VM. The CLI refers to Railway's own `vm-init`, which stamps session variables; sessions run as root (`/root/.profile`); a cloud agent wake "re-runs its entrypoint" | [U] systemd; [V-src] `vm-init`, root |

**So, for our SSH summoner** (`ssh host systemd-run --user --unit=bun-jobs-<queue> …`):

- **Target: a cloud agent.** SSH reaches it non-interactively with a registered
  key and the `agent:<env>:<id>` username [V-src]. But `systemd-run --user`
  **should be assumed to fail**: the init is `vm-init`, and nothing documents a
  user systemd manager [I]. The unit-name dedupe that paas-ssh measured does
  not carry over. Use `setsid nohup … &` with a pidfile or `flock` as the
  dedupe, or a durable session (`railway ca ssh --session NAME`) [I]. Every
  sleep kills the process, so the summoner must wake the agent and start the
  worker each time.
- **Target: a sandbox.** Do **not** use SSH plus `nohup`, because such a
  process does not hold the sandbox open [V]. Use the detached exec (SDK or
  `/ws/exec`) [V].
- **Target: a claimed free VM.** Undetermined until Railway says what it
  becomes (§2) [U].

---

## 6. Question 6: the free, unclaimed VM

### 6.1 What the sources say

| Fact | Tag |
|---|---|
| Purpose: "Use it to prototype an app, test an idea, or give a coding agent a place to work" (changelog). "One command gets you a Linux VM … For you or for your agent" (page) | [V] |
| Agents are an intended user: "If your agent can run ssh, it can get its own computer. No API key, no dashboard. It hands you the preview and the claim link." Agents "get a JSON manifest on their first connects with the preview URL, the build deadline, and the claim link, so they can build and hand the result back to you" | [V] |
| Limits: 60 minutes to build; 24 hours to claim; "3 per IP address per day"; "When demand is high, Railway caps how many free VMs run at once in each region" ("Anonymous trials are temporarily disabled…") | [V] (the per-IP figure is on the docs' free-trial page) |
| "Is it really free? Yes. … Abuse protections and a shared AI budget keep it free for everyone" | [V] |
| What happens to running processes when the 60-minute build window closes | [U] |
| **Acceptable Use Policy:** you may not use the Services "for other abuse of the platform, including cryptocurrency mining, torrenting, **reselling compute resources, evading usage or billing limits**, operating proxies or anonymization services…". "If you are unsure whether your use case is allowed, ask us before deploying" | [V] |
| **Terms of Service** (effective 2026-04-20): you will not use the Services in a manner that runs "any processes that run or are activated while you are not logged into the Services, or that otherwise interfere with the proper working of the Services (including by placing an unreasonable load on the Services' infrastructure)". Railway "has the sole right to decide whether you are in violation" | [V]. The first clause reads as boilerplate that Railway cannot apply to hosted services [I], but it is in force as written |
| "IPv4 only": **not found** in the page text or the docs today, although the briefing recorded it on 2026-09-26 | [U]. Possibly shown only in the SSH welcome, or removed |

### 6.2 Verdict

**Not a summon target, and bun-jobs must not automate it.** Reasons, in order
of weight:

1. **Intent.** Every source frames the box as something a person, or an agent
   acting for a person, builds on and then **claims** [V]. A summoner that
   creates boxes to run production jobs and never claims them uses the free tier
   as unpaid compute. That is the pattern the AUP's "evading usage or billing
   limits" names, and a library shipping it to many users drifts towards
   "reselling compute resources" [V quote; I application].
2. **It cannot work reliably anyway.** Three boxes per IP per day is fewer than
   one summon a day per queue on a busy deployment. Regional caps refuse boxes
   under demand. The box is gone within 25 hours. Only the creating IP can reach
   the preview URL [V]. Getting around any of these (rotating keys or IPs) is
   exactly the evasion the AUP forbids [I].
3. **It has no API.** Creation is an interactive SSH session with a JSON
   manifest for agents. Nothing documents stop, start or destroy [V/U].

**Appropriate use: a docs "try it" path, run by a person.** For example, a
section in the bun-jobs README or `examples/` saying: "`ssh railway.new`,
install Bun, clone the example, run a worker or executor against your queue for
up to an hour, and claim the box if you want to keep it." Two caveats to write
into that section: outbound access from an unclaimed box is not documented
[U], so point it at a URL-reachable Postgres or Redis and say it is untested;
and the preview URL answers only the creating IP [V], so it cannot demonstrate
a remote executor being called from elsewhere.

---

## 7. Recommendation

### 7.1 (a) First-party target, recipe, or neither

| Product | Verdict | Style | API |
|---|---|---|---|
| **Sandbox** | **Candidate for a first-party summoner**, after the measurements below. Until then, a documented recipe | **Launch** (ECS `RunTask`-like). Scales to zero through the idle timeout | GraphQL `sandboxCreate` with `template` or a checkpoint (the SDK's `Sandbox.create("<checkpoint>")`), plus detached exec over `/ws/exec`. The backstop is `sandboxDestroy` |
| **Cloud agent** | **A documented recipe at most**, labelled beta. Not first-party | **Wake**, in two steps: `cloudAgentWake(id)`, then SSH `setsid nohup bun …` | GraphQL `cloudAgentWake`/`cloudAgentSleep`, plus SSH `agent:<env>:<id>@ssh.railway.com` |
| **Claimed free VM** | Neither, until Railway documents what it becomes | — | — |
| **Unclaimed free VM** | Neither. A docs "try it" path only (§6.2) | — | — |

Why the cloud agent stays a recipe [I]:

- It is Priority Boarding beta, and Railway itself warns to "use Priority
  Boarding with caution if you have production workloads running" [V].
- It is per-user and fixed-size [V].
- Its wake does not start our process [V-src], so it needs SSH on top.
- The token it accepts is [U].

Sandboxes need none of that.

**What a Sandbox summoner must handle, and measure first:**

- **Dedupe: there is none** [V-src]. Keep the in-flight marker every summoner
  already needs (paas-ssh §9, the late worker registration). `sandboxes`
  listing can serve as a reconciliation check, but not as a lock [I].
- **Start latency:** create from checkpoint → `RUNNING` → first heartbeat.
  Unmeasured [U]. This joins Q26.
- **Shutdown:** the signal and grace on `sandboxDestroy` and on idle teardown
  are [U]. The worker should drain on SIGTERM, and the lease timeout must cover
  a SIGKILL.
- **Maximum lifetime** of a sandbox held open by a running exec is [U].
  Trial/Free cannot disable the idle timeout, but a running exec defers it [V].
  Whether that holds for hours on Free is [U].
- **Region:** it defaults to `us-west2` whatever the account prefers, and a
  checkpoint pins its region [V]. The recipe must pass `region` when it builds
  the checkpoint.
- **Cost:** VM rates are about 3.3× container rates for the same usage [I
  arithmetic]. That is acceptable for bursty summoning, and poor for a worker
  that stays up.
- **Dependency policy:** do not depend on the `railway` npm SDK. It declares
  `engines.node >=22` [V-src], although the docs say `bun add railway` works
  [V]. Call GraphQL with `fetch`, as the paas-ssh Railway sketch already does.
  The detached exec needs the `/ws/exec` protocol, whose wire format is in
  `src/core/exec-ws-client.ts` [V-src]. Porting that is the one non-trivial
  piece [I].

### 7.2 (b) Railway's "blocked" status and Q25

- **Change "Conditional/blocked" to "Candidate (Sandboxes); service path
  still conditional on Q25".** The block was on the only path then known
  [V paas-ssh §4.1]. A documented create/exec/destroy API now exists [V].
- **Rewrite Q25** so it no longer says "This blocks a Railway recipe". Suggested
  wording: "Q25 Railway services: whether `deploymentRestart` restarts a
  `Completed` deployment, its status name, and whether `numReplicas: 0` works.
  Only the service path depends on it; Sandboxes (railway-vms-2026-09.md §3.2)
  do not."
- **Add Q-new (Sandboxes):** start latency from a checkpoint; the signal and
  grace on destroy and on idle teardown; the maximum lifetime under a running
  exec per plan; whether `sandboxCreate` accepts a project token (the SDK
  implies yes [V-src]); and the `/ws/exec` JWT mint (`shell.graphql` in the
  SDK) [U].
- **Add Q-new (cloud agents), low priority:** which token type
  `cloudAgentWake` accepts; whether a wake starts anything we control; and
  systemd availability.

### 7.3 (c) Phase 2 platform-transport matrix rows

Keep the existing **Railway (services)** row unchanged. Add:

| Platform | HTTP/1.1 in | HTTP/2 / gRPC | Streamed | WebSocket | Raw TCP | UDP | Outbound | Limits | Health |
|---|---|---|---|---|---|---|---|---|---|
| **Railway Sandbox** | Yes, on up to 10 HTTPS domains, `PRIVATE` mode only, fixed at creation. "Previews, demos, and webhooks", not production [V] | [U] | [U]; probably as for services, same edge [I] | [U] | Public: none documented [U]. Private network in `PRIVATE` mode [V]. SSH forward [V] | Private network only, if it matches services [I] | NAT internet always; private network in `PRIVATE` [V] | Idle-timeout destroy, deferred by a running exec [V] | None documented [U] |
| **Railway cloud agent** | One HTTPS domain, port 8080 (4096 for the OpenCode code endpoint on new VMs), stable across sleep [V] | [U] | [U] | [U] | None documented [U]. SSH relay only [V-src] | [U] | Implied [I] | No idle timeout; sleep kills processes [V] | None documented [U] |
| **Railway free VM** | Preview URL on `$PORT` 8080, **reachable only from the creating IP** until claimed [V] | [U] | [U] | [U] | No [U] | No [U] | [U] | 60 min build, 24 h claim [V] | — |

**Net effect on the matrix [I]:**

- A Railway VM adds no transport a Railway service lacks. Services already have
  the TCP Proxy and unlimited WebSockets.
- Sandbox domains are the one new inbound path, and Railway scopes them to
  non-production use.
- For Phase 2, **run an executor on a Railway service, not a VM**. A summoned
  sandbox worker needs outbound only (it pulls from the queue driver), which it
  has.

### 7.4 (d) The free unclaimed VM

- Use it only as a hands-on docs "try it" path, as in §6.2.
- Never ship code in bun-jobs that creates a box by itself, including through
  an example that loops `ssh railway.new`.
- The terms to cite are the AUP's "reselling compute resources, evading usage
  or billing limits" and "If you are unsure whether your use case is allowed,
  ask us before deploying" (<https://railway.com/legal/acceptable-use>), and
  the product's own framing: prototype, then claim
  (<https://railway.com/free-vm>).

---

## 8. What surprised me

1. **Sandboxes** were already in Railway's product line: "Railway over SSH"
   (2026-06-26) created them with `ssh sandbox@railway.new`. They are the real
   programmatic VM, and neither `paas-ssh.md` nor the brief mentions them.
2. **Waking a cloud agent does not start your process.** "Waking re-runs its
   entrypoint" [V-src], and the entrypoint is Railway's.
3. **VM pricing is 5× container RAM and 2.5× container CPU** [V].
4. **The sandbox region defaults to `us-west2`** "regardless of your account's
   preferred region" [V]. A summoner that ignores this puts workers far from
   an EU database.
5. **The relay accepts a connection before the VM is ready.** Early connections
   fall through to `dev.new` rather than being refused [V-src], so "SSH
   connected" does not mean "agent ready".
6. **"IPv4 only" is not on the free-VM page today** (§6.1).
7. **The Terms prohibit "processes that run … while you are not logged into
   the Services"** [V]. For a hosting company this is surely boilerplate, but it
   is the literal text.

---

## 9. Sources (all read 2026-09-26)

Railway pages:

- <https://railway.com/free-vm>
- <https://railway.com/changelog/2026-09-25-free-vms-without-an-account>
- <https://railway.com/changelog/2026-06-26-railway-over-ssh>
- <https://railway.com/sandboxes>
- <https://railway.com/legal/acceptable-use> (`/legal/fair-use` redirects here)
- <https://railway.com/legal/terms>

Docs, each fetched as its `.md` rendering:

- <https://docs.railway.com/cloud-agents>
- <https://docs.railway.com/cloud-agents/manage>
- <https://docs.railway.com/cloud-agents/configuration>
- <https://docs.railway.com/cloud-agents/troubleshooting>
- <https://docs.railway.com/cloud-agents/terminal>
- <https://docs.railway.com/cloud-agents/quickstart>
- <https://docs.railway.com/cli/ca>
- <https://docs.railway.com/cli/ssh>
- <https://docs.railway.com/cli/sandbox>
- <https://docs.railway.com/cli/api>
- <https://docs.railway.com/sandboxes>
- <https://docs.railway.com/sandboxes/quickstart>
- <https://docs.railway.com/guides/agents-in-sandboxes>
- <https://docs.railway.com/guides/code-execution-sandboxes>
- <https://docs.railway.com/pricing/plans> (VM pricing)
- <https://docs.railway.com/pricing/free-trial> ("Try without an account")
- <https://docs.railway.com/integrations/api> (token types, rate limits)
- <https://docs.railway.com/platform/priority-boarding>

API collection:

- <https://gql-collection-server.up.railway.app/railway_graphql_collection.json>,
  the public GraphQL operation collection linked from the API docs.

[V-src] code:

- `railwayapp/railway-ts-sdk@main`: `src/generated/graphql.ts`,
  `src/core/config.ts`, `src/core/exec-ws-client.ts`, `package.json`.
- `railwayapp/cli@master`: `src/commands/code.rs`
  (`wait_until_connectable`, `relay_ssh`),
  `src/commands/cloud_agent/lifecycle.rs`,
  `src/commands/cloud_agent/access.rs`,
  `src/commands/cloud_agent/herdr/target.rs`, `src/config.rs`
  (`get_ssh_relay`), `docs/cloud-agents.md`.

Not done: no box was created with `ssh railway.new`, and no Railway account
action was taken. Every latency here is either a vendor figure or [U].
