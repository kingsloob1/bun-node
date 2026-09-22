import type { RedisClient } from "bun";
import type { RedisDriverOptions } from "../lib/drivers/redis/redis-driver";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import {
  MINUTE_BUCKET_MS,
  MINUTE_RETENTION_MS,
  SECOND_BUCKET_MS,
} from "../lib/api/contract/constants";
import { bucketStart } from "../lib/drivers/metrics";
import {
  metricsGroupSpan,
  metricsGroupStart,
  RedisKeys,
} from "../lib/drivers/redis/keys";
import { RedisDriver } from "../lib/drivers/redis/redis-driver";
import { runnerKey } from "../lib/shared/keys";
import { testNamespace } from "./helpers";

/**
 * The Redis driver's grouped analytics reads: the parts only Redis has.
 *
 * The shared contract (`analytics: grouped reads`) holds what the four reads
 * answer. This file holds how Redis finds the entities to answer for without a
 * keyspace scan — the per-namespace metrics index — and what a read costs in
 * round trips.
 *
 * ```bash
 * BUN_JOBS_TEST_REDIS_URL=redis://127.0.0.1:6379/15 bun test redis-grouped-read
 * ```
 *
 * **Every namespace this file creates is purged by name at the end, and
 * nothing here ever deletes by prefix**: other sessions share that server.
 */

/** The server to test against, when one is configured. */
const URL = process.env.BUN_JOBS_TEST_REDIS_URL;

/** Drivers to close when the suite ends. */
const drivers: RedisDriver[] = [];
/** Raw clients opened for inspection, closed at the end. */
const clients: RedisClient[] = [];
/** The exact namespaces this run created, to purge — never a prefix sweep. */
const namespaces = new Set<string>();

afterAll(async () => {
  const [driver] = drivers;

  if (driver) {
    for (const scope of namespaces) {
      await driver.purge(scope).catch(() => undefined);
    }
  }

  await Promise.allSettled(drivers.map(async (each) => await each.close()));
  for (const client of clients) {
    client.close();
  }
});

/** A driver on the configured server, tracked for cleanup. */
function makeDriver(options: Partial<RedisDriverOptions> = {}): RedisDriver {
  const driver = new RedisDriver({ url: URL, ...options });
  drivers.push(driver);
  return driver;
}

/** A raw client, to look at what the driver stored. */
async function rawClient(): Promise<RedisClient> {
  const client = new (await import("bun")).RedisClient(URL!);
  await client.connect();
  clients.push(client);
  return client;
}

/** A namespace nothing else uses, remembered so it can be purged by name. */
function scope(prefix: string): string {
  const name = testNamespace(prefix);
  namespaces.add(name);
  return name;
}

/** An index's members and scores, oldest first. */
async function indexOf(
  client: RedisClient,
  key: string,
): Promise<[string, number][]> {
  const flat = (await client.send("ZRANGE", [
    key,
    "0",
    "-1",
    "WITHSCORES",
  ])) as (string | number | [string, number])[];
  const pairs: [string, number][] = [];

  // The client may answer RESP3 pairs or the flat RESP2 list.
  if (flat.length > 0 && Array.isArray(flat[0])) {
    for (const pair of flat as [string, number][]) {
      pairs.push([String(pair[0]), Number(pair[1])]);
    }
  } else {
    for (let i = 0; i < flat.length; i += 2) {
      pairs.push([String(flat[i]), Number(flat[i + 1])]);
    }
  }

  return pairs;
}

/** When a key expires, epoch ms; `-1` for no expiry, `-2` for no key. */
async function expireTime(client: RedisClient, key: string): Promise<number> {
  return Number(await client.send("PEXPIRETIME", [key]));
}

/**
 * A client that records every command issued through it and how many round
 * trips they took.
 *
 * A round trip is counted as the **depth of the dependency chain**: a command
 * issued before any reply has come back is on trip 1, and one issued after a
 * trip-*n* reply arrived is on trip *n + 1*. Commands issued together are
 * pipelined onto one connection and share a trip, however many there are; a
 * command that had to wait for an earlier reply is one trip later. Counting
 * "gaps with nothing in flight" instead would miss a chain whose next step
 * starts while other replies of the first step are still arriving.
 */
function recordingClient(inner: RedisClient): {
  client: RedisClient;
  commands: string[];
  waves: () => number;
  reset: () => Promise<void>;
} {
  const commands: string[] = [];
  /** Replies not yet in, so a reset can wait out the previous operation's. */
  const pending = new Set<Promise<unknown>>();
  /** The latest trip any reply seen so far belonged to. */
  let answered = 0;
  /** The deepest trip any command was issued on. */
  let deepest = 0;

  const client = new Proxy(inner, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);

      if (typeof value !== "function" || property === "connect") {
        return typeof value === "function" ? value.bind(target) : value;
      }

      return (...args: unknown[]) => {
        const name =
          property === "send"
            ? String(args[0]).toUpperCase()
            : String(property).toUpperCase();
        commands.push(name);

        const trip = answered + 1;
        deepest = Math.max(deepest, trip);

        const result = (value as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );

        if (result instanceof Promise) {
          const settled = result.finally(() => {
            answered = Math.max(answered, trip);
            pending.delete(settled);
          });
          pending.add(settled);
          return settled;
        }

        return result;
      };
    },
  });

  return {
    client,
    commands,
    waves: () => deepest,
    // After waiting out every reply still due — a flush leaves a
    // fire-and-forget `SCRIPT LOAD` behind, which would otherwise make the
    // next read's first command look like part of an earlier wave.
    reset: async () => {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
      commands.length = 0;
      answered = 0;
      deepest = 0;
    },
  };
}

/** The start of the minute before last: two whole minutes, both past. */
function twoMinutesAgo(): number {
  return bucketStart(Date.now() - 2 * MINUTE_BUCKET_MS, MINUTE_BUCKET_MS);
}

/** When the newest minute hash written at `at` expires, as the driver sets it. */
function minuteHashExpiry(at: number): number {
  return (
    metricsGroupStart(at, MINUTE_BUCKET_MS) +
    metricsGroupSpan(MINUTE_BUCKET_MS) +
    MINUTE_RETENTION_MS
  );
}

describe.skipIf(!URL)("Redis grouped reads: the metrics index", () => {
  it("names every runner and worker key a flush wrote, and never the roll-up", async () => {
    const driver = makeDriver();
    const client = await rawClient();
    const ns = scope("gx-index");
    const q = { ns, queue: "orders" };
    const first = twoMinutesAgo();

    await driver.countRunnerRun(ns, runnerKey("a"), first + 1_000, {
      started: 1,
    });
    await driver.countRunnerRun(ns, runnerKey("b"), first + 61_000, {
      succeeded: 1,
      durationMs: 12,
    });
    await driver.countWorkerJobs(q, "w-1", first, { completed: 1 });
    // A key with a colon, and a worker that only sampled busyness: both are
    // entities, found through the index like any other.
    await driver.countWorkerJobs(q, "host:7", first, { failed: 1 });
    await driver.sampleWorkerBusyness(q, "idle", first + 5_000, {
      active: 0,
      concurrency: 2,
    });
    await driver.flushMetrics();

    const runners = await indexOf(
      client,
      driver.keys.metricsIndex(ns, "runners"),
    );
    const workers = await indexOf(
      client,
      driver.keys.metricsIndex(ns, "workers"),
    );

    // The roll-up is written by the same buffers under the entity `""`; it is
    // the namespace, not a runner or a worker, so it is never a member.
    expect(runners.map(([member]) => member).sort()).toEqual(["a", "b"]);
    expect(workers.map(([member]) => member).sort()).toEqual([
      "orders:host:7",
      "orders:idle",
      "orders:w-1",
    ]);
    expect(runners.some(([member]) => member === "")).toBe(false);
    expect(workers.some(([member]) => member === "")).toBe(false);

    // A member's score is the end of the latest bucket it wrote — the minute
    // row's end, which is later than any second row's.
    const scores = new Map(runners);
    expect(scores.get("a")).toBe(first + MINUTE_BUCKET_MS - 1);
    expect(scores.get("b")).toBe(first + 2 * MINUTE_BUCKET_MS - 1);

    // And the grouped reads find exactly those, without a name given.
    const range = {
      from: first,
      to: first + MINUTE_BUCKET_MS,
      interval: MINUTE_BUCKET_MS,
    };
    expect(
      (await driver.getRunnerMetricsTotals(ns, range))
        .map((row) => row.runner)
        .sort(),
    ).toEqual([runnerKey("a"), runnerKey("b")]);
    expect(
      (await driver.getWorkerMetricsTotals(ns, { ...range, busyness: true }))
        .map((row) => row.key)
        .sort(),
    ).toEqual(["host:7", "idle", "w-1"]);
  });

  it("expires with the newest hash it points at, and only ever later", async () => {
    const driver = makeDriver();
    const client = await rawClient();
    const ns = scope("gx-expiry");
    const key = driver.keys.metricsIndex(ns, "runners");
    const now = Date.now();

    await driver.countRunnerRun(ns, runnerKey("r"), now, { started: 1 });
    await driver.flushMetrics();

    // The index is a namespace key like the roll-up, so without an expiry an
    // abandoned namespace would keep it for ever.
    const set = await expireTime(client, key);
    expect(set).toBe(minuteHashExpiry(now));

    // An older write — a retried flush, or a late count — moves neither the
    // expiry nor the member's score back.
    const [[, score]] = await indexOf(client, key);
    await driver.countRunnerRun(ns, runnerKey("r"), now - 2 * 3_600_000, {
      started: 1,
    });
    await driver.flushMetrics();

    expect(await expireTime(client, key)).toBe(set);
    expect(await indexOf(client, key)).toEqual([["r", score!]]);
  });

  it("ages out a member once every bucket it could have written has expired", async () => {
    const driver = makeDriver();
    const client = await rawClient();
    const ns = scope("gx-trim");
    const q = { ns, queue: "orders" };
    const now = Date.now();
    // Beyond the widest group plus its retention: an hour of minutes, kept a
    // day. Every hash this wrote is already gone.
    const dead = now - MINUTE_RETENTION_MS - 2 * 3_600_000;

    await driver.countRunnerRun(ns, runnerKey("dead"), dead, { started: 1 });
    await driver.countRunnerRun(ns, runnerKey("live"), now, { started: 1 });
    await driver.countWorkerJobs(q, "dead", dead, { completed: 1 });
    await driver.countWorkerJobs(q, "live", now, { completed: 1 });
    await driver.flushMetrics();

    expect(
      (await indexOf(client, driver.keys.metricsIndex(ns, "runners"))).map(
        ([member]) => member,
      ),
    ).toEqual(["live"]);
    expect(
      (await indexOf(client, driver.keys.metricsIndex(ns, "workers"))).map(
        ([member]) => member,
      ),
    ).toEqual(["orders:live"]);
  });

  it("writes the index ahead of the hashes, so a failed index write counts nothing and the retry counts once", async () => {
    const inner = await rawClient();
    let failIndex = true;
    // Rejects script calls on an index key while `failIndex` holds; every
    // other command goes straight through.
    const client = new Proxy(inner, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);

        if (typeof value !== "function") {
          return value;
        }

        if (property !== "eval" && property !== "evalsha") {
          return value.bind(target);
        }

        return async (...args: unknown[]) => {
          if (failIndex && String(args[2]).includes(":mx:ix:")) {
            throw new Error("index write refused");
          }
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(
            target,
            args,
          );
        };
      },
    });
    const driver = makeDriver({ client });
    const ns = scope("gx-order");
    const first = twoMinutesAgo();
    const range = {
      from: first,
      to: first + MINUTE_BUCKET_MS,
      interval: MINUTE_BUCKET_MS,
    };

    await driver.countRunnerRun(ns, runnerKey("r"), first, { started: 2 });
    await expect(driver.flushMetrics()).rejects.toThrow();

    // Nothing landed: not the index, and not the hash it would have named.
    expect(
      (await driver.getRunnerMetrics(ns, runnerKey("r"), range)).runs,
    ).toEqual([]);
    expect(await driver.getRunnerMetricsTotals(ns, range)).toEqual([]);

    // The rows were kept, and the next flush writes both, once.
    failIndex = false;
    await driver.flushMetrics();
    const rows = await driver.getRunnerMetricsTotals(ns, range);
    expect(rows.map((row) => [row.runner, row.runs.started])).toEqual([
      [runnerKey("r"), 2],
    ]);
  });

  it("sits outside every hash tag in cluster mode, one key per script call", async () => {
    const keys = new RedisKeys({ cluster: true });

    // No tag of its own and none of a queue's or runner's: it spans all of
    // them, and the script that maintains it touches it alone.
    expect(keys.metricsIndex("svc", "runners")).toBe(
      "bun-jobs:svc:mx:ix:runners",
    );
    expect(keys.metricsIndex("svc", "workers")).toBe(
      "bun-jobs:svc:mx:ix:workers",
    );
    expect(keys.metricsIndex("svc", "workers")).not.toContain("{");

    // And a cluster-mode driver still finds its entities through it.
    const driver = makeDriver({ cluster: true });
    const ns = scope("gx-cluster");
    const first = twoMinutesAgo();
    await driver.countRunnerRun(ns, runnerKey("tagged"), first, { started: 1 });
    await driver.countWorkerJobs({ ns, queue: "orders" }, "w", first, {
      completed: 1,
    });
    await driver.flushMetrics();

    const range = {
      from: first,
      to: first + MINUTE_BUCKET_MS,
      interval: MINUTE_BUCKET_MS,
    };
    expect(
      (await driver.getRunnerMetricsTotals(ns, range)).map((row) => row.runner),
    ).toEqual([runnerKey("tagged")]);
    expect(
      (await driver.getWorkerMetricsTotals(ns, range)).map((row) => row.key),
    ).toEqual(["w"]);
  });
});

describe.skipIf(!URL)("Redis grouped reads: what a read costs", () => {
  /** How many runners and worker keys the costed reads span. */
  const ENTITIES = 30;

  /** A driver on a recording client, with `ENTITIES` of each kind counted. */
  async function seeded(prefix: string): Promise<{
    driver: RedisDriver;
    recorder: ReturnType<typeof recordingClient>;
    ns: string;
    first: number;
  }> {
    const recorder = recordingClient(await rawClient());
    const driver = makeDriver({ client: recorder.client });
    const ns = scope(prefix);
    const first = twoMinutesAgo();

    for (let i = 0; i < ENTITIES; i++) {
      await driver.countRunnerRun(ns, runnerKey(`r-${i}`), first + i * 1_000, {
        succeeded: 1,
        durationMs: 10 + i,
      });
      await driver.countWorkerJobs(
        { ns, queue: i % 2 === 0 ? "even" : "odd" },
        `w-${i}`,
        first + i * 1_000,
        { completed: 1 },
      );
      await driver.sampleWorkerBusyness(
        { ns, queue: i % 2 === 0 ? "even" : "odd" },
        `w-${i}`,
        first + i * 1_000,
        { active: 1, concurrency: 2 },
      );
    }
    await driver.flushMetrics();
    await recorder.reset();

    return { driver, recorder, ns, first };
  }

  /** Two minutes at one-second width: three minute hashes per series. */
  function secondsRange(first: number): {
    from: number;
    to: number;
    interval: number;
  } {
    return {
      from: first,
      to: first + 2 * MINUTE_BUCKET_MS - SECOND_BUCKET_MS,
      interval: SECOND_BUCKET_MS,
    };
  }

  it("totals every runner in two round trips: the index, then every hash at once", async () => {
    const { driver, recorder, ns, first } = await seeded("gx-cost-runners");
    const range = { ...secondsRange(first), durations: true };

    const rows = await driver.getRunnerMetricsTotals(ns, range);

    expect(rows).toHaveLength(ENTITIES);
    expect(recorder.waves()).toBe(2);
    // One index read, then per runner one `HGETALL` per group for each of
    // `runs` and `rdur` — two groups, since the range spans two minutes.
    expect(recorder.commands.filter((c) => c === "ZRANGE")).toHaveLength(1);
    expect(recorder.commands.filter((c) => c === "HGETALL")).toHaveLength(
      ENTITIES * 2 * 2,
    );
    expect(recorder.commands).not.toContain("KEYS");
    expect(recorder.commands).not.toContain("SCAN");
  });

  it("totals every worker key in two round trips, the queue filter costing nothing", async () => {
    const { driver, recorder, ns, first } = await seeded("gx-cost-workers");

    const rows = await driver.getWorkerMetricsTotals(ns, {
      ...secondsRange(first),
      busyness: true,
    });
    expect(rows).toHaveLength(ENTITIES);
    expect(recorder.waves()).toBe(2);
    expect(recorder.commands).not.toContain("KEYS");
    expect(recorder.commands).not.toContain("SCAN");

    // Filtered to one queue: still two, and only that queue's hashes read.
    await recorder.reset();
    const even = await driver.getWorkerMetricsTotals(ns, {
      ...secondsRange(first),
      queues: ["even"],
    });
    expect(even).toHaveLength(ENTITIES / 2);
    expect(recorder.waves()).toBe(2);
    expect(recorder.commands.filter((c) => c === "HGETALL")).toHaveLength(
      (ENTITIES / 2) * 2,
    );
  });

  it("answers a named filter or batch in one round trip, with no index read", async () => {
    const { driver, recorder, ns, first } = await seeded("gx-cost-batch");
    const range = secondsRange(first);
    const runners = Array.from({ length: 20 }, (_unused, index) => {
      return runnerKey(`r-${index}`);
    });

    expect(
      await driver.getRunnerMetricsTotals(ns, { ...range, runners }),
    ).toHaveLength(20);
    expect(recorder.waves()).toBe(1);
    expect(recorder.commands).not.toContain("ZRANGE");

    await recorder.reset();
    expect(
      await driver.getRunnerMetricsMany(ns, runners, {
        ...range,
        durations: true,
      }),
    ).toHaveLength(20);
    expect(recorder.waves()).toBe(1);

    await recorder.reset();
    const workers = Array.from({ length: 20 }, (_unused, i) => ({
      queue: i % 2 === 0 ? "even" : "odd",
      key: `w-${i}`,
    }));
    expect(
      await driver.getWorkerMetricsMany(ns, workers, {
        ...range,
        busyness: true,
      }),
    ).toHaveLength(20);
    expect(recorder.waves()).toBe(1);
    expect(recorder.commands).not.toContain("SCAN");
    expect(recorder.commands).not.toContain("KEYS");
  });
});
