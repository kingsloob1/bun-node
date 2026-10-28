# @kingsleyweb/bun-cache

Caching over pluggable drivers, for Bun. One typed API — TTLs, tags,
single-flight `getOrSet`, stale-while-revalidate and stale-if-error, counters,
events and statistics — over a byte-level driver contract, built on
[`@kingsleyweb/bun-common`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md).

**Requires Bun ≥ 1.4.2.** Bun runs the shipped TypeScript source (`main` is
`lib/index.ts`); your type checker reads the built declarations in `dts/`.

## Status

The package is being assembled in PRs (the plan is
[`docs/plans/bun-cache/`](https://github.com/kingsloob1/bun-node/blob/develop/docs/plans/bun-cache/README.md)).
What has landed (PR-C1), and is documented below:

- the core: keys, namespaces and versions; TTLs (per entry, per value, with
  jitter); the entry header; compression
- the codecs: structured clone (the default), JSON, raw, and custom codecs
- `getOrSet` and `wrap` with the in-process single-flight, collective
  cancellation, and the cross-process lock
- stale-while-revalidate, stale-if-error with its backoff, soft and hard
  loader timeouts, eager refresh (`refreshAhead`), and probabilistic early
  expiry (`earlyExpiry`)
- tags: eager invalidation with the write fence on indexed drivers, lazy
  stamps on the rest
- counters, events, `stats()`, and the failure policy with its circuit
- runtime-checked reads (`validate`, bun-validate's V10)
- the **memory driver**, and the **conformance kit** for custom drivers
  (`@kingsleyweb/bun-cache/testing`)

And (PR-C2):

- the **file driver**: one directory, one file per entry, for several
  processes on one host — with stamp-mode tags, atomic renames, `O_EXCL`
  lock files, a sweeper with size caps, and the polled bus log
- the kit's **two-process pass** and **bus-gap case**, enabled for every
  driver that advertises `multiProcess` or a polled bus

And (PR-C3):

- the **SQLite driver** over `bun:sqlite`: one connection per file per
  process, WAL, a tag index with an atomic fence, lock rows, counters, and a
  polled bus table — the fast choice for several processes on one host
- the kit's two-process pass now starts both sides at a barrier, so it
  overlaps even for a driver as fast as SQLite

And (PR-C4):

- the **Postgres, MySQL and MariaDB drivers** over Bun's built-in `SQL`:
  shared by every process and host that reaches the database — a tag index
  with an atomic fence that holds under a concurrent invalidation, counters
  that add in the database, lock rows, the optional `maxEntries` cap, and a
  bus (`LISTEN`/`NOTIFY` on Postgres, a polled table on MySQL and MariaDB)

And (PR-H1):

- the **HTTP response cache**, `@kingsleyweb/bun-cache/http`: `cacheResponse()`
  for bun-common's `BunRouter` and both HTTP adapters, `coalesceRequests()`
  and `addCacheTags()` — see [HTTP response caching](#http-response-caching)

And (PR-T1):

- **multi-tier caching**: an L1 memory tier per process over the shared
  driver, holding decoded values, kept coherent by a bus — the driver's own,
  or `redisBus` / `pgBus` on their own — with backfill that keeps the
  driver's expiry, a flush on every bus gap, and `{ tier: "l2" }` to bypass
  it per call ([Multi-tier](#multi-tier))

And (PR-C5):

- the **Redis driver** over Bun's built-in `RedisClient`: native expiry,
  counters, locks and the tag index with its fence in Lua scripts, and its
  bus is `redisBus` on the driver's own connection
  ([The Redis driver](#the-redis-driver))
- the kit's bus-gap case also runs for a pushed bus, given a way to force a
  gap (`busGap`)

And (PR-C6):

- the **MongoDB driver** over the `mongodb` package (an optional peer): TTL
  indexes with reads that filter expiry themselves, a tag index with a
  check-then-write fence that takes itself back, `$inc`-style counters in one
  update, lock documents, the optional `maxEntries` cap, and a bus — a change
  stream on a replica set, a tailable cursor on a capped collection on a
  standalone server ([The MongoDB driver](#the-mongodb-driver))
- the kit's **bus-gap case** runs for a pushed bus too, when the test gives
  it a way to force a loss (`busGap`)

And (PR-C7):

- the **S3 driver** over Bun's built-in `S3Client`: stamp-mode tags,
  expiry in each object's `Content-Type` for the sweeper, `maxEntries` and
  `maxBytes` caps, and counters and locks on S3's conditional writes, which
  it signs itself ([The S3 driver](#the-s3-driver))

Next, in the plan's order: stale serving over HTTP
(PR-H2) and the Nest interceptor (PR-N2).

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
| Observe | `on(event, listener)`, `stats()` |
| Lifecycle | `close()`, `syncSchema(opts?)` |

`get` answers fresh values only: past its TTL an entry is a miss. `getEntry`
is the escape hatch — it returns stale entries (still within their stale
window) with `stale: true`.

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

How invalidation works depends on the driver (§3.6 of the plan):

- **`tags: "index"`** (the memory driver): entries are deleted eagerly, and a
  write whose loader started *before* the invalidation is refused by the
  **fence** — the `fenced` event fires with `reason: "fence"`, and the
  loader's caller still gets its value. The fence is what catches an
  invalidation from another cache on the same driver (another process, in
  production); one on the same cache has already forgotten the flight, so its
  drop reports `reason: "local"` instead (above). Either way `tags` is the
  dropped entry's own, and `stats().fenced` counts it. A stamp at the entry's
  own millisecond counts as newer: Date.now() cannot order two events within
  one ms, so the safe side wins.
- **`tags: "stamps"`** (custom drivers via `fromSimpleDriver`, the file and
  S3 drivers later): `invalidateTags` writes only a stamp per tag, and a read
  of a tagged entry compares its age against the stamps — an entry older than
  a stamp is a miss. Stamps are cached in process for `tagStampCacheMs`
  (default 1 s), and invalidated entries are reclaimed by the sweeper.

`invalidateTags(tags, { mode: "stale" })` (a soft purge) is a later PR and
throws `UnsupportedOperationError` today.

## Counters

```ts
const n = await cache.increment("hits:/home", 1, { ttl: 86_400_000 });
```

`increment` returns the new value; `decrement` is `increment(key, -by)`. The
TTL is set only when the counter is created, so a rate-limit window does not
slide. `get` on a counter key returns its number. A counter carries no tags.
On a driver without `capabilities.atomicIncrement`, `increment` throws
`UnsupportedOperationError`.

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

`compress: { algorithm: "zstd" | "gzip", threshold, level? }` — the default
is zstd above 16 KiB, and an entry is compressed only when that makes it
smaller. `compress: false` disables it.

Every entry is capped at `maxEntryBytes` (default 4 MiB, or the driver's own
limit when smaller). An oversized `set` resolves `false` and emits `oversize`
(it does not throw, unless `strict: true`); in `getOrSet` the value is
returned uncached. A key longer than `maxKeyLength` bytes (default 200) is
stored as `#` + its SHA-256, with the full key kept in the entry's header: a
hash collision reads as a miss, never as the wrong value.

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

**Runtime-checked reads (V10).** `validate` maps key patterns to any
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
(with a `reason`, `"fence"` or `"local"`), `delete`, `invalidate`, `load`
(with its duration and a `shared` flag), `refresh`, `stale-if-error`,
`lock-wait`, `lock-timeout`, `evict`, `oversize`, `error` (with `phase` and
`driver`), `circuit-open` and `circuit-close`. A `hit` says which `tier`
served it (`"l1"` or `"l2"`; always `"l2"` without an L1), and a bus failure
is an `error` with `phase: "bus"`. Listeners are synchronous and
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

A cache that is down is bypassed, never fatal (plan D8):

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
  entry's expiry, never a fresh TTL (plan R14), so a copy never outlives the entry
  it copies. A stale value is never served from L1: the stale windows
  (`staleWhileRevalidate`, `staleIfError`) are L2's.
- **Counters never enter L1**: an `increment` is L2's alone (plan §3.8).
- **`validate`**: a value written to a key a schema covers is not copied on
  write; the next read validates it on its way into L1.
- **`{ tier: "l2" }`** on `get`, `getEntry`, `has`, `getMany`, `set` and
  `getOrSet` bypasses L1 for that call: it neither reads nor fills it. A write
  with it still drops this process's copy and publishes.

**The order of operations** (plan §4.1):

| Operation | Order |
|---|---|
| Read | L1 → L2 → loader. A fresh L2 hit is copied into L1 |
| Write (`set`, a loader's value, a refresh) | L2, then L1, then publish `set` with the key. A write the fence refused, or that failed, writes no L1 and publishes nothing |
| `delete`, `deleteMany`, `clear`, `invalidateTags` | L2, then L1, then publish |
| `increment` | L2 only |

### The bus

Other processes learn of a change through the **bus**: a message carries the
namespace and the keys or tags that changed — **never a value** (plan R13) — and a
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
- **In other processes:** stale until the bus delivers. Measured between two
  processes on this repository's machine, from the writer's `set` resolving
  to the reader's first read of the new value (15 rounds each, at random
  phases of the poll):

  | L2 and bus | Quiet machine | Loaded (1-minute load 29 on 16 cores) |
  |---|---|---|
  | Postgres, `LISTEN`/`NOTIFY` | p50 0.35 ms, max 0.8 ms | p50 0.8–9 ms, max 5–18 ms |
  | SQLite file + `redisBus` | p50 0.12 ms, max 0.6 ms | p50 0.5–1.9 ms, max 10–15 ms |
  | SQLite file, polled bus (250 ms) | — | p50 79–137 ms, max 218–234 ms: up to one poll |

  With the bus down or absent: up to `l1.ttl`.
- **When a write and a read race**, another process can read the old value
  from its L1 between the L2 write and the message's delivery. That is the
  price of L1. A read that cannot accept it uses `{ tier: "l2" }`.
- **Never**: a value no tier wrote; a value restored after `invalidateTags`
  by a loader that started before it (the fence covers both tiers); a copy
  that outlives the L2 entry it copies.

`stats().l1` counts `hits`, `misses` (reads that went on to L2; `tier: "l2"`
reads are not counted), `backfills`, `invalidations`, `evictions` and
`flushes`, and reports what it holds now, `entries` and `bytes`.

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
its subscriber connection (the Redis driver's test kills it with `CLIENT
KILL`), and the bus-gap case then runs for it too.

## Testing helpers

`@kingsleyweb/bun-cache/testing` also ships:

- **`faulty(inner, { failRate, failOn, hangMs, lagMs, down })`** — a
  fault-injection wrapper: fail every operation, fail named operations, hold
  them open, or slow them. `driver.setFaults({...})` changes the faults
  mid-test. This is how the failure-policy tests drive the circuit.
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

| Driver | Ships | TTL | Atomic increment | Lock | Tags | Bus |
|---|---|---|---|---|---|---|
| memory | PR-C1 | lazy + sweep | yes | in process | index, atomic fence | in-process |
| custom (`fromSimpleDriver`) | PR-C1 | declared | no | no | stamps | no |
| file | PR-C2 | lazy + sweep | yes, under a lock file | `O_EXCL` file | stamps, checked on read | polled log |
| SQLite | PR-C3 | filtered on read + sweep, indexed `exp` | yes, `RETURNING` upsert | lock row, one conditional upsert | index, atomic fence (one transaction) | polled table |
| Postgres | PR-C4 | filtered on read + sweep, partial `exp` index | yes, `RETURNING` upsert | lock row, one conditional upsert | index, atomic fence (one statement under a namespace advisory lock) | `LISTEN`/`NOTIFY` |
| MySQL / MariaDB | PR-C4 | filtered on read + sweep, indexed `exp` | yes, `LAST_INSERT_ID` upsert | lock row, one conditional upsert | index, atomic fence (a `REPEATABLE READ` transaction) | polled table |
| Redis | PR-C5 | native (`PEXPIREAT`), filtered on read | yes, Lua (`HINCRBY`) | `SET … PX`, Lua take and compare-and-delete | index, atomic fence (one Lua script) | pub/sub (`redisBus`) |
| MongoDB | PR-C6 | TTL index (a 60 s monitor) + filtered on read + sweep | yes, one update pipeline | lock document, a conditional upsert | index, check-then-write fence with a take-back | change stream (replica set) or tailable capped collection |
| S3 | PR-C7 | filtered on read + sweep (+ a bucket lifecycle rule) | yes, compare-and-swap (`If-Match`), batched per key | conditional `PUT`s, compare-and-delete | stamps, checked on read | none (`redisBus` / `pgBus`) |

The full per-driver design, with the measured evidence behind each choice, is
the [plan](https://github.com/kingsloob1/bun-node/blob/develop/docs/plans/bun-cache/README.md).

## The file driver

```ts
import { createCache, fileDriver } from "@kingsleyweb/bun-cache";

const cache = createCache({
  driver: fileDriver({ root: "/var/lib/myapp/cache" }),
});
```

One directory, one file per entry, for several processes on one host (a
durable single-machine cache that survives restarts, and the first
`multiProcess` driver). The layout (§7.2 of the plan):

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
  never moved (see `#judgeLock` in the source for the race this avoids).
- **Expiry and caps**: lazy on read, plus the sweeper — expired entries from
  their 14-byte file header, then `maxEntries`/`maxBytes` oldest-first by
  modification time (age order, not LRU).
- **The bus** is a polled append-only `bus.log` (default 250 ms); a
  compaction past `maxBusLogBytes` (1 MiB) signals a gap to subscribers.
- **Durability and limits**: POSIX local filesystems only — never NFS
  (lock-file semantics do not survive it). Writes are slow next to SQLite
  (about 5k/s against 20k/s, measured for the plan); prefer SQLite for small
  values on one host. There is no cross-machine story: use a shared driver
  (SQL, Redis) for that.

## The SQLite driver

```ts
import { createCache, sqliteDriver } from "@kingsleyweb/bun-cache";

const cache = createCache({
  driver: sqliteDriver({ path: "/var/lib/myapp/cache.db" }),
});
```

One database file over `bun:sqlite`, shared by every process on the host
that opens it (§7.3 of the plan). Five tables, under the prefix
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
  filesystem). Every call blocks the event loop while it runs — about
  2.5 µs per small hit, about 100 µs per 10 KB one (measured for the plan) —
  so keep values over ~100 KB in another driver.

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
built-in `SQL` (§7.4 and §7.5 of the plan). The tables, under the prefix
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
`RedisClient` (§7.7 of the plan). Every key is under the prefix (`prefix`,
`bun-cache` by default; not empty, no `{` or `}`) and the namespace, wrapped
in a hash tag and encoded so it never holds `}` or `:` (any string is a safe
namespace; `SCAN` patterns are escaped, so `x*` never reaches `xy`):

```
<p>:{<ns>}:e:<key>   STRING  the entry: a header line (expiry, tags) and its bytes; PEXPIREAT
<p>:{<ns>}:n:<key>   HASH    a counter (value, expiry, created at); PEXPIREAT
<p>:{<ns>}:t:<tag>   SET     the keys carrying the tag
<p>:{<ns>}:s:<tag>   STRING  the tag's invalidation stamp, "<at> <until>"
<p>:{<ns>}:l:<key>   STRING  a lock's owner; PX
<p>:bus              the bus channel
```

- **Atomic in Lua**: a write with the tag fence (check the stamps, replace
  the old tag memberships, write) is one script, and so is `deleteByTags`
  (every stamp, then every member and the sets), so a write whose load began
  before an invalidation is refused or deleted, never kept. So are
  `increment`, `touch`, `delete` and the lock's take and release. Scripts run
  by `EVALSHA` and are sent again with `EVAL` when the server answers
  `NOSCRIPT` (after a restart or a `SCRIPT FLUSH`). On Upstash,
  `keyLocking: true` runs them under a namespace's lock instead of the
  database's ([below](#upstash-and-other-managed-redis)).
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
  operation fails. A TLS connect to a Redis in another region takes most of
  a second (measured to Upstash: 549–1004 ms), which is why the bound is not
  tighter. `connectionTimeout`, `maxRetries` and `autoReconnect` are
  Bun's own, passed through. After a drop, Bun reconnects; once it gives up,
  the next operation starts again.
- **Redis Cluster is not supported yet**: Bun's `RedisClient` does not
  follow the cluster's `MOVED` and `ASK` redirects
  ([oven-sh/bun#22947](https://github.com/oven-sh/bun/issues/22947)) —
  measured on a three-node cluster, every key on another node failed with
  `MOVED`. `cluster: true` throws, and connecting to a cluster node fails
  with the same explanation. The keys are hash-tagged by namespace already,
  so the layout will not change when it is. A primary behind a stable
  address (a managed service, a proxy) works; Sentinel does not (Bun has no
  Sentinel support, oven-sh/bun#38515).

## The MongoDB driver

```ts
import { createCache, mongoDriver } from "@kingsleyweb/bun-cache";

const cache = createCache({
  driver: mongoDriver({ url: "mongodb://db:27017/app" }),
});
// or mongoDriver({ connection: { host: "db", database: "app" } }),
//    mongoDriver({ client: existingMongoClient, database: "app" })  // never closed by the driver
```

One set of collections in a database every process and host can reach (§7.6
of the plan). **`mongodb` is an optional peer** (`>=6`): install it with
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
  "check-then-write"`).
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
  token after a resumable loss (a killed cursor, a dropped connection), so
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
  index keys); the suite runs on 7.0, standalone and as a replica set.
  **Testing**: `mongodb.test.ts` runs its whole suite against
  `BUN_CACHE_TEST_MONGODB_URL` (a standalone server: the tailable bus) and
  again against `BUN_CACHE_TEST_MONGODB_RS_URL` (a single-node replica set:
  the change-stream bus, both modes, resume and gap). `bun
  scripts/setup-databases.ts` starts the replica set as a docker container
  on 27018 and `--print-env` prints both URLs. An unset variable skips its
  suite visibly; one set but unreachable fails.

### Upstash and other managed Redis

`redisDriver({ url: "rediss://default:<password>@<name>.upstash.io:6379" })`
works on [Upstash](https://upstash.com) over its Redis protocol endpoint:
the conformance kit and every Redis test pass against it (measured
2026-10-28, `docs/plans/bun-cache/evidence/upstash-spike.md`). What differs
from a Redis next to the app:

- **Every command is a round trip** to the database's region (about 300 ms
  from West Africa to `us-east-1`; Upstash quotes under 1 ms in the same
  region). Put the app in the database's region, and use an `l1` for hot
  keys. Concurrent operations share one connection, pipelined (50 `GET`s in
  330 ms).
- **It bills per command**, a Lua script as one plus every `redis.call`
  inside it. What each operation costs, counted with `MONITOR`:

  | Operation | Commands |
  |---|---|
  | `get`, a hit or a miss; `getCounter`; `getStamps` (one `MGET`) | 1 |
  | `getMany` | 1 per key |
  | `set`, a new key, no tags | 5 |
  | `set`, each tag | +1 |
  | `set` replacing an entry | +1, and +1 per old tag |
  | `set` with the fence | +1 per fenced tag |
  | `touch` | 4 |
  | `increment` (an existing counter / a new one) | 3 / 6 |
  | `acquireLock`, `releaseLock` | 3 each |
  | `delete` | 1, plus 2 per absent key, 3 per entry, and 1 per tag it carried |
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
  primary), and a write on one connection was read back on another at once
  30 times in 30.
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
script's locked hash tags ("Dynamic keys are not allowed …", measured); every
script here keeps to its namespace's tag, which the Upstash lane checks with
the option on and every local test run enforces on a plain Redis.

**`allow-oom` on the scripts that only remove.** A script with a shebang and
without `allow-oom` is refused whole while the server is out of memory,
where an unflagged one runs until a command that would grow memory. So
`delete`, `releaseLock` and `sweep`'s two prunes (a tag set's members, a
lapsed stamp) — every command in them a read or a removal — declare
`#!lua flags=allow-key-locking,allow-oom`, and a full database can still be
freed through them. Nothing that writes carries it: not `set`, `touch`,
`increment` or `acquireLock`, nor `deleteByTags`, which writes a stamp per
tag before it deletes. Upstash accepts the combined flags and still locks
by key (measured); what it does when actually full is not measured (that
needs a full scratch database).

**Upstash only.** Plain Redis rejects the flag (Redis 8.0.5: "Unexpected flag
in script shebang: allow-key-locking"; Redis 6 has no script flags), so the
option is off by default. Set against such a server, the first write fails
with `redisDriver: keyLocking is set, and <host:port> refused Upstash's
allow-key-locking script flag (…)`; reads that need no script (`get`,
`getMany`, a counter, the stamps) still answer.

**Testing against it.** This package's Upstash lane
(`__tests__/drivers/upstash.test.ts`) runs the kit and the Redis tests
against the database `BUN_CACHE_TEST_UPSTASH_REDIS_URL` names, and skips,
visibly, when it is unset; with `BUN_CACHE_TEST_UPSTASH_KEY_LOCKING=1` as
well, every driver it builds sets `keyLocking: true`. The URL holds the
database's password: export it for one run, never commit it. One run takes about two minutes and some
2,400 billed commands (of the free plan's 500,000 a month), and deletes the
keys it wrote.

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

A bucket every process and host can reach, over Bun's built-in `S3Client`
(§7.8 of the plan). It suits large values, long TTLs and few reads per key:
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
    (`docs/plans/bun-cache/bun-jobs-s3-driver.md` §3.3 has the sources.)
  - **SeaweedFS** (the repository's test server) serialises concurrent
    conditional writes to one object: each loser answers only after waiting
    about a second longer than the one before (measured, 4.48: five at once
    took 3 s, fifty 10 s), while one at a time they take a millisecond. The
    driver's batching and its per-key lock queue keep a process's own calls
    from contending; two processes on one hot lock still pay it.
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
  listings; other stores differ. Tested here against SeaweedFS 4.48 only
  (`bun scripts/setup-databases.ts`). An entry holds up to 5 GiB less a MiB
  (one `PUT`); the core's `maxEntryBytes` (4 MiB) applies first.

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
interceptors do not run before router middleware, so use the interceptor
(PR-N2) for anything behind a guard.

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
- a buffered body (a stream is not stored; PR-H2 adds `streams: { buffer }`);
- a lifetime: `ttl` in ms (which overrides the freshness headers, not the
  refusals above), or with `ttl: "headers"` (the default)
  `Surrogate-Control: max-age`, then `s-maxage`, then `max-age`, then
  `Expires` less `Date`, minus the response's own `Age`.

Never stored: hop-by-hop fields, `Content-Length`, `Age`, the status header,
`omitHeaders`, and any header a middleware **ahead** of the cache set and the
handler left as it was (a request id, a CORS origin, a session cookie) —
that middleware sets its own on every hit. A response's
`stale-while-revalidate=` and `stale-if-error=` are kept with the entry
(zeroed by `must-revalidate` or `proxy-revalidate`) for PR-H2; until then an
entry past its freshness is a miss.

**Hits** get the stored status and headers, `Age` (RFC 9111 §5.1: the
response's own plus its time in the cache), and the body through
`res.send()` — so a matching `If-None-Match` or `If-Modified-Since` gets a
`304`, and every stored response has an `ETag` (computed from the body when
the handler set none; `etag: false` turns that off). A conditional request
that **misses** still produces the full response for the cache (the
handler sees `req.fresh === false`), and is answered `304` from it. The
`X-Cache` header (`statusHeader`, or `false`) says `HIT`, `MISS`, `BYPASS`
(`bypass(req)`, or a request's `no-store` under `honorRequest`) or
`UNCACHEABLE` (answered, not stored).

**HEAD** is answered from the GET entry, without a body; a HEAD miss runs the
GET handler and stores nothing. A `POST`, `PUT`, `PATCH` or `DELETE` through
the middleware that gets a 2xx or 3xx drops every entry for its path, and
for a same-host `Location` or `Content-Location` (RFC 9111 §4.4;
`invalidateOnUnsafe: false` turns it off); a `GET` in the same process waits
for that invalidation before it reads. Every entry carries its path's tag,
so `pages.invalidate(path | url | request)` drops a path's queries and
variants; the `tags` option (a list, or `(req, res) => tags`) and
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
fresh response, outside the transforms: they are never stored (§9.2 of the
plan). The write never delays the response, so a request arriving right
after a miss may miss too.

**`coalesceRequests({ key?, wait? })`** is the coalescing alone, with no
store: identical in-flight `GET`s share one run, and each follower gets a
copy of the leader's buffered answer through its own `res.send()`. Requests
with `Cookie` or `Authorization` run on their own unless your `key` includes
the identity, and an answer that sets a cookie or is `private`, `no-store`
or `no-cache` is not shared.

| Option | Default | |
|---|---|---|
| `ttl` | `"headers"` | ms, or the freshness headers |
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
