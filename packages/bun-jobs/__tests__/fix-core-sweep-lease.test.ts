import type { JobsDriver, JobState } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueueWorker, MemoryDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * C12 item 7: every queue-wide maintenance sweep runs on one worker per queue
 * — the holder of that cadence's sweep lease — rather than on all of them, and
 * another worker takes over within a bounded time when the holder dies or is
 * parked.
 *
 * The sweeps that are this worker's own (flow redelivery, delayed-job
 * promotion) stay on every worker, and `maintenance: false` still arms
 * nothing.
 */

/** The queue-state entry holding the stalled-interval sweeps' lease. */
const STALLED_SWEEP_LEASE = "__win:fheal";

/** The queue-state entry holding the minute sweeps' lease. */
const MINUTE_SWEEP_LEASE = "__win:msweep";

const open: BunQueueWorker<unknown, unknown>[] = [];

afterEach(async () => {
  await Promise.allSettled(
    open.map(async (worker) => worker.close({ force: true })),
  );
  open.length = 0;
});

/** What one worker's view of the driver saw, per sweep. */
interface SweepCounts {
  /** `recoverStalled` passes. */
  stalled: number;
  /** Flow-heal walks over the queue's parents and finished children. */
  flowHeal: number;
  /** `pruneExpired` passes. */
  prune: number;
  /** `listRepeats` passes, which is the repeat-healing sweep. */
  repeats: number;
  /** Window-sweep pages (a `listQueueState` over every name). */
  windows: number;
  /** Worker-control sweep pages. */
  controls: number;
}

/** A view of `inner` counting the sweeps one worker makes through it. */
function countingView(inner: MemoryDriver): {
  /** The view to hand the worker. */
  driver: JobsDriver;
  /** What it has counted so far. */
  counts: SweepCounts;
  /** Makes every later call throw, as a process that has died would. */
  kill: () => void;
} {
  const counts: SweepCounts = {
    stalled: 0,
    flowHeal: 0,
    prune: 0,
    repeats: 0,
    windows: 0,
    controls: 0,
  };
  let dead = false;

  const driver = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function" || typeof prop !== "string") {
        return value;
      }

      return (...args: unknown[]) => {
        if (dead) {
          throw new Error("worker process is gone");
        }

        if (prop === "recoverStalled") {
          counts.stalled++;
        } else if (prop === "pruneExpired") {
          counts.prune++;
        } else if (prop === "listRepeats") {
          counts.repeats++;
        } else if (prop === "listJobs") {
          const states = (args[1] ?? []) as JobState[];
          if (
            states.includes("waiting-children") ||
            states.includes("completed") ||
            states.includes("dead")
          ) {
            counts.flowHeal++;
          }
        } else if (prop === "listQueueState") {
          const prefix = ((args[1] ?? {}) as { prefix?: string }).prefix ?? "";
          if (prefix === "") {
            counts.windows++;
          } else if (prefix.startsWith("__win:wctl:")) {
            counts.controls++;
          }
        }

        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as JobsDriver;

  return { driver, counts, kill: () => (dead = true) };
}

/** A worker on `inner`, through its own counting view. */
function worker(
  inner: MemoryDriver,
  ns: string,
  options?: {
    /** Whether the worker arms maintenance at all. */
    maintenance?: boolean;
    /** The stalled sweeps' cadence, which is also their lease's unit. */
    stalledInterval?: number;
  },
): {
  /** The worker itself. */
  instance: BunQueueWorker<unknown, unknown>;
  /** What its view has counted. */
  counts: SweepCounts;
  /** Makes its driver view throw, as a dead process would. */
  kill: () => void;
} {
  const view = countingView(inner);
  const instance = new BunQueueWorker<unknown, unknown>("q", async () => null, {
    namespace: ns,
    driver: view.driver,
    logger: noopLogger,
    stalledInterval: options?.stalledInterval ?? 50,
    pollInterval: 25,
    waitToExit: false,
    ...(options?.maintenance === false ? { maintenance: false } : {}),
  });
  // A killed view throws out of the maintenance pass; nothing else listens.
  instance.on("error", () => undefined);
  open.push(instance);
  return { instance, counts: view.counts, kill: view.kill };
}

/** `size` workers on `inner`, each with its own counting view. */
function fleet(
  inner: MemoryDriver,
  ns: string,
  size: number,
  options?: Parameters<typeof worker>[2],
): ReturnType<typeof worker>[] {
  const made: ReturnType<typeof worker>[] = [];
  for (let i = 0; i < size; i++) {
    made.push(worker(inner, ns, options));
  }
  return made;
}

/** Every sweep a worker's view counted, summed. */
function total(counts: SweepCounts): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

describe("maintenance sweeps: one worker per queue (C12 item 7)", () => {
  it("runs every queue-wide sweep on the lease holder alone", async () => {
    const inner = new MemoryDriver();
    const ns = testNamespace("sweep-one");
    const workers = fleet(inner, ns, 5);
    for (const { instance } of workers) {
      void instance.run();
    }

    // Several stalled cadences, and the one immediate pass of the minute
    // sweeps that `#every` makes on arming.
    await Bun.sleep(400);

    for (const name of [
      "stalled",
      "prune",
      "repeats",
      "windows",
      "controls",
    ] as const) {
      const sweeping = workers.filter(({ counts }) => counts[name] > 0);
      expect(
        sweeping.length,
        `${name} ran on ${sweeping.length} of 5 workers`,
      ).toBe(1);
    }

    // And it is the same worker for all of them within a cadence group.
    const minute = workers.filter(({ counts }) => counts.prune > 0);
    expect(minute[0]!.counts.repeats).toBeGreaterThan(0);
    expect(minute[0]!.counts.windows).toBeGreaterThan(0);
    expect(minute[0]!.counts.controls).toBeGreaterThan(0);
  });

  it("still promotes and redelivers on every worker", async () => {
    const inner = new MemoryDriver();
    const ns = testNamespace("sweep-own");
    let promotions = 0;
    const seen = new Set<object>();

    const workers = Array.from({ length: 4 }, () => {
      const view = new Proxy(inner, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (typeof value !== "function") {
            return value;
          }
          return (...args: unknown[]) => {
            if (prop === "promoteDelayed") {
              promotions++;
              seen.add(view as object);
            }
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      }) as JobsDriver;

      const instance = new BunQueueWorker<unknown, unknown>(
        "q",
        async () => null,
        {
          namespace: ns,
          driver: view,
          logger: noopLogger,
          stalledInterval: 50,
          pollInterval: 25,
          waitToExit: false,
        },
      );
      instance.on("error", () => undefined);
      open.push(instance);
      return instance;
    });

    for (const instance of workers) {
      void instance.run();
    }

    await waitFor(() => seen.size === 4, {
      timeout: 3_000,
      message: () => `only ${seen.size} of 4 workers promoted (${promotions})`,
    });
  });

  it("hands the stalled sweeps over within three cadences of a death", async () => {
    const inner = new MemoryDriver();
    const ns = testNamespace("sweep-death");
    const cadence = 100;
    const workers = fleet(inner, ns, 3, { stalledInterval: cadence });
    for (const { instance } of workers) {
      void instance.run();
    }

    await waitFor(() => workers.some(({ counts }) => counts.stalled > 0), {
      timeout: 2_000,
      message: "nobody took the stalled sweep lease",
    });
    await Bun.sleep(cadence * 2);

    const holder = workers.find(({ counts }) => counts.stalled > 0)!;
    const others = workers.filter((one) => one !== holder);
    expect(others.every(({ counts }) => counts.stalled === 0)).toBe(true);

    // The process is gone: it renews nothing and releases nothing, so the
    // lease has to lapse on its own.
    holder.kill();
    const started = Date.now();

    await waitFor(() => others.some(({ counts }) => counts.stalled > 0), {
      timeout: cadence * 3 + 1_000,
      message: "no worker took the stalled sweeps over",
    });

    // The documented bound: two cadences of lease, plus at most one more
    // before the next worker's pass.
    expect(Date.now() - started).toBeLessThanOrEqual(cadence * 3 + 500);
  });

  it("hands the sweeps over at once when the holder is parked", async () => {
    const inner = new MemoryDriver();
    const ns = testNamespace("sweep-park");
    const cadence = 100;
    const workers = fleet(inner, ns, 3, { stalledInterval: cadence });
    for (const { instance } of workers) {
      void instance.run();
    }

    await waitFor(() => workers.some(({ counts }) => counts.stalled > 0), {
      timeout: 2_000,
      message: "nobody took the stalled sweep lease",
    });

    const holder = workers.find(({ counts }) => counts.stalled > 0)!;
    const others = workers.filter((one) => one !== holder);
    await holder.instance.stop();

    // Released rather than left to lapse, so the next pass — one cadence at
    // the outside — picks it up.
    await waitFor(() => others.some(({ counts }) => counts.stalled > 0), {
      timeout: cadence * 3,
      message: "no worker took over from the parked holder",
    });

    const entry = await inner.getQueueState!(
      { ns, queue: "q" },
      STALLED_SWEEP_LEASE,
    );
    const now = (entry?.value as { holder?: string } | undefined)?.holder;
    expect(typeof now).toBe("string");
    expect(now).not.toBe(holder.instance.id);
    expect(others.map(({ instance }) => instance.id)).toContain(now!);
  });

  it("releases the minute lease when its holder is parked", async () => {
    const inner = new MemoryDriver();
    const ns = testNamespace("sweep-park-minute");
    const only = worker(inner, ns);
    void only.instance.run();

    const ref = { ns, queue: "q" };
    await waitFor(async () => only.counts.prune > 0, {
      timeout: 2_000,
      message: "the only worker never pruned",
    });

    const held = await inner.getQueueState!(ref, MINUTE_SWEEP_LEASE);
    expect((held?.value as { holder?: string }).holder).toBe(only.instance.id);

    // Two minutes: the same two lifetimes the stalled lease takes, at the
    // minute sweeps' own cadence. That, plus one more cadence before another
    // worker's pass, is the three-minute hand-over bound on a death.
    const until = (held?.value as { until: number }).until;
    expect(until - Date.now()).toBeGreaterThan(110_000);
    expect(until - Date.now()).toBeLessThanOrEqual(120_000);

    await only.instance.stop();
    await waitFor(
      async () =>
        (await inner.getQueueState!(ref, MINUTE_SWEEP_LEASE)) === null,
      { timeout: 2_000, message: "the parked holder kept the minute lease" },
    );
  });

  it("runs every sweep when there is only one worker", async () => {
    const inner = new MemoryDriver();
    const ns = testNamespace("sweep-solo");
    const only = worker(inner, ns);
    void only.instance.run();

    await waitFor(
      () =>
        only.counts.stalled > 0 &&
        only.counts.prune > 0 &&
        only.counts.repeats > 0 &&
        only.counts.windows > 0 &&
        only.counts.controls > 0,
      {
        timeout: 3_000,
        message: () =>
          `the only worker skipped a sweep: ${JSON.stringify(only.counts)}`,
      },
    );
  });

  it("arms nothing, and takes no lease, with maintenance off", async () => {
    const inner = new MemoryDriver();
    const ns = testNamespace("sweep-off");
    const workers = fleet(inner, ns, 3, { maintenance: false });
    for (const { instance } of workers) {
      void instance.run();
    }

    await Bun.sleep(400);

    for (const { counts } of workers) {
      expect(total(counts)).toBe(0);
    }

    const ref = { ns, queue: "q" };
    expect(await inner.getQueueState!(ref, STALLED_SWEEP_LEASE)).toBeNull();
    expect(await inner.getQueueState!(ref, MINUTE_SWEEP_LEASE)).toBeNull();
  });
});
