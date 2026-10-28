/**
 * Lifetime from the response's own headers — `cacheResponse(cache)` with the
 * default `ttl: "headers"` stores what the handler says may be stored, for as
 * long as it says.
 *
 * ```bash
 * bun 05-http/ttl-from-headers.ts
 * ```
 *
 * - `cacheControl({ sMaxAge: 60 })` (seconds) after the cache gives a
 *   lifetime: the answer is stored.
 * - No `Cache-Control` means no lifetime: `UNCACHEABLE`, run every time.
 * - `private` is refused for a shared cache, whatever the `max-age`.
 * - Order matters: a header a middleware *ahead* of the cache set is not
 *   stored, so `cacheControl()` goes between the cache and the handler.
 */
import { BunRouter, cacheControl } from "@kingsleyweb/bun-common";
import { cacheResponse } from "@kingsleyweb/bun-cache/http";
import { checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";
import { httpCache, nextSet } from "../shared/http";

title("bun-cache/http: the lifetime comes from Cache-Control");

const cache = httpCache();
const router = new BunRouter();
const pages = cacheResponse(cache);
const runs = { shared: 0, bare: 0, secret: 0 };

router.get("/shared", pages, cacheControl({ sMaxAge: 60 }), (_req, res) => {
  runs.shared++;
  res.send("shared");
});
router.get("/bare", pages, (_req, res) => {
  runs.bare++;
  res.send("bare");
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
step("s-maxage=60: stored");

const written = nextSet(cache);
checkEqual("first /shared", await status("/shared"), "MISS");
await written;
checkEqual("second /shared", await status("/shared"), "HIT");
checkEqual("the handler ran once", runs.shared, 1);

/* ------------------------------------------------------------------ */
step("no Cache-Control: no lifetime");

checkEqual("first /bare", await status("/bare"), "UNCACHEABLE");
checkEqual("second /bare", await status("/bare"), "UNCACHEABLE");
checkEqual("the handler ran every time", runs.bare, 2);

/* ------------------------------------------------------------------ */
step("private, max-age=60: not for a shared cache");

checkEqual("first /secret", await status("/secret"), "UNCACHEABLE");
checkEqual("second /secret", await status("/secret"), "UNCACHEABLE");
checkEqual("the handler ran every time", runs.secret, 2);

summary();
await cache.close();
