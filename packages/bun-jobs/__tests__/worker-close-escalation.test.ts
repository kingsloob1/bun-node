import type {
  DriverConfig,
  WorkerTargetCloseOptions,
  WorkerTargetFactory,
} from "../lib/index";
import { join, sep } from "node:path";
import { createDeferred, noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { BunQueue, BunQueueWorker, createDriver } from "../lib/index";
import { QueueLimiter } from "../lib/queue/limits";
import { FileTargetExecutor } from "../lib/queue/workerTarget";
import { testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * `close({ force: true })` landing while a graceful `close()` is under way
 * escalates it: from that moment the close is a forced one at whatever step it
 * had reached, and both calls resolve once it has finished.
 *
 * Before this, a close re-entered while one was in progress only awaited the
 * claim loop, so the force changed nothing: an attempt ignoring its signal
 * held the graceful close for its whole `timeout`, and a graceful target
 * close ran out its full grace. A process that gave up and exited at that
 * point orphaned whatever the target was still running.
 *
 * Nothing here sleeps its way to an interleaving. The graceful close is known
 * to be waiting on the attempt when its `timeout` timer is armed — a timer of
 * a length nothing else uses — and a graceful target close when the target's
 * own `close()` is called. The bounds are what "promptly" means: well under
 * the graceful windows being cut short.
 */

const cleanups: (() => Promise<void>)[] = [];
const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

const BACKENDS = [
  {
    name: "memory",
    config: { type: "memory" } as DriverConfig,
    available: true,
  },
  ...(await crossProcessBackends({ cleanups })),
];

/**
 * The graceful close's `timeout`: far longer than any bound below, and a
 * length no other timer in the worker uses, so arming it marks the moment the
 * close starts waiting on the attempt.
 */
const GRACE_MS = 43_217;

/** How long a close cut short may take to resolve after the force. */
const PROMPT_MS = 3_000;

/** Removes exactly the namespace a test created, on a driver of its own. */
function purgeAfter(config: DriverConfig, namespace: string): void {
  if (config.type === "memory") {
    return;
  }
  closers.push(async () => {
    const driver = createDriver(config);
    try {
      await driver.connect();
      await driver.purge(namespace);
    } finally {
      await driver.close();
    }
  });
}

/**
 * Watches the timers armed from `lib/queue/` until they are cleared: every
 * interval, and each timeout of `GRACE_MS` (the graceful wait), with a
 * deferred resolved when one of those is armed. Driver timers are left out,
 * as the worker does not own them. Restored after the test.
 */
function trackTimers(): {
  /** Intervals armed from `lib/queue/` and not yet cleared. */
  intervals: Map<unknown, string>;
  /** `GRACE_MS` timeouts armed from `lib/queue/`, neither fired nor cleared. */
  graceTimers: Set<unknown>;
  /** Resolves when the first `GRACE_MS` timeout is armed. */
  graceArmed: Promise<void>;
} {
  const intervals = new Map<unknown, string>();
  const graceTimers = new Set<unknown>();
  const armed = createDeferred<void>();
  const real = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const marker = `${sep}lib${sep}queue${sep}`;
  const fromQueue = () => (new Error("armed").stack ?? "").includes(marker);

  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = real.setInterval(...args);
    if (fromQueue()) {
      intervals.set(handle, new Error("armed").stack ?? "");
    }
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
    intervals.delete(handle);
    real.clearInterval(handle);
  }) as typeof clearInterval;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    if (ms !== GRACE_MS || !fromQueue()) {
      return real.setTimeout(callback, ms, ...rest);
    }
    const handle = real.setTimeout(
      (...args: unknown[]) => {
        graceTimers.delete(handle);
        callback(...args);
      },
      ms,
      ...rest,
    );
    graceTimers.add(handle);
    armed.resolve();
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    graceTimers.delete(handle);
    real.clearTimeout(handle);
  }) as typeof clearTimeout;

  closers.push(async () => {
    Object.assign(globalThis, real);
  });
  return { intervals, graceTimers, graceArmed: armed.promise };
}

/**
 * Counts `QueueLimiter.close()` per limiter, so a test can see that none gave
 * its capacity back twice. Restored after the test.
 */
function countLimiterCloses(): Map<QueueLimiter, number> {
  const counts = new Map<QueueLimiter, number>();
  const original = Object.getOwnPropertyDescriptor(
    QueueLimiter.prototype,
    "close",
  )!;
  const close = QueueLimiter.prototype.close;
  QueueLimiter.prototype.close = async function (this: QueueLimiter) {
    counts.set(this, (counts.get(this) ?? 0) + 1);
    return await close.call(this);
  };
  closers.push(async () => {
    Object.defineProperty(QueueLimiter.prototype, "close", original);
  });
  return counts;
}

/** Resolves with how long `promise` took, or `"pending"` after `ms`. */
async function within(
  promise: Promise<unknown>,
  ms: number,
): Promise<number | "pending"> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    promise.then(() => Date.now() - started),
    new Promise<"pending">((resolve) => {
      timer = setTimeout(resolve, ms, "pending");
    }),
  ]);
  clearTimeout(timer);
  return outcome;
}

/** What {@link setup} hands a test. */
interface Setup {
  /** The worker, which built — and owns — its driver. */
  worker: BunQueueWorker;
  /** A queue on the worker's driver, borrowed. */
  queue: BunQueue;
  /** Every attempt's signal, in the order the attempts started. */
  signals: AbortSignal[];
  /** Resolves when the first attempt has started. */
  started: Promise<void>;
  /** Lets every attempt end, returning `"done"`. */
  release: () => void;
  /** How many times the worker closed its driver. */
  driverCloses: () => number;
  /** How many times each event of interest was emitted. */
  events: { closing: number; closed: number };
}

/**
 * A worker whose attempts ignore their signal and end only when released,
 * run in-process, and a queue to feed it.
 */
function setup(
  config: DriverConfig,
  options?: {
    /** A target factory to run attempts through instead of the default. */
    target?: WorkerTargetFactory;
  },
): Setup {
  const namespace = testNamespace("close-esc");
  purgeAfter(config, namespace);
  const signals: AbortSignal[] = [];
  const started = createDeferred<void>();
  const gate = createDeferred<void>();

  const worker = new BunQueueWorker(
    "close-esc",
    async (_job, context) => {
      signals.push(context.signal);
      started.resolve();
      // Ignores the signal: only `release()` ends it.
      await gate.promise;
      return "done";
    },
    {
      namespace,
      driver: config,
      logger: noopLogger,
      concurrency: 1,
      pollInterval: 10,
      lockDuration: 60_000,
      waitToExit: false,
      ...(options?.target ? { target: options.target } : {}),
    },
  );
  worker.on("error", () => {});
  const events = { closing: 0, closed: 0 };
  worker.on("closing", () => {
    events.closing += 1;
  });
  worker.on("closed", () => {
    events.closed += 1;
  });

  let driverCloses = 0;
  const driver = worker.driver;
  const closeDriver = driver.close.bind(driver);
  driver.close = async () => {
    driverCloses += 1;
    await closeDriver();
  };

  const queue = new BunQueue("close-esc", {
    namespace,
    driver,
    logger: noopLogger,
  });

  closers.push(
    async () => await worker.close({ force: true }),
    async () => await queue.close(),
    async () => gate.resolve(),
  );

  return {
    worker,
    queue,
    signals,
    started: started.promise,
    release: () => gate.resolve(),
    driverCloses: () => driverCloses,
    events,
  };
}

/** Starts the worker, adds a job, and resolves once its attempt is running. */
async function running(set: Setup): Promise<void> {
  void set.worker.run();
  await set.queue.add("stubborn", {}, { attempts: 1 });
  await set.started;
}

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `close({ force: true }) during a graceful close (${backend.name})`,
    () => {
      it("escalates it: the attempt is aborted, both calls resolve promptly, nothing is left armed", async () => {
        const timers = trackTimers();
        const set = setup(backend.config);
        await running(set);

        const graceful = set.worker.close({ timeout: GRACE_MS });
        await timers.graceArmed;
        // The graceful close is waiting on an attempt that ignores it.
        expect(set.signals[0]!.aborted).toBe(false);

        const forced = set.worker.close({ force: true });
        expect(await within(forced, PROMPT_MS)).not.toBe("pending");
        expect(await within(graceful, PROMPT_MS)).not.toBe("pending");

        expect(set.signals).toHaveLength(1);
        expect(set.signals[0]!.aborted).toBe(true);
        expect(set.worker.isRunning).toBe(false);
        // The graceful wait's timer went with it; nothing of the worker's
        // is still armed.
        expect(timers.graceTimers.size).toBe(0);
        expect([...timers.intervals.values()]).toEqual([]);
        expect(set.events).toEqual({ closing: 1, closed: 1 });
        expect(set.driverCloses()).toBe(1);
      }, 20_000);

      it("two forces during a graceful close: one escalation, everything released once", async () => {
        const timers = trackTimers();
        const limiters = countLimiterCloses();
        const set = setup(backend.config);
        await running(set);
        let aborts = 0;
        set.signals[0]!.addEventListener("abort", () => {
          aborts += 1;
        });

        const graceful = set.worker.close({ timeout: GRACE_MS });
        await timers.graceArmed;
        const first = set.worker.close({ force: true });
        const second = set.worker.close({ force: true });

        const all = Promise.all([graceful, first, second]);
        expect(await within(all, PROMPT_MS)).not.toBe("pending");
        expect(aborts).toBe(1);
        expect(set.events).toEqual({ closing: 1, closed: 1 });
        expect(set.driverCloses()).toBe(1);
        for (const count of limiters.values()) {
          expect(count).toBe(1);
        }
        expect([...timers.intervals.values()]).toEqual([]);
      }, 20_000);

      it("a force during a forced close changes nothing, and resolves once the close has finished", async () => {
        const timers = trackTimers();
        const limiters = countLimiterCloses();
        const set = setup(backend.config);
        await running(set);
        let aborts = 0;
        set.signals[0]!.addEventListener("abort", () => {
          aborts += 1;
        });

        const first = set.worker.close({ force: true });
        const second = set.worker.close({ force: true }).then(() => ({
          closed: set.events.closed,
        }));

        expect(await within(first, PROMPT_MS)).not.toBe("pending");
        // Resolved only once the close had finished: `closed` was emitted.
        expect(await second).toEqual({ closed: 1 });
        expect(aborts).toBe(1);
        expect(set.events).toEqual({ closing: 1, closed: 1 });
        expect(set.driverCloses()).toBe(1);
        for (const count of limiters.values()) {
          expect(count).toBe(1);
        }
        expect([...timers.intervals.values()]).toEqual([]);
      }, 20_000);

      it("control: a second graceful close() does not escalate; the attempt drains", async () => {
        const timers = trackTimers();
        const set = setup(backend.config);
        await running(set);

        const graceful = set.worker.close({ timeout: GRACE_MS });
        await timers.graceArmed;
        const again = set.worker.close();
        // It waits for the claim loop, as it always has, and aborts nothing.
        expect(await within(again, PROMPT_MS)).not.toBe("pending");
        expect(set.signals[0]!.aborted).toBe(false);
        expect(await within(graceful, 200)).toBe("pending");

        set.release();
        expect(await within(graceful, PROMPT_MS)).not.toBe("pending");
        expect(set.signals[0]!.aborted).toBe(false);
        expect([...timers.intervals.values()]).toEqual([]);
        expect(set.events).toEqual({ closing: 1, closed: 1 });
        expect(set.driverCloses()).toBe(1);
      }, 20_000);

      it("control: a graceful close with no escalation still runs out its timeout", async () => {
        const timers = trackTimers();
        const set = setup(backend.config);
        await running(set);

        const began = Date.now();
        await set.worker.close({ timeout: 300 });
        const took = Date.now() - began;

        // Out of patience at the timeout, not before; aborted then.
        expect(took).toBeGreaterThanOrEqual(290);
        expect(took).toBeLessThan(PROMPT_MS);
        expect(set.signals[0]!.aborted).toBe(true);
        expect([...timers.intervals.values()]).toEqual([]);
        expect(set.events).toEqual({ closing: 1, closed: 1 });
        expect(set.driverCloses()).toBe(1);
      }, 20_000);

      it("control: a plain forced close aborts at once and resolves promptly", async () => {
        const timers = trackTimers();
        const set = setup(backend.config);
        await running(set);

        expect(
          await within(set.worker.close({ force: true }), PROMPT_MS),
        ).not.toBe("pending");
        expect(set.signals[0]!.aborted).toBe(true);
        expect([...timers.intervals.values()]).toEqual([]);
        expect(set.events).toEqual({ closing: 1, closed: 1 });
        expect(set.driverCloses()).toBe(1);
      }, 20_000);
    },
  );
}

/**
 * A custom target whose graceful `close()` drains until it is forced: what a
 * target close already under way looks like to the escalation.
 */
function drainingTarget(): {
  /** The factory to give the worker. */
  factory: WorkerTargetFactory;
  /** The options of every `close()` call, in order. */
  calls: (WorkerTargetCloseOptions | undefined)[];
  /** Resolves when the graceful `close()` has been called. */
  gracefulCalled: Promise<void>;
} {
  const calls: (WorkerTargetCloseOptions | undefined)[] = [];
  const gracefulCalled = createDeferred<void>();
  const drained = createDeferred<void>();
  // Rejected by a force whether or not a graceful close is awaiting it.
  drained.promise.catch(() => undefined);
  const factory: WorkerTargetFactory = (context) => ({
    name: "draining",
    run: async ({ job, context: attempt }) => {
      if (context.processor.kind !== "function") {
        throw new Error("expected a function processor");
      }
      return await context.processor.fn(job, attempt);
    },
    close: async (options) => {
      calls.push(options);
      if (options?.force) {
        // Forced: the drain it cut short fails, and that must not surface.
        drained.reject(new Error("drain cut short"));
        return;
      }
      gracefulCalled.resolve();
      await drained.promise;
    },
  });
  return { factory, calls, gracefulCalled: gracefulCalled.promise };
}

describe("close({ force: true }) during a graceful target close", () => {
  it("takes the target close over with { force: true }; both calls resolve, neither rejects", async () => {
    const target = drainingTarget();
    const set = setup({ type: "memory" }, { target: target.factory });
    void set.worker.run();

    const graceful = set.worker.close();
    await target.gracefulCalled;
    const forced = set.worker.close({ force: true });

    // Well inside the worker's 5000 ms bound on a target's close().
    expect(await within(Promise.all([graceful, forced]), 2_000)).not.toBe(
      "pending",
    );
    expect(target.calls).toEqual([undefined, { force: true }]);
    expect(set.events).toEqual({ closing: 1, closed: 1 });
  }, 20_000);

  it("closes the target once, forced, when the force lands before the graceful close reached it", async () => {
    const timers = trackTimers();
    const target = drainingTarget();
    const set = setup({ type: "memory" }, { target: target.factory });
    await running(set);

    const graceful = set.worker.close({ timeout: GRACE_MS });
    await timers.graceArmed;
    const forced = set.worker.close({ force: true });

    expect(await within(Promise.all([graceful, forced]), 2_000)).not.toBe(
      "pending",
    );
    expect(target.calls).toEqual([{ force: true }]);
    expect(set.signals[0]!.aborted).toBe(true);
  }, 20_000);
});

describe("the built-in target's close() called again", () => {
  /** An executor with no runs, which is enough to see what it hands back. */
  function executor(): FileTargetExecutor {
    return new FileTargetExecutor(
      { kind: "child-process" },
      join(import.meta.dir, "fixtures", "handlers", "job-spin-beacon.ts"),
      { namespace: "close-esc", queue: "close-esc", workerId: "w" },
    );
  }

  it("a later force returns the first force's wait rather than killing again", async () => {
    const target = executor();
    const first = target.close({ force: true });
    const second = target.close({ force: true });
    expect(first).toBeInstanceOf(Promise);
    expect(second).toBe(first);
    // A graceful call after a force has nothing to ask: it joins the force.
    expect(target.close()).toBe(first);
    await first;
  });
});
