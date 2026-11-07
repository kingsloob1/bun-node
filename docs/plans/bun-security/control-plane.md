# bun-security: the control plane, and securing the defence itself

Sub-plan of [`README.md`](README.md). It covers the policy model (services,
groups, inheritance), policy bundles and versions, the management API, its
authentication, RBAC, step-up and two-person approval, the tamper-evident
audit log, control-plane ↔ agent authentication, secrets, and the bounds
that keep the defence from being turned into a denial of service. Marks are
the README's (§0.3).

### Contents

1. [Why the control plane is separate](#1-why-the-control-plane-is-separate)
2. [The policy model](#2-the-policy-model)
3. [Bundles, versions, rollback](#3-bundles-versions-rollback)
4. [The management API](#4-the-management-api)
5. [Who may do what: authentication, RBAC, step-up, approvals](#5-who-may-do-what)
6. [The audit log](#6-the-audit-log)
7. [Control plane and agents: authentication and replay](#7-control-plane-and-agents)
8. [Secrets](#8-secrets)
9. [The defence must not become the attack surface](#9-the-defence-must-not-become-the-attack-surface)

---

## 1. Why the control plane is separate

The user's goal is that "bad actors have no access to critical web servers".
The design follows from it [D]:

- **The management API and UI never run on a protected service's public
  listener.** In (a) they run on a second listener bound to loopback or an
  admin interface; in (b) and (c) in their own process on an admin network
  (topologies.md §2). The public listener has no route to them.
- **An agent only pulls.** The CP needs no inbound route into a service's
  network, and a compromised CP cannot reach into the service except through
  the signed bundle the agent chooses to load.
- **A compromised service cannot change policy.** An agent's key can fetch
  its own service's bundle and post events, nothing else; it cannot write
  policy, bans outside its scope, or read other services' data (§7).
- **A compromised CP cannot push an unsigned or older policy** when bundle
  signing uses an offline or separately held key (§7.3).

---

## 2. The policy model

### 2.1 Entities [D]

| Entity | Fields (abridged) |
|---|---|
| `Service` | `id`, `name`, `group ids`, `environment` (`production`, `staging`…), `hosts`, `topology` (a, b, c), `agent keys`, `labels` |
| `Group` | `id`, `name`, `parent?` (groups nest, depth ≤ 4), `labels` |
| `Policy` | `scope` (global, group, service), `layers` (the configuration of each layer in layers.md), `rules` (L7), `limits` (L9), `lists` (L3), `profiles` (L11), `ladder` (§0.2), `mode` |
| `PolicyVersion` | `id`, `policyId`, `number`, `content` (canonical JSON), `hash`, `createdBy`, `createdAt`, `message`, `status` (`draft`, `pending-approval`, `published`, `superseded`, `rolled-back`) |
| `Ban`, `ListEntry` | layers.md L3, L4 |
| `AgentKey` | `id`, `serviceId`, `publicKey` or `secretHash`, `createdAt`, `lastSeenAt`, `revokedAt` |
| `ServiceIdentity` | `id`, `serviceId` (the caller), `verifier` (a hash or a public key), `forwardsClientIp` (whether its forwarded end-user address is believed), `exemptions`, `lastUsedAt` (layers.md L2.4) |
| `Operator` | `id`, `roles` per scope, `mfa` (from the host's identity provider, §5) |

Every entity is stored through a security-store driver
([`storage.md`](storage.md)) and carries a `revision`; every write names the
revision it read, so two operators cannot overwrite each other
(storage.md §3.2).

### 2.2 Inheritance and overrides [D]

The **effective policy** of a service is computed by layering: built-in
defaults ← global ← each ancestor group, outermost first ← the service ←
per-route overrides inside the service's policy. Merge rules:

- **Objects** merge by key; **scalars** replace.
- **Rules, limits and list entries** are keyed by `id`: a lower scope may
  override an inherited one by `id` (change its threshold, its mode) or
  disable it (`{ id, mode: "off" }`), and adds its own.
- A higher scope may mark an item `locked: true`: lower scopes cannot
  override or disable it (the org-wide "block known scanners" rule). The UI
  shows locked items greyed with their origin.
- **Lists** union by default (a group's deny list applies to every member);
  an allow entry in a lower scope never removes a locked deny entry above.

The UI's policy screen shows the effective value of every field with its
origin ("inherited from group *payments*"), and a diff of a draft against
the effective policy (ui.md §3).

### 2.3 Schema and validation [D]

The policy format is defined once, as Standard Schemas in the package (no
dependency, the contract core's style), and:

- validated on every save in the CP and on every load in the EP;
- published as JSON Schema in the management API's OpenAPI document
  (bun-common's `generateOpenApi`, `docs/openapi.ts:947`) [S], so the UI's
  forms and the typed client (bun-client) read the same definition;
- compiled to a matcher per service by a pure function, `compilePolicy`,
  which also enforces the bounds of §9 (rule count, list size, regex safety)
  and refuses with a list of issues.

---

## 3. Bundles, versions, rollback

### 3.1 The bundle [D]

```jsonc
{
  "format": "bun-security.bundle/1",
  "service": "svc_checkout",
  "version": 1842,                     // monotonic per service
  "policyVersions": ["pv_global_77", "pv_grp_payments_12", "pv_svc_checkout_30"],
  "compiledAt": "2026-11-07T10:00:00Z",
  "notBefore": "2026-11-07T10:00:00Z",
  "expiresAt": "2026-11-14T10:00:00Z", // an EP warns, never stops enforcing, past this
  "effective": { /* the compiled effective policy */ },
  "artefacts": [{ "kind": "mmdb-country", "sha256": "…", "url": "/artefacts/…" }],
  "signature": { "alg": "Ed25519", "keyId": "sk_2026_10", "value": "…" }
}
```

The signature is over the canonical bytes of everything but `signature`
(keys sorted, no insignificant whitespace).

### 3.2 Publishing [D]

Draft → (validate, compile, dry-run diff) → `pending-approval` when the
change is dangerous (§5.4) → `published`. Publishing a version recompiles
the bundle of every service under its scope and increments their versions.

### 3.3 Rollback [D]

Rollback is a **new publish** of an older version's content, with a new,
higher bundle version and the message "rollback to pv_…". The EP's
monotonic-version check therefore never has to be bypassed, and the audit log
records it like any change. "Undo last publish" in the UI is this
operation. A **replayed** old bundle (a lower version, validly signed) is
refused by the EP and alerted (it means someone is replaying).

---

## 4. The management API

Built on bun-common, like bun-jobs' `createJobsApi` [S, the survey]:

- `createSecurityApi({ store, authenticate, authorize, … })` returns
  `{ router, basePath, attachWebSocket }`, mounted on the admin listener.
- Every route is declared with bun-contract schemas (`validate(schemas, {
  responses })`), so the API is checked both ways and documented by
  `generateOpenApi`/`generateAsyncApi` [S], and the UI uses bun-client's
  typed calls generated from those documents (README §2.3).
- **Resources** (all lists cursor-paginated, ui.md §5): services, groups,
  policies and versions (diff, publish, approve, rollback), bans (list,
  create, extend, lift, bulk lift), list entries, rules (validate,
  test-a-request), identifier patterns (layers.md L11.7, with hit counts),
  service identities, IP-intel sources and their refresh status (the Tor
  list's size and last refresh, a manual refresh), analytics (series, top-N,
  events and refused-request samples, ban timeline), audit
  log (list, verify, export), agents (list, health, rotate keys, revoke),
  alerts (channels, rules, test), operators and role bindings (when the
  built-in RBAC is used), `/meta` and `/meta/permissions` (the bun-jobs-ui
  pattern of hiding what the operator may not do).
- **Agent endpoints** on a separate router and path (`/agent/*`), with agent
  authentication (§7), never operator authentication: `GET
  /agent/bundle`, `GET /agent/artefacts/:sha256`, `POST /agent/events`,
  `POST /agent/heartbeat`, `GET /agent/bans?since=`, and the nudge channel.
  An EP's auto-ban travels as an event and the CP records it under the
  reporting service's rule: ConcaveHR's `POST /admin/security/report`, by
  which pay-api and finance-api hand their blocks to account-api (write-up
  §2.3), becomes this path, with the EP blocking locally at once.
- **Live**: a typed channel (`defineChannel`) at `/live` with SSE fallback,
  for the analytics feed and the "policy changed / ban added" events of the
  UI (ui.md §6).
- **CSRF**: the UI authenticates with cookies (bun-jobs-ui's model, the
  survey: `credentials: "same-origin"` and a CSRF header on mutations), so
  every mutation needs the CSRF header and passes the Fetch Metadata +
  `Origin` check (bun-jobs' `checkCsrf` at `bun-jobs/lib/api/auth.ts:616`
  [S] is the model; layers.md L13.2's helper replaces it in the package).
- **Rate limits on the API itself**: the CP runs its own engine on its own
  routes (login-like profile on step-up verification, a per-operator limit on
  mutations, a per-agent limit on ingestion).

---

## 5. Who may do what

### 5.1 Authentication [D]

bun-security **does not own identities**. `authenticate(req) →
Operator | null` is required (like `liveInvalidation`'s required `authorize`,
`bun-common/lib/live/server.ts:502-506`, and bun-jobs' required `authorize`,
`bun-jobs/lib/api/config.ts:1410`) [S]: the host plugs in its SSO (OIDC
session cookie), its own login, or a reverse proxy's identity header (only
from a trusted peer). With none, `createSecurityApi` throws `ConfigError`.
A **break-glass** local account (one, from an env-provided password hash,
TOTP required, every use alerted) is an option for when the identity
provider is down during an incident (Q11).

### 5.2 RBAC [D]

Built-in roles, bound per scope (global, a group, a service):

| Role | May |
|---|---|
| `viewer` | read analytics, bans, lists, policies; no event details (no headers, no user ids) |
| `analyst` | viewer + event details, exports, test-a-request |
| `operator` | analyst + create/lift bans and list entries (with expiry ≤ 7 d, CIDR ≥ /16 for v4 and ≥ /32 for v6), toggle a rule's dry run, draft policies |
| `admin` | operator + publish policies, permanent bans, wide bans, manage agents and alert channels |
| `owner` | admin + role bindings, signing-key rotation, audit export settings, break-glass configuration |

Permissions are named (`bans:write`, `policy:publish`, …); a host that has
its own model passes `authorize(operator, permission, target) → boolean`
instead and the built-in roles are not used. `/meta/permissions` reports the
result to the UI.

### 5.3 Step-up for destructive changes [D]

A **step-up** is a fresh proof of the operator's second factor within the
last 5 minutes. bun-security asks the host for it through a hook
(`stepUp: { verify(req, operator) → boolean, challenge(req) → URL }`), so the
host's own MFA (WebAuthn, TOTP) is used. Required for: publish, rollback,
permanent or wide bans, bulk unban, disabling a locked rule, agent key
creation, role changes, alert-channel changes, audit export, any action in
`production` scopes flagged `requireStepUp`. Without a configured step-up
hook, these actions need two-person approval instead, or are refused
(`ConfigError` at start, explicit opt-out `allowWithoutStepUp`).

### 5.4 Two-person approval and confirmation [D]

A change is **dangerous** when it: publishes a policy that turns a rule
from `dryRun` to `enforce` on a production scope; raises an action
(`log` → `block`/`ban`); bans more than 65,536 addresses at once, an ASN or a
country; disables a locked rule; widens an allow list; changes the ladder;
rotates the signing key. With `approvals: "two-person"` (recommended for
(c)), a dangerous change goes to `pending-approval` and needs a second
operator with the permission (not the author) to approve it within 24 h.
Without it, the UI asks the author to type the scope's name to confirm
(the GitHub repository-deletion pattern). Emergencies: an `emergency` flag
publishes at once and opens a mandatory review the second operator must
close; every use is alerted.

---

## 6. The audit log

### 6.1 What is recorded [D]

Every mutation through the API (who, when, from which address and session,
the permission used, step-up and approval ids, the request id, before and
after, or a diff), every login of an operator to the CP, every agent key
use that failed, every auto-ban **summary** per minute (individual auto-bans
are events in the analytics store, not audit entries, or an attack would
flood the audit log, §9), every rollback and every break-glass use.

### 6.2 Tamper evidence [D]

- **Hash chain**: entry `n` stores `hash_n = SHA-256(hash_{n-1} ||
  canonical(entry_n))`. A deleted or edited entry breaks every later hash.
- **Signed checkpoints**: every 1,000 entries or every hour, the CP signs
  `{ n, hash_n, time }` with its audit key and writes the checkpoint to a
  second sink the CP cannot rewrite (an append-only S3 bucket with object
  lock, a syslog server, the host's SIEM, or an email to owners): an attacker
  who controls the CP database can rewrite the chain but not the external
  checkpoints.
- `GET /audit/verify` recomputes the chain and checks the checkpoints; the
  UI shows the result.
- The store is append-only for the API (no update or delete route); in SQL,
  the CP's database user has `INSERT, SELECT` only on the audit table
  (documented; `syncSchema` creates it so).
- Retention: 400 days by default (a year plus a margin), export to JSON
  Lines.

---

## 7. Control plane and agents

### 7.1 Agent authentication [D] [S]

Each agent has its own key, created in the UI (shown once) and bound to one
service. Two forms:

1. **Signed requests** (the default): HMAC-SHA256 over method, path, a
   timestamp, a nonce and the body's SHA-256, in a header. This is
   bun-jobs' remote envelope, which already exists and is exported:
   `signEnvelope`/`verifyEnvelope` (`bun-jobs/lib/remote/signing.ts:463`,
   `:480`), direction inside the MAC so a response cannot be replayed as a
   request, ±300 s window, a nonce store (`createRemoteNonceCache`),
   key rotation by `string | string[]` (`signing.ts:70`) [S]. Reuse it by
   moving it to a shared place (Q12) or depend on bun-jobs' `./remote`
   entry; recommendation: extract the envelope into bun-common's utilities
   (it is dependency-free), so bun-security does not depend on bun-jobs for
   its hot path.
2. **mTLS**, optional, for (c): `Bun.serve`'s `tls` with `ca` and
   `requestCert` on the CP's agent listener, and the client certificate's
   fingerprint bound to the agent key. Recommended in (c) in addition to
   signed requests, not instead (a TLS-terminating load balancer in front of
   the CP would otherwise drop it silently).

### 7.2 Replay protection [D]

- Timestamp window ±60 s (tighter than bun-jobs' 300 s: agents are servers
  with NTP), nonce remembered until the window passes, in the CP's shared
  store (bun-jobs' built-in nonce store is in memory, `nonce.ts:32-60` [S],
  which a restarted or second CP instance does not share; the CP uses a
  bun-cache-backed store).
- Event batches carry an idempotency id; a replayed batch is acknowledged
  and dropped.
- Bundles carry their version (§3.3) and `notBefore`/`expiresAt`.

### 7.3 Signing keys [D]

- The **bundle signing key** (Ed25519) is distinct from agent keys and
  from the audit key. Agents are configured with the bundle public key(s)
  at deploy time (an env var or file), not from the CP, so a compromised CP
  cannot swap the key it is verified with.
- Optionally (Q13), the signing key is **offline**: the CP prepares a bundle,
  and a separate signer (a CLI on an operator's machine or an HSM/KMS call
  through a hook) signs it. v1: the CP holds the key, encrypted at rest
  (§8), with a `sign(bytes)` hook so a KMS can replace it.
- Rotation: agents accept a list of public keys; the CP signs with the
  newest; old keys are removed after every agent has a bundle signed by the
  new one (the agents list shows which key each last verified).

---

## 8. Secrets

| Secret | Where it lives | Notes |
|---|---|---|
| HMAC secret for keys (`username`, `apiKey` hashing, layers.md L2.3) | each EP, from env or a file; the same per scope so counters match | rotation: two secrets, both checked, the new one written; counters keyed by the old expire on their own |
| clearance and device cookie keys | each EP | rotation like cookies' `extractSignedCookies(cookies, secrets[])` (`bun-common/lib/utils/native.ts:1487`) [S] |
| agent keys | the agent (env/file); the CP stores a hash or the public key | shown once at creation |
| bundle signing key | the CP, encrypted at rest with a key from env or a KMS hook; or offline | §7.3 |
| CAPTCHA provider secrets | the EP that verifies | never in a bundle (bundles are readable by every EP of the scope) |
| alert webhook secrets, SMTP credentials | the CP | outgoing webhooks are HMAC-signed with their own secret |
| store URLs | env | never in a bundle, never in an event |

Rules: no secret is ever in a policy, a bundle, an event, an audit entry or a
log line; the policy schema has no field that accepts one (provider secrets
are referenced by name, `secretRef: "TURNSTILE_SECRET"`, resolved from the
environment at the EP). The CP's database can be at-rest encrypted through
bun-cache's encryption where bun-cache is the store
(`bun-cache/lib/core/encrypt.ts`, built) [S].

---

## 9. The defence must not become the attack surface

| Risk | Bound (defaults) |
|---|---|
| unbounded keys in local limiters (key rotation, IPv6) | `maxKeys` 100,000 per limiter, LRU; /64 aggregation; eviction rate alert |
| unbounded keys in the store | every key has a TTL of at most its window plus a margin |
| active bans | `maxActiveBans` 100,000 per EP; past it, aggregate to /24 and /48 (layers.md L4) |
| event volume | ring 10,000 per EP; batch ≤ 500; `allow` sampled 0.1%; per-subject event cap (at most 10 events a minute per subject and rule; the rest only counted) |
| log flooding | the engine logs a rule's first hit per subject per minute and counts the rest; warnings rate-limited per message (bun-cache's 10 s pattern, `core/cache.ts:3474`) [S] |
| audit flooding | auto-ban summaries per minute, not per ban (§6.1) |
| ingestion endpoint | agent-authenticated before the body is read; per-agent rate limit; body ≤ 1 MiB |
| delays (tarpits) | `maxConcurrentDelays` 256, then `block` (layers.md §0.1) |
| challenge verification fan-out | provider calls only for a submitted token, per-IP limited; PoW verification is local |
| regex | the safe subset and input caps (layers.md L7) |
| policy size | rules ≤ 2,000, list entries ≤ 1 M per bundle, bundle ≤ 32 MiB |
| IP-intel lookups | lazy, LRU-cached 50,000 |
| alert storms | per channel ≤ 1 message a minute per alert rule, digests beyond (README §9) |
| self-ban of operators or health checks | the CP's own address ranges and the configured health checker are an implicit, locked allow list for the CP's routes; the UI warns before a ban covers an operator's current address |
| lockout of victims | no hard lock on failure counts (layers.md L11.4) |
