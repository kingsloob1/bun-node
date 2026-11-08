/**
 * `throttle()`, `skipThrottle()`, the router/adapter `throttle` option, the
 * memory store and the documents (`listRoutes`' `throttle`, the OpenAPI
 * `429` and `x-bun-throttle`). Every count runs on a fake clock, aligned to
 * a window boundary at {@link T0}, so window edges are exact.
 */
import { describe, expect, it } from "bun:test";
import type {
  ThrottleLimitedInfo,
  ThrottleOptions,
  ThrottleResult,
} from "../lib/throttle";
import type { ThrottleStore } from "../lib/throttleStore";
import type {
  RouterErrorMiddlewareHandler,
  RouterHandler,
} from "../lib/types/general";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunResponse } from "../lib/BunResponse";
import { BunRouter, RequestPipelineOptions } from "../lib/BunRouter";
import { generateOpenApi } from "../lib/docs";
import { ConfigError } from "../lib/errors";
import { createTestLogger } from "../lib/logging";
import { listRoutes } from "../lib/routeModel";
import {
  defaultThrottleKey,
  getThrottleResults,
  sendTooManyRequests,
  skipThrottle,
  slidingWindowResult,
  throttle,
  throttleAddressKey,
  ThrottleStoreError,
} from "../lib/throttle";
import { memoryThrottleStore } from "../lib/throttleStore";
import { parseDuration, toDurationMs } from "../lib/utils/duration";
import { makeRequest } from "./helpers";

/** A minute-aligned instant: window index boundaries fall on whole minutes from here. */
const T0 = 60_000 * 29_000_000;

/** A controllable clock. */
function clock(start = T0): {
  now: () => number;
  set: (t: number) => void;
  advance: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    set: (value) => {
      t = value;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

const ok: RouterHandler = (_req, res) => {
  res.send("ok");
};

/** Requests `path` `n` times, answering each status. */
async function statuses(
  router: BunRouter,
  path: string,
  n: number,
  init?: RequestInit,
): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push((await router.fetch(path, init)).status);
  }
  return out;
}

/** A router keyed on the `x-client` header, so tests choose the client. */
/**
 * Options keyed on the `x-client` header, so tests choose the client, with
 * the IETF headers on (off by default) unless the test says otherwise.
 */
function byHeader(options: Omit<ThrottleOptions, "key">): ThrottleOptions {
  return {
    headers: "ietf",
    ...options,
    key: (req) => req.get("x-client") ?? "anon",
  };
}

describe("durations", () => {
  it("reads the bun-jobs grammar", () => {
    expect(parseDuration("1m")).toBe(60_000);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("1h 30m")).toBe(5_400_000);
    expect(parseDuration("2 days")).toBe(172_800_000);
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("500")).toBeNull();
    expect(parseDuration("2 days after friday")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });

  it("reads an object with its units spelled out", () => {
    expect(toDurationMs({ seconds: 30 }, "w")).toBe(30_000);
    expect(toDurationMs({ minutes: 1, seconds: 30 }, "w")).toBe(90_000);
    expect(toDurationMs({ ms: 250 }, "w")).toBe(250);
    expect(toDurationMs({ hours: 1, days: 1, weeks: 1 }, "w")).toBe(
      3_600_000 + 86_400_000 + 604_800_000,
    );
  });

  it("refuses a bare number, at run time as at the type level", () => {
    // @ts-expect-error a bare number has no unit
    expect(() => toDurationMs(60, "throttle(): window")).toThrow(
      /bare number is ambiguous.*"60s"/,
    );
    // @ts-expect-error a bare number has no unit
    expect(() => throttle({ limit: 1, window: 60_000 })).toThrow(ConfigError);
  });

  it("refuses anything that is not a positive duration", () => {
    expect(toDurationMs("1s", "w")).toBe(1000);
    const bad: unknown[] = [
      "soon",
      "0s",
      "",
      {},
      { seconds: -1 },
      { seconds: 0 },
      { fortnights: 1 },
      { seconds: "30" },
      null,
    ];
    for (const value of bad) {
      expect(() => toDurationMs(value as string, "throttle: window")).toThrow(
        ConfigError,
      );
    }
  });
});

describe("memoryThrottleStore", () => {
  it("increments, sets the lifetime on creation only, and expires", () => {
    const time = clock();
    const store = memoryThrottleStore({ now: time.now });
    expect(store.increment("k", 1, 1000)).toBe(1);
    time.advance(900);
    expect(store.increment("k", 2, 1000)).toBe(3);
    expect(store.get("k")).toBe(3);
    // The second increment did not extend it: it ends 1000 ms after creation.
    time.advance(100);
    expect(store.get("k")).toBeUndefined();
    expect(store.increment("k", 1, 1000)).toBe(1);
  });

  it("stays within maxKeys however many keys a client invents", () => {
    const time = clock();
    const store = memoryThrottleStore({ maxKeys: 50, now: time.now });
    for (let i = 0; i < 10_000; i++) {
      store.increment(`rotating-${i}`, 1, 60_000);
      expect(store.size).toBeLessThanOrEqual(50);
    }
    expect(store.size).toBe(50);
    // The newest survive; the oldest went.
    expect(store.get("rotating-9999")).toBe(1);
    expect(store.get("rotating-0")).toBeUndefined();
  });

  it("drops expired counters as it inserts", () => {
    const time = clock();
    const store = memoryThrottleStore({ now: time.now });
    for (let i = 0; i < 10; i++) store.increment(`old-${i}`, 1, 100);
    time.advance(200);
    for (let i = 0; i < 10; i++) store.increment(`new-${i}`, 1, 100);
    expect(store.size).toBe(10);
  });

  it("refuses a bad maxKeys", () => {
    expect(() => memoryThrottleStore({ maxKeys: 0 })).toThrow(ConfigError);
    expect(() => memoryThrottleStore({ maxKeys: 1.5 })).toThrow(ConfigError);
  });

  it("runs GCRA: a full bucket, then one token per interval", () => {
    const store = memoryThrottleStore();
    const step = (now: number, cost = 1): boolean =>
      store.consumeGcra("g", { limit: 4, window: 1000, cost, now }).allowed;
    // Four at once (the bucket), the fifth refused.
    expect([step(T0), step(T0), step(T0), step(T0), step(T0)]).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    // One token back every 250 ms.
    expect(step(T0 + 249)).toBe(false);
    expect(step(T0 + 250)).toBe(true);
    expect(step(T0 + 250)).toBe(false);
    const refused = store.consumeGcra("g", {
      limit: 4,
      window: 1000,
      cost: 1,
      now: T0 + 300,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBe(200);
    // A cost larger than the bucket never fits.
    expect(
      store.consumeGcra("h", { limit: 4, window: 1000, cost: 5, now: T0 })
        .allowed,
    ).toBe(false);
  });
});

describe("sliding-window arithmetic", () => {
  const base = { limit: 10, window: 60_000, cost: 1 };

  it("weights the previous window by its overlap", () => {
    // 15 s into the window: 75% of the previous window still counts.
    const r = slidingWindowResult({
      ...base,
      elapsed: 15_000,
      current: 3,
      previous: 8,
    });
    expect(r.used).toBe(9); // 8 × 0.75 + 3
    expect(r.remaining).toBe(1);
    expect(r.limited).toBe(false);
    expect(r.resetAfter).toBe(45_000);
  });

  it("says when a refused request would fit in this window", () => {
    // 6 + 5 = 11 > 10; with a cost of 1, 8 × (45 s − τ)/60 s ≤ 10 − 5 − 1 → τ = 15 s.
    const r = slidingWindowResult({
      ...base,
      elapsed: 15_000,
      current: 5,
      previous: 8,
    });
    expect(r.limited).toBe(true);
    expect(r.retryAfter).toBe(15_000);
    // Check it: 15 s later, the estimate plus one more request is exactly the limit.
    expect((8 * (60_000 - 30_000)) / 60_000 + 5 + 1).toBe(10);
  });

  it("says when it would fit in the next window", () => {
    // 12 in this window: 15 s left, then 12 × (60 − t)/60 + 1 ≤ 10 → t = 15 s.
    const r = slidingWindowResult({
      ...base,
      elapsed: 45_000,
      current: 12,
      previous: 0,
    });
    expect(r.retryAfter).toBe(30_000);
  });

  it("is exact at the window's first millisecond", () => {
    const r = slidingWindowResult({
      ...base,
      elapsed: 0,
      current: 1,
      previous: 10,
    });
    expect(r.used).toBe(11);
    expect(r.limited).toBe(true);
  });
});

describe("throttle(): counting", () => {
  it("sliding window: refuses past the limit, and slides at the boundary", async () => {
    const time = clock();
    const router = new BunRouter({
      throttle: byHeader({ limit: 4, window: "1m", now: time.now }),
    });
    router.get("/x", ok);
    time.set(T0 + 30_000);
    expect(await statuses(router, "/x", 5)).toEqual([200, 200, 200, 200, 429]);
    // The next window's first moment: the previous 5 still weigh in fully.
    time.set(T0 + 60_000);
    expect(await statuses(router, "/x", 1)).toEqual([429]);
    // 45 s in: the previous window's 5 weigh 0.25 (1.25), plus this
    // window's 1 refused request: 3.25 with the next, then 4.25.
    time.set(T0 + 105_000);
    expect(await statuses(router, "/x", 2)).toEqual([200, 429]);
  });

  it("fixed window: allows a burst across the boundary (its known weakness)", async () => {
    const time = clock();
    const router = new BunRouter({
      throttle: byHeader({
        limit: 3,
        window: "1m",
        algorithm: "fixed-window",
        now: time.now,
      }),
    });
    router.get("/x", ok);
    time.set(T0 + 59_999);
    expect(await statuses(router, "/x", 4)).toEqual([200, 200, 200, 429]);
    time.set(T0 + 60_000);
    expect(await statuses(router, "/x", 4)).toEqual([200, 200, 200, 429]);
    const last = await router.fetch("/x");
    expect(last.headers.get("Retry-After")).toBe("60");
  });

  it("gcra: a bucket of `limit`, refilling over the window", async () => {
    const time = clock();
    const router = new BunRouter({
      throttle: byHeader({
        limit: 2,
        window: "10s",
        algorithm: "gcra",
        now: time.now,
      }),
    });
    router.get("/x", ok);
    expect(await statuses(router, "/x", 3)).toEqual([200, 200, 429]);
    time.advance(5_000);
    expect(await statuses(router, "/x", 2)).toEqual([200, 429]);
    const refused = await router.fetch("/x");
    expect(refused.headers.get("Retry-After")).toBe("5");
  });

  it("refuses gcra over a store without consumeGcra", () => {
    const store: ThrottleStore = {
      name: "plain",
      increment: () => 1,
      get: () => 0,
    };
    expect(() => throttle({ limit: 1, algorithm: "gcra", store })).toThrow(
      /consumeGcra/,
    );
  });

  it("several limits at once: any refuses, every one is advertised", async () => {
    const time = clock();
    const router = new BunRouter({
      throttle: byHeader({
        limits: {
          burst: { limit: 2, window: "1s" },
          sustained: { limit: 3, window: "1m" },
        },
        now: time.now,
      }),
    });
    router.get("/x", ok);
    const first = await router.fetch("/x");
    expect(first.headers.get("RateLimit-Policy")).toBe(
      '"burst";q=2;w=1, "sustained";q=3;w=60',
    );
    expect(first.headers.get("RateLimit")).toBe(
      '"burst";r=1;t=1, "sustained";r=2;t=60',
    );
    expect(await statuses(router, "/x", 2)).toEqual([200, 429]); // burst
    time.advance(2_000);
    expect(await statuses(router, "/x", 1)).toEqual([429]); // sustained: 4 counted, the refused one too
  });

  it("cost: fixed and per request", async () => {
    const time = clock();
    const router = new BunRouter({
      throttle: byHeader({ limit: 5, cost: 2, now: time.now }),
    });
    router.get("/x", ok);
    expect(await statuses(router, "/x", 3)).toEqual([200, 200, 429]);

    const priced = new BunRouter({
      throttle: byHeader({
        limit: 10,
        now: time.now,
        cost: (req) => Number(req.get("x-cost") ?? 1),
      }),
    });
    priced.get("/x", ok);
    const heavy = { headers: { "x-cost": "9" } };
    expect((await priced.fetch("/x", heavy)).status).toBe(200);
    expect((await priced.fetch("/x")).status).toBe(200);
    expect((await priced.fetch("/x")).status).toBe(429);
  });

  it("counts clients apart", async () => {
    const router = new BunRouter({
      throttle: byHeader({ limit: 1, now: clock().now }),
    });
    router.get("/x", ok);
    const as = (client: string) => ({ headers: { "x-client": client } });
    expect((await router.fetch("/x", as("a"))).status).toBe(200);
    expect((await router.fetch("/x", as("a"))).status).toBe(429);
    expect((await router.fetch("/x", as("b"))).status).toBe(200);
  });

  it("stays synchronous over the memory store", async () => {
    const router = new BunRouter({
      throttle: byHeader({ limit: 5, now: clock().now }),
    });
    router.get("/x", ok);
    const req = await makeRequest({ url: "http://localhost/x" });
    const res = new BunResponse(req);
    const outcome = router.dispatch(
      new RequestPipelineOptions(req, res, "GET", "/x", 0),
    );
    expect(outcome instanceof Promise).toBe(false);
    expect(res.statusCode).toBe(200);
  });

  it("works over an asynchronous store", async () => {
    const memory = memoryThrottleStore({ now: clock().now });
    const store: ThrottleStore = {
      name: "async",
      increment: async (key, cost, ttl) => memory.increment(key, cost, ttl),
      get: async (key) => memory.get(key),
    };
    const router = new BunRouter({
      throttle: byHeader({ limit: 2, store, now: clock().now }),
    });
    router.get("/x", ok);
    expect(await statuses(router, "/x", 3)).toEqual([200, 200, 429]);
  });

  it("records what it answered for the handler", async () => {
    let seen: readonly ThrottleResult[] | undefined;
    const router = new BunRouter({
      throttle: byHeader({ limit: 3, now: clock().now }),
    });
    router.get("/x", (req, res) => {
      seen = getThrottleResults(req);
      res.send("ok");
    });
    await router.fetch("/x");
    expect(seen).toHaveLength(1);
    expect(seen?.[0]).toMatchObject({
      name: "default",
      limit: 3,
      remaining: 2,
      limited: false,
      algorithm: "sliding-window",
    });
  });
});

describe("throttle(): the 429 and the headers", () => {
  it("answers problem+json with Retry-After and the IETF headers", async () => {
    const time = clock(T0 + 20_000);
    const router = new BunRouter({
      throttle: byHeader({ limit: 1, now: time.now }),
    });
    router.get("/x", ok);
    const allowed = await router.fetch("/x");
    expect(allowed.headers.get("RateLimit-Policy")).toBe('"default";q=1;w=60');
    expect(allowed.headers.get("RateLimit")).toBe('"default";r=0;t=40');
    expect(allowed.headers.get("Retry-After")).toBeNull();

    const refused = await router.fetch("/x");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Content-Type")).toContain(
      "application/problem+json",
    );
    expect(refused.headers.get("Cache-Control")).toBe("no-store");
    // 2 in this window, so only in the next: 40 s, then 60 × (1 − 0/2) = 60 s... capped by the formula.
    const wait = Number(refused.headers.get("Retry-After"));
    expect(wait).toBeGreaterThan(40);
    expect(refused.headers.get("RateLimit")).toBe(`"default";r=0;t=${wait}`);
    expect(await refused.json()).toEqual({
      type: "urn:bun-common:error:TOO_MANY_REQUESTS",
      title: "Too Many Requests",
      status: 429,
      code: "TOO_MANY_REQUESTS",
      detail: `Rate limit exceeded; retry in ${wait} seconds.`,
    });
  });

  it("sends @nestjs/throttler's legacy headers, both, or none", async () => {
    const make = (headers: ThrottleOptions["headers"]) => {
      const router = new BunRouter({
        throttle: byHeader({
          limits: { default: { limit: 5 }, burst: { limit: 1, window: "1s" } },
          headers,
          now: clock().now,
        }),
      });
      router.get("/x", ok);
      return router;
    };
    const legacy = await make("legacy").fetch("/x");
    expect(legacy.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(legacy.headers.get("X-RateLimit-Remaining")).toBe("4");
    expect(legacy.headers.get("X-RateLimit-Limit-burst")).toBe("1");
    expect(legacy.headers.get("RateLimit")).toBeNull();
    const legacyRouter = make("legacy");
    await legacyRouter.fetch("/x");
    const refused = await legacyRouter.fetch("/x");
    // Two in the burst window: the next window, until both have slid out.
    expect(refused.headers.get("Retry-After-burst")).toBe("2");

    const both = await make("both").fetch("/x");
    expect(both.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(both.headers.get("RateLimit-Policy")).not.toBeNull();

    const none = make(false);
    await none.fetch("/x");
    const quiet = await none.fetch("/x");
    expect(quiet.status).toBe(429);
    expect(quiet.headers.get("RateLimit")).toBeNull();
    expect(quiet.headers.get("X-RateLimit-Limit")).toBeNull();
    expect(quiet.headers.get("Retry-After")).toBe("2");
  });

  it("onLimited answers instead, and next() lets the request through", async () => {
    const seen: number[] = [];
    const router = new BunRouter({
      throttle: byHeader({
        limit: 1,
        now: clock().now,
        onLimited: (req, res, next, info) => {
          seen.push(info.retryAfter);
          if (req.get("x-vip") === "1") return next();
          res
            .status(429)
            .json({ slowDown: true, limits: info.limited.map((r) => r.name) });
        },
      }),
    });
    router.get("/x", ok);
    await router.fetch("/x");
    const refused = await router.fetch("/x");
    expect(await refused.json()).toEqual({
      slowDown: true,
      limits: ["default"],
    });
    expect(refused.headers.get("Retry-After")).not.toBeNull();
    expect(
      (await router.fetch("/x", { headers: { "x-vip": "1" } })).status,
    ).toBe(200);
    expect(seen).toHaveLength(2);
  });
});

describe("throttle(): skip, opt-out and overrides", () => {
  it("skip: skipped requests are neither counted nor given headers", async () => {
    const router = new BunRouter({
      throttle: byHeader({
        limit: 1,
        now: clock().now,
        skip: (req) => req.get("x-service-token") === "secret",
      }),
    });
    router.get("/x", ok);
    const service = { headers: { "x-service-token": "secret" } };
    for (let i = 0; i < 3; i++) {
      const res = await router.fetch("/x", service);
      expect(res.status).toBe(200);
      expect(res.headers.get("RateLimit")).toBeNull();
    }
    expect(await statuses(router, "/x", 2)).toEqual([200, 429]);
  });

  it("an asynchronous skip", async () => {
    const router = new BunRouter({
      throttle: byHeader({
        limit: 1,
        now: clock().now,
        skip: async () => await Promise.resolve(true),
      }),
    });
    router.get("/x", ok);
    expect(await statuses(router, "/x", 3)).toEqual([200, 200, 200]);
  });

  it("skipThrottle() turns every outer limit off for its route", async () => {
    const router = new BunRouter({
      throttle: byHeader({ limit: 1, now: clock().now }),
    });
    router.get("/health", skipThrottle(), ok);
    router.get("/x", ok);
    expect(await statuses(router, "/health", 3)).toEqual([200, 200, 200]);
    expect((await router.fetch("/health")).headers.get("RateLimit")).toBeNull();
    expect(await statuses(router, "/x", 2)).toEqual([200, 429]);
  });

  it("skipThrottle(name) turns only that limit off", async () => {
    const router = new BunRouter({
      throttle: byHeader({
        limits: { burst: { limit: 1, window: "1s" }, sustained: { limit: 3 } },
        now: clock().now,
      }),
    });
    router.get("/x", skipThrottle("burst"), ok);
    const res = await router.fetch("/x");
    expect(res.headers.get("RateLimit-Policy")).toBe('"sustained";q=3;w=60');
    expect(await statuses(router, "/x", 3)).toEqual([200, 200, 429]);
  });

  it("a route's own limit of the same name overrides; another name adds", async () => {
    const time = clock();
    const router = new BunRouter({
      throttle: byHeader({ limit: 100, now: time.now }),
    });
    router.post("/verify", throttle(byHeader({ limit: 2, now: time.now })), ok);
    router.post(
      "/login",
      throttle({
        limits: {
          account: {
            limit: 2,
            key: (req) =>
              `${req.get("x-client") ?? "anon"}|${req.get("x-account") ?? ""}`,
          },
          address: { limit: 3, key: (req) => req.get("x-client") ?? "anon" },
        },
        headers: "ietf",
        now: time.now,
      }),
      ok,
    );
    // /verify: the route's "default" replaces the outer one.
    const verify = await router.fetch("/verify", { method: "POST" });
    expect(verify.headers.get("RateLimit-Policy")).toBe('"default";q=2;w=60');
    expect(await statuses(router, "/verify", 2, { method: "POST" })).toEqual([
      200, 429,
    ]);
    // /login: the outer "default" and the route's two limits all apply.
    const login = await router.fetch("/login", {
      method: "POST",
      headers: { "x-account": "a" },
    });
    expect(login.headers.get("RateLimit-Policy")).toBe(
      '"default";q=100;w=60, "account";q=2;w=60, "address";q=3;w=60',
    );
    const account = (name: string) => ({
      method: "POST",
      headers: { "x-account": name },
    });
    expect((await router.fetch("/login", account("a"))).status).toBe(200);
    expect((await router.fetch("/login", account("a"))).status).toBe(429); // account
    expect((await router.fetch("/login", account("b"))).status).toBe(429); // address (4th from this client)
  });

  it("a route-level throttle counts per route by default; scope global shares it", async () => {
    const time = clock();
    const store = memoryThrottleStore({ now: time.now });
    const perRoute = throttle(byHeader({ limit: 1, store, now: time.now }));
    const shared = throttle(
      byHeader({
        limit: 1,
        store,
        prefix: "shared",
        scope: "global",
        now: time.now,
      }),
    );
    const router = new BunRouter();
    router.get("/a", perRoute, ok);
    router.get("/b", perRoute, ok);
    router.get("/c", shared, ok);
    router.get("/d", shared, ok);
    expect(await statuses(router, "/a", 1)).toEqual([200]);
    expect(await statuses(router, "/b", 1)).toEqual([200]);
    expect(await statuses(router, "/c", 1)).toEqual([200]);
    expect(await statuses(router, "/d", 1)).toEqual([429]);
  });

  it("an outer throttle counts globally by default; scope route counts each route", async () => {
    const time = clock();
    const global = new BunRouter({
      throttle: byHeader({ limit: 2, now: time.now }),
    });
    global.get("/a", ok);
    global.get("/b", ok);
    expect([
      ...(await statuses(global, "/a", 1)),
      ...(await statuses(global, "/b", 2)),
    ]).toEqual([200, 200, 429]);

    const perRoute = new BunRouter({
      throttle: byHeader({ limit: 2, scope: "route", now: time.now }),
    });
    perRoute.get("/a/:id", ok);
    perRoute.get("/b", ok);
    // Ids do not multiply counts: one route, one count.
    expect([
      ...(await statuses(perRoute, "/a/1", 1)),
      ...(await statuses(perRoute, "/a/2", 2)),
      ...(await statuses(perRoute, "/b", 2)),
    ]).toEqual([200, 200, 429, 200, 200]);
  });
});

describe("the router and adapter option", () => {
  it("runs first, ahead of middleware registered later", async () => {
    const order: string[] = [];
    const router = new BunRouter({
      throttle: byHeader({ limit: 1, now: clock().now }),
    });
    router.use((_req, _res, next) => {
      order.push("middleware");
      next();
    });
    router.get("/x", ok);
    await router.fetch("/x");
    await router.fetch("/x");
    expect(order).toEqual(["middleware"]);
  });

  it("covers every route of the adapter, mounted routers and the not-found handler (404s count)", async () => {
    const time = clock();
    const adapter = new BunHttpAdapter(0, {
      throttle: byHeader({ limit: 3, now: time.now }),
    });
    const api = new BunRouter();
    api.get("/users", ok);
    adapter.use("/api", api);
    adapter.get("/x", ok);
    adapter.setNotFoundHandler((_req, res) => {
      res.status(404).send("nope");
    });
    expect((await adapter.fetch("/x")).status).toBe(200);
    expect((await adapter.fetch("/api/users")).status).toBe(200);
    expect((await adapter.fetch("/missing")).status).toBe(404);
    expect((await adapter.fetch("/missing")).status).toBe(429);
    expect((await adapter.fetch("/x")).status).toBe(429);
  });

  it("accepts a throttle() middleware as the option", async () => {
    const handler = throttle(byHeader({ limit: 1, now: clock().now }));
    const adapter = new BunHttpAdapter(0, { throttle: handler });
    adapter.get("/x", ok);
    expect([
      (await adapter.fetch("/x")).status,
      (await adapter.fetch("/x")).status,
    ]).toEqual([200, 429]);
  });

  it("keys on req.ip by default, over a real socket", async () => {
    const adapter = new BunHttpAdapter(0, {
      throttle: { limit: 1, now: clock().now },
    });
    adapter.get("/x", ok);
    await adapter.listen(0, "127.0.0.1");
    try {
      const port = adapter.getBunServer()!.port;
      const first = await fetch(`http://127.0.0.1:${port}/x`);
      const second = await fetch(`http://127.0.0.1:${port}/x`);
      expect([first.status, second.status]).toEqual([200, 429]);
      expect(getThrottleResults).toBeDefined();
    } finally {
      await adapter.close();
    }
  });
});

describe("the default key", () => {
  it("reduces IPv6 to its /56, keeps IPv4, unmaps IPv4-mapped addresses", () => {
    expect(throttleAddressKey("203.0.113.9")).toBe("203.0.113.9");
    expect(throttleAddressKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(throttleAddressKey("2001:db8:aa:bbcc:1:2:3:4")).toBe(
      "2001:db8:aa:bb00::/56",
    );
    expect(throttleAddressKey("2001:db8:aa:bbff:ffff::1")).toBe(
      "2001:db8:aa:bb00::/56",
    );
    expect(throttleAddressKey("2001:db8:aa:bbcc::1", 64)).toBe(
      "2001:db8:aa:bbcc::/64",
    );
    expect(throttleAddressKey("2001:db8::1", false)).toBe("2001:db8::1");
    expect(throttleAddressKey("fe80::1%eth0", 128)).toBe("fe80::1");
    expect(throttleAddressKey("::1", 128)).toBe("::1");
    expect(throttleAddressKey("not-an-ip")).toBe("not-an-ip");
  });

  it("answers unknown for a request with no address", async () => {
    const req = await makeRequest({ url: "http://localhost/x" });
    expect(defaultThrottleKey(req)).toBe("unknown");
  });

  it("rotating addresses inside one /56 share a count", async () => {
    const adapter = new BunRouter({
      throttle: {
        limit: 2,
        now: clock().now,
        key: (req) => throttleAddressKey(req.get("x-ip") ?? ""),
      },
    });
    adapter.get("/x", ok);
    const from = (ip: string) => ({ headers: { "x-ip": ip } });
    expect((await adapter.fetch("/x", from("2001:db8:1:200::1"))).status).toBe(
      200,
    );
    expect((await adapter.fetch("/x", from("2001:db8:1:2ff::9"))).status).toBe(
      200,
    );
    expect(
      (await adapter.fetch("/x", from("2001:db8:1:2aa:1:1:1:1"))).status,
    ).toBe(429);
    expect((await adapter.fetch("/x", from("2001:db8:1:300::1"))).status).toBe(
      200,
    );
  });
});

describe("a failing store", () => {
  const broken = (mode: "async" | "sync"): ThrottleStore => ({
    name: "broken",
    increment:
      mode === "sync"
        ? () => {
            throw new Error("down");
          }
        : async () => await Promise.reject(new Error("down")),
    get: () => undefined,
  });

  for (const mode of ["sync", "async"] as const) {
    it(`fails open by default (${mode}), warning at most every 10 s`, async () => {
      const { logger, events } = createTestLogger();
      const router = new BunRouter({
        throttle: { limit: 1, store: broken(mode), logger },
      });
      router.get("/x", ok);
      const responses = await Promise.all(
        [1, 2, 3].map(async () => await router.fetch("/x")),
      );
      expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(responses[0].headers.get("RateLimit")).toBeNull();
      const warnings = events.filter((e) => e.level === "warn");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('throttle store "broken" failed');
      expect(warnings[0].error?.message).toBe("down");
    });

    it(`fails closed with a 503 to the error handlers (${mode})`, async () => {
      let seen: unknown;
      const router = new BunRouter({
        throttle: { limit: 1, store: broken(mode), failMode: "closed" },
      });
      router.get("/x", ok);
      router.use(((err, _req, res, _next) => {
        seen = err;
        res.status((err as ThrottleStoreError).status).send("unavailable");
      }) satisfies RouterErrorMiddlewareHandler);
      const res = await router.fetch("/x");
      expect(res.status).toBe(503);
      expect(seen).toBeInstanceOf(ThrottleStoreError);
      expect((seen as ThrottleStoreError).store).toBe("broken");
    });
  }

  it("logs through the router's logger when the throttle names none", async () => {
    const { logger, events } = createTestLogger();
    const router = new BunRouter({
      logger,
      throttle: { limit: 1, store: broken("sync") },
    });
    router.get("/x", ok);
    await router.fetch("/x");
    expect(events.some((e) => e.level === "warn")).toBe(true);
  });

  it("an error in the caller's key goes to the error handlers, not failMode", async () => {
    const router = new BunRouter({
      throttle: {
        limit: 1,
        key: () => {
          throw new Error("bad key");
        },
      },
    });
    router.get("/x", ok);
    let seen: unknown;
    router.use(((err, _req, res, _next) => {
      seen = err;
      res.status(500).send("x");
    }) satisfies RouterErrorMiddlewareHandler);
    expect((await router.fetch("/x")).status).toBe(500);
    expect((seen as Error).message).toBe("bad key");
  });
});

describe("configuration", () => {
  it("refuses bad options at construction", () => {
    const bad: ThrottleOptions[] = [
      {},
      { limit: 0 },
      { limit: 1.5 },
      { limit: 1, limits: { a: { limit: 1 } } },
      { limit: 1, window: "soon" },
      { limits: { "bad name": { limit: 1 } } },
      { limit: 1, cost: -1 },
      { limit: 1, failMode: "maybe" as "open" },
      { limit: 1, scope: "everywhere" as "route" },
      { limit: 1, headers: "draft-7" as "ietf" },
      { limit: 1, ipv6Subnet: 0 },
      { limit: 1, algorithm: "leaky" as "gcra" },
      { limit: 1, prefix: "" },
    ];
    for (const options of bad) {
      expect(() => throttle(options)).toThrow(ConfigError);
    }
    expect(() => skipThrottle("bad name")).toThrow(ConfigError);
    expect(() => new BunRouter({ throttle: { limit: 0 } })).toThrow(
      ConfigError,
    );
  });

  it("exposes its policies and store", () => {
    const store = memoryThrottleStore();
    const handler = throttle({
      limits: { burst: { limit: 5, window: "1s" } },
      store,
      algorithm: "fixed-window",
    });
    expect(handler.store).toBe(store);
    expect(handler.policies).toEqual([
      {
        name: "burst",
        limit: 5,
        window: 1000,
        algorithm: "fixed-window",
        scope: "global",
      },
    ]);
  });
});

describe("documents", () => {
  const app = (): BunHttpAdapter => {
    const adapter = new BunHttpAdapter(0, {
      throttle: {
        limits: { default: { limit: 600 }, burst: { limit: 20, window: "1s" } },
      },
    });
    adapter.get("/users", ok);
    adapter.get("/health", skipThrottle(), ok);
    adapter.post(
      "/login",
      throttle({ limits: { burst: { limit: 5, window: "1m" } } }),
      ok,
    );
    return adapter;
  };

  it("listRoutes carries the limits that apply to each route", () => {
    const routes = listRoutes(app());
    const byKey = Object.fromEntries(routes.map((route) => [route.key, route]));
    expect(
      byKey["GET /users"].throttle?.map((p) => [p.name, p.limit, p.scope]),
    ).toEqual([
      ["default", 600, "global"],
      ["burst", 20, "global"],
    ]);
    expect(byKey["GET /health"].throttle).toBeUndefined();
    expect(
      byKey["POST /login"].throttle?.map((p) => [
        p.name,
        p.limit,
        p.window,
        p.scope,
      ]),
    ).toEqual([
      ["default", 600, 60_000, "global"],
      ["burst", 5, 60_000, "route"],
    ]);
  });

  it("OpenAPI documents a 429 and x-bun-throttle on throttled routes only", () => {
    const { document } = generateOpenApi(app(), {
      title: "t",
      version: "1",
    }) as unknown as {
      document: {
        paths: Record<string, Record<string, Record<string, unknown>>>;
      };
    };
    const users = document.paths["/users"].get;
    const responses = users.responses as Record<
      string,
      { headers: Record<string, unknown>; content: Record<string, unknown> }
    >;
    expect(Object.keys(responses)).toContain("429");
    expect(Object.keys(responses["429"].headers)).toEqual([
      "Retry-After",
      "RateLimit-Policy",
      "RateLimit",
    ]);
    expect(Object.keys(responses["429"].content)).toEqual([
      "application/problem+json",
    ]);
    expect(users["x-bun-throttle"]).toEqual([
      {
        name: "default",
        limit: 600,
        window: 60_000,
        algorithm: "sliding-window",
        scope: "global",
      },
      {
        name: "burst",
        limit: 20,
        window: 1000,
        algorithm: "sliding-window",
        scope: "global",
      },
    ]);
    const health = document.paths["/health"].get;
    expect(Object.keys(health.responses as object)).not.toContain("429");
    expect(health["x-bun-throttle"]).toBeUndefined();
  });

  it("a route's own 429 wins over the generated one", () => {
    const adapter = app();
    // A handler of its own: `.describe()` keys the doc on the terminal
    // callback, so describing the shared `ok` would reach every route.
    const custom: RouterHandler = (_req, res) => {
      res.send("custom");
    };
    adapter.get("/custom", custom).describe({
      responses: {
        200: { description: "fine" },
        429: { description: "Slow down, custom." },
      },
    });
    const { document } = generateOpenApi(adapter, {
      title: "t",
      version: "1",
    }) as unknown as {
      document: {
        paths: Record<
          string,
          Record<string, { responses: Record<string, { description: string }> }>
        >;
      };
    };
    expect(document.paths["/custom"].get.responses["429"].description).toBe(
      "Slow down, custom.",
    );
  });
});

describe("the bun-security foundation", () => {
  it("sends no rate-limit headers by default, but Retry-After on a 429", async () => {
    const router = new BunRouter({
      throttle: { limit: 1, now: clock().now, key: () => "k" },
    });
    router.get("/x", ok);
    const allowed = await router.fetch("/x");
    expect(allowed.headers.get("RateLimit")).toBeNull();
    expect(allowed.headers.get("RateLimit-Policy")).toBeNull();
    expect(allowed.headers.get("X-RateLimit-Limit")).toBeNull();
    const refused = await router.fetch("/x");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("RateLimit")).toBeNull();
    expect(refused.headers.get("Retry-After")).not.toBeNull();
  });

  it("update() changes the limits while serving, and a bad update changes nothing", async () => {
    const time = clock();
    const handler = throttle(
      byHeader({ limit: 2, window: "1m", now: time.now }),
    );
    const router = new BunRouter({ throttle: handler });
    router.get("/x", ok);
    router.get(
      "/override",
      throttle(byHeader({ limit: 1, now: time.now })),
      ok,
    );
    expect(await statuses(router, "/x", 3)).toEqual([200, 200, 429]);
    // Same name and window: the count carries over (3 so far, the refused
    // one included), so 5 allows two more.
    handler.update({ limit: 5, window: "1m" });
    expect(await statuses(router, "/x", 3)).toEqual([200, 200, 429]);
    expect(handler.policies.map((p) => p.limit)).toEqual([5]);
    // A new name: a fresh count; the route that overrode "default" now also gets "burst".
    handler.update({ limits: { burst: { limit: 1, window: "10s" } } });
    expect(await statuses(router, "/x", 2)).toEqual([200, 429]);
    expect(
      (
        await router.fetch("/override", { headers: { "x-client": "other" } })
      ).headers.get("RateLimit-Policy"),
    ).toBe('"burst";q=1;w=10, "default";q=1;w=60');
    expect(() => handler.update({ limit: 0 })).toThrow(ConfigError);
    // @ts-expect-error a bare number has no unit
    expect(() => handler.update({ limit: 3, window: 30 })).toThrow(ConfigError);
    expect(handler.policies.map((p) => p.name)).toEqual(["burst"]);
  });

  it("peek() answers as if counted, consuming nothing", async () => {
    const time = clock();
    const handler = throttle(byHeader({ limit: 2, now: time.now }));
    let peeked: unknown;
    const router = new BunRouter({ throttle: handler });
    router.get("/x", async (req, res) => {
      peeked = await handler.peek(req);
      res.send("ok");
    });
    await router.fetch("/x");
    expect(peeked).toMatchObject([
      { name: "default", used: 2, remaining: 0, limited: false },
    ]);
    await router.fetch("/x");
    // Two counted: one more would be refused, and peeking again took nothing.
    expect(peeked).toMatchObject([{ used: 3, limited: true }]);
    const req = await makeRequest({ url: "http://localhost/x" });
    expect(await handler.peek(req)).toMatchObject([{ used: 3, limited: true }]);
    expect(await handler.peek(req)).toMatchObject([{ used: 3, limited: true }]);
  });

  it("peek() over GCRA consumes nothing", async () => {
    const handler = throttle({
      limit: 2,
      window: "10s",
      algorithm: "gcra",
      now: clock().now,
    });
    const req = await makeRequest({ url: "http://localhost/x" });
    for (let i = 0; i < 3; i++) {
      expect(await handler.peek(req)).toMatchObject([
        { remaining: 1, limited: false },
      ]);
    }
  });

  it("reset() forgets one key's counts, in every algorithm", async () => {
    for (const algorithm of [
      "sliding-window",
      "fixed-window",
      "gcra",
    ] as const) {
      const time = clock(T0 + 30_000);
      const handler = throttle(
        byHeader({ limit: 1, algorithm, now: time.now }),
      );
      const router = new BunRouter({ throttle: handler });
      router.get("/x", ok);
      const as = (client: string) => ({ headers: { "x-client": client } });
      expect((await router.fetch("/x", as("a"))).status).toBe(200);
      expect((await router.fetch("/x", as("a"))).status).toBe(429);
      expect((await router.fetch("/x", as("b"))).status).toBe(200);
      await handler.reset("a");
      expect((await router.fetch("/x", as("a"))).status).toBe(200);
      expect((await router.fetch("/x", as("b"))).status).toBe(429);
    }
  });

  it("reset() refuses a store without delete()", () => {
    const store: ThrottleStore = {
      name: "plain",
      increment: () => 1,
      get: () => 0,
    };
    expect(() => throttle({ limit: 1, store }).reset("a")).toThrow(/delete/);
  });

  it("failMode: a fallback store counts while the store is down", async () => {
    const { logger, events } = createTestLogger();
    const time = clock();
    let down = true;
    const primary = memoryThrottleStore({ now: time.now });
    const store: ThrottleStore = {
      name: "flaky",
      increment: (key, cost, ttl) => {
        if (down) throw new Error("down");
        return primary.increment(key, cost, ttl);
      },
      get: (key) => primary.get(key),
    };
    const local = memoryThrottleStore({ now: time.now });
    const router = new BunRouter({
      throttle: byHeader({
        limit: 2,
        store,
        failMode: local,
        logger,
        now: time.now,
      }),
    });
    router.get("/x", ok);
    expect(await statuses(router, "/x", 3)).toEqual([200, 200, 429]);
    expect(local.size).toBeGreaterThan(0);
    expect(events.filter((e) => e.level === "warn")[0]?.message).toContain(
      'fallback store "memory"',
    );
    down = false;
    expect(await statuses(router, "/x", 3)).toEqual([200, 200, 429]);
  });

  it("logLimited: one line per 429 naming the route and limit, never the key", async () => {
    const { logger, events } = createTestLogger();
    const router = new BunRouter({
      throttle: {
        limits: { address: { limit: 1, window: "1m" } },
        key: () => "203.0.113.9|alice@example.com",
        logLimited: true,
        logger,
        scope: "route",
        now: clock().now,
      },
    });
    router.post("/login", ok);
    await router.fetch("/login", { method: "POST" });
    await router.fetch("/login", { method: "POST" });
    const lines = events.filter((e) => e.level === "warn");
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe(
      'throttled POST /login by "address" (1 per 60 s)',
    );
    const serialised = JSON.stringify(lines[0]);
    expect(serialised).not.toContain("203.0.113.9");
    expect(serialised).not.toContain("alice");
  });

  it("onLimited is told each limit's name, key, count, reset and the route", async () => {
    let info: ThrottleLimitedInfo | undefined;
    const router = new BunRouter({
      throttle: byHeader({
        limits: { burst: { limit: 1, window: "1s" }, slow: { limit: 10 } },
        now: clock().now,
        onLimited: (req, res, next, given) => {
          info = given;
          sendTooManyRequests(req, res, next, given);
        },
      }),
    });
    router.get("/users/:id", ok);
    await router.fetch("/users/1", { headers: { "x-client": "c1" } });
    expect(
      (await router.fetch("/users/2", { headers: { "x-client": "c1" } }))
        .status,
    ).toBe(429);
    expect(info?.route).toBe("GET /users/:id");
    expect(
      info?.limited.map((r) => [r.name, r.key, r.used, r.limited]),
    ).toEqual([["burst", "c1", 2, true]]);
    expect(info?.results.map((r) => r.name)).toEqual(["burst", "slow"]);
    expect(info?.limited[0].resetAfter).toBeGreaterThan(0);
  });

  it("refuses a window under a second unless asked", () => {
    expect(() => throttle({ limit: 1, window: "500ms" })).toThrow(
      /allowSubSecond/,
    );
    expect(() =>
      throttle({ limit: 1, window: "500ms", allowSubSecond: true }),
    ).not.toThrow();
    expect(() =>
      throttle({
        limits: {
          tiny: { limit: 1, window: { ms: 100 }, allowSubSecond: true },
        },
      }),
    ).not.toThrow();
  });

  it("the shorthand without a window means one minute", () => {
    expect(throttle({ limit: 3 }).policies[0].window).toBe(60_000);
  });
});

describe("misplaced markers", () => {
  it("skipThrottle() registered with use() skips nothing, and the router says so", async () => {
    const { logger, events } = createTestLogger();
    const router = new BunRouter({
      logger,
      throttle: { limit: 1, now: clock().now, key: () => "k" },
    });
    router.use(skipThrottle());
    router.get("/x", ok);
    expect(
      events.some(
        (e) => e.level === "warn" && e.message.includes("skips nothing"),
      ),
    ).toBe(true);
    expect(await statuses(router, "/x", 2)).toEqual([200, 429]);
  });

  it("a mounted router's own throttle option covers its routes only", async () => {
    const time = clock();
    const api = new BunRouter({
      throttle: { limit: 1, now: time.now, key: () => "k" },
    });
    api.get("/a", ok);
    const app = new BunRouter();
    app.use("/api", api);
    app.get("/free", ok);
    expect(await statuses(app, "/api/a", 2)).toEqual([200, 429]);
    expect(await statuses(app, "/free", 3)).toEqual([200, 200, 200]);
  });
});

describe("the client address behind proxies (trustProxy)", () => {
  /** A served adapter throttling 1 request a minute per client. */
  const served = async (
    trustProxy?: "loopback",
  ): Promise<{ url: string; close: () => Promise<void> }> => {
    const adapter = new BunHttpAdapter(0, {
      ...(trustProxy === undefined ? {} : { trustProxy }),
      throttle: { limit: 1, window: "1m", now: clock().now },
    });
    adapter.get("/x", ok);
    await adapter.listen(0, "127.0.0.1");
    return {
      url: `http://127.0.0.1:${adapter.getBunServer()!.port}/x`,
      close: async () => {
        await adapter.close();
      },
    };
  };
  const via = (forwardedFor: string) => ({
    headers: { "X-Forwarded-For": forwardedFor },
  });

  it("keys each client behind a trusted proxy apart, by req.ip", async () => {
    const app = await served("loopback");
    try {
      expect((await fetch(app.url, via("203.0.113.5"))).status).toBe(200);
      expect((await fetch(app.url, via("203.0.113.5"))).status).toBe(429);
      // Another client behind the same proxy has its own count.
      expect((await fetch(app.url, via("198.51.100.7"))).status).toBe(200);
      // A spoofed left-most entry does not make a new client: the walk stops
      // at the first untrusted hop, 203.0.113.5 again.
      expect((await fetch(app.url, via("6.6.6.6, 203.0.113.5"))).status).toBe(
        429,
      );
    } finally {
      await app.close();
    }
  });

  it("without trustProxy, X-Forwarded-For is ignored: one count per peer", async () => {
    const app = await served();
    try {
      expect((await fetch(app.url, via("203.0.113.5"))).status).toBe(200);
      expect((await fetch(app.url, via("198.51.100.7"))).status).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("an IPv4 peer reported mapped and plain shares one count", async () => {
    const handler = throttle({ limit: 1, window: "1m", now: clock().now });
    const outcome = async (peer: string): Promise<number> => {
      const req = await makeRequest({ url: "http://localhost/x", peer });
      const res = new BunResponse(req);
      await handler(req, res, () => {});
      return res.statusCode;
    };
    expect(await outcome("::ffff:203.0.113.9")).toBe(200);
    expect(await outcome("203.0.113.9")).toBe(429);
    expect(await outcome("203.0.113.10")).toBe(200);
  });
});
