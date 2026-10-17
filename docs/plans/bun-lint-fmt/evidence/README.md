# Evidence: `bun lint` and `bun fmt` against ESLint and Prettier

Everything here, except `type-aware/` and the files marked 2026-10-17, was
measured or read on 2026-10-16 with **Bun
1.4.4-canary.1+5f5799ed1**, in scratch clones of develop at `f9baf24a`
(`git clone --local` under `~/.cache/bun-node-ae/plan-lintfmt/`, never the
worktree), on a 16-core Linux x64 machine shared with other sessions (the
load average is recorded with every timing). Re-run before relying on any of
it: the canary changes daily.

| Folder | What | Kind |
|---|---|---|
| [`bun-cli/`](bun-cli/) | `bun lint --help --all`, `bun fmt --help --all`, `bun lint --rules` (1,021 rules), sample `--explain` pages, `bun --revision`, the `oven.bun-vscode` manifest on `main`, and the oven-sh/bun lint/fmt issues opened since 2026-09-01 | read |
| [`doctor/`](doctor/) | `bun lint --doctor` and `bun fmt --doctor`, text and `-f json`, in each of the 11 lint directories, `benchmarks/` and the root | measured |
| [`inventory/`](inventory/) | every `eslint-disable` / `eslint-enable` / `eslint-skip` directive in the repo, tallied by rule | read |
| [`rules/`](rules/README.md) | ESLint's effective config on ten representative files (`--print-config`), the 384 enabled rules, the parity map (127 native, 85 different, 172 missing), the generated `bunfig.toml` `[lint]` sections | measured and read |
| [`lint-shadow/`](lint-shadow/README.md) | ESLint and native `bun lint` on the same tree, diffed by `file:line:rule`: all 71 ESLint findings reproduced, 743 extra explained, 16 real defects | measured |
| [`repros/`](repros/README.md) | single-file reproductions of each disagreement, against the upstream plugin and oxlint | measured |
| [`format/`](format/README.md) | `bun fmt` against Prettier 3.8.4 and 3.9.10 on every file, idempotence, `--debug-check`, the whole-repo diff, Markdown and the parsed READMEs, the generated overloads, import and `package.json` sorting | measured |
| [`perf/`](perf/README.md) | ESLint, `bun lint` (four ways), Prettier and `bun fmt`, three runs each, wall and CPU time | measured |
| [`type-aware/`](type-aware/README.md) | 2026-10-17, develop `930dd664`: the answered config ([`rules/bunfig.answered.toml`](rules/bunfig.answered.toml)) with and without `--type-aware` in the 11 directories, timed three times; every finding, one file per directory; a cross-check against typescript-eslint on bun-common; Q8's `no-restricted-globals` and Q1's `eslint-plugin-regexp` without `eslint` | measured |
| [`bun-bugs/`](bun-bugs/README.md) | the candidates investigated; none of 2026-10-16 is a Bun bug; two suspected on 2026-10-17, not filed | measured |
| [`tools/`](tools/) | the scripts that produced the above (paths inside point at the scratch directory) | — |

The `tools/` scripts expect the layout of the scratch directory: `copy/` (a
clone with `bun install` run, ESLint configs intact), `native/` (a clone with
every `eslint.config.mjs` deleted and a generated root `bunfig.toml`), `p38/`
and `p39/` (Prettier 3.8.4 and 3.9.10 installed alone), `out/`.
