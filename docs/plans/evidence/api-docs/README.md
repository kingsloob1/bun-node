# API-docs spikes

Backs the feasibility claims in `../../api-docs-generation.md`. These contain
**deliberate type errors** — that is the point of most of them — so they are
kept out of every project the repo typechecks.

## Two kinds

**Standalone** — run against the repo's own dependencies:

| File | Question | Answer |
|---|---|---|
| `chained-builder.ts` | Can a chained `.describe()` constrain a handler already passed to `.get()`? | **No.** Even given the most generous builder, a wrong-shaped response produces no error. Enforcement after the fact is impossible by construction |
| `emit-decorator-metadata.ts` | Does Bun honour `emitDecoratorMetadata`? | **Yes.** `design:type` emits `String`/`Number`/`Boolean`/`Date`/`Inner`/`Array`; `getMetadataKeys` returns `["design:type"]` |
| `class-validator.ts` | Does the full class-validator + class-transformer stack work under Bun? | **Yes.** `plainToInstance` coerces `"42"` → `42`, nested `@Type(() => Address)` produces a real instance, `validate()` returns per-property constraints |

**Patched-library** — require a copy of `packages/bun-common` with the response-type
changes from §3.7 applied (`TypedRouteHandler` gaining `TRes`, `BunResponse`
gaining `TResponses`, `ValidationShape` gaining `responses`, `MountedHandler`
threading it). Drop them in that copy's `spike/` and add `"./spike/**/*"` to its
`include`:

| File | Asserts |
|---|---|
| `responses.ts` | The positive path plus four `@ts-expect-error` cases: wrong body for a declared status, an undeclared status, a body matching neither member of a union, and a mounted sub-router's declared shape |
| `boundaries.ts` | The **escape hatches**, as compile-*must-pass* assertions — `res.send()`, `res.jsonp()` and `helper(res)` taking a bare `BunResponse` are uncaught, and a later change that closes one should be deliberate |
| `chained.ts` | The `.describe()` impossibility above, against the real class rather than a model of it |
| `nestdec.ts` | A Nest method decorator **can** constrain a return type but **cannot** retype a parameter |

## How to read the result

`tsc -p` exiting **0** is the pass condition for the whole set, because an
unsatisfied `@ts-expect-error` is itself an error (TS2578). So one clean run
proves both that the patched library compiles and that every negative control
fires. A green run with the controls deleted proves nothing — if you edit these,
keep the controls.

Run them the way the project does, with its own `tsconfig`. Passing files on the
command line drops the project's `types: ["bun"]` and produces a cascade of
unrelated errors in `lib/` that look alarming and mean nothing.
