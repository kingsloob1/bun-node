import type { CommandStartedEvent, Document, MongoClient } from "mongodb";
import type {
  JobFlow,
  JobRecord,
  PendingOptionsRewrite,
  QueueRef,
  StoredJobOptions,
} from "../lib/drivers/driver";
import type { MongoClientLike } from "../lib/drivers/mongo/mongo-driver";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { MongoDriver } from "../lib/drivers/mongo/mongo-driver";
import { JOB_OPTION_BITS } from "../lib/queue/jobDefaults";

/**
 * The MongoDB driver's `rewritePendingOptions`, and its half of the flow
 * race fix: what the shared contract cannot see.
 *
 * The contract holds every backend to the same answers. This file holds the
 * Mongo driver to the shape and cost of them — each batch read is ranges of
 * the claim index with no in-memory sort, each batch's writes are one
 * `bulkWrite` — and to the races only an interleaving can show: a job
 * claimed or patched between a batch's read and its write is `moved` and not
 * written, and a failure delivery whose parent is buried and retried between
 * its reads and its write is refused rather than burying the retried parent.
 *
 * ```bash
 * BUN_JOBS_TEST_MONGODB_URL=mongodb://127.0.0.1:27017/bun_jobs_test bun test
 * ```
 *
 * **Every collection this file creates is dropped by name, and nothing is
 * ever deleted by prefix**: other sessions share that server. Nothing here
 * imports the package root, so it runs whatever else is mid-edit.
 */

/** The server to test against, when one is configured. */
const URL = process.env.BUN_JOBS_TEST_MONGODB_URL;

/** The claim index, as the server names it. */
const CLAIM_INDEX_NAME = "ns_1_queue_1_state_1_priority_1_createdAt_1__id_1";

/** Every collection a driver creates, by its unprefixed name. */
const COLLECTIONS = [
  "jobs",
  "locks",
  "kv",
  "events",
  "jobLogs",
  "runLogs",
  "metrics",
] as const;

/** A fixed instant the cases build around. */
const T = 1_700_000_000_000;

/** One client for the whole file, monitoring every command. */
let client: MongoClient | undefined;
/** Drivers to close when the suite ends. */
const drivers: MongoDriver[] = [];
/** The exact collections this run created, to drop — never a prefix sweep. */
const collections = new Set<string>();

afterAll(async () => {
  await Promise.allSettled(drivers.map((driver) => driver.close()));

  if (client) {
    for (const name of collections) {
      await client
        .db()
        .collection(name)
        .drop()
        .catch(() => undefined);
    }
  }

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

/**
 * Work run inside one collection call of the driver under test, so a case
 * can land a write between two of the driver's own.
 */
interface Hooks {
  /** Runs once, before the next `bulkWrite` on the jobs collection is sent. */
  beforeBulkWrite?: () => Promise<void>;
  /**
   * Runs after each `findOne` on the jobs collection has answered, given its
   * filter and options, before the driver sees the answer.
   */
  afterFindOne?: (
    filter: Document,
    options: Document | undefined,
  ) => Promise<void>;
}

/** A driver under test, the plain one beside it and what it sent. */
interface Rig {
  /** The driver whose collection calls the hooks intercept. */
  driver: MongoDriver;
  /** A driver on the same collections with nothing intercepted: "another process". */
  other: MongoDriver;
  /** The hooks, set and cleared by a case. */
  hooks: Hooks;
  /** Every `find` on the jobs collection since the last `reset`. */
  finds: () => CommandStartedEvent[];
  /** How many `bulkWrite`s the driver under test sent since the last `reset`. */
  bulkWrites: () => number;
  /** Forgets what was recorded so far. */
  reset: () => void;
}

/** A driver on collections of its own, lent the monitoring client through hooks. */
async function makeRig(name: string): Promise<Rig> {
  const shared = await monitoredClient();
  const prefix = `jd_${name}_${randomUUID().slice(0, 8)}_`;
  for (const collection of COLLECTIONS) {
    collections.add(`${prefix}${collection}`);
  }
  const jobsName = `${prefix}jobs`;
  const hooks: Hooks = {};
  let bulkWrites = 0;

  /** The jobs collection, with `bulkWrite` and `findOne` intercepted. */
  const wrapCollection = (
    collectionName: string,
    collection: object,
  ): object =>
    collectionName !== jobsName
      ? collection
      : new Proxy(collection, {
          get(target, property, receiver) {
            const value: unknown = Reflect.get(target, property, receiver);
            if (typeof value !== "function") {
              return value;
            }
            const call = value as (...a: unknown[]) => Promise<unknown>;
            if (property === "bulkWrite") {
              return async (...args: unknown[]) => {
                bulkWrites++;
                const work = hooks.beforeBulkWrite;
                hooks.beforeBulkWrite = undefined;
                await work?.();
                return await call.apply(target, args);
              };
            }
            if (property === "findOne") {
              return async (...args: unknown[]) => {
                const answer = await call.apply(target, args);
                await hooks.afterFindOne?.(
                  args[0] as Document,
                  args[1] as Document | undefined,
                );
                return answer;
              };
            }
            return call.bind(target);
          },
        });

  const proxied = new Proxy(shared, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === "db") {
        return (...args: unknown[]) => {
          const db = target.db(...(args as Parameters<MongoClient["db"]>));
          return new Proxy(db, {
            get(dbTarget, dbProperty) {
              const member: unknown = Reflect.get(
                dbTarget,
                dbProperty,
                dbTarget,
              );
              if (dbProperty === "collection" && typeof member === "function") {
                return (collectionName: string, ...rest: unknown[]) =>
                  wrapCollection(
                    collectionName,
                    (member as (...a: unknown[]) => object).call(
                      dbTarget,
                      collectionName,
                      ...rest,
                    ),
                  );
              }
              return typeof member === "function"
                ? (member as (...a: unknown[]) => unknown).bind(dbTarget)
                : member;
            },
          });
        };
      }
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });

  const driver = new MongoDriver({
    url: URL,
    client: proxied as unknown as MongoClientLike,
    collectionPrefix: prefix,
  });
  const other = new MongoDriver({
    url: URL,
    client: shared as unknown as MongoClientLike,
    collectionPrefix: prefix,
  });
  drivers.push(driver, other);

  let seen: CommandStartedEvent[] = [];
  shared.on("commandStarted", (event) => {
    if (event.commandName === "find" && event.command.find === jobsName) {
      seen.push(event);
    }
  });

  return {
    driver,
    other,
    hooks,
    finds: () => seen,
    bulkWrites: () => bulkWrites,
    reset: () => {
      seen = [];
      bulkWrites = 0;
    },
  };
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
  /** Documents returned. */
  returned: number;
}

/** A command's sort as a plain document: the driver sends it as a `Map`. */
function plainSort(sort: unknown): Document | undefined {
  return sort instanceof Map
    ? (Object.fromEntries(sort) as Document)
    : (sort as Document | undefined);
}

/** Explains, with execution stats, the very `find` a driver sent. */
async function explain(event: CommandStartedEvent): Promise<PlanEvidence> {
  const { command } = event;
  const sort = plainSort(command.sort);
  const explained: Document = {
    find: command.find,
    filter: command.filter,
    ...(sort === undefined ? {} : { sort }),
    ...(command.limit === undefined ? {} : { limit: command.limit }),
    ...(command.projection === undefined
      ? {}
      : { projection: command.projection }),
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
    returned: Number(collect(result, "nReturned")[0]),
  };
}

/** A queue in a namespace of its own; the rig's collections are dropped whole. */
function scope(name: string): QueueRef {
  return { ns: `jd-${name}-${randomUUID()}`, queue: "jdef" };
}

/** Stored options with every default filled in, plus `extra`. */
function opts(extra: Partial<StoredJobOptions> = {}): StoredJobOptions {
  return {
    priority: 0,
    attempts: 1,
    backoff: 0,
    timeout: 0,
    removeOnComplete: false,
    removeOnFail: false,
    keepStacktraces: 5,
    ...extra,
  };
}

/** A job record built at the storage layer. */
function job(overrides: Partial<JobRecord> & { id: string }): JobRecord {
  return {
    name: "test",
    data: null,
    opts: opts(),
    state: "waiting",
    priority: 0,
    runAt: T,
    createdAt: T,
    processedOn: null,
    finishedOn: null,
    expiresAt: null,
    attemptsMade: 0,
    maxAttempts: 1,
    stalledCount: 0,
    progress: null,
    returnValue: null,
    failedReason: null,
    stacktrace: [],
    lockToken: null,
    lockExpiresAt: null,
    workerId: null,
    repeatKey: null,
    flow: null,
    ...overrides,
  };
}

/** One full request, every field at the value a case usually wants. */
function request(
  values: PendingOptionsRewrite["values"],
  extra: Partial<PendingOptionsRewrite> = {},
): PendingOptionsRewrite {
  return {
    states: ["waiting", "delayed", "failed", "waiting-children"],
    values,
    cursor: null,
    limit: 10_000,
    includeUnmarked: false,
    dryRun: false,
    now: T,
    ...extra,
  };
}

/** `count` marked waiting jobs, one millisecond apart, ids sortable. */
function backlog(count: number, prefix = "j"): JobRecord[] {
  const jobs: JobRecord[] = [];
  for (let index = 0; index < count; index++) {
    jobs.push(
      job({
        id: `${prefix}${String(index).padStart(5, "0")}`,
        createdAt: T + index,
        runAt: T,
        opts: opts({ explicit: 0 }),
      }),
    );
  }
  return jobs;
}

describe.skipIf(!URL)("MongoDriver rewritePendingOptions", () => {
  it("reads each batch as ranges of the claim index, with no in-memory sort, examining only what it returns", async () => {
    const rig = await makeRig("plan");
    const q = scope("plan");
    await rig.driver.addJobs(q, backlog(1_200));
    // Jobs in another queue and another state around it, which a read that
    // was not bounded by the index would have to examine.
    await rig.driver.addJobs({ ns: q.ns, queue: "neighbour" }, backlog(300));
    await rig.driver.addJobs(
      q,
      backlog(300, "d").map((each) => ({
        ...each,
        state: "delayed" as const,
        runAt: T + 60_000,
      })),
    );

    rig.reset();
    // Two calls: the first from the start, the second from its cursor, so
    // both shapes of the read are explained.
    const first = await rig.driver.rewritePendingOptions(
      q,
      request({ timeout: 5 }, { limit: 700, states: ["waiting"] }),
    );
    expect(first).toMatchObject({ examined: 700, rewritten: 700 });
    expect(first.next).not.toBeNull();
    const second = await rig.driver.rewritePendingOptions(
      q,
      request(
        { timeout: 5 },
        { limit: 700, states: ["waiting"], cursor: first.next },
      ),
    );
    expect(second).toMatchObject({ examined: 500, rewritten: 500, next: null });

    const reads = rig
      .finds()
      .filter((event) => event.command.projection?.opts === 1);
    // 500, then 201 — one past the room of 200, which says the walk goes on;
    // then 500, and 201 again, which comes back empty: the state is done.
    const limits = reads.map((event) => Number(event.command.limit));
    expect(limits).toEqual([500, 201, 500, 201]);

    const evidence: PlanEvidence[] = [];
    for (const read of reads) {
      const plan = await explain(read);
      evidence.push(plan);
      // Walked in index order: no blocking sort, only the claim index.
      expect(plan.stages).not.toContain("SORT");
      expect(plan.indexes.length).toBeGreaterThan(0);
      expect(new Set(plan.indexes)).toEqual(new Set([CLAIM_INDEX_NAME]));
      // Every document examined is one returned: the filter is all index bounds.
      expect(plan.docsExamined).toBe(plan.returned);
    }

    console.info(
      `[mongo rewrite plan] ${evidence
        .map(
          (plan) =>
            `${plan.stages.join(">")}: ${plan.keysExamined} keys, ${plan.docsExamined} docs for ${plan.returned}`,
        )
        .join("; ")}`,
    );
  });

  it("writes each batch in one bulkWrite, and a dry run in none", async () => {
    const rig = await makeRig("bulk");
    const q = scope("bulk");
    await rig.driver.addJobs(q, backlog(1_200));

    rig.reset();
    const dry = await rig.driver.rewritePendingOptions(
      q,
      request({ attempts: 3 }, { dryRun: true }),
    );
    expect(dry).toMatchObject({
      examined: 1_200,
      rewritten: 1_200,
      next: null,
    });
    expect(rig.bulkWrites()).toBe(0);

    rig.reset();
    const real = await rig.driver.rewritePendingOptions(
      q,
      request({ attempts: 3 }),
    );
    expect(real).toEqual(dry);
    // 500 + 500 + 200.
    expect(rig.bulkWrites()).toBe(3);

    const stored = await rig.driver.getJob(q, "j01199");
    expect(stored?.opts.attempts).toBe(3);
    expect(stored?.maxAttempts).toBe(3);
    expect(stored?.opts.explicit).toBe(0);
  });

  it("counts a job that left the walked states before its write as moved, and writes it nothing", async () => {
    const rig = await makeRig("left");
    const q = scope("left");
    await rig.driver.addJobs(q, backlog(3));

    // Pushed out to later: `delayed` now, with its options, priority and
    // attempts exactly as the batch read them — only the state re-check
    // can see it.
    rig.hooks.beforeBulkWrite = async () => {
      const moved = await rig.other.updateJob(
        q,
        "j00001",
        { runAt: T + 60_000 },
        T,
      );
      expect(moved?.state).toBe("delayed");
    };

    const result = await rig.driver.rewritePendingOptions(
      q,
      request({ timeout: 55 }, { states: ["waiting"] }),
    );
    expect(result).toMatchObject({ examined: 3, rewritten: 2, moved: 1 });
    expect((await rig.driver.getJob(q, "j00001"))?.opts.timeout).toBe(0);
    expect((await rig.driver.getJob(q, "j00002"))?.opts.timeout).toBe(55);
  });

  it("counts a job claimed, or patched, between its read and its write as moved, and writes it nothing", async () => {
    const rig = await makeRig("moved");
    const q = scope("moved");
    await rig.driver.addJobs(q, backlog(5));

    rig.hooks.beforeBulkWrite = async () => {
      // Another process claims the head, and an operator sets a priority on
      // the last — both after the batch was read, before its write lands.
      const claimed = await rig.other.claimJob(q, {
        workerId: "w",
        token: "t",
        lockMs: 60_000,
        now: T + 10,
      });
      expect(claimed?.id).toBe("j00000");
      await rig.other.updateJob(q, "j00004", { priority: 9 }, T + 10);
    };

    const result = await rig.driver.rewritePendingOptions(
      q,
      request({ timeout: 777, priority: 2 }),
    );
    expect(result).toMatchObject({
      examined: 5,
      rewritten: 3,
      moved: 2,
      next: null,
    });

    const claimed = await rig.driver.getJob(q, "j00000");
    expect(claimed?.state).toBe("active");
    expect(claimed?.opts.timeout).toBe(0);
    expect(claimed?.priority).toBe(0);

    // The operator's priority survives, pinned, and the stale plan did not
    // overwrite it.
    const patched = await rig.driver.getJob(q, "j00004");
    expect(patched?.priority).toBe(9);
    expect(patched?.opts).toMatchObject({
      priority: 9,
      timeout: 0,
      explicit: JOB_OPTION_BITS.priority,
    });

    for (const id of ["j00001", "j00002", "j00003"]) {
      const written = await rig.driver.getJob(q, id);
      expect(written?.opts).toMatchObject({ timeout: 777, priority: 2 });
      expect(written?.priority).toBe(2);
    }

    // A second pass finds the patched job explicit on the one key it would
    // still change, and writes it the other.
    const again = await rig.driver.rewritePendingOptions(
      q,
      request({ timeout: 777, priority: 2 }),
    );
    expect(again).toMatchObject({ examined: 4, rewritten: 1, unchanged: 3 });
    expect((await rig.driver.getJob(q, "j00004"))?.opts).toMatchObject({
      priority: 9,
      timeout: 777,
    });
  });
});

describe.skipIf(!URL)(
  "MongoDriver recordChild: a stale failure delivery",
  () => {
    /** A flow value, with only what a case cares about given. */
    const flowOf = (overrides: Partial<JobFlow>): JobFlow => ({
      parent: null,
      children: [],
      pending: 0,
      values: {},
      failures: {},
      recorded: false,
      ...overrides,
    });

    it("is refused when the parent is buried and retried between its reads and its write", async () => {
      const rig = await makeRig("flow-race");
      const ns = `jd-flow-${randomUUID()}`;
      const parents: QueueRef = { ns, queue: "parents" };
      const children: QueueRef = { ns, queue: "children" };
      const failure = { name: "Error", message: "broke" };
      const ofParent = flowOf({ parent: { queue: "parents", id: "p" } });

      await rig.driver.addJobs(children, [
        job({ id: "good", flow: ofParent }),
        job({
          id: "bad",
          state: "dead",
          finishedOn: T,
          failedReason: failure,
          flow: ofParent,
        }),
      ]);
      await rig.driver.addJob(
        parents,
        job({
          id: "p",
          state: "waiting-children",
          flow: flowOf({
            children: [
              { queue: "children", id: "good" },
              { queue: "children", id: "bad" },
            ],
            pending: 2,
          }),
        }),
      );

      // The stale delivery reads the child — unrecorded, still — and then,
      // before its bury lands, the original delivery buries the parent, marks
      // the child, and an operator retries the parent.
      let interleaved = false;
      rig.hooks.afterFindOne = async (_filter, options) => {
        const projection = (options?.projection ?? {}) as Document;
        if (interleaved || projection["flow.recorded"] !== 1) {
          return;
        }
        interleaved = true;
        expect(
          await rig.other.recordChild(
            parents,
            "p",
            { queue: "children", id: "bad" },
            { completed: false, ignored: false, error: failure },
            T,
          ),
        ).toBe("buried");
        expect(
          await rig.other.markChildRecorded(children, "bad", false, T),
        ).toBe(true);
        expect(await rig.other.requeueParent(parents, "p", T)).toBe(true);
      };

      const stale = await rig.driver.recordChild(
        parents,
        "p",
        { queue: "children", id: "bad" },
        { completed: false, ignored: false, error: failure },
        T + 1,
      );
      rig.hooks.afterFindOne = undefined;

      expect(interleaved).toBe(true);
      expect(stale).toBe("already");
      const retried = await rig.driver.getJob(parents, "p");
      expect(retried?.state).toBe("waiting-children");
      expect(retried?.failedReason).toBeNull();
      expect(retried?.flow?.pending).toBe(2);

      // The retried parent still completes: its good child's result releases
      // nothing yet, and the retried bad child's releases it.
      expect(
        await rig.driver.recordChild(
          parents,
          "p",
          { queue: "children", id: "good" },
          { completed: true, value: 1 },
          T + 2,
        ),
      ).toBe("recorded");
      expect(
        await rig.driver.recordChild(
          parents,
          "p",
          { queue: "children", id: "bad" },
          { completed: true, value: 2 },
          T + 3,
        ),
      ).toBe("released");
    });

    /** A parent waiting on `good` and `bad`, with `bad` dead and unrecorded. */
    async function seedFlow(driver: MongoDriver): Promise<{
      /** The parents' queue. */
      parents: QueueRef;
      /** The children's queue. */
      children: QueueRef;
    }> {
      const ns = `jd-flow-${randomUUID()}`;
      const parents: QueueRef = { ns, queue: "parents" };
      const children: QueueRef = { ns, queue: "children" };
      const ofParent = flowOf({ parent: { queue: "parents", id: "p" } });

      await driver.addJobs(children, [
        job({ id: "good", flow: ofParent }),
        job({
          id: "bad",
          state: "dead",
          finishedOn: T,
          failedReason: { name: "Error", message: "broke" },
          flow: ofParent,
        }),
      ]);
      await driver.addJob(
        parents,
        job({
          id: "p",
          state: "waiting-children",
          flow: flowOf({
            children: [
              { queue: "children", id: "good" },
              { queue: "children", id: "bad" },
            ],
            pending: 2,
          }),
        }),
      );
      return { parents, children };
    }

    /** `bad`'s failure, delivered to `p`. */
    const deliver = async (
      driver: MongoDriver,
      parents: QueueRef,
      now: number,
    ) =>
      await driver.recordChild(
        parents,
        "p",
        { queue: "children", id: "bad" },
        {
          completed: false,
          ignored: false,
          error: { name: "Error", message: "broke" },
        },
        now,
      );

    it("is refused when it lands after the child's own retry, which cleared the mark", async () => {
      const rig = await makeRig("flow-child-retry");
      const { parents, children } = await seedFlow(rig.driver);

      expect(await deliver(rig.other, parents, T)).toBe("buried");
      await rig.other.markChildRecorded(children, "bad", false, T);
      expect(await rig.other.requeueParent(parents, "p", T)).toBe(true);
      expect(await rig.other.retryJob(children, "bad", true, T)).toBe(true);
      const retriedChild = await rig.driver.getJob(children, "bad");
      expect(retriedChild?.state).toBe("waiting");
      expect(retriedChild?.flow?.recorded).toBe(false);

      // Only the child's state tells this one apart now.
      expect(await deliver(rig.driver, parents, T + 1)).toBe("already");
      expect((await rig.driver.getJob(parents, "p"))?.state).toBe(
        "waiting-children",
      );
    });

    it("still buries the parent when the child has no record at all", async () => {
      const rig = await makeRig("flow-no-record");
      const { parents, children } = await seedFlow(rig.driver);
      expect(await rig.driver.removeJob(children, "bad")).toBe(true);

      expect(await deliver(rig.driver, parents, T)).toBe("buried");
      expect((await rig.driver.getJob(parents, "p"))?.state).toBe("dead");
    });
  },
);
