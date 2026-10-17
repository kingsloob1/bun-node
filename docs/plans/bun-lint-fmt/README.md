# Adopting `bun lint` and `bun fmt`

**Status:** plan of 2026-10-16, **decided 2026-10-17**: the user answered the
eleven questions of §9 and replaced the gating of §6 (wait for a stable Bun)
with raising the development floor to the 1.4.4 canary now. Nothing here is
implemented yet. Written by the features (main) agent at the user's request;
the decisions, the re-measurement and the PR slices are the Bun-Node Examples
& Tooling Agent's, who leads the plan:

> Bun canary currently supports lint and fmt which is very performant. What is
> the plan to adopt it as part of our tooling. Dropping eslint, prettier,
> oxlint while still maintaining vscode usability?

Everything Bun-side was measured or read on **Bun 1.4.4-canary.1+5f5799ed1**
(`bun --revision`), on this 16-core machine: on 2026-10-16 in scratch clones
of develop at `f9baf24a`, and on 2026-10-17, under the answered config, in a
scratch clone of develop at `930dd664`. Our setup is cited as `file:line` on
`f9baf24a` (and on develop `92196c87` for `.vscode/settings.json`, which #396
changed). The workings are in [`evidence/`](evidence/README.md); the
2026-10-17 measurements in
[`evidence/type-aware/`](evidence/type-aware/README.md). **Develop has moved
on since** (to `56d6afde` when this was written, #401 among the merges): the
2026-10-17 figures are `930dd664`'s and were not re-measured; each PR
re-measures on its own branch.

## Contents

1. [Summary](#1-summary)
2. [What we run today](#2-what-we-run-today)
3. [Rule parity](#3-rule-parity)
4. [Formatter parity, and the root `bunfig.toml`](#4-formatter-parity-and-the-root-bunfigtoml)
5. [VS Code](#5-vs-code)
6. [Stability, floors and gating](#6-stability-floors-and-gating)
7. [PRs](#7-prs)
8. [Risks](#8-risks)
9. [Questions, and the user's answers](#9-questions-and-the-users-answers)

## 1. Summary

**What was decided (the user, 2026-10-17).**

- **The development floor goes to the 1.4.4 canary now**, and `bun lint` and
  `bun fmt` become the repository's lint and format tools now. The canary
  reports `Bun.version` "1.4.4", so `engines.bun >=1.4.4`,
  `packageManager: bun@1.4.4` and `MIN_BUN = "1.4.4"` accept it today and the
  stable release later. Using the packages still needs only Bun 1.4.2. Type
  checking stays `bun check` (§6).
- **Native rules plus `eslint-plugin-regexp`, nothing else from ESLint's
  world** (Q1). No import sorting (Q2), no Markdown formatting (Q3), the
  `bun:test` style rules off (Q4), Bun's default bug rules on (Q5), a separate
  `bun fmt --check` step (Q6), explicit `Buffer`/`process` imports enforced
  with `no-restricted-globals` (Q8), **the type-aware rules in this switch**
  (Q11), no Git hook (Q10).
- **An in-repo VS Code extension** replaces the ESLint extension (Q9).
- **The one-time reformat is `bun fmt`'s**, done once at the flip, in a quiet
  merge window agreed with the Nest and Common agents (Q7: no Prettier 3.9
  step before it).

**What it costs and finds, measured on 2026-10-17** (develop `930dd664`,
[`evidence/type-aware/`](evidence/type-aware/README.md)):

- **Speed.** `bun lint` with the answered config over the 11 directories:
  **6.5 s** wall (11 s CPU), **11.1 s** (34 s CPU) with `--type-aware`,
  median of three, at a load of 2.6 to 3.7. ESLint today: 126 s (212 s CPU).
  Most of the plain run is the one JavaScript plugin, `eslint-plugin-regexp`
  (0.44 s without it, 2026-10-16). `bun fmt --check` over the whole repository
  (1,697 files in scope): **0.08 to 0.10 s**. One file through standard input,
  as the editor will call it: 0.31 to 0.33 s, 0.43 to 0.45 s with types.
- **Findings without types: 141** in 1,586 files. 71 are ESLint's `no-console`
  warnings, unchanged. The other **70** (30 errors, 40 warnings) are Bun's
  default bug rules and the rule-upstream differences of §3, among them the
  **16 real defects** of 2026-10-16, still 16: 12 un-awaited
  `expect(…).rejects`, 2 duplicate test titles, 2 unused private members.
- **Findings with types: 7,721**, the 141 above plus **7,580** from the 24
  type-aware rules (below).
- **Q8 costs nothing today**: `no-restricted-globals` with `Buffer` and
  `process` reports 0 findings (399 files already import them), and reports
  a planted global use.
- **The reformat touches 89 files** (+371 −506): 82 TypeScript files, 3 CSS,
  3 HTML and `lerna.json`; 40 of them in bun-jobs, 19 in bun-common, 15 in
  bun-jobs-ui.

### What Q11 costs: the type-aware findings

With `typeAware = true`, `bun lint` over the 11 directories reports **7,721
findings: 282 errors and 7,439 warnings**. Of them, **7,580 come from the 24
type-aware rules: 252 errors and 7,328 warnings**; the other 141 are the
plain run's. **2,536 of the 7,721 carry an automatic fix** (2,517 of them
`no-unnecessary-type-assertion`), 1,669 only suggestions. 5,557 of the
7,580 are in test, type-test and bench files.

| Owner | All findings (with types) | Errors (type-aware) | Warnings (type-aware) | With a fix | Type-aware warnings in tests from `no-unsafe-*`, `require-await`, `await-thenable` |
|---|---|---|---|---|---|
| Jobs (bun-jobs) | 4,906 | 161 (145) | 4,745 (4,684) | 1,489 | 2,949 |
| Tooling (scripts, template, examples) | 1,363 | 63 (61) | 1,300 (1,297) | 400 | 7 |
| UI (bun-jobs-ui, playground) | 795 | 6 (3) | 789 (780) | 536 | 141 |
| Common (bun-common) | 380 | 41 (35) | 339 (306) | 89 | 157 |
| Nest (bun-nest) | 277 | 11 (8) | 266 (261) | 22 | 202 |
| **total** | **7,721** | **282 (252)** | **7,439 (7,328)** | **2,536** | **3,456** |

The 252 type-aware errors are 136 `no-floating-promises`, 54
`unbound-method`, 18 `restrict-template-expressions`, 15
`prefer-promise-reject-errors`, 12 `no-misused-promises`, 11
`only-throw-error`, 4 `restrict-plus-operands` and 2 `no-implied-eval`. Four
warning rules hold 6,405 of the 7,328 warnings:
`no-unnecessary-type-assertion` 2,657, `no-unsafe-member-access` 1,888,
`require-await` 1,206, `no-unsafe-assignment` 654. On bun-common, Bun's
findings equal typescript-eslint 8.59.4's on 339 of 341, to the column, so
they are the rules' findings, not the port's.

**What "each owner fixes its findings before the flip" means in effort.**
The errors and the default-rule findings are about 4 owner-days in all (§7,
PR B: Jobs 1.5, Tooling 1, Common, Nest and UI 0.5 each). The automatic
fixes are minutes plus a `bun run check`. What is left is **4,797 warnings
with no automatic fix**, about two thirds of them in bun-jobs; at one to two
minutes each (an estimate, not a measurement) that is 80 to 160 hours, 10 to
20 working days, before the flip could happen. That is Q12 (§9), with the
recommendation: **keep all 24 rules on; the 8 error rules stay errors and are
fixed before the flip; the automatic fixes are applied; `no-unsafe-*`,
`require-await` and `await-thenable` start off in test files (3,456
warnings); the remaining 1,341 warnings stay warnings, which do not fail the
gate, and each owner clears them after the flip.**

### Q1's catch: no `eslint` package needs `peer = false`

`eslint-plugin-regexp` runs in `bun lint` without the `eslint` package
(measured: its rules report, and `--doctor` lists them as JavaScript rules).
But the plugin declares `eslint >=9.38.0` as a peer dependency, and **Bun
installs peers by default**: `bun add -d eslint-plugin-regexp` installed 83
packages, `eslint` 10.13.0 among them. Only with **`[install] peer = false`**
in `bunfig.toml` did it install 9 packages and no `eslint`. That setting
would change peer installation for every package in the monorepo. Q14 (§9),
recommended: accept `eslint` installed as the plugin's peer and never run,
and keep the default peer installs.

**What we lose.** 172 of the 384 rules we run have no native counterpart
(`regexp` 60, kept as a JavaScript plugin; `jsonc` 38, `@eslint-react` 21,
`jsdoc` 17, `markdown` 15, and 21 smaller ones), Markdown and JSON linting,
perfectionist's import order, and the ESLint VS Code extension. The React
leak rules (`web-api-no-leaked-*`, `jsx-no-key-after-spread`) go with
`@eslint-react`; a mount/unmount leak test in bun-jobs-ui takes their place
before they are removed (§7, PR C). Nothing ESLint reports on today's tree is
lost: the shadow run of 2026-10-16 reproduced all 71 of its findings.

**How it lands** (§7): a floor-and-config PR that makes `bun lint` runnable
everywhere while ESLint stays the gate; one findings PR per owner; the UI
leak test; the editor extension; the flip, with the reformat, in a quiet
window; and the removal of ESLint and Prettier one merge window later.

**New questions the measurements raise** (§9): what to do with the 7,328
type-aware warnings before the flip (Q12), the doubled `no-useless-escape`
(Q13), and whether "no `eslint` package" means turning peer installs off
(Q14).

## 2. What we run today

### ESLint

- **11 `eslint.config.mjs` files, 764 lines**: one per package
  (`packages/{bun-common,bun-nest,bun-jobs,bun-jobs-ui}/eslint.config.mjs`),
  `scripts/`, `playground/`, `templates/` (outside the template, so a copy of
  the template carries none of the repo's lint dependencies), and one per
  `examples/*`. `benchmarks/` has none and is not linted.
- **All are `@antfu/eslint-config` 9.0.0** with the same options
  (`packages/bun-common/eslint.config.mjs:6-20`: `lessOpinionated`, double
  quotes, semicolons, 2-space indent, `typescript`, `vue`, `jsonc`, `yaml`,
  `toml`, `test`; bun-jobs-ui swaps `vue` for `react`), six stylistic rules
  turned off (`:21-30`), four `ts/` rules off (`:31-38`), and
  `eslint-plugin-prettier` appended for code, JSON and YAML only, with the
  Prettier options inline (`:39-71`). There is **no Prettier config file and
  no `.prettierignore`** anywhere.
- **Conventions that rest on a rule**:
  - the `^_` pattern for unused bindings
    (`packages/bun-common/eslint.config.mjs:75-88`,
    `unused-imports/no-unused-vars`; also documented in CLAUDE.md, "Working
    preferences"). Bun's `no-unused-vars` has the same `^_` defaults.
  - `no-console: "warn"` (`:89`), turned off for CLI entry points in
    `scripts/eslint.config.mjs:94-106`, `playground/eslint.config.mjs:93-105`,
    `templates/eslint.config.mjs:99-115` and every
    `examples/*/eslint.config.mjs:13-16`, along with
    `antfu/no-top-level-await`.
  - perfectionist import sorting (antfu's default, auto-fixed).
  - antfu's style rules: quotes, semicolons, indentation and brace style are
    Prettier's job here (`eslint-config-prettier` turns the overlapping ESLint
    rules off), so in practice **Prettier 3.8.4 with our options is the
    style**.
- **The rule set** (§3): 384 enabled rules across ten representative files.
- **101 inline suppressions in 67 files**
  ([`evidence/inventory/eslint-directives.txt`](evidence/inventory/eslint-directives.txt)):
  `no-console` 29, `ts/…` 19, `prefer-spread` 9, `react/no-array-index-key` 7,
  `no-new` 5, `perfectionist/sort-exports` 3, and 17
  `<!-- eslint-skip -->` in `packages/bun-jobs/docs/providers/author-guide.md`,
  which `packages/bun-jobs/__tests__/provider/docsCheck.ts:13,76` parses.
- **What ESLint does for Markdown**: in the 17 READMEs and guides inside the
  lint scope it runs `@eslint/markdown`'s 15 rules and lints the 165 `ts`/`js`
  code blocks; it does **not** run Prettier on Markdown
  (`packages/bun-common/eslint.config.mjs:39-49`, scoped away because Prettier
  reported a syntax error on the first heading). Two READMEs are parsed by
  examples (`examples/bun-jobs-ui/04-screens/permissions.ts` reads the
  bun-jobs-ui "What each element needs" table; `scaler-recipes.ts` reads the
  bun-jobs recipes), and the provider author guide by
  `packages/bun-jobs/__tests__/provider/docs.test.ts`.
- **The Prettier hang**: the memory note
  `prettier-hangs-on-long-md-cells` records ESLint hanging for more than 580 s
  on one README table wording (2026-09-24). `bun fmt` formatted every README
  in the repo in milliseconds; that class of stall goes with ESLint.

### Packages

| `package.json` | Lint and format devDependencies |
|---|---|
| root (`package.json:19-24`) | `@antfu/eslint-config ^9.0.0`, `@nx/eslint 23.2.1`, `eslint ^10.5.0`, `eslint-config-prettier ^10.0.1`, `eslint-plugin-prettier ^5.5.6` (no `prettier`: the scripts' rule finds it hoisted from a package) |
| bun-common (`:120,125-128`) | `@antfu/eslint-config`, `eslint ^10.5.0`, `eslint-config-prettier`, `eslint-plugin-prettier`, `prettier ^3.8.4` |
| bun-nest (`:120,133-136`) | the same, older ranges (`eslint ^10.4.0`, `eslint-plugin-prettier ^5.2.2`, `prettier ^3.4.2`) |
| bun-jobs (`:165,172-174,176`) | the same as bun-common |
| bun-jobs-ui (`:73-74,87-93`) | the same, plus `@eslint-react/eslint-plugin ^5.6.0`, `eslint-plugin-react-hooks ^7.0.0`, `eslint-plugin-react-refresh ^0.5.2` |

Installed: eslint 10.5.0, prettier 3.8.4, @antfu/eslint-config 9.0.0, and
through it @eslint/markdown 8.0.1, eslint-plugin-jsonc 3.1.2, -yml 3.3.2,
-toml 1.3.1, -perfectionist 5.9.0, -unused-imports 4.4.1,
@stylistic/eslint-plugin 5.10.0, @typescript-eslint/parser 8.59.4,
-unicorn 64.0.0, -jsdoc 62.9.0, -regexp 3.1.0, -n 18.0.1, -import-lite 0.6.0,
@vitest/eslint-plugin 1.6.17, eslint-plugin-vue 10.9.1, @e18e/eslint-plugin
0.4.1. `@nx/eslint` is used by nothing: `nx.json` has no plugins and there is
no `project.json`.

### oxlint

**There is no oxlint in this repository**: no config, no dependency, no
installed copy, no script. The only mentions are `bun.lock:401` and
`templates/compute-provider/bun.lock:50`, where `@e18e/eslint-plugin` (pulled
in by `@antfu/eslint-config`) declares `oxlint` as an **optional** peer, which
is not installed; and the NestJS changelog matrices in
`docs/plans/nestjs-12-parity/evidence/`, which record Nest's own oxlint bumps.
The user has the `oxc.oxc-vscode` 1.64.1 extension installed in VS Code; the
repository does not use it. Dropping oxlint is therefore a no-op.

### Hooks, editor, docs

- **No husky, lint-staged, lefthook or other Git hook.**
- **`.vscode/settings.json:2-14`** (develop `92196c87`, #396) points
  `eslint.workingDirectories` at all 11 directories with an ESLint config. It
  implies `dbaeumer.vscode-eslint` (installed here: 3.0.34); there is no
  `extensions.json`, no formatter setting, no `editor.codeActionsOnSave`.
- **No `bunfig.toml` anywhere** in the repository.
- **Every place that tells people or agents to run ESLint** (line numbers on
  `f9baf24a`; they change in PR A and PR E, §7):
  - `CLAUDE.md:29, 67, 73, 318-332, 340-345, 379-381, 389, 439-448, 504-505, 728`
  - `docs/agentic-setup.md:120, 275, 502`
  - `.claude/skills/bun-node-check/SKILL.md:22, 27, 31, 40`
  - `README.md:108`, `examples/README.md:30, 35`, `examples/bun-common/README.md:150`,
    `examples/bun-jobs-ui/README.md:140`, `examples/bun-jobs/README.md:211`,
    `examples/bun-nest/README.md:93`, `packages/bun-common/README.md:1962`,
    `packages/bun-jobs/README.md:8496`, `packages/bun-nest/README.md:1457`
  - no package has a `lint` or `format` script; the gate is typed by hand.
- **What else knows about ESLint**: every package `tsconfig.json` includes
  `eslint.config.mjs` (`packages/bun-common/tsconfig.json:16`,
  `bun-jobs-ui:16`, `bun-jobs:15`, `bun-nest:13`, `scripts/tsconfig.json:13`,
  `templates/tsconfig.json:16`); `scripts/typecheck.ts:69-76` filters the
  `TS2742`/`TS2883` noise from those configs and
  `scripts/__tests__/typecheck.test.ts:80` tests the filter; three packages'
  `.gitignore:74-76` ignore `.eslintcache`.
- **The heavy-run notes** classify lint as "not heavy, run directly"
  (`CLAUDE.md`, "Heavy runs take a slot"; `docs/agentic-setup.md`, "Direct, no
  wrapper"). `bun lint` is lighter still; only the wording changes.

## 3. Rule parity

Full map: [`evidence/rules/parity.tsv`](evidence/rules/parity.tsv), method and
the value of each missing rule in
[`evidence/rules/README.md`](evidence/rules/README.md).

| | Rules | |
|---|---|---|
| **Native, same rule** | **127** | ESLint core 97, `@typescript-eslint` 26, `n` 4 |
| **Native, different name, upstream or options** | **85** | `@eslint-react` → eslint-plugin-react / React Compiler rules 44, `unicorn` (oxlint's ports) 14, `import` (eslint-plugin-import, not import-lite) 6, `test` (vitest → `bun:test`) 6, `e18e` 6, `eslint-comments` 3, `unused-imports` 2, and 4 single renames |
| **Not available** | **172** | `regexp` 60, `jsonc` 38, `@eslint-react` 21, `jsdoc` 17, `markdown` 15, `antfu` 5, `perfectionist` 4, `n` 4, `e18e` 3, `@stylistic` 3, `eslint-comments` 1, `command` 1 |

What the differences mean in practice, all measured by the shadow run
([`evidence/lint-shadow/`](evidence/lint-shadow/README.md)) and reduced to
single-file reproductions ([`evidence/repros/`](evidence/repros/README.md)):

- **Rule names in comments.** antfu registers plugins under short prefixes
  (`ts/`, `node/`, `test/`, `style/`, `import/`, `react/`); Bun knows the
  canonical names, and reads `eslint-disable` comments literally. 24 directive
  lines in 21 files must be renamed, or 91 findings reappear.
- **Different upstreams.** `import/no-duplicates` (8 findings, eslint-plugin-import
  vs import-lite), `unicorn/*` (5, oxlint vs eslint-plugin-unicorn),
  `n/handle-callback-err` (2, oxlint reports overload signatures),
  `@typescript-eslint/no-unused-vars` (1: unused-imports counts a JSDoc
  `{@link X}` as a use).
- **Different defaults.** A native config inherits Bun's defaults for every
  option it does not set; `@typescript-eslint/no-namespace`
  (`allowDeclarations = true` in Bun) is the one that showed.
- **Rules that start firing.** The `bun:test/` style rules our vitest rules
  were meant to be (465 `prefer-lowercase-title`, 37 `prefer-hooks-in-order`,
  31 `consistent-test-it`): **off** (Q4), keeping `no-focused-tests` and
  `no-identical-title`. Bun's default bug rules (`valid-expect`,
  `no-useless-assignment`, `preserve-caught-error`,
  `no-unused-private-class-members`, `no-disabled-tests`): **on** (Q5), their
  findings fixed in the owners' PRs, `bun:test/no-export` off in
  `__tests__/helpers/`. Re-measured under the answered config: 70 findings
  besides `no-console`, by rule and directory in
  [`evidence/type-aware/`](evidence/type-aware/README.md).
- **Rules that need types** (Q11). `typeAware = true` turns on 24 rules on
  every TypeScript file: typescript-eslint's `recommended-type-checked` set
  (23) and the typed `dot-notation`, and swaps four core rules for their typed
  twins at our severity (`dot-notation`, `no-implied-eval`, `no-throw-literal`
  → `only-throw-error`, `prefer-promise-reject-errors`). 7,580 findings today.
  On bun-common they equal typescript-eslint 8.59.4's on 339 of 341; the two
  Bun-only and two typescript-eslint-only findings are reduced in
  [`evidence/repros/`](evidence/repros/README.md) ("Added 2026-10-17").
- **`node/prefer-global/{buffer,process}`** (`"never"`), which Bun has not
  ported, becomes `no-restricted-globals` with `Buffer` and `process` listed
  (Q8; `process` allowed in tests, as antfu allows it today). 0 findings on
  today's tree; a planted `Buffer.from` and `process.env` are reported, a
  type-only `Buffer` and `globalThis.process` are not.
- **Missing rules, as decided.** `regexp` is kept as a JavaScript plugin
  (Q1). Dropped: perfectionist import order (Q2), Markdown linting of the
  parsed READMEs and the guide's code blocks, JSON linting, jsdoc (Q1), and
  `@eslint-react`'s `web-api-no-leaked-*` effect-cleanup rules and
  `jsx-no-key-after-spread` (bun-jobs-ui, Q1), whose place a mount/unmount
  leak test takes (§7, PR C). The rest are layout or modernisation hints.

## 4. Formatter parity, and the root `bunfig.toml`

Full results: [`evidence/format/`](evidence/format/README.md).

- **Code: no hard differences.** On the 1,651 code files in the lint scope
  (2026-10-16), `bun fmt` with `singleAttributePerLine = true` equals Prettier
  3.9.10 byte for byte. It differs from our Prettier 3.8.4 on 78 files, every
  hunk a Prettier 3.9 change (107 of 124 are union types collapsed onto one
  line).
- **The one-time reformat, under the answered settings** (2026-10-17, develop
  `930dd664`): `bun fmt --check` from the root finds **89 files** of 1,697 in
  scope, **+371 −506** once formatted, and a second check is clean
  ([`evidence/format/`](evidence/format/README.md), last section). They are
  the 78 above, `scripts/nest-matrix.ts` (added since), 3 files in
  `benchmarks/` (not linted, but not in `[fmt]`'s ignore list), 3 CSS files
  in `packages/bun-jobs-ui/app/`, 3 HTML files (bun-common's playground and
  `examples/bun-common`) and `lerna.json`. Our ESLint config never formatted
  the CSS and HTML; ignoring them is one `ignorePatterns` entry. The reformat
  happens once, at the flip (§7, PR E), not as a Prettier 3.9 bump first (Q7).
- **Style options.** Our inline Prettier options are Prettier's defaults
  except `singleAttributePerLine: true`
  (`packages/bun-common/eslint.config.mjs:56-68`). Without it in `[fmt]`, 107
  more `.tsx` files change. That is the only style key we need.
- **Idempotent** on everything in the lint scope. On 4 plan-evidence files
  neither Prettier 3.9.10 nor `bun fmt` is idempotent, identically; `docs/**`
  is ignored.
- **Markdown is not formatted** (Q3), as today. Formatting it would change 114
  files and, with code blocks formatted, broke the provider guide's
  verbatim-excerpt test (`docs/providers/author-guide.md:818: not a verbatim
  excerpt`); with `embeddedLanguageFormatting = "off"` it passed. The measured
  alternative stays in [`evidence/format/`](evidence/format/README.md).
- **Generated overloads untouched.** After formatting,
  `bun scripts/generate-verb-overloads.ts --check` is green; no hunk falls
  inside a `BEGIN generated typed overloads` block (2026-10-16).
- **`bunfig.toml` is found from the working directory up, not per file.**
  `bun lint` in `packages/bun-common` used `../../bunfig.toml`; a
  `bunfig.toml` inside `templates/compute-provider` won when run from there
  and was ignored when run from the root (measured). So the repository gets
  **one root `bunfig.toml`**, with per-directory differences as
  `[[lint.overrides]]` and `[[fmt.overrides]]` (globs relative to the file),
  and the template gets **its own** `bunfig.toml` for when it is copied out,
  which needs no dependencies, unlike today's `templates/eslint.config.mjs`.
- **A `[lint]` section cannot sit beside an `eslint.config.mjs`** (measured
  again on 2026-10-17). With both, Bun applies `[lint]` on top of the ESLint
  config and stops: `Could not find plugin "@typescript-eslint" in
  configuration`. The same happens with the section in a separate file
  (`bun --config=bunfig.lint.toml lint`), and `bun lint -c` takes an ESLint or
  oxlint config, not a `bunfig.toml` (`Unexpected key "lint" found`). An
  ESLint config **renamed** to `eslint.legacy.config.mjs` is not discovered:
  `bun lint` then reads the root `bunfig.toml`, and `eslint -c
  eslint.legacy.config.mjs .` still runs it (bun-nest, 25 s). That is how the
  two run side by side until the flip (§7, PR A).

### The root `bunfig.toml`, as decided

The full file, as measured:
[`evidence/rules/bunfig.answered.toml`](evidence/rules/bunfig.answered.toml)
(380 lines once `bun fmt` has formatted it): the generated
[`evidence/rules/bunfig.native-regexp.toml`](evidence/rules/bunfig.native-regexp.toml)
with the answers applied. Its shape:

<!-- eslint-skip -->

```toml
[lint]
typeAware = true                           # Q11: the gate, the editor and every bun lint
ignorePatterns = ["**/dist/**", "**/dts/**", "docs/**", "benchmarks/**", "**/bench/**/results/**"]
reportUnusedDisableDirectives = "warn"     # as ESLint's linterOptions does today
plugins = [{ name = "regexp", specifier = "eslint-plugin-regexp" }]   # Q1 (a)

[lint.rules]
# 127 + 85 native rules at today's severities and options, generated from
# `eslint --print-config`; our offs stated explicitly, because Bun's defaults
# fill every gap (`@typescript-eslint/no-explicit-any` gave 615 warnings
# until it was).
"no-console" = "warn"
"@typescript-eslint/no-unused-vars" = ["error", { args = "after-used", argsIgnorePattern = "^_", caughtErrorsIgnorePattern = "^_", ignoreRestSiblings = true, vars = "all", varsIgnorePattern = "^_" }]
"@typescript-eslint/no-namespace" = ["error", { allowDeclarations = false }]
"import/consistent-type-specifier-style" = ["error", "prefer-top-level"]
"no-restricted-globals" = ["error", { name = "global", message = "Use `globalThis` instead." }, { name = "self", message = "Use `globalThis` instead." }, { name = "Buffer", message = "Import it: `import { Buffer } from \"node:buffer\"`." }, { name = "process", message = "Import it: `import process from \"node:process\"`." }]   # Q8
"bun/format" = "off"                       # Q6: bun fmt --check is its own step
# Q5: Bun's default bug rules stay on (valid-expect, no-useless-assignment,
# preserve-caught-error, no-unused-private-class-members, no-disabled-tests).
# Q13: "no-useless-escape" = "off", or fix its 5 findings.
"regexp/no-super-linear-backtracking" = "error"   # … and the other 59 regexp rules

[[lint.overrides]]                         # tests (antfu's GLOB_TESTS)
files = ["**/__tests__/**", "**/*.spec.*", "**/*.test.*", "**/*.bench.*", "**/*.benchmark.*"]
rules = { "bun:test/no-focused-tests" = "error", "bun:test/no-identical-title" = "error", "bun:test/prefer-lowercase-title" = "off", "bun:test/prefer-hooks-in-order" = "off", "bun:test/consistent-test-it" = "off", "n/no-top-level-await" = "off", "no-restricted-globals" = ["error", "…global, self and Buffer, not process"] }   # Q4, Q8

[[lint.overrides]]                         # Q5
files = ["**/__tests__/helpers/**"]
rules = { "bun:test/no-export" = "off" }

[[lint.overrides]]                         # React, where @eslint-react runs today
files = ["packages/bun-jobs-ui/**", "examples/bun-jobs-ui/**"]
rules = { "react/rules-of-hooks" = "error", "react/exhaustive-deps" = "warn", "react/jsx-key" = "error" }   # … 31 in all; no web-api-no-leaked-*, no jsx-no-key-after-spread (Q1)

[[lint.overrides]]                         # antfu's script, cli and config-file disables
files = ["**/scripts/**", "**/cli/**", "**/*.config.*"]
rules = { "n/no-top-level-await" = "off" }

[[lint.overrides]]                         # CLI entry points: printing is the product
files = ["scripts/**", "playground/**", "examples/**", "templates/*/scripts/**"]
rules = { "no-console" = "off", "n/no-top-level-await" = "off" }

[fmt]
singleAttributePerLine = true              # the one option we set that is not Prettier's default
ignorePatterns = ["**/*.md", "docs/**", "benchmarks/results/**"]   # Q3; no [fmt.sortImports] (Q2)
```

`prettier/prettier` maps to `bun/format`, which is off: formatting is checked
by `bun fmt --check` alone (Q6). `typeAware = true` in `[lint]` gives the same
7,721 findings as the `--type-aware` flag (measured), so nobody has to
remember the flag, and the editor gets the type-aware rules too.

`templates/compute-provider/bunfig.toml` repeats the `[lint]` and `[fmt]`
sections with the template's two differences (`no-console` warn, off in its
`scripts/`), so the template stays self-contained when copied.

## 5. VS Code

**Decided (Q9): build the in-repo extension.** None exists to adopt: nothing
on the VS Marketplace or Open VSX, no GitHub repository, and the official
`oven.bun-vscode` (Marketplace 0.0.32; `main` 0.0.31) has only run, debug,
test and lockfile commands, with no linter or formatter setting.
`bun lint --help --all` and `bun fmt --help --all` list `--lsp` as
**"Not supported"**. Bun's lint source says a rule's documentation "shows up …
in editors" (`src/lint/CLAUDE.md`), so an integration is intended; nothing is
announced. When Bun ships one, ours is deleted.

**Today's baseline** is the ESLint extension in all 11 directories
(`.vscode/settings.json:2-14`): inline diagnostics as you type, quick fixes
(including Prettier's, via `prettier/prettier`), "Fix all", and formatting
only through ESLint's fix-on-save if a developer has set it up (the repo sets
no formatter).

**The options considered** (2026-10-16), for the record:

| Option | Diagnostics | Quick fixes | Format on save | Format selection | Cost | Verdict |
|---|---|---|---|---|---|---|
| A. Keep the ESLint extension, against `eslint.config.mjs`, until Bun ships an LSP | yes, ESLint's | yes | via ESLint fixes | no | none, but keeps ESLint, antfu and Prettier installed, and the editor disagrees with the gate wherever the rule sets differ | until the flip only |
| B. A VS Code task (`bun lint -f stylish`) with the built-in `$eslint-stylish` problem matcher | on demand, in the Problems panel | no | no | no | an hour | a fallback, not an editor experience |
| C. A run-on-save extension (`emeraldwalk.runonsave`) calling `bun fmt <file>` | no | no | rewrites the file on disk after the save, racing the editor's buffer | no | an hour | fragile |
| D. A generic stdin formatter extension (`jkillian.custom-local-formatters`) calling `bun fmt --stdin-filepath ${file}` | no | no | **yes**, through VS Code's formatter API | no | an hour | good for formatting only |
| **E. A small in-repo extension** wrapping `bun lint --stdin --stdin-filename <file> -f json` and `bun fmt --stdin-filepath <file>` | **yes** | **yes**, from the JSON report's `fix` and `suggestions` | **yes** | **yes**, with `--range-start`/`--range-end` | about 2 days, plus upkeep | **decided** |

**What the extension must do** (PR D):

- **Run where the gate runs.** Spawn `bun` with the file's directory as the
  working directory, so Bun finds the root `bunfig.toml` (and the template's
  own inside `templates/compute-provider`), with `AGENT`, `CLAUDECODE` and
  `REPL_ID` removed from the environment and `-f json`, so the report is the
  machine format and not the agent one.
- **Diagnostics** on open, on save and, debounced, on change, from
  `bun lint --stdin --stdin-filename <file> -f json` with the buffer on
  standard input. With `typeAware = true` in the root `bunfig.toml`, the
  type-aware rules run in the editor too (measured: `lib/BunRouter.ts` sent
  through standard input got its type-aware findings). Squiggles and the
  Problems panel, with the rule name linking to `bun lint --explain=<rule>`.
- **Quick fixes**: "Quick Fix…" for every report that carries a `fix`, and
  each `suggestions` entry as its own action; "Fix all in file" from the
  `fix`es. Measured on 2026-10-17: 2,536 of the 7,721 findings carry a `fix`,
  1,669 only suggestions.
- **Formatting**: Format Document, Format Selection (`--range-start` /
  `--range-end`) and format on save, through VS Code's formatter API from
  `bun fmt --stdin-filepath <file>`, for the languages `bun fmt` formats
  except Markdown (Q3).
- **All 11 directories**: `packages/bun-common`, `packages/bun-nest`,
  `packages/bun-jobs`, `packages/bun-jobs-ui`, `scripts`, `playground`,
  `templates/compute-provider`, `examples/bun-common`, `examples/bun-nest`,
  `examples/bun-jobs`, `examples/bun-jobs-ui`. A test opens one file in each
  and expects the gate's findings for it.
- **Fail visibly** when `bun` is older than the floor or lacks `lint`
  (`Script not found "lint"` on 1.4.3): one notification, not silence.

**Latency** (2026-10-17, `lib/BunRouter.ts`, 5,939 lines, answered config):
**313 to 329 ms** without types, **425 to 446 ms** with them, against
0.02 s on 2026-10-16 for the native rules alone, without the `regexp`
plugin. Fast enough on open, on save and on a debounced change; not per
keystroke. `bun fmt --stdin-filepath`: under 0.01 s.

**What is lost compared with today**: diagnostics for Markdown and JSON
files (no native rules), the rules dropped in §3, and "Fix all ESLint
problems" across the workspace (`bun lint --fix` from a terminal does that).
**What is gained**: the type-aware rules in the editor, which ESLint never ran
here.

**Distribution.** The extension lives in the repository
(`tools/vscode-bun-lint/`, outside the workspaces, its own `package.json`),
is built with `bun build`, packed with `bunx @vscode/vsce package` and
installed with `code --install-extension`. At the flip (PR E),
`.vscode/settings.json` drops `eslint.workingDirectories` and sets
`editor.defaultFormatter` to the extension, and `.vscode/extensions.json`
recommends it and lists `dbaeumer.vscode-eslint` under
`unwantedRecommendations`. A recommendation names a published identifier, so
for a local extension it only marks the installed copy; how to install it is
in the extension's README and in CLAUDE.md.

## 6. Stability, floors and gating

**The facts** (unchanged since 2026-10-16):

- **Neither command is in a stable release.** Bun 1.4.3 (stable, released
  2026-10-10, the latest) answers `bun lint --help` with `error: Script not
  found "lint"`, and the same for `fmt` (measured with the npm build
  `@oven/bun-linux-x64@1.4.3`, revision `c6da4a4d3`). Its release notes do
  not mention either. Bun's docs already describe both as if shipped.
- **The canary is moving fast.** 18 issues about `bun lint` / `bun fmt` were
  opened on oven-sh/bun between 2026-10-13 and 2026-10-16, 15 of them still
  open ([`evidence/bun-cli/issues-lintfmt.txt`](evidence/bun-cli/issues-lintfmt.txt)),
  among them a non-idempotent formatter case (#45378), `.git/info/exclude`
  ignored (#45320), the doctor naming optional peers as still needed (#45390),
  and how to call the tool when `package.json` has a `lint` script (#45405).
- **The canary calls itself 1.4.4.** On 1.4.4-canary.1+5f5799ed1,
  `Bun.version` is `"1.4.4"` and `Bun.semver.satisfies(Bun.version,
  ">=1.4.4")` is true (measured). npm's `bun-types` has `latest` 1.4.3 and
  `canary` 1.4.4-canary.20261017T141052; there are no stable 1.4.4 types.

**The decision (the user, 2026-10-17)**, which replaces "switch on the first
stable release with both commands":

1. **Raise the development floor to the 1.4.4 canary now**:
   `packageManager: bun@1.4.4` and `engines.bun >=1.4.4` in the root
   `package.json`, `MIN_BUN = "1.4.4"` in `scripts/typecheck.ts`. These
   accept the canary today and 1.4.4 stable later, with no second change.
2. **`bun lint` and `bun fmt` become the repository's lint and format tools
   now**: the root `bunfig.toml`, a `lint` script in every linted directory,
   and the docs, in PR A; the gates themselves flip in PR E, once each
   owner's findings are fixed (§7).
3. **The users' floor stays 1.4.2.** The packages' `engines.bun >=1.4.2`
   and their optional `@types/bun >=1.4.2` peer do not change; lint and
   format are development tools and nothing of them ships. The packages'
   `bun-types ^1.4.3` and `@types/bun ^1.4.2` devDependency ranges do not
   change either: there are no stable 1.4.4 types to point at, and the code
   uses no 1.4.4 API.
4. **Type checking does not change**: `bun check`, `bun test --check`,
   `bun run check`, `bun scripts/typecheck.ts`. The type-aware lint rules run
   their own type check; they add to `bun check`, they do not replace it.
5. **The docs say** (CLAUDE.md's floor paragraph, `docs/agentic-setup.md`,
   the `bun-node-check` skill, `MIN_BUN`'s refusal message):
   - developing needs **`bun upgrade --canary`** until 1.4.4 is stable, and
     plain `bun upgrade` after;
   - the build everything was verified on, **1.4.4-canary.1+5f5799ed1**
     (`bun --revision`), and that the plan's numbers are as old as it;
   - **a later canary can change rule or format output**: a new finding or a
     reformatted file after `bun upgrade --canary` is the canary's, and is
     reported to the plan lead with both revisions rather than fixed in
     passing;
   - using the packages still needs only 1.4.2.

This sets aside the repository's rule of not depending on a canary-only fix
(memory `bun-workarounds-until-stable`) for these two commands, by the user's
decision. It does not extend to other canary behaviour: a Bun-bug workaround
still waits for a stable release.

## 7. PRs

**Owners** (2026-10-17; the earlier 4c, d6, 5a and "main" are retired):

| Short name | Agent | Owns |
|---|---|---|
| Common | Bun-Node Common, Validate & Cache Agent | `packages/bun-common` |
| Nest | Bun-Node Nest Agent | `packages/bun-nest` |
| Jobs | Bun-Node Jobs & Telemetry Agent | `packages/bun-jobs` |
| UI | Bun-Node UI, Views & Client Agent | `packages/bun-jobs-ui`, `playground/` |
| Tooling | Bun-Node Examples & Tooling Agent | `examples/**`, `scripts/`, the `templates/` tooling; leads this plan |
| Main | the features (main) agent | reviews every edit to `CLAUDE.md` and `docs/agentic-setup.md`, which are shared files |

Efforts are working days. Every PR follows `docs/agentic-setup.md`: one
owner, reviewers named here, the user's approval for each commit, PR and
merge.

**Order:**

```text
A ──┬── B-common, B-nest, B-jobs, B-tooling ──┐
    ├── C ── B-ui ────────────────────────────┤
    └── D ────────────────────────────────────┴── E (quiet window) ── F (one merge window later)
```

### PR A: the floor, the config, the scripts, the docs

**Owner** Tooling. **Reviewers** Main (`CLAUDE.md`,
`docs/agentic-setup.md`), and each owner for the files in their directory.
**Effort** 1.5. **Depends on** nothing.

- **The floor** (§6): root `package.json` `packageManager: bun@1.4.4`,
  `engines.bun >=1.4.4`; `scripts/typecheck.ts` `MIN_BUN = "1.4.4"`, its
  header comment (`:16`) and its refusal message (`:218-221`), which says
  `bun upgrade --canary` until 1.4.4 is stable. The packages' `engines`, their
  `@types/bun` peer and the `bun-types` / `@types/bun` devDependency ranges are
  unchanged.
- **The config**: the root `bunfig.toml` of §4, `[lint]` and `[fmt]`,
  reviewed rule by rule from
  [`evidence/rules/bunfig.answered.toml`](evidence/rules/bunfig.answered.toml)
  with Q13 and Q14 settled; `templates/compute-provider/bunfig.toml`, the
  template's own copy (which needs `eslint-plugin-regexp` among the
  template's devDependencies, or leaves the plugin out: settled here).
- **ESLint stays the gate, renamed.** The 11 `eslint.config.mjs` become
  `eslint.legacy.config.mjs` (`templates/eslint.config.mjs` included), because
  a `[lint]` section next to an `eslint.config.mjs` makes `bun lint` fail, and
  a renamed one is invisible to Bun while `eslint -c` still runs it (§4,
  measured). Each of the 11 directories gets two scripts: `"lint": "bun lint"`
  (inside a `lint` script `bun lint` is the linter, per Bun's docs) and
  `"lint:eslint": "eslint -c eslint.legacy.config.mjs ."`, the gate until PR E.
  The six `tsconfig.json` `include`s that name `eslint.config.mjs` follow the
  rename. `.vscode/settings.json` keeps `eslint.workingDirectories` and adds
  `"eslint.options": { "overrideConfigFile": "eslint.legacy.config.mjs" }`;
  that the ESLint extension honours it in every working directory is checked
  in this PR (not measured yet).
- **Both tools read the same directives**: `.renamePlugins({ ts:
  "@typescript-eslint", node: "n" })` on each antfu composer and the 19
  `ts/…` directive lines renamed in the same change (the old P0-1: measured on
  bun-common, ESLint stays green and Bun's doctor goes from 98 to 124 native
  rules). The other 5 lines (`antfu/no-top-level-await`,
  `unused-imports/no-unused-vars`) are names only ESLint knows; this PR finds a
  spelling both accept (listing both names in one directive is the first
  thing to try) or leaves them to PR E. Without the renames 91 findings
  reappear in `bun lint` (2026-10-16, at 930dd664). develop has gained one
  since, `packages/bun-nest/lib/BunWebSocketAdapter.ts:80`
  (`ts/no-require-imports`, from #404), so PR A recounts on its own base and
  renames whatever is there.
- **The 3 `no-throw-literal` directives name `@typescript-eslint/only-throw-error`**
  (`examples/bun-common/12-options/native-utilities.ts:1991`,
  `packages/bun-common/__tests__/fetch.test.ts:777`,
  `packages/bun-nest/__tests__/httpAdapter.test.ts:742`), the rule that
  `--type-aware` runs in `no-throw-literal`'s place. Bun today lets the old
  name silence its typescript-eslint twin, where ESLint would not and would
  call the directive unused
  ([oven-sh/bun#45785](https://github.com/oven-sh/bun/issues/45785)); naming
  the rule that actually reports makes the directive mean the same whatever
  Bun decides. Each line is checked under both tools in this PR.
- **No `format` script yet.** Until the reformat in PR E, Prettier 3.8.4
  (through `prettier/prettier`) and `bun fmt` disagree on 78 files, so running
  `bun fmt` on a directory would fail ESLint's gate. `[fmt]` is in the
  `bunfig.toml` from here; the docs say not to run `bun fmt` on whole
  directories before PR E.
- **The docs**, every place in §2's "Every place that tells people or agents
  to run ESLint", on the current lines:
  - `CLAUDE.md`: the floor paragraph (dev floor 1.4.4 canary,
    `bun upgrade --canary`, the build verified on, the warning that a later
    canary can change output; the users' floor unchanged), the dev workflow
    (`bun run lint` beside `bun run lint:eslint`, the gate until PR E), the
    scripts and template sections. **Kept as it is**: the
    `bun install --frozen-lockfile` wording for the bench directories,
    `benchmarks/` and the template in fresh worktrees (#401, develop
    `56d6afde`); the floor raise in `package.json` and `engines` must not undo
    it. (The floor paragraph's "`@types/bun` 1.4.3 is not on npm yet" is no
    longer true: npm has `@types/bun` 1.4.3, 2026-10-17. Whether to take it is
    not this plan's call.)
  - `docs/agentic-setup.md:120, 275, 328, 502` (the lint commands and the
    "Direct, no wrapper" list).
  - `.claude/skills/bun-node-check/SKILL.md:22, 27, 31, 40`.
  - The root and package READMEs' lint lines wait for PR E, since they name
    the gate.
- **Checks**: `bun scripts/typecheck.ts`; `bun run test:scripts`;
  `bun run lint:eslint` green in all 11 directories (the gate is unchanged);
  `bun lint` runs in all 11 and reports the findings PR B fixes (it exits 1
  until then, and gates nothing); `git grep -n "eslint.config.mjs"` finds
  nothing outside `docs/`.
- **CHANGE REPORT** to every agent: `bun upgrade --canary`, the renamed
  configs, the two lint scripts, that ESLint is still the gate, and each
  owner's findings file in [`evidence/type-aware/`](evidence/type-aware/README.md)
  to be re-measured on their branch.

### PR B: the findings, one PR per owner

**Owner** each owner, for their directories. **Reviewer** Tooling (the rule
choices), and Main for nothing unless a fix needs a shared file.
**Depends on** A; B-ui also on C. **Effort**: the errors and default rules
below, plus the warnings once Q12 is answered (2,517 of the 2,657
`no-unnecessary-type-assertion` warnings carry an automatic fix; run
`bun run check` after `bun lint --fix`, because some of those assertions are
in type tests).

Each PR makes `bun lint` exit 0 in its directories: the type-aware findings,
Bun's default bug rules (Q5) and the rule-upstream differences of §3, with
`bun run lint:eslint` still green. The figures are 2026-10-17's on develop
`930dd664`; each owner re-measures on their branch with `bun run lint -f
json`.

| PR | Directories | Default rules: errors / warnings (not `no-console`) | Type-aware: errors / warnings | Notable | Effort, errors and defaults |
|---|---|---|---|---|---|
| **B-common** (Common) | `packages/bun-common` | 6 / 3 | 35 / 306 | 5 un-awaited `expect(…).rejects`, 1 duplicate test title (`__tests__/httpAdapter.test.ts:230`), 11 `no-floating-promises` | 0.5 |
| **B-nest** (Nest) | `packages/bun-nest` | 3 / 0 | 8 / 261 | 1 duplicate title (`__tests__/httpAdapter.test.ts:192`), 2 `n/handle-callback-err` on overload signatures (`lib/interceptors.ts:121,123`), 5 `no-misused-promises` | 0.5 |
| **B-jobs** (Jobs) | `packages/bun-jobs` | 16 / 30 | 145 / 4,684 | 6 un-awaited `expect(…).rejects`, `#addDefined` unused (`lib/BunJobs.ts:1375`), 86 `no-floating-promises`, 32 `unbound-method`, 11 `no-disabled-tests` | 1.5 |
| **B-ui** (UI) | `packages/bun-jobs-ui`, `playground` | 3 / 4 | 3 / 780 | 1 un-awaited `expect(…).rejects`, `#pinged` unused (`app/live/client.ts:313`), 2 `bun:test/no-export` outside `__tests__/helpers/`; 619 `no-unnecessary-type-assertion` | 0.5 |
| **B-tooling** (Tooling) | `scripts`, `templates/compute-provider`, `examples/*` | 2 / 3 | 61 / 1,297 | 36 `no-floating-promises` and 364 `no-unsafe-member-access` in `examples/bun-jobs` | 1 |

The full list per directory is in
[`evidence/type-aware/`](evidence/type-aware/README.md), one file each.

### PR C: the bun-jobs-ui leak test

**Owner** UI. **Reviewer** Tooling. **Effort** 2.5 to 3. **Depends on**
nothing. **Lands before** B-ui and before PR F removes `@eslint-react`, so
there is no window with neither guard (the plan lead's decision).

`packages/bun-jobs-ui/__tests__/app/unmountLeaks.test.tsx` takes the place of
`@eslint-react`'s `web-api-no-leaked-*` and `jsx-no-key-after-spread`, which
Q1 drops. Designed and prototyped by the UI agent (in
`~/.cache/bun-node-99/leak-test-design/`: `progress.md`,
`prototype/handleLedger.ts`, `prototype/unmountLeaks.test.tsx`,
`static-check.ts`):

- A per-test **HandleLedger** wraps timers, `requestAnimationFrame`, window
  and document listeners, `WebSocket` and `EventSource`, observers, and the
  API client's `fetch`.
- It mounts the real app with live updates on, about 20 screen and panel
  cases plus 3 transient ones. Each case asserts that it started (no vacuous
  pass), navigates away, tears down fully, and asserts zero residue. It runs
  under `StrictMode`, with **13 negative controls**, one per handle kind.
- A **static tripwire** comes with it: every opener has its closer in the same
  file, and every `queryFn` takes `signal`. It is partial, and says so.
- **Measured on the prototype**: 17 of 17 in about 2.3 s; 85 of 85 with
  `--randomize --rerun-each=5`; green under `--parallel`; the whole
  bun-jobs-ui suite, serial and randomised, with it included: 1,885 pass, 0
  fail. The survey found no leak today: 9 hand-written handle sites, all
  cleaned up.

### PR D: the VS Code extension

**Owner** Tooling. **Reviewers** UI (the React diagnostics), Main.
**Effort** 2.5 (the 2 days of 2026-10-16, plus the type-aware rules and the
11-directory test). **Depends on** A (the root `bunfig.toml`). What it must do
is §5. It lands opt-in: `.vscode` changes in PR E.

### PR E: the flip, with the one-time reformat

**Owner** Tooling. **Reviewers** every owner, Main (`CLAUDE.md`,
`docs/agentic-setup.md`). **Effort** 1. **Depends on** every B, C and D.
**When**: a quiet merge window agreed beforehand with the Nest and Common
agents, whose Nest 12 and bun-common PRs are in flight, so their branches
rebase once.

- **The reformat**, in a commit that does nothing else: `bun fmt` from the
  root, re-measured that day (89 files, +371 −506 on `930dd664`: Jobs 40,
  Common 19, UI 15, Nest 2, examples 6, `benchmarks/` 3, `playground`,
  `scripts`, the template and `lerna.json` 1 each). Its hash goes in a new
  `.git-blame-ignore-revs`, and the docs say `git config
  blame.ignoreRevsFile .git-blame-ignore-revs`.
- **The gate**: `bun lint` and a separate `bun fmt --check` (Q6). Each of the
  11 directories gets `"format": "bun fmt"` and `"format:check": "bun fmt
  --check"`; `lint:eslint` goes, and no gate runs ESLint. `bun/format` stays
  off.
- **The editor**: `.vscode/settings.json` drops `eslint.workingDirectories`
  and `eslint.options` and sets `editor.defaultFormatter` to the extension;
  `.vscode/extensions.json` recommends it and puts `dbaeumer.vscode-eslint` in
  `unwantedRecommendations` (§5).
- **The docs**: every gate description in `CLAUDE.md`,
  `docs/agentic-setup.md` and the `bun-node-check` skill, the root and package
  READMEs' lint lines, and `examples/**/README.md`. The heavy-run notes'
  "lint in any directory" stays "not heavy": the type-aware run is 11 s for
  all 11 directories.
- **Checks**: `bun lint` and `bun fmt --check` exit 0 in all 11 directories;
  `bun scripts/typecheck.ts`; `bun scripts/generate-verb-overloads.ts
  --check`; every package's `bun run test`; the bun-jobs doc tests and both
  README-parsing examples (`permissions.ts`, `scaler-recipes.ts`), though
  Markdown is not formatted.
- **CHANGE REPORT** to every agent, at the merge: the new gate commands, the
  reformat commit to rebase over (and how: `git rebase` with the formatter
  run on conflicts, not by hand), the blame-ignore setting, the extension and
  how to install it, the rules that changed (§3), and the canary warning
  (§6).

### PR F: remove ESLint and Prettier

**Owner** Tooling. **Reviewers** every owner. **Effort** 1. **Depends on** E,
one merge window later, once every owner has gated on `bun lint` at least
once.

- The 11 `eslint.legacy.config.mjs`; `@antfu/eslint-config`, `eslint`,
  `prettier`, `eslint-config-prettier`, `eslint-plugin-prettier`,
  `@eslint-react/eslint-plugin` (after C), `eslint-plugin-react-hooks`,
  `eslint-plugin-react-refresh` and `@nx/eslint` from the five
  `package.json`s; `eslint-plugin-regexp` stays, as a root devDependency
  (Q1), with `eslint` installed beside it as its peer unless Q14 turns peer
  installs off; the `tsconfig.json` `include` entries; the `TS2742`/`TS2883`
  filter (`scripts/typecheck.ts:69-76`) and its test
  (`scripts/__tests__/typecheck.test.ts:80`), or keep them as harmless;
  `.eslintcache` in three `.gitignore`s; the `bun.lock`s, the template's and
  the bench directories' included, installed with `--frozen-lockfile`
  afterwards as CLAUDE.md prescribes.
- **Checks**: `bun scripts/typecheck.ts`; every package's `bun run test`;
  `bun scripts/consumer-check.ts` for all four packages (devDependencies never
  ship, so every cell must be unchanged: bun-common 92/92, bun-nest 66/66,
  bun-jobs 96/96, bun-jobs-ui 44/44); the four `__tests__/packaging.test.ts`;
  and `bun pm ls` in each package lists none of the removed names.
- **CHANGE REPORT** to every agent: what left the dependency trees, and that
  a stale worktree needs `bun install --frozen-lockfile`.

**Total**: about 13 working days of effort across six agents, with the
type-aware warnings on top (Q12). On the critical path: A (1.5), then C (3)
and B-ui (0.5) or B-jobs (1.5), then E (1) in the agreed window, then F a
window later.

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **A later canary changes rule or format output.** The floor is a canary that moves daily; 15 lint/fmt issues were open on 2026-10-16. A `bun upgrade --canary` can add findings, drop them or reformat files nobody touched. | high until 1.4.4 is stable | The docs name the verified build (1.4.4-canary.1+5f5799ed1) and say a new finding or reformat after an upgrade is reported with both revisions, not fixed in passing (§6). `evidence/tools/answered-run.sh` re-measures the 11 directories in seconds; it is re-run on the build PR E lands on and on each upgrade after. |
| **Two sessions on two canaries see two answers**, and the floor cannot tell them apart: every 1.4.4 canary reports `Bun.version` "1.4.4", which `>=1.4.4` and `MIN_BUN` accept (measured). | medium | Quote `bun --revision` in every finding that differs between sessions and in each CHANGE REPORT. A check of `Bun.revision` against the verified build is possible but would warn on every canary; not proposed. |
| **1.4.4 stable differs from the canary**, or ships one command and not the other. | possible | The floor accepts stable unchanged; re-run the measurements on it and land differences as an ordinary PR. `bun fmt` and `bun lint` are independent gates (Q6). |
| **Q1's dropped React leak rules**: `@eslint-react`'s `web-api-no-leaked-*` and `jsx-no-key-after-spread` go, and with them the only check that an effect cleans up its timers and listeners. | medium | PR C, the mount/unmount leak test, lands before the UI findings PR and before PR F removes `@eslint-react`, so there is no window with neither guard. Partial: it covers the app as tested, not new code until a case is added for it; its static tripwire says it is partial. |
| **The type-aware findings are not cleared before the flip**: 7,580 on 2026-10-17, 4,829 in bun-jobs, while every owner has other work in flight. | high | Q12 decides what "fixed" means for the 7,328 warnings. The 252 errors are fixed in PR B; 2,517 warnings fix themselves with `bun lint --fix` (then `bun run check`, because some assertions sit in type tests). |
| **Bun's type-aware rules differ from typescript-eslint** in places: 2 of 341 findings each way on bun-common, reduced in [`evidence/repros/`](evidence/repros/README.md) (`unbound-method` on a union-keyed element access; a core rule's directive silencing its typescript-eslint twin, which hides 3 `only-throw-error` findings under `no-throw-literal` directives). | low, small | Listed for the plan lead to file. Rename those 3 directives to `@typescript-eslint/only-throw-error` in PR B, which both tools read. |
| **`eslint` stays in `node_modules`** as `eslint-plugin-regexp`'s peer, so "no `eslint` package" holds only for our `package.json`s (measured: 83 packages with peers, 9 without). | certain | Q14: accept it (installed, never run) or set `[install] peer = false`, which changes every install in the monorepo and needs its own measurement. |
| **Rule semantics drift** between Bun's ports and the plugins we run (import-lite vs import, oxlint's unicorn and `node` rules, `{@link}`-aware unused imports, Bun's own defaults). | high, small | Generated config with explicit options; the findings of each are in PR B's tables. |
| **ESLint and `bun lint` side by side** between PR A and PR E: a `[lint]` section next to an `eslint.config.mjs` breaks `bun lint` (measured). | certain without the rename | PR A renames the configs to `eslint.legacy.config.mjs` and runs ESLint with `-c`. Whether the ESLint extension honours `eslint.options.overrideConfigFile` in every working directory is checked in PR A; if not, editor diagnostics are missing until PR D. |
| **Formatter churn**: 89 files at the flip, 40 of them bun-jobs'. Open branches conflict. | certain, bounded | One commit that does nothing else, in a quiet window agreed with the Nest and Common agents, listed in `.git-blame-ignore-revs`; peers rebase once. |
| **Parsed READMEs**: a reformat can break `permissions.ts`, `scaler-recipes.ts` or the provider guide's excerpts. | low | Markdown is not formatted (Q3). PR E still runs the three checks. |
| **Editor regression**: the extension is ours to maintain, and loses Markdown and JSON diagnostics; a lint call costs about 0.3 to 0.45 s per file. | medium | Keep it small (two child processes, one JSON parser), lint on open, save and a debounced change; delete it when Bun ships an LSP. |
| **`bun lint` output depends on the environment**: an agent session gets a tagged "agent" format. | certain | Scripts and the extension pass `-f json` or `-f unix` and drop `AGENT`, `CLAUDECODE` and `REPL_ID`. |
| **One `bunfig.toml` for everything**: it is chosen from the working directory up, not per file, so a nested one silently stops applying when run from higher up. | low | One root file plus the template's own; the gate and the extension run from each directory. |

## 9. Questions, and the user's answers

Q1 to Q11 were asked on 2026-10-16 and **answered by the user on
2026-10-17**. Each keeps its original options and recommendation, then the
answer and what the measurement of 2026-10-17 adds. Q12 to Q14 are new: the
measurements raised them.

1. **How native?** (a) native rules plus `eslint-plugin-regexp` only, no
   `eslint` package (**recommended**); (b) also keep perfectionist, jsdoc,
   `@eslint-react` and Markdown/JSON linting, which needs the `eslint` package
   installed as a library (Bun loads it; it never runs as a CLI); (c) native
   only, dropping `regexp` too. The price of (a) over (c) is measured: 8.1 s
   against 0.44 s for the 11 directories, still 15 times faster than ESLint;
   (b) would be about 25 s plus `@eslint-react`. Ask d6 about
   `@eslint-react`'s leak rules before deciding.
   - **Answer (2026-10-17): (a).** The UI app's React leak rules
     (`web-api-no-leaked-*`, `jsx-no-key-after-spread`) are dropped; the UI
     agent adds a mount/unmount test asserting no timers or listeners remain,
     landing before or with the PR that removes `@eslint-react` (§7, PR C:
     before).
   - **Measured**: the plugin runs in `bun lint` with no `eslint` installed,
     but only with peer installs off; by default Bun installs `eslint` 10.13.0
     as its peer (Q14). The answered config takes 6.5 s.
2. **Import order.** (a) Drop perfectionist and let order drift
   (**recommended**: order carries no meaning, and the fixer churns every
   import block it touches); (b) `bun fmt` `[fmt.sortImports]` with
   perfectionist's groups, 449 files once; (c) keep perfectionist (needs 1b).
   - **Answer (2026-10-17): drop import sorting**: no perfectionist, no
     `sortImports`.
3. **Markdown.** (a) Not formatted, as today (**recommended**); (b) formatted
   with code blocks left alone (32 files once, tables realigned; the three
   parsers pass, measured).
   - **Answer (2026-10-17): don't format Markdown.** `[fmt]` ignores
     `**/*.md`.
4. **The `bun:test` style rules our vitest rules were meant to be**
   (`prefer-lowercase-title` 465, `prefer-hooks-in-order` 37,
   `consistent-test-it` 31). **Recommended: off**, keeping
   `no-focused-tests` and `no-identical-title`. Turning on
   `prefer-lowercase-title` would rename 465 tests.
   - **Answer (2026-10-17): off**, keeping `no-focused-tests` and
     `no-identical-title`.
5. **Bun's default bug rules** (`valid-expect`, `no-useless-assignment`,
   `preserve-caught-error`, `no-unused-private-class-members`,
   `no-disabled-tests`): **recommended: keep**, after fixing the 16 findings
   (P0-3), with `bun:test/no-export` off in test files (its 7 findings are
   all in `__tests__/helpers/`).
   - **Answer (2026-10-17): keep them; fix the 16 findings;
     `bun:test/no-export` off in `__tests__/helpers/`.**
   - **Measured**: the 16 are still 16. With the override, 2 `no-export`
     findings remain, outside `__tests__/helpers/`
     (`packages/bun-jobs-ui/__tests__/app/job/jobScreen.test.tsx:539`,
     `__tests__/server/budget.test.ts:32`); they are fixed in B-ui. All 70
     default-rule findings are in PR B's table.
6. **One gate step or two?** `bun/format` inside `bun lint` (one command,
   format problems listed with lint problems) or `bun fmt --check` separately
   (**recommended**: one tool per question, and `bun fmt` also covers CSS and
   HTML).
   - **Answer (2026-10-17): a separate `bun fmt --check` step.**
     `bun/format` is off. Measured: 0.08 to 0.10 s from the root.
7. **Move the code reformat forward** into phase 0 as a Prettier 3.9 bump
   (P0-2)? **Recommended: yes**, in the next merge window.
   - **Answer (2026-10-17): moot.** No Prettier 3.9 step: the reformat is
     `bun fmt`'s own, done once at the flip with a `.git-blame-ignore-revs`
     entry. P0-2 is gone. Measured: 89 files, +371 −506.
8. **Explicit `Buffer`/`process` imports** (`node/prefer-global/*`; 392
   files import them from `node:buffer` / `node:process`, 49 of them in
   packages' `lib/`): keep as a `no-restricted-globals` rule, or let it go?
   **Recommended: let it go**; under Bun both globals are always there.
   - **Answer (2026-10-17): keep enforcing them**, as a
     `no-restricted-globals` rule, against the recommendation.
   - **Measured**: it works under `bun lint`. 0 files flagged today (399 files
     import them, 52 in `lib/`); a planted `Buffer.from` and `process.env`
     are reported, `process` is allowed in tests as antfu allows it, and a
     type-only `Buffer` is not reported (§3).
9. **The editor**: build the in-repo extension (**recommended**, 2 days), or
   stay on the ESLint extension, which means keeping ESLint and the antfu
   config installed only for the editor until Bun ships an LSP?
   - **Answer (2026-10-17): build it.** None exists: nothing on the VS
     Marketplace or Open VSX, no GitHub repository, and `oven.bun-vscode` on
     `main` (0.0.31) has only run and debug commands. It must cover all 11
     directories, and then replaces the ESLint extension in `.vscode`
     (recommendations and settings). §5 and §7, PR D.
10. **A Git hook** (`bun lint --staged`, `bun fmt --staged`, which re-stages):
    **recommended: no**. Several sessions commit from many worktrees, and a
    hook that rewrites staged files is a surprise there; the gate is enough.
    - **Answer (2026-10-17): no Git hook.**
11. **Type-aware rules** (`bun lint --type-aware`, e.g.
    `no-floating-promises`, using `bun check`'s types): new capability, not
    part of parity. **Recommended**: a follow-up plan with its own
    measurements, after the switch.
    - **Answer (2026-10-17): in this switch**, against the recommendation.
      Measure the first run's findings and cost; each owner fixes their
      package's findings before the gate flips.
    - **Measured**: 11.1 s against 6.5 s, 34 s CPU against 11 s; 7,580
      findings, 252 errors and 7,328 warnings, per directory and rule in
      [`evidence/type-aware/`](evidence/type-aware/README.md).
      `typeAware = true` in `[lint]` works like the flag, so the gate and the
      editor need no flag.

**New questions (2026-10-17), for the user through the plan lead:**

12. **What "fixed" means for the type-aware findings before the flip**, and
    whether any of the 24 rules starts as a warning or off. Q11 says each
    owner fixes their package's findings before the gate flips; the cost is
    in §1, "What Q11 costs": 252 errors, 7,328 warnings, 2,531 of the warnings
    with an automatic fix, 4,797 without one (10 to 20 working days by
    estimate, two thirds of it bun-jobs').
    (a) every finding fixed, or suppressed with a reason, before the flip;
    (b) **recommended**: all 24 rules on; the 8 error rules
    (`no-floating-promises`, `unbound-method`, `restrict-template-expressions`,
    `prefer-promise-reject-errors`, `no-misused-promises`, `only-throw-error`,
    `restrict-plus-operands`, `no-implied-eval`) stay errors and their 252
    findings are fixed in PR B; the automatic fixes are applied in PR B
    (then `bun run check`); the five `no-unsafe-*` rules, `require-await` and
    `await-thenable` start **off in test files** (3,456 warnings); the remaining 1,341 warnings stay
    warnings, which do not fail the gate, and each owner clears them after
    the flip, a rule moving to error once its count is 0;
    (c) like (b), but the warnings recorded with `bun lint --suppress-all`
    (`eslint-suppressions.json`), so only new ones are reported;
    (d) the high-volume warning rules (`no-unnecessary-type-assertion`,
    `no-unsafe-member-access`, `require-await`, `no-unsafe-assignment`) off
    everywhere until a later plan.
13. **`no-useless-escape` is on twice.** Bun's default core rule (which our
    ESLint config never enabled) and `regexp/no-useless-escape` both check
    regular expressions, and disagree on `\-` in a character class: all 5
    core findings are that, in bun-jobs' redaction patterns. (a)
    **recommended**: turn the core rule off, leaving regular expressions to
    `regexp`, as our ESLint config does today; (b) keep it and fix the 5.
14. **"No `eslint` package"** (Q1): the plugin runs without `eslint`, but
    keeping it out of `node_modules` needs `[install] peer = false` (§1,
    "Q1's catch"). (a) **recommended**: accept `eslint` installed as
    `eslint-plugin-regexp`'s peer, never run (no setting changes); (b) set
    `[install] peer = false` at the root so it is not installed, which changes
    peer installation for every package in the monorepo and needs its own
    measurement before it is proposed.
