/**
 * HTTP basics — `cacheResponse()` on a `BunRouter`: a miss runs the handler
 * and stores its answer, a hit answers from the cache without calling it.
 *
 * ```bash
 * bun 05-http/basics.ts
 * ```
 *
 * - `X-Cache` says `MISS` or `HIT`; a hit also carries `Age`.
 * - The write never delays the response, so the example awaits the cache's
 *   `set` event before asking again.
 * - Every stored response has an `ETag`, so a conditional request gets a 304.
 * - HEAD is answered from the GET entry and never stores one.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import { cacheResponse } from "@kingsleyweb/bun-cache/http";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { httpCache, nextSet } from "../shared/http";

title("bun-cache/http basics: miss, hit, 304, HEAD");

const cache = httpCache();
const router = new BunRouter();
let runs = 0;

router.get("/page", cacheResponse(cache, { ttl: 60_000 }), (_req, res) => {
  runs++;
  res.send(`page, run ${runs}`);
});

/* ------------------------------------------------------------------ */
step("a miss, then a hit");

const written = nextSet(cache);
const first = await router.fetch("/page");
show("first", [first.status, first.headers.get("x-cache")]);
checkEqual("the first request is a MISS", first.headers.get("x-cache"), "MISS");
checkEqual("…with the handler's body", await first.text(), "page, run 1");
await written;

const second = await router.fetch("/page");
show("second", [second.status, second.headers.get("x-cache")]);
checkEqual("the second request is a HIT", second.headers.get("x-cache"), "HIT");
checkEqual("…with the same body", await second.text(), "page, run 1");
check("…and an Age header", second.headers.get("age") !== null, {
  age: second.headers.get("age"),
});
checkEqual("the handler ran once", runs, 1);

/* ------------------------------------------------------------------ */
step("a conditional request");

const etag = second.headers.get("etag");
check("the hit carries an ETag (computed from the body)", etag !== null);
const conditional = await router.fetch("/page", {
  headers: { "if-none-match": etag ?? "" },
});
checkEqual("If-None-Match with that ETag gets 304", conditional.status, 304);
checkEqual("…with no body", await conditional.text(), "");
checkEqual("the handler still ran once", runs, 1);

/* ------------------------------------------------------------------ */
step("HEAD");

const head = await router.fetch("/page", { method: "HEAD" });
checkEqual("HEAD reads the GET entry", head.headers.get("x-cache"), "HIT");
checkEqual("…without a body", await head.text(), "");

const fresh = httpCache();
const freshRouter = new BunRouter();
let freshRuns = 0;
freshRouter.get("/page", cacheResponse(fresh, { ttl: 60_000 }), (_req, res) => {
  freshRuns++;
  res.send("x");
});
let stored = 0;
fresh.on("set", () => stored++);
await freshRouter.fetch("/page", { method: "HEAD" });
await Bun.sleep(20);
checkEqual("a HEAD miss runs the GET handler", freshRuns, 1);
checkEqual("…and stores nothing", stored, 0);

summary();
await cache.close();
await fresh.close();
