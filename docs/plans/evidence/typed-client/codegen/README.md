# Generation: the route model, a generated `.d.ts`, generated Zod

```bash
cd docs/plans/evidence/typed-client/codegen
bun generate.ts && ../../../../../node_modules/.bin/tsc -p .     # model → routes.gen.ts, then the client check
bun scale.ts                                                        # the generated map at 50/200/1000 routes
cd zod && bun measure.ts && bun jitless.ts && bun roundtrip.ts     # generated Zod: size, cost, what survives
```

Backs `../../../typed-client.md` §3.2, §4 and §6. Bun 1.4.3, zod 4.6.5,
2026-10-10.

## Files

| File | What it does |
|---|---|
| `describe.ts` | `dv()`: `validate()` plus the schemas and declared responses attached to the middleware as non-enumerable properties (what api-docs-generation.md Decisions 2 and 4 put in bun-common). `buildModel(router)`: walks `router.routes()`, finds those properties, converts with `~standard.jsonSchema` (no vendor import), hashes the canonical JSON (sha-256, 16 hex) |
| `app.ts` | Six routes on the **real, unpatched** BunRouter written as statements, including a sub-router mounted at `/orgs/:org` and a route with no validator |
| `emit-dts.ts` | A ~90-line JSON Schema → TypeScript emitter producing `export interface Routes { "GET /users/:id": { operationId; params; query; body; responses } }`: the same map shape as the inference path |
| `routes.gen.ts`, `model.json` | The generated output (committed so a reader can see it) |
| `client-types.ts`, `client-check.ts` | The flat client over the generated map, positive and `@ts-expect-error` checks, and a **parity** check: generated type `===` `Jsonify<z.output<schema>>` for a representable schema, with a negative control for a `z.date()` |
| `zod/emit-zod.ts` | Route model → runtime Zod source, classic (`zod`) or mini (`zod/mini`); loose objects so a newer server's extra fields pass |
| `zod/measure.ts` | Bundle size of the generated schemas, and the cost of validating a response |
| `zod/jitless.ts` | Generated classic with `z.config({ jitless: true })`, as under a CSP without `'unsafe-eval'` |
| `zod/roundtrip.ts` | What survives server schema → JSON Schema (`roundtrip.txt`) |

## Results

`bun generate.ts` (`results.txt`): 6 routes, model 9–18 ms, emit 0.6–2 ms,
2.3 KB, and two warnings: `GET /legacy` has no validator, and
`GET /orgs/:org/members/:id` has a `z.date()` in its response, which JSON
Schema cannot represent: the model falls back to `{}` and the generated type
is `unknown`, where inference (through `Jsonify`) gives `string`. `tsc -p .`
is clean, so every client check and negative control held.

What the walk found about `routes()` [measured]: a mounted sub-router's
routes come back with the **full** path and `group` set to the mount path; a
`use()` layer has no `path`; an `all()` route has no `method`. The model keys
on path presence, not method.

`scale-results.txt` (the synthetic app of `zod/synthetic.ts`, the inference
spike's schema shapes; a client file of three calls with a negative control,
checked alone with `lib: ["ESNext", "DOM"]`):

```
N=50: model 47 ms, emit 3 ms, routes.gen.ts 26093 B; client check exit 0, check 0.16 s, memory 94 MB, instantiations 2239
N=200: model 88 ms, emit 6 ms, routes.gen.ts 104923 B; client check exit 0, check 0.24 s, memory 112 MB, instantiations 6289
N=1000: model 297 ms, emit 22 ms, routes.gen.ts 527163 B; client check exit 0, check 0.75 s, memory 150 MB, instantiations 27889
```

A client over a **generated** map of 1000 routes checks in 0.75 s and
150 MB, against 1.8 s (registry) and 4.7 s (accumulating router) checked
against emitted declarations, and 7 to 10 s checked against the server's
sources (`../inference/`). Building the model is the expensive half at scale
(~0.2 to 0.3 s for 1000 routes, nearly all of it `~standard.jsonSchema`).

`zod/results.txt`:

```
size classic 1 route: 89136 min / 25191 gz; 50 routes: 103226 min / 26226 gz; per extra route ≈ 21 B gz; eval-free: false
size mini    1 route: 22600 min / 7379 gz; 50 routes: 37287 min / 8866 gz; per extra route ≈ 30 B gz; eval-free: true
cost JSON.parse of the body (reference) 10.70 µs/op
cost server schema (zod classic)        14.83 µs/op
cost generated classic (zod)            21.99 µs/op
cost generated mini (zod/mini)          37.48 µs/op
cost @cfworker/json-schema              195.07 µs/op
failure: [{"target":"response","message":"Invalid email address","path":"items.3.email"}]
cost generated classic, jitless          34.54 µs/op
```

The body is a 20-user list (≈1.7 KB of JSON). The per-route bytes are a
floor: the synthetic routes repeat one shape and gzip folds them; distinct
real schemas cost more [I]. zod classic carries `new Function` (its JIT);
under a CSP without `'unsafe-eval'` it runs at the jitless speed.

`zod/roundtrip.txt`, what crosses JSON Schema (zod 4.6.5):

| Server schema | Input | Output | Consequence for a generated client schema |
|---|---|---|---|
| `.refine()` (cross-field) | dropped **silently** | dropped silently | the client check is weaker than the server's; no warning is possible from the JSON |
| `.transform()` | the input type | **throws** | output described as unknown + warning |
| `z.custom()` | throws | throws | unknown + warning |
| `.brand()` | dropped (plain string) | dropped | the type loses its brand |
| `z.date()` | throws | throws | unknown + warning (use `z.iso.datetime()` for wire types) |
| `.pipe()`, `.default()`, regex/length, discriminated union | kept | kept | faithful |
| recursive (getter) | `$ref: "#"` | `$ref: "#"` | needs `z.lazy`; this emitter does not handle it yet |
