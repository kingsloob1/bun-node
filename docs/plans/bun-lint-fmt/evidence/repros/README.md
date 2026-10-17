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

**None of the rows of 2026-10-16 is a Bun bug.** In each, Bun does what its documentation or
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

## Added 2026-10-17: two suspected differences in the type-aware run

Found by cross-checking `bun lint --type-aware` against typescript-eslint
8.59.4 on bun-common ([`../type-aware/`](../type-aware/README.md)). Unlike the
rows above, Bun here differs from the upstream it ports, and neither behaviour
is in `bun lint --explain`. Both were filed on 2026-10-17, after a search
found nothing open (rows below). Found on Bun 1.4.4-canary.1+5f5799ed1, ESLint 10.5.0,
`@typescript-eslint/*` 8.59.4.

| Folder | Code | Upstream | Bun native | Status |
|---|---|---|---|---|
| `unbound-union-key/`, `unbound-union-key-native/` | `router[verb]` where `verb: "get" \| "post"` names two methods; `router.get` beside it | `@typescript-eslint/unbound-method`: reports `router.get` (8:23) only | reports both (7:24 and 8:23) | filed as [oven-sh/bun#45784](https://github.com/oven-sh/bun/issues/45784) (2026-10-17; reproduced against ESLint 9.39.5 + typescript-eslint 8.59.4, and on the latest canary): a stricter report than the rule it ports. 2 hits in the repo (`packages/bun-common/__tests__/router-adapter.type-test.ts:327,344`). |
| `directive-covers-ts-twin/`, `directive-covers-ts-twin-native/` | `// eslint-disable-next-line no-unused-vars` above an unused `const`, with `@typescript-eslint/no-unused-vars` on and the core rule off | ESLint: reports the variable, and the directive as unused | reports nothing on that line | filed as [oven-sh/bun#45785](https://github.com/oven-sh/bun/issues/45785) (2026-10-17; reproduced against ESLint 9.39.5 + typescript-eslint 8.59.4, and on the latest canary), possibly intended: a directive naming a core rule also silences its typescript-eslint twin, and is not reported as unused. Under `--type-aware` Bun swaps `no-throw-literal` for `only-throw-error`, so the 3 `no-throw-literal` directives in the repo (`examples/bun-common/12-options/native-utilities.ts:1991`, `packages/bun-common/__tests__/fetch.test.ts:777`, `packages/bun-nest/__tests__/httpAdapter.test.ts:742`) silence `only-throw-error`, where ESLint would not. |

The type-aware folders carry a `tsconfig.json`; the ESLint side needs
`@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin` in its
`node_modules`.

Commands, from each folder (with a `node_modules` that has the packages above):

```sh
./node_modules/.bin/eslint a.ts                 # the upstream plugin
CI=1 bun lint --format unix a.ts                # Bun, reading eslint.config.mjs
cd ../<name>-native && CI=1 bun lint --format unix a.ts   # Bun, bunfig.toml only
```
