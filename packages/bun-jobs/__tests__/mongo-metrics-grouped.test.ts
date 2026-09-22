import type { CommandStartedEvent, Document, MongoClient } from "mongodb";
import type { MongoClientLike } from "../lib/drivers/mongo/mongo-driver";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { MINUTE_BUCKET_MS } from "../lib/api/contract/constants";
import { bucketStart, NAMESPACE_ENTITY } from "../lib/drivers/metrics";
import { MongoDriver } from "../lib/drivers/mongo/mongo-driver";
import { runnerKey } from "../lib/shared/keys";
import { testNamespace } from "./helpers";

/**
 * The MongoDB driver's grouped analytics reads: what the shared contract's
 * `analytics: grouped reads` block cannot see.
 *
 * The contract holds every backend to the same answers; this file holds the
 * Mongo driver to the *cost* of them — **one aggregation** for a totals read
 * and **one query** for a batch read however many entities they cover, each
 * an index scan on the read index `{ ns, kind, entity, interval, at }` that
 * examines only the range's documents — and to the two details of its own
 * encoding: the roll-up is never read as an entity, and a worker key holding
 * a colon splits back intact.
 *
 * Operations are counted from the server's side of the wire: the driver is
 * lent a client with command monitoring on, and every `aggregate` / `find`
 * naming the metrics collection is recorded, with the exact pipeline or filter
 * it sent — which is also what `explain()` is run on.
 *
 * ```bash
 * BUN_JOBS_TEST_MONGODB_URL=mongodb://127.0.0.1:27017/bun_jobs_test bun test
 * ```
 *
 * **Every namespace this file creates is purged by name, every collection it
 * creates is dropped by name, and nothing is ever deleted by prefix**: other
 * sessions share that server.
 */

/** The server to test against, when one is configured. */
const URL = process.env.BUN_JOBS_TEST_MONGODB_URL;

/** The read index's key, as the driver defines it. */
const READ_INDEX = { ns: 1, kind: 1, entity: 1, interval: 1, at: 1 };
/** The same, as the server names it. */
const READ_INDEX_NAME = "ns_1_kind_1_entity_1_interval_1_at_1";

/** One client for the whole file, monitoring every command. */
let client: MongoClient | undefined;
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

  if (client) {
    for (const name of collections) {
      await client
        .db()
        .collection(name)
        .drop()
        .catch(() => undefined);
    }
  }

  await Promise.allSettled(drivers.map((driver) => driver.close()));
  await client?.close();
});

/** The shared monitoring client, connected on first use. */
async function monitoredClient(): Promise<MongoClient> {
  if (!client) {
    const { MongoClient } = await import("mongodb");
    client = new MongoClient(URL!, { monitorCommands: true });
    await client.connect();
  }
  return client;
}

/** What one driver sent to its metrics collection, as the server saw it. */
interface Recorder {
  /** The driver, on a collection prefix of its own. */
  driver: MongoDriver;
  /** Its metrics collection's name. */
  metrics: string;
  /** Every `aggregate`/`find` on that collection since the last `reset`. */
  reads: () => CommandStartedEvent[];
  /** Forgets what was recorded so far. */
  reset: () => void;
}

/** A driver on its own collections, lent the monitoring client. */
async function makeRecorder(name: string): Promise<Recorder> {
  const shared = await monitoredClient();
  const prefix = `gr_${name}_${Math.random().toString(36).slice(2, 8)}_`;
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

  const driver = new MongoDriver({
    url: URL,
    client: shared as unknown as MongoClientLike,
    collectionPrefix: prefix,
  });
  drivers.push(driver);

  const metrics = `${prefix}metrics`;
  let seen: CommandStartedEvent[] = [];
  shared.on("commandStarted", (event) => {
    const target = event.command[event.commandName];
    if (
      (event.commandName === "aggregate" || event.commandName === "find") &&
      target === metrics
    ) {
      seen.push(event);
    }
  });

  return {
    driver,
    metrics,
    reads: () => seen,
    reset: () => {
      seen = [];
    },
  };
}

/** A namespace of this case's own, purged by name at the end. */
function scope(name: string): string {
  const created = testNamespace(name);
  namespaces.add(created);
  return created;
}

/** The minute before last: whole, past, and so never straddled. */
function pastMinute(): number {
  return bucketStart(Date.now() - 2 * MINUTE_BUCKET_MS, MINUTE_BUCKET_MS);
}

/** How many of each command a set of recorded reads is. */
function commandCounts(events: CommandStartedEvent[]): Record<string, number> {
  const counts: Record<string, number> = { aggregate: 0, find: 0 };
  for (const event of events) {
    counts[event.commandName] = (counts[event.commandName] ?? 0) + 1;
  }
  return counts;
}

/** Every value of `key` anywhere in an explain document. */
function collect(node: unknown, key: string, into: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const item of node) {
      collect(item, key, into);
    }
  } else if (node && typeof node === "object") {
    for (const [field, value] of Object.entries(node)) {
      if (field === key) {
        into.push(value);
      }
      collect(value, key, into);
    }
  }
  return into;
}

/** What an explained read did: its winning plan's stages and its work. */
interface PlanEvidence {
  /** Every stage name in the winning plan, outermost first. */
  stages: string[];
  /** Every index the winning plan scans. */
  indexes: string[];
  /** Index keys examined. */
  keysExamined: number;
  /** Documents examined. */
  docsExamined: number;
}

/** Explains, with execution stats, the very command a driver sent. */
async function explain(event: CommandStartedEvent): Promise<PlanEvidence> {
  const { commandName, command } = event;
  // The hint only when one was sent: `hint: undefined` is a parse error.
  const hint = command.hint === undefined ? {} : { hint: command.hint };
  const explained: Document =
    commandName === "aggregate"
      ? {
          aggregate: command.aggregate,
          pipeline: command.pipeline,
          ...hint,
          cursor: {},
        }
      : { find: command.find, filter: command.filter, ...hint };

  const result = await (await monitoredClient())
    .db()
    .command({ explain: explained, verbosity: "executionStats" });

  const winning = collect(result, "winningPlan");
  return {
    stages: collect(winning, "stage").map(String),
    indexes: collect(winning, "indexName").map(String),
    keysExamined: Number(collect(result, "totalKeysExamined")[0]),
    docsExamined: Number(collect(result, "totalDocsExamined")[0]),
  };
}

describe.skipIf(!URL)("MongoDB driver: grouped analytics reads", () => {
  it("totals any number of runners in one aggregation, and a batch of them in one query", async () => {
    const { driver, reads, reset } = await makeRecorder("runner-ops");
    const first = pastMinute();
    const range = {
      from: first,
      to: first + MINUTE_BUCKET_MS,
      interval: MINUTE_BUCKET_MS,
    };

    for (const count of [1, 25]) {
      const ns = scope(`gr-ops-runners-${count}`);
      const ids = Array.from({ length: count }, (_, i) => `r-${i}`);
      const runners = ids.map((id) => runnerKey(id));
      for (const [i, runner] of runners.entries()) {
        await driver.countRunnerRun(ns, runner, first + i, {
          succeeded: 1,
          durationMs: 10 + i,
        });
        await driver.countRunnerRun(ns, runner, first + MINUTE_BUCKET_MS, {
          started: 1,
        });
      }
      await driver.flushMetrics();

      for (const durations of [false, true]) {
        reset();
        const totals = await driver.getRunnerMetricsTotals(ns, {
          ...range,
          durations,
        });
        expect(totals).toHaveLength(count);
        expect(commandCounts(reads())).toEqual({ aggregate: 1, find: 0 });

        reset();
        const batch = await driver.getRunnerMetricsMany(ns, runners, {
          ...range,
          durations,
        });
        expect(batch).toHaveLength(count);
        expect(commandCounts(reads())).toEqual({ aggregate: 0, find: 1 });
      }
    }
  });

  it("totals any number of worker keys in one aggregation, and a batch of them in one query", async () => {
    const { driver, reads, reset } = await makeRecorder("worker-ops");
    const first = pastMinute();
    const range = {
      from: first,
      to: first + MINUTE_BUCKET_MS,
      interval: MINUTE_BUCKET_MS,
    };

    for (const count of [1, 25]) {
      const ns = scope(`gr-ops-workers-${count}`);
      const refs = Array.from({ length: count }, (_, i) => ({
        queue: i % 2 === 0 ? "orders" : "mail",
        key: `w-${i}`,
      }));
      for (const ref of refs) {
        await driver.countWorkerJobs({ ns, queue: ref.queue }, ref.key, first, {
          completed: 1,
        });
        await driver.sampleWorkerBusyness(
          { ns, queue: ref.queue },
          ref.key,
          first + 1_000,
          { active: 1, concurrency: 2 },
        );
      }
      await driver.flushMetrics();

      for (const busyness of [false, true]) {
        for (const queues of [undefined, ["orders", "mail"]]) {
          reset();
          const totals = await driver.getWorkerMetricsTotals(ns, {
            ...range,
            busyness,
            ...(queues ? { queues } : {}),
          });
          expect(totals).toHaveLength(count);
          expect(commandCounts(reads())).toEqual({ aggregate: 1, find: 0 });
        }

        reset();
        const batch = await driver.getWorkerMetricsMany(ns, refs, {
          ...range,
          busyness,
        });
        expect(batch).toHaveLength(count);
        expect(commandCounts(reads())).toEqual({ aggregate: 0, find: 1 });
      }
    }
  });

  it("answers an empty filter or batch without asking the server anything", async () => {
    const { driver, reads, reset } = await makeRecorder("empty");
    const ns = scope("gr-empty");
    const first = pastMinute();
    const range = {
      from: first,
      to: first + MINUTE_BUCKET_MS,
      interval: MINUTE_BUCKET_MS,
    };
    await driver.countRunnerRun(ns, runnerKey("a"), first, { started: 1 });
    await driver.flushMetrics();

    reset();
    expect(
      await driver.getRunnerMetricsTotals(ns, { ...range, runners: [] }),
    ).toEqual([]);
    expect(
      await driver.getWorkerMetricsTotals(ns, { ...range, queues: [] }),
    ).toEqual([]);
    expect(await driver.getRunnerMetricsMany(ns, [], range)).toEqual([]);
    expect(await driver.getWorkerMetricsMany(ns, [], range)).toEqual([]);
    expect(reads()).toEqual([]);
  });

  it("scans the read index, examining only the range's documents, never the collection", async () => {
    const { driver, reads, reset } = await makeRecorder("explain");
    const ns = scope("gr-explain");
    const noise = scope("gr-explain-noise");
    const first = pastMinute();
    const second = first + MINUTE_BUCKET_MS;
    const range = { from: first, to: second, interval: MINUTE_BUCKET_MS };
    const runners = ["a", "b", "c"].map((id) => runnerKey(id));

    // In range: 3 runners × 2 minutes of `runs`, plus a `durations` bucket
    // each in the first minute.
    for (const runner of runners) {
      await driver.countRunnerRun(ns, runner, first, {
        succeeded: 1,
        durationMs: 5,
      });
      await driver.countRunnerRun(ns, runner, second, { started: 1 });
    }
    // In range and in the index's way, none of it to be examined: another
    // namespace's buckets at the same widths and times, this namespace's
    // workers, and buckets either side of the range.
    for (let i = 0; i < 40; i++) {
      await driver.countRunnerRun(noise, runnerKey(`n-${i}`), first, {
        succeeded: 1,
        durationMs: 5,
      });
      await driver.countWorkerJobs(
        { ns: noise, queue: "orders" },
        `w-${i}`,
        first,
        { completed: 1 },
      );
    }
    for (let i = 0; i < 10; i++) {
      await driver.countWorkerJobs({ ns, queue: "orders" }, `w-${i}`, first, {
        completed: 1,
      });
      await driver.countWorkerJobs({ ns, queue: "hidden" }, `w-${i}`, first, {
        completed: 1,
      });
    }
    await driver.countRunnerRun(ns, runners[0]!, first - MINUTE_BUCKET_MS, {
      started: 1,
    });
    await driver.countRunnerRun(ns, runners[0]!, second + MINUTE_BUCKET_MS, {
      started: 1,
    });
    await driver.flushMetrics();

    /** Asserts one recorded read's plan, and how many documents it touched. */
    const expectIndexed = async (docs: number): Promise<PlanEvidence> => {
      const [event] = reads();
      const plan = await explain(event!);
      expect(plan.stages).not.toContain("COLLSCAN");
      expect(plan.stages).toContain("IXSCAN");
      expect(plan.indexes).toEqual([READ_INDEX_NAME]);
      expect(plan.docsExamined).toBe(docs);
      return plan;
    };

    // Runner totals with durations: 6 `runs` + 3 `durations` documents.
    reset();
    await driver.getRunnerMetricsTotals(ns, { ...range, durations: true });
    expect(reads()[0]!.command.hint).toEqual(READ_INDEX);
    const runnerTotals = await expectIndexed(9);
    // Keys include the scan's seeks between bounds, so they are not 9 — but
    // nowhere near the 80 noise buckets and the roll-up's that the prune
    // index `{ interval, at }` would have walked for this range.
    expect(runnerTotals.keysExamined).toBeLessThan(2 * 9 + 1);

    // Worker totals filtered to one queue: its 10 documents, not `hidden`'s.
    reset();
    await driver.getWorkerMetricsTotals(ns, { ...range, queues: ["orders"] });
    await expectIndexed(10);

    // A batch of two runners: their 4 `runs` documents.
    reset();
    await driver.getRunnerMetricsMany(ns, runners.slice(0, 2), range);
    expect(reads()[0]!.command.hint).toEqual(READ_INDEX);
    await expectIndexed(4);
  });

  it("keeps to the read index where the planner would tie, on a collection holding only what is asked", async () => {
    // Nothing else in range: the range-prune index `{ interval, at }` then
    // examines exactly as many keys as the read index, and the planner was
    // seen choosing it — a plan that, once other namespaces fill the range,
    // walks all of them. The hint is what settles the tie.
    const { driver, reads, reset } = await makeRecorder("tie");
    const ns = scope("gr-tie");
    const first = pastMinute();
    const range = {
      from: first,
      to: first + MINUTE_BUCKET_MS,
      interval: MINUTE_BUCKET_MS,
    };
    for (let i = 0; i < 5; i++) {
      await driver.countRunnerRun(ns, runnerKey(`r-${i}`), first, {
        succeeded: 1,
        durationMs: 10,
      });
    }
    await driver.flushMetrics();

    reset();
    await driver.getRunnerMetricsTotals(ns, { ...range, durations: true });
    const totals = await explain(reads()[0]!);
    expect(totals.indexes).toEqual([READ_INDEX_NAME]);
    expect(totals.docsExamined).toBe(10);

    reset();
    await driver.getRunnerMetricsMany(
      ns,
      [runnerKey("r-0"), runnerKey("r-1")],
      range,
    );
    expect((await explain(reads()[0]!)).indexes).toEqual([READ_INDEX_NAME]);
  });

  it("never reads the namespace roll-up as an entity, though its buckets are there", async () => {
    const { driver, metrics } = await makeRecorder("rollup");
    const ns = scope("gr-rollup-mongo");
    const first = pastMinute();
    const range = {
      from: first,
      to: first + MINUTE_BUCKET_MS,
      interval: MINUTE_BUCKET_MS,
    };

    await driver.countRunnerRun(ns, runnerKey("only"), first, { started: 2 });
    await driver.countWorkerJobs({ ns, queue: "orders" }, "w", first, {
      completed: 2,
    });
    await driver.flushMetrics();

    // The roll-up is stored as an entity like any other, in range.
    const stored = await (await monitoredClient())
      .db()
      .collection(metrics)
      .find({ ns, entity: NAMESPACE_ENTITY, interval: MINUTE_BUCKET_MS })
      .toArray();
    expect(stored.map((doc) => doc.kind).sort()).toEqual([
      "runs",
      "workerJobs",
    ]);

    expect(
      (await driver.getRunnerMetricsTotals(ns, range)).map((row) => row.runner),
    ).toEqual([runnerKey("only")]);
    expect(
      (
        await driver.getRunnerMetricsTotals(ns, {
          ...range,
          runners: [NAMESPACE_ENTITY, runnerKey("only")],
        })
      ).map((row) => row.runner),
    ).toEqual([runnerKey("only")]);
    expect(
      (
        await driver.getRunnerMetricsMany(
          ns,
          [NAMESPACE_ENTITY, runnerKey("only")],
          range,
        )
      ).map((entry) => entry.runner),
    ).toEqual([runnerKey("only")]);
    expect(
      (await driver.getWorkerMetricsTotals(ns, range)).map((row) => [
        row.queue,
        row.key,
      ]),
    ).toEqual([["orders", "w"]]);
  });

  it("splits a worker key holding colons back intact, and filters by the whole queue name", async () => {
    const { driver } = await makeRecorder("colon");
    const ns = scope("gr-colon");
    const first = pastMinute();
    const range = {
      from: first,
      to: first + MINUTE_BUCKET_MS,
      interval: MINUTE_BUCKET_MS,
    };

    await driver.countWorkerJobs({ ns, queue: "orders" }, "host:7:a", first, {
      completed: 3,
    });
    // A queue whose name the filter's pattern must not treat as a pattern,
    // and one that merely starts like another.
    await driver.countWorkerJobs({ ns, queue: "a.b" }, "w", first, {
      failed: 1,
    });
    await driver.countWorkerJobs({ ns, queue: "axb" }, "w", first, {
      failed: 2,
    });
    await driver.countWorkerJobs({ ns, queue: "orders-eu" }, "w", first, {
      completed: 5,
    });
    await driver.flushMetrics();

    const rows = await driver.getWorkerMetricsTotals(ns, {
      ...range,
      queues: ["orders", "a.b"],
    });
    expect(
      rows
        .map(({ queue, key, jobs }) => [queue, key, jobs])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    ).toEqual([
      ["a.b", "w", { completed: 0, failed: 1 }],
      ["orders", "host:7:a", { completed: 3, failed: 0 }],
    ]);

    // A prefix of a queue's name is not that queue.
    expect(
      await driver.getWorkerMetricsTotals(ns, { ...range, queues: ["ord"] }),
    ).toEqual([]);

    const batch = await driver.getWorkerMetricsMany(
      ns,
      [{ queue: "orders", key: "host:7:a" }],
      range,
    );
    expect(batch.map(({ queue, key }) => [queue, key])).toEqual([
      ["orders", "host:7:a"],
    ]);
  });
});
