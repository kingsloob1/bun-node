import type { DriverConfig, JobsDriver } from "../../../lib/index";
import { sep } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunQueueWorker } from "../../../lib/index";
import { workerConfigName } from "../../../lib/queue/workerControl";

/**
 * A worker closed while `run()` is still starting up, with the startup held
 * on a gate so the interleaving is forced rather than hoped for.
 *
 * `run()` awaits three things before it arms anything a running worker has:
 * the driver's `connect()`, `ensureQueue()`, and the first control read (a
 * `getQueueState()`). Each is a `stage` here: that driver call is held until
 * `close()` has been called — and, if it resolves without the start, has
 * resolved — and then let through. `"ready"` is the control: no gate, the
 * close comes once the worker has announced `ready` and written its first
 * heartbeat record.
 *
 * Imported by `worker-close-during-start.test.ts`, which asserts on what
 * {@link closeDuringStart} observed; run directly (`bun close-during-start.ts
 * '<json>'`) it plays the same scenario in a process of its own and prints the
 * observations, so its parent can also check the process exits by itself.
 */

/** Which startup await is held, or `"ready"` for a close after startup. */
export type StartStage = "connect" | "ensureQueue" | "control" | "ready";

/** What {@link closeDuringStart} is asked to do. */
export interface CloseDuringStartOptions {
  /** The driver the worker builds and owns, as a config. */
  config: DriverConfig;
  /** The namespace the worker consumes from. */
  namespace: string;
  /** Which startup await to hold. */
  stage: StartStage;
  /** Whether the close is `close({ force: true })`. */
  force: boolean;
  /** Where to register the worker's forced close, as a cleanup for a failed run. */
  closers?: (() => Promise<unknown>)[];
}

/** What {@link closeDuringStart} saw. */
export interface CloseDuringStartObservation {
  /** Whether the held call was reached at all; without it the run shows nothing. */
  reached: boolean;
  /** Whether `close()` resolved while the startup was still held. */
  closedBeforeRelease: boolean;
  /** `"resolved"`, or the message `run()` rejected with. */
  run: string;
  /** The stacks of intervals armed from `lib/queue/` and never cleared. */
  liveIntervals: string[];
  /** Driver calls only a running worker makes, made after `close()` was called. */
  callsAfterClose: string[];
  /** The same calls, made after `close()` had resolved. */
  callsAfterClosed: string[];
  /** Whether `ready` was emitted after `closing`. */
  readyAfterClosing: boolean;
  /** `worker.isRunning` once everything settled. */
  isRunning: boolean;
  /** `worker.state` once everything settled. */
  state: string;
}

/**
 * The driver calls that belong to a started worker: creating its queue,
 * claiming, heartbeating, publishing, sweeping. Recorded when made after
 * `close()` was called, and again when made after it resolved; which of them
 * may still happen in between — a sweep or a report already under way — is
 * the test's to say.
 */
export const RUNNING_CALLS: ReadonlySet<string> = new Set([
  "ensureQueue",
  "claimJob",
  "claimJobs",
  "waitForJob",
  "registerWorker",
  "publish",
  "subscribe",
  "recoverStalled",
  "promoteDelayed",
  "pruneExpired",
]);

/** A queue's worth of cadence: every timer the worker arms fires within this. */
const QUIET_MS = 250;

/** How long a close is given to resolve on its own before the gate opens. */
const CLOSE_GRACE_MS = 200;

/** Every method a driver has, own or inherited. */
function methodNames(driver: JobsDriver): string[] {
  const names = new Set<string>();
  let proto: object | null = driver;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (
        name !== "constructor" &&
        typeof (driver as unknown as Record<string, unknown>)[name] ===
          "function"
      ) {
        names.add(name);
      }
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return [...names];
}

/**
 * Tracks the intervals armed from `lib/queue/` — the worker, its limiter, its
 * metrics recorder, its control poll — until they are cleared. Drivers arm
 * their own, which the worker does not own, so those are left out.
 */
function trackIntervals(): { live: Map<unknown, string>; restore: () => void } {
  const live = new Map<unknown, string>();
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const marker = `${sep}lib${sep}queue${sep}`;

  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSet(...args);
    const stack = new Error("armed").stack ?? "";
    if (stack.includes(marker)) {
      live.set(handle, stack);
    }
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
    live.delete(handle);
    realClear(handle);
  }) as typeof clearInterval;

  return {
    live,
    restore: () => {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    },
  };
}

/** Plays the scenario once and reports what happened. */
export async function closeDuringStart(
  options: CloseDuringStartOptions,
): Promise<CloseDuringStartObservation> {
  const intervals = trackIntervals();

  try {
    const worker = new BunQueueWorker("close-start", async () => null, {
      namespace: options.namespace,
      driver: options.config,
      logger: noopLogger,
      publish: true,
      pollInterval: 10,
      stalledInterval: 30,
      reportInterval: 40,
      // On, so startup's third await — the first control pass — is there.
      control: true,
      // The default, spelled out: a started worker holds the process, and a
      // hold taken after the close would keep it up for good.
      waitToExit: true,
    });
    options.closers?.push(async () => await worker.close({ force: true }));

    const driver = worker.driver;
    const calls = driver as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;

    let reached!: () => void;
    const held = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let wasReached = false;

    /** Holds the first call to `name` that `when` accepts, until the gate opens. */
    const hold = (name: string, when: (args: unknown[]) => boolean) => {
      const real = calls[name]!.bind(driver);
      let first = true;
      calls[name] = async (...args: unknown[]) => {
        if (first && when(args)) {
          first = false;
          wasReached = true;
          reached();
          await gate;
        }
        return await real(...args);
      };
    };

    if (options.stage === "connect" || options.stage === "ensureQueue") {
      hold(options.stage, () => true);
    } else if (options.stage === "control") {
      // The first control pass reads the key's configuration override.
      const name = workerConfigName(worker.key);
      hold("getQueueState", (args) => args[1] === name);
    }

    // Recorded above the gate, so the held call counts from when it was made.
    let closeCalled = false;
    let closeResolved = false;
    const callsAfterClose: string[] = [];
    const callsAfterClosed: string[] = [];
    let registered!: () => void;
    const firstReport = new Promise<void>((resolve) => {
      registered = resolve;
    });

    for (const name of methodNames(driver)) {
      const real = calls[name]!.bind(driver);
      calls[name] = (...args: unknown[]) => {
        if (closeCalled && RUNNING_CALLS.has(name)) {
          callsAfterClose.push(name);
        }
        if (closeResolved && RUNNING_CALLS.has(name)) {
          callsAfterClosed.push(name);
        }
        if (name === "registerWorker") {
          registered();
        }
        return real(...args);
      };
    }

    let closing = false;
    let readyAfterClosing = false;
    let readyFired!: () => void;
    const ready = new Promise<void>((resolve) => {
      readyFired = resolve;
    });
    worker.on("closing", () => {
      closing = true;
    });
    worker.on("ready", () => {
      readyAfterClosing ||= closing;
      readyFired();
    });

    const running = worker.run().then(
      () => "resolved",
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );

    if (options.stage !== "ready") {
      await held;
    } else {
      await ready;
      await firstReport;
      wasReached = true;
    }

    closeCalled = true;
    const closed = worker
      .close(options.force ? { force: true } : undefined)
      .then(() => {
        closeResolved = true;
      });
    const closedBeforeRelease = await Promise.race([
      closed.then(() => true),
      Bun.sleep(CLOSE_GRACE_MS).then(() => false),
    ]);
    release();
    await closed;
    const run = await running;
    await Bun.sleep(QUIET_MS);

    return {
      reached: wasReached,
      closedBeforeRelease,
      run,
      liveIntervals: [...intervals.live.values()],
      callsAfterClose,
      callsAfterClosed,
      readyAfterClosing,
      isRunning: worker.isRunning,
      state: worker.state,
    };
  } finally {
    intervals.restore();
  }
}

if (import.meta.main) {
  const options = JSON.parse(process.argv[2]!) as CloseDuringStartOptions;
  const observed = await closeDuringStart(options);
  // eslint-disable-next-line no-console -- the parent reads this line.
  console.log(
    JSON.stringify({
      ...observed,
      liveIntervals: observed.liveIntervals.length,
    }),
  );
}
