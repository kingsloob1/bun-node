# `bun-cache` benchmarks

`@kingsleyweb/bun-cache` against the caches people already use, on every
backend this machine can reach, and the regression guard that keeps the
results honest (plan [`docs/plans/bun-cache/`](../../../docs/plans/bun-cache/README.md)
§14.3, §15). It also holds the Keyv compatibility harness PR-K1 runs
`toKeyvStore` through (§13.1, §10.4).

This is a **separate, unpublished package**, like `packages/bun-jobs/bench/`:
its own `package.json`, `bun.lock` and `node_modules`, outside the root
`workspaces`, so no comparator reaches a published package's dependency tree.

## Setup

```bash
cd packages/bun-cache/bench
bun install --frozen-lockfile
```

Every comparator is pinned to an exact version, given the August 2026
supply-chain incident in the Keyv family (poisoned `keyv@6.0.0` and
`cacheable@2.5.1`, since removed: jaredwray/cacheable#1692). The lock is the
pin; a plain `bun install` re-resolves against the registry. The package sets
`trustedDependencies: []`, so **no install script runs**, Bun's default
trusted list included (`bun pm untrusted` lists none).

The servers come from the repository's provisioning script. The benchmark
uses **databases of its own**: `bun_cache_bench` on Postgres, MySQL, MariaDB
and MongoDB, and Redis database **12** (bun-jobs' tests use 15, its bench
14). A long run cannot disturb a test suite, and a test run cannot make a
figure look slow. The script creates them on Postgres, MySQL and MariaDB;
MongoDB creates its database on the first write:

```bash
bun ../../../scripts/setup-databases.ts --dry-run    # the plan first
bun ../../../scripts/setup-databases.ts
bun ../../../scripts/setup-databases.ts --dry-run --print-env | grep BUN_CACHE_BENCH
```

The last prints the `BUN_CACHE_BENCH_*_URL`s, which match the bench's
defaults.

Point a backend elsewhere with `BUN_CACHE_BENCH_REDIS_URL`,
`BUN_CACHE_BENCH_POSTGRES_URL`, `BUN_CACHE_BENCH_MYSQL_URL`,
`BUN_CACHE_BENCH_MARIADB_URL` or `BUN_CACHE_BENCH_MONGODB_URL`. A backend that
does not answer is named at the top of every run, never dropped quietly.

**Own data.** Every child process names what it creates after its own run id
(tables and collections `bcb_<run>_…`, `cm_<run>`, `ca_<run>`, `bento_<run>`;
Redis keys under `bcb-<run>:`, `cm-<run>::`, `ca-<run>::`, `bento-<run>:`),
and deletes exactly those when it ends. The databases stay.

## Run

```bash
bun cache.ts                          # every scenario, every reachable backend
bun cache.ts -b redis                 # one backend
bun cache.ts -s stampede,tags-invalidate
bun cache.ts -c bun-cache-postgres,cache-manager-postgres -s get-hit-100b
bun cache.ts --json > results.json
```

`--help` lists every option. A full run is a heavy job: run it through the
heavy-run wrapper, exclusive (it shares the database servers with the test
suites and asserts nothing about them, but they slow each other):

```bash
HEAVY_TICKET=<session>-bench HEAVY_EXCLUSIVE=1 /tmp/claude-1000/bun-node-heavy-run.sh \
  nice -n 10 timeout 3600 bun cache.ts --compare > <log> 2>&1
```

Every contender runs every scenario in its **own freshly spawned process**:
these libraries hold connection pools, reconnect loops and sweep timers, and a
memory cache keeps whatever the previous scenario left in its heap. Measured
side by side in one process, whoever ran first would tax whoever runs next.

---

## Scenarios

**Results are ranked only within a backend.** A Redis figure next to a
Postgres one measures the database, not the library.

| Scenario | What is timed | Figure |
|---|---|---|
| `get-hit-100b`, `get-hit-10kb`, `get-hit-1mb` | sequential `get`s of written keys (100 keys; 10 at 1 MB) | ops/s |
| `get-miss` | sequential `get`s of keys never written | ops/s |
| `set-100b`, `set-10kb`, `set-1mb` | sequential `set`s, overwriting the same keys | ops/s |
| `get-many-100` | `getMany` / cache-manager's `mget` of 100 written keys | batches/s |
| `set-many-100` | `setMany` / cache-manager's `mset` of 100 entries | batches/s |
| `stampede` | 1,000 concurrent `getOrSet` / `wrap` misses on one key, a 20 ms loader; 7 rounds | the best round's p99 of the callers; loader runs beside it |
| `tags-set` | sets carrying two tags each | ops/s |
| `tags-invalidate` | `invalidateTags` of one tag on 1,000 keys; 7 rounds | the fastest round's call |
| `tier-hit` | `get`s of hot keys through the L1 memory tier, the bus connected (Postgres, Redis) | ops/s |
| `tier-invalidate` | a write in this process to the first read of the new value in a second process holding the key in its L1; 50 writes | median |
| `http-hit` | `router.fetch()` of a route behind `cacheResponse()`, answered `X-Cache: HIT` (memory, Redis) | requests/s |
| `http-304` | the same, with a matching `If-None-Match` | requests/s |
| `http-miss` | the same route, a new query string each time, so every request misses and stores | requests/s |
| `http-uncached` | the same handler with no cache in front | requests/s |

`--ops` (default 2,000) sets the throughput scenarios' size on a networked or
file backend; memory runs ten times as many, the 1 MB scenarios a fortieth,
the batch scenarios a twentieth.

**A throughput figure is the best of five trials.** Each scenario warms up
untimed (a tenth of its operations, and at least 250 ms), then runs five
timed trials of its operations, each at least 100 ms and at most 2 s, and
reports the best. The latency rows do the same with their rounds (the best
round), except `tier-invalidate`, whose 50 samples give a median.
Interference — another process on the core, a database flushing for someone
else, a GC — only ever slows a trial, so the best one is the one it moved
least. Measured: with one trial per scenario, two runs of one unchanged build
differed by 0.75x to 1.42x per figure (10th to 90th percentile of 204
figures, 0.06x at worst: a MariaDB write row), and the first `--compare`
against its own baseline failed 13 figures.

**Every scenario checks what it read.** A hit that comes back wrong or
missing, a key served after its tag was invalidated, a stampede caller
answered something other than the loaded value, or a write the second process
never sees (5 s) makes the row `FAILED`, never a figure. bun-cache's stampede
also fails when its loader runs more than once: single-flight is its claim.

Values are `{ id, body }`, the body an **incompressible** string drawn from a
seeded generator (the same bytes in every process): bun-cache compresses
entries above 16 KiB by default and its rivals do not, and filler like
`"x".repeat(n)` would flatter whoever compresses.

## Contenders

| Backend | Contenders |
|---|---|
| `memory` | **bun-cache**, cache-manager + Keyv's Map store, lru-cache, BentoCache, cacheable |
| `redis` | **bun-cache**, cache-manager + `@keyv/redis`, BentoCache, cacheable + `@keyv/redis` |
| `postgres` | **bun-cache**, cache-manager + `@keyv/postgres`, BentoCache (Knex, `pg`), cacheable + `@keyv/postgres` |
| `mysql`, `mariadb` | **bun-cache**, cache-manager + `@keyv/mysql`, BentoCache (Knex, `mysql2`), cacheable + `@keyv/mysql` |
| `mongodb` | **bun-cache**, cache-manager + `@keyv/mongo`, cacheable + `@keyv/mongo` |
| `file` | **bun-cache**, BentoCache's file driver |
| `sqlite` | **bun-cache** |

Which contender answers which scenario follows §15.1: cache-manager the
get/set, batch and stampede rows (`wrap`), lru-cache the memory get/set rows,
BentoCache the stampede, tags and tier rows, cacheable the tags rows. The
HTTP rows are bun-cache against itself (§15.1: "a baseline against
ourselves"): `http-uncached` is the same handler without the cache.

Versions: cache-manager 7.2.9, keyv 5.6.0, `@keyv/redis` 5.1.6,
`@keyv/postgres` 2.2.3, `@keyv/mysql` 2.1.10, `@keyv/mongo` 3.1.0 (the last
releases that peer on Keyv 5, which cache-manager 7 depends on), lru-cache
11.5.3, bentocache 1.6.1, cacheable 2.5.0.

### What makes a number less than face value

- **lru-cache holds the object by reference**: no copy and no codec, so a hit
  returns the caller's own object. It is the floor a memory cache's own work is
  measured against, and it leads every memory get/set row by a wide margin.
  bun-cache's memory driver stores encoded bytes, so a hit is a fresh copy.
- **cache-manager's memory store is Keyv's Map**, which keeps Keyv's JSON
  envelope: a hit is a `JSON.parse`, and a `Date` comes back a string.
- **Every `stampede` row runs its library's defaults**: bun-cache's
  `getOrSet` takes no cross-process lock unless asked (`lock`), and
  cache-manager's `wrap` and BentoCache's `getOrSet` coalesce inside one
  process. The rows compare one process's 1,000 callers, not a fleet's.
- **Tag invalidation is eager in bun-cache on index-mode drivers** (the
  tagged entries are deleted inside `invalidateTags`) and **lazy in
  BentoCache and cacheable** (a stamp, checked by the next read). The
  `tags-invalidate` figure is the call alone; the lazy libraries pay on later
  reads, which no row here times.
- **cacheable runs two layers** (its documented default): an in-memory
  primary over the backend's Keyv store. Its reads after a write are answered
  by the primary.
- **BentoCache runs on its L2 alone** outside the tier rows, as bun-cache runs
  on its driver alone, so the two are compared layer for layer. It has **no
  Postgres bus**: in the Postgres tier rows its bus is Redis.
- **`tier-invalidate` does not prove a rival's L1 held the key**: a reader with
  no working L1 would see each write at once. bun-cache's tier is shown working
  by `tier-hit` (an order of magnitude above its L2), BentoCache's likewise.
- **No Keyv store for SQLite or files**: `@keyv/sqlite` runs on the native
  `sqlite3`, whose binary arrives only through an install script, and this
  package trusts none. Those backends have no cache-manager row.
- **A baseline is only meaningful on the machine that recorded it.**

---

## The regression guard

```bash
bun cache.ts --compare          # fails if anything regressed against baselines/cache.json
bun cache.ts --save-baseline    # re-record, after a deliberate change
```

The design is bun-jobs' (`../../bun-jobs/bench/lib/compare.ts`), copied:

- `baselines/cache.json` records each of bun-cache's figures, **the best
  rival's figure and who led**, the platform and the Bun version and revision.
- `--compare` fails when a figure falls more than **35%** behind its own
  baseline (`TOLERANCE`: bun-jobs' calibration, kept until bun-cache's own
  run-to-run spread is measured), **or when a rival we led has overtaken us**.
  The overtaken check is the sharper one: a busy machine slows both sides.
- It fails when a figure the baseline has was attempted and not produced (the
  run failed or answered wrongly): a scenario dropping out is how a guard
  stops guarding.
- **A row that moved is measured again before it is believed**: every
  contender of that row, in fresh processes, up to twice more, keeping each
  one's best figure. A child scheduled beside a busy hyperthread runs at
  about half speed for its whole life, which five trials inside it cannot
  undo (measured: one row of 205 in a `--compare` of an unchanged tree, a
  `get-miss` on memory at 0.48x); a real regression is slow in every process
  and stays. A run that failed or answered wrongly is never re-measured.
- It never fails on an improvement, and only checks the figures a run
  attempted, so `-b redis` is an ordinary thing to ask.

Two differences from bun-jobs':

- **A lead is lost only past a 10% margin** (`OVERTAKE_MARGIN`). bun-jobs'
  leads are factors; several cache rows are near-ties by construction (a
  stampede's p99 is mostly its 20 ms loader, whoever runs it), and a strict
  reversal flips on noise there. A baseline within 10% records the row as a
  `tie`, which guards the figure against its own past but not against the
  rival.
- **A run of bun-cache's that fails when the baseline is recorded** is written
  under the baseline's `failed`, with why, and printed — a wrong answer is a
  finding, not a figure — rather than left out. `--compare` lists those as
  not guarded until they pass and are re-recorded.

## The Keyv compatibility harness

```bash
bun run compat                  # bun test --check ./compat/keyv.compat.ts ./compat/toKeyvStore.compat.ts
```

`compat/harness.ts` drives a Keyv store adapter through the **real**
cache-manager 7.2.9 over Keyv 5.6.0 and over Keyv 6.1.0 (installed side by
side, the second as `keyv-6`); `compat/contract.ts`'s `describeKeyvCompat`
registers the cases an adapter must pass under each (round trip, the JSON
envelope's `Date`, misses, `mset`/`mget`, `del`, expiry, a namespaced
`clear()` that spares a second cache's keys). `compat/toKeyvStore.compat.ts`
(PR-K1) runs `toKeyvStore` through it:

```ts
describeKeyvCompat("toKeyvStore over memory", () => {
  const cache = createCache({ driver: memoryDriver() });
  return { store: () => toKeyvStore(cache), close: () => cache.close() };
});
```

on memory, a SQLite file, Postgres and Redis (`BUN_CACHE_BENCH_POSTGRES_URL`
and `BUN_CACHE_BENCH_REDIS_URL`; unset, each skips by name; its tables and keys
carry the run's id and are deleted by those exact names), then checks what
each major hands the store against what bun-cache stored (one serialisation,
the TTL's unit, namespaces set late, serialisation off, errors as events), and
drives it through `@nestjs/cache-manager` 12.0.1's `CacheModule.register({
stores: [toKeyvStore(cache)] })` with `@nestjs/common` and `@nestjs/core`
12.2.0 (the repository's Nest), `rxjs` 7.8.2 and `reflect-metadata` 0.2.2,
pinned like the rest. The contract alone cannot see a store's TTL: Keyv checks
its envelope's own `expires` on every read, so a store that kept an entry a
thousand times too long still reads as expired. The adapter's own cases read
the stored expiry for that reason.

`compat/keyv.compat.ts` proves the harness on a reference store (a full Keyv
6 storage adapter with a store-managed namespace; without one, Keyv 6's
namespaced `clear()` throws) and pins what the plan measured
(`docs/plans/bun-cache/evidence/keyv-compat/`): under Keyv 5, `wrap()` runs
the loader once for three concurrent calls, `ttl()` answers an absolute
timestamp and the store sees namespace `keyv` and `keyv:`-prefixed keys;
under Keyv 6, `wrap()` runs it twice, `ttl()` answers `undefined` and the
store sees bare keys. A release that changes any of that fails the file.

The files are named `.compat.ts`, not `.test.ts`: bun-cache's own `bun test`
walks into nested directories and would run a `*.test.ts` here (measured).

---

## What the baseline says

Recorded 2026-10-29 on the shared 16-thread development machine (Linux x64,
Bun 1.4.4-canary.1+11c367163), `--ops 2000`, exclusive under the heavy-run
wrapper, against the bench databases: 108 figures, 75 of them with a rival.
bun-cache leads 20, ties 10 (within 10%) and trails 45;
`baselines/cache.json` has every figure.

- **Where it leads**: Redis and SQL reads (`get-hit-100b` 1.1x to 1.45x over
  cache-manager on Redis, Postgres, MySQL and MariaDB; `get-hit-10kb` 1.15x to
  1.6x), `getMany` on memory, MySQL and MariaDB, writes on MongoDB, the L1
  tier (`tier-hit` 2.2x to 2.6x over BentoCache's L1; `tier-invalidate` a
  433 µs median on Redis against 508 µs, 1.67 ms on Postgres against
  2.25 ms), and the stampede on file (21 ms p99 against BentoCache's 54 ms).
- **The stampede ties cache-manager on every backend** (20.9–24.0 ms p99
  against 20.9–23.1 ms). Before the core fix below it trailed on every
  networked backend (29–31 ms): `getOrSet` read the driver before joining the
  in-process flight, so 1,000 concurrent misses made 1,000 reads.
- **Where it trails, by design**: lru-cache on every memory row (a reference
  against a copy through a codec); lazy tag invalidation (BentoCache,
  cacheable: a stamp) against bun-cache's eager delete. `tags-invalidate` on
  memory and file is about 1.1–1.2 ms, most of it the up-to-1 ms wait the
  fence fix added to `invalidateTags` (#573).
- **Where it trails, and a later PR should look**:
  - `setMany` of 100 is 2.9x (memory) to 28x (Postgres: 16 against 453
    batches/s) behind cache-manager's `mset` on every backend.
  - `get-miss` is 1.3x to 2.2x behind on every networked backend.
  - Writes of 1 MB values are slower everywhere but MongoDB (Redis 219
    against 1,394/s): the default zstd above 16 KiB, on incompressible data.
  - `tags-set` trails BentoCache everywhere but MongoDB (1.5x to 2.0x).
  - `invalidateTags` of 1,000 keys on MySQL takes 268 ms (MariaDB 28 ms,
    Postgres 7 ms).
- **On Redis, a cached HTTP hit (21,675 requests/s) is slower than running
  the 10 KB handler uncached (49,178/s)**; on memory the hit wins (77,751
  against 54,609/s). A route is worth caching on a networked store only when
  its handler costs more than a round trip and a decode.
- **A core bug the bench found, fixed in the same PR**: on MongoDB the
  stampede's loader ran **twice** for 1,000 concurrent callers in one
  process, every round. The reads queued for about 210 ms, longer than the
  20 ms load and its write, so the callers whose miss arrived after the
  first flight settled led a second one. `getOrSet` now joins a running load
  before reading, shares one read among the callers that ask while it runs,
  and reads again when a load settled under its read (bun-cache's README,
  "Stampede protection"). The row passes and is guarded.
- **Rivals that failed their own check**: `@keyv/mysql` does not serve back a
  1 MB value (`get-hit-1mb`, `set-1mb` on MySQL and MariaDB).
