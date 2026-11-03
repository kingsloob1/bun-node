# Transports: the 2026-11-02 spikes

Spikes for the 2026-11-02 revision of [`../../README.md`](../../README.md) and
its sub-plans ([`websocket.md`](../../websocket.md),
[`webrtc.md`](../../webrtc.md), [`graphql.md`](../../graphql.md)). A
standalone Bun project, like `../`: its own `package.json` (exact pins) and
`bun.lock`, installed here only, not in the workspaces or
`scripts/typecheck.ts`. The spikes that import `@kingsleyweb/bun-common`
resolve it from the repository root's `node_modules`, so run `bun install`
at the root too.

```bash
cd docs/plans/typed-client/evidence/transports
bun install --frozen-lockfile
```

`trustedDependencies` lists `node-datachannel`, though it runs no install
script: its native binary comes as a prebuilt optional dependency
(`@node-datachannel/linux-x64-gnu` here).

| Directory | Question | Run | Result |
|---|---|---|---|
| `ws-typing/` | What does typing WebSocket channel messages cost the type checker, inferred from `channelContract()` specs against a generated plain map? | `bun ws-typing/gen.ts && bun ws-typing/measure.ts` (a tsc loop: through the heavy-run wrapper) | `results.txt`: at 200 channels × 16 messages, tsc 6.0.3 checks the inferred client in 6.61 s against 3.92 s for the specs alone and 1.25 s for a generated map; `bun --check` 324 / 121 / 60 ms. A planted wrong field type fails `bun --check` (the negative control) |
| `http-typing/` (PR-C2) | What does the HTTP client cost the type checker, typed from `RoutesOf` over `defineRoutes` registries against the map bun-client's generator writes from the same routes' OpenAPI document (TC §3.1)? | `bun http-typing/gen.ts && bun http-typing/measure.ts` (a tsc loop: through the heavy-run wrapper, exclusive) | `results.txt`: at 1,000 routes, tsc 6.0.3 checks the inferred client in 17.52 s (1,360 MB) against 7.79 s for the registries alone and 7.16 s (327 MB) for the generated map; `bun --check` 1,817 / 280 / 208 ms. At 200 routes: tsc 5.70 / 3.62 / 1.25 s, `bun --check` 406 / 156 / 56 ms. Generating 1,000 routes took 297 ms (607 KB). A planted wrong param type fails `bun --check` in both clients (the negative control) |
| `webrtc/` | Can a Bun process be a WebRTC peer, and can signalling and data-channel messages be typed and validated with the contract core? | `bun webrtc/spike.ts` (or one pair: `ndc-ndc`, `werift-werift`, `ndc-werift`) | `results.txt`: Bun has no `RTCPeerConnection`; node-datachannel opens in ~121 ms and carries 1,000 checked messages in ~19 ms, werift in ~360 ms and ~1,140 ms, across in ~217 ms and ~13–20 ms; invalid and undeclared messages refused by the guards; trickle candidates must wait for the remote description |
| `graphql/` | What does a typed GraphQL call cost in a browser bundle, and what does gql.tada's inference cost a type check? | `bun graphql/size.ts`; `bun graphql/tada.ts` (wrapper) | `size-results.txt`: our thin call 0.3 KB gz, gql.tada + its parser 3.4, graphql-js 11.4, urql 10.5. `tada-results.txt`: 50 operations check in ~2.2–2.5 s of tsc or ~350 ms of `bun --check`, independent of the schema's size (50 or 200 types). `documents.ts` (PR-G1, 2026-11-03; `bun graphql/documents.ts`) → `documents-results.txt`: which documents carry `loc.source.body` (gql.tada's operations do not, its fragments do; graphql-js's and graphql.web's `parse` do) and what bun-client's `createGraphQLClient` sends for each, with no `print` and with either library's |
| `contract-reuse/` | Can the client reuse bun-common's browser-safe contract core for its checks? | `bun contract-reuse/size.ts` | `results.txt`: the guards and `channelContract` bundle at 19.2 KB min, 6.8 KB gzip, with no `node:`, `bun:` or `Bun.` marker; the whole entry 9.0 KB gzip |

Measured on Bun 1.4.4-canary.1+11c367163, TypeScript 6.0.3 (and 7 through
`bun --check`), linux-x64, 2026-11-02. A conclusion here is as old as the
file: re-run before relying on it. `bun --check` runs with `CLAUDECODE`,
`AGENT` and `REPL_ID` removed from its environment (CLAUDE.md, "Bun's
checker, not tsc").
