import type { JobsDriver } from "../lib/index";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { ConfigError, RedisDriver, RedisKeys } from "../lib/index";
import { makeJob, testNamespace, waitFor } from "./helpers";
import { driverContract } from "./helpers/driverContract";

/**
 * The Redis driver.
 *
 * It runs the same contract as every other driver. A server is needed:
 *
 * ```bash
 * bun scripts/setup-databases.ts --only=redis
 * BUN_JOBS_TEST_REDIS_URL=redis://127.0.0.1:6379/15 bun test
 * ```
 *
 * Without that URL the suite skips, visibly.
 */

/** The server to test against, when one is configured. */
const URL = process.env.BUN_JOBS_TEST_REDIS_URL;

/** Drivers to close when the suite ends. */
const drivers: JobsDriver[] = [];

afterAll(async () => {
  await Promise.allSettled(drivers.map((driver) => driver.close()));
});

/** A driver on the configured server, tracked for cleanup. */
function makeDriver(options: { keyPrefix?: string } = {}): RedisDriver {
  const driver = new RedisDriver({ url: URL, ...options });
  drivers.push(driver);
  return driver;
}

if (URL) {
  driverContract("redis", async () => ({ driver: makeDriver() }));
} else {
  describe.skip("driver contract: redis (set BUN_JOBS_TEST_REDIS_URL)", () => {
    it("is not configured", () => {});
  });
}

describe.skipIf(!URL)("Redis driver: atomicity", () => {
  it("gives one job to exactly one claimer, however many ask at once", async () => {
    const driver = makeDriver();
    const q = { ns: testNamespace(), queue: "contested" };
    const now = Date.now();

    await driver.addJob(q, makeJob({ id: "only-one", runAt: now }));

    const claim = (index: number) =>
      driver.claimJob(q, {
        workerId: `w${index}`,
        token: `t${index}`,
        lockMs: 5000,
        now,
      });

    // A script is the unit of atomicity, so the server decides and only one
    // of these can come back with the job.
    const claims = await Promise.all(
      Array.from({ length: 10 }, (_u, i) => claim(i)),
    );

    expect(claims.filter((job) => job !== null)).toHaveLength(1);
    await driver.purge(q.ns);
  });

  it("gives one lock to exactly one holder", async () => {
    const driver = makeDriver();
    const ns = testNamespace();
    const now = Date.now();

    const acquire = (index: number) =>
      driver.acquireLock(ns, "r:contested", `token-${index}`, 5000, now);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_u, i) => acquire(i)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    await driver.purge(ns);
  });

  it("bounds queued triggers without a read-modify-write race", async () => {
    const driver = makeDriver();
    const ns = testNamespace();

    const push = (index: number) =>
      driver.pushQueuedTrigger(
        ns,
        "r:bounded",
        {
          id: `t${index}`,
          source: "manual",
          requestedAt: Date.now(),
          requestedBy: "test",
        },
        3,
      );

    const pushes = await Promise.all(
      Array.from({ length: 10 }, (_u, i) => push(i)),
    );

    expect(pushes.filter(Boolean).length).toBe(3);
    expect(await driver.countQueuedTriggers(ns, "r:bounded")).toBe(3);
    await driver.purge(ns);
  });

  it("keeps FIFO order within a priority", async () => {
    const driver = makeDriver();
    const q = { ns: testNamespace(), queue: "ordered" };
    const now = Date.now();

    // Ids that sort against insertion order, so only the sequence stored on
    // the job can produce the right answer.
    for (const id of ["zz", "mm", "aa"]) {
      await driver.addJob(q, makeJob({ id, runAt: now }));
    }

    const claimed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const job = await driver.claimJob(q, {
        workerId: "w",
        token: `t${i}`,
        lockMs: 5000,
        now,
      });
      if (job) {
        claimed.push(job.id);
      }
    }

    expect(claimed).toEqual(["zz", "mm", "aa"]);
    await driver.purge(q.ns);
  });
});

describe.skipIf(!URL)("Redis driver: waiting and events", () => {
  it("wakes on a new job rather than waiting out the timeout", async () => {
    const driver = makeDriver();
    const q = { ns: testNamespace(), queue: "waiting-room" };
    await driver.ensureQueue(q);

    const started = Date.now();
    const waiting = driver.waitForJob(q, 5000);

    await Bun.sleep(50);
    await driver.addJob(q, makeJob({ id: "arrived" }));

    await waiting;
    const elapsed = Date.now() - started;

    // Blocking, not polling: this is the capability the driver advertises.
    expect(driver.capabilities.blockingWait).toBe(true);
    expect(elapsed).toBeLessThan(2000);

    await driver.purge(q.ns);
  });

  it("delivers events to a subscriber as they are published", async () => {
    const driver = makeDriver();
    const ns = testNamespace();
    const received: string[] = [];

    const unsubscribe = await driver.subscribe(
      ns,
      "queue",
      "events",
      (event) => {
        received.push(event.type);
      },
    );

    await driver.publish({
      v: 1,
      ns,
      kind: "queue",
      target: "events",
      type: "completed",
      at: Date.now(),
      origin: "test",
    });

    await waitFor(() => received.length > 0, {
      message: "no event was delivered",
    });
    expect(received).toEqual(["completed"]);

    await unsubscribe();
    await driver.purge(ns);
  });
});

describe.skipIf(!URL)("Redis driver: scripts", () => {
  it("re-sends a script the server has forgotten", async () => {
    const driver = makeDriver();
    const q = { ns: testNamespace(), queue: "noscript" };

    await driver.addJob(q, makeJob({ id: "before" }));

    // SCRIPT FLUSH is exactly the condition EVALSHA reports as NOSCRIPT, and
    // the driver's answer is to send the source again.
    const { RedisClient } = await import("bun");
    const admin = new RedisClient(URL!);
    await admin.connect();
    await admin.send("SCRIPT", ["FLUSH"]);
    admin.close();

    await driver.addJob(q, makeJob({ id: "after" }));
    expect(await driver.getJob(q, "after")).not.toBeNull();

    await driver.purge(q.ns);
  });
});

describe("Redis driver: keys", () => {
  it("puts the namespace ahead of everything, after the prefix", () => {
    const keys = new RedisKeys({ prefix: "jobs" });

    expect(keys.namespace("account")).toBe("jobs:account");
    expect(keys.queue({ ns: "account", queue: "mail" }).wait).toBe(
      "jobs:account:q:mail:wait",
    );
    expect(keys.runner("account", "cleanup").lock).toBe(
      "jobs:account:r:cleanup:lock",
    );
    expect(keys.channel("account", "queue", "mail")).toBe(
      "jobs:account:ev:q:mail",
    );
  });

  it("hash-tags a queue's keys in cluster mode", () => {
    const keys = new RedisKeys({ prefix: "jobs", cluster: true });
    const queue = keys.queue({ ns: "account", queue: "mail" });

    // A script may only touch keys in one slot, and the tag is what puts
    // them all there.
    for (const key of Object.values(queue)) {
      expect(key).toContain("{mail}");
    }

    expect(keys.runner("account", "cleanup").state).toContain("{cleanup}");
  });

  it("hands a script its keys in the order the Lua reads them", () => {
    const keys = new RedisKeys({ prefix: "jobs" });
    const script = keys.queueScriptKeys({ ns: "account", queue: "mail" });

    expect(script).toEqual([
      "jobs:account:q:mail:wait",
      "jobs:account:q:mail:delayed",
      "jobs:account:q:mail:failed",
      "jobs:account:q:mail:active",
      "jobs:account:q:mail:completed",
      "jobs:account:q:mail:dead",
      "jobs:account:q:mail:meta",
      "jobs:account:q:mail:seq",
      "jobs:account:q:mail:wake",
      "jobs:account:queues",
    ]);
  });

  it("refuses a driver with neither a URL nor fields", () => {
    expect(() => new RedisDriver({})).toThrow(ConfigError);
  });

  it("accepts a connection as fields instead of a URL", () => {
    const driver = new RedisDriver({
      connection: { host: "cache.internal", port: 6380, database: 3 },
    });

    expect(driver.keys.prefix).toBe("bun-jobs");
  });
});
