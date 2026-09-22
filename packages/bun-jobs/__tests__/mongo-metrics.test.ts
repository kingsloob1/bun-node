import type { MongoDriverOptions } from "../lib/drivers/mongo/mongo-driver";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import {
  MINUTE_BUCKET_MS,
  SECOND_BUCKET_MS,
} from "../lib/api/contract/constants";
import {
  bucketStart,
  DURATION_HISTOGRAM_SIZE,
  durationBin,
} from "../lib/drivers/metrics";
import { MongoDriver } from "../lib/drivers/mongo/mongo-driver";
import { testNamespace } from "./helpers";

/**
 * The MongoDB driver's analytics: the storage shape the shared contract cannot
 * see.
 *
 * `driverContract`'s `analytics` block asserts what every backend must answer;
 * what is left over is Mongo's own — which collection the buckets live in,
 * which indexes carry them, that a bucket is **one shared document** rather
 * than one per process, that a histogram is one array rather than a field per
 * bin, and that the prune is a range sweep on a once-a-minute clock rather
 * than the per-entity delete the shipped throughput path does.
 *
 * A server is needed, as for every other MongoDB suite:
 *
 * ```bash
 * bun scripts/setup-databases.ts --docker --only=mongodb
 * BUN_JOBS_TEST_MONGODB_URL=mongodb://127.0.0.1:27017/bun_jobs_test bun test
 * ```
 *
 * **Every namespace this file creates is purged by name at the end, every
 * collection it creates is dropped by name, and nothing here ever deletes by
 * prefix**: other sessions share that server.
 */

/** The server to test against, when one is configured. */
const URL = process.env.BUN_JOBS_TEST_MONGODB_URL;

/** Drivers to close when the suite ends. */
const drivers: MongoDriver[] = [];
/** The exact namespaces this run created, to purge — never a prefix sweep. */
const namespaces = new Set<string>();
/** The exact collections this run created, to drop — never a prefix sweep. */
const collections = new Set<string>();

afterAll(async () => {
  const [driver] = drivers;

  if (driver) {
    for (const ns of namespaces) {
      await driver.purge(ns).catch(() => undefined);
    }
  }

  if (URL && collections.size > 0) {
    const client = await connect();
    try {
      for (const name of collections) {
        await client
          .db()
          .collection(name)
          .drop()
          .catch(() => undefined);
      }
    } finally {
      await client.close();
    }
  }

  await Promise.allSettled(drivers.map((driver) => driver.close()));
});

/** A raw client, for looking at what the driver actually wrote. */
async function connect() {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(URL!);
  await client.connect();
  return client;
}

/** A collection-name prefix of this test's own, so nothing shares documents. */
function testPrefix(name: string): string {
  const prefix = `an_${name}_${Math.random().toString(36).slice(2, 8)}_`;
  for (const collection of [
    "jobs",
    "locks",
    "kv",
    "events",
    "jobLogs",
    "runLogs",
    "metrics",
  ]) {
    collections.add(`${prefix}${collection}`);
  }
  return prefix;
}

/** A driver on the configured server, tracked for cleanup. */
function makeDriver(options: Partial<MongoDriverOptions> = {}): MongoDriver {
  const driver = new MongoDriver({ url: URL, ...options });
  drivers.push(driver);
  return driver;
}

/** A namespace of this case's own, purged by name at the end. */
function scope(name: string): string {
  const created = testNamespace(name);
  namespaces.add(created);
  return created;
}

/** A whole minute that has already passed, so no case straddles a boundary. */
function lastMinute(): number {
  return bucketStart(Date.now() - MINUTE_BUCKET_MS, MINUTE_BUCKET_MS);
}

/** Every analytics document a driver's metrics collection holds for a bucket. */
async function metricDocuments(
  prefix: string,
  filter: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const client = await connect();
  try {
    return (await client
      .db()
      .collection(`${prefix}metrics`)
      .find(filter)
      .toArray()) as unknown as Record<string, unknown>[];
  } finally {
    await client.close();
  }
}

describe.skipIf(!URL)("MongoDB driver: analytics storage", () => {
  it("keeps every bucket in one collection, under a read index and a prune index", async () => {
    const prefix = testPrefix("shape");
    const driver = makeDriver({ collectionPrefix: prefix });
    await driver.connect();

    // One collection, named like every other — so `purge`, which sweeps every
    // collection by `ns`, needs no case for it.
    expect(driver.collections.metrics).toBe(`${prefix}metrics`);

    const client = await connect();
    try {
      const found = await client.db().collection(`${prefix}metrics`).indexes();
      const byName = new Map(
        found.map((index) => [String(index.name), index.key]),
      );

      // Exactly these: a series read is a prefix of the first, and the range
      // prune — which names no namespace and no entity — is the second. An
      // index nobody defined here would be somebody's, which is why
      // `RETIRED_INDEXES` drops only names this driver itself created.
      expect([...byName.keys()].sort()).toEqual([
        "_id_",
        "interval_1_at_1",
        "ns_1_kind_1_entity_1_interval_1_at_1",
      ]);
      expect(byName.get("ns_1_kind_1_entity_1_interval_1_at_1")).toEqual({
        ns: 1,
        kind: 1,
        entity: 1,
        interval: 1,
        at: 1,
      });
      expect(byName.get("interval_1_at_1")).toEqual({ interval: 1, at: 1 });
    } finally {
      await client.close();
    }
  }, 45_000);

  it("finds no drift against the schema it just created, and sees a metrics index go missing", async () => {
    const prefix = testPrefix("sync");
    const driver = makeDriver({ collectionPrefix: prefix });
    await driver.connect();

    // The baseline: a freshly created schema proposes nothing. It is what
    // catches an index defined one way and named another, and it has to keep
    // holding now that two of the indexes are the analytics ones.
    expect(await driver.syncSchema({ dryRun: true })).toEqual([]);

    const client = await connect();
    try {
      await client
        .db()
        .collection(`${prefix}metrics`)
        .dropIndex("interval_1_at_1");

      // And the new indexes really are what the sync compares against, rather
      // than only what `connect()` happens to create.
      const planned = await driver.syncSchema({ dryRun: true });
      expect(planned).toHaveLength(1);
      expect(planned[0]!.kind).toBe("create-index");
      expect(planned[0]!.table).toBe(`${prefix}metrics`);
      expect(planned[0]!.target).toBe("interval_1_at_1");
      expect(planned[0]!.applied).toBe(false);

      await driver.syncSchema();
      expect(await driver.syncSchema({ dryRun: true })).toEqual([]);
    } finally {
      await client.close();
    }
  }, 45_000);

  it("writes one shared document per bucket, however many processes count into it", async () => {
    const prefix = testPrefix("shared");
    const ns = scope("an-mongo-shared");
    const q = { ns, queue: "orders" };
    const minute = lastMinute();
    const at = minute + 30_000;

    // Two instances is two processes as far as the store is concerned: each
    // has its own buffer and issues its own `bulkWrite`.
    const first = makeDriver({ collectionPrefix: prefix });
    const second = makeDriver({ collectionPrefix: prefix });

    await first.countWorkerJobs(q, "w-shared", at, { completed: 2 });
    await second.countWorkerJobs(q, "w-shared", at, { completed: 3 });
    await first.flushMetrics();
    await second.flushMetrics();

    // §4a: one document per (ns, entity, at, interval) — no shard fan-out.
    // A shard per process would make this two, and a mid-sized namespace's
    // 58 K documents 1.25 M.
    for (const interval of [SECOND_BUCKET_MS, MINUTE_BUCKET_MS]) {
      const bucket = await metricDocuments(prefix, {
        ns,
        kind: "workerJobs",
        entity: "orders:w-shared",
        interval,
        at: bucketStart(at, interval),
      });

      expect(bucket).toHaveLength(1);
      expect(bucket[0]!.completed).toBe(5);
      expect(bucket[0]!.failed).toBe(0);
    }

    // The namespace roll-up is one document too, and it is a document like
    // any other: `getNamespaceMetrics` is an ordinary read of it.
    const roll = await metricDocuments(prefix, {
      ns,
      kind: "workerJobs",
      entity: "",
      interval: MINUTE_BUCKET_MS,
      at: minute,
    });
    expect(roll).toHaveLength(1);
    expect(roll[0]!.completed).toBe(5);

    // And the two agree with what either driver reads back.
    expect(
      (
        await second.getWorkerMetrics(q, "w-shared", {
          from: minute,
          to: minute,
          interval: MINUTE_BUCKET_MS,
        })
      ).jobs,
    ).toEqual([{ at: minute, completed: 5, failed: 0 }]);
  }, 45_000);

  it("stores a histogram as one array of bins, merged without touching a bin", async () => {
    const prefix = testPrefix("hist");
    const ns = scope("an-mongo-hist");
    const runner = "reports";
    const minute = lastMinute();
    const taken = [5, 5, 900];

    // Two writers again: the arrays have to add up across them without a
    // per-bin atomic increment anywhere.
    const first = makeDriver({ collectionPrefix: prefix });
    const second = makeDriver({ collectionPrefix: prefix });

    await first.countRunnerRun(ns, runner, minute + 1_000, {
      succeeded: 1,
      durationMs: taken[0],
    });
    await first.flushMetrics();
    await second.countRunnerRun(ns, runner, minute + 2_000, {
      succeeded: 1,
      durationMs: taken[1],
    });
    await second.countRunnerRun(ns, runner, minute + 3_000, {
      succeeded: 1,
      durationMs: taken[2],
    });
    await second.flushMetrics();

    const [document] = await metricDocuments(prefix, {
      ns,
      kind: "durations",
      entity: runner,
      interval: MINUTE_BUCKET_MS,
      at: minute,
    });

    // One array of 25 numbers, exactly as `durationBin` indexes it — not a
    // subdocument of bins, which would be a second indexing of the same
    // histogram and an atomic increment per bin.
    const histogram = document!.histogram as number[];
    expect(Array.isArray(histogram)).toBe(true);
    expect(histogram).toHaveLength(DURATION_HISTOGRAM_SIZE);
    expect(histogram[durationBin(5)]).toBe(2);
    expect(histogram[durationBin(900)]).toBe(1);
    expect(histogram.reduce((sum, count) => sum + count, 0)).toBe(3);

    // The mergeable figures merged; no `hist.<bin>` layout anywhere near it.
    expect(document!.count).toBe(3);
    expect(document!.sumMs).toBe(910);
    expect(document!.minMs).toBe(5);
    expect(document!.maxMs).toBe(900);
    expect(Object.keys(document!)).not.toContain("hist");
  }, 45_000);

  it("prunes by range once a minute, over every namespace rather than the batch's", async () => {
    const prefix = testPrefix("prune");
    const mine = scope("an-mongo-prune-mine");
    const idle = scope("an-mongo-prune-idle");
    const driver = makeDriver({ collectionPrefix: prefix });
    const now = Date.now();
    const minute = lastMinute();
    const ancient = bucketStart(now - 25 * 60 * 60_000, MINUTE_BUCKET_MS);

    // The clock's first `due` is always yes — a process starting with a day of
    // somebody else's buckets behind it should sweep them. Spend it here, so
    // the ancient buckets below are certainly stored before a sweep can run.
    await driver.countWorkerJobs({ ns: mine, queue: "orders" }, "w", minute, {
      completed: 1,
    });
    await driver.flushMetrics();

    await driver.countWorkerJobs(
      { ns: mine, queue: "orders" },
      "w-old",
      ancient,
      { completed: 1 },
    );
    // Another namespace, which the sweep-triggering flush below never touches.
    await driver.countWorkerJobs(
      { ns: idle, queue: "orders" },
      "w-idle",
      ancient,
      { completed: 1 },
    );
    await driver.flushMetrics();

    const ancientBuckets = async () =>
      await metricDocuments(prefix, {
        kind: "workerJobs",
        interval: MINUTE_BUCKET_MS,
        at: ancient,
      });

    // Once a minute, not once a flush: the flush that wrote them is not
    // allowed to sweep them, or the prune would be riding the counting path.
    // Two namespaces, each with an entity document and a roll-up document.
    expect(await ancientBuckets()).toHaveLength(4);

    // Far enough ahead that the clock is due again. The driver's own count is
    // in `mine` only — nothing in this batch mentions `idle`, or its entity.
    const ahead = bucketStart(now + 10 * MINUTE_BUCKET_MS, MINUTE_BUCKET_MS);
    await driver.countWorkerJobs({ ns: mine, queue: "orders" }, "w", ahead, {
      completed: 1,
    });
    await driver.flushMetrics();

    // Gone, all four: a sweep scoped to what the batch wrote — which is what
    // the shipped throughput path does, one `deleteMany` per queue written —
    // would have left the idle namespace's buckets, and `w-old`'s, for good.
    expect(await ancientBuckets()).toEqual([]);

    // And only the old ones went.
    expect(
      (
        await driver.getWorkerMetrics({ ns: mine, queue: "orders" }, "w", {
          from: ahead,
          to: ahead,
          interval: MINUTE_BUCKET_MS,
        })
      ).jobs,
    ).toEqual([{ at: ahead, completed: 1, failed: 0 }]);
  }, 45_000);
});
