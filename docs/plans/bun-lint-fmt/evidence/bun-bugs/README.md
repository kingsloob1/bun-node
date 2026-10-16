# Bun bugs: none found to file

Bun 1.4.4-canary.1+5f5799ed1, 2026-10-16. Every disagreement between `bun lint`
/ `bun fmt` and our tools was reduced to a single file and compared with the
upstream tool Bun says it matches. None turned out to be Bun's: each matches
its documented upstream (Prettier 3.9, eslint-plugin-import 2.32,
typescript-eslint, oxlint) or a documented Bun default. So there is no draft
issue here.

| Candidate | Looked like | Turned out to be | Where |
|---|---|---|---|
| `bun fmt` not idempotent on 4 files | a formatter bug (cf. oven-sh/bun#45378, open) | **Prettier 3.9.10 is not idempotent on the same 4 files**, and Bun's first and second passes equal Prettier's first and second, byte for byte | [`../format/README.md`](../format/README.md), `../tools/idem.ts` |
| `bun fmt` reformats 78 files ESLint+Prettier call clean | a Prettier mismatch | Prettier 3.9's own changes; `bun fmt` equals Prettier 3.9.10 on all 1,651 code files | [`../format/`](../format/README.md) |
| `bun fmt` breaks a verbatim-excerpt test | output that changes meaning | Prettier also formats code blocks in Markdown (`embeddedLanguageFormatting = "auto"`); `--debug-check` found no change of meaning in 2,256 files | [`../format/`](../format/README.md) |
| `import/no-duplicates` on `import type *` + `import type { }` | false positive | eslint-plugin-import 2.32.0 reports it too; antfu's fork does not | [`../repros/no-dup/`](../repros/no-dup/) |
| `n/handle-callback-err` on overload signatures | false positive | oxlint 1.88.0 reports it too; Bun's `node` rules follow oxlint (`docs/lint/plugins.mdx`) | [`../repros/cb-err-native/`](../repros/cb-err-native/) |
| `@typescript-eslint/no-namespace` silent on `declare namespace` | missed report | Bun's documented default `allowDeclarations = true` (`bun lint --explain`) | [`../repros/ns-native/`](../repros/ns-native/) |
| `--no-config-lookup` ignores `bunfig.toml` rules and lints nothing | config ignored | ESLint's own `--no-config-lookup` semantics ("File ignored because no matching configuration was supplied"); reproduced in a scratch folder with and without an `eslint.config.mjs` | [`../lint-shadow/README.md`](../lint-shadow/README.md) |

Searches run (`gh search issues --repo oven-sh/bun`, issues since 2026-09-01):
"bun lint", "bun fmt", "lint in:title", "fmt in:title", "formatter in:title",
"handle-callback-err", "overload signature lint", "bun lint lsp",
"bun lint vscode", "bun fmt vscode", "bun fmt editor", "bun lint editor". The
18 lint/fmt issues found are listed in
[`../bun-cli/issues-lintfmt.txt`](../bun-cli/issues-lintfmt.txt); the ones that
touch this plan are cited in the plan's risks.

Two Bun behaviours worth knowing, which are documented rather than bugs:

- `bun lint --doctor` lists `prettier/prettier` under "rules run natively"
  while the run itself falls back to JavaScript with Prettier 3.8.4 and says so
  (`note: prettier/prettier ran in JavaScript for 1 file because the installed
  prettier is not version 3.9`). The doctor reports what Bun *can* run
  natively; the note is the truth for the run.
- Next to an ESLint config, `[lint]` keys in `bunfig.toml` are applied as
  flags on top of that config, so a native rule set cannot be tried in place.
