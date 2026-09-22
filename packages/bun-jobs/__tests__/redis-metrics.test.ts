import type { RedisClient } from "bun";
import type { RedisDriverOptions } from "../lib/drivers/redis/redis-driver";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import {
  MINUTE_BUCKET_MS,
  SECOND_BUCKET_MS,
} from "../lib/api/contract/constants";
import { bucketStart, DURATION_HISTOGRAM_SIZE } from "../lib/drivers/metrics";
import { RedisDriver } from "../lib/drivers/redis/redis-driver";
import { renderScripts } from "../lib/drivers/redis/scripts";
import { makeJob, testNamespace } from "./helpers";

/**
 * The Redis driver's analytics: the layout, the roll-up, and the trap that
 * fails silently.
 *
 * A server is needed, as for every other Redis suite:
 *
 * ```bash
 * bun scripts/setup-databases.ts --only=redis
 * BUN_JOBS_TEST_REDIS_URL=redis://127.0.0.1:6379/15 bun test
 * ```
 *
 * **Every namespace this file creates is purged by name at the end, and
 * nothing here ever deletes by prefix**: other sessions share that server.
 */

/** The server to test against, when one is configured. */
const URL = process.env.BUN_JOBS_TEST_REDIS_URL;

/** Drivers to close when the suite ends. */
const drivers: RedisDriver[] = [];
/** The exact namespaces this run created, to purge — never a prefix sweep. */
const namespaces = new Set<string>();

afterAll(async () => {
  // Every driver first: closing one flushes the analytics it still buffers,
  // and a purge made before that flush would see those keys written back
  // straight after it.
  await Promise.allSettled(drivers.map(async (each) => await each.close()));

  if (URL && namespaces.size > 0) {
    const janitor = new RedisDriver({ url: URL });

    try {
      for (const scope of namespaces) {
        await janitor.purge(scope).catch(() => undefined);
      }
    } finally {
      await janitor.close();
    }
  }
});

/** A driver on the configured server, tracked for cleanup. */
function makeDriver(options: Partial<RedisDriverOptions> = {}): RedisDriver {
  const driver = new RedisDriver({ url: URL, ...options });
  drivers.push(driver);
  return driver;
}

/** A namespace nothing else uses, remembered so it can be purged by name. */
function scope(prefix: string): string {
  const name = testNamespace(prefix);
  namespaces.add(name);
  return name;
}

/** Runs one job through to `completed`, at exactly `now`. */
async function completeOne(
  driver: RedisDriver,
  q: { ns: string; queue: string },
  id: string,
  now: number,
): Promise<void> {
  const token = `token-${id}`;
  await driver.addJob(q, makeJob({ id, createdAt: now - 1, runAt: now - 1 }));
  await driver.claimJob(q, { workerId: "w", token, lockMs: 60_000, now });
  expect(await driver.completeJob(q, id, token, null, false, now)).toBe(true);
}

/** The keys matching a pattern, by `SCAN` — never `KEYS`, on a shared server. */
async function scanKeys(
  client: RedisClient,
  pattern: string,
): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";

  do {
    const [next, batch] = (await client.send("SCAN", [
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      "500",
    ])) as [string, string[]];

    cursor = next;
    found.push(...batch);
  } while (cursor !== "0");

  return found.sort();
}

/** The minute this run buckets into, so every expectation is deterministic. */
const MINUTE = bucketStart(Date.now(), MINUTE_BUCKET_MS);

describe.skipIf(!URL)("Redis analytics: the key layout", () => {
  it("keeps a minute's seconds in one hash of sixty second-fields", async () => {
    const driver = makeDriver();
    const ns = scope("mx-layout");
    const q = { ns, queue: "jobs" };
    const client = new (await import("bun")).RedisClient(URL!);
    await client.connect();

    // Every second of one minute, written through the buffered per-worker
    // series so the test is sixty counts rather than sixty jobs.
    for (let second = 0; second < 60; second++) {
      await driver.countWorkerJobs!(
        q,
        "worker-a",
        MINUTE + second * SECOND_BUCKET_MS,
        { completed: 1 },
      );
    }
    await driver.flushMetrics!();

    const prefix = driver.keys.queue(q).metricsPrefix;
    const key = `${prefix}wjobs:s:${MINUTE}:worker-a`;

    // One key for the whole minute — the number this layout exists for.
    expect(await scanKeys(client, `${prefix}wjobs:s:*`)).toEqual([key]);
    expect(Number(await client.send("HLEN", [key]))).toBe(60);
    expect(await client.hmget(key, ["0:completed", "59:completed"])).toEqual([
      "1",
      "1",
    ]);

    // And the minute's own bucket is in the hour's hash, beside it.
    const hour = bucketStart(MINUTE, MINUTE_BUCKET_MS * 60);
    const minuteKey = `${prefix}wjobs:m:${hour}:worker-a`;
    const offset = (MINUTE - hour) / MINUTE_BUCKET_MS;
    expect(await client.hget(minuteKey, `${offset}:completed`)).toBe("60");

    client.close();
  });

  it("counts a queue's own seconds inside COMPLETE, under the queue's prefix", async () => {
    const driver = makeDriver();
    const ns = scope("mx-inscript");
    const q = { ns, queue: "jobs" };
    const at = MINUTE + 7 * SECOND_BUCKET_MS;

    await completeOne(driver, q, "j1", at);
    await completeOne(driver, q, "j2", at);

    const client = new (await import("bun")).RedisClient(URL!);
    await client.connect();

    const keys = driver.keys.queue(q);
    const key = `${keys.metricsPrefix}jobs:s:${MINUTE}`;

    // No flush: the queue's own counts ride the script, so they are there the
    // moment `completeJob` resolves.
    expect(await client.hget(key, "7:completed")).toBe("2");
    // The dual write — the same events in the shipped minute hash.
    expect(
      await client.hget(`${keys.throughputPrefix}${MINUTE}`, "completed"),
    ).toBe("2");

    client.close();
  });

  it("puts the namespace roll-up outside the queue's hash tag", async () => {
    const tagged = makeDriver({ cluster: true });
    const ns = scope("mx-tag");
    const q = { ns, queue: "jobs" };

    const queueKey = tagged.keys.metricsKey(
      tagged.keys.queue(q).metricsPrefix,
      "jobs",
      SECOND_BUCKET_MS,
      MINUTE,
    );
    const nsKey = tagged.keys.metricsKey(
      tagged.keys.namespaceMetrics(ns),
      "jobs",
      SECOND_BUCKET_MS,
      MINUTE,
    );

    // The queue's keys are grouped into one slot; the namespace's are not in
    // it — which is exactly why a script cannot write both, and why the
    // roll-up is buffered instead of riding COMPLETE.
    expect(queueKey).toContain("{jobs}");
    expect(nsKey).not.toContain("{");
    expect(nsKey.startsWith(`bun-jobs:${ns}:mx:`)).toBe(true);
  });
});

describe.skipIf(!URL)("Redis analytics: the namespace roll-up", () => {
  it("lands after a flush, counting what the scripts counted", async () => {
    const driver = makeDriver();
    const ns = scope("mx-rollup");
    const q = { ns, queue: "jobs" };
    const at = MINUTE + 3 * SECOND_BUCKET_MS;

    await completeOne(driver, q, "ok", at);

    const range = {
      from: MINUTE,
      to: MINUTE + 59 * SECOND_BUCKET_MS,
      interval: SECOND_BUCKET_MS,
    };

    // Up to a second behind, by design: nothing has been written yet.
    expect(
      (await driver.getNamespaceMetrics!(ns, { ...range, kinds: ["jobs"] }))
        .jobs,
    ).toEqual([]);

    await driver.flushMetrics!();

    expect(
      await driver.getNamespaceMetrics!(ns, { ...range, kinds: ["jobs"] }),
    ).toEqual({ jobs: [{ at, completed: 1, failed: 0 }] });

    // And the queue's own series, which never lagged, agrees with it.
    expect(await driver.getQueueMetrics!(q, range)).toEqual([
      { at, completed: 1, failed: 0 },
    ]);
  });

  it("answers a minute query out of the shipped throughput hashes", async () => {
    const driver = makeDriver();
    const ns = scope("mx-minute");
    const q = { ns, queue: "jobs" };
    const at = MINUTE + 11 * SECOND_BUCKET_MS;

    await completeOne(driver, q, "ok", at);

    const minute = {
      from: MINUTE,
      to: MINUTE,
      interval: MINUTE_BUCKET_MS,
    };

    expect(await driver.getQueueMetrics!(q, minute)).toEqual(
      await driver.getThroughput!(q, { from: MINUTE, to: MINUTE }),
    );
    expect(await driver.getQueueMetrics!(q, minute)).toEqual([
      { at: MINUTE, completed: 1, failed: 0 },
    ]);
  });

  it("rolls per-worker and per-runner counts up as they are written", async () => {
    const driver = makeDriver();
    const ns = scope("mx-entities");
    const q = { ns, queue: "jobs" };
    const at = MINUTE + 5 * SECOND_BUCKET_MS;

    await driver.countWorkerJobs!(q, "worker-a", at, { completed: 2 });
    await driver.countWorkerJobs!(q, "worker-b", at, { failed: 1 });
    await driver.countRunnerRun!(ns, "nightly", at, { started: 1 });
    await driver.countRunnerRun!(ns, "nightly", at, {
      succeeded: 1,
      durationMs: 120,
    });
    await driver.flushMetrics!();

    const range = {
      from: MINUTE,
      to: MINUTE + 59 * SECOND_BUCKET_MS,
      interval: SECOND_BUCKET_MS,
    };

    const rollUp = await driver.getNamespaceMetrics!(ns, {
      ...range,
      kinds: ["runs", "workerJobs"],
    });

    expect(rollUp.workerJobs).toEqual([{ at, completed: 2, failed: 1 }]);
    expect(rollUp.runs).toEqual([
      {
        at,
        started: 1,
        succeeded: 1,
        failed: 0,
        timeout: 0,
        killed: 0,
        skipped: 0,
      },
    ]);
    // `jobs` was not asked for, so it is absent rather than an array of zeros.
    expect(rollUp.jobs).toBeUndefined();

    const worker = await driver.getWorkerMetrics!(q, "worker-a", range);
    expect(worker.jobs).toEqual([{ at, completed: 2, failed: 0 }]);
    expect(worker.busyness).toBeUndefined();
  });

  it("forgets what a purged namespace had not written yet", async () => {
    const driver = makeDriver();
    const ns = scope("mx-purge");
    const q = { ns, queue: "jobs" };
    const at = MINUTE + 9 * SECOND_BUCKET_MS;

    await driver.countWorkerJobs!(q, "worker-a", at, { completed: 3 });
    await driver.purge(ns);
    await driver.flushMetrics!();

    const range = {
      from: MINUTE,
      to: MINUTE + 59 * SECOND_BUCKET_MS,
      interval: SECOND_BUCKET_MS,
    };

    expect(await driver.getWorkerMetrics!(q, "worker-a", range)).toEqual({
      jobs: [],
    });
  });
});

describe.skipIf(!URL)("Redis analytics: durations and busyness", () => {
  it("round-trips a runner's durations, histogram included", async () => {
    const driver = makeDriver();
    const ns = scope("mx-durations");
    const at = MINUTE + 21 * SECOND_BUCKET_MS;

    for (const ms of [5, 9, 1_000]) {
      await driver.countRunnerRun!(ns, "nightly", at, {
        succeeded: 1,
        durationMs: ms,
      });
    }
    await driver.flushMetrics!();

    const read = await driver.getRunnerMetrics!(ns, "nightly", {
      from: MINUTE,
      to: MINUTE + 59 * SECOND_BUCKET_MS,
      interval: SECOND_BUCKET_MS,
      durations: true,
    });

    expect(read.runs).toHaveLength(1);
    expect(read.durations).toHaveLength(1);

    const bucket = read.durations![0]!;
    expect(bucket.at).toBe(at);
    expect(bucket.count).toBe(3);
    expect(bucket.sumMs).toBe(1_014);
    expect(bucket.minMs).toBe(5);
    expect(bucket.maxMs).toBe(1_000);
    expect(bucket.histogram).toHaveLength(DURATION_HISTOGRAM_SIZE);
    // 5 ms and 9 ms are bins 3 and 4; 1,000 ms is bin 10.
    expect(bucket.histogram[3]).toBe(1);
    expect(bucket.histogram[4]).toBe(1);
    expect(bucket.histogram[10]).toBe(1);
    expect(bucket.histogram.reduce((sum, count) => sum + count, 0)).toBe(3);

    // Two writers of one bucket keep exact extremes, because min and max are
    // compared in the script rather than overwritten.
    const other = makeDriver();
    await other.countRunnerRun!(ns, "nightly", at, {
      succeeded: 1,
      durationMs: 2,
    });
    await other.flushMetrics!();

    const merged = await driver.getRunnerMetrics!(ns, "nightly", {
      from: MINUTE,
      to: MINUTE + 59 * SECOND_BUCKET_MS,
      interval: SECOND_BUCKET_MS,
      durations: true,
    });

    expect(merged.durations![0]!.minMs).toBe(2);
    expect(merged.durations![0]!.maxMs).toBe(1_000);
    expect(merged.durations![0]!.count).toBe(4);
  });

  it("round-trips a worker's busyness, keeping the latest concurrency", async () => {
    const driver = makeDriver();
    const ns = scope("mx-busyness");
    const q = { ns, queue: "jobs" };
    const at = MINUTE + 31 * SECOND_BUCKET_MS;

    await driver.sampleWorkerBusyness!(q, "worker-a", at, {
      active: 2,
      concurrency: 4,
    });
    // A later sample in the same bucket: the concurrency it reports wins, and
    // the active figures still add up.
    await driver.sampleWorkerBusyness!(q, "worker-a", at + 100, {
      active: 6,
      concurrency: 8,
    });
    await driver.flushMetrics!();

    const read = await driver.getWorkerMetrics!(q, "worker-a", {
      from: MINUTE,
      to: MINUTE + 59 * SECOND_BUCKET_MS,
      interval: SECOND_BUCKET_MS,
      busyness: true,
    });

    expect(read.busyness).toEqual([
      {
        at,
        samples: 2,
        activeSum: 8,
        activeMax: 6,
        concurrency: 8,
        lastAt: at + 100,
      },
    ]);
  });
});

describe.skipIf(!URL)("Redis analytics: retention", () => {
  it("expires a second hash a minute plus its retention after it starts", async () => {
    const driver = makeDriver({ metrics: { secondRetentionMs: 120_000 } });
    const ns = scope("mx-ttl");
    const q = { ns, queue: "jobs" };
    const at = MINUTE + 4 * SECOND_BUCKET_MS;

    await completeOne(driver, q, "ok", at);

    const client = new (await import("bun")).RedisClient(URL!);
    await client.connect();

    const key = `${driver.keys.queue(q).metricsPrefix}jobs:s:${MINUTE}`;
    const ttl = Number(await client.send("PTTL", [key]));
    const expected = MINUTE + MINUTE_BUCKET_MS + 120_000 - Date.now();

    expect(ttl).toBeGreaterThan(0);
    expect(Math.abs(ttl - expected)).toBeLessThan(5_000);

    client.close();
  });

  it("serves nothing finer than a minute when per-second recording is off", async () => {
    const driver = makeDriver({ metrics: { resolution: "minute" } });
    const ns = scope("mx-minute-only");
    const q = { ns, queue: "jobs" };
    const at = MINUTE + 8 * SECOND_BUCKET_MS;

    await completeOne(driver, q, "ok", at);
    await driver.countWorkerJobs!(q, "worker-a", at, { completed: 1 });
    await driver.flushMetrics!();

    expect(driver.getMetricsSupport!().resolutions).toEqual([60]);
    expect(driver.getMetricsSupport!().recording.resolution).toBe("minute");

    expect(
      await driver.getQueueMetrics!(q, {
        from: MINUTE,
        to: MINUTE + 59 * SECOND_BUCKET_MS,
        interval: SECOND_BUCKET_MS,
      }),
    ).toEqual([]);

    const client = new (await import("bun")).RedisClient(URL!);
    await client.connect();

    // Nothing per-second was written at all: the block is not in the script,
    // and the buffers write a minute only.
    expect(
      await scanKeys(client, `${driver.keys.namespace(ns)}:*:mx:*:s:*`),
    ).toEqual([]);

    // The minute is all there.
    expect(
      await driver.getQueueMetrics!(q, {
        from: MINUTE,
        to: MINUTE,
        interval: MINUTE_BUCKET_MS,
      }),
    ).toEqual([{ at: MINUTE, completed: 1, failed: 0 }]);

    client.close();
  });
});

describe("Redis analytics: scripts are rendered per driver (§9.10)", () => {
  it("renders a different COMPLETE for a different retention", () => {
    const short = renderScripts({
      secondRetentionMs: 60_000,
      minuteRetentionMs: 86_400_000,
    });
    const long = renderScripts({
      secondRetentionMs: 900_000,
      minuteRetentionMs: 86_400_000,
    });

    // The retention reaches the script as a literal inside a PEXPIREAT, so the
    // two texts differ — and so do their SHAs. Nothing may cache by name.
    expect(short.COMPLETE).not.toBe(long.COMPLETE);
    expect(short.COMPLETE).toContain(String(60_000 + 60_000));
    expect(long.COMPLETE).toContain(String(900_000 + 60_000));

    // Every script the retention reaches, not just COMPLETE.
    expect(short.FAIL).not.toBe(long.FAIL);
    expect(short.BURY).not.toBe(long.BURY);
    expect(short.RECOVER_STALLED).not.toBe(long.RECOVER_STALLED);
    expect(short.RECORD_CHILD).not.toBe(long.RECORD_CHILD);
  });

  it("leaves the per-second block out entirely when seconds are off", () => {
    const off = renderScripts({
      secondRetentionMs: 0,
      minuteRetentionMs: 86_400_000,
    });
    const on = renderScripts({
      secondRetentionMs: 300_000,
      minuteRetentionMs: 86_400_000,
    });

    expect(off.COMPLETE).not.toContain("mx:jobs:s:");
    expect(on.COMPLETE).toContain("mx:jobs:s:");
  });
});

describe.skipIf(!URL)("Redis analytics: two drivers, two retentions", () => {
  it("writes each driver's own expiry, against one server", async () => {
    const short = makeDriver({ metrics: { secondRetentionMs: 60_000 } });
    const long = makeDriver({ metrics: { secondRetentionMs: 900_000 } });

    const shortNs = scope("mx-sha-short");
    const longNs = scope("mx-sha-long");
    const at = MINUTE + 17 * SECOND_BUCKET_MS;

    // The short one runs first, so its script is the one already cached
    // server-side when the long one sends its own.
    await completeOne(short, { ns: shortNs, queue: "jobs" }, "a", at);
    await completeOne(long, { ns: longNs, queue: "jobs" }, "b", at);
    // And again, so both are now running from EVALSHA rather than EVAL.
    await completeOne(short, { ns: shortNs, queue: "jobs" }, "c", at);
    await completeOne(long, { ns: longNs, queue: "jobs" }, "d", at);

    const client = new (await import("bun")).RedisClient(URL!);
    await client.connect();

    const ttlOf = async (driver: RedisDriver, ns: string): Promise<number> =>
      Number(
        await client.send("PTTL", [
          `${driver.keys.queue({ ns, queue: "jobs" }).metricsPrefix}jobs:s:${MINUTE}`,
        ]),
      );

    const shortTtl = await ttlOf(short, shortNs);
    const longTtl = await ttlOf(long, longNs);

    // Each wrote the expiry its *own* text asks for. Render the scripts once
    // for the module, or cache a SHA by the script's name, and the second
    // driver silently gets the first one's retention — with no error anywhere,
    // which is why this is asserted rather than assumed.
    expect(
      Math.abs(shortTtl - (MINUTE + 60_000 + 60_000 - Date.now())),
    ).toBeLessThan(5_000);
    expect(
      Math.abs(longTtl - (MINUTE + 60_000 + 900_000 - Date.now())),
    ).toBeLessThan(5_000);
    expect(longTtl - shortTtl).toBeGreaterThan(800_000);

    client.close();
  });
});
