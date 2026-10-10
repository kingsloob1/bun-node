# Spike: measured bundle sizes

```bash
cd docs/plans/evidence/typed-client && bun bundle-size/measure.ts
```

Throwaway evidence for the typed-client plan. It measures what each candidate
data layer, fetch wrapper and response validator adds to a browser bundle, so
the plan argues from bytes rather than from READMEs.

## Results

Bun 1.4.3 (bbdc5a519), linux/x64, 2026-10-10. Repeated runs give identical bytes.
`min` is the minified output, `gzip` is `Bun.gzipSync` level 9, `brotli` is
`node:zlib` quality 11. `eval` is a grep of the output for `new Function(…)` or
`eval(…)`.

| case | versions | min | gzip | brotli | eval |
|---|---|---:|---:|---:|---|
| spike core (`../swr-core/core.ts`) | (local) | 7,425 | 2,982 | 2,743 | no |
| spike core + React binding | (local) | 7,759 | 3,206 | 2,926 | no |
| `@tanstack/query-core` | 5.104.1 | 37,289 | 10,542 | 9,606 | no |
| `@tanstack/react-query` | 5.104.1 | 39,600 | 11,571 | 10,480 | no |
| `@tanstack/vue-query` (+ `vue-demi` 0.14.10) | 5.104.1 | 39,718 | 11,503 | 10,444 | no |
| `@tanstack/svelte-query` | 6.3.1 | 37,386 | 10,944 | 9,947 | no |
| `@tanstack/solid-query` | 5.104.1 | 38,255 | 11,347 | 10,340 | no |
| `@tanstack/preact-query` | 5.104.1 | 36,535 | 10,693 | 9,675 | no |
| `swr` | 2.5.1 | 16,987 | 7,522 | 6,837 | no |
| `@nanostores/query` + `nanostores` | 0.3.4 / 1.5.5 | 7,390 | 3,417 | 3,130 | no |
| … + `@nanostores/react` | 2.0.1 | 8,292 | 3,872 | 3,525 | no |
| `openapi-fetch` | 0.17.0 | 6,890 | 2,730 | 2,406 | no |
| `ky` | 2.2.0 | 31,715 | 10,971 | 9,916 | no |
| `zod` (classic) | 4.6.5 | 87,277 | 24,774 | 22,000 | **yes** |
| `zod/mini` | 4.6.5 | 18,653 | 6,379 | 5,761 | no |
| `valibot` | 1.5.0 | 5,584 | 2,028 | 1,822 | no |
| `@cfworker/json-schema` | 4.1.1 | 22,629 | 6,168 | 5,541 | no |
| `ajv` (runtime compile) | 8.20.0 | 123,864 | 38,221 | 33,765 | **yes** |
| `ajv` standalone (precompiled validator) | 8.20.0 | 8,580 | 1,786 | 1,535 | no |

`results.txt` is the script's own output, including the external imports left
in each bundle (proof the framework stayed out).

**`@tanstack/preact-query` exists**: `npm view @tanstack/preact-query version`
→ 5.104.1, released in step with the rest of TanStack Query, peer `preact
^10`. It is installed and measured above (with `preact` 10.29.8 pinned to
match that peer range; it is external, so the pin does not affect the bytes).

## Method

- One generated entry per case in `entries/` (regenerated on every run; read
  them to see exactly what was imported). Each imports the realistic surface
  and **calls** it inside an exported function or component, so tree-shaking
  cannot drop it — a bare import would measure nothing.
- `Bun.build({ target: "browser", format: "esm", minify: true })`, with
  `process.env.NODE_ENV` defined as `"production"` so development-only
  warnings are stripped as a real production build would.
- **The UI framework is external**: `react`, `react-dom`, `vue`, `svelte`,
  `solid-js`, `preact` and their subpaths (`react/jsx-runtime`,
  `svelte/internal/client`, `solid-js/web`, `preact/hooks`, …). The numbers are
  the data layer's own cost on top of a framework the app already ships.
  `vue-demi`, a tiny re-export shim `@tanstack/vue-query` depends on, is
  bundled and counted.
- `@tanstack/svelte-query` 6 ships uncompiled `.svelte` and `.svelte.js`
  (runes) files, so `measure.ts` carries a small Bun plugin compiling them with
  `svelte/compiler` 5.57.2 (`generate: "client"`), as the Vite plugin would.
- Entries (what each one uses):
  - **spike core**: `createQueryClient`, `watch` + `subscribe`, `mutate` with an
    optimistic snapshot and `invalidateTags`, `invalidate`, `dehydrate`/`hydrate`,
    `infiniteQuery(...).fetchNextPage`, a conditional (ETag) fetcher.
    **+ React**: `QueryClientProvider`, `useQuery` (plain and `suspense`),
    `useMutation`.
  - **query-core**: `QueryClient` (+ `mount`), `QueryObserver`,
    `InfiniteQueryObserver`, `MutationObserver`, `dehydrate`, `hydrate`,
    `focusManager`, `onlineManager`.
  - **react-query**: `QueryClient`, `QueryClientProvider`, `useQuery`,
    `useSuspenseQuery`, `useInfiniteQuery`, `useMutation`, `HydrationBoundary`.
  - **vue / svelte / solid / preact-query**: the minimal surface — client,
    provider (`VueQueryPlugin` for Vue), `useQuery`/`createQuery`, and
    `useMutation`/`createMutation`. So these sit lower than react-query's row
    partly because they import less (no suspense, infinite or hydration).
  - **swr**: `useSWR`, `SWRConfig`, `preload`, `useSWRMutation`
    (`swr/mutation`), `useSWRInfinite` (`swr/infinite`).
  - **nanostores**: `nanoquery` → a fetcher store, a mutator store with
    `invalidate`, `listen`; then the same plus `useStore` from
    `@nanostores/react`.
  - **openapi-fetch**: `createClient<paths>`, a middleware via `use`, `GET` with
    a path param, `POST` with a body. **ky**: `ky.create` with `baseUrl`,
    `retry`, `timeout` and a `beforeRequest` hook, `get().json()`, `post({ json })`.
  - **validators**: the same 10-field shape everywhere — integers, strings, a
    boolean, an enum, an optional bounded integer, a string array, a nested
    object, and an array of objects containing an array of objects — then one
    parse of a sample. `zod` builds it with `z.object`/`z.number().int()`/…,
    `zod/mini` with the functional API (`z.optional`, `.check(z.minimum(0))`),
    `valibot` with `v.object`/`v.pipe`, and `@cfworker/json-schema` and `ajv`
    validate the equivalent JSON Schema object (draft 2020-12 for cfworker).

## Notes for the "validate responses on the client" question

- **zod classic contains `new Function`.** It probes `new Function("")` in a
  `try` and, when allowed, JIT-compiles object parsers. Under a CSP without
  `'unsafe-eval'` the probe fails and zod falls back to the interpreted path
  (the probe itself can still raise a CSP violation report);
  `z.config({ jitless: true })` skips it. **`zod/mini` contains no
  `new Function`** in its bundle, and is about a fifth of the size.
- **ajv's runtime `compile` requires `'unsafe-eval'`**: it generates the
  validator's source and builds it with `new Function`, which a strict CSP
  forbids. **Standalone mode avoids it**: `ajv/dist/standalone` emits the
  validator as plain ESM at build time (`entries/ajv-standalone-validator.js`,
  no `require`, no `new Function`), and the browser ships only that — 1,786 B
  gzip for this schema, the smallest row here. The price is a build step per
  schema, and the size grows with the schema rather than staying fixed.
- **valibot** is the smallest general-purpose validator here (2,028 B gzip for
  this schema) because each function is its own tree-shakeable export.
- **`@cfworker/json-schema`** validates a JSON Schema at runtime without code
  generation, so it is CSP-safe and needs no build step; at 6,168 B gzip it
  costs about what `zod/mini` does.
