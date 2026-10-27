/**
 * Staleness (plan §3.5): stale-while-revalidate, stale-if-error with its
 * backoff, soft and hard loader timeouts, eager refresh, and probabilistic
 * early expiry.
 */
import { describe, expect, test } from "bun:test";
import { sleep } from "@kingsleyweb/bun-common";
import { LoaderTimeoutError } from "../../lib/index";
import { makeCache } from "../helpers";

describe("stale-while-revalidate (§3.5)", () => {
  test("a stale hit inside the window is served and refreshed in the background", async () => {
    const { cache, clock } = makeCache({
      ttl: 1_000,
      staleWhileRevalidate: 5_000,
    });
    await cache.set("k", "v1");
    clock.advance(2_000); // stale, inside the window
    const events: string[] = [];
    cache.on("stale-hit", () => events.push("stale-hit"));
    cache.on("refresh", () => events.push("refresh"));
    const value = await cache.getOrSet("k", async () => "v2");
    expect(value).toBe("v1");
    expect(events).toEqual(["stale-hit"]);
    await sleep(20); // the background refresh lands
    expect(await cache.get("k")).toBe("v2");
    expect(events).toEqual(["stale-hit", "refresh"]);
    await cache.close();
  });

  test("a burst of stale hits starts one refresh", async () => {
    const { cache, clock } = makeCache({
      ttl: 1_000,
      staleWhileRevalidate: 5_000,
    });
    await cache.set("k", "v1");
    clock.advance(2_000);
    let loads = 0;
    const values = await Promise.all(
      Array.from({ length: 10 }, () =>
        cache.getOrSet("k", async () => {
          loads++;
          await sleep(5);
          return "v2";
        }),
      ),
    );
    expect(values).toEqual(Array.from({ length: 10 }, () => "v1"));
    await sleep(50);
    expect(loads).toBe(1);
    await cache.close();
  });

  test("past the window there is no stale serve", async () => {
    const { cache, clock } = makeCache({
      ttl: 1_000,
      staleWhileRevalidate: 500,
    });
    await cache.set("k", "v1");
    clock.advance(2_000); // past freshUntil + swr; the entry is gone
    expect(await cache.getOrSet("k", async () => "v2")).toBe("v2");
    await cache.close();
  });
});

describe("stale-if-error (§3.5)", () => {
  test("a failing loader inside the window serves stale, then backs off", async () => {
    const { cache, clock } = makeCache({
      ttl: 1_000,
      staleIfError: 60_000,
      failSafeBackoff: 30_000,
    });
    await cache.set("k", "v1");
    clock.advance(2_000); // stale: past fresh, inside SIE
    const events: string[] = [];
    cache.on("stale-if-error", () => events.push("stale-if-error"));
    const boom = new Error("origin down");
    const value = await cache.getOrSet("k", async () => {
      throw boom;
    });
    expect(value).toBe("v1");
    expect(events).toEqual(["stale-if-error"]);
    // The backoff pushed the entry's freshness forward (it lands
    // asynchronously): the next call is a hit, not another load.
    await sleep(5);
    let loads = 0;
    expect(
      await cache.getOrSet("k", async () => {
        loads++;
        return "v2";
      }),
    ).toBe("v1");
    expect(loads).toBe(0);
    clock.advance(31_000); // past the backoff
    expect(await cache.getOrSet("k", async () => "v2")).toBe("v2");
    await cache.close();
  });

  test("past the window the loader's error is rethrown", async () => {
    const { cache, clock } = makeCache({ ttl: 1_000 });
    // Stored with a wide window, so the entry survives; the call narrows it.
    await cache.set("k", "v1", { staleIfError: 60_000 });
    clock.advance(2_000); // stale; the entry lives, but the call's window is 500
    await expect(
      cache.getOrSet(
        "k",
        async () => {
          throw new Error("boom");
        },
        { staleIfError: 500 },
      ),
    ).rejects.toThrow("boom");
    await cache.close();
  });
});

describe("loader timeouts (§3.5)", () => {
  test("softTimeout serves the stale value now; the loader's write still lands", async () => {
    const { cache, clock } = makeCache({
      ttl: 1_000,
      staleIfError: 60_000,
    });
    await cache.set("k", "v1");
    clock.advance(2_000); // stale
    const value = await cache.getOrSet(
      "k",
      async () => {
        await sleep(100);
        return "v2";
      },
      { softTimeout: 20 },
    );
    expect(value).toBe("v1");
    await sleep(200);
    expect(await cache.get("k")).toBe("v2");
    await cache.close();
  });

  test("hardTimeout rejects a slow loader with LoaderTimeoutError", async () => {
    const { cache } = makeCache();
    await expect(
      cache.getOrSet(
        "k",
        async () => {
          await sleep(200);
          return "v";
        },
        { hardTimeout: 30 },
      ),
    ).rejects.toThrow(LoaderTimeoutError);
    await cache.close();
  });

  test("hardTimeout with a stale value inside SIE serves the stale value", async () => {
    const { cache, clock } = makeCache({ ttl: 1_000, staleIfError: 60_000 });
    await cache.set("k", "v1");
    clock.advance(2_000);
    const value = await cache.getOrSet(
      "k",
      async () => {
        await sleep(200);
        return "v2";
      },
      { hardTimeout: 30 },
    );
    expect(value).toBe("v1");
    await cache.close();
  });
});

describe("eager refresh and early expiry (§3.5)", () => {
  test("refreshAhead refreshes a hit in the TTL's last fraction", async () => {
    const { cache, clock } = makeCache({ ttl: 1_000, refreshAhead: 0.2 });
    await cache.set("k", "v1");
    clock.advance(500); // halfway: no refresh yet
    let loads = 0;
    const loader = async () => {
      loads++;
      return "v2";
    };
    expect(await cache.getOrSet("k", loader)).toBe("v1");
    expect(loads).toBe(0);
    clock.advance(400); // the last fifth of the TTL
    expect(await cache.getOrSet("k", loader)).toBe("v1");
    await sleep(20);
    expect(loads).toBe(1);
    expect(await cache.get("k")).toBe("v2");
    await cache.close();
  });

  test("earlyExpiry recomputes when the XFetch rule says so", async () => {
    // beta huge: the rule fires on the first fresh read.
    const { cache, clock } = makeCache({ random: () => 0.5 });
    let loads = 0;
    const loader = async () => {
      loads++;
      clock.advance(100); // the load took 100 ms
      return `v${loads}`;
    };
    await cache.getOrSet("k", loader, { ttl: 10_000 });
    expect(loads).toBe(1);
    clock.advance(1_000); // fresh: 9 s of TTL left
    const value = await cache.getOrSet("k", loader, {
      ttl: 10_000,
      earlyExpiry: { beta: 1_000_000_000 },
    });
    expect(value).toBe("v1");
    await sleep(20);
    expect(loads).toBe(2);
    // beta tiny: the rule never fires.
    loads = 0;
    const calm = await cache.getOrSet("k", loader, {
      ttl: 10_000,
      earlyExpiry: { beta: 0 },
    });
    expect(calm).toBe("v2");
    await sleep(20);
    expect(loads).toBe(0);
    await cache.close();
  });
});
