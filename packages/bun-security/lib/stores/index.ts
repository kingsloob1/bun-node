/**
 * `@kingsleyweb/bun-security/stores`: shared state over bun-cache
 * (topologies.md §3), the entry that needs `@kingsleyweb/bun-cache` (an
 * optional peer):
 *
 * - {@link cacheStore}: the engine's shared store over a bun-cache `Cache`,
 *   for `createSecurity({ store })`: shared and hybrid limits, counted
 *   rules, the ban stream, offence scores, distinct counts;
 * - {@link hybridThrottleStore}: the `hybrid` mode as a plain
 *   `ThrottleStore` in front of a shared one, for any `throttle()`.
 */
export {
  cacheStore,
  type CacheStoreOptions,
  DEFAULT_STORE_NAMESPACE,
} from "./cache";
export {
  DEFAULT_SYNC_INTERVAL_MS,
  hybridThrottleStore,
  type HybridThrottleStore,
  type HybridThrottleStoreOptions,
} from "./hybrid";
