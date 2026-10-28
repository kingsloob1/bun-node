/**
 * `@kingsleyweb/bun-cache/testing`: the driver conformance kit (plan §6.2),
 * the cipher conformance kit (the encryption plan's §6.3), and the test
 * helpers — `faulty` for fault injection, `fakeClock` for the cache's `now`
 * option (§13.1).
 */
// The contract types the kit's signatures name, so a custom driver's test
// file can spell them from the one subpath it already imports.
export type {
  CacheCipher,
  CacheCipherContext,
  CacheDriver,
  StoredEntry,
} from "../core/types";
export { runCacheCipherConformance } from "./cipher";
export { fakeClock } from "./clock";
export type { FakeClock } from "./clock";
export { runCacheDriverConformance } from "./conformance";
export type {
  ConformanceCrossProcess,
  ConformanceFactory,
  ConformanceInstance,
  ConformanceOptions,
} from "./conformance";
export { faulty, InjectedFaultError } from "./faulty";
export type { FaultOptions, FaultyDriver } from "./faulty";
