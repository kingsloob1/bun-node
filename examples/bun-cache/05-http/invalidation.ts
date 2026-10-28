/**
 * Invalidation — three ways to drop a cached page: a tag the handler added
 * (`addCacheTags` + `cache.invalidateTags`), an unsafe request through the
 * middleware, and `pages.invalidate(path)`.
 *
 * ```bash
 * bun 05-http/invalidation.ts
 * ```
 *
 * - Every entry carries its path's tag, so a path drops with all its queries.
 * - A `POST`/`PUT`/`PATCH`/`DELETE` with a 2xx/3xx answer drops its path; a
 *   4xx or 5xx one does not.
 * - The core's fence drops a write whose load started in the same
 *   millisecond as an invalidation, so each step sleeps 2 ms before the next
 *   load — a real server's requests are never that close together.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import { addCacheTags, cacheResponse } from "@kingsleyweb/bun-cache/http";
import { checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";
import { httpCache, nextSet } from "../shared/http";

title("bun-cache/http: three ways to invalidate");

const cache = httpCache();
const router = new BunRouter();
const pages = cacheResponse(cache, { ttl: 60_000 });
let runs = 0;

router.get("/posts/:id", pages, (req, res) => {
  runs++;
  const id = String(req.params.id);
  addCacheTags(res, `post:${id}`);
  res.send(`post ${id}, run ${runs}`);
});
router.post("/posts/:id", pages, (_req, res) => {
  res.status(201).send("saved");
});
router.put("/posts/:id", pages, (_req, res) => {
  res.status(422).send("invalid");
});

/** The `X-Cache` value of the next `GET /posts/1`. */
async function get(): Promise<string | null> {
  return (await router.fetch("/posts/1")).headers.get("x-cache");
}

/** Loads `/posts/1` until it is stored, and answers once it is a HIT. */
async function warm(): Promise<void> {
  const written = nextSet(cache);
  await get();
  await written;
  checkEqual("  warmed: the next GET is a HIT", await get(), "HIT");
}

/* ------------------------------------------------------------------ */
step("a tag the handler added");

await warm();
await cache.invalidateTags(["post:1"]);
await Bun.sleep(2);
checkEqual("after invalidateTags(['post:1'])", await get(), "MISS");

/* ------------------------------------------------------------------ */
step("an unsafe request through the middleware");

await warm();
checkEqual(
  "a failing PUT (422) answers",
  (await router.fetch("/posts/1", { method: "PUT" })).status,
  422,
);
await Bun.sleep(2);
checkEqual("…and leaves the entry alone", await get(), "HIT");
checkEqual(
  "a POST (201) answers",
  (await router.fetch("/posts/1", { method: "POST" })).status,
  201,
);
await Bun.sleep(2);
checkEqual("…and drops it", await get(), "MISS");

/* ------------------------------------------------------------------ */
step("pages.invalidate(path)");

await warm();
await pages.invalidate("/posts/1");
await Bun.sleep(2);
checkEqual("after pages.invalidate('/posts/1')", await get(), "MISS");

summary();
await cache.close();
