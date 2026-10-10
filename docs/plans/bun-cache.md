# bun-cache: caching over pluggable drivers, with HTTP and Nest utilities

Implementation plan for a new package, **`@kingsleyweb/bun-cache`**, and for
the caching utilities built on it:

- **The package**: a cache with one API over ten drivers. Nine are built in:
  memory, file, SQLite, Postgres, MySQL, MariaDB, MongoDB, S3 (Bun's
  `S3Client`) and Redis. The tenth is a custom driver the user writes, with a
  conformance kit to check it.
- **The HTTP utilities**: a response-cache middleware, a `Cache-Control`
  helper and request coalescing for bun-common's `BunRouter`. They work
  through both HTTP adapters, bun-common's `BunHttpAdapter` and bun-nest's.
- **The Nest utilities**: a module, an injection decorator, service method
  decorators and an HTTP interceptor in bun-nest, with a bridge to
  `@nestjs/cache-manager`.

The user asked for this in these words: *"I also want a plan to implement
bun-cache which expose caching using all supported bun drivers (file, memory,
sqlite, postgres, mariadb, mysql, mongodb, bun file (s3 compatible file
system), custom driver). After bun-cache is implemented, i want the plan to
include how to add some utilities as both middlewares for bun-router (both
http adapters) and decorators for bun-nest to aid caching."* Later they added
redundant drivers (§5), whether bun-jobs needs them too (§16), and a survey of
prior art (§11, §12).

Written 2026-10-10 against `develop` at `bbe11201`. **No product code was
changed.** Every `file:line` is at `bbe11201` and relative to `packages/`
unless it says otherwise. The evidence is in
[`evidence/bun-cache/`](evidence/bun-cache/README.md), and each measurement
there can be re-run with one command.

### Contents

1. [Executive summary](#1-executive-summary)
2. [What exists today](#2-what-exists-today)
3. [The core API](#3-the-core-api)
4. [Multi-tier: L1 memory over a shared L2](#4-multi-tier-l1-memory-over-a-shared-l2)
5. [Redundant drivers](#5-redundant-drivers)
6. [The driver contract](#6-the-driver-contract)
7. [The drivers](#7-the-drivers)
8. [A shared driver layer with bun-jobs?](#8-a-shared-driver-layer-with-bun-jobs)
9. [HTTP utilities for BunRouter](#9-http-utilities-for-bunrouter)
10. [bun-nest](#10-bun-nest)
11. [Prior art](#11-prior-art)
12. [Robustness and resilience recommendations](#12-robustness-and-resilience-recommendations)
13. [Testing](#13-testing)
14. [Packaging](#14-packaging)
15. [Benchmarks and the regression guard](#15-benchmarks-and-the-regression-guard)
16. [Redundant drivers for bun-jobs: assessment](#16-redundant-drivers-for-bun-jobs-assessment)
17. [Measured evidence](#17-measured-evidence)
18. [Risks](#18-risks)
19. [Open questions for the user](#19-open-questions-for-the-user)
20. [PR slicing and effort](#20-pr-slicing-and-effort)
21. [Names needing approval](#21-names-needing-approval)

### How to read the markings

These are the same marks the other plans use:

| Mark | Meaning |
|---|---|
| **[S]** | Read in this repo's source at `bbe11201`. The `file:line` is given |
| **[M]** | Measured here by a spike that can be re-run. The evidence file is named |
| **[W]** | Read on the web from a primary source (docs, source or RFC) at a pinned version. The link is given |
| **[I]** | Inference. A claim to test, never a finding |
| **[U]** | Unverified. Nothing may rest on it |
| **[D]** | A design decision this plan proposes |

---

## 1. Executive summary

### 1.1 The one-paragraph answer

**bun-cache is a small core over a byte-level driver contract.**

- **The core** owns everything that should behave the same on every backend:
  - keys, namespaces and TTLs;
  - the value codec and compression;
  - `getOrSet` with single-flight;
  - stale-while-revalidate and stale-if-error;
  - the tag fence;
  - events, statistics and the failure policy.
- **A driver** stores opaque entries. Each entry is a `Uint8Array` with an
  absolute expiry and a list of tags. Beyond that, a driver implements only
  what its backend can do atomically: delete by tag, increment, lock and
  notify. It declares the rest as missing in its `capabilities`, and the core
  either emulates the missing piece or refuses it, the same way on every
  backend.

**The drivers:**

- Memory, file, SQLite, Postgres, MySQL and MariaDB, MongoDB, Redis and S3.
  Every one except MongoDB uses Bun built-ins. MongoDB stays an optional peer,
  as it is in bun-jobs.
- A custom driver implements the same interface and passes the same
  conformance suite. That suite is published as
  `@kingsleyweb/bun-cache/testing`.

**Multi-tier** is an L1 memory cache in front of any driver. A bus keeps the
L1 caches of different processes coherent. The bus is Postgres
`LISTEN`/`NOTIFY` (measured median 0.14 ms), Redis pub/sub (0.04 ms), or
polling of an invalidation log everywhere else. MongoDB change streams are
refused on a standalone server, measured, so MongoDB uses a capped collection
instead.

**The HTTP utilities:**

- They live in `@kingsleyweb/bun-cache/http`, built on bun-common's response
  transforms (`addResponseTransform`, `bun-common/lib/BunResponse.ts:1306`).
  `compression()` already uses the same hook.
- A cache hit is sent with `res.send(bytes)`. bun-common's own ETag and
  freshness logic then answers `304`s for free (`BunResponse.ts:1794-1806`).
- `cacheControl()` is a pure header helper, so it goes into bun-common.

**bun-nest gains a `./cache` subpath** with `bun-cache` as an optional peer,
exactly like `./jobs`. It also gets a Keyv store adapter (Keyv is the
key-value layer `@nestjs/cache-manager` builds on), so existing
`@nestjs/cache-manager` code can run on bun-cache's drivers.

### 1.2 The decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Drivers store bytes; the core owns the codec.** An entry is `{ value: Uint8Array, expiresAt, tags }`, and its first bytes are a small header: version, codec, compression, `freshUntil`, `createdAt` and the full key. | Behaviour then does not vary by backend: a `Date` comes back as a `Date` on Redis and on S3 alike. A custom driver can be ~200 lines, and the conformance suite tests one thing. §3.2 |
| D2 | **The default codec is structured clone (`bun:jsc` `serialize`). JSON is opt-in.** | JSON silently turns `Date`, `Map`, `Set` and `Uint8Array` into something else, and throws on `BigInt` [M `codecs.ts`]. A typed cache whose `Date` reads back as a `string` would be lying. Structured clone round-trips them all, and a `Blob`'s bytes, across processes too [M `codec-crossprocess.ts`]. It costs about 3.5× JSON's encode time and equal decode time on a 70 KB payload, at half the size. §3.10 |
| D3 | **`getOrSet` is single-flight in process, always. A distributed lock is opt-in per call or per cache, on drivers that can lock.** | 1000 concurrent misses ran the loader once, against 1000 times without single-flight, and the coalescing map cost nothing measurable on hits [M `single-flight.ts`]. A cross-process lock costs a round trip on every miss, which is worth paying only for expensive loaders. §3.4 |
| D4 | **Stale-while-revalidate, stale-if-error, soft and hard loader timeouts, eager refresh and TTL jitter are per entry, all in the core.** The driver keeps an entry until its *hard* expiry, `freshUntil + max(swr, sie)`. | One implementation instead of nine. The driver needs to know only one expiry. §3.5 |
| D5 | **Tags are deleted eagerly where the backend has an index**: memory, SQLite, SQL, Redis and MongoDB, through `deleteByTags`. A write-side fence covers the race. **Where it has no index**, on file, S3 and custom drivers without `deleteByTags`, tags are **lazy timestamps checked on read**, the design FusionCache, .NET HybridCache, Symfony and BentoCache use (§11). | On an indexed backend, eager deletion costs reads nothing and frees the space. The fence refuses a `set` whose tags were invalidated after its loader started, the race eager deletion otherwise has. On S3, eager deletion would cost 2 requests per tagged key, because Bun's client has no batch delete [M]. Lazy stamps there cost one cached read. §3.6 |
| D6 | **Atomic increment is native where a backend has it** (SQL, Redis, MongoDB, memory, SQLite, and file under a lock). **On S3 it throws `UnsupportedOperationError`.** | Measured: 200 concurrent increments came out exact on all four SQL engines [M `sql-primitives.ts`]. Bun's `S3Client` sends no conditional headers [M `s3-wire.ts`], so an S3 counter would be a race dressed as a counter. §3.8 |
| D7 | **SQLite uses `bun:sqlite` directly, not Bun's `SQL` sqlite adapter** (which bun-jobs uses). | Hits ran at 402k/s through `bun:sqlite` against 82k/s through `SQL` (100 B values, WAL) [M `sqlite-wal.ts`]. A cache is read-heavy. §7.3 |
| D8 | **Failure policy: a cache that is down is bypassed, never fatal.** Reads that fail are misses, failed writes are logged, each driver has a circuit, and each operation has a timeout. `strict: true` restores throwing. | A cache outage must not become an application outage, or a herd onto the origin with nothing to absorb it. §3.14 |
| D9 | **Do not share a driver layer with bun-jobs now.** bun-cache starts with its own small SQL layer. The schema-sync engine is extracted into a shared package later, when bun-cache's schema first changes. | The generic part of bun-jobs' SQL driver is about 8% of it (about 770 of 9,335 lines) [S, §8]. A cache needs about a dozen statements per dialect. Extraction would put a large bun-jobs refactor on bun-cache's critical path. §8 |
| D10 | **The response cache lives in `bun-cache/http`; `cacheControl()` lives in bun-common.** | The response cache needs a store, and bun-common must not depend on bun-cache. `cacheControl()` needs no store, and users without bun-cache want it. §9 |
| D11 | **bun-nest gets a `./cache` subpath with `@kingsleyweb/bun-cache` as an optional peer, modelled on `./jobs`.** | The pattern is proven: the consumer check covers both the optional-peer and no-peer consumers (`bun-nest/consumer-check.json`). §10.5 |
| D12 | **Ship a Keyv store adapter for `@nestjs/cache-manager`, and document the pairing as Keyv 5.6.0.** | Keyv is the only seam `@nestjs/cache-manager` exposes. Measured: with cache-manager 7.2.9 and Keyv 6.1.0, `wrap()` calls the loader on every call and `ttl()` returns `undefined`; with Keyv 5.6.0 both work [M `keyv-compat/`]. §10.4 |
| D13 | **Redundant drivers are a driver combinator, `redundant([a, b], { write: "all", read: "failover" })`, built last and only if a workload asks.** | It composes with tiers for free, because it is just another driver. Most deployments get better redundancy from the backend's own replication. §5 |
| D14 | **bun-jobs should not get redundant drivers. Document each driver's behaviour across a database failover instead.** | Every queue guarantee rests on one atomic conditional write on one backend [S, §16]. Write-all redundancy breaks claim-once outright. |

### 1.3 What it costs

| Part | Effort | Owner (§19 Q3) | Depends on |
|---|---|---|---|
| Core, memory driver, codecs, conformance kit | ~6 d | bun-cache | — |
| File, SQLite drivers | ~4.5 d | bun-cache | core |
| SQL driver (Postgres, MySQL, MariaDB) | ~4 d | bun-cache, bun-jobs agent reviews | core |
| Redis, MongoDB drivers | ~5 d | bun-cache, bun-jobs agent reviews | core |
| S3 driver, SeaweedFS in `setup-databases.ts` | ~3.5 d | bun-cache | core |
| Multi-tier and the bus | ~4 d | bun-cache | core, one networked driver |
| **The package** | **~27 d** | | |
| `cacheControl()`, transform ordering (bun-common) | ~1.5 d | bun-common agent | — |
| Response cache, coalescing (`bun-cache/http`) | ~4.5 d | bun-cache, bun-common agent reviews | core, H0 |
| HTTP stale-while-revalidate, stale-if-error, streams | ~2 d | bun-cache | H1 |
| bun-nest `./cache`: module, decorators, interceptor | ~5 d | bun-nest agent | core |
| Keyv adapter and docs | ~1.5 d | bun-cache | core |
| **The utilities** | **~14.5 d** | | |
| Benchmarks and baselines | ~3 d | bun-cache | the drivers |
| Redundant drivers (optional, last) | ~4 d | bun-cache | multi-tier |
| Examples, playground | *~4 d (examples agent, bun-jobs-ui agent)* | | each PR |

§20 has the PRs.

---

## 2. What exists today

### 2.1 No cache anywhere

No package caches values or responses today [S].

- The router has a cache of its own, but it is a **route-match** cache:
  `getCacheKey` (`bun-common/lib/BunRouter.ts:4562`), `clearRouteCache`
  (`:4656`) and `routeCacheMax`. bun-cache's names must not collide with
  these (§21).
- `sendFile` and `serveStatic` set `Cache-Control` for static files
  (`bun-common/lib/BunResponse.ts:2779-2802`, `serveStatic.ts:375`).
- `compression()` honours `no-transform` (`compression.ts:1250`).
- `req.fresh` reads a request's conditional headers
  (`bun-common/lib/BunRequest.ts:5286-5332`).

### 2.2 The hook points the HTTP utilities need [S]

| Need | Where | What it gives |
|---|---|---|
| Answer from the cache | `res.status()`, `res.set()`, `res.send(bytes)` without calling `next()` | The pipeline ends at a layer that responded and did not call `next()` (`BunRouter.ts:5638-5647`) |
| `304` for free | `BunResponse.send` with binary data sets the ETag and applies freshness (`BunResponse.ts:1790-1819`, `#applyFreshnessAndStrip` at `:1513`) | A stored `ETag` plus a matching `If-None-Match` gives a `304` with no work in the middleware |
| Capture what the handler produced | `res.addResponseTransform(t)` (`BunResponse.ts:1306`). Transforms run synchronously, in registration order, from the `response` setter, after ETag and freshness (`:1326`). `context.body` is the buffered text, bytes or Blob, and is `undefined` for streams and for 204, 205 and 304 | `compression()` is the precedent (`compression.ts:1401-1420`) |
| Revalidate in the background | `router.fetch(request)` runs the real pipeline with no socket (`BunRouter.ts:4590-4654`); the adapters override it to run `handleNativeRequest` (`bun-common/lib/BunHttpAdapter.ts:611`) | A stale hit can be refreshed by replaying the request internally |
| HEAD | A route with no HEAD handler answers HEAD with its GET handler (`BunRouter.ts:4703-4718`); the body is dropped on the wire, and by `toFetchResponse` for `fetch()` (`BunResponse.ts:446-461`) | HEAD and GET share one cache entry |

**Four limits found** [S]:

- **Transform order.** A transform registered by `compression()` before the
  cache's transform hands the cache an already-compressed `Response` with
  `body: undefined`. Registering the cache first does not help either: a hit
  that does not call `next()` never reaches `compression()`, so it would be
  served uncompressed. The cache needs to register its transform **ahead of**
  the others. That is a small bun-common change (PR-H0, §9.7).
- **Responses that bypass transforms.** An error that reaches the adapter's
  final handler is answered on a **fresh** `BunResponse`
  (`bun-common/lib/BunHttpAdapter.ts:676`; bun-nest `BunHttpAdapter.ts:1077`).
  The default 404 is a bare `new Response` (`bun-common/lib/BunHttpAdapter.ts:521`).
  Neither passes through transforms. So stale-if-error covers 5xx responses
  that the app's own error handlers produce, not unhandled errors (§9.4).
- **The typed overloads.** A plain middleware placed **between** `validate()`
  and the handler compiles, but silently drops the validated `query` and
  `body` types. Branding the middleware `__shape?: never` turns that into a
  type error wherever the handler touches `req.query` [M `typed-slot/`, §9.6].
- **bun-nest router middleware runs below Nest's pipeline.** Guards and
  interceptors do not apply to it (`bun-nest/lib/BunHttpAdapter.ts:1629-1632`).
  A response cache mounted with `app.use()` in Nest would serve cached bodies
  **before any guard runs**. In Nest, the interceptor is the safe tool
  (§10.3).

### 2.3 bun-jobs' drivers: the prior art in this repo [S]

bun-jobs runs one contract over memory, file, SQL (Postgres, MySQL, MariaDB
and SQLite through Bun's `SQL`), MongoDB and Redis. These are the parts a
cache can learn from:

- **Configuration.** `DriverConfig` must survive `JSON.stringify`, because
  child processes receive it (`bun-jobs/lib/drivers/driver.ts:2882-2890`). So
  a shared client can only be passed to a constructor, never through a config.
  A driver closes only the clients it built: `#ownsConnection = !options.sql`
  (`sql/sql-driver.ts:1681`), and the same rule holds for MongoDB (`:1679`)
  and Redis (`redis-driver.ts:769`). bun-cache keeps this rule.
- **MySQL's `allowPublicKeyRetrieval`** is taken out of the URL and passed as
  a `SQL` option (`bun-jobs/lib/shared/connection.ts:161-206`), because Bun
  ignores it in a URL (CLAUDE.md). bun-cache must do the same.
- **SQLite pragmas**: WAL, `synchronous=NORMAL` and `busy_timeout=50`. The
  timeout is deliberately small. A sync busy handler blocks the event loop
  that must run the lock holder's `COMMIT`, so two connections in one process
  deadlock for the whole timeout (`sql/dialect.ts:1925-1939`, measured
  there). Waiting happens in JS, in `withLockRetry`. **This applies even more
  to `bun:sqlite`, which is fully synchronous** (§7.3).
- **Notify.** Postgres uses `sql.listen` for job arrivals
  (`sql/arrivals.ts:230-260`), with polling as the correctness floor. MySQL,
  MariaDB and SQLite only poll. MongoDB polls, deliberately, with no change
  streams (`mongo/mongo-driver.ts:1560-1565`). Redis uses pub/sub.
- **Schema.** Tables are created `IF NOT EXISTS`. `syncSchema` adds columns
  and rebuilds indexes safely, `dryRun` returns the plan, and only indexes
  named `ix_…` are ever dropped (`sql/sync.ts:285-300`).
- **What is missing for a cache.** None of the four dialects has a bytes
  column type (`sql/dialect.ts`); bun-jobs stores JSON as `JSON` or `TEXT`.
  MongoDB uses no TTL indexes. The file driver does no directory sharding
  (`file-names.ts` only encodes names).
- **Tests.** An unset URL variable skips its backend, visibly. A URL that is
  set but unreachable fails, naming the backend
  (`bun-jobs/__tests__/helpers/backends.ts:101-147`).

---

## 3. The core API

### 3.1 Shape [D]

```ts
import { createCache, sqliteDriver } from "@kingsleyweb/bun-cache";

const cache = createCache({
  driver: sqliteDriver({ path: "./cache.db" }), // any CacheDriver
  namespace: "app",          // every key is stored as app:<key>
  ttl: 60_000,               // ms; null = no expiry; or (value) => ms
  codec: "structured",       // "structured" | "json" | "raw" | Codec
  compress: { threshold: 16 * 1024 }, // zstd above 16 KiB; false to disable
  maxEntryBytes: 4 * 1024 * 1024,
  logger,                    // LoggerLike (bun-common)
});

await cache.set("user:42", user, { ttl: 300_000, tags: ["users", "org:7"] });
const u = await cache.get("user:42");               // User | undefined
const v = await cache.getOrSet("report:q3", () => buildReport(), {
  ttl: 600_000,
  staleWhileRevalidate: 60_000,
  staleIfError: 3_600_000,
  lock: true,                // cross-process, on drivers that can lock
});
await cache.invalidateTags(["org:7"]);
const n = await cache.increment("hits:/home", 1, { ttl: 86_400_000 });
const users = cache.namespace("users");             // app:users:<key>
const cachedFetch = cache.wrap(fetchUser, { key: (id: number) => `user:${id}`, ttl: 60_000 });
```

**The `Cache<Schema>` methods:**

| Group | Methods |
|---|---|
| Read | `get(key)`, `getEntry(key)` (value with `freshUntil`, `expiresAt`, `tags`, `createdAt` and `stale`), `has(key)`, `getMany(keys)` |
| Write | `set(key, value, opts?)`, `setMany(entries)`, `touch(key, ttl)` |
| Delete | `delete(key)` (returns `boolean`), `deleteMany(keys)` (returns a count), `clear()` (this namespace only), `invalidateTags(tags, { mode? })` |
| Load | `getOrSet(key, loader, opts?)`, `wrap(fn, { key, ...opts })` |
| Counters | `increment(key, by?, opts?)`, `decrement(key, by?, opts?)` |
| Scope | `namespace(name)` |
| Observe | `on(event, listener)`, `stats()` |
| Lifecycle | `close()`, `syncSchema(opts?)` (passed to the driver) |

**Time and size units.** Every duration is in **milliseconds**, as in
bun-jobs. An absolute expiry is `expiresAt: Date | number`, an epoch in ms.
`ttl` and `expiresAt` are exclusive. `ttl: null` means no expiry.

### 3.2 The stored entry [D]

```
StoredEntry (what a driver sees)
  key        string            namespaced and, when too long, hashed (below)
  value      Uint8Array        header + payload (opaque to the driver)
  expiresAt  number | null     hard expiry, epoch ms
  tags       readonly string[]

value = header + payload
  magic "BC" | format 1 | codec id | flags (compressed, counter)
  createdAt   f64  epoch ms, when the loader started (the tag fence reads it)
  freshUntil  f64  epoch ms
  key length + full key   (to detect hash collisions, §3.7)
  payload     codec bytes, zstd-compressed when flagged
```

- **The core decodes the header, the driver never does.** The driver uses
  `expiresAt` for its native TTL or its sweeper. The header's `freshUntil` is
  what makes an entry stale before it is gone.
- **The codec id is per entry**, so changing the cache's codec needs no flush.
  Old entries decode with the codec they were written with.
- **An entry that fails to decode is a miss.** It is deleted and an `error`
  event fires with `phase: "decode"`. That covers a format change, corruption
  and a `bun:jsc` format a newer Bun wrote (§18).

### 3.3 TTL and expiry [D]

- **Where expiry is enforced.** It is checked on every read, against the
  caller's clock, in the core. The driver's own mechanism only reclaims
  space: a native TTL, a sweeper, a MongoDB TTL index (§7). A driver that
  returns an expired entry is not wrong, merely late.
- **Fresh and hard expiry.**
  - `freshUntil = now + ttl`.
  - `expiresAt = freshUntil + max(staleWhileRevalidate, staleIfError, 0)`.
- **Jitter.** `jitter: 0.1` spreads each TTL by up to ±10%, so entries
  written together do not all expire together. **Default 0**, opt-in (§12).
- **Clocks.** The core uses `Date.now()` of the process that writes, as
  bun-jobs does [S, §16]. A skew between hosts shifts expiry by the size of
  the skew. That is documented, not corrected.

### 3.4 `getOrSet`, `wrap` and stampede protection [D]

**The order of operations:**

1. **Read.** A fresh hit returns at once. A stale hit goes to §3.5.
2. **Join or lead the flight for this key.** The in-process single-flight map
   is keyed by the namespaced key. The first caller leads; everyone else
   awaits the leader's promise.
   - Measured: 1000 concurrent misses ran the loader **once** and returned a
     single value. A loader that throws rejects all 1000 callers with the one
     error, and the next call runs the loader again
     [M `single-flight.ts`].
3. **Optional cross-process lock** (`lock: true | { ttl, wait }`), only for
   the leader, only on drivers with `capabilities.lock`.
   - The leader takes `lock:<key>` for `ttl` (default 30 s, or the hard
     timeout).
   - A process that loses the race polls `get` every `wait.interval` (default
     50 ms, with backoff) until a value appears, the lock frees, or
     `wait.timeout` passes. On a bus-equipped cache it wakes on the bus
     instead.
   - After `wait.timeout` (default 5 s) it runs the loader itself
     (`onLockTimeout: "load"`, the default), or throws (`"throw"`). Like
     nginx's `proxy_cache_lock_timeout`, a lock never turns a slow loader
     into an outage.
   - The leader releases its lock with a compare-and-delete on its own owner
     token, so it never frees a lock that expired and was taken by someone
     else.
4. **Load**, with the soft and hard timeouts of §3.5.
5. **Write**, with the tag fence (§3.6), then **release** the lock.

**Rules for the flight** (Go's `singleflight`, moka, HybridCache, nginx;
§11):

- **Delete and clear forget the flight.** A `delete`, `invalidateTags` or
  `clear` that lands while a load is running **forgets** that key's flight.
  Callers arriving afterwards start a new load instead of joining one whose
  result is already stale, and the old flight's write is fenced or dropped.
- **A flight deletes only itself.** Its map entry is removed only if it is
  still the flight's own entry.
- **Cancellation.** `getOrSet(key, loader, { signal })`: the loader receives
  an `AbortSignal` that aborts only when **every** waiting caller has
  aborted. One impatient caller cannot cancel the work others are waiting
  for (HybridCache's rule).
- **Lock timeout.** A waiter that gives up on the lock and loads on its own
  (`onLockTimeout: "load"`) **does not store** its result, as nginx does
  after `proxy_cache_lock_timeout`. The lock holder's write stays the one
  that counts.

**On drivers without a lock** (S3, and custom drivers that declare none),
`lock: true` logs one `warn` per cache and falls back to single-flight only.
**On memory**, the lock is the in-process map.

**`wrap(fn, { key, ...opts })`** returns a function with `fn`'s parameters
whose result goes through `getOrSet`. `key` receives the same arguments, so
it is typed from `fn` (§3.13).

**Negative caching** [D]. A loader that returns `undefined` is not cached by
default. That matches what `get` returns for a miss. `cacheUndefined: true`
stores a marker; `negativeTtl` gives it a TTL of its own. `null` is a value
and is cached.

### 3.5 Stale-while-revalidate, stale-if-error, timeouts, eager refresh [D]

| Option (per call or cache default) | Meaning | Default |
|---|---|---|
| `staleWhileRevalidate: ms` | After `freshUntil`, serve the stale value and refresh in the background (single-flight). A failed refresh emits `error` and keeps the stale value | 0 |
| `staleIfError: ms` | When the loader throws or hard-times out, serve a stale value that is still inside this window (event `stale-if-error`); past it, rethrow | 0 |
| `softTimeout: ms` | When a stale value exists and the loader takes longer than this, return the stale value now and let the loader finish in the background | none |
| `hardTimeout: ms` | Abort waiting on the loader after this, with `LoaderTimeoutError`. Stale-if-error still applies | none |
| `refreshAhead: 0..1` | Eager refresh: a hit in the last `refreshAhead` fraction of the TTL triggers a background refresh while the hit is served (Caffeine's `refreshAfterWrite`, FusionCache's eager refresh) | off |
| `earlyExpiry: { beta }` | Probabilistic early expiration (XFetch, §11): recompute when `now - delta * beta * ln(rand()) >= freshUntil`, where `delta` is the last load's duration, kept in the header | off |

**Background refreshes go through the same single-flight**, so a burst of
stale hits starts one refresh. Their results are `refresh` events, and their
errors are `error` events with `phase: "refresh"`. A background refresh never
throws into a caller.

**After a failed refresh** (§12), the stale value's `freshUntil` is pushed
forward by `failSafeBackoff` (default 10 s). The origin then sees one retry
per 10 s instead of one per request. This is FusionCache's
`FailSafeThrottleDuration` (default 30 s) and BentoCache's `graceBackoff`
(default 10 s) [W, §11].

### 3.6 Tags [D]

Every driver stores **tag stamps**: one `(tag, invalidatedAt)` record per
invalidated tag. A stamp lives for `tagStampTtl` (default: the cache's
longest TTL, capped at 24 h). What else happens depends on the driver's
`capabilities.tags` (§6.1):

- **`"index"`** (memory, SQLite, Postgres, MySQL, MariaDB, Redis, MongoDB).
  `set(key, value, { tags })` records the entry in the driver's tag index.
  `invalidateTags(tags)` deletes every entry carrying any of the tags,
  through `driver.deleteByTags`, and writes the stamps. Reads cost nothing
  extra. Stamps are read only by writes, through the fence below.
- **`"stamps"`** (file, S3, and custom drivers with no `deleteByTags`).
  `invalidateTags` writes only the stamps. A read of a tagged entry compares
  its header's `createdAt` with its tags' stamps, and an entry older than a
  stamp is a miss. The stamps are cached in process for `tagStampCacheMs`
  (default 1 s) and pushed over the bus.
  - **Why the cache must be pushed.** .NET HybridCache caches tag timestamps
    per node with no refresh, so a `RemoveByTagAsync` on one node is not
    seen by a node that already loaded the stamp [W, §11]. bun-cache
    bounds that window by `tagStampCacheMs` and closes it with the bus.
  - **Space.** Invalidated entries are reclaimed by the sweeper, not at once.

**The fence.** A `set` with tags whose `createdAt` (when its loader started)
is before any of its tags' stamps is **refused**. The refusal is reported as
the `fenced` event, and the loader's value is still returned to the caller.
Without the fence, this interleaving resurrects data that was just
invalidated:

1. Request A misses and starts a slow loader.
2. `invalidateTags(["org:7"])` deletes everything tagged `org:7`.
3. A's loader finishes and writes its **pre-invalidation** value.

**Where the fence is atomic.** On SQL and SQLite it is one conditional
statement (`INSERT … SELECT … WHERE NOT EXISTS (SELECT 1 FROM stamps …)`). On
Redis it is one Lua script, and on memory it is synchronous. On MongoDB
it is a check followed by a write, with a window of milliseconds [I]. Drivers
with `tags: "stamps"` need no fence, because the read-time check sees the
stamp whatever order the writes landed in. §7.10 gives each driver's row.

**Modes.** `invalidateTags(tags, { mode: "stale" })` marks entries stale
instead of deleting them. It rewrites `freshUntil` to now and keeps the
`staleIfError` window, which is Fastly's soft purge. It is a later PR, on
SQL, memory and Redis first.

**Why not lazy everywhere?** Lazy stamps (cacheable 2.5, BentoCache,
FusionCache, HybridCache; Symfony's tag versions) make invalidation O(1) on
any backend. The cost is that every tagged `get` needs a second read, or a
join, and that invalidated entries keep their space until they expire. On a
backend that can delete through an index in one statement, that is a cost
with nothing to show for it. Where the backend cannot, lazy is the only sane
choice. So bun-cache uses both, chosen per driver, behind one API, and the
conformance kit runs the same tag cases against both.

### 3.7 Keys and namespaces [D]

- **Stored key.** `namespace:key`, where `namespace` may itself be a chain
  (`app:users`). `cache.namespace("x")` returns a view of the same cache and
  driver with the longer prefix.
- **Clear.** `clear()` deletes only the cache's own namespace, never the
  backend. A Redis database or an S3 bucket may be shared.
- **Long keys.** A key longer than `maxKeyLength` (default 200 bytes) is
  stored as `#` + SHA-256 (hex) of the full key, via `Bun.CryptoHasher`. The
  header carries the full key, and a read whose full key differs is a miss.
  SQL primary keys stay inside MySQL's index limits, and file and S3 names
  stay valid.
- **Versioning.** `version: "v3"` on the cache becomes part of the namespace
  (`app@v3:`). A deploy that changes a value's shape bumps it, and the old
  entries simply expire (Django's `VERSION`, §11). Rails' per-entry recyclable
  versions are declined for now (§12).

### 3.8 Counters [D]

`increment(key, by = 1, { ttl })` returns the new value. The TTL is set only
when the counter is created, so a rate-limit window does not slide.
`decrement` is `increment(key, -by)`.

| Driver | Mechanism | Measured |
|---|---|---|
| memory | synchronous | — |
| SQLite, Postgres | `INSERT … ON CONFLICT (k) DO UPDATE SET n = n + ? RETURNING n` | 200 concurrent → 200 distinct, final 200 [M `sql-primitives.ts`] |
| MySQL, MariaDB | `… ON DUPLICATE KEY UPDATE n = LAST_INSERT_ID(n + ?)`, then `SELECT LAST_INSERT_ID()` on the same reserved connection | 200 concurrent → 200 distinct, final 200 [M] |
| Redis | `INCRBY`, then `PEXPIRE … NX` (Redis 7+; the local server is 8.0.5) [M `notify-probes.ts`] | — |
| MongoDB | `findOneAndUpdate({ _id }, { $inc }, { upsert, returnDocument: "after" })` | — [I] |
| file | read, add and write under the per-key lock file | — [I] |
| S3 | **throws `UnsupportedOperationError`** | no conditional writes in Bun's client [M] |

**Storage.** A counter is stored in its own numeric column or field (`n`),
not in the value bytes, so the backend can add atomically. `get` on a counter
key returns a `number`. A counter carries no tags.

### 3.9 Size and eviction [D]

- **memory**:
  - **Caps.** `maxEntries` and `maxBytes`, where an entry's size is its
    encoded byte length. This is cost-based eviction, like ristretto's cost
    and Caffeine's weigher.
  - **Eviction order.** LRU, by `Map` insertion order, refreshed on each hit.
  - **Expiry.** Lazy on read, plus a sweep on an unref'd timer.
  - **Admission.** TinyLFU admission (Caffeine, ristretto, moka) is a later
    option (§12).
- **file, S3**: `maxBytes` and `maxEntries`, enforced by the sweeper oldest
  first, by modification time (S3: the listing's `lastModified`). This is age
  order, not LRU: recording each read would cost a write per read.
- **SQL, MongoDB, Redis**: no cap by default; the database is sized by its
  operator. An optional `maxEntries` sweeper deletes the entries nearest to
  expiry first. On Redis, pointing at a server with `maxmemory-policy
  volatile-lru` is the recommended alternative, and is documented.
- **Every driver**: `maxEntryBytes` (default 4 MiB). An oversized `set`
  resolves `false` and emits `oversize`. It does not throw, unless `strict`.
  In `getOrSet`, the value is returned uncached. This follows .NET
  HybridCache, which logs and skips over its 1 MiB and 1024-character limits
  (§11).

### 3.10 Serialisation [D]

| Codec | What round-trips [M `codecs.ts`, `codec-crossprocess.ts`] | 70 KB payload: size, encode, decode |
|---|---|---|
| `"structured"` (default; `bun:jsc` `serialize`) | `Date`, `Map`, `Set`, `Uint8Array`, `BigInt`, `undefined` fields, `NaN`, `RegExp`, `Error`, nested `Map`s. A `Blob` decodes with its bytes **in another process**. A `File` comes back as a `Blob`: the name is lost and the type gains `;charset=utf-8`. Class instances become plain objects. Cycles throw | 34,531 B, 235 µs, 110 µs |
| `"json"` | JSON values only. `Date` becomes a `string`; `Map`, `Set` and `Uint8Array` become objects; `BigInt` throws | 70,397 B, 66 µs, 117 µs |
| `"raw"` | `Uint8Array` and `string`, unchanged | — |
| `Codec` | `{ id: number (128-255), encode(v): Uint8Array, decode(b): unknown }`; ids up to 127 are reserved for the package | — |

**`node:v8` `serialize` is the same JSC format** on Bun (identical sizes) and
twice as slow to encode [M]. It is not offered.

**`structured` is not cross-runtime.** Node's `v8` format is different, so
data written by Bun is readable only by Bun. A service that shares a cache
with non-Bun readers sets `codec: "json"`. This is §19 Q8.

### 3.11 Compression and entry limits [D]

`compress: { algorithm: "zstd" | "gzip", threshold: bytes, level? }`. The
default is zstd above 16 KiB. An entry is compressed only if that makes it
smaller, and the flag is kept in the header.

Measured on 70 KB of JSON [M `codecs.ts`]:

| Algorithm | Ratio | Compress | Decompress |
|---|---|---|---|
| zstd, level 3 | 42× | 50 µs | 21 µs |
| gzip, level 6 | 22× | 196 µs | 28 µs |
| gzip, level 1 | 16× | 33 µs | 17 µs |

The L1 tier never compresses (§4). The per-backend limits that bound
`maxEntryBytes` are listed in §7.10.

### 3.12 Events, statistics and logging [D]

- **Events.** `hit`, `stale-hit`, `miss`, `set`, `fenced`, `delete`,
  `invalidate`, `load` (with its duration), `refresh`, `stale-if-error`,
  `lock-wait`, `lock-timeout`, `evict`, `oversize`, `uncacheable` (HTTP),
  `error` (with `phase` and `driver`), `circuit-open` and `circuit-close`.
- **Listeners.** Synchronous and isolated: a throwing listener is logged and
  never breaks the operation.
- **`stats()`.** Counts per tier: `hits`, `staleHits`, `misses`, `sets`,
  `deletes`, `loads`, `loadErrors`, `lockWaits`, `evictions`, `bytesRead`,
  `bytesWritten`. Plus `hitRate`, and load-duration percentiles over a
  rolling 60 s window. `stats({ reset: true })` reads and zeroes them.
- **Logging.** `logger: LoggerLike`, resolved once with `resolveLogger`
  (`bun-common/lib/logging.ts:1027`). Structured calls only:
  `logger.warn("…", { error, key })`. The default logger is `noopLogger`.
- **OpenTelemetry** follows the repo's OTel plan
  ([`opentelemetry.md`](opentelemetry.md)), as a later PR.

### 3.13 Typed caches [D]

```ts
type Schema = {
  [k: `user:${number}`]: User;
  [k: `report:${string}`]: Report;
  "config": AppConfig;
  [k: `hits:${string}`]: number;
};
const cache = createCache<Schema>({ driver });
await cache.get("user:42");           // User | undefined
await cache.set("user:42", report);   // ✗ Report is not User
await cache.get("usr:42");            // ✗ no such key pattern
await cache.increment("config");      // ✗ only number-valued keys
const users = cache.namespace("tenant-a"); // Cache<Schema>, same keys
```

**What TypeScript enforces:**

- keys belong to the schema, including template-literal patterns;
- `set`, and `getOrSet`'s loader, return the key's value type;
- `get` returns that type or `undefined`;
- `increment` and `decrement` accept only keys whose value is `number`;
- `wrap`'s `key` function receives `fn`'s parameters;
- `tags` can be narrowed with a second parameter, `createCache<Schema, Tag>`.

**What it cannot enforce:**

- that stored bytes match the type, for data written by an older deploy or
  another service;
- the lossiness of the JSON codec. With `codec: "json"`, a `Date` field
  reads back as a `string`. The type of `createCache<Schema>({ codec: "json" })`
  therefore applies `Jsonify<V>` to every value (bun-common's `jsonClone` has
  the type, `native.ts:2727`), so the type stays truthful.

**Optional runtime check.** `validate: { "user:*": UserSchema }`, any
Standard Schema, the same contract `BunValidate` accepts. It checks values on
read, and a value that fails is a miss, with an `error` event. It is opt-in,
because it costs a schema run per hit.

**Untyped.** `createCache()` with no schema is `Cache<Record<string, unknown>>`.

### 3.14 The failure policy [D]

| Situation | Default | `strict: true` |
|---|---|---|
| A driver read fails or times out (`timeout`, default 1 s on networked drivers, off on memory, file and SQLite) | A miss. `error` event, and `warn` logged at most once per 10 s per driver | Throws `CacheDriverError` |
| A driver write fails | Logged and evented; `set` resolves `false` | Throws |
| `getOrSet`'s read fails | Treated as a miss: the loader runs, and the write is attempted | Throws before loading |
| The circuit is open (§12: N consecutive failures, default 5) | Every operation bypasses the driver for `circuitCooldown` (default 30 s), then one probe (`ping()`) | Throws `CircuitOpenError` |
| The loader throws | Rethrown, after stale-if-error | Same |

**A bypassed cache can stampede the origin**, so in-process single-flight
keeps working while the circuit is open.

---

## 4. Multi-tier: L1 memory over a shared L2

### 4.1 Shape [D]

```ts
const cache = createCache({
  driver: postgresDriver({ url }),   // L2: shared by every process
  l1: { maxEntries: 10_000, maxBytes: 64 << 20, ttl: 30_000 }, // per process
  bus: "auto",                       // "auto" | false | CacheBus
});
```

**L1 is a memory driver owned by the cache.** It stores decoded values, not
bytes: its job is to skip both the round trip and the decode.

- **Mutation.** Values are returned by reference, so a caller that mutates a
  returned object mutates the L1 copy. `l1: { clone: true }` returns a
  `structuredClone` instead. The default is `false`, documented loudly.
  Mutating cached values is a bug with or without L1.
- **TTL in L1.** An entry's L1 TTL is `min(its remaining L2 TTL, l1.ttl)`.
  `l1.ttl` caps how stale L1 can get when the bus is down.

**The order of operations:**

| Operation | Order |
|---|---|
| Read | L1 → L2 → loader. An L2 hit backfills L1. A stale L2 hit follows §3.5, and its refresh writes both tiers |
| Write | L2 first, then L1, then publish `set:<key>` on the bus. Other processes drop their L1 copy; they never receive the value |
| Delete, `invalidateTags`, `clear` | L2, then L1, then publish |
| `increment` | L2 only. Counters never enter L1 |
| `lock` | L2's lock |

**Write order.** If the L2 write fails, L1 is not written either (§3.14). The
value is still returned to the caller, but no tier holds it, so no process
reads a value only one process has.

### 4.2 The bus [D]

| Driver | Bus | Measured |
|---|---|---|
| Postgres | `sql.listen` / `sql.notify` on channel `bun_cache_<hash(prefix)>`. Payloads under 8000 bytes, so key lists are batched per microtask, and an overflow sends `flush:<namespace>` | sequential p50 0.137 ms, p99 0.688 ms; a burst of 500 delivered in 23 ms; an 8000-byte payload is rejected [M `pg-listen.ts`] |
| Redis | pub/sub on a duplicated connection, resubscribed on reconnect, as bun-jobs does (`redis-driver.ts:3921-3945`) | p50 0.043 ms, p99 0.098 ms [M `notify-probes.ts`] |
| MongoDB | a **capped collection** read through a tailable, awaitData cursor. Change streams need a replica set | change stream refused on the local standalone server [M]. Tailable cursors on capped collections work on standalone servers [W: MongoDB manual, "Tailable Cursors"; I for our use] |
| MySQL, MariaDB, SQLite | poll an invalidation log table (`seq` auto-increment) every `bus.pollInterval` (default 250 ms), pruned by age | — |
| file | poll an append-only `bus.log` by byte offset, as bun-jobs' event logs do (`file-driver.ts:4265-4300`) | — |
| S3 | **none.** Listing a log prefix every 250 ms would cost about 345,000 requests a day per process. L1 staleness is bounded by `l1.ttl` | — |
| custom | `publish` and `subscribe` if implemented, else none | — |
| any | `bus: redisBus(url)` or `pgBus(url)` overrides the driver's bus. For example, S3 as L2 with a Redis bus | — |

**Gaps.** On reconnect, and whenever a polled log shows a gap in `seq`, the
process **flushes its whole L1**. It cannot know what it missed, and L1 is
only a copy. This is BentoCache's rule for its bus [W, §11].

### 4.3 Consistency, stated plainly

- **In the writing process: read-your-writes.** The write goes to L2 and then
  L1 before `set` resolves.
- **In other processes:**
  - **With a healthy bus:** stale for at most the bus latency, a fraction of
    a millisecond on loopback for Postgres and Redis [M], or up to
    `pollInterval` on polled buses.
  - **With the bus down or absent:** stale for at most `l1.ttl`.
  - **When a write and a read race:** another process can read the old value
    from its L1 between the L2 write and the delivery of the invalidation.
    That is the price of L1. A caller that cannot accept it reads with
    `{ tier: "l2" }`.
- **Never:** a value that no tier wrote; a value restored after
  `invalidateTags` by a loader that started before it (the fence, §3.6); L1
  backfilled from a stale L2 entry as if it were fresh. Backfill copies
  `freshUntil` too.

---

## 5. Redundant drivers

The user asked for *"multiple drivers… of the same type but different
location… to ensure redundancy"*, and added *"I don't know if this will be
useful."* This section answers both.

### 5.1 What it is, and how it composes with tiers [D]

Redundancy is a **driver combinator**:

```ts
const l2 = redundant([postgresDriver({ url: A }), postgresDriver({ url: B })], {
  write: "all",          // "all" | "primary"
  read: "failover",      // "failover" | "race"
  timeout: 250,          // per member, per operation
  circuit: { failures: 5, cooldown: 30_000 },
});
const cache = createCache({ driver: l2, l1: { maxEntries: 10_000 } });
```

- **It is a `CacheDriver`.** It goes wherever a driver goes: L2 under an L1,
  or alone.
- **Tiers and redundancy are orthogonal.** Tiers trade freshness for
  latency, top to bottom. Redundancy keeps one tier alive when a backend is
  lost.
- **Members can differ in type.** For example, a local file driver plus S3,
  or a custom driver.
- **Capabilities.** The combinator advertises the **intersection** of its
  members' capabilities, except for counters and locks (§5.3).

### 5.2 Strategies

| Strategy | Behaviour | Guarantee | Failure scenarios |
|---|---|---|---|
| **write `all`** | Write to every healthy member in parallel. Resolves when the first member acknowledges (`ack: "one"`, default) or all of them (`ack: "all"`) | With `ack: "all"`, a write that resolved is on every healthy member | A member that was down misses writes: §5.3 |
| **write `primary`** + async replicate | Write to the first healthy member; copy to the rest in the background through a bounded queue (default 10,000; overflow drops, with an event) | Only the primary is current; the others lag by the queue | A failover reads lagging data; a crash loses the queue |
| **read `failover`** | Read from the first healthy member in configured order. On a miss, error or timeout, try the next. A miss from a healthy primary is final | Reads come from the most-preferred member that is up | After a failover, a secondary may be stale (§5.3) |
| **read `race`** | Read from all members at once and take the first hit | Lowest latency; doubles read load | May return an older copy while a newer one exists |
| **read `quorum`** | Read from a majority and take the newest `createdAt` | Survives one stale member | **Not offered.** It needs three or more members and buys store-of-record semantics a cache does not need |
| **read repair** | On a failover hit, write the value back to the members that missed it, best-effort | Members converge on reads | It can copy a value that was deleted elsewhere while a member was down |

### 5.3 Semantics under redundancy

- **TTL and expiry.** Unaffected: `expiresAt` is absolute and travels with
  the entry.
- **Deletes and tag invalidation must reach every member.**
  - When a member is down, the combinator marks it **dirty** in this
    process and keeps nothing else.
  - **A dirty member rejoins empty.** When its circuit closes, the first
    operation `clear()`s the combinator's namespaces on it before it serves
    reads.
  - A cache can always be rebuilt; a repair log replayed after an outage
    cannot always be trusted. That is why the choice is to empty the member
    rather than replay a log.
  - **The gap.** Process P sees member B down and deletes key `k` on A only.
    Process Q still sees B up, and later fails over to B, where `k` survives.
    Q then serves a deleted value for at most `k`'s TTL. `secondaryTtl`
    (optional) caps the TTL written to non-primary members, which bounds this
    window.
- **Atomic increments and locks cannot be atomic across independent
  backends.** The combinator offers them **on the primary only**
  (`counters: "primary"`, the default). If the primary is down,
  `increment()` and `lock` throw `UnsupportedOperationError`. They never fail
  over: a counter that restarts from a secondary's old value is worse than an
  error. `counters: "refuse"` removes them entirely.
- **Single-flight** is in process and unaffected.
- **L1 bus.** The combinator uses the **first** member's bus, or the bus the
  cache names explicitly. Members do not each publish.

### 5.4 Health [D]

- **One circuit per member**, per process. Five consecutive failures or
  timeouts open it for `cooldown`; then one `ping()` probe closes it or
  re-opens it.
- **A per-member `timeout`** (default 250 ms for networked members) bounds
  every call, so a slow replica cannot hold a request. For `ack: "one"`
  writes, the slow member's write carries on in the background up to its
  timeout.
- **Events:** `member-down`, `member-up` and `member-dirty`, each with the
  member's index and name.

### 5.5 Testing

The conformance kit gains a **fault-injection driver** (§13.1):
`faulty(inner, { failRate, failOn, hangMs, lagMs, down })`. Combinator tests
then cover:

- a member that throws, hangs past its timeout, or lags;
- a member that comes back dirty and must rejoin empty;
- a primary that is down for `increment`;
- a delete that misses a member, followed by a failover read, which asserts
  the stale window §5.3 states.

### 5.6 Is it useful? An honest assessment

**When redundancy in the cache layer genuinely helps:**

- **The cache holds results that are expensive or impossible to rebuild
  quickly.** A model inference, a third-party API with a quota, a report
  that takes minutes. Losing the only backend sends every request to the
  origin at once; a second backend absorbs that.
- **Multi-region reads.** For example, S3 buckets in two regions with
  `read: "failover"`, local first.
- **Surviving one backend's outage without a herd on the origin**, where the
  backend has no high availability of its own (a single Redis, a single
  self-hosted Postgres).

**When it is wasted complexity:**

- **A cache can be rebuilt by definition.** The common answer to "the cache
  is down" is bypass (§3.14) plus single-flight, which bun-cache does by
  default.
- **The backends already replicate:** Postgres streaming replicas with
  Patroni, Redis Sentinel or Cluster, MongoDB replica sets, MySQL group
  replication, S3 cross-region replication. Each of these is consistent in a
  way an application-level combinator cannot be (§5.3's gap).
- **The cost is real:** two backends to run, double write traffic, and a
  consistency story users must read before trusting it.

**Recommendation.** Do not build it in the first release. Build it last, as
the optional PR-R1 (~4 d), when a deployment asks for it. Then build only
`write: "all" | "primary"`, `read: "failover" | "race"`, circuits,
rejoin-empty, and counters on the primary only. **Never build quorum.** The
README should meanwhile say how to get redundancy from each backend's own HA,
and how each driver behaves across that failover (§7). This is §19 Q4.

---

## 6. The driver contract

### 6.1 The interface [D]

```ts
interface CacheDriver {
  readonly name: string;                         // "postgres", "s3", "my-driver"
  readonly capabilities: CacheDriverCapabilities;
  connect?(): Promise<void>;                     // idempotent; lazy on first use otherwise
  close(): Promise<void>;                        // closes only what it created
  ping?(): Promise<void>;                        // circuit probe

  get(ns: string, key: string): Promise<StoredEntry | undefined>;
  getMany(ns: string, keys: readonly string[]): Promise<(StoredEntry | undefined)[]>;
  set(ns: string, entry: StoredEntry, fence?: TagFence): Promise<"stored" | "fenced">;
  setMany(ns: string, entries: readonly StoredEntry[]): Promise<void>;
  delete(ns: string, keys: readonly string[]): Promise<number>;
  clear(ns: string): Promise<void>;              // this namespace, and its tag index
  touch?(ns: string, key: string, expiresAt: number | null): Promise<boolean>;

  deleteByTags?(ns: string, tags: readonly string[], stampUntil: number): Promise<number>; // tags: "index"
  getStamps(ns: string, tags: readonly string[]): Promise<Map<string, number>>;
  setStamps(ns: string, tags: readonly string[], at: number, until: number): Promise<void>;
  increment?(ns: string, key: string, by: number, expiresAt: number | null): Promise<number>;
  acquireLock?(ns: string, key: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseLock?(ns: string, key: string, owner: string): Promise<boolean>;

  sweep?(now: number, limit: number): Promise<number>;          // expired rows/files/objects
  publish?(message: BusMessage): Promise<void>;
  subscribe?(onMessage: (m: BusMessage) => void, onGap: () => void): Promise<() => Promise<void>>;
  syncSchema?(options?: SchemaSyncOptions): Promise<SchemaChange[]>;
}

interface StoredEntry { key: string; value: Uint8Array; expiresAt: number | null; tags: readonly string[] }
interface TagFence { tags: readonly string[]; createdAt: number }

interface CacheDriverCapabilities {
  multiProcess: boolean;               // memory: false
  ttl: "native" | "sweep";             // who reclaims expired entries
  atomicIncrement: boolean;
  lock: boolean;
  tags: "index" | "stamps";            // eager delete + write fence, or lazy check on read (§3.6)
  fence: "atomic" | "check-then-write"; // for tags: "index"
  bus: "push" | "poll" | "none";
  maxEntryBytes?: number;              // the backend's own limit
}
```

**Defaults the core provides:**

- `getMany`, `setMany` and `delete` of several keys fall back to loops when a
  custom driver implements only the singular forms. The adapter for that is
  `fromSimpleDriver(simple)`, for a driver with just `get`, `set` and
  `delete`, which gives single-key semantics.
- A custom driver that implements no `deleteByTags` declares
  `tags: "stamps"`, and the core checks stamps on read (§3.6).
  `fromSimpleDriver` stores the stamps as ordinary entries under a reserved
  namespace, so a three-method driver still gets correct tags.
- `sweep` is called by the core on `sweepInterval` (default 60 s), unref'd,
  in one process at a time where the driver can lock.

**Driver errors** are thrown as-is. The core wraps them in
`CacheDriverError { driver, op, cause }`, and the failure policy (§3.14)
takes over from there.

**Construction.** As in bun-jobs, every driver takes either a URL or
connection fields, or an existing client. An existing client is never closed
by the driver (§2.3).

### 6.2 The conformance kit [D]

`@kingsleyweb/bun-cache/testing` exports
`runCacheDriverConformance(name, factory, options?)`, built on `bun:test`, the
same way bun-jobs' provider kit is (`bun-jobs/lib/provider/testing/conformance.ts`).

- **The factory** returns `{ driver, cleanup }`.
- **The kit asserts:**
  - round-trips of bytes of every size up to `maxEntryBytes`;
  - expiry, both lazy and swept;
  - `getMany` order;
  - delete counts;
  - `clear` scoped to its namespace, with a neighbour namespace untouched;
  - tag invalidation across two tags and shared keys, in both modes, `index`
    and `stamps`, including the race the fence or the read check must catch;
  - the fence;
  - `increment` under 200 concurrent calls, where advertised;
  - a lock contended by 50 callers;
  - bus delivery and gap signalling, where advertised.
- **Capability gating.** Each case is gated on `capabilities`. An advertised
  capability that fails its case fails the suite. A missing one is reported
  as skipped, with its name.
- **Two processes.** For drivers that advertise `multiProcess`, a second
  pass runs the increment, lock and fence cases from two processes, using
  bun-jobs' `spawn.ts` pattern.

---

## 7. The drivers

Each driver's section covers storage layout, expiry, atomicity, its tag
index, connections, schema and limits. Names use `<p>`, the table, collection
or key prefix. The default prefix is `bun_cache_` (SQL, MongoDB) or
`bun-cache` (Redis, file, S3).

### 7.1 memory [D]

- **Storage.**
  - `Map<ns, Map<key, Slot>>` holding the encoded bytes, kept in LRU order.
  - `Map<tag, Set<key>>` per namespace, the tag index.
  - A `Map<tag, number>` of tag stamps.
- **Expiry.** Lazy, plus an unref'd sweep.
- **Atomicity.** Every operation is synchronous, so atomic.
- **Lock.** In process. **Bus:** local.
- **Isolation.** `multiProcess: false`. Two `memoryDriver()` instances share
  nothing, as in bun-jobs (`bun-jobs/lib/drivers/memory-driver.ts:503-509`).
- **Bytes by default.** The standalone memory driver stores bytes, not
  values, so that it behaves exactly like every other driver: no aliasing,
  exact size accounting, and the same conformance results. Storing live
  values is the L1 tier's job (§4.1).

### 7.2 file [D]

- **Layout:**

  ```
  <root>/<seg ns>/e/<hh>/<sha256(key)>.bce   entry: header (key, expiresAt, tags) + value
  <root>/<seg ns>/s/<sha256(tag)>            tag stamp (content = invalidatedAt)
  <root>/<seg ns>/l/<sha256(key)>.lock       per-key lock files
  <root>/bus.log                             append-only bus log
  ```

  `seg` is bun-jobs' case-proof `encodeSegment` (`bun-jobs/lib/drivers/file-names.ts:250`),
  copied (§8).
- **Sharding.** One level of 256 directories. Measured with 10,000 entries:

  | Layout | Directories | Sets | Gets | Full walk |
  |---|---|---|---|---|
  | flat | 1 | 5,135/s | 20,153/s | 7 ms |
  | two levels, 256×256 | 9,268 | 3,024/s | 23,959/s | 352 ms |

  [M `file-store.ts`]. One level of 256 keeps directories under ~4,000
  entries up to a million keys. `shard: 0 | 1 | 2` is an option.
- **Atomic write.** Write `<path>.<pid>.<uuid>.tmp`, then `rename` it into
  place. This is bun-jobs' `#writeAtomic` (`file-driver.ts:5634-5652`). Readers
  never see a torn entry.
- **Cross-process locks.** `O_EXCL` lock files, stale after their TTL and
  broken by renaming them aside, as in bun-jobs' `#lockFile`
  (`file-driver.ts:5860-5904`). Counters and the fence run under the per-key
  lock.
- **Expiry.** Lazy on read; the sweeper walks the tree and deletes entries
  whose header says they have expired, reading only the first 64 bytes.
  `maxBytes` and `maxEntries` evict oldest first, by `mtime`.
- **Tags.** `tags: "stamps"` (§3.6): an entry's tags are in its header, and
  `invalidateTags` writes one stamp file per tag. The sweeper deletes entries
  that are older than one of their tags' stamps, so their space comes back
  within a sweep. Keeping an eager marker index on disk was considered: it
  costs one extra file per tag per entry, and a crash between the marker and
  the entry leaves debris.
- **Bus.** Polling `bus.log`.
- **Limits.** POSIX local filesystems only; not NFS, as in bun-jobs
  (`file-driver.ts:181-194`). Writes are slow compared with SQLite (5k/s
  against 20k/s); prefer SQLite for small values on one host.

### 7.3 SQLite [D]

- **API.** `bun:sqlite`, not Bun's `SQL` (D7). Measured, WAL, 100 B values:

  | API | Sets, one per statement | Sets, batched | Hits | Misses |
  |---|---|---|---|---|
  | `bun:sqlite`, `synchronous=NORMAL` | 19,932/s | 280,079/s (500 per transaction) | 402,683/s | 544,206/s |
  | `bun:sqlite`, `synchronous=FULL` | 2,151/s | — | — | — |
  | Bun `SQL` sqlite adapter | 21,681/s | — | 81,785/s | — |

  At 10 KB values the two APIs converge: 10,301/s against 6,770/s hits
  [M `sqlite-wal.ts`].
- **Synchronous calls block.** `bun:sqlite` blocks the event loop for each
  call: about 2.5 µs per hit, and about 100 µs per 10 KB hit.
  - The driver uses **one connection per file per process**, shared by every
    cache in the process through a module-level registry.
  - `busy_timeout` is small (50 ms), and waiting happens in JS with backoff.
    This is bun-jobs' measured lesson (`sql/dialect.ts:1925-1939`): a busy
    handler sleeping in the event-loop thread deadlocks two connections in
    one process.
- **Pragmas:** `journal_mode=WAL`, `synchronous=NORMAL` (a cache does not
  need `FULL`, which is 9× slower to write [M]), `busy_timeout=50`.
- **Tables:**

  ```sql
  CREATE TABLE IF NOT EXISTS <p>entries (ns TEXT NOT NULL, k TEXT NOT NULL, v BLOB, n INTEGER,
    exp INTEGER, PRIMARY KEY (ns, k)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS ix_<p>entries_exp ON <p>entries (exp) WHERE exp IS NOT NULL;
  CREATE TABLE IF NOT EXISTS <p>tags (ns TEXT, tag TEXT, k TEXT, PRIMARY KEY (ns, tag, k)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS ix_<p>tags_key ON <p>tags (ns, k);
  CREATE TABLE IF NOT EXISTS <p>stamps (ns TEXT, tag TEXT, at INTEGER, PRIMARY KEY (ns, tag)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS <p>locks (ns TEXT, k TEXT, owner TEXT, exp INTEGER, PRIMARY KEY (ns, k)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS <p>bus (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, msg TEXT);
  ```

- **Write paths.** `set` with tags is one `BEGIN IMMEDIATE` transaction:
  check the fence, upsert the entry, then replace its tag rows. `deleteByTags`
  is `DELETE … WHERE (ns, k) IN (SELECT ns, k FROM tags WHERE tag IN (…))`.
- **Locks.** `INSERT … ON CONFLICT DO UPDATE SET owner = excluded.owner,
  exp = excluded.exp WHERE locks.exp < ?`, then check the owner.
- **Expiry.** The sweeper deletes `exp < now` in batches (2,000 rows in 3-4
  ms [M `sql-primitives.ts`]).
- **Bus.** Polling the `bus` table.

### 7.4 Postgres [D]

**Client.** Bun's `SQL`. An existing `sql` may be passed in, and is then not
closed. Opt-in `unlogged: true` creates `UNLOGGED` tables: faster writes,
emptied after a crash, and **not replicated to standbys**, so a failover
starts cold. The default is logged tables.

**Tables:** the same as SQLite, except:

- `v BYTEA` (a 1 MiB round trip is byte-equal, read back as a `Buffer`
  [M `sql-primitives.ts`]);
- `n BIGINT`, `exp BIGINT`;
- B-tree indexes;
- no `bus` table, because the bus is `LISTEN`/`NOTIFY`.

**Statements:**

| Operation | SQL |
|---|---|
| upsert | `ON CONFLICT (ns, k) DO UPDATE` |
| fence | `INSERT … SELECT … WHERE NOT EXISTS (SELECT 1 FROM <p>stamps WHERE ns = $1 AND tag = ANY($2) AND at > $3)`, in one statement with the tag rows (a CTE) |
| increment | `… RETURNING n` (§3.8) |
| `deleteByTags` | one `DELETE … USING <p>tags` |
| sweep | `DELETE FROM <p>entries WHERE ctid IN (SELECT ctid … WHERE exp < $1 LIMIT $2)` |
| lock | an upsert guarded on `exp`, then a check of the owner |

**Bus:** `LISTEN`/`NOTIFY` (§4.2).

**Schema.** Tables are created `IF NOT EXISTS`, and indexes are named `ix_…`.
`syncSchema()` returns `[]` in v1. The tables are new, and there is nothing
to sync until bun-cache's schema first changes (§8).

### 7.5 MySQL and MariaDB [D]

These share the Postgres driver's shape, with the differences bun-jobs
already handles (`sql/dialect.ts:1759-1785`):

- **Columns.** `v LONGBLOB` (a 1 MiB round trip is byte-equal on both
  [M]), and `k VARCHAR(255)` with binary collation. MySQL uses
  `utf8mb4_0900_bin` and MariaDB `utf8mb4_nopad_bin`, so that `"a"` and
  `"A"` stay different keys. Keys longer than that are hashed (§3.7).
- **Upserts** use `ON DUPLICATE KEY UPDATE`. Increments use
  `LAST_INSERT_ID(expr)` on a reserved connection (measured exact on both,
  §3.8).
- **Affected-row counts.** Bun reports them in `affectedRows` on MySQL and
  MariaDB, and in `count` on Postgres and SQLite. A `DELETE` of 1000 rows
  gave `count = 0`, `affectedRows = 1000` on MySQL [M `sql-primitives.ts`].
  Bun's SQL docs say the same, so it is not a bug. `delete()` must read the
  right field per dialect, or it reports zero deletions.
- **`allowPublicKeyRetrieval`** is taken out of the URL and passed as an
  option, as in bun-jobs (§2.3).
- **Bus:** polling the `bus` table.

### 7.6 MongoDB [D]

**Loading.** `mongodb` is an optional peer, loaded by dynamic `import()` of a
`string`-typed specifier, with structural `*Like` types. This is bun-jobs'
pattern (`mongo/mongo-driver.ts:6017-6049`, `:478-735`).

**Collections:**

| Collection | Shape | Indexes |
|---|---|---|
| `<p>entries` | `{ _id: { ns, k }, v: Binary, n?: Long, exp: Date \| null, tags: string[] }` | TTL `{ exp: 1 }` with `expireAfterSeconds: 0`; `{ "_id.ns": 1, tags: 1 }` (multikey) |
| `<p>stamps` | `{ _id: { ns, tag }, at }` | TTL |
| `<p>locks` | `{ _id: { ns, k }, owner, exp }` | TTL `exp` |
| `<p>bus` | capped collection, 16 MB | — |

**Expiry.** The TTL monitor runs every 60 s on the local server
(`ttlMonitorSleepSecs: 60` [M `notify-probes.ts`]), so an expired document
can survive about a minute. Reads check `exp` themselves (§3.3).

**Operations:**

| Operation | Mechanism |
|---|---|
| increment | `findOneAndUpdate` with `$inc` |
| lock | `findOneAndUpdate({ _id, $or: [{ exp: { $lt: now } }, { owner }] }, …, { upsert })`; a duplicate-key error means the lock was lost |
| fence | read the stamps, then write. Check-then-write, not atomic |
| `deleteByTags` | `deleteMany({ "_id.ns": ns, tags: { $in } })` |

**Read preference.** `primary`, as in bun-jobs (`mongo-driver.ts:676-693`):
reads that decide writes must not see a lagging secondary.

**Bus.** Change streams when the server is a replica set (`hello.setName`
set), otherwise a tailable cursor on the capped `bus` collection (§4.2).

**Schema.** `syncSchema` creates missing indexes and drops only names on a
`RETIRED_INDEXES` list, as bun-jobs does (`:248-259`).

### 7.7 Redis (proposed: not in the user's list) [D]

The user's list omits Redis. bun-jobs supports it, and Bun has `RedisClient`
built in. This is §19 Q1; the recommendation is to include it.

**Keys:**

```
<p>:<ns>:e:<key>       STRING  value bytes, PXAT expiresAt
<p>:<ns>:n:<key>       STRING  counter (INCRBY)
<p>:<ns>:t:<tag>       SET     keys carrying the tag; PEXPIRE extended to the longest member
<p>:<ns>:s:<tag>       STRING  tag stamp, PX tagStampTtl
<p>:<ns>:l:<key>       STRING  lock owner, SET NX PX
```

**Operations:**

| Operation | Mechanism |
|---|---|
| `set` with tags, and the fence | one Lua script: check the stamps, `SET` with `PXAT`, then `SADD` to each tag set |
| `deleteByTags` | Lua: `SMEMBERS`, `UNLINK` the entries, `DEL` the sets, `SET` the stamps |
| `clear` | `SCAN MATCH <p>:<ns>:*` with `UNLINK`, in batches |
| lock release | a compare-and-delete script |

Scripts run through `EVALSHA`, falling back to `EVAL` on `NOSCRIPT`. That is
bun-jobs' helper (`redis-driver.ts:3966-4007`), copied (§8).

**Expiry.** Native `PXAT`, so `ttl: "native"`.

**Cluster.** `cluster: true` wraps the namespace in a hash tag (`{ns}`), so
the scripts touch one slot. The cost is that a namespace lives on one shard.

**Bus.** Pub/sub on a duplicated client (§4.2). Keyspace notifications are
off on the local server [M], and are not relied on.

**HA.** Bun's `RedisClient` has no Sentinel support. bun-jobs has none either
(`redis-driver.ts:585-619`). A Redis that fails over behind a stable address
(a managed service, or a proxy) works with `autoReconnect`.

### 7.8 S3 (Bun's `S3Client`) [D]

**What Bun 1.4.3's client can do.** Measured on the wire against a recording
stub [M `s3-wire.ts`]. A real server's side is from the docs, marked [W].

- **The client's methods** are only `write`, `file`, `delete`/`unlink`,
  `exists`, `size`, `stat`, `list` and `presign`. There is **no batch delete**
  (`DeleteObjects`), **no copy**, and **no user metadata**: an undeclared
  `metadata` option sends no `x-amz-meta-*` header.
- **No conditional writes.** Undeclared `ifNoneMatch` and `headers` options
  are not sent either.
- **What does reach the wire:** `type` (`Content-Type`, **including
  parameters**), `contentEncoding` and `contentDisposition`.
- **What `stat()` exposes:** `size`, `lastModified`, `etag` and `type`. `type`
  comes back with its parameters intact
  (`application/x-bun-cache; exp=1760000000000; v=1`).
- **Ranged reads.** `slice(0, n)` sends `Range: bytes=0-(n-1)`.
- **Errors.** A missing key throws `S3Error` with `code: "NoSuchKey"`.
- **`list()`** parses `ListObjectsV2`: `key`, `size`, `lastModified` and
  `eTag`, up to 1,000 keys per page.

**Layout:**

```
<prefix>/<ns>/e/<hh>/<sha256(key)>   entry: header + value; Content-Type carries exp=<expiresAt>
<prefix>/<ns>/s/<sha256(tag)>        tag stamps (body = invalidatedAt)
```

**Operations:**

- **`get`** is one `GET`. Expiry is read from the header. An expired entry is
  a miss, and is deleted in the background.
- **`set`** is one `PUT` with `type: "application/x-bun-cache; exp=<ms>"`, so
  the sweeper can learn an entry's expiry with a `HEAD` (`stat()`) instead of
  a `GET`.
- **Tags** are `"stamps"` (§3.6): one `PUT` per invalidated tag, whatever
  the number of entries. Eager deletion would cost a `LIST` page plus 2
  `DELETE`s per key, because Bun's client has no batch delete
  [M `s3-wire.ts`]. The sweeper reclaims invalidated entries. A later option
  is a signed `DeleteObjects` call through `fetch`, reusing the SigV4 signer
  in `evidence/summon-compute/` [I].
- **Sweep.**
  - Page through `e/`. An object whose `lastModified + maxTtl` has passed is
    deleted without a `HEAD`; otherwise one `stat()` reads its `exp`.
  - **Recommended backstop:** a bucket lifecycle rule expiring `<prefix>/`
    after N days. Lifecycle rules work in whole days [W: AWS S3 docs,
    "Expiring objects"].
- **Atomicity.** None. `increment` throws, and there is no `lock`. Lazy tags
  need no fence: the read-time check covers the race.
- **Locks, maybe later.** AWS S3 has supported `If-None-Match: *` on `PUT`
  since 2024 [W: AWS S3 docs, "Conditional writes"]. Bun does not send it, but
  `fetch(s3.presign(key, { method: "PUT" }), { method: "PUT", headers:
  { "If-None-Match": "*" } })` might, if the server accepts an unsigned
  conditional header on a presigned URL [U]. That needs a real server, and is
  tested in PR-C7, not assumed.

**Consistency and cost.**

- AWS S3 has given strong read-after-write consistency since December 2020
  [W: AWS S3 docs, "Amazon S3 data consistency model"].
- Other S3-compatible stores differ [U per vendor]. The README lists the
  ones tested (SeaweedFS in CI, §13.2) and warns about the rest.
- Every `get` is a billed request, and listing costs more than reading
  [W: AWS pricing page; check at implementation]. S3 suits large values,
  long TTLs and few reads per key. It is a poor L2 for hot small keys without
  an L1.

### 7.9 Custom drivers [D]

Implement `CacheDriver` (§6.1), or a minimal `{ get, set, delete }` wrapped by
`fromSimpleDriver`. Then run `runCacheDriverConformance` in your own tests.

The README's custom-driver section is a ~150-line example (a `Map` behind a
fake network delay), checked by the examples agent like the compute-provider
template.

### 7.10 The driver matrix

| Driver | TTL mechanism | Atomic increment | Lock | Tags | Bus | Entry limit | Extra dependency |
|---|---|---|---|---|---|---|---|
| memory | lazy + sweep | yes (sync) | in process | index, atomic fence | local | `maxEntryBytes` | — |
| file | lazy + sweep | under lock file | `O_EXCL` file | stamps, checked on read | poll log | disk | — |
| SQLite | lazy + sweep, indexed `exp` | `RETURNING` [M] | lock row | index, atomic fence (one transaction) | poll table | 1 GB BLOB [W] | — (`bun:sqlite`) |
| Postgres | lazy + sweep, indexed `exp` | `RETURNING` [M] | lock row | index, atomic fence (one statement) | `LISTEN`/`NOTIFY` [M] | 1 GB `BYTEA` [W] | — (`SQL`) |
| MySQL / MariaDB | lazy + sweep, indexed `exp` | `LAST_INSERT_ID` [M] | lock row | index, atomic fence (one statement) | poll table | `max_allowed_packet`, 64 MB default on 8.4 [W] | — (`SQL`) |
| MongoDB | TTL index (60 s monitor [M]) + lazy | `$inc` | `findOneAndUpdate` | index, check-then-write fence | change stream or tailable capped collection | 16 MB document [W] | `mongodb` (optional peer) |
| Redis | native `PXAT` | `INCRBY` | `SET NX PX` + compare-and-delete | index, atomic fence (Lua) | pub/sub [M] | 512 MB string [W] | — (`RedisClient`) |
| S3 | lazy + sweep (+ bucket lifecycle) | **no** | **no** (maybe conditional `PUT` [U]) | stamps, checked on read | none | 5 GB single `PUT` [W] | — (`S3Client`) |
| custom | declared | declared | declared | declared | declared | declared | theirs |

---

## 8. A shared driver layer with bun-jobs?

### 8.1 What bun-jobs has that is generic [S]

| Piece | Where | Lines | Reusable? |
|---|---|---|---|
| Connection fields, URL building, `takeBooleanParam`, `resolveNames` | `bun-jobs/lib/shared/connection.ts` | 251 | as is (only part exported from the root, `lib/index.ts:811-819`) |
| Dialect detection, upsert and insert-ignore syntax, DDL hooks, error codes, `withLockRetry`, SQLite pragmas | `sql/dialect.ts` | ~900 of 1,991 | after extraction; there is no bytes type |
| `openSqlClient` | `sql/sql-driver.ts:1223-1259` | ~56 | private; its error text names "The SQL driver" |
| Schema sync engine and renderers | `schemaSync.ts`, `sql/sync.ts`, `sql/schema.ts:1036-1096` | ~670 + 60 | generic over `{ tables, indexes }`, but not exported, and the `ix_` regex and "jobs tables" text are hard-coded |
| Collation guard | `sql/collation-guard.ts` | 84 | its `Symbol` key is bun-jobs-specific |
| Postgres `LISTEN` fan-out | `sql/arrivals.ts` | 261 | keyed by `QueueRef` |
| Redis `EVALSHA` helper, resubscribing subscriber | `redis-driver.ts:3966-4007`, `:3921-3945` | ~120 | private methods |
| File atomic write, exclusive create, lock file, name encoders | `file-driver.ts:5596-5904`, `file-names.ts` | ~300 + 306 | private methods; the encoders are a module |
| MongoDB dynamic import and `*Like` types | `mongo-driver.ts:6017-6049`, `:478-735` | ~290 | the types are exported from `./lib/drivers` |

The rest of the 48,285 lines in `bun-jobs/lib/drivers/` is queue logic. In
`sql-driver.ts`, about 770 of 9,335 lines (8%) are generic plumbing
[S, estimated from section boundaries].

### 8.2 The options

| Option | Coupling | Dependency tree | Duplication | Verdict |
|---|---|---|---|---|
| bun-cache depends on bun-jobs | bun-cache loads a 48k-line queue package and `chrono-node`'s optional peer | large | none | **No** |
| Move the plumbing into bun-common (a `./db` subpath) | bun-common, an HTTP layer, gains database code and an owner who does not know it | none new | none | No: wrong owner |
| A new shared package (`@kingsleyweb/bun-sql`, say) both depend on | one more published package (the dts recipe, consumer-check, a version to keep in step) | none new | none | **Later**, when there is a real second consumer of the sync engine |
| bun-cache independent, copying three small helpers | none | none | ~400 lines (connection helpers, the SQLite retry, the Redis `EVALSHA` helper, `encodeSegment`) | **Now** |

### 8.3 Recommendation [D]

**Start independent.**

- **Why.** The cache's SQL surface is three tables and about a dozen
  statements per dialect. What bun-cache would gain from bun-jobs' SQL layer
  is mostly the schema-sync engine, and v1 of bun-cache has nothing to sync.
- **Copied helpers.** Each one carries a header comment naming its origin
  (`bun-jobs/lib/shared/connection.ts@bbe11201`).
- **A drift test.** A test in bun-cache asserts that the MySQL
  `allowPublicKeyRetrieval` handling still behaves like bun-jobs': it checks
  behaviour, not text.

**Extract when bun-cache's schema first changes.** At that point, move
`schemaSync.ts`, `sql/sync.ts`, the renderers, `connection.ts` and the
dialect's DDL hooks into one shared package, and make both packages use it.
That is a plan of its own, written then and reviewed by the bun-jobs agent,
because it touches the largest driver file in the repo. This is §19 Q2.

---

## 9. HTTP utilities for BunRouter

All three utilities are ordinary `(req, res, next)` middleware on bun-common's
`BunRouter`. Both adapters route through a `BunRouter`: bun-common's adapter
*is* one (`bun-common/lib/BunHttpAdapter.ts:219`), and bun-nest's owns one as
`instance` (`bun-nest/lib/BunHttpAdapter.ts:275-280`). So the utilities work
in both, with the Nest caveat of §2.2: in Nest, use the interceptor (§10.3)
for anything behind a guard.

### 9.1 `cacheResponse()` [D]

```ts
import { cacheResponse } from "@kingsleyweb/bun-cache/http";

const pages = cacheResponse(cache, {
  ttl: 60_000,                       // or "headers": take max-age / s-maxage from the response
  tags: (req) => [`post:${req.params.id}`],
  varyBy: ["accept-language"],       // request headers in the key, besides the response's Vary
  query: "all",                      // "all" | string[] | false
  staleWhileRevalidate: 30_000,
  staleIfError: 600_000,
  bypass: (req) => req.get("x-preview") === "1",
  statusHeader: "X-Cache",           // HIT | MISS | STALE | BYPASS; false to omit
});
router.get("/posts/:id", pages, validate({ params: PostParams }), handler);
router.use("/blog", pages);          // or for a whole subtree
```

**The key.** It is built from:

- `GET`, so HEAD shares GET's entry;
- the host, when `host: true` (default `false`, for single-host apps);
- the path;
- the query, normalised: sorted, and filtered to the names given;
- the values of the `varyBy` headers;
- the stored **variant** for the response's own `Vary`, as Django's
  `learn_cache_key` does (§11). The first response stores a small "vary spec"
  record under the base key; later requests read it and add those headers'
  values to the key. `Vary: *` is never stored.

**What is stored.** The status, the headers, the body bytes, `createdAt` and
the ETag. Hop-by-hop headers are dropped, as are `Set-Cookie` (below) and the
headers listed in `omitHeaders`.

**A response is stored only when every condition holds** (RFC 9111 §3,
adapted):

- the method is `GET` (§9.3 covers HEAD);
- the status is in `statuses`, default `[200, 203, 204, 300, 301, 308, 404,
  405, 410, 414, 501]`, the heuristically cacheable set of RFC 9110 §15.1;
- the response `Cache-Control` has no `no-store` and no `private`;
- the request has no `Authorization` header, unless the response says
  `public` or `s-maxage`, or the key varies on the identity (`varyBy`
  includes `authorization`, or a `key` function);
- there is no `Set-Cookie`, unless `allowSetCookie: true`;
- `Vary` is not `*`;
- the body is buffered (§9.4 covers streams);
- the body is no larger than `maxEntryBytes`.

**The TTL.** `ttl: number` overrides everything. `ttl: "headers"` uses
`Surrogate-Control: max-age`, then `s-maxage`, then `max-age`, then
`Expires`, which is Fastly's precedence (§11). It does not store when none is
present. Response `stale-while-revalidate=` and `stale-if-error=` directives
(RFC 5861) set the matching windows unless the route set them.
`must-revalidate`, `proxy-revalidate` and `no-cache` on the response
**disable** stale serving for that entry: RFC 9111 forbids serving it stale.

**Request directives.** By default the request's `Cache-Control` is
**ignored**, as CDNs and Varnish do by default. Otherwise any client could
bust the cache with `no-cache` and send the load to the origin.
`honorRequest: true` honours `no-store` (bypass) and `no-cache` (revalidate).

**Hits:**

1. Set the stored status and headers.
2. Set `Age` (RFC 9111 §5.1: a cache MUST send it) and the status header.
3. `res.send(bytes)`, without calling `next()`.

bun-common's `send` then checks freshness against the stored `ETag` and
`Last-Modified`, and answers `304` itself (`BunResponse.ts:1790-1819`). When
the handler set no ETag, the middleware computes one at store time with
`etag()` (`bun-common/lib/utils/native.ts:969`), so every hit can answer
`304`. `etag: false` turns that off.

**Misses:**

1. Register a response transform, at the front of the list (§9.7).
2. Call `next()`.

The transform sees the final `Response` and `context.body`. When the
response is storable, it encodes and writes it, fire-and-forget: the write
never delays the response. A write error goes to the failure policy (§3.14).

### 9.2 Pipeline semantics (Express 5) [D]

| Situation | Behaviour |
|---|---|
| Placement | Anywhere before the handler: `router.use()` for a subtree, or in the verb call. The guard against the validator slot is §9.6 |
| A hit | Responds and does not call `next()`. The pipeline stops (`BunRouter.ts:5638-5647`), so later middleware and the handler do not run. That is why anything that must run on every request goes **before** `cacheResponse` |
| A miss, then the handler throws | The error goes to the app's error handlers, as usual. If one answers on the same `res` with a 5xx, the transform sees it and does not store it; with `staleIfError` and a stale entry, it **replaces** the 5xx with the stale response (§9.4) |
| An unhandled error | The adapter answers on a fresh `BunResponse` (`bun-common/lib/BunHttpAdapter.ts:676`), outside the transform. It is not cached, and stale-if-error cannot rescue it. Documented |
| The response was already sent by an earlier layer (`res.headersSent`) | `cacheResponse` calls `next()` and does nothing |
| `next("route")` / `next("router")` | Unaffected: on a miss the transform stays registered, and whatever finally responds on this `res` is considered for storing |
| Error middleware | `cacheResponse` is never an error handler. It has three parameters, and the arity rule (`BunRouter.ts:5019`) keeps it out of error mode |
| `res.redirect()` | `Response.redirect` builds immutable headers. The transform reads them, and the 301 and 308 statuses are storable |

### 9.3 HEAD, unsafe methods and invalidation [D]

- **HEAD.** A HEAD hit serves the GET entry's status and headers with no
  body. A HEAD miss runs the GET handler, as the router already does
  (`BunRouter.ts:4703-4718`), but **does not store**: the body may be cut
  short.
- **Unsafe methods.** With `invalidateOnUnsafe: true` (the default), a
  `POST`, `PUT`, `PATCH` or `DELETE` that passes through `cacheResponse` and
  gets a 2xx or 3xx invalidates the entries for its URL, all variants
  (RFC 9111 §4.4). That uses a per-path tag every entry carries
  automatically.
- **From handlers:**
  - `addCacheTags(res, ...tags)` tags the response being produced (a
    `WeakMap` keyed by `res`).
  - `invalidateTags(cache, tags)` is the same as `cache.invalidateTags(tags)`.
  - `pages.invalidate(pathOrRequest)` drops one URL's variants.
- **CDN tags.** `surrogateKeys: "Surrogate-Key" | "Cache-Tag" | false`
  (default `false`) emits the response's tags as a header, so a CDN in front
  can purge by the same tags (Fastly, Cloudflare, §11). Later PR.

### 9.4 Streams, stale-while-revalidate and stale-if-error over HTTP [D]

- **Streams.** `context.body` is `undefined` for a streamed response
  (`BunResponse.ts:1340-1344`).
  - `streams: "skip"` (the default) does not store them.
  - `streams: { buffer: maxBytes }` replaces the response body in the
    transform with one branch of `response.body.tee()` and reads the other
    branch into memory, storing it only if the stream ends within
    `maxBytes`. That is [I] until PR-H2's spike shows the transform can
    swap the body without delaying the first byte.
  - `text/event-stream` is never stored.
- **Stale-while-revalidate.** A stale hit is served at once; then the
  middleware replays the request in the background through `fetch()`:
  `router.fetch()` or `adapter.fetch()`, the same pipeline with no socket
  (§2.2).
  - The replay carries a per-process random header
    (`x-bun-cache-revalidate: <token>`), so `cacheResponse` treats it as a
    forced miss. A client cannot forge the token.
  - The replay copies only the `varyBy` and `Vary` headers, plus `host`.
  - Replays are single-flighted per key.
  - **The middleware needs to be told what to replay through:**
    `cacheResponse(cache, { revalidate: adapter })`. Without it, SWR on HTTP
    degrades to "serve stale, and the next request refreshes".
- **Stale-if-error.** It covers two cases. A 5xx produced through the
  pipeline on a miss with a stale entry: the transform returns the stale
  `Response` instead, marked `X-Cache: STALE`. A loader-side timeout: with
  `hardTimeout`, the middleware answers stale when the handler has not
  responded in time, and the late response is then dropped
  (`res.headersSent`).

### 9.5 Request coalescing [D]

- **Inside `cacheResponse`.** Misses are coalesced per key (`coalesce: true`,
  the default). The first request runs the handler; identical requests that
  arrive meanwhile wait for its stored entry and are answered from it.
- **Hit-for-miss (Varnish, §11).** When the leader's response turns out not
  storable (`private`, `Set-Cookie`, a 5xx), the key is remembered as
  **uncacheable** for `uncacheableTtl` (default 30 s; Varnish uses 120 s).
  Requests for it then skip coalescing and run in parallel, instead of
  queueing behind one handler at a time. Unlike Varnish's hit-for-pass, a
  later storable response replaces the marker at once.
- **`coalesceRequests(options?)`** is a standalone middleware with no store.
  Identical in-flight `GET`s share one handler run, and the followers get a
  copy of the leader's buffered response: status, headers and bytes.
  - The default key is `GET` + URL.
  - Requests with `Authorization` or `Cookie` are not coalesced unless the
    `key` function includes them.
  - Followers wait at most `wait` (default 10 s) before running the handler
    themselves.

### 9.6 The typed overloads [D]

`cacheResponse()` returns `RouterHandler & { readonly __shape?: never }`.

- **Before `validate()`:** it takes an ordinary `RouterHandler` slot, and the
  handler keeps its typed `query` and `body` [M `typed-slot/`, case 1].
- **Between `validate()` and the handler:** a plain `RouterHandler` would
  compile and silently drop the validated types (case 2: the type test's
  `Expect` fails). The brand makes the handler's `req.query` `never`, so any
  use of it is a type error (case 3: `Property 'page' does not exist on type
  'never'`). That is not an error at the misplaced argument itself, but it
  is not silent.
- **Alone:** the branded handler is accepted (case 4).

The README says "put `cacheResponse` before `validate()`". PR-H1 adds the
four cases to `bun-common/__tests__/verbTyping.type-test.ts` (owner review),
or to bun-cache's own type test if that test cannot import bun-cache.

### 9.7 Transform order and `cacheControl()` (bun-common, PR-H0) [D]

- **`addResponseTransform(transform, { first: true })`.** It inserts at the
  front of the transform list. The cache's capture then sees the
  uncompressed `Response` no matter where `compression()` is registered, and
  a hit, which responds without calling `next()`, still passes through
  compression's transform when compression is registered before the cache.
  - `compression()` before `cacheResponse`: hits are compressed, and misses
    are captured uncompressed and then compressed.
  - The README states this order.
  - The change is about 10 lines plus tests, in bun-common's `BunResponse`
    (owner: bun-common agent).
- **`cacheControl(directives)`** is a middleware that sets `Cache-Control`
  (and, optionally, `Surrogate-Control`) from a typed object:

  ```ts
  router.get("/assets/*", cacheControl({ public: true, maxAge: 31_536_000, immutable: true }), h);
  router.get("/feed", cacheControl({ sMaxAge: 60, staleWhileRevalidate: 30, staleIfError: 600 }), h);
  router.get("/me", cacheControl({ private: true, noStore: true }), h);
  ```

  - Values are in **seconds**, as the header is. This is the one place in
    the plan that does not use ms, and the property docs say so.
  - Contradictions are type errors: `public` with `private`, and `noStore`
    with `maxAge`.
  - `res.cacheControl()` is **not** added to `BunResponse`. A middleware and
    a pure `formatCacheControl()` function are enough.
  - It lives in `bun-common/lib/cacheControl.ts` and is exported from the
    barrel.

---

## 10. bun-nest

Everything here is under a new subpath, `@kingsleyweb/bun-nest/cache`, with
`@kingsleyweb/bun-cache` as an optional peer (§10.5).

### 10.1 `BunCacheModule` and `@InjectCache()` [D]

```ts
@Module({
  imports: [
    BunCacheModule.forRoot({ driver: redisDriver({ url }), ttl: 60_000, isGlobal: true }),
    BunCacheModule.forRootAsync({
      name: "reports",
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({ driver: postgresDriver({ url: c.get("DB") }) }),
    }),
  ],
})
class AppModule {}

@Injectable()
class UsersService {
  constructor(@InjectCache() private cache: Cache, @InjectCache("reports") private reports: Cache) {}
}
```

- **The shape follows `BunJobsApiModule`** (`bun-nest/lib/jobs/BunJobsApiModule.ts:136-148`):
  - `forRoot` and `forRootAsync` return a `DynamicModule` that provides the
    options and the cache under a token, and exports both.
  - The tokens are symbols in `tokens.ts`, which imports nothing, so it is
    safe without the peer (`bun-nest/lib/jobs/tokens.ts:10-13`).
- **Options.** It accepts `CreateCacheOptions` or an existing `cache`.
  `name` gives several caches, each with its own token, `getCacheToken(name)`.
- **Lifecycle.** `onModuleDestroy` closes a cache the module created, never
  one passed in (the ownership rule, §2.3).

### 10.2 Method decorators for services [D]

```ts
@Cacheable({ key: (id: number) => `user:${id}`, ttl: 60_000, tags: (id) => [`user:${id}`] })
async findUser(id: number): Promise<User> { … }

@Cacheable({ key: "orgs:{0}:page:{1.page}", cache: "reports", staleIfError: 3_600_000 })
async listOrgs(orgId: string, q: { page: number }): Promise<Org[]> { … }

@CacheEvict({ tags: (id: number) => [`user:${id}`] })
async updateUser(id: number, patch: Partial<User>): Promise<User> { … }

@CachePut({ key: (u: User) => `user:${u.id}` })
async createUser(u: User): Promise<User> { … }
```

**`@Cacheable`** runs the method through `cache.getOrSet` (§3.4), so it gets
single-flight, the lock, SWR and stale-if-error.

- `condition(...args)` decides whether to use the cache at all, before
  invocation.
- `unless(result, ...args)` decides whether to store, after invocation. These
  are Spring's names (§11).

**`@CacheEvict`** deletes keys or invalidates tags after the method succeeds.
With `beforeInvocation: true` it runs before; with `all: true` it clears the
namespace.

**`@CachePut`** always runs the method and stores the result.

**Keys:**

- **A function** receives the method's parameters, and its type is checked
  against them: the decorator is generic over
  `TypedPropertyDescriptor<(...a: A) => Promise<R>>`.
- **A template string** uses positional placeholders, `{0}` and `{1.page}`.
  Parameter *names* are not available reliably at runtime, so `{id}` is not
  supported. A placeholder that is out of range is caught at decoration time
  (first call) with a clear error.
- **The default key**, with no `key`, is `ClassName.method:` plus a stable
  hash of the arguments. `bun:jsc` `serialize` is not stable across `Map`
  insertion order, so this is a documented rule rather than a guarantee: pass
  `key` when arguments are objects.

**Only async methods.** A method returning a non-`Promise` is a type error,
because the descriptor type requires `Promise<R>`. A cached value can only
come back asynchronously.

**Finding the cache.** Decorators run at class definition, before DI exists.
The decorator records metadata, and `BunCacheModule` registers each cache in
a module-scoped registry `onModuleInit`. The wrapped method resolves its cache
by name (default: the unnamed one) on first call. A method called before the
module initialises throws `CacheNotReadyError`, which names the cache.

**Not supported:** decorating `@Controller` handlers. That is the
interceptor's job (§10.3), and the README says so.

### 10.3 The HTTP interceptor [D]

```ts
@UseInterceptors(BunCacheInterceptor)
@CacheTTL(30_000)
@CacheTags((ctx) => ["posts"])
@Get("posts")
list() { … }
```

`BunCacheInterceptor` is a `NestInterceptor` in the mixin style of bun-nest's
file interceptors (`bun-nest/lib/interceptors.ts:182-350`). It uses Nest's
`Reflector`; bun-nest uses none today [S], so this is the first. It runs
**after guards**, which is why it, and not router middleware, is the tool for
authenticated routes in Nest.

- **The key** is `@CacheKey(string | (ctx) => string)` if present. Otherwise
  it is `GET` + `httpAdapter.getRequestUrl(req)` (`originalUrl`,
  `bun-nest/lib/BunHttpAdapter.ts:1318`), plus the `varyBy` headers.
- **Only `GET` is cached** unless `@CacheKey` is given, the same rule as
  `@nestjs/cache-manager` (§10.4).
- **What is cached is the handler's return value**, as Nest's interceptor
  does. Hits return `of(value)`, so later interceptors (serialisation)
  still run, and `reply()` sends it.
- **Skipped:** `StreamableFile`, `@Res()` routes, and responses whose status
  a handler set outside 2xx.
- **Headers.** `X-Cache` is set through `httpAdapter.setHeader`.
- **Decorators.** `@CacheTTL(ms | (ctx) => ms)`, `@CacheTags(...)` and
  `@NoCache()` set the metadata.

**Whole-response caching in Nest** (ETag, `304`, `Vary`) needs bun-common's
transform on the `BunResponse`. A later option
(`BunCacheInterceptor.forResponses()`) can reuse `cacheResponse`'s capture
from inside the interceptor [I].

**Migration from `@nestjs/cache-manager`.** The interceptor also reads that
package's metadata keys (`cache_module:cache_key`, `cache_module:cache_ttl`),
so existing `@CacheKey` and `@CacheTTL` decorators keep working [W:
nestjs/cache-manager 12.0.1 source]. If Nest renames them, the fallback
silently stops; a test pins the strings.

### 10.4 `@nestjs/cache-manager` compatibility [D]

**What the current versions expose** [W, read 2026-10-10]:

- **`@nestjs/cache-manager` 12.0.1** (2026-10-08):
  - Its `stores` option accepts a Keyv instance, a bare Keyv store adapter,
    or a `Cacheable`.
  - A bare adapter is wrapped in `new Keyv({ store, ttl, namespace })`.
  - `CACHE_MANAGER` is cache-manager's `Cache`.
  - Its interceptor uses only `get` and `set`, with TTLs in ms.
- **cache-manager 7.2.9:**
  - `wrap()` is single-flight in process only.
  - `ttl()` returns an **absolute** timestamp.
  - It **depends on `keyv ^5.6.0`**.
- **Keyv 6.1.0** (2026-10-06) **breaks it**. Measured: with Keyv 6, `wrap()`
  ran the loader twice where Keyv 5 ran it once, and `ttl()` returned
  `undefined` [M `keyv-compat/results.txt`].

**What a Keyv store receives** [M `keyv-compat/`, W]:

- **Keyv 5:**
  - `set("keyv:k", '{"value":…,"expires":<abs ms>}', <relative ttl ms>)`, a
    JSON string in Keyv's envelope, in which `Date`s are already strings.
  - `get` returns that string.
  - `clear()` is called with `store.namespace = "keyv"`, and must clear only
    that namespace.
- **Keyv 6:**
  - The namespace is unset by default.
  - The contract requires `has`, `hasMany`, `getMany`, `setMany` and
    `deleteMany`.
  - Native v6 stores take an absolute `expires`.
  - Any other store is wrapped in a bridge that converts back to a relative
    TTL.
  - A namespaced `clear()` with no `iterator()` and no store-managed
    namespace **throws**.

**The adapter.** `toKeyvStore(cache, { namespace? })` lives in
`@kingsleyweb/bun-cache/keyv`:

- It is structural: no `keyv` dependency.
- It implements both contracts: `opts`, `namespace`, `on()`; relative or
  absolute TTL; `has`, `getMany`, `setMany`, `deleteMany`, `clear` scoped to
  the namespace, and `disconnect`.
- Values are stored with the `"raw"` codec, opaque, never re-encoded, so
  nothing is serialised twice.

**Usage:**

```ts
CacheModule.register({ stores: [toKeyvStore(createCache({ driver: pg }))], ttl: 60_000 });
```

**What is lost through Keyv:**

- tags;
- stale-while-revalidate and stale-if-error (cache-manager's
  `refreshThreshold` is the nearest thing);
- cross-process locks;
- bun-cache's codec (Keyv's JSON envelope wins, so `Date`s come back as
  strings).

**Recommendation.**

- **The primary Nest path is `./cache`** (§10.1 to §10.3).
- **Ship the Keyv adapter** as a small compatibility PR (PR-K1) for apps
  already on `@nestjs/cache-manager`, with the README pinning **keyv 5.6.0**
  until cache-manager supports Keyv 6.
- **Note in the README** the August 2026 supply-chain incident in that
  package family: poisoned `keyv@6.0.0`, `cacheable@2.5.1` and others, since
  removed from npm [W: jaredwray/cacheable#1692]. Advise exact pins.
- **Declined:** a `CACHE_MANAGER`-shaped facade (cache-manager's `Cache`
  backed by bun-cache directly). `@nestjs/cache-manager` already returns a
  `Cacheable` instance as `CACHE_MANAGER` without wrapping it, so a facade
  is possible [W]. It would be a second API to keep in step with
  cache-manager's releases, for little over the Keyv adapter.

### 10.5 Packaging the subpath [D]

These follow `./jobs` exactly (`bun-nest/package.json:35-49`, `:94-105`):

- **`exports`**: `./cache` and `./lib/cache`, each
  `{ "@kingsleyweb/source", types, default }`.
- **Peers.** `@kingsleyweb/bun-cache` becomes an optional peer and a
  devDependency.
- **`consumer-check.json`.** The `./cache` entries carry
  `"peers": ["@kingsleyweb/bun-cache"]`, and `./lib/cache/tokens` carries
  none.
- **`checkPeerScopes`** then proves the root cannot reach `./cache`'s
  declarations.

---

## 11. Prior art

Popular caches across eight ecosystems, read on 2026-10-10 from each
project's docs, and from its source where a behaviour mattered. **[W]**
means read at the link, at the version given; **[I]** means inferred, or
taken from a search snippet only. For each one, the ideas worth taking are
listed. §12 says which ones bun-cache adopts, when, and why.

**Two things the docs got wrong.**

- **FusionCache's `AutoRecoveryDelay`** is 5 s in source
  (`FusionCacheOptions.cs:101`), not the 2 s its Options.md states [W].
- **.NET HybridCache's tag timestamps** are cached per node with no refresh
  and no backplane. A `RemoveByTagAsync` on node A is not seen by node B once
  B has loaded that tag's timestamp [W: `DefaultHybridCache.TagInvalidation.cs`].
  The docs imply otherwise. bun-cache's stamp mode is designed around this
  (§3.6).

### 11.1 JavaScript and TypeScript

| Project | Read | What it does | Ideas worth taking |
|---|---|---|---|
| [cache-manager](https://github.com/jaredwray/cacheable/tree/main/packages/cache-manager) | 7.2.9 (2026-06-27) [W] | `createCache({ stores: Keyv[] })`. `get` walks the stores in order, without backfilling; `set` and `del` go to every store. `wrap` is single-flight in process (`coalesceAsync`). With `refreshThreshold`, a hit near expiry is served while the loader re-runs in the background. Errors are emitted, not thrown | A background refresh near expiry. **Trap:** `ttl()` returns an absolute time, and the package breaks under Keyv 6 [M `keyv-compat/`] |
| [Keyv](https://github.com/jaredwray/keyv) | 5.6.0 and 6.1.0 [W] | A key-value layer over storage adapters. It wraps a value in a JSON envelope `{ value, expires }` and prefixes keys with a namespace. Keyv 6 passes stores an absolute expiry and requires the `…Many` methods | Adapters as the seam for compatibility (§10.4). **Trap:** a namespaced `clear()` must not clear the whole store |
| [cacheable](https://github.com/jaredwray/cacheable/tree/main/packages/cacheable) | 2.5.0 [W] | L1 and L2 Keyv stores, with lazy version-counter tags (`invalidateTag` bumps a counter), and `CacheableSync` broadcasting sets and deletes to L1 | Lazy tags for stores without an index (§3.6) |
| [BentoCache](https://bentocache.dev/docs/grace-periods) | 1.6.1 (2026-02-09) [W] | Grace periods (stale-if-error, `graceBackoff` 10 s), soft timeouts returning a graced value, hard timeouts, tags as timestamps (`___bc:t:<tag>`), and a bus carrying invalidations only, never values, with a retry queue for while it is disconnected | Stale-if-error with a backoff; bus messages without values; flush L1 after a bus gap (§4.2) |
| [lru-cache](https://github.com/isaacs/node-lru-cache) | 11.5.3 (2026-09-18) [W] | `max`, `maxSize` with `sizeCalculation`, `ttl`, `allowStale`, and `fetchMethod`, whose in-flight calls are deduplicated, with `allowStaleOnFetchRejection` | Size-weighted LRU for the memory driver (§3.9) |
| [unstorage](https://unstorage.unjs.io/guide) | current docs [W] | A driver and mount layer: `getItem`, `setItem`, `getKeys`, `clear` and `watch`. TTL is left to each driver | The negative lesson: TTL, staleness and tags belong in the core's envelope, not in drivers (D1). Prefix mounts are a possible later router over drivers |
| [Next.js data cache](https://nextjs.org/docs/app/api-reference/functions/cacheLife) | 16.4.0 docs [W] | `"use cache"`, with `cacheLife` profiles `{ stale, revalidate, expire }` and presets (`minutes`, `hours`, `days`, …). `cacheTag` (up to 128 tags of up to 256 characters). `revalidateTag(tag, profile)` marks entries stale, and the next request revalidates them | Named lifetime profiles; invalidation that marks stale instead of deleting (`mode: "stale"`); limits on tag count and length |

### 11.2 Java and the JVM

| Project | Read | What it does | Ideas worth taking |
|---|---|---|---|
| [Caffeine](https://github.com/ben-manes/caffeine/wiki/Refresh) | 3.3.0 (2026-09-21) [W] | W-TinyLFU: an LRU window, a segmented main LRU, and a 4-bit count-min sketch that ages by halving. **`refreshAfterWrite`**: the first stale read triggers an asynchronous reload and gets the old value meanwhile. Refresh errors are logged and swallowed. A refresh result is dropped if the entry changed meanwhile. `expireAfterWrite` stays the hard cap. `AsyncCache` stores the future itself, and a failed future is removed | Refresh on access, not on timers; a refresh result dropped when the key was rewritten meanwhile; TinyLFU admission, with hash-flood protection (a candidate of frequency 6 or more admitted with probability 1/128) |
| [Spring Cache](https://docs.spring.io/spring-framework/reference/integration/cache/annotations.html) | 7.0.9 [W] | `@Cacheable` with `condition` (checked before the call) and `unless` (checked after, against `#result`). `@CachePut`; `@CacheEvict` with `allEntries` and `beforeInvocation` (default after success). `sync = true` lets one thread load, but cannot be combined with `unless`. A `NullValue` sentinel caches `null` | The decorator semantics in §10.2; a sentinel distinguishing a cached empty value from a miss |
| [JCache (JSR-107)](https://github.com/jsr107/jsr107spec) | 1.1.0 [W] | `ExpiryPolicy` with separate durations for create, access and update (`ZERO` on create means do not store). Read-through and write-through. `EntryProcessor`: an atomic read-modify-write, run next to the data | Per-event TTL hooks; `update(key, fn)` as an atomic read-modify-write (later) |
| [Ehcache 3](https://www.ehcache.org/documentation/3.10/tiering.html) | 3.10 docs, 3.11.1 release [W] | Tiers (heap, offheap, disk, clustered) with the lowest tier **authoritative**: a write goes to it and invalidates the tiers above, and a read promotes upwards. [`RobustResilienceStrategy`](https://www.ehcache.org/documentation/3.10/resilience.html) behaves as an empty cache when a store fails, never throwing | L2 as the authority, with L1 invalidated on write (§4.1); a failing store degrades to a miss (§3.14) |

### 11.3 .NET

| Project | Read | What it does | Ideas worth taking |
|---|---|---|---|
| [FusionCache](https://github.com/ZiggyCreatures/FusionCache/blob/main/docs/FailSafe.md) | 2.9.0 (2026-09-22) [W] | **Fail-safe**: a logical and a physical expiry; on a factory error the stale value is served and re-cached for `FailSafeThrottleDuration` (30 s). **Timeouts**: `FactorySoftTimeout` serves stale and lets the factory finish in the background, `FactoryHardTimeout` throws. **Eager refresh** above a TTL fraction in (0, 1), recommended around 0.8. **Backplane** messages carry key, type and time, not values, and act only where L1 holds the key. **Auto-recovery** queues failed L2 and backplane operations, last one per key, newest wins. Jitter, circuit breakers for L2 and the backplane, and tags as timestamp tombstones (`Clear` is built on reserved tags) | Almost all of §3.5 and §12: stale-if-error with a throttle, soft and hard timeouts, eager refresh, jitter, circuits, the auto-recovery queue (later) |
| [.NET HybridCache](https://learn.microsoft.com/aspnet/core/performance/caching/hybrid) | dotnet/extensions 10.10.1 [W] | Per-instance stampede protection, where the factory is cancelled only when **every** waiter cancels. Limits: 1 MiB payload, 1024-character key; over either, it logs and skips. Per-call flags (`DisableLocalCacheRead`, `DisableDistributedCacheWrite`, `DisableUnderlyingData`, …). Tags as timestamps (`__MSFT_HCT__<tag>`), checked on read | Reference-counted loader cancellation (§3.4); log-and-skip limits (§3.9); per-call tier flags (`tier: "l2"` in §4.3); the cross-node stamp flaw to avoid |

### 11.4 Go

| Project | Read | What it does | Ideas worth taking |
|---|---|---|---|
| [groupcache](https://github.com/golang/groupcache) | `2c02b820` (2024-11-29) [W] | Each key has one owning peer (consistent hashing). A non-owner asks the owner, so one process in the whole set fills a key. Values are immutable: no expiry and no delete. Hot keys are mirrored to non-owners with probability 1/10 | Probabilistic L1 admission of remote values (skip for now); owner-routed fills (a design note, not v1) |
| [ristretto](https://github.com/dgraph-io/ristretto) | 2.4.2 (2026-07-07) [W] | TinyLFU admission with a doorkeeper, sampled-LFU eviction (5 samples), cost-based capacity (`MaxCost`), and an asynchronous, **lossy** `Set` (a full buffer drops writes) | Cost-based capacity (§3.9). **Skip** lossy writes: they surprise users, and a JS event loop has no contention to buy them for |
| [x/sync/singleflight](https://github.com/golang/sync/blob/master/singleflight/singleflight.go) | 0.24.0 [W] | `Do`, `DoChan` and `Forget`; a `shared` flag; a call deletes its own map entry only if it is still its own; a panic reaches every caller | Guarded delete and `forget` (§3.4); a `shared` flag on `load` events |

### 11.5 Python, Ruby and PHP

| Project | Read | What it does | Ideas worth taking |
|---|---|---|---|
| [dogpile.cache](https://dogpilecache.sqlalchemy.org/en/latest/api.html) | 1.5.0 [W] | The dogpile lock: one creator regenerates while others get the old value; the first request with no value blocks. Expiry is computed at read time from a stored creation time. `invalidate(hard=False)` is a timestamp, not a delete, and is **local to the process**. Redis distributed locks are optional | Read-time expiry from the header (§3.3); soft invalidation as a timestamp. The process-local invalidation is the counterexample the bus fixes |
| [cachetools](https://cachetools.readthedocs.io/en/latest/) | 7.2.1 (2026-10-05) [W] | LRU, LFU, TTL and TLRU, where a per-item `ttu(key, value, now)` sets the expiry. `@cached(condition=…)` makes identical calls wait (since 6.0); `info=True` gives hit and miss counters | A TTL computed from the value, `ttl: (value) => ms` (for example, short TTLs for empty results) |
| [Django cache](https://docs.djangoproject.com/en/stable/topics/cache/) | 6.1 docs, main source [W] | Keys `prefix:version:key`. The cache middleware **learns the response's `Vary` list per URL**, then keys variants on the values of those headers (`learn_cache_key`, `get_cache_key`). It skips `private`, `no-store`, `Vary: *`, `max-age=0`, streaming responses, and `Set-Cookie` combined with `Vary: Cookie`. With `Authorization` on the request and no `public`, it adds `Vary: Authorization` | Two-step `Vary` keying (§9.1); the refuse-to-store list; key versioning (§3.7) |
| [Rails.cache](https://api.rubyonrails.org/classes/ActiveSupport/Cache/Store.html) | 8.1.4 [W] | `fetch(race_condition_ttl:)` extends a stale entry while one reader regenerates; this is best-effort, not a lock. **Recyclable keys**: a stable key plus a version stored *inside* the entry, where a mismatch is a miss. Russian-doll fragments through `touch: true`. Compression above 1 KB. The Redis store's `failsafe` turns connection errors into misses, through an error handler | An error hook that degrades to a miss (§3.14); recyclable versions (later); a compression threshold |
| [Symfony Cache](https://symfony.com/doc/current/components/cache.html) | 8.1 docs, 7.3 source [W] | **Probabilistic early expiration (XFetch)**: recompute when `expiry <= now − ctime · β · ln(rand)`, with the compute time stored next to the expiry and β = 1 by default. `LockRegistry` uses `flock`, so it is per machine only. `TagAwareAdapter` keeps random tag versions with a 0.15 s in-process cache. `ChainAdapter` backfills upper tiers with the source's expiry | XFetch, as `earlyExpiry` (§3.5); backfill keeps the source expiry (§4.3); composable marshallers |

The XFetch rule comes from Vattani, Chierichetti and Lowenstein, "Optimal
Probabilistic Cache Stampede Prevention", PVLDB 8(8), 2015
([PDF](https://cseweb.ucsd.edu/~avattani/papers/cache_stampede.pdf)) [W].

### 11.6 Rust

| Project | Read | What it does | Ideas worth taking |
|---|---|---|---|
| [moka](https://docs.rs/moka/latest/moka/sync/struct.Cache.html) | 0.12.16 (2026-08-09) [W] | Caffeine's design: TinyLFU admission, LRU eviction, a weigher, and per-entry expiry through an `Expiry` trait (on create, read and update). `get_with` merges concurrent initialisations. `try_get_with` gives every waiter the same error and **does not cache it** | Shared rejection, never cached by default (§3.4) |

### 11.7 Systems and standards

| Project | Read | What it does | Ideas worth taking |
|---|---|---|---|
| [Varnish](https://www.varnish.org/docs/users-guide/vcl-grace/) | current docs, `builtin.vcl` [W] | Three windows: `ttl`, then `grace` (serve stale, fetch asynchronously), then `keep` (kept only for a conditional revalidation). A waiting list coalesces requests. **Hit-for-miss** (`uncacheable_ttl`, 120 s [I]) remembers uncacheable responses so the waiting list does not serialise requests. Bans versus purges. xkey surrogate keys, with soft purge. Saint mode blacklists backends [I] | Hit-for-miss (§9.5); a soft purge (`mode: "stale"`) |
| [nginx proxy_cache](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) | current docs [W] | `proxy_cache_lock` (one request fills), `_lock_timeout 5s` (after that, go upstream and **do not cache**), `_lock_age`, `proxy_cache_use_stale error timeout updating http_5xx`, `background_update`, `min_uses`, and the `$upstream_cache_status` values | Bounded lock waits whose result is not stored (§3.4); stale on error by class; `X-Cache` values; `minUses` (later) |
| [Fastly surrogate keys](https://www.fastly.com/documentation/guides/full-site-delivery/purging/working-with-surrogate-keys/) and [Cloudflare Cache-Tag](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-tags/) | current docs [W] | Tags in a response header, stripped at the edge, purgeable by tag. Fastly's soft purge marks content stale. TTL precedence: `Surrogate-Control`, then `s-maxage`, then `max-age`, then `Expires` | Emitting tags as `Surrogate-Key` or `Cache-Tag` (later, §9.3); the TTL precedence (§9.1) |
| [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html), [RFC 5861](https://www.rfc-editor.org/rfc/rfc5861.html) | [W] | Storage rules: no `no-store`; no `private` in a shared cache; `Authorization` only with `public`, `s-maxage` or `must-revalidate`; `Vary: *` never matches. `Age` is required on reuse. Unsafe methods invalidate. `must-revalidate` forbids stale reuse. RFC 5861 adds `stale-while-revalidate` and `stale-if-error` | The middleware's storage and freshness rules (§9.1, §9.3) |

**Traps the survey turned up:**

- **Coalescing behind an uncacheable response serialises traffic.** That is
  why hit-for-miss exists.
- **Vary explosion.** Varying on `User-Agent` or `Cookie` means an entry per
  client. `varyBy` is an allow-list, and `Vary` values outside it are not
  keyed: the response is not stored, with an `uncacheable` event.
- **Caching `Set-Cookie` or `Authorization` responses leaks sessions.** Every
  surveyed system refuses by default.
- **Backfilling L1 with a full fresh TTL** lets L1 outlive an invalidation.
- **A lock-only stampede guard** stalls every waiter and fails with its
  holder (the XFetch paper's critique). Pair the lock with stale serving and
  bound it.
- **Treating an unreachable L2 as a quiet miss forever** hides outages.
  Report it through events and circuit state.

---

## 12. Robustness and resilience recommendations

Each idea from §11 with a decision: **adopt now** (in the named PR), **later**
(not scheduled; picked up when a user needs it), or **skip**. Every "adopt
now" idea is already folded into the section named.

| # | Idea | From | Decision | Where | Why |
|---|---|---|---|---|---|
| R1 | In-process single-flight, with a guarded delete, `forget` on delete or invalidation, and a shared rejection that is never cached | singleflight, moka, Caffeine | **Adopt now**, PR-C1 | §3.4 | Measured: 1000 misses → 1 load [M] |
| R2 | Loader `AbortSignal` that aborts only when every waiter aborts | HybridCache | **Adopt now**, PR-C1 | §3.4 | One impatient caller must not cancel shared work |
| R3 | Logical vs physical expiry; stale-if-error with a retry throttle (`failSafeBackoff`) | FusionCache, BentoCache, Varnish grace | **Adopt now**, PR-C1 | §3.3, §3.5 | The cheapest resilience there is: the origin down means stale data, not errors |
| R4 | Soft and hard loader timeouts, with background completion | FusionCache, BentoCache | **Adopt now**, PR-C1 | §3.5 | Caps tail latency whenever a stale value exists |
| R5 | Stale-while-revalidate, and eager refresh on access (`refreshAhead`) | Caffeine, FusionCache, RFC 5861, Next.js | **Adopt now**, PR-C1 | §3.5 | No per-key timers; one background refresh per key |
| R6 | Probabilistic early expiration (XFetch, `earlyExpiry: { beta }`) | Symfony, VLDB 2015 | **Adopt now** as an option, off by default, PR-C1 | §3.5 | Lock-free stampede reduction, for drivers without a lock (S3). Cheap: 8 bytes of header for the load duration |
| R7 | TTL jitter | FusionCache | **Adopt now**, off by default, PR-C1 | §3.3 | Prevents synchronised expiry after a bulk load |
| R8 | Negative caching as an explicit opt-in, with its own TTL | Spring `NullValue`, cachetools, Rails `skip_nil` | **Adopt now**, PR-C1 | §3.4 | A miss and a cached "nothing" must differ; opt-in, because caching errors by accident is worse |
| R9 | A failing backend degrades to a miss; one circuit per driver; operation timeouts | Ehcache, Rails failsafe, FusionCache circuit breaker | **Adopt now**, PR-C1 (core), each driver PR (timeouts) | §3.14 | D8. A cache outage must not become an app outage |
| R10 | Log-and-skip limits on entry and key size | HybridCache | **Adopt now**, PR-C1 | §3.7, §3.9 | An oversized value is a capacity fact, not an exception |
| R11 | Cost-based capacity (`maxBytes` on the encoded size) | ristretto, Caffeine weigher, lru-cache | **Adopt now**, PR-C1 | §3.9 | Counting entries alone lets a few large values exhaust memory |
| R12 | Tags: eager index where available, lazy timestamps elsewhere, with the stamp cache pushed over the bus | FusionCache, HybridCache (and its flaw), Symfony, BentoCache, cacheable | **Adopt now**: index in PR-C1, stamps in PR-C2 (file) | §3.6 | Each backend gets the mode it can do cheaply |
| R13 | L2 authoritative; bus messages carry keys, not values; flush L1 after a bus gap | Ehcache, FusionCache, BentoCache | **Adopt now**, PR-T1 | §4 | No value travels the bus, so nothing stale or oversized can arrive by it |
| R14 | Backfill copies the remaining expiry, never a fresh TTL | Symfony `ChainAdapter`, survey trap | **Adopt now**, PR-T1 | §4.3 | Otherwise L1 outlives invalidations |
| R15 | Bounded lock waits, whose result is not stored | nginx `proxy_cache_lock_timeout` | **Adopt now**, PR-C1 | §3.4 | A slow loader must not become an outage, nor a double write |
| R16 | Two-step `Vary` keying; the refuse-to-store list; `Age`; invalidation on unsafe methods; must-revalidate respected | Django, RFC 9111, Varnish, nginx | **Adopt now**, PR-H1 | §9.1, §9.3 | Correctness of a shared HTTP cache |
| R17 | Hit-for-miss for uncacheable responses under coalescing | Varnish | **Adopt now**, PR-H1 | §9.5 | Coalescing would otherwise serialise traffic on uncacheable URLs |
| R18 | `X-Cache` status values (HIT, MISS, STALE, BYPASS, UNCACHEABLE) | nginx, `@nestjs/cache-manager` | **Adopt now**, PR-H1, N2 | §9.1, §10.3 | Debuggability |
| R19 | Spring's decorator semantics (`condition`, `unless`, evict after success by default, `all`) | Spring Cache | **Adopt now**, PR-N1 | §10.2 | Proven ergonomics, and familiar to Nest users from Java |
| R20 | Cache-key versioning per cache (`version`) | Django `VERSION` | **Adopt now**, PR-C1 | §3.7 | Deploying a shape change without a flush |
| R21 | Soft purge: `invalidateTags(…, { mode: "stale" })` | Fastly, Varnish xkey, Next.js `revalidateTag` | **Later** (PR-C1b) | §3.6 | Useful with stale-if-error, but not needed to ship |
| R22 | An auto-recovery queue for failed L2 and bus writes (last per key, newest wins) | FusionCache | **Later** | §4 | Rejoin-empty and flush-on-gap cover correctness; this only narrows the window |
| R23 | Named lifetime profiles (`life: "minutes"`) | Next.js `cacheLife` | **Later** | §3.1 | Sugar over `ttl`, `staleWhileRevalidate` and `staleIfError`; add once real configurations show which presets people want |
| R24 | Recyclable per-entry versions (`version` inside the entry) | Rails | **Later** | §3.7 | The per-cache version covers deploys; per-entry versions serve model-driven keys, which can wait |
| R25 | TinyLFU admission for memory and L1 | Caffeine, ristretto, moka | **Later** | §3.9 | Worth it only if L1 hit rate becomes a measured problem; a sketch is real code to maintain |
| R26 | `minUses` admission for L2 (store only after N requests) | nginx | **Later** | §9 | Keeps one-hit URLs out of L2; needs a counter per key |
| R27 | Surrogate-key headers for CDNs | Fastly, Cloudflare | **Later** (PR-H2b) | §9.3 | Small, but only useful behind a CDN that supports it |
| R28 | `update(key, fn)`: an atomic read-modify-write | JCache `EntryProcessor` | **Later** | §3.8 | Needs compare-and-set per driver; counters cover the common case |
| R29 | A TTL computed from the value (`ttl: (value) => ms`) | cachetools TLRU | **Adopt now**, PR-C1 | §3.1 | Short TTLs for empty results, one line of code |
| R30 | Lossy asynchronous `set` | ristretto | **Skip** | — | Surprising semantics, for contention a JS event loop does not have |
| R31 | Owner-routed fills and hot-key mirroring | groupcache | **Skip** | — | Needs a peer-to-peer layer; a shared L2 with a lock gives the same "one fill" property more simply |
| R32 | Quorum reads | — | **Skip** | §5.2 | Store-of-record machinery for a rebuildable cache |
| R33 | Process-local-only invalidation | dogpile `invalidate`, Symfony `LockRegistry` | **Skip** (the counterexample) | §4 | Exactly what the bus exists to avoid |

---

## 13. Testing

### 13.1 The suites [D]

| Suite | What | Where |
|---|---|---|
| Core unit tests | Codecs, the header, expiry, SWR, SIE, timeouts, jitter, XFetch, single-flight, the fence, events, the failure policy and typed-cache runtime, against the memory driver and a **fake clock** (`createCache({ now })`, internal) | `packages/bun-cache/__tests__/core/` |
| Driver conformance | `runCacheDriverConformance` (§6.2) against every built-in driver, and every backend that is configured | `__tests__/drivers/*.test.ts` |
| Cross-process | Locks, increments, the fence, and bus delivery from two processes, using bun-jobs' `spawn.ts` pattern | `__tests__/crossprocess/` |
| Fault injection | `faulty(inner, { failRate, failOn, hangMs, lagMs, down })` from `./testing`: the failure policy, circuits, timeouts, and the redundant combinator (§5.5) | `__tests__/resilience/` |
| Type tests | `createCache<Schema>`, `wrap`, `namespace`, the `Jsonify` view, and `cacheResponse`'s slot (§9.6), each with a negative control | `*.type-test.ts`, checked by `tsc` |
| HTTP | `cacheResponse` and `coalesceRequests` through `router.fetch()` **and** both adapters' `fetch()`. Hits and 304s; `Vary` variants; refuse-to-store cases; HEAD; unsafe-method invalidation; SWR replay; SIE on 5xx; `compression()` in both orders; hit-for-miss; a parity test against a served request | `bun-cache/__tests__/http/` |
| Nest | Module, decorators and interceptor through bun-nest's `BunHttpAdapter`, with `reflect-metadata`, in bun-nest's suite | `bun-nest/__tests__/cache/` |
| Keyv | The adapter under the real cache-manager 7.2.9 with keyv 5.6.0 and 6.1.0, in the bench package (to keep them out of devDependencies) | `bench/compat/` |

### 13.2 Backends: the same rules as bun-jobs [D]

- **Variables.** `BUN_CACHE_TEST_<X>_URL`, falling back to
  `BUN_JOBS_TEST_<X>_URL`, for `POSTGRES`, `MYSQL`, `MARIADB`, `MONGODB`,
  `REDIS` and the new `S3`.
  - **Unset:** the backend skips, with a visible `describe.skip("backend X:
    not configured")`.
  - **Set but unreachable:** the suite fails, naming the backend and
    pointing at `setup-databases.ts`. This is bun-jobs' `reportUnreachable`
    (`bun-jobs/__tests__/helpers/backends.ts:131-147`), copied.
  - **Why the fallback.** A machine set up for bun-jobs tests bun-cache with
    no extra export.
- **Own data.**
  - SQL tables use the prefix `bun_cache_test_`.
  - MongoDB collections use `bun_cache_test_`.
  - Redis uses database **13** (bun-jobs tests use 15, its bench 14), with
    the key prefix `bun-cache-test`.
  - S3 uses the bucket `bun-cache-test`.
  - Each run uses namespaces carrying its pid and timestamp, and deletes
    exactly those, never a prefix sweep (the shared-test-data rule).
- **S3: SeaweedFS in `setup-databases.ts`** (PR-C7), the one test server
  shared with bun-jobs (`bun-jobs-s3-driver.md` §7, PR-S0, whose proposed
  owner is the bun-jobs agent; PR-C7 reuses it). MinIO was the first choice, but its images could not be
  pulled and its repository is archived [M there].
  - **Docker only.** A `dockerOnly` plan entry, as MySQL's is
    (`scripts/setup-databases.ts:809`, `:1898`). It runs
    `chrislusf/seaweedfs:4.48`, pinned, with `server -s3`, as `bun-jobs-s3`
    on `127.0.0.1:8333` with `--ulimit nofile=65536:65536`, as the other
    containers have.
  - **The bucket.** It is created with a signed `PUT /<bucket>`, because Bun's
    `S3Client` cannot create buckets: no such method [M `s3-wire.ts`].
  - **Snap Docker.** *Corrected:* the "pipe through `| cat`" caveat
    (CLAUDE.md) is about a shell's captured output. The script's `run()`
    (`scripts/setup-databases.ts:317-340`) captures through `Bun.spawn`
    pipes, and it uses no bind mounts, so the caveat does not apply there.
    The one rule is to keep the server's data off `/tmp`, which snap Docker
    cannot read or write.
  - **What it prints.** `--dry-run` prints `BUN_JOBS_TEST_S3_URL=s3://test:test@127.0.0.1:8333/bun-jobs-test`;
    `BUN_CACHE_TEST_S3_URL` falls back to it, with its own bucket
    `bun-cache-test`. The test helper maps that onto `S3Client` options
    (`endpoint`, `bucket`, keys, `virtualHostedStyle: false`).
  - **Ownership.** The script belongs to no package, so the PR tells the
    agents whose suites use it (agentic-setup).
- **Heavy runs.** bun-cache's full suite with database URLs runs through the
  heavy-run wrapper, in the background with a ticket. bun-jobs' DB suite is
  marked `HEAVY_EXCLUSIVE=1` because it asserts durations on shared servers;
  bun-cache's suite should be measured for the same effect before it gets a
  `--parallel` width.
  - **Starting point.** `--parallel=4`, as bun-jobs uses, raised after a
    three-seed clean run.
  - **Targeted runs.** Running named files directly is not heavy (CLAUDE.md).

### 13.3 Negative controls [D]

Each new check is shown to fail on the base before it is trusted
(agentic-setup):

- a driver that drops tags must fail the tag cases;
- a fence that is skipped must fail the race case;
- an `increment` done as a read followed by a write must fail the
  200-caller case;
- a middleware that stores `private` responses must fail the HTTP suite.

---

## 14. Packaging

### 14.1 `@kingsleyweb/bun-cache` [D]

```
packages/bun-cache/
  lib/
    index.ts            createCache, the drivers, types, errors
    core/               cache, header, codecs, flight, fence, events, policy
    drivers/            memory, file, sqlite, sql/{postgres,mysql}, mongo, redis, s3, redundant
    http/index.ts       cacheResponse, coalesceRequests, addCacheTags   (subpath ./http)
    keyv/index.ts       toKeyvStore                                    (subpath ./keyv)
    testing/index.ts    runCacheDriverConformance, faulty, fakeClock   (subpath ./testing)
  __tests__/  bench/ (separate, unpublished)  scripts/build-declarations.ts
  tsconfig.json  tsconfig.build.json  consumer-check.json  README.md  bun-timings.json
```

- **The recipe.** It follows CLAUDE.md's "Packaging types" exactly:
  - `tsconfig.build.json` and `scripts/build-declarations.ts` are copied
    unchanged;
  - `dts/` is gitignored and built on `prepack`;
  - every `exports` entry is `{ "@kingsleyweb/source", "types", "default" }`
    in that order, with no fallback arrays.
  - **Keys:** `.`, `./http`, `./keyv`, `./testing`, `./lib/*.ts`,
    `./lib/*.js`, `./lib/*` and `./package.json`.
  - **Tested by** `__tests__/packaging.test.ts`.
  - `./scripts/**/*` goes in `tsconfig.json`'s `include`.
- **Engines.** `engines.bun: ">=1.4.2"`, the repo's floor. Every built-in
  bun-cache uses exists on it: `sql.listen` and `RedisClient.eval` are why
  the floor is 1.4.2. Zstd and `S3Client.list` are older [I; checked in
  PR-C1 against the 1.4.2 types].
- **Dependencies:**
  - **runtime:** `@kingsleyweb/bun-common`, for `native.ts`
    (`createDeferred`, `withTimeout`, `Mutex`, `etag`, `jsonClone`), logging
    and the router types for `./http`.
  - **optional peers:** `mongodb >=6`, `@types/bun >=1.4.2` and
    `typescript`, as bun-jobs declares them.
  - **No other runtime dependency.** SQL, Redis, S3, SQLite, zstd, SHA-256
    and structured clone are all Bun built-ins.
- **Declarations.** `checkPeerScopes` must show that no declaration reachable
  from `.` imports `mongodb`. The MongoDB driver's types are structural
  `*Like` interfaces, as in bun-jobs, so it does.
- **`consumer-check.json`.** It lists `.` and the three subpaths, with
  `./http` and `./testing` values. The consumer check runs under `bundler`,
  `bun-init` and `node16`, with `skipLibCheck` on and off.
- **Lint and typecheck.** Its own `eslint.config.mjs`, and an entry in
  `scripts/typecheck.ts`'s project list. The bench gets one too.

### 14.2 bun-common and bun-nest [D]

- **bun-common** gains `lib/cacheControl.ts` and the `first` option on
  `addResponseTransform` (PR-H0). Both are exported from the barrel and added
  to `consumer-check.json`.
- **bun-nest** gains `./cache` (§10.5).

### 14.3 bench [D]

`packages/bun-cache/bench/` is a **separate, unpublished package**, like
`packages/bun-jobs/bench/`. It is outside `workspaces`, with its own
`package.json`, `bun.lock` and `node_modules`, and is covered by
`scripts/typecheck.ts` and `bunx eslint .`.

**Comparators, pinned exactly**, given the August 2026 incident:

- `cache-manager@7.2.9` and `keyv@5.6.0`;
- `@keyv/redis`, `@keyv/postgres`, `@keyv/mysql`, `@keyv/sqlite` and
  `@keyv/mongo` at the version that peers on Keyv 5;
- `lru-cache@11.5.3`;
- `bentocache@1.6.1`.

Install scripts are not trusted: no `trustedDependencies`. It uses its own
databases (`bun_cache_bench`, Redis database 12).

---

## 15. Benchmarks and the regression guard

### 15.1 What is measured [D]

| Scenario | Backends | Contenders |
|---|---|---|
| `get` hit, `get` miss, `set` (100 B, 10 KB, 1 MB) | each driver | cache-manager + the matching Keyv store; lru-cache (memory) |
| `getMany`/`setMany` of 100 | each | cache-manager `mget`/`mset` |
| `getOrSet` under 1000 concurrent misses on one key, with a 20 ms loader: loader calls and p99 latency | each | cache-manager `wrap`, BentoCache `getOrSet` |
| Tagged set, plus `invalidateTags` of 1,000 tagged keys | each | BentoCache (tags), cacheable (tags) |
| L1 + L2 hit with the bus, and invalidation latency between two processes | Postgres, Redis | BentoCache with its Redis bus |
| HTTP: `router.fetch()` of a cached route against an uncached one; hit, 304 and miss; in process, no load generator, as in the Elysia evidence | memory, Redis | none: a baseline against ourselves |

### 15.2 The guard [D]

`bun bench/cache.ts --compare` and `--save-baseline` copy bun-jobs'
`bench/lib/compare.ts` design:

- Baselines in `bench/baselines/*.json` record each figure, **who led it**,
  the platform and the Bun version.
- `--compare` fails when a figure falls behind its own baseline by more than
  the tolerance (35%, as calibrated for bun-jobs, until bun-cache's own
  run-to-run spread is measured), **or when a rival overtakes us**. The
  overtaken check is the sharper one: a busy machine slows both sides.
- A baseline is only meaningful on the machine that recorded it.

---

## 16. Redundant drivers for bun-jobs: assessment

The user asked whether bun-jobs would benefit from redundant drivers too.
This is an assessment, not a plan. Paths below are relative to
`packages/bun-jobs/`.

### 16.1 Why a queue is harder than a cache

A cache can be rebuilt; **a queue is the store of record.** A lost or
duplicated write is a lost or duplicated job. Every guarantee bun-jobs gives
is **one atomic conditional write on one backend** [S]:

| Guarantee | The primitive | Where |
|---|---|---|
| Exactly-once claim | Postgres: a CTE with `FOR UPDATE SKIP LOCKED` and `UPDATE … RETURNING`. MySQL and MariaDB: pick then a conditional `UPDATE` in a transaction. SQLite: `BEGIN IMMEDIATE`. Redis: the `CLAIM` Lua script. MongoDB: `findOneAndUpdate`. File: `rename` of a marker | `lib/drivers/driver.ts:1992-2003`; `sql/dialect.ts:1472-1485`, `:997-1020`; `redis/scripts.ts:780-828`; `mongo/mongo-driver.ts:2645-2660`; `file-driver.ts:1382-1398` |
| Lock lease and fencing | A fresh `lockToken` per claim; `extendJobLock`, `completeJob` and `failJob` check it (`WHERE lock_token = ?`, Lua `holds()`, a MongoDB filter) | `driver.ts:1198-1200`, `:2031-2038`; `sql/sql-driver.ts:3210-3230`, `:3259-3261`; `redis/scripts.ts:194-198` |
| Stalled-job recovery | A conditional update on `lockExpiresAt ≤ now` (the caller's clock), run by whoever holds the `__win:fheal` sweep lease, itself taken by compare-and-set | `driver.ts:2711-2728`; `sql/sql-driver.ts:6828-6899`; `queue/BunQueueWorker.ts:5118-5135` |
| Delayed promotion, repeats | A ranged `UPDATE`. Repeats converge through deterministic ids (`repeat:<key>:<runAt>`) and add-if-absent | `sql/sql-driver.ts:6760-6790`; `queue/repeat.ts:20-32`; `driver.ts:1978-1986` |
| Flows | An atomic `recordChild` on the parent, then `markChildRecorded`, with redelivery to repair a crash between them. The parent must be on the same driver | `driver.ts:2280-2329`; `queue/BunQueueWorker.ts:3463` |
| Events | A serial `seq` in SQL with a 30 s gap retry; a counter in MongoDB; pub/sub in Redis; byte offsets in files | `sql/sql-driver.ts:7355-7501`; `eventGaps.ts:1-60`; `mongo/mongo-driver.ts:5745-5833` |
| Queue-state compare-and-set (summon markers and claims, limits, the sweep lease, debounce) | `setQueueState(expected)` with versions that only increase | `driver.ts:2759-2796`; `summon/claim.ts:162-227`; `sql/sql-driver.ts:7023-7106` |

**Nothing handles a failover today:**

- MongoDB forces `readPreference: "primary"`, because reads that decide
  writes must not see a lagging secondary (`mongo/mongo-driver.ts:676-693`).
- Redis has no Sentinel support. It relies on Bun's `autoReconnect`
  (`redis/redis-driver.ts:585-619`).
- SQL retries only deadlocks (`sql/dialect.ts:1029-1120`), not dropped
  connections.
- No README mentions failover, Patroni or Sentinel.

### 16.2 What each strategy would do to those guarantees

| Strategy | What survives | What breaks |
|---|---|---|
| **Write-all, failover reads** (§5 applied to bun-jobs) | Nothing that matters | **Split brain on the first failover.** Each backend claims the same job independently, so it runs twice. Each side fences only its own token, so both completions succeed. Both sides win compare-and-set at the same version: two summon claimants, doubled limits, two sweepers. Event `seq`s collide, and flows split across backends never complete |
| **Primary and standby, failing over inside bun-jobs** (the primary is the only writer; the standby takes over on health failure) | Claim-once, *if* the standby is current | With asynchronous replication, the standby is behind. Claims not yet replicated show `waiting` and run again. A lagging `lockExpiresAt` looks lapsed, so live jobs are stolen. Compare-and-set versions roll back, so a stale writer wins again and summon claim-once breaks. Event `seq` rewinds below subscribers' cursors. And bun-jobs cannot tell from outside whether a standby is current: only the database's own HA machinery (fencing, timelines, `pg_rewind`, replica-set elections) can |
| **Sharding queues across drivers** | Everything, per queue, because each queue lives on exactly one backend | It is **capacity, not redundancy**. Losing a shard stops its queues. It is already possible today, by giving different `BunJobs` instances different drivers. Only flows across queues on different shards would break, since a parent must share its child's driver |
| **None: defer to the backend's own HA** (Postgres streaming replication with Patroni, Redis Sentinel or Cluster, MongoDB replica sets with majority writes, MySQL group replication) | Everything the backend's failover preserves. With synchronous or majority commit, that is every acknowledged write | A failover's in-flight connections drop, and bun-jobs' existing recovery takes over: a claim whose reply was lost comes back through the stalled sweep, at the cost of one `stalledCount` (`queue/BunQueueWorker.ts:2508-2522`) |

### 16.3 Verdict: no

**Do not build redundant drivers for bun-jobs.** Write-all breaks claim-once
on its first failover. A primary/standby switch inside bun-jobs reimplements,
worse, what each database's HA already does with information bun-jobs cannot
see. Sharding is already possible, and is not redundancy.

**What to do instead** (a docs PR for the bun-jobs agent, about 1.5 d with
measurements):

1. **A "High availability" README section, per driver.** Use the database's
   HA, and here is how bun-jobs behaves across its failover:
   - **Postgres** with Patroni: require synchronous commit for zero loss;
     connect through the Patroni leader endpoint or HAProxy.
   - **MySQL** with group replication.
   - **MongoDB:** a replica set with `w: "majority"`; the driver already
     reads from the primary.
   - **Redis:** Sentinel is unsupported. Use a managed failover endpoint, and
     note that Redis replication is asynchronous, so a failover can lose
     acknowledged jobs.
   - **SQLite and file:** single host, no HA.
2. **Measure one failover per server driver** with a container kill, and
   record what a worker sees. This is the evidence the README section quotes.
3. **Consider, separately, retrying dropped connections in the SQL driver.**
   Today it retries only deadlocks.

Because the verdict is "no", no dedicated bun-jobs redundancy plan is needed.
The docs work above is a small item for the bun-jobs agent, which §19 Q10 puts
to the user.

---

## 17. Measured evidence

All on Bun 1.4.3 (`bbdc5a519`), on the shared 16-thread laptop, at load
averages of 5 to 35. Re-run any script with the command in
[`evidence/bun-cache/README.md`](evidence/bun-cache/README.md).

| Spike | Finding | Used in |
|---|---|---|
| `s3-wire.ts` (a recording stub, so client side only) | Methods: `write`, `file`, `delete`/`unlink`, `exists`, `size`, `stat`, `list`, `presign`. No user metadata, no conditional headers, no batch delete, no bucket creation. `Content-Type` with parameters reaches the wire and comes back from `stat()` intact. Ranged reads work. A missing key throws `S3Error` `NoSuchKey`. `list()` parses `ListObjectsV2` | §7.8, D6 |
| `sqlite-wal.ts` | `bun:sqlite` WAL NORMAL, 100 B: 19.9k sets/s one per statement, 280k/s batched 500 per transaction, 403k hits/s, 544k misses/s. `synchronous=FULL`: 2.2k sets/s. Bun `SQL` sqlite: 21.7k sets/s and 81.8k hits/s. At 10 KB: 10.3k against 6.8k hits/s | D7, §7.3 |
| `pg-listen.ts` | `sql.listen` and `sql.notify`: sequential p50 0.137 ms, p95 0.254 ms, p99 0.688 ms; 500 at once arrive within 23 ms (21.5k/s); an 8000-byte payload is rejected ("payload string too long") | §4.2 |
| `notify-probes.ts` | Redis pub/sub p50 0.043 ms, p99 0.098 ms (Redis 8.0.5); keyspace notifications off. MongoDB 7.0.41 is standalone: a change stream is refused; `ttlMonitorSleepSecs` is 60 | §4.2, §7.6, §7.7 |
| `single-flight.ts` | 1000 concurrent misses: the loader runs 1000 times naively, once with single-flight (loaders of 0, 5 and 50 ms). 100 keys × 10 callers: 100 loads. A throwing loader rejects all 1000 with one error, and the next call reloads. Hit overhead 0.25 µs, no worse than without single-flight | D3, §3.4 |
| `codecs.ts` | What JSON, `bun:jsc` and `node:v8` round-trip (table in §3.10). 70 KB payload: JSON 70,397 B, 66 µs encode, 117 µs decode; `bun:jsc` 34,531 B, 235 µs, 110 µs; `v8` the same bytes at 458 µs encode. zstd 42× in 50 µs; gzip-6 22× in 196 µs | D2, §3.10, §3.11 |
| `codec-crossprocess.ts` | A `bun:jsc` buffer carries a `Blob`'s bytes and decodes in another process. A `File` decodes as a `Blob` (no name), and the type gains `;charset=utf-8` | §3.10 |
| `sql-primitives.ts` | A 1 MiB bytes column round-trips byte-equal on SQLite (`Uint8Array`), Postgres, MySQL and MariaDB (`Buffer`). 200 concurrent atomic increments: exact on all four (`RETURNING` or `LAST_INSERT_ID`). Sweep of 2,000 rows in 2.7 to 10.4 ms. `DELETE` result: `count` on Postgres and SQLite, `affectedRows` on MySQL and MariaDB | §3.8, §7.3 to §7.5 |
| `file-store.ts` | 10,000 × 1 KiB: flat 5.1k sets/s, 20k gets/s, a 7 ms walk; 256×256 sharding 3.0k sets/s, 24k gets/s, a 352 ms walk over 9,268 directories | §7.2 |
| `typed-slot/` | A plain middleware between `validate()` and the handler silently loses the typed query; branded `__shape?: never`, it makes `req.query` `never`, which is an error on use. Before the validator, and alone, both are fine | §9.6 |
| `keyv-compat/` | cache-manager 7.2.9 + Keyv 5.6.0: `wrap` loads once; the store sees `set("keyv:k", '{"value":…,"expires":…}', 60000)`; `clear` with namespace `keyv`. + Keyv 6.1.0: `wrap` loads twice; `ttl()` is `undefined`; no namespace | D12, §10.4 |

**Taken from documentation, not measured here:**

- everything about a real S3 server: metadata limits, consistency,
  conditional writes, lifecycle granularity, pricing;
- MongoDB tailable cursors on capped collections;
- the backends' size limits in §7.10;
- every prior-art claim in §11, marked [W] or [I] there.

---

## 18. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **`bun:jsc`'s serialisation format changes between Bun versions**, so entries written by a newer Bun do not decode on an older one during a rolling deploy | Medium over years [I] | The codec id and format byte are in the header; a decode failure is a miss, not an error (§3.2); the README says to use `codec: "json"` across mixed Bun versions; a test pins today's bytes so a Bun upgrade that changes them is noticed |
| **`bun:sqlite` blocks the event loop**: large values or a long checkpoint stall every request | Medium | One connection per file per process; a small `busy_timeout` with retry in JS (bun-jobs' lesson); the README says to put values over ~100 KB elsewhere; `PRAGMA wal_autocheckpoint` left at its default |
| **The HTTP cache serves one user's response to another** | Low with the defaults, but severe | The refuse-to-store list (`private`, `Set-Cookie`, `Authorization` without `public`) and `Vary` keying are on by default, with no global switch to turn them off; per-route `key` functions for authenticated caching; in Nest, the README directs authenticated routes to the interceptor (after guards), never `app.use(cacheResponse)` |
| **Bun's `S3Client` gains or changes options** (metadata, conditional writes), making today's workarounds obsolete | High (good news) | The S3 driver's capabilities are computed, not hard-coded; `s3-wire.ts` is re-run on each Bun upgrade |
| **Keyv and cache-manager churn** (Keyv 6 already breaks cache-manager 7), and **supply-chain risk** in that family | High | The adapter is structural (no dependency); exact pins in the bench; the README pins Keyv 5.6.0 and links #1692 |
| **Scope**: 27 days for the package before any utility ships | Certain | PR slicing (§20) ships a usable cache after PR-C1, about 6 days; each driver is independent |
| **Ownership**: a new package with no owning session | Certain | §19 Q3 |
| **Clock skew** between hosts shifts expiry and tag stamps | Low | Documented; stamps compare against the writer's clock, like bun-jobs' leases (§16.1) |
| **Redis in cluster mode**: per-namespace hash tags concentrate a namespace on one shard | Medium for big namespaces | Documented; an option to hash-tag per key, giving up atomic tag operations |

---

## 19. Open questions for the user

Each question has a recommended answer.

1. **Include a Redis driver?** It is not in your list, but bun-jobs supports
   Redis and Bun has `RedisClient` built in. **Recommended: yes**, in PR-C5.
   It is the most common shared cache backend, its native TTL, `INCRBY`, Lua
   and pub/sub make it the easiest driver to make fully capable, and its
   pub/sub is the fastest bus measured (p50 0.043 ms).
2. **Share a driver layer with bun-jobs?** **Recommended: not now** (§8.3).
   bun-cache copies about 400 lines of helpers with origin comments. The
   schema-sync engine is extracted into a shared package when bun-cache's
   schema first changes, under its own plan and the bun-jobs agent's review.
3. **Who maintains bun-cache?** **Recommended:** a new **bun-cache agent**
   role, owning `packages/bun-cache/**`, its bench and README, started when
   PR-C1 is approved for building.
   - Until that agent exists, the features agent builds it, as it builds
     cross-package work today.
   - The bun-jobs agent reviews the SQL, MongoDB and Redis driver PRs,
     because the prior art is its own.
   - The bun-common agent owns PR-H0 and reviews the HTTP PRs; the bun-nest
     agent owns or reviews PR-N1 and N2.
   - The examples agent writes the examples, and the bun-jobs-ui agent
     reviews the playground addition.
4. **Redundant drivers (§5): build?** **Recommended: not in the first
   release.** Build PR-R1 (~4 d: `write: all | primary`, `read: failover |
   race`, circuits, rejoin-empty, counters on the primary only) only when a
   deployment asks, and never quorum. Meanwhile, document each backend's
   own HA.
5. **The default codec: structured clone, or JSON?** **Recommended:
   structured clone** (D2). Correct `Date`, `Map`, `Set` and binary values
   are worth 170 µs of encode on a 70 KB value; JSON stays one option away.
6. **Should `cacheControl()` live in bun-common, and the response cache in
   `bun-cache/http`?** **Yes** (D10).
7. **HTTP request directives: ignore by default?** **Yes.** As CDNs do; a
   client's `no-cache` should not bypass a server-side cache unless the
   route asks for that (§9.1).
8. **Cross-runtime caches:** should bun-cache promise that non-Bun readers
   can read its entries? **Recommended: no.** Only with `codec: "json"`, and
   documented. The header format is specified in the README so another
   language *could* read it.
9. **The Nest decorators' names collide with `@nestjs/cache-manager`'s**
   (`CacheKey`, `CacheTTL`) and with the `cacheable` npm package's name
   (`Cacheable`). **Recommended: keep them.** They are what Nest users will
   look for, they live under a separate import path, and our interceptor
   reads both packages' metadata (§10.3). The alternative is a `Bun` prefix
   on every decorator.
10. **bun-jobs and redundancy (§16):** **Recommended: no redundant drivers
    for bun-jobs.** Instead, a small docs PR by the bun-jobs agent: a "High
    availability" section per driver, with one measured container-kill
    failover per server driver.
11. **Ship the Keyv adapter at all?** **Recommended: yes, small (PR-K1).**
    It is the bridge for existing `@nestjs/cache-manager` code. The native
    module stays the recommended path.

---

## 20. PR slicing and effort

Focused days for someone who knows the code, as in the other plans. Each PR
passes the full gate alone: `bun scripts/typecheck.ts`, `CI=1 bunx eslint .`
in each touched package, `bun run test` plus `bun test --randomize` with two
seeds, and the consumer check where `exports` changed. **Each PR that adds
user-facing API sends the examples agent a change report before merging**,
and the last PR of each feature adds it to the playground.

### 20.1 The package

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-C1** core + memory | The package skeleton (the dts recipe, consumer-check, the packaging test, lint, the typecheck entry). `createCache`, `Cache<Schema>`, the header, codecs (`structured`, `json`, `raw`, custom), compression, namespaces and `version`, long-key hashing. `getOrSet` and `wrap` with single-flight (R1, R2, R15). SWR, SIE, soft and hard timeouts, `refreshAhead`, `earlyExpiry`, jitter, negative caching, `ttl(value)` (R3 to R8, R29). Tags in index mode with the fence (R12). Counters, events, `stats()`, `LoggerLike`, the failure policy and circuit (R9, R10). The memory driver (LRU, `maxBytes`, R11). The conformance kit with fake clock and `faulty`. README | — | ~6 d |
| **PR-C2** file | The file driver: sharding, atomic rename, lock files, stamp-mode tags (and the core's stamp mode), the sweeper with size caps, the polled bus log | PR-C1 | ~2.5 d |
| **PR-C3** SQLite | `bun:sqlite` driver; one connection per file per process; locks; the polled bus table | PR-C1 | ~2 d |
| **PR-C4** SQL | Postgres, MySQL and MariaDB through Bun's `SQL`; `LISTEN`/`NOTIFY` bus; polled bus elsewhere; `unlogged`; `syncSchema()` returning `[]`; the copied connection helpers with the drift test. The bun-jobs agent reviews | PR-C1 | ~4 d |
| **PR-C5** Redis | The Redis driver: Lua scripts, pub/sub bus, `cluster`. The bun-jobs agent reviews | PR-C1 | ~2.5 d |
| **PR-C6** MongoDB | The MongoDB driver: TTL indexes, change-stream or tailable-cursor bus, `RETIRED_INDEXES`. The bun-jobs agent reviews | PR-C1 | ~2.5 d |
| **PR-C7** S3 | The S3 driver (stamp mode, `Content-Type` expiry, sweeper, lifecycle docs); SeaweedFS in `setup-databases.ts` (shared with bun-jobs' PR-S0); the conditional-`PUT`-through-`fetch` question, since answered by `bun-jobs-s3-driver.md` §3 (§7.8) | PR-C2 (stamp mode) | ~3.5 d |
| **PR-T1** multi-tier | L1 (values, `clone`), the bus wiring and gap flush, backfill keeping expiry, `{ tier: "l2" }`, `redisBus` and `pgBus` (R13, R14) | PR-C1 and one bus driver (C4 or C5) | ~4 d |
| **PR-B1** bench | The bench package, contenders, baselines, `--compare` | the drivers it measures | ~3 d |
| *PR-C1b* | soft purge (`mode: "stale"`, R21) | PR-C1 | *~1 d, later* |
| *PR-R1* | redundant drivers (§5) | PR-T1 | *~4 d, only on demand (Q4)* |
| | **Total (package ~27 d, plus the bench ~3 d; without the later items)** | | **~30 d** |

### 20.2 The utilities

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-H0** bun-common | `addResponseTransform(t, { first })`; `cacheControl()` and `formatCacheControl()` with typed directives; tests; README. **Owner: the bun-common agent** | — | ~1.5 d |
| **PR-H1** `bun-cache/http` | `cacheResponse` (keys, `Vary` variants, refuse-to-store, TTL from headers, `Age`, ETag and 304, HEAD, unsafe-method invalidation, `addCacheTags`, hit-for-miss, coalescing), `coalesceRequests`, the slot brand and its type cases. The bun-common agent reviews | PR-C1, PR-H0 | ~4.5 d |
| **PR-H2** HTTP SWR and SIE | Background replay through `fetch()`; stale on 5xx and on timeout; `streams: { buffer }` after a spike | PR-H1 | ~2 d |
| *PR-H2b* | surrogate-key headers (R27) | PR-H1 | *~0.5 d, later* |
| **PR-N1** bun-nest `./cache` | `BunCacheModule` (`forRoot`, `forRootAsync`, names), `InjectCache`, `getCacheToken`, the registry, `@Cacheable`, `@CacheEvict`, `@CachePut`; packaging (optional peer, consumer check). **Owner: the bun-nest agent** | PR-C1 | ~3 d |
| **PR-N2** interceptor | `BunCacheInterceptor`, `@CacheKey`, `@CacheTTL`, `@CacheTags`, `@NoCache`, reading `@nestjs/cache-manager`'s metadata | PR-N1 | ~2 d |
| **PR-K1** Keyv | `bun-cache/keyv` `toKeyvStore` (both contracts); compat tests in the bench; README for `@nestjs/cache-manager` | PR-C1, PR-B1 (for the compat harness) | ~1.5 d |
| *EX* | examples per PR, on memory plus one server, and the full sweep once per merge window | each PR | *~4 d (examples agent)* |
| *PG* | a playground page: cached routes showing `X-Cache`, stats, and invalidation buttons | PR-H1 | *~1 d (bun-jobs-ui agent reviews)* |
| | **Total (utilities)** | | **~14.5 d** |

**Order.** PR-C1 first. Then PR-C3 and PR-C4 (the drivers most users want),
PR-H0 in parallel by the bun-common agent, PR-T1, PR-H1, PR-N1, then the
rest. PR-C2 must precede PR-C7, because it brings stamp mode.

---

## 21. Names needing approval

Every new public name.

| Name | Kind | Where | Why this name |
|---|---|---|---|
| `@kingsleyweb/bun-cache` | package | `packages/bun-cache` | the repo's `bun-*` pattern |
| `./http`, `./keyv`, `./testing` | subpaths | bun-cache | what each holds |
| `./cache` | subpath | bun-nest | beside `./jobs` |
| `createCache`, `Cache<Schema, Tag>`, `CreateCacheOptions` | function, types | root | the common name across libraries |
| `get`, `getEntry`, `has`, `getMany`, `set`, `setMany`, `touch`, `delete`, `deleteMany`, `clear`, `invalidateTags`, `getOrSet`, `wrap`, `increment`, `decrement`, `namespace`, `on`, `stats`, `close`, `syncSchema` | methods | `Cache` | the vocabulary of `Map`, cache-manager and BentoCache |
| `ttl`, `expiresAt`, `staleWhileRevalidate`, `staleIfError`, `softTimeout`, `hardTimeout`, `refreshAhead`, `earlyExpiry`, `jitter`, `lock`, `onLockTimeout`, `cacheUndefined`, `negativeTtl`, `tags`, `signal`, `tier` | options | per call and cache | RFC 5861's names for the stale windows; the rest say what they do |
| `failSafeBackoff`, `tagStampTtl`, `tagStampCacheMs`, `maxKeyLength`, `maxEntryBytes`, `maxEntries`, `maxBytes`, `sweepInterval`, `timeout`, `strict`, `circuit`, `version`, `codec`, `compress`, `validate`, `l1`, `bus` | options | `CreateCacheOptions` | — |
| `mode: "delete" \| "stale"` | option | `invalidateTags` | the stale mode is later (R21) |
| `memoryDriver`, `fileDriver`, `sqliteDriver`, `postgresDriver`, `mysqlDriver`, `mariadbDriver`, `mongoDriver`, `redisDriver`, `s3Driver`, `redundant`, `fromSimpleDriver` | functions | root | `<backend>Driver`, matching the backend names users type |
| `redisBus`, `pgBus`, `CacheBus` | functions, type | root | the bus is separable from the driver |
| `CacheDriver`, `CacheDriverCapabilities`, `StoredEntry`, `TagFence`, `BusMessage`, `Codec` | types | root | the contract |
| `tags: "index" \| "stamps"`, `fence`, `bus`, `ttl: "native" \| "sweep"`, `atomicIncrement`, `lock`, `multiProcess` | capability fields | `CacheDriverCapabilities` | — |
| `CacheDriverError`, `CircuitOpenError`, `LoaderTimeoutError`, `UnsupportedOperationError`, `EntryTooLargeError`, `CacheNotReadyError` | error classes | root, bun-nest | `EntryTooLargeError` is thrown only under `strict` |
| events: `hit`, `stale-hit`, `miss`, `set`, `fenced`, `delete`, `invalidate`, `load`, `refresh`, `stale-if-error`, `lock-wait`, `lock-timeout`, `evict`, `oversize`, `uncacheable`, `error`, `circuit-open`, `circuit-close`, `member-down`, `member-up`, `member-dirty` | event names | `Cache.on` | — |
| `runCacheDriverConformance`, `faulty`, `fakeClock` | functions | `./testing` | after `runProviderConformance` |
| `cacheResponse`, `coalesceRequests`, `addCacheTags` | functions | `./http` | not `cache()`: too generic beside the router's route-match cache (`getCacheKey`, `clearRouteCache`) |
| `varyBy`, `query`, `host`, `bypass`, `statusHeader`, `honorRequest`, `allowSetCookie`, `statuses`, `omitHeaders`, `invalidateOnUnsafe`, `streams`, `revalidate`, `coalesce`, `uncacheableTtl`, `etag` | options | `cacheResponse` | — |
| `X-Cache` values `HIT`, `MISS`, `STALE`, `BYPASS`, `UNCACHEABLE` | header | `cacheResponse`, interceptor | nginx's and Nest's convention |
| `x-bun-cache-revalidate` | internal header | `cacheResponse` | carries the per-process replay token |
| `cacheControl`, `formatCacheControl`, `CacheControlDirectives` | function, type | bun-common | the header's name |
| `addResponseTransform(t, { first })` | option | bun-common `BunResponse` | — |
| `toKeyvStore` | function | `./keyv` | says what it returns |
| `BunCacheModule`, `forRoot`, `forRootAsync`, `InjectCache`, `getCacheToken`, `BUN_CACHE`, `BUN_CACHE_OPTIONS` | module, decorator, tokens | bun-nest `./cache` | follow `BunJobsApiModule` and `InjectJobsApi` |
| `Cacheable`, `CacheEvict`, `CachePut` (`key`, `ttl`, `tags`, `cache`, `condition`, `unless`, `beforeInvocation`, `all`) | method decorators | bun-nest `./cache` | Spring's names (Q9) |
| `BunCacheInterceptor`, `CacheKey`, `CacheTTL`, `CacheTags`, `NoCache` | interceptor, decorators | bun-nest `./cache` | `@nestjs/cache-manager`'s names, where they exist (Q9) |
| `bun_cache_` (SQL, MongoDB), `bun-cache` (Redis, file, S3) | default prefixes | drivers | the package name |
| `BUN_CACHE_TEST_<X>_URL`, `BUN_CACHE_TEST_S3_URL` | env variables | tests, `setup-databases.ts` | beside `BUN_JOBS_TEST_*` |

---

## Appendix: evidence

[`evidence/bun-cache/`](evidence/bun-cache/README.md) holds the spikes and
their raw output. Like the other evidence folders, it is not part of any
package, and the repo's tooling does not typecheck or lint it. The prior-art
reading (§11) is cited by link and is not copied into the folder.
