/**
 * The bun-cache corner of the playground (bun-cache PR-C1): one cached
 * endpoint on the playground's adapter, so `getOrSet`, the single-flight,
 * stale-while-revalidate, tags and `stats()` are visible live.
 *
 * - `GET  /playground/cache/report` — a report that takes 250 ms to build,
 *   cached for 10 s with a 30 s stale window. The response's `cache` field
 *   says whether you saw a `miss` (it was built for you), a `hit`, or
 *   `stale` (served stale while a refresh runs in the background). Fire ten
 *   at once: one build.
 * - `GET  /playground/cache/stats` — the cache's counters.
 * - `POST /playground/cache/invalidate` — drops the report's tag, so the next
 *   read builds again.
 */
import type { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { Cache } from "@kingsleyweb/bun-cache";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";

/** What the demo owns: the cache, so the playground's shutdown can close it. */
export interface CacheDemo {
  /** The demo's cache. */
  cache: Cache;
}

/** Mounts the demo's routes on the adapter. */
export function mountCacheDemo(app: BunHttpAdapter): CacheDemo {
  const cache = createCache({
    driver: memoryDriver(),
    namespace: "playground",
    ttl: 10_000,
    staleWhileRevalidate: 30_000,
  });

  let builds = 0;

  app.get("/playground/cache/report", async (_req, res) => {
    const before = cache.stats();
    const report = await cache.getOrSet(
      "report",
      async () => {
        builds++;
        await Bun.sleep(250); // pretend the report is expensive
        return { builtAt: new Date().toISOString(), build: builds };
      },
      { tags: ["report"] },
    );
    const after = cache.stats();
    res.json({
      report,
      cache:
        after.hits > before.hits
          ? "hit"
          : after.staleHits > before.staleHits
            ? "stale"
            : "miss",
    });
  });

  app.get("/playground/cache/stats", (_req, res) => {
    res.json({ stats: cache.stats() });
  });

  app.post("/playground/cache/invalidate", async (_req, res) => {
    await cache.invalidateTags(["report"]);
    res.json({ invalidated: true });
  });

  return { cache };
}
