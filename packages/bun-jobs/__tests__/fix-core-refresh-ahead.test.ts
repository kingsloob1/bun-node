import type { JobsDriver } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { BunQueue, MemoryDriver } from "../lib/index";
import { QueueLimiter } from "../lib/queue/limits";
import { testNamespace, waitFor } from "./helpers";

/**
 * C14: the job-defaults and limits caches read ahead of expiry in the
 * background, so a busy producer or worker never awaits the refresh — and
 * still never trusts an answer older than the refresh interval.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  setSystemTime();
  await Promise.allSettled(closers.map((close) => close()));
  closers.length = 0;
});

/** A memory driver whose queue-state reads take `ms`, counting them as they start and as they land. */
function slowStateDriver(ms: number): {
  driver: JobsDriver;
  reads: () => number;
  landed: () => number;
} {
  const driver = new MemoryDriver();
  const original = driver.getQueueState.bind(driver);
  let reads = 0;
  let landed = 0;
  driver.getQueueState = async (...args: Parameters<typeof original>) => {
    reads++;
    try {
      const entry = await original(...args);
      await Bun.sleep(ms);
      return entry;
    } finally {
      landed++;
    }
  };
  return { driver, reads: () => reads, landed: () => landed };
}

/**
 * A memory driver whose queue-state reads are held until the test releases
 * them, so when a read lands is the test's choice rather than the
 * scheduler's.
 */
function heldStateDriver(): {
  driver: JobsDriver;
  reads: () => number;
  release: () => void;
} {
  const driver = new MemoryDriver();
  const original = driver.getQueueState.bind(driver);
  const gates: (() => void)[] = [];
  let reads = 0;
  driver.getQueueState = async (...args: Parameters<typeof original>) => {
    reads++;
    const gate = Promise.withResolvers<void>();
    gates.push(gate.resolve);
    const entry = await original(...args);
    await gate.promise;
    return entry;
  };
  return {
    driver,
    reads: () => reads,
    release: () => {
      for (const open of gates.splice(0)) {
        open();
      }
    },
  };
}

/**
 * Whether `promise` settles within a few event-loop turns. A warm add with
 * the memory driver awaits nothing but microtasks, so it settles before the
 * first turn ends, however loaded the machine; an add awaiting a held read
 * never does.
 */
async function settlesUnaided(promise: Promise<unknown>): Promise<boolean> {
  const settled = promise.then(
    () => true,
    () => true,
  );
  for (let turn = 0; turn < 10; turn++) {
    const turnEnded = new Promise<false>((resolve) =>
      setImmediate(() => resolve(false)),
    );
    if (await Promise.race([settled, turnEnded])) {
      return true;
    }
  }
  return false;
}

describe("job defaults: read ahead (C14)", () => {
  it("never makes a steady stream of adds wait on the refresh", async () => {
    // The clock is the test's, and so is when each read lands: 60ms after
    // it starts, well inside the last quarter of the interval (100ms of
    // 400), so every renewal is in place before expiry. Measuring each add's
    // wall time instead counted a starved process as an awaited read, and
    // let a 60ms sleep stretch past the quarter on a loaded machine.
    const { driver, reads, release } = heldStateDriver();
    const start = Date.now();
    setSystemTime(new Date(start));
    const namespace = testNamespace();
    const queue = new BunQueue("q", {
      namespace,
      driver,
      logger: noopLogger,
      jobDefaultsRefreshInterval: 400,
    });
    closers.push(() => queue.close());

    // Nothing is cached yet, so the first add reads, and waits for it.
    const warm = queue.add("warm", {});
    expect(await settlesUnaided(warm)).toBe(false);
    release();
    await warm;
    const first = reads();

    // An add every 5ms for four intervals. A read held when an add starts
    // stays held until the add settles, so an add that awaits it never does.
    const awaited: number[] = [];
    let readStartedAt: number | undefined;
    for (let at = 5; at <= 1_600; at += 5) {
      setSystemTime(new Date(start + at));
      if (readStartedAt !== undefined && at - readStartedAt >= 60) {
        release();
        readStartedAt = undefined;
        // Let the landed read's answer reach the queue.
        await new Promise((resolve) => setImmediate(resolve));
      }

      const before = reads();
      const added = queue.add("x", {});
      if (await settlesUnaided(added)) {
        // A read this add started in the background lands 60ms on.
        if (readStartedAt === undefined && reads() > before) {
          readStartedAt = at;
        }
      } else {
        awaited.push(at);
        release();
        readStartedAt = undefined;
        await added;
      }
    }
    release();

    expect(reads() - first).toBeGreaterThanOrEqual(3);
    expect(awaited).toEqual([]);
  });

  it("still reaches a producer within the interval plus one read", async () => {
    const { driver } = slowStateDriver(5);
    const namespace = testNamespace();
    const producer = new BunQueue("q", {
      namespace,
      driver,
      logger: noopLogger,
      jobDefaultsRefreshInterval: 100,
    });
    const operator = new BunQueue("q", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(
      () => producer.close(),
      () => operator.close(),
    );

    await producer.add("warm", {});
    await operator.setJobDefaults({ attempts: 7 });
    const savedAt = Date.now();

    let seenAt: number | undefined;
    while (Date.now() - savedAt < 1_000) {
      const job = await producer.add("x", {});
      if (job.opts.attempts === 7) {
        seenAt = Date.now();
        break;
      }
      await Bun.sleep(2);
    }

    expect(seenAt).toBeDefined();
    // 100ms interval + one 5ms read, with slack for a loaded machine.
    expect(seenAt! - savedAt).toBeLessThan(250);
  });
});

describe("limits: read ahead (C14)", () => {
  // The limiter is handed the time on every call, so these hand it a clock
  // of their own: whether an answer is trusted is arithmetic on `now`, and a
  // loaded machine oversleeping a wall-clock `Bun.sleep` decided nothing
  // here but made both tests fail.

  it("renews a known-unlimited answer before it expires, without an await", async () => {
    const { driver, reads, landed } = slowStateDriver(10);
    const namespace = testNamespace();
    const queue = new BunQueue("q", { namespace, driver, logger: noopLogger });
    closers.push(() => queue.close());

    const limiter = new QueueLimiter(driver, queue.ref, "h", 30_000, 400);
    closers.push(() => limiter.close());

    const readAt = Date.now();
    expect(await limiter.reserve(1, readAt)).toBeNull();
    const first = reads();
    expect(limiter.knownUnlimited(readAt + 1)).toBe(true);
    expect(reads()).toBe(first);

    // Three quarters in (300ms of 400): still trusted, and a read starts in
    // the background rather than on the next claim's path.
    expect(limiter.knownUnlimited(readAt + 300)).toBe(true);
    expect(reads()).toBe(first + 1);
    await waitFor(() => landed() === reads());

    // Past the first read's expiry: the renewed answer is trusted, and
    // nothing else was read for it.
    expect(limiter.knownUnlimited(readAt + 450)).toBe(true);
    expect(reads()).toBe(first + 1);
    // Until it expires in turn: never trusted past the interval.
    expect(limiter.knownUnlimited(readAt + 700)).toBe(false);
  });

  it("sees limits set meanwhile within the interval", async () => {
    const { driver, reads, landed } = slowStateDriver(5);
    const namespace = testNamespace();
    const queue = new BunQueue("q", { namespace, driver, logger: noopLogger });
    closers.push(() => queue.close());

    const limiter = new QueueLimiter(driver, queue.ref, "h", 30_000, 100);
    closers.push(() => limiter.close());

    const readAt = Date.now();
    expect(await limiter.reserve(1, readAt)).toBeNull();
    await queue.setLimits({ concurrency: 1 });

    // A claim every 5ms of the limiter's time, each after every read it
    // started has landed.
    let at = readAt;
    while (limiter.knownUnlimited(at)) {
      await waitFor(() => landed() === reads());
      at += 5;
      expect(at - readAt).toBeLessThanOrEqual(1_000);
    }
    expect(at - readAt).toBeLessThanOrEqual(100);
  });
});
