/**
 * The replay header cannot be forged — `x-bun-cache-revalidate` marks the
 * background replay of a stale-while-revalidate refresh, and only the
 * middleware's own replay carries a valid one.
 *
 * ```bash
 * bun 05-http/replay-token.ts
 * ```
 *
 * - A request carrying a made-up `x-bun-cache-revalidate` is an ordinary
 *   request: on a fresh entry it is a `HIT`, on a stale one inside the window
 *   it is `STALE`. It does not make the handler run to answer it.
 * - The header is a per-process random token plus the id of a replay the
 *   middleware is waiting on, used once; a guess has neither.
 */
import type { BunResponse } from "@kingsleyweb/bun-common";
import { BunRouter } from "@kingsleyweb/bun-common";
import { cacheResponse } from "@kingsleyweb/bun-cache/http";
import { checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { httpCache, nextSet } from "../shared/http";

title("bun-cache/http: a forged replay header");

const cache = httpCache();
const router = new BunRouter();
let runs = 0;

router.get(
  "/page",
  cacheResponse(cache, { revalidate: router }),
  (_req: unknown, res: BunResponse) => {
    res.setHeader("Cache-Control", "max-age=1, stale-while-revalidate=60");
    res.send(`page v${++runs}`);
  },
);

/** A forged value: not this process's token. */
const FORGED = { "x-bun-cache-revalidate": "0123456789abcdef.1" };

/** The `X-Cache` and body of the next `GET /page` with `headers`. */
async function get(headers: Record<string, string> = {}) {
  const response = await router.fetch("/page", { headers });
  return {
    xCache: response.headers.get("x-cache"),
    body: await response.text(),
  };
}

/* ------------------------------------------------------------------ */
step("on a fresh entry");

const stored = nextSet(cache);
checkEqual("first request", (await get()).xCache, "MISS");
await stored;

const fresh = await get(FORGED);
show("forged, fresh", fresh);
checkEqual("a HIT, not a forced run", fresh.xCache, "HIT");
checkEqual("the handler ran once", runs, 1);

/* ------------------------------------------------------------------ */
step("on a stale entry inside its window");

await Bun.sleep(1100);

const refreshed = nextSet(cache);
const stale = await get(FORGED);
show("forged, stale", stale);
checkEqual("STALE, like any request", stale.xCache, "STALE");
checkEqual("the old body", stale.body, "page v1");
await refreshed;
checkEqual("one ordinary replay ran the handler", runs, 2);

summary();
await cache.close();
