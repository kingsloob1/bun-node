/**
 * Shared helpers for the `./http` tests: a cache on a fresh memory driver,
 * a promise for the next write, and a reader for what a key holds.
 */
import type { Cache, CacheEventMap, CreateCacheOptions } from "../../lib/index";
import { createCache, memoryDriver } from "../../lib/index";
import type { Frame } from "../../lib/http/frame";
import { decodeFrame } from "../../lib/http/frame";

/** A cache on a fresh memory driver, the sweeper off. */
export function makeHttpCache(
  options: Omit<CreateCacheOptions, "driver"> = {},
): Cache {
  return createCache({
    driver: memoryDriver(),
    sweepInterval: 0,
    ...options,
  });
}

/**
 * Resolves with the next `set` event: a miss answers before its entry is
 * written (the write never delays the response), so a test that wants the
 * next request to hit awaits this first.
 */
export function nextSet(cache: Cache): Promise<CacheEventMap["set"]> {
  return new Promise((resolve) => {
    const off = cache.on("set", (event) => {
      off();
      resolve(event);
    });
  });
}

/** The frame stored at `key` (fresh entries only), decoded. */
export async function frameAt(
  cache: Cache,
  key: string,
): Promise<Frame | undefined> {
  return decodeFrame(await cache.get(key));
}

/** The base key `cacheResponse()` uses for a path with no host, query or `varyBy`. */
export function keyFor(path: string, query = ""): string {
  return `http:${JSON.stringify(["GET", "", path, query])}`;
}
