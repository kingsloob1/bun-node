# Adopting `bun lint` and `bun fmt`

**Status:** plan, 2026-10-16. Nothing here is implemented. Written by the
features (main) agent at the user's request:

> Bun canary currently supports lint and fmt which is very performant. What is
> the plan to adopt it as part of our tooling. Dropping eslint, prettier,
> oxlint while still maintaining vscode usability?

Everything Bun-side was measured or read on **Bun 1.4.4-canary.1+5f5799ed1**
(`bun --revision`), in scratch clones of develop at `f9baf24a`, on this
16-core machine. Our setup is cited as `file:line` on that commit (and on
develop `92196c87` for `.vscode/settings.json`, which #396 changed today).
The workings are in [`evidence/`](evidence/README.md).

## Contents

1. [Summary](#1-summary)
2. [What we run today](#2-what-we-run-today)
3. [Rule parity](#3-rule-parity)
4. [Formatter parity, and the proposed `bunfig.toml`](#4-formatter-parity-and-the-proposed-bunfigtoml)
5. [VS Code](#5-vs-code)
6. [Stability, floors and gating](#6-stability-floors-and-gating)
7. [Migration phases and PRs](#7-migration-phases-and-prs)
8. [Risks](#8-risks)
9. [Open questions for the user](#9-open-questions-for-the-user)

## 1. Summary

**What we gain, measured.**

- **Speed.** Linting the 11 directories that have an ESLint config takes
  ESLint **126 s** of wall time (212 s CPU), median of three runs at a load of
  2 to 8. Native `bun lint` with the equivalent rule set takes **0.44 s**
  (3 s CPU); one `bun lint` over the whole repository from the root, 0.26 s.
  With `eslint-plugin-regexp` kept as a JavaScript plugin, as recommended,
  **8.1 s** (16.5 s CPU): one JS plugin costs more than all the native rules
  together. `bun fmt --check` over the whole repository (2,256 files) takes
  **0.15 s**, against 28.4 s for Prettier 3.8.4 checking only the 1,651 code
  files ESLint formats today. Pointing `bun lint` at our unchanged ESLint
  config is not the shortcut it looks like: 78 s, and more CPU than ESLint
  (305 s). Details in [`evidence/perf/`](evidence/perf/README.md).
- **A smaller tree.** ESLint, Prettier, `@antfu/eslint-config` and the
  plugins it pulls in leave every package's `devDependencies`, and the 11
  `eslint.config.mjs` files (764 lines) become one root `bunfig.toml`.
- **Real defects the default rules find today**: 12 un-awaited
  `expect(…).rejects` (bun-jobs 6, bun-common 5, bun-jobs-ui 1), 2 duplicate
  test titles, 2 unused private class members
  ([`evidence/lint-shadow/`](evidence/lint-shadow/README.md)). Our ESLint
  misses them, partly because the `test/` rules we run are vitest's and never
  fire on `bun:test` imports.
- **Faithful formatting.** `bun fmt` is byte-identical to Prettier 3.9.10 on
  all 1,651 code files in the lint scope and on all 152 Markdown, CSS, HTML
  and Vue files Prettier can read. `--debug-check` finds no change of meaning
  in 2,256 files.

**What we lose.** 172 of the 384 rules we run have no native counterpart
(`regexp` 60, `jsonc` 38, `@eslint-react` 21, `jsdoc` 17, `markdown` 15, and
21 smaller ones), Markdown and JSON linting, import sorting as perfectionist
does it, and the ESLint VS Code extension, which has no Bun counterpart: an
in-repo extension has to take its place (§5). The 85 rules that do have a counterpart
under another name or upstream behave slightly differently in places
(§3). Nothing ESLint reports on today's tree is lost: the shadow run
reproduced all 71 of its findings.

**Recommendation.**

1. **Go native, keep one JavaScript plugin.** A root `bunfig.toml` with the
   127 + 85 native rules and `eslint-plugin-regexp` loaded as a JS plugin,
   which runs without the `eslint` package. Drop perfectionist, jsdoc,
   `@eslint-react`'s extra rules, Markdown and JSON linting, or keep any of
   them only by keeping the `eslint` package installed as a library (§9, Q1).
2. **`bun fmt` replaces Prettier**, configured to print what we print today
   (`singleAttributePerLine = true`), with Markdown left out as it is today.
3. **VS Code**: keep the ESLint extension, against the unchanged
   `eslint.config.mjs` files, until the switch; at the switch, ship a small
   in-repo extension that runs `bun lint --stdin -f json` and
   `bun fmt --stdin-filepath` (§5). It gives inline diagnostics, quick fixes,
   format on save and format selection for all 11 directories.
4. **Gate on a stable release.** `bun lint` and `bun fmt` do not exist in
   Bun 1.4.3, the latest stable (measured: `Script not found "lint"`), and no
   release has announced them. Do the preparation that is useful whatever
   Bun ships now (canonical rule names, the Prettier 3.9 reformat, the defects
   above), shadow-run on canary, and switch the gates in the PR that raises the
   dev floor to the first stable release that has both commands (§6).

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
- **Every place that tells people or agents to run ESLint** (each changes in
  the switch PR):
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
  31 `consistent-test-it`) and Bun's default bug rules (`valid-expect`,
  `no-useless-assignment`, `preserve-caught-error`,
  `no-unused-private-class-members`, `no-disabled-tests`). §9, Q4 and Q5.
- **Missing rules that matter**, in order: `regexp` (ReDoS and wrong
  patterns; kept as a JS plugin in the recommendation), perfectionist import
  order (§9, Q2), Markdown linting of the parsed READMEs and the guide's code
  blocks (§9, Q3), `@eslint-react`'s `web-api-no-leaked-*` effect-cleanup
  rules (bun-jobs-ui, §9, Q1). The rest are layout or modernisation hints.

## 4. Formatter parity, and the proposed `bunfig.toml`

Full results: [`evidence/format/`](evidence/format/README.md).

- **Code: no hard differences.** On the 1,651 code files in the lint scope,
  `bun fmt` with `singleAttributePerLine = true` equals Prettier 3.9.10 byte
  for byte. It differs from our Prettier 3.8.4 on **78 files (+168 −365)**,
  every hunk a Prettier 3.9 change (107 of 124 are union types collapsed onto
  one line). That reformat is due whichever tool we use, the day we bump
  Prettier.
- **Style options.** Our inline Prettier options are Prettier's defaults
  except `singleAttributePerLine: true`
  (`packages/bun-common/eslint.config.mjs:56-68`). Without it in `[fmt]`, 107
  more `.tsx` files change. That is the only style key we need.
- **Idempotent** on everything in the lint scope. On 4 plan-evidence files
  neither Prettier 3.9.10 nor `bun fmt` is idempotent, identically.
- **Markdown is the risk.** Formatting every `.md` changes 114 files, and,
  because `bun fmt` (like Prettier) also formats code blocks inside Markdown,
  it broke the provider guide's verbatim-excerpt test
  (`docs/providers/author-guide.md:818: not a verbatim excerpt`). With
  `embeddedLanguageFormatting = "off"` for Markdown, the 32 Markdown files
  outside `docs/plans/` reformat (+2,549 −2,525, mostly table realignment),
  the bun-jobs doc tests pass 25/25, and the two README-parsing examples pass
  (`permissions.ts` 468 checks, `scaler-recipes.ts` 15).
- **Generated overloads untouched.** After formatting,
  `bun scripts/generate-verb-overloads.ts --check` is green; no hunk falls
  inside a `BEGIN generated typed overloads` block.
- **`bunfig.toml` is found from the working directory up, not per file.**
  `bun lint` in `packages/bun-common` used `../../bunfig.toml`; a
  `bunfig.toml` inside `templates/compute-provider` won when run from there
  and was ignored when run from the root (measured). So the repository gets
  **one root `bunfig.toml`**, with per-directory differences as
  `[[lint.overrides]]` and `[[fmt.overrides]]` (globs relative to the file),
  and the template gets **its own** `bunfig.toml` for when it is copied out,
  which needs no dependencies, unlike today's `templates/eslint.config.mjs`.

### Proposed root `bunfig.toml`

The full `[lint]` section is generated, not hand-written:
[`evidence/rules/bunfig.native-regexp.toml`](evidence/rules/bunfig.native-regexp.toml)
(285 lines). Its shape, with the decisions for the user marked **[Q n]**
(§9):

```toml
[lint]
ignorePatterns = ["**/dist/**", "**/dts/**", "docs/**", "benchmarks/**"]
reportUnusedDisableDirectives = "warn"     # as ESLint's linterOptions does today
plugins = [{ name = "regexp", specifier = "eslint-plugin-regexp" }]   # [Q1]

[lint.rules]
# 127 + 85 native rules at today's severities and options, generated from
# `eslint --print-config`; our offs stated explicitly, because Bun's defaults
# fill every gap (`@typescript-eslint/no-explicit-any` gave 615 warnings
# until it was).
"no-console" = "warn"
"@typescript-eslint/no-unused-vars" = ["error", { args = "after-used", argsIgnorePattern = "^_", caughtErrorsIgnorePattern = "^_", ignoreRestSiblings = true, vars = "all", varsIgnorePattern = "^_" }]
"@typescript-eslint/no-namespace" = ["error", { allowDeclarations = false }]
"import/consistent-type-specifier-style" = ["error", "prefer-top-level"]
"bun/format" = "off"            # bun fmt --check is its own gate step  [Q6]
# Bun's default bug rules we keep [Q5]: bun:test/valid-expect,
# no-unused-private-class-members, no-useless-assignment, preserve-caught-error
"regexp/no-super-linear-backtracking" = "error"   # … and the other 59 regexp rules

[[lint.overrides]]               # tests (antfu's GLOB_TESTS)
files = ["**/__tests__/**", "**/*.spec.*", "**/*.test.*", "**/*.bench.*", "**/*.benchmark.*"]
rules = { "n/no-top-level-await" = "off", "bun:test/no-focused-tests" = "error", "bun:test/no-identical-title" = "error", "bun:test/no-export" = "off" }   # [Q4]

[[lint.overrides]]               # React, where @eslint-react runs today
files = ["packages/bun-jobs-ui/**", "examples/bun-jobs-ui/**"]
rules = { "react/rules-of-hooks" = "error", "react/exhaustive-deps" = "warn", "react/jsx-key" = "error" }   # … 31 in all

[[lint.overrides]]               # antfu's script, cli and config-file disables
files = ["**/scripts/**", "**/cli/**", "**/*.config.*"]
rules = { "n/no-top-level-await" = "off" }

[[lint.overrides]]               # CLI entry points: printing is the product
files = ["scripts/**", "playground/**", "examples/**", "templates/*/scripts/**"]
rules = { "no-console" = "off", "n/no-top-level-await" = "off" }

[fmt]
singleAttributePerLine = true    # the one option we set that is not Prettier's default
ignorePatterns = ["**/*.md", "docs/**", "benchmarks/results/**"]   # [Q3]
# [Q2] import order: [fmt.sortImports] with perfectionist's groups, or nothing
# [fmt.sortImports]
# groups = [["type-builtin", "type-external", "type-subpath"], ["type-parent", "type-sibling", "type-index", "type-internal"], "builtin", "external", ["internal", "subpath"], ["parent", "sibling", "index"], "unknown"]
# newlinesBetween = false

# If Markdown is formatted [Q3], instead of ignoring it:
# [[fmt.overrides]]
# files = ["**/*.md"]
# options = { embeddedLanguageFormatting = "off" }
```

Two deliberate departures from the generated file: it maps
`prettier/prettier` to `bun/format = "error"`, which the proposal turns off in
favour of a separate `bun fmt --check` (Q6); and `bun fmt`, unlike our
Prettier rule, also formats CSS and HTML, so 6 files the ESLint config never
formatted (3 CSS in bun-jobs-ui, 3 HTML in bun-common's playground and
`examples/bun-common`) change at the switch unless ignored.

`templates/compute-provider/bunfig.toml` repeats the `[lint]` and `[fmt]`
sections with the template's two differences (`no-console` warn, off in its
`scripts/`), so the template stays self-contained when copied.

## 5. VS Code

**What exists.** Nothing that shows `bun lint` or `bun fmt` in an editor:

- `bun lint --help --all` and `bun fmt --help --all` both list `--lsp` as
  **"Not supported"** (under "Compatibility with oxlint" / "with oxfmt").
- The official extension, `oven.bun-vscode` (Marketplace 0.0.32; on `main`,
  `packages/bun-vscode/package.json` is 0.0.31), contributes `runFile`,
  `debugFile`, `runUnsavedCode`, the test runner, the debugger and the
  lockfile viewer. Its settings (`bun.runtime`, `bun.diagnosticsSocket.enabled`,
  `bun.test.*`, …) mention no linter or formatter, and its last commits
  (2026-07-04 and earlier) predate `bun lint`. The issue searches in
  [`evidence/bun-bugs/`](evidence/bun-bugs/README.md) found none asking for it.
- Bun's lint source does say a rule's documentation "shows up … in
  editors" (`src/lint/CLAUDE.md`), so an integration is intended; nothing is
  announced.

**Today's baseline** is the ESLint extension in all 11 directories
(`.vscode/settings.json:2-14`): inline diagnostics as you type, quick fixes
(including Prettier's, via `prettier/prettier`), "Fix all", and formatting
only through ESLint's fix-on-save if a developer has set it up (the repo sets
no formatter).

**Options.**

| Option | Diagnostics | Quick fixes | Format on save | Format selection | Cost | Verdict |
|---|---|---|---|---|---|---|
| A. Keep the ESLint extension, against `eslint.config.mjs`, until Bun ships an LSP | yes, ESLint's | yes | via ESLint fixes | no | none, but keeps ESLint, antfu and Prettier installed, and the editor disagrees with the gate wherever the rule sets differ | right **until the switch**, wrong after it |
| B. A VS Code task (`bun lint -f stylish`) with the built-in `$eslint-stylish` problem matcher | on demand, in the Problems panel | no | no | no | an hour | a fallback, not an editor experience |
| C. A run-on-save extension (`emeraldwalk.runonsave`) calling `bun fmt <file>` | no | no | rewrites the file on disk after the save, racing the editor's buffer | no | an hour | fragile |
| D. A generic stdin formatter extension (`jkillian.custom-local-formatters`) calling `bun fmt --stdin-filepath ${file}` | no | no | **yes**, through VS Code's formatter API | no | an hour | good for formatting only |
| **E. A small in-repo extension** wrapping `bun lint --stdin --stdin-filename <file> -f json` and `bun fmt --stdin-filepath <file>` | **yes**, on open, on change (debounced) and on save | **yes**, from the JSON report's `fix` and `suggestions` (measured: `prefer-const` and `bun/format` carry `fix.range`/`fix.text`) | **yes** | **yes**, with `--range-start`/`--range-end` (measured) | about 2 days, plus upkeep | **recommended** at the switch |

Measured on this machine: `bun lint --stdin` on the 5,948-line
`lib/BunRouter.ts` with the native config answers in **0.02 s**,
`bun fmt --stdin-filepath` in **under 0.01 s**: fast enough to run per
keystroke (debounced), with no server to keep warm.

**What a developer gets with E**, in every one of the 11 directories (the
extension runs `bun` with the file's directory as the working directory, so
Bun finds the root `bunfig.toml` as the gate does, and the template's own
inside the template): squiggles and the Problems panel, the rule name linking
to `bun lint --explain`, "Quick Fix…" for every fixable report and "Fix all
in file", **Format Document**, **Format Selection** and format on save
(`"editor.defaultFormatter"` set in `.vscode/settings.json`), Markdown
formatting only if Q3 says so.

**What is lost compared with today**: diagnostics for Markdown and JSON
files (no native rules), the rules dropped in §3, and "Fix all ESLint
problems" across the workspace (the gate's `bun lint --fix` does that from a
terminal). Type-aware rules are not in the proposal, so nothing is lost there.

**Distribution.** The extension lives in the repo (`tools/vscode-bun-lint/`,
outside the workspaces, its own `package.json`), is built with `bun build`,
and is installed with `code --install-extension` from a packed `.vsix`
(`bunx @vscode/vsce package`); `.vscode/extensions.json` cannot recommend a
local extension, so the README says how. When Bun ships an LSP or the
official extension learns `bun lint`, we delete ours.

## 6. Stability, floors and gating

- **Neither command is in a stable release.** Bun 1.4.3 (stable, released
  2026-10-10, the latest) answers `bun lint --help` with `error: Script not
  found "lint"`, and the same for `fmt` (measured with the npm build
  `@oven/bun-linux-x64@1.4.3`, revision `c6da4a4d3`). Its release notes do
  not mention either. No release has announced them; Bun's docs already
  describe both as if shipped.
- **The canary is moving fast.** 18 issues about `bun lint` / `bun fmt` were
  opened on oven-sh/bun between 2026-10-13 and today, 15 of them still open
  ([`evidence/bun-cli/issues-lintfmt.txt`](evidence/bun-cli/issues-lintfmt.txt)),
  among them a non-idempotent formatter case (#45378), `.git/info/exclude`
  ignored (#45320), the doctor naming optional peers as still needed (#45390,
  which is why `--doctor` lists `eslint-config-prettier` for us), and how to
  call the tool when `package.json` has a `lint` script (#45405), which P2-1
  relies on.
- **Our floors.** Using the packages needs Bun 1.4.2 and does not change: lint
  and format are development tools. Developing needs 1.4.3
  (`package.json:29` `packageManager: bun@1.4.3`, `:31` `engines.bun >=1.4.3`,
  `scripts/typecheck.ts:64` `MIN_BUN = "1.4.3"`, refusing older at `:218`).
  The repo rule is not to depend on a canary-only fix (memory:
  `bun-workarounds-until-stable`), so a gate cannot depend on a canary-only
  command.

**Gating.**

1. **Now, on any Bun:** the preparation in phase 0 below. It changes nothing
   that depends on `bun lint`.
2. **Shadow, on canary, opt-in:** a script that runs both linters and diffs
   them, and `bun fmt --check`; it refuses to run on a Bun without `lint`,
   and no gate calls it.
3. **Switch** in the PR that raises the dev floor to the first stable release
   with both commands (call it 1.4.x): `packageManager`, root `engines.bun`,
   `MIN_BUN`, the `bun-types` devDependency ranges, CLAUDE.md's floor
   paragraph. Re-run the shadow on that exact release first: anything this
   plan measured is as old as 1.4.4-canary.1.
4. **Remove** ESLint and Prettier one merge window later, once every peer
   has gated on `bun lint` at least once.

## 7. Migration phases and PRs

Owners follow `docs/agentic-setup.md`: the features (main) agent owns tooling
and, until their agents start, bun-common and bun-nest; **4c** owns bun-jobs,
**d6** bun-jobs-ui and the playground, **5a** `examples/**` and the example
tables in package READMEs. A gate change affects every peer, so each phase
ends with a CHANGE REPORT to all of them. Efforts are working days.

### Phase 0: preparation, useful whatever Bun ships (now)

| PR | Scope | Effort | Owner, reviewers |
|---|---|---|---|
| **P0-1** canonical rule names | `.renamePlugins({ ts: "@typescript-eslint", node: "n" })` on each antfu composer (11 configs), and the 19 `ts/…` directive lines renamed **in the same PR** (measured: without it ESLint errors `Definition for rule 'ts/no-this-alias' was not found`). ESLint stays the gate. Bun's doctor: 98 → 124 native rules in bun-common. | 0.5 | main; 4c, d6, 5a review their files |
| **P0-2** Prettier 3.9 and the reformat | bump `prettier` to 3.9.10 in the four packages and declare it at the root; reformat the **78 files** (+168 −365) in one commit that does nothing else, listed in a new `.git-blame-ignore-revs`. After it, ESLint's `prettier/prettier` and `bun fmt` agree on every code file, and `bun lint` reading our ESLint config runs `prettier/prettier` natively instead of in JavaScript. Land in a merge window: it touches 40 bun-jobs and 12 bun-jobs-ui files. | 0.5 | main; owners review |
| **P0-3a/b/c** the defects | await the 12 `expect(…).rejects` (bun-jobs 6: 4c; bun-common 5: main; bun-jobs-ui 1: d6), rename the 2 duplicate test titles (bun-common, bun-nest: main), remove or use `#addDefined` (4c) and `#pinged` (d6) | 0.25 each | per owner |

### Phase 1: shadow (canary, opt-in)

| PR | Scope | Effort | Owner |
|---|---|---|---|
| **P1-1** the shadow tooling | `scripts/lint-shadow.ts`: builds a temporary tree under `~/.cache` without the ESLint configs (a `bunfig.toml` `[lint]` cannot run beside one: see "How it was run" in [`evidence/lint-shadow/`](evidence/lint-shadow/README.md)), writes the generated config (`scripts/gen-bunfig.ts`, from `eslint --print-config`), runs ESLint and `bun lint -f json` in the 11 directories, diffs by `file:line:rule`, and exits 1 on any ESLint finding Bun lacks; plus `bun fmt --check`. Tests in `scripts/__tests__/`, lint and typecheck as the root scripts are. The generated config is reviewed and committed as `bunfig.lint.toml` (not `bunfig.toml`, which would change `bun lint`'s behaviour beside ESLint). | 1.5 | main |
| **P1-2** run it | every peer runs it once on its own branch and reports differences; the main agent fixes the generator. A run is "clean" when ESLint-only is empty and every Bun-only finding is either fixed or turned off on purpose. | 0.5 + 0.25 per peer | all |
| **P1-3** the VS Code extension | `tools/vscode-bun-lint/` (§5), tested against the canary, opt-in. | 2 | main; d6 reviews the React diagnostics |

### Phase 2: switch the gates (the stable release)

| PR | Scope | Effort | Owner |
|---|---|---|---|
| **P2-1** floor and gates | raise the dev floor (§6); `bunfig.lint.toml` becomes the root `bunfig.toml`, plus `templates/compute-provider/bunfig.toml`; a `lint` script (`bun lint`) and a `format` script (`bun fmt --check`) in each package, `scripts/`, `playground`, the template and each `examples/*` (inside a `lint` script `bun lint` is the linter, per Bun's docs); `.vscode/settings.json` points `editor.defaultFormatter` at the extension and drops `eslint.workingDirectories`. The other 5 directive lines (`antfu/no-top-level-await` → `n/no-top-level-await`, `unused-imports/no-unused-vars` → `@typescript-eslint/no-unused-vars`) are renamed here, since ESLint knows only the old names. The ESLint configs stay one more window, unused by any gate. | 1 | main |
| **P2-2** docs | every line listed in §2, "Every place…": CLAUDE.md, `docs/agentic-setup.md`, `.claude/skills/bun-node-check/SKILL.md`, root and package READMEs; and the example READMEs' lint lines. | 0.5 + 0.25 | main; **5a** for `examples/**/README.md` |
| CHANGE REPORT | to 4c, d6, 5a: the new gate commands, the renamed directives, the rules that changed, the new default findings | — | main |

### Phase 3: remove ESLint and Prettier (one merge window later)

| PR | Scope | Effort | Owner |
|---|---|---|---|
| **P3-1** remove | the 11 `eslint.config.mjs` (`templates/eslint.config.mjs` included: the template's own `bunfig.toml` from P2-1 replaces it, with no dependencies); `@antfu/eslint-config`, `eslint`, `prettier`, `eslint-config-prettier`, `eslint-plugin-prettier`, `@eslint-react/eslint-plugin`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh` and `@nx/eslint` from the five `package.json`s (keep `eslint-plugin-regexp` as a root devDependency if Q1 keeps it); the `eslint.config.mjs` entries in six `tsconfig.json` `include`s; the `TS2742`/`TS2883` filter (`scripts/typecheck.ts:69-76`) and its test (`scripts/__tests__/typecheck.test.ts:80`), or keep it as harmless; `.eslintcache` in three `.gitignore`s; `bun.lock`s, including the template's and the bench directories'. Check: `bun scripts/typecheck.ts`, every package's `bun run test`, `bun scripts/consumer-check.ts` for all four packages (devDependencies never ship, so the cells must be unchanged), the four `__tests__/packaging.test.ts`, and that `bun pm ls` in each package lists none of the removed names. | 1 | main; all review |

### Phase 4: the one-time reformat

The code reformat is **P0-2**, moved forward on purpose: it is a Prettier 3.9
change that ESLint needs as much as Bun does, and doing it first makes every
later shadow run meaningful. What is left for phase 4 depends on the
answers in §9:

| PR | Scope | Effort | Owner |
|---|---|---|---|
| **P4-1** import order (if Q2 = sortImports) | turn on `[fmt.sortImports]` and apply it: 449 files once (371 beyond P0-2), in its own commit, added to `.git-blame-ignore-revs`. | 0.5 | main; owners review |
| **P4-2** Markdown (if Q3 = format) | format the 32 Markdown files outside `docs/plans/` with `embeddedLanguageFormatting = "off"`; run the bun-jobs doc tests and both README-parsing examples before merging, and tell 5a, d6 and 4c first: the parsed tables are theirs. | 0.5 | main; 5a, d6, 4c |
| **P4-3** `package.json` order (if wanted) | `sortPackageJson = true`: 19 files, +190 −186. | 0.25 | main |

Total, with every option taken: about 10.5 working days, of which 6.5 can
happen before Bun ships (phases 0 and 1).

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **A rule we drop would have caught a bug.** 172 rules go; `regexp` is kept, so the realistic losses are perfectionist order, Markdown lint and `@eslint-react`'s leak rules. | medium | Q1 and Q3. The shadow run shows no current finding is lost, but cannot show a future one. |
| **Rule semantics drift** between Bun's ports and the plugins we run (import-lite vs import, oxlint's unicorn and `node` rules, `{@link}`-aware unused imports, Bun's own defaults). | high, small | Generated config with explicit options; the shadow script stays in the repo and is re-run on every Bun upgrade. |
| **Formatter churn**: 78 code files now, 449 for import order (371 beyond those 78), 32 Markdown files, 6 CSS/HTML files. Open branches conflict. | certain, bounded | One commit per kind, in a merge window, in `.git-blame-ignore-revs`; peers rebase once. |
| **Parsed READMEs**: a reformat can break `permissions.ts`, `scaler-recipes.ts` or the provider guide's excerpts. | real (the guide broke) | Markdown stays unformatted unless Q3; if formatted, code blocks are left alone (`embeddedLanguageFormatting = "off"`), and the three checks run before merge. |
| **Canary instability**: 15 open lint/fmt issues; behaviour may change before stable. | high until stable | No gate on canary; re-run the shadow on the release we pin. |
| **A stable release ships one command and not the other**, or ships them later than expected. | possible | The phases are independent: `bun fmt` alone replaces Prettier, `bun lint` alone replaces ESLint. ESLint keeps working meanwhile. |
| **Editor regression**: our extension is ours to maintain, and loses Markdown and JSON diagnostics. | medium | Keep it small (two child processes, one JSON parser); delete it when Bun ships an LSP. |
| **`bun lint` output depends on the environment**: an agent session gets a tagged "agent" format, and `@antfu/eslint-config` changed rules when it thought it ran in an editor. | certain | Scripts pass `-f json`/`-f unix`; the native config has no editor detection. |
| **One `bunfig.toml` for everything**: it is chosen from the working directory up, not per file, so a nested one silently stops applying when run from higher up. | low | One root file plus the template's own; the shadow script lints from each directory, as the gate does. |

## 9. Open questions for the user

1. **How native?** (a) native rules plus `eslint-plugin-regexp` only, no
   `eslint` package (**recommended**); (b) also keep perfectionist, jsdoc,
   `@eslint-react` and Markdown/JSON linting, which needs the `eslint` package
   installed as a library (Bun loads it; it never runs as a CLI); (c) native
   only, dropping `regexp` too. The price of (a) over (c) is measured: 8.1 s
   against 0.44 s for the 11 directories, still 15 times faster than ESLint;
   (b) would be about 25 s plus `@eslint-react`. Ask d6 about
   `@eslint-react`'s leak rules before deciding.
2. **Import order.** (a) Drop perfectionist and let order drift
   (**recommended**: order carries no meaning, and the fixer churns every
   import block it touches); (b) `bun fmt` `[fmt.sortImports]` with
   perfectionist's groups, 449 files once; (c) keep perfectionist (needs 1b).
3. **Markdown.** (a) Not formatted, as today (**recommended**); (b) formatted
   with code blocks left alone (32 files once, tables realigned; the three
   parsers pass, measured).
4. **The `bun:test` style rules our vitest rules were meant to be**
   (`prefer-lowercase-title` 465, `prefer-hooks-in-order` 37,
   `consistent-test-it` 31). **Recommended: off**, keeping
   `no-focused-tests` and `no-identical-title`. Turning on
   `prefer-lowercase-title` would rename 465 tests.
5. **Bun's default bug rules** (`valid-expect`, `no-useless-assignment`,
   `preserve-caught-error`, `no-unused-private-class-members`,
   `no-disabled-tests`): **recommended: keep**, after fixing the 16 findings
   (P0-3), with `bun:test/no-export` off in test files (its 7 findings are
   all in `__tests__/helpers/`).
6. **One gate step or two?** `bun/format` inside `bun lint` (one command,
   format problems listed with lint problems) or `bun fmt --check` separately
   (**recommended**: one tool per question, and `bun fmt` also covers CSS and
   HTML).
7. **Move the code reformat forward** into phase 0 as a Prettier 3.9 bump
   (P0-2)? **Recommended: yes**, in the next merge window.
8. **Explicit `Buffer`/`process` imports** (`node/prefer-global/*`; 392
   files import them from `node:buffer` / `node:process`, 49 of them in
   packages' `lib/`): keep as a `no-restricted-globals` rule, or let it go?
   **Recommended: let it go**; under Bun both globals are always there.
9. **The editor**: build the in-repo extension (**recommended**, 2 days), or
   stay on the ESLint extension, which means keeping ESLint and the antfu
   config installed only for the editor until Bun ships an LSP?
10. **A Git hook** (`bun lint --staged`, `bun fmt --staged`, which re-stages):
    **recommended: no**. Several sessions commit from many worktrees, and a
    hook that rewrites staged files is a surprise there; the gate is enough.
11. **Type-aware rules** (`bun lint --type-aware`, e.g.
    `no-floating-promises`, using `bun check`'s types): new capability, not
    part of parity. **Recommended**: a follow-up plan with its own
    measurements, after the switch.
