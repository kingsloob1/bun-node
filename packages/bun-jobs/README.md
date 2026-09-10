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
  mariadb) and MongoDB behind one contract, so producers, consumers and
  runners in different processes share a backend. Redis is next.

| Driver | Cross-process | Cross-host | How exclusivity is won |
|---|---|---|---|
| memory | no | no | one process; tests and single-process apps |
| file | yes | no | `open(…, "wx")` and atomic `rename` |
| sql (sqlite) | yes | yes | `BEGIN IMMEDIATE`, WAL, busy timeout |
| sql (postgres/mysql/mariadb) | yes | yes | `FOR UPDATE SKIP LOCKED` |
| mongodb | yes | yes | one conditional `findOneAndUpdate` |

Every driver takes its connection **either way** — a URL, or the fields a
config file gives you — and lets you name its tables or collections:

```ts
{ type: "sql", url: "postgres://user:pass@db/jobs", tablePrefix: "jobs_" }
{ type: "sql", adapter: "postgres", connection: { host: "db", user, password },
  tables: { jobs: "legacy_work_items" } }
{ type: "mongodb", connection: { host: "db", database: "work" },
  collections: { jobs: "work_items" } }
```

MongoDB's client is an **optional peer dependency**: it is imported only when
that driver connects, so a project that does not use it never installs it
(`bun add mongodb`).

### Running the integration suites

The Redis, Postgres, MariaDB and MongoDB suites skip unless their URL is set.
To provide the servers:

```bash
bun scripts/setup-databases.ts             # install what is missing
bun scripts/setup-databases.ts --docker    # containers instead, no root needed
bun scripts/setup-databases.ts --dry-run   # see the plan first
```

It is safe to run repeatedly: an installed server is never reinstalled, and
configuration runs only when connecting with the expected credentials fails.

- **Namespaces** — every runner, queue and worker is scoped by a required
  namespace, so services sharing a backend never collide.

Requires **Bun ≥ 1.4.2**.

The package is being assembled in phases; the API reference lands with the
final phase.
