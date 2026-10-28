/**
 * Stale-while-revalidate over HTTP — an entry past its freshness is answered
 * at once, and one background replay refreshes it.
 *
 * ```bash
 * bun 05-http/stale-while-revalidate.ts
 * ```
 *
 * - The handler says `max-age=1, stale-while-revalidate=60`. After the first
 *   second the next request is `STALE`: the old body, with its `Age`, and no
 *   waiting for the handler.
 * - `revalidate: router` names what the refresh replays the request through
 *   (the outermost router or adapter, here the router itself, socket-free).
 *   The replay runs the handler once and stores its answer; the request after
 *   it is a `HIT` with the new body.
 * - Ten concurrent stale requests are all `STALE` and start one replay.
 * - Without `revalidate` a stale entry is answered once; the request after it
 *   refreshes the entry itself, as a `MISS` that waits for the handler.
 */
import type { BunResponse } from "@kingsleyweb/bun-common";
import { BunRouter } from "@kingsleyweb/bun-common";
import { cacheResponse } from "@kingsleyweb/bun-cache/http";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { httpCache, nextSet } from "../shared/http";

title("bun-cache/http: stale-while-revalidate");

const cache = httpCache();
const router = new BunRouter();
const runs = { page: 0, plain: 0 };

/** The handler: fresh for a second, then stale-while-revalidate for a minute. */
function page(counter: "page" | "plain") {
  return async (_req: unknown, res: BunResponse) => {
    const run = ++runs[counter];
    await Bun.sleep(20);
    res.setHeader("Cache-Control", "max-age=1, stale-while-revalidate=60");
    res.send(`${counter} v${run}`);
  };
}

router.get("/page", cacheResponse(cache, { revalidate: router }), page("page"));
router.get("/plain", cacheResponse(cache), page("plain"));

/** The answer to the next `GET path`: its `X-Cache`, `Age` and body. */
async function get(path: string) {
  const response = await router.fetch(path);
  return {
    xCache: response.headers.get("x-cache"),
    age: response.headers.get("age"),
    body: await response.text(),
  };
}

/** Waits until an entry stored a moment ago is no longer fresh. */
async function pastFreshness(): Promise<void> {
  await Bun.sleep(1100);
}

/* ------------------------------------------------------------------ */
step("a miss, then a stale answer, then a hit with the new body");

const stored = nextSet(cache);
const first = await get("/page");
show("first", first);
checkEqual("the first request is a MISS", first.xCache, "MISS");
checkEqual("it ran the handler", first.body, "page v1");
await stored;

await pastFreshness();

const refreshed = nextSet(cache);
const stale = await get("/page");
show("stale", stale);
checkEqual("past max-age the answer is STALE", stale.xCache, "STALE");
checkEqual("with the old body", stale.body, "page v1");
check("and an Age past the freshness", Number(stale.age) >= 1, stale.age);
await refreshed;

const hit = await get("/page");
show("after the replay", hit);
checkEqual("the replay's entry is a HIT", hit.xCache, "HIT");
checkEqual("with the new body", hit.body, "page v2");
checkEqual("the handler ran twice in all", runs.page, 2);

/* ------------------------------------------------------------------ */
step("ten stale requests start one replay");

await pastFreshness();

const again = nextSet(cache);
const burst = await Promise.all(
  Array.from({ length: 10 }, async () => await get("/page")),
);
check(
  "all ten are STALE",
  burst.every((answer) => answer.xCache === "STALE"),
  burst.map((answer) => answer.xCache),
);
await again;
checkEqual("one replay ran the handler", runs.page, 3);
checkEqual("the next request is a HIT", (await get("/page")).xCache, "HIT");

/* ------------------------------------------------------------------ */
step("without revalidate: stale once, then a refreshing miss");

const plainStored = nextSet(cache);
checkEqual("first /plain", (await get("/plain")).xCache, "MISS");
await plainStored;

await pastFreshness();

const served = await get("/plain");
checkEqual("the first stale request is STALE", served.xCache, "STALE");
checkEqual("with the old body", served.body, "plain v1");
checkEqual("no replay ran", runs.plain, 1);

const next = await get("/plain");
checkEqual("the next one refreshes it, as a MISS", next.xCache, "MISS");
checkEqual("waiting for the handler", next.body, "plain v2");
await waitFor("the refreshed entry to be stored", async () => {
  return (await get("/plain")).xCache === "HIT";
});

summary();
await cache.close();
