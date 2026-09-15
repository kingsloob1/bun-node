# @kingsleyweb/bun-jobs

Background work for Bun, built on [`@kingsleyweb/bun-common`](../bun-common):

- **Runner** — run a JS/TS file on a schedule (cron with optional seconds,
  interval, one-shot) or on demand, in a child process, a `Worker` or
  in-process. Single-run mode holds a cluster-wide lock, queues extra
  triggers, and kills a stuck run with a close → `SIGTERM` → `SIGKILL`
  escalation.
- **Queue** — queue and process jobs across processes and services with
  priorities, delays, retries with backoff, per-attempt timeouts, stalled-job
  recovery, repeatable jobs, retention and events.
- **Drivers** — memory, file, SQL (`Bun.sql`: sqlite, postgres, mysql,
  mariadb), MongoDB and Redis behind one contract, so producers, consumers
  and runners in different processes share a backend.

| Driver | Cross-process | Cross-host | Waiting | How exclusivity is won |
|---|---|---|---|---|
| memory | no | no | local | one process; tests and single-process apps |
| file | yes | no | poll | `open(…, "wx")` and atomic `rename` |
| sql (sqlite) | yes | yes | poll | `BEGIN IMMEDIATE`, WAL, busy timeout |
| sql (postgres/mysql/mariadb) | yes | yes | poll | `FOR UPDATE SKIP LOCKED` |
| mongodb | yes | yes | poll | one conditional `findOneAndUpdate` |
| redis | yes | yes | **blocking** | a Lua script, which runs uninterrupted |

Redis is the only one that waits rather than polls: a worker blocks on the
queue's wake list and hears about a job in about a millisecond. It is also
the only one whose events are pushed rather than polled.

Every driver takes its connection **either way** — a URL, or the fields a
config file gives you — and lets you name its tables or collections:

```ts
import type { DriverConfig } from "@kingsleyweb/bun-jobs";

export const drivers: DriverConfig[] = [
  // A URL, with a prefix applied to every table name.
  { type: "sql", url: "postgres://user:pass@db/jobs", tablePrefix: "jobs_" },

  // The same connection as fields, naming a table that already exists.
  {
    type: "sql",
    adapter: "postgres",
    connection: { host: "db", user: "jobs", password: "secret" },
    tables: { jobs: "legacy_work_items" },
  },

  // MongoDB, naming a collection.
  {
    type: "mongodb",
    connection: { host: "db", database: "work" },
    collections: { jobs: "work_items" },
  },
];
```

MongoDB's client is an **optional peer dependency**: it is imported only when
that driver connects, so a project that does not use it never installs it
(`bun add mongodb`). It needs **MongoDB 4.2 or later**: flows record a
child's outcome with an update pipeline, which older servers reject.

## Flows

A flow is a job that runs once the jobs it waits on — its children — have
settled. Children may be in any queue of the same namespace, and may have
children of their own.

```ts
export const flow = await reports.addFlow({
  name: "monthly-report",
  data: { month: "2026-08" },
  children: [
    { name: "orders", data: {}, queue: "fetch" },
    { name: "refunds", data: {}, queue: "fetch", opts: { ignoreFailure: true } },
  ],
});

export const worker = new BunQueueWorker("reports", async (job) => {
  const values = await job.getChildrenValues(); // { "fetch:<id>": result, ... }
  const failures = await job.getChildrenFailures(); // ignored failures, as Errors
  return build(values, failures);
}, { namespace });
```

`addFlow` returns the tree it added — `{ job, children: [...] }` — with a
parent in `waiting-children` until its children settle.

- **Adding.** The whole tree is checked first: a `queue:id` that appears twice,
  or a child with the id of one of its ancestors, throws a `ConfigError` and
  nothing is written. `repeat`, `debounce` and `throttle` are not allowed in a
  flow. Jobs are then added children first, each parent after its children,
  so a parent's `createdAt` follows every child it lists. A child that
  finishes before its parent exists is delivered as soon as the parent
  arrives. Running the same `addFlow` again with the same ids adds only what
  is missing; a job whose `jobId` already exists keeps the children it has.
  `added` is published on each job's own queue.
- **Results.** `job.getChildrenValues()` gives each completed child's return
  value, keyed `queue:id`. `job.getChildrenFailures()` gives the failures of
  children marked `ignoreFailure`.
- **Failing by default.** A child that fails for good fails its parent: the
  parent goes to `dead` with a `ChildFailedError` naming the child, and that
  failure travels on up the flow. A buried parent gets what any job that dies
  gets — `failed` and `dead` events, its dead-letter queue, and its
  `removeOnFail` when it is the top of the flow. With `removeOnFail: true` a
  buried top-level parent is removed, so it cannot be retried. A nested
  parent's retention waits until its own parent has recorded it, like any
  child's. A child marked `ignoreFailure` lets its parent carry on.
- **Retrying a buried parent** — `queue.retry`, `retryJobs`, `retryAll` or
  `job.retry()` — returns it to `waiting-children`, waiting on every child it
  has no outcome for. Retry the failed child too, in either order: a child that
  completes while its parent is still buried has its result kept there, and a
  failure that has already buried the parent once does not bury the retried
  parent again. A failed child that has since been removed counts as
  unsettled, so maintenance fails the parent again (below).
- **Retention waits for delivery.** A child's `removeOnComplete` or
  `removeOnFail` — including a count or TTL applied by any other job — never
  removes it before its parent has recorded its outcome.

**Healing.** Recording a child on its parent and applying the child's
retention are two steps, and both are repeat-safe. A delivery that fails is
retried within a few seconds by the worker that started it, and workers'
maintenance (every `stalledInterval`) finishes whatever a crash left half done:

- a parent waiting on a child that settled without it knowing is told again;
- a child that finished and was never recorded is delivered again;
- a parent listing a child that does not exist, once the parent is older than
  the grace period (one minute), counts that child as failed;
- a child whose parent does not exist, once it finished more than the grace
  period ago, is released to its own retention.

Each pass reads at most a page of parents, a hundred of their children and a
page of finished jobs, and the next pass resumes where it stopped, so a queue
of any size is covered over successive passes.

**MongoDB** needs 4.2 or later for flows (see above). **SQL** stores a flow
in one `flow` column: a table created before flows needs `syncSchema()` before
a flow can be added, and says so. Recording a child rewrites its parent's whole
flow document, so on SQL a very wide flow costs O(n²) over its n children —
measured on Postgres at 1.4ms per record on a 100-child parent and 3.1ms on a
2,000-child one. Keep very wide fan-outs to nested flows, or use Redis or
MongoDB, which update one entry per record.

## Running the integration suites

The Redis, Postgres, MariaDB and MongoDB suites skip unless their URL is set.
To provide the servers:

```bash
bun scripts/setup-databases.ts             # install what is missing
bun scripts/setup-databases.ts --docker    # containers instead, no root needed
bun scripts/setup-databases.ts --dry-run   # see the plan first
```

It is safe to run repeatedly: an installed server is never reinstalled, and
configuration runs only when connecting with the expected credentials fails.

## Benchmarks

`bench/` compares both halves of this package against the established
alternatives, on Bun:

- the **queue** against BullMQ, bee-queue, node-resque (Redis), pg-boss,
  graphile-worker (Postgres) and Agenda (Mongo, Postgres, Redis);
- the **runner** against Bree, Agenda, croner, node-cron, node-schedule and
  toad-scheduler.

```bash
cd bench && bun install
bun queue.ts --verify     # every contender must deliver each job exactly once
bun queue.ts              # enqueue, drain, round-trip, payload, contention
bun runner.ts             # dispatch, cycle, schedule drift, exclusivity
```

Results are ranked only **within a backend** — a Redis figure beside a Postgres
one measures the database, not the library — and each contender runs in its own
process. `bench/README.md` explains how the configurations are kept comparable.

- **Namespaces** — every runner, queue and worker is scoped by a required
  namespace, so services sharing a backend never collide.

Requires **Bun ≥ 1.4.2**.

The package is being assembled in phases; the API reference lands with the
final phase.
