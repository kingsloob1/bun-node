---
name: bun-node-check
description: >-
  Verify changes to the bun-node monorepo (the @kingsleyweb/bun-common and
  @kingsleyweb/bun-nest packages). Use after editing anything under
  packages/*/lib or packages/*/__tests__, or when asked to check / validate /
  verify the build, types, lint, or tests for this repo.
---

# bun-node verification

Run the full quality gate for the affected package(s) of this Bun monorepo.
Everything runs with **Bun** (`bun` / `bunx`). Source ships as raw `.ts`.

## Steps

For **each affected package** (`packages/bun-common`, `packages/bun-nest`),
from that package's directory:

1. **Typecheck** — `bunx tsc --noEmit`
   Must be clean. Ignore the single pre-existing `eslint.config.mjs` `TS2742`
   portability hint — it is unrelated noise.

2. **Lint** — `bunx eslint lib __tests__`
   Must report **0 errors**. A small number of intentional `no-console`
   *warnings* (error logging in catch blocks with no logger in scope) are
   acceptable — warnings do not fail the gate. Auto-fix formatting with
   `bunx eslint lib __tests__ --fix` when only style errors remain.

3. **Test** — `bun test`
   Every test must pass.

If you changed **`bun-common`**, always run all three for **`bun-nest`** too —
bun-nest depends on bun-common at the source level.

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

## Report

Summarise per package: typecheck (clean / errors), lint (error count),
tests (pass/fail counts). Call out any failure with the offending output.
