/**
 * Stale-if-error over HTTP — when the handler fails, a stale entry is
 * answered in its place.
 *
 * ```bash
 * bun 05-http/stale-if-error.ts
 * ```
 *
 * - `/report` is cached with `max-age=1`; `staleIfError` gives the entry a
 *   window past that. Once the handler starts failing (it throws, and an
 *   error handler answers 503), a request past freshness gets the old body
 *   with `200` and `X-Cache: STALE`. The entry is kept, so the next one is
 *   answered stale too.
 * - Past the window the entry is gone: the 503 goes through.
 * - `hardTimeout` counts a slow handler as a failure: `/slow` answers stale
 *   long before its handler would have.
 * - An unhandled error (no error handler) is answered outside the pipeline
 *   and is never rescued; the error handler here is what makes the 503 an
 *   answer the cache can see.
 */
import type {
  BunResponse,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import { BunRouter } from "@kingsleyweb/bun-common";
import { cacheResponse } from "@kingsleyweb/bun-cache/http";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { httpCache, nextSet } from "../shared/http";

title("bun-cache/http: stale-if-error");

const cache = httpCache();
const router = new BunRouter();
const origin = { failing: false, slow: false };

/** How many answers each route has sent, to tell one body from the next. */
const sent = { report: 0, slow: 0 };

/** A handler fresh for a second that fails or stalls when the origin does. */
function report(name: "report" | "slow") {
  return async (_req: unknown, res: BunResponse) => {
    if (origin.failing) {
      throw new Error("the origin is down");
    }

    if (origin.slow) {
      await Bun.sleep(500);
    }

    res.setHeader("Cache-Control", "max-age=1");
    res.send(`${name} v${++sent[name]}`);
  };
}

// A window of 1.5 s past freshness, so the example can also leave it.
router.get(
  "/report",
  cacheResponse(cache, { staleIfError: 1500 }),
  report("report"),
);
router.get(
  "/slow",
  cacheResponse(cache, { staleIfError: 60_000, hardTimeout: 50 }),
  report("slow"),
);
router.use(((_err, _req, res, _next) => {
  res.status(503).send("unavailable");
}) satisfies RouterErrorMiddlewareHandler);

/** The answer to the next `GET path`. */
async function get(path: string) {
  const response = await router.fetch(path);
  return {
    status: response.status,
    xCache: response.headers.get("x-cache"),
    body: await response.text(),
  };
}

/* ------------------------------------------------------------------ */
step("the origin goes down, past freshness");

const stored = nextSet(cache);
const ok = await get("/report");
show("healthy", ok);
checkEqual("healthy: a MISS", ok.xCache, "MISS");
await stored;

origin.failing = true;
await Bun.sleep(1100);

const rescued = await get("/report");
show("origin down", rescued);
checkEqual("the client still gets a 200", rescued.status, 200);
checkEqual("STALE", rescued.xCache, "STALE");
checkEqual("with the old body", rescued.body, "report v1");

const again = await get("/report");
checkEqual("the entry was kept: STALE again", again.xCache, "STALE");

/* ------------------------------------------------------------------ */
step("past the stale-if-error window");

// 1 s of freshness plus 1.5 s: the entry is gone by now.
await waitFor("the entry to leave its window", async () => {
  return (await get("/report")).status === 503;
});
const gone = await get("/report");
show("after the window", gone);
checkEqual("the 503 goes through", gone.status, 503);
check("not stale", gone.xCache !== "STALE", gone.xCache);

/* ------------------------------------------------------------------ */
step("hardTimeout: a slow handler is a failure too");

const slowStored = nextSet(cache);
origin.failing = false;
checkEqual("first /slow", (await get("/slow")).xCache, "MISS");
await slowStored;

origin.slow = true;
await Bun.sleep(1100);

const started = performance.now();
const slow = await get("/slow");
const took = performance.now() - started;
show("slow handler", { ...slow, took: Math.round(took) });
checkEqual("answered STALE", slow.xCache, "STALE");
checkEqual("with the old body", slow.body, "slow v1");
check("well before the handler's 500 ms", took < 400, took);

summary();
await cache.close();
