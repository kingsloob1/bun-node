/**
 * Testing a security store (`@kingsleyweb/bun-security/testing`, storage.md
 * §9): the conformance kit every driver passes, and a store that fails on
 * demand for the engine's degraded-mode tests. Imports `bun:test`: for test
 * files only.
 */
export { runSecurityStoreConformance } from "./conformance";
export type {
  StoreConformanceCrossProcess,
  StoreConformanceFactory,
  StoreConformanceInstance,
  StoreConformanceOptions,
} from "./conformance";
export { faultyStore } from "./faulty";
export type { FaultyStoreOptions, StoreOperation } from "./faulty";
