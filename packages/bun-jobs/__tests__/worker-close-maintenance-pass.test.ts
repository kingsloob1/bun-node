import type { DriverConfig, JobsDriver, QueueStateEntry } from "../lib/index";
import { createDeferred, noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { BunQueueWorker, createDriver } from "../lib/index";
import { testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * `close()` waits for a maintenance pass already under way, and a pass that
 * finds the worker closing takes nothing more.
 *
 * Each pass starts on a timer and used to run detached: `close()` cleared the
 * timers and released the sweep leases it had recorded, but a pass in flight
 * at that moment carried on behind it. The stalled pass then took the queue's
 * stalled-sweep lease *after* the release had looked, so a closed worker left
 * a lease naming itself that nothing would release — the queue's stalled
 * sweeps waited out its expiry (two cadences, a minute at the defaults) — and
 * went on calling the driver after `closed`. On the file driver that write
 * holds a lock whose heartbeat timer was still armed when `close()` resolved,
 * which is how worker-close-escalation.test.ts saw it under load.
 *
 * Nothing here sleeps to an interleaving: the pass is held inside its read of
 * the lease, or inside its write taking it, and let go by the `closing` event
 * — the first thing a close does, before it releases anything — or straight
 * after `stop()` was called, which releases synchronously up to its first wait.
 */

/** The queue-state entry holding the stalled-interval sweeps' lease. */
const STALLED_SWEEP_LEASE = "__win:fheal";

const cleanups: (() => Promise<void>)[] = [];
const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => cleanup()));
});

const BACKENDS = [
  {
    name: "memory",
    config: { type: "memory" } as DriverConfig,
    available: true,
  },
  ...(await crossProcessBackends({ cleanups })),
];

/** Where {@link setup} holds the first stalled pass. */
type Hold = "read" | "write";

/** What {@link setup} hands a test. */
interface Setup {
  /** The worker, on a driver the test owns, so it outlives the close. */
  worker: BunQueueWorker<unknown, string>;
  /** The driver, connected, shared with the worker. */
  driver: JobsDriver;
  /** Resolves when the stalled pass is at the held call, held there. */
  held: Promise<void>;
  /** Lets the held call go on. */
  letGo: () => void;
  /** Resolves when the held call has answered the pass. */
  answered: Promise<void>;
  /** Writes of the stalled lease, settled or not. */
  leaseWrites: Promise<unknown>[];
  /** Writes taking the stalled lease started once the close had begun. */
  takesWhileClosing: () => number;
  /** Driver calls the worker started after `close()` resolved, by name. */
  lateCalls: string[];
  /** The pass's lease reads and writes, and its recoveries, still running. */
  passCalls: () => number;
  /** Marks `close()` as resolved, from here on. */
  markClosed: () => void;
}

/**
 * A worker whose first stalled pass is held inside its read of the stalled
 * lease, or inside the write taking it, on a driver the test connected and
 * will purge.
 */
async function setup(config: DriverConfig, hold: Hold): Promise<Setup> {
  const namespace = testNamespace("close-pass");
  const driver = createDriver(config);
  await driver.connect();
  closers.push(async () => {
    await driver.purge(namespace).catch(() => undefined);
    await driver.close();
  });

  const reached = createDeferred<void>();
  const gate = createDeferred<void>();
  const answered = createDeferred<void>();
  const leaseWrites: Promise<unknown>[] = [];
  const lateCalls: string[] = [];
  let passCalls = 0;
  let takesWhileClosing = 0;
  let closing = false;
  let closed = false;
  let holding = false;

  // A view of the shared driver: the worker's calls go through it, the test's
  // own reads go to the driver itself.
  const view = new Proxy(driver, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function" || typeof prop !== "string") {
        return value;
      }
      const call = value as (...args: unknown[]) => unknown;

      return (...args: unknown[]) => {
        if (closed) {
          lateCalls.push(prop);
        }
        const lease =
          prop.endsWith("QueueState") && args[1] === STALLED_SWEEP_LEASE;
        const take = lease && prop === "setQueueState" && args[2] !== null;
        if (take && closing) {
          takesWhileClosing += 1;
        }
        const ofPass = lease || prop === "recoverStalled";
        if (ofPass) {
          passCalls += 1;
        }
        const done = () => {
          if (ofPass) {
            passCalls -= 1;
          }
        };

        let result: unknown;
        if (
          !holding &&
          lease &&
          prop === (hold === "read" ? "getQueueState" : "setQueueState")
        ) {
          holding = true;
          reached.resolve();
          result = (async () => {
            await gate.promise;
            try {
              return await call.apply(target, args);
            } finally {
              answered.resolve();
            }
          })();
        } else {
          result = call.apply(target, args);
        }

        if (!(result instanceof Promise)) {
          done();
          return result;
        }
        const settled = result.finally(done);
        if (lease && prop === "setQueueState") {
          leaseWrites.push(settled.catch(() => undefined));
        }
        return settled;
      };
    },
  });

  const worker = new BunQueueWorker("close-pass", async () => "done", {
    namespace,
    driver: view,
    logger: noopLogger,
    concurrency: 1,
    pollInterval: 10,
    waitToExit: false,
  });
  worker.on("error", () => {});
  worker.on("closing", () => {
    closing = true;
  });
  closers.push(async () => await worker.close({ force: true }));
  // Never left holding the pass, whatever a test does.
  closers.push(async () => gate.resolve());

  return {
    worker,
    driver,
    held: reached.promise,
    letGo: () => gate.resolve(),
    answered: answered.promise,
    leaseWrites,
    takesWhileClosing: () => takesWhileClosing,
    lateCalls,
    passCalls: () => passCalls,
    markClosed: () => {
      closed = true;
    },
  };
}

/**
 * Waits for whatever the held pass went on to do with the lease: the held
 * call answered, the pass given every microtask it can use to start a write,
 * and any write it started settled.
 */
async function passSettled(set: Setup): Promise<void> {
  await set.answered;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.allSettled(set.leaseWrites);
}

/** How long a close cut short may take to resolve. */
const PROMPT_MS = 3_000;

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

/** The stalled lease as stored, read past the worker's view. */
async function storedLease(set: Setup): Promise<QueueStateEntry | null> {
  return await set.driver.getQueueState!(set.worker.ref, STALLED_SWEEP_LEASE);
}

/** Who the stored stalled lease names, if anyone. */
async function leaseHolder(set: Setup): Promise<string | undefined> {
  const value = (await storedLease(set))?.value as
    | { holder?: string }
    | null
    | undefined;
  return value?.holder;
}

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `close() and a maintenance pass in flight (${backend.name})`,
    () => {
      for (const force of [false, true]) {
        const kind = force ? "a forced" : "a graceful";

        it(`${kind} close during the pass's lease read: it takes nothing, and the close waits for it`, async () => {
          const set = await setup(backend.config, "read");
          // The pass goes on as soon as the close begins — before the close
          // has released anything.
          set.worker.on("closing", () => set.letGo());

          void set.worker.run();
          await set.held;

          await set.worker.close({ force });
          set.markClosed();
          // Resolved only once the pass had finished with the driver.
          const runningAtClose = set.passCalls();

          await passSettled(set);
          // Nobody holds the stalled sweeps for a worker that has gone.
          expect(await storedLease(set)).toBeNull();
          // Found the worker closing, so it never tried.
          expect(set.takesWhileClosing()).toBe(0);
          expect(runningAtClose).toBe(0);
          expect(set.lateCalls).toEqual([]);
        }, 20_000);

        it(`${kind} close during the pass's lease write: the close waits for it, and gives the lease back`, async () => {
          const set = await setup(backend.config, "write");
          set.worker.on("closing", () => set.letGo());

          void set.worker.run();
          await set.held;

          await set.worker.close({ force });
          set.markClosed();
          const runningAtClose = set.passCalls();

          await passSettled(set);
          // The write began before the close, so the lease was taken — and
          // released, because the release waited to see it.
          expect(set.leaseWrites.length).toBeGreaterThanOrEqual(2);
          expect(await storedLease(set)).toBeNull();
          expect(runningAtClose).toBe(0);
          expect(set.lateCalls).toEqual([]);
        }, 20_000);
      }

      it("a graceful close waits for a pass that is slow to end", async () => {
        const set = await setup(backend.config, "read");

        void set.worker.run();
        await set.held;

        const closing = set.worker.close();
        expect(await within(closing, 300)).toBe("pending");
        set.letGo();
        expect(await within(closing, PROMPT_MS)).not.toBe("pending");
        set.markClosed();

        await passSettled(set);
        expect(await storedLease(set)).toBeNull();
        expect(set.takesWhileClosing()).toBe(0);
        expect(set.lateCalls).toEqual([]);
      }, 20_000);

      it("a force cuts that wait short, and the pass left behind takes nothing", async () => {
        const set = await setup(backend.config, "read");

        void set.worker.run();
        await set.held;

        const graceful = set.worker.close();
        expect(await within(graceful, 300)).toBe("pending");
        const forced = set.worker.close({ force: true });
        expect(await within(forced, PROMPT_MS)).not.toBe("pending");
        expect(await within(graceful, PROMPT_MS)).not.toBe("pending");

        // Still held: the close went on without it. Let go now, it stops at
        // its next step instead of taking a lease for a closed worker.
        set.letGo();
        await passSettled(set);
        expect(await storedLease(set)).toBeNull();
        expect(set.takesWhileClosing()).toBe(0);
      }, 20_000);

      it("a forced close waits a bounded time for a pass that does not end", async () => {
        const set = await setup(backend.config, "read");

        void set.worker.run();
        await set.held;

        expect(
          await within(set.worker.close({ force: true }), PROMPT_MS),
        ).not.toBe("pending");

        set.letGo();
        await passSettled(set);
        expect(await storedLease(set)).toBeNull();
        expect(set.takesWhileClosing()).toBe(0);
      }, 20_000);

      it("a stop during the pass's lease read: the parked worker takes no lease", async () => {
        const set = await setup(backend.config, "read");

        void set.worker.run();
        await set.held;

        const stopping = set.worker.stop();
        // `stop()` has run up to its first wait, its release included.
        set.letGo();
        await stopping;

        await passSettled(set);
        expect(await leaseHolder(set)).toBeUndefined();
        expect(set.worker.isStopped()).toBe(true);
      }, 20_000);

      it("control: a lease taken before the close is released by it", async () => {
        const set = await setup(backend.config, "read");

        void set.worker.run();
        await set.held;
        set.letGo();
        await passSettled(set);
        // The pass took the lease, and the worker recorded it.
        expect(set.leaseWrites).toHaveLength(1);
        expect(await leaseHolder(set)).toBe(set.worker.id);

        await set.worker.close();
        set.markClosed();
        expect(await storedLease(set)).toBeNull();
      }, 20_000);
    },
  );
}
