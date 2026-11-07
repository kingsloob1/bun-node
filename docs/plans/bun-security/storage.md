# bun-security: storage drivers for durable state

Sub-plan of [`README.md`](README.md). The user asked, on 2026-11-07
(through the coordinator):

> "The bun security plan can have adapters for permanent storage of the
> security configuration similar to bun jobs and bun cache."

This document designs a pluggable **storage-driver layer** for
bun-security's durable state, modelled on bun-jobs' and bun-cache's
drivers: what is durable and what is hot, the driver interface (optimistic
concurrency, capabilities, cursor pagination), reuse of the existing driver
code, the v1 drivers, change notification and last known good, schema sync,
encryption at rest, and a conformance kit. Marks are the README's (§0.3);
paths are at `36be4163`, relative to `packages/`.

### Contents

1. [Durable and hot](#1-durable-and-hot)
2. [What exists: two driver families, two schema syncs](#2-what-exists-two-driver-families-two-schema-syncs)
3. [The driver interface](#3-the-driver-interface)
4. [Reuse: a shared SQL module, not a fourth copy](#4-reuse-a-shared-sql-module-not-a-fourth-copy)
5. [Drivers in v1 and later](#5-drivers-in-v1-and-later)
6. [Change notification, signing and last known good](#6-change-notification-signing-and-last-known-good)
7. [Schema sync and migrations](#7-schema-sync-and-migrations)
8. [Encryption at rest](#8-encryption-at-rest)
9. [The conformance kit](#9-the-conformance-kit)
10. [PRs](#10-prs)

---

## 1. Durable and hot

| State | Kind | Lives in | Why |
|---|---|---|---|
| policies, rules, lists, limits, profiles, per-service and per-group overrides | **durable** | the **security store** (this document) | the source of truth; versioned; audited |
| policy versions and history; compiled, signed bundles | durable | security store | rollback, diff, agents' pull |
| services, groups, service identities, agent keys (hashes or public keys) | durable | security store | |
| operators, role bindings, approvals | durable | security store (when the built-in RBAC is used) | |
| alert channels and rules (webhook URLs and secrets encrypted, §8) | durable | security store | |
| **manual bans** and every ban's **history** (created, extended, lifted, by whom) | durable | security store | ConcaveHR keeps lifted rows as history (`removedAt`, `removedById`), write-up §2.3 |
| **active bans** (manual and automatic) | durable record **plus** a hot copy | the record in the security store; the active set in the hot store and in each EP's memory | the hot path never reads the durable store (ConcaveHR: "Hot path never writes Postgres", §4) |
| the audit log and its checkpoints | durable, append-only | security store (and the external sink, control-plane.md §6.2) | |
| analytics: minute counters, hourly and daily rollups, events and samples, exact refused counts | durable, high volume | the security store's **analytics tables** (same driver, separate tables; or a second store) | range queries over days |
| rate-limit counters, windows | **hot** | the throttle foundation's `ThrottleStore` (`cacheThrottleStore(cache)` over bun-cache) [F] | per-request, TTL-bound |
| counted-rule counters, offence scores, HLL distinct counts, short auto-bans before they are recorded | hot | bun-cache (the same cache the throttle store uses) | per-request |
| the live ring (analytics feed resume) | hot, per CP instance | memory | ui.md §6 |

**Can one driver serve both?** Yes in topology (a) and small (b): one SQLite
file can hold bun-cache's tables (its sqlite driver, `bun-cache/lib/drivers/sqlite.ts:421`)
[S] and the security store's tables, under different prefixes, so a single
service needs one file. In (c), **no**: hot state belongs in Redis (or the
throttle store's choice) for per-request latency, durable state in a SQL
database for queries, transactions and retention; mixing them puts the
analytics' range scans and the per-request counters on one server. The
security store's interface does not include hot operations, so the split is
enforced by the types.

---

## 2. What exists: two driver families, two schema syncs

| | bun-jobs | bun-cache |
|---|---|---|
| drivers | memory, file, SQL (Postgres, MySQL, MariaDB, SQLite), Redis, MongoDB (`bun-jobs/lib/drivers/create-driver.ts:36-73`) [S] | memory, file, sqlite, postgres, mysql, mariadb, redis, mongo, s3, azure, cloudflare-kv, cloudflare-d1, redundant (`bun-cache/lib/index.ts:68-112`) [S] |
| SQL layer | one driver over a `SqlDialect` per engine, four engines, ~2,000 lines (`drivers/sql/dialect.ts:15-25`); table definitions and renderers (`sql/schema.ts`, 1,096 lines); sync (`sql/sync.ts`, 545 lines); a collation guard (`sql/collation-guard.ts`) [S] | an abstract `SqlCacheDriverBase` (`drivers/sql-base.ts:176`, 509 lines) per engine; connection helpers (`drivers/sql-connection.ts`: URL defaults, MySQL's `allowPublicKeyRetrieval` as an option, transient-lock retry `withLockRetry` `:382`); table naming (`sql-tables.ts`) [S] |
| schema sync | `SchemaSyncOptions { add, indexes, alterColumns, dryRun }`, `SchemaChange { kind, table, target, statement, reason, blocking, applied }` (`drivers/schemaSync.ts:12-60`) [S]; the CLAUDE.md "Schema sync" contract | its **own** `SchemaSyncOptions { dryRun }` and `SchemaChange { description, applied, blocking? }` (`bun-cache/lib/core/types.ts:124-138`) [S] |
| change notification | driver events: Redis pub/sub, stored and polled events elsewhere; Postgres `LISTEN` as an arrival hint (`sql/arrivals.ts:48`) [S] | `CacheBus`: `redisBus`, `pgBus`, polled buses, at-most-once with `onGap` (`core/types.ts:106-121`, `bus/redis.ts:223`, `bus/pg.ts:135`) [S] |
| cursors | opaque keyset cursor bound to its walk (`drivers/pageCursor.ts:68`, `:99`) [S] | none (a cache does not list) |
| conformance kit | none exported (driver tests live in `__tests__`) | `runCacheDriverConformance` at `./testing` (`testing/conformance.ts:342`), a cross-process pass, a faulty-driver wrapper (`testing/faulty.ts`) [S] |
| encryption | none | AES-256-GCM envelope with a key ring and HKDF-derived name hashing (`core/encrypt.ts:526`, `core/names.ts`), **not exported** as a utility [S] |

So the repo already has two SQL layers with two incompatible schema-sync
shapes. A third, private copy in bun-security would make three.

---

## 3. The driver interface

### 3.1 Shape [D]

The store is **resource-oriented**, not a key-value store: the screens
need filtered, sorted, paginated lists, and the policy needs compare-and-set.

```ts
interface SecurityStoreDriver {
  readonly name: string;
  readonly capabilities: SecurityStoreCapabilities;
  connect(): Promise<void>;
  close(): Promise<void>;
  syncSchema?(options?: SchemaSyncOptions): Promise<SchemaChange[]>;

  // Documents: services, groups, policies (heads), service identities, agent keys,
  // operators, role bindings, alert channels, list entries, approvals.
  get(kind: DocKind, id: string): Promise<StoredDoc | undefined>;
  list(kind: DocKind, query: ListQuery): Promise<Page<StoredDoc>>;
  /** Optimistic concurrency: writes only if the stored revision equals `ifRevision` (`null`: must not exist). */
  put(kind: DocKind, id: string, doc: unknown, ifRevision: number | null): Promise<PutResult>;
  delete(kind: DocKind, id: string, ifRevision: number): Promise<boolean>;

  // Versions: append-only per policy, the head moved by compare-and-set.
  appendVersion(policyId: string, version: PolicyVersionRecord, expectedHead: string | null): Promise<AppendResult>;
  listVersions(policyId: string, query: ListQuery): Promise<Page<PolicyVersionRecord>>;
  putBundle(serviceId: string, bundle: SignedBundle, expectedVersion: number): Promise<AppendResult>;
  getBundle(serviceId: string, ifNoneMatch?: string): Promise<SignedBundle | "not-modified" | undefined>;

  // Bans: records with merge semantics, history kept.
  upsertBan(ban: BanRecord): Promise<BanRecord>;          // merge: later expiry wins, "until removed" beats a date, manual replaces automatic
  liftBan(id: string, by: Actor, at: number): Promise<boolean>;
  listBans(query: ListQuery & BanFilter): Promise<Page<BanRecord>>;

  // Audit: a chain, appended only after the head it extends.
  appendAudit(entry: AuditEntry, expectedPrevHash: string | null): Promise<AppendResult>;
  listAudit(query: ListQuery & AuditFilter): Promise<Page<AuditEntry>>;

  // Analytics.
  appendEvents(batchId: string, events: SecurityEvent[]): Promise<{ duplicate: boolean }>;
  addCounters(rows: CounterRow[]): Promise<void>;          // upsert-add by (scope, bucket, dimensions)
  listEvents(query: ListQuery & EventFilter): Promise<Page<SecurityEvent>>;
  series(query: SeriesQuery): Promise<SeriesPoint[]>;
  topK(query: TopKQuery): Promise<TopKRow[]>;
  rollup(from: Tier, to: Tier, until: number): Promise<number>;
  deleteBefore(table: RetainedTable, before: number, limit: number): Promise<number>;

  // Changes: a monotonic feed of what changed, for agents and the UI.
  changesSince(seq: bigint, limit: number): Promise<{ changes: Change[]; head: bigint }>;
  subscribe?(listener: (head: bigint) => void, onGap: () => void): () => void;
}
```

Every write returns the new `revision` (documents) or `seq` (changes); every
mutation also appends a `Change { seq, kind, id, revision }` in the same
statement or transaction, so `changesSince` never misses a write (an outbox,
not a separate notification that can be lost).

### 3.2 Optimistic concurrency [D]

Two operators editing the same draft must not overwrite each other: every
document carries a `revision` (an integer), every `put` names the revision it
read, and a mismatch answers `conflict` with the current document. The API
maps it to `409` with both versions; the UI shows a three-way diff and asks
the operator to rebase their change. Publishing is `appendVersion` with the
`expectedHead` the operator's draft was based on: a publish over someone
else's newer publish is refused the same way. The audit chain uses the same
primitive (`expectedPrevHash`), which keeps it linear even with two CP
instances.

Per engine: SQL `UPDATE … WHERE id = ? AND revision = ?` and an
`INSERT … ON CONFLICT DO NOTHING` for `null`; SQLite the same; MongoDB a
filtered `updateOne`; memory and file a compare in a lock. **No driver
needs multi-statement transactions** for correctness except where a
mutation and its `Change` row must land together; drivers with
`transactions: false` put the change in the same document (MongoDB) or use a
single statement with `RETURNING`.

### 3.3 Capabilities [D]

| Flag | Meaning | memory | SQLite | Postgres | MySQL/MariaDB | Redis | MongoDB |
|---|---|---|---|---|---|---|---|
| `durable` | survives a restart | no | yes | yes | yes | with persistence | yes |
| `multiProcess` | several processes on one host | no | yes (WAL) | yes | yes | yes | yes |
| `multiHost` | several hosts | no | no | yes | yes | yes | yes |
| `transactions` | a mutation and its change row atomically | yes | yes | yes | yes | Lua | single-document |
| `changeFeed` | `"push"` or `"poll"` | push (in process) | poll | push (`LISTEN/NOTIFY`) | poll | push (pub/sub) | push (change streams on a replica set), else poll |
| `analytics` | events, counters, rollups, range queries | yes (bounded) | yes | yes | yes | **no** (config and bans only) | yes |
| `cidrQuery` | an index answering "which entries contain this address" | trie in memory | no (scan by range columns) | yes (`inet`, GiST) | no | no | no |

The CP refuses a driver whose capabilities do not fit the topology (a
`memory` store under `connectAgent`, `multiHost: false` in (c)) with a
`ConfigError` naming the capability.

### 3.4 Pagination primitives [D]

Every `list*` takes `ListQuery { limit, cursor?, sort?, direction? }` and
returns `Page<T> { items, next?, previous?, totalEstimate? }`:

- **keyset** over `(sortKey, id)`, the cursor opaque and bound to the
  filter's hash (a cursor used with another filter is a 400), as bun-jobs'
  `encodePageCursor`/`decodePageCursor` already do (`drivers/pageCursor.ts:68`,
  `:99`) [S] — moved to the shared module (§4);
- `totalEstimate` only where it is cheap (a counter, a planner estimate),
  never a `COUNT(*)` per page;
- sort keys limited to indexed columns per kind (the driver declares them),
  so a list never scans.

---

## 4. Reuse: a shared SQL module, not a fourth copy

### 4.1 Options

| Option | For | Against |
|---|---|---|
| A. bun-security writes its own SQL layer | no coupling | a third SQL layer and a third schema sync; MySQL's key-retrieval quirk, transient-lock retries, collation checks re-learnt |
| B. depend on bun-cache's SQL layer (`sql-base.ts`, `sql-connection.ts`) | exists, four engines' connections | it is built for one entry table and counters, its `SchemaSyncOptions` is `{ dryRun }` only (no `add`, `indexes`, `alterColumns`), and its files are internals behind `./lib/drivers` |
| C. depend on bun-jobs' SQL layer (`sql/dialect.ts`, `sql/schema.ts`, `sql/sync.ts`) | the most complete: four engines, table definitions, a full schema sync with `alterColumns` and collation | it is inside bun-jobs; bun-security's control plane would install a job queue to get a schema renderer |
| **D. extract a shared module both can use** | one dialect layer, one schema sync contract (bun-jobs' richer shape), one connection helper, one keyset cursor | an extraction PR, and two follow-up PRs moving bun-jobs and bun-cache onto it |

### 4.2 Recommendation (Q22): option D [D]

A new, small package **`@kingsleyweb/bun-sql`** (name for approval):

- from **bun-jobs**: `SqlDialect` and the four dialects (`sql/dialect.ts`),
  table and index definitions and their renderers (`sql/schema.ts`), the
  sync engine (`sql/sync.ts`), the collation guard, `SchemaSyncOptions` and
  `SchemaChange` (`drivers/schemaSync.ts`), `encodePageCursor`/`decodePageCursor`
  (`drivers/pageCursor.ts`) [S];
- from **bun-cache**: the connection helpers (`drivers/sql-connection.ts`:
  URL defaults, `allowPublicKeyRetrieval` passed as an option, which Bun
  ignores in a URL per CLAUDE.md, `withLockRetry`) [S];
- a **MongoDB** schema-sync helper (indexes by name, the `RETIRED_INDEXES`
  rule from CLAUDE.md) with the MongoDB client loaded lazily, as bun-cache's
  mongo driver does (`drivers/mongo.ts:627-640`) [S].

No runtime dependency beyond `bun` and bun-common's `ConfigError`/`Mutex`.
bun-security depends on it from PR-D1. bun-jobs and bun-cache move onto it
in their own later PRs (each re-exporting what it exports today, so no public
change), which also unifies bun-cache's `SchemaSyncOptions` with bun-jobs'.
Until they move, the code exists twice, which is the state today for
bun-jobs and bun-cache anyway; the extraction does not make it worse and
stops a third copy.

Missing in both today, built in the shared module: a JSON-document column
type per engine for policy content (bun-jobs' `jsonType` exists,
`dialect.ts` [S]), an `inet`/CIDR column on Postgres (optional `cidrQuery`),
and a monotonic change sequence per store (an identity column or a counter
row).

**What stays per package**: the drivers themselves (their tables and
statements); the shared module is dialects, schema, sync, connections and
cursors, not a generic ORM.

---

## 5. Drivers in v1 and later

| Driver | v1 | Notes |
|---|---|---|
| `memoryStore()` | **yes** | tests, examples, topology (a) without persistence; bounded analytics |
| `sqliteStore({ path })` | **yes** | topology (a) and small (b): one file, WAL, `multiProcess`; covers the "file" case (a JSON-files driver adds nothing a SQLite file lacks, and SQLite has transactions and indexes) |
| `postgresStore({ url })` | **yes** | (b) and (c); `LISTEN/NOTIFY` change feed; `inet` for CIDR queries; what ConcaveHR uses (write-up §4) |
| `policyFile(path)` | **yes**, read-only source | GitOps: policies from a reviewed file in the app's repository, loaded as a read-only document set (the UI shows them locked, "from file") |
| `mysqlStore`, `mariadbStore` | later (~1.5 d with the shared dialects) | poll change feed |
| `redisStore` | later (~2.5 d) | config and bans only (`analytics: false`); for fleets that run no SQL |
| `mongoStore` | later (~3 d) | change streams on a replica set, polling otherwise |

The test servers exist: `bun scripts/setup-databases.ts` provides Postgres,
MySQL (3307), MariaDB (3306), Redis and MongoDB (CLAUDE.md) [S]; the suites
read `BUN_SECURITY_TEST_*_URL`, falling back to `BUN_JOBS_TEST_*_URL` as
bun-cache's do, skip visibly when unset and fail when set but unreachable.

---

## 6. Change notification, signing and last known good

- **Two ways an EP learns of a new configuration** [D]:
  1. **Through the CP** (topology (c), the default where the CP exists): the
     agent pulls its signed bundle with `ETag` and is nudged over the CP's
     channel (topologies.md §4).
  2. **Straight from the store** (topology (b), and ConcaveHR's model, where
     every service reads published state from one Redis, write-up §3–§4):
     the EP reads `getBundle(serviceId)` and subscribes to the store's change
     feed. The bundle is still the signed artefact the CP (or the in-process
     CP) wrote, so an EP verifies it the same way whichever path delivered it.
- **The feed**: `subscribe` where the driver has push (`LISTEN/NOTIFY` on
  Postgres, the same mechanism as bun-cache's `pgBus`,
  `bun-cache/lib/bus/pg.ts:135`; Redis pub/sub as `redisBus`) [S]; a poll of
  `changesSince(head)` every 250 ms where it has not (bun-cache's
  `DEFAULT_SQL_BUS_POLL_INTERVAL_MS`, `drivers/sql-base.ts:45`) [S]; and,
  whatever the driver, **a full reconcile every 60 s** (ConcaveHR's
  minute-by-minute republish, write-up §2.3, is what made a flushed Redis
  refill and expired blocks drop out everywhere within a minute).
- **Signing and versions**: control-plane.md §3. The store never holds a
  signing key; it holds signed bundles.
- **Last known good**: each EP writes every verified bundle and the active
  ban set atomically to a local file (`0600`) and loads it first at start.
  A store or CP outage then changes nothing about who is blocked
  (ConcaveHR's "keep the last known list", write-up §4, §8).

---

## 7. Schema sync and migrations

In the bun-jobs style, through the shared module's sync engine (CLAUDE.md
"Schema sync"):

- `syncSchema: true` on connect, or `await store.syncSchema(options)`, with
  `{ add, indexes, alterColumns, dryRun }`: adding columns and indexes and
  dropping the driver's own retired indexes by default; type changes only
  with `alterColumns` (they rewrite tables); `dryRun` returns the plan.
- Indexes named by the driver's convention, so only its own are dropped;
  MongoDB indexes dropped only from an explicit `RETIRED_INDEXES` list.
- A **baseline test** per driver: a freshly created schema reports no drift.
- **Data migrations** (a policy format change, `bun-security.bundle/1` → `/2`)
  are not schema sync: they run as versioned, idempotent steps recorded in a
  `migrations` table, each with a dry run, invoked by
  `bun-security migrate` or `store.migrate({ dryRun })`, never on connect.
- The audit table is created with grants that allow `INSERT` and `SELECT`
  only to the CP's role where the engine supports it (control-plane.md §6.2).

---

## 8. Encryption at rest

Sensitive fields: agent and service-identity secrets (when HMAC rather than
public keys), webhook URLs and their signing secrets, SMTP or provider
credentials referenced by the CP, the bundle signing key when CP-held,
break-glass TOTP seeds.

- **Reuse bun-cache's envelope** (AES-256-GCM, a key ring with ids, HKDF
  labels, rotation by adding a key, `core/encrypt.ts:526`) [S], which today is
  internal: PR-D3 exports it from bun-cache as a small `./encryption` entry
  (`sealField(value, ring, context)`, `openField(bytes, ring, context)`,
  the same ring format as `CacheEncryptWithKeys`), with a distinct HKDF label
  for bun-security so a key shared by mistake between the two never decrypts
  the other's data. Alternative: move it into the shared module; it is not SQL,
  so bun-cache is the better home.
- **Field-level**, not whole-row: the store's indexes and filters stay usable;
  each sealed field's associated data binds it to its table, row id and
  field name, so a sealed value copied to another row fails to open.
- Keys from the environment or a KMS hook; rotation re-seals lazily on write
  and by a `store.reseal()` job.
- Never encrypted, because never stored: CAPTCHA secrets and store URLs live
  in the EP's environment only (control-plane.md §8).

---

## 9. The conformance kit

`@kingsleyweb/bun-security/testing` exports
`runSecurityStoreConformance(factory, options)`, in bun-cache's style
(`runCacheDriverConformance`, `testing/conformance.ts:342`) [S]:

- every operation and its edge cases (empty pages, the last page, cursors
  bound to their filter, sort stability under concurrent inserts);
- **optimistic concurrency**: two writers racing `put` and `appendVersion`;
  exactly one wins, the other sees `conflict`;
- the audit chain under concurrent appends (never forked);
- ban merge semantics (later expiry wins, "until removed" beats a date,
  manual replaces an automatic reason, lifts kept as history);
- `appendEvents` idempotency by batch id;
- the change feed: no write without a change row; `changesSince` complete;
  `subscribe` delivering or reporting a gap;
- a **cross-process pass** (two processes on one store, as bun-cache's
  `crossprocess-worker.ts` does) for `multiProcess` drivers;
- a faulty-driver wrapper (timeouts, errors on chosen operations) for the
  EP's degraded-mode tests (bun-cache's `testing/faulty.ts` pattern);
- `syncSchema`'s baseline (no drift on a fresh schema) and a dry run.

A third-party driver passes the kit to be listed in the README.

---

## 10. PRs

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-D0** shared SQL module | `@kingsleyweb/bun-sql`: dialects, schema, sync, collation guard, connections, keyset cursors, the MongoDB sync helper; its own tests; packaging recipe | — | ~4 d |
| **PR-D1** store interface, memory, SQLite, conformance kit | `SecurityStoreDriver`, capabilities, `memoryStore`, `sqliteStore`, `policyFile`, `runSecurityStoreConformance` | PR-D0, PR-S1 | ~4.5 d |
| **PR-D2** Postgres | `postgresStore`, `LISTEN/NOTIFY` feed, `inet` CIDR queries, the conformance run | PR-D1 | ~2.5 d |
| **PR-D3** bun-cache `./encryption` | the field envelope exported; bun-security's field sealing | — | ~1 d |
| *later* | `mysqlStore`/`mariadbStore` ~1.5 d, `redisStore` ~2.5 d, `mongoStore` ~3 d; bun-jobs and bun-cache moved onto `bun-sql` ~2 d each | | ~11 d |
