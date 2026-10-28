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

Next, in the plan's order: Redis (PR-C5), MongoDB (PR-C6), S3 (PR-C7), then
the multi-tier L1/L2 bus (PR-T1). The HTTP utilities (`cacheResponse`) and
the Nest module follow.

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
`driver`), `circuit-open` and `circuit-close`. Listeners are synchronous and
isolated: a throwing one is logged and never breaks the operation. `on`
returns an unsubscribe function.

`cache.stats()` counts `hits`, `staleHits`, `misses`, `sets`, `fenced`,
`deletes`, `loads`, `loadErrors`, `lockWaits`, `evictions`, `bytesRead`,
`bytesWritten`, plus `hitRate` and load-duration percentiles over a rolling
60 s window. `stats({ reset: true })` reads and zeroes them.

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
forces a gap in its log.

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
| Redis, MongoDB, S3 | PR-C5 to PR-C7 | per the plan | per the plan | per the plan | per the plan | per the plan |

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
