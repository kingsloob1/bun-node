# bun-security: a defence layer for bun-node services, its control plane, and a management UI

Plan for a new package, **`@kingsleyweb/bun-security`**: a request-defence
engine (rate limits, bans, allow and deny lists, request-shape limits,
WAF-style rules, bot challenges, honeypots and canaries, protection of login,
OTP, signup and payment endpoints, API-key abuse detection, security headers
and CSRF) usable as bun-common middleware, as a bun-nest module and around
a plain `Bun.serve`; a **control plane** that configures it across one
service, several services on one system, or services across several
systems; and a management UI with a live **analytics page**, the
**`/security`** entry of **`@kingsleyweb/bun-ui`** (the user's decision of
2026-11-08, [`bun-ui`](../bun-ui/README.md)). The user asked, on 2026-11-07:

> "Due to some bad actors attempting to attack concavehr, we had to implement
> a robust defence. ... have an agent draft out a robust plan to make it a
> plugin both for the api and to have a robust management ui to configure the
> defence layer across multiple services in different systems or multiple
> services in the same system or single service. There should also be an
> analytic page with different components that is properly paginated if it is
> a list, with live update showing the activity. I want this as a separate
> package probably under bun-security to ensure bad actors have no access to
> critical web servers. You can recommend more secure measures to be added in
> the plan, and other packages in the mono repo can be used to achieve the
> package's intended result."

**Status: approved by the user on 2026-11-07, every open question (§16) answered with its recommendation as written. Not started: building M1 waits for the user's go-ahead.** The foundations it builds on are trustProxy (merged, #653) and the throttle (merged as three PRs, T1 #654, T2 #655 and T3 #656). **Changed on 2026-11-08:** the management UI is no longer a package of its own, `@kingsleyweb/bun-security-ui`, but the `/security` entry (with `/security/browser`) of `@kingsleyweb/bun-ui`, because the user decided that every bun-node UI lives in one package ([`bun-ui`](../bun-ui/README.md), approved 2026-11-08; its §7 lists every edit made here). No security decision changed; PR-U1 drops to ~4 d and the optional shared-module PR (Q14) becomes bun-ui's BU-4.

Written 2026-11-07 against `develop` at `36be4163`, on Bun 1.4.4-canary.1
(`11c367163`). **No product code was changed.** Every `file:line` is at
`36be4163` and relative to `packages/` unless it says otherwise. The spikes
are in [`evidence/`](evidence/README.md); none measures speed (the standing
rule: no benchmarks or speed comparisons without the user's yes).

### Status (2026-11-10)

| Part | State |
|---|---|
| This plan and its sub-plans | **approved** by the user on 2026-11-07 (above); nothing of the package built |
| ConcaveHR's write-up of its defence | **folded in** (§12, received 2026-11-07): every layer mapped, its lessons carried into the design and §14 |
| Foundations built beside this plan (§2.6) | the **trust-proxy client IP**, merged 2026-11-07, #653, and the **throttle plugin**, merged 2026-11-08 as T1 #654, T2 #655 and T3 #656 (follow-ups #669, #670, #672, #673, #675, #703), both requested by the user. bun-security builds on them (§20 lists what it needs from them) |
| Storage drivers for durable state ([`storage.md`](storage.md)) | added 2026-11-07 at the user's request |
| Prerequisites in other packages (§15.1) | not started |
| The UI's package | **changed 2026-11-08**: bun-ui's `/security` entry instead of `@kingsleyweb/bun-security-ui` (the user's single-UI-package decision, [`bun-ui`](../bun-ui/README.md) §7) |

### Contents

0. [How to read this plan](#0-how-to-read-this-plan)
1. [Executive summary](#1-executive-summary)
2. [What exists today, and what is missing](#2-what-exists-today-and-what-is-missing)
3. [Packages and where the engine hooks in](#3-packages-and-where-the-engine-hooks-in)
4. [The engine](#4-the-engine)
5. [Topologies and the policy model](#5-topologies-and-the-policy-model)
6. [Securing the defence itself](#6-securing-the-defence-itself)
7. [The management UI](#7-the-management-ui)
8. [Analytics data: events, rollups, retention, budgets](#8-analytics-data-events-rollups-retention-budgets)
9. [Observability and alerting](#9-observability-and-alerting)
10. [Performance budgets (targets, unmeasured)](#10-performance-budgets-targets-unmeasured)
11. [Testing strategy](#11-testing-strategy)
12. [ConcaveHR's defence, mapped](#12-concavehrs-defence-mapped)
13. [Measures recommended beyond ConcaveHR's](#13-measures-recommended-beyond-concavehrs)
14. [Risks](#14-risks)
15. [PR slicing, effort and the v1 cut](#15-pr-slicing-effort-and-the-v1-cut)
16. [Open questions for the user](#16-open-questions-for-the-user)
17. [Names needing approval](#17-names-needing-approval)
18. [Findings outside this plan](#18-findings-outside-this-plan)
19. [Sources](#19-sources)
20. [What bun-security needs from the two foundations](#20-what-bun-security-needs-from-the-two-foundations)

Sub-plans:

- [`layers.md`](layers.md) — the defence layers L1–L14 in request order,
  with defaults, actions, escalation, expiry and the v1 cut per layer.
- [`topologies.md`](topologies.md) — (a), (b), (c); shared state; config
  distribution; failure modes; consistency.
- [`control-plane.md`](control-plane.md) — the policy model and
  inheritance, bundles and rollback, the management API, RBAC, step-up,
  approvals, the audit log, agent authentication, secrets, self-DoS bounds.
- [`storage.md`](storage.md) — the security store: durable vs hot state,
  the driver interface with optimistic concurrency and cursors, a shared SQL
  module instead of a third copy, v1 drivers, change feeds and last known
  good, schema sync, encryption at rest, the conformance kit.
- [`ui.md`](ui.md) — bun-ui's `/security`: screens, pagination, live updates,
  the analytics page, tests.

---

## 0. How to read this plan

### 0.1 Words

**EP** (enforcement point): the engine in a protected service's process.
**Agent**: the EP's link to the control plane. **CP** (control plane): the
management API, policy store, audit log, analytics store and UI.
**Bundle**: a compiled, signed, versioned policy for one service. **Scope**:
global, a group of services, a service, a route prefix. **Subject**: what a
rule keys on (an IP or /64, a user, a username, an API key, a device).

### 0.2 Plans this one cites

**BC** is [`bun-cache/README.md`](../bun-cache/README.md), **TC** is
[`typed-client/README.md`](../typed-client/README.md), **OT** is
[`opentelemetry/README.md`](../opentelemetry/README.md), **BNR** is
[`bun-native-routes/README.md`](../bun-native-routes/README.md).

### 0.3 Marks

| Mark | Meaning |
|---|---|
| **[S]** | Read in this repo's source at `36be4163`; the `file:line` is given |
| **[M]** | Measured here by a spike that can be re-run; the evidence file is named (behaviour only, never speed) |
| **[V]** | Read in a third party's docs or spec, linked in §19, read 2026-11-07 |
| **[I]** | Inference. A claim to test, never a finding |
| **[U]** | Unverified. Nothing may rest on it |
| **[D]** | A design decision this plan proposes |
| **[F]** | A foundation being built beside this plan (trust proxy, throttle), as the coordinator's brief and the building agent's progress file describe it; not yet code on develop. Re-check against the branch before relying on it |

---

## 1. Executive summary

### 1.1 The one-paragraph answer

**A small engine runs in each protected service and decides every request
locally, from a signed policy bundle and local state, on top of two
foundations being built now (trusted-proxy client identity and a throttle
plugin); a separate control
plane, never on a public listener, owns the policy, the audit log and the
analytics; a UI (bun-ui's `/security` entry) talks only to the control plane.** The
engine evaluates fourteen layers in request order (connection limits,
trusted-proxy identity, lists, bans, IP intelligence, request shape, rules,
deception, rate limits, bot signals and challenges, sensitive-endpoint
profiles, API keys, response controls, outcome signals), each with a
dry-run mode, producing one of eight actions (allow, log, tag, delay,
challenge, block, ban, drop) and feeding a decaying offence score that
escalates to bans with growing durations. State is local in a single
service, shared through bun-cache (Redis, SQL, SQLite) between services, and
regional with global bans across systems; bans are always a local lookup,
and at most one store round trip is spent per request. When the store or the
control plane is down, the engine degrades to per-process limits and the
last good bundle rather than failing open or closed. The control plane is a
bun-common router with bun-contract schemas, so its OpenAPI and AsyncAPI
documents are generated and the UI's calls are typed by bun-client; it has
RBAC, step-up for destructive changes, optional two-person approval, a
hash-chained audit log with external checkpoints, and signed,
replay-protected agent traffic. The analytics page reads per-minute rollups
built by bun-jobs, paginates every list with keyset cursors, and updates live
over a typed channel with SSE fallback, coalesced and resumable.

### 1.2 The decisions

| # | Decision | Why |
|---|---|---|
| D1 | **The engine package and a UI entry**: `@kingsleyweb/bun-security` (engine, adapters, control plane, agent) and the management UI as `@kingsleyweb/bun-ui/security` (with `/security/browser`), bun-security an optional peer of that entry only ([`bun-ui`](../bun-ui/README.md); the user's decision of 2026-11-08). bun-nest's integration is a `./security` subpath **in bun-nest**, bun-security an optional peer | the protected services never install the UI's React bundle or its build **through bun-security**, which never depends on bun-ui; bun-nest already hosts `./cache` and `./jobs` this way (`bun-nest/package.json` exports) [S]. ui.md §1 |
| D2 | **The engine decides locally**: policy from a bundle in memory, bans and lists as in-memory structures, at most **one** store round trip per request (shared limits pipelined) and zero for bans | a defence that waits on the network for every request is a new single point of failure and a latency tax. topologies.md §3, §7 |
| D3 | **The control plane never runs on a protected service's public listener**: a second listener on loopback or an admin interface in (a), its own process on an admin network in (b) and (c); agents only pull | the user's "bad actors have no access to critical web servers". control-plane.md §1 |
| D4 | **Client identity is the trust-proxy foundation's `req.ip`** (Express's `trust proxy`, off by default, presets only through a trusted chain) [F]; bun-security keys IPv6 by /64, adds **service identity** (a verified service credential, never an address) and detects a wrong trust configuration | a default `Bun.serve` listener reports IPv4 clients as `::ffff:a.b.c.d` [M]; bun-common's `req.ips` reads `X-Forwarded-For` unconditionally today (`bun-common/lib/BunRequest.ts:5372`) [S]; ConcaveHR blocked its own service by address and keyed on the wrong hop (write-up §6, §8). layers.md L2 |
| D5 | **Policy is data** (JSON validated by Standard Schemas, compiled per service), never user code; hooks only for what only the app knows (`identify`, `signal`, challenge providers, step-up) | it can be signed, diffed, versioned, rolled back, tested in the UI and validated before it runs |
| D6 | **Rate limiting is the throttle foundation's** (`throttle()`, `ThrottleStore`, `cacheThrottleStore`) [F]; bun-security drives it from policy (keys, several limits per route, run-time updates, dry run), turns 429s into events, and adds `local`/`shared`/`hybrid` modes as stores, WebSocket message limits and HLL distinct counts | no second limiter API; ConcaveHR's per-instance throttler and its unit bug (write-up §4, §8) are fixed once, in the foundation. layers.md L9, topologies.md §3 |
| D7 | **Degrade to local by default** (`onStoreError: "local"`), `open` and `closed` per rule | fail-open hands an attacker a switch; fail-closed turns a Redis blip into an outage. topologies.md §6 |
| D8 | **Configuration is pulled with `ETag`, nudged by push, versioned monotonically, signed with Ed25519, cached on disk as last known good**; rollback is a new, higher version | Bun has Ed25519 in `crypto.subtle` and `node:crypto` [M]; a replayed old bundle is refused. control-plane.md §3 |
| D9 | **Every rule has a dry run** (`log` with `wouldHaveBeen`), new rules start in it, and the UI estimates a draft's impact on recorded traffic | enforcing an untested rule in an attack is how defences cause outages. layers.md §0.4, ui.md §4.4 |
| D10 | **Escalation by a decaying offence score** feeding a ladder, ban durations growing geometrically per subject | thinly spread abuse never trips one rule; a shared score sees it. layers.md §0.2 |
| D11 | **No hard account lockout on failure counts**: device cookies, per (username, device) counters, soft locks with a challenge and a second factor | OWASP: lockout can deny the account's owner [V]. layers.md L11.4 |
| D12 | **Regexes only through a safety validator** (no backreferences, lookarounds, nested quantifiers; capped input); globs and literal matchers preferred | JavaScriptCore backtracks and JavaScript has no regex timeout; ReDoS [V]. layers.md L7 |
| D13 | **Challenges are provider-neutral**: a `ChallengeProvider` interface, a built-in proof of work, Turnstile and hCaptcha adapters over `fetch`, a signed clearance cookie | no SDK dependency; server-side verification is mandatory and tokens are single-use [V]. layers.md L10 |
| D14 | **No IP-intelligence data ships in the package**; an in-package MMDB reader; data downloaded by the operator, distributed by the CP as signed artefacts | the licences (CC BY 4.0, CC BY-SA 4.0, GeoLite2's EULA) must not flow to every npm consumer [V]. layers.md L5 |
| D15 | **The management API is a bun-common router declared with bun-contract schemas**, documented by `generateOpenApi`/`generateAsyncApi` and called by the UI through bun-client | the repo already has every piece (§2); the UI is then type-checked against the server |
| D16 | **bun-security owns no identities**: `authenticate` is required, RBAC roles are built in but replaceable by `authorize`, step-up is a hook to the host's MFA | the CP plugs into the host's SSO; a `ConfigError` without `authenticate`, as `liveInvalidation` requires `authorize` (`bun-common/lib/live/server.ts:502`) [S]. control-plane.md §5 |
| D17 | **A hash-chained audit log with signed checkpoints written outside the CP**; dangerous changes need step-up and, optionally, a second operator | tamper evidence that survives a compromised CP database. control-plane.md §6 |
| D18 | **Agent traffic is signed (bun-jobs' envelope: HMAC, timestamp, nonce, direction in the MAC), mTLS optional**; an agent key reaches its own service only | the envelope exists and is tested (`bun-jobs/lib/remote/signing.ts:463`) [S]. control-plane.md §7 |
| D19 | **Every list is server-paginated by keyset cursor; live updates are server-aggregated (≤ 1 message a second per counter topic, ≤ 20 feed events a second), coalesced, and resumable by `{ epoch, seq }`** | bun-jobs' cursor and hub are the model (`bun-jobs/lib/drivers/pageCursor.ts`, `api/ws/hub.ts:120`) [S]. ui.md §5, §6 |
| D20 | **Analytics from per-minute counters shipped by each EP, plus sampled events**; hourly and daily rollups by a bun-jobs schedule; retention tiers | exact charts even when events are sampled; bun-jobs' metrics use the same bucket model (`bun-jobs/lib/drivers/metrics.ts:1-30`) [S]. §8 |
| D21 | **Every bound is explicit** (keys, bans, events, delays, logs, rules, bundle size) | the defence must not become the attack (control-plane.md §9) |
| D22 | **Durable state goes through pluggable security-store drivers** (memory, SQLite, Postgres in v1; MySQL/MariaDB, Redis, MongoDB later) with optimistic concurrency, keyset cursors, a change feed, bun-jobs-style `syncSchema`, field encryption from bun-cache, and a conformance kit; built on a **shared SQL module** extracted from bun-jobs and bun-cache | the user's request; two SQL layers with two schema-sync shapes already exist (`bun-jobs/lib/drivers/schemaSync.ts:12`, `bun-cache/lib/core/types.ts:124`) [S]. storage.md |
| D23 | **Counted rules ("N events in W s per key → ban B") are first-class**, with per-group and per-service overrides, beside the offence score and the escalation ladder | ConcaveHR ran on seven of them and operators read them at a glance (write-up §2.3); layers.md §0.2 |
| D24 | **Checks run where data is created, not only on routes**: `security.check(req, kind, value)` from services, the route profile as a convenience | ConcaveHR's actor returned through team invites, a path no auth route guarded (write-up §1, §8). layers.md L11.7 |
| D25 | **The integration asserts itself at boot**: each adapter's install sends a socket-free self-test request through `fetch()` and fails start-up if the engine did not see it | ConcaveHR's pay-api ran with no throttling because a pipe was registered as the guard (write-up §8). §3.3 |

### 1.3 What it costs

| Part | Effort | Depends on |
|---|---|---|
| The two foundations (trust proxy, throttle) | **not counted here**: built separately, at the user's request | — |
| Prerequisites in bun-common, bun-cache (PR-P2 to P4) | ~5.5 d | — |
| Storage: the shared SQL module, the store interface, memory, SQLite, Postgres, field encryption (PR-D0 to D3) | ~12 d | — |
| The engine and adapters, bun-nest `./security` (PR-S1 to S11) | ~37 d | the foundations, PR-P2, P3, D1 |
| The control plane and agent (PR-CP1 to CP7) | ~25.5 d | PR-S1, S4, P4, D1 |
| The UI (PR-U1 to U6) | ~27 d | PR-CP2, CP5 |
| Topology and attack test harnesses, examples, playground (PR-T1, T2, X1, X2) | ~13 d | each |
| **Total** | **~120 d**, plus ~1.5 d optional (the OTel bridge once OT lands) and ~11 d of later drivers; the shared UI-server module is bun-ui's BU-4 | |

Focused days for someone who knows the code; §15 has the order.

### 1.4 The v1 cut

v1 is three milestones, each usable on its own (§15.6):

- **M1, the engine** (~56 d with the prerequisites, the SQLite store and
  examples): topologies (a) and (b) with a policy file or a SQLite store,
  every v1 layer of [`layers.md` §15](layers.md#15-what-is-v1-and-what-is-later),
  bun-common, `Bun.serve` and bun-nest adapters, shared state on Redis and
  SQL. **ConcaveHR could adopt it here**: everything its three APIs do on the
  request path maps onto M1 (§12); its admin API and insights page map onto
  M2 and M3.
- **M2, the control plane** (~32 d): the Postgres store, services and
  groups, inheritance, signed bundles, agents, topology (c), RBAC, step-up,
  approvals, audit, analytics ingestion and rollups, live hub, alerts.
- **M3, the UI** (~27 d, overlapping M2): every screen of ui.md, the
  analytics page, e2e.

Later, on demand: an OWASP CRS-derived rule set, body-field rules, VPN
feeds, the payment profile, a built-in breached-password check, reCAPTCHA
Enterprise, response body scanners, API-key baselines, canary URLs, an
offline bundle signer, a cross-instance live ring.

---

## 2. What exists today, and what is missing

A survey of the packages the plan builds on, at `36be4163`.

### 2.1 bun-common

| Need | What exists [S] | Missing |
|---|---|---|
| peer address | `BunRequest.socketAddress` → `server.requestIP()` (`BunRequest.ts:3133`); `req.ip` = its address (`:5362`); socket-free `fetch()` reports `null`/`""` (`BunRouter.ts:626-633`) | normalisation of `::ffff:` [M] |
| forwarded headers | `req.ips` splits `X-Forwarded-For` **always**, client first, no trust setting (`BunRequest.ts:5367-5380`); `req.protocol` believes `X-Forwarded-Proto` always (`:5267-5276`) | a `trustProxy` setting with Express's semantics, presets, IP/CIDR utilities (only a private `isLoopbackAddress`, `docs/devTypes.ts:376`) → **the trust-proxy foundation** (§2.6) |
| a hook before the body is read | the protected `handleNativeRequest` override (`BunHttpAdapter.ts:470`), the only code before `BunRequest.init`; body parsing is eager unless `deferBody` (`BunRequest.ts:2115-2127`) | a public early hook on bun-common's adapter; bun-nest has `setOnRequestHook` (`bun-nest/lib/BunHttpAdapter.ts:1654`, after `init`), `addBeforeWriteHook` (`:1727`) and `registerSecurityHook` (`:3059`, forces `deferBody`), bun-common none → **PR-P2** |
| after the response | `res.whenResponded(listener)` (`BunResponse.ts:4244`); `addResponseTransform(t, { first })` (`:2797`) | — |
| `Bun.serve` options | the adapter spreads its `server` option; sets neither `idleTimeout` nor `maxRequestBodySize` (`BunHttpAdapter.ts:1556-1577`); a 413 payload guard after `init` (`:518`) | `hardenServe()` in bun-security sets them |
| security features | `cors()` (`cors.ts:255`); signed cookies with `timingSafeEqual` (`utils/native.ts:1415-1487`); `Semaphore`, `Mutex`, `computeBackoff`, `retry` (`native.ts:1814-2031`) | security headers, CSRF, IP lists: **none** (CSRF and origin guards exist only inside bun-jobs, `bun-jobs/lib/api/auth.ts:525-670`); rate limiting → **the throttle foundation** (§2.6) |
| contracts and documents | `validate(schemas, { responses })` (`BunValidate.ts:1108`), `defineRoutes`/`RoutesOf` (`defineRoutes.ts:257`, `:380`), `generateOpenApi` (`docs/openapi.ts:947`), `generateAsyncApi` (`docs/asyncapi.ts:283`), `docsRouter` (`docs/router.ts:190`), `listRoutes` (`routeModel.ts:293`) | — |
| live | `defineChannel` (`channel.ts:354`); `res.sse()` with `resume`, heartbeat, `retry` (`BunResponse.ts:3674`, `sse/writer.ts:303`); `liveInvalidation` with required `authorize` (`live/server.ts:498`) | channel-level `authorize` (auth happens in route middleware, `checks()` or `onUpgrade`) |
| logging | `createLogger`, `LoggerLike`, `resolveLogger` (`logging.ts:298`, `:952`, `:1027`) | — |
| errors | `ConfigError` (`errors.ts:19`) | a problem+json helper (bun-jobs has one, `bun-jobs/lib/api/errors.ts:621`) |

### 2.2 bun-cache

| Need | What exists [S] | Missing |
|---|---|---|
| drivers | memory, file, sqlite, postgres, mysql, mariadb, redis, mongo, s3, azureBlob, cloudflareKv, cloudflareD1, `redundant()` (`lib/index.ts:68-112`) | — |
| atomic counters | `cache.increment(key, by, { ttl })`; expiry set at creation, a fixed window (`core/types.ts:233-242`, `:1079`); Redis by Lua (`drivers/redis.ts:487-505`), SQLite `RETURNING` upsert (`sqlite.ts:307`), Postgres, MySQL, Mongo `$inc`; never evicted by `maxEntries` (`drivers/entry-cap.ts:10`) | enough for counted rules (ConcaveHR's `INCR`+`EXPIRE NX`); **HyperLogLog** missing, CAS and set-if-absent missing (GCRA needs them, only if the throttle foundation lacks a sliding algorithm); the Redis counter uses the client's clock (`redis.ts:1236`) → **PR-P3** |
| invalidation bus | `redisBus`, `pgBus`, polled buses; at-most-once with `onGap` (`core/types.ts:106-121`); measured Redis p50 0.043 ms, Postgres p50 0.137 ms (BC §4.2) | carries keys and tags, not values (enough for "reload bans since v") |
| failure policy | reads miss, writes fall back, circuit breaker 5 failures / 30 s (`core/cache.ts:474-580`); **`increment` throws on failure** (`:3041-3082`); per-op `timeout` (`types.ts:1198`) | — (the engine decides per rule) |
| encryption | AES-256-GCM envelope, keyed name hashing (`core/encrypt.ts`, `core/names.ts`), built | a public HMAC helper (internal only) |
| middleware model | `cacheResponse`, `coalesceRequests` as `RouterHandler`s capturing responses through `addResponseTransform` (`http/cacheResponse.ts:497`, `http/coalesce.ts:90`) | — |

### 2.3 bun-contract and bun-client

bun-contract is the zero-dependency contract core, browser-safe
(`packages/bun-contract/package.json`, no dependencies) [S]. bun-client has
`createClient` (`bun-client/lib/client.ts:410`), retries honouring
`Retry-After` and 429 (`client.ts:74`, `retry.ts:48`), `./sse`
(`sse.ts:774`), `./channel` with reconnect and fatal close codes
(`channel.ts:1464`), `./query` and `./react` [S]. **Nothing is missing** for
the UI's typed calls; the UI is bun-client's second in-repo consumer after
the playground (TC §11's bun-jobs-ui pilot is not built).

### 2.4 bun-jobs

| Need | What exists [S] | Missing |
|---|---|---|
| scheduled work | `BunRunner` with cron/`every`/`at` and `runMode: "single"` (cluster-wide lock) (`runner/BunRunner.ts:136`, `runner/types.ts:825-880`); repeatable jobs (`queue/types.ts:62-90`) | — |
| a management API to copy | `createJobsApi`: required `authorize(req, ctx)` with 53 named actions (`api/config.ts:153`, `api/contract/constants.ts:19-72`), CSRF and origin guards (`api/auth.ts:525-670`), keyset cursors (`drivers/pageCursor.ts:68`), a WS hub with an epoch/seq ring, resume, coalescing, an inbound token bucket, per-channel re-authorization, slow-consumer gaps (`api/ws/hub.ts:120`, `ws/session.ts:39-925`) | **RBAC**, an **audit log** ("not an audit trail", `shared/eventRetention.ts:9`), alerts or webhooks (`notifier.ts` merges events, sends nothing), cross-instance resume |
| time series | per-second and per-minute buckets written directly, no rollup job; seconds kept 5–15 min, minutes 24 h (`drivers/metrics.ts:1-30`, `api/contract/constants.ts:838-869`) | hour and day tiers |
| signed agent traffic | HMAC envelope with direction in the MAC, ±300 s, nonce store, key rotation, exported (`remote/signing.ts:1-51`, `:463`, `:480`, `remote/nonce.ts:16-60`) | mTLS; a shared nonce store (the built-in is in memory) |
| a limiter | `QueueLimiter`: fixed window and concurrency leases over a versioned CAS of one JSON document, up to 12 attempts (`queue/limits.ts:18-731`) | **not fit for per-request limiting** (read + CAS per decision, fixed window); bun-cache's primitives are the base instead |

### 2.5 bun-jobs-ui, bun-api-docs-ui, bun-nest, the playground

- **bun-jobs-ui** is the UI model (ui.md §1): `jobsUi()` (`bun-jobs-ui/lib/jobsUi.ts:679`),
  a nonce CSP with `style-src 'self'` (`lib/shell.ts:73-88`), sha384 SRI
  and a verified `dist/` manifest (`lib/assets.ts:132`, `:304-364`), cookie
  auth with a CSRF header (`app/api/client.ts:226-236`), permissions that hide
  elements (`app/meta/hooks.ts:86`), a resumable WS live client
  (`app/live/client.ts:263`), offset-plus-cursor paging (`app/components/Pager.tsx:71`),
  hand-rolled SVG charts (`app/components/Sparkline.tsx:18`), the DOM-test
  rules and their guards, e2e through `Bun.WebView` [S]. ~40,000 lines of
  app and ~57,000 of tests [S].
- **bun-api-docs-ui** embeds as a reference viewer (`./embed`); its
  `lib/assets.ts` is a near copy of bun-jobs-ui's [S].
- **bun-nest**: `BunCacheModule.forRoot/forRootAsync` and `BunJobsApiModule`
  (mounts a bun-common router through `adapter.use`, attaches the socket on
  bootstrap, `bun-nest/lib/jobs/BunJobsApiModule.ts:136-184`) are the models
  for `SecurityModule`; **no `APP_GUARD` exists yet** (only `APP_PIPE` and
  `APP_FILTER`, `validation.ts:898-907`) [S]; `set("trust proxy")` is
  accepted and does nothing (`BunHttpAdapter.ts:5284`) [S].
- **The playground** adds a feature as a `mountXxx(app)` module with a
  banner line and a stop in `shutdown()` (`playground/index.ts:164-180`,
  `:345-411`) [S].

### 2.6 The two foundations [F]

Both were requested by the user on 2026-11-07 and are being built beside
this plan. Their worktrees held no code yet when this was written (the
throttle agent's progress file lists its plan only, and the trust-proxy
agent had not written one), so everything here is from the coordinator's
brief; re-check against the branches before building on it.

| Foundation | Gives (per the brief) | bun-security uses it for | bun-security still adds |
|---|---|---|---|
| **Trust-proxy client IP** (`feat/trust-proxy-client-ip`) | `trustProxy` on both HTTP adapters with Express-exact semantics; `req.ip` the client the trusted chain vouches for; `req.ips`, `protocol`, `hostname` follow trust; presets (Cloudflare `CF-Connecting-IP` and its ranges, Railway, Fly, others) only through a trusted chain; the same for WebSocket upgrades | L2's client address, every `ip` key, events | /64 keys for IPv6; service identity and forwarded end-user addresses (layers.md L2.4); trust-misconfiguration detection (L2.5); the resolution shown in events and the UI |
| **Throttle plugin** (`feat/throttle`) | bun-common `throttle()` and an adapter-wide `throttle` option on both adapters; a structural `ThrottleStore` with a bounded memory store; `RateLimit` headers and 429 problem+json; fail-open/closed; bun-cache `cacheThrottleStore(cache)`; bun-nest `@Throttle()`/`@SkipThrottle()` and a guard | L9's limits: the counting, the stores, the 429 | limits from policy, updated at run time; identity keys and composite keys; several limits per route; `throttled` events feeding counted rules and escalation; `hybrid` and local-fallback stores; dry run; WebSocket message limits; distinct counts; bans, reputation and cross-route scoring; central policy distribution |

§20 lists what bun-security needs from each, so the building agents can be
steered now.

---

## 3. Packages and where the engine hooks in

### 3.1 `@kingsleyweb/bun-security` [D]

| Entry | What | Runs on |
|---|---|---|
| `.` | `createSecurity(options)` → the engine: `evaluate`, `middleware()`, `signal()`, `explain()`, `load(bundle)`, `close()`; policy types and schemas; `compilePolicy` | every EP |
| `./http` | bun-common integration: `securityMiddleware`, `securityHeaders`, `csrf`, `uniformAuthResponse`, the early hook (PR-P2) | EPs on bun-common |
| `./serve` | `withSecurity(fetch, security)` for a plain `Bun.serve`, `hardenServe(options)` | EPs on raw Bun |
| `./stores` | hot state over bun-cache (`cacheStore(cache)`: scores, counted-rule counters, HLLs, active-ban copies); the `hybrid` `ThrottleStore` wrapper | EPs |
| `./store` | the security store (durable state): `SecurityStoreDriver`, `memoryStore`, `sqliteStore`, `postgresStore`, `policyFile` ([`storage.md`](storage.md)) | the CP; EPs that read bundles straight from the store |
| `./challenge` | `powChallenge`, `turnstile`, `hcaptcha`, the `ChallengeProvider` type | EPs |
| `./intel` | the MMDB reader, `ipIntel(files)` | EPs, CP (artefact checks) |
| `./agent` | `connectAgent({ cpUrl, key, bundleKeys, cacheDir })` | EPs in (b), (c) |
| `./control` | `createSecurityApi(options)`, `secureAdmin()`, the rollup and alert jobs | the CP only |
| `./testing` | `attack` simulators (§11.2), a fake CP, `explain` assertions, `runSecurityStoreConformance` | tests, third-party drivers |

Dependencies [D]: `@kingsleyweb/bun-common` and `@kingsleyweb/bun-contract`
(runtime; bun-common carries the two foundations); `@kingsleyweb/bun-sql`
(runtime, the shared SQL module, storage.md §4; only `./store` imports it);
`@kingsleyweb/bun-cache` (optional peer, for shared state and the field
envelope);
`@kingsleyweb/bun-jobs` (optional peer, for the CP's rollups and alerts; the
CP falls back to timers without it in (a)). No third-party runtime
dependency. `./control` imports bun-jobs only behind its own entry, checked
by the build's peer-scope verify (CLAUDE.md, "Packaging types") so an EP's
import graph never reaches it.

It follows the packaging recipe: `lib/` run directly, `dts/` built on
`prepack`, `exports` in the `{ "@kingsleyweb/source", types, default }`
shape, `consumer-check.json` (with `peers` on `./control`), the four copied
build files, `publishConfig.access`, `files`, `LICENSE`, `workspace:^`
internal dependencies, so `scripts/publish.ts` takes it without a list
(CLAUDE.md, "A new package").

### 3.2 `@kingsleyweb/bun-ui/security` [D]

An entry of bun-ui ([`bun-ui`](../bun-ui/README.md) §3), built on its kit;
ui.md §1 argues why it is not in bun-security. `/security` (server:
`securityUi()`) and `/security/browser` (the browser-safe config and types).
`@kingsleyweb/bun-security` is an **optional peer scoped to those two
entries** (`consumer-check.json` `peers`, checked by `checkPeerScopes` and a
consumer of its own); bun-common is bun-ui's runtime dependency; React,
TanStack and bun-client bundled into `dist/security/`.

### 3.3 bun-common: middleware in two stages [D]

```ts
const security = createSecurity({ policy: "./security.json", store: cacheStore(cache), identify });
const app = new BunHttpAdapter();
security.install(app);           // registers the early hook (pre-routing stage, before the body)
                                 // and a first middleware (route stage), plus response transforms
app.post("/login", security.profile("login"), loginHandler);
```

- **Pre-routing stage** (L1–L8, L9 for limits not keyed by route or user):
  the early hook of PR-P2, before `BunRequest.init` reads the body, so a
  banned client or a 10 MB body to a 1 KB route costs no parsing. Until
  PR-P2 lands, `install()` falls back to overriding `handleNativeRequest` in
  a subclass (`createSecureAdapter()`), which is the only pre-body point today
  [S].
- **Route stage** (L9 per route and user, L10, L11, L12): a middleware
  registered first, so `req.user` (from `identify`) and the route key are
  known; per-route options through `security.profile(name)` or
  `.describe({ security: … })` metadata read through `listRoutes`.
- **Response stage** (L13, L14): `addResponseTransform` for headers and
  scrubbing, `whenResponded` for outcome signals [S].
- WebSocket upgrades pass the same pre-routing and route stages (they run
  the HTTP middleware before the `ws()` route, `BunWebSocket.ts:174-178`) [S].
- **Boot self-test** (D25): `install()` sends one synthetic request through
  the adapter's socket-free `fetch()` (`BunHttpAdapter.ts:707`) [S], marked
  so the engine recognises it, and throws at start-up if the engine did not
  see it, or if the throttle foundation's middleware is configured and did not
  run. ConcaveHR ran pay-api without throttling for an unknown time because a
  validation pipe had been registered as its `APP_GUARD` (write-up §8).

### 3.4 Plain `Bun.serve` [D]

```ts
Bun.serve(hardenServe({
  port: 443,
  fetch: withSecurity(security, async (req, server) => app(req)),
}));
```

`hardenServe` sets `idleTimeout`, `maxRequestBodySize` and refuses a config
that leaves `development` on under `NODE_ENV=production`. `withSecurity` runs
every stage; outcome signals come from the returned `Response`.

### 3.5 bun-nest: `@kingsleyweb/bun-nest/security` [D]

- `SecurityModule.forRoot(options)` / `forRootAsync` (the `BunCacheModule`
  shape) installs the engine on bun-nest's `BunHttpAdapter` through its
  existing hooks: `registerSecurityHook` (which forces `deferBody`, so it
  runs before the body, `bun-nest/lib/BunHttpAdapter.ts:3059`, `:999`) for
  the pre-routing stage, `addBeforeWriteHook` for response controls,
  `setOnResponseHook` for outcomes [S].
- `SecurityGuard` as `APP_GUARD` (the first global guard in bun-nest) for
  the route stage, so decorators work: `@RateLimit({ … })`,
  `@SecurityProfile("login")`, `@SkipSecurity("rule-id")`.
- `@InjectSecurity()` for `signal()` and `check()` in services (layers.md
  L11.7: checks where data is created).
- The rate-limit decorators are the throttle foundation's `@Throttle()`/
  `@SkipThrottle()` [F]; `SecurityGuard` does not duplicate them.
- **Declared dependencies and a boot self-test**: the guard is an
  `@Injectable()` with its constructor parameters declared explicitly (no
  inherited constructor metadata: ConcaveHR's subclassed `ThrottlerGuard`
  failed Nest's injection on the first boot after deploys, write-up §8), and
  `onApplicationBootstrap` runs §3.3's self-test through the adapter.
- Runs in the Nest matrix (11.2.7 and 12-latest columns), including a cold
  boot test.

### 3.6 The admin listener [D]

`secureAdmin({ hostname: "127.0.0.1", port, api, ui })` starts a second
`Bun.serve` for the CP and UI (topology (a)), refusing a public bind
(`0.0.0.0`, `::`) unless `allowPublicBind: true` with mTLS or a
`trustProxy` set. In (b) and (c) the CP is its own process started the same
way.

---

## 4. The engine

The layers are specified in [`layers.md`](layers.md); this section is how
they run.

### 4.1 Request facts and the decision [D]

Each adapter turns a request into **facts** once: method, canonical path,
raw path, route key (when known), headers (lower-cased, bounded), cookie
names, the peer address, the resolved client and the chain that resolved it,
`Content-Length`, the service and environment. The engine is a pure function
of facts, the compiled policy and state reads:

```ts
type Decision = {
  action: "allow" | "log" | "tag" | "delay" | "challenge" | "block" | "ban" | "drop";
  status?: number; delayMs?: number; retryAfter?: number;
  hits: RuleHit[];            // every rule that matched, with its would-have-been in dry run
  tags: string[]; risk: number; subject: SubjectKeys;
};
```

Stages run in order; a stage that answers ends the request; every hit is
recorded. `explain(facts, { assumeState })` is the same function with state
writes disabled, backing the UI's test-a-request tool and the tests.

### 4.2 Hooks the app supplies [D]

| Hook | Purpose | Default |
|---|---|---|
| `identify(req)` | `{ user?, session?, tenant?, apiKey?, scopes? }` | none (IP-keyed only) |
| `signal(req, name, data)` | facts only the app knows (layers.md L11.1) | outcome inference |
| challenge providers | layers.md L10.2 | none: `challenge` falls back to `block` |
| `onDecision(decision, req)` | the app's own logging or metrics | none |
| `renderBlock(decision, req)` | a branded block or challenge page | problem+json, a minimal HTML page |

### 4.3 Hot-path rules [D]

No `await` on the hot path when every rule in play is local (an allow is
synchronous); shared limits for one request batched into one store call;
facts computed lazily (IP intel only when a rule needs it); no per-request
closures in the compiled matcher; the decision object reused for allows.
These are design constraints; their cost is §10's targets, unmeasured.

---

## 5. Topologies and the policy model

Specified in [`topologies.md`](topologies.md) and
[`control-plane.md` §2–§3](control-plane.md#2-the-policy-model). In short:

| | (a) one service | (b) services on one system | (c) services across systems |
|---|---|---|---|
| policy lives | a file, or the in-process CP's SQLite | a CP process on the host | a CP on an admin network, Postgres |
| config reaches EPs | in process; a watched file | pull over loopback/Unix socket, nudged by bun-cache's bus | signed bundles pulled over HTTPS with `ETag`, nudged by a channel; last known good on disk |
| counters | memory (or SQLite) | Redis on loopback, or one SQLite file (WAL) | regional Redis; global limits as the sum of regions |
| bans and scores | SQLite | the shared store + bus | regional store; global bans republished by the CP to every region |
| analytics | the same SQLite, timers or a `BunRunner` | CP ingests; one rollup job | CP ingests batches; bun-jobs workers roll up |
| store down | n/a (local) | `onStoreError` (`local` by default); bans keep enforcing from memory | the same, per region |
| CP down | n/a | last bundle keeps enforcing; events queue (bounded) | the same; agents back off |

**Groups and inheritance**: built-in defaults ← global ← each ancestor
group ← the service ← per-route overrides; items keyed by id; `locked` items
cannot be overridden below; lists union (control-plane.md §2.2). ConcaveHR's
"platform default plus per-service override" rules (write-up §2.3) are the
two-level case; its write-up asks for a named scope of service, system or
fleet (§8), which groups give.

**Storage** ([`storage.md`](storage.md)): durable state (policies,
versions, bundles, bans and their history, audit, operators, service
identities, alert settings, analytics) goes through a `SecurityStoreDriver`;
hot state (counters, windows, scores, active-ban copies) stays on the
throttle foundation's store and bun-cache. v1 drivers: memory, SQLite,
Postgres, and a read-only `policyFile`; MySQL/MariaDB, Redis and MongoDB
later. Every document has a `revision` (optimistic concurrency); every list
is keyset-paginated; every write lands in a change feed (push on Postgres
and Redis, polled elsewhere, plus a 60 s reconcile); SQL and MongoDB
schemas follow bun-jobs' `syncSchema`; secrets are sealed with bun-cache's
envelope; a conformance kit tests third-party drivers. The SQL code comes
from a shared module extracted from bun-jobs and bun-cache rather than a
third copy.

---

## 6. Securing the defence itself

Specified in [`control-plane.md`](control-plane.md) §4–§9:

- **Management API**: `authenticate` required; built-in RBAC (`viewer`,
  `analyst`, `operator`, `admin`, `owner`) per scope, or the host's
  `authorize`; cookies plus a CSRF header and Fetch Metadata + `Origin`
  checks; its own rate limits.
- **Step-up** (a fresh second factor within 5 minutes, through the host's
  MFA) for publish, rollback, permanent or wide bans, bulk unban, disabling a
  locked rule, agent keys, roles, alert channels, audit export.
- **Two-person approval** (optional; recommended for production in (c)) for
  dangerous changes, with an audited emergency path; otherwise a typed
  confirmation.
- **Audit**: every mutation, hash-chained, signed checkpoints to an
  external sink, `GET /audit/verify`, append-only grants, 400-day retention.
- **Agents**: per-agent keys bound to one service; signed requests
  (bun-jobs' envelope), ±60 s, a shared nonce store; mTLS optional; bundles
  signed by a key the agents are configured with at deploy time, not from the
  CP; monotonic versions; rollback as a new version.
- **Secrets**: never in a policy, bundle, event, audit entry or log line;
  referenced by name and resolved at the EP.
- **Self-DoS bounds**: control-plane.md §9's table.

---

## 7. The management UI

Specified in [`ui.md`](ui.md): services and groups with inheritance and
origin shown per field; draft, diff, publish, versions and rollback; rules
with a live regex verdict; lists and bans with bulk actions and step-up; dry
run with an impact estimate over recorded traffic; a test-a-request tool
that runs a pasted request through a service's effective policy without side
effects; audit, approvals, agents, alerts; the embedded API reference. Every
list is keyset-paginated with the cursor in the URL; live lists show "N new"
instead of reshuffling the page.

**Attribution.** Pages that display country or ASN show the line each
IP-intelligence licence requires (DB-IP: a link to db-ip.com; GeoLite2 and
IPinfo Lite: their credit lines) [V].

---

## 8. Analytics data: events, rollups, retention, budgets

### 8.1 What is stored [D]

| Kind | Content | Written by |
|---|---|---|
| **minute counters** | per (service, minute): requests by action; by (route, action); by (rule, action, dryRun); by (country, action); by (ASN, action) for the top 200 ASNs; status classes; decision latency histogram (fixed buckets); store errors; event drops | each EP, pre-aggregated, shipped every batch |
| **top-K per minute** | the top 100 subjects per (service, metric) with counts, by the space-saving algorithm at each EP (bounded memory), merged at the CP | each EP |
| **events** | one per non-allow decision (plus 0.1% of allows): time, service, route, action, rules hit, subject keys (IP, /64, user hash, key id), country, ASN, decision latency, and a **redacted request sample** | each EP, sampled at most 30 per subject per minute (ConcaveHR's budget) and capped per rule |
| **exact refused counts** | per (subject, service, day): every refusal counted, sampled or not | each EP, in its minute counters (ConcaveHR's `blocked_request_daily`, write-up §4) |
| **ban log** | created, extended, lifted, with source and rule | EPs and the CP |
| **heartbeats** | per agent: bundle version, key id, ring drops, fallback mode, store health | agents |

**Redaction** (ConcaveHR's rules, write-up §6, which made its "is this a
false positive?" question quick to answer): lower-cased headers with
credential headers (`authorization`, `cookie`, `set-cookie`, `x-api-key`,
service tokens) replaced by `[redacted]`; the query and a JSON body with
sensitive keys redacted (password, token, secret, signature, OTP, code,
PIN, card and account numbers, national identifiers; the list is
configurable per policy); everything capped (60 headers, 512 characters
per value, a 4 KB body, a 1 KB query, nesting depth 5); the answer's status
and a capped body. One redaction module, in the package, replaces
ConcaveHR's per-repo copies (its "main maintenance risk", §8).

### 8.2 Where [D]

The analytics tables belong to the security store
([`storage.md`](storage.md)): SQLite in (a) and small (b); Postgres (MySQL
and MariaDB later) in (c), with `syncSchema`. Not Redis: retention and range
queries over days are SQL's strength, and Redis memory is the attack
surface's most expensive resource. Events are indexed by `(service, time,
id)` (the keyset order) and by subject; the minute counters by `(service,
minute)`.

### 8.3 Rollups [D] [S]

Minute counters are written as they arrive (no job), as bun-jobs' metrics
write their buckets directly (`bun-jobs/lib/drivers/metrics.ts:1-30`) [S].
A `BunRunner` schedule with `runMode: "single"`
(`bun-jobs/lib/runner/types.ts:825-880`) [S] builds **hourly** rows from
minutes (every 5 minutes, for the closed hours) and **daily** from hours, and
runs retention deletes in bounded batches. Without bun-jobs (topology (a)),
the same functions run on a timer in the CP process. The analytics API picks
the tier by range: minute ≤ 6 h, hour ≤ 14 d, day beyond.

### 8.4 Retention [D]

| Tier | Default | Max |
|---|---|---|
| events | 14 d | 90 d |
| minute counters | 7 d | 30 d |
| hourly | 90 d | 400 d |
| daily | 400 d | 5 y |
| ban log | 400 d | — |
| audit log | 400 d | — (control-plane.md §6) |

### 8.5 Volume budgets (targets) [D]

- **Events**: at most `maxEventsPerDay` per service (default 1,000,000);
  past it, events are counted only and an alert fires. At ~400 B per row
  [I], that is ~400 MB a day and ~5.6 GB at 14 days per service at the cap.
  The per-subject cap (10 a minute per rule, control-plane.md §9) keeps a
  flood from one subject to a handful of rows.
- **Minute counters**: bounded by dimensions: at most 2,000 rows per service
  per minute (routes × actions are capped by the route count; ASNs capped at
  200), so ≤ 2.9 M rows a day per service at the cap, typically far fewer.
- **Live**: ≤ 1 counter message a second per topic and ≤ 20 feed events a
  second per subscriber (ui.md §6).
- **Shipping**: one batch a second per agent, ≤ 500 events, gzip, ≤ 1 MiB.

All sizes are estimates to be checked by the first PR that writes the
tables (PR-CP1), not measured.

---

## 9. Observability and alerting

### 9.1 Logs [D]

Through bun-common's `Logger` (`LoggerLike` accepted, `resolveLogger`)
[S]: one structured line per rule's first hit per subject per minute
(`security.decision` with `action`, `rule`, `subject`, `service`, `route`),
store and CP errors, bundle loads (version, key id), signature failures. No
secrets, no cookie or authorization values, user ids only as hashes unless
the policy says otherwise; a 429 line names the route and the limit, never
the address or the account (ConcaveHR's rule, write-up §2.2); a failure in
the security path says what was kept ("store unreachable, kept 1,204 bans
from 12:01").

### 9.2 Metrics [D]

A Prometheus text endpoint on the admin listener (bun-jobs has a scaler
exposition, `bun-jobs/lib/api/prometheus.ts`, as a precedent) [S], and the
same counters through OT's `TelemetryHooks` once that plan lands (it is
**held**, `docs/plans/README.md`): `security_decisions_total{action,rule,service}`,
`security_decision_duration_seconds` (histogram), `security_store_errors_total`,
`security_fallback_active`, `security_bans_active`, `security_events_dropped_total`,
`security_limiter_evictions_total`, `security_bundle_version`,
`security_agent_last_sync_seconds`. Traces: attributes on the HTTP server
span (`security.action`, `security.rule`), not a span per rule.

### 9.3 Alerts [D]

| Alert (default severity) | When |
|---|---|
| canary used (critical) | any canary credential, key or URL (layers.md L8) |
| bundle signature failure or replayed bundle (critical) | an agent refuses a bundle |
| store down (critical) | an EP in fallback for 30 s |
| agent silent (warning) | no heartbeat for 2 min |
| block-rate spike (warning) | blocked share 3× its 7-day baseline at this hour, for 5 min |
| credential stuffing (warning) | layers.md L11.2's global failure ratio |
| ban storm (warning) | > 1,000 auto-bans in 5 min in a scope |
| rule tripped N times (warning) | a counted rule trips more than N times (default 5) in an hour; ConcaveHR's first alert wish (write-up §8) |
| subject refused heavily (info) | one subject passes a refused-request threshold (default 1,000 an hour) |
| trust misconfiguration (warning) | layers.md L2.5's detector |
| feed refresh failed or below its minimum size (warning) | the Tor list or an IP-intel file |
| limiter evictions (warning) | sustained key eviction (a rotation attack) |
| event cap reached (info) | `maxEventsPerDay` |
| dangerous change published, emergency path used, break-glass login (info/critical) | control-plane.md §5 |

Channels: **webhook** (JSON, HMAC-signed with a per-channel secret, a
timestamp, retried with backoff), **email** (through a host hook
`send(message)`; bun-security ships no SMTP client), **Slack-compatible**
webhook. Delivery runs as a bun-jobs queue on the CP, so retries survive a
restart; without bun-jobs, in process with bounded retries. **Rate limits**:
per channel, at most one message a minute per alert rule; beyond that, a
digest every 15 minutes; identical alerts deduplicated by key while open;
a global cap of 60 messages an hour per channel, past which only `critical`
goes through.

---

## 10. Performance budgets (targets, unmeasured)

**Every number here is a target to measure later, with the user's approval
(the standing rule), not a result.** No benchmark was run for this plan.

| Item | Target |
|---|---|
| pre-routing stage, local state, policy of 50 rules, 10,000 list entries, 100,000 bans | p50 ≤ 5 µs, p99 ≤ 20 µs per request added |
| route stage, local limits | p50 ≤ 5 µs |
| allocations on an allow with local state | the facts object and at most two small objects; no per-rule allocation |
| store round trips per request | 0 for bans, lists, local and hybrid limits; ≤ 1 (pipelined) when any shared limit applies |
| shared limit round trip | ≤ 1 ms p99 on loopback Redis; ≤ 3 ms on a LAN |
| memory per EP at default bounds | ≤ 64 MB (100,000 limiter keys, 100,000 bans, a 10,000-event ring, a 50,000-entry intel cache) |
| policy compile | ≤ 100 ms for 2,000 rules and 1 M list entries |
| ban propagation | ≤ 1 s within a system (b), ≤ 5 s across regions (c) |
| policy change to enforcement | ≤ 5 s with the nudge; ≤ 30 s by poll |

The first measurement, when approved, belongs in `evidence/` with its
command, beside the bun-common router baseline so the engine's cost reads
against a known figure.

---

## 11. Testing strategy

### 11.1 Unit and contract

Every layer, action, merge rule and failure mode; the policy schema's JSON
Schema matching what the API documents; `explain()` agreeing with
`evaluate()` on every test request (one function, two modes).

### 11.2 Attack simulations as tests [D]

`./testing` ships simulators; each named case is a test with its negative
control (the defence off, the attack succeeds):

| Case | Asserts |
|---|---|
| T-L2-1 spoofed `X-Forwarded-For` from an untrusted peer | the peer is the client; a ban on the claimed address does not block it, a ban on the peer does |
| T-L2-2 IPv4 client on a default (dual-stack) listener | a `203.0.113.0/24` rule matches `::ffff:203.0.113.5` |
| T-L2-3 IPv6 rotation inside one /64 | one key, one limit |
| T-L6-1 `//admin`, `%2Fadmin`, `/a/%2e%2e/admin`, backslashes | the canonical path matches `/admin/*` rules, or the request is refused |
| T-L6-2 duplicate `Host` | refused while Bun accepts it (§18) |
| T-L7-1 ReDoS-shaped patterns | refused by the validator; accepted patterns stay linear on the generated adversarial inputs (no timing assertion: a step count from an instrumented matcher) |
| T-L9-1 burst, steady, boundary-straddling traffic through policy-driven limits | the throttle foundation admits exactly its model's count for each named limit and key (its own tests cover the algorithm; this covers bun-security's wiring, keys and run-time updates) |
| T-L9-2 key-cardinality flood | memory bounded, evictions counted, alert |
| T-L11-1 credential stuffing: 1 IP × 1,000 usernames; 1,000 IPs × 1 username; low-and-slow over 6 h | each detector fires; the owner's device cookie still logs in |
| T-L11-2 enumeration by timing and status | `uniformAuthResponse()` equalises status, body and minimum time |
| T-L11-3 lock-out-the-victim | the owner's device keeps working; untrusted devices are throttled |
| T-L1-1 slowloris (a trickled request) | closed at `idleTimeout`, in a child process |
| T-L8-1 honeypot hit, canary key use | ban on first hit; critical alert |
| T-L13-1 cross-site `POST` with cookies | refused by Fetch Metadata; same-site allowed; header-less falls back to `Origin` |
| T-CP-1 tampered bundle, replayed older bundle, wrong key | refused, last good kept, alert |
| T-CP-2 replayed agent request, skewed clock, another service's key | refused |
| T-CP-3 edited or deleted audit entry | `verify` fails at that entry |
| T-L2-4 a sibling service calls with a valid service identity, through a proxy flow that trips a counted rule | the end user it forwards is counted and banned, the service never is; with no forwarded address nobody is counted (ConcaveHR's 40-minute self-block, write-up §6) |
| T-L2-5 a wrong `trustProxy` (every client resolves to the proxy, or to `100.64.0.0/10`) | L2.5's alert fires within its window |
| T-L11-4 a disposable email through a path no route guard covers (an invite created by a job) | `security.check()` refuses it, counts it, answers generically (ConcaveHR's second wave, write-up §1) |
| T-L5-1 a truncated Tor list (fewer than the minimum entries) | refused, the last good list kept |
| T-INT-1 the integration not installed, or installed but bypassed | start-up fails with the self-test error (D25) |
| T-L9-3 a window given as a bare number, or under a second | the compiler refuses it (ConcaveHR's 60 ms window) |
| T-ST-1 two operators edit one policy | the second write gets `409` with both versions; nothing is lost |

### 11.3 Property and fuzz tests [D]

- the CIDR trie against a brute-force scan over random prefixes and
  addresses (v4, v6, mapped);
- the glob matcher against a reference regex over random paths;
- the path canonicaliser: idempotent, and in agreement with Bun's own URL
  normalisation on every form Bun normalises (a differential through a
  raw-socket server, as in `evidence/request-shape/`);
- the `hybrid` store and counted rules against a reference model on random
  arrival timelines (fake clock), with the overshoot bound of topologies.md §3.2;
- policy merge laws: associativity of layering, `locked` never overridden,
  lists' union;
- the regex validator: random patterns from a grammar, every accepted one
  run on generated adversarial inputs under a step budget;
- the trust-proxy foundation's `req.ip` on random and malformed
  `X-Forwarded-For`/`Forwarded` headers and trust sets (never throws, never
  picks an address beyond the trusted boundary), run by bun-security as a
  check on the dependency it rests on.

### 11.4 Multi-process topology tests [D]

- **(b)**: `Bun.spawn` N service processes sharing Redis (database 15, the
  test database) or one SQLite file; a client drives them round-robin;
  assert the global limit holds within the hybrid bound, a ban written by one
  is enforced by the others within the target, and stopping the store moves
  them to `local` and back.
- **(c)**: a CP process, two "regions" (two Redis databases or two key
  prefixes), agents in each; assert signed bundle delivery, a global ban
  republished to both regions, CP restart with last known good, a replayed
  bundle refused.
- Database-backed cases skip visibly when their URL is unset and fail when
  it is set but unreachable (the repo's rule); the full suites run through
  the heavy-run wrapper; the multi-process suite is its own heavy job.

### 11.5 UI

ui.md §9: the bun-jobs-ui DOM rules (`setupDom()`, no static `react-dom`,
`domLeak`, `unmountLeaks` with a ledger, `--randomize` seeds), bundle-safety
and budget tests, e2e in Chrome through `Bun.WebView` against a real CP fed
by the simulators (a ban appears live; paging the events list while events
arrive shows no duplicates and no gaps; no CSP violations).

### 11.6 Examples, playground, matrices

- `examples/bun-security/`: `01-single-service`, `02-one-host` (three
  processes, Redis, shaped like ConcaveHR's three APIs: one owning the
  store, two reading it, a service identity between them), `03-fleet` (a CP and agents), `04-nest`, `05-login`
  (the credential-stuffing profile under the simulator), `06-ui`, each
  checked by `run-all.ts`.
- The **playground** gets `mountSecurityDemo(app)`: the engine in front of
  the playground's own routes, the CP and UI on the same adapter under
  `/security`, and a simulated attacker loop (scanners, a stuffing run, a
  burst) so every analytics component moves (the user's rule: every
  finished feature reaches the playground).
- The Nest matrix columns for `./security`; consumer-check for
  bun-security and bun-ui's `/security` entry (`peers: ["@kingsleyweb/bun-security"]`).

---

## 12. ConcaveHR's defence, mapped

ConcaveHR's session wrote up its defence on 2026-11-07
(`~/.cache/bun-node-b8/security/concavehr-defence.md`, 8 sections; outside the
repository). Its three Bun/Nest APIs run on bun-nest's `BunHttpAdapter` at
2.2.0 with `@nestjs/throttler` 6.7, ioredis, redlock and Node's
`net.BlockList`; none of the security code uses a bun-node package yet
(write-up §3). The write-up carries no secrets or attacker addresses (the
only range named is `100.64.0.0/10`); none were copied here. ConcaveHR's
internal file paths are left out; each row cites the write-up's section.

### 12.1 The threat, in one paragraph

One actor, with ffuf, curl and scripts, probed production for about four
hours: dozens of sign-ups with disposable domains and injection-probe names,
every auth flow walked repeatedly, IDOR-style uploads and path fuzzing
(bursts of 404s), 34 ₦1 offline payment claims that each emailed the finance
team, and the real hole, an unvalidated union DTO on a sign-in proxy plus a
`findOne({ id: undefined })` that returned the first user and leaked a
profile. Blocked, it came back through rotating Tor exits and new domains,
and through company team invites, which the sign-up email check did not
cover (§1).

### 12.2 Layer by layer

| ConcaveHR layer (write-up §) | What it does there | Lands in | Notes |
|---|---|---|---|
| **2.0 Service-token exemption** | a request whose `x-api-token` verifies (constant time) is a sibling API: skips the block list and the counters; strict per-route throttles still apply | layers.md **L2.4** service identity | first-class, named per service, never an address; `appliesToServices` keeps the strict limits |
| 2.0 forwarded end-user address (`x-concave-client-ip`, believed only with a valid service token, only if it parses) | the proxied user is counted, not the proxy | **L2.4** | a service call with no forwarded address counts against nobody (kept) |
| **2.0 Allow list** (`allowed_ip` table, published to Redis) | addresses and CIDRs never refused or counted; an entry wider than /8 or /32 refused; adding one lifts covered blocks | **L3**, L3.1 guards | scoped (global, group, service, route prefix); allow still subject to `evenWhenAllowed` limits |
| 2.0 built-in always-allowed ranges (loopback, RFC 1918, CGNAT, link-local, ULA) | internal hops are never blocked | **L3.1** `internal` list | plus L2.5's alert when public traffic resolves into it (a broken trust configuration) |
| **2.1 `BlockedIpGuard`** | the client against the shared block set; 403 before throttling or auth; a redacted sample, not awaited | **L4** bans, pre-routing stage (§3.3) | the same order; `403` problem+json `code: "banned"` |
| 2.1 Tor exits (`tor_exit_nodes` on/off, hourly refresh, a download under 100 entries ignored) | stopped the second wave | **L5** classes, the refresh job's minimum-size guard | a rule like any other, per scope |
| 2.1 counting `requests_per_second` for every passing request | fire-and-forget `INCR` | **L14** / §0.2 counted rule on `request` | from the minute counters, not one store write per request where `hybrid` is on |
| **2.2 `ThrottlerBehindProxyGuard`** (`@nestjs/throttler`, 600/min per route and client) | 429 only, never a block | **the throttle foundation** [F], driven by policy (L9.1) | ConcaveHR's limits are layers.md L9.3's defaults; shared across instances through `cacheThrottleStore` (ConcaveHR's were per instance, §4) |
| 2.2 strict sign-in limits (10/min `ip\|account`, 30/min `ip`; MFA 5 and 30; codes, reset, email change 5/min `ip`) | password-spraying and guessing caps | L9.1 items 2–3 (composite keys, several limits per route), **L11** profiles | plus per-account limits across addresses (L11.8), which ConcaveHR lacks (§8) |
| **2.3 Counted rules** (`security_rule`: platform default, per-service override) | "N in W s from one address → block B s" | **§0.2 counted rules** (D23), with per-group and per-service overrides | `null` B ("until removed") kept; the ladder as an option for repeat offenders (§8's wish) |
| 2.3 `failed_password`, `failed_mfa` (10 / 15 min → 1 h) | from sign-in 4xx | counted rules on `auth.failure`, `mfa.failure` (**L11.1** signals or outcome inference) | the login profile's defaults |
| 2.3 `disposable_signup` (1 / 60 s → 7 d) | a blocked pattern on any auth route | counted rule on `pattern.hit` (**L11.7**) | |
| 2.3 `signups_per_ip` (5 / 24 h → 7 d), `password_resets_per_ip` (10 / 1 h → 1 d) | | counted rules on `signup`, `password.reset` (**L11.6**) | ConcaveHR wants a challenge before blocking for `signups_per_ip` (§8): `action: challenge` then `ban` on the ladder (L10) |
| 2.3 `requests_per_second` (100 / 1 s → 15 min) | all three APIs | counted rule on `request` | |
| 2.3 `not_found_per_minute` (120 / 60 s → 1 d), route-not-found only | fuzzing signature | **L14** route-not-found counting (bun-common marks it, PR-S5) | an app's own 404 never counts (kept) |
| 2.3 counting: `INCR` + `EXPIRE NX` in a `MULTI`; delete the counter on a trip | | bun-cache `increment` with a creation-time TTL (`core/types.ts:233-242`) [S] | the same semantics |
| 2.3 who blocks: account-api writes; pay-api and finance-api block locally at once and report to account-api | | **topologies (b)/(c)**: the EP bans locally and ships the event; the CP records it (control-plane.md §4) | the reporting endpoint becomes the agent's event path |
| 2.3 merging (later expiry wins, "until removed" beats a date, manual replaces automatic), expiry, history rows | | **L4** merge rules; history in the security store | |
| 2.3 a minute job republishing the active set | expired blocks drop out everywhere within a minute | the ban stream plus a **60 s reconcile** (topologies.md §3.3) | push makes it seconds; the reconcile keeps the minute guarantee |
| **2.4 `EmailPatternGuard`** (wildcards, ≥ 4 literal characters, anchored linear regexes; a hit counts, samples, trips `disposable_signup`, answers generically) | disposable-domain sign-ups | **L11.7** identifier patterns | also `phone`, `username`, `domain` kinds |
| 2.4 the same check inside account creation (team invites, admin-created users) | closed the coverage gap | **`security.check()`** (D24) | the design rule: checks where data is created |
| 2.4 built-in policy for self-chosen addresses (reserved domains, the company's own domain) | | **L11.7** built-ins | |
| **2.5 validation fix** (the root cause) | union DTO validated; a lookup without a user id refused | **not bun-security's**: BunValidate on every route (§13 item 19 recommends a contract-coverage panel) | ConcaveHR's lesson: "rate limits only bought time" (§8) |
| 2.5 sign-out on deactivation | | not bun-security's (the app's session store) | |
| 2.5 `login_event` (one row per sign-in, 90 days) | | **L11.1** signals become events; the app keeps its own login history | the events list filters by `auth.*` |
| 2.5 no CAPTCHA (reCAPTCHA configured, unused) | | **L10** optional: PoW and Turnstile/hCaptcha adapters | |
| **§3 admin API** (blocked IPs, rules, insights, blocked requests, allowed IPs, email patterns, Tor status and refresh, report) | behind `SuperAdminGuard` | `createSecurityApi` (control-plane.md §4) | RBAC roles instead of one super-admin; step-up for destructive actions |
| §3 jobs (`publishSecurityState` every minute, `refreshTorExitList` hourly, `cleanupSecurityHistory` daily), `Bun.cron` under redlock | | bun-jobs `BunRunner` with `runMode: "single"` (§8.3) | the minute publish becomes push plus reconcile |
| §3 account-ui insights page (totals, per-rule table, per-day chart, per-service, top 10, pattern hits, paginated refusals with a drawer) | refreshed by hand | **ui.md §7**, live | every component kept; live updates were its first "do differently" (§8) |
| **§4 state**: Postgres source of truth, Redis shared by every API | | security store (`postgresStore`) + bun-cache over Redis | the split is the same; the key shapes become the package's, not a cross-repo contract |
| §4 atomic publish (`SADD` into staging, `RENAME`) | readers never see a half set | signed, versioned bundles and ban deltas | |
| §4 read caching 30 s (Tor 5 min), keep the last copy on failure | an outage never unblocks or blocks everyone | in-memory lists and bans, **last known good on disk** (storage.md §6), `onStoreError: "local"` | |
| §4 hot path never writes Postgres; refusals drained every minute | | events shipped in batches; analytics written by the CP | |
| **§5 client identity** (`TRUSTED_PROXY_HOPS = 2` on Railway; socket address, then a placeholder) | | **the trust-proxy foundation** [F] with a hop count (L2.2 item 3) | a Railway preset, verified against the real header shape |
| §5 shared IPs (generous global limit, `ip\|account` keys, private ranges allowed, rules on rare behaviour) | | L9.3 defaults, L3.1, counted rules | |
| **§6 observability** (warn lines without address or account; exact counts plus ≤ 30 samples per address per minute; redaction rules and caps) | | §8.1 events, exact counts, redaction; §9.1 logs | one redaction module instead of three copies |
| §6 no alerts for blocks | | **§9.3** alerts | ConcaveHR's wish (§8) |
| **§7 configuration** (rules, blocks, allow list, patterns, Tor at run time within 30 s; global throttle by env and restart; strict limits, hops, ranges, sampling, redaction in code) | | everything in policy, at run time, seconds by push; only secrets and the trust configuration stay in the environment | trust stays deploy-time on purpose: a run-time switch that changes who the client is would be a strong lever for a compromised CP |

### 12.3 The lessons (write-up §8), carried into the design

| Lesson | Where it lands |
|---|---|
| One owner, simple contracts | the CP owns policy; bundles are plain signed JSON readable from any language |
| Fail-safe caching | D7, storage.md §6 last known good |
| Fire-and-forget recording with sampling and a cap | §8.1 sampling, control-plane.md §9 bounds |
| Generic answers on pattern refusals | L11.5, L11.7 |
| The Tor rule, with a minimum-size check | L5 |
| Exact counts plus redacted samples | §8.1 |
| Blocking its own service | L2.4 (D4), T-L2-4 |
| Rate limiting silently off (a pipe as the guard) | D25 boot self-test, T-INT-1 |
| Unit confusion (ms vs s) | L9.3 explicit units, T-L9-3; asked of the throttle foundation (§20) |
| Keying on the wrong `X-Forwarded-For` entry | the foundation's hop count, L2.5 detection, T-L2-5 |
| Boot-time dependency injection of a subclassed guard | §3.5 declared dependencies, a cold-boot test |
| Coverage gaps: checks belong where data is created | D24, T-L11-4 |
| The root cause was validation, not rate | §13 item 19, the contract-coverage panel |
| Wishes: live updates, shared throttler storage, alerts, identity beyond IP (per-account limits, devices, ASN, IPv6 /64), a challenge before blocking, escalating blocks, one shared package, a named scope (service, system, fleet) | ui.md §6; the throttle foundation; §9.3; L11.8, L11.4, L5, L2.3; L10; §0.2 ladder; this package; groups (control-plane.md §2) |

---

## 13. Measures recommended beyond ConcaveHR's

ConcaveHR already has a block list, an allow list with private ranges, Tor
refusal, per-route throttles, seven counted rules, email patterns, service
tokens, exact counts with redacted samples and an insights page (§12). The
plan recommends these in addition; the ones its own write-up asks for are
marked *(ConcaveHR's wish)*.

1. **Live updates** of bans, rules and the analytics page *(ConcaveHR's
   wish)* (ui.md §6).
2. **Alerts** on rule trips, heavy refusals, store outages, canaries,
   signature failures, a broken trust configuration *(ConcaveHR's wish)*
   (§9.3).
3. **Escalating bans and a decaying offence score** across routes and
   services *(ConcaveHR's wish)* (D10, layers.md §0.2).
4. **A challenge before a ban** on borderline rules: proof of work with no
   third party, Turnstile or hCaptcha, and signed clearance cookies
   *(ConcaveHR's wish)* (layers.md L10).
5. **Per-account limits across addresses, device cookies and soft locks**,
   so guesses spread over many addresses are capped and lockouts spare the
   owner *(ConcaveHR's wish)* (D11, L11.4, L11.8).
6. **IPv6 /64 keys and ASN/hosting classes** *(ConcaveHR's wish)* (L2.3, L5).
7. **Dry run for every rule, with an impact estimate** over recorded traffic
   (D9).
8. **Trust-misconfiguration detection** (L2.5) and a **boot self-test**
   (D25), the two failures that silently switch a defence off.
9. **Distinct-count detectors** for credential stuffing (one IP × many
   usernames; many IPs × one username; the global failure ratio) (L11.2).
10. **Uniform authentication answers with a minimum response time**, against
    enumeration by timing (L11.5).
11. **SMS-pumping and card-testing counters** by destination prefix and
    baseline (L11.6).
12. **Honeypot routes and canary credentials, keys and URLs** (L8).
13. **Path canonicalisation, refusal of encoded slashes and duplicate
    `Host`** (L6) [M].
14. **A ReDoS-safe rule language** beyond email patterns (D12, L7), with
    a small managed probe set in dry run.
15. **Fetch Metadata CSRF protection and a native security-headers set**
    (L13).
16. **API-key anomaly rules and canary keys** (L12).
17. **WebSocket message limits** (L9.5).
18. **Signed, versioned, monotonic policy bundles with last known good on
    disk** (D8), replacing the Redis key contract.
19. **A contract-coverage panel**: the routes with no request validator,
    listed from bun-common's `listRoutes`/`effectiveContract`
    (`bun-common/lib/routeModel.ts:293`, `:127`) [S], because ConcaveHR's
    root cause was an unvalidated union DTO and "rate limits only bought
    time" (write-up §8). For bun-nest, the same from `@Validate` metadata.
20. **A control plane off the public listener, RBAC, step-up, two-person
    approval, and a hash-chained audit log** with external checkpoints (D3,
    D17), in place of one super-admin guard on the owner service's public
    API.
21. **Explicit bounds on everything the defence stores or emits** (D21).
22. **A breached-password check hook** (OWASP ASVS 2.1.7, Pwned Passwords'
    range API or a self-hosted copy) [V].

---

## 14. Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | **False positives block real users** during an attack, when operators change rules fastest | high / high | dry run by default, impact estimates, scoped auto-bans (group, not global), expiries required, the test-a-request tool, quick rollback |
| R2 | **A misconfigured `trustProxy`** (trusting a range that includes the internet) makes identity spoofable | medium / high | off by default; `secureAdmin` and the UI warn when a trusted range is public; T-L2-1; the UI shows how each event's client was resolved |
| R3 | **The store becomes the bottleneck or the outage** | medium / high | local-first design; `onStoreError: "local"`; bun-cache's circuit breaker; one round trip at most |
| R4 | **The defence is DoS-able** (key floods, event floods, tarpit exhaustion) | medium / high | control-plane.md §9's bounds, tested (T-L9-2) |
| R5 | **Compromise of the CP** pushes a malicious policy (e.g. allow-list everything) | low / high | deploy-time bundle keys, optional offline signer, two-person approval, external audit checkpoints, monotonic versions |
| R6 | **Bun behaviour changes** under the engine (request normalisation, `requestIP` forms, header limits) | medium / medium | the spikes in `evidence/` become tests (T-L2-2, T-L6-1, T-L6-2) that fail on a change |
| R7 | **Scope creep toward a full WAF** (CRS, bot management) | high / medium | the v1 cut; CRS later (Q10); hooks for commercial providers |
| R8 | **IP-intel licence terms** misapplied by consumers | medium / medium | no data shipped; the docs per source; the UI's attribution line |
| R9 | **The UI's size and test cost** (bun-jobs-ui's precedent: 57,000 lines of tests) | certain / medium | bun-ui's kit and test harness; lazy screens; a `dist/security` budget from the first build |
| R10 | **The trust-proxy foundation changes bun-common's `req.ips`/`req.protocol`** for existing users | certain / medium | the foundation's concern; in 3.0 (a major, rc.0 is out); Express's semantics; release notes |
| R11 | **Clock skew** across systems breaks counter windows, expiries and signatures | medium / medium | store time in the new scripts; ±60 s windows; agents report skew in heartbeats |
| R12 | **Privacy**: events hold IPs, identifiers and redacted request samples | certain / medium | hashed user and username keys, redaction (§8.1), retention tiers, the `viewer` role sees no details |
| R13 | **Blocking our own services** (ConcaveHR's 40-minute outage, write-up §6) | medium / high | service identity (L2.4) exempt by default; the `internal` list; T-L2-4; the UI warns before a ban covers a known service range |
| R14 | **A defence silently off**: the integration not installed, a wrong trust configuration, a window in the wrong unit (all three happened to ConcaveHR, §8) | medium / high | the boot self-test (D25), L2.5's detector, explicit units (L9.3), T-INT-1, T-L2-5, T-L9-3 |
| R15 | **The foundations' APIs do not fit** bun-security (no run-time limit updates, no limited hook, no inspectable resolution) | medium / medium | §20 sent to the building agents now; bun-security wraps rather than forks if a gap remains |
| R16 | **The shared SQL module churns bun-jobs and bun-cache** | certain / low | extracted with re-exports; bun-jobs and bun-cache move in their own later PRs; their suites unchanged are the gate |
| R17 | **Two operators overwrite each other** | medium / medium | revisions on every document (storage.md §3.2), T-ST-1 |
| R18 | **Checks only on routes** miss a creation path (ConcaveHR's team invites) | medium / high | `security.check()` (D24), documented as the primary form; T-L11-4 |

---

## 15. PR slicing, effort and the v1 cut

Focused days. Each PR passes the full gate alone (`bun scripts/typecheck.ts`;
`bun run lint` and `bun run format:check` in each touched directory;
`bun run test` plus `bun test --randomize` with two seeds; the consumer
check for packaging changes; the affected examples), sends the examples a
change report before merging, and lists its new public names for approval.
After a bun-common change, bun-nest's suite and bun-jobs' `test:seeded` run
too (CLAUDE.md).

### 15.1 Group 0: prerequisites in other packages

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| *(foundation)* trust-proxy client IP | `feat/trust-proxy-client-ip` [F]; not counted here | — | — |
| *(foundation)* throttle plugin | `feat/throttle` [F]; not counted here | — | — |
| **PR-P2** bun-common early hooks | a public pre-body hook on bun-common's adapter (parity with bun-nest's `setOnRequestHook`/`registerSecurityHook`), and a before-write hook | — | ~2 d |
| **PR-P3** bun-cache distinct counts | `pfAdd`/`pfCount` driver capability on memory, file, sqlite, postgres, mysql, mariadb, redis, mongo; store time in the new scripts; conformance cases (a `gcra` op joins it, +1.5 d, only if the throttle foundation ships fixed windows only) | — | ~2.5 d |
| **PR-P4** shared signed envelope | bun-jobs' HMAC envelope and nonce-store interface moved to bun-common's utilities, re-exported by bun-jobs unchanged | — | ~1 d |
| | **Group 0 total** | | **~5.5 d** |

### 15.1a Group D: storage ([`storage.md`](storage.md) §10)

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-D0** shared SQL module | `@kingsleyweb/bun-sql` from bun-jobs' dialects, schema and sync and bun-cache's connection helpers; keyset cursors; the MongoDB sync helper | — | ~4 d |
| **PR-D1** store interface, memory, SQLite, `policyFile`, conformance kit | `SecurityStoreDriver`, capabilities, revisions, the change feed, `runSecurityStoreConformance` | PR-D0, PR-S1 | ~4.5 d |
| **PR-D2** Postgres | `postgresStore`, `LISTEN/NOTIFY`, `inet` CIDR queries | PR-D1 | ~2.5 d |
| **PR-D3** bun-cache `./encryption` | the field envelope exported; field sealing in the store | — | ~1 d |
| | **Group D total** | | **~12 d** |

### 15.2 Group 1: the engine (`bun-security`, bun-nest `./security`)

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-S1** package and core | skeleton and recipe; policy schema and `compilePolicy` (explicit units); the engine (stages, actions, decisions, `explain`); L2 on the trust-proxy foundation, service identity, L2.5 detection; L3 lists (CIDR trie, the `internal` list, allow guards); memory state; `./serve` (`withSecurity`, `hardenServe`) | the trust-proxy foundation | ~5 d |
| **PR-S2** limits and counted rules | L9 on the throttle foundation (policy-driven limits, composite keys, several per route, `throttled` events, dry run), counted rules (§0.2), L1 per-IP concurrency and in-flight cap; L14 outcome signals | PR-S1, the throttle foundation | ~3.5 d |
| **PR-S3** bans, shape, deception | L4 (ladder, scores, bans, merge rules), L6 (canonical path, refusals), L8 (honeypots, canary keys and credentials, trap fields) | PR-S2 | ~3.5 d |
| **PR-S4** shared state | `./stores` over bun-cache: `shared` and `hybrid` stores, the local fallback, `onStoreError`, the ban stream over the bus with the 60 s reconcile, scores, WebSocket message limits | PR-S3, PR-P3 | ~3.5 d |
| **PR-S5** bun-common integration | `./http`: `install()`, early hook, route-stage middleware, `security.profile()`, the boot self-test, router-not-found marking, L13 (`securityHeaders`, CSRF, scrubbing) | PR-S1, PR-P2 | ~3 d |
| **PR-S6** bun-nest `./security` | `SecurityModule.forRoot/forRootAsync`, `SecurityGuard` (`APP_GUARD`, declared dependencies, boot self-test), `@SecurityProfile`, `@SkipSecurity`, `@InjectSecurity` (rate-limit decorators are the foundation's); the Nest matrix with a cold boot | PR-S5 | ~2.5 d |
| **PR-S7** sensitive endpoints | L11: signals, the login/OTP/reset profiles, HLL distinct counts, per-account limits, progressive delay, device cookies, soft lock, `uniformAuthResponse()`, identifier patterns and `security.check()`, the breached-password hook | PR-S4 | ~5 d |
| **PR-S8** request rules | L7: the rule language, safe matchers, the regex validator, the managed probe set | PR-S3 | ~4 d |
| **PR-S9** challenges | L10: `ChallengeProvider`, PoW, Turnstile, hCaptcha, clearance cookies, challenge pages, bot signals | PR-S5 | ~3 d |
| **PR-S10** IP intelligence | L5: the MMDB reader, country and ASN conditions and lists, Tor and cloud ranges as classes | PR-S1 | ~3 d |
| **PR-S11** API keys | L12 v1: per-key limits, the new-ASN and many-IPs anomalies, revoke-and-ban | PR-S4, PR-S10 | ~2 d |
| | **Group 1 total** | | **~37 d** |

### 15.3 Group 2: the control plane and agent

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-CP1** events and analytics | the EP ring, sampling and redaction, minute counters, exact refused counts and top-K, the agent batcher, `/agent/events`, the analytics tables in the store, rollups and retention (bun-jobs or timers) | PR-S4, PR-D1 | ~5 d |
| **PR-CP2** management API | `createSecurityApi`, `secureAdmin`; services, groups, service identities, policies, versions, inheritance (409 on a stale revision), bundles (compile, sign), RBAC, `authenticate`/`authorize`/`stepUp`, approvals, CSRF, `/meta/permissions`, OpenAPI and AsyncAPI | PR-S1, PR-D1 | ~6 d |
| **PR-CP3** audit log | hash chain, signed checkpoints, sinks, `verify`, export | PR-CP2 | ~2 d |
| **PR-CP4** agent | `connectAgent`: pull with `ETag`, the nudge channel, signed requests (PR-P4), shared nonce store, last known good, artefacts, heartbeats | PR-CP2, PR-P4 | ~4 d |
| **PR-CP5** live and analytics endpoints | the live hub (channel and SSE, topics, sampling, coalescing, resume), series, top-N, events and ban timeline with keyset cursors | PR-CP1 | ~4 d |
| **PR-CP6** alerts | rules, webhook (signed), email hook, Slack-compatible, rate limits and digests, a bun-jobs delivery queue | PR-CP1 | ~2 d |
| **PR-CP7** test-a-request and impact | `POST /rules/test` over `explain`; the draft impact estimate over stored events | PR-CP2, PR-CP1 | ~2.5 d |
| | **Group 2 total** | | **~25.5 d** |

### 15.4 Group 3: the UI (bun-ui's `/security`)

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-U1** entry and shell | `lib/security/`, `app/security/`, the two `exports` keys and their consumer-check spellings; `securityUi()` on bun-ui's kit (shell, CSP, SRI, `dist/security/`); providers, nav, permissions, scope picker; bun-client typed calls; the live client; the URL-cursor `Pager`; the test harness and its guards | PR-CP2, bun-ui BU-4 | ~4 d |
| **PR-U2** analytics page | every component of ui.md §7, SVG charts, live | PR-U1, PR-CP5 | ~6 d |
| **PR-U3** bans, lists, events | ui.md §4.1, §4.2, the events list | PR-U1 | ~4 d |
| **PR-U4** policies | services and groups, the editor with origins, draft, diff, publish, versions, rollback, dry run, impact, test a request | PR-U1, PR-CP7 | ~7 d |
| **PR-U5** rules, audit, approvals, agents, alerts | ui.md §4.3, §8 | PR-U1, PR-CP3, PR-CP6 | ~4 d |
| **PR-U6** e2e and accessibility | Chrome flows, responsive, contrast, the parsed permissions table and its example | PR-U2 to U5 | ~2 d |
| | **Group 3 total** | | **~27 d** |

### 15.5 Group 4: harnesses, examples, playground

| PR | What it ships | Effort |
|---|---|---|
| **PR-T1** topology harness | the (b) and (c) multi-process suites (§11.4) | ~3 d |
| **PR-T2** attack simulators | `./testing`'s simulators and the T-cases not owned by a layer PR | ~3 d |
| **PR-X1** examples | `examples/bun-security/` (§11.6) | ~5 d |
| **PR-X2** playground | `mountSecurityDemo` with the attacker loop | ~2 d |
| *optional* | the OTel bridge once OT lands | ~1.5 d |
| | **Group 4 total** | **~13 d** (+1.5 d) |

### 15.6 Order and the v1 cut

**Order.** The two foundations first (in progress); PR-P2, P3, P4, D0 and
D3 can start beside them. Then PR-S1 → S2 → S3; D1 after D0 and S1; S4
after P3; S5 after P2; S6 after S5; S7, S8, S9, S10 in parallel after
their parents; S11 last. PR-CP2 can start after S1, beside the rest of group
1; CP1 after S4; CP3, CP4, CP5, CP6, CP7 after their parents. PR-U1 after
CP2, the rest of group 3 beside group 2's tail. PR-T2 grows with group 1;
PR-T1 after S4 and CP4; PR-X1 per milestone; PR-X2 at M3.

| Milestone | PRs | Effort | What it gives |
|---|---|---|---|
| **M1 the engine** | P2–P4, D0, D1, S1–S11, T2, the M1 examples | ~54 d + ~2 d examples | (a) and (b) with a policy file or a SQLite store; every v1 layer; bun-common, `Bun.serve`, bun-nest; **ConcaveHR's whole request path** (§12; its admin API and insights page arrive with M2 and M3) |
| **M2 the control plane** | D2, D3, CP1–CP7, T1 | ~32 d | (c); the Postgres store; groups; signed bundles; audit; analytics data; alerts |
| **M3 the UI** | U1–U6, X2, the remaining examples | ~32 d | the management UI and analytics page |

**v1 = M1 + M2 + M3.** The "later" list is §1.4's.

---

## 16. Open questions for the user

Each with a recommendation. Asked once; the answers go in the plan.

**Answered 2026-11-07: the user approved every recommendation below as written** (Q19 needed no decision: the Bun bug was already filed as oven-sh/bun#44232). The Recommendation column is therefore the decision.

| # | Question | Recommendation |
|---|---|---|
| Q1 | **Packages**: `@kingsleyweb/bun-security` (engine, adapters, CP, agent, store drivers) and the UI as bun-ui's `/security` entry (the user's decision of 2026-11-08, [`bun-ui`](../bun-ui/README.md); asked on 2026-11-07 as a separate `@kingsleyweb/bun-security-ui`); bun-nest's integration as `@kingsleyweb/bun-nest/security` | **Yes** (D1, ui.md §1) |
| Q2 | **v1 scope**: M1 + M2 + M3 as §15.6, with §1.4's "later" list out of v1 | **Yes**; land M1 first so ConcaveHR can replace its three in-repo copies with the package before the UI exists |
| Q3 | **Counted rules and the offence score together**: counted rules as the operator's main form (ConcaveHR's), the score and ladder as escalation on top | **Yes** (D23, D10) |
| Q4 | **Default fail mode** when the shared store is down | **`local`** (per-process limits), with `open` and `closed` per rule (D7) |
| Q5 | **Distinct counts (HyperLogLog)** as a new bun-cache driver capability (PR-P3), or private code in bun-security | **bun-cache** (eight drivers, conformance kit, schemas already there) |
| Q6 | **Default scope of an auto-ban**: the service, its group, or global | **The group** (a false positive in one product does not lock a customer out of all; ConcaveHR's three APIs would be one group) |
| Q7 | **IP-intelligence source** to document as the default | **DB-IP Lite (CC BY 4.0)** for country and ASN; any MMDB accepted (GeoLite2, IPinfo Lite); no data shipped (D14) |
| Q8 | **MMDB reader**: our own (no dependency) or `mmdb-lib` (MIT) as an optional peer | **Our own** (the format is small and public) |
| Q9 | **CAPTCHA stance**: provider-neutral interface; built-in proof of work; Turnstile and hCaptcha adapters in v1; reCAPTCHA later | **Yes**; and make the PoW challenge **ALTCHA-compatible** so its MIT widget works unchanged, if PR-S9's reading of ALTCHA's spec allows it |
| Q10 | **OWASP CRS** port | **Later**, not v1 (layers.md L7) |
| Q11 | **Break-glass account** for the CP when the identity provider is down | **Yes, opt-in**, TOTP required, every use alerted |
| Q12 | **The signed envelope**: move bun-jobs' remote envelope into bun-common's utilities (PR-P4), or depend on bun-jobs | **Move it** (bun-jobs re-exports it unchanged); service identities (L2.4) use it too |
| Q13 | **Bundle signing key**: held by the CP (encrypted, with a `sign` hook for a KMS), or an offline signer from v1 | **CP-held in v1** with the hook; offline signer later |
| Q14 | **A third copy of the UI server code** (shell, CSP, assets): copy again, or extract a shared internal module first | **Extract**: done by bun-ui's kit (BU-4), before PR-U1 |
| Q15 | **Geography component**: a world map or a ranked table | **A table in v1** (no map data or dependency); a map later |
| Q16 | **IETF `RateLimit` headers** by default (the throttle foundation's choice; this is bun-security's recommendation to it) | **Off by default** (a draft; it helps attackers pace) |
| Q17 | **Two-person approval** default | **Off**, with the setup flow recommending it for production scopes in (c) |
| Q18 | **Package name** | **`bun-security`** as asked (alternatives considered: `bun-shield`, `bun-defence`) |
| Q19 | **Duplicate `Host` (Bun bug, §18)**: file on oven-sh/bun | **Done**: already filed as [oven-sh/bun#44232](https://github.com/oven-sh/bun/issues/44232); our build confirmed in a comment (2026-11-07). No decision needed |
| Q20 | **The `internal` never-block list on by default** (loopback, RFC 1918, CGNAT, link-local, ULA, as ConcaveHR does) | **Yes**, with L2.5's alert, because the list also hides a broken trust configuration |
| Q21 | **Service identity exemptions on by default** for verified sibling services (lists, bans, counted rules, global limits), with strict routes still limited on the forwarded end user | **Yes** (L2.4; ConcaveHR's main lesson) |
| Q22 | **Storage reuse**: extract `@kingsleyweb/bun-sql` (bun-jobs' dialects, schema and sync, bun-cache's connection helpers, keyset cursors) for bun-security, and move bun-jobs and bun-cache onto it later | **Yes** (storage.md §4); the alternative, a third private SQL layer, is what this avoids |
| Q23 | **v1 store drivers**: memory, SQLite, Postgres, and a read-only `policyFile`; MySQL/MariaDB, Redis, MongoDB later | **Yes** (storage.md §5) |
| Q24 | **EPs may read bundles straight from the store** in topology (b) (ConcaveHR's model), as well as through the CP | **Yes**; the bundle is signed either way (storage.md §6) |
| Q25 | **Field encryption**: export bun-cache's envelope as `./encryption` (PR-D3) for the store's secrets | **Yes** (storage.md §8) |
| Q26 | **Policy in a file** (`policyFile`, GitOps) shown as locked in the UI, beside UI-managed policy | **Yes** |
| Q27 | **The trust configuration stays deploy-time** (environment or code), not a run-time policy field | **Yes** (§12.2's last row: a run-time switch over who the client is would be a strong lever for a compromised CP) |
| Q28 | **A contract-coverage panel** in the UI (routes with no request validator) | **Yes**, in PR-U4 (within its estimate); ConcaveHR's root cause (§13 item 19) |

---

## 17. Names needing approval

Every new public name proposed (none built):

| Name | Kind | Where |
|---|---|---|
| `@kingsleyweb/bun-security` | package | new |
| `@kingsleyweb/bun-ui/security`, `@kingsleyweb/bun-ui/security/browser` | subpaths | bun-ui |
| `./http`, `./serve`, `./stores`, `./challenge`, `./intel`, `./agent`, `./control`, `./testing` | subpaths | bun-security |
| `@kingsleyweb/bun-nest/security` | subpath | bun-nest |
| `createSecurity`, `Security` (`evaluate`, `install`, `middleware`, `profile`, `signal`, `check`, `explain`, `load`, `close`), `compilePolicy`, `Decision`, `RuleHit`, `SecurityPolicy`, `SecurityRefusal` | function, types, class | `.` |
| `securityMiddleware`, `securityHeaders`, `csrf`, `uniformAuthResponse`, `createSecureAdapter` | functions | `./http` |
| `withSecurity`, `hardenServe` | functions | `./serve` |
| `cacheStore`, `hybridThrottleStore` | functions | `./stores` |
| `SecurityStoreDriver`, `SecurityStoreCapabilities`, `memoryStore`, `sqliteStore`, `postgresStore`, `policyFile`, `ListQuery`, `Page` | types, functions | `./store` |
| `runSecurityStoreConformance` | function | `./testing` |
| `@kingsleyweb/bun-sql` | package | new, extracted (storage.md §4) |
| `sealField`, `openField` | functions | bun-cache `./encryption` (PR-D3) |
| `ChallengeProvider`, `powChallenge`, `turnstile`, `hcaptcha` | type, functions | `./challenge` |
| `ipIntel`, `openMmdb` | functions | `./intel` |
| `connectAgent` | function | `./agent` |
| `createSecurityApi`, `secureAdmin` | functions | `./control` |
| `securityUi` | function | bun-ui `/security` |
| `SecurityModule`, `SecurityGuard`, `SecurityProfile`, `SkipSecurity`, `InjectSecurity` | module, guard, decorators | bun-nest `./security` |
| actions `allow`, `log`, `tag`, `delay`, `challenge`, `block`, `ban`, `drop`; modes `enforce`, `dryRun`, `off`; `onStoreError` `local`/`open`/`closed`; state modes `local`/`shared`/`hybrid` | values | policy format |
| roles `viewer`, `analyst`, `operator`, `admin`, `owner` | values | `./control` |
| `bun-security.bundle/1` | format id | bundles |
| counted-rule events `auth.failure`, `mfa.failure`, `signup`, `password.reset`, `request`, `route.notFound`, `pattern.hit`, `throttled`; the `internal` list; list kinds `email`, `phone`, `username`, `domain`; `ServiceIdentity` | values, entity | policy format |
| `pfAdd`, `pfCount`, capability `distinctCount` | driver operations | bun-cache (PR-P3) |

The trust-proxy and throttle names (`trustProxy`, `throttle()`,
`ThrottleStore`, `cacheThrottleStore`, `@Throttle`, `@SkipThrottle`) are
the foundations', approved with them, not here.

---

## 18. Findings outside this plan

Found while surveying; each is reported, none fixed here.

1. **Bun accepts an HTTP/1.1 request with two `Host` header lines**, joining
   them as `"a.example, b.example"` and building `req.url` from the first;
   RFC 9112 §3.2 requires a 400 [V]. Minimal reproduction, Bun only, exits
   1 while the bug is present:
   [`evidence/request-shape/repro-duplicate-host.ts`](evidence/request-shape/repro-duplicate-host.ts)
   [M, Bun 1.4.4-canary.1+11c367163]. Already filed upstream as
   [oven-sh/bun#44232](https://github.com/oven-sh/bun/issues/44232) (open,
   reported on 1.4.2); the coordinator confirmed it on this build and
   [commented](https://github.com/oven-sh/bun/issues/44232#issuecomment-6713117321)
   (2026-11-07). It goes into `docs/bun-bugs/` when the L6 workaround is
   built.
2. **bun-common trusts forwarding headers unconditionally**: `req.ips` reads
   `X-Forwarded-For` with no trust check (`bun-common/lib/BunRequest.ts:5372`,
   its doc says so at `:5367-5371`), and `req.protocol`/`req.secure` believe
   `X-Forwarded-Proto` (`:5267-5276`, `:5418`) [S]. An app that rate-limits on
   `req.ips[0]` or redirects on `req.secure` behind no proxy is spoofable.
   Express returns `[]` and the socket's protocol unless `trust proxy` is set
   [V]. ConcaveHR's write-up confirms it in practice: its APIs read `ips` as
   "`X-Forwarded-For` split" (§3). **The trust-proxy foundation fixes this**
   (§2.6).
3. **bun-nest accepts `set("trust proxy")` and ignores it**
   (`bun-nest/lib/BunHttpAdapter.ts:5284`) [S]: a Nest app that sets it
   believes it has proxy handling. The trust-proxy foundation wires it.
4. **A default `Bun.serve` listener reports IPv4 clients as
   `::ffff:a.b.c.d`** [M, `evidence/client-ip/results-dualstack.txt`]: any
   address comparison in the repo must normalise. bun-common's
   `isLoopbackAddress` already handles `::ffff:127.` (`docs/devTypes.ts:376`)
   [S]; new code should use the trust-proxy foundation's normalisation
   (§20 asks for it).
5. **`BunRequest.socket.localAddress` returns the peer's address**, not the
   local one (`bun-common/lib/BunRequest.ts:3263`) [S, survey; not
   re-checked]. A compatibility shim's naming, but misleading in a security
   context.

---

## 19. Sources

Read 2026-11-07 unless noted.

- OWASP, *Credential Stuffing Prevention Cheat Sheet*,
  <https://cheatsheetseries.owasp.org/cheatsheets/Credential_Stuffing_Prevention_Cheat_Sheet.html>
- OWASP, *Authentication Cheat Sheet* (login throttling, account lockout,
  authentication responses), <https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html>
- OWASP, *Regular expression Denial of Service — ReDoS*,
  <https://owasp.org/www-community/attacks/Regular_expression_Denial_of_Service_-_ReDoS>
  (redirects to community.owasp.org; not re-read for this plan)
- OWASP, *Cross-Site Request Forgery Prevention Cheat Sheet* (Fetch Metadata)
  [U: cited from prior knowledge, to be read in PR-S5]
- IETF, *RateLimit header fields for HTTP*, draft-ietf-httpapi-ratelimit-headers-11
  (23 May 2026), <https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/>
- MDN, *X-Forwarded-For*, <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For>
- RFC 9112 §3.2 (Host); RFC 7239 (`Forwarded`); RFC 6177 (IPv6 end-site
  assignments) [U: cited from prior knowledge]
- DB-IP, *IP to Country Lite*, <https://db-ip.com/db/download/ip-to-country-lite>
- IPinfo, *Free IP data downloads*, <https://ipinfo.io/products/free-ip-data-downloads>
- MaxMind, *GeoLite2 EULA*, <https://www.maxmind.com/en/geolite2/eula>
  (terms read from a 2020 copy quoted on debian-legal; current text not confirmed)
- ALTCHA, <https://github.com/altcha-org/altcha> (MIT)
- Cloudflare, *Turnstile server-side validation*,
  <https://developers.cloudflare.com/turnstile/get-started/server-side-validation/>
- Express `trust proxy` / `proxy-addr` semantics [U: cited from prior
  knowledge; the trust-proxy foundation must match them exactly]

---

## 20. What bun-security needs from the two foundations

Sent to the coordinator on 2026-11-07 so the agents building the
foundations can be steered early. **None blocks bun-security outright**: for
each, the fallback is a wrapper inside bun-security, which costs a little
duplication. Items marked **must** would otherwise make bun-security
re-implement the foundation or carry a correctness risk.

### 20.1 Trust-proxy client IP (`feat/trust-proxy-client-ip`)

1. **Must: the walk is Express's** (`proxy-addr`): from the peer, leftward,
   while the hop is trusted; the first untrusted address is `req.ip`. The
   brief's phrase "the left-most untrusted address" must not become "the
   left-most entry": with `trustProxy: ["10.0.0.0/8"]`, peer `10.0.0.1`,
   `X-Forwarded-For: <spoof>, 203.0.113.5`, `req.ip` is `203.0.113.5`. A
   test with exactly that case.
2. **Must: normalise `::ffff:a.b.c.d` to `a.b.c.d`** in `req.ip`, `req.ips`
   and before matching trusted CIDRs: a default `Bun.serve` listener reports
   IPv4 peers in the mapped form [M, `evidence/client-ip/results-dualstack.txt`],
   so `trustProxy: ["10.0.0.0/8"]` would otherwise trust nothing on a default
   listener.
3. **Must: hop count** as well as CIDRs, named sets and a function
   (ConcaveHR's Railway deployment needs `hops: 2`, write-up §5), and a
   Railway preset checked against the real header shape (`[client, edge]`,
   the edge rotating).
4. **Should: export the IP and CIDR utilities** (parse, normalise, contains,
   a compiled CIDR set), so bun-security's lists, bans and `internal` range
   use the same code.
5. **Should: expose the resolution** (the hops seen, which were trusted,
   the preset used) on the request, for events, `explain()` and the UI.
6. **Should: keep the trust configuration out of request-time mutation**
   (no per-request override), and document that `trustProxy: true` reaches
   the left-most, client-supplied entry.
7. **Note for bun-security, not the foundation**: forwarded end-user
   addresses from verified sibling services (L2.4) are bun-security's
   concern; the foundation should not grow a "trust this header from that
   token" feature.

### 20.2 Throttle plugin (`feat/throttle`)

1. **Must: limits updatable at run time** without re-registering middleware
   (a handle with `update(limits)`, or a limit resolved per request from a
   function), because bun-security loads new bundles while serving.
2. **Must: a hook on every limited request** (`onLimited(req, info)` with
   the limit's name, key, count and reset), so a 429 becomes a `throttled`
   event and can feed counted rules and escalation.
3. **Must: a caller-supplied key function** receiving the request (so keys
   can be `req.ip` with IPv6 /64, `ip|account`, `user`, `apiKey`), and a
   `skip(req)` predicate (service identities, allow-listed subjects).
4. **Must: several named limits on one route**, each with its own key
   (ConcaveHR's sign-in: 10/min per `ip|account` and 30/min per `ip`).
5. **Must: explicit units** (durations as `"1m"` strings or `{ seconds }`,
   never a bare number of ambiguous unit; refuse a sub-second window unless
   asked), the lesson of ConcaveHR's `THROTTLE_TTL=60` meaning 60 ms.
6. **Should: `ThrottleStore` with a cost per hit, a peek that consumes
   nothing** (for dry run and `explain()`), and **a reset of one key**
   (an operator's unban or allow-list entry lifts its counters).
7. **Should: `onStoreError` accepting a fallback store** as well as
   `"open"`/`"closed"`, so "degrade to local" is one option.
8. **Should: a sliding window or GCRA** beside the fixed window, for routes
   where a boundary burst matters (layers.md L9.2); if not, bun-security
   works with fixed windows and PR-P3 grows a `gcra` op later.
9. **Should: store time, not the caller's clock**, in `cacheThrottleStore`'s
   Redis path, or a documented NTP requirement (bun-cache's counter script
   takes the client's clock today, `bun-cache/lib/drivers/redis.ts:1236`)
   [S].
10. **bun-nest: declared constructor dependencies on the guard** (no
    inherited metadata; ConcaveHR's subclassed `ThrottlerGuard` broke Nest's
    injection on cold boots) and **a boot check that the guard is installed**
    (ConcaveHR's pay-api ran unthrottled because a pipe was registered as the
    `APP_GUARD`).
11. **Should: the 429 log line names the route and limit, never the address
    or account**, and the `RateLimit` headers default off (Q16).
