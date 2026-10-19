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
(`bun upgrade --canary`; verified on 1.4.4-canary.1+5f5799ed1, `bun --revision`).

## Steps

1. **Typecheck** — from the repo root, `bun scripts/typecheck.ts`
   Covers every project in the repo (the packages, their nested bench /
   playground / app projects, `benchmarks/`, the examples and the root
   `scripts/`); must end with "no type errors". Run `bun install
   --frozen-lockfile` in the three bench directories and the template first. It
   already filters the known `TS2742`/`TS2883` `eslint.legacy.config.mjs` noise.

Then, for **each affected package** (`packages/bun-common`, `packages/bun-nest`,
`packages/bun-jobs`, `packages/bun-jobs-ui`), from that package's directory:

2. **Lint** — `CI=1 bun run lint:eslint` (ESLint over the whole package, with
   `-c eslint.legacy.config.mjs`; a bare `bunx eslint .` finds no config).
   Must report **0 errors**. A small number of intentional `no-console`
   *warnings* (error logging in catch blocks with no logger in scope) are
   acceptable — warnings do not fail the gate. Auto-fix formatting with
   `bun run lint:eslint --fix` when only style errors remain (not `bun fmt`,
   which disagrees with ESLint's Prettier until the bun-lint-fmt flip, PR E).
   `bun run lint` (`bun lint`) runs too, and reports findings that each owner
   fixes before the flip; it gates nothing yet.

3. **Test** — `bun test`
   Every test must pass.

If you changed **`bun-common`**, always run steps 2 and 3 for **`bun-nest`**
and **`bun-jobs`** too — both depend on bun-common at the source level.

If you changed anything in the root **`scripts/`**, lint it from there:
`bun run lint:eslint:scripts` from the root (0 errors; its config turns
`no-console` off, so 0 warnings too). Step 1 already typechecks it.

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
