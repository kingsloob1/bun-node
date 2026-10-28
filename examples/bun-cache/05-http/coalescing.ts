/**
 * Coalescing inside `cacheResponse()` — a burst of identical misses runs the
 * handler once; the rest wait for the leader and answer from its result.
 *
 * ```bash
 * bun 05-http/coalescing.ts
 * ```
 *
 * - Ten concurrent GETs of a slow handler: one `MISS` (the leader), nine
 *   `HIT`s (the followers).
 * - When the leader's answer may not be stored (`private` here) the key is
 *   marked uncacheable, and the burst runs side by side — each answer is
 *   `UNCACHEABLE`, as it would be with no coalescing at all.
 */
import { BunRouter, cacheControl } from "@kingsleyweb/bun-common";
import { cacheResponse } from "@kingsleyweb/bun-cache/http";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { httpCache } from "../shared/http";

title("bun-cache/http: a burst of ten");

const cache = httpCache();
const router = new BunRouter();
const pages = cacheResponse(cache, { ttl: 60_000 });
const runs = { slow: 0, secret: 0 };

router.get("/slow", pages, async (_req, res) => {
  runs.slow++;
  await Bun.sleep(100);
  res.send("slow answer");
});
router.get(
  "/secret",
  pages,
  cacheControl({ private: true }),
  async (_req, res) => {
    runs.secret++;
    await Bun.sleep(50);
    res.send("secret answer");
  },
);

/** Ten concurrent GETs of `path`: each one's `X-Cache` and body. */
async function burst(path: string): Promise<[string | null, string][]> {
  return await Promise.all(
    Array.from({ length: 10 }, async () => {
      const response = await router.fetch(path);
      return [response.headers.get("x-cache"), await response.text()] as [
        string | null,
        string,
      ];
    }),
  );
}

/** How many of `results` carry `X-Cache: status`. */
function count(results: [string | null, string][], status: string): number {
  return results.filter(([x]) => x === status).length;
}

/* ------------------------------------------------------------------ */
step("a storable answer: one run, one MISS, nine HITs");

const slow = await burst("/slow");
show("statuses", slow.map(([x]) => x).join(" "));
checkEqual("the handler ran once", runs.slow, 1);
checkEqual("one MISS (the leader)", count(slow, "MISS"), 1);
checkEqual("nine HITs (the followers)", count(slow, "HIT"), 9);
check(
  "everyone got the leader's body",
  slow.every(([, body]) => body === "slow answer"),
);

/* ------------------------------------------------------------------ */
step("a private answer: side by side, all UNCACHEABLE");

const secret = await burst("/secret");
show("statuses", secret.map(([x]) => x).join(" "));
checkEqual("the handler ran ten times", runs.secret, 10);
checkEqual("all ten UNCACHEABLE", count(secret, "UNCACHEABLE"), 10);
check(
  "each got its own body",
  secret.every(([, body]) => body === "secret answer"),
);

summary();
await cache.close();
