# `@kingsleyweb/bun-cache` examples

Runnable examples for
[`@kingsleyweb/bun-cache`](../../packages/bun-cache): caching over pluggable
drivers — TTLs, tags, single-flight `getOrSet`, staleness, counters, events
and stats, typed keys, runtime-checked reads, and HTTP response caching (`@kingsleyweb/bun-cache/http`).

Each file is a script. Its opening comment says what it shows and how to run
it; its output narrates what happened, and the `✓` lines are assertions (a
failed one exits non-zero, so `run-all.ts` reports it).

```bash
cd examples/bun-cache
bun 01-core/basics.ts              # start here
bun run-all.ts                     # every example; prints ok / skip / FAIL
bun run-all.ts 01 03               # only folders 01-* and 03-*
```

No install step: the examples use the workspace package through the repo's
root `node_modules`; `03-typed` uses zod from the same place.

| Folder | What it shows |
|---|---|
| `01-core` | `basics.ts` — set/get/has/delete, `getEntry`, TTL expiry, tags, counters, namespaces, events, stats |
| `01-core` | `compression.ts` — the stored bytes as proof: zstd above 16 KiB and nothing below, `gzip`/`br`/`deflate` (format 1 vs 2, compressor ids), `level` and the option `TypeError`s, mixed algorithms in one store, per-call `compress: false`, a sync and an async user compressor with `previous`, and planted decompression bombs (zstd, gzip, br, deflate) read as misses with a `decode` error |
| `02-loading` | `getorset.ts` — the single-flight under a burst, `wrap`, stale-while-revalidate, stale-if-error, negative caching |
| `03-typed` | `validated.ts` — a typed schema, and `validate` (V10): a failing value is a miss with an `error` event |
| `04-drivers` | `file.ts` — the file driver: durability across instances, stamp-mode tags, the sweeper and its caps |
| `04-drivers` | `sqlite.ts` — the SQLite driver: durability, eager tag deletion and the fence, the polled bus, and two processes sharing a counter and a lock |
| `04-drivers` | `sql.ts` — the Postgres, MySQL and MariaDB drivers on each server whose `EXAMPLE_*_URL` is set: `getOrSet`, tags and counters below zero, exact keys, two instances sharing data and the bus, `maxEntries` evicting nearest-to-expiry first, an existing `sql` client, `?allowPublicKeyRetrieval=true`, Postgres `unlogged` |
| `04-drivers` | `redis.ts` — the Redis driver on the server `EXAMPLE_REDIS_URL` names (skips when unset): `getOrSet`, tags, bytes through the `structured` codec, counters below zero, `touch`, native expiry (`PTTL` -2), two drivers sharing data with the driver's own bus dropping the other's L1 copy, the driver's bus and a separate `redisBus` hearing each other, an existing `client`, `cluster: true` throwing (oven-sh/bun#22947), and the `volatile-lru` note for a memory cap |
| `04-drivers` | `mongodb.ts` — the MongoDB driver on the server `EXAMPLE_MONGODB_URL` names (skips when unset; needs the `mongodb` package): `getOrSet`, tags, counters below zero, a lock contended by two caches, an expired entry read as a miss while its document is still stored (the TTL monitor runs once a minute), `collections` naming one collection outright, `syncSchema({ dryRun: true })` answering `[]`, `maxEntries` with a manual `sweep` and the `evict` events, an existing `client`, and two `l1: true` caches kept coherent over the driver's bus (a change stream on a replica set, a tailable cursor on a standalone server) |
| `04-drivers` | `s3.ts` — the S3 driver on the bucket `EXAMPLE_S3_URL` names (skips when unset; `bun scripts/setup-databases.ts --print-env` prints a local SeaweedFS URL): `getOrSet`, stamp-mode tag invalidation (a stamp object; the tagged entry's object stays until a sweep), a counter below zero, `touch`, the layout (`<ns>/e/<hh>/<sha256>`, and `exp=`/`at=` in each object's `Content-Type`), an expired entry read as a miss and reclaimed by `sweep`, `maxEntries` evicting the oldest write, two drivers on one prefix counting exactly 50 and sharing a lock through conditional writes, and `conditionalWrites: false` turning `increment` and locks off; deletes exactly the objects it wrote |
| `04-drivers` | `azure.ts` — the Azure Blob Storage driver on the blob container `EXAMPLE_AZURE_URL` names (skips when unset; `bun scripts/setup-databases.ts --print-env` prints a local Azurite URL): `getOrSet`, stamp-mode tag invalidation (a stamp blob; the tagged entry's blob stays until a sweep), a counter below zero, `touch`, the same driver from `UseDevelopmentStorage=true` (only against the default local Azurite), the layout (`<ns>/e/<hh>/<sha256>`, and `exp=`/`at=` in each blob's `Content-Type`), an expired entry read as a miss and reclaimed by `sweep`, `maxEntries` evicting the oldest write, and two drivers on one prefix counting exactly 50 and sharing a lock through conditional writes (not Blob Leases); lists and deletes exactly the blobs it wrote with a Shared Key signer of its own |
| `04-drivers` | `cloudflare-kv.ts` — the Cloudflare KV driver, with no account: the example runs the Worker the package ships in workerd through miniflare (skips when miniflare cannot be loaded) and points the driver at it with `endpoint`: `set`/`get`/`getMany`/`setMany`, stamp-mode tag invalidation (the entries stay stored, unreadable; KV's eventual consistency is stated, not shown, since local KV is one store), a 300 ms TTL exact under KV's 60 s floor while the key stays stored, `increment` throwing `UnsupportedOperationError`, `delete` and `clear`; shuts workerd down at the end |
| `04-drivers` | `cloudflare-d1.ts` — the Cloudflare D1 driver, with no account (the same local Worker under miniflare): the tables under a `prefix`, atomic counters (20 concurrent increments lose none), index-mode tags (a trigger deletes the tagged rows and their tag rows at once), the atomic fence emitting `fenced`, a `getOrSet` lock running the loader once across two caches, a 900,000-byte value stored and a 1,000,001-byte one skipped with an `oversize` event (`EntryTooLargeError` under `strict`), `maxEntries` evicting the entry nearest to expiry on a sweep with an `evict` event, and an expired row reclaimed by `sweep`; drops exactly the tables it created |
| `05-http` | `basics.ts` — `cacheResponse()` on a `BunRouter`: `MISS` then `HIT` with `Age`, a 304 from the stored `ETag`, HEAD from the GET entry |
| `05-http` | `ttl-from-headers.ts` — the default `ttl: "headers"`: `s-maxage` is stored, no `Cache-Control` and `private` are `UNCACHEABLE` |
| `05-http` | `vary.ts` — a handler's `Vary: Accept-Language` learned per URL, one entry per language; `Vary: *` never stored |
| `05-http` | `invalidation.ts` — `addCacheTags` + `invalidateTags`, an unsafe 2xx through the middleware (a 4xx leaves it), `pages.invalidate(path)` |
| `05-http` | `coalescing.ts` — a burst of ten runs the handler once (one `MISS`, nine `HIT`); a `private` answer runs ten times |
| `05-http` | `coalesce-requests.ts` — `coalesceRequests()` with no store: five GETs, one run; cookies run alone; nothing kept |
| `05-http` | `compression.ts` — `compression()` ahead of the cache: one stored copy, gzip per request on a hit |
| `05-http` | `stale-while-revalidate.ts` — `max-age=1, stale-while-revalidate=60`: a `STALE` answer with the old body, one background replay (ten stale requests, one run), then a `HIT` with the new body; without `revalidate` the next request refreshes it |
| `05-http` | `stale-if-error.ts` — a failing handler (error handler answers 503) is replaced by the stale `200` inside `staleIfError`, the 503 goes through past it; `hardTimeout` answers stale before a slow handler does |
| `05-http` | `replay-token.ts` — a made-up `x-bun-cache-revalidate` header is an ordinary request: `HIT` on a fresh entry, `STALE` on a stale one |
| `05-http` | `streams.ts` — streamed answers are `UNCACHEABLE` by default; `streams: { buffer }` stores one that ends within it (`MISS` then `HIT`), a longer one is sent whole and not stored |
| `06-tiers` | `l1.ts` — an L1 memory tier over a shared driver, kept coherent by the driver's bus: backfill, writes/deletes/tags/`clear` dropping the other copy, `tier: "l2"`, counters never in L1, `clone` |
| `06-tiers` | `staleness.ts` — `l1.ttl` as the staleness bound with `bus: false`, and the same write with the bus |
| `06-tiers` | `two-processes.ts` — a second process with its own L1: the measured invalidation window (SQLite polled bus; Postgres `LISTEN`/`NOTIFY` with `EXAMPLE_POSTGRES_URL`; `redisBus` with `EXAMPLE_REDIS_URL`) and a forced gap flushing the L1. Runs alone |
| `06-tiers` | `separate-bus.ts` — `redisBus` / `pgBus` over an SQLite L2 whose own bus polls every minute (`EXAMPLE_REDIS_URL` / `EXAMPLE_POSTGRES_URL`; skips when neither is set) |
