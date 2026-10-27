/**
 * `runCacheDriverConformance` (plan §6.2): the contract every cache driver
 * keeps, as a `bun:test` suite. A custom driver runs it in its own tests:
 *
 * ```ts
 * import { runCacheDriverConformance } from "@kingsleyweb/bun-cache/testing";
 *
 * await runCacheDriverConformance("my-driver", async () => {
 *   const driver = myDriver({ ... });
 *   return { driver, cleanup: () => driver.close() };
 * });
 * ```
 *
 * Each case is gated on the driver's `capabilities`: an advertised capability
 * that fails its case fails the suite; one the driver does not advertise is
 * reported as skipped, with its name. The suite never touches a namespace
 * outside its own (each case gets a fresh one).
 *
 * The factory is awaited before the suite registers, so the capabilities the
 * cases gate on are the driver's own. Await the call at the test file's top
 * level, as above.
 */
import { afterAll, describe, expect, test } from "bun:test";
import process from "node:process";
import type { BusMessage, CacheDriver, StoredEntry } from "../core/types";

/** What the factory answers: the driver, and an optional cleanup run once after the suite. */
export interface ConformanceInstance {
  /** The driver under test. */
  driver: CacheDriver;
  /** Run once after the suite; closes clients, removes files. */
  cleanup?: () => unknown | Promise<unknown>;
}

/** The driver's factory; awaited once, before the suite registers. */
export type ConformanceFactory = () =>
  ConformanceInstance | Promise<ConformanceInstance>;

/** `runCacheDriverConformance`'s options. */
export interface ConformanceOptions {
  /**
   * The largest entry the round-trip case writes, in bytes. Defaults to the
   * driver's advertised `capabilities.maxEntryBytes`, capped at 1 MiB.
   */
  maxEntryBytes?: number;
  /**
   * How the two-process pass builds the same driver in a child process
   * (§6.2): the child imports `module`, calls its `export` with `options`,
   * and must get a driver on the same backend. Required when the driver
   * advertises `multiProcess`; a `multiProcess: true` claim without it fails
   * the pass rather than skipping it.
   */
  crossProcess?: ConformanceCrossProcess;
  /**
   * Forces a gap in a polled bus's log (a compaction, a truncation). Required
   * when the driver advertises `bus: "poll"`; the bus-gap case fails without
   * it.
   */
  busGap?: () => unknown | Promise<unknown>;
  /** Cases to skip, each with a reason printed in the skip line. */
  skip?: readonly {
    /** The case id, e.g. `"increment"`. */
    id: string;
    /** Why, for the report. */
    reason: string;
  }[];
}

/** How the kit's two-process pass builds the driver's twin in a child process. */
export interface ConformanceCrossProcess {
  /** The absolute path of the module the child imports for the factory. */
  module: string;
  /** The export the factory lives under; defaults to `"default"`. */
  export?: string;
  /** The options the child passes to the factory — the same backend as the driver's. */
  options?: unknown;
}

/** Deterministic bytes of `size`, cycling every byte value. */
function bytesOf(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let index = 0; index < size; index++) {
    out[index] = index % 256;
  }
  return out;
}

/** An entry for the kit. */
function entry(
  key: string,
  size: number,
  init: Partial<Pick<StoredEntry, "expiresAt" | "tags">> = {},
): StoredEntry {
  return {
    key,
    value: bytesOf(size),
    expiresAt: init.expiresAt ?? null,
    tags: init.tags ?? [],
  };
}

/** Waits for `ms` of real time. */
async function wait(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

/** Waits until `condition` holds, checking every 10 ms; throws after `timeoutMs`. */
async function waitFor(
  what: string,
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await wait(10);
  }
}

/** The kit's cross-process cases: the child side, spawned with the job. */
async function spawnWorker(job: {
  /** The harness the caller gave the kit. */
  harness: ConformanceCrossProcess;
  /** What to do. */
  op: "increment" | "lock" | "stamps";
  /** The namespace to work in. */
  ns: string;
  /** The key (increment, lock). */
  key?: string;
  /** The tag (stamps). */
  tag?: string;
  /** How many increments or lock attempts. */
  count?: number;
  /** The owner prefix (lock). */
  ownerPrefix?: string;
}): Promise<{ results?: number[]; acquired?: number; winners?: string[] }> {
  const workerPath = new URL("./crossprocess-worker.ts", import.meta.url)
    .pathname;
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      workerPath,
      JSON.stringify({
        module: job.harness.module,
        export: job.harness.export,
        options: job.harness.options,
        op: job.op,
        ns: job.ns,
        key: job.key,
        tag: job.tag,
        count: job.count,
        ownerPrefix: job.ownerPrefix,
      }),
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `the cross-process worker exited ${exitCode}: ${stderr.trim()}`,
    );
  }
  return JSON.parse(stdout) as {
    results?: number[];
    acquired?: number;
    winners?: string[];
  };
}

/**
 * Runs the conformance suite for a driver. See the module header. Await it at
 * a test file's top level.
 */
export async function runCacheDriverConformance(
  name: string,
  factory: ConformanceFactory,
  options: ConformanceOptions = {},
): Promise<void> {
  const skipped = new Map(
    (options.skip ?? []).map((entry) => [entry.id, entry.reason] as const),
  );
  const instance = await factory();
  const { driver } = instance;

  describe(`runCacheDriverConformance: ${name}`, () => {
    let serial = 0;

    /** A fresh namespace per case, so cases never share data. */
    const ns = (): string => `kit-${process.pid}-${Date.now()}-${++serial}`;

    afterAll(async () => {
      await instance.cleanup?.();
    });

    /**
     * Registers a case, or its visible skip: a capability the driver does not
     * advertise, or a case the caller named in `options.skip`.
     */
    function kase(
      id: string,
      title: string,
      advertised: boolean,
      run: () => void | Promise<void>,
    ): void {
      const reason = skipped.get(id);
      if (reason !== undefined) {
        test.skip(`${title} — skipped: ${reason}`, () => {});
        return;
      }
      if (!advertised) {
        test.skip(`${title} — skipped: not advertised in capabilities`, () => {});
        return;
      }
      test(title, run);
    }

    const maxEntryBytes = Math.min(
      options.maxEntryBytes ??
        driver.capabilities.maxEntryBytes ??
        Number.POSITIVE_INFINITY,
      1024 * 1024,
    );

    kase("round-trip", "round-trips bytes of every size", true, async () => {
      const namespace = ns();
      const sizes = [0, 1, 63, 4096, 65_536, maxEntryBytes]
        .filter(
          (size, index, all) =>
            Number.isFinite(size) && all.indexOf(size) === index,
        )
        .sort((a, b) => a - b);
      for (const size of sizes) {
        const written = entry(`k-${size}`, size, {
          expiresAt: Date.now() + 60_000,
          tags: ["a", "b"],
        });
        expect(await driver.set(namespace, written)).toBe("stored");
        const read = await driver.get(namespace, written.key);
        expect(read).toBeDefined();
        expect(read!.value).toEqual(written.value);
        expect(read!.expiresAt).toBe(written.expiresAt);
        expect([...read!.tags].sort()).toEqual(["a", "b"]);
      }
    });

    kase("miss", "reads an unknown key as undefined", true, async () => {
      expect(await driver.get(ns(), "never-written")).toBeUndefined();
    });

    kase(
      "overwrite",
      "a second set replaces the value and the tags",
      true,
      async () => {
        const namespace = ns();
        await driver.set(namespace, entry("k", 10, { tags: ["old"] }));
        await driver.set(namespace, entry("k", 20, { tags: ["new"] }));
        const read = await driver.get(namespace, "k");
        expect(read!.value).toEqual(bytesOf(20));
        expect(read!.tags).toEqual(["new"]);
      },
    );

    kase("expiry.lazy", "an expired entry reads as a miss", true, async () => {
      const namespace = ns();
      await driver.set(
        namespace,
        entry("k", 10, { expiresAt: Date.now() - 1_000 }),
      );
      expect(await driver.get(namespace, "k")).toBeUndefined();
    });

    kase("expiry.never", "an entry with no expiry survives", true, async () => {
      const namespace = ns();
      await driver.set(namespace, entry("k", 10, { expiresAt: null }));
      const read = await driver.get(namespace, "k");
      expect(read).toBeDefined();
      expect(read!.expiresAt).toBeNull();
    });

    kase(
      "expiry.sweep",
      "sweep reclaims expired entries and keeps live ones",
      driver.sweep !== undefined,
      async () => {
        const namespace = ns();
        await driver.set(
          namespace,
          entry("dead", 10, { expiresAt: Date.now() - 1_000 }),
        );
        await driver.set(
          namespace,
          entry("live", 10, { expiresAt: Date.now() + 60_000 }),
        );
        const removed = await driver.sweep!(Date.now(), 1_000);
        expect(removed).toBeGreaterThanOrEqual(1);
        expect((await driver.get(namespace, "live"))?.value).toEqual(
          bytesOf(10),
        );
      },
    );

    kase(
      "getMany",
      "getMany answers in the keys' order, with holes",
      true,
      async () => {
        const namespace = ns();
        await driver.set(namespace, entry("a", 11));
        await driver.set(namespace, entry("b", 22));
        const out = await driver.getMany(namespace, ["a", "missing", "b"]);
        expect(out.length).toBe(3);
        expect(out[0]?.value).toEqual(bytesOf(11));
        expect(out[1]).toBeUndefined();
        expect(out[2]?.value).toEqual(bytesOf(22));
      },
    );

    kase("delete", "delete counts what it removed", true, async () => {
      const namespace = ns();
      await driver.setMany(namespace, [
        entry("a", 5),
        entry("b", 5),
        entry("c", 5),
      ]);
      expect(await driver.delete(namespace, ["a", "b", "missing"])).toBe(2);
      expect(await driver.get(namespace, "a")).toBeUndefined();
      expect((await driver.get(namespace, "c"))?.value).toEqual(bytesOf(5));
    });

    kase("clear", "clear empties its namespace only", true, async () => {
      const mine = ns();
      const neighbour = ns();
      await driver.set(mine, entry("k", 5, { tags: ["t"] }));
      await driver.set(neighbour, entry("k", 7));
      await driver.clear(mine);
      expect(await driver.get(mine, "k")).toBeUndefined();
      expect((await driver.get(neighbour, "k"))?.value).toEqual(bytesOf(7));
      if (
        driver.capabilities.tags === "index" &&
        driver.deleteByTags !== undefined
      ) {
        // The cleared namespace's tag index went with it.
        expect(
          await driver.deleteByTags(mine, ["t"], Date.now() + 60_000),
        ).toBe(0);
      }
    });

    kase(
      "touch",
      "touch extends an entry's expiry and reports misses",
      driver.touch !== undefined,
      async () => {
        const namespace = ns();
        expect(await driver.touch!(namespace, "missing", null)).toBe(false);
        await driver.set(
          namespace,
          entry("k", 5, { expiresAt: Date.now() + 100 }),
        );
        expect(await driver.touch!(namespace, "k", null)).toBe(true);
        expect((await driver.get(namespace, "k"))?.expiresAt).toBeNull();
      },
    );

    kase(
      "tags.index",
      'tags: "index" deletes by tag across shared keys',
      driver.capabilities.tags === "index",
      async () => {
        const namespace = ns();
        expect(typeof driver.deleteByTags).toBe("function");
        await driver.set(namespace, entry("k1", 5, { tags: ["a"] }));
        await driver.set(namespace, entry("k2", 5, { tags: ["a", "b"] }));
        await driver.set(namespace, entry("k3", 5));
        const removed = await driver.deleteByTags!(
          namespace,
          ["a"],
          Date.now() + 60_000,
        );
        expect(removed).toBe(2);
        expect(await driver.get(namespace, "k1")).toBeUndefined();
        expect(await driver.get(namespace, "k2")).toBeUndefined();
        expect((await driver.get(namespace, "k3"))?.value).toEqual(bytesOf(5));
      },
    );

    kase(
      "tags.index.stamps",
      'tags: "index" writes a stamp per invalidated tag',
      driver.capabilities.tags === "index",
      async () => {
        const namespace = ns();
        expect(typeof driver.deleteByTags).toBe("function");
        const before = Date.now();
        await driver.deleteByTags!(namespace, ["x"], Date.now() + 60_000);
        const stamps = await driver.getStamps(namespace, ["x", "unset"]);
        expect(stamps.get("x")).toBeGreaterThanOrEqual(before);
        expect(stamps.has("unset")).toBe(false);
      },
    );

    kase(
      "tags.index.fence",
      "the fence refuses a write older than its tag's stamp",
      driver.capabilities.tags === "index",
      async () => {
        const namespace = ns();
        expect(typeof driver.deleteByTags).toBe("function");
        await driver.deleteByTags!(namespace, ["t"], Date.now() + 60_000);
        // A load that started before the invalidation is refused.
        const stale = await driver.set(
          namespace,
          entry("k", 5, { tags: ["t"] }),
          { tags: ["t"], createdAt: Date.now() - 60_000 },
        );
        expect(stale).toBe("fenced");
        expect(await driver.get(namespace, "k")).toBeUndefined();
        // One that started after it is stored. (The fence counts a stamp at
        // the load's own millisecond as newer — Date.now() cannot order two
        // events within one ms — so the fresh load starts a tick later.)
        await wait(2);
        const fresh = await driver.set(
          namespace,
          entry("k", 5, { tags: ["t"] }),
          { tags: ["t"], createdAt: Date.now() },
        );
        expect(fresh).toBe("stored");
      },
    );

    kase(
      "tags.stamps",
      'tags: "stamps" round-trips stamps and leaves entries to the core\'s read check',
      driver.capabilities.tags === "stamps",
      async () => {
        const namespace = ns();
        const at = Date.now();
        await driver.setStamps(namespace, ["t"], at, at + 60_000);
        expect((await driver.getStamps(namespace, ["t"])).get("t")).toBe(at);
        // An expired stamp reads as absent.
        await driver.setStamps(namespace, ["old"], at - 120_000, at - 60_000);
        expect((await driver.getStamps(namespace, ["old"])).has("old")).toBe(
          false,
        );
        // The driver does not delete invalidated entries itself: the core's
        // read-side check does the invalidating (§3.6).
        await driver.set(namespace, entry("k", 5, { tags: ["t"] }));
        expect(await driver.get(namespace, "k")).toBeDefined();
      },
    );

    kase(
      "increment",
      "increment is atomic under 200 concurrent callers",
      driver.capabilities.atomicIncrement,
      async () => {
        const namespace = ns();
        expect(typeof driver.increment).toBe("function");
        const results = await Promise.all(
          Array.from(
            { length: 200 },
            async () => await driver.increment!(namespace, "counter", 1, null),
          ),
        );
        expect(new Set(results).size).toBe(200);
        expect(Math.max(...results)).toBe(200);
        expect(Math.min(...results)).toBe(1);
      },
    );

    kase(
      "increment.ttl",
      "a counter's expiry is set at creation only",
      driver.capabilities.atomicIncrement,
      async () => {
        const namespace = ns();
        expect(typeof driver.increment).toBe("function");
        expect(typeof driver.getCounter).toBe("function");
        const created = Date.now() + 60_000;
        await driver.increment!(namespace, "c", 1, created);
        await driver.increment!(namespace, "c", 1, Date.now() + 3_600_000);
        const counter = await driver.getCounter!(namespace, "c");
        expect(counter?.value).toBe(2);
        expect(counter?.expiresAt).toBe(created);
      },
    );

    kase(
      "lock",
      "a lock contended by 50 callers is taken exactly once, and lapses",
      driver.capabilities.lock,
      async () => {
        const namespace = ns();
        expect(typeof driver.acquireLock).toBe("function");
        expect(typeof driver.releaseLock).toBe("function");
        const outcomes = await Promise.all(
          Array.from({ length: 50 }, (_, index) =>
            driver.acquireLock!(namespace, "k", `owner-${index}`, 30_000),
          ),
        );
        expect(outcomes.filter(Boolean).length).toBe(1);
        const winner = `owner-${outcomes.findIndex(Boolean)}`;
        // Only the owner releases.
        expect(await driver.releaseLock!(namespace, "k", "owner-nobody")).toBe(
          false,
        );
        expect(await driver.releaseLock!(namespace, "k", winner)).toBe(true);
        // And then another caller takes it.
        expect(await driver.acquireLock!(namespace, "k", "next", 30_000)).toBe(
          true,
        );
        // A lock lapses at its TTL.
        await driver.acquireLock!(namespace, "short", "owner", 20);
        await wait(40);
        expect(
          await driver.acquireLock!(namespace, "short", "other", 30_000),
        ).toBe(true);
      },
    );

    kase(
      "bus",
      "a published message reaches a subscriber; an unsubscribed one does not",
      driver.capabilities.bus !== "none" &&
        driver.publish !== undefined &&
        driver.subscribe !== undefined,
      async () => {
        const received: BusMessage[] = [];
        const unsubscribe = await driver.subscribe!(
          (message) => {
            received.push(message);
          },
          () => {},
        );
        const message: BusMessage = {
          type: "delete",
          namespace: ns(),
          keys: ["k"],
          at: Date.now(),
        };
        await driver.publish!(message);
        await waitFor("the published message", () => received.length === 1);
        expect(received).toEqual([message]);
        await unsubscribe();
        await driver.publish!({ ...message, at: Date.now() });
        await wait(300);
        expect(received.length).toBe(1);
      },
    );

    kase(
      "multiprocess.increment",
      "two processes increment the same counter exactly",
      driver.capabilities.multiProcess && driver.capabilities.atomicIncrement,
      async () => {
        const harness = options.crossProcess;
        expect(
          harness,
          "the driver advertises multiProcess: give the kit `crossProcess` ({ module, export, options }) so the pass can spawn a second process",
        ).toBeDefined();
        const namespace = ns();
        const child = spawnWorker({
          harness: harness!,
          op: "increment",
          ns: namespace,
          key: "c",
          count: 100,
        });
        const mine = await Promise.all(
          Array.from(
            { length: 100 },
            async () => await driver.increment!(namespace, "c", 1, null),
          ),
        );
        const theirs = await child;
        const all = [...mine, ...(theirs.results ?? [])];
        expect(new Set(all).size).toBe(200);
        expect(Math.max(...all)).toBe(200);
        expect(Math.min(...all)).toBe(1);
      },
    );

    kase(
      "multiprocess.lock",
      "two processes contending a lock take it exactly once",
      driver.capabilities.multiProcess && driver.capabilities.lock,
      async () => {
        const harness = options.crossProcess;
        expect(
          harness,
          "the driver advertises multiProcess: give the kit `crossProcess` ({ module, export, options }) so the pass can spawn a second process",
        ).toBeDefined();
        const namespace = ns();
        const child = spawnWorker({
          harness: harness!,
          op: "lock",
          ns: namespace,
          key: "k",
          count: 25,
          ownerPrefix: "c-",
        });
        const mine = await Promise.all(
          Array.from({ length: 25 }, (_, index) =>
            driver.acquireLock!(namespace, "k", `p-${index}`, 60_000),
          ),
        );
        const theirs = await child;
        expect(mine.filter(Boolean).length + (theirs.acquired ?? 0)).toBe(1);
        // Release whoever won, by every name tried on either side.
        for (let index = 0; index < 25; index++) {
          await driver.releaseLock!(namespace, "k", `p-${index}`);
          await driver.releaseLock!(namespace, "k", `c-${index}`);
        }
      },
    );

    kase(
      "multiprocess.stamps",
      "a stamp written by another process is visible here",
      driver.capabilities.multiProcess,
      async () => {
        const harness = options.crossProcess;
        expect(
          harness,
          "the driver advertises multiProcess: give the kit `crossProcess` ({ module, export, options }) so the pass can spawn a second process",
        ).toBeDefined();
        const namespace = ns();
        const tag = `tag-${process.pid}`;
        await spawnWorker({
          harness: harness!,
          op: "stamps",
          ns: namespace,
          tag,
        });
        const stamps = await driver.getStamps(namespace, [tag]);
        expect(stamps.has(tag)).toBe(true);
      },
    );

    kase(
      "bus.gap",
      "a gap in the polled log is signalled to subscribers",
      driver.capabilities.bus === "poll",
      async () => {
        const gap = options.busGap;
        expect(
          gap,
          "the driver advertises a polled bus: give the kit `busGap` (a function that forces a gap in its log)",
        ).toBeDefined();
        let gaps = 0;
        const unsubscribe = await driver.subscribe!(
          () => {},
          () => {
            gaps++;
          },
        );
        await gap!();
        await waitFor("the gap to be signalled", () => gaps > 0);
        await unsubscribe();
      },
    );
  });
}
