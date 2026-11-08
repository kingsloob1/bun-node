# bun-ui: evidence

Spikes and surveys behind [`../README.md`](../README.md). Recorded on
2026-11-08 against `develop` at `d0d53ee1`, on Bun 1.4.4-canary.1+11c367163,
git 2.53.0. **No speed was measured or compared** (the standing rule); the
build output below prints a build time because `scripts/build.ts` always does,
and nothing in the plan reads it.

| File | What it shows | How to re-run |
|---|---|---|
| [`build-bun-jobs-ui.txt`](build-bun-jobs-ui.txt) | `bun scripts/build.ts` in `packages/bun-jobs-ui`, written outside the package: every file of `dist/` with its size and gzipped size. **907.1 KiB of JavaScript and CSS (288.8 KiB gzipped)** without source maps; entry 330.2 KiB (106.5 gzipped); 38 JavaScript files, 12 CSS files | `cd packages/bun-jobs-ui && bun scripts/build.ts --out <scratch>/jobs` |
| [`build-bun-api-docs-ui.txt`](build-bun-api-docs-ui.txt) | the same in `packages/bun-api-docs-ui`: **371.6 KiB (112.4 KiB gzipped)**, one entry (339.4 KiB, 106.1 gzipped) and one stylesheet, no split chunk | `cd packages/bun-api-docs-ui && bun scripts/build.ts --out <scratch>/docs` |
| [`dist-sizes.md`](dist-sizes.md) | the bytes on disk of both builds, source maps separated, and the published `3.0.0-rc.0` tarballs broken down by directory; what one bun-ui tarball would hold | the commands in the file |
| [`react-lint-docs.txt`](react-lint-docs.txt) | `bun lint` in `packages/bun-api-docs-ui` with the root `bunfig.toml`'s React override (today `packages/bun-jobs-ui/**` and `examples/bun-jobs-ui/**` only) widened to cover it: **1 error** (`react/only-export-components`, `app/screens/docs/viewer.tsx:35`) **and 2 new warnings** (`react/no-array-index-key`, `http/Sidebar.tsx:163`, `http/index.tsx:175`). Unwidened, the same directory gives 0 errors and 23 warnings. The bunfig edit was reverted after the run | add `"packages/bun-api-docs-ui/**"` to the override's `files` at `bunfig.toml:357`, run `bun lint` in the package, revert |
| [`rename-rebase.sh`](rename-rebase.sh), [`rename-rebase.out`](rename-rebase.out) | a branch written before the move, rebased over a pure `git mv` commit plus an import fix-up: **the edit to a moved file follows it to the new path with no conflict**; a **new file** the branch added in a moved directory stops the rebase once with `CONFLICT (file location)`, already placed at the new path by git's directory-rename detection, and needs only `git add`; `git log --follow` on a moved file shows its history through the move | `bash rename-rebase.sh <bun-node checkout> <empty scratch dir>` (a throwaway repository of its own) |

## Surveys (read, not run)

Each is quoted in the plan with `file:line` at `d0d53ee1` [S]:

- the two packages' `package.json`, `consumer-check.json`, `lib/`,
  `scripts/`, `__tests__/` and budgets (plan §2);
- which files of the two apps are byte-identical (plan §2.4): the command is
  a `cmp` over every path `packages/bun-api-docs-ui/app` shares with
  `packages/bun-jobs-ui/app` — 28 identical files (3,783 lines), 18 at the
  same path that differ (2,814 lines);
- `checkPeerScopes` in the copied `scripts/build-declarations.ts` and the
  two-consumer arrangement in `scripts/consumer-check.ts` (plan §4);
- every file outside the two packages that names either of them (plan §6).
