import type { JobsDriver } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  ConfigError,
  MemoryDriver,
} from "../lib/index";
import { LIMITER_STATE, LIMITS_STATE, QueueLimiter } from "../lib/queue/limits";
import { testNamespace, waitFor } from "./helpers";

/**
 * Cluster-wide limits, stored on the queue and enforced by every worker.
 *
 * Several workers share one driver here, which is what several processes
 * sharing a backend reduce to: every worker reads and writes the same stored
 * counters, and none of them can see another's memory.
 */

/** What the test jobs carry. */
interface Work {
  /** How long the processor takes, in milliseconds. */
  ms?: number;
}

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  // First, so a failed test can never leave the clock frozen for the next.
  setSystemTime();
  await Promise.allSettled(closers.map((close) => close()));
  closers.length = 0;
});

/**
 * Waits for `predicate` by the real clock, never `Date.now()`.
 *
 * For the tests that freeze `Date.now()` with `setSystemTime`: `waitFor`
 * measures its deadline with `Date.now()`, so under a frozen clock it would
 * never time out and a failure would surface as the test's own timeout with
 * no message.
 */
async function until(
  predicate: () => boolean,
  message: () => string,
  timeout = 5_000,
): Promise<void> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(2);
  }
  throw new Error(message());
}

/**
 * How long a frozen window is watched for anything more starting: several of
 * the workers' passes (`maxBlock` 20ms, `pollInterval` 5ms), so a limiter that
 * would admit one more has every chance to show it. Only ever a wait for
 * nothing to happen — no assertion depends on something finishing within it.
 */
const HOLD_MS = 80;

/**
 * Freezes `Date.now()` in the middle of a window, so no boundary can pass
 * except when the test moves the clock. Answers the frozen time.
 */
function freezeMidWindow(window: number): number {
  const at = Math.ceil(Date.now() / window) * window + window / 2;
  setSystemTime(new Date(at));
  return at;
}

/** A queue and a way to start workers on it, sharing one driver. */
function setup() {
  const driver: JobsDriver = new MemoryDriver();
  const namespace = testNamespace();
  const queue = new BunQueue<Work>("limited", {
    namespace,
    driver,
    logger: noopLogger,
  });
  closers.push(() => queue.close());

  /** Everything observed about running jobs. */
  const seen = {
    running: 0,
    peak: 0,
    runningByName: new Map<string, number>(),
    peakByName: new Map<string, number>(),
    starts: [] as { name: string; at: number }[],
    finished: [] as string[],
  };

  /** Starts a worker that records what runs. */
  function worker(concurrency: number) {
    const instance = new BunQueueWorker<Work>(
      "limited",
      async (job) => {
        seen.running++;
        seen.peak = Math.max(seen.peak, seen.running);
        const byName = (seen.runningByName.get(job.name) ?? 0) + 1;
        seen.runningByName.set(job.name, byName);
        seen.peakByName.set(
          job.name,
          Math.max(seen.peakByName.get(job.name) ?? 0, byName),
        );
        seen.starts.push({ name: job.name, at: Date.now() });

        await Bun.sleep(job.data.ms ?? 5);

        seen.running--;
        seen.runningByName.set(job.name, byName - 1);
        seen.finished.push(job.name);
        return null;
      },
      {
        namespace,
        driver,
        logger: noopLogger,
        concurrency,
        pollInterval: 5,
        maxBlock: 20,
        limitsRefreshInterval: 20,
      },
    );
    closers.push(() => instance.close({ force: true }));
    void instance.run();
    return instance;
  }

  return { driver, namespace, queue, seen, worker };
}

describe("queue limits: storage", () => {
  it("stores limits, reads them back with durations in milliseconds, and removes them", async () => {
    const { queue } = setup();

    expect(await queue.getLimits()).toBeNull();

    await queue.setLimits({
      rate: { max: 100, duration: "1 minute" },
      concurrency: 20,
      names: {
        sendEmail: { concurrency: 5, rate: { max: 10, duration: 1000 } },
      },
    });

    expect(await queue.getLimits()).toEqual({
      rate: { max: 100, duration: 60_000 },
      concurrency: 20,
      names: {
        sendEmail: { concurrency: 5, rate: { max: 10, duration: 1000 } },
      },
    });

    await queue.setLimits(null);
    expect(await queue.getLimits()).toBeNull();
    // Removing what is not there is not an error.
    await queue.setLimits(null);
  });

  it("refuses limits that make no sense", async () => {
    const { queue } = setup();

    for (const bad of [
      { concurrency: 0 },
      { concurrency: 1.5 },
      { rate: { max: 0, duration: 1000 } },
      { rate: { max: 5, duration: 0 } },
      { rate: { max: 5, duration: "whenever" } },
      { names: { mail: { concurrency: -1 } } },
    ]) {
      await expect(queue.setLimits(bad)).rejects.toThrow(ConfigError);
    }

    expect(await queue.getLimits()).toBeNull();
  });
});

describe("queue limits: releases", () => {
  /**
   * A job that finishes while a limiter write is in flight must still be taken
   * off the count.
   *
   * `release()` notes a finished job on the pending object in place, and the
   * write that was already carrying that object used to forget everything on
   * it once it landed — including releases noted after it was read. With a
   * worker writing the counters on every claim pass, most completions land in
   * that window, so a name's count only ever grew: after enough jobs it read
   * as full with nothing running, and its jobs waited forever. No error, on
   * every driver, with a single worker.
   */
  it("counts every finished job back, however the writes interleave", async () => {
    const { driver, namespace, queue } = setup();
    await queue.setLimits({ names: { capped: { concurrency: 2 } } });

    // A round trip's worth of latency on the counter writes, as any networked
    // backend has. The memory driver answers in the same tick, which leaves no
    // window for a job to finish while a write is in flight — and so hides
    // exactly the interleaving this is about. Reads stay instant: a slower
    // read only moves the window, it does not widen it.
    const setQueueState = driver.setQueueState!.bind(driver);
    driver.setQueueState = async (...args) => {
      await Bun.sleep(1);
      return await setQueueState(...args);
    };

    /** Jobs added: one capped for every two plain. */
    const JOBS = 120;
    /** Jobs finished, of either name. */
    let finished = 0;
    /** Capped jobs running right now, and the most there ever were. */
    const capped = { running: 0, peak: 0 };

    // Built here rather than through `setup()`, whose worker re-reads the
    // limits every 20ms. At the default one-second refresh a worker spends its
    // idle passes on nothing but counter writes, which is the shape that lost
    // releases: Postgres, running this same queue, stalled at 82 of 120.
    const instance = new BunQueueWorker<{ index: number }>(
      "limited",
      async (job) => {
        const isCapped = job.name === "capped";
        if (isCapped) {
          capped.running++;
          capped.peak = Math.max(capped.peak, capped.running);
        }
        await Bun.sleep(1 + (job.data.index % 3));
        if (isCapped) {
          capped.running--;
        }
        finished++;
        return null;
      },
      {
        namespace,
        driver,
        logger: noopLogger,
        concurrency: 6,
        pollInterval: 5,
        limitsRefreshInterval: 1000,
      },
    );
    closers.push(() => instance.close({ force: true }));
    void instance.run();

    // The same queue, typed for this test's jobs rather than `setup()`'s.
    const indexed = new BunQueue<{ index: number }>("limited", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(() => indexed.close());

    for (let index = 0; index < JOBS; index++) {
      await indexed.add(index % 3 === 0 ? "capped" : "plain", { index });
    }

    await waitFor(() => finished === JOBS, { timeout: 5000 });

    expect(finished).toBe(JOBS);
    expect(capped.peak).toBeLessThanOrEqual(2);
  });
});

describe("queue limits: a claim that fails", () => {
  /**
   * `reserve` charges a limited name for the whole grant before the claim, and
   * `commit` gives back what the claim did not use. A claim that throws in
   * between used to skip the `commit`, so the charge stayed on this worker's
   * own lease — which it keeps renewing — and the name read as full until the
   * worker closed. On MySQL and MariaDB a claim throws whenever InnoDB picks it
   * as a deadlock victim, so this is not hypothetical.
   */
  it("gives back the reservation, so the capped name keeps running", async () => {
    const { driver, queue, seen, worker } = setup();
    await queue.setLimits({ names: { capped: { concurrency: 1 } } });

    /** Claims to fail before handing them to the real driver. */
    let failuresLeft = 1;
    /** How many claims were made to fail. */
    let failed = 0;
    const fail = () => {
      if (failuresLeft > 0) {
        failuresLeft--;
        failed++;
        throw new Error("Deadlock found when trying to get lock");
      }
    };

    const claimJob = driver.claimJob.bind(driver);
    driver.claimJob = async (...args) => {
      fail();
      return await claimJob(...args);
    };
    if (driver.claimJobs) {
      const claimJobs = driver.claimJobs.bind(driver);
      driver.claimJobs = async (...args) => {
        fail();
        return await claimJobs(...args);
      };
    }

    await queue.add("capped", { ms: 1 });
    const errors: string[] = [];
    const instance = worker(2);
    instance.on("error", (_error, context) => errors.push(context));

    // Well inside the lease the leaked charge would be renewed under forever.
    await waitFor(() => seen.finished.length === 1, { timeout: 2000 });

    expect(failed).toBe(1);
    expect(seen.finished).toEqual(["capped"]);
    // The failure is still reported, not swallowed.
    expect(errors).toContain("loop");
  });
});

describe("queue limits: enforcement", () => {
  it("runs as before when the queue has no limits", async () => {
    const { queue, seen, worker } = setup();
    for (let i = 0; i < 20; i++) {
      await queue.add("free", { ms: 30 });
    }

    worker(10);
    await waitFor(() => seen.finished.length === 20, { timeout: 10_000 });

    expect(seen.peak).toBe(10);
  });

  it("caps how many jobs run at once across every worker", async () => {
    const { queue, seen, worker } = setup();
    await queue.setLimits({ concurrency: 3 });

    for (let i = 0; i < 30; i++) {
      await queue.add("capped", { ms: 25 });
    }

    // Twelve slots between them, three allowed.
    worker(4);
    worker(4);
    worker(4);

    await waitFor(() => seen.finished.length === 30, { timeout: 15_000 });
    expect(seen.peak).toBeLessThanOrEqual(3);
    expect(seen.peak).toBeGreaterThanOrEqual(2);
  }, 20_000);

  /**
   * The rate tests run on a frozen clock, moved a whole window at a time.
   *
   * They used to count starts per window by the wall clock, which judged the
   * limiter by when a job's processor happened to run rather than by the
   * window it was admitted in. A job admitted in a window's last moments whose
   * processor ran a little later counted against the next window, which
   * admits its own full rate: five in one window, once in a while, under
   * load. Frozen, every start in a window carries that window's time, and a
   * limiter that would admit one more has the whole hold to do it.
   */
  it("starts no more than the rate allows in any window", async () => {
    const { queue, seen, worker } = setup();
    const window = 300;
    const start = freezeMidWindow(window);
    await queue.setLimits({ rate: { max: 4, duration: window } });

    for (let i = 0; i < 16; i++) {
      await queue.add("rated", { ms: 1 });
    }

    worker(8);
    worker(8);

    for (let index = 0; index < 4; index++) {
      const expected = 4 * (index + 1);
      await until(
        () => seen.starts.length >= expected,
        () => `window ${index} started ${seen.starts.length - 4 * index} of 4`,
      );
      await Bun.sleep(HOLD_MS);
      expect(seen.starts).toHaveLength(expected);
      setSystemTime(new Date(start + (index + 1) * window));
    }

    await until(
      () => seen.finished.length === 16,
      () => `${seen.finished.length} of 16 finished`,
    );

    const perWindow = new Map<number, number>();
    for (const { at } of seen.starts) {
      const windowStart = Math.floor(at / window) * window;
      perWindow.set(windowStart, (perWindow.get(windowStart) ?? 0) + 1);
    }
    expect([...perWindow.values()]).toEqual([4, 4, 4, 4]);
  }, 20_000);

  it("skips a name at its cap while other names keep running", async () => {
    const { queue, seen, worker } = setup();
    await queue.setLimits({ names: { slow: { concurrency: 1 } } });

    // The capped name is at the head of the queue.
    for (let i = 0; i < 4; i++) {
      await queue.add("slow", { ms: 150 });
    }
    for (let i = 0; i < 12; i++) {
      await queue.add("fast", { ms: 5 });
    }

    worker(4);
    worker(4);

    // Every fast job finishes while slow ones are still queued behind the cap.
    await waitFor(
      () => seen.finished.filter((name) => name === "fast").length === 12,
      { timeout: 10_000 },
    );
    expect(seen.finished.filter((name) => name === "slow").length).toBeLessThan(
      4,
    );

    await waitFor(() => seen.finished.length === 16, { timeout: 10_000 });
    expect(seen.peakByName.get("slow")).toBe(1);
  }, 20_000);

  it("limits a name's rate on its own", async () => {
    const { queue, seen, worker } = setup();
    const window = 300;
    const start = freezeMidWindow(window);
    await queue.setLimits({
      names: { throttled: { rate: { max: 2, duration: window } } },
    });

    for (let i = 0; i < 6; i++) {
      await queue.add("throttled", { ms: 1 });
    }
    for (let i = 0; i < 6; i++) {
      await queue.add("open", { ms: 1 });
    }

    worker(6);

    const started = (name: string) =>
      seen.starts.filter((entry) => entry.name === name).length;

    // Every open job runs in the first window: only the throttled name waits.
    await until(
      () => started("open") === 6,
      () => `open ${started("open")} of 6 in the first window`,
    );

    for (let index = 0; index < 3; index++) {
      const expected = 2 * (index + 1);
      await until(
        () => started("throttled") >= expected,
        () =>
          `window ${index} started ${started("throttled") - 2 * index} of 2`,
      );
      await Bun.sleep(HOLD_MS);
      expect(started("throttled")).toBe(expected);
      setSystemTime(new Date(start + (index + 1) * window));
    }

    await until(
      () => seen.finished.length === 12,
      () => `${seen.finished.length} of 12 finished`,
    );

    const throttledPerWindow = new Map<number, number>();
    for (const { name, at } of seen.starts) {
      if (name === "throttled") {
        const windowStart = Math.floor(at / window) * window;
        throttledPerWindow.set(
          windowStart,
          (throttledPerWindow.get(windowStart) ?? 0) + 1,
        );
      }
    }
    // Exactly the rate: a name is charged for its whole grant inside the
    // reservation, before the claim, so no window runs over.
    expect([...throttledPerWindow.values()]).toEqual([2, 2, 2]);
  }, 20_000);

  it("applies a change to running workers within the refresh interval", async () => {
    const { queue, seen, worker } = setup();
    await queue.setLimits({ concurrency: 1 });

    for (let i = 0; i < 20; i++) {
      await queue.add("changing", { ms: 40 });
    }

    worker(8);
    await waitFor(() => seen.finished.length >= 3, { timeout: 10_000 });
    expect(seen.peak).toBe(1);

    await queue.setLimits(null);
    await waitFor(() => seen.running >= 4, {
      timeout: 5_000,
      message: "removing the limit never let more jobs run",
    });
  }, 20_000);

  it("does not announce a drain while jobs are only held back", async () => {
    const { queue, seen, worker } = setup();
    await queue.setLimits({ rate: { max: 1, duration: 400 } });

    for (let i = 0; i < 3; i++) {
      await queue.add("patient", { ms: 1 });
    }

    const instance = worker(4);
    let drainedEarly = false;
    instance.on("drained", () => {
      if (seen.finished.length < 3) {
        drainedEarly = true;
      }
    });

    await waitFor(() => seen.finished.length === 3, { timeout: 10_000 });
    expect(drainedEarly).toBe(false);
  }, 15_000);
});

describe("queue limits: a window boundary mid-reservation", () => {
  /**
   * A reservation is charged to the window of the moment it is written, not
   * the moment it began.
   *
   * `reserve(slots, now)` used to judge the window by `now` throughout.
   * Between `now` and the write there are awaits — the counters read, and
   * after a lost compare-and-set a random pause, up to a dozen times — so when
   * a boundary passed meanwhile, the grant was charged to a window that had
   * already ended. Its jobs started in the new window, which then admitted its
   * full rate on top of them: twice the rate in one window. The gate holds the
   * counters read open while the clock crosses the boundary, which is what a
   * slow backend, a lost race or a busy event loop does by chance.
   */
  it("counts the grant in the window it lands in, so the next caller sees it full", async () => {
    const driver = new MemoryDriver();
    const ref = { ns: testNamespace(), queue: "limited" };
    const window = 1_000;
    await driver.setQueueState(
      ref,
      LIMITS_STATE,
      { rate: { max: 2, duration: window } },
      null,
    );

    /** Holds the next counters read open until released. */
    let gate: { reached: () => void; open: Promise<void> } | undefined;
    const getQueueState = driver.getQueueState.bind(driver);
    driver.getQueueState = async (queueRef, name) => {
      const held = name === LIMITER_STATE ? gate : undefined;
      if (held) {
        gate = undefined;
        held.reached();
        await held.open;
      }
      return await getQueueState(queueRef, name);
    };

    const first = new QueueLimiter(driver, ref, "first", 30_000);
    const second = new QueueLimiter(driver, ref, "second", 30_000);
    closers.push(
      () => first.close(),
      () => second.close(),
    );

    // The last millisecond of a window.
    const boundary = Math.ceil(Date.now() / window) * window + window;
    setSystemTime(new Date(boundary - 1));

    const reached = Promise.withResolvers<void>();
    const open = Promise.withResolvers<void>();
    gate = { reached: reached.resolve, open: open.promise };

    const pending = first.reserve(2, Date.now());
    await reached.promise;
    // The boundary passes while the reservation waits on the counters.
    setSystemTime(new Date(boundary + 5));
    open.resolve();

    const granted = await pending;
    expect(granted?.grant).toBe(2);
    expect(granted?.windowStart).toBe(boundary);

    // Another worker, in the same window: the rate is spent.
    const refused = await second.reserve(2, Date.now());
    expect(refused?.grant).toBe(0);
    expect(refused?.retryAfter).toBe(window - 5);
  });
});

describe("queue limits: leases", () => {
  it("ignores capacity held by a worker whose lease lapsed", async () => {
    const { driver, namespace, queue, seen, worker } = setup();
    await queue.setLimits({ concurrency: 2 });

    // A worker that died holding both slots, its lease long expired.
    await driver.setQueueState!(
      { ns: namespace, queue: "limited" },
      LIMITER_STATE,
      {
        holders: {
          ghost: { expiresAt: Date.now() - 1_000, total: 2, names: {} },
        },
        windows: {},
      },
      null,
    );

    await queue.add("after-crash", { ms: 1 });
    worker(2);

    await waitFor(() => seen.finished.length === 1, {
      timeout: 5_000,
      message: "an expired lease still held the queue",
    });
  });

  it("respects capacity held by a worker whose lease is live", async () => {
    const { driver, namespace, queue, seen, worker } = setup();
    await queue.setLimits({ concurrency: 2 });

    await driver.setQueueState!(
      { ns: namespace, queue: "limited" },
      LIMITER_STATE,
      {
        holders: {
          busy: { expiresAt: Date.now() + 60_000, total: 2, names: {} },
        },
        windows: {},
      },
      null,
    );

    await queue.add("blocked", { ms: 1 });
    worker(2);

    await Bun.sleep(300);
    expect(seen.starts).toHaveLength(0);
  });

  it("gives its capacity back when it closes", async () => {
    const { driver, namespace, queue, seen, worker } = setup();
    await queue.setLimits({ concurrency: 1 });

    await queue.add("once", { ms: 1 });
    const instance = worker(1);
    await waitFor(() => seen.finished.length === 1, { timeout: 5_000 });

    await instance.close();

    const state = await driver.getQueueState!(
      { ns: namespace, queue: "limited" },
      LIMITER_STATE,
    );
    expect(
      Object.keys((state?.value as { holders: object }).holders),
    ).not.toContain(instance.id);
  });
});

describe("queue limits: from job definitions", () => {
  it("stores a definition's concurrency as that name's limit, and enforces it", async () => {
    const driver = new MemoryDriver();
    const jobs = new BunJobs({
      namespace: testNamespace(),
      driver,
      logger: noopLogger,
    });
    closers.push(() => jobs.close());

    let running = 0;
    let peak = 0;
    let done = 0;

    jobs.define(
      "report",
      async () => {
        running++;
        peak = Math.max(peak, running);
        await Bun.sleep(30);
        running--;
        done++;
        return null;
      },
      { concurrency: 1 },
    );
    jobs.define("mail", async () => null);

    // Limits already on the queue are kept.
    await jobs.queue("jobs").setLimits({
      rate: { max: 1_000, duration: 1_000 },
      names: { other: { concurrency: 7 } },
    });

    for (let i = 0; i < 4; i++) {
      await jobs.now("report");
    }

    await jobs.start({
      concurrency: 4,
      pollInterval: 5,
      maxBlock: 20,
      limitsRefreshInterval: 20,
    });

    await waitFor(() => done === 4, { timeout: 10_000 });
    expect(peak).toBe(1);
    expect(await jobs.queue("jobs").getLimits()).toEqual({
      rate: { max: 1_000, duration: 1_000 },
      names: { other: { concurrency: 7 }, report: { concurrency: 1 } },
    });
  }, 15_000);

  it("refuses a concurrency that is not a positive whole number at define()", () => {
    const jobs = new BunJobs({
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
    });
    closers.push(() => jobs.close());

    for (const concurrency of [0, -1, 2.5]) {
      expect(() =>
        jobs.define("bad", async () => null, { concurrency }),
      ).toThrow(ConfigError);
    }
  });
});
