/**
 * Moved to `@kingsleyweb/bun-contract` (typed-client plan §10.1, PR-K); this
 * path re-exports that package's `lib/describe.ts` unchanged, so every import of
 * it keeps working. Its functions log, so loading it installs bun-common's
 * logger resolution first (`./logger`).
 */
import "./logger";

export * from "@kingsleyweb/bun-contract/lib/describe";
