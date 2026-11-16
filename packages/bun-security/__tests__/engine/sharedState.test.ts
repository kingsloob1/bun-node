/**
 * The pieces of shared state that need no store: `BanTable.merge` (another
 * process's record, merged the same in any order), `BanTable.reconcile`
 * (adds, and removes only from a whole set), `StoreGuard` (timeout and
 * circuit), and distinct counts (lib/engine/distinct.ts) in this process
 * and over a store, with their fallback.
 */
import { describe, expect, it } from "bun:test";
import { noopLogger } from "@kingsleyweb/bun-common";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { faulty } from "@kingsleyweb/bun-cache/testing";
import { BanTable, mergeBans } from "../../lib/engine/bans";
import type { Ban } from "../../lib/engine/bans";
import { DistinctCounts, MAX_LOCAL_ELEMENTS } from "../../lib/engine/distinct";
import { StoreGuard } from "../../lib/engine/shared";
import { EvictionMonitor } from "../../lib/engine/state";
import { cacheStore } from "../../lib/stores/index";
import { fakeClock, randomWord, seededRandom } from "../helpers";
import { quiet } from "../stores/fleet";

/** A record of the ban of 203.0.113.1. */
function record(overrides: Partial<Ban> = {}): Ban {
  return {
    id: "ip:203.0.113.1",
    subject: { type: "ip", value: "203.0.113.1" },
    action: "ban",
    reason: "r",
    source: "auto",
    createdAt: 1_000,
    expiresAt: 10_000,
    count: 1,
    ...overrides,
  };
}

describe("BanTable.merge: another process's record", () => {
  it("merges the same in either order, and taking a record twice changes nothing", () => {
    const seed = Date.now() % 100_000;
    const random = seededRandom(seed);
    const pick = <T>(list: readonly [T, ...T[]]): T =>
      list[randomWord(random) % list.length] ?? list[0];
    for (let i = 0; i < 500; i++) {
      const make = (): Ban =>
        record({
          action: pick(["ban", "challenge"] as const),
          source: pick(["auto", "manual"] as const),
          reason: pick(["a", "b", "c"]),
          count: 1 + (randomWord(random) % 4),
          createdAt: 1_000 + (randomWord(random) % 3),
          expiresAt: pick([null, 5_000, 9_000]),
        });
      const x = make();
      const y = make();
      const one = new BanTable(() => 100);
      one.merge(x, 0);
      one.merge(y, 0);
      one.merge(y, 0);
      const two = new BanTable(() => 100);
      two.merge(y, 0);
      two.merge(x, 0);
      two.merge(x, 0);
      expect({ seed, i, ban: one.get(x.id) }).toEqual({
        seed,
        i,
        ban: two.get(x.id),
      });
      expect(mergeBans(x, y)).toEqual(mergeBans(y, x));
    }
  });

  it("keeps the later expiry, until-lifted over a date, ban over challenge, a manual reason over an automatic one", () => {
    const merged = mergeBans(
      record({
        source: "manual",
        reason: "ops",
        expiresAt: 5_000,
        action: "challenge",
      }),
      record({ source: "auto", reason: "ladder", expiresAt: null, count: 3 }),
    );
    expect(merged).toMatchObject({
      source: "manual",
      reason: "ops",
      expiresAt: null,
      action: "ban",
      count: 3,
    });
  });

  it("ignores an ended record, and drops an automatic one past the bound's slack", () => {
    const table = new BanTable(() => 0);
    expect(table.merge(record({ expiresAt: 5 }), 10)).toBeUndefined();
    for (let i = 0; i < 1_024; i++) {
      table.merge(
        record({
          id: `ip:10.0.${i >> 8}.${i & 255}`,
          subject: { type: "ip", value: `10.0.${i >> 8}.${i & 255}` },
        }),
        0,
      );
    }
    expect(table.merge(record(), 0)).toBeUndefined();
    expect(table.dropped).toBe(1);
    expect(table.merge(record({ source: "manual" }), 0)?.source).toBe("manual");
  });
});

describe("BanTable.reconcile", () => {
  it("adds the set's bans; removes the others only from a whole set, keeping what keep says", () => {
    const table = new BanTable(() => 100);
    table.merge(record(), 0);
    const other = record({
      id: "ip:203.0.113.2",
      subject: { type: "ip", value: "203.0.113.2" },
    });
    const pending = record({
      id: "user:u",
      subject: { type: "user", value: "u" },
    });
    table.merge(other, 0);
    table.merge(pending, 0);
    const set = new Map([[record().id, record({ count: 2 })]]);
    expect(table.reconcile(set, false, () => false, 0)).toBe(0);
    expect(table.list(0)).toHaveLength(3);
    expect(table.reconcile(set, true, (id) => id === "user:u", 0)).toBe(1);
    expect(
      table
        .list(0)
        .map((ban) => ban.id)
        .sort(),
    ).toEqual(["ip:203.0.113.1", "user:u"]);
    expect(table.get(record().id)?.count).toBe(2);
  });
});

describe("StoreGuard", () => {
  it("fails a slow call, opens after the failures, lets one probe through after the cooldown", async () => {
    const clock = fakeClock();
    const guard = new StoreGuard({
      timeout: 20,
      failures: 2,
      cooldown: 1_000,
      now: clock.now,
    });
    await expect(guard.run("slow", () => Bun.sleep(100))).rejects.toThrow(
      "timed out",
    );
    await expect(
      guard.run("bad", () => Promise.reject(new Error("x"))),
    ).rejects.toThrow("failed");
    let called = 0;
    const ok = () => {
      called++;
      return Promise.resolve(1);
    };
    await expect(guard.run("open", ok)).rejects.toThrow("circuit is open");
    expect(called).toBe(0);
    clock.advance(1_000);
    // Two calls at once after the cooldown: one probes, the other fails fast.
    const [probe, other] = await Promise.allSettled([
      guard.run("probe", async () => {
        await Bun.sleep(5);
        return ok();
      }),
      guard.run("other", ok),
    ]);
    expect(probe.status).toBe("fulfilled");
    expect(other.status).toBe("rejected");
    expect(guard.health().healthy).toBe(true);
    // A failed probe opens the circuit again at once.
    await expect(
      guard.run("bad", () => Promise.reject(new Error("x"))),
    ).rejects.toThrow();
    await expect(
      guard.run("bad", () => Promise.reject(new Error("x"))),
    ).rejects.toThrow();
    clock.advance(1_000);
    await expect(
      guard.run("probe", () => Promise.reject(new Error("x"))),
    ).rejects.toThrow();
    await expect(guard.run("after", ok)).rejects.toThrow("circuit is open");
  });
});

describe("distinct counts", () => {
  const monitor = new EvictionMonitor(
    () => {},
    () => undefined,
  );

  it("count distinct elements per key and window in this process, bounded", () => {
    const counts = new DistinctCounts(undefined, 10, monitor, noopLogger);
    const add = (element: string, now: number) =>
      counts.add(
        {
          key: "ip:203.0.113.1",
          element,
          window: 60_000,
          state: "local",
          onStoreError: "local",
        },
        now,
      );
    expect(add("alice", 0)).toBe(1);
    expect(add("bob", 1)).toBe(2);
    expect(add("alice", 2)).toBe(2);
    // A new window starts from nothing.
    expect(add("alice", 60_000)).toBe(1);
    for (let i = 0; i < MAX_LOCAL_ELEMENTS + 10; i++) {
      void add(`u${i}`, 60_001);
    }
    expect(add("again", 60_002)).toBe(MAX_LOCAL_ELEMENTS);
  });

  it("count in the shared store across processes, falling back to this process (or not counting) when it fails", async () => {
    const driver = faulty(memoryDriver());
    const stores = [0, 1].map(() =>
      cacheStore(createCache({ driver, logger: quiet }), { logger: quiet }),
    );
    const [a, b] = stores.map(
      (store) => new DistinctCounts(store, 10, monitor, noopLogger),
    );
    if (a === undefined || b === undefined) throw new Error("two");
    const count = {
      key: "user:alice",
      window: 60_000,
      state: "shared",
      onStoreError: "local",
    } as const;
    expect(await a.add({ ...count, element: "203.0.113.1" }, 0)).toBe(1);
    expect(await b.add({ ...count, element: "203.0.113.2" }, 0)).toBe(2);
    expect(await b.add({ ...count, element: "203.0.113.1" }, 0)).toBe(2);
    expect(await a.peek({ ...count, element: "203.0.113.9" }, 0)).toBe(3);
    driver.setFaults({ down: true });
    // b has nothing local for this key: its fallback starts at one.
    expect(await b.add({ ...count, element: "203.0.113.3" }, 0)).toBe(1);
    expect(
      await b.add(
        { ...count, element: "203.0.113.4", onStoreError: "open" },
        0,
      ),
    ).toBeUndefined();
    for (const store of stores) await store.close();
  });
});
