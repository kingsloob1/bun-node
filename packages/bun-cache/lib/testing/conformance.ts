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
import { Buffer } from "node:buffer";
import process from "node:process";
import { createCache } from "../core/cache";
import type {
  BusMessage,
  Cache,
  CacheDriver,
  CacheEncryptOptions,
  StoredEntry,
} from "../core/types";

/** What the factory answers: the driver, and an optional cleanup run once after the suite. */
export interface ConformanceInstance {
  /** The driver under test. */
  driver: CacheDriver;
  /** Run once after the suite; closes clients, removes files. */
  cleanup?: () => unknown | Promise<unknown>;
  /**
   * Every byte the driver has stored, raw: rows, key names, objects, files,
   * the bus — read straight from the backend, around the driver. A string
   * chunk is scanned as its UTF-8. With it, the kit's at-rest case writes
   * sentinel keys, namespaces, tags and values through a cache with
   * `encrypt` and `hashNames`, and fails if the dump shows any of them, in
   * UTF-8 or UTF-16. It first proves the dump sees the store: a plain
   * cache's value and namespace must be found in it. Without it the case is
   * reported as skipped.
   */
  rawDump?: () =>
    | readonly (Uint8Array | string)[]
    | Promise<readonly (Uint8Array | string)[]>;
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
   * Forces a gap in the driver's bus: on a polled bus, a stretch of its log
   * the subscriber never sees (a compaction, a truncation); on a pushed bus,
   * a dropped subscriber connection (Redis: `CLIENT KILL` of it), since
   * whatever is published while it reconnects is lost. Required when the
   * driver advertises `bus: "poll"`, where the bus-gap case fails without it;
   * optional for `bus: "push"`, where giving it runs the case (MongoDB:
   * the bus collection dropped under the subscriber; Postgres: its `LISTEN`
   * backend terminated).
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

/**
 * How long {@link waitFor} waits by default, in ms: the bound on a bus
 * delivery or a gap's signal, a reconnect included (Redis: about a second
 * after `CLIENT KILL`).
 */
const WAIT_FOR_MS = 5_000;

/**
 * The bound of a case that waits with {@link waitFor}, in ms: its wait's
 * {@link WAIT_FOR_MS}, plus the subscribe, the publishes or the forced gap,
 * and the 300 ms quiet check around it, with room for a loaded machine. It
 * must outlast the wait by more than the rest of the case takes, so a message
 * that never comes fails the case with `waitFor`'s own message. At bun:test's
 * default 5 s, equal to the wait, the case timed out first and the wait's
 * error landed after it, as an unhandled error between tests.
 */
const WAITING_CASE_TIMEOUT_MS = 15_000;

/** Waits until `condition` holds, checking every 10 ms; throws after `timeoutMs` (default {@link WAIT_FOR_MS}), inside a case bounded by {@link WAITING_CASE_TIMEOUT_MS}. */
async function waitFor(
  what: string,
  condition: () => boolean,
  timeoutMs = WAIT_FOR_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await wait(10);
  }
}

/** What a cross-process worker answers. */
interface WorkerResult {
  /** The values its increments answered (`increment`). */
  results?: number[];
  /** How many of its lock attempts won (`lock`). */
  acquired?: number;
  /** The owners whose attempts won (`lock`). */
  winners?: string[];
}

/** A started cross-process worker, waiting at the start barrier. */
interface WorkerHandle {
  /** Releases the barrier: the worker starts its operation now. */
  go: () => void;
  /** The worker's answer, once it has finished and exited. */
  result: Promise<WorkerResult>;
}

/**
 * Spawns the kit's cross-process worker with a job and waits until it is
 * **ready** — its driver built and connected — at the start barrier. The
 * caller releases it with `go()` and starts its own side in the same tick, so
 * the two processes genuinely overlap.
 *
 * The barrier is load-bearing: without it, a fast driver (SQLite: ~10 µs an
 * increment) finished the parent's whole side while the child was still
 * starting (~50 ms), and the two-process case passed against an increment
 * that was a plain read-then-write with no transaction (measured, PR-C3).
 */
async function startWorker(job: {
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
}): Promise<WorkerHandle> {
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
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  /** The worker's next stdout line; `undefined` once it has closed stdout. */
  const nextLine = async (): Promise<string | undefined> => {
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        return line;
      }
      const { done, value } = await reader.read();
      if (done) {
        const rest = buffered;
        buffered = "";
        return rest === "" ? undefined : rest;
      }
      buffered += decoder.decode(value, { stream: true });
    }
  };
  /** Throws the worker's failure, with its stderr. */
  const failed = async (): Promise<never> => {
    void child.stdin.end();
    const exitCode = await child.exited;
    throw new Error(
      `the cross-process worker exited ${exitCode}: ${(await stderr).trim()}`,
    );
  };
  const ready = await nextLine();
  if (
    ready === undefined ||
    (JSON.parse(ready) as { ready?: boolean }).ready !== true
  ) {
    return await failed();
  }
  return {
    go: () => {
      void child.stdin.write("go\n");
      void child.stdin.end();
    },
    result: (async () => {
      const line = await nextLine();
      const exitCode = await child.exited;
      if (exitCode !== 0 || line === undefined) {
        return await failed();
      }
      return JSON.parse(line) as WorkerResult;
    })(),
  };
}

/**
 * How long a case that starts a second process may take, ms. Most of it is
 * the worker's start (a fresh `bun`, the driver's module, a connection):
 * well under a second on a quiet machine, but past bun:test's default 5 s
 * with the machine's load at 60 (measured, 8 copies of the MongoDB suite at
 * once beside other runs). Timed out, the case's worker is killed with the
 * one the next case starts, so one slow start failed the cases after it too.
 */
const CROSS_PROCESS_TIMEOUT_MS = 30_000;

/** Runs a started worker to completion right away (no side of the caller's to overlap). */
async function runWorker(
  job: Parameters<typeof startWorker>[0],
): Promise<WorkerResult> {
  const worker = await startWorker(job);
  worker.go();
  return await worker.result;
}

/**
 * `count` increments in ten waves, yielding to the event loop between them,
 * so the two sides of the two-process case interleave wave by wave instead
 * of one burst finishing before the other is scheduled. The worker runs the
 * same shape. Measured with an SQLite increment mutated into a plain
 * read-then-write (no transaction): caught 16 of 16 runs with zero-delay
 * waves, 2 of 5 with 1 ms sleeps between them, 0 without the barrier.
 */
async function incrementInWaves(
  driver: CacheDriver,
  ns: string,
  key: string,
  count: number,
): Promise<number[]> {
  const out: number[] = [];
  const perWave = Math.ceil(count / 10);
  for (let done = 0; done < count; done += perWave) {
    const wave = Math.min(perWave, count - done);
    out.push(
      ...(await Promise.all(
        Array.from(
          { length: wave },
          async () => await driver.increment!(ns, key, 1, null),
        ),
      )),
    );
    await wait(0);
  }
  return out;
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
     * advertise, or a case the caller named in `options.skip`. `timeoutMs` is
     * the case's own bound, bun:test's default (5 s) when omitted.
     */
    function kase(
      id: string,
      title: string,
      advertised: boolean,
      run: () => void | Promise<void>,
      timeoutMs?: number,
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
      test(title, run, timeoutMs);
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
        // An expiry far enough off to outlive the round trips before the
        // touch: at 100 ms, a remote server (Upstash, ~300 ms a round trip)
        // had expired the entry by then, and the touch rightly missed it.
        await driver.set(
          namespace,
          entry("k", 5, { expiresAt: Date.now() + 60_000 }),
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
        const after = Date.now();
        const stamps = await driver.getStamps(namespace, ["x", "unset"]);
        expect(stamps.get("x")).toBeGreaterThanOrEqual(before);
        // Stamped with the clock while the call ran, never later: the core's
        // `invalidateTags` waits out the millisecond it read after the call,
        // so a load that starts once it resolved is not fenced (§3.6).
        expect(stamps.get("x")).toBeLessThanOrEqual(after);
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
        const at = (await driver.getStamps(namespace, ["t"])).get("t")!;
        // A load that started before the invalidation is refused.
        const stale = await driver.set(
          namespace,
          entry("k", 5, { tags: ["t"] }),
          { tags: ["t"], createdAt: Date.now() - 60_000 },
        );
        expect(stale).toBe("fenced");
        expect(await driver.get(namespace, "k")).toBeUndefined();
        // So is one that started in the stamp's own millisecond: a stamp
        // records only the millisecond, so it cannot tell a load that began
        // before the invalidation from one that began after it, and the
        // safe side wins.
        const tie = await driver.set(
          namespace,
          entry("k", 5, { tags: ["t"] }),
          { tags: ["t"], createdAt: at },
        );
        expect(tie).toBe("fenced");
        expect(await driver.get(namespace, "k")).toBeUndefined();
        // One that started a millisecond later is stored.
        const fresh = await driver.set(
          namespace,
          entry("k", 5, { tags: ["t"] }),
          { tags: ["t"], createdAt: at + 1 },
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
        // Only this case's namespace counts. The bus is the suite's, and a
        // pushed one may deliver an earlier case's message after this
        // subscribe: one published just before, still on its way over the
        // shared subscriber connection (Redis: the raw-dump case's last
        // `clear`, which made the count 2 and the wait for exactly 1 run out).
        const namespace = ns();
        const received: BusMessage[] = [];
        const unsubscribe = await driver.subscribe!(
          (message) => {
            if (message.namespace === namespace) {
              received.push(message);
            }
          },
          () => {},
        );
        const message: BusMessage = {
          type: "delete",
          namespace,
          keys: ["k"],
          at: Date.now(),
        };
        await driver.publish!(message);
        await waitFor("the published message", () => received.length > 0);
        expect(received).toEqual([message]);
        await unsubscribe();
        await driver.publish!({ ...message, at: Date.now() });
        await wait(300);
        expect(received.length).toBe(1);
      },
      WAITING_CASE_TIMEOUT_MS,
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
        const child = await startWorker({
          harness: harness!,
          op: "increment",
          ns: namespace,
          key: "c",
          count: 100,
        });
        // Both sides start in this tick: the worker at the barrier's release.
        child.go();
        const mine = await incrementInWaves(driver, namespace, "c", 100);
        const theirs = await child.result;
        const all = [...mine, ...(theirs.results ?? [])];
        expect(new Set(all).size).toBe(200);
        expect(Math.max(...all)).toBe(200);
        expect(Math.min(...all)).toBe(1);
      },
      CROSS_PROCESS_TIMEOUT_MS,
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
        const child = await startWorker({
          harness: harness!,
          op: "lock",
          ns: namespace,
          key: "k",
          count: 25,
          ownerPrefix: "c-",
        });
        child.go();
        const mine = await Promise.all(
          Array.from({ length: 25 }, (_, index) =>
            driver.acquireLock!(namespace, "k", `p-${index}`, 60_000),
          ),
        );
        const theirs = await child.result;
        expect(mine.filter(Boolean).length + (theirs.acquired ?? 0)).toBe(1);
        // Release whoever won, by every name tried on either side.
        for (let index = 0; index < 25; index++) {
          await driver.releaseLock!(namespace, "k", `p-${index}`);
          await driver.releaseLock!(namespace, "k", `c-${index}`);
        }
      },
      CROSS_PROCESS_TIMEOUT_MS,
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
        await runWorker({
          harness: harness!,
          op: "stamps",
          ns: namespace,
          tag,
        });
        const stamps = await driver.getStamps(namespace, [tag]);
        expect(stamps.has(tag)).toBe(true);
      },
      CROSS_PROCESS_TIMEOUT_MS,
    );

    kase(
      "bus.gap",
      "a gap in the bus is signalled to subscribers",
      // A polled bus must prove it; a pushed one can, given a way to force a gap.
      driver.capabilities.bus === "poll" ||
        (driver.capabilities.bus === "push" && options.busGap !== undefined),
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
      WAITING_CASE_TIMEOUT_MS,
    );

    registerEncryptedPass({ driver, instance, options, kase });
  });
}

/** The ring the encrypted pass seals with: fixed, test-only bytes. */
const KIT_RING = [{ id: "kit", key: new Uint8Array(32).fill(0x6b) }];

/** The names key the encrypted pass hashes with: fixed, test-only bytes. */
const KIT_NAMES_KEY = new Uint8Array(32).fill(0x6e);

/** The encryption the pass's caches use. */
const KIT_ENCRYPT: CacheEncryptOptions = {
  keys: KIT_RING,
  hashNames: { key: KIT_NAMES_KEY },
};

/**
 * The driver as a cache's, whose `close()` does nothing: the pass's caches
 * share the suite's driver, which only the factory's `cleanup` closes.
 */
function unclosable(driver: CacheDriver): CacheDriver {
  return new Proxy(driver, {
    get(target, property) {
      if (property === "close") {
        return async () => {};
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** A run-unique token, so sentinels never match another case's or run's data. */
function token(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex");
}

/** Whether any chunk of a dump holds `text`, as UTF-8 or UTF-16 (LE or BE). */
function dumpHolds(
  chunks: readonly (Uint8Array | string)[],
  text: string,
): boolean {
  const utf8 = Buffer.from(text, "utf8");
  const utf16le = Buffer.from(text, "utf16le");
  const utf16be = Buffer.from(utf16le).swap16();
  return chunks.some((chunk) => {
    const bytes = Buffer.from(
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
    );
    return (
      bytes.includes(utf8) || bytes.includes(utf16le) || bytes.includes(utf16be)
    );
  });
}

/**
 * The pass with `encrypt` and `hashNames` on (the encryption plan's §11):
 * the core's every operation the driver advertises, through caches whose
 * names reach the driver only as keyed hashes and whose entries are sealed —
 * and, given `rawDump`, a scan of the backend for the plaintext.
 */
function registerEncryptedPass(context: {
  /** The suite's driver. */
  driver: CacheDriver;
  /** The factory's answer (`rawDump`). */
  instance: ConformanceInstance;
  /** The suite's options (`crossProcess`). */
  options: ConformanceOptions;
  /** The suite's case registrar. */
  kase: (
    id: string,
    title: string,
    advertised: boolean,
    run: () => void | Promise<void>,
    timeoutMs?: number,
  ) => void;
}): void {
  const { driver, instance, options, kase } = context;
  const capabilities = driver.capabilities;

  /** A cache over the suite's driver, in a fresh namespace of its own; `encrypt: null` is a plain one. */
  const open = (
    namespace = `kitenc-${process.pid}-${token()}`,
    encrypt: CacheEncryptOptions | null = KIT_ENCRYPT,
  ): Cache =>
    createCache({
      driver: unclosable(driver),
      namespace,
      sweepInterval: 0,
      bus: false,
      ...(encrypt === null ? {} : { encrypt }),
    });

  /** Runs `body` with a cache, closing it after. */
  const withCache = async (
    body: (cache: Cache) => Promise<void>,
    cache = open(),
  ): Promise<void> => {
    try {
      await body(cache);
    } finally {
      await cache.close();
    }
  };

  kase(
    "encrypted.round-trip",
    "encrypt + hashNames: values round-trip under hashed names, sealed",
    true,
    async () => {
      await withCache(async (cache) => {
        const big = "x".repeat(70_000);
        expect(await cache.set("user:1", { id: 1 }, { tags: ["org:1"] })).toBe(
          true,
        );
        expect(await cache.set("big", big)).toBe(true);
        expect(await cache.get("user:1")).toEqual({ id: 1 });
        expect(await cache.get("big")).toBe(big);
        const entry = await cache.getEntry("user:1");
        expect(entry?.tags).toEqual(["org:1"]);
        expect(await cache.getMany(["user:1", "nope"])).toEqual([
          { id: 1 },
          undefined,
        ]);
        expect(await cache.has("user:1")).toBe(true);
        // The driver holds it under the names describeKey answers, sealed.
        const described = cache.describeKey("user:1", ["org:1"]);
        expect(described.key).toMatch(/^[\da-f]{32}$/);
        const raw = await driver.get(described.namespace, described.key);
        expect(raw).toBeDefined();
        expect(Buffer.from(raw!.value.subarray(0, 2)).toString()).toBe("BE");
        expect([...raw!.tags]).toEqual(described.tags);
        expect(await cache.delete("user:1")).toBe(true);
        expect(await cache.get("user:1")).toBeUndefined();
        expect(await cache.deleteMany(["big"])).toBe(1);
        expect(await cache.get("big")).toBeUndefined();
      });
    },
  );

  kase(
    "encrypted.names",
    "encrypt + hashNames: another names key, or none, sees nothing",
    true,
    async () => {
      const namespace = `kitenc-${process.pid}-${token()}`;
      const cache = open(namespace);
      const other = open(namespace, {
        ...KIT_ENCRYPT,
        hashNames: { key: new Uint8Array(32).fill(0x6f) },
      });
      const unhashed = open(namespace, { keys: KIT_RING });
      try {
        await cache.set("k", "v");
        expect(await cache.get("k")).toBe("v");
        expect(await other.get("k")).toBeUndefined();
        expect(await unhashed.get("k")).toBeUndefined();
      } finally {
        await cache.close();
        await other.close();
        await unhashed.close();
      }
    },
  );

  kase(
    "encrypted.clear",
    "encrypt + hashNames: clear() empties its own namespace view only",
    true,
    async () => {
      await withCache(async (root) => {
        const users = root.namespace("users");
        const orders = root.namespace("orders");
        await root.set("k", "root");
        await users.set("k", "users");
        await orders.set("k", "orders");
        await users.clear();
        expect(await users.get("k")).toBeUndefined();
        expect(await orders.get("k")).toBe("orders");
        expect(await root.get("k")).toBe("root");
      });
    },
  );

  kase(
    "encrypted.tags",
    "encrypt + hashNames: invalidateTags reaches the hashed tags",
    true,
    async () => {
      const namespace = `kitenc-${process.pid}-${token()}`;
      const peer = open(namespace);
      await withCache(async (cache) => {
        await cache.set("a", 1, { tags: ["org:1", "plan:pro"] });
        await cache.set("b", 2, { tags: ["org:2"] });
        await wait(2);
        await cache.invalidateTags(["org:1"]);
        expect(await cache.get("a")).toBeUndefined();
        expect(await cache.get("b")).toBe(2);
        // A second cache over the store (a peer process's) sees it too —
        // read only now, since a stamps-mode read caches the stamps it saw
        // for `tagStampCacheMs`.
        expect(await peer.get("a")).toBeUndefined();
        expect(await peer.get("b")).toBe(2);
      }, open(namespace));
      await peer.close();
    },
  );

  kase(
    "encrypted.increment",
    "encrypt + hashNames: a counter's name is hashed, its value stays plain",
    capabilities.atomicIncrement && driver.increment !== undefined,
    async () => {
      await withCache(async (cache) => {
        expect(await cache.increment("hits", 3)).toBe(3);
        expect(await cache.increment("hits")).toBe(4);
        expect(await cache.get("hits")).toBe(4);
        const { namespace, key } = cache.describeKey("hits");
        const counter = await driver.getCounter?.(namespace, key);
        if (driver.getCounter !== undefined) {
          expect(counter?.value).toBe(4);
        }
      });
    },
  );

  kase(
    "encrypted.lock",
    "encrypt + hashNames: getOrSet with a lock loads once and stores",
    capabilities.lock && driver.acquireLock !== undefined,
    async () => {
      await withCache(async (cache) => {
        let loads = 0;
        const loader = async () => {
          loads++;
          await wait(20);
          return "loaded";
        };
        const [one, two] = await Promise.all([
          cache.getOrSet("locked", loader, { lock: true }),
          cache.getOrSet("locked", loader, { lock: true }),
        ]);
        expect([one, two]).toEqual(["loaded", "loaded"]);
        expect(loads).toBe(1);
        expect(await cache.get("locked")).toBe("loaded");
      });
    },
  );

  kase(
    "encrypted.multiprocess.increment",
    "encrypt + hashNames: another process increments the counter at describeKey's names",
    capabilities.multiProcess && capabilities.atomicIncrement,
    async () => {
      const harness = options.crossProcess;
      expect(
        harness,
        "the driver advertises multiProcess: give the kit `crossProcess` ({ module, export, options }) so the pass can spawn a second process",
      ).toBeDefined();
      await withCache(async (cache) => {
        const { namespace, key } = cache.describeKey("shared-counter");
        const child = await startWorker({
          harness: harness!,
          op: "increment",
          ns: namespace,
          key,
          count: 50,
        });
        child.go();
        const mine: number[] = [];
        for (let wave = 0; wave < 10; wave++) {
          mine.push(
            ...(await Promise.all(
              Array.from(
                { length: 5 },
                async () => await cache.increment("shared-counter"),
              ),
            )),
          );
          await wait(0);
        }
        const theirs = await child.result;
        const all = [...mine, ...(theirs.results ?? [])];
        expect(new Set(all).size).toBe(100);
        expect(Math.max(...all)).toBe(100);
        expect(await cache.get("shared-counter")).toBe(100);
      });
    },
    CROSS_PROCESS_TIMEOUT_MS,
  );

  const rawDumpTitle =
    "encrypt + hashNames: the raw store holds no plaintext key, namespace, tag or value";
  if (instance.rawDump === undefined) {
    test.skip(`${rawDumpTitle} — skipped: the factory gives no rawDump (what the backend stored, read around the driver)`, () => {});
    return;
  }
  kase(
    "encrypted.raw-dump",
    rawDumpTitle,
    true,
    async () => {
      const rawDump = instance.rawDump!;
      const run = token();
      // The dump must see the store: a plain cache's value and namespace are
      // in it, in clear, on every driver (keys and tags may already be
      // hashed by the driver itself, unsalted — not a protection).
      const plainNs = `kitplainns_${run}`;
      const plainValue = `kitplainvalue_${run}`;
      const plain = open(plainNs, null);
      try {
        expect(await plain.set("k", plainValue)).toBe(true);
        const before = await rawDump();
        expect(
          dumpHolds(before, plainValue),
          "rawDump does not show a plain cache's value: it does not read what the driver stored",
        ).toBe(true);
        expect(
          dumpHolds(before, plainNs),
          "rawDump does not show a plain cache's namespace: it misses the stored names",
        ).toBe(true);
      } finally {
        await plain.clear();
        await plain.close();
      }

      const sentinels = {
        namespace: `kitsecretns_${run}`,
        key: `kitsecretkey_${run}`,
        tag: `kitsecrettag_${run}`,
        value: `kitsecretvalue_${run}`,
        counter: `kitsecretcounter_${run}`,
        lock: `kitsecretlock_${run}`,
        child: `kitsecretchild_${run}`,
      };
      // With the driver's bus, so a store that keeps its messages (a bus
      // table, a log, a capped collection) holds this cache's.
      const cache = createCache({
        driver: unclosable(driver),
        namespace: sentinels.namespace,
        sweepInterval: 0,
        bus: capabilities.bus === "none" ? false : "auto",
        encrypt: KIT_ENCRYPT,
      });
      try {
        const child = cache.namespace(sentinels.child);
        expect(
          await cache.set(
            sentinels.key,
            { secret: sentinels.value },
            { tags: [sentinels.tag], ttl: 600_000 },
          ),
        ).toBe(true);
        expect(
          await child.set(sentinels.key, sentinels.value, {
            tags: [sentinels.tag],
          }),
        ).toBe(true);
        expect(
          await cache.set(`${sentinels.key}_gone`, sentinels.value, {
            tags: [`${sentinels.tag}_gone`],
          }),
        ).toBe(true);
        if (capabilities.atomicIncrement && driver.increment !== undefined) {
          await cache.increment(sentinels.counter, 7);
        }
        if (capabilities.lock && driver.acquireLock !== undefined) {
          await cache.getOrSet(sentinels.lock, () => sentinels.value, {
            lock: true,
            tags: [sentinels.tag],
          });
        }
        // Stamps (and their bus messages) name the invalidated tag.
        await cache.invalidateTags([`${sentinels.tag}_gone`]);
        await cache.delete(`${sentinels.key}_gone`);
        const dump = await rawDump();
        expect(
          dumpHolds(dump, cache.describeKey(sentinels.key).namespace),
          "rawDump does not show the encrypted cache's hashed namespace",
        ).toBe(true);
        const leaks = Object.entries(sentinels)
          .filter(([, text]) => dumpHolds(dump, text))
          .map(([what, text]) => `${what} "${text}"`);
        expect(leaks, "the raw store holds these in plaintext").toEqual([]);
      } finally {
        await cache.namespace(sentinels.child).clear();
        await cache.clear();
        await cache.close();
      }
    },
    CROSS_PROCESS_TIMEOUT_MS,
  );
}
