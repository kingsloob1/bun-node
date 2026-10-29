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
    return {
      driver,
      cleanup: async () => await driver.close(),
      // The database file and its WAL and shared-memory files, as on disk:
      // a row only in the WAL is still stored. Read by a child process:
      // closing any descriptor of the file in this one would drop the POSIX
      // locks SQLite holds on it (measured: `--seed=2` then failed the
      // two-process cases with SQLITE_IOERR_SHORT_READ).
      rawDump: async () =>
        await Promise.all(
          ["", "-wal", "-shm"].map(async (suffix) => {
            const child = Bun.spawn(["cat", `${kitPath}${suffix}`], {
              stdout: "pipe",
              stderr: "ignore",
            });
            const bytes = await new Response(child.stdout).bytes();
            await child.exited;
            return bytes;
          }),
        ),
    };
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

describe("sqliteDriver maxEntries (§3.9)", () => {
  /** The entry rows left in a file's default-prefix table, `ns:k`, sorted. */
  const keysIn = (path: string): string[] =>
    inspect(path, (db) =>
      db
        .query<{ ns: string; k: string }, []>(
          "SELECT ns, k FROM bun_cache_entries WHERE n IS NULL ORDER BY ns, k",
        )
        .all()
        .map((row) => `${row.ns}:${row.k}`),
    );

  test("a sweep evicts down to the cap, nearest to expiry first, then the oldest unexpiring write; counters stay", async () => {
    const path = join(dir, "cap-order.db");
    let now = 1_000_000;
    const driver = sqliteDriver({ path, maxEntries: 3, now: () => now });
    const evicted: string[] = [];
    driver.onEviction!((ns, key, reason) => {
      evicted.push(`${ns}:${key}:${reason}`);
    });
    const put = async (
      key: string,
      expiresAt: number | null,
    ): Promise<void> => {
      await driver.set("ns", { ...entry(key, 1), expiresAt });
      now++; // a distinct write time per entry
    };
    // The counter is the oldest row of all: an eviction that took counters
    // would take it first among the unexpiring rows.
    await driver.increment!("ns", "hits", 1, null);
    now++;
    await put("a", now + 30_000);
    await put("b", now + 10_000);
    await put("c", null);
    await put("d", now + 20_000);
    await put("e", null);
    await put("f", null);
    // Six entries over a cap of three, and nothing expired: b, d, a go — the
    // soonest to expire — and the unexpiring three stay.
    expect(await driver.sweep!(now, 1_000)).toBe(0);
    expect(evicted).toEqual(["ns:b:cap", "ns:d:cap", "ns:a:cap"]);
    expect(keysIn(path)).toEqual(["ns:c", "ns:e", "ns:f"]);
    // Counters are not entries: never counted, never evicted.
    expect((await driver.getCounter!("ns", "hits"))?.value).toBe(1);
    // One more unexpiring entry: the oldest write among them (c) goes.
    await put("g", null);
    await driver.sweep!(now, 1_000);
    expect(evicted.at(-1)).toBe("ns:c:cap");
    expect(keysIn(path)).toEqual(["ns:e", "ns:f", "ns:g"]);
    expect((await driver.getCounter!("ns", "hits"))?.value).toBe(1);
    // Under the cap, a sweep evicts nothing.
    await driver.sweep!(now, 1_000);
    expect(evicted).toHaveLength(4);
    await driver.close();
  });

  test("the cap counts every namespace, takes the tag rows with each victim, and evicts at most `limit` per pass", async () => {
    const path = join(dir, "cap-tags.db");
    let now = 2_000_000;
    const driver = sqliteDriver({ path, maxEntries: 2, now: () => now });
    for (const [ns, key] of [
      ["one", "k1"],
      ["two", "k2"],
      ["one", "k3"],
      ["two", "k4"],
      ["one", "k5"],
    ] as const) {
      await driver.set(ns, entry(key, 1, ["t", `t-${key}`]));
      now++;
    }
    // Three over the cap, one eviction allowed per pass.
    await driver.sweep!(now, 1);
    expect(keysIn(path)).toEqual(["one:k3", "one:k5", "two:k2", "two:k4"]);
    await driver.sweep!(now, 10);
    expect(keysIn(path)).toEqual(["one:k5", "two:k4"]);
    const tagged = inspect(path, (db) =>
      db
        .query<{ k: string }, []>(
          "SELECT DISTINCT k FROM bun_cache_tags ORDER BY k",
        )
        .all()
        .map((row) => row.k),
    );
    expect(tagged).toEqual(["k4", "k5"]);
    // And an invalidation sees only the survivors.
    expect(await driver.deleteByTags!("one", ["t"], now + 60_000)).toBe(1);
    await driver.close();
  });

  test("through the cache: each eviction is an `evict` event and counts in stats()", async () => {
    const driver = sqliteDriver({
      path: join(dir, "cap-cache.db"),
      maxEntries: 2,
    });
    const cache = createCache({ driver, sweepInterval: 0 });
    const events: string[] = [];
    cache.on("evict", (event) => {
      events.push(event.reason);
    });
    for (let index = 0; index < 5; index++) {
      await cache.set(`k${index}`, index, { ttl: 60_000 + index });
    }
    await driver.sweep!(Date.now(), 1_000);
    expect(events).toEqual(["cap", "cap", "cap"]);
    expect(cache.stats().evictions).toBe(3);
    expect(await cache.get("k0")).toBeUndefined();
    expect(await cache.get("k4")).toBe(4);
    await cache.close();
  });

  test("two processes sweeping one file at once hold the cap exactly — no double eviction", async () => {
    for (let round = 0; round < 3; round++) {
      const path = join(dir, `cap-xproc-${round}.db`);
      const driver = sqliteDriver({ path, maxEntries: 15 });
      let evicted = 0;
      driver.onEviction!(() => {
        evicted++;
      });
      for (let index = 0; index < 20; index++) {
        await driver.set("p", entry(`parent-${index}`, 1, ["parent"]));
      }
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          new URL("./sqlite-cap-worker.ts", import.meta.url).pathname,
          path,
          "20",
          "c",
          "15",
        ],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("\n")) {
        const { done, value } = await reader.read();
        if (done) {
          throw new Error(
            `worker exited before ready: ${await new Response(child.stderr).text()}`,
          );
        }
        text += decoder.decode(value, { stream: true });
      }
      // Both sweep at once: one transaction waits for the other's commit.
      void child.stdin.end();
      await driver.sweep!(Date.now(), 1_000);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        text += decoder.decode(value, { stream: true });
      }
      expect(await child.exited).toBe(0);
      const theirs = (
        JSON.parse(text.trim().split("\n").at(-1)!) as { evicted: number }
      ).evicted;
      expect(keysIn(path)).toHaveLength(15);
      expect(evicted + theirs).toBe(25);
      await driver.close();
    }
  });

  test("no cap by default; a bad cap throws", async () => {
    const path = join(dir, "cap-none.db");
    const driver = sqliteDriver({ path });
    for (let index = 0; index < 50; index++) {
      await driver.set("ns", entry(`k${index}`, 1));
    }
    await driver.sweep!(Date.now(), 1_000);
    expect(keysIn(path)).toHaveLength(50);
    await driver.close();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => sqliteDriver({ path, maxEntries: bad })).toThrow(TypeError);
    }
  });
});

describe("sqliteDriver table names and schema sync", () => {
  /** The tables and indexes a file holds. */
  const objectsIn = (path: string): { type: string; name: string }[] =>
    inspect(path, (db) =>
      db
        .query<{ type: string; name: string }, []>(
          "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all(),
    );

  test("names its tables, by prefix or outright: a `tables` name is used as given and ignores the prefix", async () => {
    const path = join(dir, "named.db");
    const named = sqliteDriver({
      path,
      prefix: "app_",
      tables: { entries: "legacy_cache_rows", bus: "legacy_bus" },
    });
    await named.set("ns", entry("k", 3, ["t"]));
    const tables = objectsIn(path)
      .filter((object) => object.type === "table")
      .map((object) => object.name);
    expect(tables).toEqual([
      "app_locks",
      "app_stamps",
      "app_tags",
      "legacy_bus",
      "legacy_cache_rows",
    ]);
    expect(
      inspect(
        path,
        (db) =>
          db.query<{ k: string }, []>("SELECT k FROM legacy_cache_rows").all()
            .length,
      ),
    ).toBe(1);
    // The prefix alone names other tables: that driver cannot see the row.
    const prefixed = sqliteDriver({ path, prefix: "app_" });
    expect(await prefixed.get("ns", "k")).toBeUndefined();
    // The same `tables` reads it back, and its bus is its own.
    const again = sqliteDriver({
      path,
      prefix: "app_",
      tables: { entries: "legacy_cache_rows", bus: "legacy_bus" },
    });
    expect((await again.get("ns", "k"))?.value).toHaveLength(3);
    await Promise.all([named.close(), prefixed.close(), again.close()]);
  });

  test("index names follow the table names and stay within 63 characters", async () => {
    const path = join(dir, "long-names.db");
    const long = "t".repeat(63);
    const driver = sqliteDriver({ path, tables: { entries: long } });
    await driver.connect!();
    const indexes = objectsIn(path)
      .filter((object) => object.type === "index")
      .map((object) => object.name);
    expect(indexes).toContain("ix_bun_cache_tags_key");
    const exp = indexes.find((name) => name.endsWith("_exp"))!;
    expect(exp.length).toBeLessThanOrEqual(63);
    expect(exp.startsWith(`ix_${"t".repeat(20)}`)).toBe(true);
    await driver.close();
  });

  test("a bad `tables` name throws", () => {
    const path = join(dir, "bad-names.db");
    const bad: Record<string, string>[] = [
      { entries: "bad-name" },
      { entries: "x; DROP TABLE y" },
      { entries: "9lives" },
      { entries: "t".repeat(64) },
      { entries: "same", tags: "same" },
      { entries: "bun_cache_tags" },
      { jobs: "nope" },
    ];
    for (const tables of bad) {
      expect(() => sqliteDriver({ path, tables })).toThrow(TypeError);
    }
  });

  test("syncSchema: runs when the tables are created on a connection when set, never when unset", async () => {
    const calls: unknown[] = [];
    const spyOn = (driver: ReturnType<typeof sqliteDriver>) => {
      const target = driver as unknown as {
        migrateSchema: (db: Database, options: unknown) => unknown;
      };
      const original = target.migrateSchema.bind(driver);
      target.migrateSchema = (db, options) => {
        calls.push(options);
        return original(db, options);
      };
    };
    const off = sqliteDriver({ path: join(dir, "sync-off.db") });
    spyOn(off);
    await off.connect!();
    expect(calls).toEqual([]);
    await off.close();

    const on = sqliteDriver({
      path: join(dir, "sync-on.db"),
      syncSchema: true,
    });
    spyOn(on);
    // First use creates the tables, and the sync runs with them, once.
    await on.set("ns", entry("k", 1));
    await on.connect!();
    expect(calls).toEqual([{}]);
    await on.close();

    const dry = sqliteDriver({
      path: join(dir, "sync-dry.db"),
      syncSchema: { dryRun: true },
    });
    spyOn(dry);
    await dry.connect!();
    expect(calls).toEqual([{}, { dryRun: true }]);
    // One schema version: nothing to change, whether asked on connect or not.
    expect(await dry.syncSchema!()).toEqual([]);
    await dry.close();
  });
});
