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

How to run: against a Nest version copy from `scripts/nest-matrix.ts`
(`~/bun-node-nest-matrix/<version>`, the repo's CLAUDE.md "Nest versions"),
`bun probe.ts > out<major>.json` and `bun probe2.ts`, from a directory whose
`node_modules` resolves that copy's `@nestjs/*`. bun-node-15 holds the exact
invocation; it is not part of any gate.
