# Rule parity: every rule ESLint runs here, against `bun lint`

Bun 1.4.4-canary.1+5f5799ed1 (`bun lint --rules`: 1,021 rules,
[`../bun-cli/rules.txt`](../bun-cli/rules.txt)); ESLint 10.5.0,
`@antfu/eslint-config` 9.0.0; 2026-10-16.

## The rule set we run today

`eslint --print-config` (with `CI=1`) on ten representative files
([`print-config/`](print-config/)): a bun-common `lib` file, a bun-common test,
a README, a README code block (`README.md/0.ts`), `package.json`,
`tsconfig.json`, a bun-jobs-ui `app/*.tsx` and `__tests__/app/*.test.tsx`, a
root `scripts/` file and an `examples/bun-jobs` file. Their union is
**384 enabled rules** ([`enabled-rules.tsv`](enabled-rules.tsv): rule,
severities, which files, options):

| Source | Rules |
|---|---|
| ESLint core | 97 |
| `@eslint-react` (as `react/`) | 65 |
| `eslint-plugin-regexp` | 60 |
| `eslint-plugin-jsonc` | 38 |
| `@typescript-eslint` (as `ts/`) | 26 |
| `eslint-plugin-jsdoc` | 17 |
| `@eslint/markdown` | 15 |
| `eslint-plugin-unicorn` | 14 |
| `@e18e/eslint-plugin` | 9 |
| `eslint-plugin-n` (as `node/`) | 8 |
| `@vitest/eslint-plugin` (as `test/`) | 6 |
| `eslint-plugin-import-lite` (as `import/`) | 6 |
| `eslint-plugin-antfu` | 6 |
| `@stylistic` (as `style/`) | 4 |
| `eslint-plugin-perfectionist` | 4 |
| `@eslint-community/eslint-comments` | 4 |
| `eslint-plugin-unused-imports` | 2 |
| `eslint-plugin-react-refresh`, `eslint-plugin-prettier`, `eslint-plugin-command` | 1 each |

No YAML or TOML file is linted (there are none in the lint scope), so the
`yaml/` and `toml/` rules antfu turns on apply to nothing.

## The parity map

[`parity.tsv`](parity.tsv), built by [`../tools/parity.ts`](../tools/parity.ts)
from [`rule-map-raw.tsv`](rule-map-raw.tsv) (each rule looked up with
`bun lint --explain=<name>` under its plausible names) and a hand-written table
of equivalents, each checked with `--explain`.

| Category | Rules | What it means |
|---|---|---|
| **Native, same rule** | **127** | ESLint core 97, `@typescript-eslint` 26, `n` 4. The name changes only by antfu's prefix (`ts/x` is `@typescript-eslint/x`). Bun pins the upstream versions it ports: ESLint 10.12, typescript-eslint 8.71, n 18.4 (`docs/guides/lint/migrate-from-eslint.mdx`). |
| **Native, different name, upstream or options** | **85** | `unicorn` 14 (Bun's are oxlint's ports), `import` 6 (eslint-plugin-import 2.32, not import-lite), `react` 44 + `react-refresh` 1 (eslint-plugin-react / React Compiler / oxlint rules for our `@eslint-react` ones, 14 by the same name, 30 by a different one), `test` 6 (Bun's `bun:test/` rules; ours are vitest's and never fire on `bun:test` imports), `e18e` 6, `eslint-comments` 3, `unused-imports` 2, `antfu/no-top-level-await` → `n/no-top-level-await`, `style/jsx-curly-brace-presence` → `react/…`, `prettier/prettier` → `bun/format` |
| **Not available** | **172** | `regexp` 60, `jsonc` 38, `react` 21, `jsdoc` 17, `markdown` 15, `antfu` 5, `perfectionist` 4, `n` 4, `e18e` 3, `style` 3, `eslint-comments` 1, `command` 1 |

### What the missing rules are worth to us

| Rules | Defect class | Evidence in this repo | Keep it how |
|---|---|---|---|
| `regexp/*` (60) | wrong or slow regular expressions, including `no-super-linear-backtracking` (ReDoS) | 1 suppression (`regexp/no-obscure-range`) | `plugins = [{ name = "regexp", … }]` in bunfig: **loads without the `eslint` package** (measured), +0.8 s on bun-common, 0.44 s → 8.1 s over the 11 directories |
| `perfectionist/sort-imports`, `sort-named-imports`, `sort-exports`, `sort-named-exports` | import/export order, auto-fixed | 3 suppressions (`perfectionist/sort-exports`); shapes every file's import block | (a) drop and let order drift; (b) `bun fmt` `[fmt.sortImports]` with our groups: **449 files** change once, 371 of them beyond the Prettier 3.9 set ([`../format/sort-imports-perfectionist-groups.diff`](../format/sort-imports-perfectionist-groups.diff)); with Bun's default groups 1,211; (c) the JS plugin, which **needs the `eslint` package installed** to load |
| `markdown/*` (15) and linting the 165 `ts`/`js` code blocks in 17 READMEs | broken link fragments, table column counts, invalid code in docs | the README tables two examples parse; 17 `<!-- eslint-skip -->` markers in `packages/bun-jobs/docs/providers/author-guide.md` | only with the `eslint` package installed (Markdown is an ESLint *language*: `docs/lint/plugins.mdx`, "Other languages") |
| `jsonc/*` (38) | JSON syntax and `package.json` / `tsconfig.json` key order | antfu's `sort-package-json` / `sort-tsconfig` | `bun fmt` `sortPackageJson = true` covers `package.json` only, in its own order: **19 files**, +190 −186 ([`../format/sort-package-json.diff`](../format/sort-package-json.diff)); tsconfig order not kept |
| `jsdoc/*` (17) | `@param` names that do not match, malformed tags | none suppressed | JS plugin, needs the `eslint` package; or drop (`bun fmt` `jsdoc = true` formats tags but checks nothing) |
| `@eslint-react` (21 with no counterpart) | `web-api-no-leaked-*` (timers, listeners, observers, fetch not cleaned up in effects), React 19 migrations (`no-forward-ref`, `no-context-provider`, `no-use-context`), `naming-convention-*` | 1 directive pair (`react/no-unnecessary-use-prefix`) | JS plugin, needs the `eslint` package; the bun-jobs-ui owner's call |
| `node/prefer-global/buffer`, `process` | implicit `Buffer` / `process` globals; 392 files import them explicitly (49 in packages' `lib/`) | commit `8b4692d3` added a `Buffer` import for this rule | drop, or `no-restricted-globals` (native) with `Buffer` and `process` listed |
| `node/no-deprecated-api`, `node/process-exit-as-throw` | deprecated Node APIs | none | drop (`n/no-deprecated-api` is not among Bun's 15 `n` rules) |
| `antfu/*` (5): `consistent-chaining`, `consistent-list-newline`, `import-dedupe`, `no-import-dist`, `no-import-node-modules-by-path` | layout, duplicate specifiers, imports from `dist/` or `node_modules/` paths | none | layout is the formatter's; `import/no-duplicates` covers dedupe; `no-restricted-imports` patterns cover the paths; or the JS plugin (loads without `eslint`) |
| `e18e/prefer-array-fill`, `prefer-timer-args`, `prefer-url-canparse` | modernisation suggestions | none | drop |
| `style/lines-between-class-members`, `spaced-comment`, `jsx-function-call-newline` | layout | none | drop; `bun fmt` decides layout |
| `eslint-comments/no-aggregating-enable` | one `eslint-enable` for several disables | none | `reportUnusedDisableDirectives` covers the useful half |
| `command/command` | comment-triggered codemods (`/// to-function`) | none used | drop |

## Configs generated from it

- [`bunfig.native.toml`](bunfig.native.toml): every native rule, at our
  severity and options, the offs, and the overrides. Verified by the shadow
  run ([`../lint-shadow/`](../lint-shadow/README.md)).
- [`bunfig.native-regexp.toml`](bunfig.native-regexp.toml): the same plus
  `eslint-plugin-regexp`'s 60 rules as a JavaScript plugin.
- [`bunfig.hybrid.toml`](bunfig.hybrid.toml): every JS plugin our `.ts` files
  use except `@eslint-react` (perfectionist, regexp, jsdoc, antfu, e18e,
  stylistic, command, eslint-comments). Needs the `eslint` package installed
  for perfectionist and jsdoc.

Which plugins load in `bun lint` with the `eslint` package removed from
`node_modules` (measured one by one): **load**: `eslint-plugin-regexp`,
`eslint-plugin-antfu`, `@e18e/eslint-plugin`, `@stylistic/eslint-plugin`,
`eslint-plugin-command`, `@eslint-community/eslint-plugin-eslint-comments`,
`eslint-plugin-react-refresh`. **`Cannot find module 'eslint'`**:
`eslint-plugin-perfectionist`, `eslint-plugin-jsdoc`,
`eslint-plugin-unused-imports`, `@eslint-react/eslint-plugin`.

## Defaults that differ

Bun documents a few defaults that differ from ESLint's
(`docs/lint/index.mdx`, "A few defaults differ"): `_`-prefixed names may be
unused, `require()` allowed in TypeScript, short-circuit expressions allowed,
and others. One bit us: `@typescript-eslint/no-namespace` defaults to
`allowDeclarations = true` in Bun and `false` in typescript-eslint
([`../repros/`](../repros/README.md)). `--print-config` only shows options a
config sets, so a generated config inherits Bun's defaults for the rest. The
proposed config states the options of the rules we rely on, and the shadow run
is what proves it.
