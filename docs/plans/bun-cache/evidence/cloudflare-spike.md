# Spike: Cloudflare KV and D1 (PR-C10 `cloudflareKvDriver`, PR-C11 `cloudflareD1Driver`)

The plan's questions (Status, 2026-10-27): can the D1 REST API express the
fence's one-transaction rule; and, for both drivers, what transport, what
capabilities, and how to test them with real KV and D1 semantics and no
mocks. bun-cache runs in a Bun server process, not in a Worker, so it reaches
Cloudflare over HTTP. Run 2026-10-28 on the shared laptop (Bun
1.4.4-canary.1+a0cc096ce, load 3.5–4.5), with **miniflare 4.20260730.0**
(workerd `2026-07-30`) installed in a scratch directory. Nothing was added to
the repository's dependencies. No Cloudflare account was used: everything
about the real service is from Cloudflare's documentation, marked [W]; what
ran locally is [M]; what neither settles is [U].

## Answers

1. **miniflare does not serve the Cloudflare REST API, only the Worker
   bindings.** It ships a REST-*shaped* "local explorer"
   (`unsafeLocalExplorer`, `/cdn-cgi/explorer/api/…`), but it is a dashboard
   backend and not faithful: it ignores `expiration_ttl` and accepts a TTL of
   30 s, runs a D1 batch one statement at a time (a failed batch leaves its
   first insert), has no D1 `/query`, no KV bulk write or delete, no metadata
   route, and checks no token [M]. **The test strategy that works:** a small
   Worker, run by miniflare, that answers the REST API's KV and D1 data paths
   over real KV and D1 bindings (`cloudflare-spike/proxy.worker.js`, about 200
   lines). The driver's HTTP client then runs against workerd's own KV and D1
   implementations. Started from Bun in about 0.1 s (0.7 s the first time),
   42 MiB per instance, each operation about 1 ms [M].
2. **That same Worker is the right production transport for anything beyond
   light traffic.** The REST API is capped at **1,200 requests per five
   minutes per user or token**, shared with Wrangler and the dashboard, and
   exceeding it blocks every API call for five minutes [W]. That is four
   cache operations a second on average. A Worker with KV and D1 bindings has
   no such cap. So each driver should take either the REST API (an account id
   and an API token) or a deployed copy of this Worker (its URL and a secret),
   speaking the same REST shapes, so there is one client. The tests run the
   very Worker users deploy.
3. **KV** can honestly advertise `multiProcess`, `ttl: "native"` (with a 60 s
   floor the driver absorbs), `tags: "stamps"` (eventually consistent: an
   invalidation may take a minute or more to be seen everywhere), and
   nothing else: no `atomicIncrement`, no `lock`, `bus: "none"` [W]. The core
   already handles each of those (below).
4. **D1: the fence does not need the REST API's batch to be a transaction.**
   Every write the driver makes can be **one SQL statement**, with
   **triggers** keeping the tag index and doing the invalidation's deletes.
   D1 refuses `BEGIN`/`SAVEPOINT` [M], documents the *binding's* `batch()` as a
   transaction [W] (and it is one locally [M]), but says nothing about the REST
   API's batch [W]. Under the one-statement design, a fenced write raced
   against an invalidation left **0 survivors in 60 rounds**; the
   check-then-write mutant left **60 of 60** (59 of 60 in a second run) [M].
   D1 can then advertise everything SQLite does except the bus: `atomicIncrement`,
   `lock`, `tags: "index"`, `fence: "atomic"`, `ttl: "sweep"`, `bus: "none"`.

## What was measured

Scripts and output in [`cloudflare-spike/`](cloudflare-spike/). Each starts its
own in-memory miniflare on port 0 with `proxy.worker.js`; nothing persists.
Re-run: `cd cloudflare-spike && bun install && bun probe-kv.ts --expiry`
(and the others), outside the repository's dependency tree (the folder's
`package.json` pins miniflare; it is not a workspace).

| Script | What | Output |
|---|---|---|
| `proxy.worker.js` | The REST API's KV (`values`, `metadata`, `keys`, `bulk`, `bulk/get`, `bulk/delete`) and D1 (`query`, `raw`, `{ sql, params }` or `{ batch }`, string params only) over real bindings; Bearer token | — |
| `probe-kv.ts` | KV limits, reads, list and bulk, latency, the local explorer, native expiry (`--expiry`, about 65 s) | `results-kv.txt` |
| `probe-d1.ts` | D1's SQL surface, the trigger schema, round trips, the fence and its race, counters, locks, batch atomicity, latency; `MODE_SEQUENTIAL=1` makes the proxy run a batch one statement at a time, as the explorer does | `results-d1.txt`, `results-d1-sequential.txt` |
| `probe-d1-size.ts`, `probe-d1-limit.ts` | The largest value through a hex string parameter; the local length limit by bisection | `results-d1-size.txt`, `results-d1-limit.txt` |
| `probe-d1-upsert-trigger.ts` | A stamp upsert taking the `DO UPDATE` path still fires its trigger | `results-d1-upsert-trigger.txt` |
| `probe-start.ts` | Time to `ready`, the workerd child's RSS, dispose | `results-start.txt` |

### miniflare under Bun

- **It runs.** `new Miniflare({ modules, scriptPath, kvNamespaces,
  d1Databases, bindings, port: 0 })` under Bun: `ready` in 95–104 ms (five
  runs; 725 ms the first time on this machine), workerd's RSS 42 MiB, dispose
  4–6 ms [M]. miniflare declares `engines.node >=22`; nothing here needed
  Node.
- **The package**: `miniflare@4.20260730.0` (2026-07-30, the `latest` tag;
  5.x is beta), which brings `workerd@1.20260730.1` and its platform binary
  (`@cloudflare/workerd-linux-64`, 54 MB), plus `sharp`/`@img` (12 MB),
  `undici`, `ws`, `youch` and source-map support: 26 packages, 63 MB. workerd
  alone is not enough: the KV and D1 simulators are miniflare's own Workers
  (`dist/src/workers/kv`, `…/d1`).

### KV

Through the proxy, over workerd's KV binding [M]:

| Probe | Local result | Cloudflare [W] |
|---|---|---|
| `expiration_ttl=59` / `=60` | 400 "must be at least 60" / stored | "The minimum value is 60" |
| `expiration` = now + 30 s / + 61 s | 400 / stored | "less than 60 seconds into the future are not supported" |
| key of 512 / 513 bytes | stored / 414 | 512 bytes |
| metadata of 1024 / 1025 bytes | stored / 413 | 1024 bytes |
| value of 25 MiB / + 1 byte | stored / 413 | 25 MiB |
| 5 writes to one key within ~10 ms | 200 ×5 | **1 write per second per key, else 429** |
| write, then read at once, ×100 | 100 fresh | eventually consistent: usually at once where written, "up to 60 seconds or more" elsewhere; negative lookups are cached too |
| raw `GET` of all 256 byte values | byte-exact, `expiration` header present | raw bytes, `expiration` header |
| `bulk/get` of a binary value (`type: "text"`) | not byte-exact | "Binary values are not supported" |
| `bulk/get` of a base64 text value | byte-exact after decoding | — |
| bulk write of 1,500 (base64, TTL) | `successful_key_count: 1500` | up to 10,000 pairs, 100 MB |
| list by prefix | 1,500 keys in 2 pages of ≤ 1,000, expiration on each | 1,000 per page |
| bulk delete of 1,500 | `successful_key_count: 1500` | up to 10,000 |
| `expiration_ttl=60`, then poll | gone after 60.15 s | — |
| put / get of 1 KiB | p50 0.90 / 1.15 ms, p99 1.95 / 2.73 ms (n = 200) | — |

So locally the **limits are Cloudflare's** (workerd enforces them), but the two
behaviours that most shape a driver are **not reproduced**: eventual
consistency and the per-key write rate. (The 100-key cap on `bulk/get` in the
results is the proxy's own check, copied from the API reference.)

### D1

Through the proxy, over workerd's D1 binding [M]:

- **SQL surface.** `BEGIN TRANSACTION` and `SAVEPOINT` are refused ("To
  execute a transaction, please use the state.storage.transaction() …": D1 is
  SQLite in a Durable Object). `sqlite_version()` is not authorized.
  `unhex()`/`hex()`, `json_each()` over a parameter, `RETURNING`, `UPSERT`,
  partial indexes, `WITHOUT ROWID` and triggers all work. A BLOB comes back in
  JSON as an array of numbers, so the driver reads `hex(v)`.
- **Parameters are strings** (the documented schema, `params?: string[]`
  [W]; the proxy refuses anything else). SQLite's affinity makes them work: a
  string bound into an `INTEGER` column is stored as an integer, compared
  numerically (`n > '999'`) and added (`n + '-5'`); `NULL` is `NULLIF(?, '')`.
  A value goes in as `unhex(?)` and comes out as `hex(v)`: all 256 byte
  values and a 1 MiB value byte-exact.
- **Size.** D1 documents 2,000,000 bytes per string, BLOB or row [W]. Hex
  doubles the value in both directions, so one parameter and one `hex(v)`
  carry at most **1,000,000 bytes**. Locally the limit is 2,200,000 (by
  bisection: a text parameter of 2,200,000 characters, `hex()` of a 1,099,999
  byte BLOB), so **the local server accepts what Cloudflare refuses** and the
  driver must enforce its own cap. Writing two hex halves
  (`unhex(?1) || unhex(?2)`) and reading `hex(substr(…))` twice reached
  2,000,001 bytes locally, so ~2 MB is possible later.
- **The schema**: `lib/drivers/sqlite.ts`'s tables, plus five triggers: the
  tag rows follow `entries.tg` (after insert, after update of `tg`, after
  delete), and a stamp deletes its tag's entries (after insert, and after
  update — measured: the second invalidation of a tag takes the upsert's `DO
  UPDATE` path and still deleted both entries). Eleven DDL statements in one
  batch.
- **The fence, one statement**: `INSERT … SELECT … WHERE NOT EXISTS (SELECT 1
  FROM stamps …) ON CONFLICT DO UPDATE … RETURNING 1` — the SQLite driver's
  fence check moved into the insert. A pre-invalidation load is refused, a
  post-invalidation one stored, an untagged one unaffected.
- **Invalidation, one statement**: the stamps upsert, whose trigger deletes
  the entries, whose trigger deletes their tag rows. `meta.changes` counts
  the trigger's rows too (3 for one stamp, one entry, one tag row), so a
  count of the entries deleted comes from a `SELECT count(*)` sent first in
  the same batch: exact if the batch is a transaction, an undercount by
  concurrent writers otherwise (harmless: it only feeds the event).
- **The race**: 60 rounds of a fenced write (its `createdAt` before the
  stamp) against the invalidation, started together, then a read. One
  statement plus triggers: **0 survivors**, in both proxy modes. The mutant
  (the stamp read in one request, the write in a second): **60 of 60** and
  **59 of 60** survived.
- **Counters**: the SQLite driver's `RETURNING` upsert unchanged except
  `NULLIF` and string parameters. 200 concurrent increments over HTTP: final
  200, 200 distinct return values, 195–202 ms; by `'-3'`: 197.
- **Locks**: the SQLite driver's conditional upsert. 50 contenders on a free
  lock: **1 winner**; a takeover after expiry wins.
- **Batch atomicity**: through `DB.batch()`, a batch whose second statement
  fails (a missing table; a primary-key clash) **rolls back** its first. The
  same batch run one statement at a time (`MODE_SEQUENTIAL=1`, as the
  explorer does) **keeps** it. The probe can tell the two apart; what
  Cloudflare's REST API does is [U].
- **Latency** (local workerd): `get` p50 0.89 ms, p99 3.33 ms; fenced `set`
  p50 0.92 ms, p99 3.08 ms (n = 200).

## Cloudflare's side [W]

- **REST API rate limit**: "1,200 requests per five minute period per user",
  "cumulatively regardless of whether the request is made via the dashboard,
  API key, or API token"; over it, HTTP 429 for the next five minutes, with
  `Retry-After` (since 2025-09). KV's limits page says its REST API is
  subject to it; D1's says nothing more specific.
  ([API limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/),
  [KV limits](https://developers.cloudflare.com/kv/platform/limits/),
  [changelog](https://developers.cloudflare.com/changelog/post/2025-09-03-rate-limiting-improvement/))
- **KV**: eventually consistent, "may take up to 60 seconds or more to be
  visible" elsewhere, slower where an old version was recently read; "not
  ideal" for atomic operations or read-and-write transactions
  ([how KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)).
  1 write per second per key, else 429; TTL ≥ 60 s; key 512 bytes; metadata
  1,024 bytes; value 25 MiB; bulk write 10,000 pairs and 100 MB; `bulk/get`
  100 keys, text or JSON only, with metadata and expiration on request; raw
  `GET` answers the bytes and an `expiration` header. Free plan: 100,000
  reads and **1,000 writes a day**
  ([write](https://developers.cloudflare.com/kv/api/write-key-value-pairs/),
  [REST values](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/subresources/values/methods/update/),
  [bulk get](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/bulk_get/),
  [bulk write](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/bulk_update/)).
- **D1**: `POST …/d1/database/{id}/query` (and `/raw`) takes `{ sql, params?:
  string[] }` or `{ batch: [{ sql, params? }] }`; `sql` "supports multiple
  statements, joined by semicolons, which will be executed as a batch". The
  page says nothing about transactions
  ([query](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/);
  the TypeScript SDK's types agree). The binding's `batch()`: "Batched
  statements are SQL transactions … it aborts or rolls back the entire
  sequence"; "D1 operates in auto-commit"
  ([binding](https://developers.cloudflare.com/d1/worker-api/d1-database/)).
  Cloudflare describes the REST API as primarily the control plane
  ([query D1](https://developers.cloudflare.com/d1/best-practices/query-d1/)).
  Limits: 2,000,000 bytes per string, BLOB or row; 100 bound parameters; a
  statement of 100 KB; 30 s per query, which "also caps the entire batch
  call"; one Durable Object per database
  ([limits](https://developers.cloudflare.com/d1/platform/limits/)).

## Recommended design

### Transport, both drivers

**One HTTP client, two endpoints**, both speaking the REST API's shapes:

| | REST API | Binding proxy (a Worker the user deploys) |
|---|---|---|
| Endpoint | `https://api.cloudflare.com/client/v4/accounts/{accountId}` | the Worker's URL |
| Auth | `Authorization: Bearer <API token>` (KV: Workers KV Storage Edit; D1: D1 Edit) | `Authorization: Bearer <secret>` (a Worker secret) |
| Throughput | **1,200 requests / 5 min per token**, shared with Wrangler and the dashboard; then 5 min of 429 | Workers' limits only (KV: 1,000 operations per invocation; D1: one Durable Object per database) |
| Deploy | nothing | one Worker with KV and/or D1 bindings |
| KV reads | the API's | the binding's (edge cache, `cacheTtl`) |
| D1 batch | atomicity undocumented | `DB.batch()`, a documented transaction |
| Fit | development, CI, low traffic, an L2 behind an L1 | production |

The proxy is the spike's `proxy.worker.js`, finished: ship it with the
package, deployable with a five-line `wrangler.toml`, and run that same file
under miniflare in the tests, so the server code users deploy is the code the
suite runs. A driver never needs to know which endpoint it has. The 429
handling (both transports): honour `Retry-After`, bounded retries for writes
that matter for correctness (stamps), and an error, under the failure
policy, for the rest.

### `cloudflareKvDriver`

- **Layout**: `<prefix>/<ns>/e/<key>` and `<prefix>/<ns>/s/<tag>`, hashed
  (SHA-256) past KV's 512-byte key limit, as the S3 driver does. A value is
  the S3 driver's frame (raw bytes; exact `expiresAt` inside).
- **Expiry**: `expiration_ttl = max(60, ceil((expiresAt − now) / 1000))`
  (relative, so the client's clock never trips the "60 s in the future"
  check). A shorter TTL is exact anyway: the core rejects an entry whose
  frame says it expired (`cache.ts`, the `raw.expiresAt <= now` check); KV
  reclaims it up to 60 s later. `ttl: "native"`, no sweeper.
- **Reads**: `get` one raw `GET`. `getMany` parallel `GET`s (bounded), since
  `bulk/get` refuses binary; the alternative, base64 text values, makes
  `getMany` one request per 100 keys at a third more bytes and CPU on every
  read and write (a question below). `getStamps` is one `bulk/get` (stamps
  are JSON text).
- **Writes**: `set` one `PUT` (`setMany` one bulk `PUT`); `delete` one
  `bulk/get` for existence (the count) and one `bulk/delete`; `clear` lists
  the prefix and bulk-deletes. All eventually consistent: a deleted or
  overwritten key can be read elsewhere for a minute.
- **Tags**: `"stamps"` — one `PUT` per invalidated tag. A stamp is
  last-writer-wins (no compare-and-swap on KV), as on S3 without conditional
  writes; and a second invalidation of the same tag within a second gets a
  429 and is retried.
- **Capabilities**: `multiProcess: true`, `ttl: "native"`, `atomicIncrement:
  false`, `lock: false`, `tags: "stamps"`, `bus: "none"`, `maxEntryBytes`
  25 MiB (26,214,400 bytes, the frame included).
- **How the core behaves with those off** (read in `lib/core/cache.ts`,
  `types.ts`): `increment`/`decrement` throw `UnsupportedOperationError` even
  under the default failure policy; `getOrSet`'s `lock` logs one `warn` per
  cache and keeps the in-process single-flight, so a cross-process stampede is
  bounded by the number of processes; a tagged hit runs the stamps check,
  cached `tagStampCacheMs` (1 s) in process; an L1 needs `redisBus` or
  `pgBus`, or lives with `l1.ttl`. The kit reports the increment, lock,
  index-tag and bus cases as skipped, by name.
- **What to document**: KV is an eventually consistent L2. An invalidation,
  a delete or an overwrite may take a minute or more to be seen in other
  locations, and the core's stamp cache adds `tagStampCacheMs`. One write per
  second per key: a hot key refreshed from many processes sees 429s. The free
  plan's 1,000 writes a day.

### `cloudflareD1Driver`

- **SQL**: `lib/drivers/sqlite.ts`'s tables and statements, with string
  parameters (`NULLIF(?, '')` for a null, `unhex(?)`/`hex(v)` for the value),
  and the five triggers above. Every write one statement: `set` (the fence in
  its `WHERE`, the tag rows by trigger), `increment`, `acquireLock`,
  `releaseLock`, `touch`, `delete … RETURNING`, the stamps upsert
  (`deleteByTags`, preceded by its count in the same batch), and `sweep`'s
  `DELETE … LIMIT … RETURNING ns, k, tg` (tag rows by trigger; the
  `maxEntries` cap through `entry-cap.ts`'s victim selection, then a delete
  by key, checked against D1 in the PR). So correctness never rests on the
  REST API's batch being a transaction; a batch is used only to save round
  trips (the schema; `setMany`, in chunks under 100 parameters).
- **Capabilities**: `multiProcess: true`, `ttl: "sweep"`, `atomicIncrement:
  true`, `lock: true`, `tags: "index"`, `fence: "atomic"`, `bus: "none"`,
  `maxEntryBytes` 1,000,000 (hex through D1's 2,000,000-byte string limit;
  ~2 MB later with split parameters).
- **Bus**: `"none"` in v1. A polled table works through the proxy (the
  SQLite driver's), but over the REST API one poll a second is a quarter of
  the token's budget, and on D1 every poll is billed rows read.
- **Cost**: D1 bills rows read and written; the triggers add the tag rows'
  writes to each tagged `set` and invalidation.
- **Latency**: every operation is one HTTP request to the database's
  primary; from here, unmeasured [U].

### Tests, both drivers

- **Local, always on, no account**: a helper starts miniflare (port 0, in
  memory, a random secret) with the shipped proxy Worker, and each driver runs
  the conformance kit and its specifics against it, the two-process pass
  included. No environment variable, no skip; about 0.1 s and 42 MiB per
  instance. This needs **`miniflare` as a devDependency of bun-cache**
  (exact `4.20260730.0`), which the user must approve. The proxy's Worker
  types (`KVNamespace`, `D1Database`) can be a few structural interfaces in
  the file rather than `@cloudflare/workers-types`.
- **What the local lane cannot show**: KV's eventual consistency and its
  1-write-per-second 429 (local KV is immediate and unlimited, measured);
  D1's 2,000,000-byte limit (local allows 2,200,000); the REST frontend
  itself (auth, error envelopes, the rate limit, whether a REST batch is a
  transaction); real latency. So the driver enforces its own caps, and a
  test-only switch in the harness could make the local proxy answer 429 on a
  second write to a key within a second, to drive the retry path (a question
  below).
- **Live, opt-in**, like the Upstash lane: `BUN_CACHE_TEST_CLOUDFLARE_*`
  variables (account id, API token, KV namespace id, D1 database id; and
  optionally a deployed proxy's URL and secret). It must pace itself under
  1,200 requests per five minutes, and on the free plan a KV run may exceed
  the 1,000 writes a day; both are measured in the PR by counting the kit's
  requests on the local proxy first. It also settles the REST batch question
  with the probe's two-statement batch.

### Effort

About **7.5 days**: the shared client, the proxy Worker and the miniflare
harness ~1.5 d; `cloudflareKvDriver` ~2.5 d; `cloudflareD1Driver` ~2.5 d
(the SQL is the SQLite driver's); the live lanes and the README ~1 d.

### Blockers

None for building and testing locally, once the devDependency is approved.
The live lane needs a Cloudflare account and: the **account id**; an **API
token** with account permissions *Workers KV Storage: Edit* and *D1: Edit*
(nothing else); one **KV namespace** and one **D1 database** made for tests
(their ids); and, to test the proxy transport live, permission to deploy one
Worker (*Workers Scripts: Edit*, or the user deploys it). Workers Paid
($5/month) removes the free plan's 1,000 KV writes a day, which a kit run may
exceed.

## Questions for the user

**Answered by the user on 2026-10-28: all nine as recommended** (the plan's
Status records it). PR-C10 built on them; the D1 driver is PR-C11.

1. **The devDependency.** Add `miniflare` **4.20260730.0** (exact; the
   `latest` tag, published 2026-07-30) to `packages/bun-cache`'s
   devDependencies? It brings workerd 1.20260730.1 and its binary, 26
   packages, 63 MB; nothing reaches a consumer. *Recommended: yes* — it is
   the only way to run the drivers against real KV and D1 semantics without
   an account.
2. **Transports.** Both the REST API and the binding proxy, through one
   client (*recommended*), or REST only (four operations a second, shared
   with Wrangler), or the proxy only (a deploy before first use)? The README
   would recommend the proxy for production.
3. **Shipping the proxy Worker.** *Recommended*: a source file in bun-cache
   with no Bun or Node imports, exported as a subpath, so a user's Worker is
   `export { default } from "@kingsleyweb/bun-cache/cloudflare-worker"` and
   `wrangler deploy` bundles it; the tests run the same file. The
   alternative is a `templates/` directory copied out, like the
   compute-provider template, which drifts from the driver's version.
4. **New names** (not in §21). *Recommended*: the subpath
   `./cloudflare-worker`; options `accountId`, `apiToken`, `namespaceId`
   (KV), `databaseId` (D1), `endpoint` (the proxy's URL; the REST API when
   absent), `prefix` (default `bun-cache`, §21's), with
   `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (Wrangler's own names)
   read when the options are absent, as the S3 driver reads `AWS_*`; types
   `CloudflareKvDriverOptions`, `CloudflareD1DriverOptions`; the proxy's
   Worker secret `BUN_CACHE_PROXY_TOKEN`; test variables
   `BUN_CACHE_TEST_CLOUDFLARE_ACCOUNT_ID`, `…_API_TOKEN`,
   `…_KV_NAMESPACE_ID`, `…_D1_DATABASE_ID`, `…_PROXY_URL`, `…_PROXY_TOKEN`.
5. **KV values**: raw bytes, `getMany` as parallel `GET`s (*recommended*: no
   size or CPU cost on the common path), or base64 text, so `getMany` is one
   `bulk/get` per 100 keys (a third larger values; the cap ~18.75 MiB)?
6. **Emulating KV's write rate in the tests.** A test-only switch in the
   harness (off by default, never in the shipped Worker) making the local
   proxy answer 429 on a second write to a key within a second, so the
   driver's retry path runs without an account? *Recommended: yes* — it is a
   documented Cloudflare behaviour that workerd does not reproduce, injected
   like the kit's `faulty`. Eventual consistency is not emulated; the README
   states it and the live lane observes it.
7. **D1's bus**: `"none"` in v1 (*recommended*), or the SQLite driver's
   polled table, through the proxy only?
8. **D1's entry cap**: 1,000,000 bytes in v1 (*recommended*: one hex
   parameter), or about 2 MB with split parameters and chunked reads?
9. **The live lane.** Will you provide, once, as for Upstash: the account id,
   an API token with *Workers KV Storage: Edit* and *D1: Edit*, a KV namespace
   and a D1 database for tests, and (optionally) a deployed proxy or
   *Workers Scripts: Edit*? *Recommended: yes*, before PR-C10 merges; Workers
   Paid only if a kit run exceeds the free plan's 1,000 KV writes a day.
