import type { Backend, CacheContender, CacheHandle } from "../lib/types";
import { Cacheable } from "cacheable";
import { KEYV_BACKENDS, keyvFor } from "./keyv-stores";

/**
 * cacheable 2.5.0 (2.5.1 was the poisoned release of August 2026, since
 * removed: jaredwray/cacheable#1692), the tags rival. It runs as its
 * documented layered default: an in-memory primary over the backend's Keyv
 * store as the secondary, with the tag service on (`tags: true`), which
 * keeps its tag metadata in the secondary. Its invalidation is lazy: an
 * invalidated entry is found stale, and removed, by the next `get`.
 */

/** Builds the cacheable contender for one backend. */
function contender(backend: Backend): CacheContender {
  return {
    id: `cacheable-${backend}`,
    label: backend === "memory" ? "cacheable" : `cacheable + Keyv (${backend})`,
    backend,
    scenarios: ["tags-set", "tags-invalidate"],
    note:
      backend === "memory"
        ? undefined
        : "cacheable is two layers here (in-memory primary, the Keyv store secondary): a read after a write is answered by the primary.",
    setup: (ctx): CacheHandle => {
      const secondary =
        backend === "memory" ? undefined : keyvFor(backend, ctx, "ca");
      const cache = new Cacheable({
        secondary: secondary?.keyv,
        tags: true,
        ttl: 600_000,
        namespace: `ca-${ctx.run}`,
      });
      return {
        get: (key) => cache.get(key),
        set: async (key, value, tags) => {
          await cache.set(key, value, { tags: tags ? [...tags] : undefined });
        },
        invalidateTags: async (tags) => {
          await cache.tags.invalidateTags([...tags]);
        },
        close: async () => {
          if (secondary) {
            await secondary.close();
          } else {
            await cache.disconnect();
          }
        },
      };
    },
  };
}

/** Every cacheable contender, one per backend with a Keyv store. */
export function cacheableContenders(): CacheContender[] {
  return [...KEYV_BACKENDS].map((backend) => contender(backend));
}
