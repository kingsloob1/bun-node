# What a Nest interceptor sees, on Nest 11 and 12

Recorded by bun-node-15 (the bun-nest agent) on 2026-10-17, reviewing the
plan's §4.5, and copied here from its scratch directory so the plan's claims
cite files in the repo. Run on Nest 11.1.27 and 12.1.3, each on
`ExpressAdapter` and bun-nest's `BunHttpAdapter`; all four gave identical
results.

| File | What it records |
|---|---|
| `probe.ts` | an interceptor's view in `map()` (status, headers, `headersSent`) against what went on the wire, for GET, POST, `@HttpCode`, `@Header`, `@Redirect`, `@Res({ passthrough })`, plain `@Res()`, `StreamableFile` and `@Sse`; the interceptor → pipe → handler order; `@Body({ schema })` with and without `StandardSchemaValidationPipe`; `@RawBody({ schema })` with `validateCustomDecorators`; the serializer's placement |
| `probe2.ts` | the `@Sse` cases: a synchronous first event against an asynchronous one |
| `out11.json`, `out12.json` | the outputs on Nest 11.1.27 and 12.1.3 |
| `out-sse.txt` | `probe2.ts`'s output on both majors and both adapters, re-run by bun-node-11 on 2026-10-17: a synchronous bad first event is a 500; a later one an `event: error` carrying the message verbatim |

How to run, one directory per Nest major (Nest is never installed into
them; each has a `node_modules` symlink). Bun reads decorator options from the
**cwd's** `tsconfig.json` (oven-sh/bun#28605, `docs/bun-bugs/`), so run from
inside each directory:

```bash
# from this folder; first, from the repo root: bun scripts/nest-matrix.ts --prepare 12.1.3
mkdir -p v11 v12
cp probe.ts probe2.ts tsconfig.json v11/ && cp probe.ts probe2.ts tsconfig.json v12/
ln -s "$(git rev-parse --show-toplevel)/node_modules" v11/node_modules   # Nest 11.1.27 until nestjs-12-parity PR-3
ln -s ~/bun-node-nest-matrix/12.1.3/node_modules v12/node_modules
(cd v11 && bun probe.ts > ../out11.json && bun probe2.ts)
(cd v12 && bun probe.ts > ../out12.json && bun probe2.ts)
```

`probe.ts` reads the major from `@nestjs/core/package.json`; `probe2.ts` (the
`@Sse` cases) prints to stdout. Delete `v11/` and `v12/` afterwards. It is not
part of any gate.
