/**
 * A bus of its own — `redisBus()` or `pgBus()` keeping L1s coherent over an
 * L2 whose own bus is slow (PR-T1).
 *
 * ```bash
 * EXAMPLE_REDIS_URL=redis://localhost:6379/13 bun 06-tiers/separate-bus.ts
 * EXAMPLE_POSTGRES_URL=postgres://user:pass@localhost:5432/app bun 06-tiers/separate-bus.ts
 * ```
 *
 * - The L2 is an SQLite file whose own bus is a polled table; here it polls
 *   every minute (`busPollInterval: 60_000`), which is the slow bus. Two
 *   caches, each with its own driver on the file and its own L1, stand for
 *   two processes.
 * - `bus: redisBus(url)` or `bus: pgBus(url)` replaces the driver's bus. A
 *   message names what changed (never a value), so it works over any L2 —
 *   an S3 or file L2 with a Redis bus is the same shape — and the cache's
 *   `close()` closes the bus.
 * - It runs for each of `EXAMPLE_REDIS_URL` and `EXAMPLE_POSTGRES_URL` that
 *   is set and says which it skipped; with neither set it prints `skipped:`
 *   and exits 0. A URL that is set but unreachable fails, naming the
 *   variable.
 * - Redis pub/sub ignores the database number in the URL (a channel is
 *   server-wide), and `LISTEN`/`NOTIFY` is per database, so each run's
 *   channel carries this process's pid. The buses write no keys or tables;
 *   the only thing created is a temporary directory for the SQLite file,
 *   deleted at the end.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { RedisClient, SQL } from "bun";
import type { Cache, CacheBus } from "@kingsleyweb/bun-cache";
import {
  createCache,
  pgBus,
  redisBus,
  sqliteDriver,
} from "@kingsleyweb/bun-cache";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

/** The driver's own bus poll, in ms: slow enough that only the separate bus can explain a fast delivery. */
const SLOW_POLL_MS = 60_000;

/** How long a delivery may take here, in ms. A bound for a loaded machine, not an expectation. */
const DELIVERY_BOUND_MS = 5_000;

/** The buses this example can show, and the variable holding each one's URL. */
const BUSES = [
  {
    name: "redisBus",
    variable: "EXAMPLE_REDIS_URL",
    make: (url: string, channel: string): CacheBus =>
      redisBus({ url, channel }),
    // A channel is server-wide: the pid keeps two runs apart.
    channel: () => `bun-cache-example:${process.pid}:bus`,
    probe: async (url: string): Promise<void> => {
      const client = new RedisClient(url);
      try {
        await client.send("PING", []);
      } finally {
        client.close();
      }
    },
  },
  {
    name: "pgBus",
    variable: "EXAMPLE_POSTGRES_URL",
    make: (url: string, channel: string): CacheBus => pgBus({ url, channel }),
    channel: () => `bun_cache_example_${process.pid}_bus`,
    probe: async (url: string): Promise<void> => {
      const client = new SQL(url);
      try {
        await client`SELECT 1`;
      } finally {
        await client.close();
      }
    },
  },
] as const;

const selected = BUSES.filter((bus) => process.env[bus.variable]);
const skippedBuses = BUSES.filter((bus) => !process.env[bus.variable]);

if (selected.length === 0) {
  console.log(
    "skipped: set EXAMPLE_REDIS_URL or EXAMPLE_POSTGRES_URL to run this example",
  );
  process.exit(0);
}

title("a separate bus over an L2 with a slow one");
if (skippedBuses.length > 0) {
  show(
    "skipped buses",
    skippedBuses.map((bus) => `${bus.name} (${bus.variable} is unset)`),
  );
}

/** The tier of the latest `hit` on each cache. */
const lastTier = new WeakMap<Cache, "l1" | "l2" | undefined>();

/** A cache with an L1 over the file, on `bus`, remembering which tier served each hit. */
function openCache(path: string, bus: "auto" | CacheBus): Cache {
  const cache = createCache({
    driver: sqliteDriver({ path, busPollInterval: SLOW_POLL_MS }),
    namespace: "example",
    l1: true,
    bus,
    sweepInterval: 0,
  });
  cache.on("hit", ({ tier }) => {
    lastTier.set(cache, tier);
  });
  return cache;
}

/** Reads `key`, answering the value and the tier that served it. */
async function read(cache: Cache, key: string) {
  lastTier.set(cache, undefined);
  const value = await cache.get(key);
  return { value, tier: lastTier.get(cache) };
}

/** Waits until `cache` has subscribed to its bus (L1 arms with a flush). */
async function armed(cache: Cache): Promise<void> {
  await waitFor(
    "the bus to listen",
    () => (cache.stats().l1?.flushes ?? 0) >= 1,
  );
}

const dir = await mkdtemp(join(tmpdir(), "bun-cache-example-"));

try {
  for (const bus of selected) {
    const url = process.env[bus.variable]!;
    try {
      await bus.probe(url);
    } catch (error) {
      throw new Error(`${bus.variable} is set but unreachable`, {
        cause: error,
      });
    }

    step(`${bus.name}: the invalidation arrives long before the driver's poll`);

    const path = join(dir, `${bus.name}.db`);
    const channel = bus.channel();
    const writer = openCache(path, bus.make(url, channel));
    const reader = openCache(path, bus.make(url, channel));
    try {
      await Promise.all([armed(writer), armed(reader)]);

      await writer.set("page", "v1");
      // The writer's own message about v1 may reach the reader after its
      // first read copied v1, and drop that copy once; the next read copies
      // it again. So wait for a read that L1 serves.
      await waitFor(
        "the reader to hold v1 in L1",
        async () => (await read(reader, "page")).tier === "l1",
        { timeout: DELIVERY_BOUND_MS },
      );
      checkEqual("the reader holds v1 in L1", await read(reader, "page"), {
        value: "v1",
        tier: "l1",
      });

      const wrote = performance.now();
      await writer.set("page", "v2");
      await waitFor(
        "the reader to read v2",
        async () => (await reader.get("page")) === "v2",
        { timeout: DELIVERY_BOUND_MS, interval: 5 },
      );
      const took = performance.now() - wrote;
      show(`${bus.name}: the reader saw v2 after`, `${took.toFixed(1)} ms`);
      check(
        `the reader saw v2 within ${DELIVERY_BOUND_MS} ms, against a ${SLOW_POLL_MS} ms driver poll`,
        took < DELIVERY_BOUND_MS,
        took,
      );
      check(
        "its L1 counted the invalidation",
        (reader.stats().l1?.invalidations ?? 0) >= 1,
        reader.stats().l1,
      );
    } finally {
      await writer.close();
      await reader.close();
    }

    /* ---------------------------------------------------------------- */
    step(
      `${bus.name}: the control — the driver's own bus, polled every ${SLOW_POLL_MS / 1000} s`,
    );

    const controlPath = join(dir, `${bus.name}-control.db`);
    const slowWriter = openCache(controlPath, "auto");
    const slowReader = openCache(controlPath, "auto");
    try {
      await Promise.all([armed(slowWriter), armed(slowReader)]);
      const subscribed = Date.now();
      await slowWriter.set("page", "v1");
      await slowReader.get("page");
      await slowWriter.set("page", "v2");
      await Bun.sleep(DELIVERY_BOUND_MS / 5);
      if (Date.now() - subscribed < SLOW_POLL_MS / 2) {
        // The first poll cannot have run yet, and l1.ttl (30 s) has not.
        checkEqual(
          "with the driver's bus the reader still serves v1 from L1",
          await read(slowReader, "page"),
          { value: "v1", tier: "l1" },
        );
      } else {
        show("the machine stalled; skipping the control");
      }
    } finally {
      await slowWriter.close();
      await slowReader.close();
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

summary();
