# Reproductions: where native `bun lint` and our ESLint disagree

Each folder is one disagreement found by the shadow run
([`../lint-shadow/`](../lint-shadow/README.md)), reduced to a single file and
run against the upstream plugin, Bun, and (where Bun says it follows oxlint)
oxlint. Bun 1.4.4-canary.1+5f5799ed1, 2026-10-16. The `node_modules` the
ESLint runs used were a scratch install (`eslint@10.5.0`,
`@typescript-eslint/parser@8.59.4`, `@typescript-eslint/eslint-plugin@8.59.4`,
`eslint-plugin-import@2.32.0`, `eslint-plugin-import-lite@0.6.0`,
`eslint-plugin-n@18.0.1` and `@18.4.1`, `eslint-plugin-unicorn@64.0.0`,
`eslint-plugin-unused-imports@4.4.1`, `oxlint@1.88.0`); they are not kept.

**None of these is a Bun bug.** In each, Bun does what its documentation or
the upstream it ports says; the difference is between our ESLint stack
(antfu's choice of plugin fork, or a plugin's extra leniency) and that
upstream. They are recorded because each one is a line the migration must
handle.

| Folder | Code | Upstream | Bun native | Verdict |
|---|---|---|---|---|
| `jsdoc-link/`, `jsdoc-link-native/` | `import type { Thing }` used only in `/** {@link Thing} */` | `@typescript-eslint/no-unused-vars` 8.59.4: **reports**; `eslint-plugin-unused-imports` 4.4.1 (what we run): **does not** (it scans JSDoc for `{@link Name}` / `@see Name`) | reports | Bun = typescript-eslint. Our plugin is lenient. 1 hit in the repo (`packages/bun-jobs/lib/queue/workerTarget.ts:20`). |
| `no-dup/` | `import type { A } from "./m"` + `import type * as M from "./m"` | `eslint-plugin-import` 2.32.0: **reports both**; `eslint-plugin-import-lite` 0.6.0 (antfu's fork, what we run): **does not** (it keeps namespace type imports apart) | reports | Bun = eslint-plugin-import. 8 hits in the repo, all type-test files. |
| `cb-err/`, `cb-err-native/` | `function wrap(error: Error): Error;` overload signatures | `eslint-plugin-n` 18.0.1 and 18.4.1: **no report**; `oxlint` 1.88.0 `node/handle-callback-err`: **reports each signature** | reports each signature | Bun = oxlint, as its docs say for its `node` rules. 2 hits (`packages/bun-nest/lib/interceptors.ts:121,123`). |
| `unicorn/` | `waiter.match(line)` on a non-string; `/^\^3\./.test("^2.0.0")` | `eslint-plugin-unicorn` 64.0.0: reports `prefer-regexp-test` only; oxlint 1.88.0: reports both | reports both | Bun = oxlint. 5 hits. |
| `ns/`, `ns-native/` | `export declare namespace Schema { … }` in a `.ts` file | `@typescript-eslint/no-namespace` 8.59.4 default `allowDeclarations: false`: **reports**; Bun reading the same ESLint config: **reports** | **does not report** | Bun's native default is `allowDeclarations = true`, and `bun lint --explain=@typescript-eslint/no-namespace` says so. A documented default difference: set the option explicitly. Showed up as an unused `eslint-disable` at `packages/bun-common/lib/types/standardSchema.ts:25`. |

Commands, from each folder (with a `node_modules` that has the packages above):

```sh
./node_modules/.bin/eslint a.ts                 # the upstream plugin
CI=1 bun lint --format unix a.ts                # Bun, reading eslint.config.mjs
cd ../<name>-native && CI=1 bun lint --format unix a.ts   # Bun, bunfig.toml only
```
