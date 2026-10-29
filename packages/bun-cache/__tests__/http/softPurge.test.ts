/**
 * A soft purge over HTTP (R21, plan §3.6 and §9.4): after
 * `cache.invalidateTags(tags, { mode: "stale" })` a stored response is no
 * longer fresh, so `cacheResponse()` answers it `STALE` within the stale
 * windows its `Cache-Control` gave it (counted from the purge) — refreshed by
 * the background replay under stale-while-revalidate, or answered in place of
 * a 5xx under stale-if-error — instead of the `MISS` a delete would give.
 * The cache is a plaintext one over the memory driver, so it has
 * `softPurge: true`.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type {
  BunRequest,
  BunResponse,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import { BunRouter } from "@kingsleyweb/bun-common";
import { cacheResponse } from "../../lib/http/index";
import { makeHttpCache, nextSet } from "./helpers";

afterEach(() => {
  setSystemTime();
});

/** 2026-10-29T10:00:00Z, the first request. */
const T0 = Date.parse("2026-10-29T10:00:00Z");

/** Sets the clock to `seconds` after {@link T0}. */
function at(seconds: number): void {
  setSystemTime(new Date(T0 + seconds * 1000));
}

/** A router with `/r` cached under the route tag `posts`, answering `answer` (switchable), 503 on a throw. */
function fixture(cacheControl: string, revalidate: boolean) {
  const cache = makeHttpCache({ softPurge: true });
  const router = new BunRouter();
  let runs = 0;
  let fail = false;
  router.get(
    "/r",
    cacheResponse(cache, {
      tags: ["posts"],
      ...(revalidate ? { revalidate: router } : {}),
    }),
    (_req: BunRequest, res: BunResponse) => {
      runs++;
      if (fail) {
        throw new Error("origin down");
      }
      res.setHeader("Cache-Control", cacheControl);
      res.send(`body ${runs}`);
    },
  );
  router.use(((_err, _req, res, _next) => {
    res.status(503).send("down");
  }) satisfies RouterErrorMiddlewareHandler);
  return {
    cache,
    router,
    runs: () => runs,
    failing: () => {
      fail = true;
    },
  };
}

/** Stores `/r` at {@link T0}, then soft-purges `posts` a second later. */
async function primeAndPurge(f: ReturnType<typeof fixture>): Promise<void> {
  at(0);
  const written = nextSet(f.cache);
  expect((await f.router.fetch("/r")).headers.get("x-cache")).toBe("MISS");
  await written;
  at(1);
  expect((await f.router.fetch("/r")).headers.get("x-cache")).toBe("HIT");
  await f.cache.invalidateTags(["posts"], { mode: "stale" });
  at(2);
}

describe("soft purge over HTTP", () => {
  test("stale-while-revalidate: answered STALE at once, and the replay refreshes it", async () => {
    const f = fixture("max-age=60, stale-while-revalidate=60", true);
    await primeAndPurge(f);
    const refreshed = nextSet(f.cache);
    const stale = await f.router.fetch("/r");
    expect(stale.headers.get("x-cache")).toBe("STALE");
    expect(await stale.text()).toBe("body 1");
    await refreshed;
    expect(f.runs()).toBe(2);
    const hit = await f.router.fetch("/r");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe("body 2");
  });

  test("stale-if-error: a 5xx after the purge is answered with the stale response", async () => {
    const f = fixture("max-age=60, stale-if-error=600", false);
    await primeAndPurge(f);
    f.failing();
    const stale = await f.router.fetch("/r");
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-cache")).toBe("STALE");
    expect(await stale.text()).toBe("body 1");
    expect(f.runs()).toBe(2);
  });

  test("with no stale window it is a miss that runs the handler", async () => {
    const f = fixture("max-age=60", false);
    await primeAndPurge(f);
    const miss = await f.router.fetch("/r");
    expect(miss.headers.get("x-cache")).toBe("MISS");
    expect(await miss.text()).toBe("body 2");
  });

  test("the control: a delete-mode invalidation is a MISS, not STALE", async () => {
    const f = fixture("max-age=60, stale-while-revalidate=60", true);
    at(0);
    const written = nextSet(f.cache);
    await f.router.fetch("/r");
    await written;
    at(1);
    await f.cache.invalidateTags(["posts"]);
    at(2);
    expect((await f.router.fetch("/r")).headers.get("x-cache")).toBe("MISS");
  });
});
