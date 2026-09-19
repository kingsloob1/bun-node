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

## Steps

1. **Typecheck** — from the repo root, `bun scripts/typecheck.ts`
   Covers every project in the repo (the packages, their nested bench /
   playground / app projects, `benchmarks/`, the examples and the root
   `scripts/`); must end with "no type errors". Run `bun install` in the three
   bench directories first. It already filters the known `TS2742`/`TS2883`
   `eslint.config.mjs` noise.

Then, for **each affected package** (`packages/bun-common`, `packages/bun-nest`,
`packages/bun-jobs`, `packages/bun-jobs-ui`), from that package's directory:

2. **Lint** — `bunx eslint .` (the whole package, not `lib __tests__`)
   Must report **0 errors**. A small number of intentional `no-console`
   *warnings* (error logging in catch blocks with no logger in scope) are
   acceptable — warnings do not fail the gate. Auto-fix formatting with
   `bunx eslint . --fix` when only style errors remain.

3. **Test** — `bun test`
   Every test must pass.

If you changed **`bun-common`**, always run steps 2 and 3 for **`bun-nest`**
and **`bun-jobs`** too — both depend on bun-common at the source level.

If you changed anything in the root **`scripts/`**, lint it from there:
`cd scripts && bunx eslint .` (0 errors; its config turns `no-console` off, so
0 warnings too). Step 1 already typechecks it.

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
count) and tests (pass/fail counts), plus `scripts/` lint when it changed.
Call out any failure with the offending output.
