# Shadow run: ESLint against native `bun lint`

Measured 2026-10-16, Bun 1.4.4-canary.1+5f5799ed1, scratch clones of develop
at `f9baf24a`.

## How it was run

1. **ESLint**, as the gate runs it: `CI=1 bunx eslint . -f json` in each of the
   11 directories that have an `eslint.config.mjs` (4 packages, `scripts`,
   `playground`, `templates/compute-provider`, 4 `examples/*`). `CI=1` matters:
   without it `@antfu/eslint-config` decides it is "running in editor" (it saw
   this session's terminal) and turns some rules off; Bun printed the same
   warning when it loaded the config.
2. **Native `bun lint`**, in a second clone with every `eslint.config.mjs`
   deleted and one root `bunfig.toml` holding
   [`../rules/bunfig.native.toml`](../rules/bunfig.native.toml): `CI=1 bun lint
   -f json` in the same 11 directories (`../tools/native-run.sh`). The config is
   generated from ESLint's own effective config (`eslint --print-config` on
   representative files, [`../rules/print-config/`](../rules/print-config/)) by
   [`../tools/gen-bunfig.ts`](../tools/gen-bunfig.ts): every rule with a native
   counterpart, at the same severity and options, `off` where ours is off, and
   overrides for tests, React, CLI entry points and antfu's per-glob disables.
3. **Diff** ([`../tools/shadow-diff.ts`](../tools/shadow-diff.ts)): findings
   keyed by `file:line:rule`, rule names normalised to Bun's (`ts/` →
   `@typescript-eslint/`, `node/` → `n/`, `test/` → `bun:test/`,
   `unused-imports/no-unused-vars` → `@typescript-eslint/no-unused-vars`,
   `antfu/no-top-level-await` → `n/no-top-level-await`, `prettier/prettier` →
   `bun/format`). Markdown and JSON findings are left out, because native
   `bun lint` does not read those files.

A `bunfig.toml` `[lint]` section cannot be shadow-run **in place**: next to an
`eslint.config.mjs`, Bun applies its keys as flags on top of the ESLint config
(`docs/runtime/bunfig.mdx`, "`[lint]` also applies next to an
`eslint.config.js`"), so `"@typescript-eslint/…"` fails with `Could not find
plugin "@typescript-eslint" in configuration` (antfu registers it as `ts`).
`--no-config-lookup` behaves as ESLint's does: every file is "ignored because
no matching configuration was supplied". Handing Bun the same rules as an
`.oxlintrc.json` with `-c` failed on oxlint's stricter option schemas
(`unicorn/escape-case` takes no options). Hence the second clone.

## Result

[`shadow-diff-final.txt`](shadow-diff-final.txt):

- ESLint: **71** findings on code files (all `no-console` warnings).
- Native: **all 71 reproduced** at the same file, line and rule, after four
  fixes to the generated config (below). Nothing ESLint reports today is lost.
  (Today's tree is clean, so this cannot show what a *missing* rule would have
  caught; the parity map covers that.)
- Native: **743 more**, every one explained:

| Count | Rule | Why ESLint does not report it |
|---|---|---|
| 465 | `bun:test/prefer-lowercase-title` (error) | Our `test/prefer-lowercase-title` is `@vitest/eslint-plugin`'s, which only recognises `describe`/`it` imported from `vitest`. Every test here imports `bun:test`, so the rule has never fired. Bun's `bun:test/` version does. |
| 136 | `bun/format` | The Prettier 3.8 → 3.9 differences in 78 files ([`../format/`](../format/README.md)). |
| 37 | `bun:test/prefer-hooks-in-order` | dead vitest rule, as above |
| 31 | `bun:test/consistent-test-it` | dead vitest rule, as above |
| 16 | `no-useless-assignment` (warn) | Bun's default set (ESLint 10's recommended); antfu does not enable it |
| 12 | `bun:test/valid-expect` | Bun's default for `bun:test` files. **Real defects**: un-awaited `expect(…).rejects` in bun-jobs (6), bun-common (5), bun-jobs-ui (1): [`shadow-real-defects.txt`](shadow-real-defects.txt) |
| 11 | `bun:test/no-disabled-tests` (warn) | Bun default |
| 8 | `import/no-duplicates` | Bun ports eslint-plugin-import 2.32; we run antfu's fork, import-lite, which keeps `import type * as X` apart ([`../repros/`](../repros/README.md)) |
| 7 | `bun:test/no-export` (warn) | Bun default; all in `__tests__/helpers/` |
| 4 | `no-useless-escape` (warn) | Bun default (our config uses `regexp/no-useless-escape`, not the core rule) |
| 3 | `preserve-caught-error` (warn) | Bun default (ESLint 10 recommended) |
| 3 + 2 | `unicorn/prefer-regexp-test`, `unicorn/prefer-string-starts-ends-with` | Bun's unicorn rules follow oxlint ([`../repros/`](../repros/README.md)) |
| 2 | `bun:test/no-identical-title` | dead vitest rule; **real**: duplicate test titles in `packages/bun-common/__tests__/httpAdapter.test.ts:230` and `packages/bun-nest/__tests__/httpAdapter.test.ts:192` |
| 2 | `n/handle-callback-err` | follows oxlint: reports TypeScript overload signatures (`packages/bun-nest/lib/interceptors.ts:121,123`) |
| 2 | `no-unused-private-class-members` (warn) | Bun default. **Real** dead code: `#addDefined` (`packages/bun-jobs/lib/BunJobs.ts:1375`), `#pinged` (`packages/bun-jobs-ui/app/live/client.ts:313`) |
| 1 | `@typescript-eslint/no-unused-vars` | `eslint-plugin-unused-imports` counts a JSDoc `{@link X}` as a use; typescript-eslint and Bun do not (`packages/bun-jobs/lib/queue/workerTarget.ts:20`) |
| 1 | unused `eslint-disable` | `@typescript-eslint/no-namespace`: Bun's default `allowDeclarations = true` (`packages/bun-common/lib/types/standardSchema.ts:25`) |

### The four config fixes the shadow run forced

1. **`eslint-disable` comments name rules by antfu's prefixes.** 24 directive
   lines in 21 files say `ts/…`, `antfu/no-top-level-await`,
   `unused-imports/no-unused-vars` or `node/…`. Bun reads them literally, so
   under canonical names they disable nothing: 55 `no-unused-vars` findings
   came from one file-level `/* eslint-disable unused-imports/no-unused-vars */`
   (`packages/bun-common/__tests__/native.type-test.ts:17`), 20 from the `ts/`
   ones and 16 from `antfu/no-top-level-await`. Renaming them in place (a
   `perl -pi` over the 21 files) cleared all 91.
2. **Option spellings differ between forks**:
   `import/consistent-type-specifier-style` is `"top-level"` in import-lite and
   `"prefer-top-level"` in eslint-plugin-import.
3. **antfu's per-glob disables** (`antfu/disables/scripts`, `cli`, `dts`,
   `cjs`, `config-files`, in `@antfu/eslint-config/dist/index.mjs`) and its
   test-file overrides are not in a single file's `--print-config`; they became
   `[[lint.overrides]]`. Our packages' trailing `overrideRules({ "no-console":
   "warn" })` beats antfu's script disable, so package `scripts/` keep the
   warning, as today.
4. **Rules ESLint does not mention stay at Bun's defaults**, so a native config
   must turn off what it does not want (`@typescript-eslint/no-explicit-any`
   gave 615 warnings until mapped to `off`).

## Rule-name and option drift, in one place

- antfu's prefixes `ts/`, `node/`, `test/`, `style/`, `import/` (import-lite),
  `react/` (@eslint-react) all mean something else, or nothing, to Bun. Bun's
  docs say a renamed built-in plugin runs in JavaScript (`docs/lint/plugins.mdx`,
  Notes). `.renamePlugins({ ts: "@typescript-eslint", node: "n" })` on the antfu
  composer, measured in bun-common: ESLint stays green once the 10 directives
  there are renamed in the same change (without it, ESLint errors `Definition
  for rule 'ts/no-this-alias' was not found`), and Bun's doctor goes from 98
  to 124 native rules.
- `bun lint` prints a tagged, multi-line "agent" report when `CLAUDECODE` /
  `AGENT` is set (seen in this session). Scripts must pass `-f json` or
  `-f unix`, as they already do for `bun check`.
