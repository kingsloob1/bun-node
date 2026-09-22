import type { JobRecord, JobsDriver } from "../lib/index";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import {
  FRESH_JOB_FIELD_COUNT,
  JOB_FIELDS,
} from "../lib/drivers/redis/scripts";
import { RedisDriver, RedisKeys } from "../lib/index";
import { makeJob, testNamespace } from "./helpers";

/**
 * The wire format the add scripts take.
 *
 * ARGV carries a job's **values only**, in `JOB_FIELDS` order, and the script
 * pairs them with names from a constant Lua table generated from that same
 * constant. That halves the ARGV entries — the Lua VM interns every one of
 * them — but it means position *is* the contract: a value added to the driver
 * and not to `JOB_FIELDS`, or either list reordered, would silently write
 * every field one slot out.
 *
 * Nothing else covers it. A brand-new job stops at `FRESH_JOB_FIELD_COUNT`, so
 * the ordinary tests only ever exercise the first nine positions; these send a
 * record with every field populated and distinct, and read it back.
 */

/** The server to test against, when one is configured. */
const URL = process.env.BUN_JOBS_TEST_REDIS_URL;

/** Drivers to close when the suite ends. */
const drivers: JobsDriver[] = [];

/**
 * The exact namespaces this file created, purged by name when the suite ends —
 * never a prefix sweep: other sessions share that server.
 */
const namespaces: string[] = [];

afterAll(async () => {
  // The drivers first, so nothing they still buffer is written back after
  // the purge.
  await Promise.allSettled(drivers.map((driver) => driver.close()));

  if (URL && namespaces.length > 0) {
    const janitor = new RedisDriver({ url: URL });

    try {
      for (const ns of namespaces.splice(0)) {
        await janitor.purge(ns).catch(() => undefined);
      }
    } finally {
      await janitor.close();
    }
  }
});

/** A queue in a namespace of its own, remembered so it is purged afterwards. */
function scope(queue: string): { ns: string; queue: string } {
  const ns = testNamespace();
  namespaces.push(ns);
  return { ns, queue };
}

/**
 * A record with every field set to something distinct and non-default.
 *
 * Distinct on purpose: two fields sharing a value would let a swap between
 * them pass.
 */
function fullyPopulated(id: string): JobRecord {
  return makeJob({
    id,
    name: "populated",
    data: { which: "data" },
    state: "completed",
    priority: 7,
    runAt: 1_700_000_001_000,
    createdAt: 1_700_000_002_000,
    processedOn: 1_700_000_003_000,
    finishedOn: 1_700_000_004_000,
    expiresAt: 1_700_000_005_000,
    attemptsMade: 3,
    maxAttempts: 9,
    stalledCount: 2,
    progress: { which: "progress" },
    returnValue: { which: "returnValue" },
    failedReason: { name: "Error", message: "failedReason" },
    stacktrace: [{ name: "Error", message: "stacktrace" }],
    lockToken: "token-value",
    lockExpiresAt: 1_700_000_006_000,
    workerId: "worker-value",
    repeatKey: "repeat-value",
    flow: {
      parent: { queue: "parent.queue", id: "parent-id" },
      children: [{ queue: "child-queue", id: "child-id" }],
      pending: 4,
      // Keys with dots and colons, and values a cjson round trip would change:
      // an empty array, and an integer past double-safe precision as a string.
      values: { "q.one:a:b": [], "q:$two": { big: "12345678901234567890" } },
      failures: { "q:failed": { name: "Error", message: "ignored" } },
      recorded: true,
    },
  });
}

describe("Redis add scripts: the positional wire format", () => {
  it("sends a value for every field it names", () => {
    // The Lua table is generated from JOB_FIELDS, so the only way the two can
    // disagree is if the driver stops building values in that order.
    expect(JOB_FIELDS.length).toBe(22);
    expect(FRESH_JOB_FIELD_COUNT).toBeLessThan(JOB_FIELDS.length);

    // The fresh set has to be a *prefix* of the full one — that is what lets
    // the script use a single name table and read `state`, `priority` and
    // `runAt` at positions both shapes share.
    expect(JOB_FIELDS.slice(0, FRESH_JOB_FIELD_COUNT)).toEqual([
      "id",
      "state",
      "priority",
      "runAt",
      "createdAt",
      "blob",
    ]);

    // The four inside `blob` must not also be named on their own: two places
    // to write one value is two places for them to disagree.
    for (const folded of ["name", "maxAttempts", "data", "opts"]) {
      expect(JOB_FIELDS).not.toContain(folded);
    }
  });

  it.skipIf(!URL)("round-trips every field through addJob", async () => {
    const driver = new RedisDriver({ url: URL });
    drivers.push(driver);
    const q = scope("fields");
    await driver.ensureQueue(q);

    const job = fullyPopulated("single");
    const { added } = await driver.addJob(q, job);
    expect(added).toBe(true);

    const stored = await driver.getJob(q, "single");
    expect(stored).toEqual(job);
  });

  it.skipIf(!URL)("round-trips every field through addJobs", async () => {
    const driver = new RedisDriver({ url: URL });
    drivers.push(driver);
    const q = scope("fields");
    await driver.ensureQueue(q);

    // Two at once, so the batch path's per-job cursor arithmetic is exercised:
    // a miscounted stride would corrupt the second and leave the first intact.
    const first = fullyPopulated("batch-1");
    const second = fullyPopulated("batch-2");
    const results = await driver.addJobs(q, [first, second]);
    expect(results.map((r) => r.added)).toEqual([true, true]);

    expect(await driver.getJob(q, "batch-1")).toEqual(first);
    expect(await driver.getJob(q, "batch-2")).toEqual(second);
  });

  it.skipIf(!URL)(
    "mixes fresh and populated records in one batch",
    async () => {
      const driver = new RedisDriver({ url: URL });
      drivers.push(driver);
      const q = scope("fields");
      await driver.ensureQueue(q);

      // The stride differs per job — nine values then twenty-two — so a batch
      // that mixes them is the case a fixed stride would get wrong.
      const fresh = makeJob({ id: "mixed-fresh" });
      const full = fullyPopulated("mixed-full");
      const after = makeJob({ id: "mixed-after" });

      const results = await driver.addJobs(q, [fresh, full, after]);
      expect(results.map((r) => r.added)).toEqual([true, true, true]);

      expect(await driver.getJob(q, "mixed-fresh")).toEqual(fresh);
      expect(await driver.getJob(q, "mixed-full")).toEqual(full);
      expect(await driver.getJob(q, "mixed-after")).toEqual(after);
    },
  );

  it.skipIf(!URL)("reads a hash written before `blob` existed", async () => {
    const driver = new RedisDriver({ url: URL });
    drivers.push(driver);
    const q = scope("legacy");
    await driver.ensureQueue(q);

    // Nothing rewrites a hash in place, so an upgraded deployment's jobs still
    // have `name`, `maxAttempts`, `data` and `opts` as four separate fields.
    // They have to read back exactly as a `blob` record does.
    const client = new Bun.RedisClient(URL!);

    try {
      const key = `${new RedisKeys({}).queue(q).jobPrefix}legacy-1`;
      await client.send("HSET", [
        key,
        "id",

        "legacy-1",
        "name",

        "from-before",
        "state",

        "waiting",
        "priority",

        "3",
        "runAt",

        "1700000001000",
        "createdAt",

        "1700000002000",
        "maxAttempts",

        "7",
        "data",

        JSON.stringify({ which: "data" }),
        "opts",

        JSON.stringify({ attempts: 7 }),
        "member",

        "0000000000000001:legacy-1",
      ]);

      const stored = await driver.getJob(q, "legacy-1");
      expect(stored?.name).toBe("from-before");
      expect(stored?.maxAttempts).toBe(7);
      expect(stored?.data).toEqual({ which: "data" });
      expect(stored?.opts).toEqual({ attempts: 7 } as never);
      expect(stored?.priority).toBe(3);
    } finally {
      client.close();
    }
  });

  it.skipIf(!URL)("places a record by the state it arrived with", async () => {
    const driver = new RedisDriver({ url: URL });
    drivers.push(driver);
    const q = scope("placed");
    await driver.ensureQueue(q);

    // The script now reads `state` out of ARGV rather than reading back the
    // hash it just wrote, so this is what proves it reads the right slot.
    await driver.addJobs(q, [
      makeJob({ id: "is-waiting" }),
      fullyPopulated("is-completed"),
      makeJob({
        id: "is-delayed",
        state: "delayed",
        runAt: Date.now() + 60_000,
      }),
    ]);

    const counts = await driver.countJobs(q);
    expect(counts.waiting).toBe(1);
    expect(counts.completed).toBe(1);
    expect(counts.delayed).toBe(1);
  });
});
