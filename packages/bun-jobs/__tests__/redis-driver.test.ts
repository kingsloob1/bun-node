import type { JobsDriver } from "../lib/index";
import process from "node:process";
import { RedisClient as BunRedis } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import {
  EXCLUDE_CURSOR_MAX_SIGNATURES,
  EXCLUDE_HEAD_WINDOW,
  EXCLUDE_SCAN_LIMIT,
} from "../lib/drivers/redis/scripts";
import { ConfigError, RedisDriver, RedisKeys } from "../lib/index";
import { queueEvent } from "../lib/shared/events";
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

describe.skipIf(!URL)("Redis driver: excluding names", () => {
  /** Claim options for these tests, excluding the given names. */
  const options = (now: number, excludeNames: string[]) => ({
    workerId: "w",
    token: `t-${crypto.randomUUID()}`,
    lockMs: 5000,
    now,
    excludeNames,
  });

  it("matches a name exactly, whatever JSON has to escape in it", async () => {
    const driver = makeDriver();
    const q = { ns: testNamespace(), queue: "escaped" };
    const now = Date.now();

    // The script reads the name from the blob's leading string literal, so
    // these are the names that could end it early or match on a prefix.
    const tricky = ['say "hi"', "back\\slash\\", 'a\\"b', "naïve ✓"];
    for (const [index, name] of [...tricky, 'say "hi', "free"].entries()) {
      await driver.addJob(
        q,
        makeJob({ id: `e${index}`, name, runAt: now, createdAt: now + index }),
      );
    }

    const claimed = await driver.claimJobs(q, options(now, tricky), 10);
    expect(claimed.map((job) => job.name)).toEqual(['say "hi', "free"]);
    await driver.purge(q.ns);
  });

  it("reads the name of a record written before the blob", async () => {
    const driver = makeDriver();
    const q = { ns: testNamespace(), queue: "legacy" };
    const keys = driver.keys.queue(q);
    const now = Date.now();
    const raw = new BunRedis(URL);

    // The pre-blob shape: name, data, opts and maxAttempts as fields of their
    // own. Nothing migrates such a hash, so a claim must still read its name.
    for (const [seq, id, name] of [
      [1, "old-capped", "capped"],
      [2, "old-free", "free"],
    ] as const) {
      const member = `${String(seq).padStart(16, "0")}:${id}`;
      await raw.send("HSET", [
        `${keys.jobPrefix}${id}`,
        ...["member", member, "id", id, "name", name, "state", "waiting"],
        ...["priority", "0", "runAt", String(now), "createdAt", String(now)],
        ...["data", "null", "opts", "{}", "maxAttempts", "1"],
      ]);
      await raw.send("ZADD", [keys.wait, "0", member]);
    }
    raw.close();

    const job = await driver.claimJob(q, options(now, ["capped"]));
    expect(job?.id).toBe("old-free");
    expect(job?.name).toBe("free");
    await driver.purge(q.ns);
  });

  /** Adds `length` capped jobs at the head of `q`, then the given jobs. */
  const pileUp = async (
    driver: RedisDriver,
    q: { ns: string; queue: string },
    now: number,
    length: number,
    behind: string[],
  ) => {
    const cappedJob = (_u: unknown, index: number) =>
      makeJob({
        id: `c${index}`,
        name: "capped",
        runAt: now,
        createdAt: now + index,
      });
    const capped = Array.from({ length }, cappedJob);
    const free = behind.map((id) =>
      makeJob({ id, name: "free", runAt: now, createdAt: now + length }),
    );
    await driver.addJobs(q, [...capped, ...free]);
  };

  it("works through a pile longer than one scan, claiming nothing it excludes", async () => {
    const driver = makeDriver();
    const q = { ns: testNamespace(), queue: "bounded-scan" };
    const now = Date.now();
    const pile = EXCLUDE_SCAN_LIMIT * 2 + 100;
    await pileUp(driver, q, now, pile, ["free-1", "free-2", "free-3"]);

    // Each claim is still bounded, so the first comes back empty-handed...
    expect(await driver.claimJob(q, options(now, ["capped"]))).toBeNull();

    // ...but the next ones resume where it stopped rather than rereading it.
    const claimed: string[] = [];
    for (let attempt = 0; attempt < 6 && claimed.length === 0; attempt++) {
      const job = await driver.claimJob(q, options(now, ["capped"]));
      if (job) {
        claimed.push(job.id);
      }
    }
    for (let attempt = 0; attempt < 6 && claimed.length < 3; attempt++) {
      const jobs = await driver.claimJobs(q, options(now, ["capped"]), 5);
      claimed.push(...jobs.map((job) => job.id));
    }

    expect(claimed).toEqual(["free-1", "free-2", "free-3"]);
    // Nothing capped went along the way, and the head is still the head.
    expect((await driver.countJobs(q)).active).toBe(3);
    expect((await driver.claimJob(q, options(now, [])))?.id).toBe("c0");
    await driver.purge(q.ns);
  }, 60_000);

  it("resumes past its cursor when the entry it names has gone", async () => {
    const driver = makeDriver();
    const q = { ns: testNamespace(), queue: "cursor-gone" };
    const keys = driver.keys.queue(q);
    const now = Date.now();
    // Once the cursor's entry goes, the free job is the last entry a scan
    // resuming right after it can reach — and out of reach of one that
    // restarts behind the head window.
    const pile = EXCLUDE_HEAD_WINDOW + EXCLUDE_SCAN_LIMIT * 2 - 1;
    await pileUp(driver, q, now, pile, ["behind"]);

    expect(await driver.claimJob(q, options(now, ["capped"]))).toBeNull();

    const raw = new BunRedis(URL);
    const cursors = (await raw.send("HGETALL", [keys.excludeCursors])) as
      | Record<string, string>
      | string[];
    const stored = Array.isArray(cursors)
      ? cursors[1]
      : Object.values(cursors)[0];
    expect(stored).toBeString();
    const member = stored!.slice(stored!.indexOf(" ") + 1);
    expect(member).toEndWith(
      `:c${EXCLUDE_HEAD_WINDOW + EXCLUDE_SCAN_LIMIT - 1}`,
    );

    // The entry the cursor names leaves the wait set underneath it.
    expect(Number(await raw.send("ZREM", [keys.wait, member]))).toBe(1);
    raw.close();

    expect((await driver.claimJob(q, options(now, ["capped"])))?.id).toBe(
      "behind",
    );
    await driver.purge(q.ns);
  }, 60_000);

  it("keeps its cursors bounded, and out of claims that exclude nothing", async () => {
    const driver = makeDriver();
    const q = { ns: testNamespace(), queue: "cursor-bounds" };
    const keys = driver.keys.queue(q);
    const now = Date.now();
    const raw = new BunRedis(URL);
    await pileUp(
      driver,
      q,
      now,
      EXCLUDE_HEAD_WINDOW + EXCLUDE_SCAN_LIMIT + 10,
      [],
    );

    // No exclusions: the plain head read, which writes no cursor.
    await driver.claimJob(q, options(now, []));
    expect(Number(await raw.send("EXISTS", [keys.excludeCursors]))).toBe(0);

    // A hash already holding as many signatures as it keeps is cleared before
    // a new one is written, and the key always carries a TTL.
    const stale = Array.from(
      { length: EXCLUDE_CURSOR_MAX_SIGNATURES },
      (_u, index) => [`5:old-${index}`, "0 0000000000000001:x"],
    ).flat();
    await raw.send("HSET", [keys.excludeCursors, ...stale]);

    expect(await driver.claimJob(q, options(now, ["capped"]))).toBeNull();
    expect(Number(await raw.send("HLEN", [keys.excludeCursors]))).toBe(1);
    expect(
      Number(await raw.send("PTTL", [keys.excludeCursors])),
    ).toBeGreaterThan(0);

    // A drain empties the wait set, so it drops the cursors pointing into it.
    await driver.drainQueue(q, true);
    expect(Number(await raw.send("EXISTS", [keys.excludeCursors]))).toBe(0);

    raw.close();
    await driver.purge(q.ns);
  }, 60_000);
});

describe.skipIf(!URL)("Redis driver: queue state", () => {
  it("is swept by a purge and never listed as a queue", async () => {
    const driver = makeDriver();
    const ns = testNamespace();
    const q = { ns, queue: "stateful" };

    expect(await driver.setQueueState(q, "limiter", { n: 1 }, null)).toBe(1);
    // State alone does not make a queue: the queue set is its own key.
    expect(await driver.listQueues(ns)).toEqual([]);

    await driver.purge(ns);
    expect(await driver.getQueueState(q, "limiter")).toBeNull();
    // And a re-created entry starts again from the first version.
    expect(await driver.setQueueState(q, "limiter", { n: 2 }, null)).toBe(1);
    await driver.purge(ns);
  });

  it("lists names from a sorted set, bounded by prefix and after", async () => {
    const driver = makeDriver();
    const ns = testNamespace();
    const q = { ns, queue: "listed" };
    const keys = driver.keys.queue(q);

    for (const name of ["a", "b:1", "b:2", "b:3", "c"]) {
      await driver.setQueueState(q, name, {}, null);
    }
    // An update does not add the name twice; a delete removes it.
    await driver.setQueueState(q, "a", { n: 1 }, 1);
    await driver.setQueueState(q, "c", null, 1);

    const raw = new BunRedis(URL!);
    await raw.connect();
    expect(
      await raw.send("ZRANGE", [keys.stateNames, "-", "+", "BYLEX"]),
    ).toEqual(["a", "b:1", "b:2", "b:3"]);

    // An `after` below the prefix starts at the prefix, not among non-matches.
    expect(
      await driver.listQueueState(q, { prefix: "b:", after: "a", limit: 2 }),
    ).toEqual(["b:1", "b:2"]);
    // An `after` past every match lists nothing, not the names beyond it.
    expect(
      await driver.listQueueState(q, { prefix: "a", after: "a", limit: 10 }),
    ).toEqual([]);
    expect(await driver.listQueueState(q, { prefix: "b:", limit: 0 })).toEqual(
      [],
    );

    // A purge sweeps the names set with the entries.
    await driver.purge(ns);
    expect(await raw.exists(keys.stateNames)).toBe(false);
    raw.close();
  });
});

describe.skipIf(!URL)("Redis driver: read APIs", () => {
  it("finds a job by a name JSON has to escape, reading only the name", async () => {
    const driver = makeDriver();
    const q = { ns: testNamespace(), queue: "find-escaped" };
    const now = Date.now();

    // Names that end the blob's leading literal early, or swallow the quote
    // after it, if the scanner misreads a backslash.
    const names = ['say \\"hi\\" there', 'q"uote', "tail\\", "naïve ✓"];
    await driver.addJobs(
      q,
      names.map((name, index) =>
        makeJob({
          id: `n${index}`,
          name,
          createdAt: now + index,
          // A payload the name must never be read out of.
          data: { name: "decoy", note: 'x", "name": "decoy' },
        }),
      ),
    );

    const find = async (query: { search?: string; names?: string[] }) =>
      (
        await driver.findJobs(q, {
          states: ["waiting"],
          offset: 0,
          limit: 10,
          order: "asc",
          total: true,
          ...query,
        })
      ).jobs.map((job) => job.id);

    expect(await find({ search: '\\"hi\\" THERE' })).toEqual(["n0"]);
    expect(await find({ names: ['say \\"hi\\" there'] })).toEqual(["n0"]);
    expect(await find({ search: 'q"u' })).toEqual(["n1"]);
    expect(await find({ names: ["tail\\"] })).toEqual(["n2"]);
    expect(await find({ search: "NAÏVE" })).toEqual(["n3"]);
    expect(await find({ search: "decoy" })).toEqual([]);

    await driver.purge(q.ns);
  });

  it("finds a record written before the blob by its name field", async () => {
    const driver = makeDriver();
    const q = { ns: testNamespace(), queue: "find-legacy" };
    const keys = driver.keys.queue(q);
    const now = Date.now();
    const raw = new BunRedis(URL);

    const member = `${"1".padStart(16, "0")}:old`;
    await raw.send("HSET", [
      `${keys.jobPrefix}old`,
      ...[
        "member",
        member,
        "id",
        "old",
        "name",
        "legacyName",
        "state",
        "waiting",
      ],
      ...["priority", "0", "runAt", String(now), "createdAt", String(now)],
      ...["data", "null", "opts", "{}", "maxAttempts", "1"],
    ]);
    await raw.send("ZADD", [keys.wait, "0", member]);
    raw.close();

    const page = await driver.findJobs(q, {
      states: ["waiting"],
      offset: 0,
      limit: 10,
      order: "asc",
      names: ["legacyName"],
    });
    expect(page.jobs.map((job) => job.id)).toEqual(["old"]);
    await driver.purge(q.ns);
  });

  it("walks a state in chunks, in listJobs order", async () => {
    const driver = makeDriver();
    const q = { ns: testNamespace(), queue: "find-chunks" };
    const now = Date.now();

    /** Every third job is named `third`. */
    const seed = (_u: unknown, index: number) =>
      makeJob({
        id: `c${index}`,
        name: index % 3 === 0 ? "third" : "other",
        createdAt: now + index,
      });
    await driver.addJobs(q, Array.from({ length: 1_203 }, seed));

    const listed = (
      await driver.listJobs(q, ["waiting"], {
        offset: 0,
        limit: 5_000,
        order: "desc",
      })
    )
      .filter((job) => job.name === "third")
      .map((job) => job.id);

    const page = await driver.findJobs(q, {
      states: ["waiting"],
      offset: 395,
      limit: 10,
      order: "desc",
      names: ["third"],
      total: true,
    });
    expect(page.total).toBe(401);
    expect(page.jobs.map((job) => job.id)).toEqual(listed.slice(395, 405));
    await driver.purge(q.ns);
  }, 30_000);

  it("adds no key to the queue scripts, and expires each throughput minute", async () => {
    const driver = makeDriver();
    const q = { ns: testNamespace(), queue: "tp-keys" };
    const keys = driver.keys.queue(q);
    const now = Date.now();
    const minute = now - (now % 60_000);

    expect(driver.keys.queueScriptKeys(q)).toHaveLength(11);

    await driver.addJob(
      q,
      makeJob({ id: "j", createdAt: now - 1, runAt: now - 1 }),
    );
    await driver.claimJob(q, {
      workerId: "w",
      token: "t",
      lockMs: 60_000,
      now,
    });
    expect(await driver.completeJob(q, "j", "t", null, false, now)).toBe(true);

    const raw = new BunRedis(URL);
    const key = `${keys.throughputPrefix}${minute}`;
    expect(await raw.send("HGETALL", [key])).toEqual({ completed: "1" });
    const expiresAt = Number(await raw.send("PEXPIRETIME", [key]));
    expect(expiresAt).toBe(minute + 24 * 60 * 60 * 1000 + 60_000);
    raw.close();

    await driver.purge(q.ns);
  });

  it("expires the worker registry with its latest record", async () => {
    const driver = makeDriver();
    const q = { ns: testNamespace(), queue: "worker-ttl" };
    const keys = driver.keys.queue(q);
    const now = Date.now();
    const worker = {
      id: "w1",
      queue: q.queue,
      host: "h",
      pid: 1,
      concurrency: 1,
      active: 0,
      paused: false,
      startedAt: now,
      heartbeatAt: now,
      expiresAt: now + 60_000,
    };

    await driver.registerWorker(q, worker);
    await driver.registerWorker(q, {
      ...worker,
      id: "w2",
      expiresAt: now + 30_000,
    });

    // Relative, on the server's clock: twice the longest record's lifetime,
    // which the shorter record written after it does not shorten.
    const raw = new BunRedis(URL);
    for (const key of [keys.workers, keys.workersExpiry]) {
      const ttl = Number(await raw.send("PTTL", [key]));
      expect(ttl).toBeGreaterThan(110_000);
      expect(ttl).toBeLessThanOrEqual(120_000);
    }
    raw.close();

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

    await driver.publish(
      queueEvent(
        { ns, target: "events", type: "completed", origin: "test" },
        { id: "job-1", returnValue: null },
      ),
    );

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
      "jobs:account:q:mail:children",
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

describe.skipIf(!URL)(
  "Redis driver: worker registry and read shortcuts",
  () => {
    it("keeps the registry of a worker whose clock runs behind the server's", async () => {
      const driver = makeDriver();
      const q = { ns: testNamespace(), queue: "skew" };
      // Five seconds behind, with a record that lapses three seconds after its
      // report: as an absolute expiry, already past on the server.
      const behind = Date.now() - 5_000;

      await driver.registerWorker(q, {
        id: "w1",
        queue: q.queue,
        host: "h",
        pid: 1,
        concurrency: 1,
        active: 0,
        paused: false,
        startedAt: behind,
        heartbeatAt: behind,
        expiresAt: behind + 3_000,
      });

      expect(
        (await driver.listWorkers(q, behind + 10)).map((worker) => worker.id),
      ).toEqual(["w1"]);
      await driver.purge(q.ns);
    });

    it("answers an empty name filter without asking the server", async () => {
      const inner = new BunRedis(URL);
      let calls = 0;
      const counted = new Proxy(inner, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function"
            ? (...args: unknown[]) => {
                calls++;
                return (value as (...rest: unknown[]) => unknown).apply(
                  target,
                  args,
                );
              }
            : value;
        },
      });
      const driver = new RedisDriver({ url: URL, client: counted });
      drivers.push(driver);
      const q = { ns: testNamespace(), queue: "no-names" };

      await driver.addJob(q, makeJob({ id: "a" }));
      const before = calls;

      expect(
        await driver.findJobs(q, {
          states: ["waiting", "completed"],
          offset: 0,
          limit: 10,
          order: "asc",
          names: [],
          total: true,
        }),
      ).toEqual({ jobs: [], total: 0 });
      expect(calls).toBe(before);

      await driver.purge(q.ns);
      inner.close();
    });
  },
);
