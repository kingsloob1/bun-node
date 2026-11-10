# @kingsleyweb/bun-cache

Caching over pluggable drivers, for Bun. One typed API — TTLs, tags,
single-flight `getOrSet`, stale-while-revalidate and stale-if-error, counters,
events and statistics — over a byte-level driver contract, built on
[`@kingsleyweb/bun-common`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md).

**Requires Bun ≥ 1.4.2.** Bun runs the shipped TypeScript source (`main` is
`lib/index.ts`); your type checker reads the built declarations in `dts/`.

## Installation

```sh
bun add @kingsleyweb/bun-cache
bun add mongodb            # only if you use mongoDriver()
```

- **Bun ≥ 1.4.2** (`engines.bun`). An optional `@types/bun >=1.4.2` peer
  warns a project on older Bun types.
- **`@kingsleyweb/bun-common`** is a dependency, installed with it: the
  logger, the HTTP middleware and the throttle and live-invalidation
  contracts come from there.
- **`mongodb` (`>=6`)** is an optional peer, needed only by `mongoDriver()`.
  Every other driver is built on Bun's own clients (`bun:sqlite`, `SQL`,
  `RedisClient`, `S3Client`) or on `fetch`, with nothing else to install.
- **`typescript`** (`^5.9.3 || ^6.0.0`) is an optional peer, for the
  shipped declarations.

## Features

- **One typed API over every driver**: keys, namespaces and versions; TTLs
  per entry, per value or computed, with jitter; `getOrSet` and `wrap` with
  an in-process single-flight, collective cancellation and an opt-in
  cross-process lock ([Stampede protection](#stampede-protection)).
- **Staleness**: stale-while-revalidate, stale-if-error with a fail-safe
  backoff, soft and hard loader timeouts, eager refresh and probabilistic
  early expiry ([Staleness](#staleness)).
- **Tags**: eager invalidation with a write fence on indexed drivers, lazy
  stamps on the rest, and a soft purge that marks entries stale instead of
  deleting them ([Tags](#tags)).
- **Counters** ([Counters](#counters)), **codecs** (structured clone, JSON,
  raw or your own, [Codecs](#codecs)) and **compression** (zstd, gzip,
  Brotli, raw DEFLATE or your own, with a decompression cap,
  [Compression and limits](#compression-and-limits)).
- **Encryption at rest** with AES-256-GCM, key rings and rotation, keys from
  a KMS, user ciphers, and keyed hashing of names
  ([Encryption at rest](#encryption-at-rest), [Hiding names](#hiding-names)).
- **Typed caches** and runtime-checked reads with any Standard Schema
  ([Typed caches, and `validate`](#typed-caches-and-validate)).
- **Events, statistics and a failure policy** with a circuit breaker: a
  cache that is down is bypassed, never fatal
  ([Events, statistics, logging](#events-statistics-logging),
  [The failure policy](#the-failure-policy)).
- **Multi-tier caching**: an L1 memory tier per process over a shared
  driver, kept coherent by a bus ([Multi-tier](#multi-tier)).
- **Redundant drivers**: one driver made of several, with failover
  ([Redundant drivers](#redundant-drivers)).
- **Twelve drivers**: memory, file, SQLite, Postgres, MySQL, MariaDB, Redis,
  MongoDB, S3, Azure Blob Storage, Cloudflare KV and Cloudflare D1
  ([The driver matrix](#the-driver-matrix)), plus custom drivers proved by a
  conformance kit ([Custom drivers](#custom-drivers)).
- **HTTP response caching** for bun-common's router and both HTTP adapters,
  with stale serving and CDN tags ([HTTP response caching](#http-response-caching)).
- **Integrations**: a Keyv store for cache-manager and
  `@nestjs/cache-manager` ([Keyv](#keyv-and-nestjscache-manager)), a shared
  store for bun-common's `throttle()` ([Throttling](#throttling)), and a bus
  for bun-common's live invalidation
  ([Live invalidation across processes](#live-invalidation-across-processes)).

### Entry points

| Import | What it holds |
|---|---|
| `@kingsleyweb/bun-cache` | `createCache`, every driver, `redundant`, `fromSimpleDriver`, `redisBus` and `pgBus`, the error classes and the types |
| `@kingsleyweb/bun-cache/http` | `cacheResponse`, `coalesceRequests`, `addCacheTags` ([HTTP response caching](#http-response-caching)) |
| `@kingsleyweb/bun-cache/keyv` | `toKeyvStore` ([Keyv](#keyv-and-nestjscache-manager)) |
| `@kingsleyweb/bun-cache/throttle` | `cacheThrottleStore` ([Throttling](#throttling)) |
| `@kingsleyweb/bun-cache/live` | `cacheLiveBus` ([Live invalidation](#live-invalidation-across-processes)) |
| `@kingsleyweb/bun-cache/testing` | the driver and cipher conformance kits, `faulty`, `fakeClock` ([Testing helpers](#testing-helpers)) |
| `@kingsleyweb/bun-cache/cloudflare-worker` | the Worker you deploy for the Cloudflare drivers ([The Cloudflare KV driver](#the-cloudflare-kv-driver)) |

Every entry is ESM with named exports. Runnable examples for each area are
in [`examples/bun-cache`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-cache).
In a NestJS app, bun-nest's
[cache module](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-nest/README.md#the-cache-module)
provides these caches with decorators and a response interceptor.

### Contents

- Using the cache: [Quick start](#quick-start) · [The API](#the-api) ·
  [Options](#createcache-options) · [Stampede protection](#stampede-protection) ·
  [Staleness](#staleness) · [Tags](#tags) · [Counters](#counters) ·
  [Codecs](#codecs) · [Compression and limits](#compression-and-limits) ·
  [Encryption at rest](#encryption-at-rest) ·
  [Namespaces and versions](#namespaces-and-versions) ·
  [Typed caches](#typed-caches-and-validate) ·
  [Events, statistics, logging](#events-statistics-logging) ·
  [The failure policy](#the-failure-policy) · [Errors](#errors) ·
  [Multi-tier](#multi-tier) · [Redundant drivers](#redundant-drivers)
- Drivers: [Custom drivers](#custom-drivers) ·
  [Testing helpers](#testing-helpers) · [The driver matrix](#the-driver-matrix) ·
  [Memory](#the-memory-driver) · [File](#the-file-driver) ·
  [SQLite](#the-sqlite-driver) ·
  [Postgres, MySQL and MariaDB](#the-postgres-mysql-and-mariadb-drivers) ·
  [Redis](#the-redis-driver) · [Upstash](#upstash-and-other-managed-redis) ·
  [MongoDB](#the-mongodb-driver) · [S3](#the-s3-driver) ·
  [Azure Blob Storage](#the-azure-blob-storage-driver) ·
  [Cloudflare KV](#the-cloudflare-kv-driver) · [Cloudflare D1](#the-cloudflare-d1-driver)
- Integrations: [HTTP response caching](#http-response-caching) ·
  [Keyv and `@nestjs/cache-manager`](#keyv-and-nestjscache-manager) ·
  [Live invalidation](#live-invalidation-across-processes) ·
  [Throttling](#throttling)

## Quick start

```ts
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";

const cache = createCache({
  driver: memoryDriver(),
  namespace: "app",        // every key is stored under "app"
  ttl: 60_000,             // ms; null = no expiry; or (value) => ms
});

await cache.set("user:42", user, { ttl: 300_000, tags: ["users", "org:7"] });
const u = await cache.get("user:42");               // User | undefined
const report = await cache.getOrSet("report:q3", () => buildReport(), {
  ttl: 600_000,
  staleWhileRevalidate: 60_000,
  staleIfError: 3_600_000,
});
await cache.invalidateTags(["org:7"]);
const n = await cache.increment("hits:/home", 1, { ttl: 86_400_000 });
const users = cache.namespace("users");             // a view, storing app:users:*
const cachedFetch = cache.wrap(fetchUser, { key: (id: number) => `user:${id}` });
```

Every duration is in **milliseconds**; an absolute expiry is
`expiresAt: Date | number`, an epoch in ms. `ttl` and `expiresAt` are
exclusive. `ttl: null` means no expiry.

## The API

| Group | Methods |
|---|---|
| Read | `get(key)`, `getEntry(key)` (value with `freshUntil`, `expiresAt`, `tags`, `createdAt`, `stale`), `has(key)`, `getMany(keys)` |
| Write | `set(key, value, opts?)`, `setMany(entries)`, `touch(key, ttl)` |
| Delete | `delete(key)`, `deleteMany(keys)`, `clear()` (this namespace only), `invalidateTags(tags)` |
| Load | `getOrSet(key, loader, opts?)`, `wrap(fn, { key, ...opts })` |
| Counters | `increment(key, by?, opts?)`, `decrement(key, by?, opts?)` |
| Scope | `namespace(name)` — a view of the same cache with a longer prefix |
| Observe | `on(event, listener)`, `stats()`, `describeKey(key, tags?)` (the names the store holds, [Hiding names](#hiding-names)) |
| Lifecycle | `close()`, `syncSchema(opts?)` |

`get` answers fresh values only: past its TTL an entry is a miss. `getEntry`
is the escape hatch — it returns stale entries (still within their stale
window) with `stale: true`.

**`setMany(entries)`** takes `[key, value, options?]` triples and answers how
many it stored. Each entry goes through `set`'s pipeline with its own options
(TTL, tags, `compress`, the entry limit, encryption), but the driver gets the
batch in one call: one statement per 1,000 entries on Postgres (several in one
transaction), one transaction on SQLite, MySQL and MariaDB, one script per
1,000 entries on Redis, one `bulkWrite` on MongoDB, and the cloud drivers' bulk
paths. Tagged entries on a driver with a tag index need the write fence
([Tags](#tags)), which the contract's `setMany` does not take: the built-in
index drivers (memory, SQLite, Postgres, MySQL, MariaDB, Redis, MongoDB,
Cloudflare D1, and `redundant()` when its first member does) take such a
batch in one call too (`setManyFenced`, each entry held to its own
fence, refused entries reported as `fenced` in their place), and a driver
without it gets a fenced `set` per entry, all issued together. A key given
twice keeps its last write.
An entry over the limit is skipped with its `oversize` event in its place, and
events and stats follow the batch's order. On SQLite, Postgres, MySQL and
MariaDB a batch is stored whole or not at all; a driver failure under the
default policy stores nothing of it and answers `0`, with one `error` event
and a `fenced` event per entry (as a failed `set` reports itself). A throw
while preparing an entry (a codec's, a refused tag, or under `strict` an
oversize entry or a failed seal) writes the entries before it, then throws.

## `createCache` options

Every option but `driver` is optional. Most of the per-entry ones are also
accepted per call (`set`, `getOrSet`, `wrap`), where they override the
cache's default.

| Option | Default | What it does |
|---|---|---|
| `driver` | required | where entries live: a built-in driver, `redundant([...])`, or your own ([Custom drivers](#custom-drivers)) |
| `namespace` | `"cache"` | the prefix every key is stored under ([Namespaces and versions](#namespaces-and-versions)) |
| `version` | none | joins the namespace (`app@v3`), so a change of a value's shape needs no flush |
| `ttl` | none (no expiry) | ms; `null` for no expiry; or `(value) => ms \| null` |
| `jitter` | `0` | spread each TTL by up to ± this fraction |
| `codec` | `"structured"` | `"json"`, `"raw"` or a `Codec` ([Codecs](#codecs)) |
| `compress` | zstd above 16 KiB | `{ algorithm, threshold, level, previous }`, or `false` ([Compression and limits](#compression-and-limits)) |
| `maxEntryBytes` | 4 MiB, or the driver's limit when smaller | the size cap per entry |
| `maxKeyLength` | 200 | a longer key is stored as `#` + its SHA-256 |
| `encrypt` | none | seal every entry ([Encryption at rest](#encryption-at-rest)) |
| `staleWhileRevalidate`, `staleIfError`, `softTimeout`, `hardTimeout`, `refreshAhead`, `earlyExpiry` | off | the stale windows and loader timeouts ([Staleness](#staleness)) |
| `failSafeBackoff` | 10 s | how far a failed refresh pushes the stale value's freshness forward |
| `cacheUndefined`, `negativeTtl` | `false`; the entry's TTL | negative caching ([Stampede protection](#stampede-protection)) |
| `tagStampTtl` | the cache's longest TTL, at most 24 h | how long an invalidation stamp lives ([Tags](#tags)) |
| `tagStampCacheMs` | 1 s | how long a process keeps its copy of a stamp |
| `softPurge` | `false` | allow `invalidateTags(tags, { mode: "stale" })` ([Soft purge](#soft-purge-mode-stale)) |
| `validate` | none | key patterns mapped to Standard Schemas, checked on read ([Typed caches](#typed-caches-and-validate)) |
| `l1` | none | an in-process memory tier: `true`, or `{ maxEntries, maxBytes, ttl, clone }` ([Multi-tier](#multi-tier)) |
| `bus` | `"auto"` with an `l1`, else `false` | the invalidation bus ([The bus](#the-bus)) |
| `sweepInterval` | 60 s | how often the core calls the driver's sweeper, in ms; `0` disables it |
| `timeout` | off | a timeout around every driver operation, in ms |
| `strict` | `false` | throw driver failures instead of degrading ([The failure policy](#the-failure-policy)) |
| `circuit` | `{ failures: 5, cooldown: 30_000 }` | the circuit breaker around the driver |
| `logger` | a no-op | any `LoggerLike` ([Events, statistics, logging](#events-statistics-logging)) |
| `now`, `random` | `Date.now`, `Math.random` | the clock and the randomness source, for tests ([Testing helpers](#testing-helpers)) |

## Stampede protection

`getOrSet` is single-flight in process, always: 1000 concurrent misses run the
loader once, and every caller awaits the same promise. A loader that throws
rejects every waiter with the one error and is never cached; the next call
runs the loader again. A `delete`, `deleteMany`, `invalidateTags`, `clear`
or `increment` on the same cache, in the load's own namespace, landing
mid-flight forgets the flight: later callers load afresh, and the forgotten
load's write is dropped, its caller still getting the value. The drop is
reported like the tag fence's (below): a `fenced` event with
`reason: "local"`, carrying the load's own tags (empty when it had none), and
one more in `stats().fenced`. A background refresh that is forgotten reports
the same, in place of its `refresh` event.

- **The read is shared too.** Callers that ask while a load runs join it
  without reading; callers that ask while a read of the key runs share that
  read, so they miss together and one leads the load. A read that a load
  settled under reads again when it found nothing fresh, since it may have
  looked before the write. This matters on a backend whose reads queue for
  longer than the load, where a burst of misses would otherwise run the
  loader more than once. Concurrent callers are therefore answered the same
  value object, a hit's as a load's.
- **Cancellation is collective.** `getOrSet(key, loader, { signal })` rejects
  the caller that aborted; the loader's own `signal` aborts only when *every*
  waiter has aborted, so one impatient caller cannot cancel shared work.
- **A cross-process lock** is opt-in per call: `{ lock: true }` (or
  `{ lock: { ttl, wait: { interval, timeout } } }`) on drivers with
  `capabilities.lock`. The leader loads while other processes poll for the
  value; after `wait.timeout` (default 5 s) a waiter loads itself *without
  storing* (`onLockTimeout: "load"`, the default) or throws
  `LoaderTimeoutError` (`"throw"`). On a driver without locks, `lock` logs one
  warning per cache and the in-process flight still applies.

- **A loader can refuse to store its own value**: it receives
  `{ signal, noStore }`, and calling `noStore()` returns the value to every
  caller sharing the flight while writing nothing — no `set`, no `fenced`
  event; a background refresh that calls it leaves the stale entry as it was.
  For a value only the loader can judge (bun-nest's `@Cacheable({ unless })`
  uses it); a plain negative is simpler as `undefined`.

**Negative caching.** A loader's `undefined` is not cached (it reads as a
miss). `cacheUndefined: true` stores a marker — `has` then answers `true` —
and `negativeTtl` gives it its own TTL. `null` is a value and is cached.

## Staleness

All of these are per call (or cache-wide defaults):

| Option | Meaning | Default |
|---|---|---|
| `staleWhileRevalidate: ms` | after `freshUntil`, serve the stale value and refresh in the background (single-flighted); a failed refresh emits `error` and keeps the stale value | 0 |
| `staleIfError: ms` | when the loader throws or hard-times out, serve a stale value still inside this window (event `stale-if-error`); past it, rethrow | 0 |
| `softTimeout: ms` | with a stale value, a loader outlasting this returns the stale value now and finishes in the background | none |
| `hardTimeout: ms` | stop waiting on the loader after this, with `LoaderTimeoutError`; stale-if-error still applies | none |
| `refreshAhead: 0..1` | a hit in the last fraction of the TTL refreshes in the background while it is served | off |
| `earlyExpiry: { beta }` | probabilistic early expiration (XFetch): recompute when `now - loadMs * beta * ln(rand()) >= freshUntil` | off |
| `jitter: 0..1` | spreads each TTL by up to ± the fraction, so bulk-written entries do not expire together | 0 |

An entry lives until its *hard* expiry, `freshUntil + max(swr, sie)`; the
driver needs to know only that one expiry. After a failed refresh, the stale
value's freshness is pushed forward by `failSafeBackoff` (default 10 s), so
the origin sees one retry per backoff instead of one per request.

## Tags

Tag entries on write, invalidate by tag:

```ts
await cache.set("user:42", user, { tags: ["users", "org:7"] });
await cache.invalidateTags(["org:7"]);
```

How invalidation works depends on the driver ([The driver matrix](#the-driver-matrix)
says which mode each one uses):

- **`tags: "index"`** (memory, SQLite, Postgres, MySQL, MariaDB, Redis,
  MongoDB, Cloudflare D1): entries are deleted eagerly, and a
  write whose loader started *before* the invalidation is refused by the
  **fence** — the `fenced` event fires with `reason: "fence"`, and the
  loader's caller still gets its value. The fence is what catches an
  invalidation from another cache on the same driver (another process, in
  production); one on the same cache has already forgotten the flight, so its
  drop reports `reason: "local"` instead (above). Either way `tags` is the
  dropped entry's own, and `stats().fenced` counts it. A stamp at the entry's
  own millisecond counts as newer: a stamp records only the millisecond, so
  it cannot tell a load that began before the invalidation from one that
  began after it, and the safe side wins. So that this never costs a load
  that follows an invalidation, `invalidateTags` resolves only once the clock
  has passed its stamps' millisecond (about a millisecond at most, nothing
  when the driver call took one): a `getOrSet`, `set` or HTTP request that
  starts after it resolved, in this process or another on the same clock, is
  stored. Another process's invalidation landing in a load's own millisecond
  still fences it.
- **`tags: "stamps"`** (file, S3, Azure Blob Storage, Cloudflare KV, and
  custom drivers via `fromSimpleDriver`): `invalidateTags` writes only a stamp per tag, and a read
  of a tagged entry compares its age against the stamps — an entry older than
  a stamp is a miss. Stamps are cached in process for `tagStampCacheMs`
  (default 1 s), and invalidated entries are reclaimed by the sweeper.

### Soft purge (`mode: "stale"`)

`invalidateTags(tags, { mode: "stale" })` marks the entries stale instead of
deleting them — Fastly's soft purge, Next.js's `revalidateTag`:

```ts
const cache = createCache({
  driver: postgresDriver({ url }),
  softPurge: true,            // every cache that soft-purges needs it
  ttl: 60_000,
  staleWhileRevalidate: 300_000,
  staleIfError: 3_600_000,
});
await cache.invalidateTags(["org:7"], { mode: "stale" });
// Within 5 minutes: the old value at once, and one background refresh.
await cache.getOrSet("org:7:report", loadReport, { tags: ["org:7"] });
```

- **What a purged entry reads as.** Stale from the purge on, never missing:
  `get` and `has` miss it, `getEntry` answers it with `stale: true` and a
  `freshUntil` of the purge, `getOrSet` serves it within
  `staleWhileRevalidate` (refreshing it in the background) or `staleIfError`
  (when the loader fails), both **counted from the purge**, and a refresh
  replaces it. With neither window, it is a miss that loads. Its hard
  expiry is not shortened, so it keeps its space until then (a delete frees
  it at once). Freshness is only ever lowered: an entry already stale keeps
  its own `freshUntil`, and one that never goes stale (`ttl: null`) goes
  stale at the purge. Entries written after the purge are fresh.
- **How.** One stale stamp per tag (the stamp of the tag's name with a
  reserved first character, U+0001, which no tag may start with), and a read
  of a tagged entry created at or before it caps its freshness at the stamp.
  Nothing is deleted or rewritten, so it works alike on every driver and
  under encryption (`freshUntil` is inside the sealed entry). The stale
  stamps travel in the same `getStamps` call as the ordinary ones, through
  the same `tagStampCacheMs` copy, and are pushed over the bus.
- **Every cache needs `softPurge: true`**, on every driver, encrypted or
  not: without it `mode: "stale"` throws `UnsupportedOperationError`, naming
  the option, and no read ever asks for a stale stamp — no cache pays for
  soft purge unless it opts in. **The cost of `softPurge`**: its tagged reads
  check the tags' stale stamps, one stamp lookup per tag per
  `tagStampCacheMs` (default 1 s) per process. On a plaintext cache over an
  index-mode driver (memory, SQLite, Postgres, MySQL, MariaDB, MongoDB,
  Redis, Cloudflare D1), whose reads otherwise read no stamps, that is a new
  lookup; on a stamps-mode driver (file, S3, Azure, Cloudflare KV,
  `fromSimpleDriver`) or an encrypted cache, which read the ordinary stamps
  anyway, the stale ones join the same call, as one more stamp per tag (a
  file or an object of its own on a stamps-mode driver).
- **The fence.** A load that began before the purge still stores its value
  (no write is refused, unlike a delete's fence), but its `createdAt`
  predates the stale stamp, so it reads stale: a fresh pre-purge value is
  never resurrected. One on the purging cache itself is dropped, since the
  purge forgets its flights (`fenced`, `reason: "local"`).
- **The fail-safe backoff** of a soft-purged entry is kept in process: after
  a failed refresh, this process serves it as fresh for `failSafeBackoff`,
  but other processes may still try a refresh each (the usual backoff
  rewrites the entry, whose stale stamp would make it stale again). A later
  soft purge ends it.
- **Lifetimes.** A stale stamp lives for `tagStampTtl`, like any stamp: an
  entry that outlives it (a TTL longer than the cache's own, or `ttl: null`
  past 24 h) reads fresh again. Set `tagStampTtl` to cover your longest TTL.
- **Rolling deploys.** A process on a version before soft purge reads no
  stale stamps, and serves soft-purged entries as fresh until they expire.
- **Events.** `invalidate` carries `mode` (`"delete"` or `"stale"`), and a
  soft purge counts no `deletes` in `stats()`. Its bus message is a delete's
  (`invalidate-tags`): every other cache drops its L1 copies of the tags and
  its stamp copies, the stale ones included, and reads the entries stale.

## Counters

```ts
const n = await cache.increment("hits:/home", 1, { ttl: 86_400_000 });
```

`increment` returns the new value; `decrement` is `increment(key, -by)`. The
TTL is set only when the counter is created, so a rate-limit window does not
slide. `get` on a counter key returns its number. A counter carries no tags.
On a driver without `capabilities.atomicIncrement`, `increment` throws
`UnsupportedOperationError`. For request rate limits, use the counters
through bun-common's `throttle()` ([Throttling](#throttling)).

## Codecs

| `codec` | What round-trips |
|---|---|
| `"structured"` (default) | `Date`, `Map`, `Set`, `Uint8Array`, `BigInt`, `undefined` fields, `NaN`, `RegExp`, `Error`, cycles. Class instances become plain objects |
| `"json"` | JSON values only: a `Date` reads back as a string, `Map`/`Set` as objects; `BigInt` throws on write |
| `"raw"` | `Uint8Array` and `string`, unchanged |
| a `Codec` | `{ id: 128–255, encode(v): Uint8Array, decode(b): unknown }` |

The codec id is stored in each entry's header, so changing `codec` needs no
flush: old entries decode with the codec they were written with. An entry
whose codec the cache does not know (or that fails to decode at all) is a
miss, is deleted, and fires `error` with `phase: "decode"`.

Two honesty notes. `"structured"` is `bun:jsc`: **Bun reads Bun** — a cache
shared with non-Bun readers wants `codec: "json"`. And because JSON is lossy,
`createCache<Schema>({ codec: "json" })` types every value as its JSON view
(`Jsonify`): a `Date` field types as `string`, so the type never lies.

## Compression and limits

`compress: { algorithm, threshold?, level?, previous? }` — the default is
zstd above 16 KiB, and an entry is compressed only when that makes it
smaller. `compress: false` disables it.

| `algorithm` | Default `level` | Range | Implementation |
|---|---|---|---|
| `"zstd"` (default) | 3 | 1–22 | `Bun.zstdCompressSync` |
| `"gzip"` | 6 | 0–9 | `Bun.gzipSync` |
| `"br"` (Brotli) | 4 | 0–11 | `node:zlib` `brotliCompressSync` (quality) |
| `"deflate"` | 6 | 0–9 | `Bun.deflateSync`: **raw** DEFLATE |
| a `CacheCompressor` | — | — | your `compress` and `decompress` |

- **Which one.** zstd is the default: on JSON it matches Brotli 4's ratio
  in a fraction of the time, and it gives up quickly on bytes that do not
  compress (an image, an archive), where gzip and deflate spend far longer.
  Brotli wins on small text, through its built-in dictionary, which matters
  only with a threshold far under 16 KiB. Its quality defaults to 4, as
  bun-common's response compression does: Brotli's own default, 11, is much
  slower.
- **`"deflate"` is raw DEFLATE** (RFC 1951), not the zlib-wrapped form HTTP's
  `Content-Encoding: deflate` means: these bytes never reach HTTP. It is the
  same ratio, six bytes shorter.
- **`level`** is the one knob, and is checked: a level outside its range, or
  a `level` beside a user compressor, is a `TypeError` at `createCache`. The
  default `threshold`, 16 KiB, is the same for every algorithm; it is
  compared with the encoded value's size.
- **Changing `algorithm` needs no flush.** Each entry's header names its
  compressor, and every built-in always decompresses.
- **Per call, `compress: false`** on `set`, `setMany`, `getOrSet` and `wrap`
  stores that value uncompressed: for bytes already compressed, where gzip,
  deflate and Brotli spend up to 20 ms per MiB before the "only if smaller"
  rule discards their work. It is also the answer to a **compression
  oracle**: a value that mixes a secret with text an attacker chooses leaks
  the secret through its compressed size, byte by byte (the CRIME and BREACH
  attacks). A `touch` keeps such an entry uncompressed.
- **A large value is probed first.** From 256 KiB, a built-in algorithm
  first compresses a sample: four slices spread over the value, 1/64 of it
  and at most 16 KiB. When the sample shrinks by less than 2%, the value is
  stored as it is, without compressing it whole, which would only produce
  output the "only if smaller" rule then discards. The sample decides, so a value whose sampled parts do not shrink is stored
  uncompressed even if a part between them would have. A user compressor is
  never probed.

**User compressors.** A `CacheCompressor` is
`{ id: 128–255, compress(bytes), decompress(bytes, maxOutputLength) }`, and
either function may return a promise (the cache awaits only one that does).
A dictionary-trained zstd, for one (Bun's native zstd takes no dictionary):

```ts
import type { CacheCompressor } from "@kingsleyweb/bun-cache";
import type { ZstdOptions } from "node:zlib";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

const dictionary = await Bun.file("cache.dict").bytes();
// Bun's node:zlib honours `dictionary`; @types/node does not declare it yet.
const withDictionary = (options: ZstdOptions = {}) =>
  ({ ...options, dictionary }) as ZstdOptions;
const zstdDict: CacheCompressor = {
  id: 128,
  compress: (bytes) => zstdCompressSync(bytes, withDictionary()),
  decompress: (bytes, maxOutputLength) =>
    zstdDecompressSync(bytes, withDictionary({ maxOutputLength })),
};
const cache = createCache({ driver, compress: { algorithm: zstdDict } });
```

The id is stored in every entry it compressed, so a new compressor takes a
new id, and the old one goes in `previous` while its entries live:
`compress: { algorithm: zstdDict2, previous: [zstdDict] }`. An entry whose
compressor the cache does not know is a miss, is deleted, and fires `error`
with `phase: "decode"`, as an unknown codec is. Ids outside 128–255, and two
compressors with one id, are a `TypeError`.

**The header format.** An entry with no compression, zstd or gzip is written
as it always was (format 1); `br`, `deflate` and user compressors need a
compressor-id byte, so they write **format 2**. A process on a version
before format 2 reads such an entry as a miss and deletes it, so during the
rolling deploy that turns Brotli on, old and new processes miss each other's
entries; once every process runs the new version, nothing more changes.

**The decompression cap holds for every compressor.** A read decodes no
further than the entry limit (below), whoever wrote the entry. Bun's own
decoders (`Bun.zstdDecompressSync`, `Bun.gunzipSync`, `Bun.inflateSync`) are
1.3–33× faster than `node:zlib`'s, but take no output limit. So a payload is
decoded natively only when its own bytes prove that it fits, and otherwise
through `node:zlib`, with `maxOutputLength` set to the limit:

| Payload | Decoded by |
|---|---|
| zstd frames that all declare their size, summing to at most the limit and 16 MiB: every entry this cache writes | Bun |
| zstd frames declaring more than the limit | nothing: refused before decoding |
| other zstd: a frame with no size, a skippable frame, trailing bytes, a sum past 16 MiB | `node:zlib` |
| gzip or raw DEFLATE of at most limit ÷ 1,032 bytes (4,064 bytes at 4 MiB) | Bun |
| larger gzip or raw DEFLATE, and Brotli | `node:zlib` |

Why each native row is safe:

- **zstd**: the sizes are read from the frame and block headers, before
  anything is decoded. Bun reserves exactly their sum (when it is at most
  16 MiB) and decodes into that buffer alone, and libzstd refuses a frame that
  decodes to more or less than it declares. A frame declaring 1,000 bytes and
  holding 256 MiB fails with no growth. Past 16 MiB, or with no size, Bun
  streams with no limit, so those payloads go to `node:zlib`.
- **gzip and DEFLATE**: no DEFLATE stream decodes to more than 1,032 bytes
  per byte (a 258-byte match in two bits), so the payload's length bounds its
  output. gzip's ISIZE trailer must fit the bound too, because Bun reserves
  that much up front.
- **Brotli** has no Bun decoder (`DecompressionStream` is slower than
  `node:zlib`).

A gzip payload of more than one member reads as `node:zlib` reads it (every
member), though Bun's decoder reads only the first. A user compressor is
handed the limit as `maxOutputLength`, and its answer is refused past it
anyway. An entry that opened under its encryption key is held to the same
proofs.

**With encryption**, compression runs first, on the plaintext entry: the
cipher seals the compressed bytes, and a read opens the entry before it
decompresses it ([Encryption at rest](#encryption-at-rest)).

Every entry is capped at `maxEntryBytes` (default 4 MiB, or the driver's own
limit when smaller). An oversized `set` resolves `false` and emits `oversize`
(it does not throw, unless `strict: true`); in `getOrSet` the value is
returned uncached. The limit also holds the value before compression, and a
read never decompresses past it, so an entry planted in the store that would
expand further (a decompression bomb) reads as a miss with an `error` event
of phase `"decode"`, and is deleted. A key longer than `maxKeyLength` bytes
(default 200) is stored as `#` + its SHA-256 (lower-case hex), with the full
key kept in the entry's header: a hash collision reads as a miss, never as
the wrong value.

## Encryption at rest

`encrypt` seals every entry before it reaches the driver, so a dump of
Redis, a database backup, an S3 bucket or the file driver's directory does
not show the values, and a writer to the store cannot make the cache serve
a forged or misplaced one.

```ts
const cache = createCache({
  driver: redisDriver({ url }),
  encrypt: {
    keys: [
      { id: "2026-10", key: process.env.CACHE_KEY_2026_10! }, // the first seals
      { id: "2026-09", key: process.env.CACHE_KEY_2026_09! }, // still opens
    ],
    aad: "prod", // optional: bound into every entry
  },
});
```

`encrypt` takes one of two shapes: `{ keys, cipher?: "aes-256-gcm",
keyRefresh? }` for the built-in cipher, or `{ cipher }` with a user
[`CacheCipher`](#user-ciphers), and no `keys`. Either takes
`previous`, `aad`, `hashNames` and `acceptUnencrypted`. Neither `keys` nor a
user `cipher`, or both, is a compile error ("Property 'keys' is missing …"),
and a `TypeError` at `createCache` for JavaScript callers and casts. The
shapes are exported by name: `CacheEncryptWithKeys` and
`CacheEncryptWithCipher`, and for `hashNames`, `CacheHashNamesKey` and
`CacheHashNamesHash`.

The built-in cipher is **AES-256-GCM** through `node:crypto`, with **a key
per entry**: HKDF-SHA-256 derives a key from each ring key once, and each
write derives its own from that and a random 128-bit salt, with a random
96-bit nonce. A cache writing 10,000 entries a second would reach GCM's
limit of 2^32 random nonces per key in five days; with a key per entry it
never does. The order on write is **encode → compress → encrypt**, and the
reverse on read, so the cipher sees the compressed bytes and the
decompression cap still applies after decrypting. Whether to compress is
decided on the plaintext (the threshold, and "only if smaller"), since
ciphertext does not compress.

**What is sealed.** The whole entry: its header (with the full key and the
timestamps), its payload, and copies of its **tags** and **hard expiry**. The
cache trusts those copies over the driver's clear ones:

- raising an entry's expiry in the store gains nothing: it expires when the
  sealed copy says;
- stripping its tags in the store (or its rows in a tag index) gains
  nothing: an encrypted cache checks its sealed tags against the
  invalidation stamps on **every** driver, so an `invalidateTags` still
  misses it. (On an index driver this adds one stamp read per tagged read,
  cached in process for `tagStampCacheMs`, 1 s by default; an entry written
  in the same millisecond as an invalidation of its tag reads as a miss, as
  on a stamps driver.)

Each entry is bound to its place by the AEAD's additional data: the full
namespace, the full key, `aad`, and the envelope's own prefix. An entry
copied to another key, another namespace or a cache with another `aad`
does not open.

**What it does not hide.**

- **Names**: keys, namespaces and tags are stored as written, unless
  `hashNames` is on ([Hiding names](#hiding-names)).
- **Sizes, exactly.** Nothing is padded: the sealed size is the plain
  entry's plus a fixed overhead (below), and the plain entry holds the full
  key, so a key's length stays readable in its entry's size even with
  `hashNames` on, as does the length of its tags (sealed with it).
- **Timings**: when an entry was written (`ca` columns, mtimes, S3's `at=`),
  when it expires (the driver's clear expiry, which native TTLs and
  sweepers need), when a tag was invalidated (its stamp), and how often an
  entry is read (the store's own logs).
- **Which entries share a name**: a tag's index rows and every entry
  carrying it name the same stored tag, hashed or not, and a key keeps its
  stored name across rewrites, so a reader sees which entries change and
  which are invalidated together.
- **Counters** are plaintext integers, so that the backend can add to them
  atomically; only their names are hashed.
- **A compression oracle**: a value that mixes a secret with text an
  attacker chooses still leaks the secret through its compressed size,
  since encryption hides the bytes, not the length. Store such values with
  `compress: false` ([Compression and limits](#compression-and-limits)).
- **Deletion and replay**: a writer to the store can always delete entries,
  or **replay an older ciphertext of the same key**: served, but never
  fresher or longer-lived than when it was written, since its freshness and
  expiry are sealed with it.
- **The app process** holds the keys, and the decoded values in L1:
  nothing here helps once it is compromised.

### Keys

A key is exactly **32 bytes**: a `Uint8Array`, or a string of 32 bytes as
hex, base64 or base64url. Generate one with `openssl rand -base64 32`.
Anything else, a passphrase included, is a `TypeError` at `createCache`
(whose message never shows the value). An id is 1–32 characters of
`A-Z a-z 0-9 . _ -`, unique in the ring; it is written into every entry, so
a read picks its key directly. The **first** key seals; **every** key opens.

**Rotating a key**, without a cold cache:

1. Deploy `[old, new]` everywhere: every process can now open the new key's
   entries, and writes still use the old one.
2. Deploy `[new, old]`: new writes use the new key.
3. After the longest TTL plus its stale window, deploy `[new]`.

Skipping step 1 costs only misses while the deploy rolls: an entry that does
not open is never deleted. The `keyId` on `hit` and `stale-hit` events shows
when the old key stops being read.

Any rewrite of an entry seals it under the ring's first key: a `set`, a
load, a background refresh, and a `touch`, which re-seals the value it
read. Nothing else re-encrypts, so an entry with no expiry (`ttl: null`)
never drains by itself: rewrite or `touch` such entries before step 3, or
they read as misses (`"unknown-key"`) until something writes them again.

**A key from a KMS or Vault.** `keys` may be a function, sync or async; the
cache never talks to a KMS itself. The usual pattern is an envelope key: the
KMS decrypts a data key once, and the function answers it.

```ts
import { DecryptCommand, KMSClient } from "@aws-sdk/client-kms";

const kms = new KMSClient({});
const cache = createCache({
  driver,
  timeout: 2_000,
  encrypt: {
    keys: async () => {
      const { Plaintext } = await kms.send(
        new DecryptCommand({ CiphertextBlob: Buffer.from(process.env.CACHE_DATA_KEY!, "base64") }),
      );
      return [{ id: process.env.CACHE_KEY_ID!, key: Plaintext! }];
    },
    keyRefresh: 300_000, // optional: ask again every 5 min
  },
});
```

- It is called on first use, and operations wait for it, reads and writes
  alike, at most the cache's `timeout`: past it a read is a miss and a write
  resolves `false`, while the call goes on. `timeout` is off by default, and
  without it they wait as long as the function takes, so set one (2 s
  above).
- With `keyRefresh` (a positive number of ms; a `TypeError` beside a static
  ring), it is called again in the background that many ms after its last
  answer, as operations run: there is no timer. A rotation's next step then
  reaches a busy process about `keyRefresh` after the ring changes where the
  function reads it.
- A read that meets an **unknown key id** calls it once more, at most once
  per 10 s, so a process learns a peer's new key without a restart. (A
  static ring cannot learn one: the read is an `"unknown-key"` miss.)
- A rejection, or an answer that is not a valid ring, is an `error` event
  (`phase: "encrypt"` on a write, `"decrypt"` on a read) and the previous
  ring stays: an answer is validated whole, never half-applied. With no ring
  yet, writes resolve `false` and reads miss, and a later operation tries
  again (at most once a second).

### When an entry does not open

It is a **miss**, with an `error` event of `phase: "decrypt"` whose `error`
is a `CacheDecryptError` with a `reason`, and the `keyId` the envelope names
when it names one (the built-in cipher's entries):

| `reason` | Meaning |
|---|---|
| `"auth"` | The tag failed: a changed byte, the wrong key under a known id, an entry moved to another key, namespace or `aad` |
| `"unknown-key"` | No ring key has the entry's key id (after one refresh of a `keys` function) |
| `"unencrypted"` | Not an envelope, and `acceptUnencrypted` is off |
| `"malformed"` | An envelope that does not parse |
| `"cipher"` | The entry's cipher is not configured here — including a cache with **no `encrypt` at all** reading a sealed entry, and a cache whose `cipher` is a user cipher reading the built-in's entries — or a user cipher threw |

It is **never thrown**, not even under `strict`, and the entry is **not
deleted** — during a key rollout, a process without the new key would
otherwise delete every entry its peers wrote. The same holds for a process
missing `encrypt` altogether (a configuration not rolled out yet): a cache
without encryption recognises a sealed entry by its `"BE"` magic and reads
it as a miss with this event (`"cipher"`), where any other bytes it cannot
decode are deleted. The next `set` or load — an explicit write of the app's,
on either kind of cache — overwrites it; an encrypted cache then reads that
plain entry as `"unencrypted"`, again without deleting it. A `warn` is
logged at most once per 10 s per reason, naming the key id, never key
material or values.

A write that cannot seal (no ring yet, a user cipher that threw) resolves
`false` with an `error` event of `phase: "encrypt"`, and throws only under
`strict`. Nothing is ever stored unencrypted.

**The size.** The built-in cipher adds 49 bytes plus the key id's length,
plus 11 and the tags (2 + their UTF-8 length each), to the plain entry: 67
bytes for an untagged entry under the id `2026-10`. The entry limit
(`maxEntryBytes`, or the driver's own when smaller) holds both the value's
encoded size before compression and the **sealed** bytes the driver
receives; `oversize` reports whichever passed it, and the `set` event's
`bytes` and `stats().bytesWritten` count the sealed bytes.

**Migrating an existing cache.** `acceptUnencrypted: true` reads entries
written before encryption was turned on; every write is still sealed, and
a `touch` of a plain entry rewrites it sealed. Leave it off afterwards:
while it is on, anyone who can write to the store can plant a plaintext
value the cache serves. A rollout in four steps:

1. Upgrade every process to a version of this package that has `encrypt`
   (it need not be on yet): an older one reads a sealed entry as bytes it
   cannot decode, and deletes it.
2. Deploy `encrypt` with `acceptUnencrypted: true`. A process not yet on it
   reads its peers' sealed entries as misses (`"cipher"`) and never deletes
   them; the new processes read the old ones' plain entries.
3. After the longest TTL plus its stale window, deploy without
   `acceptUnencrypted`.
4. Turn `hashNames` on, if wanted, as a deploy of its own. It cannot join
   step 2: a cache hashing its names looks every entry up under its hashed
   name, so `acceptUnencrypted` never finds the plain entries, which sit
   under their written names. Turning it on is a flush either way
   ([Hiding names](#hiding-names)).

### User ciphers

`encrypt: { cipher }` replaces the built-in with a `CacheCipher` —
`{ id: 128–255, seal(plaintext, context), open(sealed, context) }`, either
function sync or returning a promise — for an HSM, a KMS that encrypts, or a
library cipher. `context` is `{ namespace, key, aad }`, and the cipher
**must** authenticate `context.aad`: it is what binds an entry to its place.
`open` throws when the bytes do not authenticate. Its keys are its own
business, so `keys` (or `keyRefresh`) beside it is a compile error and a
`TypeError`. Entries keep the cipher id
they were sealed with: a new cipher takes a new id, and the old one goes in
`previous: [oldCipher]` while its entries live (`previous` works beside the
built-in's `keys` too). An id outside 128–255, or one taken twice among
`cipher` and `previous`, is a `TypeError`. An entry whose cipher is not
configured is a miss (`"cipher"`). The built-in has no place in `previous`:
a cache whose `cipher` is a user cipher holds no ring, so moving from the
built-in to a user cipher leaves the built-in's entries unreadable — misses
until they are rewritten or expire, as after a flush.

Check one with the conformance kit, in its own test file:

```ts
import { runCacheCipherConformance } from "@kingsleyweb/bun-cache/testing";

runCacheCipherConformance("kms-cipher", kmsCipher);
```

It asserts an id in 128–255; a round trip at 0 B, 100 B, 70 KB and 1 MiB;
no plaintext in the sealed bytes; two seals of one input differing; and that
a flipped bit, a truncation, and a changed `aad`, namespace or key are each
refused — then round-trips a value through a real `createCache`. A cipher that ignores the
AAD fails it.

### The cost

A few microseconds per small operation, which a networked store's round
trip mostly hides, and within the noise for large values, where the cipher
sees the compressed bytes.

### The format

For a reader in another language (HKDF-SHA-256, HMAC-SHA-256 and
AES-256-GCM are in every standard library):

```
envelope   = "BE" | u8 1 (version) | u8 cipher id (1 = aes-256-gcm; 128–255 a user cipher) | …
built-in … = u8 key id length L (1–32) | key id (UTF-8) | 16-byte salt | 12-byte nonce | ciphertext | 16-byte GCM tag
user     … = whatever the cipher's seal answered
sealed body = u8 1 | f64 LE expiresAt (-1: none) | u16 LE tag count | per tag: u16 LE length, UTF-8 | the entry (below)

K          = HKDF-SHA-256(ikm = ring key, salt = empty, info = "bun-cache/enc/1/aes-256-gcm", 32 bytes)
K_salt     = HMAC-SHA-256(K, "entry" | salt | 0x01)
AAD        = "bun-cache/enc/1" 0x00 | full namespace 0x00 | full key 0x00 | aad 0x00 | envelope bytes up to the ciphertext
ciphertext = AES-256-GCM(K_salt, nonce, sealed body, AAD), its 16-byte tag after it

entry, format 1 = "BC" | u8 1 | u8 codec | u8 flags | f64 LE createdAt | f64 LE freshUntil (-1: never stale) | f64 LE loadMs | u32 LE key length | full key (UTF-8) | payload
entry, format 2 = "BC" | u8 2 | u8 codec | u8 flags (bits 0–1 zero) | u8 compressor | the rest as format 1
codec      = 1 structured (bun:jsc), 2 json, 3 raw, 128–255 a user codec
flags      = bit 0 zstd, bit 1 gzip (format 1 only), bit 2 counter, bit 3 negative, bit 4 raw string
compressor = 0 none, 1 zstd, 2 gzip, 3 br, 4 raw deflate, 128–255 a user compressor
```

In the AAD and the names hash below, the **full namespace** is the
plaintext chain the cache writes under: its `namespace`, then `@version`
when it has one, then each `namespace()` segment after a `:`
(`app@v3:users`); the **full key** is the key as given, before the long-key
or name hashing; and `aad` is `encrypt.aad`'s bytes (a string's UTF-8),
empty when it is unset. Both names stay plaintext there under `hashNames`.
The AAD of a user cipher's entry ends with the envelope's first four bytes.
A plain cache stores the entry alone, in the same format. A reader outside
Bun wants `codec: "json"`, since `"structured"` is `bun:jsc`'s format.

### Hiding names

Encryption hides values, not names: a dump still shows every key,
namespace and tag, and keys are often the secret — an email, a URL with
its query, a tenant's name. `hashNames` stores each name as a keyed hash
instead:

```ts
const cache = createCache({
  driver: redisDriver({ url }),
  encrypt: {
    keys: [{ id: "2026-10", key: process.env.CACHE_KEY_2026_10! }],
    hashNames: { key: process.env.CACHE_NAMES_KEY! }, // its own key, never rotated
  },
});
```

- **What changes in the store.** Each name becomes 32 hex characters: the
  first 128 bits of an HMAC-SHA-256. A key and a tag are hashed together
  with their namespace, so the same key in two namespaces hashes apart and
  a dump does not show which tenants hold the same one. Redis's key names,
  SQL's `ns`/`k`/`tg` columns, MongoDB's `_id`s, the file and object names,
  the stamps, the locks and the bus messages all carry the hashes. The
  long-key hashing (`maxKeyLength`) does not apply: an HMAC is already
  short.
- **What does not.** `clear()`, `invalidateTags()`, counters, locks, L1
  and the bus work as before: the core hashes every name before anything
  below it sees one, so every process with the same key agrees. Counter
  **values** stay plaintext integers. Events keep the plaintext names (they
  are your process's own API), except `evict`, which only the driver knows;
  the core's log lines name the stored key.
- **It needs encryption**, `keys` or a user `cipher` (a compile error
  otherwise, and a `TypeError` for JavaScript callers): without it every
  entry's header carries its full key in clear, and hashing the names would
  hide nothing. The full key is still checked on every read, inside the
  sealed header, so two names colliding only overwrite each other — a miss,
  never the wrong value.
- **Its key never rotates.** It is a separate key from `keys`: a rotation
  of the encryption keys must not rename the store. (One of a static ring's
  keys is allowed, since HKDF keeps the two uses apart, and `createCache`
  warns about it; a `keys` function's answers are not compared.)
- **Turning it on is a flush**, and so is changing its key, like a `version`
  bump: the old entries sit under names nobody asks for until they expire
  or are swept. `clear()` each namespace first with a cache configured as
  before, or accept the orphans. `acceptUnencrypted` does not bridge it: it
  reads plain entries only under the names the cache looks up, which are
  now the hashed ones ([migrating](#when-an-entry-does-not-open)).
- **A hash of your own**, to match an existing scheme: `hashNames: { hash:
  (name, { kind, namespace }) => string }`, where `kind` is `"namespace"`,
  `"key"` or `"tag"`. `hashNames` takes exactly one of `key` and `hash`:
  both, or neither, is a compile error (and a `TypeError`). The hash must be
  deterministic and answer 1–200 bytes with no NUL or newline. Each new
  name's answer is checked (the memo keeps the last 10,000), and the first name of each kind is hashed twice and must
  hash alike. A failure is a `TypeError`: thrown by `createCache` and
  `namespace()` for the namespace, by `describeKey`, and as the rejection
  of the operation for a key or a tag.

**Debugging: `describeKey`.** `cache.describeKey(key, tags?)` answers the
names the store holds for a key and its tags, in that view's namespace,
without reading or writing anything:

```ts
cache.describeKey("user:42", ["org:7"]);
// { namespace: "3f9c…", key: "9a41…", tags: ["c17e…"] }
```

Search a dump for those (`redis-cli --scan --pattern '*9a41*'`, `WHERE k =
'9a41…'`); on the file, S3, Azure and Cloudflare KV drivers the key's
object name is the SHA-256 of that hash. To check a value, read it back
through the cache, skipping L1 with `get(key, { tier: "l2" })`. Without
`hashNames`, `describeKey` answers the names as stored: the namespace, the
key (`#`-hashed when long) and the tags as they are.

The names hash, for a reader in another language (the full namespace and
key as in [The format](#the-format); a counter's name is hashed as a key):

```
K_names    = HKDF-SHA-256(ikm = hashNames.key, salt = empty, info = "bun-cache/names/1", 32 bytes)
namespace  = hex(HMAC-SHA-256(K_names, "ns"  0x00 | full namespace))[0..32]
key        = hex(HMAC-SHA-256(K_names, "key" 0x00 | full namespace 0x00 | full key))[0..32]
tag        = hex(HMAC-SHA-256(K_names, "tag" 0x00 | full namespace 0x00 | tag))[0..32]
```

## Namespaces and versions

Every key is stored under the cache's `namespace` (default `"cache"`).
`cache.namespace("users")` returns a view with a longer prefix — same driver,
same events, same stats. `clear()` deletes only its own namespace, never the
backend. A `version: "v3"` joins the namespace (`app@v3`): a deploy that
changes a value's shape bumps it instead of flushing, and old entries simply
expire.

## Typed caches, and `validate`

```ts
type Schema = {
  [k: `user:${number}`]: User;
  [k: `hits:${string}`]: number;
};
const cache = createCache<Schema>({ driver: memoryDriver() });

await cache.get("user:42");        // User | undefined
await cache.set("user:42", user);  // a Report is a type error
await cache.increment("hits:/");   // only number-valued keys
```

Keys belong to the schema — literals and template-literal patterns both — and
`set`/`getOrSet` take and return the key's value type. `wrap`'s `key` function
receives `fn`'s own parameters. Tags can be narrowed with a second type
parameter: `createCache<Schema, "users" | "orgs">(...)`.

**Runtime-checked reads.** `validate` maps key patterns to any
[Standard Schema](https://standardschema.dev) — the contract `BunValidate`
accepts — and checks values **on read**:

```ts
const cache = createCache({
  driver: memoryDriver(),
  validate: { "user:*": UserSchema },   // zod, valibot, arktype, yup, …
});
// the cache's type is CacheSchemaFrom<{ "user:*": typeof UserSchema }>,
// inferred: get("user:1") is User | undefined
```

A stored value that fails its schema is a miss and is deleted, with an
`error` event whose `phase` is `"validate"` and whose issues target `"cache"`
(value-free, as everywhere in bun-common). The schema's *output* is what a
read returns, so defaults and transforms apply. Patterns are exact keys or a
single trailing `*`; a key matching no pattern is unchecked. It is opt-in
because it costs a schema run per hit.

## Events, statistics, logging

`cache.on(event, listener)` — `hit`, `stale-hit`, `miss`, `set`, `fenced`
(with a `reason`, `"fence"` or `"local"`), `delete`, `invalidate` (with its
`mode`, `"delete"` or `"stale"`), `load`
(with its duration and a `shared` flag), `refresh`, `stale-if-error`,
`lock-wait`, `lock-timeout`, `evict`, `oversize`, `error` (with `phase` and
`driver`), `circuit-open` and `circuit-close`, and from a `redundant()`
driver `member-down`, `member-up` and `member-dirty`
([Redundant drivers](#redundant-drivers)). A `hit` says which `tier`
served it (`"l1"` or `"l2"`; always `"l2"` without an L1), and a bus failure
is an `error` with `phase: "bus"`. On an encrypted cache, `hit` and
`stale-hit` carry the `keyId` that sealed the entry, and an entry that does
not open, or a write that cannot seal, is an `error` with `phase: "decrypt"`
or `"encrypt"` ([Encryption at rest](#encryption-at-rest)). Listeners are synchronous and
isolated: a throwing one is logged and never breaks the operation. `on`
returns an unsubscribe function.

`cache.stats()` counts `hits`, `staleHits`, `misses`, `sets`, `fenced`,
`deletes`, `loads`, `loadErrors`, `lockWaits`, `evictions`, `bytesRead`,
`bytesWritten`, plus `hitRate` and load-duration percentiles over a rolling
60 s window. `stats({ reset: true })` reads and zeroes them. With an L1,
`stats().l1` adds its own counts ([Multi-tier](#multi-tier)); the top-level
`hits` include L1's.

`logger` accepts any `LoggerLike` (bun-common's `resolveLogger`): a Logger, a
sink, or a pino/winston/Nest-shaped logger. The default is a no-op.

## The failure policy

A cache that is down is bypassed, never fatal:

| Situation | Default | `strict: true` |
|---|---|---|
| A driver read fails or times out (`timeout`, in ms) | a miss; an `error` event; a `warn` at most once per 10 s | throws `CacheDriverError` |
| A driver write fails | logged and evented; `set` resolves `false` | throws |
| `getOrSet`'s read fails | the loader runs, and the write is attempted | throws before loading |
| The circuit is open | every operation bypasses the driver for the cooldown, then one probe | throws `CircuitOpenError` |
| The loader throws | rethrown, after stale-if-error | same |

`circuit: { failures: 5, cooldown: 30_000 }` is the default: that many
consecutive driver failures open the circuit, and the first operation after
the cooldown probes (and closes) it. A bypassed cache can stampede the
origin, so the in-process single-flight keeps working while the circuit is
open. Counters are the exception: a failed `increment` throws even without
`strict`, because there is no honest fallback value.

## Errors

Every error class is exported from the package root.

| Error | Thrown when |
|---|---|
| `CacheDriverError` | a driver operation failed or timed out, under `strict` (and for a failed `increment` always); `driver` and `op` name it, `cause` holds the driver's error |
| `CircuitOpenError` | the circuit is open and the operation was bypassed, under `strict` (and for `increment`); `retryAt` is when the next probe may run |
| `LoaderTimeoutError` | a loader outlasted `hardTimeout` with no stale value to serve, or a cross-process lock wait outlasted `wait.timeout` with `onLockTimeout: "throw"`; carries `key` and `timeoutMs` |
| `UnsupportedOperationError` | the driver cannot do what was asked: `increment` without atomic counters, `mode: "stale"` without `softPurge`; carries `driver` and `op` |
| `EntryTooLargeError` | an entry over `maxEntryBytes`, under `strict` only (otherwise `set` resolves `false` with an `oversize` event); carries `key`, `bytes` and `limit` |
| `CacheDecryptError` | never thrown: the `error` of a `phase: "decrypt"` event when an entry does not open ([When an entry does not open](#when-an-entry-does-not-open)) |

Configuration mistakes (an invalid option, a bad key in a key ring, two
authorization methods on one Azure driver) are thrown at construction, most
as a `TypeError`.

## Multi-tier

An **L1** memory tier per process over the shared driver (the **L2**), for
the reads that would otherwise cost a round trip and a decode each:

```ts
import { createCache, postgresDriver } from "@kingsleyweb/bun-cache";

const cache = createCache({
  driver: postgresDriver({ url }), // L2: shared by every process
  l1: { maxEntries: 10_000, maxBytes: 64 << 20, ttl: 30_000 }, // per process
  // bus: "auto" — the default with an l1: the driver's own bus
});

await cache.get("user:42");                    // L1, else L2 (copied into L1)
await cache.get("user:42", { tier: "l2" });    // L2 only: never a copy
```

**What L1 holds.** Decoded values, so an L1 hit costs neither the round trip
nor the decode. `l1: true` takes the defaults below.

| `l1` option | Default | What it does |
|---|---|---|
| `maxEntries` | 10,000 | at most this many entries; the least recently used go first |
| `maxBytes` | 64 MiB | at most this many decoded payload bytes (the codec's bytes, before compression) |
| `ttl` | 30,000 ms | the longest an entry is held: the staleness bound when the bus is down or absent |
| `clone` | `false` | return a `structuredClone` of each hit, and hold a clone of each value |

- **Values are shared, not copied.** With `clone: false`, an L1 hit returns
  the object L1 holds: a caller that mutates it changes what every later hit
  in that process returns (and not what L2 holds). `clone: true` costs a
  `structuredClone` per hit and per copy. Mutating a cached value is a bug
  with or without L1.
- **A write holds what an L2 read would return**: the value is decoded from
  the bytes just written. With `codec: "json"`, a `Date` set in reads back as
  a string from L1 too, and a later change to the object passed to `set` is
  not seen.
- **Only fresh copies.** An entry is held until the first of its freshness,
  the L2 entry's expiry, and `l1.ttl`. A copy taken from L2 keeps the L2
  entry's expiry, never a fresh TTL, so a copy never outlives the entry
  it copies. A stale value is never served from L1: the stale windows
  (`staleWhileRevalidate`, `staleIfError`) are L2's.
- **Counters never enter L1**: an `increment` is L2's alone.
- **`validate`**: a value written to a key a schema covers is not copied on
  write; the next read validates it on its way into L1.
- **`{ tier: "l2" }`** on `get`, `getEntry`, `has`, `getMany`, `set` and
  `getOrSet` bypasses L1 for that call: it neither reads nor fills it. A write
  with it still drops this process's copy and publishes.

**The order of operations**:

| Operation | Order |
|---|---|
| Read | L1 → L2 → loader. A fresh L2 hit is copied into L1 |
| Write (`set`, a loader's value, a refresh) | L2, then L1, then publish `set` with the key. A write the fence refused, or that failed, writes no L1 and publishes nothing |
| `delete`, `deleteMany`, `clear`, `invalidateTags` | L2, then L1, then publish |
| `increment` | L2 only |

### The bus

Other processes learn of a change through the **bus**: a message carries the
namespace and the keys or tags that changed — **never a value** — and a
process that receives one drops its copies. The next read goes to L2.

| `bus` | What it is |
|---|---|
| `"auto"` (the default with an `l1`) | the driver's own: pub/sub on Redis (`redisBus`'s channel for the driver's prefix); `LISTEN`/`NOTIFY` on Postgres; a change stream (replica set) or a tailable cursor on a capped collection (standalone) on MongoDB; a polled table on SQLite, MySQL and MariaDB, a polled log on the file driver (every 250 ms by default, `busPollInterval`); in-process on the memory driver. A driver with none: no bus |
| `redisBus(url \| { url, client, prefix, channel })` | Redis pub/sub on the channel `<prefix>:bus` (`bun-cache:bus` by default), on its own connection |
| `pgBus(url \| { url, connection, sql, channel, prefix, tables })` | Postgres `LISTEN`/`NOTIFY`, the Postgres driver's code; by default on the channel a `postgresDriver` with the same `prefix`/`tables` uses, so the two interoperate |
| a `CacheBus` of your own | `{ name, publish, subscribe, close }` |
| `false` | none: an L1 copy can be stale for up to `l1.ttl` |

An explicit bus replaces the driver's — an S3 or file L2 with a Redis bus —
and the cache's `close()` closes it. A cache with a bus and **no** `l1` still
publishes its writes and invalidations, so a process that only writes keeps
the others' L1s coherent; without `l1` the bus defaults to off, so such a
writer needs `bus: "auto"` (or one of its own).

- **A cache skips its own messages**: each message carries its publisher's
  `origin`, an id per `createCache` call.
- **Gaps flush.** Whenever messages may have been lost — a reconnect (Redis,
  Postgres), rows pruned before a polled subscriber read them, a truncated
  log — the whole L1 is flushed: what was missed is unknowable, and L1 is
  only a copy (BentoCache's rule). A flush also clears the tag-stamp cache.
- **L1 starts once the bus listens.** Until the bus's first subscribe
  settles, L1 serves and holds nothing: messages published before it were
  never received. If that subscribe fails, L1 starts anyway (bounded by
  `l1.ttl`), an `error` event with `phase: "bus"` fires, and the subscribe is
  retried with backoff; the success flushes L1.
- **A copy taken while an invalidation lands is dropped.** A read that
  fetched the old value just before another process's write, and would copy
  it into L1 just after that write's message, is detected and not copied;
  so is a loaded value whose loader started before an invalidation of its
  key or tags arrived (on the file driver, which has no write fence, this
  is what keeps it out of L1).
- **Publishes are batched** per microtask (keys merged per namespace); `set`
  resolves once its message is out. A publish that fails is an `error` event,
  never a throw.
- **Tag stamps.** On a stamps-mode driver (file), another cache's
  `invalidateTags` reaches this cache's stamp cache through the bus, L1 or
  not, instead of waiting out `tagStampCacheMs`.
- **Pub/sub ignores Redis's database number**: two deployments on one server
  share a bus unless their `prefix` or `channel` differs.

### Consistency, stated plainly

- **In the writing process: read-your-writes.** A write and an invalidation
  reach L1 before they resolve.
- **In other processes:** stale until the bus delivers. On a pushed bus
  (Postgres `LISTEN`/`NOTIFY`, `redisBus`, a MongoDB change stream) that is
  typically well under a millisecond on a quiet host and a few milliseconds
  under load; on a polled bus (SQLite, MySQL, MariaDB, the file driver), up
  to one `busPollInterval` (250 ms by default). With the bus down or absent:
  up to `l1.ttl`.
- **When a write and a read race**, another process can read the old value
  from its L1 between the L2 write and the message's delivery. That is the
  price of L1. A read that cannot accept it uses `{ tier: "l2" }`.
- **Never**: a value no tier wrote; a value restored after `invalidateTags`
  by a loader that started before it (the fence covers both tiers); a copy
  that outlives the L2 entry it copies.

`stats().l1` counts `hits`, `misses` (reads that went on to L2; `tier: "l2"`
reads are not counted), `backfills`, `invalidations`, `evictions` and
`flushes`, and reports what it holds now, `entries` and `bytes`.

## Redundant drivers

`redundant(members, options)` makes one driver of several, so a cache tier
survives losing one backend. It is a driver like any other: alone,
or as the L2 under an L1. Members can differ in type.

```ts
import { createCache, postgresDriver, redundant } from "@kingsleyweb/bun-cache";

const driver = redundant(
  [postgresDriver({ url: PRIMARY_URL }), postgresDriver({ url: SECOND_URL })],
  {
    write: "all", // or "primary"
    read: "failover", // or "race"
    timeout: 250, // per member, per operation
    circuit: { failures: 5, cooldown: 30_000 },
    secondaryTtl: 60_000, // optional: see "the gap"
  },
);
const cache = createCache({ driver, l1: { maxEntries: 10_000 } });
cache.on("member-dirty", ({ index, member, op, reason }) => {
  logger.warn("cache member missed a write", { index, member, op, reason });
});
```

**Is it worth it?** Usually not, and that is the first thing to decide.

- **It helps** when the cache holds what is expensive or impossible to
  rebuild quickly (a model inference, a quota-limited API, a report that
  takes minutes), so losing the only backend sends every request to the
  origin at once; for reads in two regions (`read: "failover"`, the local
  one first); and when the backend has no high availability of its own (one
  Redis, one self-hosted Postgres).
- **It is wasted** when the answer to "the cache is down" can be the default
  one: bypass plus the in-process single-flight
  ([The failure policy](#the-failure-policy)) — a cache can always be
  rebuilt. And when the backend already replicates (Postgres streaming
  replicas, Redis Sentinel or Cluster, MongoDB replica sets, MySQL group
  replication, S3 cross-region replication): each of those is consistent in
  a way an application-level combinator cannot be (the gap, below). The
  cost is real: two backends to run, twice the writes, and the semantics
  below to read before trusting it.

**Writes.** `write: "all"` (the default) writes every healthy member at once.
`ack: "one"` (the default) resolves once the member a read would ask first
has acknowledged — the first healthy one in order under `failover`, so a
process reads its own writes — while the rest finish in the background, each
up to its `timeout`. `ack: "all"` waits for every healthy member. A write
carrying a tag fence, and a tag invalidation, always wait for every member.
One member's writes are applied in order (a key's write after that key's
earlier one; a `clear` or an invalidation after everything before it in its
namespace; a sweep after every write before it). `write: "primary"` writes the first healthy member and copies to
the others in the background (a fenced write and an invalidation too), in order, through a queue per member
(`maxQueue`, default 10,000): only the first member is current, the others
lag by their queue, and a crash loses the queue. `close()` drains it first.

**Reads.** `read: "failover"` (the default) asks the first healthy member; on
an error, a timeout or a secondary's miss, the next. **A miss from a healthy
primary is final.** `read: "race"` asks every healthy member and takes the
first hit: the lowest latency, twice the read load, and possibly an older
copy while a newer one exists. Tag stamps are read from every healthy member
whatever the read mode. Under `write: "all"` the newest per tag wins. Under
`write: "primary"` the stamps of the member that takes the writes win, since it
alone applies the fence: a secondary's copy of an invalidation is stamped
when its queue replays it, later than the invalidation itself. A tag only the
other members hold (one the writer lost by rejoining empty) takes their newest.

**Health.** One circuit per member, in each process: `circuit.failures`
consecutive failures or timeouts (default 5) open it (`member-down`) for
`circuit.cooldown` (default 30 s); then one `ping()` probe closes it
(`member-up`) or opens it again. A member's call is not cancelled at its
timeout: the backend may still apply it. Keep the cache's own `timeout`, if
any, above the members'.

**Rejoin empty.** A member that misses a write or delete — its circuit open,
the call failing or timing out, or dropped from a full `write: "primary"`
queue — is marked **dirty** in this process (`member-dirty`, with the `op`
and a `reason`: `"down"`, `"failed"` or `"overflow"`), and nothing else is
kept. Reads skip it until it has been emptied: once every call it was sent
has settled, every namespace this combinator wrote to is `clear()`ed on it,
and then it serves again (`member-up` with `cleared: true`). A replayed
repair log could not be trusted after an outage; an empty cache can always be
refilled. Emptying is the whole member's share of those namespaces, so a
member that misses one write while up is emptied too: give `timeout` room.

**The gap.** Process P sees member B down and deletes `k` on A only. Process
Q still sees B up, and later fails over to B, where `k` survived: Q serves a
deleted value for up to `k`'s TTL. Nothing in one process can see what
another missed. `secondaryTtl` caps the hard expiry written to every member
but the first, which bounds that window (and makes a failover read a miss
sooner): served stale right after the delete, gone after `secondaryTtl`.

**Counters and locks** cannot be atomic across independent backends, so they
live on the first member only (`counters: "primary"`, the default). While it
is down or being emptied, `increment` throws `UnsupportedOperationError` and
**never fails over** — a counter restarted from a secondary's old value is
worse than an error — and `get` of a counter misses. The cross-process lock
is refused the same way, and the capabilities say so while it lasts
(`lock: false`), so `getOrSet({ lock: true })` falls back to the in-process
single-flight instead of waiting out a lock it cannot take. A primary that
rejoins empty loses the counters of the namespaces it is emptied of (a
rate-limit window restarts). `counters: "refuse"` removes counters and locks.

**Capabilities** are the members' intersection, except counters and locks
(above): `multiProcess` only when every member is; `maxEntryBytes` the
smallest. **Tags** are `"index"` when every member indexes them — deleted on
every member, and the fence checked on every member a write goes to: a write
any member fences is fenced, and deleted where it was stored. Otherwise they are
`"stamps"`: an invalidation stamps every member and the core's read check
hides what it invalidated, which is just as correct on an indexing member,
whose invalidated entries then keep their space until they expire. **The
bus** is the first member's, unless the cache names one (`bus:
redisBus(...)`).

Not offered: **quorum reads** (they need three or more members, for
store-of-record semantics a cache does not need) and **read repair** (it can
copy a value that was deleted elsewhere while a member was down).

## Custom drivers

Implement `CacheDriver` — or the minimal `SimpleCacheDriver` (`get`, `set`,
`delete`, optional `clear`), wrapped by `fromSimpleDriver` — and prove it with
the conformance kit (`@kingsleyweb/bun-cache/testing`):

```ts
// my-driver.ts — a Map behind a fake network delay
import type {
  CacheDriver,
  CacheDriverCapabilities,
  StoredEntry,
} from "@kingsleyweb/bun-cache";

export interface MapStoreOptions {
  /** The fake network delay per operation, in ms. */
  latencyMs?: number;
}

/** A driver over a Map, as a starting point for a real one. */
export function mapStoreDriver(options: MapStoreOptions = {}): CacheDriver {
  const latency = options.latencyMs ?? 2;
  const entries = new Map<string, StoredEntry>();        // `${ns}\n${key}`
  const stamps = new Map<string, { at: number; until: number }>(); // `${ns}\n${tag}`

  const capabilities: CacheDriverCapabilities = {
    multiProcess: false,       // a Map is this process only
    ttl: "sweep",              // nothing native; the core's sweeper calls sweep()
    atomicIncrement: false,    // not offered: the cache's increment() throws
    lock: false,               // not offered: `lock: true` falls back to single-flight
    tags: "stamps",            // no index: invalidation is a stamp, checked on read
    fence: "atomic",           // unused in stamps mode
    bus: "none",               // no invalidation bus
  };

  const read = (ns: string, key: string): StoredEntry | undefined => {
    const entry = entries.get(`${ns}\n${key}`);
    if (
      entry !== undefined &&
      entry.expiresAt !== null &&
      entry.expiresAt <= Date.now()
    ) {
      entries.delete(`${ns}\n${key}`);  // lazy expiry: reclaim on read
      return undefined;
    }
    return entry;
  };

  return {
    name: "map-store",
    capabilities,
    async close() {
      entries.clear();
      stamps.clear();
    },
    async get(ns, key) {
      await Bun.sleep(latency);
      return read(ns, key);
    },
    async getMany(ns, keys) {
      await Bun.sleep(latency);
      return keys.map((key) => read(ns, key));
    },
    async set(ns, entry) {
      await Bun.sleep(latency);
      entries.set(`${ns}\n${entry.key}`, {
        ...entry,
        value: entry.value.slice(),      // no aliasing: copy on write
      });
      return "stored";                   // no fence in stamps mode
    },
    async setMany(ns, batch) {
      await Bun.sleep(latency);
      for (const entry of batch) {
        entries.set(`${ns}\n${entry.key}`, { ...entry, value: entry.value.slice() });
      }
    },
    async delete(ns, keys) {
      await Bun.sleep(latency);
      let count = 0;
      for (const key of keys) {
        if (entries.delete(`${ns}\n${key}`)) count++;
      }
      return count;
    },
    async clear(ns) {
      for (const key of [...entries.keys()]) {
        if (key.startsWith(`${ns}\n`)) entries.delete(key);
      }
      for (const key of [...stamps.keys()]) {
        if (key.startsWith(`${ns}\n`)) stamps.delete(key);
      }
    },
    // The stamps: one (tag, invalidatedAt) record per invalidated tag,
    // read back by the core's read-side check.
    async getStamps(ns, tags) {
      const out = new Map<string, number>();
      const now = Date.now();
      for (const tag of tags) {
        const stamp = stamps.get(`${ns}\n${tag}`);
        if (stamp !== undefined && stamp.until > now) out.set(tag, stamp.at);
      }
      return out;
    },
    async setStamps(ns, tags, at, until) {
      for (const tag of tags) stamps.set(`${ns}\n${tag}`, { at, until });
    },
    // The sweeper: delete expired entries, at most `limit` of them.
    async sweep(now, limit) {
      let removed = 0;
      for (const [key, entry] of [...entries]) {
        if (removed >= limit) break;
        if (entry.expiresAt !== null && entry.expiresAt <= now) {
          entries.delete(key);
          removed++;
        }
      }
      return removed;
    },
  };
}
```

Then the kit, in your own test file:

```ts
import { runCacheDriverConformance } from "@kingsleyweb/bun-cache/testing";

await runCacheDriverConformance("map-store", () => ({
  driver: mapStoreDriver(),
  // cleanup: () => driver.close(),   // remove test data here
}));
```

The kit checks byte round-trips, expiry (lazy and swept), `getMany` order,
`setMany` (each entry's expiry and tags, replaced tags, a key given twice,
a batch past 1,000 entries and past 16 MiB, and through a cache: per-entry
TTLs, tags and compression, an oversize entry, plain and encrypted), the
optional fenced batch `setManyFenced` (each entry's fence and outcome, and the
fence under a concurrent invalidation; skipped, naming the method, on a
`tags: "index"` driver without it),
delete counts, namespace-scoped `clear`, tag invalidation in both modes with
the fence's race, 200 concurrent increments, a 50-way contended lock, and bus
delivery. Each case is gated on the driver's `capabilities`: an advertised
capability that fails its case fails the suite; one not advertised is
reported as skipped, with its name.

A driver that advertises `multiProcess` also gives the kit `crossProcess`
(`{ module, export, options }`: how a child process builds the same driver on
the same backend), and the kit runs increments, a contended lock and stamp
visibility from two processes. Both sides are released together from a start
barrier and the increments run in interleaved waves, so the two genuinely
overlap. A driver with a polled bus also gives `busGap`, a function that
forces a gap in its log; a driver with a pushed bus may give one that drops
its subscriber connection (on Redis, for example, with `CLIENT KILL`), and
the bus-gap case then runs for it too.

The kit also runs the core over the driver with `encrypt` and `hashNames`
on: every operation the driver advertises, through caches whose names reach
it only as hashes. Give it `rawDump` too — a function answering every byte
the backend holds, read around the driver (rows, key names, objects, files,
the bus), as `Uint8Array`s or strings — and it writes sentinel keys,
namespaces, tags and values through such a cache and fails if the dump
shows any of them, in UTF-8 or UTF-16. It first checks the dump can see the
store at all: a plain cache's value and namespace must be in it.

```ts
await runCacheDriverConformance("map-store", () => ({
  driver,
  rawDump: () => [...store].flatMap(([name, bytes]) => [name, bytes]),
}));
```

**A fenced batch** is optional. A `tags: "index"` driver may add
`setManyFenced(ns, writes)`: each `write` is `{ entry, fence? }` (a
`FencedWrite`), held to its fence exactly as `set(ns, entry, fence)` is, and
it answers `"stored"` or `"fenced"` per write, in order. A `fenced` write
stores nothing, and the key keeps what it held. The keys of one call are
distinct. With it, `cache.setMany` writes a tagged batch in one call; without
it, the core sends a fenced `set` per tagged entry, so a driver written
before it needs no change.

## Testing helpers

`@kingsleyweb/bun-cache/testing` also ships:

- **`runCacheCipherConformance(name, cipher)`** — the contract a user
  cipher keeps ([User ciphers](#user-ciphers)).
- **`faulty(inner, { failRate, failOn, hangMs, lagMs, down })`** — a
  fault-injection wrapper: fail every operation, fail named operations, hold
  them open, or slow them. `driver.setFaults({...})` changes the faults
  mid-test. An injected failure is an `InjectedFaultError` (its `op` names
  the operation). Use it to test how your app behaves when the cache's
  backend fails: the failure policy, the circuit, `strict`.
- **`fakeClock()`** — a controllable clock for `createCache`'s `now` option
  (and `memoryDriver`'s), so expiry, staleness and the fence are tested
  without waiting:

  ```ts
  const clock = fakeClock();
  const cache = createCache({
    driver: memoryDriver({ now: clock.now }),
    now: clock.now,
    sweepInterval: 0,   // tests sweep by hand
  });
  clock.advance(61_000);  // one minute later, without waiting one minute
  ```

## The driver matrix

| Driver | TTL | Atomic increment | Lock | Tags | Bus |
|---|---|---|---|---|---|
| memory | lazy + sweep | yes | in process | index, atomic fence | in-process |
| custom (`fromSimpleDriver`) | declared | no | no | stamps | no |
| file | lazy + sweep | yes, under a lock file | `O_EXCL` file | stamps, checked on read | polled log |
| SQLite | filtered on read + sweep, indexed `exp` | yes, `RETURNING` upsert | lock row, one conditional upsert | index, atomic fence (one transaction) | polled table |
| Postgres | filtered on read + sweep, partial `exp` index | yes, `RETURNING` upsert | lock row, one conditional upsert | index, atomic fence (one statement under a namespace advisory lock) | `LISTEN`/`NOTIFY` |
| MySQL / MariaDB | filtered on read + sweep, indexed `exp` | yes, `LAST_INSERT_ID` upsert | lock row, one conditional upsert | index, atomic fence (a `REPEATABLE READ` transaction) | polled table |
| Redis | native (`PEXPIREAT`), filtered on read | yes, Lua (`HINCRBY`) | `SET … PX`, Lua take and compare-and-delete | index, atomic fence (one Lua script) | pub/sub (`redisBus`) |
| MongoDB | TTL index (a 60 s monitor) + filtered on read + sweep | yes, one update pipeline | lock document, a conditional upsert | index, check-then-write fence with a take-back | change stream (replica set) or tailable capped collection |
| S3 | filtered on read + sweep (+ a bucket lifecycle rule) | yes, compare-and-swap (`If-Match`), batched per key | conditional `PUT`s, compare-and-delete | stamps, checked on read | none (`redisBus` / `pgBus`) |
| Azure Blob Storage | filtered on read + sweep (+ a lifecycle management rule) | yes, compare-and-swap (`If-Match`), batched per key | conditional Put Blob, compare-and-delete (not leases) | stamps, checked on read | none (`redisBus` / `pgBus`) |
| Cloudflare KV | native (`expiration_ttl`, at least 60 s) + filtered on read | no | no | stamps, checked on read (eventually consistent) | none (`redisBus` / `pgBus`) |
| Cloudflare D1 | filtered on read + sweep, partial `exp` index | yes, `RETURNING` upsert | lock row, one conditional upsert | index (triggers), atomic fence (one statement) | none (`redisBus` / `pgBus`) |
| `redundant([...])` | its members' (native only when all are) | the primary's, never failed over | the primary's, never failed over | index when every member indexes, else stamps | the first member's |

## The memory driver

```ts
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";

const cache = createCache({
  driver: memoryDriver({ maxEntries: 50_000, maxBytes: 256 << 20 }),
});
```

A `Map` in this process: the fastest driver, and the one for tests and for a
single process. Nothing is shared with other processes (`multiProcess:
false`), and nothing survives a restart.

- **Options**: `maxEntries` and `maxBytes` (the encoded bytes) cap it, the
  least recently used entries going first; both are uncapped by default.
  `now` is the clock, for tests: pass the same `fakeClock()` the cache runs
  on ([Testing helpers](#testing-helpers)).
- **Everything is supported**: atomic counters, an in-process lock, an
  index of tags with an atomic fence, and an in-process bus.
- **Values are copied** on write, so a caller that changes the bytes it
  passed changes nothing stored. Expiry is lazy on read, plus the sweeper.

## The file driver

```ts
import { createCache, fileDriver } from "@kingsleyweb/bun-cache";

const cache = createCache({
  driver: fileDriver({ root: "/var/lib/myapp/cache" }),
});
```

One directory, one file per entry, for several processes on one host (a
durable single-machine cache that survives restarts, and the first
`multiProcess` driver). The layout:

```
<root>/<seg ns>/e/<hh>/<sha256(key)>.bce   entry: file header + encoded bytes
<root>/<seg ns>/s/<sha256(tag)>            tag stamp
<root>/<seg ns>/n/<sha256(key)>.cnt        counter
<root>/<seg ns>/l/<sha256(key)>.lock       per-key lock file
<root>/bus.log                             append-only bus log
```

- **Writes are atomic**: a temp file renamed into place, so a reader never
  sees a torn entry. Sharding is one level of 256 directories by default
  (`shard: 0 | 1 | 2`).
- **Tags are stamps mode**: `invalidateTags` writes one stamp file per tag;
  the read-side check invalidates and the sweeper reclaims the space.
- **Locks** are `O_EXCL` lock files (created with full content via a hard
  link), stale after their TTL, and broken only when *positively read* as
  stale — a lock that merely fails to read in the churn of a herd is probed,
  never moved.
- **Expiry and caps**: lazy on read, plus the sweeper — expired entries from
  their 14-byte file header, then `maxEntries`/`maxBytes` oldest-first by
  modification time (age order, not LRU).
- **The bus** is a polled append-only `bus.log` (default 250 ms); a
  compaction past `maxBusLogBytes` (1 MiB) signals a gap to subscribers.
- **Durability and limits**: POSIX local filesystems only — never NFS
  (lock-file semantics do not survive it). Writes are several times slower
  than SQLite's; prefer SQLite for small values on one host. There is no cross-machine story: use a shared driver
  (SQL, Redis) for that.

## The SQLite driver

```ts
import { createCache, sqliteDriver } from "@kingsleyweb/bun-cache";

const cache = createCache({
  driver: sqliteDriver({ path: "/var/lib/myapp/cache.db" }),
});
```

One database file over `bun:sqlite`, shared by every process on the host
that opens it. Five tables, under the prefix
(`bun_cache_` by default; `prefix` must be an SQL identifier, and two
prefixes on one file are two separate stores):

```
<p>entries (ns, k, v BLOB, n INTEGER, exp INTEGER, tg TEXT, ca INTEGER)  entries and counters (ca: written/created at)
<p>tags    (ns, tag, k)                                                  the tag index
<p>stamps  (ns, tag, at, exp)                                            invalidation stamps
<p>locks   (ns, k, owner, exp)                                           lock rows
<p>bus     (seq AUTOINCREMENT, at, msg)                                  the polled bus
```

**Table names.** `prefix` names them all (`<prefix>entries`, …); `tables`
names any of them outright, for an existing schema that was not named here —
`sqliteDriver({ path, tables: { entries: "app_cache" } })` — and a name given
that way is used as-is and ignores the prefix (the others keep it), as
bun-jobs' SQL driver does. Every name is an SQL identifier of at most 63
characters, and no two tables may share one; anything else throws. Index
names follow the tables (`ix_<table>_exp`, `ix_<table>_key`, shortened with a
hash past 63 characters). The table keys are the `SqlCacheTable` type.

**Schema.** The tables are created automatically on first use, with
`CREATE TABLE IF NOT EXISTS` (and `CREATE INDEX IF NOT EXISTS`), once per
connection; nothing is ever dropped. `syncSchema()` answers `[]`: there is
one schema version, so there is nothing to migrate yet. The `syncSchema`
option (`true`, or the `SchemaSyncOptions` to pass) runs it when the tables
are created — **a no-op until the schema first changes**; set it now so later
migrations run on connect. As in bun-jobs, connecting does not return the
sync's report: `await driver.syncSchema({ dryRun: true })` reads one.

- **One connection per file per process.** Every `sqliteDriver` on the same
  file (after `path.resolve`) shares one `Database`; the last `close()`
  closes it. `bun:sqlite` is synchronous, so nothing in the process ever
  waits on itself for the write lock.
- **Pragmas**: `journal_mode=WAL`, `synchronous=NORMAL` and a deliberately
  small `busy_timeout=50`. SQLite's busy handler sleeps in the calling
  thread — the event loop — so the waiting for another process's write is
  done in JavaScript instead, retrying `SQLITE_BUSY` with jittered backoff
  for up to 10 s.
- **Atomic by transaction.** Each write is one synchronous
  `BEGIN IMMEDIATE` transaction: the fence check with the entry and its tag
  rows; the tag-index delete with the stamps; a counter's `RETURNING` upsert.
- **Locks** are one conditional upsert whose `WHERE` is the staleness check
  (`exp <= now`), evaluated under the write lock: there is no read-then-break
  step, so a stale break can never replace a live lock.
- **Expiry**: reads filter out expired rows and never write; the core's
  sweeper deletes them through the partial `exp` index (with their tag rows,
  expired stamps and lapsed locks).
- **`maxEntries`** (opt-in; no cap by default — the database is sized by its
  operator): the same sweep pass, in the same transaction, evicts the excess
  — **nearest to expiry first**, then the entries with no expiry, oldest
  write first — each with its tag rows, at most the sweep's `limit` per
  pass. Each eviction is an `evict` event (reason `"cap"`) and counts in
  `stats().evictions`. It is enforced at sweep time, so the table can briefly
  exceed the cap between sweeps. The cap counts every namespace under the
  prefix together. Counters are not entries: never counted, never evicted
  (that would silently reset a rate-limit window). Two processes sweeping one
  file at once evict exactly the excess: each pass counts and evicts inside
  one `BEGIN IMMEDIATE` transaction.
- **The bus** is the `<p>bus` table, polled every `busPollInterval` (250 ms)
  and pruned by age (`busRetention`, 60 s). A subscriber further behind than
  that, or a reset table, sees a gap.
- **An existing database**: `sqliteDriver({ database })` uses a `Database`
  you opened, never closes it, and sets no pragma on it — give it
  `journal_mode=WAL` yourself if several processes share the file.
  `path: ":memory:"` is a private in-process store (`multiProcess: false`).
- **Limits**: one host (SQLite's locking does not survive a network
  filesystem). Every call blocks the event loop while it runs — a few
  microseconds for a small hit, about a hundred for a 10 KB one — so keep
  values over ~100 KB in another driver.

## The Postgres, MySQL and MariaDB drivers

```ts
import {
  createCache,
  mariadbDriver,
  mysqlDriver,
  postgresDriver,
} from "@kingsleyweb/bun-cache";

const cache = createCache({
  driver: postgresDriver({ url: process.env.DATABASE_URL }),
});
// or mysqlDriver({ url: "mysql://app:secret@db:3306/app" }),
//    mariadbDriver({ connection: { host: "db", user: "app", password, database: "app" } }),
//    postgresDriver({ sql: existingClient })  // never closed by the driver
```

One set of tables in a database every process and host can reach, over Bun's
built-in `SQL`. The tables, under the prefix
(`prefix`, `bun_cache_` by default; letters, digits and `_`, at most 48
characters) unless `tables` names them:

```
<p>entries (ns, k, v bytes, n BIGINT, exp BIGINT, ca BIGINT, tg TEXT)  entries and counters (ca: written/created at)
<p>tags    (ns, tag, k)                                               the tag index
<p>stamps  (ns, tag, at, exp)                                         invalidation stamps
<p>locks   (ns, k, owner, exp)                                        lock rows
<p>bus     (seq AUTO_INCREMENT, at, msg)                              MySQL and MariaDB: the polled bus
```

**Table names.** `prefix` names them all (`<prefix>entries`, …); `tables`
names any of them outright, for an existing schema that was not named here —
`postgresDriver({ url, tables: { entries: "app_cache" } })` — and a name
given that way is used as-is and ignores the prefix (the others keep it), as
bun-jobs' SQL driver does. Every name is an SQL identifier of at most 63
characters (Postgres's limit, one under MySQL's), and no two tables may share
one; anything else throws. `bus` can be named on MySQL and MariaDB only:
Postgres's bus is `LISTEN`/`NOTIFY`, and `postgresDriver` refuses a `bus`
name. Index names follow the tables (`ix_<table>_exp`, `ix_<table>_key`,
`ix_<table>_at`, shortened with a hash past 63 characters). The `LISTEN`
channel and the advisory-lock keys are derived from the entries, tags,
stamps and locks table names, so two drivers on the same tables share them
and two on different tables never do. The table keys are the `SqlCacheTable`
type.

**Schema.** The tables are created automatically on first use, with
`CREATE TABLE IF NOT EXISTS` (and `IF NOT EXISTS` indexes on Postgres; the
indexes are inline in `CREATE TABLE` on MySQL and MariaDB), once per driver;
nothing is ever dropped. `syncSchema()` answers `[]`: there is one schema
version, so there is nothing to migrate yet. The `syncSchema` option
(`true`, or the `SchemaSyncOptions` to pass) runs it on connect, after the
tables are created — **a no-op until the schema first changes**; set it now
so later migrations run on connect. As in bun-jobs, `connect()` does not
return the sync's report: `await driver.syncSchema({ dryRun: true })` reads
one.

- **Connections**: a `url`, `connection` fields, or an existing `sql` client
  (never closed by the driver; the driver closes only what it built). `max`
  sizes the pool of a client the driver builds. On MySQL and MariaDB,
  `allowPublicKeyRetrieval` — the URL parameter or the connection field — is
  taken out of the URL and passed as the client option, because **Bun
  ignores it in a URL**; prefer TLS outside a trusted network.
- **Keys are exact**: MySQL's and MariaDB's columns are `VARCHAR(255)` in a
  binary collation (`utf8mb4_0900_bin`, `utf8mb4_nopad_bin`), so `"a"`,
  `"A"` and `"a "` are three keys. A namespace, key, tag or lock owner longer
  than 255 characters is stored as `#` + its SHA-256, on all three engines.
- **The fence is airtight under a concurrent invalidation.** A write whose
  load began before `invalidateTags` either commits before the invalidation
  deletes (and is deleted) or sees its stamp (and is refused), never neither:
  on Postgres the write holds a shared advisory lock on its namespace and the
  invalidation an exclusive one; on MySQL and MariaDB the write reads the
  stamps `LOCK IN SHARE MODE` inside a `REPEATABLE READ` transaction, and the
  invalidation upserts them first. Writes that touch the tag index on MySQL
  and MariaDB are one transaction; on Postgres one statement.
- **`setMany`** is multi-row: on Postgres one statement per 1,000 entries
  (and 16 MiB of values), several in one transaction; on MySQL and MariaDB
  one `REPEATABLE READ` transaction of multi-row statements, each within
  1,000 rows and `max_allowed_packet`. Either way the batch is stored whole
  or not at all, its rows go in key order (two batches over the same keys
  lock them in the same order), and a key given twice keeps its last write.
  A tagged batch is one transaction too: one read of its fence tags' stamps
  under the fence's lock (Postgres's shared advisory lock, MySQL's and
  MariaDB's `LOCK IN SHARE MODE`), then the same writes for the entries the
  stamps do not refuse.
- **Counters** are integers (`BIGINT`), added in the database, and may go
  below zero; a fractional step throws a `TypeError`.
- **Expiry**: reads filter out expired rows and never write; the core's
  sweeper deletes them (with their tag rows, expired stamps, lapsed locks
  and, on MySQL and MariaDB, bus rows past `busRetention`).
- **`maxEntries`** (opt-in; no cap by default — the database is sized by its
  operator): after the expired delete, one transaction evicts the excess —
  **nearest to expiry first**, then the entries with no expiry, oldest write
  first — each with its tag rows, at most the sweep's `limit` per pass. Each
  eviction is an `evict` event (reason `"cap"`) and counts in
  `stats().evictions`. It is enforced at sweep time, so the table can briefly
  exceed the cap between sweeps; it counts every namespace under the prefix
  together; counters are never counted or evicted. Two processes sweeping at
  once take turns (an advisory lock on Postgres, a lock row on MySQL and
  MariaDB), so the excess is evicted exactly once.
- **The bus**: Postgres uses `LISTEN`/`NOTIFY` on a channel named after the
  prefix; a message too big for a notification (8,000 bytes) is sent as a
  `clear` of its namespace, and a reconnect of the listening connection is
  reported as a gap. MySQL and MariaDB poll `<p>bus` every `busPollInterval`
  (250 ms); a hole in its sequence that outlives about a second — rows
  pruned while a subscriber lagged, or an insert that never committed — is
  reported as a gap.
- **`unlogged: true`** (Postgres) creates `UNLOGGED` tables: faster writes,
  emptied after a crash and **not replicated to standbys**, so a failover
  starts cold. It applies when the tables are created.
- **Limits**: an entry is at most `max_allowed_packet` less 64 KiB on MySQL
  and MariaDB (read from the server on connect, as
  `capabilities.maxEntryBytes`), and 1 GB on Postgres.

## The Redis driver

```ts
import { createCache, redisDriver } from "@kingsleyweb/bun-cache";

const cache = createCache({
  driver: redisDriver({ url: process.env.REDIS_URL }), // redis:// or rediss://
});
// or redisDriver({ connection: { host: "cache", port: 6379, database: 2, password } }),
//    redisDriver({ client: existingClient })  // never closed by the driver
```

One Redis every process and host can reach, over Bun's built-in
`RedisClient`. Every key is under the prefix (`prefix`,
`bun-cache` by default; not empty, no `{` or `}`) and the namespace, wrapped
in a hash tag and encoded so it never holds `}` or `:` (any string is a safe
namespace; `SCAN` patterns are escaped, so `x*` never reaches `xy`):

```
<p>:{<ns>}:e:<key>   STRING  the entry: a header line (expiry, tags) and its bytes; PEXPIREAT
<p>:{<ns>}:n:<key>   HASH    a counter (value, expiry, created at); PEXPIREAT
<p>:{<ns>}:t:<tag>   SET     the keys carrying the tag
<p>:{<ns>}:s:<tag>   STRING  the tag's invalidation stamp, "<at> <until>"
<p>:{<ns>}:l:<key>   STRING  a lock's owner; PX
<p>:{<ns>}:w:<uuid>  STRING  a large entry's frame between its two commands (below); PX 60 s
<p>:bus              the bus channel
```

- **Atomic in Lua**: a write with the tag fence (check the stamps, replace
  the old tag memberships, write) is one script, and so is `deleteByTags`
  (every stamp, then every member and the sets), so a write whose load began
  before an invalidation is refused or deleted, never kept. A tagged
  `setMany` is that write for each entry, one script per 1,000 entries. So
  are `increment`, `touch`, `delete` and the lock's take and release. Scripts run
  by `EVALSHA` and are sent again with `EVAL` when the server answers
  `NOSCRIPT` (after a restart or a `SCRIPT FLUSH`). On Upstash,
  `keyLocking: true` runs them under a namespace's lock instead of the
  database's ([below](#upstash-and-other-managed-redis)).
- **A large entry skips Lua.** A value passed to a script is copied into Lua
  and out again, several times slower than a plain `SET` for a large value.
  So an entry whose frame is 8 KiB or more is
  written with a plain `SET` to a staging key (`w:`, in the namespace's hash
  tag, expiring in 60 s), pipelined with the script, which checks the fence
  and renames it into place, or deletes it when fenced. `setMany` stages its
  large frames the same way, renaming each in the batch's script (staged
  frames are outside a script's 8 MiB of arguments; one script renames at
  most 64 MiB of them). A script whose staged frame is gone (its `SET`
  failed, or it outlived the 60 s) writes nothing and fails, `set`'s
  included, so the old entry and its tag memberships stay as they were; the
  staging write's own error is the one thrown. Replacing or deleting an entry reads only its header
  line (`GETRANGE` of its first 4 KiB).
- **Expiry is native**: an entry's and a counter's keys expire with
  `PEXPIREAT`, and reads also treat a passed expiry as a miss. There is
  nothing for the core's sweeper to reclaim but what has no TTL — tag-set
  members whose entry is gone, empty tag sets and lapsed stamps — which
  `sweep` prunes, walking the prefix with `SCAN` (at most 100 calls a pass,
  resuming where the last one stopped).
- **A memory cap**: there is none by default; Redis is sized by its operator.
  To bound it, run the server with `maxmemory` and **`maxmemory-policy
  volatile-lru`** (or `volatile-ttl`): Redis then evicts entries that have an
  expiry, least recently used first, and never touches the keys that have
  none. Tag sets and stamps deliberately have no Redis TTL, so that an
  eviction can never take a tag set while its entries live on (an
  invalidation would miss them) or a stamp while a load it must fence is
  still running. An entry written without a TTL is never evicted under
  these policies. A counter with an expiry can be evicted, which resets it.
  Avoid `allkeys-*` policies, which can evict tag sets and stamps.
- **Counters** are integers, added in Redis, and may go below zero; a
  fractional step throws a `TypeError`. A counter and an entry never share a
  key: the last writer wins.
- **`clear()`** deletes the namespace's entries, counters and tag sets by
  `SCAN` in batches, so it is not atomic: a write landing during it may
  survive. Stamps and locks stay.
- **Bytes**: values are written as given and read with `getBuffer`; Bun's
  other replies are strings, which would not round-trip bytes that are not
  UTF-8. An entry is at most 511 MiB (Redis's 512 MB string, less room for
  the header); the core's `maxEntryBytes` (4 MiB) applies first.
- **The bus** is `redisBus` on the driver's client and prefix: pub/sub on
  `<prefix>:bus`, subscribed on a `duplicate()` of the client, a reconnect of
  that connection reported as a gap (every L1 flushes). A `redisBus` with the
  same prefix shares the channel. Pub/sub ignores the database number, so two
  deployments on one server need different prefixes to keep their buses
  apart.
- **Connections**: a `url`, `connection` fields (`host`, `port`, `user`,
  `password`, `database`, `tls`), or an existing `client` (never closed by
  the driver; its options are its own). The first connect of a client the
  driver builds is bounded by `firstConnectTimeout` (5 s; `0` for none):
  without it, Bun retries a refused connection for about 31 s before an
  operation fails. A TLS connect to a Redis in another region can take most
  of a second, which is why the bound is not tighter. `connectionTimeout`, `maxRetries` and `autoReconnect` are
  Bun's own, passed through. After a drop, Bun reconnects; once it gives up,
  the next operation starts again.
- **Redis Cluster is not supported yet**: Bun's `RedisClient` does not
  follow the cluster's `MOVED` and `ASK` redirects
  ([oven-sh/bun#22947](https://github.com/oven-sh/bun/issues/22947)), so
  every key on another node fails with `MOVED`. `cluster: true` throws, and connecting to a cluster node fails
  with the same explanation. The keys are hash-tagged by namespace already,
  so the layout will not change when it is. A primary behind a stable
  address (a managed service, a proxy) works; Sentinel does not (Bun has no
  Sentinel support, oven-sh/bun#38515).

### Upstash and other managed Redis

`redisDriver({ url: "rediss://default:<password>@<name>.upstash.io:6379" })`
works on [Upstash](https://upstash.com) over its Redis protocol endpoint,
and passes the driver conformance kit there. What differs from a Redis next
to the app:

- **Every command is a round trip** to the database's region (Upstash
  quotes under 1 ms in the same region; from another continent it is
  hundreds of ms). Put the app in the database's region, and use an `l1`
  for hot keys. Concurrent operations share one connection, pipelined, so a
  burst of them costs about one round trip, not one each.
- **It bills per command**, a Lua script as one plus every `redis.call`
  inside it. What each operation costs:

  | Operation | Commands |
  |---|---|
  | `get`, a hit or a miss; `getCounter`; `getStamps` (one `MGET`) | 1 |
  | `getMany` | 1 per key |
  | `set`, a new key, no tags | 5 |
  | `set`, each tag | +1 |
  | `set` replacing an entry | +1 per old tag it no longer carries |
  | `set` with the fence | +1 (one `MGET` of the stamps) |
  | `set` of an entry of 8 KiB or more (staged) | +2 (the staging `SET`, and the script's `EXISTS` of it), and +1 more when it has no expiry |
  | `setMany`, each entry of 8 KiB or more (staged) | as `set`'s, and 1 per script that stages (`EXISTS`) |
  | `touch` | 4 |
  | `increment` (an existing counter / a new one) | 3 / 6 |
  | `acquireLock`, `releaseLock` | 3 each |
  | `delete` | 1, plus 3 per absent key, 3 per entry, and 1 per tag it carried |
  | `deleteByTags` | 1, plus 3 per tag, plus 2 per member and 1 per tag it carried |
  | `publish` (the bus) | 1 |

  `clear` and `sweep` walk the whole database with `SCAN`, 1,000 keys a
  call.
- **Eviction is off by default** there, and writes fail at the plan's size
  limit. Turned on, Upstash evicts keys with a TTL first, then any key —
  tag sets and stamps included — so under memory pressure an invalidation
  can miss entries whose tag set was evicted (as with `allkeys-*` above).
- **Requests are at most 10 MB** on the free and pay-as-you-go plans: keep
  `maxEntryBytes` (4 MiB by default) under it.
- **No `CLIENT KILL`**: the driver never sends it. Replication across
  Upstash's replicas is asynchronous, and consistency is causal per
  connection only; the fence is unaffected (it runs in a script, on the
  primary).
- **Scripts take Upstash's global lock** by default (no other command runs
  meanwhile), and a key a script names outside `KEYS` that has gone cold to
  disk is loaded with that lock held. `keyLocking: true` lifts that (below).

**`keyLocking`: Upstash's per-key script locking.**

```ts
redisDriver({ url: process.env.UPSTASH_REDIS_URL, keyLocking: true });
```

Every script the driver runs then starts with `#!lua flags=allow-key-locking`,
so Upstash locks only the hash tag of the script's keys — the namespace's,
`{<ns>}` — instead of the whole database: scripts on other namespaces, and
plain commands on other keys, run alongside it, and a cold key is loaded
holding only that namespace's lock. Writes to one namespace still run one at
a time. Use it on Upstash when several namespaces, or other applications
sharing the database, write at once. Upstash refuses a key outside a flagged
script's locked hash tags ("Dynamic keys are not allowed …"); every script
the driver runs keeps to its namespace's tag.

**`allow-oom` on the scripts that only remove.** A script with a shebang and
without `allow-oom` is refused whole while the server is out of memory,
where an unflagged one runs until a command that would grow memory. So
`delete`, `releaseLock` and `sweep`'s two prunes (a tag set's members, a
lapsed stamp) — every command in them a read or a removal — declare
`#!lua flags=allow-key-locking,allow-oom`, and a full database can still be
freed through them. Nothing that writes carries it: not `set`, `touch`,
`increment` or `acquireLock`, nor `deleteByTags`, which writes a stamp per
tag before it deletes. Upstash accepts the combined flags and still locks
by key; how it behaves when the database is actually full has not been
verified.

**Upstash only.** Plain Redis rejects the flag (Redis 8.0.5: "Unexpected flag
in script shebang: allow-key-locking"; Redis 6 has no script flags), so the
option is off by default. Set against such a server, the first write fails
with `redisDriver: keyLocking is set, and <host:port> refused Upstash's
allow-key-locking script flag (…)`; reads that need no script (`get`,
`getMany`, a counter, the stamps) still answer.

**The URL is a credential**: it holds the database's password. Keep it in
your secret store or environment, never in the repository.

## The MongoDB driver

```ts
import { createCache, mongoDriver } from "@kingsleyweb/bun-cache";

const cache = createCache({
  driver: mongoDriver({ url: "mongodb://db:27017/app" }),
});
// or mongoDriver({ connection: { host: "db", database: "app" } }),
//    mongoDriver({ client: existingMongoClient, database: "app" })  // never closed by the driver
```

One set of collections in a database every process and host can reach.
**`mongodb` is an optional peer** (`>=6`): install it with
`bun add mongodb`. The driver loads it on first connect, and its types are
structural (`MongoClientLike`), so a project that never builds a
`mongoDriver` needs neither the package nor its types, and a real
`MongoClient` passed as `client` type-checks. The collections, under the
prefix (`prefix`, `bun_cache_` by default) unless `collections` names them:

```
<p>entries { _id: { ns, k }, v?: Binary, n?: number, exp: Date | null, tags, ca, w }  entries and counters
<p>stamps  { _id: { ns, tag }, at, exp }                                            invalidation stamps
<p>locks   { _id: { ns, k }, owner, exp }                                           lock documents
<p>bus     capped, 16 MiB (busSize): { _id, ts, m }                                 the bus
```

**Collection names.** `prefix` names them all (`<prefix>entries`, …);
`collections` names any of them outright — `mongoDriver({ url, collections:
{ entries: "app_cache" } })` — and a name given that way is used as-is and
ignores the prefix (the others keep it), as bun-jobs' MongoDB driver does.
Names are letters, digits, `_`, `.` and `-`, starting with a letter or `_`,
never `system.…`, at most 120 characters, and no two may share one; anything
else throws. The keys are the `MongoCacheCollection` type. The database is
`database`, else `connection.database`, else the URL's path, else
`bun_cache`.

**Schema.** Connecting creates the indexes, once per driver: a TTL index on
`exp` (`expireAfterSeconds: 0`) on entries, stamps and locks, and the tag
index `{ "_id.ns": 1, tags: 1 }` (multikey). Nothing is ever dropped on
connect. `syncSchema()` creates any index that has gone missing and drops
**only** the indexes on the driver's `RETIRED_INDEXES` list — MongoDB names
an index after its key pattern, so one this driver no longer defines is
indistinguishable from one an operator added, and an index of yours is never
touched. The list is empty and connect creates every index, so today it
answers `[]`; `dryRun` reports without applying. The `syncSchema` option runs
it on connect, as on the SQL drivers.

- **Connections**: a `url`, `connection` fields, or an existing `client`
  (never closed by the driver), with `clientOptions` for a client the driver
  builds. Every collection reads from the **primary**, whatever the client's
  read preference: the reads that decide writes (the fence, a lock) must not
  see a lagging secondary.
- **Expiry**: the TTL monitor deletes what expired, but it runs **once a
  minute** (`ttlMonitorSleepSecs: 60`), so every read filters `exp` itself;
  the core's sweeper also deletes expired entries (up to its `limit` a pass).
- **The fence is check-then-write, with a take-back.** A write whose load
  began before `invalidateTags` reads the stamps, writes, and reads them
  again; if a stamp appeared meanwhile, it deletes its own write (only that
  write — a newer one is left) and is reported as `fenced`. The invalidation
  writes its stamps before it deletes, so no interleaving leaves a
  pre-invalidation value stored; what remains is a window of about one round
  trip in which a reader can see it (`capabilities.fence:
  "check-then-write"`). A tagged `setMany` does the same for the whole batch:
  one stamp read, one `bulkWrite` of the entries it does not refuse, one
  re-read, and one take-back of the writes a new stamp fences.
- **Counters** are integers, added on the server by one update, and may go
  below zero (MongoDB widens a 32-bit value to 64 bits as it grows); a
  fractional step throws a `TypeError`.
- **Keys are exact**, of any length: MongoDB has no index-key limit, so
  nothing is hashed here (the core still hashes keys past `maxKeyLength`).
- **`maxEntries`** (opt-in; no cap by default), with the SQL drivers'
  semantics: at sweep time, the excess is evicted — **nearest to expiry
  first**, then the entries with no expiry, oldest write first — at most the
  sweep's `limit` a pass, each as an `evict` event (reason `"cap"`); counters
  are never counted or evicted, and two processes sweeping at once take turns
  through a lock document. It counts and sorts without an index of its own,
  so a pass scans the collection.
- **The bus** is a capped collection (`busSize`, 16 MiB by default when the
  driver creates it; an existing one must be capped). On a **replica set** or
  through `mongos` subscribers read a **change stream**, resumed from its
  token after a resumable loss (a killed cursor, a dropped connection), or
  from where it opened when it was lost before its first read answered, so
  nothing is missed; a stream whose history is gone, or that was invalidated
  (the collection dropped), starts again from now and reports a **gap**. On
  a **standalone** server, which refuses change streams, subscribers tail
  the collection with an awaitData cursor positioned by a server timestamp;
  a lost cursor is reopened after the last message it read, and a gap is
  reported when messages it had not read may have been overwritten (it fell
  `busSize` behind) or the collection was dropped. A message over 64 KiB is
  sent as a `clear` of its namespace.
- **Limits**: an entry is at most the server's `maxBsonObjectSize` (16 MiB)
  less 64 KiB, read on connect as `capabilities.maxEntryBytes`. The server
  must be MongoDB 4.2 or later (the counter's update pipeline, unbounded
  index keys); it is tested on 7.0, standalone and as a replica set.
- **Which bus you get depends on the server.** A replica set (a single-node
  one is enough: `mongod --replSet rs0`, then `rs.initiate()`) or `mongos`
  gives the change-stream bus; a standalone server gives the tailable capped
  collection. Name the replica set in the URL
  (`mongodb://db:27017/app?replicaSet=rs0`) to get change streams.

## The S3 driver

```ts
import { createCache, redisBus, s3Driver } from "@kingsleyweb/bun-cache";

const cache = createCache({
  driver: s3Driver({ url: process.env.CACHE_S3_URL }),
  // s3://<accessKeyId>:<secretAccessKey>@<host>[:<port>]/<bucket>[?region=…][&scheme=http]
});
// or s3Driver({ connection: { bucket: "my-cache", region: "eu-west-1" } }) — Bun's own S3Options;
//    what it leaves out is read from S3_* / AWS_* like Bun's client does
// or s3Driver({ client: existingS3Client, connection: { … } })
```

A bucket every process and host can reach, over Bun's built-in `S3Client`.
It suits large values, long TTLs and few reads per key:
every read is a billed request, so for hot small keys put an
[L1](#multi-tier) in front of it, with a bus of its own (`bus:
redisBus(url)` or `pgBus(url)`; S3 has none).

```
<p>/<ns>/e/<hh>/<sha256(key)>   an entry or a counter: a header (expiry, tags) and the bytes
<p>/<ns>/s/<sha256(tag)>        a tag's invalidation stamp
<p>/<ns>/l/<sha256(key)>        a lock
```

`<p>` is the prefix (`prefix`, `bun-cache` by default), `<ns>` the namespace
encoded so it never adds a `/`. Every object's `Content-Type` carries its
kind, expiry and write time (`application/x-bun-cache; exp=…; at=…`), so the
sweeper reads an expiry with a `HEAD`, not a `GET`.

- **Reads and writes**: `get` is one `GET`, `set` one `PUT`. `delete` is a
  `HEAD` and a `DELETE` per key (S3 answers a `DELETE` the same whether or
  not the object existed, and the count needs to know). `clear()` lists the
  namespace's entries and deletes them page by page — not atomic; stamps and
  locks stay.
- **Tags are stamps mode**: `invalidateTags` writes one stamp object per
  tag, whatever the number of entries, and the core's read check does the
  invalidating (eager deletion would cost a listing plus requests per key).
- **Counters and locks need conditional writes** — `If-None-Match: *` (create
  only) and `If-Match: <etag>` (compare-and-swap) — which S3 has (AWS since
  2024) and Bun's client cannot send yet
  ([oven-sh/bun#17339](https://github.com/oven-sh/bun/issues/17339)), so the
  driver signs those requests itself (SigV4, `fetch`). `increment` is a
  compare-and-swap on the counter's object; calls on one key in one process
  join a batch, so 200 concurrent increments cost a few writes. A lock is
  read first (a live lock held by someone else costs one `GET`), created with
  `If-None-Match: *`, refreshed by its owner or taken over from a holder whose
  expiry has passed with `If-Match`, and released by a conditional `DELETE`.
  Before the first of these the driver checks the store answers a repeated
  create-only `PUT` with 412, and throws otherwise.
  - **Which stores**: AWS S3 and S3 Express, Cloudflare R2, MinIO, Ceph RGW,
    Tigris and SeaweedFS document or honour both conditions; Backblaze B2
    rejects them, and Google Cloud Storage's XML API needs other headers. On
    such a store pass `conditionalWrites: false`: `increment` is then
    unsupported and `getOrSet` loads without a cross-process lock. R2 and GCS
    accept one write per second per key, which a busy counter exceeds. A
    release is a conditional `DELETE`, which MinIO ignores and R2 does not
    list: there, a holder releasing after its lock lapsed and was taken over
    deletes the new holder's lock. Tigris's global buckets are eventually
    consistent, so two processes can both take a lock there.
  - **SeaweedFS** serialises concurrent conditional writes to one object:
    each loser answers only after waiting about a second longer than the one
    before, while one at a time they take a millisecond. The driver's
    batching and its per-key lock queue keep a process's own calls from
    contending; two processes on one hot lock still pay it.
  - Lock expiry compares the holders' clocks: keep them in sync (NTP).
- **Expiry**: lazy on read (an expired entry is a miss, and its object is
  deleted in the background), plus the core's sweeper: it walks the prefix
  and deletes expired entries, counters, stamps and locks, each only if
  unchanged since it was judged. It `HEAD`s an object once and remembers its
  expiry while the listing shows it unchanged (up to 100,000 objects), so a
  pass over a quiet bucket costs its listing pages. Give each cache's objects
  a prefix of their own: the sweeper walks everything under it.
- **Caps**: `maxEntries` and `maxBytes` evict the oldest writes first, enforced
  by the sweeper (so the bucket can briefly exceed them); counters are never
  counted or evicted. Age order, not LRU — recording each read would cost a
  write per read.
- **A lifecycle rule is the backstop**, for objects no sweeper reaches (no
  cache running, a prefix abandoned). It expires by age, so make it longer
  than your longest TTL and than `tagStampTtl` (at most 24 h), or it deletes
  live entries and stamps:

  ```json
  { "Rules": [{ "ID": "bun-cache-backstop", "Status": "Enabled",
                "Filter": { "Prefix": "bun-cache/" }, "Expiration": { "Days": 7 } }] }
  ```

  (`aws s3api put-bucket-lifecycle-configuration --bucket <b>
  --lifecycle-configuration file://rule.json`; rules work in whole days.)
- **Connections**: `url`, `connection` (Bun's `S3Options`, passed to the
  client as given; `url` wins over its fields), or `client` (Bun's client
  does not expose its credentials, so the signed requests still need `url`
  or `connection`, or the `S3_*`/`AWS_*` environment; without them
  `conditionalWrites` defaults to `false`). There is nothing to close.
  Region: given, else from the environment, else as Bun's client picks it
  (`auto` for a custom endpoint, the AWS endpoint's own, else `us-east-1`).
- **Consistency**: AWS S3 is strongly consistent for reads, writes and
  listings; other stores differ, so check your store's guarantees. The
  driver is tested against SeaweedFS. An entry holds up to 5 GiB less a MiB
  (one `PUT`); the core's `maxEntryBytes` (4 MiB) applies first.

## The Azure Blob Storage driver

```ts
import { azureBlobDriver, createCache } from "@kingsleyweb/bun-cache";

const cache = createCache({
  driver: azureBlobDriver({ url: process.env.CACHE_AZURE_URL }),
  // azure://<accountName>:<accountKey>@<host>[:<port>][/<path>]/<container>[?scheme=http]
  // e.g. azure://myacct:KEY%3D%3D@myacct.blob.core.windows.net/cache — percent-encode the key's /, + and =
});
// or azureBlobDriver({ connection: { connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING, container: "cache" } })
// or azureBlobDriver({ connection: { accountName, accountKey, container, endpoint? } })
// or a SAS, or Microsoft Entra ID: see "Authorization" below
```

A blob container every process and host can reach, over `fetch`: Bun has no
Azure client, and the driver authorizes its own requests — Shared Key, a SAS
or a Microsoft Entra ID token ([below](#authorization)) — rather than take
the Azure SDK. Like S3, it suits large values,
long TTLs and few reads per key — every read is a billed operation — so for
hot small keys put an [L1](#multi-tier) in front of it, with a bus of its own
(`bus: redisBus(url)` or `pgBus(url)`; Azure Blob Storage has none).

The layout, the frame and the types are [the S3 driver's](#the-s3-driver):
one block blob per entry or counter (`<p>/<ns>/e/<hh>/<sha256(key)>`), stamp
and lock blobs beside them, and each blob's `Content-Type` carrying its kind,
expiry and write time (`application/x-bun-cache; exp=…; at=…`). Azure keeps
those parameters and returns them in List Blobs, so the sweeper learns every
blob's expiry from the listing alone.

- **Reads and writes**: `get` is one Get Blob, `set` one Put Blob, `delete`
  one Delete Blob per key (Azure answers 202 or 404, so the count needs
  nothing more). `clear()` lists the namespace's entries and deletes them page
  by page — not atomic; stamps and locks stay.
- **Tags are stamps mode**, as on S3: one stamp blob per invalidated tag, a
  stamp only ever moves forward, and the core's read check does the
  invalidating.
- **Counters and locks are compare-and-swaps on conditional writes**, which
  Azure's API has always had: create with `If-None-Match: *` (a lost race
  answers 409 `BlobAlreadyExists`), replace or delete with `If-Match: <etag>`
  (412). `increment` batches one key's calls in a process into one write; a
  lock is read first (a live lock held by someone else costs one Get Blob),
  created with `If-None-Match: *`, refreshed by its owner or taken over from a
  holder whose expiry has passed with `If-Match`, and released by a
  conditional Delete Blob. Lock expiry compares the holders' clocks: keep
  them in sync (NTP).
  - **Not Lease Blob**, Azure's own lock: a lease lasts 15 to 60 seconds or
    for ever, and a cache lock's TTL is anything from a second up, so a
    holder that died would keep a one-second lock for fifteen, and one longer
    than a minute cannot be expressed without a renewer. (Leases are judged by
    the server's clock, which is their one advantage.)
- **Expiry**: lazy on read (an expired entry is a miss, and its blob is
  deleted in the background, only if it is still the blob that was read), plus
  the core's sweeper: it pages through the prefix (5,000 blobs a listing) and
  deletes expired entries, counters, stamps and locks, each with `If-Match`
  on the ETag the listing gave, so a blob rewritten meanwhile stays. Give each
  cache's blobs a prefix of their own: the sweeper walks everything under it.
- **Caps**: `maxEntries` and `maxBytes` evict the oldest writes first, enforced
  by the sweeper (so the container can briefly exceed them); counters are
  never counted or evicted. Age order, not LRU.
- **A lifecycle management rule is the backstop**, for blobs no sweeper
  reaches. It deletes by age, so make it longer than your longest TTL and
  than `tagStampTtl` (at most 24 h):

  ```json
  { "rules": [{ "enabled": true, "name": "bun-cache-backstop", "type": "Lifecycle",
      "definition": { "filters": { "blobTypes": ["blockBlob"], "prefixMatch": ["cache/bun-cache/"] },
                      "actions": { "baseBlob": { "delete": { "daysAfterModificationGreaterThan": 7 } } } } }] }
  ```

  (`az storage account management-policy create --account-name <a>
  --resource-group <g> --policy @rule.json`; `prefixMatch` starts with the
  container's name.)
- **Soft delete and versioning** keep what the cache deletes, billed, for
  their retention: turn them off for a cache's account or container, or
  expect deleted entries to linger there.
- **Connections**: `url`; or `connection` with Azure's `connectionString`
  (the portal's `DefaultEndpointsProtocol=…;AccountName=…;AccountKey=…`, or
  `BlobEndpoint=…` with an `AccountKey` or a `SharedAccessSignature`, or
  `UseDevelopmentStorage=true` for a local Azurite) and a `container`, or
  with the fields — `endpoint` (default
  `https://<accountName>.blob.core.windows.net`), `container`, and one way to
  authorize ([below](#authorization)); the URL wins over the fields, which
  win over the connection string, field by field. The container must exist
  (the driver never creates one); `connect()` names it when it is missing.
  There is nothing to close.
- **No retries of its own**: a throttled request (503 `ServerBusy`) fails, and
  the cache's [failure policy](#the-failure-policy) takes over. A conditional
  write is never retried blindly, since one that landed but whose answer was
  lost would be applied twice.
- **Tested against Azurite**, the Azure Storage emulator, which checks the
  signatures (Shared Key and SAS, with a SAS's permissions), honours every
  condition the driver uses and, over HTTPS with `--oauth basic`, takes
  bearer tokens (below). **It has not been run against real Azure**, so
  check it against your account before relying on it. An entry holds up to
  5000 MiB less a MiB (one Put Blob); the core's `maxEntryBytes` (4 MiB)
  applies first.

### Authorization

Exactly one way per driver — an account key, a SAS, a `credential` or a
`token`, wherever each comes from (the url, the fields or the connection
string). Two are a `TypeError` naming both and where each came from (the
same one twice is not: the url's key wins over a field's), and none is one
too.

**Shared Key** — the account key; every request is signed with it (above).

**A SAS** (shared access signature) — no account key, and nothing signed:
the SAS's query is appended to every request.

```ts
// In the url: the SAS is the query (every parameter but scheme), with no key.
azureBlobDriver({ url: "azure://myacct.blob.core.windows.net/cache?sv=2022-11-02&ss=b&srt=co&sp=rwdl&se=2027-01-01T00%3A00%3A00Z&spr=https&sig=…" });
// As a field (a leading ? is dropped), or in Azure's SAS connection string.
azureBlobDriver({ connection: { endpoint: "https://myacct.blob.core.windows.net", container: "cache", sasToken: process.env.AZURE_STORAGE_SAS } });
azureBlobDriver({ connection: { connectionString: "BlobEndpoint=https://myacct.blob.core.windows.net;SharedAccessSignature=sv=…&sig=…", container: "cache" } });
```

- **Permissions**: read, write, delete and list — `sp=rwdl`; an account SAS
  also `ss=b` (the Blob service) and `srt=co` (List Blobs is a container
  operation, the rest are object ones). For an account SAS and a container
  SAS (`sr=c`) alike: without `l` connecting fails (and
  the sweeper and `clear()`); without `r`, `get`; without `w`, `set` — `c`
  (create) alone writes a new blob but cannot replace one, and the driver
  replaces blobs — and without `d`, `delete`. Each fails with 403
  `AuthorizationPermissionMismatch`, and the error says what the SAS must
  grant. `a`, `c`, and the others are not needed.
- **The SAS is kept exactly as given** (still percent-encoded: its `sig` is
  base64, and a `+` is not a `%2B`). The driver never renews one: when it
  passes its `se`, every request fails with 403. Give the SAS a lifetime
  longer than the process, or rebuild the driver with a new one. A SAS with
  `spr=https` refuses `http` (an emulator).

**Microsoft Entra ID** — a bearer token on every request
(`Authorization: Bearer …`, with `x-ms-version` 2025-01-05; Azure needs
2017-11-09 or later for one). Azure takes bearer tokens over HTTPS only, and
the identity needs a data role on the container, such as Storage Blob Data
Contributor (a 403 `AuthorizationPermissionMismatch` says so). The url
carries no key.

```ts
import { DefaultAzureCredential } from "@azure/identity"; // yours: bun-cache does not depend on it

// A credential: anything with getToken(scopes), @azure/core-auth's TokenCredential.
azureBlobDriver({
  url: "azure://myacct.blob.core.windows.net/cache",
  connection: { credential: new DefaultAzureCredential() },
});
// Or a raw token: a string, or a function asked on every request.
azureBlobDriver({
  url: "azure://myacct.blob.core.windows.net/cache",
  connection: { token: async () => await myTokenCache.get() },
});
```

- **`credential`** (`AzureTokenCredential`): asked for
  `https://storage.azure.com/.default`. Its token is cached until 5 minutes
  before its `expiresOnTimestamp` (half its life for a token living under 10
  minutes; earlier if it gives a `refreshAfterTimestamp`), and one `getToken`
  runs at a time, however many requests are waiting for it. When a refresh
  fails while the cached token is still valid, the cached one is used and
  the next request tries again.
- **`token`**: a string is sent as is and never renewed; a function (or
  async function) is asked **on every request**, so its caching and refresh
  are the application's — keep it cheap.
- **A refused token is renewed once.** On a 401 (or the 403
  `AuthenticationFailed` Azurite answers), the driver asks again — the
  credential, or the token function — and resends the request once if it
  gets a different token; a refusal means nothing was applied, so the resend
  cannot write twice. Otherwise the error stands, naming the refusal.
  Several requests refused together share one `getToken`.

**Trying Entra ID locally**: Azurite takes bearer tokens only over HTTPS and
with `--oauth basic`, which checks a token's `aud`
(`https://storage.azure.com`), `iss` (under `https://sts.windows.net/`) and
`iat`/`nbf`/`exp` but not its signature. Run it with a certificate, create
the blob container (Shared Key still works there), and give the driver an
`https` endpoint; the process has to trust the certificate.

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem -out certs/cert.pem -days 30 \
  -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"
docker create --name azurite-oauth -p 127.0.0.1:10100:10000 mcr.microsoft.com/azure-storage/azurite:3.37.0 \
  azurite-blob --blobHost 0.0.0.0 --oauth basic --cert /certs/cert.pem --key /certs/key.pem
tar -c certs | docker cp - azurite-oauth:/ && docker start azurite-oauth
```

## The Cloudflare KV driver

```ts
import { cloudflareKvDriver, createCache } from "@kingsleyweb/bun-cache";

// Production: through the bun-cache Worker you deploy (below).
const cache = createCache({
  driver: cloudflareKvDriver({
    endpoint: "https://bun-cache.<you>.workers.dev",
    apiToken: process.env.BUN_CACHE_PROXY_TOKEN, // the Worker's secret
    namespaceId: "CACHE_KV", // the binding's name in wrangler.toml
  }),
});

// Development, CI, light traffic: straight to the REST API.
cloudflareKvDriver({
  accountId: "…", // or CLOUDFLARE_ACCOUNT_ID
  apiToken: "…", // or CLOUDFLARE_API_TOKEN: a token with Workers KV Storage: Edit
  namespaceId: "…", // the namespace's id
});
```

A Workers KV namespace, reached from a Bun process over HTTP — bun-cache
runs in your server, not in a Worker. Two transports, one client, the same
request shapes:

- **The REST API** needs nothing deployed, but Cloudflare allows it **1,200
  requests per five minutes per user or token**, shared with Wrangler and the
  dashboard, and blocks the token for five minutes past that. That is four
  cache operations a second. The client paces itself under the budget so
  this process never trips it alone (it queues instead), and fails at once,
  without sending, while a block lasts.
- **The bun-cache Worker** has no such cap: it reads and writes through its
  KV binding. **Use it in production.** It is part of this package:

  ```ts
  // src/index.ts of a Worker project
  export { default } from "@kingsleyweb/bun-cache/cloudflare-worker";
  ```

  ```toml
  # wrangler.toml
  name = "bun-cache"
  main = "src/index.ts"
  compatibility_date = "2026-07-01"
  kv_namespaces = [{ binding = "CACHE_KV", id = "<namespace id>" }]
  d1_databases = [{ binding = "CACHE_DB", database_name = "cache", database_id = "<database id>" }]
  ```

  Then `wrangler secret put BUN_CACHE_PROXY_TOKEN` and `wrangler deploy`.
  The Worker answers only requests carrying that secret as a bearer token
  (with no secret set it refuses everything), and only for its KV and D1
  bindings, named in the path. The driver's `apiToken` is then the secret,
  given explicitly: `CLOUDFLARE_API_TOKEN` is never sent to a Worker URL. An
  `endpoint` must be `https:` (`http:` only to a loopback host).

```
<p>/<ns>/e/<sha256(key)>   an entry: a header (expiry, tags) and the bytes
<p>/<ns>/s/<sha256(tag)>   a tag's invalidation stamp
```

`<p>` is the prefix (`prefix`, `bun-cache` by default), `<ns>` the namespace
encoded so it never adds a `/`; keys are hashed, so none passes KV's 512
bytes.

- **Expiry is KV's own**, with every write's `expiration_ttl`, which KV
  refuses under **60 s**. A shorter TTL is still exact: the entry's header
  holds its expiry, every read checks it, and KV reclaims the key up to a
  minute later. No sweeper runs.
- **Reads and writes**: `get` is one `GET` of the raw bytes, `getMany`
  parallel `GET`s (KV's bulk read refuses binary values), `setMany` one bulk
  write per 10,000 entries. `delete` reads each key first (KV answers a
  delete alike either way, and the count needs to know), then one bulk
  delete. `clear()` lists the namespace's entries and deletes them — not
  atomic; stamps stay.
- **Tags are stamps mode**: `invalidateTags` writes one stamp per tag, and
  the core's read check does the invalidating. KV has no compare-and-swap,
  so a stamp is read and written forward (the later time kept), which
  narrows but cannot close the window where two invalidations of one tag
  from two places land out of order.
- **No counters, no locks, no bus.** KV has neither an atomic increment nor
  a conditional write: `increment` throws `UnsupportedOperationError`, and
  `getOrSet`'s `lock` logs one warning and keeps the in-process
  single-flight, so a stampede across processes is bounded by their number.
  An [L1](#multi-tier) needs a bus of its own (`redisBus` / `pgBus`).
- **KV is eventually consistent.** A write, a delete or an invalidation is
  usually seen at once where it was made, and may take **a minute or more**
  elsewhere (a reader that saw the old value, or no value, recently waits
  longest); the stamp cache (`tagStampCacheMs`) adds its own second. Use it
  where serving a value a minute stale is acceptable. Through the REST API
  a deleted key has been seen served for most of a minute, where through
  the Worker a delete or an overwrite usually shows within a second — one
  more reason to use the Worker.
- **One write per second per key.** KV answers 429 to a second write to a key
  within a second; the client waits out `Retry-After` and retries, up to six
  attempts, so a hot key refreshed from many processes costs latency, not
  errors.
- **Limits and cost**: 25 MiB per value (the driver's `maxEntryBytes` is
  24 MiB, leaving room for the header; the core's own 4 MiB applies first);
  the free plan allows 100,000 reads and 1,000 writes a day.
- **Local development** needs no account: run the shipped Worker in
  workerd, through [miniflare](https://www.npmjs.com/package/miniflare) or
  `wrangler dev`, with a local KV binding, and point `endpoint` at it. Local
  KV is one store — it is never eventually consistent — and it does not
  limit writes per key, so check what your app relies on against
  Cloudflare's KV. Through the REST API, a read right after a delete can
  answer the old value for up to a minute.

## The Cloudflare D1 driver

```ts
import { cloudflareD1Driver, createCache } from "@kingsleyweb/bun-cache";

// Production: through the bun-cache Worker (see the KV driver's section).
const cache = createCache({
  driver: cloudflareD1Driver({
    endpoint: "https://bun-cache.<you>.workers.dev",
    apiToken: process.env.BUN_CACHE_PROXY_TOKEN, // the Worker's secret
    databaseId: "CACHE_DB", // the binding's name in wrangler.toml
  }),
});

// Development, CI, light traffic: straight to the REST API.
cloudflareD1Driver({
  accountId: "…", // or CLOUDFLARE_ACCOUNT_ID
  apiToken: "…", // or CLOUDFLARE_API_TOKEN: a token with D1: Edit
  databaseId: "…", // the database's id
});
```

A D1 database, reached from a Bun process over HTTP, by the same two
transports as [the KV driver](#the-cloudflare-kv-driver): the REST API
(nothing to deploy, **1,200 requests per five minutes per token**) or the
bun-cache Worker with the database bound (`d1_databases` in its
`wrangler.toml`; no such cap — **use it in production**).

D1 is SQLite in a Durable Object, so this is [the SQLite
driver](#the-sqlite-driver)'s design — its tables (`<prefix>entries`,
`tags`, `stamps`, `locks`; no bus table), a tag index with an atomic fence,
counters as a `RETURNING` upsert, locks as one conditional upsert, expiry
filtered on read and reclaimed by the sweeper — with what HTTP changes:

- **Every write is one statement.** D1 refuses `BEGIN`, so no write relies on
  a transaction. **Triggers** keep the tag index (it follows each entry's
  tags on insert, update and delete) and make a stamp an invalidation (writing
  one deletes its tag's entries, in the same statement). The fence is the
  write's own `WHERE NOT EXISTS`. D1 runs one statement at a time, so a
  fenced write and an invalidation are ordered whole: a write of a load that
  started before an invalidation never survives it.
- **Values travel as hex** (`unhex(?)`, `hex(v)`). D1 caps a string at
  2,000,000 bytes, so an entry holds at most **1,000,000 bytes**
  (`maxEntryBytes`, below the core's 4 MiB default); a larger one is refused
  with `EntryTooLargeError` before anything is sent.
- **Parameters are strings** (the REST API's rule), which SQLite's type
  affinity stores and compares as numbers.
- **Requests**: `get` is one; `getMany` one per ten keys; `set` one;
  `setMany` and its fenced form one per 50 entries; `delete` one; `invalidateTags` one (its
  count read just before the invalidation, in the same request); `clear`
  one; `sweep` one or two.
- **No bus** (`bus: "none"`): a polled table over the REST API would spend
  the token's budget, and every poll's rows read are billed. An
  [L1](#multi-tier) takes `redisBus` / `pgBus`.
- **Options**: `prefix` (an SQL identifier, `bun_cache_` by default),
  `tables` (exact names, as the SQL drivers take them; no `bus`),
  `maxEntries` (enforced by the sweep, nearest to expiry first, then the
  oldest unexpiring; counters never), `syncSchema` (a no-op until the schema
  first changes). The tables, indexes and triggers are created on first use,
  each `IF NOT EXISTS`.
- **Cost**: D1 bills rows read and written; the triggers add the tag rows'
  writes to each tagged `set` and invalidation.
- **Local development** works as for KV: the shipped Worker in workerd
  (miniflare or `wrangler dev`) with a local D1 binding, no account needed.

## HTTP response caching

```ts
import { cacheControl, compression } from "@kingsleyweb/bun-common";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { addCacheTags, cacheResponse } from "@kingsleyweb/bun-cache/http";

const cache = createCache({ driver: memoryDriver(), namespace: "http" });
const pages = cacheResponse(cache, { ttl: 60_000 });

app.use(compression());                           // before the cache: hits are compressed too
app.get("/posts/:id", pages, validate({ params: PostParams }), async (req, res) => {
  addCacheTags(res, `post:${req.params.id}`);
  res.json(await loadPost(req.params.id));
});
app.use("/blog", cacheResponse(cache));           // a subtree; TTL from Cache-Control
// TTL from the header cacheControl() sets: after the cache, because headers
// set by a middleware ahead of the cache are never stored.
app.get("/feed", cacheResponse(cache), cacheControl({ sMaxAge: 60 }), feed);

await cache.invalidateTags(["post:7"]);           // after an edit
await pages.invalidate("/posts/7");               // or one path, every query and variant
```

`cacheResponse(cache, options)` is ordinary `(req, res, next)` middleware for
bun-common's `BunRouter`, so it works on both HTTP adapters. A **hit** answers
from the cache and does **not** call `next()`; a **miss** runs the rest of the
pipeline and stores what it produced, when it may.

**Where to put it.** Before `validate()` — between `validate()` and the
handler it takes the validator's typed slot and the handler's validated
`req.query`/`req.body` types are lost — and after anything that must run on
every request (authentication, rate limits, request ids): a hit runs nothing
behind it. Put `compression()` **ahead** of it: misses are captured
uncompressed and hits are compressed per request. In Nest, guards and
interceptors do not run before router middleware, so use bun-nest's
[`BunCacheInterceptor`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-nest/README.md#the-cache-interceptor)
for anything behind a guard.

**The cache.** Pass an untyped cache (`createCache()` with no schema) with a
codec that keeps bytes — `"structured"`, the default, or `"raw"`: a response
is stored as one framed `Uint8Array`. A JSON cache is refused by the types,
and if forced, every request is a miss (never a broken answer). A namespace
of its own (`namespace: "http"`) keeps it apart: an unsafe request's
invalidation forgets the in-flight loads of the whole namespace.

**The key** is `GET` (HEAD shares GET's entry), the host with `host: true`,
the path (the full `originalUrl`, mount included), the query sorted by name
(`query: "all"`, a list of names to keep, or `false`), and the `varyBy`
request headers — or your `key(req)` in place of all but `GET`. A response's
own `Vary` is learned per URL: the first answer stores a record naming the
headers (and carries that first variant), and every other combination of
values gets an entry of its own. `Vary: *` is never stored.

**What is stored** (RFC 9111 §3, for a shared cache): only a `GET` whose
status is in `statuses` (by default RFC 9110's heuristically cacheable set:
200, 203, 204, 300, 301, 308, 404, 405, 410, 414, 501) and

- no `no-store` (unless `must-understand`, for a status the cache stores),
  no unqualified `private`, and no unqualified `no-cache` (its reuse needs a
  revalidation this cache does not make); the qualified `private="X"` and
  `no-cache="X"` withhold just those fields;
- for a request with `Authorization`, a `public`, `s-maxage` or
  `must-revalidate` answer, unless the key varies on the identity
  (`varyBy: ["authorization"]`, or a `key` function);
- no `Set-Cookie` from the handler, unless `allowSetCookie`;
- a buffered body, or a stream under `streams: { buffer }` that ends within
  the buffer (`text/event-stream` never; see
  [Stale serving over HTTP](#stale-serving-over-http));
- a lifetime: `ttl` in ms (which overrides the freshness headers, not the
  refusals above), or with `ttl: "headers"` (the default)
  `Surrogate-Control: max-age`, then `s-maxage`, then `max-age`, then
  `Expires` less `Date`, minus the response's own `Age`. With
  `ttl: "headers-or-cache"` the same headers are read, and a response that
  has none is stored under the cache's own TTL (`createCache`'s `ttl`: a
  number, a function of the value, or `null` for no expiry) instead of not
  at all; a header's lifetime still wins, a lifetime of `0` included, and
  every refusal above still applies. Either way, `HIT` or `STALE` is judged
  by the entry's own freshness (what the core decided, `jitter` included),
  on a coalesced follower's answer too.

Never stored: hop-by-hop fields, `Content-Length`, `Age`, the status header,
`omitHeaders`, and any header a middleware **ahead** of the cache set and the
handler left as it was (a request id, a CORS origin, a session cookie) —
that middleware sets its own on every hit. A response's
`stale-while-revalidate=` and `stale-if-error=` are kept with the entry
(zeroed by `must-revalidate` or `proxy-revalidate`): see
[Stale serving over HTTP](#stale-serving-over-http).

**Hits** get the stored status and headers, `Age` (RFC 9111 §5.1: the
response's own plus its time in the cache), and the body through
`res.send()` — so a matching `If-None-Match` or `If-Modified-Since` gets a
`304`, and every stored response has an `ETag` (computed from the body when
the handler set none; `etag: false` turns that off). A conditional request
that **misses** still produces the full response for the cache (the
handler sees `req.fresh === false`), and is answered `304` from it. The
`X-Cache` header (`statusHeader`, or `false`) says `HIT`, `MISS`, `STALE`
(past its freshness, inside a stale window), `BYPASS` (`bypass(req)`, or a
request's `no-store` under `honorRequest`) or `UNCACHEABLE` (answered, not
stored).

**HEAD** is answered from the GET entry, without a body; a HEAD miss runs the
GET handler and stores nothing. A `POST`, `PUT`, `PATCH` or `DELETE` through
the middleware that gets a 2xx or 3xx drops every entry for its path, and
for a same-host `Location` or `Content-Location` (RFC 9111 §4.4;
`invalidateOnUnsafe: false` turns it off); a `GET` in the same process waits
for that invalidation before it reads. Every entry carries its path's tag,
so `pages.invalidate(path | url | request)` drops a path's queries and
variants. Either invalidation also runs a second time, in the background,
once the writes this middleware had in flight for the path have landed (at
most `coalesce.wait`), if one of them stored after it began: an uncoalesced
write, or one whose body is still being read (a stream, a sent file), is
issued after the invalidation and no fence covers it, so without the second
pass it could put back what was just dropped (a write that landed before it
began, or that a fence refused, needs none, and gets none); the `tags` option (a list, or `(req, res) => tags`) and
`addCacheTags(res, ...tags)` from the handler add more for
`cache.invalidateTags()`.

**Coalescing** (`coalesce`, on by default). Identical misses run the handler
once: the first leads, and the rest wait — through the core's single-flight,
so the write gets the core's tag fence too (an invalidation that lands while
the handler runs drops the write instead of storing a stale answer). A
follower waits at most `coalesce: { wait }` (10 s by default) and then runs
the handler itself; a leader whose answer bypasses the response transforms
— an unhandled error, the adapter's bare 404 — holds its followers that
long. When the leader's answer may not be stored (`private`, a cookie, a
5xx…), the key is marked uncacheable for `uncacheableTtl` (30 s; Varnish's
hit-for-miss) and its requests run side by side meanwhile; a storable answer
replaces the mark at once. Requests with `Authorization` (and a key that
does not vary on identity) are never coalesced.

**The request's own `Cache-Control`** is ignored by default, as CDNs do, so
a client cannot push its load onto the origin. `honorRequest: true` honours
`no-store` (bypass), `no-cache`, `Pragma: no-cache` and `max-age=0`
(run the handler and store its answer), `max-age=N`, `min-fresh=N`, and
`only-if-cached` (a `504` on a miss).

**Limits.** An unhandled error and the adapter's bare 404 are answered on a
fresh response, outside the transforms: they are never stored. The write never delays the response, so a request arriving right
after a miss may miss too.

**`coalesceRequests({ key?, wait? })`** is the coalescing alone, with no
store: identical in-flight `GET`s share one run, and each follower gets a
copy of the leader's buffered answer through its own `res.send()`. Requests
with `Cookie` or `Authorization` run on their own unless your `key` includes
the identity, and an answer that sets a cookie or is `private`, `no-store`
or `no-cache` is not shared.

| Option | Default | |
|---|---|---|
| `ttl` | `"headers"` | ms; the freshness headers; or `"headers-or-cache"`, the headers else the cache's TTL |
| `tags` | none | a list, or `(req, res) => tags` |
| `varyBy` | none | request headers in the key |
| `query` | `"all"` | `"all"`, names to keep, or `false` |
| `host` | `false` | the host in the key and the path tag |
| `key` | none | `(req) => string`, replacing host, path, query, `varyBy` |
| `bypass` | none | `(req) => boolean`: no read, no store |
| `statusHeader` | `"X-Cache"` | or `false` |
| `honorRequest` | `false` | the request's `Cache-Control` |
| `allowSetCookie` | `false` | store (and replay) the handler's cookies |
| `statuses` | RFC 9110's set | the statuses stored |
| `omitHeaders` | none | response headers never stored |
| `invalidateOnUnsafe` | `true` | unsafe 2xx/3xx drops the path |
| `coalesce` | `true` | or `false`, or `{ wait }` (10 s) |
| `uncacheableTtl` | 30 s | the hit-for-miss mark; `0` disables |
| `etag` | `true` | compute an `ETag` when there is none |
| `staleWhileRevalidate` | the response's | ms answered `STALE` past freshness while refreshing |
| `staleIfError` | the response's | ms answered `STALE` past freshness when the handler fails |
| `hardTimeout` | none | ms to wait for the handler when a stale-if-error answer exists |
| `revalidate` | none | the router or adapter a refresh replays through |
| `streams` | `"skip"` | or `{ buffer: bytes }`: store streams that end within it |
| `surrogateKeys` | `false` | `"Surrogate-Key"` (Fastly) or `"Cache-Tag"` (Cloudflare): each answer's tags for a CDN |
| `logger` | the console | where the middleware's warnings go (a tag left out of `surrogateKeys`' header) |

### Stale serving over HTTP

```ts
const app = new BunHttpAdapter();
const pages = cacheResponse(cache, {
  revalidate: app,                 // what a refresh replays the request through
  staleIfError: 600_000,           // or the response's stale-if-error=
  hardTimeout: 2_000,              // a slow handler counts as a failure, when a stale answer exists
});
app.get("/posts/:id", pages, async (req, res) => {
  res.setHeader("Cache-Control", "max-age=60, stale-while-revalidate=300");
  res.json(await loadPost(req.params.id));
});
```

An entry past its freshness is kept for the longer of its two windows
(RFC 5861): the route's `staleWhileRevalidate` and `staleIfError` (ms) when
set, the response's `stale-while-revalidate=` and `stale-if-error=`
otherwise, and never under `must-revalidate` or `proxy-revalidate`. A stale
answer carries `X-Cache: STALE` and its `Age`; no `Warning` (RFC 9111 dropped
it).

**Stale-while-revalidate.** Inside the window a request is answered from
the stale entry at once, and **one** background replay refreshes it:

- **The replay** is a `GET` of the same URL through `revalidate.fetch()` —
  the router or adapter you pass, the outermost one, so it routes as the
  request did — with no socket. It carries the host, the `varyBy` headers
  and the response's `Vary` headers, nothing else of the client's request
  (no cookie or credential the key does not vary on, no conditional), and
  an internal `x-bun-cache-revalidate` header: this process's random token
  and the id of a replay the middleware is waiting on. Only a request
  carrying both is a replay; anything else with that header is an ordinary
  request, and an id is used once.
- **One per key**: the replay loads through the core's single-flight, so a
  burst of stale answers starts one, a miss arriving meanwhile waits for it,
  and a replay started while a miss is running joins that miss.
- **Its write is fenced** like a miss's: an invalidation that lands while it
  runs drops it.
- **A replay that fails** — a 5xx, an answer that bypassed the transforms,
  nothing within `coalesce.wait` (or `hardTimeout`, when shorter) — stores
  nothing: the stale entry stays, and the key's next replay waits 10 s. One
  whose answer may no longer be stored (`no-store`, `private`, a cookie…)
  replaces the entry with the hit-for-miss mark, as a miss would.
- **Without `revalidate`**, a stale entry is answered once, and the next
  request for it refreshes it (and waits for the handler).
- **What it costs**: the stale entry is read once more before the
  single-flight on a miss, so `stats()` counts a miss (or a stale hit) per
  read, not per request.
- **The key must be reproducible from those headers.** With a `key`
  function that reads anything else, the replay lands on another key:
  nothing is stored, and the stale entry is answered until its window ends.
- A `HEAD` inside the window is answered stale and refreshed as a `GET`.
  A request whose `Cache-Control` bounds the age it accepts (`max-age`,
  `min-fresh`, `only-if-cached`, `no-cache`, under `honorRequest`) is never
  answered stale.

**Stale-if-error.** Past stale-while-revalidate and inside the
stale-if-error window, a request runs the handler as a miss, holding on to
the stale entry: when the pipeline answers a **5xx** (an error handler's
answer counts), the stale response goes out instead, `STALE`, with the
headers middleware ahead of the cache set, and the entry is kept; coalesced
followers get it too. With **`hardTimeout`**, a handler that has not
answered in time is answered stale the same way, and its late answer is
dropped (bun-common sends nothing once a response went out) and not stored.
An unhandled error is answered by the adapter outside the pipeline and
cannot be rescued. Without a stale entry, a 5xx goes through and
`hardTimeout` does nothing.

**After a soft purge** (`cache.invalidateTags(tags, { mode: "stale" })`,
[Soft purge](#soft-purge-mode-stale)) the stored responses carrying the tags
are past their freshness from the purge on, so they are answered `STALE`
inside the windows above — counted from the purge — and refreshed by the
replay, or answered in place of a 5xx; with neither window, the next request
is a `MISS`. A route's own tag (`tags`, `addCacheTags()`, the path's tag) is
what the purge names. The cache needs `softPurge: true` for it.

**Streams.** By default (`streams: "skip"`) a streamed answer is sent and
not stored. With `streams: { buffer: maxBytes }` its body is swapped for a
pull-through copy: each chunk goes to the client as it arrives (the first
byte is not held back), the client's reads drive the handler's stream and
its disconnect cancels it, and the copy is stored once the stream ends
within `maxBytes` (and the cache's `maxEntryBytes`). A stream that outgrows
the buffer is sent whole and not stored; with coalescing (the default) its
key is marked uncacheable (hit-for-miss) as soon as the copy outgrows the
buffer. One that fails or whose client leaves is not stored.
`text/event-stream` is never stored. The stream's **end reaches the client
only once what was decided is written** — the entry, or the mark (at most
`coalesce.wait`) — so a request that arrives after the client saw the end
finds it. A buffered stream's `X-Cache` is `MISS`: it goes out with the
first byte, before the size is known — also under the mark, where the
stream is still copied and replaces the mark if it fits, as any storable
answer does. Coalesced followers wait for the stream to end. The copy is not a
`tee()`: a tee's second branch keeps pulling, so a slow client stops
back-pressuring the handler and a client that leaves no longer stops it.

### CDN tags (surrogate keys)

```ts
const pages = cacheResponse(cache, {
  ttl: 60_000,
  surrogateKeys: "Surrogate-Key",  // Fastly; "Cache-Tag" for Cloudflare
});
app.get("/posts/:id", pages, async (req, res) => {
  addCacheTags(res, `post:${req.params.id}`);
  res.setHeader("Cache-Control", "s-maxage=300");    // what the CDN keeps it for
  res.json(await loadPost(req.params.id));
});
// GET /posts/7 → Surrogate-Key: http:path:/posts/7 post:7
```

With `surrogateKeys`, every answer carries its entry's tags in the header a
CDN in front purges by, so the CDN can drop a response by the same tags
`cache.invalidateTags()` takes. The tags are the path's own
(`http:path:<path>`, the one unsafe methods and `pages.invalidate()` drop),
the route's `tags` and `addCacheTags()`'s, in plain text. `false`, the
default, sends nothing.

| Header | CDN | Format | Limits |
|---|---|---|---|
| `Surrogate-Key` | Fastly | space-separated, case sensitive, no duplicates | a key 1 KB, the header 16 KB; past a limit Fastly ignores that key and every key after it |
| `Cache-Tag` | Cloudflare | comma-separated, case insensitive, printable ASCII, no spaces | the header 16 KB after its name (about 1,000 tags); a purge call takes tags of at most 1,024 characters |

Sources: Fastly's [working with surrogate
keys](https://www.fastly.com/documentation/guides/full-site-delivery/purging/working-with-surrogate-keys/)
and [purging API](https://www.fastly.com/documentation/reference/api/purging/);
Cloudflare's [purge by cache-tags](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-tags/)
and [purge cache](https://developers.cloudflare.com/cache/how-to/purge-cache/)
(the limits as documented in October 2026; check them for your plan).

- **Which answers.** Every `GET` and `HEAD` through the middleware: `MISS`,
  `HIT`, `STALE` (stale-while-revalidate, and the stale answer to a 5xx or a
  `hardTimeout`), `UNCACHEABLE` (this cache refused it; a CDN may still keep
  it), a coalesced follower's, a `304` (RFC 9111 §4.3.4: a CDN revalidating
  its copy takes the 304's headers, so a 304 without the tags could strip
  them), a `HEAD` hit and a `HEAD` miss. Not `BYPASS`. The CDN reads the
  header on the response it stores — usually a `MISS` or `HIT` from the
  origin's side.
- **Merging.** A header the handler (or a middleware ahead) already set is
  kept first, as written; the entry's tags follow, de-duplicated —
  case-insensitively for `Cache-Tag`, as Cloudflare compares them. Set it
  once: two lines are joined with a comma, which `Surrogate-Key` reads as
  part of a key. The other CDN's header is left alone.
- **Tags that break the format** are left out of the header, never the
  entry (the cache still invalidates by them), with one `logger` warning
  per tag: a tag holding the separator (a space for `Surrogate-Key`, a
  comma for `Cache-Tag`), any character outside visible ASCII (`!` to `~`:
  whitespace, control characters, non-ASCII — percent-encode such tags
  yourself, the same way where you purge), one longer than 1,000 bytes,
  and any that would take the header past 16,000 bytes (the smaller reading
  of both CDNs' "1 KB" and "16 KB"; smaller tags after it still go in). They
  are not encoded or cut: either would change the name a purge has to use.
  A request never fails over one; but a CDN cannot purge that response by
  it, so keep tags short and plain.
- **Privacy: the tags reach the client unless the CDN removes the header.**
  Fastly removes `Surrogate-Key` before delivering a response (unless the
  request sends `Fastly-Debug`); Cloudflare removes `Cache-Tag` (its
  visitors and Workers never see it). Without such a CDN in front — or with
  the header on the wrong CDN, or a client reaching the origin directly —
  every client sees every tag. Do not put identities or secrets in tags of
  a route that sends them.
- **Under `encrypt.hashNames`** the header still carries the tags in plain
  text: they are the names your purge calls send, and the `invalidate` event
  names them so. The store holds them only sealed (inside the encrypted
  entry, and hashed in the tag index), but the CDN — and any client, without
  the stripping above — sees them.
- **Two CDN details.** CDN tags are not namespaced: a purge of `post:7`
  drops every response at the CDN carrying it, whichever cache stored it.
  Cloudflare's tags are case insensitive, so its purge of
  `http:path:/About` also drops `/about`'s responses (more is purged, never
  less). An entry stored before `surrogateKeys` was turned on carries the
  tags the core stored with it.

**Purging the CDN by the same tags.** The cache emits `invalidate`, with the
tags in plain text, in the process that called `invalidateTags()` (an
unsafe method's invalidation and `pages.invalidate()` included; not in the
processes that only hear of it over the bus), so one listener purges each
invalidation once. One case emits twice, on purpose: when
`pages.invalidate()` or an unsafe method lands while a `GET` of the path is
still writing its answer (a streamed body is written at its end), and that
write stores after the invalidation began, the path is invalidated again
once it has, and `invalidate` fires again. The CDN may have taken that same
answer, so the second purge is wanted too. A write that had already landed,
or that the invalidation refused, causes no second pass.

```ts
// Fastly: POST /service/{id}/purge, up to 256 keys a call. A soft purge
// (`invalidateTags(tags, { mode: "stale" })`) soft-purges the CDN too: it
// marks its copies stale instead of dropping them.
cache.on("invalidate", ({ tags, mode }) => {
  void fetch(`https://api.fastly.com/service/${FASTLY_SERVICE_ID}/purge`, {
    method: "POST",
    headers: {
      "Fastly-Key": FASTLY_API_TOKEN,
      "Content-Type": "application/json",
      ...(mode === "stale" ? { "Fastly-Soft-Purge": "1" } : {}),
    },
    body: JSON.stringify({ surrogate_keys: tags }),
  }).catch((error: unknown) => logger.error("CDN purge failed", { error }));
});

// Cloudflare: POST /zones/{zone_id}/purge_cache; a token with Cache Purge.
// Cloudflare has no soft purge: a `mode: "stale"` invalidation is a hard
// purge there (the CDN drops its copies; the cache's stay, stale).
cache.on("invalidate", ({ tags }) => {
  void fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tags }),
  }).catch((error: unknown) => logger.error("CDN purge failed", { error }));
});
```

Split a long list into calls the CDN accepts (Fastly's 256 keys; Cloudflare
lists 100 operations a request, and its tag purges are rate limited per
plan, from 5 a minute on Free), and retry a failed one: the listener runs
after the cache's own invalidation, and a lost purge leaves the CDN serving
the old response until its own TTL. `cache.clear()` and `delete()` are not
tag invalidations and emit no `invalidate`. A Cloudflare `200` means the
purge was accepted, not done. bun-cache ships no CDN client.

## Keyv and `@nestjs/cache-manager`

`@kingsleyweb/bun-cache/keyv` turns a cache into a
[Keyv](https://github.com/jaredwray/keyv) store, for an app already on
`@nestjs/cache-manager` or cache-manager, whose only storage seam is a Keyv
store. A new Nest app is better served by bun-nest's
[`BunCacheModule`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-nest/README.md#the-cache-module),
which keeps everything below that Keyv loses.

```ts
import { CacheModule } from "@nestjs/cache-manager";
import { createCache, postgresDriver } from "@kingsleyweb/bun-cache";
import { toKeyvStore } from "@kingsleyweb/bun-cache/keyv";

@Module({
  imports: [
    CacheModule.register({
      stores: [toKeyvStore(createCache({ driver: postgresDriver({ url }) }))],
      ttl: 60_000,
    }),
  ],
})
export class AppModule {}
```

`@nestjs/cache-manager` wraps the store in `new Keyv({ store, ttl,
namespace })`, and `CACHE_MANAGER` is cache-manager's `Cache` over it. The
same store goes to `new Keyv({ store })` or to cache-manager's
`createCache({ stores: [keyv] })` directly. It is structural: this package
has no Keyv dependency, and installing Keyv is the app's.

**Pin `keyv@5.6.0`, exactly.** cache-manager 7.2.9 (the current one)
depends on `keyv ^5.6.0` and breaks under Keyv 6.1.0: `wrap()` runs the loader on
every call where Keyv 5 runs it once (three concurrent calls, then a fourth:
two runs), and `ttl()` answers `undefined` instead of the entry's absolute
expiry. The store itself works under both majors; it is cache-manager that
does not. In `package.json`:

```json
{ "dependencies": { "keyv": "5.6.0", "cache-manager": "7.2.9", "@nestjs/cache-manager": "12.0.1" } }
```

**Pin the whole family exactly, and check the lock.** On 2026-08-04
poisoned releases of ten packages in this family were published, each adding
a `preinstall` script — `keyv@6.0.0`, `cacheable@2.5.1` and
`cache-manager@7.2.10` among them — and have since been removed from npm
([jaredwray/cacheable#1692](https://github.com/jaredwray/cacheable/issues/1692)).
A caret range would have taken them. Pin exact versions, commit the lock,
install with `--frozen-lockfile`, and leave install scripts untrusted (Bun
runs none outside `trustedDependencies` and its own short default list).

**What a store receives, and what it does with it.**

| | Keyv 5 | Keyv 6 |
|---|---|---|
| How Keyv uses it | directly | directly: the store declares `capabilities.expires`, so no bridge |
| The value | Keyv's JSON envelope as a string, stored with the `"raw"` codec | the same |
| The TTL | relative, in ms | an absolute expiry, in epoch ms |
| The key | prefixed with Keyv's namespace (`keyv:k`), stored as sent | bare |
| The namespace | `"keyv"` by default; none when `@nestjs/cache-manager` passes none | none by default |
| `deleteMany` answers | whether every key was there | a boolean per key |

- **One serialisation.** Keyv has already serialised the value (and
  compressed or encrypted it, if told to), so the store keeps the string's
  UTF-8 bytes under the `"raw"` codec whatever the cache's `codec` is, and
  hands the same string back. With Keyv's serialisation off
  (`serialize: undefined` in Keyv 5, `serialization: false` in Keyv 6) the
  store receives Keyv's envelope object and stores it with the cache's own
  codec — its only encoding, so with the default structured clone a `Date`
  survives. The cache's compression still applies to large entries.
- **Namespaces.** Each Keyv namespace is a namespace view of the cache:
  `"keyv"` stores in `<cache namespace>:keyv`, and a namespace
  `cache.namespace()` would refuse (a space, a colon) in
  `<cache namespace>:_:<its UTF-8 in hex>`. No namespace is the cache's own
  namespace, or `toKeyvStore(cache, { namespace })`'s. Keyv sets
  `store.namespace` when it is built and when you assign
  `keyv.namespace`; the store reads it on every call.
- **`clear()` clears the current namespace and nothing else** — never
  another Keyv namespace, never the backend. With no Keyv namespace it
  clears the cache's own namespace, so give the store a cache of its own,
  or `toKeyvStore(cache, { namespace: "keyv-store" })`.
- **TTLs are Keyv's.** A write Keyv gives no TTL never expires, whatever the
  cache's `ttl` default; the cache's `jitter` and stale windows are not
  applied. A relative TTL of 0 or less, or one that is not finite, is no
  TTL, as Keyv treats it. An absolute expiry already past deletes the key
  (Keyv 6's own bridge does the same).
- **Errors are `error` events, never throws**, as Keyv expects of a store: a
  failed operation answers a miss, `false` or nothing and emits the error,
  which Keyv re-emits on `keyv.on("error")`. The cache's own `error` events
  (a driver failure its default policy turned into a miss) are forwarded
  too, each error once.
- **`disconnect()` closes the cache**, as a Keyv store closes its connection;
  `@nestjs/cache-manager` calls it from its `onModuleDestroy`, as it does for
  every store — before `app.close()` drains the requests still in flight, so
  a request still running then reads misses. Give the store a cache nothing
  else uses.
- **One store per Keyv.** The store learns which Keyv major drives it from
  Keyv itself (Keyv 6 reads `capabilities`), and holds one Keyv namespace at
  a time, as every Keyv store does.

**What is lost through Keyv**: tags (`invalidateTags`); stale-while-revalidate
and stale-if-error (cache-manager's `refreshThreshold` is the nearest thing);
cross-process locks, since cache-manager's `wrap()` is single-flight in one
process only; and the cache's codec, because Keyv's JSON envelope wins, so a
`Date` comes back as its ISO string. `cache.getOrSet` keeps all of them.

**Tested with** the real cache-manager 7.2.9 over Keyv 5.6.0 and 6.1.0, and
`@nestjs/cache-manager` 12.0.1's `CacheModule`, on the memory, SQLite,
Postgres and Redis drivers. None of those libraries is a dependency of this
package.

## Live invalidation across processes

`@kingsleyweb/bun-cache/live` adapts a bun-cache bus to bun-common's live
invalidation (`@kingsleyweb/bun-common/live`), whose subscribers are
otherwise per process: behind three instances, a client hears only what its
own instance publishes.

```ts
import { liveInvalidation } from "@kingsleyweb/bun-common/live";
import { redisBus } from "@kingsleyweb/bun-cache";
import { cacheLiveBus } from "@kingsleyweb/bun-cache/live";

const bus = redisBus({ url: process.env.REDIS_URL, channel: "app:live" });
app.use(liveInvalidation(app, { authorize, bus: cacheLiveBus(bus) }));
```

- **Any bus**: `redisBus()` or `pgBus()`, or any `CacheBus`. The bus stays
  yours: close it at shutdown; closing the live connection never does.
- **The wire**: a live message is an `invalidate-tags` bus message in the
  namespace `"bun-common/live"` (`namespace` changes it; every process must
  agree), its origin `<process>:<n>`. A cache on the same channel acts only
  on its own namespaces, and the live bus ignores every other one, so a
  channel can be shared; a channel of its own keeps them apart all the same.
- **Postgres's 8,000 bytes**: `pgBus` turns a larger message into a `clear`,
  which arrives as a gap: the receivers' clients invalidate everything.
- What a gap is, the ordering and what happens while the bus is down are
  bun-common's: see its README,
  [Live invalidation](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md#live-invalidation-kingsleywebbun-commonlive).

## Throttling

`@kingsleyweb/bun-cache/throttle` is a store for bun-common's
[`throttle()`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md#throttling):
the counts live in the cache's backend, so one limit holds across every
process that shares it. bun-common's default store is in memory, per
process: behind three instances, a limit of 100 lets 300 through.

```ts
import { BunRouter } from "@kingsleyweb/bun-common";
import { createCache, redisDriver } from "@kingsleyweb/bun-cache";
import { cacheThrottleStore } from "@kingsleyweb/bun-cache/throttle";

const cache = createCache({ driver: redisDriver({ url: process.env.REDIS_URL }) });
const router = new BunRouter({
  throttle: { limit: 100, window: "1m", store: cacheThrottleStore(cache) },
});
```

- **The backend counts, on Redis, Postgres, MySQL, MariaDB and SQLite.**
  There the store has `countWindow` and `consumeGcra`, and `throttle()` uses
  them: each request is **one round trip** per limit (a Lua script on Redis,
  one statement on Postgres, one multi-statement query on MySQL and MariaDB,
  one `BEGIN IMMEDIATE` transaction on SQLite), which adds to the current
  window's counter, reads the previous one's and reads the time, together.
  **GCRA** (`algorithm: "gcra"`) runs there too, across processes: the
  bucket's arrival time is read, judged and written in that one step. These
  steps go to the driver directly, past the cache's failure policy, circuit
  breaker, events and statistics; a failure is the store's, and
  `throttle()`'s `failMode` decides.
- **Two calls per request elsewhere** (memory, file, MongoDB, D1, S3,
  Azure, `redundant()`, a wrapped driver). The sliding window makes an
  `increment` of the current window's counter and a `get` of the previous
  one's, side by side; the fixed window makes the `increment` alone.
  `increment` is `cache.increment(key, cost, { ttl })`: atomic, and the
  lifetime is set only when the counter is created ([Counters](#counters)).
  `get` reads the driver with `tier: "l2"`: counters never enter an L1 tier,
  so an L1 cannot make a count per-process. GCRA is not offered there: it
  needs a compare-and-set on one value, which a cache counter cannot do
  atomically, so `throttle({ algorithm: "gcra" })` refuses the store at
  construction.
- **Keys.** `throttle()` builds every key whole — its `prefix`, the limit's
  name, the window's length in milliseconds, the scope, the client and the
  window's index — and the store keeps each as it is, in the cache namespace
  `throttle` under the cache's own (`app:throttle` on a cache namespaced
  `app`). `namespace` changes it; processes that share a limit share the
  cache namespace, this `namespace` and `throttle()`'s `prefix`.
- **Failures.** A failed `increment` throws even under the cache's default
  failure policy, and an open circuit throws `CircuitOpenError` at once:
  `throttle()`'s `failMode` decides what the request gets (`"open"`, the
  default, lets it through with a warning at most every 10 s; `"closed"`
  answers `503`). A failed `get` reads as a miss, as every cache read does
  under the default policy (under `strict` it throws too): a request then
  counts its current window alone.
- **Costs are integers.** Redis counts with `HINCRBY` and SQL in a `BIGINT`,
  so the store refuses a fractional `cost` on every driver, the memory one
  included, rather than only in production.
- **Refunds** (`throttle()`'s `skipSuccessfulRequests` and
  `skipFailedRequests`) are a negative cost: subtracted from a counter that
  is still live, never creating one (a GCRA refund moves the bucket's
  arrival time back, never below an empty bucket). On a backend that counts
  by its own clock a refund lands in the window the backend is in when the
  response ends, so a request that straddles a window's edge gives back to
  the new window, not the one it counted in.
- **`delete(key)`** resets one counter (bun-common's `handler.reset`) and
  **`clear()`** empties the store's namespace and nothing else.

**Which drivers can count.** `cacheThrottleStore` refuses, at construction
and with a `ConfigError` naming the driver, a cache whose driver has no
atomic increment: a read-then-write counter lets concurrent requests through
uncounted.

| Driver | Atomic increment | Shares a limit across processes |
|---|---|---|
| memory | yes | no: one process (use bun-common's `memoryThrottleStore()`, which is synchronous) |
| file | yes, under a lock file | processes on one host |
| SQLite | yes | processes on one host |
| Postgres, MySQL, MariaDB | yes | yes |
| Redis | yes (Lua) | yes |
| MongoDB | yes | yes |
| S3, Azure Blob Storage | yes, compare-and-swap, batched per key (a request costs one or more HTTP round trips) | yes |
| Cloudflare D1 | yes | yes |
| Cloudflare KV | **no**: refused | — |
| S3 with `conditionalWrites: false` | **no**: refused | — |
| `fromSimpleDriver` | **no**: refused | — |
| `redundant([...])` | the primary's (refused when the primary has none, or with `counters: "refuse"`) | as its primary; while the primary is down, increments throw and `failMode` decides |

A `Cache` that `createCache` did not make cannot be inspected; it is
accepted, and its own `increment` decides.

**Clocks.** Where the backend counts (above), `clock` decides which clock
places a request in a window:

- **`clock: "store"`, the default:** the backend's own: Redis `TIME`,
  Postgres `clock_timestamp()`, MySQL and MariaDB `UTC_TIMESTAMP(6)` (so the
  session's time zone plays no part), SQLite `julianday('now')` (the host's
  clock, never the driver's `now` option). Every process sharing the store
  agrees on the window, the counters' expiry and a GCRA bucket's time
  whatever its own clock says, so **no process needs NTP**; `throttle()`'s
  `now` is not used for counting. Two processes whose clocks sit either side
  of a window's edge still count into one window, where with each process's
  own clock they would each get a full window.
- **`clock: "process"`:** `throttle()`'s `now`, as everywhere else: what a
  test that drives a fake clock wants. Still one round trip, and GCRA still
  runs across processes. Redis sets the counter's lifetime relative to the
  step's time (`PEXPIRE`), so a process clock that is not the server's
  gives it the life it would have had.

Elsewhere each process puts a request in a window by its own clock
(`throttle()`'s `now`), and a counter's expiry is computed by the process
that creates it, from the cache's clock (`createCache`'s `now`), so processes
sharing the store need synchronised clocks (NTP): a skew of `s` ms between
two of them puts their window edges `s` ms apart, and a counter's lifetime
moves by the creating process's skew. Because the window's index is in the
key, a counter that lives a little longer changes no count, so the store adds
`expiryMargin` (default 1 s) to every lifetime: it also covers the SQL
drivers' sweeper, which judges a counter's expiry by the process's clock, on
a backend that counts by its own.
