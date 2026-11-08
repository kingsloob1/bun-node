# bun-ui `/security`: the management UI and the analytics page

Sub-plan of [`README.md`](README.md). It covers the UI (bun-ui's `/security`
entry, [`bun-ui`](../bun-ui/README.md)), its screens
(policies per service and per group, lists, bans, rules, dry run, the
test-a-request tool, audit, agents), the analytics page's components, server
pagination on every list, and live updates. The data behind the analytics
(storage, rollups, retention, budgets) is in the README's §8. Marks are the
README's (§0.3). Paths marked [S] are at `36be4163`, from the survey of
bun-jobs-ui and bun-api-docs-ui.

**Changed on 2026-11-08**: the UI was planned as its own package,
`@kingsleyweb/bun-security-ui`; the user decided that every bun-node UI lives
in one package, so it is bun-ui's `/security` entry
([`bun-ui`](../bun-ui/README.md) §7 lists the edits). The screens, pagination,
live updates and tests below are unchanged.

### Contents

1. [The `/security` entry, and why it is not in bun-security](#1-the-security-entry-and-why-it-is-not-in-bun-security)
2. [Navigation and permissions](#2-navigation-and-permissions)
3. [Policies: services, groups, inheritance](#3-policies-services-groups-inheritance)
4. [Lists, bans, rules, dry run, test a request](#4-lists-bans-rules-dry-run-test-a-request)
5. [Pagination: one model for every list](#5-pagination-one-model-for-every-list)
6. [Live updates](#6-live-updates)
7. [The analytics page](#7-the-analytics-page)
8. [Audit, approvals, agents, alerts](#8-audit-approvals-agents-alerts)
9. [Tests](#9-tests)

---

## 1. The `/security` entry, and why it is not in bun-security

**The `/security` entry of `@kingsleyweb/bun-ui`** (with `/security/browser`),
on bun-ui's kit [D] (Q1; the user's decision of 2026-11-08):

- `lib/security/` — the server, Bun only, on bun-ui's kit: `securityUi({ api | apiUrl, basePath,
  authorize, middleware, dev, theme, title })` returns a bun-common router
  serving the HTML shell (nonce CSP, SRI, injected config) and hashed assets,
  as `jobsUi()` does (`bun-jobs-ui/lib/jobsUi.ts:679`; CSP at
  `bun-jobs-ui/lib/shell.ts:73-88`; SRI sha384 at `lib/assets.ts:132`) [S].
- `app/security/` — React 19 and TanStack Query on `app/kit/`, **bundled, not peers** (bun-jobs-ui
  bundles them, `package.json` devDependencies) [S], prebuilt into `dist/security/` on
  `prepack`, built in memory when `dist/security/` is missing in the repo.
- `lib/security/browser/` — the browser-safe config contract, published as `/security/browser`.

`@kingsleyweb/bun-security` is an optional peer of those two entries only
(bun-ui §4). Why the UI is in bun-ui rather than a `./ui` subpath of
bun-security:

1. **The engine runs on the critical servers; the UI must not.** The
   engine's package never depends on bun-ui, so the protected services do
   not install React, a 350 KB bundle, its build scripts or its test surface
   through it (bun-jobs-ui's entry budget is 348 KiB,
   `__tests__/server/budget.test.ts:38`) [S]. A service that serves no UI
   installs no UI code. A service that installs bun-ui for another UI (the
   `/docs` viewer) carries the security bundle as inert static files, which
   nothing mounts without `securityUi()` and its bun-security peer (bun-ui
   §11, R2). "Bad actors have no access to critical web servers" is easier
   to show when the code is not there.
2. **Dependencies.** The engine has no third-party runtime dependency;
   bun-ui's dev tree has React, TanStack, happy-dom, Testing Library.
3. **The pattern is proven here**: the same CSP, SRI, in-memory build,
   bundle-safety and budget tests carry over.

(The cadence argument made here before 2026-11-08 is dropped: every package
releases together at one version anyway, `CHANGELOG.md` line 3.)

The cost: a typed contract between bun-security and the entry (the
management API's OpenAPI document, which bun-client turns into types), the
same cost bun-jobs and bun-ui's `/jobs` pay.

**What it reuses** [S]:

| From | What |
|---|---|
| bun-ui's kit (`lib/kit/`) | the shell, CSP builder, asset pipeline, `dist/` manifest verification, `unauthorized`; once duplicated between bun-jobs-ui and bun-api-docs-ui, extracted by bun-ui's BU-4 (Q14) |
| bun-ui `app/kit/` and `app/jobs/` | `Pager` and `pagerState`, `Sparkline`, `RangePicker`, `useRange`, the theme tokens and dark mode, `MetaProvider`/`useCan`, `LiveClient`'s reconnect/resume logic, `onDemand` lazy screens, the toast and mutation hooks — from `app/kit/` (Q14), or moved there from `app/jobs/` when PR-U1 needs one not yet shared |
| bun-ui's `/docs/embed` | the management API's own reference, embedded as the jobs UI embeds it |
| bun-client | the typed calls (`createClient`, `./query`, `./react`, `./sse`, `./channel`) instead of a hand-written API client (bun-jobs-ui predates bun-client and hand-writes one, `app/api/client.ts`) [S] |

---

## 2. Navigation and permissions

Sections: **Overview** (the analytics page), **Services** (and groups),
**Policies**, **Rules**, **Lists**, **Bans**, **Events**, **Audit**,
**Approvals**, **Agents**, **Alerts**, **API reference**.

As in bun-jobs-ui, an element the operator may not use is **absent, not
disabled**, driven by `/meta/permissions` (`useCan`,
`bun-jobs-ui/app/meta/hooks.ts:86`) [S], with a scoped refinement per
service or group. Every screen has a scope picker (global, a group, a
service) in the URL, so a link shares exactly what the sender saw.
bun-ui's `guides/security.md` gets the same parsed "What each element needs" table
bun-jobs-ui has (`bun-jobs-ui/README.md:342-519`) [S], with an example that
checks it.

No login screen (bun-jobs-ui has none either): a 401 shows "Sign in
required" with the host's login URL from the config; step-up opens the
host's step-up URL in a popup and resumes the action when it returns.

---

## 3. Policies: services, groups, inheritance

- **Services list** (paginated): name, group(s), environment, topology,
  agent health (last seen, bundle version vs latest, signature key),
  requests/min, blocked %, mode summary (how many rules in dry run).
- **Groups tree**: nesting, member services, the policy at each node.
- **Policy editor** per scope, one tab per layer (layers.md L1–L14), each
  field showing its **effective value and origin** ("300/min — inherited
  from global", "locked by group *payments*") and an override control. Forms
  are generated from the policy's JSON Schema where they are simple, and
  hand-built for rules, limits, lists, profiles and the ladder.
- **Draft, diff, publish**: edits accumulate in a draft; the diff view shows
  the change against the published version **and** against the effective
  policy of each affected service; publishing shows the impact estimate
  (§4.4), asks for step-up and, when dangerous, opens an approval
  (control-plane.md §5.4).
- **Versions**: the history per scope (paginated), any two versions diffed,
  "roll back to this" (a new publish, control-plane.md §3.3).

---

## 4. Lists, bans, rules, dry run, test a request

### 4.1 Lists

Per scope and kind (IP/CIDR, user, API key, ASN, country): paginated,
searchable by value (a CIDR search finds entries containing the address),
filterable by action, source and expiry; bulk import (CSV, ≤ 10,000 rows per
import, validated before anything is written) and export.

### 4.2 Bans

- **Active bans**: paginated, sortable by created or expiry, filterable by
  subject kind, source (auto, manual, feed), rule, scope; each row: subject
  (with country/ASN), reason, rule, created, expires, hit count since. Live
  (§6): a new ban appears at the top with a highlight, without moving the
  operator's page (a "N new" chip, like a feed).
- **Ban detail**: the events that led to it (a link into the events list
  filtered by subject and time), the subject's history (previous bans, the
  ladder step), actions: extend, lift, convert to permanent (permission and
  step-up), widen to the /24.
- **Bulk lift** with a filter preview ("lift 1,204 bans from rule X created
  in the last hour") — dangerous, so step-up.
- **Manual ban** form: subject, scope, duration (expiry required, default
  24 h), reason; warns when the subject covers the operator's own address or
  a known service range.

### 4.3 Rules

The rule list per scope (id, origin, mode, action, hits in the last 24 h,
would-have-blocked in dry run); the rule editor with the matcher builder
(layers.md L7), the regex validator's verdict live as the operator types,
and the managed rule sets with their versions.

### 4.4 Dry run [D]

- Every rule shows its mode; switching `dryRun` → `enforce` is a policy
  change (draft → publish).
- The **impact estimate** for a draft: re-evaluate the draft's rules over
  the stored events and sampled requests of the last 24 h (the CP runs the
  same `compilePolicy` and engine over them) and show how many requests,
  subjects and routes it would have blocked, with examples. This works for
  stateless rules exactly and for rate limits approximately (it replays the
  sampled timeline); the UI says which.
- A "dry run for 24 h, then ask me" option schedules a reminder (an alert to
  the author) with the observed hits.

### 4.5 Test a request [D]

A form (or a pasted raw HTTP request, or a `curl` command line) with the
client address and the peer address (to test trusted-proxy handling), run
through the effective policy of a chosen service **without side effects**
(no counters incremented, no bans written; counters can be set to an
assumed state, "as if this IP had sent 299 requests this minute"). The
result: the decision, every rule that matched with the matched values, the
identity L2 resolved and why (which hop was trusted), the keys derived,
the IP-intel lookups, and the stage that answered. The same function backs
`POST /rules/test` and the package's `security.explain(request)` for tests.

---

## 5. Pagination: one model for every list

**Server-side, cursor-based, on every list** [D] (the user's requirement):

- Every list endpoint takes `limit` (default 50, max 200) and `cursor`
  (opaque, bound to the list's filter and sort, a 400 for one used with
  another filter), and answers `{ items, next, previous?, totalEstimate? }`.
  This is bun-jobs' keyset cursor (`bun-jobs/lib/drivers/pageCursor.ts`,
  `encodePageCursor` `:68`) [S], reused or copied.
- **Keyset, not offset**: the sort key plus a unique tiebreaker (`(createdAt,
  id)`), so a page is stable while new rows arrive (bans and events arrive
  during an attack at hundreds a second, and offset paging would skip and
  repeat rows).
- `totalEstimate` is shown as "about 12,400" where it is cheap (a rollup
  count or `pg_class.reltuples`-style estimate), never an exact `COUNT(*)`
  over a large table on each page.
- The UI keeps the cursor trail in the URL (unlike bun-jobs-ui's jobs table,
  which keeps it in component state, `screens/queues/jobWalk.ts`) [S], so
  back/forward and shared links work; page size in the URL too.
- **Live lists do not reshuffle the page**: new rows are counted in a chip
  ("37 new — show"), shown when the operator clicks or is on the first page
  with auto-follow on.
- Top-N widgets (top offenders, top rules) are not "lists" in this sense:
  they are bounded (N ≤ 100) and computed from rollups; their "see all" opens
  the paginated list.

---

## 6. Live updates

- **Transport**: the management API's typed channel (`defineChannel`,
  `bun-common/lib/channel.ts:354`) with an SSE fallback (`res.sse()`,
  `bun-common/lib/BunResponse.ts:3674`, resume through `lastEventId`) [S],
  consumed through bun-client's `./channel` and `./sse` (which already have
  reconnect, jittered backoff, heartbeat watchdog and resume) [S].
- **Topics**: `overview:<scope>` (per-second counters), `events:<scope>`
  (the activity feed), `bans:<scope>`, `policy:<scope>`, `agents`,
  `approvals`. Authorization per topic and scope at subscribe time and
  re-checked when a role binding changes (the connection is closed with a
  policy close code), as bun-jobs' hub re-authorizes broad channels per
  target (`bun-jobs/lib/api/ws/session.ts:861-925`) [S].
- **Rates and coalescing** [D]:
  - counters are **pushed once a second at most** per topic, as deltas
    (the server aggregates; the UI never receives one message per request);
  - the activity feed is **sampled server-side** to at most 20 events a
    second per subscriber (the rest counted: "+1,240 more in the last
    second"), with priority for `ban`, `challenge` failures and `critical`;
  - the UI coalesces query invalidations over 250 ms, as bun-jobs-ui does
    (`LIVE_INVALIDATION_DELAY_MS`, `app/live/live.ts:94`) [S];
  - backpressure: a subscriber whose buffer passes 1 MiB gets a `gap` and is
    told to refetch (bun-jobs' slow-consumer handling, `session.ts:54-60`) [S].
- **Resume**: every message carries `{ epoch, seq }`; a reconnect sends the
  last pair; the hub replays from a ring (1,000 messages, 5 min) or answers
  `gap`, after which the UI refetches the visible queries. Like bun-jobs'
  hub (`hub.ts:120`), **the ring is per CP instance** [S]; with an HA pair,
  a reconnect to the other instance gets a `gap` and refetches. A shared
  ring (Redis stream) is later, if the gap rate warrants it.
- **Safety polling** at a slow interval while live (bun-jobs-ui's
  `max(base × 6, 60 s)`) [S], so a silently dead socket cannot freeze the
  page.
- A status badge (live, reconnecting, refused) as in bun-jobs-ui.

---

## 7. The analytics page

One page per scope, with a time range picker (last 15 min, 1 h, 6 h, 24 h,
7 d, 30 d, custom; the bun-jobs-ui `range.ts` model) [S], auto-refresh live
for ranges ending "now", and each component a lazy chunk.

| Component | Shows | Data | Live |
|---|---|---|---|
| **Headline totals** | active bans, bans created in the range, refused requests and distinct refused addresses, pattern refusals, Tor refusals, challenges passed and failed (ConcaveHR's insights header, write-up §6) | rollups | yes |
| **Traffic over time** | requests, allowed, blocked, challenged, delayed, dry-run would-block, stacked | rollups at the range's resolution (README §8.3) | per-second deltas appended |
| **Outcome mix** | the share per action, and per status class | rollups | yes |
| **Top offenders** | top-N subjects (IP or /64, user, API key, ASN, country) by blocks or score, with sparkline, country/ASN, current ban state, a "ban"/"allow" action | top-K rollups (README §8.3) | refreshed every 5 s |
| **Per-rule hits** | each rule's hits, blocks, dry-run would-blocks, false-positive reports; sortable; trend | rollups by rule | yes |
| **Per service / per route** | requests and blocks by service, then by route (drill-down), p95 decision latency | rollups by service and route | yes |
| **Geography and ASN** | a choropleth or a ranked table (a table first: no map dependency; Q15) of requests and blocks by country; a table by ASN with its class (hosting, Tor) | rollups by country and ASN; attribution line per the data's licence (layers.md L5) | 5 s |
| **Ban timeline** | bans created and lifted over time, by source and rule; currently active count | ban log | yes |
| **Activity feed** | the latest decisions: time, subject, service, route, rule, action, a short reason; click → event detail | events, sampled live (§6) | yes, paused on hover/scroll |
| **Credential-stuffing panel** | login failure ratio vs baseline, distinct usernames per IP, success-after-failures | rollups of the login profile | yes |
| **Agent health** | per service: last seen, bundle version, event drops, store errors, fallback mode in use | heartbeats | yes |
| **Events list** | every stored event and refused-request sample, **paginated (§5)**, filters (time, service, route, subject, rule, action, pattern, country, ASN, dry run), a detail drawer with the redacted request (headers, query, JSON body, the answer sent) — the view ConcaveHR found answered "is this a false positive?" quickly (§8) | the events store | "N new" chip |
| **Identifier patterns** | per pattern: hits, last hit, the addresses it tripped | rollups by pattern | 5 s |
| **IP-intel sources** | each feed's size, last refresh, last failure (the Tor list's minimum-size guard) | heartbeats of the refresh job | on change |

**Charts** are hand-rolled SVG, as in bun-jobs-ui (no chart library: the
`Sparkline` and the throughput bars are SVG, `app/components/Sparkline.tsx`)
[S]; the new ones (stacked area, horizontal bars, a heat strip for the ban
timeline) follow the same CSP rule (no inline styles, `style-src 'self'`,
`shell.ts:68-72`) [S] and the WCAG contrast test on the tokens.

**Every list on the page is paginated or bounded**: the feed is a bounded
live window (the last 200, with "open the events list" for more), top-N is
bounded, and everything else uses §5.

---

## 8. Audit, approvals, agents, alerts

- **Audit**: the paginated log, filters (actor, action, scope, time), each
  entry's before/after diff, the chain verification status and the last
  external checkpoint (control-plane.md §6.2), export (step-up).
- **Approvals**: pending changes with their diff, impact estimate, author
  and expiry; approve or reject (not by the author).
- **Agents**: per service, the keys (created, last used, revoke), health,
  bundle version, key rotation flow (create new → deploy → revoke old),
  and the bundle signing key each agent last verified.
- **Alerts**: channels (webhook, email, Slack-compatible webhook), rules
  (README §9), a "send a test" button, the delivery log (paginated).

---

## 9. Tests

The bun-jobs-ui rules (CLAUDE.md, "bun-jobs-ui") apply unchanged. The harness
is bun-ui's (`__tests__/harness/`): one `domLeak` guard over every UI's
tests, `setupDom({ preload })` with the security UI's lazy screens.

- `setupDom()` at the top of every DOM test file; no static `react-dom` or
  `@testing-library/react` import; a `domLeak.test.ts` guard;
- an `unmountLeaks.test.tsx` case per live screen over a handle ledger
  (its start, Phase A, Phase B), with a negative control per kind;
- `bun test --randomize` with two seeds in the gate;
- a bundle-safety test (no `node:`, `bun:`, `Bun.serve`, `BunRouter`,
  engine or store code in the bundle) with a negative control;
- a budget test (`BUNDLE_BUDGET`, set from the first build and raised only
  deliberately);
- e2e in Chrome through `Bun.WebView` against a real `createSecurityApi`
  with a simulated attack feeding it (README §11.5), skipping visibly
  without Chrome: publish a policy, watch a ban appear live, lift it, page
  through the events list while events arrive (no duplicates or gaps across
  pages), no CSP violations;
- the parsed "What each element needs" table, checked by an example.
