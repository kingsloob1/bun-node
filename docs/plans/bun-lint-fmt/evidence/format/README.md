# Formatter parity: `bun fmt` against our Prettier

Measured 2026-10-16 on Bun 1.4.4-canary.1+5f5799ed1, in a scratch clone of
develop at `f9baf24a` (`git clone --local`, never the worktree), 16 cores.

## The three-way differential

`../tools/fmt-diff.ts` formats every file three ways and compares the bytes:

1. **Prettier 3.8.4**, our installed version, with the options our
   `prettier/prettier` rule passes (`packages/bun-common/eslint.config.mjs:56-68`:
   double quotes, semicolons, trailing commas `all`, `singleAttributePerLine`,
   2 spaces, LF).
2. **Prettier 3.9.10**, the current release, same options.
3. **`bun fmt --stdin-filepath <file>`**, with `bunfig.toml` holding only
   `[fmt] singleAttributePerLine = true`.

### Code in today's lint scope (1,651 files)

Every `.js/.mjs/.cjs/.jsx/.ts/.mts/.cts/.tsx/.vue/.json/.jsonc/.yaml/.yml`
file under the 11 directories with an `eslint.config.mjs` (lockfiles
excluded): [`per-file-code.tsv`](per-file-code.tsv).

| Comparison | Files that differ |
|---|---|
| the repo against Prettier 3.8.4 | **0**: the tree is clean today |
| `bun fmt` against Prettier 3.9.10 | **0**: byte-identical on all 1,651 |
| Prettier 3.8.4 against Prettier 3.9.10 | **78** (+168 −365 lines): [`p38-vs-p39.diff`](p38-vs-p39.diff), [`p38-vs-p39.files`](p38-vs-p39.files) |

So the whole of the code churn is **Prettier 3.9's own style change**, not
Bun: we would get the same 78 files by bumping Prettier. The 124 hunks:
107 are union types in annotations and `as` casts collapsed onto one line
(`| A\n| undefined` → `A | undefined`), 6 are `await (await x()).y()` chains
broken around the inner `await`, 4 are arrow-function arguments hugged, 7 are
other type-argument and mapped-type layouts.

By package: bun-jobs 40, bun-common 17, bun-jobs-ui 12, bun-nest 2,
examples 5, playground 1, templates 1.

### Markdown, CSS, HTML, Vue and Svelte (159 files, whole repo)

[`per-file-md.tsv`](per-file-md.tsv). `bun fmt` equals Prettier 3.9.10 on all
152 that Prettier can format. The 7 `.svelte` files (plan evidence only) have
no Prettier plugin installed here, so they were not compared. 131 of the 159
are **not** Prettier-formatted today, because our ESLint config scopes
`prettier/prettier` away from Markdown
(`packages/bun-common/eslint.config.mjs:39-49`).

## Idempotence

- After `bun fmt` on the whole clone, `bun fmt --check` flagged **4** files,
  all plan evidence under `docs/plans/**/evidence/` (member chains such as
  `res.status(200).json({...})`). `../tools/idem.ts` shows **Prettier 3.9.10
  does exactly the same**: neither is idempotent on those 4, and Bun's first
  and second passes equal Prettier's first and second. Not a Bun bug; nothing
  in the lint scope is affected.
- On the 78 code files, a second run changed nothing (`All 78 files are
  formatted.`).
- `bun fmt --debug-check` (fail if formatting changes what a file means) over
  the whole repository: 2,256 files, exit 0, no report.

## What a whole-repo `bun fmt` would change

With only `singleAttributePerLine = true` and no ignores
([`numstat.txt`](numstat.txt)): **552 files, +51,232 −27,562**.

| Area | Files | Lines + / − |
|---|---|---|
| lint scope, code (`.ts/.tsx`) | 78 | +168 / −365 |
| lint scope, Markdown | 17 | +2,639 / −2,364 |
| lint scope, CSS / HTML | 6 | +141 / −95 |
| root files (`CLAUDE.md`, `README.md`, `lerna.json`, …) | 5 | +58 / −63 |
| `docs/` outside plans | 7 | +77 / −51 |
| `docs/plans/**` | 424 | +47,898 / −24,392 |
| `benchmarks/` | 15 | +251 / −232 |

Without `singleAttributePerLine` (Bun's default, Prettier's default) the count
was 659: 107 more `.tsx` files in bun-jobs-ui.

## Parsed Markdown

Formatting every `.md` file broke one test, measured on the formatted clone:

```text
bun test __tests__/api/readme-tables.test.ts __tests__/provider/docs.test.ts __tests__/provider/reference.test.ts
24 pass, 1 fail
docs/providers/author-guide.md:818: not a verbatim excerpt of templates/compute-provider/test/conformance.test.ts
```

`bun fmt`, like Prettier, **formats the code blocks inside Markdown**
(`embeddedLanguageFormatting = "auto"`). The guide quotes the template's
files verbatim, and an excerpt lifted out of a nested `it(...)` is re-wrapped
at a shallower indent, so it is no longer verbatim. It also inserts a blank
line after every `<!-- eslint-skip -->` (17 of them in that guide), which
`docsCheck.ts` tolerates today, and de-indents a lazy list continuation line
(Prettier 3.9 does the same; rendering is unchanged).

With code blocks left alone, `[[fmt.overrides]] files = ["**/*.md"]`,
`options = { embeddedLanguageFormatting = "off" }`, formatting the 34
Markdown files outside `docs/plans/` changed 32 (+2,549 −2,525, mostly table
column alignment; `packages/bun-jobs/README.md` alone 2,032 changed lines) and
everything that parses them passed on the formatted clone:

| Check | Result |
|---|---|
| bun-jobs `readme-tables`, `provider/docs`, `provider/reference` tests | 25 pass, 0 fail |
| `examples/bun-jobs-ui/04-screens/permissions.ts` (parses the "What each element needs" table) | 468 checks passed ([`ex-permissions.log`](ex-permissions.log)) |
| `examples/bun-jobs/11-management-api/scaler-recipes.ts` (parses the scaler recipes) | 15 checks passed ([`ex-scaler.log`](ex-scaler.log)) |

## Import and `package.json` sorting

| Setting | Files changed in the lint scope (code) |
|---|---|
| `sortImports = true` (Bun's default groups) | 1,211 (+5,087 −3,769), 1,133 beyond the Prettier 3.9 set |
| `[fmt.sortImports]` with perfectionist's groups (type imports first), `newlinesBetween = false` | 449 (+615 −812), 371 beyond the Prettier 3.9 set: [`sort-imports-perfectionist-groups.diff`](sort-imports-perfectionist-groups.diff) |
| `sortPackageJson = true` | 19 `package.json` files, +190 −186: [`sort-package-json.diff`](sort-package-json.diff) |

The residual 371 come from three differences with perfectionist: named
specifiers are ordered by the imported name, not the alias (`encodeJobId as
rootEncodeJobId`); imports above a file's leading comment block move below
it; and (per Bun's docs) duplicate imports of one module are merged.

## The generated typed overloads

After formatting the clone, `bun scripts/generate-verb-overloads.ts --check`
in bun-common printed `lib/BunRouter.ts: up to date (25 verbs)` and
`../bun-nest/lib/BunHttpAdapter.ts: up to date (16 verbs)`, exit 0. The
format diff in `BunRouter.ts` touches lines 85, 442, 1428, 1432 and 5312,
none inside a `BEGIN generated typed overloads` block (the first starts at
line 1485): the generator already emits Prettier-stable text.

## Time

`bun fmt --check` on the whole repository (2,256 files): 0.12 s wall,
1.45 s CPU. See [`../perf/`](../perf/README.md) for the repeated runs.

## The one-time reformat under the answered settings (2026-10-17)

Develop `930dd664`, Bun 1.4.4-canary.1+5f5799ed1, in the scratch clone of
[`../type-aware/`](../type-aware/README.md), with the answered root
`bunfig.toml` ([`../rules/bunfig.answered.toml`](../rules/bunfig.answered.toml):
`[fmt] singleAttributePerLine = true`, `ignorePatterns = ["**/*.md",
"docs/**", "benchmarks/results/**"]`, no `sortImports`).

- `bun fmt --list-files` from the root: **1,697 files** in scope (1,388 `.ts`,
  210 `.tsx`, 65 `.json`, 21 `.css`, 9 `.html`/`.htm`, 2 `.mjs`, 1 `.js`, 1
  `.toml`).
- `bun fmt --check` from the root: exit 1, **89 files** need formatting
  (0.08 to 0.10 s wall, about 1 s CPU, three runs):
  [`answered-reformat-files.txt`](answered-reformat-files.txt). Formatted
  (`bun fmt`), they change by **+371 −506**
  ([`answered-reformat-numstat.txt`](answered-reformat-numstat.txt)); a second
  `bun fmt --check` exits 0.
- **By kind**: 82 TypeScript files (+228 −407; 79 in the lint scope, 3 in
  `benchmarks/`, which has no ESLint config but is not in `[fmt]`'s ignore
  list), 3 CSS (`packages/bun-jobs-ui/app/`), 3 HTML (bun-common's
  playground and `examples/bun-common`) and `lerna.json`.
- **By owner**: bun-common 19 (+149 −219), bun-jobs 40 (+74 −139),
  bun-jobs-ui 15 (+68 −70), bun-nest 2 (+7 −10), `examples/*` 6, `benchmarks/`
  3, `playground/` 1, `scripts/` 1, the template 1, the root 1.

The 79 in the lint scope are the 78 of 2026-10-16 (the Prettier 3.9
changes), all still there, plus `scripts/nest-matrix.ts`, which #400 added
after `f9baf24a`.
