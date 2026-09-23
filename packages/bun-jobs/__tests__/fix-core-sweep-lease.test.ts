import type { JobsDriver, JobState } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueueWorker, MemoryDriver } from "../lib/index";
// Reserved queue-state entries are refused without this package's own token,
// so a test that has to plant one writes it the way the worker does.
import { setReservedState } from "../lib/queue/windows";
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
function countingView(
  inner: MemoryDriver,
  /**
   * Where to append the epoch millisecond of every stalled sweep this view
   * sees. Shared across a fleet's views on purpose: the queue has one sweep
   * history whoever made it, and its gaps are what an operator's
   * `stalledInterval` is a promise about. Defaults to a private array.
   */
  stalledAt: number[] = [],
): {
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
          stalledAt.push(Date.now());
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
    /**
     * Where to append the epoch millisecond of every stalled sweep this
     * worker makes. Pass one array to a whole fleet to get the queue's sweep
     * history. Defaults to a private array.
     */
    stalledAt?: number[];
  },
): {
  /** The worker itself. */
  instance: BunQueueWorker<unknown, unknown>;
  /** What its view has counted. */
  counts: SweepCounts;
  /** Makes its driver view throw, as a dead process would. */
  kill: () => void;
} {
  const view = countingView(inner, options?.stalledAt);
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

/**
 * The lease settles on the **fastest** sweeper, not on whoever grabbed it
 * first. Without this, a worker deliberately given a short `stalledInterval`
 * beside default-cadence workers governs the queue only when it happens to win
 * the startup race — and when it loses, nothing sweeps for a default interval
 * and its cadence means nothing, silently.
 *
 * A worker takes a live lease when the holder's recorded cadence is more than
 * twice its own. That factor is what keeps it from thrashing: equal and
 * near-equal cadences never take it from each other, and the slow holder can
 * never take it back (it would need `cB > 2*cA` when `cA > 2*cB`).
 */
describe("the maintenance lease settles on the fastest sweeper", () => {
  /** The lease as it is written: holder, expiry and the holder's cadence. */
  interface LeaseValue {
    /** The worker id holding it. */
    holder: string;
    /** The epoch millisecond it lapses at. */
    until: number;
    /** How often that worker sweeps, in milliseconds. */
    cadence?: number;
  }

  /** The stalled-sweep lease as it stands, or `null` if nobody holds one. */
  async function lease(
    inner: MemoryDriver,
    ns: string,
  ): Promise<LeaseValue | null> {
    const entry = await inner.getQueueState!(
      { ns, queue: "q" },
      STALLED_SWEEP_LEASE,
    );
    return (entry?.value as LeaseValue | undefined) ?? null;
  }

  /**
   * Every holder the lease has had between now and `ms` from now, in order and
   * without repeats — the thing a thrash would show up in.
   */
  async function holdersOver(
    inner: MemoryDriver,
    ns: string,
    ms: number,
    step = 50,
  ): Promise<string[]> {
    const seen: string[] = [];
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const held = await lease(inner, ns);
      if (held && seen.at(-1) !== held.holder) {
        seen.push(held.holder);
      }
      await Bun.sleep(step);
    }
    return seen;
  }

  /** The longest gap between consecutive sweeps recorded in `at`. */
  function widestGap(at: number[]): number {
    let widest = 0;
    for (let i = 1; i < at.length; i++) {
      widest = Math.max(widest, at[i]! - at[i - 1]!);
    }
    return widest;
  }

  const FAST = 100;
  const SLOW = 1_500;

  it("takes the lease from a slower holder, whichever started first", async () => {
    for (const slowFirst of [true, false]) {
      const inner = new MemoryDriver();
      const ns = testNamespace(`sweep-fastest-${slowFirst ? "slow" : "fast"}`);
      const sweeps: number[] = [];
      const slow = worker(inner, ns, {
        stalledInterval: SLOW,
        stalledAt: sweeps,
      });
      const fast = worker(inner, ns, {
        stalledInterval: FAST,
        stalledAt: sweeps,
      });

      const [first, second] = slowFirst ? [slow, fast] : [fast, slow];
      void first.instance.run();
      await waitFor(async () => (await lease(inner, ns)) !== null, {
        timeout: 2_000,
        message: "the first worker never took the lease",
      });
      expect((await lease(inner, ns))!.holder).toBe(first.instance.id);
      void second.instance.run();

      // Whoever started, the fast worker ends up holding it.
      await waitFor(
        async () => (await lease(inner, ns))?.holder === fast.instance.id,
        {
          timeout: 2_000,
          message: async () =>
            `the fast worker never took the lease: ${JSON.stringify(await lease(inner, ns))}`,
        },
      );

      // And the queue is then swept at the fast worker's cadence, not the
      // slow one's: measured over more than a whole slow cadence, so a slow
      // sweeper governing the queue could not possibly pass this.
      sweeps.length = 0;
      await Bun.sleep(SLOW + 300);
      expect(sweeps.length).toBeGreaterThanOrEqual(8);
      expect(widestGap(sweeps)).toBeLessThan(FAST * 5);

      await Promise.allSettled(
        [slow, fast].map(async (one) => one.instance.close({ force: true })),
      );
    }
  }, 20_000);

  it("keeps a uniform fleet's lease with one holder over many passes", async () => {
    const inner = new MemoryDriver();
    const ns = testNamespace("sweep-uniform");
    const cadence = 200;
    const sweeps: number[] = [];
    const workers = fleet(inner, ns, 4, {
      stalledInterval: cadence,
      stalledAt: sweeps,
    });
    for (const { instance } of workers) {
      void instance.run();
    }

    // Twenty passes' worth. Equal cadences are never "materially longer", so
    // nothing may take the lease from anybody: this is #108's behaviour,
    // unchanged.
    const holders = await holdersOver(inner, ns, cadence * 20);
    expect(holders).toHaveLength(1);

    const sweeping = workers.filter(({ counts }) => counts.stalled > 0);
    expect(sweeping).toHaveLength(1);
    expect(sweeping[0]!.instance.id).toBe(holders[0]!);
    expect((await lease(inner, ns))!.cadence).toBe(cadence);
  }, 20_000);

  it("leaves near-equal cadences alone — under the factor, nobody moves", async () => {
    const inner = new MemoryDriver();
    const ns = testNamespace("sweep-near-equal");
    // 180 is shorter than 200 but not *materially*: 200 is not more than
    // twice 180, nor 180 more than twice 200, so neither may take the other's.
    const quick = worker(inner, ns, { stalledInterval: 180 });
    const plain = worker(inner, ns, { stalledInterval: 200 });

    void plain.instance.run();
    await waitFor(
      async () => (await lease(inner, ns))?.holder === plain.instance.id,
      { timeout: 2_000, message: "the first worker never took the lease" },
    );
    void quick.instance.run();

    const holders = await holdersOver(inner, ns, 3_000);
    expect(holders).toEqual([plain.instance.id]);
    expect(quick.counts.stalled).toBe(0);
  }, 20_000);

  it("never lets the slow worker take it back", async () => {
    const inner = new MemoryDriver();
    const ns = testNamespace("sweep-no-takeback");
    const slowCadence = 400;
    const slow = worker(inner, ns, { stalledInterval: slowCadence });
    const fast = worker(inner, ns, { stalledInterval: FAST });

    void slow.instance.run();
    await waitFor(
      async () => (await lease(inner, ns))?.holder === slow.instance.id,
      { timeout: 2_000, message: "the slow worker never took the lease" },
    );
    void fast.instance.run();
    await waitFor(
      async () => (await lease(inner, ns))?.holder === fast.instance.id,
      { timeout: 2_000, message: "the fast worker never took the lease" },
    );

    // Ten of the slow worker's own passes. Every one of them reads a live
    // lease whose cadence is a quarter of its own, and stands down.
    const swept = slow.counts.stalled;
    const holders = await holdersOver(inner, ns, slowCadence * 10);
    expect(holders).toEqual([fast.instance.id]);
    expect(slow.counts.stalled).toBe(swept);
  }, 20_000);

  it("gives the lease the new holder's lifetime after a takeover", async () => {
    const inner = new MemoryDriver();
    const ns = testNamespace("sweep-lifetime");
    const slow = worker(inner, ns, { stalledInterval: SLOW });
    const fast = worker(inner, ns, { stalledInterval: FAST });

    void slow.instance.run();
    await waitFor(
      async () => (await lease(inner, ns))?.holder === slow.instance.id,
      { timeout: 2_000, message: "the slow worker never took the lease" },
    );
    const bySlow = (await lease(inner, ns))!;
    expect(bySlow.cadence).toBe(SLOW);
    expect(bySlow.until - Date.now()).toBeGreaterThan(SLOW);

    void fast.instance.run();
    await waitFor(
      async () => (await lease(inner, ns))?.holder === fast.instance.id,
      { timeout: 2_000, message: "the fast worker never took the lease" },
    );

    // The hand-over bound follows whoever holds it now: two of the *fast*
    // worker's cadences, not two of the slow one's.
    const byFast = (await lease(inner, ns))!;
    expect(byFast.cadence).toBe(FAST);
    expect(byFast.until - Date.now()).toBeLessThanOrEqual(FAST * 2);
  }, 20_000);

  it("waits out a lease that records no cadence at all", async () => {
    const inner = new MemoryDriver();
    const ns = testNamespace("sweep-legacy-lease");
    const ref = { ns, queue: "q" };

    // What a worker from before the cadence was recorded leaves behind. An
    // unknown cadence is not a known-slower one, so even the fastest worker
    // waits for it rather than taking it — otherwise an old worker and a new
    // one would take it from each other on alternate passes.
    await setReservedState(
      inner,
      ref,
      STALLED_SWEEP_LEASE,
      { holder: "someone-else", until: Date.now() + 5_000 },
      null,
    );

    const fast = worker(inner, ns, { stalledInterval: FAST });
    void fast.instance.run();
    await Bun.sleep(FAST * 8);

    expect((await lease(inner, ns))!.holder).toBe("someone-else");
    expect(fast.counts.stalled).toBe(0);
  }, 20_000);
});
