# Inference: does a route map type flow from BunRouter, and what does it cost?

```bash
cd docs/plans/evidence/typed-client/inference
bun patch-router.ts && bun gen.ts && bun measure.ts      # ~5 min; a heavy job: run it through the heavy-run wrapper
```

Backs `../../../typed-client.md` §3.1. Measured 2026-10-10, Bun 1.4.3
(`bbdc5a519`), TypeScript 6.0.3, zod 4.6.5, linux-x64, through the heavy-run
wrapper (`HEAVY_TICKET=e6-typedclient-inference`), median of 3 runs.

## What is here

| File | What it does |
|---|---|
| `patch-router.ts` | Copies the **real** `packages/bun-common/lib` into `.patched/` (git-ignored) and changes only types: a 4th class parameter `TRoutes = {}`; every generated typed verb overload (25 blocks × 10) returns `BunRouter<…, TRoutes & RouteEntry<VERB, \`${TMountPath}${TPath}\`, TShape>>` instead of `this`; the two typed `use(path, subRouter)` overloads infer the sub-router's routes and intersect them. The patched library typechecks clean (`tsc -p tsconfig.patched-lib.json`, exit 0) |
| `spike-types.ts` | `v()` (= `validate()` plus the input types and the declared responses the client needs), `Jsonify`, the flat `"VERB /path"` client (openapi-fetch style), and the v2 registry builder `defineRoutes()` with a named-operation client (tRPC style) |
| `gen.ts` | Generates `out/<variant>-<N>/` for N = 50, 200, 1000: modules of 50 routes, each route with its **own** zod schemas (params, query, body on POST/PUT) and two declared responses. Route 0 of each module carries an `@ts-expect-error` proving the handler's `req` is still narrowed; each client carries positive checks and `@ts-expect-error` negative controls (wrong query type, no such route) |
| `measure.ts` | `tsc --extendedDiagnostics` per project, then declaration emit (`--declaration --emitDeclarationOnly`), then the client checked against the emitted `.d.ts` instead of the sources |
| `probes/statements.ts` | Can statement-style registration accumulate without chaining? (Assertion signatures: yes, but not usable for BunRouter; see below) |

Variants: **v0** is today (statements on the real router, no route map, no
client); **v1** is the patched router, chained, sub-routers mounted with
`use()`; **v2** is no router change: `defineRoutes()` registries.

## Results (`results.txt`)

```
variant    N     exit  check_s  total_s  mem_MB  instantiations  types    | dts: errors           app.d.ts  own.d.ts | client-vs-dts: exit check_s
v0         50    0        2.03     2.84     306          437464    93265   | none                       122       246  | -
v1         50    0        2.92     3.76     394          662739   141518   | none                     57629    107401  | 0 3.03
v2         50    0        2.49     3.59     300          461226    94897   | none                     72706    130165  | 0 2.18
v0         200   0        3.15     4.11     423          658800   131473   | none                       122       618  | -
v1         200   0        3.89     4.91     500         1072761   192881   | none                    229853    428803  | 0 3.42
v2         200   0        2.96     4.04     385          748319   137049   | none                    290641    520339  | 0 2.22
v0         1000  0        6.92     8.09     843         1838640   335137   | none                       122      2622  | -
v1         1000  0       10.30    11.48     973         3305145   466817   | none                   1148881   2143967  | 0 4.72
v2         1000  0        7.07     8.08     928         2277551   361641   | none                   1453471   2602287  | 0 1.77
```

- **Every project exits 0**, so every negative control fired: the types flow
  through the real class, handlers stay narrowed, and wrong calls are errors.
- **v1 (accumulating router) costs +49% check time at 1000 routes** (10.3 s
  against 6.9 s) and +1.47 M instantiations: the intersection is re-examined
  at every chained call. **v2 (registry objects) costs +2%** (7.07 s).
- **No TS7056 / TS2742 / TS4023** under declaration emit at any size, even
  with a 1.1 MB (v1) or 1.45 MB (v2) `app.d.ts`. (oRPC documents TS7056 for a
  single big exported router; the per-module exports here stay under it.)
- **A client checked against the emitted declarations is cheap**: 1.8 s for
  v2 at 1000 routes, 4.7 s for v1 (Hono's "precompile the client type" advice
  holds here too).
- Most of v0's cost is the routes themselves (1000 handlers with their own
  zod schemas, contextually typed through 10 overloads each).

## The statement-style probe (`probes/`, `tsc -p probes`)

`router.get(...)` as a statement cannot accumulate when the method returns a
type. An `asserts this is …` method **does** narrow the variable statement by
statement, and a `typeof` type query at the end of the module sees the
narrowed type (exported and imported in `import-side.ts`). It is still not an
option for BunRouter: the variable needs an explicit annotation (TS2775), an
assertion method must return `void` (so no chaining, no `.describe()`, no
`.setName()`, breaking today's `this` return), and the narrowing stops at
function boundaries: routes registered in `registerUsers(app)` never reach
the caller (`b2` in the probe).

## Finding: input or output types for query and params

`z.coerce.number()` has input type `unknown` in zod 4. Typing a client's
`query` from the schema's **input** accepted `{ page: "x" }`; the negative
control caught it. Query and params cross as strings and are coerced, so the
client sends the **output** value types (but with the input's optionality: a
key with a default may be omitted). Bodies use the input type.
