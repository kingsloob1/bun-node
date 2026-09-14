# `bun-jobs` benchmarks

Two suites, measuring the two things this package does.

- **`queue.ts`** — `BunQueue`/`BunQueueWorker` against **BullMQ**, **bee-queue**,
  **node-resque**, **pg-boss**, **graphile-worker** and **Agenda**.
- **`runner.ts`** — `BunRunner` against **Bree**, **Agenda**, and the in-process
  cron timers **croner**, **node-cron**, **node-schedule** and
  **toad-scheduler**.

Every library here was checked to run on Bun before it was included; all
thirteen do.

## Setup

```bash
cd packages/bun-jobs/bench
bun install
```

Redis, Postgres, MySQL, MariaDB and MongoDB are needed for the backends that
use them. The repository's provisioning script brings them up; the bench
database is then created once per SQL server:

```bash
bun ../../../scripts/setup-databases.ts --docker
createdb bun_jobs_bench     # or: docker exec <pg> createdb -U bunjobs bun_jobs_bench

# MySQL (container on 3307) and MariaDB (3306), as root
docker exec -e MYSQL_PWD=<root password> bun-jobs-mysql mysql -uroot -e \
  "CREATE DATABASE bun_jobs_bench; GRANT ALL ON bun_jobs_bench.* TO 'bunjobs'@'%'"
docker exec -e MYSQL_PWD=<root password> bun-jobs-mariadb mariadb -uroot -e \
  "CREATE DATABASE bun_jobs_bench; GRANT ALL ON bun_jobs_bench.* TO 'bunjobs'@'%'"
```

The suites use their own databases — Redis database **14** and
**`bun_jobs_bench`** on Postgres, MySQL, MariaDB and MongoDB — so a long
benchmark cannot disturb the test suite, and a test run cannot make a benchmark
look slow. Override with `BUN_JOBS_BENCH_REDIS_URL`,
`BUN_JOBS_BENCH_POSTGRES_URL`, `BUN_JOBS_BENCH_MYSQL_URL`,
`BUN_JOBS_BENCH_MARIADB_URL` and `BUN_JOBS_BENCH_MONGODB_URL`.

Nothing is skipped silently: a backend that does not answer is named at the top
of every run, with the environment variable that would point it elsewhere.

## Run

```bash
bun queue.ts --verify              # prove every contender is correct, then stop
bun queue.ts                       # every scenario, every reachable backend
bun queue.ts -b redis              # just the Redis group
bun queue.ts -s roundtrip --samples 500
bun queue.ts --json > queue.json

bun runner.ts                      # every scenario
bun runner.ts -s exclusive         # three replicas, one cron job
bun runner.ts -c bun-runner-spawn,bree -s cycle
```

`--help` on either lists every option.

---

## The queue suite

### Contenders

| Backend      | Contenders                                                     |
| ------------ | -------------------------------------------------------------- |
| `redis`      | **bun-jobs**, BullMQ, bee-queue, node-resque, Agenda            |
| `postgres`   | **bun-jobs**, pg-boss, graphile-worker, Agenda                  |
| `mongodb`    | **bun-jobs**, Agenda                                            |
| `mysql`      | **bun-jobs**                                                    |
| `mariadb`    | **bun-jobs**                                                    |
| `sqlite`     | **bun-jobs**                                                    |
| `file`       | **bun-jobs**                                                    |
| `memory`     | **bun-jobs**                                                    |

**Results are only ranked within a backend.** A Redis figure next to a Postgres
figure measures the database, not the library, and a ranking across them would
say nothing useful. The backends only `bun-jobs` supports here are reported for
their own sake, not against anyone.

Agenda 6 splits storage into separate packages, so it appears in three groups
from one codebase.

### Scenarios

| Scenario       | What it measures                                                       |
| -------------- | ---------------------------------------------------------------------- |
| `enqueue`      | producer only, one job at a time, no consumer running                  |
| `enqueue-bulk` | producer only, batched through each library's own batch API            |
| `throughput`   | drain a pre-seeded backlog: worker start to last completion            |
| `roundtrip`    | add one job, wait for it, repeat — dispatch latency on an *idle* queue |
| `payload`      | the same drain with padded jobs, isolating serialization               |
| `contention`   | several independent consumers on one queue, checked for exactly-once   |

`roundtrip` is the number that a request-driven workload feels: the queue is
empty, so it is the cost of waking a consumer, not of chewing through a
backlog. `throughput` is the opposite case, and the two rank differently.

### Keeping it fair

Comparing defaults would be comparing documentation. Every contender is
configured the same way where the option exists, and the table footnotes the
cases where it does not.

- **One attempt, no retries, result discarded.** `removeOnComplete` and its
  equivalents are on everywhere, so nobody is charged for history the
  benchmark never reads.
- **One shared poll interval** (`--poll`, default 50ms) for every library that
  polls, rather than each one's own default — those range from 1s to 5s.
  Libraries that wait on the backend instead ignore it, and their rows say so.
- **Each library's own fast path is switched on.** pg-boss ships LISTEN/NOTIFY
  (`useListenNotify`) and burst mode (`burstWhenBatchFull`) *off*; both are
  enabled here. With them off pg-boss round-trips in ~500ms and drains at the
  poll rate; with them on it round-trips in ~3ms. Measuring the defaults would
  have measured the defaults.
- **A batch API is used when there is one.** node-resque and Agenda have none,
  so their `enqueue-bulk` figure is a sequential loop and the row says so.
- **Every contender is proved correct before it is timed.** `--verify` runs
  200 jobs through three competing consumers and requires each to arrive
  exactly once. A scenario that loses or repeats a job reports `FAILED`, never
  a fast time.
- **Each contender runs in its own freshly spawned process.** These libraries
  hold connection pools, poll timers and reconnect loops, and several keep them
  running after `close()`. Measured side by side in one process, whoever ran
  first taxes whoever runs next.

---

## The runner suite

### Contenders, grouped by what they actually guarantee

| Family                | Contenders                                                       |
| --------------------- | ---------------------------------------------------------------- |
| **isolated** — the handler is a file, run in its own process or thread | **BunRunner** (spawn), **BunRunner** (worker), Bree |
| **durable** — the run is coordinated across processes | **BunRunner** (single, spawn, redis), **BunRunner** (single, in-process, redis), **BunRunner** (single, spawn, postgres), Agenda (mongodb), Agenda (redis) |
| **in-process timers** — no isolation, no persistence, no coordination | **BunRunner** (in-process), croner, node-cron, node-schedule, toad-scheduler |

The durable family carries a deliberate pair: `single, spawn` takes a
cluster-wide lock **and** runs the handler in a fresh process, while
`single, in-process` takes the same lock and runs the handler on the caller's
stack. The gap between them is the price of isolation; the gap between
`single, in-process` and the timers is the price of exclusivity. Agenda sits
alongside the second one, which is the like-for-like comparison — it coordinates
across processes but runs an in-process function.

These are **not** grouped by backend, because the backend is barely on the
path: a runner touches it once to take a lock and once to record the result.
What separates the entries is how the handler is executed, and whether anything
outside the process is coordinated at all.

The timers are in the comparison as the floor. Whatever they cost is what a run
costs when nothing is isolated and nothing is durable — which is exactly what
the isolated and durable families are paying for.

### Scenarios

| Scenario    | What it measures                                                        |
| ----------- | ----------------------------------------------------------------------- |
| `dispatch`  | ask for a run, wait until the handler is executing — start-up cost      |
| `cycle`     | ask for a run, wait until it has finished — the whole round trip        |
| `drift`     | arm a one-second cron, measure how far each fire lands from the second  |
| `exclusive` | several replicas, one cron job: does it run once, or once per replica?  |

`exclusive` is the one that is not about speed. Three instances of the same
job are armed on the same one-second schedule, and the table reports runs per
occurrence: **1.00 means exactly once**, and a figure equal to the replica
count means every replica ran it. It is the question anyone deploying more than
one copy of a service has to answer, and it splits the field cleanly.

Every contender runs the same trivial handler — report that it started, return
— so the figures are the runner's own cost rather than the work's.

`drift` timestamps the moment the *scheduler decides to fire*, not the moment
user code lands, so a contender that runs its handler in a worker is not
charged twice for the start-up that `dispatch` already measures.

In `single` mode the cluster-wide lock is released *after* the run reports
finished, so a trigger issued the instant the previous run completes is
legitimately refused and retried. That wait lands in the `cycle` throughput
figure but not in the latency sample, which is right both ways: an exclusive
run cannot start until the last one has let go, but the run itself did not
take any longer.

---

## Caveats

- The load generator and every backend share one machine. Absolute numbers are
  environment-specific; the ranking within a group is the point.
- `contention` runs its consumers as separate client instances in one process,
  not as separate processes. That exercises claim atomicity, which is what it
  is for, but it is not a distributed-systems test. The package's own
  `queue-crossprocess.test.ts` covers real separate processes.
- `bun-jobs (memory)` shares one driver between producer and consumer, because
  the memory driver keeps jobs in the instance and there is no other way for
  them to see the same queue. It is in the table for scale, not for comparison.
- Worker maintenance (stalled-job recovery, delayed promotion) stays **on** for
  `bun-jobs`, as it is by default. Turning it off would flatter the figure.
- A drain is timed from the worker starting to the **last job's arrival**, not
  to the poll that noticed it. On the in-process backends the whole drain is a
  few milliseconds and a poll interval would be a tenth of the figure.
- Agenda's `processEvery` must be given as a **number**. A string goes through
  `human-interval`, which returns `NaN` for `"50 ms"` — Agenda then silently
  falls back to its 5-second default, and every Agenda figure becomes that
  default. (`"50 milliseconds"` is worse: it parses as 50000.)
