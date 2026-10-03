# Bun bugs bun-node works around

Each entry is Bun behaviour that differs from a standard or from what
bun-node needs, with a minimal reproduction that uses no bun-node code. A
reproduction exits **1 while the behaviour is present and 0 once it is
fixed**, so re-running them after a Bun upgrade (`bun docs/bun-bugs/<file>.ts`)
says which workaround can go. Each report names the code that works around
it and the test that guards it.

| Report | Bun | Upstream | Worked around in |
|---|---|---|---|
| [A served HEAD response loses the implicit `Content-Type` its GET gets](./head-response-loses-implicit-content-type.md) | 1.4.2 | not filed | `BunResponse` `#canSkipHeaders` |
| [`new Response(string).headers` has no `Content-Type`](./response-headers-miss-body-content-type.md) | 1.4.2 | not filed | `toFetchResponse` (socket-free `fetch()`) |

Found earlier, while planning native routes, and filed upstream; their
reproductions live with that plan's evidence
([`docs/plans/evidence/bun-native-routes/bun-repros/`](../plans/evidence/bun-native-routes/bun-repros/),
discussed in [§14 of the plan](../plans/bun-native-routes.md#14-bun-behaviour-worth-reporting-upstream)):

| Report | Bun | Upstream |
|---|---|---|
| `routes` matches the raw request target while `req.url` is normalised | 1.4.3-canary.1 | [oven-sh/bun#44176](https://github.com/oven-sh/bun/issues/44176) |
| `routes` build time is quadratic, lookup linear, in sibling count | 1.4.3-canary.1 | [oven-sh/bun#44177](https://github.com/oven-sh/bun/issues/44177) |
| `/mid/:a-:b` is accepted and reports `{ b: "1-2" }` | 1.4.3-canary.1 | [comment on oven-sh/bun#41363](https://github.com/oven-sh/bun/issues/41363#issuecomment-5880415977) |

## Adding one

1. A `<slug>.ts` reproduction: Bun only, prints `Bun.version` and
   `Bun.revision`, prints what it saw, exits 1 while the bug is present.
2. A `<slug>.md` report: the table at the top (Bun version, upstream status,
   reproduction, where it is worked around), what happens, why it is a bug
   (the standard or contract it breaks), and what to remove once it is fixed.
3. A row in the table above.
