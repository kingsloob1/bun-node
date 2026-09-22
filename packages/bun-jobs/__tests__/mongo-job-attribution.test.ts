import type { CommandStartedEvent, Document, MongoClient } from "mongodb";
import type { JobQuery, JobRecord, JobState } from "../lib/drivers/driver";
import type { MongoClientLike } from "../lib/drivers/mongo/mongo-driver";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { MongoDriver } from "../lib/drivers/mongo/mongo-driver";
import { makeJob, testNamespace } from "./helpers";

/**
 * The MongoDB driver's job attribution: what the shared contract's
 * `job attribution` block cannot see.
 *
 * The contract holds every backend to the same answers; this file holds the
 * Mongo driver to the *cost* of them and to its storage. A `finishedOn` range
 * is served by the existing finished-order index `{ ns, queue, state,
 * finishedOn }` — a bounded index scan examining only the range's documents,
 * never the collection, with a worker filter checked on that same scan — and
 * the stamp lives in the fields the claim already writes (`workerId`, plus
 * `workerKey`/`workerHost`/`workerPid`), kept by the settle.
 *
 * The page and total reads are taken off the wire (the driver is lent a client
 * with command monitoring on) and explained exactly as sent.
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

/**
 * The finished-order index, as the server names it. `_id` ends its key since
 * the 2026-09-22 fix round, so a listing sorted by `finishedOn` then `_id`
 * walks the index instead of sorting the state; the old name is retired.
 */
const FINISHED_INDEX_NAME = "ns_1_queue_1_state_1_finishedOn_1__id_1";

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

/** What one driver sent to its jobs collection, as the server saw it. */
interface Recorder {
  /** The driver, on a collection prefix of its own. */
  driver: MongoDriver;
  /** Its jobs collection's name. */
  jobs: string;
  /** Every `find`/`aggregate` on that collection since the last `reset`. */
  reads: () => CommandStartedEvent[];
  /** Forgets what was recorded so far. */
  reset: () => void;
}

/** A driver on its own collections, lent the monitoring client. */
async function makeRecorder(name: string): Promise<Recorder> {
  const shared = await monitoredClient();
  const prefix = `ja_${name}_${Math.random().toString(36).slice(2, 8)}_`;
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

  const jobs = `${prefix}jobs`;
  let seen: CommandStartedEvent[] = [];
  shared.on("commandStarted", (event) => {
    const target = event.command[event.commandName];
    if (
      (event.commandName === "aggregate" || event.commandName === "find") &&
      target === jobs
    ) {
      seen.push(event);
    }
  });

  return {
    driver,
    jobs,
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
  // Only what was sent: `hint: undefined` is a parse error.
  const hint = command.hint === undefined ? {} : { hint: command.hint };
  const explained: Document =
    commandName === "aggregate"
      ? {
          aggregate: command.aggregate,
          pipeline: command.pipeline,
          ...hint,
          cursor: {},
        }
      : {
          find: command.find,
          filter: command.filter,
          ...(command.sort === undefined ? {} : { sort: command.sort }),
          ...(command.skip === undefined ? {} : { skip: command.skip }),
          ...(command.limit === undefined ? {} : { limit: command.limit }),
          ...hint,
        };

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

/** A settled job, stamped by `key`'s worker, finished at `finishedOn`. */
function finished(
  state: JobState,
  finishedOn: number,
  key: string,
  overrides: Partial<JobRecord> = {},
): JobRecord {
  return makeJob({
    state,
    createdAt: finishedOn - 1_000,
    processedOn: finishedOn - 10,
    finishedOn,
    attemptsMade: 1,
    processedBy: { id: `${key}-1`, key, host: "h", pid: 1 },
    ...overrides,
  });
}

/** `count` values, the `i`th made by `make(i)`. */
function times<T>(count: number, make: (i: number) => T): T[] {
  return Array.from({ length: count }, (_, i) => make(i));
}

/** A listing query over `states`, first page of 50, with a total. */
function listing(states: JobState[], extra: Partial<JobQuery> = {}): JobQuery {
  return {
    states,
    order: "desc",
    offset: 0,
    limit: 50,
    total: true,
    ...extra,
  };
}

describe.skipIf(!URL)("MongoDB driver: job attribution", () => {
  it("stores the stamp whole in one sub-document, kept by the settle while the holder is cleared", async () => {
    const { driver, jobs } = await makeRecorder("store");
    const q = { ns: scope("ja-store"), queue: "orders" };
    const collection = (await monitoredClient()).db().collection(jobs);
    const now = Date.now();
    const raw = async (): Promise<Document | null> =>
      await collection.findOne({ ns: q.ns, id: "a" });

    await driver.addJob(q, makeJob({ id: "a", createdAt: now - 10 }));
    expect(await raw()).not.toHaveProperty("processedBy");

    const claimed = await driver.claimJob(q, {
      token: "t1",
      lockMs: 30_000,
      now,
      workerId: "w-1",
      worker: { key: "mail", host: "box", pid: 42 },
    });
    const stamp = { id: "w-1", key: "mail", host: "box", pid: 42 };
    expect(claimed?.processedBy).toEqual(stamp);
    expect(await raw()).toMatchObject({ workerId: "w-1", processedBy: stamp });

    // A retry, then an id-only claim: the stamp is replaced whole.
    expect(
      await driver.failJob(
        q,
        "a",
        "t1",
        { name: "Error", message: "boom" },
        { retry: true, runAt: now },
        now + 1,
        5,
      ),
    ).toBe(true);
    expect(await raw()).toMatchObject({ workerId: null, processedBy: stamp });
    expect(await driver.promoteDelayed(q, now + 2, 10)).toBe(1);
    const again = await driver.claimJob(q, {
      token: "t2",
      lockMs: 30_000,
      now: now + 2,
      workerId: "w-2",
    });
    expect(again?.id).toBe("a");
    expect((await raw())?.processedBy).toEqual({ id: "w-2" });

    expect(await driver.completeJob(q, "a", "t2", null, false, now + 5)).toBe(
      true,
    );
    expect(await raw()).toMatchObject({
      state: "completed",
      workerId: null,
      processedBy: { id: "w-2" },
    });

    const read = await driver.getJob(q, "a");
    expect(read?.workerId).toBeNull();
    expect(read?.processedBy).toEqual({ id: "w-2" });
  });

  it("reads documents from before attribution, and keeps a stamp an older version settles", async () => {
    const { driver, jobs } = await makeRecorder("legacy");
    const q = { ns: scope("ja-legacy"), queue: "orders" };
    const collection = (await monitoredClient()).db().collection(jobs);
    const now = Date.now();

    await driver.addJobs(q, [
      makeJob({ id: "old-active" }),
      makeJob({ id: "mixed", createdAt: now - 10 }),
    ]);
    // Claimed by an older version: a holder, no stamp.
    await collection.updateOne(
      { ns: q.ns, id: "old-active" },
      { $set: { state: "active", workerId: "old-1", lockToken: "x" } },
    );
    // Claimed by this version, then settled by an older one — which clears
    // the holder, as it always did, and knows nothing of the stamp.
    await driver.claimJob(q, {
      token: "t",
      lockMs: 30_000,
      now,
      workerId: "w-1",
      worker: { key: "mail", host: "box", pid: 1 },
    });
    await collection.updateOne(
      { ns: q.ns, id: "mixed" },
      {
        $set: {
          state: "completed",
          finishedOn: now + 1,
          lockToken: null,
          lockExpiresAt: null,
          workerId: null,
        },
      },
    );

    const [oldActive, mixed] = await driver.getJobs(q, ["old-active", "mixed"]);
    expect(oldActive?.workerId).toBe("old-1");
    expect(oldActive?.processedBy ?? null).toBeNull();
    expect(mixed?.workerId).toBeNull();
    expect(mixed?.processedBy).toEqual({
      id: "w-1",
      key: "mail",
      host: "box",
      pid: 1,
    });

    const page = await driver.findJobs(
      q,
      listing(["active", "completed"], { workerKeys: ["mail"] }),
    );
    expect(page.jobs.map((job) => job.id)).toEqual(["mixed"]);
    expect(page.total).toBe(1);
  });

  it("round-trips a record whose holder and stamp disagree", async () => {
    const { driver } = await makeRecorder("restore");
    const q = { ns: scope("ja-restore"), queue: "orders" };
    const now = Date.now();
    const restored = finished("completed", now, "k", {
      id: "r",
      workerId: "holder-value",
      processedBy: { id: "stamp-value", key: "k" },
    });

    expect((await driver.addJob(q, restored)).added).toBe(true);
    expect(await driver.getJob(q, "r")).toEqual(restored);
  });

  it("serves a finishedOn range from the finished-order index, examining only the range's documents", async () => {
    const { driver, reads, reset } = await makeRecorder("explain");
    const ns = scope("ja-explain");
    const q = { ns, queue: "orders" };
    const base = Date.now() - 3_600_000;
    const from = base + 1_000_000;
    const to = from + 100_000;

    // In range: 20 completed and 10 dead, split over two keys.
    const ab = (i: number): string => (i % 2 === 0 ? "a" : "b");
    const inRange = [
      ...times(20, (i) => finished("completed", from + i * 1_000, ab(i))),
      ...times(10, (i) => finished("dead", from + 500 + i * 1_000, ab(i))),
    ];
    // In the collection's way, none of it to be examined: finished jobs either
    // side of the range, another queue's in the range, and a backlog of
    // unfinished jobs.
    const noise = [
      ...times(200, (i) => finished("completed", base + i * 1_000, "a")),
      ...times(200, (i) => finished("dead", to + i * 1_000, "b")),
      ...times(200, () => makeJob({ state: "waiting" })),
      ...times(100, () => makeJob({ state: "failed", runAt: from + 10 })),
    ];
    await driver.addJobs(q, [...inRange, ...noise]);
    await driver.addJobs(
      { ns, queue: "mail" },
      times(200, (i) => finished("completed", from + i * 100, "a")),
    );

    const cases: { query: JobQuery; expected: number }[] = [
      {
        query: listing(["completed", "dead"], {
          finishedFrom: from,
          finishedTo: to,
        }),
        expected: 30,
      },
      {
        query: listing(["completed"], { finishedFrom: from, finishedTo: to }),
        expected: 20,
      },
      {
        // Every state asked for; only the finished ones are read.
        query: listing(
          ["waiting", "active", "failed", "delayed", "completed", "dead"],
          { finishedFrom: from, finishedTo: to },
        ),
        expected: 30,
      },
      {
        // The key is checked on the range's scan: it narrows what comes back,
        // not what is examined.
        query: listing(["completed", "dead"], {
          finishedFrom: from,
          finishedTo: to,
          workerKeys: ["a"],
        }),
        expected: 15,
      },
    ];

    for (const { query, expected } of cases) {
      reset();
      const page = await driver.findJobs(q, query);
      expect(page.jobs).toHaveLength(expected);
      expect(page.total).toBe(expected);

      const sent = reads();
      // The page's `find` and the total's `countDocuments` (an aggregate).
      expect(sent.map((event) => event.commandName).sort()).toEqual([
        "aggregate",
        "find",
      ]);

      for (const event of sent) {
        const plan = await explain(event);
        expect(plan.stages).not.toContain("COLLSCAN");
        // An index scan, or — for a single state's bare count — the count
        // scan of the same index.
        expect(
          plan.stages.includes("IXSCAN") || plan.stages.includes("COUNT_SCAN"),
        ).toBe(true);
        expect(plan.indexes).toEqual([FINISHED_INDEX_NAME]);
        // Only the range's entries, all keys: 20 completed and 10 dead. The
        // page fetches each; the total, with nothing to check beyond the
        // index, may be answered from the keys alone.
        const finishedInRange = query.states.includes("dead") ? 30 : 20;
        const covered =
          event.commandName === "aggregate" && query.workerKeys === undefined;
        expect(plan.docsExamined).toBe(covered ? 0 : finishedInRange);
        // Plus at most one key per state bound that ends each scan.
        expect(plan.keysExamined).toBeGreaterThanOrEqual(finishedInRange);
        expect(plan.keysExamined).toBeLessThanOrEqual(finishedInRange + 2);
      }
    }
  });

  it("names the finished-order index even when another scans as many keys", async () => {
    const { driver, reads, reset } = await makeRecorder("tie");
    const q = { ns: scope("ja-tie"), queue: "orders" };
    const base = Date.now() - 3_600_000;

    // Every finished job in range, so the promotion index `{ ns, queue,
    // state, runAt }` bounds exactly as many keys: the planner's trial has no
    // fewer keys to prefer the finished-order index by.
    const abb = (i: number): string => (i % 3 === 0 ? "a" : "b");
    await driver.addJobs(q, [
      ...times(150, (i) => finished("completed", base + i * 1_000, abb(i))),
      ...times(150, () => makeJob({ state: "waiting" })),
    ]);

    for (const query of [
      listing(["completed"], { finishedFrom: base }),
      listing(["completed"], { finishedTo: base + 10_000_000 }),
      listing(["completed"], { finishedFrom: base, workerKeys: ["a"] }),
      listing(["completed", "dead"], { finishedFrom: base, workerKeys: ["a"] }),
    ]) {
      reset();
      await driver.findJobs(q, query);
      for (const event of reads()) {
        const plan = await explain(event);
        expect(plan.indexes).toEqual([FINISHED_INDEX_NAME]);
      }
    }
  });

  it("answers a range that can match nothing without asking the server", async () => {
    const { driver, reads, reset } = await makeRecorder("nothing");
    const q = { ns: scope("ja-nothing"), queue: "orders" };
    const now = Date.now();
    await driver.addJob(q, finished("completed", now, "a"));

    reset();
    for (const query of [
      listing(["completed"], { finishedFrom: now, finishedTo: now }),
      listing(["waiting", "active"], { finishedFrom: now - 1 }),
      listing(["completed"], { workerKeys: [] }),
      listing(["completed"], { workerIds: [] }),
    ]) {
      expect(await driver.findJobs(q, query)).toEqual({ jobs: [], total: 0 });
    }
    expect(reads()).toEqual([]);
  });
});
