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
(`bun add mongodb`).

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
