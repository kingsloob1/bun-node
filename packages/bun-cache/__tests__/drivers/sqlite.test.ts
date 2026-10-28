/**
 * The SQLite driver (plan §7.3): the conformance kit against a real database
 * file — including the two-process pass and the bus-gap case, two processes
 * on one file being this driver's main multi-process case — plus the
 * driver-specific behaviors: the schema and pragmas, one connection per file
 * per process, a given database left open, prefixes, the tag index's
 * bookkeeping, a stale lock under a two-process herd, the cross-process
 * fence, and the bus's own pruning.
 *
 * Test data: one temporary directory per run, made by this file and deleted
 * by this file alone.
 */
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, test } from "bun:test";
import type { StoredEntry } from "../../lib/index";
import { createCache, sqliteDriver } from "../../lib/index";
import { runCacheDriverConformance } from "../../lib/testing/index";

/** The run's own directory. */
const dir = await mkdtemp(join(tmpdir(), `bun-cache-sqlite-${process.pid}-`));

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The kit's database file. */
const kitPath = join(dir, "kit.db");

/** The driver module, for the child processes. */
const driverModule = new URL("../../lib/drivers/sqlite.ts", import.meta.url)
  .pathname;

await runCacheDriverConformance(
  "sqlite",
  () => {
    const driver = sqliteDriver({ path: kitPath, busPollInterval: 25 });
    return { driver, cleanup: async () => await driver.close() };
  },
  {
    crossProcess: {
      module: driverModule,
      export: "sqliteDriver",
      options: { path: kitPath, busPollInterval: 25 },
    },
    busGap: () => {
      // Messages published and pruned before the subscriber's next poll —
      // exactly what a subscriber further behind than `busRetention` misses.
      // One transaction, so no poll can see the row in between.
      const db = new Database(kitPath);
      try {
        db.run("PRAGMA busy_timeout=5000");
        db.transaction(() => {
          db.run(
            "INSERT INTO bun_cache_bus (at, msg) VALUES (0, '{}'), (0, '{}')",
          );
          db.run(
            "DELETE FROM bun_cache_bus WHERE seq > (SELECT seq FROM sqlite_sequence WHERE name = 'bun_cache_bus') - 2",
          );
        }).immediate();
      } finally {
        db.close();
      }
    },
  },
);

/** An entry for the specifics. */
function entry(key: string, size: number, tags: string[] = []): StoredEntry {
  return { key, value: new Uint8Array(size).fill(7), expiresAt: null, tags };
}

/** A raw connection to inspect a file the driver wrote. */
function inspect<T>(path: string, read: (db: Database) => T): T {
  const db = new Database(path);
  try {
    db.run("PRAGMA busy_timeout=5000");
    return read(db);
  } finally {
    db.close();
  }
}

/** This process's open file descriptors on `path` (Linux: `/proc/self/fd`). */
async function openDescriptors(path: string): Promise<number> {
  let count = 0;
  for (const fd of await readdir("/proc/self/fd")) {
    const target = await readlink(`/proc/self/fd/${fd}`).catch(() => "");
    if (target === path) {
      count++;
    }
  }
  return count;
}

/**
 * Spawns the kit's cross-process worker with a job and waits for it at its
 * start barrier (its `{"ready":true}` line). `go()` releases it, so this
 * process's side and the worker's start together; `result` is its answer.
 */
async function startWorker(job: Record<string, unknown>): Promise<{
  /** Releases the worker (closes its stdin). */
  go: () => void;
  /** The worker's result line, parsed. */
  result: Promise<{ acquired?: number; winners?: string[] }>;
}> {
  const worker = new URL(
    "../../lib/testing/crossprocess-worker.ts",
    import.meta.url,
  ).pathname;
  const child = Bun.spawn({
    cmd: [process.execPath, worker, JSON.stringify(job)],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error(`worker exited before ready: ${await stderr}`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return {
    go: () => {
      void child.stdin.end();
    },
    result: (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        text += decoder.decode(value, { stream: true });
      }
      const code = await child.exited;
      if (code !== 0) {
        throw new Error(`worker exited ${code}: ${await stderr}`);
      }
      const lines = text.trim().split("\n");
      return JSON.parse(lines.at(-1)!) as {
        acquired?: number;
        winners?: string[];
      };
    })(),
  };
}

describe("sqliteDriver specifics", () => {
  test("the schema: §7.3's tables and indexes under the prefix, in WAL mode", async () => {
    const path = join(dir, "schema.db");
    const driver = sqliteDriver({ path });
    await driver.connect!();
    const names = inspect(path, (db) =>
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name LIKE '%bun_cache_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
    );
    expect(names).toEqual([
      "bun_cache_bus",
      "bun_cache_entries",
      "bun_cache_locks",
      "bun_cache_stamps",
      "bun_cache_tags",
      "ix_bun_cache_entries_exp",
      "ix_bun_cache_tags_key",
    ]);
    const mode = inspect(
      path,
      (db) =>
        db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()
          ?.journal_mode,
    );
    expect(mode).toBe("wal");
    expect(await driver.syncSchema!()).toEqual([]);
    expect(driver.capabilities).toMatchObject({
      multiProcess: true,
      tags: "index",
      fence: "atomic",
      bus: "poll",
      atomicIncrement: true,
      lock: true,
    });
    await driver.close();
  });

  test.skipIf(process.platform !== "linux")(
    "one connection per file per process: two drivers share it, the last close closes it",
    async () => {
      const path = join(dir, "shared.db");
      const before = await openDescriptors(path);
      const one = sqliteDriver({ path });
      const two = sqliteDriver({ path, prefix: "other_" });
      await one.set("ns", entry("k", 3));
      await two.set("ns", entry("k", 4));
      expect(await openDescriptors(path)).toBe(before + 1);
      await one.close();
      // The other driver keeps the connection.
      expect((await two.get("ns", "k"))?.value).toHaveLength(4);
      expect(await openDescriptors(path)).toBe(before + 1);
      await two.close();
      expect(await openDescriptors(path)).toBe(before);
      // And a closed driver reconnects lazily on its next use.
      expect((await one.get("ns", "k"))?.value).toHaveLength(3);
      await one.close();
    },
  );

  test("a given database is used as-is: no pragma set, never closed", async () => {
    const path = join(dir, "given.db");
    const database = new Database(path, { create: true });
    const driver = sqliteDriver({ database });
    await driver.set("ns", entry("k", 2));
    expect(
      database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()
        ?.journal_mode,
    ).toBe("delete");
    await driver.close();
    // Still open: the caller owns it.
    expect(database.query<{ n: number }, []>("SELECT 1 AS n").get()?.n).toBe(1);
    database.close();
  });

  test(":memory: is private to its driver, and not multi-process", async () => {
    const one = sqliteDriver({ path: ":memory:" });
    const two = sqliteDriver({ path: ":memory:" });
    expect(one.capabilities.multiProcess).toBe(false);
    await one.set("ns", entry("k", 1));
    expect(await two.get("ns", "k")).toBeUndefined();
    await one.close();
    await two.close();
  });

  test("two prefixes on one file are two stores; a bad prefix or no path throws", async () => {
    const path = join(dir, "prefixes.db");
    const a = sqliteDriver({ path, prefix: "app_a_" });
    const b = sqliteDriver({ path, prefix: "app_b_" });
    await a.set("ns", entry("k", 5));
    expect(await b.get("ns", "k")).toBeUndefined();
    await a.close();
    await b.close();
    expect(() => sqliteDriver({ path, prefix: "bad-prefix" })).toThrow(
      TypeError,
    );
    expect(() => sqliteDriver({ path, prefix: "x; DROP TABLE y" })).toThrow(
      TypeError,
    );
    expect(() => sqliteDriver({})).toThrow(TypeError);
  });

  test("the tag index keeps no stale rows: overwrite, delete, deleteByTags, increment and sweep each take theirs", async () => {
    const path = join(dir, "tags.db");
    const driver = sqliteDriver({ path });
    const tagRows = (): string[] =>
      inspect(path, (db) =>
        db
          .query<{ tag: string; k: string }, []>(
            "SELECT tag, k FROM bun_cache_tags ORDER BY k, tag",
          )
          .all()
          .map((row) => `${row.k}:${row.tag}`),
      );
    await driver.set("ns", entry("k1", 1, ["a"]));
    await driver.set("ns", entry("k2", 1, ["a", "b"]));
    await driver.set("ns", entry("k3", 1, ["c"]));
    await driver.set("ns", entry("k4", 1, ["d"]));
    await driver.set("ns", entry("k5", 1, ["e"]));
    // Overwrite: the old tags go.
    await driver.set("ns", entry("k3", 1, ["c2"]));
    // deleteByTags("a") takes k2's "b" row too — it reads the tag table it
    // deletes from.
    expect(await driver.deleteByTags!("ns", ["a"], Date.now() + 60_000)).toBe(
      2,
    );
    expect(tagRows()).toEqual(["k3:c2", "k4:d", "k5:e"]);
    expect(await driver.delete("ns", ["k3"])).toBe(1);
    // A counter replaces an entry, and its tags.
    expect(await driver.increment!("ns", "k4", 2, null)).toBe(2);
    expect(await driver.get("ns", "k4")).toBeUndefined();
    // An expired entry's rows go with it in the sweep.
    await driver.set("ns", {
      ...entry("k5", 1, ["e"]),
      expiresAt: Date.now() - 1,
    });
    expect(await driver.sweep!(Date.now(), 100)).toBe(1);
    expect(tagRows()).toEqual([]);
    await driver.close();
  });

  test("a stale lock under a 25+25 two-process herd is taken exactly once, five rounds", async () => {
    const path = join(dir, "herd.db");
    const driver = sqliteDriver({ path });
    for (let round = 0; round < 5; round++) {
      const ns = `herd-${round}`;
      // A dead holder's lock: lapsed already.
      expect(await driver.acquireLock!(ns, "k", "dead", 1)).toBe(true);
      await Bun.sleep(5);
      const child = await startWorker({
        module: driverModule,
        export: "sqliteDriver",
        options: { path },
        op: "lock",
        ns,
        key: "k",
        count: 25,
        ownerPrefix: "c-",
      });
      child.go();
      const mine = await Promise.all(
        Array.from({ length: 25 }, (_, index) =>
          driver.acquireLock!(ns, "k", `p-${index}`, 60_000),
        ),
      );
      const theirs = await child.result;
      expect(mine.filter(Boolean).length + (theirs.acquired ?? 0)).toBe(1);
      // The dead holder cannot release what it lost.
      expect(await driver.releaseLock!(ns, "k", "dead")).toBe(false);
    }
    await driver.close();
  });

  test("the fence across processes: a stamp written by another process refuses an older load's write", async () => {
    const path = join(dir, "fence.db");
    const driver = sqliteDriver({ path });
    const startedAt = Date.now() - 1_000;
    const writer = await startWorker({
      module: driverModule,
      export: "sqliteDriver",
      options: { path },
      op: "stamps",
      ns: "fence",
      tag: "org:7",
    });
    writer.go();
    await writer.result;
    expect(
      await driver.set("fence", entry("k", 1, ["org:7"]), {
        tags: ["org:7"],
        createdAt: startedAt,
      }),
    ).toBe("fenced");
    expect(await driver.get("fence", "k")).toBeUndefined();
    await driver.close();
  });

  test("durability: a second driver (after the first closed) reads entries, counters and stamps", async () => {
    const path = join(dir, "durable.db");
    const first = sqliteDriver({ path });
    await first.set("d", entry("k", 12, ["t"]));
    await first.increment!("d", "c", 5, null);
    await first.deleteByTags!("d", ["gone"], Date.now() + 60_000);
    await first.close();
    const second = sqliteDriver({ path });
    expect((await second.get("d", "k"))?.tags).toEqual(["t"]);
    expect((await second.getCounter!("d", "c"))?.value).toBe(5);
    expect((await second.getStamps("d", ["gone"])).has("gone")).toBe(true);
    await second.close();
  });

  test("the clock: lazy expiry and lock lapse follow the driver's `now`", async () => {
    let now = 1_000_000;
    const driver = sqliteDriver({
      path: join(dir, "clock.db"),
      now: () => now,
    });
    await driver.set("ns", { ...entry("k", 1), expiresAt: now + 100 });
    expect(await driver.acquireLock!("ns", "l", "a", 100)).toBe(true);
    expect(await driver.acquireLock!("ns", "l", "b", 100)).toBe(false);
    now += 100;
    expect(await driver.get("ns", "k")).toBeUndefined();
    expect(await driver.touch!("ns", "k", null)).toBe(false);
    expect(await driver.acquireLock!("ns", "l", "b", 100)).toBe(true);
    await driver.close();
  });

  test("the bus: a subscriber further behind than busRetention sees a gap from the driver's own pruning", async () => {
    const path = join(dir, "bus.db");
    const publisher = sqliteDriver({ path, busRetention: 1 });
    const subscriber = sqliteDriver({ path, busPollInterval: 50 });
    const received: string[] = [];
    let gaps = 0;
    const unsubscribe = await subscriber.subscribe!(
      (message) => {
        received.push(message.type);
      },
      () => {
        gaps++;
      },
    );
    /** Waits until `condition` holds, for at most 5 s. */
    const until = async (condition: () => boolean): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!condition()) {
        expect(Date.now()).toBeLessThan(deadline);
        await Bun.sleep(10);
      }
    };
    await publisher.publish!({ type: "clear", namespace: "a", at: 1 });
    await until(() => received.length > 0);
    expect(received).toEqual(["clear"]);
    expect(gaps).toBe(0);
    // A burst pruned by a sweep before the subscriber's next poll.
    await publisher.publish!({ type: "clear", namespace: "b", at: 2 });
    await publisher.sweep!(Date.now() + 1_000, 100);
    await until(() => gaps > 0);
    expect(received).toEqual(["clear"]);
    // After the gap it resumes: the next message arrives.
    await publisher.publish!({ type: "delete", namespace: "c", at: 3 });
    await until(() => received.length > 1);
    expect(received).toEqual(["clear", "delete"]);
    await unsubscribe();
    await publisher.close();
    await subscriber.close();
  });

  test("through the cache: tags invalidate eagerly and counters count", async () => {
    const cache = createCache({
      driver: sqliteDriver({ path: join(dir, "cache.db") }),
      sweepInterval: 0,
    });
    await cache.set("user:1", { name: "Ada" }, { tags: ["users"] });
    expect(await cache.get("user:1")).toEqual({ name: "Ada" });
    await cache.invalidateTags(["users"]);
    expect(await cache.get("user:1")).toBeUndefined();
    expect(await cache.increment("hits")).toBe(1);
    expect(await cache.increment("hits", 4)).toBe(5);
    expect(await cache.get("hits")).toBe(5);
    await cache.close();
  });
});
