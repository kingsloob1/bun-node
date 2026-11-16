# @kingsleyweb/bun-security

A request-defence engine for Bun services. It decides every request locally,
from a policy compiled once, before your handler sees it.

> **Being built.** This is milestone M1's first two parts (PR-S1, PR-S2) of
> the [bun-security plan](../../docs/plans/bun-security/README.md): the
> engine, client identity, service identity, the trust check, allow and deny
> lists, rate limits on bun-common's throttle foundation, counted rules,
> connection limits, outcome signals, and the plain `Bun.serve` integration.
> Bans with escalation, request rules, challenges, the bun-common and bun-nest
> integrations, shared state and the control plane follow in later PRs.

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
status (`403`, `429` for a limit, `503` past the in-flight cap) and
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
  refused: `action: "ban"` (the default, `403`) or `"challenge"` (a block until
  challenge providers land), for `duration` (`Retry-After` says how long), or
  with `duration: null` until the rule is removed or turned off. The tripping
  request is refused too.
- `key`, `routes` and `mode` work as for limits. Counters live in the same
  `throttleStore` (a fixed window from the first occurrence); trips are kept
  in a bounded local table.
- A verified sibling service is exempt by default; `appliesToServices: true`
  counts and refuses the end user it forwards instead (ConcaveHR's sign-in
  proxy), never the service itself.

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

Every table of local state (trips, in-flight requests, the default store's
counters) is bounded by `maxKeys`; past it the oldest entry is dropped, counted
in `security.status().state.evictions`, and a `state.evictions` warning goes to
`onWarning` and the logger.

## The policy

A policy is plain data. `compilePolicy(policy)` validates it and compiles it
(a CIDR trie for addresses, maps for users and keys); it throws a
`SecurityPolicyError` listing every issue. Unknown keys are refused (keys
starting with `$` are ignored), a duration needs its unit (`"5m"`,
`{ minutes: 5 }`), and a timestamp its time zone. `version: 1` names the
format; a policy without one reads as version 1, and a higher version is
refused with an error saying the policy is newer than this package (rather
than a list of unknown keys), so an older service tells a newer policy from a
broken one. `securityPolicySchema` is
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
