# @kingsleyweb/bun-security

A request-defence engine for Bun services. It decides every request locally,
from a policy compiled once, before your handler sees it.

> **Being built.** This is milestone M1's first part (PR-S1) of the
> [bun-security plan](../../docs/plans/bun-security/README.md): the engine,
> client identity, service identity, the trust check, allow and deny lists,
> and the plain `Bun.serve` integration. Rate limits, bans, request rules,
> challenges, the bun-common and bun-nest integrations, shared state and the
> control plane follow in later PRs.

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
asks the engine, and answers a refusal itself: `403` problem+json
(`{ type, title, status, code }`, never the rule's name), a minimal HTML page
for a browser, `renderBlock`'s answer if you pass one, or for `drop` no answer
at all (the connection closes). If the engine throws, the request goes
through and the error is logged; `failClosedOnEngineError: true` answers
`503` instead.

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

## The policy

A policy is plain data. `compilePolicy(policy)` validates it and compiles it
(a CIDR trie for addresses, maps for users and keys); it throws a
`SecurityPolicyError` listing every issue. Unknown keys are refused (keys
starting with `$` are ignored), a duration needs its unit (`"5m"`,
`{ minutes: 5 }`), and a timestamp its time zone. `securityPolicySchema` is
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

`evaluate()` is synchronous while every rule is local (all of them today);
its type allows a promise for the store-backed rules to come. `explain()` is
the same decision with no state written, plus how the client was resolved
and every check made. `onDecision(decision, facts)` sees every
`evaluate()` decision.
