# bun-security: topologies, shared state and failure modes

Sub-plan of [`README.md`](README.md). It designs the three deployments the
user asked for, explicitly:

- **(a)** one service;
- **(b)** several services on one system;
- **(c)** services across several systems.

For each it says where policy lives, how configuration reaches each
enforcement point, where counters, bans and reputation are shared, and what
happens when the control plane or the shared store is down. Marks are the
README's (§0.3). Every latency below is a **target, unmeasured** (README
§10).

### Contents

1. [Vocabulary](#1-vocabulary)
2. [The three topologies](#2-the-three-topologies)
3. [Shared state: counters, bans, scores](#3-shared-state-counters-bans-scores)
4. [Configuration distribution](#4-configuration-distribution)
5. [Events and analytics flow](#5-events-and-analytics-flow)
6. [Failure modes and degraded operation](#6-failure-modes-and-degraded-operation)
7. [Consistency and latency trade-offs](#7-consistency-and-latency-trade-offs)

---

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **Enforcement point (EP)** | the code in a service's process that runs the engine on each request: the bun-common middleware, the `Bun.serve` wrapper or the bun-nest module (README §3) |
| **Agent** | the part of an EP that talks to the control plane: fetches the policy bundle, ships events, reports health. In topology (a) it is a no-op |
| **Control plane (CP)** | the management API, the policy store, the audit log, the analytics store and its rollups, and the UI that sits on it. **Never on the public listener of a protected service** (README D3) |
| **Shared store** | where state shared between EPs lives: counters, active bans, offence scores. A bun-cache cache (README §2.2) |
| **Ban stream** | how a new ban reaches every EP: bun-cache's bus, or the CP's channel |
| **Policy bundle** | the compiled, versioned, signed policy for one service (control-plane.md §3) |
| **Scope** | global, a group of services, a service, a route prefix |

---

## 2. The three topologies

### 2.1 (a) A single service [D]

```
             internet
                │
   ┌────────────▼─────────────┐
   │  service process          │
   │  public listener :443     │──► EP (engine, local state)
   │  admin listener 127.0.0.1 │──► CP (management API + UI), in process
   └───────────────────────────┘
        state: memory, or SQLite file (survives restarts)
```

- **Policy lives** in the process: a policy file on disk (`policyFile`,
  JSON, unsigned allowed here) or the in-process CP's `sqliteStore`
  ([`storage.md`](storage.md)) when the UI is used.
- **Configuration reaches the EP** directly: the in-process CP calls
  `engine.load(bundle)`; a file is watched.
- **State**: `memory` (fastest; lost on restart, so an attacker's bans reset
  with a deploy) or bun-cache's `sqlite` driver, which survives restarts and
  has atomic increments and locks (`bun-cache/lib/drivers/sqlite.ts:421`,
  RETURNING upsert `:307`) [S]. Recommendation: memory for counters (a lost
  window costs little), SQLite for bans, scores and events (a reset ban list
  costs a lot).
- **CP on a second listener**, bound to loopback or an admin interface, on
  another port. `secureAdmin({ hostname: "127.0.0.1", port: 9443 })`
  starts a second `Bun.serve` in the same process. An operator reaches it
  through SSH forwarding, a VPN or a private network. The public listener
  never routes `/security/*`, so a bug in the public app's routing cannot
  expose it.
- **Analytics** in the same SQLite file; rollups by an in-process
  `BunRunner` schedule (`runMode: "single"`, `bun-jobs/lib/runner/types.ts:825`)
  [S], or a simple timer when bun-jobs is not installed.

### 2.2 (b) Several services on one system [D]

```
   ┌──── host ───────────────────────────────────────────┐
   │ svc A (EP+agent)   svc B (EP+agent)   svc C (EP+agent)│
   │        │                  │                  │       │
   │        └──── shared store: Redis on loopback ┘       │
   │              (or one SQLite file in WAL mode)        │
   │        └──── CP process (admin listener, loopback) ──┘
   └──────────────────────────────────────────────────────┘
```

- **Policy lives** in the CP, a separate process on the host (`bun-security
  control` as a small entry point, or embedded in one designated service;
  recommendation: a separate process, so restarting a service never takes
  the CP down, and the CP holds no public listener).
- **Configuration**: either straight from the shared security store (each
  EP reads its signed bundle and follows the store's change feed,
  storage.md §6; ConcaveHR's model, where every API reads state account-api
  published to one Redis, write-up §3), or each agent pulls its bundle from
  the CP over loopback HTTP (or a Unix socket, `requestIP()` is `null` there and peer identity is
  the socket's file permissions [M, `evidence/client-ip/`]) with `ETag`;
  the CP nudges agents through the shared store's bus (`policy:<service>`
  invalidation) so a change lands in about the bus latency instead of the
  poll interval.
- **Shared store**:
  - **Redis on loopback** is the recommendation: atomic Lua counters
    (`bun-cache/lib/drivers/redis.ts:487-505`) [S], pub/sub for the ban
    stream (`bun-cache/lib/bus/redis.ts`) [S], HyperLogLog natively.
  - **SQLite in WAL mode**, one file shared by the processes, when no Redis
    is wanted: bun-cache's sqlite driver is `multiProcess` with a polled bus
    (250 ms) [S, survey]. Counters through its atomic upsert. Good for a few
    hundred decisions a second per host [I, unmeasured]; the hybrid mode
    (§3.2) keeps the per-request path off the file.
  - `memory` is **not** valid in (b) for anything shared (bun-cache's memory
    driver is `multiProcess: false`) [S]; the engine refuses a policy that
    asks for shared limits on a single-process store.
- **Analytics**: agents write events to the CP (batched HTTP) or straight
  into the analytics store; one rollup job on the CP.

### 2.3 (c) Services across several systems [D]

```
                       ┌──────────── admin network ───────────┐
                       │  CP (HA pair) ── policy DB (Postgres) │
                       │      │   └──── analytics DB (Postgres)│
                       │  UI ─┘    rollup + alert jobs (bun-jobs)
                       └──────▲────────────────▲───────────────┘
       signed bundles (pull+nudge) │ events (batched, signed)
   ┌─── region 1 ──────────────────┼───┐   ┌─── region 2 ──────┐
   │ svc A EP+agent  svc B EP+agent │   │   │ svc D  svc E       │
   │        └── regional Redis ─────┘   │   │  └── regional Redis│
   └────────────────────────────────────┘   └────────────────────┘
```

- **Policy lives** in the CP's security store (`postgresStore`, or SQLite
  for a small fleet; [`storage.md`](storage.md)), versioned and audited
  (control-plane.md §3, §6).
- **Configuration** reaches each EP as a **signed bundle, pulled** by the
  agent over HTTPS with `If-None-Match` every 30 s, plus a **nudge** over a
  long-lived channel (a `defineChannel` WebSocket or SSE from the CP,
  README §2.1) so a change lands within seconds. Pull is the source of truth;
  the nudge is an optimisation, so a lost nudge costs at most one poll
  interval. The agent authenticates to the CP with a per-agent key (signed
  requests; mTLS optional, control-plane.md §6).
- **Shared state** is **regional**: each region (or each data centre) has
  its own Redis. Counters are regional; a global limit is approximated as
  the sum of regional ones (§7). **Bans are global**: an auto-ban in region
  1 is written to region 1's store, shipped to the CP as an event, and the
  CP republishes it to every region whose scope covers it (the CP's
  `bans` channel, or a write to each regional store); target: every region
  within 5 s (unmeasured).
- **Analytics**: events shipped to the CP in batches (≤ 1 s or ≤ 500 events,
  whichever first), stored in the analytics DB, rolled up by bun-jobs workers
  on the CP side (README §8).
- **Time**: signatures, ban expiries and counter windows need clocks within
  a few seconds. bun-cache's Redis driver takes the client's clock
  (`String(this.#now())` passed to the script, `redis.ts:1236`) [S], so a
  counter's window starts by whichever service's clock created it. PR-P3
  uses store time in its new scripts; the throttle foundation's
  `cacheThrottleStore` inherits bun-cache's choice (README §20); the docs
  require NTP either way.

### 2.4 Mixed

One CP can manage all three shapes at once: a service is a service whatever
its host. Service groups (control-plane.md §2.2) are orthogonal to topology: a group
"payments" can span regions.

---

## 3. Shared state: counters, bans, scores

### 3.1 What exists, and what bun-security adds [S] [F]

**Rate-limit counters are the throttle foundation's** (layers.md L9.1):
its `ThrottleStore`, bounded memory store and bun-cache's
`cacheThrottleStore(cache)` share limits across processes and instances
[F]. bun-security puts its other hot state in the **same bun-cache cache**,
so one Redis (or one SQLite file) serves both. Durable state (policies,
history, audit, analytics) is the security store's ([`storage.md`](storage.md)).

| Need | bun-cache today | Gap |
|---|---|---|
| counted-rule counters ("N in W s") | `cache.increment(key, by, { ttl })`, expiry set at creation, a fixed window (`core/types.ts:233-242`, `:1079`) — exactly ConcaveHR's `INCR` + `EXPIRE NX` (write-up §2.3) | none |
| counters never evicted by `maxEntries` | yes (`drivers/entry-cap.ts:10`) | — |
| offence scores | `set`/`get` with TTL | read-modify-write races are acceptable (a score is approximate); no gap |
| set-if-absent, compare-and-set | not found | GCRA (only if the throttle foundation lacks a sliding algorithm, layers.md L9.2) |
| distinct counts (HLL) | not found | PR-P3 adds `pfAdd`/`pfCount` |
| locks | driver-level only; no public `cache.lock()` | none needed on the hot path; jobs use bun-jobs' `runMode: "single"` |
| per-entry TTL, `touch` | yes (`types.ts:834`, `:204`) | — |
| invalidation bus across processes | `redisBus`, `pgBus`, polled buses; at-most-once with `onGap` (`types.ts:106-121`) | carries keys and tags, not values: enough for "bans changed, reload since v" |
| failure policy | reads miss, writes fall back, circuit breaker; **`increment` throws on failure** (`core/cache.ts:3041-3082`) | good: the engine decides per rule (§6) |

**So PR-P3** (README §15) adds to bun-cache, as a driver capability,
HyperLogLog (`pfAdd`/`pfCount`: Redis natively; a 12 KB register array under
a CAS loop on memory and file; an upsert of a merged sketch on SQL) with a
conformance case, and server time for its Redis scripts (the counter script
takes the client's clock today, `drivers/redis.ts:1236`) [S]. A GCRA
operation joins it only if the throttle foundation ships fixed windows only.

### 3.2 Three state modes per limit [D]

The modes are expressed through the foundation's stores, not a second
limiter:

| Mode | How | Accuracy | When |
|---|---|---|---|
| `local` | the foundation's memory store | exact per process; across N processes the effective limit is up to N× | (a); anything where "per instance" is acceptable |
| `shared` | `cacheThrottleStore(cache)`: one store round trip | exact across the scope | auth endpoints, OTP, payment: low rate, high value |
| `hybrid` | a memory store at the local share, synced in batches to the shared store every `syncMs` (250 ms) | approximate: overshoot bounded by about `rate × syncMs × nodes` | high-rate global per-IP limits in (b) and (c); built in bun-security as a `ThrottleStore` that wraps the two (no new API) |

The default per limit: `shared` for profiled sensitive routes (layers.md
L11), `hybrid` for the global per-IP limit, `local` in (a).

### 3.3 Bans and scores [D]

- **Bans**: the durable record (with history) is in the security store
  (storage.md §1); the hot store holds the authoritative active set (`ban:<scope>:<subject>`
  entries with TTL). Every EP keeps a local copy (exact map + CIDR trie,
  layers.md L4) loaded at start and kept current by the **ban stream**: in
  (a) in process; in (b) bun-cache's bus message ("bans changed since
  version v") followed by a delta read (`bans:log` entries since v); in (c)
  the CP's `bans` channel carrying the records themselves, signed, with a
  `{ epoch, seq }` cursor for resume (the live-invalidation pattern,
  `bun-common/lib/live/server.ts:498`) [S]. A gap triggers a full reload, and
  every EP reconciles the full set every 60 s anyway (ConcaveHR's minute
  republish, write-up §2.3).
- **Offence scores** are stored as `{ score, updatedAt }` and decayed on
  read; writes are `shared` for profiled routes and `hybrid` otherwise.
- **Reputation across services** (an IP banned by service A is challenged by
  service B): a ban's scope decides it. The default auto-ban scope is the
  **group** of the service that banned (Q6), not global: a false positive in
  one product then does not lock a customer out of all of them.

---

## 4. Configuration distribution

- **Pull with `ETag`, nudged by push.** Pull is simple to secure (the agent
  initiates, the CP needs no route into the service network), and survives
  any number of missed pushes. The nudge makes it fast.
- **Versioned**: each bundle has a monotonically increasing `version` per
  service and the `policyVersionId` it was compiled from. An agent refuses a
  bundle whose version is lower than the one it runs, except a signed
  `rollback` bundle (which carries a higher version number whose content is
  an older policy), so replaying an old bundle cannot downgrade a service
  (control-plane.md §3.3).
- **Signed**: Ed25519 over the bundle's canonical bytes, by a signing key the
  CP holds (or an offline key, control-plane.md §6.3). Bun supports Ed25519
  through `crypto.subtle` and `node:crypto` [M, `evidence/crypto/`]. The
  agent verifies before loading; a bad signature keeps the last good bundle
  and raises a `critical` alert.
- **Last known good on disk**: the agent writes each verified bundle
  atomically to a local file (`0600`) and loads it at start, before talking
  to the CP. A service therefore starts protected while the CP is down.
- **Artefacts**: IP-intel files (layers.md L5) are distributed the same way,
  as content-addressed artefacts the bundle references by SHA-256.
- **Bootstrap**: a service with no cached bundle and no CP starts with the
  **baseline policy** compiled into its code (`createSecurity({ baseline })`,
  defaults: the L1/L2/L6 hardening and the global per-IP limit), never with
  nothing.

---

## 5. Events and analytics flow

```
EP decision ─► local ring (bounded, 10,000 events) ─► agent batcher ─► CP /ingest ─► analytics store
                         │                                                    └─► live hub ─► UI
                         └─► local counters (per minute, per rule/route/outcome) ─► shipped with the batch
```

- Every non-`allow` decision is an event; `allow`s are counted, and sampled
  into events at `allowSample` (default 0.1%).
- The ring drops the oldest on overflow and counts drops (an attack must not
  turn the defence into a memory leak, control-plane.md §7).
- Batches are signed (§6 of control-plane.md) and idempotent (a batch id), so
  a retry after a timeout does not double-count.
- **Pre-aggregation at the edge**: the agent also ships per-minute counters
  (requests, by outcome, per rule, per route), so the analytics charts stay
  exact even when events are sampled or dropped.

---

## 6. Failure modes and degraded operation

### 6.1 Per rule: `onStoreError` [D]

| Value | Meaning | Default for |
|---|---|---|
| `local` | fall back to the EP's local state at the local share of the limit (limit ÷ expected EP count, floored at 1) | every limit (the recommended default, Q4) |
| `open` | allow, record `store-error` | none by default; for limits whose false positive is worse than the abuse |
| `closed` | answer `503` with `Retry-After` | admin and payment profiles, opt-in |

The engine never waits on a sick store: the per-operation timeout is 50 ms
(bun-cache's `timeout` option, `types.ts:1198`) [S], and bun-cache's circuit
breaker (5 failures, 30 s cooldown, `core/cache.ts:474-580`) [S] turns a dead
store into an immediate fallback instead of 50 ms per request.

### 6.2 Component down: what still works [D]

| Down | Effect | Degraded behaviour |
|---|---|---|
| **Control plane** | no policy changes, no UI, no analytics ingestion | EPs keep enforcing the last good bundle; events queue in the ring (and spill to a bounded local file, optional), drops counted; agents back off 1 s → 60 s; nothing about request handling changes |
| **Shared store** | shared counters, ban writes, score writes fail | limits per `onStoreError`; bans: the local copy keeps enforcing; new auto-bans apply locally and are queued for the store (bounded); a `critical` alert after 30 s |
| **Bus / ban stream** | no push of new bans or policy nudges | pull continues (bundles every 30 s, ban deltas every 5 s by poll); bun-cache reports the gap (`onGap`) and the EP reloads in full on recovery |
| **IP-intel file missing or stale** | country/ASN rules cannot evaluate | rules using them evaluate as "unknown"; each such rule has `onUnknown` (default: skip, log once a minute) |
| **Challenge provider** (Turnstile etc.) | challenges cannot be verified | fall back to the built-in PoW if configured, else the rule's `challengeFallback` (`block` by default for sensitive routes, `allow` + tag elsewhere) |
| **The engine throws** (a bug) | — | the middleware catches, allows the request, logs `error`, counts it; `failClosedOnEngineError` opt-in. A defence bug must not take the site down |

### 6.3 Fail-open or fail-closed by default (Q4)

Recommendation: **degrade to local, never wholly open or closed by
default**. Pure fail-open hands an attacker a switch (knock the store over,
then attack); pure fail-closed turns a Redis blip into an outage. `local`
keeps a per-process limit in force, which bounds the abuse at N× and costs
no availability.

---

## 7. Consistency and latency trade-offs

| Choice | Consistency | Hot-path cost (target, unmeasured) |
|---|---|---|
| bans, allow/deny lists | eventually consistent, ≤ 1 s on a healthy bus in (b), ≤ 5 s across regions in (c) | a local lookup, no I/O |
| `local` limits | exact per process | no I/O |
| `hybrid` limits | approximate, bounded overshoot | no I/O on the request; a batched sync every 250 ms |
| `shared` limits | exact within a store | one round trip: target ≤ 1 ms p99 on loopback Redis, ≤ 3 ms on a LAN |
| global limits in (c) | the sum of regional limits; a region cannot see another's burst until the next sync | — |
| policy changes | seconds (nudge) to 30 s (poll) | none on the request |

A request never makes more than **one** store round trip in the engine,
whatever the number of rules: shared limits for one request are evaluated in
one pipelined call (a Lua script taking several keys, or one SQL statement).
