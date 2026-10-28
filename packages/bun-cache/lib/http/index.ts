/**
 * `@kingsleyweb/bun-cache/http`: response caching for bun-common's
 * `BunRouter` and both HTTP adapters (plan §9).
 *
 * ```ts
 * import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
 * import { addCacheTags, cacheResponse } from "@kingsleyweb/bun-cache/http";
 *
 * const cache = createCache({ driver: memoryDriver() });
 * const pages = cacheResponse(cache, { ttl: 60_000 });
 * router.get("/posts/:id", pages, async (req, res) => {
 *   addCacheTags(res, `post:${req.params.id}`);
 *   res.json(await loadPost(req.params.id));
 * });
 * ```
 */
export { cacheResponse } from "./cacheResponse";
export type {
  CacheResponseMiddleware,
  CacheResponseOptions,
  CacheStatus,
} from "./cacheResponse";
export { coalesceRequests } from "./coalesce";
export type { CoalesceRequestsOptions } from "./coalesce";
export { addCacheTags } from "./tags";
