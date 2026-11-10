# bun-security: the defence layers, in request order

Sub-plan of [`README.md`](README.md). It specifies each layer the engine runs:
what it looks at, its defaults, the action it takes on a hit, how it
escalates and expires, and whether it is in v1. The README's §4 says how the
engine runs them (stages, decisions, keys); [`topologies.md`](topologies.md)
says where their state lives; [`control-plane.md`](control-plane.md) says how
a policy reaches them.

Every default below is a **[D]** proposal, and every number is a starting
point to be tuned per service in the UI, not a measured value. Marks are the
README's (§0.3).

### Contents

0. [Actions, escalation and expiry (shared by every layer)](#0-actions-escalation-and-expiry)
1. [L1 Connection and server limits](#l1-connection-and-server-limits)
2. [L2 Client identity and trusted proxies](#l2-client-identity-and-trusted-proxies)
3. [L3 Allow and deny lists](#l3-allow-and-deny-lists), with [verified crawlers (L3.2)](#l32-verified-crawlers-let-search-engines-index-the-site-d-v)
4. [L4 Bans](#l4-bans)
5. [L5 IP intelligence: country, ASN, hosting, Tor](#l5-ip-intelligence-country-asn-hosting-tor)
6. [L6 Request shape: method, path, headers, size](#l6-request-shape-method-path-headers-size)
7. [L7 Request rules (the WAF-style subset)](#l7-request-rules-the-waf-style-subset)
8. [L8 Deception: honeypot routes, trap fields, canary tokens](#l8-deception-honeypot-routes-trap-fields-canary-tokens)
9. [L9 Rate limits](#l9-rate-limits)
10. [L10 Bot and automation signals, and challenges](#l10-bot-and-automation-signals-and-challenges)
11. [L11 Sensitive endpoints: login, OTP, signup, reset, payment](#l11-sensitive-endpoints-login-otp-signup-reset-payment)
12. [L12 API keys](#l12-api-keys)
13. [L13 Response-side controls: headers, CSRF, leakage](#l13-response-side-controls-headers-csrf-leakage)
14. [L14 Outcome signals (after the response)](#l14-outcome-signals-after-the-response)
15. [What is v1 and what is later](#15-what-is-v1-and-what-is-later)

---

## 0. Actions, escalation and expiry

### 0.1 The actions [D]

A rule's hit produces one **action**. When several rules hit, the engine
applies the most severe (the order below), records every hit, and stops
evaluating later stages once the request is answered.

| Action | What the client sees | What is recorded | Notes |
|---|---|---|---|
| `allow` | nothing | a counter only (allows are sampled into events, README §8.2) | an allow-list hit ends evaluation of every later *blocking* layer, but rate limits marked `evenWhenAllowed` still count |
| `log` | nothing | an event with the rule and its reason | the action every rule takes in **dry run** (§0.4) |
| `tag` | nothing; the request carries `req.security.tags` | an event | lets the app decide (e.g. ask for 2FA on a "risky" login) |
| `delay` | the answer, `delayMs` later | an event | bounded: at most `maxDelayMs` (default 2,000 ms) and at most `maxConcurrentDelays` (default 256) per process; past that cap a `delay` becomes `block`, so tarpitting cannot exhaust the server |
| `challenge` | a challenge response (L10.2): an HTML interstitial for a page request, `401`/`403` problem+json with a challenge descriptor for an API request | an event | needs a challenge provider; without one, falls back to the rule's `challengeFallback` (default `block`) |
| `block` | `403`, or `429` for a rate limit, problem+json, `Retry-After` when known | an event | the body never says which rule hit (`code` only, configurable) |
| `ban` | `403` (or a configured status), and every later request from the subject is blocked at L4 until the ban expires | an event and a ban record | escalates (§0.2) |
| `drop` | the connection is closed with no response | an event | only before routing (L1–L4); for a known-hostile subject, so it costs the attacker a timeout. Not the default anywhere |

Severity order: `drop` > `ban` > `block` > `challenge` > `delay` > `tag` >
`log` > `allow`.

### 0.2 Counted rules and escalation [D]

**Counted rules** are the first form, because operators read them at a
glance and ConcaveHR ran on them (write-up §2.3): "N occurrences of *event*
within W seconds for one *key* → *action* for B seconds", e.g.
`failed_password: 10 / 15 min per ip → ban 1 h`. A counted rule has a
platform default and per-group and per-service overrides (ConcaveHR's
`(key, service)` rows), an `enabled` switch, and a `mode`. The events it can
count are the engine's outcomes and signals: `auth.failure`,
`mfa.failure`, `signup`, `password.reset`, `request` (every request that
passed the lists), `route.notFound` (no route matched, L14), `pattern.hit`
(L11.7), `throttled` (a 429 from the throttle foundation), any app signal.
`B` may be `null` ("until removed"). When the count reaches the threshold
the counter is cleared and the action applied (ConcaveHR deletes the counter
on a trip, so one burst gives one ban).

Each rule can also feed an **offence score** for its subject (an IP, a /64, a
user, an API key, a device). An offence has a weight (default 1; a honeypot
hit 10; a canary token 100). The score decays exponentially with a half-life
(default 1 h). A **ladder** maps the score to an action:

```
score ≥ 3   → challenge for 15 min
score ≥ 10  → ban 1 h
second ban within 24 h → ban 6 h
third ban within 7 d   → ban 7 d
```

Ban durations escalate geometrically per subject (`base × factor^(n-1)`, base
1 h, factor 6, capped at `maxBan` 30 d), with `n` the number of bans in the
`memory` window (7 d). Manual bans have their own duration and do not count
toward the ladder unless marked so. A ladder is part of the policy, editable
per service.

Why a score as well as counted rules: a credential-stuffing run spread
thinly across rules (a few 401s, a probe of `/.env`, a burst on signup) never
trips one rule's threshold. A shared, decaying score sees it, across routes
and services in the scope. And ConcaveHR's fixed `blockSeconds` meant a
repeat offender got the same block each time; its write-up asks for
escalation (§8). A counted rule's action can be `{ ban: "ladder" }` to use
the escalating durations instead of a fixed `B`.

### 0.3 Expiry [D]

Everything expires: bans (`expiresAt`), challenges' clearances (cookie TTL),
offence scores (decay), counters (their window), list entries (optional
`expiresAt`, required for entries added from the analytics page's "ban this"
button, default 24 h). A permanent entry must be made deliberately (an
operator with the `bans:permanent` permission, control-plane.md §5.2). Expiry runs
lazily at read time and is swept by a scheduled job (README §8.3) so the
store does not grow.

### 0.4 Dry run [D]

Every rule and every policy has a `mode`: `enforce`, `dryRun` (the rule is
evaluated and its would-be action is recorded as `log` with
`wouldHaveBeen: "<action>"`) or `off`. A new rule defaults to `dryRun` in the
UI (README §7). The analytics page filters by `wouldHaveBeen`, so an operator
sees what a rule would block before enforcing it.

---

## L1 Connection and server limits

**Stage:** before the handler (`Bun.serve` options) and the very first thing
in the handler.

Bun already enforces several limits below the handler, measured on 1.4.4
([`evidence/request-shape/`](evidence/README.md)) [M]:

- a header block over Bun's limit gets **431** and never reaches the
  handler (20 KB and 100 KB headers; Bun's default limit is 16 KiB,
  `--max-http-header-size`) [M, V];
- `Content-Length` together with `Transfer-Encoding` gets **400** (a
  request-smuggling guard) [M];
- a request without `Host` gets **400** [M];
- an unknown method (`FOO`) or a lower-case one (`get`) is closed with no
  response [M];
- `idleTimeout` is capped at 255 s; 256 is a `TypeError` [M].

And one it does not: **two `Host` header lines are accepted**, joined as
`"a, b"`, with `req.url` built from the first [M]. RFC 9112 §3.2 requires a
400 [V]. This is a Bun bug (a minimal reproduction is in
[`evidence/request-shape/repro-duplicate-host.ts`](evidence/request-shape/repro-duplicate-host.ts);
upstream [oven-sh/bun#44232](https://github.com/oven-sh/bun/issues/44232)); L6 refuses such a request until Bun does.

What bun-security adds [D]:

| Limit | Default | Where |
|---|---|---|
| `idleTimeout` (slowloris: a client that opens and trickles) | 10 s (Bun's default is 10 s; the hardening helper states it explicitly) | `Bun.serve` option, set by `hardenServe()` (README §3.4) |
| `maxRequestBodySize` | 1 MiB globally, raised per route | `Bun.serve` option, plus L6's per-route limit read from `Content-Length` before the body is read |
| per-request body read deadline | 30 s (`server.timeout(req, s)` exists, [M]) | L6, for routes that read bodies |
| concurrent requests per IP | 64 in flight | an engine counter incremented on entry and decremented on `whenResponded` (local per process) |
| concurrent WebSocket connections per IP | 16 | the upgrade path |
| global in-flight cap (load shedding) | off; when set, beyond it a request gets `503` with `Retry-After` | first check in the handler |

Bun exposes no TLS ClientHello (no JA3/JA4) and no TCP-level hooks to a
`fetch` handler [S, `Bun.serve` API]; connection fingerprints must come from a
fronting proxy through a trusted header (L10).

**v1:** `hardenServe()`, per-route body limit, concurrency per IP, global
in-flight cap. The duplicate-`Host` refusal in L6.

---

## L2 Client identity and trusted proxies

**Stage:** before everything that keys on a client. This is where most
home-grown rate limiters are broken, so it is specified in full.

### L2.1 The peer address [M]

`server.requestIP(req)` returns `{ address, family, port }` for TCP and
`null` on a Unix socket [M, `evidence/client-ip/`]. **A default `Bun.serve`
listener reports an IPv4 client as `::ffff:127.0.0.1`, family `IPv6`**, as
does an explicit `"::"` listener; only an IPv4 listener reports `127.0.0.1`
[M, `results-dualstack.txt`]. A rule `127.0.0.0/8` or `203.0.113.0/24`
therefore misses every IPv4 client on a default listener unless the address
is normalised. Every address must be normalised once: IPv4-mapped IPv6
(`::ffff:a.b.c.d`) becomes `a.b.c.d`; IPv6 is parsed to its 16 bytes (zone
ids dropped), so `2001:DB8::1` and `2001:db8:0:0::1` are one key. This
belongs in the trust-proxy foundation's `req.ip` (L2.2, item 4); the engine
normalises again defensively for addresses it receives from elsewhere (an
event, a service's forwarded header, an operator's form).

### L2.2 Forwarded headers: the trust-proxy foundation [F] [M] [V]

Bun passes `X-Forwarded-For`, `Forwarded` and `X-Real-IP` through untouched,
and two `X-Forwarded-For` lines reach the handler joined with `", "` [M].
Any client can send them. MDN's guidance [V]: a security use "_must only_
use IP addresses added by a trusted proxy", searching from the right; "if
the server can be directly connected to from the internet — even if it is
also behind a trusted reverse proxy — no part of the X-Forwarded-For IP list
can be considered trustworthy".

**bun-security does not resolve the client itself.** The trust-proxy
foundation (branch `feat/trust-proxy-client-ip`, being built beside this
plan) gives both HTTP adapters a `trustProxy` option with Express's exact
`trust proxy` semantics: `req.ip` is the client the trusted chain vouches
for, `req.ips`, `req.protocol` and `req.hostname` follow trust, platform
presets (Cloudflare's `CF-Connecting-IP` with its edge ranges, Railway, Fly
and others) are honoured only through a trusted chain, and WebSocket
upgrades get the same [F]. The engine reads `req.ip`. What it requires of
the foundation, and asks the building agent to confirm (README §20):

1. **Off by default**: no `trustProxy`, the client is the peer address.
2. **The walk starts at the peer and moves left only while the current hop
   is trusted**; the first untrusted address is the client. "Left-most
   untrusted" must not be read as the left-most entry of the header: with
   `trustProxy: ["10.0.0.0/8"]`, a peer `10.0.0.1` and
   `X-Forwarded-For: <spoof>, 203.0.113.5`, the client is `203.0.113.5`.
   Only `trustProxy: true` (trust every hop, Express's documented foot-gun)
   reaches the left-most entry.
3. **Hop count** as well as CIDR lists and a function. ConcaveHR keys on the
   entry a fixed number of hops from the right (`TRUSTED_PROXY_HOPS = 2` on
   Railway, whose edge rewrites the header to `[client, edge]` with a
   rotating edge address); keying on the right-most entry spread one client
   over several keys (write-up §5, §8).
4. **Normalised addresses** (L2.1): `::ffff:a.b.c.d` → `a.b.c.d`, so a
   default listener's IPv4 clients match IPv4 rules [M].
5. **The resolution is inspectable**: which hops were seen, which trusted,
   which preset applied, so an event and the UI's test-a-request tool can
   say *why* this address is the client.
6. **Exported IP and CIDR utilities** (parse, normalise, contains, a CIDR
   set), so bun-security does not carry a second copy.
7. Malformed entries end the walk (the last good address is the client) and
   a header over 32 hops is truncated from the left; both observable.

The peer must be trusted before any header is read. That one check is the
whole defence against spoofing, and has its own test (README §11.2,
T-L2-1), run against the foundation's `req.ip`.

### L2.3 Keys [D]

The engine derives keys from the identity once per request:

| Key | Default form | Why |
|---|---|---|
| `ip` | the normalised address; **IPv6 truncated to its /64** for rate limits and bans (configurable `/48`–`/128`) | one IPv6 subscriber usually holds a whole /64; per-address keys let one attacker rotate through 2^64 keys [V, common practice; RFC 6177 assigns /48–/64 to end sites] |
| `user` | the app's user id, from `identify(req)` (a hook; README §4.2) | per-account limits |
| `username` | the **attempted** login identifier, keyed as `HMAC(secret, lower(trim(username)))` | counts failures for accounts that may not exist, without storing the identifiers |
| `apiKey` | a key id or `HMAC(secret, key)`, never the key | L12 |
| `device` | the id inside a signed device cookie (L11.4) | lockouts that spare the owner |
| `session` | from `identify(req)` | |
| `tenant` | from `identify(req)` | per-tenant quotas |
| `asn`, `country` | L5 | aggregate limits |
| `route` | the matched route key (`"POST /login"`), or the normalised path before routing | per-route limits |
| `fingerprint` | a hash of trusted proxy-supplied fingerprints (JA4, H2) when present (L10) | |

Keys are bounded strings; the engine refuses a key over 256 bytes (it hashes
it), so a hostile header cannot blow up the store.

### L2.4 Service identity [D]

ConcaveHR's worst false positive blocked its own pay-api: the actor signed in
through pay-api's sign-in proxy, the email-pattern rule counted the proxy's
egress address, and every pay-api call to its sibling APIs got 403 for about
40 minutes (write-up §6). Its lesson (§8): "service identity must be a
first-class concept, never 'an IP like any other'". So:

- A **service identity** is a named credential per calling service (an HMAC
  token or a signed request with the PR-P4 envelope), verified in constant
  time by `identify()`'s built-in step, never inferred from an address.
- A verified service call is **exempt from lists, bans, counted rules and
  the global limits** by default. Limits marked `appliesToServices` (the
  strict sign-in, code and password limits, which ConcaveHR still applies
  because a proxy forwards end users' attempts) still apply, keyed on the
  forwarded end user.
- **A forwarded end-user address** (ConcaveHR's `x-concave-client-ip`) is
  read **only** with a valid service identity and only if it parses as an
  IP; it then becomes the request's client for every key. A service call
  forwarding no address counts against **nobody**, so a sibling's egress
  address can never be counted or banned.
- Service identities live in the security store (storage.md §1), their
  verifiers in the bundle (hashes or public keys only), and the UI lists
  them with their last use.

### L2.5 Detecting a wrong trust configuration [D]

A wrong `trustProxy` fails silently in one of two ways: every client
collapses to the proxy's address (one key for everyone, so limits trip for
all), or every client resolves to an internal or always-allowed range (so
nothing is ever counted). ConcaveHR hit the first kind (the rotating edge
entry, §8). The engine keeps per-minute gauges of **distinct resolved clients
vs distinct peers** and **the share of requests resolving to an
always-allowed range** (L3.1), and raises a warning event and alert when
the share passes 50% for 5 minutes on a service whose policy says it is
public. The UI shows the trust configuration and the last resolutions on the
service page.

**v1:** all of L2.

---

## L3 Allow and deny lists

**Stage:** pre-routing, after L2.

Entries: an IP, a CIDR (v4 and v6), an ASN, a country, a user id, an API key
id, a user-agent *exact* string, a fingerprint. Each entry has `action`
(`allow`, `block`, `challenge`, `drop`), `reason`, `createdBy`, optional
`expiresAt`, and a scope (global, a service group, a service, a route
prefix).

- Matching: CIDRs in a binary radix trie per family (lookup O(32) or O(128)
  bit steps, independent of the number of entries) [D]; ASNs and countries in
  sets, after L5.
- Allow-list semantics: an allow entry skips L4–L10's blocking actions but
  not the rate limits marked `evenWhenAllowed` (an allowed partner still
  cannot send 10,000 req/s), and never the response-side controls. Allow
  entries can be scoped to a route prefix (the internal health checker may
  bypass everything on `/healthz` and nothing else).
- Size bounds: lists are compiled into the policy bundle; the compiler
  refuses a bundle over `maxListEntries` (default 1 M CIDRs) and the UI shows
  the bound. Larger feeds (L5) are IP-intel sources, not lists.
- Precedence: a more specific scope wins (route > service > group >
  global); within a scope, `allow` beats `block` only if marked `override`,
  otherwise the most severe wins. The UI's "test a request" tool shows which
  entry decided (ui.md §4.5).

### L3.1 Built-in never-block ranges, and allow-list guards [D]

ConcaveHR always allows loopback, RFC 1918, carrier-grade NAT
`100.64.0.0/10` (Railway's private network and edge hops), link-local, IPv6
ULA and IPv6 link-local: a request from those ranges is internal or has lost
its client address, and blocking it could refuse everyone behind it
(write-up §2.0). bun-security ships the same set as a **named, locked-by-default
list** `internal` with action `allow` (bans and counted rules skip it; rate
limits still apply), which an operator can narrow per service. Because it
also hides a broken trust configuration (L2.5), the engine alerts when
public traffic resolves into it.

Two guards from ConcaveHR, kept: **an allow entry wider than /8 (IPv4) or
/32 (IPv6) is refused** (a typo must not allow the internet), and **adding
an allow entry lifts every active ban it covers** (and the UI says how many
it lifted).

**v1:** IP and CIDR lists, user and API-key lists, scopes, the `internal`
list and the guards. ASN/country entries arrive with L5.

### L3.2 Verified crawlers: let search engines index the site [D] [V]

*Added 2026-11-10 at the user's request, so that the defence never stops a
search engine from building its index of a service.*

**Why the defaults would block a crawler.** A search engine's crawler
behaves, at the edge, like the scanners these layers exist to stop. It walks
every link it has ever seen, so it meets many dead URLs. It comes from a
cloud provider's address space. It sends none of a browser's `Sec-Fetch-*`
headers, and it cannot solve a challenge. Here is what that triggers, by default:

| Layer | What a crawl trips | Effect on the index |
|---|---|---|
| L14 | `not_found_per_minute` (120 in 60 s → ban 1 day) on old links | Googlebot is banned for a day |
| L7 | the managed probe set, on a link someone published to `/wp-admin` or `/.git/` | an offence weight, then the ladder |
| L8 | a honeypot path that some external page links to | weight 10, a ban on the first hit |
| L5, L10 | the hosting class, and no `Sec-Fetch-*` on a browser route | a challenge, so the challenge page is what gets indexed |
| L9 | the per-IP global limit, if one crawler address is busy | 429s; Google drops a URL that answers 429, 500 or 503 "for multiple days" [V] |
| L3 | a country or ASN block (geo-fencing), which covers the crawler's addresses | the site disappears from that engine |

So the policy gets a **crawler allowance**: a third kind of allow, beside
plain allow entries and the `internal` list. It differs from an allow entry in
two ways:

- **it is earned by verification, never by a header**: a `User-Agent` that
  says Googlebot proves nothing, and anyone can send it;
- **it lifts only the named layers**, on named paths, for `GET` and `HEAD`.

**Verification** [V]. A request is a *claimant* when its `User-Agent`
contains a token from the crawler registry (below). It is *verified* only
when its client address (L2's, after the trust-proxy foundation) passes the
operator's method for that crawler:

- **`ranges`**: the address is inside the operator's published IP-range file.
  Google publishes JSON files for its common crawlers, its special-case crawlers
  and its user-triggered fetchers. Bing publishes `bingbot.json`, Apple
  publishes `applebot.json`. The files are fetched by L5's refresh job, daily.
  Each file must hold at least a minimum entry count, so a truncated download
  never empties the set. The last good copy is kept on a failure, and the files
  are distributed to agents as artefacts. They load into the L3 CIDR trie,
  each range tagged with its crawler id. The lookup is synchronous and costs
  what an L3 lookup costs.
- **`rdns`**: a reverse DNS lookup of the address must give a host name under
  the crawler's domains. Examples: `googlebot.com` and `google.com` for Google,
  `search.msn.com` for Bing, `applebot.apple.com` for Apple. A forward lookup
  of that name must then return the same address. Google, Bing and Apple all
  document the forward confirmation. Without it, an attacker who controls the
  PTR record of their own address can name it `crawl-….googlebot.com`.
- **`ranges-then-rdns`** (the default): `ranges` first, and `rdns` only when
  the address is not in the ranges, or the crawler publishes none.

DNS is kept off the hot path, and it cannot be used for a flood:

- verdicts are cached per address, positive for 24 h and negative for 1 h, in
  an LRU of at most 50,000 entries;
- in `hybrid` and `shared` state the verdicts are written to the shared store,
  so a fleet resolves each address once;
- at most `maxPendingVerifications` lookups run at once per process (default
  64);
- a claimant whose lookup is pending is held for at most `verifyTimeoutMs`
  (default 500 ms). On a timeout, an error or a full queue, it is treated as
  **unverified for this request** and is not cached, so a slow resolver costs
  an allowance but never grants one;
- the resolver is a hook (`resolver: { reverse, lookup }`), so tests and
  operators can supply their own. It is trusted, like the host's own resolver.
  Whether Bun's `node:dns` `reverse` is complete enough to be the default is
  for PR-S12 to measure [U].

**The registry** [D]. The package ships the *methods*, not the address data.
No range file is bundled, which is consistent with L5's rule that no data
ships through npm:

| Id | `User-Agent` tokens (the full list is in the package, read from each engine's documentation in PR-S12) | Range file | Reverse-DNS domains | In the default set |
|---|---|---|---|---|
| `google` | `Googlebot`, `Googlebot-Image`, `Googlebot-News`, `Googlebot-Video`, `Storebot-Google`, `Google-InspectionTool`, `GoogleOther` | `developers.google.com/static/crawling/ipranges/common-crawlers.json` [V] | `googlebot.com`, `google.com` [V] | yes |
| `google-special` | `AdsBot-Google`, `Mediapartners-Google` and the other special-case crawlers [U] | `…/special-crawlers.json` [V] | `google.com` (`rate-limited-proxy-…`) [V] | no |
| `bing` | `bingbot`, `adidxbot` [U] | `www.bing.com/toolbox/bingbot.json` [V] | `search.msn.com` [V] | yes |
| `apple` | `Applebot` | `search.developer.apple.com/applebot.json` [V] | `applebot.apple.com` [V] | yes |
| `duckduckgo` | `DuckDuckBot` | DuckDuckGo's published address list [U: not found in this survey; PR-S12 reads DuckDuckGo's help pages] | none documented [U] | yes, once a source is confirmed |
| `yandex` | `YandexBot` | none [U] | `yandex.ru`, `yandex.net`, `yandex.com` [U] | no |
| `baidu` | `Baiduspider` | none [U] | `baidu.com`, `baidu.jp` [U] | no |
| *(operator-defined)* | any | a URL, or a file the operator provides | any | — |

A verification method that comes from prior knowledge, marked [U], is read
from the engine's own page before it goes into the registry. An entry whose
method cannot be confirmed ships disabled.

Two groups are deliberately **not** in the default set:

- **Google's user-triggered fetchers.** Anyone can make Google fetch a URL
  through them, so they are not autonomous indexers.
- **AI and LLM crawlers** (`GPTBot`, `ClaudeBot`, `PerplexityBot`, `CCBot`
  and others). They do not build a search index, and letting them in is a
  content decision for the operator, not a default (Q30, decided 2026-11-10). The registry can
  carry them, with whatever verification their operators publish, for an
  operator who opts in.

**The policy option** [D], per scope (global, group, service, route prefix),
inherited like the rest of the policy:

```jsonc
"crawlers": {
  "mode": "enforce",                        // enforce | dryRun | off
  "allow": ["google", "bing", "apple", "duckduckgo"],   // registry ids
  "verify": "ranges-then-rdns",             // ranges | rdns | ranges-then-rdns
  "methods": ["GET", "HEAD"],               // only these; never widened past GET/HEAD/OPTIONS
  "paths": { "include": ["/**"], "exclude": ["/api/**", "/admin/**"] },
  "exempt": ["notFound", "probeRules", "honeypots", "botSignals",
             "challenges", "hostingClass", "geo", "perIpLimits", "autoBans"],
  "limit": "3000/1m",                       // per crawler id, across its addresses
  "spoofed": { "action": "block", "weight": 5 },
  "custom": [ { "id": "acme-search", "tokens": ["AcmeBot"],
                "ranges": "https://acme.example/bot-ranges.json",
                "rdns": ["crawl.acme.example"] } ]
}
```

What each exemption lifts, for a **verified** crawler, on a path and method
the allowance covers:

| Exemption | Effect |
|---|---|
| `notFound` | L14's route-not-found answers are not counted against it |
| `probeRules` | L7's managed probe set does not act. Its hits are logged as `crawler.probe`, which shows the operator that a link to the path exists. Operator-written L7 rules still apply unless a rule sets `crawlers: "skip"` |
| `honeypots` | L8's honeypot routes answer as usual, with no score or ban, logged as `crawler.honeypot`. A verified crawler obeys `robots.txt`, so a hit usually means an outside link to the path, or a `Disallow` the crawler has not re-read yet (they cache `robots.txt`) |
| `botSignals`, `challenges` | L10 adds no signals and never challenges it. A challenge page served to a crawler is what gets indexed |
| `hostingClass` | L5's `hosting` class is not counted against it |
| `geo` | L3 country and ASN *block* entries do not apply. IP and CIDR entries an operator wrote still do (see the conflict check below) |
| `perIpLimits` | the per-IP limits are replaced by the crawler's own `limit`, keyed `crawler:<id>`, because one engine crawls from many addresses. The limit is `evenWhenAllowed`. A crawler over it gets `429` with `Retry-After`, which Google reads as "slow down" [V]. An alert fires when a crawler has been limited on more than a day's worth of windows, because a URL that keeps answering 429 is dropped from Google's index [V] |
| `autoBans` | the ladder never bans a verified crawler. An earlier auto-ban covering its address, written before verification, is skipped and flagged in the UI. **Manual bans still apply**: an operator who bans a crawler means it |

What a crawler is **never** exempt from:

- L6's shape refusals;
- L11's sensitive endpoints, since a crawler has no business posting to a
  sign-in form;
- L12's API keys;
- canary credentials and keys (L8);
- L13's response-side controls;
- the `evenWhenAllowed` limits;
- every method other than `GET` and `HEAD`;
- any path outside `paths`.

A verified Googlebot that sends a `POST` is evaluated like anyone else.

**Spoofed claimants** [D]. A claimant that fails verification is a strong
L10 signal, `crawler.spoofed`. Scrapers borrow Googlebot's name precisely to
get through allowances like this one. By default the request is blocked and
the subject's offence score gains weight 5 (Q31, decided 2026-11-10). An SEO audit tool that the
operator's own staff run with a Googlebot user agent should be given a plain
allow entry for its address, not a looser crawler check. The analytics page
counts spoofed claimants per claimed crawler.

**The conflict check** [D]. The policy compiler warns when a block entry, a
ban, or a country or ASN entry would cover an allowed crawler's published
ranges, for example a block on Google's ASN, or a country block covering the
addresses Googlebot crawls from. The UI shows the warning before publish, with
the crawler and the entry that covers it. Publishing anyway is allowed and is
recorded in the audit log.

**Dry run** [D]. In `dryRun` the allowance is evaluated and recorded, as
`wouldHaveBeen: "allow"` on the decision a verified crawler would have
skipped, but nothing is lifted. So an operator can see which crawler requests
the current policy would have refused before switching it on, and the
analytics page shows the would-be-refused crawler requests, per crawler.

**Events.** Every decision on a claimant records `crawler: "<id>"`,
`verified` and `verifiedBy` (`ranges`, `rdns` or `cache`). Verified crawler
traffic is its own series on the analytics page (requests, 404s, 429s per
crawler), and never mixed with the refused counts.

**Default** [D]: on, in `enforce`, for `google`, `bing` and `apple`, with
`duckduckgo` added once its source is confirmed, on every path for `GET` and
`HEAD` (Q29, the user's decision of 2026-11-10). For an API-only service this costs nothing: a verified crawler
can already `GET` a public endpoint. A service that wants no crawling at all
sets `"crawlers": { "mode": "off" }`, or better, says so in `robots.txt`,
because an allowance never makes a crawler crawl.

**Later:**

- a `robotsTxt()` helper that writes `Disallow` lines for the honeypot paths
  and the allowance's `paths.exclude`, so `robots.txt` and the policy never
  disagree;
- signed agents (HTTP message signatures carried by the crawler, the
  web-bot-auth proposals) [U: cited from prior knowledge] as a third
  verification method, once an engine sends them.

**v1:** the registry with the default set, `ranges` and `rdns`
verification, the cache and its bounds, the policy option with every
exemption, the per-crawler limit, the spoofed signal, the conflict check,
dry run, and the events.

---

## L4 Bans

**Stage:** pre-routing, right after L3. A ban is a list entry with an expiry
and a history; it is separate from L3 because it is written at run time by
the engine and by operators, at high rate during an attack, and must reach
every enforcement point fast.

- **Subjects:** `ip` (with its prefix length), `cidr`, `user`, `apiKey`,
  `device`, `fingerprint`, `asn` (manual only).
- **Record:** `{ id, subject, scope, reason, ruleId?, source: "auto" |
  "manual" | "feed", createdAt, expiresAt, createdBy?, count }`.
- **Auto-ban** comes from the ladder (§0.2). **Manual ban** from the UI or
  the API (permission `bans:write`; a ban wider than a /16 or an ASN needs
  step-up and, when two-person approval is on, a second operator,
  control-plane.md §5.4).
- **Lookup is always local** [D]: each enforcement point holds the active
  bans of its scope in memory (an exact-key map plus the CIDR trie), filled at
  start from the store and updated by the ban stream (topologies.md §3).
  A request never waits on the store to learn whether it is banned.
- **Propagation target:** a ban written on one node is enforced on every
  node of its scope within 1 s on a healthy bus (a target; unmeasured).
- **Merging** (ConcaveHR's rules, write-up §2.3): a new ban on a subject
  with an active ban extends it — the later expiry wins, "until removed"
  beats any date — and a manual ban replaces an automatic reason.
- **Unban** marks the record lifted (`liftedAt`, `liftedBy`) and keeps it as
  history; the active copies are removed everywhere. Unban of an auto ban
  resets the subject's score.
- **Reconcile**: besides the ban stream, every EP reloads the full active
  set every 60 s (ConcaveHR's minute republish), so an expiry or a lost
  message is corrected within a minute whatever the bus did.
- **Bounds:** at most `maxActiveBans` (default 100,000) per enforcement
  point; past it, new auto-bans are aggregated to the /24 or /48 and an alert
  fires (README §9). Manual bans are never dropped.
- **Ban response:** `403` problem+json with `code: "banned"` and, by default,
  no expiry (configurable to send `Retry-After`).

**v1:** all of L4.

---

## L5 IP intelligence: country, ASN, hosting, Tor

**Stage:** pre-routing, lazily: the lookup runs only when a rule in the
compiled policy needs a country, an ASN or a class.

**Data and licences** (read 2026-11-07) [V]:

| Source | What | Licence | Notes |
|---|---|---|---|
| DB-IP Lite (country, ASN, city) | MMDB or CSV, monthly | **CC BY 4.0**; attribution and a link to db-ip.com on pages that show or use the results | [db-ip.com/db/download/ip-to-country-lite](https://db-ip.com/db/download/ip-to-country-lite); country MMDB 8.1 MB gzipped |
| IPinfo Lite (country, ASN) | MMDB, CSV, JSON, Parquet; daily | **CC BY-SA 4.0** (stated on IPinfo's pages; download needs a free token) | [ipinfo.io/products/free-ip-data-downloads](https://ipinfo.io/products/free-ip-data-downloads) |
| MaxMind GeoLite2 (country, city, ASN) | MMDB; an account and licence key | **GeoLite2 EULA**: attribution, delete old copies within 30 days of a new release, terms flow down to anyone the data is passed to (read from a 2020 copy; the current text was not confirmed) | [maxmind.com/en/geolite2/eula](https://www.maxmind.com/en/geolite2/eula) |
| Tor exit list | plain text, hourly | Tor Project, public | `check.torproject.org/torbulkexitlist` [U: not fetched] |
| Cloud provider ranges (AWS, GCP, Azure, Cloudflare, Oracle…) | JSON per provider | each provider's published file | "hosting" class |

**Design** [D]:

- **No data ships in the package** (licences differ, and ShareAlike or
  "delete within 30 days" terms must not flow to every consumer through npm).
  The operator downloads a file; bun-security reads it.
- An **MMDB reader** in the package (the MaxMind DB format is a published,
  open spec), pure TypeScript over a memory-mapped or read-once
  `Uint8Array`, with no dependency. Alternative: `mmdb-lib` (MIT, no
  dependencies) as an optional peer. Recommendation: our own reader (about
  300 lines, the format is small), Q8.
- **A refresh job** (bun-jobs, README §8.3) downloads the configured sources
  on their cadence (the Tor exit list hourly, as ConcaveHR does at :17),
  verifies the file (size, MMDB metadata, checksum when the source publishes
  one; for a list, a **minimum entry count**, 100 by default for Tor, so a
  truncated download can never empty the set, write-up §3), keeps the last
  good copy on failure, and the control plane distributes it to agents as an
  artefact beside the policy bundle (topologies.md §4), so agents never call
  third parties. Tor refusal is a rule like any other (`tor_exit_nodes`,
  on/off per scope); it stopped ConcaveHR's second wave (§8).
- **Lookups are cached** per process (an LRU of 50,000 addresses).
- **The UI shows the attribution** each licence requires on any page that
  displays country or ASN (README §7, "Attribution").

**Rules on it:** country and ASN in L3 lists and in L7 conditions; the
`hosting`, `tor`, `vpn` (only where a source provides it) classes as signals
for L10 and as challenge triggers ("challenge logins from hosting ASNs",
OWASP's example [V]).

**v1:** the MMDB reader, country and ASN lists and conditions, the Tor and
cloud-range feeds as classes. **Later:** VPN/proxy feeds (commercial), the
city level (privacy cost, little defensive value).

---

## L6 Request shape: method, path, headers, size

**Stage:** pre-routing, before the body is read.

What Bun hands the handler, measured on raw sockets (no client
normalisation) [M, `evidence/request-shape/`]:

| Request line | `req.url` / pathname seen |
|---|---|
| `GET /a/../admin` | `/admin` (dot segments resolved) |
| `GET /a/%2e%2e/admin` | `/admin` (encoded dots resolved) |
| `GET /a\..\admin` | `/admin` (backslashes treated as slashes) |
| `GET /admin%2Fsecret` | `/admin%2Fsecret` (encoded slash kept) |
| `GET //admin//x` | `//admin//x` (empty segments kept) |
| `GET http://evil.example/admin` (absolute form) | `http://<Host>/admin` (the Host header wins) |

So Bun already does the WHATWG URL normalisation, and **two forms reach the
app un-normalised**: `%2F` inside a segment, and empty segments. A path rule
written as `/admin/*` does not match `//admin/x`, while a router may still
route it, which is the classic bypass. L6 therefore [D]:

- computes one **canonical path** for every rule to match: percent-decoding
  of unreserved characters, `//` collapsed, a trailing `/` optional per rule,
  case folded only when the policy says the app is case-insensitive (Express
  is case-insensitive by default; whether bun-common's router matches it is
  to check in PR-S3 [U]);
- refuses (`400`, rule `shape.path`) a path containing an encoded slash
  `%2F`, an encoded backslash `%5C`, a NUL (`%00`), or an overlong UTF-8
  sequence, unless the route opts out;
- refuses a path over 2,048 bytes and a query string over 8,192 bytes, with
  more than 256 parameters, or nested deeper than 5 (picoquery's nesting,
  README §2.1);
- refuses methods outside the service's allowed set (default: the methods
  the router registered, plus `HEAD` and `OPTIONS`); `TRACE` and `CONNECT`
  always;
- refuses **duplicate `Host`** (Bun's bug above) and a `Host` not in the
  service's `hosts` list when one is set (DNS-rebinding and host-header
  injection);
- caps header count (default 100) and any single header (default 8 KiB)
  below Bun's block limit, with per-header exceptions (`cookie` 16 KiB);
- checks `Content-Length` against the route's body limit before the body is
  read, and wraps a chunked body in a counting stream that aborts at the
  limit;
- refuses `Content-Type`s the route does not accept (from its contract, when
  it has one; bun-common's validators know the media types, README §2.1).

**v1:** all of L6.

---

## L7 Request rules (the WAF-style subset)

**Stage:** pre-routing for rules on the line and headers; route stage for
rules on the parsed body (opt-in per route, since it needs the body parsed).

A rule is **data**, not code [D]:

```jsonc
{
  "id": "block-dotenv-probes",
  "when": { "any": [
    { "path": { "glob": "/**/.env*" } },
    { "path": { "glob": "/**/.git/**" } },
    { "header": "user-agent", "contains": "sqlmap" }
  ]},
  "action": "ban", "weight": 10, "mode": "enforce"
}
```

**Matchers** (the safe subset): `equals`, `in` (set), `prefix`, `suffix`,
`contains` (case-folded optional), `glob` (`*`, `**`, `?`; compiled to a
linear-time matcher, not a regex), `cidr`, numeric comparisons, `exists`,
`length`, and **`regex` under restrictions**. Targets: method, canonical path,
query parameter, header, cookie name, body field (JSON path, route stage
only), country, ASN, class, key values, the request's score.

**Regular expressions and ReDoS** [V] [D]. JavaScriptCore's engine
backtracks; a pattern with nested or overlapping quantifiers (`(a+)+$`,
`(a|aa)*$`) can take exponential time on a crafted input (OWASP, "Regular
expression Denial of Service" [V]). JavaScript has no regex timeout and Bun
has no linear-time engine (RE2) built in. So:

- `regex` is allowed only through a **validator** that rejects backreferences,
  lookarounds, nested quantifiers (a quantified group containing a
  quantifier), and alternations whose branches can match the same prefix
  under a quantifier — a conservative "star height ≤ 1" check in the spirit
  of `safe-regex`, written in the package;
- the input is capped (`maxRegexInput`, default 1,024 bytes per target);
- a pattern the validator rejects is refused when the policy is saved, with
  the reason shown in the UI;
- the property test (README §11.3) generates adversarial inputs for every
  accepted pattern shape.

**Managed rule sets** [D]: bun-security ships a small, conservative set, in
`dryRun` by default: path probes (`.env`, `.git`, `wp-admin` on non-WordPress
services, `phpmyadmin`, `/cgi-bin/`, `/actuator`), known scanner user agents,
`\x00` and CRLF in headers, oversized cookies. **No OWASP CRS port in v1**:
CRS's value is in hundreds of regexes tuned for a different engine
(ModSecurity/Coraza), with a paranoia-level false-positive budget; porting it
safely is a project of its own (later, Q10). A verified crawler (L3.2) on
the paths its allowance covers is exempt from the managed sets; its hits are
logged as `crawler.probe`.

**v1:** the rule language, the matchers, the regex validator, the managed
probe set. **Later:** body-field rules, a CRS-derived set.

---

## L8 Deception: honeypot routes, trap fields, canary tokens

Cheap, and almost free of false positives, because no legitimate client
touches them.

- **Honeypot routes** [D]: paths the service never serves (`/wp-login.php`,
  `/.env`, `/admin.php`, plus any the operator adds, and optionally a
  randomised path listed only in `robots.txt`'s `Disallow` or in a hidden
  link). A hit adds weight 10 to the subject's score (so the ladder bans on
  the first hit by default) and records the request (headers only, bounded).
  The route answers like a real one (a plausible 200 or 404, configurable),
  not with a block page, so a scanner learns nothing. A verified crawler
  (L3.2) gets the same answer and no weight, logged as `crawler.honeypot`;
  a claimant that fails verification gets the full weight.
- **Trap form fields**: a helper that renders a visually hidden field and a
  check that rejects a submission filling it (classic, for signup and
  contact forms).
- **Canary tokens**: values that exist only to be stolen. **Canary
  credentials** (a username and password, or an API key, planted in a
  config file, a backup, a seed) that no one uses legitimately: any use is
  an immediate ban of the subject (weight 100), a `critical` alert, and an
  event naming the canary (which tells you where the leak came from). Canary
  API keys are L12 entries with `canary: true`; canary users are
  `identify()` results the app marks, or usernames hashed in the policy.
- **Canary URLs**: a unique URL per document (an internal wiki page, a
  backup's README); a request to it alerts.

**v1:** honeypot routes, canary API keys and credentials, trap fields.
**Later:** canary URLs with per-document generation in the UI.

---

## L9 Rate limits

### L9.1 The throttle foundation does the limiting [F]

bun-security **does not ship its own rate limiter.** The throttle
foundation (branch `feat/throttle`, being built beside this plan) gives
bun-common a `throttle()` middleware and an adapter-wide `throttle` option
on both adapters, a structural `ThrottleStore` interface with a bounded
memory store, `RateLimit` headers and a 429 problem+json, fail-open or
fail-closed; bun-cache a `cacheThrottleStore(cache)` so limits are shared
across processes and instances; bun-nest `@Throttle()`/`@SkipThrottle()`
and a guard [F]. That alone fixes two of ConcaveHR's problems: its
`@nestjs/throttler` counters were per instance (write-up §4), and its window
unit was ambiguous (§8).

What bun-security adds on top, without a second limiter API:

1. **Limits from policy.** A policy's `limits` compile into the throttle
   foundation's own configuration per service and route, and are replaced
   when a new bundle loads, without re-registering middleware (README §20
   asks the foundation for a run-time-updatable limit set).
2. **Keys from identity.** The engine supplies the key function: `ip` (the
   foundation's `req.ip`, IPv6 by /64), composite keys (`ip|account`, as
   ConcaveHR keys sign-in), `user`, `apiKey`, `tenant`, `asn`; service
   identities (L2.4) skipped or re-keyed on the forwarded end user.
3. **Several limits on one route.** ConcaveHR's sign-in has two: 10/min per
   address and account, and 30/min per address against password spraying
   (write-up §2.2). A policy route entry is a list of named limits, each a
   foundation limit.
4. **A 429 is an event, and feeds escalation.** The foundation's limited
   hook (asked for, README §20) emits `throttled`, which counted rules and the
   offence score count (§0.2). ConcaveHR deliberately kept a 429 from ever
   blocking anyone; bun-security keeps that as the default (`throttled`
   weight 0) and lets a policy turn repeated 429s into a challenge or a ban.
5. **Fallback to local when the store fails** (topologies.md §6): the
   foundation's fail-open/closed plus a fallback store
   (`onStoreError: memoryThrottleStore`), so "degrade to local" is
   expressible (README §20).
6. **Dry run and explain**: a limit in `dryRun` counts and records
   `wouldHaveBeen: "block"` without answering 429; `explain()` asks the
   store without consuming (a peek, README §20).

### L9.2 Algorithms [D] [V]

The algorithm is the foundation's choice. For the record of what
bun-security needs: fixed windows suffice for ConcaveHR's limits and counted
rules (its `INCR` + `EXPIRE NX`, write-up §2.3); a **sliding window or GCRA**
avoids the 2× burst at a window boundary on high-value routes. GCRA keeps one
timestamp per key (`tat' = max(tat, now) + T`, allow iff `tat' − now ≤ τ +
T`), equivalent to a token bucket, and needs a compare-and-set on the store,
which bun-cache's counters do not provide today (`bun-cache/lib/core/types.ts:233-242`)
[S]. If the foundation ships fixed windows only, bun-security uses them and
PR-P3 adds GCRA to bun-cache as a later option; nothing in the policy format
changes (an `algorithm` field defaulting to the foundation's).

**Distinct counts** (L11.2: distinct usernames per IP, distinct IPs per
username) are not rate limits: they need a HyperLogLog per key, which PR-P3
adds to bun-cache (`pfAdd`/`pfCount`; Redis natively, a small in-package HLL
elsewhere).

### L9.3 Defaults [D]

| Limit | Key | Default |
|---|---|---|
| global per IP | `ip` (/64 for IPv6) | 600 per minute per route (ConcaveHR's: generous, because offices share one NAT address) |
| sign-in | `ip\|account` and `ip` | 10/min and 30/min (ConcaveHR's) |
| MFA step | `ip\|account` and `ip` | 5/min and 30/min |
| verify code, send code, reset, email change | `ip` | 5/min |
| per user | `user` | 1,000 per minute |
| per API key | `apiKey` | from the key's plan (L12) |
| per tenant | `tenant` | from the tenant's plan |
| verified crawler (L3.2) | `crawler:<id>`, across its addresses | 3,000 per minute per service, `evenWhenAllowed`, in place of the per-IP limits |

**Units are explicit** (ConcaveHR's `THROTTLE_TTL=60` meant 60 ms under
`@nestjs/throttler` 6, which disabled throttling, §8): the policy format takes
`"1m"`, `"15m"`, `"1h"` strings or `{ seconds }`, never a bare number, and the
compiler refuses a window under one second unless marked `subSecond: true`.

### L9.4 Responses [V] [D]

429 with `Retry-After`, and the IETF `RateLimit`/`RateLimit-Policy` fields
(draft-ietf-httpapi-ratelimit-headers-11, 23 May 2026, expires 24 Nov 2026
[V]) as the foundation emits them. bun-security's recommendation for the
foundation's default: off (it is a draft, and advertising remaining quota
helps an attacker pace just under it) (Q16). A 429 log line names the route
and limit, never the address or the account (ConcaveHR's rule, §2.2).

### L9.5 WebSocket message limits [D]

The foundation limits HTTP requests (and upgrades, through the HTTP
middleware). A socket, once open, can send without limit. bun-security adds a
per-connection inbound token bucket (bun-jobs' WS session does this: a burst
of 2× the rate, a second breach within 10 s closes with 1008,
`bun-jobs/lib/api/ws/session.ts:39-42`, `:484-499`) [S] and per-subject
limits on messages across connections, applied through `BunWebSocket`'s
message handler wrapper, with the same actions (a close code instead of a
429).

### L9.6 Memory and cardinality [D]

The foundation's memory store is bounded [F]; bun-security's own local
state (scores, counted-rule fallbacks, HLLs) has `maxKeys` (default 100,000)
with LRU eviction and an eviction counter; a sustained eviction rate is an
alert (a key-rotation attack). Shared state is bounded by TTLs.

**v1:** policy-driven foundation limits, composite keys, several limits per
route, `throttled` events, the local fallback, dry run, explicit units,
WebSocket message limits, HLL distinct counts. GCRA if the foundation lacks
it: later.

---

## L10 Bot and automation signals, and challenges

### L10.1 Signals [D]

Signals add to the request's **risk score** (separate from the subject's
offence score: risk is per request, offence is per subject over time). None
blocks alone by default.

| Signal | Source | Note |
|---|---|---|
| no or implausible `User-Agent`; UA family mismatched with `Sec-CH-UA` | headers | spoofable; weak |
| header order, `Accept`/`Accept-Language`/`Accept-Encoding` patterns of common HTTP libraries | headers | Bun's `Headers` object does not preserve wire order [I], so header-order fingerprints need the proxy |
| missing `Sec-Fetch-*` on a browser-only route | headers | strong for browser routes (every current browser sends them) |
| JA4/JA3, HTTP/2 fingerprint | a trusted proxy header (Cloudflare `cf-ja4` and similar, an nginx/HAProxy module) | Bun exposes no ClientHello [S]; only read from a trusted peer (L2) |
| hosting ASN, Tor, known VPN | L5 | OWASP suggests challenging hosting-sourced logins [V] |
| request cadence (too regular intervals) | the subject's recent timestamps (a small ring) | later |
| headless markers | a client-side script's report (later; needs JS on the page) | later |
| a failed challenge, honeypot field filled | L8, L10.2 | strong |
| a crawler `User-Agent` whose address fails verification (`crawler.spoofed`) | L3.2 | strong; blocked by default |

### L10.2 Challenges [D] [V]

A `ChallengeProvider` interface, provider-neutral:

```ts
interface ChallengeProvider {
  /** Builds what the client must solve: an HTML widget snippet, a JSON descriptor. */
  issue(ctx: ChallengeContext): Promise<ChallengeDescriptor>;
  /** Verifies the client's answer; never trusts the client alone. */
  verify(answer: string, ctx: ChallengeContext): Promise<ChallengeVerdict>;
}
```

- **Built in: proof of work**, no third party: a challenge `{ alg: "SHA-256",
  salt, difficulty, expires }` signed with HMAC; the client finds `n` such
  that `SHA-256(salt + n)` has `difficulty` leading zero bits; the server
  checks the HMAC, the expiry, the hash, and that the salt is unused (a
  replay cache keyed by salt until expiry). Difficulty scales with the risk
  score. Compatible in spirit with ALTCHA (MIT, self-hosted, PBKDF2/SHA-256
  [V]); whether to speak ALTCHA's wire format so its MIT widget can be used
  unchanged is Q9. PoW slows a bot farm per request; it does not stop a
  determined one, so it is a rate shaper, not an identity check.
- **Adapters for hosted CAPTCHAs**, each a few lines over `fetch`, with no
  SDK: Cloudflare Turnstile, hCaptcha, Google reCAPTCHA (v2/v3/Enterprise).
  They share one shape: the client widget yields a token; the server POSTs
  `secret`, `response` and optionally `remoteip` to the provider's verify
  endpoint. Turnstile's tokens are valid 300 s and single use, and server-side
  verification is mandatory [V]. Each adapter checks `success`, the
  `hostname`, and `action` when set.
- **Clearance**: a passed challenge mints a **clearance cookie** (HMAC-signed,
  `HttpOnly`, `Secure`, `SameSite=Lax`, bound to the /64 or /24 and to a hash
  of the UA, TTL 30 min default), so a human is challenged once, not per
  request. API clients get a clearance token in a header instead.
- **A verified crawler is never challenged** (L3.2): it cannot solve one, and
  the challenge page is what would be indexed.
- **Challenge pages** are served by the engine itself (a tiny HTML page with
  its own strict CSP and the provider's script origins only), or rendered by
  the app through a hook.

**v1:** the provider interface, PoW, the Turnstile and hCaptcha adapters,
clearance cookies. **Later:** reCAPTCHA Enterprise's assessment API, a
client-side automation probe script.

---

## L11 Sensitive endpoints: login, OTP, signup, reset, payment

These are where credential stuffing, enumeration, SMS pumping and card
testing happen. bun-security provides **route profiles** that bundle the
right limits, plus a small **signals API** for the facts only the app knows
(was the password right?).

### L11.1 Signals [D]

```ts
security.signal(req, "auth.failure", { username, reason: "bad-password" });
security.signal(req, "auth.success", { username, userId });
security.signal(req, "otp.sent", { channel: "sms", destination });
security.signal(req, "payment.declined", { reason });
```

A signal increments counters keyed as L2.3 says (`username` as an HMAC) and
feeds the ladder. Where the app does not call `signal`, **outcome signals**
(L14) infer them from the response status on the profiled route (`401`/`403`
→ failure, `2xx` → success), which is cruder but needs no code.

### L11.2 Credential stuffing and brute force [V] [D]

Following OWASP's credential-stuffing and authentication cheat sheets [V],
which put MFA first and then layered defences, the login profile counts, by
default:

| Counter | Window | Threshold → action |
|---|---|---|
| failures per **username** (HMAC) | 15 min sliding | 5 → progressive delay (§L11.3); 10 → challenge; 20 → soft lock (§L11.4) |
| failures per **IP** (/64) | 15 min | 20 → challenge; 50 → ban 1 h |
| **distinct usernames** per IP | 1 h | 10 → challenge; 30 → ban (the signature of stuffing: one source, many accounts) |
| **distinct IPs** per username | 1 h | 10 → step up for that account (signal to the app: require MFA) |
| **global failure ratio** for the route | 5 min vs 24 h baseline | 3× baseline → challenge every login from hosting ASNs and new devices; alert |
| successes after many failures from one IP | 1 h | tag `risky-success`, alert (a hit in a stuffing run) |

Distinct counts use a HyperLogLog per key (Redis `PFADD`/`PFCOUNT`; a small
in-package HLL for the other stores), bounded at 12 KB per key and bounded in
key count.

### L11.3 Progressive delay [D]

After the per-username threshold, each further failure delays the *next*
attempt's answer: 1 s, 2 s, 4 s … capped at 8 s (OWASP's exponential
lockout, capped [V]), under §0.1's `maxConcurrentDelays`. The delay applies to
**both** success and failure answers for that username, so timing does not
reveal which.

### L11.4 Lockouts that cannot lock out the victim [D] [V]

OWASP notes that lockout can be abused to deny service to the account's
owner, and suggests letting the user in through the forgotten-password flow
[V]. bun-security never hard-locks an account on failure counts alone. It
uses:

- **Device cookies** (the "device cookie" approach to online guessing): after
  a successful login, the engine sets a signed, long-lived cookie naming
  `{ deviceId, userHash, issuedAt }`. Failure counters and locks are kept
  **per (username, device)** for requests carrying a valid device cookie, and
  per username for those without. The owner's known device keeps working
  while the attacker's untrusted attempts are throttled.
- **Soft lock**: a locked username requires a challenge plus a successful
  login *and* an emailed or second-factor confirmation (an app hook), never a
  dead end.
- An operator unlock in the UI, audited.

### L11.5 Account enumeration [V] [D]

The engine cannot fix an app's messages, but it helps:

- `uniformAuthResponse()`: a helper that normalises the status and body of
  a profiled route's failures (`401` with one generic problem, OWASP's
  "Login failed; Invalid user ID or password" pattern [V]) and pads every
  answer to a minimum time (`minResponseMs`, default 300 ms) so the
  "quick exit" timing difference [V] is hidden.
- Reset and signup profiles count requests per destination (`email`
  HMAC) and per IP, and the docs show the generic "if the address exists,
  we sent a link" answers.
- An analytics card for **enumeration signals**: many distinct usernames
  with a high not-found ratio from one subject.

### L11.6 OTP, SMS pumping, signup, payment [D]

| Profile | Counters (defaults) | Notes |
|---|---|---|
| OTP send | per destination 3 / 10 min, 10 / day; per IP 10 / hour; per destination prefix (country code + area) 100 / hour; global per hour vs baseline | SMS pumping ("toll fraud") sends to premium ranges; the prefix and baseline counters catch it; optional country allow-list for SMS |
| OTP verify | per (user, OTP id) 5 attempts then the OTP is void; per IP 30 / hour | the app voids the code through a signal |
| Signup | per IP 5 / hour; distinct emails per IP; disposable-domain list (data, later); trap fields; PoW | |
| Password reset | per destination 3 / hour; per IP 10 / hour; uniform answers | |
| Payment | per card fingerprint (app-supplied HMAC) declines 3 / hour; per IP declines 5 / hour; per user 10 / day | card testing; the app supplies the signals |

### L11.7 Identifier patterns, checked where data is created [D]

ConcaveHR's `EmailPatternGuard` (write-up §2.4) refuses sign-ups and other
auth requests whose email matches an operator-managed wildcard pattern
(`*@disposable.example`): `*` and `?` only, at least 4 literal characters (so
`*@*` is refused), compiled to anchored, case-insensitive, linear matchers. A
match counts a hit on the pattern, records a sample, trips
`disposable_signup` against the address (threshold 1), and answers with the
same generic error as any unusable address, so the actor learns nothing.
bun-security keeps all of that as **identifier patterns** (lists of kind
`email`, `phone`, `username`, `domain`), plus the built-in policy for
self-chosen addresses (reserved domains `example.*`, `.test`, `.invalid`,
`localhost`, and the operator's own domains).

ConcaveHR's coverage gap is the design rule: the actor came back through
company team invites, which no auth route guarded, and the fix was to run the
same check inside the account-creation service (§8: "checks should sit where
data is created, not only on routes"). So the check is an API first and a
route guard second:

```ts
await security.check(req, "email", email);   // throws SecurityRefusal with the generic message; counts and records
```

called from the code that creates the record, whatever route or job reached
it; `security.profile("signup")` applies it to a route's `email` field as a
convenience. The UI shows each pattern's hit count and last hit.

### L11.8 Per-account limits across addresses [D]

ConcaveHR's `ip|account` limit "doesn't cap guesses spread across many
addresses" (§8). L11.2's per-username failure counter (keyed by the
username's HMAC, not the address) and its distinct-IPs-per-username
detector close that, with L11.4's device cookies keeping the owner in.

**v1:** signals, the login, OTP and reset profiles, progressive delay, device
cookies, soft lock, `uniformAuthResponse()`, identifier patterns with
`security.check()`, per-account limits. **Later:** signup's disposable
domains, payment profile, a breached-password check hook (Pwned Passwords'
k-anonymity range API or a self-hosted copy, OWASP [V]) — a hook in v1, the
built-in check later.

---

## L12 API keys

For services that issue API keys (bun-security does not issue them; it
watches them).

- The app tells the engine the key id and its scopes through `identify(req)`
  (or the engine reads a header and maps it with an app hook). Keys are
  never stored in clear by bun-security: the key id, or `HMAC(secret, key)`.
- **Per-key limits** from the key's plan; per (key, route) limits.
- **Anomaly rules** [D]: a key seen from a new country or ASN; from more than
  N distinct IPs per hour (default 20, configurable per key: a key embedded in
  a mobile app is legitimately everywhere); a request rate above k× its
  7-day baseline at this hour; use of a scope it has not used in 30 days; a
  burst of `401`/`403` for one key (scope probing). Each anomaly is an event
  and, by policy, a `tag`, a `challenge` (for interactive keys), a temporary
  suspension (`ban` of the key subject), and an alert to the key's owner via
  a webhook.
- **Canary keys** (L8).
- **Leaked-key response**: a "revoke and ban" action in the UI that bans the
  key subject at once (the app's own revocation is its job; the ban covers
  the gap).

**v1:** per-key limits, canary keys, the new-ASN and many-IPs anomalies.
**Later:** baselines (they need the rollups, README §8), scope anomalies.

---

## L13 Response-side controls: headers, CSRF, leakage

These run after the handler, through bun-common's response transforms (README
§2.1).

### L13.1 Security headers [D]

A native helmet equivalent, `securityHeaders(options)`, with these defaults:

| Header | Default |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (only on HTTPS; `preload` opt-in) |
| `Content-Security-Policy` | none by default (an app's CSP is the app's); a builder with nonces for apps that want one; `frame-ancestors 'none'` when the app sets nothing |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Permissions-Policy` | camera, microphone, geolocation, payment off |
| `X-Frame-Options` | `DENY` (legacy browsers; CSP `frame-ancestors` is the real control) |
| removed | `X-Powered-By`, `Server` (as far as Bun lets the app remove it) |

### L13.2 CSRF [D] [V]

Two layers, both native:

1. **Fetch Metadata resource isolation** (default on for cookie-authenticated
   services): refuse a state-changing request (`POST`, `PUT`, `PATCH`,
   `DELETE`) whose `Sec-Fetch-Site` is `cross-site`, unless the route is
   marked as a cross-site endpoint (webhooks, OAuth callbacks); when the
   header is absent (old browsers, non-browser clients), fall back to the
   `Origin` check against the service's `origins`. This is the OWASP CSRF
   cheat sheet's Fetch Metadata defence [U: cited from memory, to check].
2. **Signed double-submit token** for apps that need tokens (forms in older
   browsers): an HMAC-signed token bound to the session id, in a cookie and a
   header or field, compared in constant time.

### L13.3 Response leakage [D]

- Error responses: problem+json without stack traces in production
  (bun-common's error handler already formats errors; L13 verifies that no
  `stack` field and no `at <file>:<line>` text leaves a 5xx when
  `NODE_ENV=production`, and scrubs it if one does, logging an event).
- Optional body scanners on JSON responses for patterns that must never
  leave (a canary token value, a private key header, a configured secret's
  prefix): a match blocks the response with 500 and a `critical` event.
  Off by default (it costs a scan of every body).
- Cache: `Cache-Control: no-store` on responses that set cookies or carry
  `Authorization`-dependent data, unless the route says otherwise.

**v1:** `securityHeaders`, Fetch Metadata + Origin CSRF, the double-submit
token, stack-trace scrubbing. **Later:** body scanners.

---

## L14 Outcome signals (after the response)

Some facts exist only after the handler: the status, the time taken, the
bytes sent. bun-common resolves a response hook once the response is sent
(README §2.1); the engine uses it to:

- infer `auth.failure`/`auth.success` on profiled routes (L11.1);
- count **route-not-found** answers per subject (no route matched: the
  router's not-found path, distinct from an app's own 404 for a missing
  record, which never counts; ConcaveHR counts only the former, from its
  exception filter, write-up §2.3). Default counted rule
  `not_found_per_minute`: 120 in 60 s → ban 1 day (ConcaveHR's); bun-common
  marks the response as router-not-found so the engine can tell (PR-S5);
  not counted for a verified crawler on its allowance's paths (L3.2), whose
  old links are the commonest source of such answers;
- count `5xx` per route for the analytics page, and per subject (an attacker
  finding a crashing input);
- decrement concurrency counters (L1, L9);
- record the decision's latency in the event.

**v1:** all of L14.

---

## 15. What is v1 and what is later

| Layer | v1 | Later |
|---|---|---|
| L1 | `hardenServe()`, body limits, per-IP concurrency, global in-flight cap | |
| L2 | everything, on the trust-proxy foundation; service identity; trust misconfiguration detection | |
| L3 | IP, CIDR, user, API-key lists; scopes; expiries; the `internal` list and allow guards; verified crawlers (L3.2: the registry's default set, `ranges` and `rdns` verification, exemptions, the per-crawler limit, the spoofed signal, the conflict check) | fingerprint lists; a `robotsTxt()` helper; signed agents as a verification method |
| L4 | everything, with ConcaveHR's merge rules and a 60 s reconcile | |
| L5 | MMDB reader; country, ASN; Tor and cloud ranges as classes | VPN/proxy feeds, city |
| L6 | everything | |
| L7 | the rule language, safe matchers, the regex validator, the probe set | body-field rules, a CRS-derived set |
| L8 | honeypot routes, canary keys and credentials, trap fields | canary URLs |
| L9 | on the throttle foundation: policy-driven limits, composite keys, several per route, `throttled` events, local fallback, dry run, explicit units; WebSocket message limits; HLL distinct counts | GCRA if the foundation lacks it |
| L10 | provider interface, PoW, Turnstile, hCaptcha, clearance | reCAPTCHA Enterprise, a client probe, cadence signals |
| L11 | signals, login/OTP/reset profiles, progressive delay, device cookies, soft lock, uniform answers, identifier patterns and `security.check()`, per-account limits, a breached-password hook | a maintained disposable-domain feed, the payment profile, a built-in breached-password check |
| L12 | per-key limits, canary keys, new-ASN and many-IPs anomalies | baselines, scope anomalies |
| L13 | security headers, CSRF (Fetch Metadata + token), stack scrubbing | body scanners |
| L14 | everything | |
