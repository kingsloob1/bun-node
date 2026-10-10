# Evidence: bun-cache

The evidence behind [`../../bun-cache.md`](../../bun-cache.md). Gathered on
**2026-10-10** on the shared laptop: i9-11900H, 16 threads, Linux
7.0.0-38-generic, Bun **1.4.3** (`bbdc5a519`, the `1.4.3-canary.1` build
installed here). Peer sessions were running, at a load average of 5 to 35
during the runs, so compare figures within one run, not across machines.
Nothing here is part of a published package, and the repo's tooling does not
build, typecheck or lint it ([`../README.md`](../README.md) explains why).

| Path | What it is | Re-run |
|---|---|---|
| `s3-wire.ts` | What Bun's `S3Client` sends and parses, captured against a **recording S3 stub** (`Bun.serve`). It checks whether `type`, `contentEncoding` and `contentDisposition` reach the wire, whether undeclared `metadata`, `ifNoneMatch` or `headers` options are sent, what `stat()` exposes, ranged reads, the list parser, the methods on the prototype, and presign | `bun s3-wire.ts` |
| `sqlite-wal.ts` | SQLite set/get throughput in WAL on a cache-shaped table. It compares `bun:sqlite` (sync, prepared) at `synchronous` NORMAL and FULL with Bun's `SQL` sqlite adapter (async, which bun-jobs uses), at 100 B and 10 KB values | `bun sqlite-wal.ts` |
| `pg-listen.ts` | Postgres `sql.listen` / `sql.notify` latency between two `SQL` instances: sequential, a burst of 500, and the 8000-byte payload limit | `BUN_JOBS_TEST_POSTGRES_URL=… bun pg-listen.ts` |
| `single-flight.ts` | 1000 concurrent misses on one key with and without in-process coalescing. Also 100 keys, a loader that throws, and the per-hit overhead | `bun single-flight.ts` |
| `codecs.ts` | Which value types JSON, `bun:jsc` `serialize` and `node:v8` `serialize` round-trip, their speed and size on a 70 KB payload, and gzip, deflate and zstd on the same bytes | `bun codecs.ts` |
| `notify-probes.ts` | Redis pub/sub latency through `RedisClient`, Redis `notify-keyspace-events`, and whether the local MongoDB opens a change stream (standalone: no), plus its TTL monitor period | `BUN_JOBS_TEST_REDIS_URL=… BUN_JOBS_TEST_MONGODB_URL=… bun notify-probes.ts` |
| `sql-primitives.ts` | On sqlite, postgres, mysql and mariadb: a 1 MiB bytes-column round trip, 200 concurrent atomic increments that return the new value, and an indexed `expires_at` sweep | `BUN_JOBS_TEST_POSTGRES_URL=… BUN_JOBS_TEST_MYSQL_URL=… BUN_JOBS_TEST_MARIADB_URL=… bun sql-primitives.ts` |
| `file-store.ts` | Atomic set (temp file plus `rename`), get, miss, and a full directory walk for 10,000 1 KiB entries, in a flat directory and a two-level 256×256 sharded one | `bun file-store.ts` |
| `codec-crossprocess.ts` | Whether a `bun:jsc` `serialize` buffer of a Blob, a File, a Date and a Map decodes in a second process (a same-process round trip cannot tell copied bytes from a handle) | `bun codec-crossprocess.ts` |
| `typed-slot/` | Whether a cache middleware typed `RouterHandler & { readonly __shape?: never }` turns misplacement between `validate()` and the handler into a type error, against a plain `RouterHandler` | `cd typed-slot && bunx tsc -p .` |
| `keyv-compat/` | A recording Keyv store under cache-manager 7.2.9 with Keyv 5.6.0 and with Keyv 6.1.0: what the store receives (envelope, TTL, namespace, `clear`), and whether `wrap()` and `ttl()` work | `cd keyv-compat/v5 && bun install && cp ../probe.ts . && bun probe.ts` (same for `v6`) |
| `results-*.txt`, `keyv-compat/results.txt` | The captured output of each script | — |

## Before running

- **Databases.** The scripts read the bun-jobs test suites' variables:
  `BUN_JOBS_TEST_POSTGRES_URL`, `_MYSQL_URL`, `_MARIADB_URL`, `_MONGODB_URL`
  and `_REDIS_URL`. Take them from `bun scripts/setup-databases.ts --dry-run`.
  MariaDB is on 3306 and MySQL on 3307. An unset variable skips that backend.
- **Data.** Each script uses names carrying its pid (`cacheplan_<pid>` tables,
  `cacheplan:<pid>` channels, `cacheplan_probe_<pid>` collections) and drops
  exactly those. Temporary files go under `$SPIKE_DIR`, by default
  `~/.cache/bun-node-e6/cacheplan`, and are removed afterwards.
- **S3.** There was no S3-compatible server on this machine (no MinIO image,
  and none was pulled), so `s3-wire.ts` measures **the client only**. What a
  real server does with the same requests (metadata limits, consistency,
  `If-None-Match` support, lifecycle rules) is taken from AWS and MinIO
  documentation and is marked as such in the plan.
- **The keyv probe** needs network access for `bun install` (cache-manager
  7.2.9 plus keyv 5.6.0 or 6.1.0). Pin those exact versions: see the plan's
  §13 on the August 2026 supply-chain incident in that package family.
