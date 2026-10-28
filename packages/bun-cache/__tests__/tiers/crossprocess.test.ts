/**
 * Two processes sharing an L2, each with its own L1 (plan §4.3): this test
 * process and a spawned `tier-worker.ts` (explicit env, the job on argv).
 *
 * - An invalidation in one is seen in the other's L1 once the bus delivers,
 *   and the window is measured: from the writer's `set` resolving to the
 *   reader's first read of the new value, both on
 *   `performance.timeOrigin + now()`. Every round first checks the reader is
 *   serving the old value **from L1**, so the window is L1's staleness.
 * - A gap flushes the reader's L1: a write made without publishing is not
 *   seen until a forced gap (SQLite: rows pruned past the reader; Postgres:
 *   its `LISTEN` backend terminated), and then is.
 * - The control: with `bus: false` the reader serves its copy until
 *   `l1.ttl`.
 *
 * L2s: an SQLite file (its polled bus, 250 ms by default); Postgres
 * (`LISTEN`/`NOTIFY`) when `BUN_CACHE_TEST_POSTGRES_URL` (or the bun-jobs
 * fallback) is set; the SQLite file with `redisBus` when a Redis URL is.
 * Set `BUN_CACHE_MEASURE=1` to print each pass's windows on stderr.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { RedisClient, SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Cache, CacheBus, CacheDriver } from "../../lib/index";
import {
  createCache,
  postgresDriver,
  redisBus,
  sqliteDriver,
} from "../../lib/index";
import type { PostgresCacheDriver } from "../../lib/drivers/postgres";
import {
  dropTables,
  reachError,
  redisBackend,
  redisReachError,
  runPrefix,
  sqlBackends,
} from "../drivers/backends";
import { reportNotConfigured, reportUnreachable } from "../drivers/sqlSuite";
import type { TierJob } from "./tier-worker";

/** One spawned reader. */
interface TierWorker {
  /** Its process id (its bus connections carry it in their names). */
  pid: number;
  /** Sends a command; resolves with its result. */
  request: <T = unknown>(command: Record<string, unknown>) => Promise<T>;
  /** Closes its cache and waits for it to exit. */
  close: () => Promise<void>;
}

/** What `get` answers. */
interface Got {
  /** The value read. */
  value: unknown;
  /** The tier that served it; absent on a miss. */
  tier?: "l1" | "l2";
}

/** What `watch` answers. */
interface Watched {
  /** When the reader first saw the value, on the shared clock. */
  seenAt?: number;
  /** Set when it never did. */
  timedOut?: boolean;
  /** What it last read, when it timed out. */
  last?: unknown;
  /** How many reads each tier served while watching. */
  tiers: Record<string, number>;
}

/** The shared clock: wall-clock-based, sub-millisecond, the same in both processes. */
function clock(): number {
  return performance.timeOrigin + performance.now();
}

/** Spawns a reader for `job`, with an explicit environment (nothing inherited but `PATH`). */
async function spawnWorker(job: TierJob): Promise<TierWorker> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      new URL("./tier-worker.ts", import.meta.url).pathname,
      JSON.stringify(job),
    ],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let next = 0;
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const answer = JSON.parse(buffered.slice(0, newline)) as {
          id: number;
          result?: unknown;
          error?: string;
        };
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        const waiter = pending.get(answer.id);
        pending.delete(answer.id);
        if (answer.error === undefined) {
          waiter?.resolve(answer.result);
        } else {
          waiter?.reject(new Error(`worker: ${answer.error}`));
        }
      }
    }
    const reason = new Error(
      `the worker exited (${await child.exited}): ${await stderr}`,
    );
    for (const waiter of pending.values()) {
      waiter.reject(reason);
    }
    pending.clear();
  })();
  const worker: TierWorker = {
    pid: child.pid,
    request: async <T>(command: Record<string, unknown>) => {
      const id = next++;
      const answer = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      void child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      void child.stdin.flush();
      return (await answer) as T;
    },
    close: async () => {
      await worker.request({ op: "close" }).catch(() => undefined);
      void child.stdin.end();
      await child.exited;
    },
  };
  await worker.request({ op: "armed" });
  return worker;
}

/** p50 / p95 / max of a sample, in ms, rounded to 0.01. */
function summary(samples: number[]): { p50: number; p95: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) =>
    Math.round(
      sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] *
        100,
    ) / 100;
  return { p50: at(0.5), p95: at(0.95), max: at(1) };
}

/** One L2 + bus configuration. */
interface Pass {
  /** The title. */
  name: string;
  /** The reader's job (the bus is `"auto"` unless said). */
  job: (bus: TierJob["bus"], l1Ttl?: number) => TierJob;
  /** A writer cache in this process on the same L2 and bus. */
  writer: (bus: "auto" | false | CacheBus, l1: boolean) => Cache;
  /** The bus option this pass's writer and reader use. */
  bus: () => "auto" | CacheBus;
  /** The reader's job bus. */
  jobBus: TierJob["bus"];
  /** The most a delivery may take here, in ms (generous: a loaded machine). */
  bound: number;
  /** Forces a gap on the subscription of the reader with this pid. */
  forceGap: (readerPid: number) => Promise<void>;
  /** After everything. */
  cleanup: () => Promise<void>;
}

/** Registers the cases for one pass. */
function registerPass(title: string, pass: () => Pass): void {
  let it: Pass;
  let writer: Cache;
  let reader: TierWorker;
  let round = 0;
  /** A key of this run. */
  const key = (name: string) => `${name}-${process.pid}-${round++}`;
  /**
   * Reads until the reader serves `value` from its L1. The writer's message
   * about the write that produced it can reach the reader after its first
   * read already fetched (and copied) the new value, and drop that copy once;
   * the next read copies it again.
   */
  const holding = async (k: string, value: unknown): Promise<void> => {
    const deadline = Date.now() + it.bound * 4;
    for (;;) {
      const got = await reader.request<Got>({ op: "get", key: k });
      if (got.value === value && got.tier === "l1") {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`the reader never held ${String(value)} in L1`);
      }
      await Bun.sleep(10);
    }
  };

  describe(`two processes: ${title}`, () => {
    beforeAll(async () => {
      it = pass();
      writer = it.writer(it.bus(), true);
      reader = await spawnWorker(it.job(it.jobBus));
    });
    afterAll(async () => {
      await reader?.close();
      await writer?.close();
      await it?.cleanup();
    });

    test("an invalidation in one is seen in the other's L1 once the bus delivers (window measured)", async () => {
      const k = key("window");
      const windows: number[] = [];
      for (let n = 0; n < 15; n++) {
        await writer.set(k, `v${n}`);
        // The reader holds the current value in its L1 …
        await holding(k, `v${n}`);
        // … is watching it …
        const watching = reader.request<Watched>({
          op: "watch",
          key: k,
          value: `v${n + 1}`,
          timeoutMs: it.bound * 4,
        });
        // A random delay, so the write lands at a random phase of a polled
        // bus's interval (otherwise every round starts just after a poll).
        await Bun.sleep(20 + Math.floor(Math.random() * 250));
        // … when the writer changes it.
        await writer.set(k, `v${n + 1}`);
        const changed = clock();
        const seen = await watching;
        expect(seen.timedOut).toBeUndefined();
        // The old value came from L1 until the message arrived.
        expect(seen.tiers.l1).toBeGreaterThan(0);
        windows.push(Math.max(0, seen.seenAt! - changed));
      }
      const measured = summary(windows);
      if (process.env.BUN_CACHE_MEASURE === "1") {
        process.stderr.write(
          `${JSON.stringify({ pass: it.name, window: measured, n: windows.length })}\n`,
        );
      }
      expect(measured.max).toBeLessThan(it.bound);
    }, 120_000);

    test("a delete and a tag invalidation reach the other L1", async () => {
      const k = key("drop");
      await writer.set(k, "v", { tags: ["t"] });
      await holding(k, "v");
      await writer.delete(k);
      // No `value`: the watch waits for a miss.
      const deleted = await reader.request<Watched>({
        op: "watch",
        key: k,
        timeoutMs: it.bound * 4,
      });
      expect(deleted.timedOut).toBeUndefined();

      await writer.set(k, "tagged", { tags: [`t-${k}`] });
      await holding(k, "tagged");
      await writer.invalidateTags([`t-${k}`]);
      const gone = await reader.request<Watched>({
        op: "watch",
        key: k,
        timeoutMs: it.bound * 4,
      });
      expect(gone.timedOut).toBeUndefined();
    }, 60_000);

    test("a gap flushes the other's L1: a write it was never told of is seen after one", async () => {
      const k = key("gap");
      await writer.set(k, "v1");
      // Let the message about v1 land first (on a polled bus, up to a poll
      // later), so nothing but the gap can drop the copy below.
      await Bun.sleep(it.bound);
      await holding(k, "v1");
      // A writer that publishes nothing changes L2 behind the reader's back.
      const silent = it.writer(false, false);
      await silent.set(k, "v2");
      await silent.close();
      await Bun.sleep(it.bound);
      expect(await reader.request<Got>({ op: "get", key: k })).toEqual({
        value: "v1",
        tier: "l1",
      });
      const before = (
        await reader.request<{ l1: { flushes: number } }>({ op: "stats" })
      ).l1.flushes;
      await it.forceGap(reader.pid);
      const seen = await reader.request<Watched>({
        op: "watch",
        key: k,
        value: "v2",
        timeoutMs: 15_000,
      });
      expect(seen.timedOut).toBeUndefined();
      const after = (
        await reader.request<{ l1: { flushes: number } }>({ op: "stats" })
      ).l1.flushes;
      expect(after).toBeGreaterThan(before);
    }, 60_000);
  });
}

/* ------------------------------------------------------------------ */
/* The passes                                                         */
/* ------------------------------------------------------------------ */

const dir = mkdtempSync(join(tmpdir(), `bun-cache-tiers-${process.pid}-`));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** An SQLite-file pass, with the driver's polled bus or a separate one. */
function sqlitePass(
  name: string,
  file: string,
  bus: () => "auto" | CacheBus,
  jobBus: TierJob["bus"],
  bound: number,
  forceGap?: (readerPid: number) => Promise<void>,
): Pass {
  const path = join(dir, file);
  const writers: CacheDriver[] = [];
  return {
    name,
    bus,
    jobBus,
    bound,
    job: (jobBusOverride, l1Ttl) => ({
      driver: { kind: "sqlite", path },
      bus: jobBusOverride,
      ...(l1Ttl === undefined ? {} : { l1Ttl }),
    }),
    writer: (writerBus, l1) => {
      const driver = sqliteDriver({ path });
      writers.push(driver);
      return createCache({
        driver,
        bus: writerBus,
        ...(l1 ? { l1: true } : {}),
        sweepInterval: 0,
      });
    },
    forceGap:
      forceGap ??
      (() => {
        // Two rows published and pruned before the reader's next poll —
        // what a reader further behind than `busRetention` misses. One
        // transaction, so no poll sees them in between.
        const db = new Database(path);
        try {
          db.run("PRAGMA busy_timeout=5000");
          db.transaction(() => {
            db.run(
              "INSERT INTO bun_cache_bus (at, msg) VALUES (0, '{}'), (0, '{}')",
            );
            db.run(
              "DELETE FROM bun_cache_bus WHERE seq > (SELECT seq FROM sqlite_sequence WHERE name = 'bun_cache_bus') - 2",
            );
          })();
        } finally {
          db.close();
        }
        return Promise.resolve();
      }),
    cleanup: () => Promise.resolve(),
  };
}

registerPass("an SQLite file, its polled bus (250 ms)", () =>
  sqlitePass("sqlite", "polled.db", () => "auto", "auto", 1_500),
);

const redis = redisBackend();
if (redis.url === undefined) {
  reportNotConfigured("redis", redis.variable);
} else {
  const unreachable = await redisReachError(redis.url);
  if (unreachable !== undefined) {
    reportUnreachable("redis", redis.variable, unreachable);
  } else {
    const url = redis.url;
    const channel = `bun-cache-test:${process.pid}:${Date.now()}:tiers`;
    const helper = new RedisClient(url);
    registerPass("an SQLite file, with redisBus", () =>
      sqlitePass(
        "sqlite+redis",
        "redis.db",
        () => redisBus({ url, channel }),
        { kind: "redis", url, channel },
        500,
        async (readerPid) => {
          // Only the reader's own pub/sub connection: its name carries its
          // pid (`bun-cache-bus-<pid>-…`); `CLIENT KILL` by id, nothing else.
          const list = (await helper.send("CLIENT", [
            "LIST",
            "TYPE",
            "pubsub",
          ])) as string;
          const lines = list
            .split("\n")
            .filter((line) =>
              line.includes(` name=bun-cache-bus-${readerPid}-`),
            );
          expect(lines.length).toBe(1);
          const id = /\bid=(\d+)/.exec(lines[0])?.[1];
          await helper.send("CLIENT", ["KILL", "ID", id!]);
        },
      ),
    );
    afterAll(() => {
      helper.close();
    });
  }
}

const postgres = sqlBackends().find((backend) => backend.name === "postgres")!;
if (postgres.url === undefined) {
  reportNotConfigured("postgres", postgres.variable);
} else {
  const unreachable = await reachError(postgres);
  if (unreachable !== undefined) {
    reportUnreachable("postgres", postgres.variable, unreachable);
  } else {
    const url = postgres.url;
    const prefix = runPrefix("tiers_");
    registerPass("Postgres, LISTEN/NOTIFY", () => {
      const channel = (postgresDriver({ url, prefix }) as PostgresCacheDriver)
        .channel;
      const helper = new SQL(url);
      return {
        name: "Postgres, LISTEN/NOTIFY",
        bus: () => "auto",
        jobBus: "auto",
        bound: 500,
        job: (jobBus, l1Ttl) => ({
          driver: { kind: "postgres", url, prefix },
          bus: jobBus,
          ...(l1Ttl === undefined ? {} : { l1Ttl }),
        }),
        writer: (writerBus, l1) =>
          createCache({
            driver: postgresDriver({ url, prefix }),
            bus: writerBus,
            ...(l1 ? { l1: true } : {}),
            sweepInterval: 0,
          }),
        forceGap: async () => {
          // The backends LISTENing on this run's channel (the reader's, and
          // this process's writer's): Bun reconnects them and re-runs
          // `onlisten`, which is the gap.
          const rows = await helper.unsafe<{ pid: number }[]>(
            "SELECT pid FROM pg_stat_activity WHERE query = $1",
            [`LISTEN "${channel}"`],
          );
          expect(rows.length).toBeGreaterThan(0);
          for (const row of rows) {
            await helper.unsafe("SELECT pg_terminate_backend($1)", [row.pid]);
          }
        },
        cleanup: async () => {
          await helper.close();
          await dropTables(postgres, prefix);
        },
      };
    });
  }
}

describe("two processes, no bus (the control)", () => {
  test("the other L1 serves its copy until l1.ttl, then reads the new value", async () => {
    const it = sqlitePass("control", "control.db", () => "auto", false, 0);
    const writer = it.writer(false, false);
    const reader = await spawnWorker(it.job(false, 600));
    try {
      await writer.set("k", "v1");
      await reader.request({ op: "get", key: "k" });
      await writer.set("k", "v2");
      const started = clock();
      const seen = await reader.request<Watched>({
        op: "watch",
        key: "k",
        value: "v2",
        timeoutMs: 5_000,
      });
      const window = seen.seenAt! - started;
      // Not before l1.ttl (less the time since the copy was taken) …
      expect(window).toBeGreaterThan(300);
      // … and not much after it.
      expect(window).toBeLessThan(2_000);
      expect(seen.tiers.l1).toBeGreaterThan(0);
    } finally {
      await reader.close();
      await writer.close();
    }
  }, 30_000);
});
