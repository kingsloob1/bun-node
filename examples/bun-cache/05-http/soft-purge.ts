/**
 * Soft purge over HTTP — after `cache.invalidateTags(tags, { mode: "stale" })`
 * the stored responses carrying the tags are answered `STALE` and refreshed
 * by one background replay, instead of being dropped.
 *
 * ```bash
 * bun 05-http/soft-purge.ts
 * ```
 *
 * - The cache needs `softPurge: true`. The handler says
 *   `max-age=300, stale-while-revalidate=60`, so the entry is fresh for
 *   minutes: only the purge makes it stale.
 * - The window is counted from the purge: the first request after it is
 *   `STALE` with the old body, a replay runs the handler once, and the
 *   request after that is a `HIT` with the new body.
 * - A route with no window (`max-age` alone) answers a `MISS` after the
 *   purge, since there is nothing to serve stale.
 */
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { addCacheTags, cacheResponse } from "@kingsleyweb/bun-cache/http";
import { BunRouter } from "@kingsleyweb/bun-common";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { nextSet } from "../shared/http";

title("bun-cache/http: STALE after a soft purge");

const cache = createCache({
  driver: memoryDriver(),
  namespace: "http",
  sweepInterval: 0,
  softPurge: true,
});
const router = new BunRouter();
const runs = { swr: 0, plain: 0 };

router.get(
  "/swr",
  cacheResponse(cache, { revalidate: router }),
  async (_req, res) => {
    const run = ++runs.swr;
    await Bun.sleep(10);
    addCacheTags(res, "page:swr");
    res.setHeader("Cache-Control", "max-age=300, stale-while-revalidate=60");
    res.send(`swr v${run}`);
  },
);
router.get("/plain", cacheResponse(cache), (_req, res) => {
  const run = ++runs.plain;
  addCacheTags(res, "page:plain");
  res.setHeader("Cache-Control", "max-age=300");
  res.send(`plain v${run}`);
});

/** The answer to the next `GET path`: its `X-Cache` and body. */
async function get(path: string) {
  const response = await router.fetch(path);
  return {
    xCache: response.headers.get("x-cache"),
    body: await response.text(),
  };
}

/* ------------------------------------------------------------------ */
step("a fresh entry, a soft purge, a STALE answer, then a HIT");

const stored = nextSet(cache);
checkEqual("first request", (await get("/swr")).xCache, "MISS");
await stored;
checkEqual("fresh: a HIT", (await get("/swr")).xCache, "HIT");

await cache.invalidateTags(["page:swr"], { mode: "stale" });
const refreshed = nextSet(cache);
const stale = await get("/swr");
show("after the purge", stale);
checkEqual("the first request after the purge is STALE", stale.xCache, "STALE");
checkEqual("with the old body", stale.body, "swr v1");
await refreshed;
checkEqual("one replay ran the handler", runs.swr, 2);
const hit = await get("/swr");
show("after the replay", hit);
checkEqual("then a HIT", hit.xCache, "HIT");
checkEqual("with the new body", hit.body, "swr v2");

/* ------------------------------------------------------------------ */
step("no stale window: the purge makes the next request a MISS");

const plainStored = nextSet(cache);
await get("/plain");
await plainStored;
checkEqual("fresh: a HIT", (await get("/plain")).xCache, "HIT");
await cache.invalidateTags(["page:plain"], { mode: "stale" });
const after = await get("/plain");
show("after the purge", after);
checkEqual("a MISS", after.xCache, "MISS");
checkEqual("that ran the handler again", after.body, "plain v2");
await waitFor("the refreshed entry to be stored", async () => {
  return (await get("/plain")).xCache === "HIT";
});
check("and it is stored again", runs.plain === 2, runs);

summary();
await cache.close();
