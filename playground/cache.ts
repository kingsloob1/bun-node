/**
 * The bun-cache corner of the playground: the page at `/playground/cache`
 * (plan row PG) and the routes it drives, all on one switchable cache.
 *
 * - **The cache** is rebuilt by `POST /playground/cache/config?driver=&compress=&l1=`:
 *   any driver `cache-drivers.ts` finds available (memory, file and SQLite
 *   always; the servers whose `BUN_CACHE_TEST_*_URL` is set), a compression
 *   algorithm (off, zstd, gzip, br, deflate, at a 1 KiB threshold so the
 *   demo's responses reach it), and an L1 tier on or off. The previous cache
 *   is closed and its data removed. It starts on memory, zstd, L1 on.
 * - **Cached routes** (`/playground/cache/http/*`, behind `cacheResponse()`
 *   from `@kingsleyweb/bun-cache/http`): each takes about 120 ms to build, so
 *   a `MISS` and a `HIT` differ in time as well as in `X-Cache`.
 *   `item/:id` is fresh for 15 s, tagged `items` and `item:<id>`, `?bypass`
 *   answers `BYPASS`, and a `POST` to it invalidates it (RFC 9111 §4.4);
 *   `swr` is fresh for 2 s, then `STALE` for 60 s while one background replay
 *   refreshes it; `sie` is fresh for 2 s, then, while its failure switch is on
 *   (`POST /playground/cache/sie?failing=true`), its 503 is replaced by the
 *   stale copy; `private` answers `Cache-Control: private`, so `UNCACHEABLE`;
 *   `big` is about 64 KiB of text, for the compression switch.
 * - **Controls**: invalidate by path or tag, a load fenced by a mid-load
 *   delete (`fenced`), a fill past the drivers' 64-entry cap (`evictions`),
 *   and a counters reset. `GET /playground/cache/state` is the page's JSON.
 * - **The PR-C1 report** stays: `GET /playground/cache/report` (250 ms to
 *   build, cached 10 s with a 30 s stale window through `getOrSet`; its
 *   `cache` field says `miss`, `hit` or `stale`), `GET /playground/cache/stats`
 *   and `POST /playground/cache/invalidate` (the `report` tag, or `?tag=`).
 * - **At rest** (`cache-at-rest.ts`, PR-E3): `GET`/`POST
 *   /playground/cache/at-rest`, one value through an encrypted cache with
 *   `hashNames` on, shown as the store holds it beside what the cache
 *   answers, with a plain cache's copy for contrast. It has its own two
 *   caches over an in-memory SQLite database; the switch does not touch it.
 *
 * Everything lives in the namespace `playground-cache`, under a prefix of
 * this process's own (`cache-drivers.ts`), removed by `stop()`.
 */
import type { BunHttpAdapter, RouterHandler } from "@kingsleyweb/bun-common";
import type {
  Cache,
  CacheStats,
  CompressOptions,
} from "@kingsleyweb/bun-cache";
import type { CacheResponseMiddleware } from "@kingsleyweb/bun-cache/http";
import type { LabDriver, LabDriverKind } from "./cache-drivers";
import { createCache } from "@kingsleyweb/bun-cache";
import { addCacheTags, cacheResponse } from "@kingsleyweb/bun-cache/http";
import {
  isAvailable,
  LAB_MAX_ENTRIES,
  labDrivers,
  openLabDriver,
  removeCacheDirs,
  removeLabData,
} from "./cache-drivers";
import { mountAtRestDemo } from "./cache-at-rest";
import { cachePage } from "./cache-page";

/** The lab's mount point. */
export const CACHE_BASE = "/playground/cache";

/** The compression settings the page offers. */
export const LAB_COMPRESSIONS = [
  "off",
  "zstd",
  "gzip",
  "br",
  "deflate",
] as const;

/** One of {@link LAB_COMPRESSIONS}. */
export type LabCompression = (typeof LAB_COMPRESSIONS)[number];

/** What the lab's cache is built from. */
export interface LabConfig {
  /** The driver. */
  driver: LabDriverKind;
  /** The compression algorithm, or `"off"`. */
  compress: LabCompression;
  /** Whether the cache has an L1 tier (and so `stats().l1`). */
  l1: boolean;
}

/** One driver the lab opened this run, for the page and the smoke check. */
export interface LabOpening {
  /** The driver kind. */
  kind: LabDriverKind;
  /** Where its data lives (`cache-drivers.ts`). */
  location: string;
  /** Whether it is the current one. */
  current: boolean;
  /** How many things its cleanup removed, once it was closed. */
  removed?: number;
}

/** What the demo owns, for the playground's shutdown. */
export interface CacheDemo {
  /** The current cache (it changes on every switch). */
  readonly cache: Cache;
  /** Closes the cache and removes every driver's data this run created. */
  stop: () => Promise<void>;
}

/** The cached routes' middlewares, rebuilt with each cache. */
interface LabRoutes {
  /** `http/item/:id`. */
  item: CacheResponseMiddleware;
  /** `http/swr`. */
  swr: CacheResponseMiddleware;
  /** `http/sie`. */
  sie: CacheResponseMiddleware;
  /** `http/private`. */
  priv: CacheResponseMiddleware;
  /** `http/big`. */
  big: CacheResponseMiddleware;
}

/** The namespace every lab entry is written under. */
const NAMESPACE = "playground-cache";

/** How long a cached route takes to build, in ms. */
const BUILD_MS = 120;

/** The compression threshold: low, so the demo's responses are compressed. */
const COMPRESS_THRESHOLD = 1024;

/**
 * Mounts the page and its routes on the adapter, on memory, zstd and L1 to
 * start. `app` is also what a stale-while-revalidate replay runs through.
 */
export async function mountCacheDemo(app: BunHttpAdapter): Promise<CacheDemo> {
  // A `.data/cache-<pid>/` a killed playground left behind.
  removeCacheDirs("stale");

  let config: LabConfig = { driver: "memory", compress: "zstd", l1: true };
  let generation = 0;
  let opened: LabDriver = await openLabDriver(config.driver, ++generation);
  let cache = buildCache(opened, config);
  let routes = buildRoutes(cache, app);
  const openings: LabOpening[] = [
    { kind: opened.kind, location: opened.location, current: true },
  ];
  /** Switches run one at a time. */
  let switching: Promise<unknown> = Promise.resolve();
  /** The `sie` route's failure switch. */
  let sieFailing = false;
  /** Builds per route, so a refreshed response is told from the one before. */
  const builds = new Map<string, number>();
  /** The at-rest item, on caches of its own. */
  const atRest = await mountAtRestDemo(app, CACHE_BASE);

  /** A response that took {@link BUILD_MS} to build. */
  const build = async (route: string): Promise<Record<string, unknown>> => {
    const n = (builds.get(route) ?? 0) + 1;
    builds.set(route, n);
    await Bun.sleep(BUILD_MS);
    return { route, build: n, builtAt: new Date().toISOString() };
  };

  /** Closes `previousCache` and removes `previous`'s data, recording how much. */
  const retire = async (
    previousCache: Cache,
    previous: LabDriver,
  ): Promise<void> => {
    await previousCache.close();
    const removed = await removeLabData(previous);
    const record = openings.findLast(
      (entry) => entry.location === previous.location,
    );
    if (record !== undefined) {
      record.current = false;
      record.removed = removed;
    }
  };

  /** Rebuilds the cache from `next`; throws (keeping the old one) when the driver does not answer. */
  const switchTo = async (next: LabConfig): Promise<void> => {
    const nextOpened = await openLabDriver(next.driver, ++generation);
    const previousCache = cache;
    const previous = opened;
    opened = nextOpened;
    cache = buildCache(nextOpened, next);
    routes = buildRoutes(cache, app);
    config = next;
    openings.push({
      kind: nextOpened.kind,
      location: nextOpened.location,
      current: true,
    });
    await retire(previousCache, previous);
  };

  /** Delegates to the current cache's middleware, so a switch applies to the next request. */
  const via =
    (pick: (current: LabRoutes) => CacheResponseMiddleware): RouterHandler =>
    async (req, res, next) =>
      await pick(routes)(req, res, next);

  /** The page's JSON. */
  const state = (): Record<string, unknown> => ({
    config,
    drivers: labDrivers(),
    driver: {
      kind: opened.kind,
      location: opened.location,
      cap: opened.capped ? LAB_MAX_ENTRIES : null,
    },
    openings,
    sieFailing,
    stats: cache.stats(),
  });

  /* ---------------------------------------------------------------- */
  /* The page, its state and the switch                               */
  /* ---------------------------------------------------------------- */

  app.get(CACHE_BASE, (_req, res) => {
    res.type("html").send(cachePage(CACHE_BASE));
  });

  app.get(`${CACHE_BASE}/state`, (_req, res) => {
    res.json(state());
  });

  app.post(`${CACHE_BASE}/config`, async (req, res) => {
    const query = req.query as Record<string, string | undefined>;
    const driver = query.driver ?? config.driver;
    const compress = query.compress ?? config.compress;
    const l1 = query.l1 === undefined ? config.l1 : query.l1 === "true";
    if (!isAvailable(driver)) {
      res.status(400).json({
        error: `driver "${driver}" is not available here`,
        drivers: labDrivers(),
      });
      return;
    }
    if (!(LAB_COMPRESSIONS as readonly string[]).includes(compress)) {
      res.status(400).json({
        error: `compress must be one of ${LAB_COMPRESSIONS.join(", ")}`,
      });
      return;
    }
    const next: LabConfig = {
      driver,
      compress: compress as LabCompression,
      l1,
    };
    const run = switching.then(async () => await switchTo(next));
    switching = run.catch(() => undefined);
    try {
      await run;
    } catch (error) {
      res.status(502).json({
        error: `could not switch to ${driver}: ${error instanceof Error ? error.message : String(error)}`,
        ...state(),
      });
      return;
    }
    res.json(state());
  });

  /* ---------------------------------------------------------------- */
  /* The cached routes                                                */
  /* ---------------------------------------------------------------- */

  app.get(
    `${CACHE_BASE}/http/item/:id`,
    via((r) => r.item),
    async (req, res) => {
      const id = String(req.params.id);
      addCacheTags(res, `item:${id}`);
      res.json(await build(`item/${id}`));
    },
  );
  // A POST through the middleware that succeeds drops every entry stored for
  // the path (`invalidateOnUnsafe`, RFC 9111 §4.4).
  app.post(
    `${CACHE_BASE}/http/item/:id`,
    via((r) => r.item),
    (req, res) => {
      res.json({ updated: req.params.id });
    },
  );

  app.get(
    `${CACHE_BASE}/http/swr`,
    via((r) => r.swr),
    async (_req, res) => {
      res.json(await build("swr"));
    },
  );

  app.get(
    `${CACHE_BASE}/http/sie`,
    via((r) => r.sie),
    async (_req, res) => {
      if (sieFailing) {
        await Bun.sleep(BUILD_MS);
        res
          .status(503)
          .json({ error: "the origin is failing (the page's switch)" });
        return;
      }
      res.json(await build("sie"));
    },
  );

  app.get(
    `${CACHE_BASE}/http/private`,
    via((r) => r.priv),
    async (_req, res) => {
      res.set("Cache-Control", "private, max-age=60");
      res.json(await build("private"));
    },
  );

  app.get(
    `${CACHE_BASE}/http/big`,
    via((r) => r.big),
    async (_req, res) => {
      const head = await build("big");
      // About 64 KiB of very compressible text.
      const lines = Array.from(
        { length: 900 },
        (_, i) =>
          `line ${String(i).padStart(4, "0")}: the cache stores this response once`,
      );
      res.json({ ...head, lines });
    },
  );

  /* ---------------------------------------------------------------- */
  /* Controls                                                         */
  /* ---------------------------------------------------------------- */

  app.post(`${CACHE_BASE}/sie`, (req, res) => {
    sieFailing = (req.query as { failing?: string }).failing === "true";
    res.json({ sieFailing });
  });

  app.post(`${CACHE_BASE}/invalidate-path`, async (req, res) => {
    const path = String((req.query as { path?: string }).path ?? "");
    if (!path.startsWith(`${CACHE_BASE}/http/`)) {
      res
        .status(400)
        .json({ error: `path must start with ${CACHE_BASE}/http/` });
      return;
    }
    // The path's own tag is the same whichever route's middleware computes it.
    await routes.item.invalidate(path);
    res.json({ invalidated: { path } });
  });

  app.post(`${CACHE_BASE}/fence`, async (_req, res) => {
    // A load that a delete of its key lands in the middle of: the core forgets
    // the flight and drops the write (`fenced`, reason "local").
    const before = cache.stats().fenced;
    const reasons: string[] = [];
    const off = cache.on("fenced", (event) => {
      reasons.push(event.reason);
    });
    const load = cache.getOrSet("fence-demo", async () => {
      await Bun.sleep(300);
      return { loadedAt: new Date().toISOString() };
    });
    await Bun.sleep(100);
    await cache.delete("fence-demo");
    await load;
    off();
    res.json({
      fenced: cache.stats().fenced - before,
      reasons,
      stored: await cache.has("fence-demo"),
    });
  });

  app.post(`${CACHE_BASE}/fill`, async (req, res) => {
    const asked = Number((req.query as { count?: string }).count ?? 100);
    const count = Math.min(1000, Math.max(1, asked || 100));
    const before = cache.stats().evictions;
    for (let i = 0; i < count; i++) {
      await cache.set(`fill:${i}`, { i }, { ttl: 60_000 });
    }
    res.json({
      written: count,
      cap: opened.capped ? LAB_MAX_ENTRIES : null,
      evictions: cache.stats().evictions - before,
      note:
        opened.kind === "memory"
          ? "the memory driver evicts at once"
          : opened.capped
            ? "this driver evicts on its sweep (every 2 s here): watch evictions climb"
            : "this driver has no entry cap (Redis: the server's maxmemory policy evicts)",
    });
  });

  app.post(`${CACHE_BASE}/reset`, (_req, res) => {
    res.json({ previous: cache.stats({ reset: true }) });
  });

  /* ---------------------------------------------------------------- */
  /* The PR-C1 report, on the same cache                              */
  /* ---------------------------------------------------------------- */

  let reportBuilds = 0;
  app.get(`${CACHE_BASE}/report`, async (_req, res) => {
    const before = cache.stats();
    const report = await cache.getOrSet(
      "report",
      async () => {
        reportBuilds++;
        await Bun.sleep(250); // pretend the report is expensive
        return { builtAt: new Date().toISOString(), build: reportBuilds };
      },
      { tags: ["report"], ttl: 10_000, staleWhileRevalidate: 30_000 },
    );
    const after = cache.stats();
    res.json({ report, cache: verdict(before, after) });
  });

  app.get(`${CACHE_BASE}/stats`, (_req, res) => {
    res.json({ stats: cache.stats() });
  });

  app.post(`${CACHE_BASE}/invalidate`, async (req, res) => {
    const tag = String((req.query as { tag?: string }).tag ?? "report");
    await cache.invalidateTags([tag]);
    res.json({ invalidated: true, tag });
  });

  return {
    get cache() {
      return cache;
    },
    stop: async () => {
      await switching;
      await retire(cache, opened);
      await atRest.stop();
      removeCacheDirs("mine");
    },
  };
}

/** What a `getOrSet` call was, from the counters around it. */
function verdict(before: CacheStats, after: CacheStats): string {
  if (after.hits > before.hits) {
    return "hit";
  }
  return after.staleHits > before.staleHits ? "stale" : "miss";
}

/** The lab's cache over `opened`, as `config` says. */
function buildCache(opened: LabDriver, config: LabConfig): Cache {
  const compress: false | CompressOptions =
    config.compress === "off"
      ? false
      : { algorithm: config.compress, threshold: COMPRESS_THRESHOLD };
  return createCache({
    driver: opened.driver,
    namespace: NAMESPACE,
    ttl: 60_000,
    compress,
    l1: config.l1 ? true : undefined,
    // Short, so a capped driver's evictions show within seconds of "Fill".
    sweepInterval: 2_000,
  });
}

/** The cached routes' middlewares on `cache`. */
function buildRoutes(cache: Cache, app: BunHttpAdapter): LabRoutes {
  return {
    item: cacheResponse(cache, {
      ttl: 15_000,
      tags: ["items"],
      bypass: (req) => req.query.bypass !== undefined,
    }),
    swr: cacheResponse(cache, {
      ttl: 2_000,
      staleWhileRevalidate: 60_000,
      // The replay runs the whole adapter pipeline, socket-free.
      revalidate: { fetch: async (request) => await app.fetch(request) },
    }),
    sie: cacheResponse(cache, { ttl: 2_000, staleIfError: 60_000 }),
    priv: cacheResponse(cache, { ttl: 15_000 }),
    big: cacheResponse(cache, { ttl: 15_000 }),
  };
}
