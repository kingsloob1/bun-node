/**
 * Request coalescing (plan §9.5): inside `cacheResponse()` through the
 * core's single-flight, with hit-for-miss for keys whose answers cannot be
 * stored; and `coalesceRequests()`, the standalone middleware with no store.
 */
import { describe, expect, test } from "bun:test";
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunRouter,
  createDeferred,
} from "@kingsleyweb/bun-common";
import type { CacheEventMap } from "../../lib/index";
import type { CacheResponseOptions } from "../../lib/http/index";
import { cacheResponse, coalesceRequests } from "../../lib/http/index";
import { frameAt, keyFor, makeHttpCache, nextSet } from "./helpers";

/**
 * A router whose `/slow` handler waits on a gate the test opens; `started`
 * resolves on each run. `answer` decides what each run sends.
 */
function gated(
  answer: (res: BunResponse, run: number, req: BunRequest) => void,
  options: CacheResponseOptions = { ttl: 60_000 },
) {
  const cache = makeHttpCache();
  const router = new BunRouter();
  let gate = createDeferred<void>();
  let runs = 0;
  let started = createDeferred<void>();
  router.get("/slow", cacheResponse(cache, options), async (req, res) => {
    runs++;
    const run = runs;
    started.resolve();
    await gate.promise;
    answer(res, run, req);
  });
  return {
    cache,
    router,
    runs: () => runs,
    started: () => started.promise,
    open: () => {
      gate.resolve();
    },
    reset: () => {
      gate = createDeferred<void>();
      started = createDeferred<void>();
    },
  };
}

/** Starts `n` GETs of `/slow` and lets the microtasks run, so all have joined or led. */
async function burst(router: BunRouter, n: number, init: RequestInit = {}) {
  const responses = Array.from({ length: n }, () =>
    router.fetch("/slow", init),
  );
  await Bun.sleep(5);
  return responses;
}

describe("cacheResponse() coalesces identical misses", () => {
  test("ten concurrent misses run the handler once; the rest answer from its entry", async () => {
    const { router, runs, open, started } = gated((res, run) => {
      res.send(`run ${run}`);
    });
    const pending = await burst(router, 10);
    await started();
    expect(runs()).toBe(1);
    open();
    const responses = await Promise.all(pending);
    const bodies = await Promise.all(
      responses.map(async (r) => await r.text()),
    );
    expect(new Set(bodies)).toEqual(new Set(["run 1"]));
    const statuses = responses.map((r) => r.headers.get("x-cache"));
    expect(statuses.filter((s) => s === "MISS")).toHaveLength(1);
    expect(statuses.filter((s) => s === "HIT")).toHaveLength(9);
    expect(runs()).toBe(1);
  });

  test("coalesce: false runs each miss on its own", async () => {
    const { router, runs, open } = gated(
      (res, run) => {
        res.send(`run ${run}`);
      },
      { ttl: 60_000, coalesce: false },
    );
    const pending = await burst(router, 4);
    expect(runs()).toBe(4);
    open();
    await Promise.all(pending);
  });

  test("requests with Authorization (not identity-keyed) are never coalesced", async () => {
    const { router, runs, open } = gated((res) => {
      res.send("x");
    });
    const pending = await burst(router, 3, {
      headers: { authorization: "Bearer a" },
    });
    expect(runs()).toBe(3);
    open();
    await Promise.all(pending);
  });

  test("an invalidation while the leader runs drops its write (the local fence) — followers still get its answer", async () => {
    const { cache, router, open, started } = gated((res) => {
      res.send("pre-invalidation");
    });
    const fenced: CacheEventMap["fenced"][] = [];
    cache.on("fenced", (event) => fenced.push(event));
    const pending = await burst(router, 3);
    await started();
    await cache.invalidateTags([`http:path:/slow`]);
    open();
    const bodies = await Promise.all(
      (await Promise.all(pending)).map(async (r) => await r.text()),
    );
    expect(bodies).toEqual([
      "pre-invalidation",
      "pre-invalidation",
      "pre-invalidation",
    ]);
    await Bun.sleep(5);
    expect(fenced).toHaveLength(1);
    expect(fenced[0].reason).toBe("local");
    expect(await frameAt(cache, keyFor("/slow"))).toBeUndefined();
  });

  test("the core reads ttl and tags when it writes, so the leader's header-derived lifetime lands in the entry", async () => {
    const { cache, router, open } = gated(
      (res) => {
        res.setHeader("Cache-Control", "max-age=42");
        res.send("x");
      },
      { ttl: "headers", tags: ["late"] },
    );
    const before = Date.now();
    const written = nextSet(cache);
    const pending = await burst(router, 1);
    open();
    await Promise.all(pending);
    await written;
    const entry = await cache.getEntry(keyFor("/slow"));
    expect(entry?.freshUntil).toBeGreaterThanOrEqual(before + 42_000);
    expect(entry?.freshUntil).toBeLessThanOrEqual(Date.now() + 42_000);
    expect(entry?.tags).toEqual(["http:path:/slow", "late"]);
  });

  test("followers stop waiting after coalesce.wait and run the handler themselves", async () => {
    const { router, runs, open, started } = gated(
      (res, run) => {
        res.send(`run ${run}`);
      },
      { ttl: 60_000, coalesce: { wait: 30 } },
    );
    const pending = await burst(router, 3);
    await started();
    expect(runs()).toBe(1);
    await Bun.sleep(60);
    expect(runs()).toBe(3);
    open();
    const bodies = await Promise.all(
      (await Promise.all(pending)).map(async (r) => await r.text()),
    );
    expect(new Set(bodies)).toEqual(new Set(["run 1", "run 2", "run 3"]));
  });

  test("a leader answered outside the transforms (an unhandled error) releases its followers after wait", async () => {
    const cache = makeHttpCache();
    const adapter = new BunHttpAdapter(0);
    let runs = 0;
    const gate = createDeferred<void>();
    adapter.get(
      "/err",
      cacheResponse(cache, { ttl: 60_000, coalesce: { wait: 30 } }),
      async (_req, res) => {
        runs++;
        if (runs === 1) {
          await gate.promise;
          throw new Error("unhandled");
        }
        res.send("recovered");
      },
    );
    const first = adapter.fetch("/err");
    await Bun.sleep(5);
    const second = adapter.fetch("/err");
    await Bun.sleep(5);
    gate.resolve();
    expect((await first).status).toBe(500);
    const followed = await second;
    expect(await followed.text()).toBe("recovered");
    expect(runs).toBe(2);
  });
});

describe("hit-for-miss (uncacheableTtl)", () => {
  test("an unstorable leader marks the key; its followers and later misses then run side by side", async () => {
    const { cache, router, runs, open, started, reset } = gated((res, run) => {
      res.setHeader("Cache-Control", "private");
      res.send(`private ${run}`);
    });
    const first = await burst(router, 3);
    await started();
    expect(runs()).toBe(1);
    const marked = nextSet(cache);
    open();
    const bodies = await Promise.all(
      (await Promise.all(first)).map(async (r) => await r.text()),
    );
    // The followers did not get the leader's private answer: they ran.
    expect(new Set(bodies)).toEqual(
      new Set(["private 1", "private 2", "private 3"]),
    );
    await marked;
    expect((await frameAt(cache, keyFor("/slow")))?.kind).toBe("uncacheable");

    reset();
    const later = await burst(router, 3);
    expect(runs()).toBe(6);
    open();
    const answered = await Promise.all(later);
    expect(
      answered.every((r) => r.headers.get("x-cache") === "UNCACHEABLE"),
    ).toBe(true);
  });

  test("a storable answer replaces the marker at once", async () => {
    let cacheable = false;
    const { cache, router, open } = gated(
      (res, run) => {
        res.setHeader("Cache-Control", cacheable ? "max-age=60" : "no-store");
        res.send(`run ${run}`);
      },
      { ttl: "headers" },
    );
    open();
    const marked = nextSet(cache);
    await router.fetch("/slow");
    await marked;
    expect((await frameAt(cache, keyFor("/slow")))?.kind).toBe("uncacheable");
    cacheable = true;
    const stored = nextSet(cache);
    expect((await router.fetch("/slow")).headers.get("x-cache")).toBe("MISS");
    await stored;
    expect((await frameAt(cache, keyFor("/slow")))?.kind).toBe("response");
    const hit = await router.fetch("/slow");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe("run 2");
  });

  test("the marker expires after uncacheableTtl, and coalescing resumes", async () => {
    const { cache, router, open } = gated(
      (res) => {
        res.setHeader("Cache-Control", "no-store");
        res.send("x");
      },
      { ttl: 60_000, uncacheableTtl: 20 },
    );
    open();
    const marked = nextSet(cache);
    await router.fetch("/slow");
    await marked;
    expect((await frameAt(cache, keyFor("/slow")))?.kind).toBe("uncacheable");
    await Bun.sleep(30);
    expect(await frameAt(cache, keyFor("/slow"))).toBeUndefined();
  });
});

describe("coalesceRequests()", () => {
  /** A router with `coalesceRequests(options)` before a gated `/c` handler. */
  function coalesced(
    answer: (res: BunResponse, run: number) => void,
    options?: Parameters<typeof coalesceRequests>[0],
  ) {
    const router = new BunRouter();
    const gate = createDeferred<void>();
    let runs = 0;
    router.get("/c", coalesceRequests(options), async (_req, res) => {
      runs++;
      const run = runs;
      await gate.promise;
      answer(res, run);
    });
    const fire = async (n: number, init: RequestInit = {}) => {
      const pending = Array.from({ length: n }, () => router.fetch("/c", init));
      await Bun.sleep(5);
      return pending;
    };
    return { router, fire, runs: () => runs, open: () => gate.resolve() };
  }

  test("identical in-flight GETs share one run and each get a copy", async () => {
    const { fire, runs, open } = coalesced((res, run) => {
      res.setHeader("X-Run", String(run));
      res.status(201).json({ run });
    });
    const pending = await fire(5);
    expect(runs()).toBe(1);
    open();
    const responses = await Promise.all(pending);
    for (const response of responses) {
      expect(response.status).toBe(201);
      expect(response.headers.get("x-run")).toBe("1");
      expect(response.headers.get("content-type")).toBe(
        "application/json;charset=utf-8",
      );
      expect(await response.json()).toEqual({ run: 1 });
    }
  });

  test("requests with a Cookie or Authorization run on their own, unless a key says otherwise", async () => {
    const plain = coalesced((res) => {
      res.send("x");
    });
    const cookied = await plain.fire(3, { headers: { cookie: "s=1" } });
    expect(plain.runs()).toBe(3);
    plain.open();
    await Promise.all(cookied);

    const keyed = coalesced(
      (res) => {
        res.send("x");
      },
      { key: (req) => `${req.getHeader("cookie")} ${req.originalUrl}` },
    );
    const same = await keyed.fire(3, { headers: { cookie: "s=1" } });
    expect(keyed.runs()).toBe(1);
    keyed.open();
    await Promise.all(same);
  });

  test("an answer that sets a cookie, or is private, is not shared: followers run themselves", async () => {
    for (const unshared of [
      (res: BunResponse) => res.cookie("session", "new"),
      (res: BunResponse) => res.setHeader("Cache-Control", "private"),
    ]) {
      const { fire, runs, open } = coalesced((res, run) => {
        unshared(res);
        res.send(`run ${run}`);
      });
      const pending = await fire(3);
      expect(runs()).toBe(1);
      open();
      const bodies = await Promise.all(
        (await Promise.all(pending)).map(async (r) => await r.text()),
      );
      expect(runs()).toBe(3);
      expect(new Set(bodies)).toEqual(new Set(["run 1", "run 2", "run 3"]));
    }
  });

  test("followers give up after wait", async () => {
    const { fire, runs, open } = coalesced(
      (res, run) => {
        res.send(`run ${run}`);
      },
      { wait: 20 },
    );
    const pending = await fire(2);
    await Bun.sleep(40);
    expect(runs()).toBe(2);
    open();
    await Promise.all(pending);
  });

  test("a bad wait throws when the middleware is built", () => {
    expect(() => coalesceRequests({ wait: -1 })).toThrow(RangeError);
  });
});
