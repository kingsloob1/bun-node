/**
 * `Vary` — a handler that answers differently per `Accept-Language` and says
 * so; the cache learns the header per URL and keeps one entry per value.
 *
 * ```bash
 * bun 05-http/vary.ts
 * ```
 *
 * - No configuration: the response's own `Vary` is the instruction.
 * - Each language misses once, then hits, and gets its own body.
 * - `Vary: *` is never stored.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import { cacheResponse } from "@kingsleyweb/bun-cache/http";
import { checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { httpCache, nextSet } from "../shared/http";

title("bun-cache/http: Vary: Accept-Language");

const cache = httpCache();
const router = new BunRouter();
const runs = { greeting: 0, star: 0 };

router.get("/greeting", cacheResponse(cache, { ttl: 60_000 }), (req, res) => {
  runs.greeting++;
  res.set("Vary", "Accept-Language");
  res.send(req.get("accept-language") === "fr" ? "bonjour" : "hello");
});
router.get("/star", cacheResponse(cache, { ttl: 60_000 }), (_req, res) => {
  runs.star++;
  res.set("Vary", "*");
  res.send("anything");
});

/** One `GET /greeting` in `language`: its `X-Cache` and its body. */
async function greet(language: string): Promise<[string | null, string]> {
  const response = await router.fetch("/greeting", {
    headers: { "accept-language": language },
  });
  return [response.headers.get("x-cache"), await response.text()];
}

/* ------------------------------------------------------------------ */
step("each language misses once, then hits");

let written = nextSet(cache);
checkEqual("en, first", await greet("en"), ["MISS", "hello"]);
await written;
written = nextSet(cache);
checkEqual("fr, first", await greet("fr"), ["MISS", "bonjour"]);
await written;
checkEqual("en, again", await greet("en"), ["HIT", "hello"]);
checkEqual("fr, again", await greet("fr"), ["HIT", "bonjour"]);
checkEqual("the handler ran twice: once per language", runs.greeting, 2);
show("Vary on a hit", (await router.fetch("/greeting")).headers.get("vary"));

/* ------------------------------------------------------------------ */
step("Vary: * is never stored");

const a = await router.fetch("/star");
const b = await router.fetch("/star");
checkEqual("first", a.headers.get("x-cache"), "UNCACHEABLE");
checkEqual("second", b.headers.get("x-cache"), "UNCACHEABLE");
checkEqual("the handler ran every time", runs.star, 2);

summary();
await cache.close();
