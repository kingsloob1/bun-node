/**
 * The SQL drivers' suite (plan §7.4, §7.5), registered once per engine by
 * `postgres.test.ts`, `mysql.test.ts` and `mariadb.test.ts`: the conformance
 * kit — with its two-process pass, and the bus-gap case on the polled bus —
 * plus the behaviours specific to a SQL backend.
 *
 * Test data: the run's own tables (`bun_cache_test_<pid>_…`), dropped by
 * name at the end. A backend whose URL is unset skips visibly; one whose URL
 * is set but unreachable fails, naming the variable (`backends.ts`).
 */
import process from "node:process";
import { afterAll, describe, expect, it, test } from "bun:test";
import type { BusMessage, StoredEntry } from "../../lib/index";
import { createCache } from "../../lib/index";
import type { PostgresCacheDriver } from "../../lib/drivers/postgres";
import { runCacheDriverConformance } from "../../lib/testing/index";
import type { SqlBackend } from "./backends";
import {
  dropTables,
  rawClient,
  reachError,
  runPrefix,
  sqlBackends,
} from "./backends";

/**
 * Registers a failing test for a backend whose URL is set but whose server
 * cannot be reached (bun-jobs' `reportUnreachable`, copied). The backend is
 * then skipped, so the run shows one named, explained failure rather than a
 * storm of connection errors.
 */
export function reportUnreachable(
  /** Backend name, as it appears in the test titles. */
  name: string,
  /** The variable that pointed at it, so the reader knows what to fix. */
  variable: string,
  /** Why the connection failed. */
  error: Error,
): void {
  describe(`backend ${name}: unreachable`, () => {
    it(`connects to the server ${variable} points at`, () => {
      throw new Error(
        `${variable} (or its BUN_JOBS_TEST_* fallback) is set, but the ${name} server it names could not be reached, so every ${name} test would have been skipped and the run would still have been green. Start the server (bun scripts/setup-databases.ts), fix the URL, or unset the variable to skip ${name} deliberately.\n  ${error.message}`,
        { cause: error },
      );
    });
  });
}

/** Registers the visible skip for a backend with no URL. */
export function reportNotConfigured(name: string, variable: string): void {
  describe.skip(`backend ${name}: not configured`, () => {
    it(`set ${variable} (bun scripts/setup-databases.ts --print-env) to run it`, () => {});
  });
}

/** An entry for the specifics. */
function entry(
  key: string,
  bytes: number[],
  tags: readonly string[] = [],
  expiresAt: number | null = null,
): StoredEntry {
  return { key, value: new Uint8Array(bytes), expiresAt, tags };
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
    await Bun.sleep(10);
  }
}

/** Registers the whole suite for one engine. Await it at the test file's top level. */
export async function registerSqlSuite(
  name: SqlBackend["name"],
): Promise<void> {
  const backend = sqlBackends().find((candidate) => candidate.name === name)!;
  if (backend.url === undefined) {
    reportNotConfigured(name, backend.variable);
    return;
  }
  const unreachable = await reachError(backend);
  if (unreachable !== undefined) {
    reportUnreachable(name, backend.variable, unreachable);
    return;
  }

  const url = backend.url;
  const prefixes = new Set<string>();
  /** A prefix of this run's, recorded so the end of the file drops its tables. */
  const prefix = (suffix: string): string => {
    const value = runPrefix(suffix);
    prefixes.add(value);
    return value;
  };
  /** A driver on this run's tables. */
  const make = (suffix: string, extra: Record<string, unknown> = {}) =>
    backend.make({ url, prefix: prefix(suffix), ...extra });

  /** Tables this run named outright (`tables`), dropped by name at the end. */
  const namedTables = new Set<string>();
  /** A table name of this run's, recorded for the end of the file. */
  const named = (suffix: string): string => {
    const value = runPrefix(suffix);
    namedTables.add(value);
    return value;
  };

  afterAll(async () => {
    for (const each of prefixes) {
      await dropTables(backend, each);
    }
    const sql = rawClient(backend);
    try {
      for (const table of namedTables) {
        await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
      }
    } finally {
      await sql.close();
    }
  });

  // The kit, on its own tables.
  const kitOptions = {
    url,
    prefix: prefix("kit_"),
    busPollInterval: 25,
  };
  const kitDriver = backend.make(kitOptions);
  // Connected first, so the capabilities the kit gates on include what the
  // server reports (MySQL's `maxEntryBytes`).
  await kitDriver.connect!();
  await runCacheDriverConformance(
    name,
    () => ({ driver: kitDriver, cleanup: async () => await kitDriver.close() }),
    {
      crossProcess: {
        module: backend.module,
        export: backend.exportName,
        options: kitOptions,
      },
      // The polled bus (MySQL, MariaDB) must prove its gap; Postgres is
      // pushed, and its reconnect gap has a test of its own below (a
      // terminated LISTEN backend, whose reconnect can outlast the kit's
      // 5 s), so it gives none.
      ...(name === "postgres"
        ? {}
        : {
            busGap: async () => {
              // A stretch of the log the subscriber never saw: a row far past the
              // next `seq`, which is what a prune (or a lost insert) looks like.
              // An ordinary row first: a subscriber that started on an empty table
              // takes its first row as the start of the sequence, so the jump must
              // come after one.
              const sql = rawClient(backend);
              try {
                await sql.unsafe(
                  `INSERT INTO ${kitOptions.prefix}bus (at, msg) VALUES (?, ?)`,
                  [
                    Date.now(),
                    JSON.stringify({
                      type: "clear",
                      namespace: "before-gap",
                      at: 0,
                    }),
                  ],
                );
                await sql.unsafe(
                  `INSERT INTO ${kitOptions.prefix}bus (seq, at, msg) SELECT COALESCE(MAX(seq), 0) + 1000, ?, ? FROM ${kitOptions.prefix}bus`,
                  [
                    Date.now(),
                    JSON.stringify({ type: "clear", namespace: "gap", at: 0 }),
                  ],
                );
              } finally {
                await sql.close();
              }
            },
          }),
    },
  );

  describe(`${name} table names and schema sync`, () => {
    /** The index names on a table, from the catalog. */
    const indexesOf = async (table: string): Promise<string[]> => {
      const sql = rawClient(backend);
      try {
        const rows =
          name === "postgres"
            ? await sql.unsafe<{ name: string }[]>(
                "SELECT indexname AS name FROM pg_indexes WHERE tablename = $1",
                [table],
              )
            : await sql.unsafe<{ name: string }[]>(
                "SELECT DISTINCT index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ?",
                [table],
              );
        return rows.map((row) => row.name);
      } finally {
        await sql.close();
      }
    };

    test("names its tables, by prefix or outright: a `tables` name is used as given and ignores the prefix", async () => {
      const entriesTable = named("legacy_rows");
      const options = {
        url,
        prefix: prefix("named_"),
        tables: { entries: entriesTable },
      };
      const driver = backend.make(options);
      await driver.set("ns", entry("k", [1, 2], ["t"]));
      const sql = rawClient(backend);
      try {
        const rows = await sql.unsafe<{ k: string }[]>(
          `SELECT k FROM ${entriesTable}`,
        );
        expect(rows.map((row) => row.k)).toEqual(["k"]);
        // The tables not named keep the prefix.
        const tagged = await sql.unsafe<{ k: string }[]>(
          `SELECT k FROM ${runPrefix("named_")}tags`,
        );
        expect(tagged.map((row) => row.k)).toEqual(["k"]);
      } finally {
        await sql.close();
      }
      // The prefix alone names another entries table: that driver cannot see it.
      const prefixed = make("named_");
      expect(await prefixed.get("ns", "k")).toBeUndefined();
      // The same `tables` reads it back.
      const again = backend.make(options);
      expect([...(await again.get("ns", "k"))!.value]).toEqual([1, 2]);
      expect(await again.deleteByTags!("ns", ["t"], Date.now() + 60_000)).toBe(
        1,
      );
      await Promise.all([driver.close(), prefixed.close(), again.close()]);
    });

    test("index names follow the table names and stay within 63 characters", async () => {
      const long = `${runPrefix("")}${"x".repeat(63)}`.slice(0, 63);
      namedTables.add(long);
      const driver = backend.make({
        url,
        prefix: prefix("longidx_"),
        tables: { entries: long },
      });
      await driver.connect!();
      const indexes = (await indexesOf(long)).filter(
        (index) => index !== "PRIMARY" && !index.endsWith("_pkey"),
      );
      expect(indexes).toHaveLength(1);
      expect(indexes[0].length).toBeLessThanOrEqual(63);
      expect(indexes[0].endsWith("_exp")).toBe(true);
      expect(await indexesOf(`${runPrefix("longidx_")}tags`)).toContain(
        `ix_${runPrefix("longidx_")}tags_key`,
      );
      await driver.close();
    });

    test("a bad `tables` name throws before anything connects", () => {
      const bad: Record<string, string>[] = [
        { entries: "bad-name" },
        { entries: "x; DROP TABLE y" },
        { entries: "9lives" },
        { entries: "t".repeat(64) },
        { entries: "same", tags: "same" },
        { entries: "bun_cache_tags" },
        { jobs: "nope" },
      ];
      if (name === "postgres") {
        // Postgres's bus is LISTEN/NOTIFY: there is no bus table to name.
        bad.push({ bus: "my_bus" });
      }
      for (const tables of bad) {
        expect(() => backend.make({ url, tables })).toThrow(TypeError);
      }
    });

    test("two table sets on one database are two stores, buses included", async () => {
      const setA = { url, prefix: prefix("seta_"), busPollInterval: 25 };
      const setB = {
        url,
        prefix: prefix("seta_"),
        busPollInterval: 25,
        tables: { entries: named("setb_entries") },
      };
      const a = backend.make(setA);
      const b = backend.make(setB);
      const a2 = backend.make(setA);
      if (name === "postgres") {
        expect((a as PostgresCacheDriver).channel).toBe(
          (a2 as PostgresCacheDriver).channel,
        );
        expect((a as PostgresCacheDriver).channel).not.toBe(
          (b as PostgresCacheDriver).channel,
        );
      }
      await a.set("ns", entry("k", [1]));
      expect(await b.get("ns", "k")).toBeUndefined();
      const received: string[] = [];
      const unsubscribe = await a.subscribe!(
        (message) => {
          received.push(message.namespace);
        },
        () => {},
      );
      if (name !== "postgres") {
        // MySQL/MariaDB: the bus table is shared unless named apart, so this
        // set's bus is named too.
        const c = backend.make({
          ...setB,
          tables: { ...setB.tables, bus: named("setb_bus") },
        });
        await c.publish!({ type: "clear", namespace: "other-set", at: 0 });
        await c.close();
      } else {
        await b.publish!({ type: "clear", namespace: "other-set", at: 0 });
      }
      await Bun.sleep(300);
      expect(received).toEqual([]);
      await a2.publish!({ type: "clear", namespace: "same-set", at: 1 });
      await waitFor("the same set's message", () => received.length > 0);
      expect(received).toEqual(["same-set"]);
      await unsubscribe();
      await Promise.all([a.close(), b.close(), a2.close()]);
    });

    test("syncSchema: runs on connect, after the tables, when set; never when unset", async () => {
      const calls: unknown[] = [];
      const spy = (driver: ReturnType<typeof make>): void => {
        const target = driver as unknown as {
          migrateSchema: (options: unknown) => Promise<unknown>;
        };
        const original = target.migrateSchema.bind(driver);
        target.migrateSchema = async (options) => {
          calls.push(options);
          return await original(options);
        };
      };
      const off = make("syncoff_");
      spy(off);
      await off.connect!();
      expect(calls).toEqual([]);
      await off.close();

      const on = make("syncon_", { syncSchema: true });
      spy(on);
      // First use connects, and the sync runs with it, once.
      await on.set("ns", entry("k", [1]));
      await on.connect!();
      expect(calls).toEqual([{}]);
      await on.close();

      const dry = make("syncdry_", { syncSchema: { dryRun: true } });
      spy(dry);
      await dry.connect!();
      expect(calls).toEqual([{}, { dryRun: true }]);
      // One schema version: nothing to change, on connect or asked.
      expect(await dry.syncSchema!()).toEqual([]);
      await dry.close();
    });
  });

  describe(`${name} maxEntries (§3.9)`, () => {
    /** The entry rows left in a prefix's table, `ns:k`, sorted. */
    const keysIn = async (prefix: string): Promise<string[]> => {
      const sql = rawClient(backend);
      try {
        const rows = await sql.unsafe<{ ns: string; k: string }[]>(
          `SELECT ns, k FROM ${prefix}entries WHERE n IS NULL`,
        );
        return rows.map((row) => `${row.ns}:${row.k}`).sort();
      } finally {
        await sql.close();
      }
    };

    test("a sweep evicts down to the cap, nearest to expiry first, then the oldest unexpiring write; counters stay", async () => {
      let now = 1_000_000;
      const driver = make("cap1_", { maxEntries: 3, now: () => now });
      const evicted: string[] = [];
      driver.onEviction!((ns, key, reason) => {
        evicted.push(`${ns}:${key}:${reason}`);
      });
      const put = async (
        key: string,
        expiresAt: number | null,
      ): Promise<void> => {
        await driver.set("ns", entry(key, [1], [], expiresAt));
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
      // Six entries over a cap of three, and nothing expired: b, d, a go —
      // the soonest to expire — and the unexpiring three stay.
      expect(await driver.sweep!(now, 1_000)).toBe(0);
      expect(evicted).toEqual(["ns:b:cap", "ns:d:cap", "ns:a:cap"]);
      expect(await keysIn(runPrefix("cap1_"))).toEqual([
        "ns:c",
        "ns:e",
        "ns:f",
      ]);
      // Counters are not entries: never counted, never evicted.
      expect((await driver.getCounter!("ns", "hits"))?.value).toBe(1);
      // One more unexpiring entry: the oldest write among them (c) goes.
      await put("g", null);
      await driver.sweep!(now, 1_000);
      expect(evicted.at(-1)).toBe("ns:c:cap");
      expect(await keysIn(runPrefix("cap1_"))).toEqual([
        "ns:e",
        "ns:f",
        "ns:g",
      ]);
      expect((await driver.getCounter!("ns", "hits"))?.value).toBe(1);
      // Under the cap, a sweep evicts nothing.
      await driver.sweep!(now, 1_000);
      expect(evicted).toHaveLength(4);
      await driver.close();
    });

    test("the cap counts every namespace, takes the tag rows with each victim, and evicts at most `limit` per pass", async () => {
      let now = 2_000_000;
      const driver = make("cap2_", { maxEntries: 2, now: () => now });
      for (const [ns, key] of [
        ["one", "k1"],
        ["two", "k2"],
        ["one", "k3"],
        ["two", "k4"],
        ["one", "k5"],
      ] as const) {
        await driver.set(ns, entry(key, [1], ["t", `t-${key}`]));
        now++;
      }
      // Three over the cap, one eviction allowed per pass.
      await driver.sweep!(now, 1);
      expect(await keysIn(runPrefix("cap2_"))).toEqual([
        "one:k3",
        "one:k5",
        "two:k2",
        "two:k4",
      ]);
      await driver.sweep!(now, 10);
      expect(await keysIn(runPrefix("cap2_"))).toEqual(["one:k5", "two:k4"]);
      const sql = rawClient(backend);
      try {
        const tagged = await sql.unsafe<{ k: string }[]>(
          `SELECT DISTINCT k FROM ${runPrefix("cap2_")}tags`,
        );
        expect(tagged.map((row) => row.k).sort()).toEqual(["k4", "k5"]);
      } finally {
        await sql.close();
      }
      // And an invalidation sees only the survivors.
      expect(await driver.deleteByTags!("one", ["t"], now + 60_000)).toBe(1);
      await driver.close();
    });

    test("through the cache: each eviction is an `evict` event and counts in stats()", async () => {
      const driver = make("cap3_", { maxEntries: 2 });
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

    test("two processes sweeping one table at once hold the cap exactly — no double eviction", async () => {
      for (let round = 0; round < 3; round++) {
        const options = {
          url,
          prefix: prefix(`capx${round}_`),
          maxEntries: 15,
        };
        const driver = backend.make(options);
        let evicted = 0;
        driver.onEviction!(() => {
          evicted++;
        });
        for (let index = 0; index < 20; index++) {
          await driver.set("p", entry(`parent-${index}`, [1], ["parent"]));
        }
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            new URL("./sql-cap-worker.ts", import.meta.url).pathname,
            backend.module,
            backend.exportName,
            JSON.stringify(options),
            "20",
            "c",
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
        expect(await keysIn(options.prefix)).toHaveLength(15);
        expect(evicted + theirs).toBe(25);
        await driver.close();
      }
    }, 30_000);

    test("no cap by default; a bad cap throws", async () => {
      const driver = make("cap5_");
      for (let index = 0; index < 50; index++) {
        await driver.set("ns", entry(`k${index}`, [1]));
      }
      await driver.sweep!(Date.now(), 1_000);
      expect(await keysIn(runPrefix("cap5_"))).toHaveLength(50);
      await driver.close();
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        expect(() =>
          backend.make({
            url,
            prefix: runPrefix("cap5_"),
            maxEntries: bad,
          }),
        ).toThrow(TypeError);
      }
    });
  });

  describe(`${name} specifics`, () => {
    const driver = make("spec_");
    const ns = `spec-${process.pid}`;

    test("keys are exact: case and trailing spaces make different keys", async () => {
      await driver.set(ns, entry("a", [1]));
      await driver.set(ns, entry("A", [2]));
      await driver.set(ns, entry("a ", [3]));
      expect([...(await driver.get(ns, "a"))!.value]).toEqual([1]);
      expect([...(await driver.get(ns, "A"))!.value]).toEqual([2]);
      expect([...(await driver.get(ns, "a "))!.value]).toEqual([3]);
      expect(await driver.delete(ns, ["a", "A", "a "])).toBe(3);
    });

    test("names past 255 characters are hashed, and stay distinct and exact", async () => {
      const longNs = `${ns}-${"n".repeat(300)}`;
      const k1 = `${"k".repeat(300)}-1`;
      const k2 = `${"k".repeat(300)}-2`;
      const tag = "t".repeat(400);
      await driver.set(longNs, entry(k1, [1], [tag]));
      await driver.set(longNs, entry(k2, [2], [tag]));
      const read = await driver.get(longNs, k1);
      expect(read?.key).toBe(k1);
      expect(read?.tags).toEqual([tag]);
      expect([...(await driver.get(longNs, k2))!.value]).toEqual([2]);
      expect(
        (await driver.getMany(longNs, [k2, k1])).map((e) => e?.key),
      ).toEqual([k2, k1]);
      expect(
        await driver.deleteByTags!(longNs, [tag], Date.now() + 60_000),
      ).toBe(2);
      expect((await driver.getStamps(longNs, [tag])).has(tag)).toBe(true);
      expect(
        await driver.acquireLock!(longNs, k1, "o".repeat(300), 10_000),
      ).toBe(true);
      expect(await driver.releaseLock!(longNs, k1, "o".repeat(300))).toBe(true);
    });

    test("counters: below zero, replacing an entry, replaced by a set, restarting once expired", async () => {
      expect(await driver.increment!(ns, "neg", -3, null)).toBe(-3);
      expect(await driver.increment!(ns, "neg", -2, null)).toBe(-5);
      expect(await driver.increment!(ns, "neg", 7, null)).toBe(2);

      await driver.set(ns, entry("was-entry", [9], ["x"]));
      expect(await driver.increment!(ns, "was-entry", 4, null)).toBe(4);
      expect(await driver.get(ns, "was-entry")).toBeUndefined();
      // A counter carries no tags: invalidating the entry's old tag leaves it.
      expect(await driver.deleteByTags!(ns, ["x"], Date.now() + 60_000)).toBe(
        0,
      );
      expect((await driver.getCounter!(ns, "was-entry"))?.value).toBe(4);

      await driver.set(ns, entry("was-entry", [5]));
      expect(await driver.getCounter!(ns, "was-entry")).toBeUndefined();
      expect([...(await driver.get(ns, "was-entry"))!.value]).toEqual([5]);

      await driver.increment!(ns, "expiring", 10, Date.now() - 1);
      const later = Date.now() + 60_000;
      expect(await driver.increment!(ns, "expiring", 1, later)).toBe(1);
      expect((await driver.getCounter!(ns, "expiring"))?.expiresAt).toBe(later);

      await expect(driver.increment!(ns, "frac", 0.5, null)).rejects.toThrow(
        TypeError,
      );
    });

    test("an expired row is a miss everywhere, and the sweeper takes it with its tag rows", async () => {
      const sweepDriver = make("sweep_");
      const past = Date.now() - 1_000;
      await sweepDriver.set(ns, entry("dead", [1], ["t"], past));
      await sweepDriver.set(ns, entry("live", [2], ["t"]));
      expect(await sweepDriver.get(ns, "dead")).toBeUndefined();
      expect(
        (await sweepDriver.getMany(ns, ["dead", "live"]))[0],
      ).toBeUndefined();
      expect(await sweepDriver.touch!(ns, "dead", null)).toBe(false);
      expect(await sweepDriver.sweep!(Date.now(), 1_000)).toBe(1);
      const sql = rawClient(backend);
      try {
        const rows = await sql.unsafe(
          `SELECT k FROM ${runPrefix("sweep_")}tags ORDER BY k`,
        );
        expect(rows.map((row: { k: string }) => row.k)).toEqual(["live"]);
      } finally {
        await sql.close();
      }
      await sweepDriver.close();
    });

    test("touch to the same expiry still answers true", async () => {
      const at = Date.now() + 60_000;
      await driver.set(ns, entry("same", [1], [], at));
      expect(await driver.touch!(ns, "same", at)).toBe(true);
      expect(await driver.touch!(ns, "same", at)).toBe(true);
    });

    test("a lock re-taken by its owner is refreshed, not refused", async () => {
      expect(await driver.acquireLock!(ns, "re", "me", 30_000)).toBe(true);
      expect(await driver.acquireLock!(ns, "re", "me", 30_000)).toBe(true);
      expect(await driver.acquireLock!(ns, "re", "you", 30_000)).toBe(false);
    });

    test("the fence holds under a concurrent invalidation: a pre-invalidation write never survives it", async () => {
      // Each round races a fenced write, whose load began before, against an
      // invalidation of its tag. Whichever lands first, nothing may be left:
      // either the write was fenced, or the invalidation deleted it.
      const raceNs = `race-${process.pid}`;
      const survivors: number[] = [];
      for (let round = 0; round < 60; round++) {
        const key = `k${round}`;
        const tag = `t${round}`;
        const startedAt = Date.now() - 1;
        await Promise.all([
          driver.set(raceNs, entry(key, [1], [tag]), {
            tags: [tag],
            createdAt: startedAt,
          }),
          (async () => {
            await Bun.sleep(round % 3);
            await driver.deleteByTags!(raceNs, [tag], Date.now() + 60_000);
          })(),
        ]);
        if ((await driver.get(raceNs, key)) !== undefined) {
          survivors.push(round);
        }
      }
      expect(survivors).toEqual([]);
    });

    test("an existing client is used and never closed", async () => {
      const sql = rawClient(backend);
      const shared = backend.make({ sql, prefix: prefix("shared_") });
      await shared.set(ns, entry("k", [1]));
      await shared.close();
      // Still open: the driver closes only what it built.
      expect((await sql.unsafe("SELECT 1 AS one"))[0].one).toBe(1);
      await sql.close();
    });

    test("syncSchema creates the tables and reports nothing to change", async () => {
      const fresh = make("sync_");
      expect(await fresh.syncSchema!()).toEqual([]);
      expect(await fresh.syncSchema!({ dryRun: true })).toEqual([]);
      const sql = rawClient(backend);
      try {
        const rows = await sql.unsafe(
          `SELECT COUNT(*) AS n FROM ${runPrefix("sync_")}entries`,
        );
        expect(Number(rows[0].n)).toBe(0);
      } finally {
        await sql.close();
      }
      await fresh.close();
    });

    test("a cache over the driver: getOrSet, tags, counters", async () => {
      const cache = createCache({
        driver: make("cache_"),
        namespace: `cache-${process.pid}`,
        sweepInterval: 0,
      });
      let loads = 0;
      const load = async () => {
        loads++;
        return { n: loads };
      };
      expect(await cache.getOrSet("k", load, { tags: ["g"] })).toEqual({
        n: 1,
      });
      expect(await cache.getOrSet("k", load, { tags: ["g"] })).toEqual({
        n: 1,
      });
      await cache.invalidateTags(["g"]);
      expect(await cache.getOrSet("k", load, { tags: ["g"] })).toEqual({
        n: 2,
      });
      expect(await cache.increment("hits", 5)).toBe(5);
      expect(await cache.get("hits")).toBe(5);
      await cache.close();
    });

    test("the bus: a second driver instance receives what the first publishes", async () => {
      const a = make("bus_", { busPollInterval: 25 });
      const b = make("bus_", { busPollInterval: 25 });
      const received: BusMessage[] = [];
      const unsubscribe = await b.subscribe!(
        (message) => {
          received.push(message);
        },
        () => {},
      );
      const message: BusMessage = {
        type: "invalidate-tags",
        namespace: "app",
        tags: ["users"],
        at: Date.now(),
      };
      await a.publish!(message);
      await waitFor("the message", () => received.length > 0);
      expect(received).toEqual([message]);
      await unsubscribe();
      await a.close();
      await b.close();
    });

    test("a malformed prefix is refused before anything connects", () => {
      expect(() =>
        backend.make({ url, prefix: "bad-prefix; DROP TABLE x" }),
      ).toThrow(TypeError);
    });

    if (name === "postgres") {
      test("unlogged: true creates UNLOGGED tables", async () => {
        const unlogged = make("unlogged_", { unlogged: true });
        await unlogged.connect!();
        const sql = rawClient(backend);
        try {
          const rows = await sql.unsafe(
            "SELECT relname, relpersistence FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname",
            [
              ["entries", "locks", "stamps", "tags"].map(
                (table) => `${runPrefix("unlogged_")}${table}`,
              ),
            ],
          );
          expect(
            rows.map((row: { relpersistence: string }) => row.relpersistence),
          ).toEqual(["u", "u", "u", "u"]);
        } finally {
          await sql.close();
        }
        await unlogged.close();
      });

      test("a NOTIFY payload too big for Postgres becomes a clear of its namespace", async () => {
        const bus = make("bus_");
        const received: BusMessage[] = [];
        const unsubscribe = await bus.subscribe!(
          (message) => {
            received.push(message);
          },
          () => {},
        );
        await bus.publish!({
          type: "delete",
          namespace: "big",
          keys: Array.from({ length: 2_000 }, (_, index) => `key-${index}`),
          at: 1,
        });
        await waitFor("the flush", () => received.length > 0);
        expect(received).toEqual([{ type: "clear", namespace: "big", at: 1 }]);
        await unsubscribe();
        await bus.close();
      });

      test("a dropped LISTEN connection is reported as a gap once it is back", async () => {
        const bus = make("gap_");
        let gaps = 0;
        const received: BusMessage[] = [];
        const unsubscribe = await bus.subscribe!(
          (message) => {
            received.push(message);
          },
          () => {
            gaps++;
          },
        );
        const sql = rawClient(backend);
        try {
          // The listening backend is the one whose last statement LISTENed on
          // this prefix's channel.
          const killed = await sql.unsafe(
            "SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query ILIKE 'LISTEN%' AND datname = current_database() AND query LIKE $1",
            [`%${(bus as PostgresCacheDriver).channel}%`],
          );
          expect(killed.length).toBe(1);
        } finally {
          await sql.close();
        }
        await waitFor("the gap", () => gaps > 0, 15_000);
        // And it delivers again afterwards.
        await bus.publish!({ type: "clear", namespace: "after", at: 2 });
        await waitFor("delivery after the reconnect", () =>
          received.some((message) => message.namespace === "after"),
        );
        await unsubscribe();
        await bus.close();
        // Bun's reconnect backs off exponentially; measured ~0.25 s idle.
      }, 20_000);
    } else {
      test("maxEntryBytes is read from the server's max_allowed_packet", async () => {
        const sql = rawClient(backend);
        try {
          const [row] = await sql.unsafe(
            "SELECT @@max_allowed_packet AS packet",
          );
          expect(kitDriver.capabilities.maxEntryBytes).toBe(
            Number(row.packet) - 64 * 1024,
          );
        } finally {
          await sql.close();
        }
      });

      test("the bus: rows pruned before a subscriber read them are reported as a gap", async () => {
        const writer = make("lag_", { busRetention: 1 });
        // Polls every 300 ms: the publish, prune and publish below all land
        // before its first poll, so the pruned row is never read.
        const reader = make("lag_", { busPollInterval: 300 });
        let gaps = 0;
        const received: string[] = [];
        await writer.publish!({ type: "clear", namespace: "seed", at: 0 });
        const unsubscribe = await reader.subscribe!(
          (message) => {
            received.push(message.namespace);
          },
          () => {
            gaps++;
          },
        );
        await writer.publish!({ type: "clear", namespace: "lost", at: 1 });
        await Bun.sleep(5);
        // The sweeper prunes rows older than `busRetention` (1 ms here).
        await writer.sweep!(Date.now(), 1_000);
        await writer.publish!({ type: "clear", namespace: "kept", at: 2 });
        await waitFor("the gap", () => gaps > 0);
        await waitFor("the row after it", () => received.includes("kept"));
        expect(received).toEqual(["kept"]);
        await unsubscribe();
        await writer.close();
        await reader.close();
      });
    }

    afterAll(async () => {
      await driver.close();
    });
  });
}
