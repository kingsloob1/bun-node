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

**Status: approved by the user on 2026-11-07, every open question (§16) answered with its recommendation as written. M1 started on 2026-11-15 with the user's go-ahead: PR-S1 (package and core) is built, not yet merged ([Status](#status-2026-11-16)).** The foundations it builds on are trustProxy (merged, #653) and the throttle (merged as three PRs, T1 #654, T2 #655 and T3 #656). **Changed on 2026-11-08:** the management UI is no longer a package of its own, `@kingsleyweb/bun-security-ui`, but the `/security` entry (with `/security/browser`) of `@kingsleyweb/bun-ui`, because the user decided that every bun-node UI lives in one package ([`bun-ui`](../bun-ui/README.md), approved 2026-11-08; its §7 lists every edit made here). No security decision changed; PR-U1 drops to ~4 d and the optional shared-module PR (Q14) becomes bun-ui's BU-4. **Added on 2026-11-10, at the user's request:** a verified-crawler allowance ([`layers.md` L3.2](layers.md#l32-verified-crawlers-let-search-engines-index-the-site-d-v)), so that path scanning by search-engine crawlers is not blocked and their index of a service keeps building. It is a new PR, PR-S12 (~2.5 d), with three new questions, Q29 to Q31 (§16), answered the same day with their recommendations.

Written 2026-11-07 against `develop` at `36be4163`, on Bun 1.4.4-canary.1
(`11c367163`). **No product code was changed.** Every `file:line` is at
`36be4163` and relative to `packages/` unless it says otherwise. The spikes
are in [`evidence/`](evidence/README.md); none measures speed (the standing
rule: no benchmarks or speed comparisons without the user's yes).

### Status (2026-11-16)

| Part | State |
|---|---|
| This plan and its sub-plans | **approved** by the user on 2026-11-07 (above) |
| M1, the engine | **started 2026-11-15** at the user's go-ahead. **PR-S1 merged** (#789, 2026-11-16): `packages/bun-security` with the packaging recipe, the policy format (`compilePolicy`, `securityPolicySchema`, explicit units), the engine (`createSecurity`: `evaluate`, `explain`, `load`, `status`, `close`), L2 on the trust-proxy foundation with service identity and the L2.5 trust check, L3 lists (CIDR trie, the `internal` list, allow guards), memory state, and `./serve` (`withSecurity`, `hardenServe`). **PR-S2 merged** (#793, 2026-11-16): the policy format's `version`, L9 limits on the throttle foundation (policy-driven, composite keys, several per route, `throttled` events, dry run), counted rules, L1 per-IP concurrency and the in-flight cap, L14 outcome signals (`complete`, `signal`). **PR-S3 merged** (#796, 2026-11-16): L4 bans (manual `ban`/`unban`/`bans`, merge rules, the `maxActive` bound with /24 and /48 widening), the offence score and escalation ladder, L6 (the canonical path in `facts.path`, the shape refusals, the duplicate-`Host` refusal), L8 (honeypot routes, canary credentials, trap fields), and the `policy.newer` issue code. **PR-S5 built** on `feat/bun-security-s5` (2026-11-16), not yet merged: `./http` (`installSecurity` on P2's hooks with the boot self-test, the route stage `securityMiddleware`, `securityProfile`, router-not-found marking, L13 `securityHeaders`, `csrf` and stack-trace scrubbing) and two-stage evaluation (`evaluate(facts, { stage })`) across S2's and S3's layers. **PR-S6 built** on `feat/bun-security-s6` (2026-11-16), not yet merged: bun-nest's `./security` (`SecurityModule.forRoot`/`forRootAsync`, `SecurityGuard` as `APP_GUARD` with declared dependencies, `@SecurityProfile`, `@SkipSecurity`, `@InjectSecurity`, the boot self-test, a cold-boot test) on a new `addBeforeReadHook` on bun-nest's adapter. **PR-S8 built** on `feat/bun-security-s8` (2026-11-16), not yet merged: L7 request rules (`requestRules`: the rule language, safe matchers, the glob matcher, the regex validator with T-L7-1's step-count proof, the managed probe set, staged early or route, hits feeding `pattern.hit`/`probe.hit` (since PR-T2 `rule.hit`/`probe.hit`) and the ladder, a verified-crawler hook for PR-S12). **PR-S4 built** on `feat/bun-security-s4` (2026-11-16), not merged: `./stores` over bun-cache (`cacheStore`, `hybridThrottleStore`), limits' and counted rules' `state` (`local`/`shared`/`hybrid`) and `onStoreError` (`local` at the local share, `open`, `closed`), the ban stream (a log over the store, the bus's nudge, a 5 s poll, the 60 s reconcile, a snapshot), offence scores and the ladder's history synced, distinct counts over `pfAdd`/`pfCount` (for PR-S7), WebSocket message limits (`messages`, `socket()`, `./http`'s `securityWebSocket`), and the limits counted through the throttle's `count()`/`peekCount()` (#791). **PR-S9 built** on `feat/bun-security-s9` (2026-11-16), not yet merged: L10 challenges (`./challenge`: `challenges()` with clearance cookies and header tokens, the ALTCHA-compatible `powChallenge`, `turnstile`, `hcaptcha`, the challenge page under a strict CSP), every `challenge` action made real in its own stage with the fall-back to `block` kept for an engine without a flow, and L10.1 bot signals (`botSignals`). **PR-S7 built** on `feat/bun-security-s7` (2026-11-16), not merged: L11's sensitive endpoints (route profiles `login`, `mfa`, `otp`, `reset`, `signup` scoping rules; the attempted `username` and `destination` keyed by HMAC under `createSecurity`'s `secret`; the login defences: progressive delay, challenge, soft lock, device cookies, distinct usernames per address and addresses per username over the S4 distinct counts, `risky-success`, outcome inference; `uniformAuthResponse()`; identifier patterns and `security.check()` with the breached-password hook) and the **presets** (`per-ip` and `per-user` on, enforced; the profiles' rules on, on their routes; `not_found_per_minute` off), overridable by id. **PR-S10 built** on `feat/bun-security-s10` (2026-11-16), not yet merged: L5 IP intelligence (`./intel`: our own MMDB reader `openMmdb`, `ipIntel` with country and ASN from operator-supplied databases, range feeds as classes with the refresh job, minimum entry counts and the last good copy kept), `country`/`asn` list entries, `country`/`asn`/`class` request-rule conditions and `botSignals.classes`. **PR-S12 built** on `feat/bun-security-s12` (2026-11-16), not yet merged: L3.2 verified crawlers (the registry, `ranges` and forward-confirmed `rdns` verification with its cache and bounds, the `crawlers` option and its nine exemptions, the crawler limit, `crawler.spoofed`, the conflict check, `crawlerFeeds()` in `./intel`), S8's crawler hook filled, and the managed probe set and `not_found_per_minute` on by default in dry run. **PR-S11 built** on `feat/bun-security-s11` (2026-11-16), not yet merged: L12 v1 (API keys keyed by HMAC, per-key and per-plan limits, the new-ASN and many-addresses anomalies on S4's shared state and S10's intel, `onKeyCompromised`, `revokeApiKey()`). **PR-T2 built** on `feat/bun-security-t2` (2026-11-16), not yet merged: `./testing`'s attack simulators (§11.2) and the runner, and end-to-end attack tests (`__tests__/attacks/`) against ConcaveHR's request path (§12) on `installSecurity`, closing T-L13-1 and T-INT-1 end to end. **The global failure-rate rule merged** (#824, 2026-11-17): layers.md L11.2's global failure ratio, which T2's attack suite showed missing (a spray from a fresh address per attempt answered 60 of 60), as the `login.failure-rate` preset, on in dry run (§17.20). **The eviction wiring built** on `feat/bun-security-evictions` (2026-11-17), not yet merged: the default throttle store's drops at `maxKeys` (bun-common's `onEvict`, #821, `"cap"` only) counted in `status().state.evictions` and the `state.evictions` warning, and the failure-rate rule's example (§17.21). Every other PR of M1 not started |
| M2, the control plane | **started 2026-11-17** (the user: M2 and M3 finished before anything is published). **PR-CP2 merged** (#828, 2026-11-17): `./control` (`createSecurityApi`, `secureAdmin`) with services, groups, service identities, drafts, versions and inheritance with locked items, Ed25519-signed bundles (`verifyBundle` in `.`), dangerous-change confirmation and two-person approvals, step-up, the built-in RBAC, CSRF, the live stream and the OpenAPI and AsyncAPI documents; `./control/contract`, browser-safe; bundles in the store (§17.22). **PR-CP3 built** on `feat/bun-security-cp3` (2026-11-17), not yet merged: the audit log (a hash chain over every change, recorded intent first; Ed25519 checkpoints under a key of its own, in the store and in file, webhook or callback sinks; `verifyAudit()` naming where the chain broke, and reconciling an intent with no done; `/audit` routes, export, `purgeAudit`), its records in the store (memory, SQLite, Postgres under D2's lock), break-glass (Q11) and `onAlert` (§17.24) **PR-CP1 merged** (#837, 2026-11-17): the store's analytics operations on memory, SQLite and Postgres (events, counters, series, top-K, rollups with watermarks and carried-up late rows, bounded retention deletes), `./analytics` (the recorder's minute counters, exact refusals and top-K; the event ring with the user's caps; the redaction module; `analyticsHook`; rollups and retention), and `POST /agent/events` on `createSecurityApi` (§17.26); the agent's batcher is PR-CP4's **PR-CP4 built** on `feat/bun-security-cp4` (2026-11-17), not yet merged: the agent (`./agent`: `connectAgent`, the last known good, signed pulls of bundles and ban batches, artefacts, heartbeats, the nudge, the event batcher behind CP1's contract), agent keys with rotation and revocation, the `/agent/*` routes, bans in the store and their routes (§17.27) |
| ConcaveHR's write-up of its defence | **folded in** (§12, received 2026-11-07): every layer mapped, its lessons carried into the design and §14 |
| Foundations built beside this plan (§2.6) | the **trust-proxy client IP**, merged 2026-11-07, #653, and the **throttle plugin**, merged 2026-11-08 as T1 #654, T2 #655 and T3 #656 (follow-ups #669, #670, #672, #673, #675, #703), both requested by the user. bun-security builds on them (§20 lists what it needs from them) |
| Storage drivers for durable state ([`storage.md`](storage.md)) | added 2026-11-07 at the user's request. **PR-D0a merged** (#816, 2026-11-16): `@kingsleyweb/bun-sql`; D0 split into D0a, D0b and D0c (§15.1a, §17.16), D0b and D0c deferred. **PR-D1 merged** (#818, 2026-11-16): `./store` (the driver interface with revisions, policy versions and the change feed; `memoryStore`, `sqliteStore` on bun-sql, the read-only `policyFile`), `./testing` (`runSecurityStoreConformance`, `faultyStore`), and `createSecurity({ policy: { store } })` following a stored policy with a last known good (§17.18). **PR-D2 merged** (#829, 2026-11-17): `postgresStore` on D1's SQL core, its feed pushed by `LISTEN`/`NOTIFY` (polling while `LISTEN` cannot be set up), writers serialised by a transaction-scoped advisory lock so the change sequence commits in order (§17.23). **PR-D3 built** on `feat/bun-security-d3` (2026-11-17), not yet merged: bun-cache's `./encryption` (its envelope for one value: `sealField`, `openField`, `fieldKeyRing`, `fieldKeyId`, under labels of its own), and bun-security's `./sealing` (`sealedFields`, a `StoreCodec` sealing named fields bound to their table, kind, id, version and path, with key rotation, and `resealStore`), with the default sealed fields of §17.25 |
| Prerequisites in other packages (§15.1) | **PR-P2 merged** (#794, 2026-11-16): bun-common's adapter gains `addBeforeReadHook` (before `BunRequest.init`: no body, cookie or query read; answer, drop or hold) and `addBeforeWriteHook` (every response before it is written, phases `early`, `response`, `error`). **PR-P3 built** on `feat/bun-security-p3` (2026-11-16), not yet merged: bun-cache distinct counts (`pfAdd`/`pfCount`, capability `distinctCount`) on memory, file, SQLite, Postgres, MySQL, MariaDB, Redis (native) and MongoDB, timed by the store's clock, with conformance cases; no `gcra` op (the throttle foundation already ships GCRA). **PR-P4 built** on `feat/bun-security-p4` (2026-11-16), not yet merged: bun-jobs' HMAC envelope and nonce-store interface moved to bun-common's browser-safe `./envelope` (`envelopeCodec` binds a package's own `ConfigError` and header names), re-exported by bun-jobs unchanged, with a wire-compatibility test against envelopes the old code signed |
| Verified crawlers ([`layers.md` L3.2](layers.md#l32-verified-crawlers-let-search-engines-index-the-site-d-v)) | **added 2026-11-10** at the user's request: PR-S12; Q29 to Q31 answered with their recommendations |
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
| The engine and adapters, bun-nest `./security` (PR-S1 to S12) | ~39.5 d | the foundations, PR-P2, P3, D1 |
| The control plane and agent (PR-CP1 to CP7) | ~25.5 d | PR-S1, S4, P4, D1 |
| The UI (PR-U1 to U6) | ~27.5 d | PR-CP2, CP5 |
| Topology and attack test harnesses, examples, playground (PR-T1, T2, X1, X2) | ~13 d | each |
| **Total** | **~123 d**, plus ~1.5 d optional (the OTel bridge once OT lands) and ~11 d of later drivers; the shared UI-server module is bun-ui's BU-4 | |

Focused days for someone who knows the code; §15 has the order.

### 1.4 The v1 cut

v1 is three milestones, each usable on its own (§15.6):

- **M1, the engine** (~58.5 d with the prerequisites, the SQLite store and
  examples): topologies (a) and (b) with a policy file or a SQLite store,
  every v1 layer of [`layers.md` §15](layers.md#15-what-is-v1-and-what-is-later),
  bun-common, `Bun.serve` and bun-nest adapters, shared state on Redis and
  SQL. **ConcaveHR could adopt it here**: everything its three APIs do on the
  request path maps onto M1 (§12); its admin API and insights page map onto
  M2 and M3.
- **M2, the control plane** (~32 d): the Postgres store, services and
  groups, inheritance, signed bundles, agents, topology (c), RBAC, step-up,
  approvals, audit, analytics ingestion and rollups, live hub, alerts.
- **M3, the UI** (~27.5 d, overlapping M2): every screen of ui.md, the
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
| `./serve` | `withSecurity(security, fetch, options?)` for a plain `Bun.serve` (the order §3.4's example uses; the user's decision, 2026-11-16), `hardenServe(options)` | EPs on raw Bun |
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
| T-L7-1 ReDoS-shaped patterns | refused by the validator; accepted patterns stay bounded on the generated adversarial inputs, at most about n² steps over `maxRegexInput` (no timing assertion: a step count from an instrumented matcher) |
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
| T-L10-1 a challenge before a ban (ConcaveHR's `signups_per_ip`, §8): a counted rule challenges; one client solves it, another keeps failing | the solver passes on its clearance; the failer's `challenge.failed` climbs the ladder to a ban, which its clearance does not lift. Negative control: without a challenge flow the rule blocks, as before PR-S9 |
| T-L3-1 a verified crawler (fixture ranges and a fake resolver) crawls 500 dead links, a published `/wp-admin` link and a honeypot | no ban, no challenge, no score; `crawler.probe` and `crawler.honeypot` logged. Negative control: with the allowance off, `not_found_per_minute` bans it |
| T-L3-2 a Googlebot `User-Agent` from an address outside the ranges, and one whose PTR names `googlebot.com` but whose forward lookup does not return it | both unverified, `crawler.spoofed`, blocked |
| T-L3-3 a verified crawler `POST`s to sign-in, or `GET`s an excluded path | evaluated as an ordinary client |
| T-L3-4 a resolver that hangs, errors, or floods (1,000 claimants at once) | unverified within `verifyTimeoutMs`, nothing cached, at most `maxPendingVerifications` lookups open |
| T-L3-5 a truncated crawler range file; a country block covering a crawler's ranges | the last good file kept; the compiler's conflict warning names the crawler and the entry |

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
23. **Verified search-engine crawlers** (layers.md L3.2, added 2026-11-10 at
    the user's request). They are verified by the engines' published IP ranges
    or forward-confirmed reverse DNS, never by `User-Agent`, and are exempt from
    the not-found, probe, honeypot, bot-signal, challenge and geo rules that a
    crawl would otherwise trip. A spoofed claimant is a strong signal.

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
| R19 | **The defence de-indexes the site**: a crawl trips the not-found rule, a probe rule, a honeypot, a challenge or a geo block, and the engine drops the pages | high without L3.2 / high | the verified-crawler allowance on by default (Q29); the conflict check; the alert on a crawler limited for a day; T-L3-1 |
| R20 | **The crawler allowance becomes a bypass**: a forged `User-Agent`, a PTR record the attacker controls, or a fetcher anyone can steer | medium / high | verification by ranges or forward-confirmed rDNS only; user-triggered fetchers outside the default set; `GET`/`HEAD` and the allowance's paths only; L6, L11, L12, canaries and manual bans never lifted; T-L3-2, T-L3-3 |

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
| **PR-D0a** shared SQL module | the package `@kingsleyweb/bun-sql`: bun-jobs' dialects (without its claim statements), schema renderers and sync, the collation guard, keyset cursors, bun-cache's connection helpers, the MongoDB index sync, `documentType` and `inetType`; a parity test against bun-jobs' table definitions; no other package changed | — | ~4 d |
| **PR-D0b** bun-jobs onto bun-sql | bun-jobs' `SqlDialect` becomes bun-sql's plus its claim members under the same name; schema, sync, cursors and the collation guard re-exported; its `ConfigError` through the seam; no public change | PR-D0a | ~2 d |
| **PR-D0c** bun-cache onto bun-sql | bun-cache's connection helpers from bun-sql; its SQL drivers on bun-sql's sync behind an adapter that keeps its public `SchemaSyncOptions { dryRun }` and `SchemaChange` shapes; no public change | PR-D0a | ~2 d |
| **PR-D1** store interface, memory, SQLite, `policyFile`, conformance kit | `SecurityStoreDriver`, capabilities, revisions, the change feed, `runSecurityStoreConformance` | PR-D0a, PR-S1 | ~4.5 d |
| **PR-D2** Postgres | `postgresStore`, `LISTEN/NOTIFY`, `inet` CIDR queries | PR-D1 | ~2.5 d |
| **PR-D3** bun-cache `./encryption` | the field envelope exported; field sealing in the store | — | ~1 d |
| | **Group D total** (D0b and D0c beside D1) | | **~16 d** |

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
| **PR-S12** verified crawlers | L3.2: the crawler registry (methods, not data), the range files on L5's refresh job, forward-confirmed reverse DNS with its cache and bounds, the `crawlers` policy option and its exemptions across L5, L7, L8, L9, L10 and L14, the per-crawler limit, `crawler.spoofed`, the conflict check, T-L3-1 to T-L3-5 | PR-S8, PR-S9, PR-S10 | ~2.5 d |
| | **Group 1 total** | | **~39.5 d** |

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
| **PR-U4** policies | services and groups, the editor with origins, draft, diff, publish, versions, rollback, dry run, impact, test a request; the crawler allowance's form and conflict warnings, and the crawler series (ui.md §3, §7) | PR-U1, PR-CP7 | ~7.5 d |
| **PR-U5** rules, audit, approvals, agents, alerts | ui.md §4.3, §8 | PR-U1, PR-CP3, PR-CP6 | ~4 d |
| **PR-U6** e2e and accessibility | Chrome flows, responsive, contrast, the parsed permissions table and its example | PR-U2 to U5 | ~2 d |
| | **Group 3 total** | | **~27.5 d** |

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
their parents; S11 and S12 last. PR-CP2 can start after S1, beside the rest of group
1; CP1 after S4; CP3, CP4, CP5, CP6, CP7 after their parents. PR-U1 after
CP2, the rest of group 3 beside group 2's tail. PR-T2 grows with group 1;
PR-T1 after S4 and CP4; PR-X1 per milestone; PR-X2 at M3.

| Milestone | PRs | Effort | What it gives |
|---|---|---|---|
| **M1 the engine** | P2–P4, D0, D1, S1–S12, T2, the M1 examples | ~56.5 d + ~2 d examples | (a) and (b) with a policy file or a SQLite store; every v1 layer; bun-common, `Bun.serve`, bun-nest; **ConcaveHR's whole request path** (§12; its admin API and insights page arrive with M2 and M3) |
| **M2 the control plane** | D2, D3, CP1–CP7, T1 | ~32 d | (c); the Postgres store; groups; signed bundles; audit; analytics data; alerts |
| **M3 the UI** | U1–U6, X2, the remaining examples | ~32.5 d | the management UI and analytics page |

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

**Added 2026-11-10, with the verified-crawler allowance (layers.md L3.2). Answered the same day: the user approved all three recommendations as written**, so the Recommendation column is the decision.

| # | Question | Recommendation |
|---|---|---|
| Q29 | **The crawler allowance on by default**, in `enforce`, for Google, Bing and Apple (DuckDuckGo once its verification source is confirmed), every path, `GET` and `HEAD` | **Yes**: the defaults otherwise ban a crawler on its first burst of dead links (L14), and an API-only service loses nothing |
| Q30 | **AI and LLM crawlers** (`GPTBot`, `ClaudeBot`, `PerplexityBot`, `CCBot`…) in the default set | **No**: in the registry, opt-in per service. They build no search index, so letting them in is a content decision |
| Q31 | **A spoofed claimant** (a crawler `User-Agent` that fails verification) | **Block, with offence weight 5**, configurable per scope; staff SEO tools get a plain allow entry |

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
| the `crawlers` policy option (`mode`, `allow`, `verify`, `methods`, `paths`, `exempt`, `limit`, `spoofed`, `custom`); `verify` values `ranges`, `rdns`, `ranges-then-rdns`; exemptions `notFound`, `probeRules`, `honeypots`, `botSignals`, `challenges`, `hostingClass`, `geo`, `perIpLimits`, `autoBans`; registry ids `google`, `google-special`, `bing`, `apple`, `duckduckgo`, `yandex`, `baidu`; events `crawler.probe`, `crawler.honeypot`, `crawler.spoofed`; the key prefix `crawler:`; options `maxPendingVerifications`, `verifyTimeoutMs`, `resolver` | values, options | policy format (PR-S12) |

### 17.1 Added with PR-S1 (approved by the user, 2026-11-16)

PR-S1 added these public names beyond the table above, all approved as
built:

| Names | Where |
|---|---|
| values `securityPolicySchema`, `SecurityPolicyError`, `requestFacts`, `INTERNAL_RANGES`, `ACTION_SEVERITY`, `DEFAULT_MAX_LIST_ENTRIES`, `DEFAULT_SERVICE_HEADER`, `DEFAULT_CLIENT_IP_HEADER`, `MAX_FACT_HEADERS`, `MAX_FACT_HEADER_LENGTH` | `.` |
| `Security` members `identify`, `status`, `closed` | `.` |
| types `CreateSecurityOptions`, `ExplainOptions`, `SecurityStatus`, `Explanation`, `ExplainStep`, `ClientResolution`, `ClientSource`, `SecurityLayer`, `SubjectKeys`, `RequestFacts`, `RequestFactsInit`, `SecurityIdentity`, `SecurityWarning`, `TrustStatus`, `TrustMinute`, `TrustWarningKind`, `CompiledPolicy`, `CompilePolicyOptions`, `PolicyIssue`, `SecurityMode`, `SecurityAction`, `ListAction`, `ListEntry`, `PolicyScope`, `KeyPolicy`, `InternalListPolicy`, `ServiceExemption`, `ServiceIdentityPolicy`, `TrustCheckPolicy` | `.` |
| `DEFAULT_IDLE_TIMEOUT_SECONDS`, `DEFAULT_MAX_REQUEST_BODY_SIZE`, `WithSecurityOptions`, `HardenServeOptions`, `HardenableServeOptions`, `RequestIpServer` | `./serve` |
| options: `createSecurity`'s `onWarning`, `logger`, `now`; `withSecurity`'s `failClosedOnEngineError`, `logger`; `hardenServe`'s second argument `{ production }`; `compilePolicy`'s `{ maxListEntries }` | options |
| policy fields: `service`, `environment`, `public`, `mode`, `keys.ipv6Prefix`, `internal` (`true`, `false` or `{ ranges }`); list entries' `id`, `ip`, `user`, `apiKey`, `action`, `override`, `locked`, `scope`, `paths`, `expiresAt`, `mode`, `reason`, `createdBy`, `code`; `serviceIdentity { header, clientIpHeader, services[{ id, verifier, forwardsClientIp, exempt }] }`; `trustCheck { threshold, window, minRequests } \| false`; scopes `global`, `group`, `service`; exemptions `lists`, `bans`, `countedRules`, `globalLimits` | policy format |
| headers `x-service-token`, `x-service-client-ip`; verifier format `sha256:<hex>`; warning kinds `trust.internal`, `trust.unread-forwarding`; rule ids `ip:<cidr>`, `user:<id>`, `apiKey:<id>`, `internal:<cidr>`, `service:<id>`, `service-identity`; problem codes `blocked`, `unavailable`; client sources `socket`, `trusted-proxy`, `client-ip-header`, `service`, `none` | values |

Two behaviours the user confirmed with them (2026-11-16): the L2.5 trust
check warns only for a service whose policy says `public: true` (the
default is `false`, so internal-only services do not warn about their
internal share); and the `internal` list protects addresses only, so a
refusing `user` or `apiKey` entry still applies to a client on an internal
address, while no `ip` entry refuses one.

### 17.2 Added with PR-S2 (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| values `SECURITY_POLICY_VERSION`, `DEFAULT_CONCURRENCY_PER_IP`, `DEFAULT_MAX_KEYS` | `.` |
| types `LimitRule`, `LimitAlgorithm`, `CountedRule`, `CountedRuleAction`, `ConcurrencyPolicy`, `SubjectKeyPart`, `EvaluateOptions`, `RequestOutcome`, `StateStatus`, `SecurityWarningKind` | `.` |
| `Security.complete`; `evaluate`'s `{ track }`; `createSecurity`'s `throttleStore`, `maxKeys`; `SecurityStatus.state` (`inFlight`, `inFlightClients`, `trips`, `evictions`, `warning`); `CompiledPolicy.version`; `RequestOutcome`'s `status`, `routeNotFound` | members, options |
| policy fields `version`; `limits` (`id`, `limit`, `window`, `subSecond`, `key`, `routes`, `algorithm`, `cost`, `mode`, `appliesToServices`, `evenWhenAllowed`, `code`); `countedRules` (`id`, `event`, `threshold`, `window`, `subSecond`, `key`, `routes`, `action`, `duration`, `mode`, `appliesToServices`, `code`); `concurrency` (`perIp`, `total`, `releaseAfter`, `mode`, or `false`) | policy format |
| key parts `ip`, `user`, `session`, `tenant`, `apiKey`, `route`; counted actions `ban`, `challenge`; event `server.error`; rule ids `limit:<id>`, `counted:<id>`, `concurrency:per-ip`, `concurrency:total`; problem code `rate_limited`; warning kind `state.evictions` | values |

Decided with them (2026-11-16): the policy format's `version` (a missing one reads as 1; a newer one is refused, naming the upgrade); whether L9.3's default limits and the `not_found_per_minute` rule are built in and on by default is decided alongside PR-S5 and PR-S7; and PR-S3 adds a machine-readable "newer version" issue code to `SecurityPolicyError`, for the control plane (CP2, CP4).

### 17.3 Added with PR-P2 (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| `addBeforeReadHook`, `addBeforeWriteHook` (methods); `BeforeReadHook`, `BeforeWriteHook`, `BeforeWriteContext`, `BeforeWritePhase` (types); phases `"early"`, `"response"`, `"error"` | bun-common's `BunHttpAdapter` and root |

The "early hook" of §3.3 is `addBeforeReadHook`; with it, §3.3's `createSecureAdapter()` fallback is no longer needed.

### 17.4 Added with PR-S3 (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| values `canonicalPath`, `trapField`, `isTrapFilled`, `DEFAULT_TRAP_FIELD`, `DEFAULT_HONEYPOTS`, `DEFAULT_WEIGHTS` | `.` |
| types `Ban`, `BanSubject`, `BanInput`, `UnbanOptions`, `BanPolicy`, `LadderPolicy`, `LadderStep`, `ShapePolicy`, `ShapeRoute`, `DeceptionPolicy`, `HoneypotPolicy`, `CanaryPolicy`, `PolicyIssueCode`, `TrapField`, `TrapFieldOptions`, `TrapSubmission` | `.` |
| `Security.ban`, `Security.unban`, `Security.bans`; `StateStatus.bans`, `bansDropped`, `scores`; `PolicyIssue.code`; `RequestFacts.query`, `headerCount`, `headerLengths`; `Ban`'s `id`, `subject { type, value }`, `action`, `reason`, `rule`, `source` (`auto`/`manual`), `createdAt`, `expiresAt`, `createdBy`, `count`, `code`, `liftedAt`, `liftedBy`; `BanInput`'s `ip`, `user`, `apiKey`, `action`, `duration`, `reason`, `by`, `code`; `UnbanOptions.by` | members, fields |
| policy sections `bans` (`code`, `retryAfter`, `maxActive`, `mode`); `ladder` or `false` (`halfLife`, `steps[{ score, action, duration }]`, `base`, `factor`, `maxBan`, `memory`, `weights`, `mode`); `shape` or `false` (`caseSensitive`, `maxPathBytes`, `maxQueryBytes`, `maxQueryParams`, `maxQueryDepth`, `methods`, `hosts`, `maxHeaders`, `maxHeaderBytes`, `headerLimits`, `maxBodySize`, `routes[{ routes, maxBodySize, contentTypes, allowEncodedSlash }]`, `mode`); `deception` (`honeypots`: `true` or `{ paths, answer: "pass" \| "not-found", mode }`; `canaries[{ id, user, apiKey }]`); counted rules' `weight` and the action `"ladder"` | policy format |
| events `honeypot.hit`, `canary.used`, `trap.filled`, `shape.refused`; rule ids `ban:<id>`, `ladder`, `honeypot`, `canary:<id>`, `shape.method`, `shape.path`, `shape.query`, `shape.host`, `shape.headers`, `shape.body`, `shape.content-type`; problem codes `banned`, `rejected`, `not_found`; warning kinds `bans.aggregated`, `canary.used`; issue code `policy.newer` | values |

Decided with them (2026-11-16): PR-S3's seven changes to PR-S2's behaviour are accepted (a counted-rule ban answers `banned` with no `Retry-After`; `facts.path` is the canonical path; list `paths` fold case, as bun-common's router does; the ladder is on by default). Built-in defaults are **presets, staged**: L9.3's limits, `not_found_per_minute` and the honeypots ship as named presets, off; `not_found_per_minute` turns on in `dryRun` once PR-S12's crawler exemption exists; the per-IP and per-user L9.3 limits turn on, enforced, with PR-S7; honeypots stay opt-in. Offence scores are per client address until PR-S7 and PR-S11.

### 17.5 Added with PR-S5 (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| subpaths `./http`, `./lib/http` | bun-security |
| values `installSecurity`, `securityMiddleware`, `securityProfile`, `securityHeaders`, `csrf`, `requestSecurity`, `SELF_TEST_PATH`, `MAX_DELAY_MS` | `./http` |
| types `InstallSecurityOptions`, `SecurityInstallation`, `SecuritySelfTest`, `SecurityMiddlewareOptions`, `RefusalOptions`, `SecurityProfileOptions`, `SecurityHeadersOptions`, `HstsOptions`, `CsrfOptions`, `CsrfTokenOptions`, `CsrfGuard`, `CsrfRefusal`, `ScrubMode`, `RequestSecurity` | `./http` |
| type `EvaluationStage`; `EvaluateOptions.stage` (`"early"`, `"route"`) | `.` |
| options: `installSecurity`'s `headers`, `csrf`, `scrub` (`"production"`, `"always"`, `false`), `selfTest`, `expectThrottle`, `renderBlock`, `failClosedOnEngineError`, `logger`; `securityMiddleware`'s `router`, `trustProxy`, `clientIpHeader`; `securityProfile`'s `crossSite`; `csrf`'s `origins`, `allowSameSite`, `onlyWithCookies`, `token { secret, session, cookie, header, field }`; `securityHeaders`' `hsts { maxAge, includeSubDomains, preload }`, `contentSecurityPolicy`, `contentTypeOptions`, `referrerPolicy`, `crossOriginOpenerPolicy`, `crossOriginResourcePolicy`, `permissionsPolicy`, `frameOptions`, `remove`, `noStoreWithCookies`, `override`; `SecurityInstallation`'s `selfTest { ran, throttle }`, `remove`; `CsrfGuard`'s `token`, `check`; `RequestSecurity`'s `decision`, `facts`, `profile`, `routeMatched` | options, members |
| problem codes `csrf`, `internal_error`; CSRF refusals `cross-site`, `untrusted-origin`, `opaque-origin`, `missing-token`, `invalid-token`; rule id `csrf`; header `x-bun-security-self-test`; path `/__bun-security/self-test`; cookie `__Host-csrf` (`csrf` over HTTP), header `x-csrf-token`, field `_csrf` | values |

Decided with them (2026-11-16): §3.3's `security.install(app)`, `security.middleware()` and `security.profile(name)` are built as free functions of `./http` (`installSecurity(app, security, options)`, `securityMiddleware(security, options)`, `securityProfile(name, options)`), the shape of `withSecurity`; the engine gains `evaluate`'s `stage` option, each limit and counted rule counted in exactly one stage (the route stage for keys naming the caller or the route and for route patterns with a parameter; the early stage otherwise). Route-not-found is marked in bun-security (no route handler matched and the answer is a `404`), not by a bun-common flag. The built-in defaults are §17.4's **presets, staged**; S5 builds none of them (PR-S7 does).

### 17.6 Added with PR-P3 (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| `Cache.pfAdd(key, elements, options)`, `Cache.pfCount(keys)`; `CacheDriver.pfAdd?`, `pfCount?`; capability `distinctCount?` (approved in §17 as `pfAdd`, `pfCount`, `distinctCount`) | bun-cache |
| type `PfAddOptions` (`{ ttl }`) | bun-cache root |
| conformance case ids `distinctCount`, `distinctCount.ttl`, `distinctCount.concurrent`, `multiprocess.distinctCount` (named in `options.skip`) | bun-cache `./testing` |

No `gcra` op: §15.1's condition does not hold (the throttle foundation ships GCRA, and `cacheThrottleStore` already has `consumeGcra`).

### 17.7 Added with PR-S6 (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| subpaths `./security`, `./lib/security` (and the peer-free `./lib/security/security.constants`); `@kingsleyweb/bun-security` as an optional peer | bun-nest |
| `SecurityModule` (`forRoot`, `forRootAsync`), `SecurityGuard`, `SecurityService` (`security`, `routeStage`, `selfTest`, `close`), `SecurityRefusalException` (`decision`), decorators `SecurityProfile`, `SkipSecurity`, `InjectSecurity`; values `BUN_SECURITY`, `BUN_SECURITY_OPTIONS`, `SECURITY_PROFILE_METADATA`, `SKIP_SECURITY_METADATA`, `SECURITY_SELF_TEST_PATH` | `./security` |
| types `SecurityModuleOptions`, `SecurityModuleAsyncOptions`, `SecurityModuleSettings`, `SecuritySource`, `SecurityProfileMetadata` | `./security` |
| options `globalGuard`, `isGlobal` (both default `true`), `headers`, `csrf`, `scrub`, `selfTest`, `renderBlock`, `failClosedOnEngineError`, `logger`; `forRootAsync`'s `imports`, `inject`, `useFactory`; `@SecurityProfile(name, { crossSite })`; `@SkipSecurity(...ruleIds)` (none: the whole route stage; `"csrf"`: the CSRF check) | options |
| `BunHttpAdapter.addBeforeReadHook` and type `BunBeforeReadHook` (bun-common's P2 hook, §17.3, on bun-nest's adapter) | bun-nest `.` |

Built on these choices, confirmed by the user (2026-11-16): the early stage is a before-read hook on bun-nest's adapter, not §3.5's `registerSecurityHook` (which is synchronous, answers only through Nest's exception layer, and runs after the body is read unless it forces `deferBody`); the security headers and stack-trace scrubbing ride on bun-common's response transforms, put on each response by a middleware the module registers while Nest builds the application, because bun-nest's `addBeforeWriteHook` may only refuse a response (so an error the adapter answers on a fresh response, outside Nest's exception zone, gets no headers); the route stage's refusals are a `SecurityRefusalException` for Nest's exception layer, and `renderBlock` applies to the early stage only; the boot self-test checks the guard statically (global or `@UseGuards`), since a synthetic request reaches no route.

### 17.8 Added with PR-S4 (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| subpaths `./stores`, `./lib/stores`; `@kingsleyweb/bun-cache` as an optional peer | bun-security |
| values `cacheStore`, `hybridThrottleStore` (approved in §17), `DEFAULT_STORE_NAMESPACE` (`"bun-security"`), `DEFAULT_SYNC_INTERVAL_MS` (250); types `CacheStoreOptions`, `HybridThrottleStore`, `HybridThrottleStoreOptions` | `./stores` |
| `cacheStore`'s options `namespace`, `bus`, `timeout` (`"50ms"`), `circuit { failures, cooldown }` (5, `"30s"`), `syncInterval` (`"250ms"`), `pollInterval` (`"5s"`), `reconcileInterval` (`"60s"`), `clock`, `now`, `logger`; `hybridThrottleStore`'s `syncInterval`, `maxKeys`, `now`, `logger`; `HybridThrottleStore`'s `flush`, `close`, `healthy`, `size` | options, members |
| types `SharedStateStore` (`name`, `throttle`, `hybrid`, `intervals`, `get`, `getMany`, `set`, `increment`, `touch`, `pfAdd`, `pfCount`, `notify`, `listen`, `flush`, `health`, `close`), `SharedStateIntervals` (`sync`, `poll`, `reconcile`), `StoreHealth` (`healthy`, `failingSince`, `failures`), `SharedStoreStatus`, `MessageDecision` (`action` `allow`/`drop`/`close`, `code`, `reason`, `hits`), `SocketLimiter` (`message`), `StateMode`, `StoreErrorMode`, `StatePolicy`, `MessagePolicy` | `.` |
| `createSecurity`'s `store`, `maxPendingBans` (10,000); `Security.ready`, `Security.flush`, `Security.socket`; `StateStatus.store` (`name`, `healthy`, `failingSince`, `pendingBans`, `droppedBans`, `banCursor`, `reconciledAt`, `pendingScores`); `Ban.service`, `Ban.scope` (`"service"`, added with `state.scope`) | options, members |
| policy sections `state` (`mode`, `onStoreError`, `nodes`, `scope`: `"shared"` or `"service"`) and `messages` (`perConnection { limit, window, subSecond }` or `false`, `burst`, `breach`, `closeCode`, `limits`, `mode`); a limit's `state`, `onStoreError`; a counted rule's `state` (`local`/`shared`), `onStoreError` (`local`/`open`) | policy format |
| warning kind `store.unavailable`; rule ids `message:per-connection`, `message:<id>`; close codes 1008 (default), 1013 (a `closed` store failure); store keys `bans:seq`, `bans:log:<n>`, `bans:snap`, `bans:snapgen`, `bans:snap:<gen>:<i>`, `bans:compact:<period>`, `scores:<key>`, `hist:<id>` (`scores:svc:<service>:<key>`, `hist:svc:<service>:<id>` in `"service"` scope), log lifts `scope` `service:<id>`, `d:<window>:<index>:<key>`, throttle namespace `throttle`; bus namespace `bun-security:<namespace>` | values |
| `securityWebSocket(security, handler, { identify, onRefused })`, type `SecurityWebSocketOptions` | `./http` |

Decided with them (2026-11-16): the names as built. **Ban and score scope is an option** (the user's decision), `state.scope`: `"shared"` shares a service's bans, offence scores and the ladder's ban history with every other `"shared"` service on the store's namespace; `"service"` keeps them to the service's own processes (it needs the policy's `service`), so no other service enforces its bans or reads its scores, nor it another's. Mixed on one namespace: shared services share among themselves, each per-service service keeps to itself, a subject banned in both scopes is two bans each lifted in its own scope, and a ban takes its writer's scope (manual bans too). Snapshots are written from the store's whole set, every scope. **The default is `"shared"`**, confirmed by the user (2026-11-16). Also confirmed by the user, as built: a counted rule removed from a service's policy stops its bans in that service's processes, while other shared services enforce them until they expire or are lifted; the `closed` store failure answers `503` with `Retry-After: 5`; no default message limits (presets, staged, as §17.4); `close()` stays synchronous and `flush()` waits for its last write; the engine never closes the store, which the app closes.

### 17.9 Added with PR-S8 (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| values `regexRefusal`, `MANAGED_RULE_IDS`, `DEFAULT_MAX_REGEX_INPUT` | `.` |
| types `RequestRule`, `RequestRuleAction`, `RequestRulesPolicy`, `RuleCondition`, `RuleMatch`, `StringMatcher`, `NumberMatcher`, `AddressMatcher`, `ManagedRuleId`, `ManagedRulesPolicy` | `.` |
| policy section `requestRules` (`rules`, `managed`, `maxRegexInput`); a rule's `id`, `when`, `action` (`log`, `block`, `challenge`, `ban`, `drop`), `weight`, `mode`, `status`, `code`, `duration`, `crawlers` (`apply`, `skip`); conditions `all`, `any`, `not`; targets `method`, `path`, `rawPath`, `query`, `queryParam`, `header`, `anyHeader`, `cookie`, `client`, `contentLength`, `headerCount`, `routeKey`, `user`, `session`, `tenant`, `apiKey`; matchers `equals`, `in`, `prefix`, `suffix`, `contains`, `glob`, `regex`, `exists`, `length`, `gt`, `gte`, `lt`, `lte`, `cidr`, and `ignoreCase`; `managed`'s `mode`, `exclude`, `weight` | policy format |
| managed rule ids `dotenv`, `vcs`, `wordpress`, `phpmyadmin`, `cgi-bin`, `actuator`, `scanner-agents`, `header-control-chars`, `oversized-cookie`; event `probe.hit` (beside `pattern.hit`; request rules' hits count `rule.hit` since PR-T2, §17.19); rule ids `rule:<id>`, `probe:<id>` | values |

Built on these choices, confirmed by the user (2026-11-16): the managed probe set is **off unless the policy turns it on**, and then in dry run (`managed: true`), in the spirit of §17.4's presets rather than this plan's "dry run by default"; probes of paths are answered `404` and scanners `403`; a rule on the caller or the matched route runs in the route stage, every other in the early stage; an enforced hit counts its event and adds the rule's weight (default 1, 0 for `log`) to the address's score; a `ban` bans the client address for `duration`, or the ladder's escalating length; the regex validator also refuses adjacent choices that can trade characters (`a?a?aa`, `\d+\d*`), the polynomial blow-ups star height alone misses; tags (`tag` action) are left for when decisions carry tags; body-field rules and the CRS-derived set stay later, as planned. The crawler exemption is a hook (`#verifiedCrawler`, always false) that PR-S12 fills.

Also decided (2026-11-16): the managed probe set turns on by default **in dry run** with PR-S12 (the verified-crawler exemption), as `not_found_per_minute` does; and an accepted regex is guaranteed **bounded, not linear**: JavaScript's `RegExp` backtracks and tries each start position, so the validator plus the `maxRegexInput` cap bound the worst case to about n² steps (T-L7-1 asserts a 16M-step budget and no faster than n² growth). A strictly linear guarantee would need a non-backtracking matcher, which the user did not require.

### 17.10 Added with PR-S9 (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| subpaths `./challenge`, `./lib/challenge` | bun-security |
| `challenges` (the flow), `powChallenge`, `solvePowChallenge`, `turnstile`, `hcaptcha`, `challengePage`, `challengeCsp`, `mintClearance`, `clearanceRefusal`, `clearanceNetwork`; values `DEFAULT_CHALLENGE_PATH` (`/__bun-security/challenge`), `DEFAULT_CLEARANCE_COOKIE` (`bun-security-clearance`, `__Host-` before it over HTTPS), `DEFAULT_CLEARANCE_HEADER` (`x-security-clearance`) | `./challenge` |
| types `ChallengeFlow` (`provider`, `path`, `cleared`, `respond`, `answers`, `answer`), `ChallengesOptions` (`provider`, `secret`, `ttl`, `path`, `cookie`, `header`, `title`, `page`, `now`), `ChallengeAnswer` (`response`, `passed`, `reason`), `ChallengeProvider` (`id`, `field`, `issue`, `verify`), `ChallengeContext` (`client`, `risk`, `hostname`), `ChallengeDescriptor` (`provider`, `field`, `html`, `scripts`, `script`, `origins` { `frame`, `connect`, `style` }, `data`), `ChallengeVerdict` (`ok`, `reason`), `PowChallengeOptions` (`secret`, `maxNumber`, `riskFactor`, `maxNumberCap`, `expiresIn`, `maxReplay`, `store`, `storeTimeoutMs`, `now`), `PowChallengeData` (ALTCHA's `algorithm`, `challenge`, `maxnumber`, `salt`, `signature`), `CaptchaOptions` (`siteKey`, `secret`, `hostnames`, `action`, `fetch`, `timeoutMs`, `verifyUrl`), `VerifyFetch`, `ChallengePageOptions` (`action`, `returnTo`, `title`, `notice`, `status`), `ClearanceSubject` (`client`, `userAgent`) | `./challenge` |
| `createSecurity`'s `challenge` option; `Security.challenge` | `.` |
| value `BOT_SIGNALS`; types `BotSignalsPolicy`, `BotSignalName` | `.` |
| policy section `botSignals` (`mode`, `weights`, `challengeAt`, `browserPaths`); signals `noUserAgent`, `libraryUserAgent`, `headlessUserAgent`, `missingFetchMetadata`, `clientHintsMismatch`; rule id `botSignals` on layer `L10` | policy format |
| problem codes `challenge_required`, `challenge_failed`; events `challenge.passed`, `challenge.failed`; the answer's JSON body `{ answer, return }` and reply `{ clearance, header, expiresAt }`; the API problem's `challenge` member (`provider`, `field`, `path`, `data`) | values, wire |

Built on these choices, confirmed by the user (2026-11-16): the proof of work speaks ALTCHA's v1 wire format (read from altcha-lib's `src/v1`: the salt carries `?expires=…&` parameters, `challenge = hex(SHA-256(salt + number))`, `signature = hex(HMAC-SHA-256(key, challenge))`, the answer `base64(JSON)`), so Q9 is met; difficulty is ALTCHA's `maxnumber` (a linear count of tries), not leading zero bits, and grows with the decision's `risk`; the salt also carries `c=`, a keyed hash of the client's /24 or /64, so a solved challenge cannot be farmed out to another network. With PR-S4's shared store passed as `store`, each answered salt is also marked there with one atomic `increment` (`pow:used:<hash>`, for the challenge's remaining life), so an answer is single use across processes; when the store fails or takes longer than `storeTimeoutMs` (100 ms), the process's own replay cache decides alone, so only a replay to another process inside the outage passes. Clearances need no replay state: a clearance is meant to be reused until it expires, bound to the network and the `User-Agent`, so it stays a stateless signed token.

Also decided (2026-11-16): an L3 `challenge` list entry lets L4 decide first, so a banned client on it is refused by its ban at once, with or without a clearance, and a client with no ban is still challenged; `allow`, `block` and `drop` entries keep answering before the bans (layers.md L3, L4). No other challenge source answers before L4: the ladder, counted rules and bans are L4 itself, and L7 and the bot signals run after it. bun-nest's route-stage challenges (`SecurityGuard` answered a bare `challenge_required`) were the follow-up PR after S9; see §17.13. A cleared client passes challenges only (the hit is logged), never a block or a ban. The `challenge` decision is resolved once per request, in one place (`Run.add`), for every layer, and the flow's `cleared()` is asked only when a challenge is hit. Bot signals are off unless the policy has the section, read in the early stage only, and refuse nothing unless `challengeAt` is set (layers.md L10.1's "none blocks alone"). Under bun-nest, a route-stage challenge (`SecurityGuard`) still answers the refusal exception's `challenge_required` without the challenge; the early stage is complete.

### 17.11 Added with PR-S7 (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| values `PRESETS`, `PROFILE_NAMES`, `DEFAULT_DEVICE_COOKIE` (`"__Host-bun-security-device"`), class `SecurityRefusal` (`status`, `code`, `rule`; approved in §17); types `Preset`, `SignalData`, `CheckKind`, `LoginProfilePolicy`, `ProfilesPolicy`, `IdentifierKind`, `IdentifierPattern`, `IdentifierPolicy` | `.` |
| `Security.check(facts, kind, value)` (approved in §17), `Security.deviceCookie(facts)`, `Security.unlock(username)`; `signal(facts, event, data?)`'s `data` (`username`, `destination`); `createSecurity`'s `secret`, `breachedPassword`; `SecurityIdentity.username`, `destination`; `RequestFacts.profile`, `RequestFactsInit.profile`; `SubjectKeys.username`, `destination`, `destinationPrefix`, `device`; `Decision.tags` now filled (`step-up`, `risky-success`) | members, options |
| `uniformAuthResponse({ minResponseMs, statuses, status, title, code })` (approved in §17), type `UniformAuthResponseOptions` | `./http` |
| `withSecurity`'s `profile` option | `./serve` |
| policy: `presets` (by id, `true`/`false`); `profiles.login` (`failures { window, delayAfter, challengeAfter, lockAfter, lockFor, maxDelay }`, `distinctUsernames { window, challengeAt, banAt, banFor }` or `false`, `distinctAddresses { window, stepUpAt }` or `false`, `riskySuccessAfter`, `device { cookie, maxAge }` or `false`, `inferOutcome`, `mode`) or `false`; `identifiers` (`patterns [{ id, kind, pattern, reason, mode }]`, `reserved`, `ownDomains`, `code`); a limit's and a counted rule's `profile`; key parts `username`, `destination`, `destinationPrefix`, `device` | policy format |
| preset ids `per-ip`, `per-user`, `login.account`, `login.ip`, `login.ip-failures`, `login.ip-failures-ban`, `mfa.account`, `mfa.ip`, `mfa.failures`, `otp.ip`, `otp.ip-hour`, `otp.destination`, `otp.destination-day`, `otp.prefix`, `reset.ip`, `reset.ip-hour`, `reset.destination`, `signup.ip`, `not_found_per_minute`; profile names `login`, `mfa`, `otp`, `reset`, `signup`; rule ids `login:delay`, `login:challenge`, `login:lock`, `login:distinct-usernames`, `login:distinct-addresses`, `login:risky-success`; tags `step-up`, `risky-success`; warning kind `login.risky-success`; problem codes `invalid_identifier`, `breached_password`, `login_failed`; check rules `reserved-domain`, `own-domain`, `malformed`, `breached-password`; events `auth.success`, `mfa.failure` (beside §17's) | values |

Confirmed by the user (2026-11-16), as built: the profiles' presets are on, but count only on routes marked with their profile (an app that marks nothing sees only `per-ip` and `per-user`, both on and enforced; `not_found_per_minute` off; honeypots opt-in); the progressive delay stays capped at 2 s (§0.1's bound); outcome inference is on (`401`/`403` failure, `2xx` success, on routes marked `login`, when the attempted username is known and the app signalled neither); device cookies last a year, issued on every success on a `login` route, `HttpOnly; Secure; SameSite=Lax`; `security.check()` refuses with one generic `400`, reserved domains by default and the operator's `ownDomains`; the breached-password hook is the app's, and a hook that throws is logged and the password accepted.

Changed at the user's request (2026-11-16): **a shared store without a `secret` refuses to start** (`createSecurity` throws a `ConfigError`); without a store a random per-process secret stays allowed.

Built on PR-S9's challenges: the per-username challenge (`challengeAfter`) and the credential-stuffing challenge (`distinctUsernames.challengeAt`, a ban with `action: "challenge"`) go through the challenge flow, a `challenge` (`403`, `challenge_required`) with a flow, a pass with a valid clearance, and without a flow the per-username challenge answers `429` `rate_limited` and the challenge ban `403` `banned`. The soft lock stays a refusal: `429` `rate_limited` with `Retry-After` of `lockFor`, with a flow and a clearance as without; only a device cookie for the username passes it.

Also with PR-S7: `cacheStore`'s `bus` defaults to the cache's own bus (bun-cache's `cacheBusOf(cache)`, #807), and takes `false` for none.

Left for later, from the plan's L11 tables: the global failure-ratio baseline (it needs L5's hosting classes; built after T2's finding, §17.20), OTP verify's per-code voiding, signup's distinct emails per address, and the payment profile.

### 17.12 Added with PR-S10 (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| subpaths `./intel`, `./lib/intel` | bun-security |
| `ipIntel` (approved in §17), `openMmdb` (approved), `MmdbReader` (`metadata`, `lookup`, `lookupWithPrefix`), `MmdbError`, `extractIntel`, `rangeFeed`, `torExitFeed`, value `TOR_BULK_EXIT_LIST_URL` | `./intel` |
| types `IpIntel` (`lookup`, `provides`, `refresh`, `start`, `stop`, `reload`, `status`), `IpIntelOptions` (`databases`, `feeds`, `ranges`, `dir`, `cacheSize`, `extract`, `fetch`, `logger`, `now`), `IntelStatus` (`databases`, `feeds`, `classes`, `cached`), `ExtractedIntel` (`country`, `asn`, `asOrganization`), `MmdbMetadata` (`nodeCount`, `recordSize`, `ipVersion`, `databaseType`, `languages`, `binaryFormatMajorVersion`, `binaryFormatMinorVersion`, `buildEpoch`, `description`), `MmdbResult` (`record`, `prefixLength`), `MmdbValue`, `RangeFeed`, `RangeFeedOptions` (`id`, `class`, `url`, `format`, `interval`, `retry`, `minEntries`, `maxBytes`, `maxEntries`, `timeoutMs`), `RangeFormat` (`"lines"`, `"json"`, a function), `FeedFetch`, `FeedRefresh` (`id`, `ok`, `entries`, `error`), `FeedStatus` (`id`, `class`, `entries`, `source`, `updatedAt`, `attemptedAt`, `error`, `dueAt`), `IntelLookup`, `IntelProvides` (`country`, `asn`, `classes`), `IntelRecord` (`country`, `asn`, `asOrganization`, `classes`) | `./intel` |
| `createSecurity`'s `intel` option; type `AsnMatcher` (`equals`, `in`, `exists`) | `.` |
| list entry subjects `country` (ISO 3166-1 alpha-2, upper case) and `asn`, ids `country:<CC>`, `asn:<n>`; request-rule targets `country`, `asn`, `class`; `botSignals.classes` (points per class, signals `class:<name>`) | policy format |
| class names `tor`, `hosting` (conventions, not reserved); a feed's last good copy `<dir>/<id>.ranges` | values |

Built on these choices, confirmed by the user (2026-11-16): the MMDB reader is our own (Q8), from the format specification, the whole file read into memory once (no `mmap` in Bun's API; GeoLite2-Country is about 9 MB, GeoLite2-ASN about 10 MB); an IPv4 address in an IPv6 database is looked up under `::/96`. It was checked against MaxMind's own published test databases by hand (decoder, ipv4-24/28/32, ipv6-24, mixed-28, GeoIP2-Country and GeoLite2-ASN test files), not shipped; the suites use databases they write themselves. A record is read as MaxMind's and DB-IP's shape (`country.iso_code`, else `registered_country.iso_code`; `autonomous_system_number`) or IPinfo Lite's (`country_code`, `asn` `"AS…"`), the first database to give a field giving it; `extract` reads any other. What a database provides is read from its `database_type` (`…ASN…`: ASNs; `…Country…`/`…City…`: countries; anything else: both). Classes come from range feeds and static ranges only (no class from an ASN), and the refresh job is the intel's own (`start()` on unref'd timers, or `refresh()` from bun-jobs or any scheduler), not a bun-jobs dependency; it is generic over feeds, so PR-S12's crawler range files are feeds with a class such as `crawler:google`. A feed's copy is refused when it is not `200`, larger than `maxBytes` (16 MiB), unreadable, holds more than `maxEntries` or fewer than `minEntries` ranges (`torExitFeed`: 100); the last good copy is kept and, with `dir`, written atomically and read back at start, due again only an interval after it was fetched. No URL is fetched unless the operator configures it (`TOR_BULK_EXIT_LIST_URL` is a constant to pass, not a default). Country and ASN list entries take the lists' usual precedence and run in the early stage. A policy that uses `country`, `asn` or `class` is refused at `createSecurity()` and `load()` when the engine has no `intel`, when no database gives what it uses, or when it names a class no feed or range provides. Lookups run only when the policy needs them, and are cached (LRU, 50,000): a cached address costs a map lookup and returns the same frozen record.

Also decided (2026-11-16): **an `allow` on a country entry is refused** at compile time (a `SecurityPolicyError` at `lists.<i>.action`, as the /8 guard refuses a wide address allow), while an `allow` on an ASN entry is accepted and every other action on a country entry stays allowed (layers.md L3.1, L5). **Classes derived from ASNs** (a "hosting ASNs" list) are left for later, not S10.

### 17.13 Added with the bun-nest route-stage challenge follow-up (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| `SecurityChallengeException` (extends `SecurityRefusalException`; `decision`, `challengeStatus`, `sent`, `getResponse()` the challenge's body) | bun-nest `./security` |

Built on these choices, confirmed by the user (2026-11-16): a route-stage `challenge` with a challenge flow is answered with the flow's own answer (S9's `respond`), its headers set on the response Nest answers on; the problem (with the `challenge` descriptor) goes through Nest's exception layer as the exception's response, so an app's filter can render it; the page is sent by the guard itself, because Nest's `BaseExceptionFilter` turns a string response into `{ statusCode, message }` JSON and bun-nest's `reply` forces an error body to JSON, so the exception carries `sent: true` and Nest's layer, finding the answer sent, only ends it. The answer to the challenge is taken by the module's early stage, as S9 built. Without a flow nothing changes (the engine's fallback block). The change is in the guard and a new `security.challenge.ts`; `security.service.ts` is untouched.

### 17.14 Added with PR-S12 (approved by the user, 2026-11-16)

The crawlers row of §17 (the `crawlers` option and its fields, `verify` values, exemptions, registry ids, events `crawler.probe`, `crawler.honeypot`, `crawler.spoofed`, the key prefix `crawler:`, `maxPendingVerifications`, `verifyTimeoutMs`, `resolver`) is approved; these are the names PR-S12 added beside them.

| Names | Where |
|---|---|
| values `CRAWLERS` (the registry: each `CrawlerDefinition`'s `id`, `tokens`, `rdns`, `ranges`, `minEntries`), `CRAWLER_IDS`, `DEFAULT_CRAWLERS`, `CRAWLER_EXEMPTIONS`; types `CrawlersPolicy`, `CustomCrawler` (`id`, `tokens`, `ranges`, `rdns`), `CrawlerExemption`, `CrawlerVerifyMethod`, `CrawlerId`, `CrawlerDefinition`, `CrawlerResolver` (`reverse`, `lookup`), `CrawlerConflict` (`crawler`, `entry`, `range`, `message`), `DecisionCrawler` | `.` |
| `Decision.crawler` (`id`, `verified`, `verifiedBy`: `ranges`/`rdns`/`cache`, `spoofed`); `SubjectKeys.crawler`; `Security.crawlerConflicts()`; warning kind `crawler.conflict`; key part `crawler` (a limit keyed by the verified crawler's id); the built-in limit id `crawler` (`limit:crawler`); rule ids `crawler.spoofed` (L10) and `crawler:<id>` (the dry-run "would have allowed" hit, L3) | members, values |
| `crawlers.spoofed.action` values `log`, `block`, `challenge`, `drop`; `crawlers.paths` `include`, `exclude`; `crawlers.limit` as `"<count>/<window>"` or `false` | policy format |
| `crawlerFeeds(crawlers?, overrides?)`: one `rangeFeed` per allowed crawler with a range file, id and class `crawler:<id>`, daily; `IpIntel.ranges(className)`, and `IntelLookup.ranges` (optional) for the conflict check | `./intel` |

Built on these choices, confirmed by the user (2026-11-16): the registry was read from each engine's own pages on 2026-11-16 (Google's verifying-Googlebot, common and special-case crawler pages; Bing's "How to verify that Bingbot is Bingbot"; Apple's support 119829; DuckDuckGo's DuckDuckBot help page; Yandex's check-yandex-robots; Baidu's help), and **DuckDuckGo is in the default set**, its range file (`duckduckgo.com/duckduckbot.json`) being confirmed (it publishes no reverse DNS, so it is verified by ranges only). Bing's tokens are `bingbot` only (its crawler list page could not be read; `adidxbot` was left out); Google's user-triggered fetchers stay out. The default resolver is the host's `node:dns` (`reverse`, then `lookup` with `all`), measured once on Bun 1.4.5-canary to return PTRs and forward answers for IPv4 and IPv6 crawler addresses (about 250–310 ms cold); tests use a fake. A claimant is **unknown**, an ordinary client, when its verification times out, errors, finds every slot taken, or has nothing to go on (no ranges loaded and no DNS domains); only a definite failure (outside loaded ranges with `ranges`, no PTR, a PTR outside the domains, a forward lookup missing the address) is `crawler.spoofed`. Verdicts are cached per crawler and address (24 h / 1 h, LRU 50,000) and shared through the engine's `store` when it has one. The allowance is the policy's own (no per-scope inheritance beyond the policy's service); `custom` crawlers' range URLs reach `./intel` through `crawlerFeeds()`. `perIpLimits` lifts L9's address-only limits (keyed by `ip` and `route` alone), not L1's in-flight limit; the crawler's limit (`3000/1m` by default) is a built-in limit beside the presets, keyed by the verified crawler's id, counting past allow entries. `autoBans` also keeps the ladder from scoring a verified crawler. `hostingClass` removes `hosting` from the classes its L7 conditions and bot signals see. A spoofed claimant's `crawler.spoofed` hit is L10's, placed after L7 and before the bot signals, so a plain allow entry for a staff tool's address wins. The conflict check runs at start and on `load()`, and `crawlerConflicts()` on demand, once the range feeds have loaded (the compiler alone has no ranges). Not built: the alert on a crawler limited for a day's worth of windows, and the analytics series (no analytics yet).

Also decided (2026-11-16), landing with PR-S12: **the managed probe set is on by default, in dry run** (`requestRules.managed` absent reads as `true`; `false` turns it off, `{ mode: "enforce" }` makes it act), and **the `not_found_per_minute` preset is on by default, in dry run** (`presets: { not_found_per_minute: false }` turns it off, `"enforce"` enforces it), now that a verified crawler is exempt from both.

Also decided (2026-11-16): **a preset's switch is `true`, `"enforce"` or `false`**, for every preset. `true` turns a preset on **as it ships**, which is enforced for every preset but `not_found_per_minute`, shipped in dry run; so `true` keeps its meaning for `per-ip`, `per-user` and the profile presets, and no existing policy changes. `"enforce"` turns any preset on and enforced. `false` turns it off. A preset left out is the same as `true`. Any other value is refused at `presets.<id>`. The managed probe set already reaches enforcement as `requestRules.managed: { mode: "enforce" }`, so it takes no new value. New name: the type `PresetSetting` (`.`).

### 17.15 Added with PR-P4 (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| subpaths `./envelope`, `./lib/envelope` (browser-safe) | bun-common |
| values `signEnvelope`, `verifyEnvelope`, `signEnvelopeWith`, `verifyEnvelopeWith`, `createRemoteNonceCache`, `subtleHmacSha256`, `REMOTE_ID_PATTERN`, `REMOTE_SIGNATURE_WINDOW_MS` (moved from bun-jobs, which re-exports them unchanged), and the new `envelopeCodec` | bun-common `./envelope` and root |
| types `HmacSha256`, `RemoteBody`, `RemoteSecret`, `RemoteSignatureDirection`, `SignEnvelopeOptions`, `VerifyEnvelopeOptions`, `VerifyEnvelopeResult`, `RemoteNonceStore`, `RemoteNonceCacheOptions`, and the new `EnvelopeCodec`, `EnvelopeCodecOptions`, `EnvelopeConfigError`, `EnvelopeHeaderNames` | bun-common `./envelope` and root |

Decided with them (2026-11-16): a pure move under the existing `Remote*` names; generic `Envelope*` aliases come with the bun-security PR that first uses the envelope (CP4). bun-common's own functions name the headers `x-signature` and `x-signature-id` in a refusal's detail (never on the wire); bun-jobs keeps `bun-jobs-signature` and `bun-jobs-id` through `envelopeCodec`.

### 17.16 Added with PR-D0a (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| the package `@kingsleyweb/bun-sql`; subpaths `./dialect`, `./schema`, `./sync`, `./cursor`, `./connection`, `./mongo` (each also under `./lib/`) | new package |
| `SqlAdapter`, `SqlDialect`, `dialectFor`, `detectAdapter` | `./dialect` |
| `ColumnDefinition`, `IndexDefinition`, `TableDefinition`, `renderColumn`, `renderIndex`, `createSchema` | `./schema` |
| `SchemaSyncOptions`, `SchemaChange`, `syncSqlSchema` | `./sync` |
| `encodePageCursor`, `decodePageCursor`, `keysetAfter` | `./cursor` |
| `resolveConnectionUrl`, `openSqlClient`, `sqlClientOptions`, `isTransientLockError`, `withLockRetry` | `./connection` |
| `syncMongoIndexes` | `./mongo` |

Decided with them (2026-11-16):

1. **D0 is split in three**: PR-D0a the package alone, with a parity test against bun-jobs' table definitions and no other package changed; PR-D0b moves bun-jobs onto it; PR-D0c bun-cache. D0b and D0c depend only on D0a and can run beside D1 (§15.1a).
2. **bun-cache keeps its public `SchemaSyncOptions { dryRun }` and `SchemaChange { description, applied, blocking? }`** and adapts to bun-sql's sync internally in D0c: no public change.
3. **bun-sql throws bun-common's `ConfigError`**, with an error-factory seam (`configError`) so bun-jobs keeps its own `ConfigError` and bun-cache its `TypeError`, message for message (the P4 pattern). bun-sql depends on bun-common for `ConfigError` and `Mutex` (storage.md §4.2); `mongodb` is an optional peer, loaded only by `./mongo`.
4. The MongoDB client is loaded only from `./mongo`, on first call.

Also approved with PR-D0a (2026-11-16), the supporting names the move needed: `./dialect` `declaredCollation`, types `AlterColumn`, `KeysetCursor`, and the `SqlDialect` members `documentType`, `inetType`; `./schema` `renderIndexColumn`, types `CollatedIndexColumn`, `SchemaDefinition`, `CreateSchemaOptions`; `./sync` `resolveSyncOptions`, `readColumns`, `compareColumn`, `collationDrift`, `collationDriftWarning`, `createCollationGuard`, types `CollationGuard`, `ResolvedSyncOptions`, `SyncBackend`, `ColumnRow`, `IndexRow`, `SqlColumnRow`, `CollationDrift`, `ColumnDifference`; `./cursor` types `CursorPart`, `CursorPartType`; `./connection` `toConnectionUrl`, `takeBooleanParam`, `databaseFromUrl`, `isPublicKeyRetrievalRefusal`, types `ConnectionInput`, `SqlConnectionOptions`, `SqlClientLimits`, `UrlDefaults`; `./mongo` `loadMongoClient`, types `MongoIndexSchema`, `MongoIndexDefinition`, `RetiredMongoIndex`, `MongoIndexDb`, `MongoIndexCollection`, `MongoIndexSyncOptions`, `MongoClientLike`, `MongoClientConstructor`; the root's `defaultConfigError`, types `SqlConfigError`, `SqlErrorOptions`.

### 17.17 Added with PR-S11 (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| `createSecurity`'s `onKeyCompromised(event)`; `Security.revokeApiKey(id, { duration, reason, by })`; types `KeyCompromise` (`apiKey`, `reason`: `revoked`/`apiKey.newAsn`/`apiKey.manyAddresses`, `detail`, `ban`, `at`), `RevokeApiKeyOptions`, `ApiKeysPolicy`, `ApiKeyAnomalyPolicy`, `ApiKeyAnomalyAction` | `.` |
| `SecurityIdentity.apiKeyPlan`, `SecurityIdentity.apiKeyMaxAddresses` (a number, or `false`); a limit's `apiKeyPlan` | identify, policy format |
| policy section `apiKeys`: `newAsn` (`true`, `false` or `{ mode, action, duration, remember }`), `manyAddresses` (`true`, `false` or `{ mode, action, duration, limit, window }`); actions `log`, `tag`, `challenge`, `ban` | policy format |
| events `apiKey.newAsn`, `apiKey.manyAddresses` (also the hits' rule ids, on layer `L12`); tags `api-key:new-asn`, `api-key:many-addresses`; store keys `ak:k:`, `ak:a:`, `ak:m:` and the distinct count `apikey:` | values |

Built on these choices, confirmed by the user (2026-11-16): an API key's id is keyed by `HMAC(secret, "apiKey|" + id)` everywhere the engine keeps it (limits, counted rules, bans, distinct counts, the shared store, `Decision.subject.apiKey`), as PR-S7 keys usernames, and S7's rule that a shared store needs a `secret` covers it; list entries and `ban({ apiKey })` still take the id, and the engine maps it. The plan's "per-key limits from the key's plan" is a limit field, `apiKeyPlan`, matched against `identify()`'s `apiKeyPlan` (route stage; WebSocket message limits never count a plan's limit), rather than a new section. The anomalies are off unless the `apiKeys` section names them; `true` takes the defaults (`tag`; 30 days of memory; 20 addresses an hour). A key's first ASN is learned; ASNs are remembered from their first use for `remember` (a store's `increment` creates them with that lifetime; it does not refresh). The anomalies run in the route stage, after L7 and the bot signals and before L8's sensitive endpoints and L9's limits, and never for an allow-listed, internal or service-identity client. Each anomaly's event, its `ban` and `onKeyCompromised` happen once per key and new ASN, or once per key and window for `manyAddresses` (a marker in the store), while its `tag`, `challenge` or `ban` answer applies to every request it finds. `onKeyCompromised` is called for a `ban` action and for `revokeApiKey()`, never for `log`, `tag` or `challenge`; revoking stays the app's job. Not built: the other anomalies (rate against a baseline, unused scopes, 401/403 bursts), the alert webhook and the UI action (M2).

### 17.18 Added with PR-D1 (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| subpaths `./store`, `./lib/store`, `./testing`, `./lib/testing` | bun-security |
| values `DOC_KINDS`, `MAX_PAGE_LIMIT`, `DEFAULT_STORE_PREFIX`, `DEFAULT_POLICY_POLL_MS`, `DEFAULT_POLICY_RECONCILE_MS`, `isPolicyFromStore`, `storeSchema`, `storeTables` | `./store` |
| types `DocKind`, `StoredDoc`, `PutResult`, `AppendResult`, `PolicyVersionInput`, `PolicyVersionRecord`, `PolicyHead`, `Change`, `PolicyFromStore`, `PolicySourceStatus`, `MemoryStoreOptions`, `SqliteStoreOptions`, `PolicyFileOptions` | `./store` |
| `SecurityStoreDriver` members `getVersion` (beyond storage.md §3.1's list); capability `readOnly` (`policyFile`) | `./store` |
| `faultyStore`, types `StoreConformanceFactory`, `StoreConformanceInstance`, `StoreConformanceOptions`, `StoreConformanceCrossProcess`, `FaultyStoreOptions`, `StoreOperation` | `./testing` |
| `createSecurity`'s `policy: { store, id, lastKnownGood, pollIntervalMs, reconcileIntervalMs }`; `SecurityStatus.policySource`; warning kinds `policy.refused`, `policy.unavailable`; the last-known-good format id `bun-security.lkg/1` | `.` |
| `policyFile`'s options `id` (default `default`), `watch`, `debounceMs`, `onError`, `now`; its version ids `sha256:<16 hex>` (a revert `<hash>@<number>`) | `./store` |
| the encryption seam (storage.md §8, for PR-D3): `sqliteStore`'s `codec` option, types `StoreCodec` (`seal`, `open`) and `StoreCodecContext` (`field`, `kind`, `id`, `version`) | `./store` |

Scope (the user's decision, 2026-11-16): PR-D1's store holds documents, policy versions and the change feed. The bans, the audit chain, signed bundles and the analytics operations of storage.md §3.1 join the store with the control-plane PRs in M2 that define their records (PR-CP1 for events and analytics, PR-CP2 for bundles; bans and the audit chain with them), and `capabilities.analytics` is `false` until then.

### 17.19 Added with PR-T2 (approved by the user, 2026-11-16)

| Names | Where |
|---|---|
| `runAttack(attack, target, { advance, settle, refused, stopAfterRefusals })`; targets `fetchTarget(app)`, `handlerTarget(handler, origin?)`; types `Attack` (`name`, `requests`), `AttackRequest` (`method`, `path`, `client`, `headers`, `body`, `at`), `AttackResult` (`name`, `sent`, `statuses`, `byStatus`, `refused`, `firstRefused`, `codes`, `answers`), `AttackTarget`, `RunAttackOptions`, `FetchableApp`, `ServeHandler`; the code `dropped` for a dropped connection | `./testing` |
| simulators `credentialStuffing`, `distributedGuessing`, `passwordSpraying`, `lowAndSlow`, `accountEnumeration`, `pathScan`, `ipv6Rotation`, `addressRotation`, `keyCardinalityFlood`, `burst`, `forwardedForSpoof`, `crawl`, `spoofedCrawler`, `disposableSignups`, `apiKeyAbuse`, `crossSitePosts`; type `SignInAttackOptions` (`path`, `usernameField`, `passwordField`, `headers`, `everyMs`) | `./testing` |
| helpers `paced(attack, everyMs, startMs?)`, `sequence(name, ...attacks)`, `nthAddress(n, base?)`, `ipv6InPrefix(n, prefix?)`, `probeAnswers(attack, target)`, `enumerationLeaks(answers, known, minMs)` (`"status"`, `"body"`, `"time"`), type `ProbeAnswer`; constants `PROBE_PATHS`, `CRAWLER_USER_AGENTS`; the fake `staticCrawlerResolver({ reverse, forward })` | `./testing` |

Built on these choices: the simulators are plain
request lists (an app can edit, filter or combine them) and one sequential
runner, so a run is deterministic; time is a request's `at`, applied to the
app's fake clock through `advance`, never waited for; outcomes only (no
throughput, no timing apart from `probeAnswers`' minimum-time check for
T-L11-2). The default refusal test counts a `403`, `429` or `503`, any
problem+json `code` except on a `401`, and a dropped connection; the engine's
disguised `404` for a probe counts, a honeypot's (indistinguishable from the
router's, by design) does not. The simulators' module imports no test runner; it
shares `./testing` with PR-D1's store kit, whose conformance suite imports
`bun:test`.
Default addresses are public, never an internal range.

Decided with it (the user, 2026-11-16), from the attack runs' findings:

- **L7 request-rule hits count `rule.hit`**, not `pattern.hit`: the attack
  run showed a Tor client's refused `POST /auth/signup` tripping ConcaveHR's
  `disposable_signup` (a counted rule on `pattern.hit`, 7 days).
  `pattern.hit` is now only the identifier checks' (`security.check()`,
  L11.7), and the managed probe set keeps `probe.hit`. A counted rule or a
  ladder weight on `pattern.hit` that meant request-rule hits moves to
  `rule.hit`.
- **A valid device cookie skips the `step-up` tag**: the owner signing in
  on a known device is not asked for a second factor while the account is
  being attacked from many addresses; a device without the cookie still is.
- Left to their own PRs: the limits' store counting its evictions
  (kingsloob1/bun-node#819, then the engine's wiring; `maxKeys`' JSDoc no
  longer claims them meanwhile) and a global failure-rate rule for a spray
  that uses a fresh address per attempt.

The trust-proxy and throttle names (`trustProxy`, `throttle()`,
`ThrottleStore`, `cacheThrottleStore`, `@Throttle`, `@SkipThrottle`) are
the foundations', approved with them, not here.

---

### 17.20 Added with the global failure-rate rule (approved by the user, 2026-11-17)

| Names | Where |
|---|---|
| the preset `login.failure-rate` (on, in dry run, as it ships; `"enforce"` answers); values `DETECTOR_PRESETS`, `PRESET_IDS` (the detector presets beside `PRESETS`) | `.` (presets) |
| policy fields `profiles.login.failureRate` (`window`, `baseline`, `factor`, `minFailures`, `hold`, `respond` `challenge`/`tag`/`limit`, `to` `hosting`/`newDevice`/`all`, `limit` `{ attempts, window, by: "asn" \| "hosting" }`); types `FailureRatePolicy`, `FailureRateTarget` | policy format |
| `SecurityStatus.loginFailureRate` (each `login` route's `route`, `tripped`, `since`, `failures`, `attempts`, `ratio`, `baselineRatio`, `readAt`); type `FailureRateState`; the warning kind `login.failure-rate`; the rule id `login:failure-rate` | `.` |
| `flush()` also reads the rule's counts afresh | `.` |

Decided with them (2026-11-17): it ships **on, in dry run**, as recommended. **A valid device cookie for the username exempts a sign-in from the rule**, whatever `to` says, `all` and a hosting address included, matching PR-T2's `step-up` exemption (§17.19): the owner's known device keeps signing in during an attack, and an attacker cannot forge the cookie, which is signed and bound to the username. So `to: ["all"]` answers the same attempts as `"newDevice"`; it is kept as the spelling that says so. Tripped, it answers a route's every new-device and hosting-address sign-in, service-wide, so a false trip is wide; its baseline needs a day of history; and enforced without a challenge flow its challenge is a `429` for those sign-ins. In dry run it records what it would answer and raises `login.failure-rate` from day one, which is the alert §9.3 asks for; `presets: { "login.failure-rate": "enforce" }` answers, and is the setting for a service with a challenge flow. The counts are a ratio against the route's own history before the window, not a volume: a Monday-morning surge of ordinary sign-ins raises failures and successes alike and trips nothing (tested), at the cost that a spray hidden inside heavy ordinary traffic moves the ratio little.

### 17.21 Added with the eviction wiring (approved by the user, 2026-11-17)

No new public name. One behaviour, for approval: the engine's default `throttleStore` (a `memoryThrottleStore` bounded by `maxKeys`) now reports its drops at `maxKeys` to the engine (bun-common's `onEvict`, #821, the `"cap"` reason only), so they count in `status().state.evictions` and raise the `state.evictions` warning ("the rate-limit counters table"), as the engine's own tables' drops did. A counter that expired is not an eviction, and a `throttleStore` the app passes is the app's: the engine counts none of its drops. The warning's `share` is capped at 1, since the store reports its drops but not its inserts. `maxKeys`' JSDoc and the README now say exactly that, replacing PR-T2's "not counted yet".

### 17.22 Added with PR-CP2 (approved by the user, 2026-11-17)

| Names | Where |
|---|---|
| `createSecurityApi(options)` → `SecurityApi` (`router`, `basePath`, `plane`, `openapi()`, `asyncapi()`); options `store`, `authenticate`, `authorize`, `owners`, `stepUp` (`verify`, `challenge`), `allowWithoutStepUp`, `approvals` (`off`, `two-person`), `approvalTtl`, `signing`, `bundleTtl`, `basePath` (default `/security/api`), `csrf` (`header`, `origins`, or `false`), `docs` (`title`, `version`), `logger`, `now`; types `SecurityApiOptions`, `Operator`, `PermissionTarget`, `StepUpHook` | `./control` |
| `secureAdmin({ hostname, port, api, ui, allowPublicBind, tls, trustProxy, security, logger })` → `AdminListener` (`url`, `port`, `adapter`, `close`); `isPrivateBind(hostname)`; types `SecureAdminOptions`, `AdminMount`, `AdminListener` | `./control` |
| `mergePolicies(layers)` → `MergedPolicy` (`policy`, `origins`, `locked`); `diffPolicies(before, after)` → `PolicyChange[]`; `dangerousChanges(before, after, production)`; types `PolicyLayer`, `LockedOverride`, `PolicyChange` | `./control` |
| `signBundle(unsigned, signer)`, `bundlePublicKey(privateKey)`; types `BundleSigner` (`{ keyId, privateKey }` or `{ keyId, sign }`), `ResolvedSigner`; `ControlPlane` (the logic behind the routes), `ApiProblem`; types `PublishRequest`, `PublishOutcome` | `./control` |
| `verifyBundle(bundle, keys, { service, after, now })` → `BundleVerdict` (refusals `malformed`, `format`, `unknown-key`, `signature`, `not-yet-valid`, `replayed`, `wrong-service`; `expired` on an accepted one), `canonicalJson`, `bundleSigningBytes`; types `SecurityBundle`, `BundleSignature`, `BundleArtefact`, `BundlePublicKey`, `BundleRefusal`, `VerifyBundleOptions` | `.` and `./bundle` |
| constants `SECURITY_API_PROTOCOL_VERSION`, `BUNDLE_FORMAT` (`bun-security.bundle/1`), `DEFAULT_SECURITY_CSRF_HEADER` (`x-bun-security-csrf`), `DEFAULT_API_PAGE_LIMIT` (50), `MAX_API_PAGE_LIMIT` (200), `MAX_GROUP_DEPTH` (4), `SECURITY_API_PERMISSIONS`, `SECURITY_ROLES` (`viewer`, `analyst`, `operator`, `admin`, `owner`), `ROLE_PERMISSIONS`, `SECURITY_API_ERROR_CODES`, `SECURITY_LIVE_EVENTS`; the wire types `ServiceDto`, `ServiceInput`, `GroupDto`, `GroupInput`, `ServiceIdentityDto`, `ServiceIdentityInput`, `PolicyDto`, `PolicyDraftDto`, `PolicyDraftInput`, `PolicyVersionDto`, `PolicyDiffDto`, `PolicyChangeDto`, `PublishInput`, `RollbackInput`, `PublishResultDto`, `CompiledBundleDto`, `EffectivePolicyDto`, `ApprovalDto`, `ApprovalDecisionInput`, `RoleBindingDto`, `RoleBindingInput`, `OperatorDto`, `SecurityApiMetaDto`, `SecurityApiPermissionsDto`, `SecurityLiveEventDto`, `ProblemDto`, `PageDto`, `PolicyScopeId`, `SecurityApiPermission`, `SecurityRole`, `SecurityApiErrorCode`, `SecurityLiveEventName` | `./control/contract` (browser-safe) |
| permissions `services:read`, `services:write`, `groups:read`, `groups:write`, `identities:read`, `identities:write`, `policy:read`, `policy:draft`, `policy:publish`, `bundles:read`, `approvals:read`, `roles:read`, `roles:write`; problem codes `invalid_request`, `unauthenticated`, `forbidden`, `csrf`, `step_up_required`, `not_found`, `conflict`, `invalid_policy`, `locked`, `confirmation_required`, `approval_required`, `approval_closed`, `self_approval`, `not_modified`, `internal` (type `urn:bun-security:problem:<code>`); live events `policy.published`, `bundle.compiled`, `approval.created`, `approval.decided`; approval actions `policy.publish`, `policy.rollback`, `roleBinding.create`, `roleBinding.delete`, `serviceIdentity.put`, `serviceIdentity.delete` and statuses `pending`, `review`, `approved`, `rejected`, `expired`, `stale` | values |
| routes under `basePath`: `GET /meta`, `GET /meta/permissions?scope=`, `GET /operators/me`, `GET|POST /services`, `GET|PUT|DELETE /services/:id`, `GET /services/:id/effective`, `GET /services/:id/bundle`, the same five for `/groups` and `/service-identities`, `GET /policies/:scope`, `PUT /policies/:scope/draft`, `GET /policies/:scope/versions`, `GET /policies/:scope/versions/:id`, `GET /policies/:scope/diff?from=&to=`, `POST /policies/:scope/publish`, `POST /policies/:scope/rollback`, `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/approve`, `POST /approvals/:id/reject`, `GET|POST /role-bindings`, `DELETE /role-bindings/:id`, `GET /live` (SSE), `GET /openapi.json`, `GET /asyncapi.json`; scopes `global`, `group:<id>`, `service:<id>` | the API |
| the store's `putBundle(serviceId, { version, bundle }, expectedVersion)` and `getBundle(serviceId, ifNoneMatch?)`; types `BundleInput`, `StoredBundle` (`etag` `"<version>"`), `PutBundleResult`, `ChangeKind` (a change's `kind` may be `bundle`); the document kind `policyDraft`; the SQL table `<prefix>bundles`; `faultyStore` operations `putBundle`, `getBundle` | `./store`, `./testing` |
| `locked?: boolean` on a limit, a counted rule and a request rule | policy format |

Decided with them (the user, 2026-11-17): bundles are signed with
**Ed25519** (a public key on every EP, so neither an EP nor the store can
forge one), the CP holding the key with a `sign` hook for a KMS (Q13); P4's
HMAC envelope is for CP4's agent requests. **The first owner is deploy-time**
(`owners`), never the first caller: without `owners` or the host's own
`authorize`, `createSecurityApi` throws. **`locked` joins limits, counted
rules and request rules** (additive). **Scope:** bans, list entries, rules,
identifier patterns, IP-intel sources, agent keys, analytics, alerts and the
audit log are later PRs; break-glass (Q11) comes with CP3; `/live` carries
only policy, bundle and approval events (SSE; the WebSocket channel and the
analytics topics come with CP5); the typed client (`routes.gen.ts`) with
PR-U1, CP2 shipping the OpenAPI document and a test that it covers every
route.

Built on these choices, confirmed by the user (2026-11-17): a draft is a document
(`policyDraft`, by scope) saved by revision and published by the head it was
based on, never a version; publishing deletes the draft. A draft must
compile over the published scopes above it, and an override of an item a
higher scope locked is a `422` naming the scope. Every write that changes a
service's effective policy (a publish, a service's groups, a group's parent,
an identity) recompiles its bundle, and a service whose effective policy
would not compile is refused before the write. A **dangerous change**
(control-plane.md §5.4: dry run to enforced or the policy's own mode on a
`production` service, an action raised, an allow entry added or widened, the
ladder changed; a brand-new enforced rule is not) needs, with approvals off,
the scope's name typed in `confirm` (`428` without it), and with
`approvals: "two-person"` an approval (`202`) another operator holding the
change's permission approves within 24 hours; an emergency publishes at
once and opens a review. With no step-up hook and two-person approvals,
every step-up-guarded change (publish, rollback, identities, role bindings)
opens an approval instead; with neither, `allowWithoutStepUp` is required.
An approval whose base moved is `stale` (`409`). A role binding on a group
covers its descendants and their services. The policy's JSON Schema is not
built yet: the documents describe a policy as an object, and its own
validator checks it.

### 17.23 Added with PR-D2 (approved by the user, 2026-11-17)

| Names | Where |
|---|---|
| `postgresStore`'s options `url`, `connection`, `prefix`, `syncSchema`, `max`, `pollIntervalMs`, `now`, `codec`; type `PostgresStoreOptions` | `./store` |
| the feed's `NOTIFY` channel `<prefix>changes` (payload: the change's sequence number); the advisory lock key `(0x62736563, hashtext(prefix))`; the index `ix_<prefix>docs_id` (Postgres only) | Postgres |

How the change sequence stays safe (storage.md §3.1, PR-D2): every mutating transaction first takes a transaction-scoped advisory lock (`pg_advisory_xact_lock`, one key per table prefix), before it touches a row, so writers commit one at a time and their sequence numbers commit in order; a reader at the feed's head never skips one. Chosen over a transaction-id watermark (`pg_snapshot_xmin`), which would let writers run in parallel but let any long transaction anywhere in the database hold the whole feed back, and over a sequence-table row lock, which is the same serialisation with a table to keep. The cost is that one store's writes run one at a time, which configuration written by people never notices. Proved by a test that pauses a writer inside its transaction after its number is taken: without the lock (the negative control), a reader at the head skips its change for good; with it, the later writer waits and the reader sees both, in order. CIDR queries (`inet`): no store operation needs one yet (list entries are documents), so `cidrQuery` stays `false`; the column and its query come with the operation that needs them.

### 17.24 Added with PR-CP3 (approved by the user, 2026-11-17)

| Names | Where |
|---|---|
| `createSecurityApi`'s options `audit` (`signing`: `{ keyId, privateKey }` or `{ keyId, sign, publicKey }`; `sinks`; `allowNoExternalCheckpoints` (default `false`); `checkpointEvery` (default 1,000); `checkpointInterval` (default `"1h"`); `previousKeys` (retired audit keys' public halves by id)), required; `breakGlass` (`passwordHash`, `totpSecret`, `id` (default `break-glass`)); `onAlert(alert)`; `Operator.sessionId`; `SecurityApi.verifyAudit()`, `checkpointAudit()`, `purgeAudit({ before })`; `ControlPlane.audit` (the log: `intent`, `done`, `event`, `verify`, `reconcile`, `describe`, `entries`, `checkpointNow`, `purge`), `ControlPlane.auditPage`, `auditEntry`, `alert`, `emit` | `./control` |
| `fileCheckpointSink(path)`, `webhookCheckpointSink({ url, secret, fetch, timeoutMs, read })`, `callbackCheckpointSink({ name, write, read })`, `auditHash(prevHash, entry)`, `totpCode(secret, counter)`; types `AuditSigning`, `CheckpointSink` (`name`, `write`, `read?`), `WebhookCheckpointSinkOptions`, `BreakGlassOptions` | `./control` |
| constants `BREAK_GLASS_HEADER` (`x-bun-security-break-glass`), `AUDIT_INCOMPLETE_HEADER` (`x-bun-security-audit`, value `incomplete`), `SECURITY_ALERT_KINDS`; types `SecurityAlertKind`, `SecurityAlertDto` (`kind`, `severity` `info`/`warning`/`critical`, `message`, `at`, `detail`), `AuditActorDto` (`kind` `operator`/`break-glass`/`system`), `AuditTargetDto`, `AuditEntryDto`, `AuditCheckpointDto`, `AuditProblemDto`, `AuditVerifyDto`, `BreakGlassLoginInput`, `BreakGlassSessionDto` | `./control/contract` (browser-safe) |
| permissions `audit:read` (analyst and up), `audit:export` (admin and up); problem codes `audit_unavailable` (`503`), `break_glass_locked` (`429`); the live event `breakGlass.used`; alert kinds `breakGlass.login`, `breakGlass.locked`, `audit.verifyFailed`, `approval.emergency`, `policy.dangerous`, `checkpoint.sinkFailed` | values |
| audit actions `service.put`, `service.delete`, `group.put`, `group.delete`, `serviceIdentity.put`, `serviceIdentity.delete`, `policy.draft`, `policy.publish`, `policy.rollback`, `approval.open`, `approval.approve`, `approval.reject`, `roleBinding.create`, `roleBinding.delete`, `audit.purge`, `audit.export`, `breakGlass.login`, `breakGlass.failed`; phases `intent`, `done`, `event`; a done's `outcome` `applied`/`refused`; an intent's status `done`, `completed-unconfirmed`, `not-applied`; `verify`'s reasons `hash-mismatch`, `gap`, `order`, `anchor`, `truncated`, `checkpoint-signature`, `checkpoint-mismatch`; its `external` `none-configured`, `checked`, `write-only` | the log |
| routes `GET /audit?limit&cursor&direction&actor&action&scope&since&until`, `GET /audit/checkpoints`, `GET /audit/verify`, `GET /audit/export?since&until` (`application/x-ndjson`), `GET /audit/:n`, `POST /break-glass/session` (only with `breakGlass`) | the API |
| the webhook sink's headers `x-bun-security-timestamp` and `x-bun-security-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">`; a checkpoint's signed bytes, the canonical JSON of `{ n, hash, at }` (signature base64) | wire |
| the store's `appendAudit(input, expectedPrevHash)`, `getAuditHead()`, `listAudit(query)`, `appendCheckpoint(checkpoint)` (the first for a number wins), `listCheckpoints(query)`, `deleteAuditBefore(beforeN, limit)`; `AUDIT_GENESIS_HASH` (64 zeros); types `AuditInput`, `AuditRecord`, `AuditHead`, `AppendAuditResult`, `AuditQuery`, `AuditCheckpoint`; the change kind `audit`; tables `<prefix>audit`, `<prefix>audit_head`, `<prefix>audit_checkpoints`, indexes `ix_<prefix>audit_at`, `ix_<prefix>audit_actor`; cursor prefixes `sa1.` and `sc1.`; `faultyStore` operations `appendAudit`, `getAuditHead`, `listAudit`, `appendCheckpoint`, `listCheckpoints`, `deleteAuditBefore` | `./store`, `./testing` |

Decided with them (the user, 2026-11-17):

- **Q1, the audit key**: a separate, required Ed25519 key for checkpoints;
  `createSecurityApi` refuses one equal to the bundle key (by id or by
  public key).
- **Q2 and Q7, sinks**: at least one external sink is required, or
  `allowNoExternalCheckpoints: true` (then `verify` reports
  `external: "none-configured"`). File, signed-webhook and callback sinks
  are built, each with an optional `read()` that `verify` uses. A sink
  outage never blocks a change: the change lands, the checkpoint is retried
  with the next one (at most 100 waiting per sink, in this process), and
  `checkpoint.sinkFailed` alerts.
- **Q3, retention**: 400 days, by a host-scheduled `purgeAudit({ before })`,
  never a route, only up to a checkpoint so the oldest kept entry stays
  anchored, and itself audited.
- **Q4, permissions**: `audit:read` from analyst up; `audit:export` from
  admin up, with a step-up.
- **Q5, break-glass (Q11)**: a `Bun.password` hash and a TOTP secret
  (RFC 6238: SHA-1, 6 digits, 30 s, ±1 step), from the environment; a
  15-minute HMAC-signed token in `x-bun-security-break-glass`; single-use
  codes; 5 failures lock it for 15 minutes; it acts as `owner` on `global`,
  its step-up counted fresh for 5 minutes; every login and failure audited;
  a login also raises an alert, a live event and an error-level log line.
- **Q6, alerts**: an `onAlert` hook with the kinds above (`policy.dangerous`
  added beside the five proposed, for a dangerous change published).
- **Q8, intent first** (changed by the user from the proposal): before a
  change, an `intent` entry (the action, scope, target and intended
  after-state or diff) is appended; if that fails after bounded retries
  (three), the change is refused with `503` and nothing changes. After the
  change, a `done` entry references the intent; if it fails, the change
  stands and the answer carries `x-bun-security-audit: incomplete`.
  `verify` and `GET /audit` reconcile an intent with no done against the
  store (the version exists; the document's revision reached the one
  intended; a deleted document is gone) as `completed-unconfirmed` or
  `not-applied`, never as tampering. Proved by tests: the intent failing
  refuses the change (a negative control shows recording after the change
  leaves it with no trace), a done failing, and both reconciliations.

Built on these choices, for review: an entry's hashed body carries its
indexed columns (time, actor, action, scope), so editing a column is a
`hash-mismatch` too. A refused change (a `409`, a `422`) is recorded as an
intent and a `refused` done; a request refused before the change is tried
is recorded only when a signed-in operator lacked a permission or a
step-up (below); an invalid body is not. A checkpoint is
signed over `{ n, hash, at }` and stored before the sinks are written; the
Postgres store takes D2's advisory lock in the same transaction as each
audit append, checkpoint and purge (a test holds a change in its
transaction: with the lock the audit append and checkpoint wait; without it,
the negative control, they pass), and the conformance kit's two-process
race appends to the chain from both sides and checks it is one line. Draft changes are recorded as
a diff from the previous draft, publishes as a diff from the head, other
documents with their before and after.

The user approved these names and the four choices above as built
(2026-11-17), and decided three changes, made in the same PR:

- **Break-glass state is in the shared store.** The failure counter (an
  atomic increment with an expiry, 15 minutes after the last failure) and
  the used TOTP codes (a set-if-absent with a TTL) are kept in the store,
  so every control-plane instance on it shares the lock and refuses a code
  another used. The store gains counters and claims for it, with
  conformance cases on memory, SQLite and Postgres (the writes under D2's
  lock, proved like the audit append). Tested with two `createSecurityApi`
  instances on one store (one memory store, two SQLite store objects on
  one file, two Postgres store objects on one prefix): five failures spread
  across them lock both, and a code used on one is refused on the other;
  the negative control is two separate stores. Attempts while locked go to
  the log only, so at most five failures per lock reach the chain.
- **Refusals of signed-in operators are audited.** An authenticated
  operator refused for a missing permission (`403 forbidden`) or a failed
  step-up (`401 step_up_required`) becomes an `access.refused` event,
  outcome `refused`, with the permission, the scope, the route and its
  target. Unauthenticated requests and CSRF refusals stay out of the chain
  (anonymous traffic must not grow it): they are logged (`info`). The
  control plane has no metrics surface yet; counting them waits for one.
- **`/audit?scope=` includes descendants**, as role bindings do: a group
  reads itself, its descendant groups and every service in any of them; a
  service reads itself. A reader bound to a group is refused a sibling
  group (`403`), and sees none of its entries. Entries of a group or
  service deleted since are not matched by a group's filter (it is computed
  from the groups and services that exist now).

Added with those changes (approved by the user, 2026-11-17):

| Names | Where |
|---|---|
| the store's `incrementCounter(key, ttlMs)` → `CounterValue` (`count`, `expiresAt`), `getCounter(key)`, `resetCounter(key)`, `claimKey(key, ttlMs)` → `boolean`; the table `<prefix>counters` (`name`, `count`, `expires_at`); `AuditQuery.scopes` (1 to `MAX_AUDIT_SCOPES`, 5,000); `faultyStore` operations `incrementCounter`, `getCounter`, `resetCounter`, `claimKey` | `./store`, `./testing` |
| the audit action `access.refused` (`reason` `forbidden` or `step_up_required`, `permission`, `route`, `target`); the store keys `breakGlass:<id>:failures` and `breakGlass:<id>:code:<step>`; `ControlPlane.logger`, `ControlPlane.auditScopesUnder(scope)` | the log, `./control` |

### 17.25 Added with PR-D3 (approved by the user, 2026-11-17)

| Names | Where |
|---|---|
| subpaths `./encryption`, `./lib/encryption`; `sealField(value, ring, context)`, `openField(sealed, ring, context)`, `fieldKeyRing(keys)`, `fieldKeyId(sealed)`, `FIELD_LABELS`; types `FieldContext` (`purpose`, `bind`), `FieldKeyRing` (`primaryKeyId`, `keyIds`); `CacheDecryptError`, `CacheKey`, `CacheKeyRing` re-exported; `CacheDecryptError`'s constructor option `subject` | bun-cache |
| the persisted labels `bun-cache/field/1` (AAD), `bun-cache/field/1/aes-256-gcm/<purpose>` (HKDF info), `field` (per-seal expand label) | bun-cache `./encryption` |
| subpaths `./sealing`, `./lib/sealing`; `sealedFields({ keys, fields, acceptUnsealed })`, `resealStore(store, codec, { kinds, pageSize })`, `SealedFieldError` (`reason`, `keyId`, `field`, `kind`, `id`, `path`), `DEFAULT_SEALED_FIELDS`, `SEALED_MARKER` (`$sealed`), `SEALING_PURPOSE` (`bun-security/store`); types `SealedFieldsOptions`, `SealedFieldsCodec` (`keyIds`, `fields`, `isStale`), `SealedFieldPaths` (`doc`, `policy`, `bundle`), `SealedFieldFailure` (`auth`, `unknown-key`, `malformed`, `unsealed`), `ResealStoreOptions`, `ResealResult` (`scanned`, `resealed`, `conflicts`) | bun-security |
| the default sealed fields: `agentKey.secret`, `serviceIdentity.secret`, `alertChannel.url`, `alertChannel.secret`, `operator.totpSeed`; no policy or bundle field | bun-security `./sealing` |

What is sealed by default (storage.md §8): the secrets it lists, as field names on the records that will hold them, since none of those records exists yet. An agent's HMAC secret (`agentKey.secret`: control-plane.md §2 names `secretHash`, which cannot verify an HMAC, so the CP has to hold the secret itself when an agent signs with HMAC), a webhook's URL and signing secret (`alertChannel.url`, `alertChannel.secret`: a Slack-compatible URL carries its token), and the break-glass TOTP seed (`operator.totpSeed`). `serviceIdentity.secret` is there should an identity ever be HMAC; today's identities hold only `verifier`, the token's SHA-256, which is not a secret. Policies and bundles are not sealed: they hold no secret, and the control plane diffs and reviews them. PR-CP4 and PR-CP6 name these fields as they define the records, or change the default in their own PR. The codec is synchronous, as D1's seam is: a KMS's ring is resolved before the codec is built. Sealing binds a value to its place but not to its revision: someone who can write the database can put back an earlier value of the same field of the same row.

Decided by the user (2026-11-17): the default sealed fields above are the
defaults, and CP4 and CP6 use these names or change the default in their own
PR; `acceptUnsealed` defaults to `false`, with `resealStore` for a store that
held secrets before sealing; and a sealed value is bound to its row, field
and version but not its revision, as documented.

### 17.26 Added with PR-CP1 (approved by the user, 2026-11-17)

| Names | Where |
|---|---|
| `SecurityStoreDriver` members `appendEvents(batchId, events, counters?)`, `addCounters`, `listEvents`, `series`, `topK`, `rollup`, `deleteBefore` (present exactly when `capabilities.analytics`); types `SecurityEvent`, `SecurityEventSubjects`, `EventFilter`, `EventListQuery`, `CounterRow`, `CounterQuery`, `SeriesQuery`, `SeriesPoint`, `TopKQuery`, `TopKRow`, `Tier` (`minute`, `hour`, `day`), `RetainedTable` (`events`, `minute`, `hour`, `day`, `batches`); values `TIER_MS`, `MAX_SERIES_POINTS`, `MAX_BATCH_EVENTS`, `MAX_BATCH_COUNTERS` | `./store` |
| the tables `<prefix>events`, `<prefix>event_batches`, `<prefix>analytics_counters` (named apart from PR-CP3's `<prefix>counters`, its short-lived counters and claims), `<prefix>analytics_state` and their indexes; the event cursor prefix `se1.`; the watermarks `minute>hour`, `hour>day`; Postgres' analytics lock key `(0x62736563, hashtext(prefix \|\| ':analytics'))`, shared for counters, exclusive for a rollup | the SQL stores |
| `faultyStore` operations `appendEvents`, `addCounters`, `listEvents`, `series`, `topK`, `rollup`, `deleteBefore`; the kit's analytics cases | `./testing` |
| subpaths `./analytics`, `./lib/analytics`; `createAnalyticsRecorder` (`service`, `now`, `subjects`, `userKey`, `topK`, `maxRowsPerMinute`, `maxAsns`, `maxRefusedSubjects`, `maxPendingMinutes`; `record`, `recordDecision`, `count`, `flush`, `stats`), `createEventRing` (`service`, `capacity`, `sampleAllows`, `caps`, `maxTracked`, `recorder`, `userKey`, `now`, `random`, `logger`; `offer`, `take`, `giveBack`, `size`), `createRedactor` (`keys`, `headers`; `sensitiveKey`, `sample`), `looksLikeCredential`, `analyticsHook`, `analyticsMaintenance` (`retention`, `grace`, `batchSize`, `maxBatches`, `interval`, `now`, `logger`; `run`, `start`, `stop`, `retention`), `decodeEventBatch`, `ingestEventBatch`, `EventBatchError`, `SpaceSaving`; values `ANALYTICS_METRICS`, `REFUSING_ACTIONS`, `LATENCY_BUCKETS_MS`, `OTHER` (`(other)`), `DEFAULT_EVENT_CAPS`, `DEFAULT_RETENTION`, `MAX_RETENTION`, `EVENT_BATCH_FORMAT` (`bun-security.events/1`), `EVENT_BATCH_LIMITS`, `REDACTED`, `REDACTED_SEGMENT`, `TRUNCATED`, `REDACTION_LIMITS`, `SENSITIVE_KEY_WORDS`, `CREDENTIAL_HEADERS`, `SENSITIVE_PROFILES`; types `AgentEventBatch`, `AnalyticsRecord`, `AnalyticsRecorder`, `AnalyticsRecorderOptions`, `AnalyticsRecorderStats`, `AnalyticsSubjectKind`, `DecisionExtras`, `EventRing`, `EventRingOptions`, `EventCaps`, `EventCap`, `EventExtras`, `OfferResult`, `Redactor`, `RedactionOptions`, `RequestSample`, `SampleInput`, `AnalyticsHookOptions`, `AnalyticsMaintenance`, `AnalyticsMaintenanceOptions`, `MaintenanceReport`, `SpaceSavingEntry` | `./analytics` |
| the metrics `requests`, `requests.route`, `rules`, `requests.country`, `requests.asn`, `responses`, `latency`, `refused` (day tier), `top.refused`, `top.requests`, `analytics.overflow`, `events.capped`, `events.dropped`; the warning `events.capped` | analytics |
| `createSecurityApi`'s option `agentEvents` (`authenticate`, `rateLimit`); types `AgentEventsOptions`, `AgentIdentity`; the route `POST /agent/events`; problem codes `too_large`, `unsupported_encoding`, `rate_limited` | `./control` |

Decisions recorded (the user's answers of 2026-11-17 to CP1's six questions, and what followed from them):

1. **Caps**: 10 events a minute per subject and rule, 30 per subject, 600 per rule at one enforcement point, 1,000,000 a day; past any, the request is only counted, each drop under its reason (`events.capped { cap }`), with the `events.capped` warning once a minute per cap. Allows are sampled one in a thousand.
2. **Bodies**: JSON and form-urlencoded bodies are kept as fields; any other content type keeps its type and length, never a byte.
3. **Redaction**: keys by substring, case-insensitive, `_` and `-` ignored, the list extended by pass, pwd, key, auth, session, cookie, credential, iban, ssn, bvn, nin, cvv (and passport, nationalid, taxid); credential-looking values redacted whatever their key (a JWT, `Bearer …`, a Luhn-valid card number, a run of 24 or more base64 or hex characters with letters and digits); on the `login`, `mfa`, `otp`, `reset` and `signup` profiles only the body's field names are kept.
4. **The answer's body** only when the engine answered; an app's answer keeps its status and redacted headers (`set-cookie` redacted).
5. **Paths and queries**: the route's template where known, credential-looking segments as `:redacted` otherwise; the query under rule 3.
6. **Scope**: the ban log and the heartbeats are PR-CP4's, as is the agent's batcher; CP1 ships the batch's shape, the control plane's ingestion and its route.

Also decided in the build: subjects are the engine's keys (the address, the API key's HMAC, the username's HMAC); a raw user id is never kept, only an app-supplied key of it (`userKey`); a list entry's default id that names an API key or a user (`apiKey:<id>`, `user:<id>`, `ban:user:<id>`) is rewritten to the request's key (or `[redacted]`) in events and counters. `secureAdmin`'s adapter now defers bodies (`request: { deferBody: true }`), and the route authenticates in a `use` middleware, which runs before the router reads a deferred body (the router reads it just before the first *route* callback, `BunRouter.ts` near line 6699, so a check inside a route handler is too late). Measured on a real socket: at authentication the request's body stream is unused and unlocked; on an adapter without `deferBody` it has already been read (the test's negative control). What this does not cover: bytes the runtime has already received into its socket buffers, and the caps of an adapter that reads first. A check before any read at all would sit in bun-common's before-read hook (PR-P2's `addBeforeReadHook`), which sees headers only; whether to move the agent's header checks there is a follow-up. A signature over the decoded body (PR-CP4) can only be verified after the read, so the pre-read step can check the key, the timestamp and the rate, not the signature. A counter added for an hour already rolled up is added to the rolled-up tiers too (the watermarks), and retention never deletes a counter not yet rolled up.

### 17.27 Added with PR-CP4 (approved by the user, 2026-11-17)

| Names | Where |
|---|---|
| subpaths `./agent`, `./lib/agent`; `connectAgent(options)` → `SecurityAgent` (`ready`, `status()`, `sync()`, `reconcile()`, `heartbeat()`, `events`, `close()`); options `url`, `agent`, `secret` (or a list, the new first), `service`, `publicKeys`, `security`, `stateFile`, `artefactDir`, `onArtefacts`, `pollInterval` (`"30s"`), `banPollInterval` (`"5s"`), `reconcileInterval` (`"60s"`), `heartbeatInterval` (`"30s"`), `nudge` (`true`), `start` (`true`), `events`, `fetch`, `logger`, `onAlert`, `now`; types `ConnectAgentOptions`, `AgentEngine`, `AgentAlert` (kinds `state.invalid`, `bundle.refused`, `bundle.replayed`, `bundle.expired`, `bundle.unloadable`, `bans.refused`, `bans.replayed`, `artefact.mismatch`), `AgentArtefact`, `AgentStatusReport`; `AGENT_PROTOCOL_VERSION` (`bun-security-agent/1`) | `./agent` |
| the protocol: `AGENT_HEADER` (`x-bun-security-agent`), `AGENT_SIGNATURE_HEADER` (`x-bun-security-signature`), `AGENT_REQUEST_ID_HEADER` (`x-bun-security-id`), `AGENT_SIGNATURE_WINDOW_MS` (60,000), `AGENT_ROUTES` (`bundle`, `bans`, `artefact`, `heartbeat`, `nudge`, `events`), `AGENT_ID_PATTERN`, `agentRequestId(route, ...parts)` (`<tag>.<parts>.<random>`); a 304's signature over `{"notModified":"<request id>"}`, an artefact's over `{"artefact":"<sha256>"}`; types `AgentRoute`, `AgentHeartbeat` (`route`, `sentAt`, `agentVersion`, `bundle`, `bans`, `health`, `lastError`), `AgentHeartbeatAnswer`, `AgentNudge` (`route`, `reason` `bundle`/`bans`, `at`), `AgentNudgeEvent` (`body`, `signature`), `AgentReportedHealth`; the state file `AGENT_STATE_FORMAT` (`bun-security.agent-state/1`), `AgentState` | `./agent` |
| the batcher: `createEventBatcher(options)` → `EventBatcher` (`flush`, `queued`, `dropped`, `rejected`, `close`), `EventBatcherOptions`, `BatchAnswer`; on CP1's types (re-exported by one file, `lib/agent/events.ts`): `AgentEventBatch` (CP1's, plus `route: "events"`), `AgentEventSource` (`ring`: CP1's `EventRing`'s `take` and `size`; `recorder`: its recorder's `flush`), `SecurityEvent`, `CounterRow`, `EVENT_BATCH_FORMAT`, `EVENT_BATCH_LIMITS`, `MAX_BATCH_EVENTS` (CP1's 500), `MAX_BATCH_COUNTERS` | `./agent` |
| `createSecurityApi`'s `agents` (`allowEphemeralStore`, `rateLimit` (600), `heartbeatInterval` (`"30s"`), `rotationGrace` (`"24h"`), `artefacts` (`{ dir }` or `{ get, put }`), `maxArtefactBytes` (128 MiB), `maxBodyBytes` (1 MiB)); `SecurityApi.addArtefact(bytes)`; `ControlPlane.agents` (`AgentRegistry`), `createBan`, `liftBan`, `listBans`, `banDto`, `audited`, `scopesAbove`, `now()`, `signer`; `agentRequest(req, res, route, context)` and `sendSigned(...)` (CP1's `/agent/events` builds on them), `AgentRegistry`, `directoryArtefacts(dir)`, `sha256Of`; types `SecurityApiAgentsOptions`, `ResolvedAgentsOptions`, `ArtefactStore`, `AgentRequest`, `AgentRequestOutcome`, `AgentRouteContext` | `./control` |
| routes `GET /agents`, `GET /agents/:id`, `POST /agents`, `POST /agents/:id/rotate`, `POST /agents/:id/revoke`, `GET /bans?scope=&active=`, `POST /bans`, `POST /bans/:id/lift`; agent routes `GET /agent/bundle`, `GET /agent/bans?since=&full=`, `GET /agent/artefacts/:sha256`, `POST /agent/heartbeat`, `GET /agent/nudge` | the API |
| permissions `agents:read` (analyst up), `agents:write` (admin up), `bans:read` (viewer up), `bans:write` (operator up); problem codes `rate_limited`, `too_large`; the live event `ban.changed`; the alert kind `agent.signatureFailing`; the audit actor kind `agent`; audit actions `agent.create`, `agent.rotate`, `agent.revoke`, `agent.firstContact`, `agent.keyRotated`, `agent.signatureFailing`, `agent.signatureRecovered`, `agent.refused`, `ban.create`, `ban.lift`; types `AgentDto` (statuses `never-seen`, `ok`, `late`, `offline`, `signature-failing`, `revoked`), `AgentStatus`, `AgentCreateInput`, `AgentSecretDto`, `BanDto`, `BanCreateInput` | `./control/contract`, values |
| signed ban batches: `BAN_BATCH_FORMAT` (`bun-security.bans/1`), `BanBatch` (`format`, `service`, `request`, `since`, `seq`, `full`, `issuedAt`, `bans`, `signature`), `verifyBanBatch(batch, keys, { service, since, request })` (refusals `malformed`, `format`, `unknown-key`, `signature`, `wrong-service`, `replayed`), `banBatchSigningBytes` | `./bundle` |
| the store's `upsertBan(ban)`, `liftBan(id, by, at)`, `getBan(id)`, `listBans({ limit, cursor, direction, scopes, active })`; `banId(scope, subject)` (`ban_<40 hex>`); types `BanInputRecord`, `BanRecord`, `BanQuery`, `StoredBanSubject` (`ip`, `cidr`, `user`, `apiKey`); the change kind `ban`; the document kind `agentHealth`; the table `<prefix>bans`, index `ix_<prefix>bans_scope`, cursor prefix `sb1.`; store keys `agentNonce:<mac>`, `agentRate:<agent>:<minute>`, `agentRefusedAudit:<agent>`; `faultyStore` operations `upsertBan`, `liftBan`, `getBan`, `listBans`; the default sealed field `agentKey.previous.secret` | `./store`, `./testing`, `./sealing` |

Decided by the user (2026-11-17), from the coordinator's relay:

- **Settled by the docs**: a ±60 s window, each signature's nonce claimed
  in the store (`claimKey`); a failed or replayed bundle keeps the last
  good one, with an alert; past `expiresAt`, a warning, still enforced;
  the last known good written atomically, `0600`, loaded before the
  control plane is asked; bootstrap on the host's own policy.
- **Rotation**: `POST /agents/:id/rotate` with a step-up, the new secret
  shown once, the old one sealed in `agentKey.previous` and accepted until
  the agent's first request with the new one or 24 hours, whichever first;
  revoke is immediate.
- **Route binding**: a route tag in each bodyless request's id and a
  `route` in each body, both checked; no bun-common change.
- **Every answer to an agent is signed** (the envelope's `response`).
- **Last known good**: re-verified at start like a pulled bundle; a bad one
  ignored with a critical alert; the highest accepted version a floor
  across restarts; trusted indefinitely after that, with the expiry
  warning.
- **Every signature failing**: keep enforcing; one critical alert per
  distinct version or `ETag`; `signature-failing` in the agent's health.
- **Ban batches are also signed with the bundle key** (changed by the
  user from the proposal): the agent verifies each with the deploy-time
  keys and refuses and alerts on a bad one, so a forged row in the control
  plane's database cannot inject a ban. Changes every 5 s, a nudge on
  change, the whole set every 60 s, scoped global ← groups ← service.
  Tested: a forged batch, one signed with another key and a replayed older
  batch are each refused; negative controls accept each when the check
  that caught it is left out.
- **Audit**: operator create, rotate and revoke go intent-first; agent
  state changes (first contact, the switch to a rotated key, signature
  failing starting and stopping, a known agent's refused request) are
  events; heartbeats update health only.
- **mTLS** is a later follow-up. **Artefacts**: an `artefacts` option, a
  content-addressed directory or `{ get, put }`, `GET
  /agent/artefacts/:sha256` capped at 128 MiB, hash-checked and written
  atomically by the agent; publishing them in bundles is a later PR
  (`addArtefact` only).
- **With agents, a non-durable store is refused** unless
  `allowEphemeralStore: true`; the README states the multi-host need.
- **600 agent requests a minute per agent**; `late` after 3 missed
  heartbeats and `offline` after 10 (30 s apart); nudge backoff 1 s to
  60 s. The `./agent` subpath; the store's bans with the merge rules,
  history, a `ban` change kind, conformance on memory, SQLite and Postgres,
  writes under D2's lock.

Built on these choices, for review: a ban batch is bound to the signed
request it answers (`request`), not only to `since`, because a full
reconcile asked from an unchanged `since` could otherwise be answered with
an older full set that still holds a lifted ban. The last known good keeps
the last **full** ban batch as signed, re-verified at start (its request
binding was checked when it arrived); deltas after it are re-fetched. A
known agent's refusals reach the audit chain at most once a minute per
agent (the rest are logged), so garbage sent under an agent's id cannot
grow the chain. The agent signs a gzip body's decoded content (gzip is
only how it travels), because bun-common's router reads and decodes a body
before any route runs, even under the adapter's `deferBody` (measured): the
agent routes check the key, the time and the rate before looking at the
body, then the kept bytes (`req.buffer`, which needs `retainBuffer`, on by
default); this is also what CP1's `/agent/events` gets through
`agentRequest`. Answers without a body (a 304) are signed over a text
naming their request, and an artefact's over a text naming its SHA-256 (the
envelope refuses to sign a bodyless response, or a body made only of id
characters). Making or rotating a key under two-person approvals with no
step-up hook is refused (an approval would have to show the secret to
someone). An agent's CP bans are applied with the engine's `ban()` (its
raw subject, its remaining duration); two scopes' bans of one subject are
one engine ban, re-applied when one of them is lifted. Bans are listed by
id; `GET /bans?scope=` includes what is under the scope, as `/audit` does.

The user approved these names and choices (2026-11-17) and decided two
changes, made in the same PR:

- **The control plane keys ban subjects.** An API-key ban's subject is
  stored and sent as `HMAC(secret, "apiKey|" + id)`, the keying S11 and
  the engine use, never the raw id; `createSecurityApi` takes the fleet's
  keying secret (`bans.secret`) and refuses to start without it unless
  API-key bans are off (`bans.apiKeys: false`). What the operator typed is
  shown only in the answer to `POST /bans` (`entered`). The store refuses
  an API-key subject that is not 32 hex characters. The agent applies the
  keyed subject as it is (the engine's `ban({ apiKeyHash })`), never keying
  it twice. A user subject follows the engine (in clear today; a separate
  decision on user ids is with the user). Tested: no raw id in the SQLite
  file's bytes (database, WAL and shared memory), the audit log or the
  list; the agent's engine holds the same key an engine on the fleet's
  secret makes from the raw id; negative controls: keyed twice, or on
  another secret, it would miss.
- **No change row for an agent's health.** `agentHealth` is written
  without a change row (`seq` 0); its status (`late`, `offline`) is
  computed when read. Tested: ten heartbeats in a steady state add no row;
  the negative control, a key rotation, does.

Wired after PR-CP1 merged (2026-11-17, the coordinator's relay): CP1's
`POST /agent/events` runs on the agents' signed requests when `agents` is
set, split as CP1 measured: the header checks (`checkAgentHeaders`: the
agent, its key not revoked, the ±60 s window, the per-agent rate) in a
`use` guard that runs before the router reads a deferred body and leaves it
unread; the body's signature (`verifyAgentBody`), its `route: "events"`, the
store's `ingestEventBatch` and a signed answer in the handler. `agents` and
CP1's `agentEvents` together are refused (one route, one authentication).
The batcher flushes the recorder with `{ all: true }` on every batch, the
open minute too, so the live overview (CP5) is not a minute behind: the
recorder forgets what it flushed and the store adds, so a minute sent in
parts counts once (tested). After a batch is stored, and after every ban
written or lifted, an internal live-hub hook is called (`setLiveHooks`,
not exported; a no-op until CP5 sets it; a hook that throws is logged). A
CP ban by key and #836's keyed list entry name the same `apiKey:<HMAC>` in
a decision (tested).

Added with those changes (approved by the user, 2026-11-17):

| Names | Where |
|---|---|
| `createSecurityApi`'s `bans` (`secret`, `apiKeys` (default `true`)); `BanDto.entered` (`{ apiKey }`, the create answer only); the engine's `ban({ apiKeyHash })`; the store's kinds kept out of the feed (`agentHealth`; a write answers `seq` `0n`) | `./control`, `.`, `./store` |
| `HeaderState` (what the agent header check, `agentGuard`/`checkAgentHeaders`, hands to the body check, `verifyAgentBody`), approved by the user, 2026-11-17 | `./control` |

### 17.28 Added with the distinct counts' deadline (approved by the user, 2026-11-17)

| Names | Where |
|---|---|
| `CacheStoreOptions.distinctTimeout` (a `Duration`, 1 ms to 60 s; default the larger of `"250ms"` and `timeout`) | `./stores` |
| `SharedStoreStatus.distinctFallbacks` (`status().state.store.distinctFallbacks`: distinct counts that fell back from the store since the engine started) | `.` |
| the warning kind `store.distinct-fallback` (`SecurityWarningKind`) | `.` |

Why: a distinct count (credential stuffing, spraying, the API-key many-addresses check) that misses the store's deadline falls back to its `onStoreError`, and `local` counts only this process's traffic, so a fleet-wide anomaly goes unseen; under load a Postgres `pfAdd` (a five-statement transaction, about 2 ms idle, 37 ms on a first call) went past the general 50 ms and the sixth address was let through. 250 ms is five times the general deadline: room for a transaction on a loaded SQL engine and for the first call's connection, while a sick store still costs a counting request at most twice that (the write, then the read) until five failures in a row open the circuit, after which it costs nothing. A `timeout` set longer than 250 ms lengthens it with it, so an app that gave every call more room does not find its distinct counts given less. Limits keep the 50 ms: a limit that falls back counts one request at its local share, where a distinct count that falls back misses the attack it exists for.

The fallbacks were visible only in a log line at most every 10 s. Now each is counted (local or not counted alike; `explain()`'s peeks are not), and the `store.distinct-fallback` warning is raised at the first one and again only after a whole minute with none, as `state.evictions` is. Its `share` is the minute's fallbacks over the distinct counts tried in the store that minute, at the moment it is raised; `minutes` and `since` are the run's. The warning in force is not kept in `status()` (the count is): say if it should be, as `state.warning` is for evictions.

### 17.29 Added with the keyed API-key entry ids (#836, approved by the user, 2026-11-17)

No new public name. One behaviour: an API-key list entry's default id, which is the `rule` of its hits and appears in `explain()`'s steps and in `onDecision`, is now `apiKey:` followed by the key id's HMAC under the engine's `secret`. That is the same key as `Decision.subject.apiKey`, so the key id is never reported, as §17.17 requires. Before, it was `apiKey:<the key id>`.
- The compiler has no secret, so each engine keys the id when it matches the entry. One compiled policy in two engines with different secrets reports two ids.
- An `id` the policy's author writes is reported as written.
- A duplicate API-key entry is refused without echoing the id.
- Matching is unchanged: lists, bans by key, limits and counted rules key on the subject, not on entry ids.

Open, for a decision: user ids are not keyed anywhere. `Decision.subject.user`, user bans (`ban:user:u_1`, `unban("user:u_1")`, the ban log) and per-user limits all keep the app's user id in clear, by the original design: §17.17 keys API keys and S7 keys attempted usernames, but nothing keys user ids. Keying only a user entry's id would change nothing while `subject.user` is in clear. Keying user ids throughout would change bans already stored, the `unban()` handle and per-user limit keys, so it is a design change of its own.

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
- Google, *Verifying Googlebot and other Google crawlers* (reverse DNS with
  forward confirmation; the range files for common crawlers, special-case
  crawlers and user-triggered fetchers), read 2026-11-10,
  <https://developers.google.com/search/docs/crawling-indexing/verifying-googlebot>
- Google, *Reduce the Google crawl rate* (429, 500 and 503 slow it down; the
  same answer for multiple days may drop the URL), read 2026-11-10,
  <https://developers.google.com/search/docs/crawling-indexing/reduce-crawl-rate>
- Bing, *How to verify that Bingbot is Bingbot* (reverse DNS under
  `search.msn.com`, forward confirmation), <https://blogs.bing.com/webmaster/2012/08/31/how-to-verify-that-bingbot-is-bingbot>,
  and the published `bingbot.json` (<https://www.bing.com/toolbox/bingbot.json>),
  read through secondary reports on 2026-11-10 [U: the pages themselves to be read in PR-S12]
- Apple, *About Applebot* (reverse DNS under `applebot.apple.com`; the
  published `applebot.json`), <https://support.apple.com/en-us/119829>,
  read through secondary reports on 2026-11-10 [U: to be read in PR-S12]

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
