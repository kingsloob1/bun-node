/**
 * `cacheThrottleStore` (`@kingsleyweb/bun-cache/throttle`) on the memory
 * driver: bun-common's `throttle()` counting through a bun-cache `Cache`,
 * driven with `router.fetch()` on one fake clock shared by the throttle and
 * the cache, aligned to a window boundary at {@link T0} so window edges are
 * exact. The shared backends (Redis, Postgres) and the two-process proof are
 * in `servers.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import type {
  RouterErrorMiddlewareHandler,
  RouterHandler,
  ThrottleOptions,
} from "@kingsleyweb/bun-common";
import {
  BunRouter,
  ConfigError,
  createTestLogger,
  ThrottleStoreError,
} from "@kingsleyweb/bun-common";
import type { Cache, CacheDriver } from "../../lib/index";
import {
  cloudflareKvDriver,
  createCache,
  fromSimpleDriver,
  memoryDriver,
  redundant,
  s3Driver,
  sqliteDriver,
} from "../../lib/index";
import type { CacheThrottleStore } from "../../lib/throttle/index";
import {
  cacheThrottleStore,
  DEFAULT_THROTTLE_EXPIRY_MARGIN,
} from "../../lib/throttle/index";
import type { FakeClock } from "../../lib/testing/index";
import { fakeClock, faulty } from "../../lib/testing/index";

/** A minute-aligned instant: window boundaries fall on whole minutes from here. */
const T0 = 60_000 * 29_000_000;

/** One minute, the window every limit here uses. */
const MINUTE = 60_000;

const ok: RouterHandler = (_req, res) => {
  res.send("ok");
};

/** A cache on a fresh memory driver and a store over it, all on one fake clock at {@link T0}. */
function setup(driver?: CacheDriver): {
  /** The cache. */
  cache: Cache;
  /** The store under test. */
  store: CacheThrottleStore;
  /** The clock the cache, its driver and the throttle share. */
  clock: FakeClock;
} {
  const clock = fakeClock(T0);
  const cache = createCache({
    driver: driver ?? memoryDriver({ now: clock.now }),
    sweepInterval: 0,
    now: clock.now,
  });
  return { cache, store: cacheThrottleStore(cache), clock };
}

/** A router throttled through `store`, keyed on the `x-client` header. */
function router(
  options: Omit<ThrottleOptions, "key" | "now">,
  clock: FakeClock,
): BunRouter {
  const app = new BunRouter({
    throttle: {
      ...options,
      key: (req) => req.get("x-client") ?? "anon",
      now: clock.now,
    },
  });
  app.get("/", ok);
  return app;
}

/** Requests `/` `n` times as `client`, answering each status. */
async function statuses(
  app: BunRouter,
  n: number,
  client = "c1",
): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      (await app.fetch("/", { headers: { "x-client": client } })).status,
    );
  }
  return out;
}

describe("cacheThrottleStore: the store", () => {
  it("is named after the driver, and keeps its counters in its own namespace", async () => {
    const { cache, store } = setup();
    expect(store.name).toBe("bun-cache:memory");
    expect(store.namespace).toBe("cache:throttle");
    expect(await store.increment("k", 2, 1_000)).toBe(2);
    expect(await store.increment("k", 3, 1_000)).toBe(5);
    expect(await store.get("k")).toBe(5);
    // Not in the cache's own namespace: under `throttle`.
    expect(await cache.get("k")).toBeUndefined();
    expect(await cache.namespace("throttle").get("k")).toBe(5);
  });

  it("takes another namespace, and two namespaces never share a count", async () => {
    const { cache } = setup();
    const a = cacheThrottleStore(cache, { namespace: "limits-a" });
    const b = cacheThrottleStore(cache.namespace("tenant"), {
      namespace: "limits-b",
    });
    expect(a.namespace).toBe("cache:limits-a");
    expect(b.namespace).toBe("cache:tenant:limits-b");
    await a.increment("k", 1, 1_000);
    expect(await b.get("k")).toBeUndefined();
    expect(await b.increment("k", 1, 1_000)).toBe(1);
  });

  it("answers undefined for a counter that does not exist", async () => {
    const { store } = setup();
    expect(await store.get("nothing")).toBeUndefined();
  });

  it("sets the lifetime only when it creates the counter, plus the expiry margin", async () => {
    const { cache, store, clock } = setup();
    await store.increment("k", 1, 10_000);
    clock.advance(4_000);
    await store.increment("k", 1, 10_000);
    const entry = await cache.namespace("throttle").getEntry("k");
    expect(entry?.expiresAt).toBe(T0 + 10_000 + DEFAULT_THROTTLE_EXPIRY_MARGIN);
    clock.set(T0 + 10_000 + DEFAULT_THROTTLE_EXPIRY_MARGIN);
    expect(await store.get("k")).toBeUndefined();
    expect(await store.increment("k", 1, 10_000)).toBe(1);
  });

  it("stores exactly the lifetime asked for with expiryMargin 0", async () => {
    const { cache, clock } = setup();
    const store = cacheThrottleStore(cache, { expiryMargin: 0 });
    await store.increment("k", 1, 10_000);
    clock.set(T0 + 9_999);
    expect(await store.get("k")).toBe(1);
    clock.set(T0 + 10_000);
    expect(await store.get("k")).toBeUndefined();
  });

  it("deletes one counter: the count starts again from zero, others untouched", async () => {
    const { store } = setup();
    await store.increment("a", 3, 10_000);
    await store.increment("b", 2, 10_000);
    await store.delete("a");
    expect(await store.get("a")).toBeUndefined();
    expect(await store.increment("a", 1, 10_000)).toBe(1);
    expect(await store.get("b")).toBe(2);
  });

  it("clears its own namespace and nothing else", async () => {
    const { cache, store } = setup();
    await cache.set("mine", "kept");
    await store.increment("a", 1, 10_000);
    await store.clear();
    expect(await store.get("a")).toBeUndefined();
    expect(await cache.get("mine")).toBe("kept");
  });

  it("refuses a fractional cost, on every driver alike", async () => {
    const { store } = setup();
    await expect(store.increment("k", 0.5, 1_000)).rejects.toThrow(
      /cost must be an integer/,
    );
    expect(await store.get("k")).toBeUndefined();
  });

  it("refuses a bad namespace or expiryMargin at construction", () => {
    const { cache } = setup();
    expect(() => cacheThrottleStore(cache, { namespace: "" })).toThrow(
      ConfigError,
    );
    expect(() => cacheThrottleStore(cache, { expiryMargin: -1 })).toThrow(
      ConfigError,
    );
    expect(() =>
      cacheThrottleStore(cache, { expiryMargin: Number.NaN }),
    ).toThrow(ConfigError);
  });

  it("never answers from an L1 tier: a count is the driver's", async () => {
    const clock = fakeClock(T0);
    const shared = memoryDriver({ now: clock.now });
    const tiered = (): Cache =>
      createCache({
        driver: shared,
        sweepInterval: 0,
        now: clock.now,
        l1: { maxEntries: 100, ttl: 60_000 },
        bus: false,
      });
    const a = cacheThrottleStore(tiered());
    const b = cacheThrottleStore(tiered());
    expect(await a.increment("k", 1, 10_000)).toBe(1);
    expect(await b.get("k")).toBe(1);
    expect(await b.increment("k", 1, 10_000)).toBe(2);
    // `a` read nothing stale from a per-process copy: no bus, yet it sees 2.
    expect(await a.get("k")).toBe(2);
  });
});

describe("cacheThrottleStore: refusing a driver without an atomic increment", () => {
  it("refuses cloudflare-kv at construction, naming it and the alternatives", () => {
    const cache = createCache({
      driver: cloudflareKvDriver({
        accountId: "acc",
        apiToken: "tok",
        namespaceId: "ns",
      }),
    });
    let error: unknown;
    try {
      cacheThrottleStore(cache);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('"cloudflare-kv"');
    expect((error as Error).message).toContain("no atomic increment");
    expect((error as Error).message).toContain("redisDriver");
    expect((error as Error).message).toContain("memoryThrottleStore()");
  });

  it("refuses a simple driver, s3 without conditional writes, and a capability of false", () => {
    const simple = fromSimpleDriver({
      name: "simple-kv",
      get: async () => undefined,
      set: async () => {},
      delete: async () => true,
    });
    expect(() => cacheThrottleStore(createCache({ driver: simple }))).toThrow(
      /"simple-kv" has no atomic increment/,
    );
    const s3 = s3Driver({
      url: "s3://key:secret@127.0.0.1:1/bucket?scheme=http",
      conditionalWrites: false,
    });
    expect(() => cacheThrottleStore(createCache({ driver: s3 }))).toThrow(
      /"s3" has no atomic increment/,
    );
    // A driver with an increment method that does not advertise it as atomic.
    const claimsNone = faulty(memoryDriver());
    Object.defineProperty(claimsNone, "name", { value: "not-atomic" });
    Object.defineProperty(claimsNone, "capabilities", {
      value: { ...memoryDriver().capabilities, atomicIncrement: false },
    });
    expect(typeof claimsNone.increment).toBe("function");
    expect(() =>
      cacheThrottleStore(createCache({ driver: claimsNone })),
    ).toThrow(/"not-atomic" has no atomic increment/);
  });

  it("refuses a redundant() whose primary has no counters, or with counters: refuse", () => {
    const kv = cloudflareKvDriver({
      accountId: "acc",
      apiToken: "tok",
      namespaceId: "ns",
    });
    expect(() =>
      cacheThrottleStore(
        createCache({ driver: redundant([kv, memoryDriver()]) }),
      ),
    ).toThrow(/"redundant\(cloudflare-kv, memory\)" has no atomic increment/);
    expect(() =>
      cacheThrottleStore(
        createCache({
          driver: redundant([memoryDriver(), memoryDriver()], {
            counters: "refuse",
          }),
        }),
      ),
    ).toThrow(ConfigError);
  });

  it("accepts a redundant() over a primary with counters, even while that primary is down", async () => {
    const primary = faulty(memoryDriver());
    const driver = redundant([primary, memoryDriver()], {
      circuit: { failures: 1, cooldown: 60_000 },
    });
    const cache = createCache({ driver });
    const store = cacheThrottleStore(cache);
    expect(store.name).toBe("bun-cache:redundant(faulty(memory), memory)");
    expect(await store.increment("k", 1, 10_000)).toBe(1);
    primary.setFaults({ down: true });
    // The primary's circuit opens: increments throw (throttle()'s failMode
    // decides), and the capability reads false for now.
    await expect(store.increment("k", 1, 10_000)).rejects.toThrow();
    await expect(store.increment("k", 1, 10_000)).rejects.toThrow();
    expect(driver.capabilities.atomicIncrement).toBe(false);
    // A new store over the same cache is still accepted: down is not "has none".
    expect(() => cacheThrottleStore(cache)).not.toThrow();
  });

  it("accepts a Cache that createCache did not make, named plainly", async () => {
    const { cache } = setup();
    // A hand-written Cache: here, one that delegates to a real one.
    const handWritten = new Proxy({} as Cache, {
      get: (_target, property) => {
        const value = (cache as unknown as Record<PropertyKey, unknown>)[
          property
        ];
        return typeof value === "function" ? value.bind(cache) : value;
      },
    });
    const store = cacheThrottleStore(handWritten);
    expect(store.name).toBe("bun-cache");
    expect(await store.increment("k", 1, 1_000)).toBe(1);
  });
});

describe("cacheThrottleStore under throttle()", () => {
  it("counts a sliding window: the previous window's requests weigh on the next", async () => {
    const { store, clock } = setup();
    const app = router({ limit: 3, window: "1m", store }, clock);
    expect(await statuses(app, 4)).toEqual([200, 200, 200, 429]);
    // Another client has its own count.
    expect(await statuses(app, 1, "c2")).toEqual([200]);
    // Halfway into the next window: 4 counted last window, half of them
    // still weigh (2), so one more fits.
    clock.set(T0 + MINUTE + MINUTE / 2);
    expect(await statuses(app, 2)).toEqual([200, 429]);
    // Two windows on, nothing weighs: the full limit again.
    clock.set(T0 + 3 * MINUTE);
    expect(await statuses(app, 4)).toEqual([200, 200, 200, 429]);
  });

  it("counts a fixed window: a new window starts from zero", async () => {
    const { store, clock } = setup();
    const app = router(
      { limit: 3, window: "1m", store, algorithm: "fixed-window" },
      clock,
    );
    expect(await statuses(app, 4)).toEqual([200, 200, 200, 429]);
    clock.set(T0 + MINUTE - 1);
    expect(await statuses(app, 1)).toEqual([429]);
    clock.set(T0 + MINUTE);
    expect(await statuses(app, 4)).toEqual([200, 200, 200, 429]);
  });

  it("lets a counter expire with its window, not with the traffic", async () => {
    const { cache, store, clock } = setup();
    const app = router(
      { limit: 100, window: "1m", store, algorithm: "fixed-window" },
      clock,
    );
    await statuses(app, 1);
    clock.set(T0 + 30_000);
    await statuses(app, 1);
    const key = `throttle:default:${MINUTE}:global:c1:${T0 / MINUTE}`;
    const entry = await cache.namespace("throttle").getEntry(key);
    expect(entry?.value).toBe(2);
    expect(entry?.expiresAt).toBe(T0 + MINUTE + DEFAULT_THROTTLE_EXPIRY_MARGIN);
  });

  it("sends the IETF headers from the cache's counts", async () => {
    const { store, clock } = setup();
    const app = router(
      { limit: 2, window: "1m", store, headers: "ietf" },
      clock,
    );
    const first = await app.fetch("/", { headers: { "x-client": "h" } });
    expect(first.headers.get("RateLimit")).toContain("r=1");
    await app.fetch("/", { headers: { "x-client": "h" } });
    const refused = await app.fetch("/", { headers: { "x-client": "h" } });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("RateLimit")).toContain("r=0");
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("starts a client from zero once its counters are deleted", async () => {
    const { store, clock } = setup();
    const app = router(
      { limit: 2, window: "1m", store, algorithm: "fixed-window" },
      clock,
    );
    expect(await statuses(app, 3)).toEqual([200, 200, 429]);
    await store.delete(`throttle:default:${MINUTE}:global:c1:${T0 / MINUTE}`);
    expect(await statuses(app, 3)).toEqual([200, 200, 429]);
  });

  it("is refused by algorithm gcra, which needs an atomic consumeGcra", () => {
    const { store } = setup();
    expect("consumeGcra" in store).toBe(false);
    expect(
      () => new BunRouter({ throttle: { limit: 3, store, algorithm: "gcra" } }),
    ).toThrow(/algorithm "gcra" needs a store with an atomic consumeGcra\(\)/);
  });

  it("answers 503 under failMode closed when the cache's driver fails, and lets through under open", async () => {
    const clock = fakeClock(T0);
    const broken = faulty(memoryDriver({ now: clock.now }), {
      failOn: ["increment"],
    });
    const { store } = setup(broken);
    let seen: unknown;
    const closed = router(
      { limit: 3, window: "1m", store, failMode: "closed" },
      clock,
    );
    closed.use(((err, _req, res, _next) => {
      seen = err;
      res.status((err as ThrottleStoreError).status).send("unavailable");
    }) satisfies RouterErrorMiddlewareHandler);
    expect(await statuses(closed, 1)).toEqual([503]);
    expect(seen).toBeInstanceOf(ThrottleStoreError);
    expect((seen as ThrottleStoreError).store).toBe("bun-cache:faulty(memory)");
    const { logger, events } = createTestLogger();
    const open = router({ limit: 1, window: "1m", store, logger }, clock);
    expect(await statuses(open, 2)).toEqual([200, 200]);
    expect(events.some((event) => event.level === "warn")).toBe(true);
  });
});

describe("cacheThrottleStore: the backend's own counters", () => {
  it("has none on a backend that cannot count itself: process clock, no countWindow, no GCRA", () => {
    const { store } = setup();
    expect(store.clock).toBe("process");
    expect(store.countWindow).toBeUndefined();
    expect(store.deleteWindow).toBeUndefined();
    expect(store.consumeGcra).toBeUndefined();
    // A wrapped driver is not the driver: it keeps the cache's path.
    const wrapped = cacheThrottleStore(
      createCache({ driver: faulty(sqliteDriver({ path: ":memory:" })) }),
    );
    expect(wrapped.countWindow).toBeUndefined();
  });

  it("has them on SQLite: the store clock by default, the process clock on request", async () => {
    const cache = createCache({
      driver: sqliteDriver({ path: ":memory:" }),
      sweepInterval: 0,
    });
    try {
      expect(cacheThrottleStore(cache).clock).toBe("store");
      const local = cacheThrottleStore(cache, { clock: "process" });
      expect(local.clock).toBe("process");
      expect(typeof local.consumeGcra).toBe("function");
    } finally {
      await cache.close();
    }
  });

  it("refuses a clock that is neither", () => {
    const { cache } = setup();
    expect(() =>
      // @ts-expect-error not a clock
      cacheThrottleStore(cache, { clock: "server" }),
    ).toThrow(ConfigError);
  });
});
