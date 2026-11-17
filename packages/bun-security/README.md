# @kingsleyweb/bun-security

A request-defence engine for Bun services. It decides every request locally,
from a policy compiled once, before your handler sees it.

> **Being built.** This is milestone M1's first parts (PR-S1 to PR-S5) of
> the [bun-security plan](../../docs/plans/bun-security/README.md):
> the engine, client identity, service identity, the trust check, allow and
> deny lists, rate limits on bun-common's throttle foundation, counted rules,
> bans with an offence score and an escalation ladder, request shape and a
> canonical path, honeypots, canary credentials and trap fields, connection
> limits, outcome signals, the plain `Bun.serve` integration, and the
> bun-common adapter integration with security headers and CSRF, shared
> state across processes (`./stores`), WebSocket message limits, request
> rules, challenges with bot signals, the sensitive endpoints (sign-in,
> codes, resets: presets, the login defences, device cookies, identifier
> checks), IP intelligence (`./intel`), verified crawlers, API keys,
> the security store (`./store`: a policy from a file, a SQLite or a
> Postgres database, followed as it changes; `./sealing`: its secrets
> sealed at rest), events and analytics (`./analytics`), and attack simulators for testing a policy
> (`./testing`), and the control plane's management API (`./control`;
> the agent, audit log and analytics follow in later PRs).

```sh
bun add @kingsleyweb/bun-security
```

Bun 1.4.2 or later. Its runtime dependencies are `@kingsleyweb/bun-common`
and `@kingsleyweb/bun-sql` (the store's SQL layer); `./stores` and
`./sealing` need `@kingsleyweb/bun-cache` (an optional peer).

Runnable examples of everything below, each asserting what it shows, are in
[`examples/bun-security`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-security):
`Bun.serve`, bun-common and NestJS integrations, client identity, lists and
bans, limits, presets, request rules, deception, sign-in protection,
challenges, IP intelligence, verified crawlers, API keys, shared stores,
policies from a file or a store, dry run and `explain()`, and testing a
policy with simulated attacks.

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
id; `country` or `asn`, which need [IP intelligence](#ip-intelligence)) and an
action: `allow`, `block`, `challenge` (see
[Challenges](#challenges); a `block` without a challenge flow) or `drop`.
`allow`, `block` and `drop` answer before [bans](#bans) are looked at; a
`challenge` entry lets the bans decide first, so a banned client gets its
ban, and only one with no ban is challenged. Entries take an `id`, `reason`, `createdBy`,
`code`, `expiresAt` (an ISO 8601 timestamp with its time zone), `paths`
(route prefixes), `scope`, `override`, `locked` and `mode`.

A `/0` range (`0.0.0.0/0`, `::/0`, or `::ffff:0:0/96`, which maps to the
IPv4 `/0`) covers every address of its family, so it is refused, saying so:
`lists[0].ip: a /0 range covers every address of its family; use a request
rule instead`. The same goes for the internal ranges, a request rule's
`client.cidr`, `ipIntel()`'s static `ranges` and `ban()`. A rule matching
every client is a rule without a `client` condition.

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

Local counts live in the engine's `throttleStore`: by default a memory store
of its own, bounded by `maxKeys` (100,000). With a shared store (`store`,
[below](#shared-state-across-processes)) limits count there by default; with
an asynchronous store, `evaluate()` returns a promise. The engine counts
through the throttle's `count()` and `peekCount()` (by key, no request).

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
  (see [Challenges](#challenges)) for `duration`, or with
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
default store's counters) is bounded by `maxKeys`, per table and per process;
past it the oldest entry is dropped. Each drop is counted in
`security.status().state.evictions`, and a `state.evictions` warning goes to
`onWarning` and the logger, once, until a minute passes with none: a key
rotation (a botnet, addresses in a /64) or `maxKeys` set too small. A counter
that expired is not an eviction. A `throttleStore` you pass is yours: the
engine counts none of its drops (bun-common's `memoryThrottleStore` reports
them to its own `onEvict`).

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
  `client` (`{ cidr }`), `contentLength`, `headerCount`, the client's
  `country`, `asn` (`{ equals }`, `{ in: [...] }`, `{ exists }`) and `class`
  (see [IP intelligence](#ip-intelligence)); and, read in the
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
  length), `drop` (no answer), `challenge` (see
  [Challenges](#challenges)), `log`. `mode: "dryRun"` records what a rule would have
  done; `off` skips it.
- **Scoring:** each enforced hit counts the `rule.hit` event (the managed
  set's `probe.hit`; `pattern.hit` is the identifier checks' alone) for
  counted rules, and adds the rule's `weight` (default
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
- **The managed probe set** (on by default, in dry run, since verified
  crawlers are exempt from it; `managed: false` turns it off,
  `{ mode: "enforce" }` makes it act): `dotenv`, `vcs` (`.git`, `.svn`, `.hg`), `wordpress`,
  `phpmyadmin`, `cgi-bin`, `actuator` (answered `404`), `scanner-agents`
  (`403`), `header-control-chars` (`400`), `oversized-cookie` (`431`). A
  [verified crawler](#verified-crawlers) is never refused by it (its hits
  are logged as `crawler.probe`), and a rule of your own can say
  `crawlers: "skip"` to exempt one too.

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

## Shared state across processes

Several processes (enforcement points) share limits, counted rules, bans and
offence scores through one bun-cache backend: Redis, Postgres, MySQL,
MariaDB, MongoDB or one SQLite file.

```ts
import { createCache, redisDriver } from "@kingsleyweb/bun-cache";
import { createSecurity } from "@kingsleyweb/bun-security";
import { cacheStore } from "@kingsleyweb/bun-security/stores";

const store = cacheStore(createCache({ driver: redisDriver({ url: process.env.REDIS_URL }) }));
const security = createSecurity({ policy, store, secret: process.env.SECURITY_SECRET });
await security.ready(); // the fleet's bans loaded before the first request
```

- **Where a limit counts** is its `state`: `shared` (the default with a
  store: one round trip, exact across processes), `local` (this process
  only), or `hybrid` (counted here at once and synced every `syncInterval`,
  250 ms: no round trip, approximate by about `rate × syncInterval ×
  processes`; not with `gcra`). Counted rules take `local` or `shared`. The
  policy's `state.mode` is the default. A policy naming `shared` or `hybrid`
  on an engine without a store is refused.
- **When the store fails** a rule does what its `onStoreError` says (default
  the policy's `state.onStoreError`, else `local`): `local` counts in this
  process at its local share (the limit or threshold ÷ `state.nodes`, at
  least 1); `open` lets it through, recording the failure; `closed` (limits
  only) answers `503` with `Retry-After: 5`. Every store call has a timeout
  (`timeout`, 50 ms) and a circuit breaker (`circuit`, 5 failures, 30 s), so a
  dead store costs a request its fallback, not a wait. A distinct count's
  calls (`pfAdd`, `pfCount`: credential stuffing, spraying and the API-key
  many-addresses check) have their own, longer deadline (`distinctTimeout`,
  250 ms, or `timeout` when that is longer), since a count that falls back
  sees only its own process's traffic: every such fallback is counted in
  `status().state.store.distinctFallbacks` and raises a
  `store.distinct-fallback` warning, once, until a minute passes with none.
  After 30 s of failure the engine raises a `store.unavailable` warning.
- **Bans** are always looked up in memory. A ban (and a lift) is written to
  the store's ban log and announced on the cache's own bus (`cacheBusOf`:
  Redis's pub/sub, Postgres's `LISTEN`; another with `bus`, none with
  `bus: false`); every process reads the log on the announcement and every
  `pollInterval` (5 s) besides, and reloads the whole set every
  `reconcileInterval` (60 s), which corrects a lost message or a lift. A
  failed read removes nothing. Writes made while the store fails are queued
  (`maxPendingBans`, 10,000) and sent when it answers; a store found emptied
  is refilled from the processes' memory. A counted rule removed from a
  service's policy stops its bans in that service.
- **Who shares bans and scores** is the policy's `state.scope`:
  `"shared"` (the default) shares them with every other `"shared"` service
  on the same `namespace`, so an address banned by one is refused by all;
  `"service"` keeps them to the service's own processes (it needs the
  policy's `service`): another service never enforces its bans or reads its
  scores, nor it another's. On one namespace the two mix predictably: the
  shared services share among themselves, each per-service service keeps to
  itself, and a subject banned in both is two bans, each lifted in its own
  scope. A ban takes its writer's scope (`Ban.scope` is `"service"` for a
  per-service one), manual bans included. Changing a service's scope with
  `load()` changes which of the store's bans apply, and starts its scores
  afresh. Limits and counted rules are per service in either scope.
- **Offence scores** and the ladder's ban history sync every `syncInterval`:
  offences on two processes add up, and a reset after a ban reaches the
  others.
- `security.flush()` sends what waits for the store now; `close()` stops the
  timers and starts a last write (`flush()` waits for it); the store's own
  `close()` stops its hybrid sync and never closes the cache.
  `status().state.store` reports its health and queues.

`hybridThrottleStore(shared, { syncInterval })` is the `hybrid` mode as a
plain `ThrottleStore`, for any `throttle()`.

## WebSocket message limits

An HTTP limit sees the upgrade; the policy's `messages` section limits what
an open socket sends.

```ts
messages: {
  perConnection: { limit: 20, window: "1s" }, // a bucket of 2 × 20 (burst)
  limits: [{ id: "per-user", limit: 600, window: "1m", key: "user" }],
},
```

A message over a limit is dropped; a second breach within `breach` (10 s)
closes the connection with `closeCode` (1008; 1013 or 4000 to 4999 allowed).
`limits` take a limit's grammar and `state`, counted across every connection
of the subject (and across processes with a shared store; a `closed` store
failure closes 1013). On a bun-common route:

```ts
import { securityWebSocket } from "@kingsleyweb/bun-security/http";

app.ws("/live", securityWebSocket(security, handlers, {
  identify: (ws) => ({ user: ws.data.user?.id as string }),
}));
```

Messages are handed on in their order. Elsewhere, call
`security.socket(facts).message()` per message.

## Challenges

A `challenge` (a list entry's, a counted rule's, the ladder's 15-minute
step, a ban's, a request rule's, the bot signals') asks the client to prove
it is a browser with a person behind it before it goes on. Give the engine
a challenge flow from `@kingsleyweb/bun-security/challenge`:

```ts
import { challenges, powChallenge } from "@kingsleyweb/bun-security/challenge";

const security = createSecurity({
  policy,
  challenge: challenges({
    provider: powChallenge({ secret: process.env.POW_SECRET! }), // or turnstile(), hcaptcha()
    secret: process.env.CLEARANCE_SECRET!, // signs clearances: 32+ characters, the same on every instance
  }),
});
```

- **Without a flow** every `challenge` is a `block`, as it always was (the
  hit's reason says so).
- **A challenged browser** (HTML first in `Accept`) gets a small page under
  a strict CSP of its own (`default-src 'none'`, scripts by nonce and the
  provider's origin only, `form-action 'self'`). It posts the answer to
  `/__bun-security/challenge` (`path`), which verifies it and sends the
  browser back where it was going with a **clearance cookie**:
  HMAC-signed, `HttpOnly`, `SameSite=Lax`, `Secure` and `__Host-` over HTTPS,
  bound to the client's /24 (/64 for IPv6) and a hash of its `User-Agent`,
  valid 30 minutes (`ttl`). `page` renders your own page instead.
- **An API client** gets `403` problem+json, `code: "challenge_required"`,
  with `challenge: { provider, field, path, data }`. It posts
  `{ "answer": … }` as JSON to `path` and gets `{ clearance, header }`; it
  sends the token back in `x-security-clearance`.
- **A cleared client passes challenges, never blocks or bans**: the hit is
  logged ("challenge passed"), and a ban, a block list entry or a rule that
  blocks still refuses it.
- **Answers are signalled**: `challenge.passed` and `challenge.failed`, for
  a counted rule or the ladder's weights (`weights: { "challenge.failed": 1 }`
  climbs a bot that keeps failing to a ban).
- The answer endpoint is taken in the early stage under `installSecurity`
  and bun-nest's `SecurityModule` (before the body is read by anything
  else), by `withSecurity`, and by `securityMiddleware` alone. A blocked or
  banned client's answers are refused, not verified. Under bun-nest, a
  route-stage challenge (`SecurityGuard`) answers the same page or
  descriptor, as a `SecurityChallengeException`.

**Providers.** `powChallenge({ secret })` is the built-in proof of work, no
third party: ALTCHA's v1 wire format (its MIT widget can solve it), bound to
the client's network, single use, valid 5 minutes (`expiresIn`), harder as
the request's risk grows (`maxNumber`, default 50,000 tries at risk 0,
`riskFactor`, `maxNumberCap`). Pass the engine's shared store as `store`
and an answer is single use across processes too (the local cache decides
alone while the store fails). It slows a bot farm per request; it does not
stop a determined one. `turnstile({ siteKey, secret })` and
`hcaptcha({ siteKey, secret })` verify the widget's token at the provider
over `fetch` (an injectable `fetch`, a `timeoutMs`), checking `success`, the
`hostname` (the request's, or `hostnames`) and `action` when set; a network
failure fails the answer. Your own provider implements `ChallengeProvider`:
`issue(context)` and `verify(answer, context)`.

**Bot signals** (off unless the policy has a `botSignals` section) add to
a request's `risk`: `noUserAgent`, `libraryUserAgent` (curl, python-requests,
Go's, Java's, okhttp, axios, …), `headlessUserAgent`, `missingFetchMetadata`
(a browser's page request without `Sec-Fetch-Mode`, or any request on a
`browserPaths` route) and `clientHintsMismatch` (`Sec-CH-UA` beside a
User-Agent that is not Chromium's), each 1 point (`weights`, `0` for off).
None refuses alone; `challengeAt` challenges a request whose signals reach
it, and `mode: "dryRun"` only logs that. They read headers alone, so they
run in the early stage.

```ts
botSignals: { challengeAt: 2, browserPaths: ["/app/**"], weights: { headlessUserAgent: 2 } },
```

## IP intelligence

Country, ASN and classes such as `tor` and `hosting` for the policy's
`country` and `asn` list entries, its `country`, `asn` and `class`
conditions, and `botSignals.classes` (layers.md L5):

```ts
import {
  ipIntel,
  rangeFeed,
  TOR_BULK_EXIT_LIST_URL,
  torExitFeed,
} from "@kingsleyweb/bun-security/intel";

const intel = await ipIntel({
  databases: ["/var/lib/geo/GeoLite2-Country.mmdb", "/var/lib/geo/GeoLite2-ASN.mmdb"],
  feeds: [
    torExitFeed({ url: TOR_BULK_EXIT_LIST_URL }),
    rangeFeed({ id: "aws", class: "hosting", url: "https://ip-ranges.amazonaws.com/ip-ranges.json", format: "json", interval: "1d", minEntries: 1000 }),
  ],
  dir: "/var/lib/bun-security/ranges", // the last good copy of each feed, read back at start
});
intel.start(); // or call intel.refresh() from bun-jobs or your own scheduler

const security = createSecurity({
  policy: {
    lists: [{ country: "KP", action: "block" }, { asn: 64500, action: "challenge" }],
    requestRules: { rules: [{ id: "no-tor-logins", when: { all: [{ class: { equals: "tor" } }, { path: { prefix: "/login" } }] }, action: "block" }] },
    botSignals: { classes: { hosting: 1 } },
  },
  intel,
});
```

- **No data ships with the package.** Download the databases yourself and
  give their paths: MaxMind GeoLite2 Country and ASN (a free account and
  licence key, from maxmind.com; the GeoLite2 EULA asks for attribution and
  that old copies be deleted within 30 days of a new release), DB-IP Lite
  (CC BY 4.0, attribution and a link to db-ip.com), IPinfo Lite (CC BY-SA
  4.0, a free token), or a commercial database. Any MaxMind DB (`.mmdb`)
  file is read by the package's own reader; MaxMind's, DB-IP's and IPinfo's
  record shapes are understood, and `extract` reads any other. Replace the
  files on their release cadence (`geoipupdate` does it for MaxMind's) and
  call `intel.reload()`.
- **Classes come from range feeds** you configure (the URL is yours to
  choose; nothing is fetched until `start()` or `refresh()`) and from static
  `ranges` (`{ office: ["198.51.100.0/24"] }`). `format: "lines"` (one
  address or range per line, the Tor list's and Cloudflare's), `"json"`
  (every address or range anywhere in the document: AWS, Google Cloud,
  Azure, Oracle) or your own parser.
- **A bad copy never empties a class.** A feed's download is refused when it
  is not `200`, is larger than `maxBytes` (16 MiB), cannot be read, or holds
  fewer than `minEntries` ranges (100 for `torExitFeed`); the last good copy
  stays, a warning is logged, and the feed is tried again after `retry`
  (5 minutes). `intel.status()` shows each feed's state.
- **A whole country is never allowed**: a `country` entry takes any action
  but `allow` (the policy is refused, as an address allow wider than /8 is);
  allow its addresses or its ASNs instead.
- **A policy that needs what the engine cannot know is refused**:
  `createSecurity()` and `load()` throw when a policy uses `country`, `asn`
  or `class` without `intel`, when no database gives it, or when it names a
  class no feed or range provides.
- Lookups run only when the policy needs them, in the early stage, and are
  cached per process (`cacheSize`, 50,000 addresses).
## Verified crawlers

A search engine's crawler looks like a scanner at the edge: it walks every
link it has ever seen (many are dead), comes from a cloud's address space,
sends no browser headers, cannot solve a challenge. So the engine gives
**verified** crawlers an allowance (layers.md L3.2), on by default for
Google, Bing, Apple and DuckDuckGo, for `GET` and `HEAD` on every path:

- **Verification, never a header.** A request whose `User-Agent` carries a
  crawler's token (`Googlebot`, `bingbot`, `Applebot`, `DuckDuckBot`) is a
  claimant. It is verified when its address is in the crawler's published
  range file (`ranges`), or when its reverse DNS name ends in the crawler's
  domain (`googlebot.com`, `search.msn.com`, `applebot.apple.com`) **and**
  that name resolves back to the address (`rdns`); `ranges-then-rdns` by
  default. Range files come in as `./intel` feeds:
  `ipIntel({ feeds: crawlerFeeds(policy.crawlers) })`, given to
  `createSecurity({ intel })`. DNS is the host's (`node:dns`) unless you
  pass `resolver`; verdicts are cached (24 h verified, 1 h refuted), at most
  `maxPendingVerifications` (64) lookups run at once, and a claimant whose
  lookup takes over `verifyTimeoutMs` (500 ms) or fails is an ordinary
  client for that request.
- **What the allowance lifts** (`exempt`, every one by default):
  `notFound` (L14's not-found answers are not counted), `probeRules` (the
  managed probe set logs `crawler.probe` instead), `honeypots` (answered as
  usual, no score: `crawler.honeypot`), `botSignals`, `challenges` (never
  challenged), `hostingClass`, `geo` (country and ASN *block* entries; IP
  entries still apply), `perIpLimits` (replaced by the crawler's own
  `limit`, `"3000/1m"` per crawler across its addresses, answered `429`
  with `Retry-After`), `autoBans` (the ladder never bans it; an automatic
  ban of its address is skipped; a manual ban applies).
- **Never lifted**: request shape, the sensitive endpoints, canaries, your
  own IP entries, manual bans, other methods than its `methods`, paths
  outside its `paths`.
- **A spoofed claimant** (a crawler's token, failing verification) is
  `crawler.spoofed`: blocked and weighed 5 on the ladder by default
  (`spoofed: { action, weight }`). Give an SEO tool of your own staff a plain
  allow entry for its address.
- **The conflict check**: a refusing list entry or a manual ban that covers
  an allowed crawler's ranges raises a `crawler.conflict` warning at start
  and on `load()`; `security.crawlerConflicts()` lists them once the range
  feeds have loaded.
- Every decision on a claimant carries `crawler: { id, verified,
  verifiedBy, spoofed }`. `mode: "dryRun"` lifts nothing and records, on a
  refused verified crawler, that the allowance would have let it in;
  `mode: "off"` looks at no claimant.

```ts
crawlers: {
  allow: ["google", "bing", "apple", "duckduckgo"], // also google-special, yandex, baidu, or your custom ids
  paths: { exclude: ["/api/**"] },
  limit: "3000/1m",
  custom: [{ id: "acme", tokens: ["AcmeBot"], rdns: ["crawl.acme.example"] }],
},
```

AI and LLM crawlers are not in the registry's default set: add them as
`custom` entries if you choose to let them in.

## API keys

bun-security watches the API keys your service issues; it never issues or
stores them (layers.md L12). Tell it the key's **id** (never the key) in
`identify()`: `{ apiKey: "key_123", apiKeyPlan: "pro", apiKeyMaxAddresses: 50 }`.

- **Keyed by HMAC.** Everything the engine keeps about a key (limits, bans,
  counts, the shared store, a decision's `subject.apiKey`) is keyed by
  `HMAC(secret, id)`, as usernames are. With a shared store, give every
  process the same `secret` (a store without one refuses to start). List
  entries and `ban({ apiKey })` still name the id.
- **Per-key limits**: `key: "apiKey"` (or `["apiKey", "route"]`), and
  `apiKeyPlan` for a plan's limit, which counts only keys `identify()` puts
  on that plan:

  ```ts
  limits: [
    { id: "free", limit: 60, window: "1m", key: "apiKey", apiKeyPlan: "free" },
    { id: "pro", limit: 1200, window: "1m", key: "apiKey", apiKeyPlan: "pro" },
  ],
  ```
- **Anomalies** (`apiKeys`, off unless named): `newAsn`, a key used from an
  autonomous system it never used (its first is learned; needs `intel` with
  an ASN database; ASNs remembered for `remember`, 30 days), and
  `manyAddresses`, a key used from more than `limit` distinct addresses in
  `window` (20 an hour; `apiKeyMaxAddresses` per key, `false` for none).
  Each counts an event (`apiKey.newAsn`, `apiKey.manyAddresses`, once per
  key and anomaly or window) and does its `action`: `log`, `tag` (the
  default: the decision's `tags` carry `api-key:new-asn` or
  `api-key:many-addresses`), `challenge`, or `ban` (the key suspended for
  `duration`, 1 h). With a shared store the fleet watches each key once.
  `mode: "dryRun"` only records.
- **Revoking is your job; the engine covers the gap.** An anomaly that bans,
  and `security.revokeApiKey(id, { reason, by, duration })` (a ban until
  lifted by default), call your `onKeyCompromised({ apiKey, reason, detail,
  ban, at })`, so your service revokes the key and tells its owner.

```ts
const security = createSecurity({
  policy: { apiKeys: { newAsn: { action: "challenge" }, manyAddresses: { limit: 50, action: "ban" } } },
  secret: process.env.SECURITY_SECRET,
  intel,
  onKeyCompromised: ({ apiKey, reason }) => keys.revoke(apiKey, reason),
});
```

## Presets

A policy gets built-in rules without writing them, each with an id
(`PRESETS` lists them), and switches each in `presets`:

- `true`: on, **as it ships** (enforced, or in dry run for the presets that
  ship in dry run, `not_found_per_minute` and `login.failure-rate`). Leaving
  a preset out is the same as `true`.
- `"enforce"`: on and enforced, whatever mode it ships in.
- `false`: off.

Any other value is refused. A rule of the policy's own with a preset's id
replaces the preset.

```ts
presets: { "per-ip": false, not_found_per_minute: "enforce" },
limits: [{ id: "per-user", limit: 300, window: "1m", key: "user" }], // replaces the preset
```

- **On**: `per-ip` (600 a minute per address and route) and `per-user`
  (1,000 a minute per user), enforced; and the sensitive endpoints' rules,
  which count only on routes marked with their profile: `login.account`
  (10 a minute per address and attempted username), `login.ip` (30),
  `login.ip-failures` (20 failures in 15 minutes: a challenge) and
  `login.ip-failures-ban` (50: a one-hour ban); `mfa.account`, `mfa.ip`,
  `mfa.failures`; `otp.ip`, `otp.ip-hour`, `otp.destination` (3 in ten
  minutes), `otp.destination-day`, `otp.prefix` (100 an hour per country
  and area code, against SMS pumping); `reset.ip`, `reset.ip-hour`,
  `reset.destination`; `signup.ip`.
- **On, in dry run**: `not_found_per_minute` (120 route-not-found answers a
  minute: a day's ban), which records the bans it would make. A verified
  crawler's not-found answers are not counted.
  `presets: { not_found_per_minute: "enforce" }` enforces it, `false` turns
  it off. And `login.failure-rate`, the global failure-rate rule (see
  [Sensitive endpoints](#sensitive-endpoints)): it records what it would
  answer and raises its warning; `"enforce"` answers.
- **Beside them**: `crawler`, the verified crawlers' own limit (see
  [Verified crawlers](#verified-crawlers)).

## Sensitive endpoints

A route's profile names it a sign-in (`login`), a second factor (`mfa`), a
code sent (`otp`), a password reset (`reset`) or a sign-up (`signup`):
`securityProfile("login")` in `./http`, `@SecurityProfile("login")` in
bun-nest, `withSecurity`'s `profile` option. A limit or counted rule with
`profile` counts only there; `identify()` adds the attempted `username` or
the code's `destination`, which are keyed by their HMAC under
`createSecurity`'s `secret` (at least 32 bytes; required with a shared
store, the same in every process sharing it), never kept in clear.

```ts
const security = createSecurity({
  policy,
  secret: process.env.SECURITY_SECRET,
  identify: (req) => ({ username: req.body?.email }),
});
app.post("/login", securityProfile("login"), uniformAuthResponse(), login);
// in the handler, or let the answer's status say it (401/403 failure, 2xx success):
security.signal(requestSecurity(req).facts, "auth.failure");
```

The login defences (`profiles.login`, on by default on routes marked
`login`; `false` turns them off):

- **Per attempted username**: after 5 failures in 15 minutes each attempt
  waits 1 s, then 2 s (`maxDelay`, §0.1's 2 s bound), whatever its outcome;
  at 10 a challenge (the challenge flow's, a pass with a clearance; `429`
  without a flow); at 20 a soft lock for 15 minutes (`429`, clearance or
  not), which refuses the username from every device without a valid
  **device cookie** for it, so the owner's known device keeps signing in.
  `security.unlock(username)` lifts it.
- **Device cookies**: a success issues a signed `__Host-bun-security-device`
  cookie (a year); requests carrying one for the username count their
  failures apart. `installSecurity` and `withSecurity` set it;
  `security.deviceCookie(facts)` gives it to an app that answers itself.
- **Credential stuffing**: 10 distinct usernames failing from one address in
  an hour challenge it (a challenge ban), 30 ban it for an hour (distinct counts, through the
  shared store's `pfAdd` when there is one).
- **Password spraying**: 10 distinct addresses failing one username in an
  hour tag its requests `step-up` (`decision.tags`), for the app to require
  a second factor; a request carrying a valid device cookie for the
  username is not tagged, so the owner's known device signs in as usual.
- **A success from an address with 10 failures** is tagged `risky-success`
  and raises the `login.risky-success` warning.
- **The global failure-rate rule** (the `login.failure-rate` preset, on in
  dry run): a spray that uses a fresh address and a fresh username for every
  attempt repeats no key, so none of the above sees it. This counts the
  route's sign-in outcomes across every client, in the shared store, and
  trips when at least 20 of the last 5 minutes' attempts failed and the
  failure ratio is 3 × the route's own baseline (the 24 hours before the
  window, taken as at least 5 %; the threshold at most 90 %). A ratio, so a
  surge of ordinary sign-ins trips nothing. While tripped, and for 5 minutes
  after, it answers the attempts from a `hosting` address (IP intelligence)
  or a new device (no device cookie for the username): `respond:
  "challenge"` (the default), `"tag"` (`step-up`) or `"limit"` (a stricter
  limit per ASN, or for every hosting address). A sign-in with a valid
  device cookie for its username is never answered, whatever `to` says
  (`all` and a hosting address included), so the owner's known device
  keeps signing in, as with the password-spraying `step-up`. It raises the
  `login.failure-rate` warning as it trips, and `security.status()
  .loginFailureRate` shows each route's ratio and baseline. As it ships it
  only records what it would answer: turn it on with
  `presets: { "login.failure-rate": "enforce" }` once a challenge flow is
  set up (without one, a challenge is a `429`).

  ```ts
  profiles: {
    login: {
      failureRate: { window: "5m", baseline: "24h", factor: 3, minFailures: 20, hold: "5m",
        respond: "limit", to: ["hosting"], limit: { attempts: 10, window: "1m", by: "asn" } },
    },
  },
  ```
- **Outcome inference**: when the app signals neither `auth.failure` nor
  `auth.success` for a request, a `401` or `403` counts as a failure and a
  `2xx` as a success (`inferOutcome: false` turns it off).

`uniformAuthResponse({ minResponseMs })` (in `./http`) makes a marked route's
failures (`400`, `401`, `403`, `404`, `409`, `422`) one `401` problem
("Login failed") and holds every answer to at least 300 ms, so neither the
status, the body nor the time tells a missing account from a wrong password.

**Identifier checks**, where data is created (`security.check()`, D24):

```ts
await security.check(facts, "email", email); // in the code that creates the account or invite
```

throws a `SecurityRefusal` (`400`, `invalid_identifier`, one generic
message) for an email, phone number, username or domain matching an
`identifiers.patterns` entry (`*` and `?`, at least 4 literal characters),
a reserved domain (`example.*`, `.test`, `.invalid`, `.localhost`,
`.example`) or the operator's `ownDomains`; a match counts `pattern.hit`
under the request's client, so a counted rule can ban it. A job with no
request passes `undefined`. `check(facts, "password", password)` asks
`createSecurity`'s `breachedPassword` hook and refuses a breached password.

## Testing your policy with simulated attacks

`./testing` has the attacks this package defends against as request lists,
and a runner that sends them to your app and reports what happened. They
measure outcomes (each answer's status, the refusals and their problem
codes, where the first refusal came), never speed, and need no network: the
target is your app's socket-free `fetch()` (`fetchTarget`) or a
`withSecurity` handler (`handlerTarget`).

```ts
import { createSecurity } from "@kingsleyweb/bun-security";
import { credentialStuffing, fetchTarget, paced, pathScan, runAttack } from "@kingsleyweb/bun-security/testing";

let now = Date.now();
const security = createSecurity({ policy, secret, now: () => now });
// … installSecurity(app, security) and the app's routes …

const result = await runAttack(credentialStuffing({ path: "/auth/login", count: 1000, everyMs: 3000 }), fetchTarget(app), {
  advance: (ms) => { now += ms; }, // a six-hour attack runs in milliseconds
  settle: () => Bun.sleep(0),      // let each answer's outcome reach the engine first
});
expect(result.firstRefused).toBeLessThanOrEqual(10);

// The negative control: the same attack, the defence off, succeeds.
```

| Simulator | The attack |
|---|---|
| `credentialStuffing` | leaked username and password pairs from one address |
| `distributedGuessing` | one account's password guessed from many addresses |
| `passwordSpraying` | one password against many accounts, from a pool of addresses |
| `lowAndSlow` | attempts spread over hours, under any per-minute limit |
| `accountEnumeration`, `probeAnswers`, `enumerationLeaks` | telling real accounts from missing ones by status, body or time |
| `pathScan` (`PROBE_PATHS`) | ffuf-style probing of well-known paths, then a burst of dead links |
| `ipv6Rotation`, `addressRotation` | one client rotating addresses: inside one IPv6 /64, or Tor exits |
| `keyCardinalityFlood` | thousands of addresses, one request each, to swell the state tables |
| `burst` | many requests from one address at once, or `everyMs` apart |
| `forwardedForSpoof` | a client claiming another address in `X-Forwarded-For` |
| `crawl`, `spoofedCrawler` (`CRAWLER_USER_AGENTS`) | a search-engine crawler, verified or spoofed |
| `disposableSignups` | sign-ups with disposable addresses |
| `apiKeyAbuse` | one API key used from many addresses (a leaked key) |
| `crossSitePosts` | cross-site form posts with the victim's cookies |

A request may carry `at` (ms from the attack's start): `runAttack`'s
`advance` moves your fake clock there rather than waiting. `paced(attack,
everyMs)` spaces an attack's requests, `sequence(name, ...attacks)` runs
several one after another. The runner counts as refused any `403`, `429`
or `503`, any problem+json answer with a `code` except a `401` (a failed
sign-in made uniform is the app's answer), and a dropped connection (status
`0`, code `dropped`); `refused` replaces that test. `staticCrawlerResolver`
verifies crawlers from fixed DNS records, and `nthAddress` and
`ipv6InPrefix` give distinct public addresses (never an internal range,
which the engine lets past most layers).

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

## A policy from a file or a store

`createSecurity`'s `policy` can name a policy kept in a security store
(`./store`) instead of holding one, and the engine follows it as it changes
(storage.md §6 in the plan):

```ts
import { createSecurity } from "@kingsleyweb/bun-security";
import { policyFile, sqliteStore } from "@kingsleyweb/bun-security/store";

// GitOps: a reviewed JSON file in the app's repository, reloaded when it changes.
const security = createSecurity({
  policy: { store: policyFile("./security.json"), lastKnownGood: "./.security-lkg.json" },
});
await security.ready(); // the file's policy is in force

// Or published versions in a SQLite file several processes share.
const shared = createSecurity({ policy: { store: sqliteStore({ path: "./security.sqlite" }), id: "checkout" } });
```

- **Following.** The engine loads the policy's head version, then follows the
  store's change feed: pushed where the store can (`policyFile`,
  `memoryStore`), polled every 250 ms where it cannot (`sqliteStore`,
  `pollIntervalMs`), and reconciled with the head every 60 s whatever the feed
  said (`reconcileIntervalMs`).
- **A refused version is never swapped in.** A version that does not compile
  leaves the last known good policy in force, raises one `policy.refused`
  warning, and is not retried; the next good version loads. A failing store
  raises `policy.unavailable` once and changes nothing.
- **Last known good on disk** (`lastKnownGood: path`): every policy the
  engine accepts is written there atomically, mode `0600`, and read first at
  start, so a restart during a store outage enforces what was enforced
  before. Without it, the engine starts on an empty policy until the store
  answers; `ready()` resolves once the store has been tried.
- `security.status().policySource` says which version is in force, whether
  it came from the last-known-good file, what was refused, and whether the
  store is failing.

### The store

A security store holds documents with revisions (services, groups, operators,
list entries, … by kind), each policy's published versions with a head moved
by compare-and-set, and a change feed every write appends to in the same
transaction:

```ts
const store = sqliteStore({ path: "./security.sqlite" });
const read = await store.get("service", "checkout");
const written = await store.put("service", "checkout", { owner: "payments" }, read?.revision ?? null);
if (!written.ok) console.log("changed meanwhile:", written.conflict); // re-read and retry

await store.appendVersion("checkout", { id: "v2", policy, createdBy: "ann" }, "v1"); // ok: false if the head moved
const page = await store.list("service", { limit: 50, sort: "updatedAt", direction: "desc" });
const next = await store.list("service", { limit: 50, sort: "updatedAt", direction: "desc", cursor: page.next });
const { changes, head } = await store.changesSince(0n, 100);
```

| Store | Durable | Processes | Change feed | Notes |
|---|---|---|---|---|
| `memoryStore()` | no | one | pushed | tests, examples, one process |
| `sqliteStore({ path })` | yes | several on one host (WAL) | polled | bun-sql's SQLite dialect; `syncSchema` on connect or by call; a `codec` encodes every body at rest ([sealing secrets](#sealing-secrets-at-rest)) |
| `postgresStore({ url })` | yes | several, on several hosts | pushed (`LISTEN`/`NOTIFY`; polled while `LISTEN` cannot be set up) | bun-sql's Postgres dialect; writers take a per-store advisory lock so the change sequence commits in order and no reader skips a change; ids listed by code point whatever the database's locale; `syncSchema` and `codec` as SQLite's |
| `policyFile(path)` | the file | one | pushed (file watching) | read-only: one policy, every write refused |

- **Optimistic concurrency.** Every `put` names the revision it read (`null`:
  it must not exist yet); a stale one answers `{ ok: false, conflict }` with
  the document as it is now. `appendVersion` names the head it was based on
  the same way. Two writers never both win.
- **Pages** are keyset pages: `next` is an opaque cursor bound to its walk
  (the kind, sort, direction and prefix); used with another walk it is
  refused, never read as page one.
- **`./testing`** has `runSecurityStoreConformance(name, factory, options)`,
  the `bun:test` suite every store passes (and a third-party one must), with
  a two-process race for a `multiProcess` store, and `faultyStore(store,
  { fail, delayMs })` for testing what an engine does when its store fails.

### Sealing secrets at rest

`@kingsleyweb/bun-security/sealing` seals the secrets a store keeps (an
agent's HMAC secret, a webhook's URL and signing secret, a break-glass TOTP
seed), so a copy of the database, a dump or a backup does not hold them in
clear. It needs the optional peer `@kingsleyweb/bun-cache`, whose
`./encryption` envelope it uses (AES-256-GCM under a key derived per seal):

```ts
import { sealedFields } from "@kingsleyweb/bun-security/sealing";
import { postgresStore } from "@kingsleyweb/bun-security/store";

const codec = sealedFields({
  keys: [
    { id: "2026-11", key: process.env.STORE_KEY_2026_11! }, // seals: openssl rand -base64 32
    { id: "2026-10", key: process.env.STORE_KEY_2026_10! }, // still opens
  ],
});
const store = postgresStore({ url: process.env.SECURITY_STORE_URL!, codec });
```

- **Field by field.** Only the named fields are sealed; every other field
  stays as it was, so the store's lists and filters, and a person reading
  the table, still see what a record is. At rest a sealed field is
  `{ "$sealed": "<base64url>" }`.
- **What is sealed by default** (`DEFAULT_SEALED_FIELDS`): `agentKey.secret`,
  `serviceIdentity.secret`, `alertChannel.url` and `alertChannel.secret`,
  `operator.totpSeed`. Policies and bundles are not: they hold no secret (a
  service identity's `verifier` is its token's SHA-256, and the bundle
  signing key never reaches the store), and the control plane diffs and
  reviews them. `fields: { doc: { <kind>: ["path", "list.*.field"] }, policy:
  [...], bundle: [...] }` replaces the default; a `*` stands for every element
  or property.
- **Bound to its place.** A sealed value opens only in the table, kind,
  document id, version and field (array indexes included) it was sealed
  for. Copied to another row or field by someone with write access to the
  database, it is refused, and the read rejects with a `SealedFieldError`
  (`reason`: `"auth"`, `"unknown-key"`, `"malformed"`, `"unsealed"`) that
  names the place and the key id, never a value. A plain value planted in a
  sealed field is refused too, unless `acceptUnsealed: true`, which is for
  a store that held its secrets before sealing was turned on. What sealing
  does not stop: someone who can write the database putting back an
  **earlier** value of the same field of the same row.
- **Rotation.** Put the new key first: it seals every write from then on,
  and the old keys keep opening what they sealed. `await resealStore(store,
  codec)` then rewrites each document still sealed under an older key (or
  holding a plain value, with `acceptUnsealed`) at the revision it read,
  which uses a revision and a change per document; one changed in between is
  counted as a conflict and left as its writer sealed it. Once it reports
  nothing left, drop the old key.
- **Keys** come from the environment or a secret manager, never from the
  store they protect. The codec is synchronous: resolve a KMS's keys before
  building it, and build a new codec (and store) to take a new ring.

## Events and analytics

`@kingsleyweb/bun-security/analytics` turns decisions into the numbers and
events an analytics page reads, without letting an attack's volume, or a
credential, reach the store.

```ts
import { createSecurity } from "@kingsleyweb/bun-security";
import {
  analyticsHook,
  createAnalyticsRecorder,
  createEventRing,
  createRedactor,
} from "@kingsleyweb/bun-security/analytics";

const recorder = createAnalyticsRecorder({ service: "api" });
const ring = createEventRing({ service: "api", recorder });
const security = createSecurity({
  policy,
  secret: process.env.SECURITY_SECRET!,
  onDecision: analyticsHook({ recorder, ring, redactor: createRedactor() }),
});
// Each second: ring.take(500) and recorder.flush() make an agent's batch.
```

- **Counters** (`createAnalyticsRecorder`), per minute: requests by action,
  by route, by rule (and dry run), by country, by ASN (200 a minute, then
  `(other)`), answers by status class, a decision-latency histogram. Exact
  refusals per subject per day (`refused`), and each minute's 100 most
  refused and busiest subjects by space-saving (`top.refused`,
  `top.requests`). At most 2,000 rows a minute; past any bound a value is
  counted under `(other)` and the overflow under `analytics.overflow`.
- **Events** (`createEventRing`): every refusal, challenge or dry-run hit,
  and one `allow` in a thousand. At most 10 a minute per subject and rule,
  30 per subject, 600 per rule, 1,000,000 a day; past a cap the request is
  only counted (`events.capped { cap }`, with an `events.capped` warning at
  most once a minute), and the ring holds 10,000 (`events.dropped`).
- **What an event keeps** (`createRedactor`): the method; the route's
  template, or the path with credential-looking segments as `:redacted`;
  the query and the headers with sensitive names (`password`, `token`,
  `key`, `session`, `cookie`, … by substring, any case) and
  credential-looking values (a JWT, `Bearer …`, a card number, a long key)
  as `[redacted]`; a JSON or form body the same way, 4 KB in all, and only
  its field names on a `login`, `mfa`, `otp`, `reset` or `signup` route;
  any other body its type and length only. The answer keeps its status and
  headers, and a body only when the engine answered itself.
- **Subjects** are the engine's keys: the address, the API key's HMAC and
  the username's HMAC. A raw user id is never kept; with `userKey`, the
  app's own key of it is. A list entry's default id, which names its key
  or user, is rewritten the same way.
- **At the control plane**: `createSecurityApi({ agentEvents: {
  authenticate } })` adds `POST /agent/events`: on an adapter that defers
  bodies (`secureAdmin`'s does), the agent is authenticated in a `use`
  middleware while the request's body stream is still unread (measured on a
  real socket; what the runtime has already buffered is not covered, and an
  adapter that reads bodies before routing has read it first), each agent
  is rate limited, the body is at most 1 MiB as sent and 8 MiB unpacked,
  and a batch is stored once by its id (`ingestEventBatch`).
  `analyticsMaintenance(store).start()` rolls minutes into hours and hours
  into days, and deletes by retention (events 14 days, minutes 7, hours 90,
  days 400; at most 90, 30, 400 days and 5 years), on a timer or from a
  bun-jobs schedule.
- **In the store** (`./store`): `appendEvents`, `addCounters`,
  `listEvents`, `series`, `topK`, `rollup`, `deleteBefore` on
  `memoryStore`, `sqliteStore` and `postgresStore`
  (`capabilities.analytics`). A counter for an hour already rolled up is
  added to it too, so a late batch is never lost from the rollups.

## The control plane's management API

`./control` is the control plane (control-plane.md in the plan): services,
groups and sibling-service identities, a policy per scope with drafts,
published versions and inheritance, signed bundles per service, approvals
and roles. It runs on an admin listener, never on a protected service's
public one.

```ts
import {
  createSecurityApi,
  fileCheckpointSink,
  secureAdmin,
} from "@kingsleyweb/bun-security/control";
import { sqliteStore } from "@kingsleyweb/bun-security/store";

const api = createSecurityApi({
  store: sqliteStore({ path: "./security.sqlite" }),
  authenticate: (req) => sessions.operatorOf(req), // your SSO or login; null for nobody
  owners: ["op_alice"],                            // the first owner, from configuration
  stepUp: { verify: (req, op) => mfa.isFresh(req, op), challenge: () => "/mfa" },
  signing: { keyId: "sk_2026_11", privateKey: process.env.BUNDLE_SIGNING_KEY! }, // Ed25519
  audit: {
    signing: { keyId: "ak_2026_11", privateKey: process.env.AUDIT_SIGNING_KEY! }, // another Ed25519 key
    sinks: [fileCheckpointSink("/var/log/security/checkpoints.jsonl")],
  },
});
const admin = await secureAdmin({ port: 9443, api }); // 127.0.0.1 unless told otherwise
```

- **Scopes and inheritance.** A policy is kept per scope: `global`,
  `group:<id>` (groups nest up to 4 deep) and `service:<id>`. A service's
  effective policy is global ← its groups, outermost first ← its own:
  objects merge by key, limits, counted rules, request rules and list
  entries by `id` (a lower scope overrides one, or turns it off with
  `{ id, mode: "off" }`), lists union. An item marked `locked: true` cannot
  be overridden below it. `GET /services/:id/effective` shows the result
  with each field's origin.
- **Drafts and publishing.** `PUT /policies/:scope/draft` saves a draft by
  the revision read (a stale one is a `409` with the current draft); it must
  compile over the scopes above it. `POST /policies/:scope/publish` names
  the head it was based on (`409` if someone published meanwhile), appends a
  version, and recompiles and signs the bundle of every service under the
  scope. `rollback` publishes an older version's content as a new version.
- **Dangerous changes** (a rule from dry run to enforced on production, an
  action raised, an allow entry added or widened, the ladder changed) need
  the scope's name typed in `confirm`, or with `approvals: "two-person"` a
  second operator's approval (`202` with the approval; never its author;
  24 hours). `emergency: true` publishes at once and opens a review.
- **Step-up**: publishing, rollback, identities and role bindings need the
  host's fresh second factor (`stepUp.verify`; a `401` with
  `stepUp.challenge`'s URL otherwise). Without a hook, `approvals:
  "two-person"` makes each of them an approval; `allowWithoutStepUp: true`
  runs without either. With none of the three, `createSecurityApi` throws.
- **Who may do what**: `authenticate` is required. The built-in roles
  (`viewer`, `analyst`, `operator`, `admin`, `owner`) are bound per scope in
  the store (`/role-bindings`), a binding on a group covering its services,
  with `owners` bound from configuration; or pass `authorize(operator,
  permission, { scope })` and use your own model. `GET /meta/permissions`
  answers each permission for a scope, for the UI to hide what it may not
  use.
- **CSRF**: every mutation carries `x-bun-security-csrf` (any value) and
  passes the Fetch Metadata and `Origin` check (`csrf: false` for an API no
  browser uses).
- **Bundles**: `bun-security.bundle/1`, the effective policy signed with
  Ed25519 over its canonical JSON, a version per service that only grows, and
  an expiry (`bundleTtl`, 7 days) past which an EP warns but keeps
  enforcing. `GET /services/:id/bundle` answers it with an `ETag`.
  `verifyBundle(bundle, { [keyId]: publicKey }, { service, after })` (in `.`
  and `./bundle`) is what an EP checks: a tampered bundle, an unknown key,
  another service's, an older one (a replay) and one not yet valid are
  refused. `bundlePublicKey(privateKey)` gives the PEM to deploy to EPs.
- **Lists** are cursor pages (`limit` up to 200, `cursor` the last page's
  `next`, a cursor of another list a `400`); `GET /live` streams
  `policy.published`, `bundle.compiled`, `approval.created` and
  `approval.decided` (server-sent events) to operators who may read the
  scope; `/openapi.json` and `/asyncapi.json` document it all.
- `./control/contract` holds the wire types, permission and role names and
  problem codes, browser-safe with no runtime import, for a UI or client.

### The audit log

Every change through the API is recorded in a hash chain in the store:
each entry's hash is SHA-256 of the previous hash and the entry's
canonical JSON (who, from which address, the request's id, the permissions
checked, whether a step-up was proven, the target, and the state before
and after or the policy's diff).

- **Intent first.** Before a change, an `intent` entry is appended. If it
  cannot be written (after three tries), the change is refused with `503
  audit_unavailable` and nothing changes: no change exists without a trace.
  After the change, a `done` entry names the intent (`applied`, or
  `refused` and why). If the done cannot be written the change stands, and
  the answer carries `x-bun-security-audit: incomplete`. `GET /audit` and
  `verify` reconcile an intent with no done against the store:
  `completed-unconfirmed` (the change is there) or `not-applied`; never
  tampering.
- **Checkpoints.** Every 1,000 entries or hourly (`checkpointEvery`,
  `checkpointInterval`), the head is signed with the **audit key**, an
  Ed25519 key of its own (the bundle key is refused), kept in the store
  and written to each **sink**: `fileCheckpointSink(path)` (JSON Lines,
  read back by `verify`), `webhookCheckpointSink({ url, secret })`
  (signed `x-bun-security-signature: sha256=<hex>` over
  `<x-bun-security-timestamp>.<body>`), or `callbackCheckpointSink({ write,
  read? })`. One sink at least, or `allowNoExternalCheckpoints: true`. A
  sink that fails never blocks a change: the checkpoint is retried with the
  next, and `onAlert` hears `checkpoint.sinkFailed`.
- **`verifyAudit()`** (and `GET /audit/verify`) recomputes the chain and
  checks every checkpoint, stored and read back from the sinks, naming the
  first entry where it broke: `hash-mismatch` (edited), `gap` (deleted),
  `order` (moved), `truncated` (the end cut off), `anchor` (the oldest kept
  entry vouched for by nothing), `checkpoint-signature` (forged) or
  `checkpoint-mismatch`. A failure alerts `audit.verifyFailed`. Run it on a
  schedule.
- **Refusals**: a signed-in operator refused for a permission or a step-up
  is recorded (`access.refused`, with the permission, scope, route and
  target). Unauthenticated and cross-site requests are only logged, so
  anonymous traffic cannot grow the chain.
- **Reading**: `GET /audit` (filters `actor`, `action`, `scope` (a group
  includes its descendant groups and their services, as a role binding
  does), `since`, `until`; cursor pages), `/audit/:n` and `/audit/checkpoints` need
  `audit:read` (analyst and up); `GET /audit/export` (JSON Lines, itself
  recorded) needs `audit:export` (admin and up) and a step-up.
- **Retention** is the host's scheduled job, never a route:
  `api.purgeAudit({ before })` deletes entries older than `before`, only up
  to the latest checkpoint older than it, so the oldest kept entry stays
  anchored, and records the purge. The plan keeps 400 days.

### Break-glass

For when the identity provider is down during an incident, one local
account, off unless configured:

```ts
createSecurityApi({
  // ...
  breakGlass: {
    passwordHash: process.env.BREAK_GLASS_PASSWORD_HASH!, // Bun.password.hash(...)
    totpSecret: process.env.BREAK_GLASS_TOTP_SECRET!,     // base32, an authenticator app's
  },
  onAlert: (alert) => pager.send(alert), // breakGlass.login is critical
});
```

`POST /break-glass/session` with `{ password, code }` (TOTP, RFC 6238:
SHA-1, 6 digits, 30 s, a step either side; each code once) answers a token
valid 15 minutes, sent back in `x-bun-security-break-glass`. Its holder
acts as `owner` on `global` (the host's `authenticate` and `authorize` are
not asked), its step-up fresh for the first 5 minutes. Five failures lock it
for 15 minutes. The failures and the used codes are kept in the store, so
every control-plane instance on it shares the lock and refuses a code
another used. Attempts while locked are logged, not audited. Every login and failure is audited; a login also alerts
(`breakGlass.login`), goes out on `/live` (`breakGlass.used`) and is logged
at error level. A login whose audit entry cannot be written is refused.

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
no state written (limits are read with the throttle's `peekCount()`, and layer L1
as for a tracked request), plus how the client was resolved and every check
made. `onDecision(decision, facts)` sees every
`evaluate()` decision.
