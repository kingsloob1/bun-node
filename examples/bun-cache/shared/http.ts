/**
 * Helpers for the `05-http` examples: a cache fit for `cacheResponse()` and a
 * promise for the next write.
 */
import type { Cache, CacheEventMap } from "@kingsleyweb/bun-cache";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";

/**
 * A cache on a fresh memory driver, in a namespace of its own, as the README
 * advises: an unsafe request's invalidation forgets the in-flight loads of the
 * whole namespace. The default codec (`structured`) keeps the framed bytes.
 */
export function httpCache(): Cache {
  return createCache({
    driver: memoryDriver(),
    namespace: "http",
    sweepInterval: 0,
  });
}

/**
 * Resolves with the next `set` event. A miss answers before its entry is
 * written (the write never delays the response), so an example that wants the
 * next request to hit awaits this first. Rejects after two seconds, so an
 * example whose request never stored fails instead of waiting forever.
 */
export function nextSet(cache: Cache): Promise<CacheEventMap["set"]> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = cache.on("set", (event) => {
      clearTimeout(timer);
      off();
      resolve(event);
    });
    timer = setTimeout(() => {
      off();
      reject(new Error("Timed out waiting for the cache to store an entry"));
    }, 2000);
  });
}
