---
name: bun-node-check
description: >-
  Verify changes to the bun-node monorepo (the @kingsleyweb/bun-common,
  @kingsleyweb/bun-nest and @kingsleyweb/bun-jobs packages). Use after editing anything under
  packages/*/lib or packages/*/__tests__, or when asked to check / validate /
  verify the build, types, lint, or tests for this repo.
---

# bun-node verification

Run the full quality gate for the affected package(s) of this Bun monorepo.
Everything runs with **Bun** (`bun` / `bunx`). Source ships as raw `.ts`.
Developing needs **Bun ≥ 1.4.4**, the canary until it is stable
(`bun upgrade --canary`; verified on 1.4.4-canary.1+5f5799ed1 and 6bb5dc195, `bun --revision`).

## Steps

1. **Typecheck** — from the repo root, `bun scripts/typecheck.ts`
   Covers every project in the repo (the packages, their nested bench /
   playground / app projects, `benchmarks/`, the examples and the root
   `scripts/`); must end with "no type errors". Run `bun install
   --frozen-lockfile` in the three bench directories, the template and
   `tools/vscode-bun-lint/` first. It
   already filters the known `TS2742`/`TS2883` `eslint.legacy.config.mjs` noise.

Then, for **each affected package** (`packages/bun-common`, `packages/bun-nest`,
`packages/bun-jobs`, `packages/bun-jobs-ui`), from that package's directory:

2. **Lint and format** — `bun run lint` (`bun lint`, type-aware, over the
   whole package, against the root `bunfig.toml`) must report **0 errors**;
   warnings do not fail the gate. Then `bun run format:check` (`bun fmt
   --check`) must be clean; `bun run format` formats. Never let `bun lint
   --fix` edit one of the four `scripts/build-declarations.ts` or
   `tsconfig.build.json` copies alone (the same change to all four, or none),
   and never autofix `@typescript-eslint/no-duplicate-type-constituents` (its
   fix deletes compile-time guards). ESLint is no longer run (bun-lint-fmt
   PR E).

3. **Test** — `bun test`
   Every test must pass.

If you changed **`bun-common`**, always run steps 2 and 3 for **`bun-nest`**
and **`bun-jobs`** too — both depend on bun-common at the source level.

If you changed anything in the root **`scripts/`**, check it from the root:
`bun run lint:scripts` (0 errors) and `bun run format:check:scripts`. Step 1
already typechecks it.

## Conventions to uphold

- Add or update tests for every behavioural change; never let an existing
  test regress. Tests revealing real bugs is expected — fix the bug.
- New tests must reuse the helpers (`__tests__/helpers.ts` in each package)
  and bind servers to **port `0`**. A bare `Bun.serve` defaulting to port 3000
  will collide and fail intermittently.
- Prefer native/Bun APIs and `packages/bun-common/lib/utils/native.ts` over
  new dependencies.
- `BunHttpAdapter.close()` must `stop(true)` (force-close) so ports are fully
  released — see CLAUDE.md "Port-release pitfall".
- bun-jobs tests must never leave a runner, worker, timer or child process
  alive after the test (register cleanup in `afterEach`/`afterAll`), or
  `bun test` hangs; use unique temp dirs and unique namespaces per suite.

## Report

Summarise the repo typecheck (clean / errors), then per package: lint (error
count, format check) and tests (pass/fail counts), plus `scripts/` lint when it changed.
Call out any failure with the offending output.
