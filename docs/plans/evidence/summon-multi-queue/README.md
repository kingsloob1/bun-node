# Evidence: summon groups

The evidence behind [`../../summon-multi-queue.md`](../../summon-multi-queue.md).
Gathered on **2026-10-06**, on one shared laptop: i9-11900H with 16 threads,
Linux 7.0.0-31-generic, and Bun 1.4.3 (`5f554969`). Peer sessions ran at the
same time, at load average 13 to 27, so compare within a run rather than
across machines. Nothing here is part of a published package, and the repo's
tooling does not build, typecheck or lint it ([`../README.md`](../README.md)
says why).

| Path | What it is | Re-run |
|---|---|---|
| `state-home.ts` | Part 1: a reserved queue-state entry under a queue ref that was never ensured. Does it read back, compare-and-set, list, show up in `listQueues`, and go with `purge`? Part 2: K concurrent read-increment-CAS charges against one shared entry against K separate entries, with K = 1, 4, 16 and 64 (median of 3 rounds) | `bun state-home.ts` |
| `unit-boot.ts`, `unit.ts` | One process with N workers against N one-worker processes, for N = 1, 4 and 8. It measures the time from spawn until every queue has a record the controller counts, and the summed RSS at `ready` (median of 3 rounds) | `bun unit-boot.ts` |
| `results-state-home.txt` | The output of `state-home.ts` on all eight backends | — |
| `results-unit-boot.txt`, `results-unit-boot-run2.txt` | Two runs of `unit-boot.ts`: SQLite, Postgres and Redis, then SQLite and Postgres | — |

## Before running

- **Databases.** The scripts read the test suites' variables:
  `BUN_JOBS_TEST_POSTGRES_URL`, `_MYSQL_URL`, `_MARIADB_URL`, `_MONGODB_URL`
  and `_REDIS_URL`. Take them from `bun scripts/setup-databases.ts --dry-run`.
  An unset variable skips that backend, with a line saying so. memory, file
  and SQLite always run.
- **Data.** Each run uses fresh namespaces (`mqplan-<pid>-<ms>-<backend>`,
  `mqboot-<pid>-<ms>-<backend>`) and purges exactly those. SQL tables use the
  test suites' `bun_jobs_test_` prefix.
- **`bun install`** at the repo root first. The scripts import the package
  source by relative path.
