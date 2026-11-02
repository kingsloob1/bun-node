/**
 * The transport-agnostic contract core, published as the browser-safe
 * subpath `@kingsleyweb/bun-common/contract`. It lives in
 * `@kingsleyweb/bun-contract` since the typed-client plan's PR-K (§10.1):
 * this entry re-exports that package's root unchanged, after installing
 * bun-common's logger resolution (`./logger`), so a guard's `logger` option
 * takes every logger bun-common does.
 *
 * Browser-safe: bun-contract imports no Bun or Node API, and bun-common's
 * logger is dependency-free (`__tests__/contract/browserSafety.test.ts`
 * checks a browser bundle of this entry).
 */
import "./logger";

export * from "@kingsleyweb/bun-contract";
