/**
 * CDN tags — `cacheResponse(cache, { surrogateKeys })` sends each answer's
 * tags as Fastly's `Surrogate-Key` or Cloudflare's `Cache-Tag`, so a CDN in
 * front can purge by the tags `cache.invalidateTags()` takes.
 *
 * ```bash
 * bun 05-http/cdn-tags.ts
 * ```
 *
 * - The header is on every `MISS` and `HIT`: the path's own tag
 *   (`http:path:<path>`), then the route's `tags` and `addCacheTags()`'s.
 * - A header the handler set stays first, as written; the entry's tags follow,
 *   de-duplicated (case-insensitively for `Cache-Tag`).
 * - A tag that breaks the CDN's format is left out of the header with one
 *   `logger` warning, and still invalidates the cache.
 * - `surrogateKeys: false` (the default) sends nothing.
 * - The last part is the README's purge recipe: an `invalidate` listener. It
 *   records the calls it would make to Fastly (a hard purge, and
 *   `Fastly-Soft-Purge: 1` for `mode: "stale"`) instead of sending them: no
 *   network, no token.
 */
import { BunRouter, createTestLogger } from "@kingsleyweb/bun-common";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { addCacheTags, cacheResponse } from "@kingsleyweb/bun-cache/http";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { httpCache, nextSet } from "../shared/http";

title("bun-cache/http: CDN tags (Surrogate-Key, Cache-Tag)");

/** The answer to the next `GET path` on `router`: its `X-Cache` and the two tag headers. */
async function get(router: BunRouter, path: string) {
  const response = await router.fetch(path);
  await response.text();
  return {
    xCache: response.headers.get("x-cache"),
    surrogate: response.headers.get("surrogate-key"),
    cacheTag: response.headers.get("cache-tag"),
  };
}

/* ------------------------------------------------------------------ */
step("Surrogate-Key on a MISS and on a HIT");

const fastlyCache = httpCache();
const fastly = new BunRouter();
const fastlyPages = cacheResponse(fastlyCache, {
  ttl: 60_000,
  surrogateKeys: "Surrogate-Key",
});
fastly.get("/posts/:id", fastlyPages, (req, res) => {
  addCacheTags(res, `post:${String(req.params.id)}`);
  res.send("a post");
});

const stored = nextSet(fastlyCache);
const miss = await get(fastly, "/posts/7");
show("MISS", miss);
checkEqual("the first request is a MISS", miss.xCache, "MISS");
checkEqual(
  "it carries the path's tag, then the handler's",
  miss.surrogate,
  "http:path:/posts/7 post:7",
);
await stored;
const hit = await get(fastly, "/posts/7");
show("HIT", hit);
checkEqual("the second is a HIT", hit.xCache, "HIT");
checkEqual("with the same tags", hit.surrogate, "http:path:/posts/7 post:7");
checkEqual("and no Cache-Tag", hit.cacheTag, null);

/* ------------------------------------------------------------------ */
step("Cache-Tag for Cloudflare: comma-separated");

const cfCache = httpCache();
const cloudflare = new BunRouter();
cloudflare.get(
  "/posts/:id",
  cacheResponse(cfCache, { ttl: 60_000, surrogateKeys: "Cache-Tag" }),
  (req, res) => {
    addCacheTags(res, `post:${String(req.params.id)}`);
    res.send("a post");
  },
);
const cf = await get(cloudflare, "/posts/7");
show("Cache-Tag", cf);
checkEqual("comma-separated", cf.cacheTag, "http:path:/posts/7,post:7");
checkEqual("and no Surrogate-Key", cf.surrogate, null);

/* ------------------------------------------------------------------ */
step("a header the handler set is kept first; the rest is de-duplicated");

const mergeCache = httpCache();
const merging = new BunRouter();
merging.get(
  "/merge",
  cacheResponse(mergeCache, { ttl: 60_000, surrogateKeys: "Surrogate-Key" }),
  (_req, res) => {
    res.setHeader("Surrogate-Key", "edge-all post:7");
    addCacheTags(res, "post:7", "post:8", "post:8");
    res.send("merged");
  },
);
const merged = await get(merging, "/merge");
show("merged", merged);
checkEqual(
  "the handler's keys first, then the entry's, each once",
  merged.surrogate,
  "edge-all post:7 http:path:/merge post:8",
);

const cfMergeCache = httpCache();
const cfMerging = new BunRouter();
cfMerging.get(
  "/merge",
  cacheResponse(cfMergeCache, { ttl: 60_000, surrogateKeys: "Cache-Tag" }),
  (_req, res) => {
    res.setHeader("Cache-Tag", "Post:7");
    addCacheTags(res, "post:7", "post:8");
    res.send("merged");
  },
);
checkEqual(
  "Cache-Tag compares case-insensitively: post:7 is Post:7",
  (await get(cfMerging, "/merge")).cacheTag,
  "Post:7,http:path:/merge,post:8",
);

/* ------------------------------------------------------------------ */
step("a tag that breaks the format: left out, warned once, still invalidates");

const { logger, events } = createTestLogger();
const badCache = httpCache();
const bad = new BunRouter();
let badRuns = 0;
bad.get(
  "/bad",
  cacheResponse(badCache, {
    ttl: 60_000,
    surrogateKeys: "Surrogate-Key",
    logger,
  }),
  (_req, res) => {
    badRuns++;
    addCacheTags(res, "has space", "ok:1");
    res.send("bad tag");
  },
);
const badStored = nextSet(badCache);
const badFirst = await get(bad, "/bad");
show("header", badFirst.surrogate);
checkEqual(
  "the tag holding a space is not in the header",
  badFirst.surrogate,
  "http:path:/bad ok:1",
);
const warnings = events.filter((event) => event.level === "warn");
show(
  "warnings",
  warnings.map((event) => event.message),
);
checkEqual("one warning", warnings.length, 1);
check(
  "…naming the tag",
  JSON.stringify(warnings[0]).includes("has space"),
  warnings[0],
);
await badStored;
checkEqual(
  "the entry is stored: a HIT",
  (await get(bad, "/bad")).xCache,
  "HIT",
);
checkEqual(
  "no second warning for the same tag on a HIT",
  events.filter((event) => event.level === "warn").length,
  1,
);
await badCache.invalidateTags(["has space"]);
checkEqual(
  "invalidating by the left-out tag still drops the entry",
  (await get(bad, "/bad")).xCache,
  "MISS",
);
checkEqual("the handler ran again", badRuns, 2);

/* ------------------------------------------------------------------ */
step("false (the default) sends nothing");

const offCache = httpCache();
const off = new BunRouter();
off.get(
  "/off",
  cacheResponse(offCache, { ttl: 60_000, surrogateKeys: false }),
  (_req, res) => {
    addCacheTags(res, "post:1");
    res.send("off");
  },
);
const offAnswer = await get(off, "/off");
checkEqual(
  "neither header",
  [offAnswer.surrogate, offAnswer.cacheTag],
  [null, null],
);

/* ------------------------------------------------------------------ */
step("the purge recipe: an invalidate listener (recorded, not sent)");

/** What the README's Fastly listener would POST. */
interface PurgeCall {
  /** The Fastly purge URL path. */
  url: string;
  /** The request headers that matter. */
  softPurge: string | undefined;
  /** The body. */
  body: string;
}
const calls: PurgeCall[] = [];
const purgeCache = createCache({
  driver: memoryDriver(),
  namespace: "cdn",
  softPurge: true,
  ttl: 60_000,
  sweepInterval: 0,
});
purgeCache.on("invalidate", ({ tags, mode }) => {
  const headers: Record<string, string> = {
    "Fastly-Key": "not-a-real-token",
    "Content-Type": "application/json",
    ...(mode === "stale" ? { "Fastly-Soft-Purge": "1" } : {}),
  };
  calls.push({
    url: "https://api.fastly.com/service/SERVICE_ID/purge",
    softPurge: headers["Fastly-Soft-Purge"],
    body: JSON.stringify({ surrogate_keys: tags }),
  });
});
await purgeCache.invalidateTags(["post:7"]);
await purgeCache.invalidateTags(["post:7", "post:8"], { mode: "stale" });
show("calls", calls);
checkEqual("two purges recorded", calls.length, 2);
checkEqual(
  "the hard purge sends no Fastly-Soft-Purge",
  calls[0]?.softPurge,
  undefined,
);
checkEqual(
  "…and names the tags in plain text",
  calls[0]?.body,
  '{"surrogate_keys":["post:7"]}',
);
checkEqual(
  "the soft purge sends Fastly-Soft-Purge: 1",
  calls[1]?.softPurge,
  "1",
);
checkEqual(
  "…with its tags",
  calls[1]?.body,
  '{"surrogate_keys":["post:7","post:8"]}',
);

for (const closing of [
  fastlyCache,
  cfCache,
  mergeCache,
  cfMergeCache,
  badCache,
  offCache,
  purgeCache,
]) {
  await closing.close();
}
summary();
