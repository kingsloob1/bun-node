# @kingsleyweb/bun-security

A request-defence engine for Bun services. It decides every request locally,
from a policy compiled once, before your handler sees it.

> **Being built.** This is milestone M1's first parts (PR-S1 to PR-S3, and
> PR-S5) of the [bun-security plan](../../docs/plans/bun-security/README.md):
> the engine, client identity, service identity, the trust check, allow and
> deny lists, rate limits on bun-common's throttle foundation, counted rules,
> bans with an offence score and an escalation ladder, request shape and a
> canonical path, honeypots, canary credentials and trap fields, connection
> limits, outcome signals, the plain `Bun.serve` integration, and the
> bun-common adapter integration with security headers and CSRF. Request
> rules, challenges, the bun-nest integration, shared state and the control
> plane follow in later PRs.

```sh
bun add @kingsleyweb/bun-security
```

Bun 1.4.2 or later. Its one runtime dependency is `@kingsleyweb/bun-common`.

## A plain `Bun.serve`

```ts
import { createSecurity } from "@kingsleyweb/bun-security";
import { hardenServe, withSecurity } from "@kingsleyweb/bun-security/serve";

const security = createSecurity({
  policy: {
    service: "checkout",
    public: true,
    lists: [
      { ip: "203.0.113.0/24", action: "block", reason: "scanner" },
      { ip: "198.51.100.7", action: "drop" },
      { user: "u_mallory", action: "block" },
    ],
  },
  identify: (req) => ({ user: req.headers.get("x-user-id") ?? undefined }),
});

Bun.serve(
  hardenServe({
    port: 443,
    fetch: withSecurity(security, (req) => app(req), {
      trustProxy: ["10.0.0.0/8"], // the proxies in front of this listener
    }),
  }),
);
```

`withSecurity(security, fetch, options)` turns each request into facts,
asks the engine, and answers a refusal itself: problem+json
(`{ type, title, status, code }`, never the rule's name) with the refusal's
status (`403`, `429` for a limit, `503` past the in-flight cap, `400` to
`431` for a request-shape refusal, `404` for a honeypot that asks for it) and
`Retry-After` when it ends, a minimal HTML page for a browser, `renderBlock`'s
answer if you pass one, or for `drop` no answer at all (the connection
closes). Every request it lets through is tracked, and reported back with
`complete()` once the handler answers (a thrown handler counts as a `500`),
so connection limits and outcome events work with no more wiring. If the
engine throws, the request goes through and the error is logged;
`failClosedOnEngineError: true` answers `503` instead.

`hardenServe(options)` sets `idleTimeout` (10 s) and `maxRequestBodySize`
(1 MiB) unless you set them, refuses an `idleTimeout` of `0` or over 255, and
refuses `development` under `NODE_ENV=production`.

## Who the client is

The client is the socket peer unless `trustProxy` trusts the hops in front of
it. The resolution is bun-common's (Express's `trust proxy`, its presets,
`behindCloudflare()`, `behindRailway()`), so a spoofed `X-Forwarded-For`
from an untrusted peer is never read. The engine then normalises the address
(`::ffff:203.0.113.5`, how a default listener reports an IPv4 client, is
`203.0.113.5`) and keys IPv6 by its `/64` (`keys.ipv6Prefix`), so one
subscriber rotating through its /64 is one key.

**Service identity.** A sibling service calls with its token in
`x-service-token`; the policy holds only the token's SHA-256. A verified call
is exempt from lists (and, as they land, bans, counted rules and global
limits), and its egress address is never counted: with `forwardsClientIp`,
the end-user address it sends in `x-service-client-ip` becomes the client;
without one, the call counts against nobody.

```ts
serviceIdentity: {
  services: [{ id: "pay-api", verifier: "sha256:<hex of the token>", forwardsClientIp: true }],
},
```

**The trust check.** On a service whose policy says `public: true`, the
engine warns (through `logger` and `onWarning`) when most requests resolve
into the internal list, or carry forwarding headers your trust configuration
never reads, for five minutes in a row: the two ways a wrong `trustProxy`
silently switches a defence off. `security.status().trust` shows the
per-minute gauges.

## Lists

Each entry names one subject (`ip`: an address or CIDR range; `user`; `apiKey`
id) and an action: `allow`, `block`, `challenge` (a `block` until challenge
providers land) or `drop`. Entries take an `id`, `reason`, `createdBy`,
`code`, `expiresAt` (an ISO 8601 timestamp with its time zone), `paths`
(route prefixes), `scope`, `override`, `locked` and `mode`.

- The most specific scope that matched decides (route `paths` > service >
  group > global); within it an `allow` marked `override` wins, otherwise the
  most severe action does. A `locked` entry is weighed before every unlocked
  one.
- The built-in **`internal`** list (loopback, RFC 1918, CGNAT
  `100.64.0.0/10`, link-local, IPv6 loopback, unique local and link-local)
  is on by default and locked: no address entry refuses an internal client.
  Narrow it with `internal: { ranges: [...] }` or turn it off with
  `internal: false`.
- An `allow` entry wider than `/8` (IPv4) or `/32` (IPv6) is refused.
- `paths` match the canonical path (see [Request shape](#request-shape)),
  folded to lower case unless `shape.caseSensitive` is `true`, as
  bun-common's router matches, so `//Admin` cannot step around `/admin`.
- Every entry, and the whole policy, has a `mode`: `enforce`, `dryRun` (the
  decision is `log`, with the entry's would-be action as `wouldHaveBeen`) or
  `off`.

## Rate limits

bun-security has no rate limiter of its own: each entry of `limits` is
counted by bun-common's `throttle()` (its algorithms, its store contract, its
fail-open on a store error), keyed and selected by the engine.

```ts
limits: [
  // ConcaveHR's sign-in: per address and account, and per address against password spraying.
  { id: "signin-account", limit: 10, window: "1m", key: ["ip", "user"], routes: ["POST /auth/signin"] },
  { id: "signin-ip", limit: 30, window: "1m", routes: ["POST /auth/signin"] },
  { id: "per-user", limit: 1000, window: "1m", key: "user" },
],
```

- **Keys**: `ip` (IPv6 by its `/64`), `user`, `session`, `tenant`, `apiKey`
  (from `identify()`) and `route`, alone or composite (`["ip", "user"]`). A
  request missing a part is not counted by that limit.
- **Routes**: `"POST /login"`, `"/login"` (any method), `"/auth/*"` (a
  prefix on whole segments); matched on the path (case-insensitive, trailing
  slash ignored, `GET` covering `HEAD`) or the matched route's pattern. Every
  request when absent; several limits on one route each count.
- **Windows take a unit** (`"1m"`, `{ seconds: 30 }`); a bare number is
  refused, and so is a window under a second unless `subSecond: true`.
- `algorithm`: `sliding-window` (the default), `fixed-window` or `gcra`;
  `cost` per request; `code` of the `429` body (`rate_limited`).
- A refused request gets `429` with `Retry-After`, counts too, and emits the
  `throttled` event. `mode: "dryRun"` counts and records
  `wouldHaveBeen: "block"` without refusing.
- An allow entry skips limits unless `evenWhenAllowed: true`; an internal
  client is never limited by an address-only key. A verified sibling service
  is exempt from limits unless `appliesToServices: true`, which keys it on
  the end user it forwards (one that forwards none counts against nobody).
- `security.load()` keeps the counts of every limit whose id, window and
  algorithm stay the same.

Counts live in the engine's `throttleStore`: by default a memory store of its
own, bounded by `maxKeys` (100,000). Pass a shared one, such as
`cacheThrottleStore(cache)` from `@kingsleyweb/bun-cache/throttle`, to count
across processes; with an asynchronous store, `evaluate()` returns a promise.

The throttle is a bun-common middleware, so the engine calls it with a
stand-in request (an empty object, its key looked up in a `WeakMap`); a
request-free entry into the foundation's counting is proposed upstream
(kingsloob1/bun-node#791).

## Counted rules

"N occurrences of an event within W for one key → an action for B", the form
ConcaveHR's operators ran on:

```ts
countedRules: [
  { id: "failed-password", event: "auth.failure", threshold: 10, window: "15m", duration: "1h" },
  { id: "requests-per-second", event: "request", threshold: 100, window: "1s", duration: "15m" },
  { id: "not-found", event: "route.notFound", threshold: 120, window: "60s", duration: "1d" },
  { id: "repeat-429", event: "throttled", threshold: 20, window: "10m", duration: "1h" },
],
```

- **Events**: `request` (every request past the lists), `throttled` (a limit
  refused it), `route.notFound` and `server.error` (from `complete()`), and the
  app's own: `security.signal(facts, "auth.failure")`.
- At the threshold the counter is cleared (one burst, one trip) and the key is
  banned (see [Bans](#bans)): `action: "ban"` (the default) or `"challenge"`
  (a block until challenge providers land) for `duration`, or with
  `duration: null` until lifted (`security.unban()`, or the rule removed or
  turned off); `action: "ladder"` bans for the ladder's escalating length and
  takes no `duration`. The tripping request is refused too, and the trip adds
  the rule's `weight` (default 1) to the address's score.
- `key`, `routes` and `mode` work as for limits. Counters live in the same
  `throttleStore` (a fixed window from the first occurrence).
- A verified sibling service is exempt by default; `appliesToServices: true`
  counts and refuses the end user it forwards instead (ConcaveHR's sign-in
  proxy), never the service itself.

## A bun-common adapter

```ts
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { createSecurity } from "@kingsleyweb/bun-security";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { installSecurity, requestSecurity, securityProfile } from "@kingsleyweb/bun-security/http";

const security = createSecurity<BunRequest>({
  policy,
  identify: (req) => ({ user: sessionUser(req.cookies.sid) }),
});
const app = new BunHttpAdapter(0, { trustProxy: ["10.0.0.0/8"] });
await installSecurity(app, security);            // first, before any route or middleware

app.post("/login", securityProfile("login"), login);
app.post("/hooks/stripe", securityProfile("webhook", { crossSite: true }), stripeHook);
app.get("/me", (req, res) => res.json({ tags: requestSecurity(req)?.decision?.tags }));
```

`installSecurity(app, security, options)` puts the engine on the adapter in
three places (plan §3.3):

- **The early stage**, on the adapter's before-read hook, runs before the
  request is read: the in-flight limits, client identity, the lists'
  address entries, bans of an address or a range, the request's shape (L6),
  honeypot routes (L8), and the limits and counted rules keyed on the
  address alone. A refused request is answered before its body, cookies or query
  are parsed, as `withSecurity` answers one (`renderBlock`, `drop`,
  `failClosedOnEngineError` work the same).
- **The route stage**, a middleware the install registers, runs once the
  request is read: it finds the route the request will reach (its pattern,
  `"GET /users/:id"`, and its `securityProfile()`), asks `identify(req)`
  who is calling, and evaluates the rules keyed on the caller (`user`,
  `session`, `tenant`, `apiKey`) or the route (`route`), the rules on a
  route pattern with a parameter, the lists' user and API-key entries, bans
  naming the caller, and canary credentials (L8); then the CSRF check. Each rule counts in exactly one stage
  (`evaluate(facts, { stage: "early" | "route" })`), so a request is
  counted once, and an event both stages see (`request`,
  `route.notFound`, `server.error`) adds its offence weight to the ladder
  once.
- **The response stage**, on the adapter's before-write hook, sees every
  answer (a route's, a not-found page, an error, a refusal): it sets the
  security headers, scrubs a stack trace from a `5xx`, and reports the
  outcome to `complete()` once the answer is final (a stream when it ends),
  with **route-not-found** marked: no route handler matched and the answer
  is a `404`, which an app's own `404` for a missing record, answered by a
  route, never is.

The route stage runs in registration order, so install first; only a
throttle the adapter was constructed with runs ahead of it. The install
then sends one marked request through the adapter's socket-free `fetch()`
(the **boot self-test**) and rejects with a `ConfigError` unless all three
stages saw it, so an install that is not in the pipeline fails at start-up
rather than in production. `expectThrottle: true` also fails it unless a
bun-common throttle ran. The self-test's request is explained, never
counted. `installation.remove()` takes the engine back off.

`securityProfile(name, options)` marks a route: the name, for the app
(`requestSecurity(req).profile`) and for later profiles' counters (PR-S7),
and its per-route options (`crossSite: true`, a webhook or OAuth callback
the CSRF check does not refuse). `securityMiddleware(security, { router })`
is the route stage alone, for a router the install does not cover: it
evaluates every stage at once, takes no in-flight slot, and counts as
route-not-found only a not-found answer sent on the response.

### Security headers, CSRF and scrubbing

`securityHeaders(options)` (on by default under `installSecurity`, `headers:
false` turns it off) sets, unless the answer already has them:
`Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options:
nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Cross-Origin-Opener-Policy` and `-Resource-Policy: same-origin`, a
`Permissions-Policy` turning camera, microphone, geolocation and payment
off, `X-Frame-Options: DENY`, and over HTTPS
`Strict-Transport-Security: max-age=31536000; includeSubDomains`. It removes
`X-Powered-By` and `Server`, and marks an answer that sets a cookie and says
nothing about caching `Cache-Control: no-store`. Each header takes its own
value or `false`; `override: true` replaces the app's.

`csrf(options)` (on by default, `csrf: false` turns it off) refuses a
state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`) that carries
cookies and that the browser marks `Sec-Fetch-Site: cross-site`, with a
`403` problem (code `csrf`), unless its `Origin` is in `origins` or its route
is `crossSite`. Without that header it checks `Origin` against the request's
own origin and `origins`; a request with neither is not a browser's. With
`token: { secret, session }` it also issues a signed double-submit token
(`guard.token(req, res)`, set in a cookie) and requires it echoed in
`x-csrf-token` or a `_csrf` field.

`scrub: "production"` (the default) replaces a `5xx` answer whose body
carries a stack trace (a `"stack"` member, a stack frame line) with a bare
problem+json of the same status while `NODE_ENV` is `production`, and logs
it (status and path, never the body); `"always"` scrubs everywhere.

## Connection limits and outcomes

```ts
concurrency: { perIp: 64, total: 2000 },   // the defaults: perIp 64, total off
```

`perIp` refuses a client address with more requests in flight (`429`);
`total` sheds load past a number in flight (`503`, `Retry-After: 1`), for
everyone. Both count only **tracked** requests, `evaluate(facts, { track:
true })`, whose integration promises to call
`security.complete(facts, decision, { status, routeNotFound })` when the
request is answered; `withSecurity` does both. A slot whose `complete()` is
lost stops counting after `releaseAfter` (5 minutes). `complete()` also counts
`route.notFound` (no route matched; never an app's own `404`) and
`server.error` (a `5xx`) for counted rules.

Every table of local state (scores, ban history, in-flight requests, the
default store's counters) is bounded by `maxKeys`; past it the oldest entry is dropped, counted
in `security.status().state.evictions`, and a `state.evictions` warning goes to
`onWarning` and the logger.

## Bans

A ban refuses every request of its subject until it ends: an address (IPv6 by
its `/64`), a range, a user, an API key, or a counted rule's composite key.
Bans are written by counted rules, by the ladder, and by hand; they are looked
up locally on every request, never waiting on a store.

```ts
security.ban({ ip: "203.0.113.0/24", duration: "1h", reason: "scanner", by: "ops" });
security.ban({ user: "u_mallory", duration: null }); // until lifted
security.unban("cidr:203.0.113.0/24", { by: "ops" });
security.bans(); // the bans in force
```

- A ban answers `403` with `code: "banned"` and, by default, no `Retry-After`
  (an attacker learns nothing); `bans: { code, retryAfter: true }` changes
  both. Its id is its subject, `ip:203.0.113.5`.
- **Merging**: a new ban on a subject already banned extends it (the later end
  wins, "until lifted" beats any date), `ban` beats `challenge`, and a manual
  ban replaces an automatic one's reason.
- An address ban never refuses an internal client (a user or API-key ban
  does); an allow entry is never refused; a verified service exempt from bans
  is refused only by bans of counted rules with `appliesToServices`.
- At most `bans.maxActive` (100,000) are held: past it, a new automatic ban of
  an address is widened to its `/24` or `/48` and a `bans.aggregated` warning
  raised. Manual bans are never dropped. Sharing bans across processes comes
  with PR-S4.

### The offence score and the ladder

Each client address has a score that offences raise and that halves every
`halfLife` (1 hour). The ladder turns it into challenges and bans:

```ts
ladder: {
  steps: [{ score: 3, action: "challenge" }, { score: 10, action: "ban" }], // the defaults
  weights: { "honeypot.hit": 10, "canary.used": 100, "trap.filled": 10, "shape.refused": 1 },
},
```

- **Weights** are per event (an engine event, an L8 event or your own
  `signal()`), merged over the defaults above; any other event weighs 0, so a
  `429` alone never bans. A counted rule's trip adds its `weight` (1).
- A `challenge` step lasts 15 minutes unless it says otherwise; a `ban` step
  lasts `base × factor^(n-1)` (1 h, 6 h, 36 h, …, `maxBan` 30 days), n being
  the address's bans within `memory` (7 days), and starts the score again.
- Allow-listed and internal addresses are never scored. `ladder: false` turns
  it off; `mode: "dryRun"` scores and logs only.

## Request shape

Every request's path is read in one **canonical** form (`canonicalPath()`):
the WHATWG normalisation Bun applies, then unreserved escapes decoded (`%61`
is `a`) and repeated slashes collapsed, so `//admin`, `/a/%2e%2e/admin` and
`/a\..\admin` all read `/admin` for every rule. Before routing, `shape`
refuses (`400` unless noted, problem code `rejected`):

- `TRACE` and `CONNECT`, and methods outside `methods` (`405`);
- an encoded slash or backslash (`%2F`, `%5C`, unless a route opts out with
  `allowEncodedSlash`), a NUL, escapes that are not UTF-8 (overlong forms
  included), a path over 2,048 bytes (`414`);
- a query over 8,192 bytes (`414`), with more than 256 parameters, or nested
  deeper than 5;
- **a duplicate `Host`** (Bun accepts two lines,
  [oven-sh/bun#44232](https://github.com/oven-sh/bun/issues/44232)), or a
  `Host` outside `hosts`;
- more than 100 headers, or a value over 8 KiB (`cookie`: 16 KiB) (`431`);
- a `Content-Length` over the route's `maxBodySize` (or the policy's) (`413`),
  and a body of a media type the route does not accept (`415`):

```ts
shape: {
  hosts: ["api.example.com"],
  routes: [{ routes: ["POST /avatar"], maxBodySize: 100_000, contentTypes: ["image/*"] }],
},
```

A refusal is the `shape.refused` event (weight 1). `shape: false` turns the
checks off, `mode: "dryRun"` logs them.

## Request rules

Rules are data: a condition over the request and what to do when it holds
(layers.md L7).

```ts
requestRules: {
  rules: [
    {
      id: "no-scanners",
      when: { any: [
        { path: { glob: "/**/.env*" } },
        { header: "user-agent", contains: "sqlmap", ignoreCase: true },
        { queryParam: "id", regex: "'\\s*or\\s+\\d", ignoreCase: true },
      ] },
      action: "ban", duration: "1d", weight: 5,
    },
    { id: "staff-only", when: { all: [{ path: { prefix: "/admin" } }, { not: { user: { prefix: "staff_" } } }] } },
  ],
  managed: true, // the probe set below, in dry run; { mode: "enforce", exclude: ["wordpress"] } to act
},
```

- **Targets:** `method`, `path` (the canonical path), `rawPath`, `query`,
  `queryParam`, `header`, `anyHeader`, `cookie` (whether one is sent),
  `client` (`{ cidr }`), `contentLength`, `headerCount`; and, read in the
  route stage once routing and `identify()` have run, `routeKey`, `user`,
  `session`, `tenant`, `apiKey`. A rule that reads any of the last five runs
  in the route stage; every other runs in the early stage, before the body
  is read.
- **Matchers**, one per test: `equals`, `in`, `prefix`, `suffix`,
  `contains`, `glob` (`*`, `**`, `?`, matched without regular expressions),
  `regex`, `exists`, `length`, and on numbers `equals`, `gt`, `gte`, `lt`,
  `lte`; `ignoreCase` beside them (on by default for paths). Combine tests
  with `all`, `any` and `not`.
- **Actions:** `block` (the default; `status` and `code` choose the answer),
  `ban` (the client address, for `duration`, or the ladder's escalating
  length), `drop` (no answer), `challenge` (a `block` until challenge
  providers exist), `log`. `mode: "dryRun"` records what a rule would have
  done; `off` skips it.
- **Scoring:** each enforced hit counts the `pattern.hit` event (the managed
  set's `probe.hit`) for counted rules, and adds the rule's `weight` (default
  1, 0 for `log`) to the client address's score, so a run of probes reaches
  the ladder's ban.
- **Regular expressions are restricted** (JavaScriptCore backtracks and has
  no timeout): no backreferences, lookarounds, Unicode property escapes or
  inline modifiers; no quantifier inside a quantified group (`(a+)+`); no
  repeated group whose alternatives start alike (`(a|aa)*`) or that can match
  nothing; and no two choices that can trade characters (`\\d+\\d*`,
  `.*a.*`, `a?a?aa`). A refused pattern refuses the policy, with the reason
  (`regexRefusal(source)` gives it beforehand). A regex reads at most
  `maxRegexInput` characters (1,024).
- **The managed probe set** (off by default; `managed: true` turns it on in
  dry run): `dotenv`, `vcs` (`.git`, `.svn`, `.hg`), `wordpress`,
  `phpmyadmin`, `cgi-bin`, `actuator` (answered `404`), `scanner-agents`
  (`403`), `header-control-chars` (`400`), `oversized-cookie` (`431`). A
  verified crawler (a later release) is never refused by it, and a rule of
  your own can say `crawlers: "skip"` to exempt one too.

## Deception

```ts
deception: {
  honeypots: true, // "/wp-login.php", "/.env", "/admin.php"; or { paths, answer }
  canaries: [{ id: "backup-2026-q3", apiKey: "key_planted_in_backup" }],
},
```

- **Honeypot routes** (off by default) are paths your service never serves.
  A hit is answered as a real route would be (`answer: "pass"`, the default,
  lets your app answer it; `"not-found"` answers `404`), never with a block
  page, and weighs 10, so the client is banned from its next request.
- **Canary credentials** are user or API key ids no one uses legitimately
  (planted in a backup, a config file, a seed). Any use is refused at once,
  weighs 100, logs an error and raises a `canary.used` warning naming the
  canary, which tells you where the leak came from.
- **Trap form fields**: `trapField()` renders a field people never see
  (`html`, to put in your form); `isTrapFilled(submission)` says whether a
  bot filled it; then call `security.signal(facts, "trap.filled")` (weight
  10) and refuse the submission.

## The policy

A policy is plain data. `compilePolicy(policy)` validates it and compiles it
(a CIDR trie for addresses, maps for users and keys); it throws a
`SecurityPolicyError` listing every issue. Unknown keys are refused (keys
starting with `$` are ignored), a duration needs its unit (`"5m"`,
`{ minutes: 5 }`), and a timestamp its time zone. `version: 1` names the
format; a policy without one reads as version 1, and a higher version is
refused with an error saying the policy is newer than this package (rather
than a list of unknown keys), so an older service tells a newer policy from a
broken one; that issue carries `code: "policy.newer"`, for a program to
tell "upgrade needed" from "malformed". `securityPolicySchema` is
the same validation as a [Standard Schema](https://standardschema.dev).
`security.load(policy)` swaps a new policy in at once, keeping the old one if
the new one is refused.

## Deciding and explaining

```ts
import { requestFacts } from "@kingsleyweb/bun-security";

const facts = requestFacts(request, { peer: "10.0.0.1", trustProxy: ["10.0.0.0/8"] });
const decision = await security.evaluate(facts);
// { action: "block", status: 403, code: "blocked", hits: [...], tags: [], risk: 1, subject: { address, ip } }

const { decision: same, client, steps } = await security.explain(facts);
```

`evaluate()` is synchronous while every store in play is (the default
memory store is); a promise otherwise. `explain()` is the same decision with
no state written (limits are read with the throttle's `peek()`, and layer L1
as for a tracked request), plus how the client was resolved and every check
made. `onDecision(decision, facts)` sees every
`evaluate()` decision.
