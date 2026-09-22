import type { CommandStartedEvent, Document, MongoClient } from "mongodb";
import type { JobQuery, JobRecord, JobState } from "../lib/drivers/driver";
import type { MongoClientLike } from "../lib/drivers/mongo/mongo-driver";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { sortByCreated } from "../lib/drivers/added";
import { MongoDriver } from "../lib/drivers/mongo/mongo-driver";
import { makeJob, testNamespace } from "./helpers";

/**
 * The MongoDB driver's reads by creation time: what the shared contract's
 * `jobs by creation time` block cannot see.
 *
 * The contract holds every backend to the same answers; this file holds the
 * Mongo driver to the shape and cost of them. `countAddedJobs` is one
 * aggregation, answered from the claim index without fetching a document,
 * and asks nothing for an empty range. `sort: "createdAt"` breaks ties by
 * `_id`, whose byte order is code point order even beyond ASCII and beyond
 * the Basic Multilingual Plane, and fetches only the page.
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

/** The claim index, as the server names it: the one both reads use. */
const CLAIM_INDEX_NAME = "ns_1_queue_1_state_1_priority_1_createdAt_1__id_1";

/** A fixed instant the cases build around, never read from a clock. */
const T = 1_700_000_000_000;

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
  /** Every `find`/`aggregate` on its jobs collection since the last `reset`. */
  reads: () => CommandStartedEvent[];
  /** Forgets what was recorded so far. */
  reset: () => void;
}

/** A driver on its own collections, lent the monitoring client. */
async function makeRecorder(name: string): Promise<Recorder> {
  const shared = await monitoredClient();
  const prefix = `ab_${name}_${Math.random().toString(36).slice(2, 8)}_`;
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

/** A command's sort as a plain document: the driver sends it as a `Map`. */
function plainSort(sort: unknown): Document | undefined {
  return sort instanceof Map
    ? (Object.fromEntries(sort) as Document)
    : (sort as Document | undefined);
}

/** Explains, with execution stats, the very command a driver sent. */
async function explain(event: CommandStartedEvent): Promise<PlanEvidence> {
  const { commandName, command } = event;
  const hint = command.hint === undefined ? {} : { hint: command.hint };
  const sort = plainSort(command.sort);
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
          ...(sort === undefined ? {} : { sort }),
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

/** A job in `state`, created at `createdAt`. */
function created(
  state: "waiting" | "completed" | "dead",
  createdAt: number,
  overrides: Partial<JobRecord> = {},
): JobRecord {
  return state === "waiting"
    ? makeJob({ createdAt, ...overrides })
    : makeJob({
        state,
        createdAt,
        processedOn: createdAt + 5,
        finishedOn: createdAt + 10,
        attemptsMade: 1,
        ...(state === "dead"
          ? { failedReason: { name: "Error", message: "x" } }
          : {}),
        ...overrides,
      });
}

/** A listing query sorted by creation, first page of 50, with a total. */
function byCreated(
  states: JobState[],
  extra: Partial<JobQuery> = {},
): JobQuery {
  return {
    states,
    order: "asc",
    offset: 0,
    limit: 50,
    total: true,
    sort: "createdAt",
    ...extra,
  };
}

describe.skipIf(!URL)("MongoDB driver: reads by creation time", () => {
  it("counts in one aggregation, matching the range on createdAt, and asks nothing for an empty range", async () => {
    const { driver, reads, reset } = await makeRecorder("shape");
    const ns = scope("ab-shape");
    await driver.addJobs({ ns, queue: "orders" }, [
      created("waiting", T + 1),
      created("completed", T + 2),
    ]);

    reset();
    expect(await driver.countAddedJobs(ns, { from: T, to: T + 10 })).toEqual({
      orders: {
        waiting: 1,
        delayed: 0,
        active: 0,
        completed: 1,
        failed: 0,
        dead: 0,
        "waiting-children": 0,
      },
    });
    expect(reads().map((event) => event.commandName)).toEqual(["aggregate"]);
    expect(reads()[0]!.command.pipeline).toEqual([
      { $match: { ns, createdAt: { $gte: T, $lt: T + 10 } } },
      {
        $group: {
          _id: { queue: "$queue", state: "$state" },
          total: { $sum: 1 },
        },
      },
    ]);

    reset();
    await driver.countAddedJobs(ns, { from: T, to: T + 10 }, "orders");
    expect(reads()[0]!.command.pipeline[0]).toEqual({
      $match: { ns, createdAt: { $gte: T, $lt: T + 10 }, queue: "orders" },
    });

    reset();
    expect(await driver.countAddedJobs(ns, { from: T, to: T })).toEqual({});
    expect(await driver.countAddedJobs(ns, { from: T + 5, to: T })).toEqual({});
    expect(reads()).toEqual([]);
  });

  it("breaks a createdAt tie by code point beyond ASCII and the BMP, both ways", async () => {
    const { driver } = await makeRecorder("ties");
    const q = { ns: scope("ab-ties"), queue: "ties" };
    // One millisecond; ids where code point order disagrees with case
    // folding (`Z` < `a`), with Latin-1 (`é` after `z`), and with UTF-16
    // units (U+FF5A before U+1D49C, whose high surrogate is 0xD835).
    const ids = ["t-a", "t-\u{1D49C}", "t-Z", "t-ｚ", "t-é", "t-z"];
    const jobs = ids.map((id) => created("waiting", T, { id }));
    await driver.addJobs(q, jobs);

    const expected = sortByCreated([...jobs], "asc").map((job) => job.id);
    expect(expected).toEqual([
      "t-Z",
      "t-a",
      "t-z",
      "t-é",
      "t-ｚ",
      "t-\u{1D49C}",
    ]);
    // The premise: UTF-16 unit order is a different one.
    expect([...ids].sort()).not.toEqual(expected);

    const asc = await driver.findJobs(q, byCreated(["waiting"]));
    expect(asc.jobs.map((job) => job.id)).toEqual(expected);
    const desc = await driver.findJobs(
      q,
      byCreated(["waiting"], { order: "desc" }),
    );
    expect(desc.jobs.map((job) => job.id)).toEqual([...expected].reverse());
  });

  it("counts from the claim index alone, examining keys for the range and no document", async () => {
    const { driver, reads, reset } = await makeRecorder("covered");
    const ns = scope("ab-covered");
    // 600 jobs over 600ms, 30 of them in the range.
    const states = ["waiting", "completed", "dead"] as const;
    const all: JobRecord[] = [];
    for (let i = 0; i < 600; i++) {
      all.push(created(states[i % 3]!, T + i));
    }
    await driver.addJobs({ ns, queue: "a" }, all.slice(0, 300));
    await driver.addJobs({ ns, queue: "b" }, all.slice(300));

    reset();
    const counts = await driver.countAddedJobs(ns, {
      from: T + 285,
      to: T + 315,
    });
    expect(
      Object.values(counts).reduce(
        (sum, each) => sum + Object.values(each).reduce((a, b) => a + b, 0),
        0,
      ),
    ).toBe(30);

    const plan = await explain(reads()[0]!);
    expect(plan.indexes).toEqual([CLAIM_INDEX_NAME]);
    expect(plan.stages).toContain("PROJECTION_COVERED");
    expect(plan.docsExamined).toBe(0);
    // The range's keys plus a seek per (queue, state, priority) prefix, never
    // the namespace's 600.
    expect(plan.keysExamined).toBeLessThan(30 + 20);
  });

  it("sorts a page by creation over the index's keys and fetches only the page", async () => {
    const { driver, reads, reset } = await makeRecorder("page");
    const q = { ns: scope("ab-page"), queue: "done" };
    // Added out of creation order: 7 is coprime to 400, so every instant once.
    const done: JobRecord[] = [];
    for (let i = 0; i < 400; i++) {
      done.push(created("completed", T + ((i * 7) % 400)));
    }
    await driver.addJobs(q, done);

    reset();
    const page = await driver.findJobs(
      q,
      byCreated(["completed"], { order: "desc", limit: 20 }),
    );
    expect(page.total).toBe(400);
    expect(page.jobs.map((job) => job.createdAt)).toEqual(
      Array.from({ length: 20 }, (_, i) => T + 399 - i),
    );

    const find = reads().find((event) => event.commandName === "find")!;
    expect(plainSort(find.command.sort)).toEqual({ createdAt: -1, _id: -1 });
    const plan = await explain(find);
    expect(plan.indexes).toEqual([CLAIM_INDEX_NAME]);
    expect(plan.docsExamined).toBe(20);
  });
});
