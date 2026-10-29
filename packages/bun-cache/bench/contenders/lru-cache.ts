import type { CacheContender, CacheHandle } from "../lib/types";
import { LRUCache } from "lru-cache";

/**
 * lru-cache 11.5.3: the in-process baseline for the memory backend. It is
 * synchronous and stores the object itself (no copy, no codec), so it is the
 * floor a memory cache's own work is measured against. It is called inside
 * the same awaited shape as everyone else, so its figure includes one
 * promise per operation.
 */
export function lruCacheContenders(): CacheContender[] {
  return [
    {
      id: "lru-cache",
      label: "lru-cache",
      backend: "memory",
      scenarios: [
        "get-hit-100b",
        "get-hit-10kb",
        "get-hit-1mb",
        "get-miss",
        "set-100b",
        "set-10kb",
        "set-1mb",
      ],
      note: "lru-cache holds the object by reference: no copy and no codec, so a hit returns the caller's own object.",
      setup: (): CacheHandle => {
        const lru = new LRUCache<string, object>({
          max: 100_000,
          ttl: 600_000,
        });
        return {
          // eslint-disable-next-line @typescript-eslint/require-await -- the awaited shape every contender is called in
          get: async (key) => lru.get(key),
          // eslint-disable-next-line @typescript-eslint/require-await -- the awaited shape every contender is called in
          set: async (key, value) => {
            lru.set(key, value as object);
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- nothing to release
          close: async () => {
            lru.clear();
          },
        };
      },
    },
  ];
}
