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
| `02-loading` | `getorset.ts` — the single-flight under a burst, `wrap`, stale-while-revalidate, stale-if-error, negative caching |
| `03-typed` | `validated.ts` — a typed schema, and `validate` (V10): a failing value is a miss with an `error` event |
| `04-drivers` | `file.ts` — the file driver: durability across instances, stamp-mode tags, the sweeper and its caps |
| `04-drivers` | `sqlite.ts` — the SQLite driver: durability, eager tag deletion and the fence, the polled bus, and two processes sharing a counter and a lock |
| `04-drivers` | `sql.ts` — the Postgres, MySQL and MariaDB drivers on each server whose `EXAMPLE_*_URL` is set: `getOrSet`, tags and counters below zero, exact keys, two instances sharing data and the bus, `maxEntries` evicting nearest-to-expiry first, an existing `sql` client, `?allowPublicKeyRetrieval=true`, Postgres `unlogged` |
| `05-http` | `basics.ts` — `cacheResponse()` on a `BunRouter`: `MISS` then `HIT` with `Age`, a 304 from the stored `ETag`, HEAD from the GET entry |
| `05-http` | `ttl-from-headers.ts` — the default `ttl: "headers"`: `s-maxage` is stored, no `Cache-Control` and `private` are `UNCACHEABLE` |
| `05-http` | `vary.ts` — a handler's `Vary: Accept-Language` learned per URL, one entry per language; `Vary: *` never stored |
| `05-http` | `invalidation.ts` — `addCacheTags` + `invalidateTags`, an unsafe 2xx through the middleware (a 4xx leaves it), `pages.invalidate(path)` |
| `05-http` | `coalescing.ts` — a burst of ten runs the handler once (one `MISS`, nine `HIT`); a `private` answer runs ten times |
| `05-http` | `coalesce-requests.ts` — `coalesceRequests()` with no store: five GETs, one run; cookies run alone; nothing kept |
| `05-http` | `compression.ts` — `compression()` ahead of the cache: one stored copy, gzip per request on a hit |
| `06-tiers` | `l1.ts` — an L1 memory tier over a shared driver, kept coherent by the driver's bus: backfill, writes/deletes/tags/`clear` dropping the other copy, `tier: "l2"`, counters never in L1, `clone` |
| `06-tiers` | `staleness.ts` — `l1.ttl` as the staleness bound with `bus: false`, and the same write with the bus |
| `06-tiers` | `two-processes.ts` — a second process with its own L1: the measured invalidation window (SQLite polled bus; Postgres `LISTEN`/`NOTIFY` with `EXAMPLE_POSTGRES_URL`; `redisBus` with `EXAMPLE_REDIS_URL`) and a forced gap flushing the L1. Runs alone |
| `06-tiers` | `separate-bus.ts` — `redisBus` / `pgBus` over an SQLite L2 whose own bus polls every minute (`EXAMPLE_REDIS_URL` / `EXAMPLE_POSTGRES_URL`; skips when neither is set) |
