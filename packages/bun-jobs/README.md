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
- **Drivers** — memory, file, Redis (`Bun.redis`) and SQL (`Bun.sql`:
  postgres, mysql, mariadb, sqlite) behind one contract, so producers,
  consumers and runners in different processes share a backend.
- **Namespaces** — every runner, queue and worker is scoped by a required
  namespace, so services sharing a backend never collide.

Requires **Bun ≥ 1.4.2**.

The package is being assembled in phases; the API reference lands with the
final phase.
