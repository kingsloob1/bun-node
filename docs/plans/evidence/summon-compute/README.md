# Evidence: summon-compute

This directory holds the research behind
[`../../summon-compute.md`](../../summon-compute.md), which is Phase 1.5 of
[`../../worker-runtimes.md`](../../worker-runtimes.md). The first three files
were gathered on 2026-09-25, and `railway-vms-2026-09.md` on 2026-09-26 (at the
user's prompt). None of them builds or runs anything in the repo.

| File | Covers | Ranks first | Key findings the plan relies on |
|---|---|---|---|
| [`aws.md`](aws.md) | ECS (Fargate, Spot, Managed Instances, EC2), Lambda (default, Managed Instances, durable, MicroVMs), EC2 and Auto Scaling, EKS, Batch, App Runner, Beanstalk, Lightsail. Also SigV4 and credentials without an SDK, and the scheduled trigger | ECS `RunTask` (one adapter for every ECS capacity type), then Lambda `Invoke` (Event), then EC2 `RunInstances` | a measured SigV4 signer. ECS `clientToken` dedupes identical requests only. LMI cannot be summoned from zero. Default Lambda is lease-safe only inside one invocation |
| [`google-azure.md`](google-azure.md) | Cloud Run jobs, worker pools and instances; Compute Engine, MIG, Cloud Batch, GKE; ACA jobs and apps, ACI, VM/VMSS, Functions, AKS. Also KEDA (every relevant scaler) and a token helper without an SDK | Cloud Run jobs and ACA event-driven jobs + KEDA | **the zero-worker blind spot** (due delayed jobs, retries and stalled jobs never reach `waiting` without a worker). The `demand`/`outstanding` depth endpoint and `countDemand`. SIGTSTP/SIGCONT on long Cloud Run jobs. Neither cloud's launch API dedupes |
| [`railway-vms-2026-09.md`](railway-vms-2026-09.md) | Railway's VM products: the free unclaimed VM, cloud agents and Sandboxes (`paas-ssh.md` covered Railway services only). Also VM pricing, SSH to Railway VMs, and the Acceptable Use Policy | Sandboxes: a candidate first-party summoner once measured; a recipe until then | Railway stops being blocked: Sandboxes are launch-style and scale to zero through the idle timeout, with **no dedupe** on create. Cloud agents wake but do not start our process. The free VM must never be automated. VM rates are about 3.3× containers |
| [`paas-ssh.md`](paas-ssh.md) | Railway, Render, Heroku, SSH (`systemd-run`); also Fly.io Machines, Cloudflare Containers, DigitalOcean, Koyeb, Northflank, Kubernetes Job + KEDA, and Nomad | Fly Machines, then Render one-off jobs, then SSH via `systemd-run` | **the late worker registration**, which means every summoner needs an in-flight marker. Shutdown budgets differ by about 60×. Nothing in `lib/queue/` handles signals. The unit-name dedupe is measured |

## Tags

Each file defines its own tags in a "How to read" section. They agree in
substance:

| Tag | Meaning |
|---|---|
| V | verified from a primary source that day |
| V~ | verified, but read through a summarising fetch (`google-azure.md` only) |
| V-src | read from the vendor's own open-source code (`railway-vms-2026-09.md` only) |
| M | measured |
| S / R | read from this repository's source |
| P / V-plan | carried from `worker-runtimes.md`'s 2026-09-22 round, not re-read |
| I | inference |
| U | unverified |

`summon-compute.md` quotes these tags unchanged, with the file each came from.

## Where the files disagree, and what the plan does about it

1. **Is `GET /queues/:queue/counts` enough for KEDA?**
   - `paas-ssh.md` §6.2 says yes: "bun-jobs needs no new endpoint" [R][I].
   - `google-azure.md` §1.3 and §6.4 say no: `waiting` misses due, retried and
     stalled jobs; a paused queue is not folded in; and `countJobs` scans
     retained history on SQL and Mongo.

   The plan sides with `google-azure.md`, and keeps `paas-ssh.md`'s point that
   KEDA counts Jobs rather than workers as open question Q12
   (`summon-compute.md` §6.1).

2. **The SigV4 vector count** — **resolved 2026-09-25:** re-running the harness independently gave 5 matches out of the 7 vectors it runs; `aws.md` §1 now says so, matching its §5.2 table (5 matches,
   2 path-encoding differences). An earlier draft of §1 said "6 of 8".

## Open items

Every item the files leave open is carried, with attribution, into
`summon-compute.md` §12.1 (Q1–Q30 from the first three; `railway-vms-2026-09.md`
rewrote Q25 and added Q40–Q41).
