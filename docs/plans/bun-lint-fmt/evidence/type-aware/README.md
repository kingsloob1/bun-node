# The answered config, with and without `--type-aware`

Measured 2026-10-17 on **Bun 1.4.4-canary.1+5f5799ed1**, on develop
`930dd664`, on the 16-core machine (load 2.6 to 3.7, recorded in
[`timings.txt`](timings.txt)). Develop has moved on since (`56d6afde`, #401 among
the merges); nothing here was re-measured on it.

## How it was run

1. A scratch clone of develop at `930dd664` under
   `~/.cache/bun-node-e8/agents/lintplan/native/`, `bun install
   --frozen-lockfile` at the root, in `templates/compute-provider/` and in the
   two `bench/` directories (the type-aware rules need their types).
2. The 11 `eslint.config.mjs` deleted (a `[lint]` section cannot run beside
   one: see [`../lint-shadow/`](../lint-shadow/README.md), "How it was run"),
   and the 24 directive lines in 21 files that name rules by antfu's prefixes
   renamed to the canonical names, as the shadow run did.
3. One root `bunfig.toml`: [`../rules/bunfig.answered.toml`](../rules/bunfig.answered.toml),
   which is [`../rules/bunfig.native-regexp.toml`](../rules/bunfig.native-regexp.toml)
   with the user's answers of 2026-10-17 applied: `bun/format` off (Q6), the
   three `bun:test` style rules off and `no-focused-tests` /
   `no-identical-title` kept (Q4), Bun's default bug rules left on with
   `bun:test/no-export` off in `**/__tests__/helpers/**` (Q5), `Buffer` and
   `process` in `no-restricted-globals` (Q8, `process` allowed in tests, as
   antfu allows it today), `@typescript-eslint/no-namespace` with
   `allowDeclarations = false`, no `sortImports` (Q2), Markdown not formatted
   (Q3), and `typeAware = true` (Q11).
4. `CI=1 bun lint -f json` in each of the 11 directories, three times without
   types (`--no-type-aware` is the same as leaving the key out) and three times
   with `--type-aware`, then once more with the key in `bunfig.toml` instead of
   the flag ([`../tools/answered-run.sh`](../tools/answered-run.sh),
   [`../tools/answered-tally.ts`](../tools/answered-tally.ts),
   [`../tools/type-aware-lists.ts`](../tools/type-aware-lists.ts)).

## Cost

| Run | Wall, 11 directories (3 runs) | CPU (user), median |
|---|---|---|
| answered config, no types | 6.46 / 6.55 / 7.09 s | 11.1 s |
| answered config, `--type-aware` | 10.76 / 11.14 / 11.31 s | 34.0 s |
| ESLint today ([`../perf/`](../perf/README.md), 2026-10-16) | 126 s (median) | 212 s |

The type-aware run is 1.7 times the plain one in wall time and 3 times in CPU,
and still 11 times faster than ESLint. bun-jobs is the largest share (2.46 s
of the 11.31 s, 697 files). `typeAware = true` in `[lint]` gives the same
7,721 findings as the flag (13.27 s, at load 3.0 to 3.7).

On one file through standard input, as an editor extension would call it
(`bun lint --stdin --stdin-filename lib/BunRouter.ts -f json`, 5,939 lines, in
`packages/bun-common`): **313 to 329 ms** without types, **425 to 446 ms** with
them. The plan's 0.02 s of 2026-10-16 was the native config without the
`regexp` JavaScript plugin, which is now most of the cost of a single file.

## What `--type-aware` turns on

24 rules more, on every TypeScript file (`bun lint --print-config` on
`lib/BunRouter.ts`, with and without the flag): the 23 that each one's
`bun lint --explain` says "`bun lint --type-aware` turns this rule on", which
are typescript-eslint's `recommended-type-checked` set, plus
`@typescript-eslint/dot-notation`. Four core rules are swapped for their typed
twins at our severity: `dot-notation`, `no-implied-eval`, `no-throw-literal`
(→ `only-throw-error`) and `prefer-promise-reject-errors`. The other 20 run
at Bun's default severities: errors for `no-floating-promises`,
`no-misused-promises`, `unbound-method`, `restrict-template-expressions`,
`restrict-plus-operands`; warnings for the rest.

## Findings

All of them, by directory, are in one file each (`file:line:column`,
severity, rule, `[types]` when the rule needs types, message):
[`packages_bun-common.txt`](packages_bun-common.txt),
[`packages_bun-nest.txt`](packages_bun-nest.txt),
[`packages_bun-jobs.txt`](packages_bun-jobs.txt),
[`packages_bun-jobs-ui.txt`](packages_bun-jobs-ui.txt),
[`scripts.txt`](scripts.txt), [`playground.txt`](playground.txt),
[`templates_compute-provider.txt`](templates_compute-provider.txt),
[`examples_bun-common.txt`](examples_bun-common.txt),
[`examples_bun-nest.txt`](examples_bun-nest.txt),
[`examples_bun-jobs.txt`](examples_bun-jobs.txt),
[`examples_bun-jobs-ui.txt`](examples_bun-jobs-ui.txt). Counts per directory,
rule and severity, for both runs: [`summary.tsv`](summary.tsv).

**Totals**: 1,586 files. Without types, **141** findings: 71 `no-console`
warnings (ESLint's 71, unchanged) and **70** from Bun's default bug rules and
the rule-upstream differences, 30 errors and 40 warnings. With types,
**7,721**: those 141 plus **7,580** from the type-aware rules, 252 errors and
7,328 warnings.

| Directory | default rules, errors | default rules, warnings (not `no-console`) | `no-console` | type-aware, errors | type-aware, warnings |
|---|---|---|---|---|---|
| packages/bun-common | 6 | 3 | 30 | 35 | 306 |
| packages/bun-nest | 3 | 0 | 5 | 8 | 261 |
| packages/bun-jobs | 16 | 30 | 31 | 145 | 4,684 |
| packages/bun-jobs-ui | 3 | 4 | 5 | 3 | 770 |
| scripts | 0 | 0 | 0 | 0 | 25 |
| playground | 0 | 0 | 0 | 0 | 10 |
| templates/compute-provider | 0 | 0 | 0 | 0 | 0 |
| examples/bun-common | 0 | 1 | 0 | 13 | 77 |
| examples/bun-nest | 0 | 2 | 0 | 1 | 82 |
| examples/bun-jobs | 2 | 0 | 0 | 43 | 891 |
| examples/bun-jobs-ui | 0 | 0 | 0 | 4 | 222 |
| **total** | **30** | **40** | **71** | **252** | **7,328** |

**Type-aware rules**, by directory (E error, W warning):

| Rule | common | nest | jobs | jobs-ui | scripts | playground | ex/common | ex/nest | ex/jobs | ex/jobs-ui | total |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `no-unnecessary-type-assertion` (W) | 88 | 29 | 1,510 | 619 | 15 | 8 | 23 | 16 | 154 | 195 | 2,657 |
| `no-unsafe-member-access` (W) | 24 | 113 | 1,359 | 6 | 0 | 0 | 0 | 22 | 364 | 0 | 1,888 |
| `require-await` (W) | 57 | 14 | 787 | 112 | 10 | 2 | 24 | 23 | 155 | 22 | 1,206 |
| `no-unsafe-assignment` (W) | 28 | 42 | 413 | 8 | 0 | 0 | 9 | 12 | 142 | 0 | 654 |
| `await-thenable` (W) | 72 | 7 | 159 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 241 |
| `no-unsafe-argument` (W) | 13 | 2 | 157 | 10 | 0 | 0 | 7 | 4 | 19 | 0 | 212 |
| `no-unsafe-return` (W) | 10 | 23 | 124 | 6 | 0 | 0 | 1 | 1 | 29 | 2 | 196 |
| `no-unsafe-call` (W) | 6 | 28 | 119 | 2 | 0 | 0 | 0 | 0 | 22 | 0 | 177 |
| `no-floating-promises` (E) | 11 | 1 | 86 | 0 | 0 | 0 | 1 | 0 | 36 | 1 | 136 |
| `unbound-method` (E) | 8 | 0 | 32 | 1 | 0 | 0 | 10 | 1 | 1 | 1 | 54 |
| `no-base-to-string` (W) | 2 | 0 | 22 | 2 | 0 | 0 | 13 | 4 | 6 | 3 | 52 |
| `no-redundant-type-constituents` (W) | 4 | 3 | 22 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 31 |
| `restrict-template-expressions` (E) | 2 | 0 | 12 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 18 |
| `prefer-promise-reject-errors` (E) | 8 | 1 | 4 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 15 |
| `no-duplicate-type-constituents` (W) | 2 | 0 | 12 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 14 |
| `no-misused-promises` (E) | 1 | 5 | 2 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 12 |
| `only-throw-error` (E) | 3 | 0 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 11 |
| `restrict-plus-operands` (E) | 2 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 4 |
| `no-implied-eval` (E) | 0 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 |

(All `@typescript-eslint/`. The template has none.)

**Default rules** (no types), by directory:

| Rule | common | nest | jobs | jobs-ui | ex/common | ex/nest | ex/jobs | total |
|---|---|---|---|---|---|---|---|---|
| `no-console` (W) | 30 | 5 | 31 | 5 | 0 | 0 | 0 | 71 |
| `no-useless-assignment` (W) | 3 | 0 | 10 | 1 | 1 | 2 | 0 | 17 |
| `bun:test/valid-expect` (E) | 5 | 0 | 6 | 1 | 0 | 0 | 0 | 12 |
| `bun:test/no-disabled-tests` (W) | 0 | 0 | 11 | 0 | 0 | 0 | 0 | 11 |
| `import/no-duplicates` (E) | 0 | 0 | 6 | 2 | 0 | 0 | 0 | 8 |
| `no-useless-escape` (W) | 0 | 0 | 5 | 0 | 0 | 0 | 0 | 5 |
| `unicorn/prefer-regexp-test` (E) | 0 | 0 | 2 | 0 | 0 | 0 | 1 | 3 |
| `preserve-caught-error` (W) | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 3 |
| `unicorn/prefer-string-starts-ends-with` (E) | 0 | 0 | 1 | 0 | 0 | 0 | 1 | 2 |
| `bun:test/no-identical-title` (E) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 2 |
| `bun:test/no-export` (W) | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 2 |
| `no-unused-private-class-members` (W) | 0 | 0 | 1 | 1 | 0 | 0 | 0 | 2 |
| `n/handle-callback-err` (E) | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 2 |
| `@typescript-eslint/no-unused-vars` (E) | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 1 |

The "16 findings" of the plan of 2026-10-16 are still there and still 16: 12
`valid-expect`, 2 `no-identical-title`, 2 `no-unused-private-class-members`.
Around them, under the answered config: `no-useless-assignment` is 17 (was
16), `no-useless-escape` 5 (was 4), and `bun:test/no-export` 2 (was 7: the
override clears the 5 in `__tests__/helpers/`; the 2 left are exports from
`packages/bun-jobs-ui/__tests__/app/job/jobScreen.test.tsx:539` and
`packages/bun-jobs-ui/__tests__/server/budget.test.ts:32`). Develop moved on
between the two measurements (`f9baf24a` → `930dd664`).

**`no-useless-escape` is on twice.** Our ESLint config never enables the
core rule (it runs `regexp/no-useless-escape`); Bun's defaults do. Both report
a useless escape in a regular expression (the Q1 probe below: one `\a` gave
one finding from each), and they disagree on `\-` inside a character class:
all 5 core findings are that (`packages/bun-jobs/lib/runner/redact.ts:75,102`,
`lib/provider/redact.ts:95`, `__tests__/runner-logs-redact.test.ts:310`),
which `regexp/no-useless-escape` accepts. Either the 5 are fixed or the core
rule is turned off; it is not one of the bug rules Q5 names.

## Are the type-aware findings typescript-eslint's?

Cross-checked on `packages/bun-common`: typescript-eslint 8.59.4 (the copy
antfu installs), the same 23 rules, `projectService`, run by ESLint 10.5.0
([`../tools/eslint.type-checked.mjs`](../tools/eslint.type-checked.mjs),
9.9 s), against Bun's run, keyed by `file:line:column:rule`
([`../tools/type-aware-cmp.ts`](../tools/type-aware-cmp.ts)):

| | typescript-eslint | Bun | both |
|---|---|---|---|
| 18 rules with findings | 341 | 341 | 339 |

- **Bun only, 2**: `unbound-method` on `verbRouter[dynamicVerb]` and
  `verbAdapter[dynamicVerb]` (`__tests__/router-adapter.type-test.ts:327,344`),
  an element access with a union-typed key. Reduced to
  [`../repros/unbound-union-key/`](../repros/unbound-union-key/) and
  [`../repros/unbound-union-key-native/`](../repros/unbound-union-key-native/).
- **typescript-eslint only, 2**: `only-throw-error` at
  `__tests__/fetch.test.ts:728`, under `// eslint-disable-next-line
  no-throw-literal` (the type-aware run swaps `no-throw-literal` for
  `only-throw-error`, and Bun lets the old name's directive cover it: reduced,
  with the non-type-aware twin `no-unused-vars`, to
  [`../repros/directive-covers-ts-twin/`](../repros/directive-covers-ts-twin/)
  and [`../repros/directive-covers-ts-twin-native/`](../repros/directive-covers-ts-twin-native/));
  and `no-unnecessary-type-assertion` on an object literal with a spread cast
  to `Parameters<typeof BunRequest.init>[1]`
  (`__tests__/streaming.test.ts:206`), which did not reproduce reduced to one
  file (both tools reported the reduced case), so it is listed, not explained.

The other 339 agree to the column. On this package, then, the findings are
typescript-eslint's, not artefacts of Bun's port (the other ten directories
were not cross-checked); four warning rules hold 6,405 of
the 7,580 (`no-unnecessary-type-assertion` 2,657, `no-unsafe-member-access`
1,888, `require-await` 1,206, `no-unsafe-assignment` 654). The ESLint side read inline config off
(`--no-inline-config`), which none of the 339 depends on.

## Q8: explicit `Buffer` and `process` imports

`node/prefer-global/buffer` and `…/process` (`"never"`) have no Bun port;
the nearest native rule is `no-restricted-globals`, which Bun has. In the
answered config it lists `Buffer` and `process` beside `global` and `self`,
and the test-file override lists only `Buffer`, because antfu turns
`node/prefer-global/process` off in tests today.

- **Today's tree: 0 findings** in all 11 directories. 399 files import them
  from `node:buffer` or `node:process` (52 in packages' `lib/`), as the ESLint
  rule makes them.
- **Negative control** (a probe file in `packages/bun-common/lib/` and a copy
  in `__tests__/`, removed after): `Buffer.from("x")` and `process.env.HOME`
  are reported in `lib/` (`Unexpected use of 'Buffer'. Import it: …`), only
  `Buffer.from` in `__tests__/`; a type-only `x: Buffer` and
  `globalThis.process.pid` are not reported.

So the rule enforces the convention under `bun lint`, with nothing to fix.

## Q1: `eslint-plugin-regexp` without the `eslint` package

In an empty directory, `bun add -d eslint-plugin-regexp@3.1.0`:

- **By default, Bun installs `eslint` anyway**: the plugin declares
  `eslint >=9.38.0` as a (non-optional) peer dependency, and Bun installs
  peers. 83 packages, `node_modules/eslint` 10.13.0.
- With `[install] peer = false` in that directory's `bunfig.toml`: 9 packages,
  no `eslint`. `bun lint` then loads the plugin and runs its rules
  (`regexp/no-super-linear-backtracking`, `no-useless-escape`, `prefer-d` all
  reported on a two-line probe), and `--doctor` lists "3 rules run in
  JavaScript: eslint-plugin-regexp".

So the plugin runs without `eslint`, but keeping it as a dependency keeps
`eslint` in `node_modules` unless the repository turns peer installs off,
which would change every install in the monorepo. `eslint` is then installed
but never run.
