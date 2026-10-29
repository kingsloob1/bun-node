/**
 * The second process of `crossprocess.test.ts`: a cache with its own L1 over
 * the shared L2 the test names, driven by JSON lines on stdin (one command
 * each, `{ id, op, … }`) and answering one JSON line per command on stdout
 * (`{ id, result }` or `{ id, error }`).
 *
 * `watch` is the measurement: it reads a key in a tight loop — yielding to
 * the event loop between reads, so the bus can deliver — until it sees the
 * expected value, and answers when (`performance.timeOrigin + now()`, the
 * same clock the parent reads) and from which tier each read came.
 */
import process from "node:process";
import type { Cache, CacheBus, CacheDriver } from "../../lib/index";
import {
  createCache,
  pgBus,
  postgresDriver,
  redisBus,
  sqliteDriver,
} from "../../lib/index";

/** The job, from argv. */
export interface TierJob {
  /** The shared L2. */
  driver:
    | { kind: "sqlite"; path: string; busPollInterval?: number }
    | { kind: "postgres"; url: string; prefix: string };
  /** The bus: the driver's (`"auto"`), none, or a separate one. */
  bus:
    | "auto"
    | false
    | { kind: "redis"; url: string; channel: string }
    | { kind: "pg"; url: string; channel: string };
  /** `l1.ttl`, in ms. */
  l1Ttl?: number;
  /** `softPurge` (R21): the reader checks stale stamps on its tagged reads. */
  softPurge?: boolean;
  /** `tagStampCacheMs`: long in the soft-purge case, so only the bus can refresh the reader's stamp copy. */
  tagStampCacheMs?: number;
}

/** One command from the parent. */
interface Command {
  /** Echoed in the answer. */
  id: number;
  /** What to do. */
  op:
    | "armed"
    | "get"
    | "getEntry"
    | "set"
    | "delete"
    | "invalidateTags"
    | "watch"
    | "stats"
    | "close";
  /** The key. */
  key?: string;
  /** The value (`set`) or the value awaited (`watch`). */
  value?: unknown;
  /** Tags (`set`, `invalidateTags`). */
  tags?: string[];
  /** `invalidateTags`' mode. */
  mode?: "delete" | "stale";
  /** `watch`'s patience, in ms. */
  timeoutMs?: number;
}

/** Builds the job's driver. */
function makeDriver(job: TierJob): CacheDriver {
  return job.driver.kind === "sqlite"
    ? sqliteDriver({
        path: job.driver.path,
        ...(job.driver.busPollInterval === undefined
          ? {}
          : { busPollInterval: job.driver.busPollInterval }),
      })
    : postgresDriver({ url: job.driver.url, prefix: job.driver.prefix });
}

/** Builds the job's bus option. */
function makeBus(job: TierJob): "auto" | false | CacheBus {
  if (job.bus === "auto" || job.bus === false) {
    return job.bus;
  }
  return job.bus.kind === "redis"
    ? redisBus({ url: job.bus.url, channel: job.bus.channel })
    : pgBus({ url: job.bus.url, channel: job.bus.channel });
}

/** Performs one command. */
async function perform(
  cache: Cache,
  job: TierJob,
  command: Command,
  lastTier: { tier: "l1" | "l2" | undefined },
): Promise<unknown> {
  const key = command.key ?? "";
  switch (command.op) {
    case "armed": {
      const deadline = Date.now() + 10_000;
      while (job.bus !== false && (cache.stats().l1?.flushes ?? 0) < 1) {
        if (Date.now() > deadline) {
          throw new Error("the bus never subscribed");
        }
        await Bun.sleep(5);
      }
      return true;
    }
    case "get": {
      lastTier.tier = undefined;
      const value = await cache.get(key);
      return { value, tier: lastTier.tier };
    }
    case "getEntry": {
      const entry = await cache.getEntry(key);
      return entry === undefined
        ? undefined
        : { value: entry.value, stale: entry.stale };
    }
    case "set":
      return await cache.set(key, command.value, { tags: command.tags });
    case "delete":
      return await cache.delete(key);
    case "invalidateTags":
      await cache.invalidateTags(command.tags ?? [], { mode: command.mode });
      return true;
    case "watch": {
      const deadline = Date.now() + (command.timeoutMs ?? 10_000);
      const tiers: Record<string, number> = { l1: 0, l2: 0, miss: 0 };
      for (;;) {
        lastTier.tier = undefined;
        const value = await cache.get(key);
        tiers[lastTier.tier ?? "miss"]++;
        if (value === command.value) {
          return {
            seenAt: performance.timeOrigin + performance.now(),
            tiers,
          };
        }
        if (Date.now() > deadline) {
          return { timedOut: true, last: value, tiers };
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    case "stats":
      return cache.stats();
    case "close":
      await cache.close();
      return true;
  }
}

/** Prints one JSON line. */
async function emit(value: unknown): Promise<void> {
  await Bun.write(Bun.stdout, `${JSON.stringify(value)}\n`);
}

/** Reads commands until stdin closes or `close` arrives. */
async function main(): Promise<void> {
  const job = JSON.parse(process.argv[2] ?? "{}") as TierJob;
  const cache = createCache({
    driver: makeDriver(job),
    l1: job.l1Ttl === undefined ? true : { ttl: job.l1Ttl },
    bus: makeBus(job),
    sweepInterval: 0,
    ...(job.softPurge === undefined ? {} : { softPurge: job.softPurge }),
    ...(job.tagStampCacheMs === undefined
      ? {}
      : { tagStampCacheMs: job.tagStampCacheMs }),
  });
  const lastTier: { tier: "l1" | "l2" | undefined } = { tier: undefined };
  cache.on("hit", (hit) => {
    lastTier.tier = hit.tier;
  });
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
      try {
        await emit({
          id: command.id,
          result: await perform(cache, job, command, lastTier),
        });
      } catch (error) {
        await emit({ id: command.id, error: String(error) });
      }
      if (command.op === "close") {
        return;
      }
    }
  }
  await cache.close();
}

await main();
