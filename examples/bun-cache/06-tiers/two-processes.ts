/**
 * Two processes, one L2, an L1 each — how long an invalidation takes to reach
 * the other process's L1, and what a gap does (PR-T1).
 *
 * ```bash
 * bun 06-tiers/two-processes.ts
 * EXAMPLE_POSTGRES_URL=postgres://user:pass@localhost:5432/app \
 *   EXAMPLE_REDIS_URL=redis://localhost:6379/13 bun 06-tiers/two-processes.ts
 * ```
 *
 * - This file is both processes: run plainly it is the parent (the writer);
 *   it starts itself again with `child` as its first argument and an
 *   explicit environment as the reader, a cache with its own L1 over the same
 *   L2, driven by JSON lines on stdin.
 * - Passes: an SQLite file with the driver's polled bus (250 ms) always;
 *   Postgres with `pgBus` (`LISTEN`/`NOTIFY`) on a channel of its own when
 *   `EXAMPLE_POSTGRES_URL` is set; the
 *   SQLite file with `redisBus` when `EXAMPLE_REDIS_URL` is. A pass whose URL
 *   is unset is named as skipped; a URL set but unreachable fails.
 * - The window: the reader first holds the old value in its L1 (and keeps
 *   reading it), then the writer changes the value. The time from the
 *   writer's `set` resolving to the reader's first read of the new value is
 *   printed (both ends on `performance.timeOrigin + now()`). What is
 *   guaranteed is that the invalidation arrives eventually — within the bus's
 *   delivery, or one poll for a polled bus. The assertion is only a generous
 *   bound ({@link BOUND_MS}) that says "arrived, not stuck"; the figures
 *   printed are what this run measured, not a promise.
 * - A gap: a write made by a cache that publishes nothing (`bus: false`)
 *   is not seen by the reader, which keeps serving its copy. Then a gap is
 *   forced on the reader's subscription — SQLite: two bus rows inserted and
 *   pruned between its polls; Redis: its pub/sub connection killed by id;
 *   Postgres: the `LISTEN` backends terminated — and the reader flushes its
 *   L1 (`stats().l1.flushes` grows) and reads the new value. Messages lost
 *   in a gap are unknowable, so the whole L1 goes.
 * - Timing is asserted, so `run-all.ts` runs this example alone.
 * - Cleanup: the temporary directory with the SQLite files is deleted; on
 *   Postgres exactly the tables of this run's prefix
 *   (`bun_cache_example_<pid>_t_`) are dropped; Redis pub/sub writes no keys.
 */
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { RedisClient, SQL } from "bun";
import type { Cache, CacheBus, CacheDriver } from "@kingsleyweb/bun-cache";
import {
  createCache,
  pgBus,
  postgresDriver,
  redisBus,
  sqliteDriver,
} from "@kingsleyweb/bun-cache";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

/**
 * How long a delivery may take here, in ms. Generous on purpose (a shared,
 * loaded machine; ten times what a polled bus needs): it tells "delivered"
 * from "never delivered", it is not a latency target.
 */
const BOUND_MS = 5_000;

/** How many times the window is measured per pass. */
const ROUNDS = 5;

/** What the parent tells the reader to open. */
interface Job {
  /** The shared L2. */
  driver:
    | { kind: "sqlite"; path: string }
    | { kind: "postgres"; url: string; prefix: string };
  /** The driver's bus (`"auto"`), or a Redis or Postgres channel. */
  bus: "auto" | { kind: "redis" | "pg"; url: string; channel: string };
}

/** One command to the reader. */
interface Command {
  /** Echoed in the answer. */
  id: number;
  /** What to do. */
  op: "armed" | "get" | "watch" | "stats" | "close";
  /** The key. */
  key?: string;
  /** For `watch`: the value awaited. */
  value?: unknown;
  /** For `watch`: how long to try, in ms. */
  timeoutMs?: number;
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
  /** How many reads each tier served while watching. */
  tiers: Record<string, number>;
}

/** The clock both processes read: wall-clock based, sub-millisecond. */
function clock(): number {
  return performance.timeOrigin + performance.now();
}

/** Opens the shared L2 the way the job says. */
function openDriver(driver: Job["driver"]): CacheDriver {
  return driver.kind === "sqlite"
    ? sqliteDriver({ path: driver.path })
    : postgresDriver({ url: driver.url, prefix: driver.prefix });
}

/** Opens the bus the job says: the driver's own, a Redis one or a Postgres one. */
function openBus(bus: Job["bus"]): "auto" | CacheBus {
  if (bus === "auto") {
    return "auto";
  }
  return bus.kind === "redis"
    ? redisBus({ url: bus.url, channel: bus.channel })
    : pgBus({ url: bus.url, channel: bus.channel });
}

/* ------------------------------------------------------------------ */
// The reader: `bun two-processes.ts child <job json>`.
if (process.argv[2] === "child") {
  const job = JSON.parse(process.argv[3] ?? "{}") as Job;
  const cache = createCache({
    driver: openDriver(job.driver),
    namespace: "example",
    l1: true,
    bus: openBus(job.bus),
    sweepInterval: 0,
  });
  let lastTier: "l1" | "l2" | undefined;
  cache.on("hit", ({ tier }) => {
    lastTier = tier;
  });

  /** Performs one command. */
  const perform = async (command: Command): Promise<unknown> => {
    const key = command.key ?? "";
    switch (command.op) {
      case "armed":
        // L1 arms (flushes) once the bus listens.
        await waitFor(
          "the bus to listen",
          () => (cache.stats().l1?.flushes ?? 0) >= 1,
        );
        return true;
      case "get": {
        lastTier = undefined;
        return { value: await cache.get(key), tier: lastTier } satisfies Got;
      }
      case "watch": {
        const deadline = Date.now() + (command.timeoutMs ?? BOUND_MS);
        const tiers: Record<string, number> = { l1: 0, l2: 0, miss: 0 };
        for (;;) {
          lastTier = undefined;
          const value = await cache.get(key);
          tiers[lastTier ?? "miss"]++;
          if (value === command.value) {
            return { seenAt: clock(), tiers } satisfies Watched;
          }
          if (Date.now() > deadline) {
            return { timedOut: true, tiers } satisfies Watched;
          }
          // Yield, so the bus can deliver between reads.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      case "stats":
        return cache.stats();
      case "close":
        await cache.close();
        return true;
    }
  };

  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      const command = JSON.parse(line) as Command;
      let answer: unknown;
      try {
        answer = { id: command.id, result: await perform(command) };
      } catch (error) {
        answer = { id: command.id, error: String(error) };
      }
      await Bun.write(Bun.stdout, `${JSON.stringify(answer)}\n`);
      if (command.op === "close") {
        process.exit(0);
      }
    }
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ */
// The parent.

/** A started reader. */
interface Reader {
  /** Its process id (its Redis subscriber connection's name carries it). */
  pid: number;
  /** Sends a command and resolves with its result. */
  request: <T = unknown>(command: Omit<Command, "id">) => Promise<T>;
  /** Closes its cache and waits for it to exit. */
  close: () => Promise<void>;
}

/** Starts this file as the reader and waits until its L1 is armed. */
async function startReader(job: Job): Promise<Reader> {
  const child = Bun.spawn(
    [process.execPath, import.meta.path, "child", JSON.stringify(job)],
    {
      // An explicit environment: the reader inherits nothing else.
      env: { PATH: process.env.PATH ?? "" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
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
          waiter?.reject(new Error(`reader: ${answer.error}`));
        }
      }
    }
    const reason = new Error(`the reader exited (${await child.exited})`);
    for (const waiter of pending.values()) {
      waiter.reject(reason);
    }
    pending.clear();
  })();
  const reader: Reader = {
    pid: child.pid,
    request: async <T>(command: Omit<Command, "id">) => {
      const id = next++;
      const answer = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      void child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      void child.stdin.flush();
      return (await answer) as T;
    },
    close: async () => {
      await reader.request({ op: "close" }).catch(() => undefined);
      void child.stdin.end();
      await child.exited;
    },
  };
  await reader.request({ op: "armed" });
  return reader;
}

/** One L2 and bus: how to open it from the parent, and how to force a gap on the reader. */
interface Pass {
  /** The title. */
  name: string;
  /** The reader's job. */
  job: Job;
  /** The parent's cache on the same L2 and bus. `publish: false` gives one that publishes nothing and keeps no L1. */
  open: (publish: boolean) => Cache;
  /** Forces a gap on the subscription of the reader with this pid. */
  forceGap: (readerPid: number) => Promise<void>;
  /** Releases what the pass opened. */
  cleanup: () => Promise<void>;
}

/** p50 and max of a sample, rounded to 0.01 ms. */
function describe(samples: number[]): { p50: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    p50: round(sorted[Math.floor((sorted.length - 1) / 2)]),
    max: round(sorted.at(-1) ?? 0),
  };
}

title("two processes, one L2: the window, and a gap");

const dir = await mkdtemp(join(tmpdir(), "bun-cache-example-"));
const passes: Pass[] = [];
const skipped: string[] = [];

/** An SQLite-file pass; the file is read through `bus` (the driver's own when `"auto"`). */
function sqlitePass(
  name: string,
  file: string,
  bus: Job["bus"],
  forceGap: Pass["forceGap"],
  cleanup: Pass["cleanup"] = () => Promise.resolve(),
): Pass {
  const path = join(dir, file);
  return {
    name,
    job: { driver: { kind: "sqlite", path }, bus },
    open: (publish) =>
      createCache({
        driver: sqliteDriver({ path }),
        namespace: "example",
        ...(publish ? { l1: true, bus: openBus(bus) } : { bus: false }),
        sweepInterval: 0,
      }),
    forceGap,
    cleanup,
  };
}

passes.push(
  sqlitePass(
    "an SQLite file, its polled bus (250 ms)",
    "polled.db",
    "auto",
    () => {
      // Two rows published and pruned between the reader's polls: what a
      // reader further behind than `busRetention` would miss. One transaction,
      // so no poll sees them in between.
      const db = new Database(join(dir, "polled.db"));
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
    },
  ),
);

const redisUrl = process.env.EXAMPLE_REDIS_URL;
if (redisUrl) {
  const helper = new RedisClient(redisUrl);
  try {
    await helper.send("PING", []);
  } catch (error) {
    helper.close();
    throw new Error("EXAMPLE_REDIS_URL is set but unreachable", {
      cause: error,
    });
  }
  // A channel is server-wide (the URL's database number does not scope it).
  const channel = `bun-cache-example:${process.pid}:two-processes`;
  passes.push(
    sqlitePass(
      "an SQLite file, with redisBus",
      "redis.db",
      { kind: "redis", url: redisUrl, channel },
      async (readerPid) => {
        // The reader's own subscriber connection: its name carries its pid
        // (`bun-cache-bus-<pid>-…`). `CLIENT KILL` by id, nothing else.
        const list = (await helper.send("CLIENT", [
          "LIST",
          "TYPE",
          "pubsub",
        ])) as string;
        const lines = list
          .split("\n")
          .filter((line) => line.includes(` name=bun-cache-bus-${readerPid}-`));
        const id = /\bid=(\d+)/.exec(lines[0] ?? "")?.[1];
        if (lines.length !== 1 || id === undefined) {
          throw new Error(
            `expected one pub/sub connection of the reader, found ${lines.length}`,
          );
        }
        await helper.send("CLIENT", ["KILL", "ID", id]);
      },
      () => {
        helper.close();
        return Promise.resolve();
      },
    ),
  );
} else {
  skipped.push("redisBus (EXAMPLE_REDIS_URL is unset)");
}

const postgresUrl = process.env.EXAMPLE_POSTGRES_URL;
if (postgresUrl) {
  const helper = new SQL(postgresUrl);
  try {
    await helper`SELECT 1`;
  } catch (error) {
    await helper.close();
    throw new Error("EXAMPLE_POSTGRES_URL is set but unreachable", {
      cause: error,
    });
  }
  const prefix = `bun_cache_example_${process.pid}_t_`;
  // The bus is `pgBus` on a channel this example names (an SQL identifier;
  // the pid keeps two runs apart): the same `LISTEN`/`NOTIFY` as the
  // driver's own bus, on a channel known here.
  const channel = `bun_cache_example_${process.pid}_two_processes`;
  const bus = { kind: "pg", url: postgresUrl, channel } as const;
  passes.push({
    name: "Postgres, pgBus (LISTEN/NOTIFY)",
    job: {
      driver: { kind: "postgres", url: postgresUrl, prefix },
      bus,
    },
    open: (publish) =>
      createCache({
        driver: postgresDriver({ url: postgresUrl, prefix }),
        namespace: "example",
        ...(publish ? { l1: true, bus: openBus(bus) } : { bus: false }),
        sweepInterval: 0,
      }),
    forceGap: async () => {
      // The backends LISTENing on this run's channel — the reader's and the
      // parent's. Bun reconnects each and re-runs its LISTEN, which is what
      // reports the gap.
      const rows = await helper.unsafe<{ pid: number }[]>(
        "SELECT pid FROM pg_stat_activity WHERE query = $1",
        [`LISTEN "${channel}"`],
      );
      if (rows.length === 0) {
        throw new Error("no LISTEN backend found for the channel");
      }
      for (const row of rows) {
        await helper.unsafe("SELECT pg_terminate_backend($1)", [row.pid]);
      }
    },
    cleanup: async () => {
      // Exactly this run's tables — never a pattern.
      for (const table of ["entries", "tags", "stamps", "locks", "bus"]) {
        await helper.unsafe(`DROP TABLE IF EXISTS ${prefix}${table}`);
      }
      await helper.close();
    },
  });
} else {
  skipped.push("Postgres (EXAMPLE_POSTGRES_URL is unset)");
}

if (skipped.length > 0) {
  show("skipped passes", skipped);
}

try {
  for (const pass of passes) {
    step(pass.name);
    const writer = pass.open(true);
    const reader = await startReader(pass.job);
    let counter = 0;
    /** A key of this pass. */
    const key = (name: string) => `${name}-${process.pid}-${counter++}`;
    /**
     * Reads until the reader serves `value` from its L1. The writer's message
     * about the write that produced it can reach the reader after its first
     * read already copied the new value, and drop that copy once; the next
     * read copies it again.
     */
    const holding = async (k: string, value: unknown): Promise<void> => {
      await waitFor(
        `the reader to hold ${String(value)} in L1`,
        async () => {
          const got = await reader.request<Got>({ op: "get", key: k });
          return got.value === value && got.tier === "l1";
        },
        { timeout: BOUND_MS * 2, interval: 10 },
      );
    };

    try {
      await waitFor(
        "the writer's bus to listen",
        () => (writer.stats().l1?.flushes ?? 0) >= 1,
      );

      /* ------------------------------------------------------------ */
      const k = key("window");
      const windows: number[] = [];
      let servedFromL1 = true;
      for (let n = 0; n < ROUNDS; n++) {
        await writer.set(k, `v${n}`);
        await holding(k, `v${n}`);
        const watching = reader.request<Watched>({
          op: "watch",
          key: k,
          value: `v${n + 1}`,
          timeoutMs: BOUND_MS,
        });
        // A random delay, so the write lands at a random phase of a polled
        // bus's interval.
        await Bun.sleep(20 + Math.floor(Math.random() * 250));
        await writer.set(k, `v${n + 1}`);
        const changed = clock();
        const seen = await watching;
        if (seen.timedOut || seen.seenAt === undefined) {
          windows.push(Number.POSITIVE_INFINITY);
          continue;
        }
        windows.push(Math.max(0, seen.seenAt - changed));
        // The old value was served from L1 until the message arrived.
        servedFromL1 &&= (seen.tiers.l1 ?? 0) > 0;
      }
      const measured = describe(windows);
      show(`${pass.name}: window over ${ROUNDS} rounds (ms)`, measured);
      check(
        `every change reached the reader's L1 within ${BOUND_MS} ms (eventual invalidation)`,
        Number.isFinite(measured.max) && measured.max < BOUND_MS,
        windows,
      );
      check("until then the reader served the old value from L1", servedFromL1);

      /* ------------------------------------------------------------ */
      const g = key("gap");
      await writer.set(g, "v1");
      // Let the message about v1 land first (on a polled bus, up to a poll
      // later), so only the gap can drop the copy below.
      await Bun.sleep(1_000);
      await holding(g, "v1");
      // A cache that publishes nothing changes L2 behind the reader's back.
      const silent = pass.open(false);
      await silent.set(g, "v2");
      await silent.close();
      await Bun.sleep(1_000);
      checkEqual(
        "a write the reader was never told of: it still serves v1 from L1",
        await reader.request<Got>({ op: "get", key: g }),
        { value: "v1", tier: "l1" },
      );
      const before = (
        await reader.request<{ l1: { flushes: number } }>({ op: "stats" })
      ).l1.flushes;
      await pass.forceGap(reader.pid);
      const seen = await reader.request<Watched>({
        op: "watch",
        key: g,
        value: "v2",
        timeoutMs: 15_000,
      });
      check("after a gap the reader reads v2", seen.timedOut !== true, seen);
      const after = (
        await reader.request<{ l1: { flushes: number } }>({ op: "stats" })
      ).l1.flushes;
      show(`${pass.name}: reader's L1 flushes`, { before, after });
      check("…because its L1 was flushed", after > before, { before, after });
    } finally {
      await reader.close();
      await writer.close();
    }
  }
} finally {
  for (const pass of passes) {
    await pass.cleanup();
  }
  await rm(dir, { recursive: true, force: true });
}

summary();
