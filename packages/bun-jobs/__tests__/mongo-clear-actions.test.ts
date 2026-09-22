import type { MongoClient } from "mongodb";
import type { MongoClientLike } from "../lib/drivers/mongo/mongo-driver";
import type { QueueRef } from "../lib/index";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { MongoDriver } from "../lib/drivers/mongo/mongo-driver";
import { makeJob, testNamespace } from "./helpers";

/**
 * `clearJobLogs` on the MongoDB driver, beyond the shared contract
 * ("clearing a job's log"): what the contract, which only ever calls one
 * method at a time, cannot see.
 *
 * - **The active refusal is the write's own filter.** A claim landing the
 *   instant before the clear's write makes the clear answer `active` and
 *   remove nothing — a clear that read the state first and wrote after would
 *   empty a running job's log. The claim is injected at the write itself, so
 *   the case does not depend on timing.
 * - **The key is rotated, not just emptied.** A line an append wrote under
 *   the old key after the clear's delete is counted by no read, and the
 *   maintenance sweep removes it: nothing leaks.
 *
 * ```bash
 * BUN_JOBS_TEST_MONGODB_URL=mongodb://127.0.0.1:27017/bun_jobs_test bun test
 * ```
 *
 * On the default collections, in namespaces of its own, each purged by name.
 */

/** The server to test against, when one is configured. */
const URL = process.env.BUN_JOBS_TEST_MONGODB_URL;

/** The whole log, oldest first. */
const ALL = { offset: 0, limit: 1000, order: "asc" } as const;

/** A fixed instant the cases build around. */
const T = 1_700_000_000_000;

/** The one real client, shared by every driver here. */
let client: MongoClient | undefined;
/** Drivers to close when the suite ends. */
const drivers: MongoDriver[] = [];
/** The exact namespaces this run created, to purge — never a prefix sweep. */
const namespaces = new Set<string>();

afterAll(async () => {
  const [driver] = drivers;
  if (driver) {
    for (const ns of namespaces) {
      await driver.purge(ns).catch(() => undefined);
    }
  }
  await Promise.allSettled(drivers.map((driver) => driver.close()));
  await client?.close();
});

/** The shared client, connected on first use. */
async function realClient(): Promise<MongoClient> {
  if (!client) {
    const { MongoClient } = await import("mongodb");
    client = new MongoClient(URL!);
    await client.connect();
  }
  return client;
}

/** A queue in a namespace of this case's own, purged by name at the end. */
function scope(name: string): QueueRef {
  const ns = testNamespace(`mclear-${name}`);
  namespaces.add(ns);
  return { ns, queue: "logs" };
}

/**
 * Work to run once, immediately before the driver's next write that unsets a
 * job's `logKey` — the clear's write — and then never again.
 */
interface WriteHook {
  /** The pending work, or `undefined` once it has run. */
  before?: () => Promise<void>;
}

/** Whether an update document unsets `logKey`. */
function unsetsLogKey(update: unknown): boolean {
  const unset = (update as { $unset?: Record<string, unknown> } | null)?.$unset;
  return unset !== undefined && "logKey" in unset;
}

/**
 * A driver whose jobs collection runs `hook.before` ahead of the clear's
 * write. Everything else passes straight to the real client.
 */
async function hookedDriver(hook: WriteHook): Promise<MongoDriver> {
  const real = await realClient();
  let jobsName = "";

  /** The collection, with `findOneAndUpdate` intercepted on the jobs one. */
  const wrapCollection = (name: string, collection: object): object =>
    name !== jobsName
      ? collection
      : new Proxy(collection, {
          get(target, property, receiver) {
            const value: unknown = Reflect.get(target, property, receiver);
            if (
              property !== "findOneAndUpdate" ||
              typeof value !== "function"
            ) {
              return value;
            }
            return async (...args: unknown[]) => {
              const work = hook.before;
              if (work && unsetsLogKey(args[1])) {
                hook.before = undefined;
                await work();
              }
              return await (
                value as (...a: unknown[]) => Promise<unknown>
              ).apply(target, args);
            };
          },
        });

  const proxied = new Proxy(real, {
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
                return (name: string, ...rest: unknown[]) =>
                  wrapCollection(
                    name,
                    (member as (...a: unknown[]) => object).call(
                      dbTarget,
                      name,
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
  });
  jobsName = driver.collections.jobs;
  drivers.push(driver);
  return driver;
}

describe.skipIf(!URL)("MongoDriver clearJobLogs", () => {
  it("answers active, removing nothing, for a job claimed just before the clear's write", async () => {
    const hook: WriteHook = {};
    const driver = await hookedDriver(hook);
    const q = scope("race");

    await driver.addJob(q, makeJob({ id: "busy", runAt: T }));
    await driver.addJobLog(q, "busy", "started", 0);
    await driver.addJobLog(q, "busy", "working", 0);

    // A worker claims the job between anything the clear read and its write.
    hook.before = async () => {
      const claimed = await driver.claimJob(q, {
        workerId: "w",
        token: crypto.randomUUID(),
        lockMs: 60_000,
        now: Date.now(),
      });
      expect(claimed?.id).toBe("busy");
    };

    expect(await driver.clearJobLogs(q, "busy")).toEqual({ status: "active" });
    expect(hook.before).toBeUndefined();
    expect(await driver.getJobLogs(q, "busy", ALL)).toEqual({
      logs: ["started", "working"],
      count: 2,
    });
    // And the running job keeps logging under the key it had.
    expect(await driver.addJobLog(q, "busy", "still going", 0)).toBe(3);
  });

  it("never counts a line written under the old key after the clear, and the sweep removes it", async () => {
    const driver = await hookedDriver({});
    const q = scope("rotate");
    const db = (await realClient()).db();
    const jobs = db.collection<{ _id: string; logKey?: string }>(
      driver.collections.jobs,
    );
    const logs = db.collection(driver.collections.jobLogs);

    await driver.addJob(q, makeJob({ id: "job", runAt: T }));
    await driver.addJobLog(q, "job", "old", 0);
    const oldKey = (await jobs.findOne({ _id: `${q.ns}:${q.queue}:job` }))
      ?.logKey;
    expect(typeof oldKey).toBe("string");

    expect(await driver.clearJobLogs(q, "job")).toEqual({
      status: "cleared",
      removed: 1,
    });

    // An append that read the job's key before the clear, landing after it.
    await logs.insertOne({
      ns: q.ns,
      queue: q.queue,
      logKey: oldKey,
      jobId: "job",
      seq: Date.now() * 1024,
      line: "straggler",
    });

    expect(await driver.addJobLog(q, "job", "new", 0)).toBe(1);
    expect(await driver.getJobLogs(q, "job", ALL)).toEqual({
      logs: ["new"],
      count: 1,
    });

    // The maintenance tick's sweep finds it keyed to no job, and removes it.
    await driver.pruneExpired(q, Date.now(), 100);
    expect(
      await logs.countDocuments({ ns: q.ns, queue: q.queue, logKey: oldKey }),
    ).toBe(0);
    expect(await driver.getJobLogs(q, "job", ALL)).toEqual({
      logs: ["new"],
      count: 1,
    });
  });
});
