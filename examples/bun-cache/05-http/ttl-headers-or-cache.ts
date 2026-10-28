/**
 * `ttl: "headers-or-cache"` — the response's own lifetime when it has one,
 * else the cache's own `ttl` (`createCache({ ttl })`).
 *
 * ```bash
 * bun 05-http/ttl-headers-or-cache.ts
 * ```
 *
 * - With the default `ttl: "headers"` a response with no `Cache-Control` is
 *   `UNCACHEABLE` (see `ttl-from-headers.ts`). With `"headers-or-cache"` it
 *   is stored, and goes stale when the cache's `ttl` (here 300 ms) says so.
 * - A response with `max-age` keeps its own lifetime: the cache's `ttl` does
 *   not shorten it.
 * - `private` is still not stored, whatever the fallback.
 */
import { BunRouter, cacheControl } from "@kingsleyweb/bun-common";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { cacheResponse } from "@kingsleyweb/bun-cache/http";
import { checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";
import { nextSet } from "../shared/http";

title('bun-cache/http: ttl: "headers-or-cache"');

const cache = createCache({
  driver: memoryDriver(),
  namespace: "http",
  sweepInterval: 0,
  ttl: 300,
});
const router = new BunRouter();
const pages = cacheResponse(cache, { ttl: "headers-or-cache" });
const runs = { bare: 0, declared: 0, secret: 0 };

router.get("/bare", pages, (_req, res) => {
  runs.bare++;
  res.send("bare");
});
router.get("/declared", pages, cacheControl({ maxAge: 60 }), (_req, res) => {
  runs.declared++;
  res.send("declared");
});
router.get(
  "/secret",
  pages,
  cacheControl({ private: true, maxAge: 60 }),
  (_req, res) => {
    runs.secret++;
    res.send("secret");
  },
);

/** The `X-Cache` value of the next `GET path`. */
async function status(path: string): Promise<string | null> {
  return (await router.fetch(path)).headers.get("x-cache");
}

/* ------------------------------------------------------------------ */
step("no Cache-Control: stored under the cache's ttl (300 ms)");

let written = nextSet(cache);
checkEqual("first /bare", await status("/bare"), "MISS");
await written;
checkEqual("second /bare", await status("/bare"), "HIT");
checkEqual("the handler ran once", runs.bare, 1);

/* ------------------------------------------------------------------ */
step("max-age=60: the response's own lifetime");

written = nextSet(cache);
checkEqual("first /declared", await status("/declared"), "MISS");
await written;
checkEqual("second /declared", await status("/declared"), "HIT");

/* ------------------------------------------------------------------ */
step("private: not stored, whatever the cache's ttl");

checkEqual("first /secret", await status("/secret"), "UNCACHEABLE");
checkEqual("second /secret", await status("/secret"), "UNCACHEABLE");
checkEqual("the handler ran every time", runs.secret, 2);

/* ------------------------------------------------------------------ */
step("after the cache's ttl: the bare one is gone, max-age=60 is not");

await Bun.sleep(400);
written = nextSet(cache);
checkEqual("/bare after 400 ms", await status("/bare"), "MISS");
await written;
checkEqual("/declared after 400 ms", await status("/declared"), "HIT");
checkEqual("/bare ran again", runs.bare, 2);
checkEqual("/declared did not", runs.declared, 1);

summary();
await cache.close();
