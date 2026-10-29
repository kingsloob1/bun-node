/**
 * `redundant()` (plan §5): the conformance kit over the combinator on
 * in-process members — two memory drivers (in each write and read mode), a
 * memory driver over SQLite, and a memory driver over the file driver (mixed
 * tag modes, so the combinator is `tags: "stamps"`) — plus the combinator's
 * own behaviour under injected faults (§5.5): a member that throws, hangs past
 * its timeout or lags; a dirty member rejoining empty; the primary down for
 * counters and locks; the §5.3 gap bounded by `secondaryTtl`; `race`; the
 * `write: "primary"` queue and its overflow; and every member event.
 *
 * The server lanes (Postgres twice, Redis over Postgres) are in
 * `redundant-servers.test.ts`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, test } from "bun:test";
import type {
  CacheDriver,
  CacheEventMap,
  CacheMemberEvent,
  StoredEntry,
} from "../../lib/index";
import {
  createCache,
  fileDriver,
  memoryDriver,
  redundant,
  sqliteDriver,
  UnsupportedOperationError,
} from "../../lib/index";
import { memoryDriverDump } from "../../lib/drivers/memory";
import type { RedundantOptions } from "../../lib/drivers/redundant";
import { redundantDriverState } from "../../lib/drivers/redundant";
import {
  fakeClock,
  faulty,
  runCacheDriverConformance,
} from "../../lib/testing/index";

/** The run's own directory, for the file-driver lane. */
const dir = await mkdtemp(
  join(tmpdir(), `bun-cache-redundant-${process.pid}-`),
);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A kit lane over two memory drivers, with both members' maps as the raw dump. */
async function memoryLane(
  title: string,
  options: RedundantOptions,
): Promise<void> {
  await runCacheDriverConformance(title, () => {
    const a = memoryDriver();
    const b = memoryDriver();
    return {
      driver: redundant([a, b], options),
      rawDump: () => [...memoryDriverDump(a), ...memoryDriverDump(b)],
    };
  });
}

await memoryLane("redundant([memory, memory])", {});
await memoryLane('redundant([memory, memory], { ack: "all" })', { ack: "all" });
await memoryLane('redundant([memory, memory], { read: "race" })', {
  read: "race",
});
await memoryLane('redundant([memory, memory], { write: "primary" })', {
  write: "primary",
});
await memoryLane("redundant([memory, memory], { secondaryTtl })", {
  secondaryTtl: 3_600_000,
});

await runCacheDriverConformance("redundant([memory, sqlite])", () => ({
  driver: redundant([memoryDriver(), sqliteDriver({ path: ":memory:" })]),
}));

// Mixed tag modes: memory indexes, the file driver stamps, so the
// combinator stamps — the core's read check over both members.
await runCacheDriverConformance("redundant([memory, file])", () => ({
  driver: redundant([memoryDriver(), fileDriver({ root: join(dir, "kit") })]),
}));

/* ------------------------------------------------------------------ */
/* The combinator under faults (§5.5)                                  */
/* ------------------------------------------------------------------ */

/** An entry for the cases. */
function entry(
  key: string,
  byte = 1,
  init: Partial<Pick<StoredEntry, "expiresAt" | "tags">> = {},
): StoredEntry {
  return {
    key,
    value: new Uint8Array([byte]),
    expiresAt: init.expiresAt ?? null,
    tags: init.tags ?? [],
  };
}

/** Every member event a driver reports, in order. */
function recordEvents(driver: CacheDriver): {
  /** The events so far. */
  events: {
    event: CacheMemberEvent;
    payload: CacheEventMap[CacheMemberEvent];
  }[];
  /** The events of one name so far. */
  of: <E extends CacheMemberEvent>(event: E) => CacheEventMap[E][];
} {
  const events: {
    event: CacheMemberEvent;
    payload: CacheEventMap[CacheMemberEvent];
  }[] = [];
  driver.onMemberEvent!((event, payload) => {
    events.push({ event, payload });
  });
  return {
    events,
    of: <E extends CacheMemberEvent>(event: E) =>
      events
        .filter((each) => each.event === event)
        .map((each) => each.payload as CacheEventMap[E]),
  };
}

/** Waits until `condition` holds, checking every 5 ms; throws after `timeoutMs`. */
async function waitFor(
  what: string,
  condition: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await Bun.sleep(5);
  }
}

/** `driver` with some of its methods replaced; the rest bound to it. */
function overriding(
  driver: CacheDriver,
  overrides: Partial<CacheDriver>,
): CacheDriver {
  return new Proxy(driver, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) {
        return overrides[property as keyof CacheDriver];
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** The bytes of a member's entry, or `undefined`. */
async function byteOn(
  driver: CacheDriver,
  ns: string,
  key: string,
): Promise<number | undefined> {
  return (await driver.get(ns, key))?.value[0];
}

describe("redundant(): options", () => {
  test("refuses fewer than two members, a member twice, and options that do not apply", () => {
    const a = memoryDriver();
    const b = memoryDriver();
    expect(() => redundant([a])).toThrow(/at least two/);
    expect(() => redundant([a, a])).toThrow(/once/);
    expect(() => redundant([a, b], { write: "primary", ack: "all" })).toThrow(
      /ack applies to write: "all"/,
    );
    expect(() => redundant([a, b], { maxQueue: 5 })).toThrow(
      /maxQueue applies to write: "primary"/,
    );
    expect(() =>
      // @ts-expect-error — not a write mode
      redundant([a, b], { write: "quorum" }),
    ).toThrow(/write must be "all" or "primary"/);
    expect(() =>
      // @ts-expect-error — quorum reads are not offered (§5.2)
      redundant([a, b], { read: "quorum" }),
    ).toThrow(/read must be "failover" or "race"/);
    expect(() => redundant([a, b], { timeout: -1 })).toThrow(/timeout/);
    expect(() => redundant([a, b], { circuit: { failures: 0 } })).toThrow(
      /circuit.failures/,
    );
    expect(() => redundant([a, b], { secondaryTtl: 0 })).toThrow(
      /secondaryTtl/,
    );
    expect(() =>
      redundant([a, b], { write: "primary", maxQueue: 1.5 }),
    ).toThrow(/maxQueue/);
  });

  test("capabilities: the intersection, tags index only when every member indexes, the bus the primary's", () => {
    const both = redundant([
      memoryDriver(),
      sqliteDriver({ path: ":memory:" }),
    ]);
    expect(both.name).toBe("redundant(memory, sqlite)");
    expect(both.capabilities).toEqual({
      multiProcess: false,
      ttl: "sweep",
      atomicIncrement: true,
      lock: true,
      tags: "index",
      fence: "atomic",
      bus: "push",
      maxEntryBytes: both.capabilities.maxEntryBytes!,
    });
    expect(typeof both.deleteByTags).toBe("function");
    const mixed = redundant([
      memoryDriver(),
      fileDriver({ root: join(dir, "caps") }),
    ]);
    expect(mixed.capabilities.tags).toBe("stamps");
    expect(mixed.deleteByTags).toBeUndefined();
    // The file driver's bus is polled, but the primary's is the one used.
    expect(mixed.capabilities.bus).toBe("push");
    const fileFirst = redundant([
      fileDriver({ root: join(dir, "caps2") }),
      memoryDriver(),
    ]);
    expect(fileFirst.capabilities.bus).toBe("poll");
    expect(fileFirst.capabilities.multiProcess).toBe(false);
  });

  test('counters: "refuse" advertises no counters and no locks', () => {
    const driver = redundant([memoryDriver(), memoryDriver()], {
      counters: "refuse",
    });
    expect(driver.capabilities.atomicIncrement).toBe(false);
    expect(driver.capabilities.lock).toBe(false);
    expect(driver.increment).toBeUndefined();
    expect(driver.acquireLock).toBeUndefined();
    expect(driver.getCounter).toBeUndefined();
  });
});

describe("redundant(): a member that throws, hangs or lags (§5.5)", () => {
  test("a member that throws on a write misses it: dirty, emptied, then it serves again", async () => {
    const a = memoryDriver();
    const b = memoryDriver();
    const fb = faulty(b);
    const driver = redundant([a, fb], { timeout: 200 });
    const seen = recordEvents(driver);
    await driver.set("ns", entry("old", 1));
    expect(await byteOn(b, "ns", "old")).toBe(1);
    fb.setFaults({ failOn: ["set"] });
    // The primary acknowledged: the write resolves.
    expect(await driver.set("ns", entry("k", 2))).toBe("stored");
    await waitFor("member-up", () => seen.of("member-up").length > 0);
    expect(seen.of("member-dirty")).toEqual([
      {
        driver: "redundant(memory, faulty(memory))",
        index: 1,
        member: "faulty(memory)",
        op: "set",
        reason: "failed",
      },
    ]);
    expect(seen.of("member-up")).toEqual([
      {
        driver: "redundant(memory, faulty(memory))",
        index: 1,
        member: "faulty(memory)",
        cleared: true,
      },
    ]);
    // It rejoined empty: the value it held from before its miss is gone.
    expect(await byteOn(b, "ns", "old")).toBeUndefined();
    expect(redundantDriverState(driver)[1]).toMatchObject({
      up: true,
      dirty: false,
      cleaning: false,
    });
    // Its circuit never opened: one failure is not `circuit.failures`.
    expect(seen.of("member-down")).toEqual([]);
    fb.setFaults({});
    await driver.set("ns", entry("k2", 3));
    expect(await byteOn(b, "ns", "k2")).toBe(3);
  });

  test("a member that hangs past its timeout: a read fails over within the timeout, and its circuit opens", async () => {
    const a = memoryDriver();
    const b = memoryDriver();
    const fa = faulty(a, { hangMs: 2_000 });
    const driver = redundant([fa, b], {
      timeout: 50,
      circuit: { failures: 2, cooldown: 60_000 },
    });
    const seen = recordEvents(driver);
    await b.set("ns", entry("k", 7));
    let started = Date.now();
    expect((await driver.get("ns", "k"))?.value[0]).toBe(7);
    const first = Date.now() - started;
    expect(first).toBeGreaterThanOrEqual(45);
    expect(first).toBeLessThan(1_000);
    expect(seen.of("member-down")).toEqual([]);
    await driver.get("ns", "k");
    expect(seen.of("member-down")).toEqual([
      {
        driver: "redundant(faulty(memory), memory)",
        index: 0,
        member: "faulty(memory)",
        failures: 2,
      },
    ]);
    // Open: the member is skipped, with no timeout to wait out.
    started = Date.now();
    expect((await driver.get("ns", "k"))?.value[0]).toBe(7);
    expect(Date.now() - started).toBeLessThan(40);
    expect(redundantDriverState(driver)[0]!.up).toBe(false);
  });

  test("a member that lags under its timeout: an ack-one write resolves on the primary, and the lagging write lands later", async () => {
    const a = memoryDriver();
    const b = memoryDriver();
    const fb = faulty(b, { lagMs: 120 });
    const driver = redundant([a, fb], { timeout: 2_000 });
    const seen = recordEvents(driver);
    let started = Date.now();
    await driver.set("ns", entry("k", 4));
    expect(Date.now() - started).toBeLessThan(100);
    expect(await byteOn(b, "ns", "k")).toBeUndefined();
    await Bun.sleep(200);
    expect(await byteOn(b, "ns", "k")).toBe(4);
    expect(seen.events).toEqual([]);
    // ack: "all" waits for it.
    const all = redundant(
      [memoryDriver(), faulty(memoryDriver(), { lagMs: 120 })],
      {
        ack: "all",
        timeout: 2_000,
      },
    );
    started = Date.now();
    await all.set("ns", entry("k", 4));
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });

  test('ack "one" under failover waits for the first healthy member in order, so a process reads its own write', async () => {
    const a = memoryDriver();
    const fa = faulty(a, { lagMs: 80 });
    const b = memoryDriver();
    const driver = redundant([fa, b], { timeout: 2_000 });
    const started = Date.now();
    await driver.set("ns", entry("k", 5));
    // The secondary answered first; the write resolved on the primary.
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(await byteOn(a, "ns", "k")).toBe(5);
    expect((await driver.get("ns", "k"))?.value[0]).toBe(5);
  });
});

describe("redundant(): one member's writes stay in order under ack one", () => {
  test("a write on a key follows that key's write still running, and a namespace-wide write everything before it", async () => {
    const a = memoryDriver();
    const inner = memoryDriver();
    let slowSets = 1;
    // A secondary whose first write and every clear are slow, the rest fast:
    // a pool would apply them out of order.
    const b = overriding(inner, {
      set: async (ns, written, fence) => {
        if (slowSets-- > 0) {
          await Bun.sleep(60);
        }
        return await inner.set(ns, written, fence);
      },
      clear: async (ns) => {
        await Bun.sleep(60);
        await inner.clear(ns);
      },
    });
    const driver = redundant([a, b], { timeout: 2_000 });
    await driver.set("ns", entry("k", 1)); // slow on B
    await driver.set("ns", entry("k", 2)); // fast on B, but after
    await driver.clear("other"); // slow on B
    await driver.set("other", entry("j", 3)); // after the clear
    await Bun.sleep(200);
    expect(await byteOn(inner, "ns", "k")).toBe(2);
    expect(await byteOn(inner, "other", "j")).toBe(3);
  });
});

describe("redundant(): sweep", () => {
  test("a member's sweep runs after the writes already sent to it", async () => {
    const a = memoryDriver();
    const inner = memoryDriver();
    const b = overriding(inner, {
      set: async (ns, written, fence) => {
        await Bun.sleep(60);
        return await inner.set(ns, written, fence);
      },
    });
    const driver = redundant([a, b], { timeout: 2_000 });
    await driver.set("ns", entry("dead", 1, { expiresAt: Date.now() + 30 }));
    await Bun.sleep(35); // expired, and still being written on B
    // Each member reclaims its own copy: 2, not the primary's 1.
    expect(await driver.sweep!(Date.now(), 100)).toBe(2);
  });
});

describe("redundant(): rejoin empty (§5.3)", () => {
  test("a member that missed writes while down is emptied by the probe before it serves reads", async () => {
    const a = memoryDriver();
    const b = memoryDriver();
    const fb = faulty(b);
    const driver = redundant([a, fb], {
      timeout: 200,
      circuit: { failures: 1, cooldown: 50 },
    });
    const seen = recordEvents(driver);
    await driver.set("ns", entry("old", 1));
    await driver.set("other", entry("old", 1));
    fb.setFaults({ down: true });
    // A member that fails to connect is down from the start.
    await driver.connect!();
    expect(seen.of("member-down")).toEqual([
      { driver: driver.name, index: 1, member: "faulty(memory)", failures: 1 },
    ]);
    await driver.set("ns", entry("k", 2)); // skipped: B is open, so dirty
    await driver.delete("ns", ["old"]); // skipped too
    expect(seen.of("member-dirty")).toEqual([
      {
        driver: driver.name,
        index: 1,
        member: "faulty(memory)",
        op: "set",
        reason: "down",
      },
    ]);
    // B still holds the value the primary deleted.
    expect(await byteOn(b, "ns", "old")).toBe(1);
    fb.setFaults({});
    await Bun.sleep(60);
    await driver.get("ns", "k"); // the operation that starts the probe
    await waitFor("member-up", () => seen.of("member-up").length > 0);
    expect(seen.of("member-up")[0]).toEqual({
      driver: driver.name,
      index: 1,
      member: "faulty(memory)",
      cleared: true,
    });
    // Emptied in every namespace the combinator wrote to.
    expect(await byteOn(b, "ns", "old")).toBeUndefined();
    expect(await byteOn(b, "other", "old")).toBeUndefined();
    // And back in service.
    await driver.set("ns", entry("k3", 3));
    expect(await byteOn(b, "ns", "k3")).toBe(3);
  });

  test("a member that was down but missed nothing rejoins as it is", async () => {
    const a = memoryDriver();
    const b = memoryDriver();
    const fb = faulty(b);
    const driver = redundant([a, fb], {
      timeout: 200,
      read: "race",
      circuit: { failures: 1, cooldown: 50 },
    });
    const seen = recordEvents(driver);
    await driver.set("ns", entry("kept", 1));
    fb.setFaults({ down: true });
    await driver.get("ns", "kept"); // a read fails: down, not dirty
    expect(seen.of("member-down").length).toBe(1);
    fb.setFaults({});
    await Bun.sleep(60);
    await driver.get("ns", "kept");
    await waitFor("member-up", () => seen.of("member-up").length > 0);
    expect(seen.of("member-up")[0]!.cleared).toBe(false);
    expect(seen.of("member-dirty")).toEqual([]);
    expect(await byteOn(b, "ns", "kept")).toBe(1);
  });

  test("connect: only every member failing rejects", async () => {
    const driver = redundant([
      faulty(memoryDriver(), { down: true }),
      faulty(memoryDriver(), { down: true }),
    ]);
    await expect(driver.connect!()).rejects.toThrow(/no member connected/);
  });

  test("a probe that fails keeps the member out for another cooldown", async () => {
    const a = memoryDriver();
    const fb = faulty(memoryDriver(), { down: true });
    const driver = redundant([a, fb], {
      timeout: 200,
      circuit: { failures: 1, cooldown: 30 },
    });
    const seen = recordEvents(driver);
    await driver.set("ns", entry("k", 1));
    await Bun.sleep(40);
    await driver.get("ns", "k"); // probe, which fails
    await Bun.sleep(5);
    expect(seen.of("member-up")).toEqual([]);
    expect(redundantDriverState(driver)[1]!.up).toBe(false);
  });
});

describe("redundant(): counters and locks on the primary only (§5.3)", () => {
  test("with the primary down, increment and the lock refuse and never fail over", async () => {
    const a = memoryDriver();
    const fa = faulty(a);
    const b = memoryDriver();
    const driver = redundant([fa, b], {
      timeout: 200,
      circuit: { failures: 1, cooldown: 60_000 },
    });
    const cache = createCache({ driver, sweepInterval: 0, bus: false });
    expect(await cache.increment("hits")).toBe(1);
    const { namespace, key } = cache.describeKey("hits");
    expect((await a.getCounter!(namespace, key))?.value).toBe(1);
    expect(await b.getCounter!(namespace, key)).toBeUndefined();
    expect(driver.capabilities.atomicIncrement).toBe(true);
    expect(driver.capabilities.lock).toBe(true);

    fa.setFaults({ down: true });
    await driver.get("ns", "x"); // opens the primary's circuit
    expect(redundantDriverState(driver)[0]!.up).toBe(false);
    expect(driver.capabilities.atomicIncrement).toBe(false);
    expect(driver.capabilities.lock).toBe(false);
    // The driver refuses.
    await expect(driver.increment!("ns", "c", 1, null)).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    await expect(
      driver.acquireLock!("ns", "l", "me", 1_000),
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(driver.releaseLock!("ns", "l", "me")).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    expect(await driver.getCounter!(namespace, key)).toBeUndefined();
    // So does the cache, as it is, and nothing reached the secondary.
    await expect(cache.increment("hits")).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    expect(await b.getCounter!(namespace, key)).toBeUndefined();
    expect(await cache.get("hits")).toBeUndefined();
    // A getOrSet with a lock falls back to the in-process single-flight
    // rather than waiting out a lock it cannot take.
    let loads = 0;
    const started = Date.now();
    const [one, two] = await Promise.all([
      cache.getOrSet("locked", () => ++loads, { lock: true }),
      cache.getOrSet("locked", () => ++loads, { lock: true }),
    ]);
    expect([one, two]).toEqual([1, 1]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await cache.get("locked")).toBe(1); // stored on the secondary
    await cache.close();
  });

  test("a refusal racing the capability check is thrown as it is, and never counts toward the cache's circuit", async () => {
    // A driver that advertises counters and locks but refuses them: what a
    // cache sees when the primary goes down between its capability check
    // and the call.
    const inner = memoryDriver();
    const refusing: CacheDriver = {
      ...inner,
      name: "refusing",
      capabilities: inner.capabilities,
      get: async (ns, key) => await inner.get(ns, key),
      getMany: async (ns, keys) => await inner.getMany(ns, keys),
      set: async (ns, written, fence) => await inner.set(ns, written, fence),
      setMany: async (ns, entries) => await inner.setMany(ns, entries),
      delete: async (ns, keys) => await inner.delete(ns, keys),
      clear: async (ns) => await inner.clear(ns),
      getStamps: async (ns, tags) => await inner.getStamps(ns, tags),
      setStamps: async (ns, tags, at, until) =>
        await inner.setStamps(ns, tags, at, until),
      deleteByTags: async (ns, tags, until) =>
        await inner.deleteByTags!(ns, tags, until),
      close: async () => await inner.close(),
      increment: async () => {
        throw new UnsupportedOperationError("refusing", "increment", "test");
      },
      acquireLock: async () => {
        throw new UnsupportedOperationError("refusing", "acquireLock", "test");
      },
      releaseLock: async () => true,
    };
    const cache = createCache({
      driver: refusing,
      sweepInterval: 0,
      bus: false,
      circuit: { failures: 1, cooldown: 60_000 },
    });
    const opened: unknown[] = [];
    cache.on("circuit-open", (payload) => opened.push(payload));
    await expect(cache.increment("c")).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    expect(
      await cache.getOrSet("k", () => "v", {
        lock: { wait: { timeout: 30, interval: 10 } },
      }),
    ).toBe("v");
    expect(opened).toEqual([]);
    // The cache still reads: its circuit stayed closed.
    await cache.set("x", 1);
    expect(await cache.get("x")).toBe(1);
    await cache.close();
  });
});

describe("redundant(): the gap, bounded by secondaryTtl (§5.3)", () => {
  /**
   * Two processes over the same two members: P sees B down and deletes `k`
   * on A only; Q still sees B up, and fails over to it once A is gone for Q.
   */
  async function gap(options: RedundantOptions): Promise<{
    /** What Q reads right after P's delete, with A gone for Q. */
    stale: number | undefined;
    /** What Q reads 400 ms later. */
    later: number | undefined;
  }> {
    const a = memoryDriver();
    const b = memoryDriver();
    const p = redundant([a, faulty(b, { down: true })], {
      circuit: { failures: 1, cooldown: 60_000 },
    });
    const qa = faulty(a);
    const q = redundant([qa, b], {
      circuit: { failures: 1, cooldown: 60_000 },
      ...options,
    });
    await q.set("ns", entry("k", 9, { expiresAt: Date.now() + 60_000 }));
    expect(await p.delete("ns", ["k"])).toBe(1);
    expect(await byteOn(a, "ns", "k")).toBeUndefined();
    qa.setFaults({ down: true });
    const stale = (await q.get("ns", "k"))?.value[0];
    await Bun.sleep(400);
    const later = (await q.get("ns", "k"))?.value[0];
    return { stale, later };
  }

  test("a delete that missed a member is served by another process's failover read", async () => {
    // Without secondaryTtl: for the entry's whole TTL (60 s here).
    expect(await gap({})).toEqual({ stale: 9, later: 9 });
  });

  test("secondaryTtl caps how long", async () => {
    expect(await gap({ secondaryTtl: 250 })).toEqual({
      stale: 9,
      later: undefined,
    });
  });

  test("secondaryTtl caps the secondaries only, an entry with no expiry included", async () => {
    const a = memoryDriver();
    const b = memoryDriver();
    const driver = redundant([a, b], { secondaryTtl: 1_000 });
    const before = Date.now();
    await driver.set("ns", entry("k", 1, { expiresAt: null }));
    await driver.set("ns", entry("soon", 1, { expiresAt: before + 100 }));
    expect((await a.get("ns", "k"))!.expiresAt).toBeNull();
    const capped = (await b.get("ns", "k"))!.expiresAt!;
    expect(capped).toBeGreaterThanOrEqual(before + 1_000);
    expect(capped).toBeLessThanOrEqual(Date.now() + 1_000);
    // An earlier expiry stays.
    expect((await b.get("ns", "soon"))!.expiresAt).toBe(before + 100);
    await driver.touch!("ns", "k", null);
    expect((await a.get("ns", "k"))!.expiresAt).toBeNull();
    expect((await b.get("ns", "k"))!.expiresAt).not.toBeNull();
  });
});

describe("redundant(): reads", () => {
  test("failover: a healthy primary's miss is final; with the primary down, the secondary answers", async () => {
    const a = memoryDriver();
    const fa = faulty(a);
    const b = memoryDriver();
    const driver = redundant([fa, b], {
      circuit: { failures: 1, cooldown: 60_000 },
    });
    await b.set("ns", entry("only-b", 2));
    expect(await driver.get("ns", "only-b")).toBeUndefined();
    expect(await driver.getMany("ns", ["only-b"])).toEqual([undefined]);
    fa.setFaults({ down: true });
    expect((await driver.get("ns", "only-b"))?.value[0]).toBe(2);
    expect((await driver.getMany("ns", ["x", "only-b"]))[1]?.value[0]).toBe(2);
  });

  test("failover: an entry past its expiry is a miss, and a secondary's moves on to the next", async () => {
    const a = memoryDriver();
    const fa = faulty(a, { down: true });
    // A member that returns an expired entry as it is (the contract allows
    // it: "an expired entry may be returned; the core checks").
    const expired = entry("k", 2, { expiresAt: Date.now() - 1 });
    const b = overriding(memoryDriver(), {
      get: async () => expired,
      getMany: async (_ns, keys) => keys.map(() => expired),
    });
    const c = memoryDriver();
    const driver = redundant([fa, b, c], {
      circuit: { failures: 1, cooldown: 60_000 },
    });
    await c.set("ns", entry("k", 3));
    expect((await driver.getMany("ns", ["k"]))[0]?.value[0]).toBe(3);
    expect((await driver.get("ns", "k"))?.value[0]).toBe(3);
  });

  test("race: the first hit wins, and a miss on one member does not end the race", async () => {
    const a = memoryDriver();
    const fa = faulty(a, { lagMs: 150 });
    const b = memoryDriver();
    const driver = redundant([fa, b], { read: "race", timeout: 2_000 });
    await a.set("ns", entry("both", 1));
    await b.set("ns", entry("both", 2));
    let started = Date.now();
    expect((await driver.get("ns", "both"))?.value[0]).toBe(2);
    expect(Date.now() - started).toBeLessThan(120);
    await a.set("ns", entry("only-a", 3));
    started = Date.now();
    expect((await driver.get("ns", "only-a"))?.value[0]).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    const many = await driver.getMany("ns", ["only-a", "both", "none"]);
    expect(many.map((each) => each?.value[0])).toEqual([3, 2, undefined]);
  });

  test("stamps: the newest per tag, from every healthy member, whatever the read mode", async () => {
    const a = memoryDriver();
    const b = memoryDriver();
    const driver = redundant([a, b]);
    await a.setStamps("ns", ["t", "u"], 100, Date.now() + 60_000);
    await b.setStamps("ns", ["t"], 200, Date.now() + 60_000);
    await b.setStamps("ns", ["only-b"], 50, Date.now() + 60_000);
    const stamps = await driver.getStamps("ns", ["t", "u", "only-b", "none"]);
    expect(Object.fromEntries(stamps)).toEqual({
      t: 200,
      u: 100,
      "only-b": 50,
    });
  });
});

describe("redundant(): tags", () => {
  test("index: a write any member fences is fenced, and deleted where it was stored", async () => {
    const a = memoryDriver();
    const b = memoryDriver();
    const driver = redundant([a, b]);
    // Only B saw the invalidation (as after an outage it rejoined from).
    await b.deleteByTags!("ns", ["t"], Date.now() + 60_000);
    const fence = { tags: ["t"], createdAt: Date.now() - 1_000 };
    expect(await driver.set("ns", entry("k", 1, { tags: ["t"] }), fence)).toBe(
      "fenced",
    );
    expect(await a.get("ns", "k")).toBeUndefined();
    expect(await b.get("ns", "k")).toBeUndefined();
    // Unfenced, it is stored on both.
    expect(
      await driver.set("ns", entry("k", 1, { tags: ["t"] }), {
        tags: ["t"],
        createdAt: Date.now() + 1_000,
      }),
    ).toBe("stored");
    expect(await byteOn(a, "ns", "k")).toBe(1);
    expect(await byteOn(b, "ns", "k")).toBe(1);
  });

  test('write "primary": the writer\'s stamps win, so getStamps agrees with the fence when the queue replays an invalidation a millisecond later', async () => {
    // Both members on one fake clock: the secondary's replayed
    // `deleteByTags` stamps with its own clock when the queue runs it, which
    // the gate holds until the clock has moved a millisecond.
    const clock = fakeClock();
    const a = memoryDriver({ now: clock.now });
    const b = memoryDriver({ now: clock.now });
    const gate = Promise.withResolvers<void>();
    let replayed = false;
    const gated = overriding(b, {
      deleteByTags: async (ns, tags, stampUntil) => {
        await gate.promise;
        const count = await b.deleteByTags!(ns, tags, stampUntil);
        replayed = true;
        return count;
      },
    });
    const driver = redundant([a, gated], { write: "primary" });
    const invalidatedAt = clock.now();
    await driver.deleteByTags!("ns", ["t"], invalidatedAt + 60_000);
    clock.advance(1);
    gate.resolve();
    await waitFor("the replayed invalidation", () => replayed);
    expect((await a.getStamps("ns", ["t"])).get("t")).toBe(invalidatedAt);
    expect((await b.getStamps("ns", ["t"])).get("t")).toBe(invalidatedAt + 1);
    // The kit's case: the stamp getStamps answers is the one the fence (on
    // the writer alone, under write "primary") refuses at.
    const at = (await driver.getStamps("ns", ["t"])).get("t")!;
    const fence = (createdAt: number) => ({ tags: ["t"], createdAt });
    expect(
      await driver.set("ns", entry("k", 1, { tags: ["t"] }), fence(at)),
    ).toBe("fenced");
    expect(await driver.get("ns", "k")).toBeUndefined();
    expect(at).toBe(invalidatedAt);
    expect(
      await driver.set("ns", entry("k", 1, { tags: ["t"] }), fence(at + 1)),
    ).toBe("stored");
    expect(await byteOn(a, "ns", "k")).toBe(1);
    await driver.close();
  });

  test('write "primary": a stamp only another member holds still counts, and with the first member down the next one\'s stamps win', async () => {
    const a = memoryDriver();
    const fa = faulty(a);
    const b = memoryDriver();
    const c = memoryDriver();
    const driver = redundant([fa, b, c], {
      write: "primary",
      circuit: { failures: 1, cooldown: 60_000 },
    });
    const until = Date.now() + 60_000;
    // The writer's own stamp wins over later copies; a tag only the others
    // hold (one A lost by rejoining empty) takes their newest.
    await a.setStamps("ns", ["t"], 100, until);
    await b.setStamps("ns", ["t"], 150, until);
    await c.setStamps("ns", ["t"], 200, until);
    await b.setStamps("ns", ["only-bc"], 50, until);
    await c.setStamps("ns", ["only-bc"], 60, until);
    let stamps = await driver.getStamps("ns", ["t", "only-bc", "none"]);
    expect(Object.fromEntries(stamps)).toEqual({ t: 100, "only-bc": 60 });
    // With A down, B takes the writes and the fence: its stamps win.
    fa.setFaults({ down: true });
    await driver.get("ns", "x"); // opens A's circuit
    stamps = await driver.getStamps("ns", ["t", "only-bc"]);
    expect(Object.fromEntries(stamps)).toEqual({ t: 150, "only-bc": 50 });
  });

  test('write "primary", encrypted: a value loaded during the replication lag after an invalidation is kept, not reloaded', async () => {
    // An encrypted cache checks the tags' stamps on every read (the
    // encryption plan's §4.3), so a stamp later than the fence's would hide
    // a value the fence let through.
    const clock = fakeClock();
    const a = memoryDriver({ now: clock.now });
    const b = memoryDriver({ now: clock.now });
    const gate = Promise.withResolvers<void>();
    let replayed = false;
    const gated = overriding(b, {
      deleteByTags: async (ns, tags, stampUntil) => {
        await gate.promise;
        const count = await b.deleteByTags!(ns, tags, stampUntil);
        replayed = true;
        return count;
      },
    });
    const driver = redundant([a, gated], { write: "primary" });
    const options = {
      driver,
      now: clock.now,
      encrypt: { keys: [{ id: "k", key: new Uint8Array(32).fill(1) }] },
      sweepInterval: 0,
      bus: false,
    } as const;
    const writer = createCache(options);
    await writer.set("k", "old", { tags: ["t"] });
    clock.advance(5);
    await writer.invalidateTags(["t"]);
    clock.advance(1);
    let loads = 0;
    /** A loader that counts its calls. */
    const loader = (value: string) => () => {
      loads++;
      return value;
    };
    await writer.getOrSet("k", loader("fresh"), { tags: ["t"] });
    // The secondary replays the invalidation later (a backlog, a remote
    // member), stamping it with the clock of then.
    clock.advance(50);
    gate.resolve();
    await waitFor("the replayed invalidation", () => replayed);
    // Another process, with no stamps of its own cached, reads it.
    const reader = createCache(options);
    expect(
      await reader.getOrSet("k", loader("reloaded"), { tags: ["t"] }),
    ).toBe("fresh");
    expect(loads).toBe(1);
    await writer.close();
    await reader.close();
  });

  test("stamps (mixed members): an invalidation stamps every member, and the core's read check hides the entry on each", async () => {
    const a = memoryDriver();
    const fa = faulty(a);
    const file = fileDriver({ root: join(dir, "tags-mixed") });
    const driver = redundant([fa, file], {
      circuit: { failures: 1, cooldown: 60_000 },
    });
    const cache = createCache({ driver, sweepInterval: 0, bus: false });
    await cache.set("k", "v", { tags: ["org:1"] });
    await Bun.sleep(2);
    await cache.invalidateTags(["org:1"]);
    expect(await cache.get("k")).toBeUndefined();
    const { namespace } = cache.describeKey("k");
    expect((await a.getStamps(namespace, ["org:1"])).has("org:1")).toBe(true);
    expect((await file.getStamps(namespace, ["org:1"])).has("org:1")).toBe(
      true,
    );
    // The memory member still holds the entry (stamps mode deletes
    // nothing), and a cache reading only the file member hides it too.
    expect(await a.get(namespace, cache.describeKey("k").key)).toBeDefined();
    fa.setFaults({ down: true });
    const fresh = createCache({ driver, sweepInterval: 0, bus: false });
    expect(await fresh.get("k")).toBeUndefined();
    await cache.close();
  });
});

describe('redundant(): write "primary"', () => {
  test("replicates in the background, in order", async () => {
    const a = memoryDriver();
    const b = memoryDriver();
    const fb = faulty(b, { lagMs: 20 });
    const driver = redundant([a, fb], { write: "primary", timeout: 2_000 });
    const seen = recordEvents(driver);
    await driver.set("ns", entry("k", 1));
    await driver.set("ns", entry("k", 2));
    await driver.set("ns", entry("gone", 1));
    await driver.delete("ns", ["gone"]);
    await driver.clear("other");
    expect(await byteOn(b, "ns", "k")).toBeUndefined(); // still queued
    await waitFor(
      "the queue to drain",
      () => redundantDriverState(driver)[1]!.queued === 0,
    );
    await Bun.sleep(100);
    expect(await byteOn(b, "ns", "k")).toBe(2);
    expect(await byteOn(b, "ns", "gone")).toBeUndefined();
    expect(seen.events).toEqual([]);
  });

  test("with the first member down, the next takes the write and the first is dirty", async () => {
    const fa = faulty(memoryDriver(), { down: true });
    const b = memoryDriver();
    const driver = redundant([fa, b], {
      write: "primary",
      circuit: { failures: 1, cooldown: 60_000 },
    });
    const seen = recordEvents(driver);
    await driver.set("ns", entry("k", 1));
    expect(await byteOn(b, "ns", "k")).toBe(1);
    expect(seen.of("member-dirty")[0]).toMatchObject({
      index: 0,
      op: "set",
      reason: "failed",
    });
    expect(seen.of("member-down")[0]).toMatchObject({ index: 0 });
  });

  test("a full queue drops the write for that member, which is marked dirty and emptied", async () => {
    const a = memoryDriver();
    const b = memoryDriver();
    const fb = faulty(b, { lagMs: 40 });
    const driver = redundant([a, fb], {
      write: "primary",
      maxQueue: 5,
      timeout: 2_000,
    });
    const seen = recordEvents(driver);
    await driver.set("ns", entry("pre", 1));
    await Bun.sleep(80);
    expect(await byteOn(b, "ns", "pre")).toBe(1);
    for (let index = 0; index < 20; index++) {
      await driver.set("ns", entry(`k${index}`, 1));
    }
    expect(seen.of("member-dirty")).toEqual([
      {
        driver: driver.name,
        index: 1,
        member: "faulty(memory)",
        op: "set",
        reason: "overflow",
      },
    ]);
    await waitFor("member-up", () => seen.of("member-up").length > 0);
    expect(seen.of("member-up")[0]!.cleared).toBe(true);
    expect(await byteOn(b, "ns", "pre")).toBeUndefined();
    // The primary has every write.
    for (let index = 0; index < 20; index++) {
      expect(await byteOn(a, "ns", `k${index}`)).toBe(1);
    }
  });

  test("close() drains the queue first", async () => {
    const a = memoryDriver();
    const b = memoryDriver();
    const writes: string[] = [];
    const fb = faulty(b, { lagMs: 30 });
    const recording = overriding(fb, {
      setMany: async (ns, entries) => {
        await fb.setMany(ns, entries);
        writes.push(...entries.map((each) => each.key));
      },
    });
    const driver = redundant([a, recording], { write: "primary" });
    await driver.set("ns", entry("k", 1));
    await driver.close();
    expect(writes).toEqual(["k"]);
  });
});

describe("redundant(): member events reach cache.on", () => {
  test("member-dirty, member-down and member-up, each with the member's index and name", async () => {
    const fb = faulty(memoryDriver());
    const driver = redundant([memoryDriver(), fb], {
      timeout: 200,
      circuit: { failures: 1, cooldown: 30 },
    });
    const cache = createCache({ driver, sweepInterval: 0, bus: false });
    const got: string[] = [];
    cache.on("member-down", (payload) =>
      got.push(`down ${payload.index} ${payload.member} ${payload.failures}`),
    );
    cache.on("member-dirty", (payload) =>
      got.push(`dirty ${payload.index} ${payload.op} ${payload.reason}`),
    );
    cache.on("member-up", (payload) =>
      got.push(`up ${payload.index} ${payload.member} ${payload.cleared}`),
    );
    fb.setFaults({ down: true });
    await cache.set("k", 1);
    fb.setFaults({});
    await Bun.sleep(40);
    await cache.get("k");
    await waitFor("member-up", () => got.some((each) => each.startsWith("up")));
    expect(got).toEqual([
      "down 1 faulty(memory) 1",
      "dirty 1 set failed",
      "up 1 faulty(memory) true",
    ]);
    await cache.close();
  });
});
