import type { JobRecord, JobsDriver } from "../lib/index";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import {
  FRESH_JOB_FIELD_COUNT,
  JOB_FIELDS,
} from "../lib/drivers/redis/scripts";
import { RedisDriver } from "../lib/index";
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

afterAll(async () => {
  await Promise.allSettled(drivers.map((driver) => driver.close()));
});

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
      "name",
      "state",
      "priority",
      "runAt",
      "createdAt",
      "maxAttempts",
      "data",
      "opts",
    ]);
  });

  it.skipIf(!URL)("round-trips every field through addJob", async () => {
    const driver = new RedisDriver({ url: URL });
    drivers.push(driver);
    const q = { ns: testNamespace(), queue: "fields" };
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
    const q = { ns: testNamespace(), queue: "fields" };
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
      const q = { ns: testNamespace(), queue: "fields" };
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

  it.skipIf(!URL)("places a record by the state it arrived with", async () => {
    const driver = new RedisDriver({ url: URL });
    drivers.push(driver);
    const q = { ns: testNamespace(), queue: "placed" };
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
