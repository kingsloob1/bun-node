import type { CacheContender } from "../lib/types";
import { bentoContenders } from "./bentocache";
import { bunCacheContenders } from "./bun-cache";
import { cacheManagerContenders } from "./cache-manager";
import { cacheableContenders } from "./cacheable";
import { lruCacheContenders } from "./lru-cache";

/** Every contender, ours first. */
export function cacheContenders(): CacheContender[] {
  return [
    ...bunCacheContenders(),
    ...cacheManagerContenders(),
    ...lruCacheContenders(),
    ...bentoContenders(),
    ...cacheableContenders(),
  ];
}
