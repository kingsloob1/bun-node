# Typed client: evidence

Spikes for [`../../typed-client.md`](../../typed-client.md) and
[`../../nest-typed-routes.md`](../../nest-typed-routes.md). Throwaway code,
not a package: nothing here is in `scripts/typecheck.ts` or the workspaces,
and several files contain intentional type errors behind `@ts-expect-error`.

Third-party packages are installed **here only** (`package.json`, exact
pins; `node_modules/` is git-ignored by the root `.gitignore`). Run
`bun install` in this directory first. The spikes that import
`@kingsleyweb/bun-common` / `@kingsleyweb/bun-nest` resolve them from the
repository root's `node_modules`, so run `bun install` at the root as well.

| Directory | Question | Run |
|---|---|---|
| [`inference/`](inference/README.md) | Can a route map type accumulate on the real `BunRouter` (patched copy) or a registry, and what does it cost tsc at 50/200/1000 routes, with declaration emit? | `bun patch-router.ts && bun gen.ts && bun measure.ts` (heavy) |
| [`codegen/`](codegen/README.md) | The route model from today's statement-style routes, a generated `.d.ts`, its parity with inference, its cost at scale; generated Zod (size, cost, what survives JSON Schema) | `bun generate.ts`, `bun scale.ts`, `cd zod && bun measure.ts` |
| [`sync/`](sync/README.md) | Live sync: edit a route, time until the client's types file changes (`--hot`, `--watch`, polling) | `bun e2e.ts` |
| [`swr-core/`](swr-core/README.md) | A dependency-free SWR core (465 lines) and a React binding: dedupe, SWR, focus/online, retries, optimistic rollback, tags, GC, hydration, ETag/304, structural sharing, infinite; 27 tests | `bun test swr-core` |
| [`bundle-size/`](bundle-size/README.md) | Minified/gzip/brotli of our spike core against query-core and its five adapters, swr, nanoquery, openapi-fetch, ky, and client-side validators | `bun bundle-size/measure.ts` |
| [`nest/`](nest/README.md) | Nest controllers → the same route model through DiscoveryService, on bun-nest; a guarded dev endpoint | `cd nest && bun explore.ts` (from that directory) |

Measured on Bun 1.4.3 (`bbdc5a519`), TypeScript 6.0.3 (7.0.2 for the
swr-core type check), linux-x64, 2026-10-10. A conclusion here is as old as
the file: re-run before relying on it.

**Note for anyone re-running with `CLAUDECODE` set:** Bun 1.4.3's test runner
then prints only failures and the summary; `swr-core/results.txt` was
captured with `env -u CLAUDECODE`.
