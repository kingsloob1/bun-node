/**
 * `ThrottleHandler.count()` and `peekCount()`: the throttle's counting
 * without a request (bun-node#791). A caller that decided the key from plain
 * data counts in the same store entries as the middleware, under the same
 * algorithms, `failMode` and `update()`, and nothing else the middleware
 * does (headers, `onLimited`, `getThrottleResults`) happens. Every count
 * runs on a fake clock aligned to a window boundary, as `throttle.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import type { ThrottleResult } from "../lib/throttle";
import type { ThrottleStore } from "../lib/throttleStore";
import { BunRouter } from "../lib/BunRouter";
import { createTestLogger } from "../lib/logging";
import { throttle, ThrottleStoreError } from "../lib/throttle";
import { memoryThrottleStore } from "../lib/throttleStore";

/** A minute-aligned instant. */
const T0 = 60_000 * 29_000_000;

/** A clock that stands still unless moved. */
function clock(start = T0): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/** `results` reduced to what each case compares. */
function brief(
  results: readonly ThrottleResult[],
): { name: string; key: string; used: number; limited: boolean }[] {
  return results.map(({ name, key, used, limited }) => ({
    name,
    key,
    used,
    limited,
  }));
}

/** A store whose every call throws (`sync`) or rejects (`async`). */
function broken(mode: "async" | "sync"): ThrottleStore {
  return {
    name: "broken",
    increment:
      mode === "sync"
        ? () => {
            throw new Error("down");
          }
        : async () => await Promise.reject(new Error("down")),
    get:
      mode === "sync"
        ? () => {
            throw new Error("down");
          }
        : async () => await Promise.reject(new Error("down")),
  };
}

describe("count(): the issue's reproduction, without a stand-in request", () => {
  it("counts by key and refuses the third hit of a limit of two", () => {
    const limiter = throttle({
      limits: { login: { limit: 2, window: "1m" } },
      store: memoryThrottleStore({ now: clock().now }),
      now: clock().now,
      algorithm: "fixed-window",
    });
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const results = limiter.count({ login: "203.0.113.9|alice" });
      // Synchronous over the memory store.
      expect(Array.isArray(results)).toBe(true);
      const [result] = results as ThrottleResult[];
      seen.push(`hit ${i + 1}: limited=${result.limited} used=${result.used}`);
    }
    expect(seen).toEqual([
      "hit 1: limited=false used=1",
      "hit 2: limited=false used=2",
      "hit 3: limited=true used=3",
    ]);
  });
});

describe("count()", () => {
  it("counts in the middleware's store entries: a router throttle and a direct caller share one count", async () => {
    const time = clock();
    const limiter = throttle({
      limit: 3,
      key: (req) => req.get("x-client") ?? "anon",
      now: time.now,
    });
    const router = new BunRouter({ throttle: limiter });
    router.get("/x", (_req, res) => res.send("ok"));
    const as = { headers: { "x-client": "alice" } };
    expect((await router.fetch("/x", as)).status).toBe(200);
    expect(brief(limiter.count("alice") as ThrottleResult[])).toEqual([
      { name: "default", key: "alice", used: 2, limited: false },
    ]);
    expect((await router.fetch("/x", as)).status).toBe(200);
    // The fourth hit, counted directly, is over.
    expect(brief(limiter.count("alice") as ThrottleResult[])).toEqual([
      { name: "default", key: "alice", used: 4, limited: true },
    ]);
    expect((await router.fetch("/x", as)).status).toBe(429);
    // Another key is another count.
    expect(brief(limiter.count("bob") as ThrottleResult[])[0]?.used).toBe(1);
  });

  it("one key counts every limit; a key per name counts only those named, in limit order", () => {
    const time = clock();
    const limiter = throttle({
      limits: {
        burst: { limit: 2, window: "1s" },
        sustained: { limit: 10, window: "1m" },
      },
      now: time.now,
    });
    expect(brief(limiter.count("k") as ThrottleResult[])).toEqual([
      { name: "burst", key: "k", used: 1, limited: false },
      { name: "sustained", key: "k", used: 1, limited: false },
    ]);
    expect(
      brief(limiter.count({ sustained: "s", burst: "b" }) as ThrottleResult[]),
    ).toEqual([
      { name: "burst", key: "b", used: 1, limited: false },
      { name: "sustained", key: "s", used: 1, limited: false },
    ]);
    expect(
      brief(limiter.count({ sustained: "k" }) as ThrottleResult[]),
    ).toEqual([{ name: "sustained", key: "k", used: 2, limited: false }]);
    expect(limiter.count({})).toEqual([]);
  });

  it("takes a cost, and a limit's own numeric cost by default", () => {
    const time = clock();
    const limiter = throttle({
      limits: { units: { limit: 10, window: "1m", cost: 3 } },
      now: time.now,
    });
    expect((limiter.count("k") as ThrottleResult[])[0]?.used).toBe(3);
    expect((limiter.count("k", { cost: 5 }) as ThrottleResult[])[0]?.used).toBe(
      8,
    );
    expect((limiter.count("k", { cost: 0 }) as ThrottleResult[])[0]?.used).toBe(
      8,
    );
  });

  it("counts per scope: global by default, a route's count when named", async () => {
    const time = clock();
    const limiter = throttle({
      limit: 2,
      key: () => "k",
      now: time.now,
      scope: "route",
    });
    const router = new BunRouter();
    router.post("/login", limiter, (_req, res) => res.send("ok"));
    expect((await router.fetch("/login", { method: "POST" })).status).toBe(200);
    // The route's count, shared.
    expect(
      brief(limiter.count("k", { scope: "POST /login" }) as ThrottleResult[])[0]
        ?.used,
    ).toBe(2);
    expect((await router.fetch("/login", { method: "POST" })).status).toBe(429);
    // The global count is another one.
    expect(brief(limiter.count("k") as ThrottleResult[])[0]?.used).toBe(1);
    expect(
      (limiter.count("k", { scope: "POST /login" }) as ThrottleResult[])[0]
        ?.scope,
    ).toBe("POST /login");
  });

  it("runs every algorithm: GCRA takes nothing for a refused hit", () => {
    const time = clock();
    const limiter = throttle({
      limit: 2,
      window: "10s",
      algorithm: "gcra",
      now: time.now,
    });
    const limited = () =>
      (limiter.count("k") as ThrottleResult[]).map((r) => r.limited)[0];
    expect([limited(), limited(), limited(), limited()]).toEqual([
      false,
      false,
      true,
      true,
    ]);
    // One token back after half the window.
    time.advance(5_000);
    expect(limited()).toBe(false);
    expect(limited()).toBe(true);
  });

  it("follows update(): the new limits count, a carried-over count stays", () => {
    const time = clock();
    const limiter = throttle({
      limits: { a: { limit: 1, window: "1m" } },
      now: time.now,
    });
    expect((limiter.count("k") as ThrottleResult[])[0]?.limited).toBe(false);
    limiter.update({ limits: { a: { limit: 3, window: "1m" } } });
    expect(brief(limiter.count("k") as ThrottleResult[])).toEqual([
      { name: "a", key: "k", used: 2, limited: false },
    ]);
    expect(() => limiter.count({ b: "k" })).toThrow(TypeError);
  });

  it("is a promise over an asynchronous store, with the same counts", async () => {
    const memory = memoryThrottleStore({ now: clock().now });
    const store: ThrottleStore = {
      name: "async",
      increment: async (key, cost, ttl) =>
        await Promise.resolve(memory.increment(key, cost, ttl)),
      get: async (key) => await Promise.resolve(memory.get(key)),
    };
    const limiter = throttle({
      limit: 1,
      algorithm: "fixed-window",
      store,
      now: clock().now,
    });
    const first = limiter.count("k");
    expect(first).toBeInstanceOf(Promise);
    expect(brief(await first)).toEqual([
      { name: "default", key: "k", used: 1, limited: false },
    ]);
    expect(brief(await limiter.count("k"))[0]?.limited).toBe(true);
  });

  it("leaves no trace the middleware leaves: no headers, no onLimited, no limited log line", async () => {
    const { logger, events } = createTestLogger();
    let told = 0;
    const limiter = throttle({
      limit: 1,
      headers: "both",
      logLimited: true,
      logger,
      onLimited: () => {
        told++;
      },
      now: clock().now,
    });
    await limiter.count("k");
    expect((limiter.count("k") as ThrottleResult[])[0]?.limited).toBe(true);
    expect(told).toBe(0);
    expect(events).toEqual([]);
  });

  it("refuses a bad argument with a TypeError, before touching the store", () => {
    let calls = 0;
    const memory = memoryThrottleStore();
    const store: ThrottleStore = {
      name: "counting",
      increment: (key, cost, ttl) => {
        calls++;
        return memory.increment(key, cost, ttl);
      },
      get: (key) => {
        calls++;
        return memory.get(key);
      },
    };
    const limiter = throttle({
      limits: {
        fixed: { limit: 5, window: "1m" },
        dynamicCost: { limit: 5, window: "1m", cost: () => 2 },
      },
      store,
    });
    const bad: [string, () => unknown][] = [
      ["an unknown limit", () => limiter.count({ nope: "k" })],
      [
        "a key that is not a string",
        () => limiter.count({ fixed: 7 as unknown as string }),
      ],
      ["a negative cost", () => limiter.count("k", { cost: -1 })],
      ["a NaN cost", () => limiter.count("k", { cost: Number.NaN })],
      ["an empty scope", () => limiter.count("k", { scope: "" })],
      ["keys that are neither", () => limiter.count(3 as unknown as string)],
      ["a cost per request with no cost given", () => limiter.count("k")],
    ];
    for (const [what, call] of bad) {
      expect({ what, threw: thrown(call) }).toEqual({
        what,
        threw: "TypeError",
      });
    }
    expect(calls).toBe(0);
    // The control: the same limit with a cost given counts.
    expect(
      (limiter.count({ dynamicCost: "k" }, { cost: 2 }) as ThrottleResult[])[0]
        ?.used,
    ).toBe(2);
    const quota = throttle({ limit: () => 5 });
    expect(thrown(() => quota.count("k"))).toBe("TypeError");
  });
});

/** The name of what `call` throws, or `"nothing"`. */
function thrown(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return error instanceof Error ? error.name : typeof error;
  }
  return "nothing";
}

describe("count() when the store fails: the throttle's failMode", () => {
  for (const mode of ["sync", "async"] as const) {
    it(`"open" answers [] and warns at most every 10 s (${mode})`, async () => {
      const { logger, events } = createTestLogger();
      const limiter = throttle({ limit: 1, store: broken(mode), logger });
      expect(await limiter.count("k")).toEqual([]);
      expect(await limiter.count("k")).toEqual([]);
      const warnings = events.filter((e) => e.level === "warn");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.error?.message).toBe("down");
    });

    it(`"closed" throws or rejects with a ThrottleStoreError (${mode})`, async () => {
      const limiter = throttle({
        limit: 1,
        store: broken(mode),
        failMode: "closed",
      });
      let caught: unknown;
      try {
        await limiter.count("k");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ThrottleStoreError);
      expect((caught as ThrottleStoreError).store).toBe("broken");
      expect((caught as Error).cause).toBeInstanceOf(Error);
    });
  }

  it("a fallback store counts while the store is down", async () => {
    const { logger } = createTestLogger();
    const local = memoryThrottleStore({ now: clock().now });
    const limiter = throttle({
      limit: 1,
      store: broken("sync"),
      failMode: local,
      logger,
      now: clock().now,
    });
    expect(brief(await limiter.count("k"))[0]?.limited).toBe(false);
    expect(brief(await limiter.count("k"))[0]?.limited).toBe(true);
    expect(local.size).toBeGreaterThan(0);
  });
});

describe("peekCount()", () => {
  it("answers as if counted, consuming nothing, in the same entries count() and the middleware use", async () => {
    const time = clock();
    const limiter = throttle({
      limit: 2,
      key: (req) => req.get("x-client") ?? "anon",
      now: time.now,
    });
    for (let i = 0; i < 3; i++) {
      expect(brief(limiter.peekCount("alice") as ThrottleResult[])).toEqual([
        { name: "default", key: "alice", used: 1, limited: false },
      ]);
    }
    await limiter.count("alice");
    const router = new BunRouter({ throttle: limiter });
    router.get("/x", (_req, res) => res.send("ok"));
    await router.fetch("/x", { headers: { "x-client": "alice" } });
    expect(brief(limiter.peekCount("alice") as ThrottleResult[])).toEqual([
      { name: "default", key: "alice", used: 3, limited: true },
    ]);
    expect(
      (limiter.peekCount("alice", { cost: 0 }) as ThrottleResult[])[0]?.used,
    ).toBe(2);
  });

  it("over GCRA consumes nothing", () => {
    const limiter = throttle({
      limit: 2,
      window: "10s",
      algorithm: "gcra",
      now: clock().now,
    });
    for (let i = 0; i < 3; i++) {
      expect(
        (limiter.peekCount("k") as ThrottleResult[]).map((r) => r.remaining),
      ).toEqual([1]);
    }
  });

  it("rejects when the store fails, whatever failMode says", async () => {
    const limiter = throttle({ limit: 1, store: broken("async") });
    await expect(
      Promise.resolve().then(() => limiter.peekCount("k")),
    ).rejects.toThrow("down");
    const sync = throttle({ limit: 1, store: broken("sync") });
    expect(() => sync.peekCount("k")).toThrow("down");
  });
});
