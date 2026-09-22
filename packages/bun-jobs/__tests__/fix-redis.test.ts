import type { QueueRef } from "../lib/index";
import process from "node:process";
import { RedisClient as BunRedis } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import { RedisDriver } from "../lib/index";
import { makeJob, testNamespace } from "./helpers";

/**
 * Redis driver bugs from the 2026-09-22 deep check (B2, B3, B5, B6), each
 * pinned by a test that failed before its fix.
 *
 * Every test builds its own namespace and purges exactly that namespace.
 */

const URL = process.env.BUN_JOBS_TEST_REDIS_URL;

/** Cleanups to run after each test, newest first. */
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

/** A driver on the test server, closed after the test. */
function makeDriver(
  options: { client?: BunRedis; maxBlockSeconds?: number } = {},
): RedisDriver {
  const driver = new RedisDriver({
    url: URL,
    maxBlockSeconds: options.maxBlockSeconds ?? 5,
    ...(options.client ? { client: options.client } : {}),
  });
  cleanups.push(async () => await driver.close());
  return driver;
}

/** A fresh namespace, purged (exactly) after the test. */
function namespace(driver: RedisDriver, prefix: string): string {
  const ns = testNamespace(prefix);
  cleanups.push(async () => await driver.purge(ns));
  return ns;
}

/**
 * A real client behind a proxy that counts calls per method and can run a
 * hook after the next command resolves — the driver sees an ordinary client.
 */
function spyClient(): {
  client: BunRedis;
  calls: Map<string, number>;
  afterNext: (hook: () => Promise<void>) => void;
} {
  const real = new BunRedis(URL!);
  const calls = new Map<string, number>();
  let pending: (() => Promise<void>) | undefined;

  const client = new Proxy(real, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function" || typeof property !== "string") {
        return value;
      }
      return (...args: unknown[]) => {
        calls.set(property, (calls.get(property) ?? 0) + 1);
        const result = (value as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );
        const hook = pending;
        if (hook && property !== "connect" && result instanceof Promise) {
          pending = undefined;
          return result.then(async (reply: unknown) => {
            await hook();
            return reply;
          });
        }
        return result;
      };
    },
  });

  cleanups.push(async () => {
    real.close();
  });

  return {
    client,
    calls,
    afterNext: (hook) => {
      pending = hook;
    },
  };
}

/** How long `wait` takes to settle, in ms. */
async function timed(wait: Promise<unknown>): Promise<number> {
  const started = performance.now();
  await wait;
  return performance.now() - started;
}

describe.skipIf(!URL)("redis fix round: waits (B2, B3)", () => {
  it("B2: notices a wake on a second queue while the first is waiting", async () => {
    const driver = makeDriver();
    const ns = namespace(driver, "b2");
    const a: QueueRef = { ns, queue: "a" };
    const b: QueueRef = { ns, queue: "b" };
    await driver.connect();

    // A parks first, for the whole budget; nothing will ever wake it.
    const waitA = driver.waitForJob(a, 3_000);
    await Bun.sleep(50);
    const waitB = driver.waitForJob(b, 3_000);
    await Bun.sleep(100);

    const pushed = performance.now();
    await driver.addJob(b, makeJob({ id: "b1", runAt: Date.now() }));
    await waitB;
    const noticed = performance.now() - pushed;

    // Before the fix B's pop queued behind A's on the one blocking
    // connection: ~2,850ms here, and up to maxBlock in production.
    expect(noticed).toBeLessThan(500);

    // And A still waits out its own budget, undisturbed by B's token.
    await waitA;
  }, 15_000);

  it("B2: a wake on the first queue still reaches it once a second one waits", async () => {
    const driver = makeDriver();
    const ns = namespace(driver, "b2r");
    const a: QueueRef = { ns, queue: "a" };
    const b: QueueRef = { ns, queue: "b" };
    await driver.connect();

    const waitA = driver.waitForJob(a, 3_000);
    await Bun.sleep(50);
    const waitB = driver.waitForJob(b, 3_000);
    await Bun.sleep(50);

    await driver.addJob(a, makeJob({ id: "a1", runAt: Date.now() }));
    expect(await timed(waitA)).toBeLessThan(500);
    await waitB;
  }, 15_000);

  it("B2: many queues waiting at once share one blocking connection", async () => {
    const spy = spyClient();
    const driver = makeDriver({ client: spy.client });
    const ns = namespace(driver, "b2n");
    await driver.connect();

    const queues = Array.from({ length: 8 }, (_u, i) => ({
      ns,
      queue: `q${i}`,
    }));
    const waits = queues.map((q) => driver.waitForJob(q, 3_000));
    await Bun.sleep(100);

    // Wake the last one: it must not wait behind the other seven.
    const last = queues.at(-1)!;
    await driver.addJob(last, makeJob({ id: "x", runAt: Date.now() }));
    expect(await timed(waits.at(-1)!)).toBeLessThan(500);

    expect(spy.calls.get("duplicate") ?? 0).toBe(1);
    await Promise.all(waits);
  }, 15_000);

  it("B3: two concurrent first waits open one blocking connection, not two", async () => {
    const spy = spyClient();
    const driver = makeDriver({ client: spy.client });
    const ns = namespace(driver, "b3");
    await driver.connect();

    // Both reach the lazily-made connection in the same tick.
    await Promise.all([
      driver.waitForJob({ ns, queue: "a" }, 100),
      driver.waitForJob({ ns, queue: "b" }, 100),
    ]);

    // Before the fix the second `duplicate()` overwrote the first, which
    // was never closed.
    expect(spy.calls.get("duplicate") ?? 0).toBe(1);
  }, 10_000);

  it("B3: two concurrent first subscriptions open one pub/sub connection", async () => {
    const spy = spyClient();
    const driver = makeDriver({ client: spy.client });
    const ns = namespace(driver, "b3s");
    await driver.connect();

    const offs = await Promise.all([
      driver.subscribe(ns, "queue", "a", () => {}),
      driver.subscribe(ns, "queue", "b", () => {}),
    ]);

    expect(spy.calls.get("duplicate") ?? 0).toBe(1);
    await Promise.all(offs.map(async (off) => await off()));
  }, 10_000);
});

describe.skipIf(!URL)("redis fix round: wake tokens (B5)", () => {
  /** Two idle consumers, each on a driver of its own (as two processes are). */
  async function twoIdleConsumers(ns: string, queue: string) {
    const first = makeDriver();
    const second = makeDriver();
    await Promise.all([first.connect(), second.connect()]);

    const q: QueueRef = { ns, queue };
    const waits = [first.waitForJob(q, 4_000), second.waitForJob(q, 4_000)];
    const started = performance.now();
    const settled = waits.map(async (wait) => {
      await wait;
      return performance.now() - started;
    });
    // Both parked before anything is made ready.
    await Bun.sleep(100);
    return { q, settled };
  }

  it("B5: a bulk add wakes as many idle consumers as it made jobs ready", async () => {
    const producer = makeDriver();
    const ns = namespace(producer, "b5a");
    const { q, settled } = await twoIdleConsumers(ns, "bulk");

    const now = Date.now();
    await producer.addJobs(q, [
      makeJob({ id: "j1", runAt: now }),
      makeJob({ id: "j2", runAt: now }),
    ]);

    // Before the fix one token went out for the batch, so the second consumer
    // slept out its whole wait (~4,000ms).
    for (const took of await Promise.all(settled)) {
      expect(took).toBeLessThan(1_000);
    }
  }, 15_000);

  it("B5: a promotion burst wakes as many idle consumers as it promoted", async () => {
    const producer = makeDriver();
    const ns = namespace(producer, "b5p");
    const q: QueueRef = { ns, queue: "promote" };
    const now = Date.now();
    await producer.addJobs(q, [
      makeJob({ id: "d1", state: "delayed", runAt: now + 50 }),
      makeJob({ id: "d2", state: "delayed", runAt: now + 50 }),
    ]);

    const { settled } = await twoIdleConsumers(ns, "promote");
    expect(await producer.promoteDelayed(q, now + 100, 100)).toBe(2);

    for (const took of await Promise.all(settled)) {
      expect(took).toBeLessThan(1_000);
    }
  }, 15_000);

  it("B5: recovering stalled jobs wakes as many idle consumers as it requeued", async () => {
    const producer = makeDriver();
    const ns = namespace(producer, "b5r");
    const q: QueueRef = { ns, queue: "stall" };
    const now = Date.now();
    await producer.addJobs(q, [
      makeJob({ id: "s1", runAt: now }),
      makeJob({ id: "s2", runAt: now }),
    ]);
    await producer.claimJobs(
      q,
      { workerId: "gone", token: "t", lockMs: 10, now },
      2,
    );
    // Drop the tokens the add sent, so only the recovery's can wake anyone.
    const raw = new BunRedis(URL!);
    cleanups.push(async () => raw.close());
    await raw.del(producer.keys.queue(q).wake);

    const { settled } = await twoIdleConsumers(ns, "stall");
    const recovered = await producer.recoverStalled(q, now + 1_000, 5, 100);
    expect(recovered.requeued).toHaveLength(2);

    for (const took of await Promise.all(settled)) {
      expect(took).toBeLessThan(1_000);
    }
  }, 15_000);

  it("B5: pushes one token per ready job, capped at the wake list's length", async () => {
    const driver = makeDriver();
    const ns = namespace(driver, "b5c");
    const q: QueueRef = { ns, queue: "cap" };
    const wake = driver.keys.queue(q).wake;
    const raw = new BunRedis(URL!);
    cleanups.push(async () => raw.close());

    const now = Date.now();
    const jobs = (prefix: string, count: number) =>
      Array.from({ length: count }, (_u, i) => `${prefix}${i}`).map((id) =>
        makeJob({ id, runAt: now }),
      );
    await driver.addJobs(q, jobs("c", 3));
    expect(await raw.llen(wake)).toBe(3);

    await driver.addJobs(q, jobs("m", 150));
    expect(await raw.llen(wake)).toBe(100);
  }, 15_000);
});

describe.skipIf(!URL)("redis fix round: updateProgress (B6)", () => {
  it("B6: a job removed mid-update is not resurrected as an orphan hash", async () => {
    const spy = spyClient();
    const driver = makeDriver({ client: spy.client });
    const other = makeDriver();
    const ns = namespace(driver, "b6");
    const q: QueueRef = { ns, queue: "progress" };
    const key = `${driver.keys.queue(q).jobPrefix}p1`;
    const raw = new BunRedis(URL!);
    cleanups.push(async () => raw.close());

    await driver.addJob(q, makeJob({ id: "p1", runAt: Date.now() }));

    // Between the first command `updateProgress` sends and whatever it sends
    // next, another client removes the job — the window the old EXISTS-then-
    // HSET left open. Atomic, there is no "next".
    spy.afterNext(async () => {
      await other.removeJob(q, "p1");
    });
    await driver.updateProgress(q, "p1", { pct: 50 });

    // Before the fix: a one-field `{progress}` hash, in no set, with no TTL.
    expect(await raw.exists(key)).toBe(false);
    expect(await driver.getJob(q, "p1")).toBeNull();
  }, 10_000);

  it("B6: still updates a job that exists, and refuses one that does not", async () => {
    const driver = makeDriver();
    const ns = namespace(driver, "b6b");
    const q: QueueRef = { ns, queue: "progress" };

    await driver.addJob(q, makeJob({ id: "p1", runAt: Date.now() }));
    expect(await driver.updateProgress(q, "p1", { pct: 10 })).toBe(true);
    expect((await driver.getJob(q, "p1"))?.progress).toEqual({ pct: 10 });

    expect(await driver.updateProgress(q, "missing", 1)).toBe(false);
    const raw = new BunRedis(URL!);
    cleanups.push(async () => raw.close());
    expect(await raw.exists(`${driver.keys.queue(q).jobPrefix}missing`)).toBe(
      false,
    );
  }, 10_000);
});

describe.skipIf(!URL)("redis fix round: completeJobs (batch)", () => {
  it("completes a burst in one script, reporting only the jobs it still held", async () => {
    const spy = spyClient();
    const driver = makeDriver({ client: spy.client });
    const ns = namespace(driver, "cj");
    const q: QueueRef = { ns, queue: "batch" };
    const now = Date.now();
    await driver.addJobs(
      q,
      ["k1", "k2", "r1", "lost"].map((id) => makeJob({ id, runAt: now })),
    );
    await driver.claimJobs(
      q,
      { workerId: "w", token: "t", lockMs: 60_000, now },
      3,
    );
    await driver.claimJob(q, {
      workerId: "x",
      token: "other",
      lockMs: 60_000,
      now,
    });

    const scripts = () =>
      (spy.calls.get("evalsha") ?? 0) + (spy.calls.get("eval") ?? 0);
    const before = scripts();
    const done = await driver.completeJobs(
      q,
      "t",
      [
        { id: "k1", result: { v: 1 }, retention: false },
        { id: "k2", result: 2, retention: { ttl: 60_000 } },
        { id: "r1", result: null, retention: true },
        { id: "lost", result: 3, retention: false },
      ],
      now,
    );

    expect(done.sort()).toEqual(["k1", "k2", "r1"]);
    // One script for the burst.
    expect(scripts() - before).toBe(1);

    const k1 = await driver.getJob(q, "k1");
    expect(k1).toMatchObject({
      state: "completed",
      returnValue: { v: 1 },
      lockToken: null,
    });
    expect((await driver.getJob(q, "k2"))?.expiresAt).toBe(now + 60_000);
    expect(await driver.getJob(q, "r1")).toBeNull();
    expect((await driver.getJob(q, "lost"))?.state).toBe("active");

    const minute = now - (now % 60_000);
    expect(await driver.getThroughput(q, { from: minute, to: minute })).toEqual(
      [{ at: minute, completed: 3, failed: 0 }],
    );
  }, 10_000);
});

describe.skipIf(!URL)("redis fix round: block bounds (B2 follow-up)", () => {
  /** A spy whose `send("BLPOP", …)` block times are recorded, in seconds. */
  function blockSpy() {
    const blocks: number[] = [];
    const real = new BunRedis(URL!);
    const wrap = (target: BunRedis): BunRedis =>
      new Proxy(target, {
        get(inner, property, receiver) {
          const value = Reflect.get(inner, property, receiver) as unknown;
          if (typeof value !== "function") {
            return value;
          }
          if (property === "duplicate") {
            return async () =>
              wrap(
                (await (value as () => Promise<BunRedis>).call(
                  inner,
                )) as BunRedis,
              );
          }
          return (...args: unknown[]) => {
            if (
              property === "send" &&
              String(args[0]).toUpperCase() === "BLPOP"
            ) {
              const list = args[1] as string[];
              blocks.push(Number(list.at(-1)));
            }
            return (value as (...a: unknown[]) => unknown).apply(inner, args);
          };
        },
      });
    cleanups.push(async () => real.close());
    return { client: wrap(real), blocks };
  }

  it("ends a wait at maxBlockSeconds, however long the caller asked for", async () => {
    const driver = makeDriver({ maxBlockSeconds: 0.25 });
    const ns = namespace(driver, "mb");
    await driver.connect();

    // Before the fix the shared pop ignored the driver's bound: ~5,000ms.
    expect(
      await timed(driver.waitForJob({ ns, queue: "q" }, 10_000)),
    ).toBeLessThan(1_000);
  }, 15_000);

  it("never blocks longer than maxBlockSeconds or the longest waiter's time left", async () => {
    const spy = blockSpy();
    const driver = makeDriver({ client: spy.client, maxBlockSeconds: 2 });
    const ns = namespace(driver, "mb2");
    await driver.connect();

    await driver.waitForJob({ ns, queue: "short" }, 300);
    await driver.waitForJob({ ns, queue: "long" }, 10_000);

    expect(spy.blocks.length).toBeGreaterThanOrEqual(2);
    expect(spy.blocks[0]!).toBeLessThanOrEqual(0.3);
    expect(Math.max(...spy.blocks)).toBeLessThanOrEqual(2);
  }, 15_000);

  it("releases a shorter waiter joining a parked pop on its own time", async () => {
    const driver = makeDriver({ maxBlockSeconds: 5 });
    const ns = namespace(driver, "mb3");
    const q: QueueRef = { ns, queue: "q" };
    await driver.connect();

    const long = driver.waitForJob(q, 3_000);
    await Bun.sleep(50);
    const short = await timed(driver.waitForJob(q, 200));
    expect(short).toBeGreaterThanOrEqual(150);
    expect(short).toBeLessThan(600);
    await long;
  }, 15_000);
});
