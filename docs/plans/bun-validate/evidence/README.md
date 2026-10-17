# bun-validate evidence

Backs [`../README.md`](../README.md). Recorded 2026-10-15 on `develop` at
`73bf4a00` (`contract-core/` and `http-complete/` on 2026-10-17 at
`68023d36`), with the installed Bun 1.4.4-canary.1 (`7583003d8`). Nothing here
is part of a package, and no project the repo checks includes this folder:
the probes carry deliberate `@ts-expect-error` controls, and
`response-typing/responses.spike.ts` only compiles against a patched copy of
bun-common.

Run everything from this directory. It has its own `tsconfig.json`
(extending the repo's base, so the decorator options Nest needs apply; Bun
reads them from the cwd, oven-sh/bun#28605). Packages resolve through the
repo's root `node_modules`, so run `bun install` at the root first.

| File | Run | Recorded in | Pass condition |
|---|---|---|---|
| `audit-runtime.ts` | `bun audit-runtime.ts` | `results-runtime.txt` | prints R1–R9; the plan quotes each line |
| `audit-types.ts` | `env -u AGENT -u CLAUDECODE -u REPL_ID bun --check` | `results-types.txt` | exits 0, **and** the same file with every `@ts-expect-error` line removed fails 7 times (the recorded negative control) |
| `vendors-sync.ts` | `bun vendors-sync.ts` | `results-vendors.txt` | prints sync/Promise, `~standard.jsonSchema` and µs per check for six vendors |
| `response-check-proto.ts` | `HEAVY_TICKET=<you>-proto /tmp/claude-1000/bun-node-heavy-run.sh nice -n 10 timeout 900 bun response-check-proto.ts` | `results-proto.txt` | P1a/P1c/P1e answer 500, P1b and P1d 200; P2 is a benchmark: read the minimums, and the load average it prints |
| `nest-schema-dto.ts` | `bun nest-schema-dto.ts`, then `NOPIPE=1 bun nest-schema-dto.ts` | `results-nest.txt` | with the pipe: N2 and N4 are 400; without (the control): both pass, with strings typed as numbers; the type controls fail 2 times when removed |
| `response-typing/run.sh` | `bash response-typing/run.sh [scratch-dir]` | `response-typing/results.txt` | a, c: no errors; b: 9 errors in `zz-mutant`; d: errors (the unpatched base); e: both generated files "up to date" |
| `contract-core/` (2026-10-17) | `cd contract-core && bash check-types.sh`, then `bun run.ts` | `contract-core/results.txt` | the clean check exits 0 and the mutant fails on exactly the 24 control lines ("PASS: every control fires"); C1–C22 as `contract-core/README.md` lists |
| `http-complete/run.sh` (2026-10-17) | `bash http-complete/run.sh [scratch-dir]`; `BENCH=1` adds the cost run through the heavy-run wrapper | `http-complete/results.txt` | b: no errors; c: 19 errors in `zz-mutant`; d: 1 error, bun-jobs' `ProblemIssueDto`; e: errors (the unpatched base); f: both generated files "up to date"; g: H1–H52 as `http-complete/README.md` lists; h: the same 3 location-caused failures patched and unpatched |
| `nest-interceptor/` (2026-10-17, bun-node-15) | see `nest-interceptor/README.md` (against a `scripts/nest-matrix.ts` copy of Nest 11 or 12) | `nest-interceptor/out11.json`, `out12.json` | the rows of the plan's §4.5.4 table; `@Body({ schema })` without the pipe answers 201 |

`AGENT`, `CLAUDECODE` and `REPL_ID` are removed for every `bun --check`
because they switch its output to a multi-line format for agents (the repo's
`CLAUDE.md`, "Bun's checker, not tsc").

## `response-typing/`

AD §3.7's response typing (the [api-docs-generation plan](../../api-docs-generation/README.md)),
re-applied to today's bun-common as `response-typing.patch` (four files, 78
added lines), with the correction the plan's §4.3 describes: `json()` takes a
schema's **input** type, or its **output** when the input is `unknown`.
`run.sh` copies `packages/bun-common` and `packages/bun-nest` into a scratch
directory (default `~/.cache/bun-node-ae/plan-validate/spike-rt`), points the
copy's `node_modules` at the patched bun-common, applies the patch and runs
the five checks. It deletes nothing outside that directory.

`responses.spike.ts` started from AD's `responses.ts` and `boundaries.ts`
(`../../api-docs-generation/evidence/`) and adds an inline validator,
preceding plain handlers, `replace: false`, a `Date`-typed schema, a
body-less status, a sub-route's own validator under a mount, a legacy
four-argument `TypedRouteHandler`, and a zod case.

## Re-running and what a number is worth

The probes are cheap and deterministic, apart from `response-check-proto.ts`
and `vendors-sync.ts`, which time things. `results-proto.txt` was recorded
while another session's job held the machine at a load of 35 to 41 on 16
cores: its medians are noisy, so the plan quotes its minimums. Re-run it
through the heavy-run wrapper before relying on a figure.
