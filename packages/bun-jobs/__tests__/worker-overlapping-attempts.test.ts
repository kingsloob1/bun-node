import type {
  DriverConfig,
  JobsDriver,
  ProcessorContext,
  QueueRef,
} from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { BunQueue, BunQueueWorker, createDriver } from "../lib/index";
import { QueueLimiter } from "../lib/queue/limits";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * Two attempts at one job, running side by side on one worker (#187).
 *
 * At a concurrency above one, a worker's own stalled sweep can hand back a job
 * whose attempt is still running — its lock lapsed, the processor did not
 * notice — and the free slot claims it again. The worker then holds two
 * attempts at the same job. Its per-attempt state was keyed by job id, so the
 * second attempt's entries overwrote the first's, and when the abandoned
 * attempt ended its cleanup deleted the recovered attempt's:
 *
 * - its **heartbeat** was cleared, so its lock lapsed too and the job stalled a
 *   second time and died;
 * - it left the **in-flight count**, so the worker claimed past its
 *   concurrency;
 * - **`close()`** stopped waiting for it, and **a forced close** could no
 *   longer abort it;
 * - and the **limiter** was released once for two charged attempts.
 *
 * **How it is made certain.** The first claim's lock renewals are refused, so
 * its lock lapses on schedule while the heartbeat keeps running. Its processor
 * waits for its own worker's `stalled` event and, at concurrency 2, for the
 * recovered attempt to start, and only then returns. Every later step waits
 * on something the worker or the driver did — the abandoned completion being
 * answered, a renewal landing, a second stall — never on a guessed duration.
 * The one fixed wait is the graceful-close test's window, which is how long a
 * `close()` that should be waiting is given to finish early instead.
 *
 * **The control** is the same scenario at concurrency 1, where the re-claim
 * waits for the abandoned attempt to end and the two can never overlap.
 */

/** The lock each claim takes. The first claim's lapses once. */
const LOCK_MS = 600;
/** How often a held lock is renewed. */
const HEARTBEAT_MS = 100;
/** Longest any gate may hold, so a broken scenario fails instead of hanging. */
const GATE_MS = 10_000;
/** How long a graceful `close()` that should be waiting is given to return. */
const CLOSE_WINDOW_MS = 500;
/** The stalling job's name. */
const STALLS = "stalls";

const backendCleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(backendCleanups.map((cleanup) => cleanup()));
});

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** Memory, the file driver, SQLite and every configured server. */
const BACKENDS: { name: string; config: DriverConfig; available: boolean }[] = [
  { name: "memory", config: { type: "memory" }, available: true },
  ...(await crossProcessBackends({ cleanups: backendCleanups })),
];

/** A promise, the function that resolves it, and whether it has. */
function gate<T = void>() {
  let open!: (value: T) => void;
  const state = { opened: false };
  const promise = new Promise<T>((resolve) => {
    open = (value: T) => {
      state.opened = true;
      resolve(value);
    };
  });
  return {
    promise,
    open,
    get opened() {
      return state.opened;
    },
  };
}

/** Waits for `promise`, failing with `what` after {@link GATE_MS}. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${what}`)),
      GATE_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One macrotask turn: every microtask queued before it has run. */
async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** What a test does with the recovered attempt, and when it returns. */
type Recovered = (ctx: ProcessorContext) => Promise<void>;

/**
 * A worker that stalls one job and claims it again, with the attempts
 * overlapping when `overlap` is set (concurrency 2) and not otherwise
 * (concurrency 1, the control).
 */
async function stallTwice(
  config: DriverConfig,
  options: {
    overlap: boolean;
    /** Queue limits to store before the worker starts. */
    limits?: boolean;
  },
) {
  const driver = createDriver(config);
  const namespace = testNamespace("overlap");
  backendCleanups.push(async () => {
    await driver.purge(namespace).catch(() => undefined);
    await driver.close();
  });

  const concurrency = options.overlap ? 2 : 1;
  /** The first claim's lock: never renewed, so it lapses. */
  let firstToken: string | null = null;
  const recoveredStarted = gate();
  const abandonedSettled = gate();
  /** Opened by a test to let the abandoned attempt return. */
  const releaseAbandoned = gate();
  releaseAbandoned.open();
  let releaseGate = releaseAbandoned;
  const stalls = { count: 0, second: gate() };
  const firstStall = gate();
  /** Successful renewals of any lock but the first claim's. */
  const renewals = { count: 0 };
  const running = { now: 0, max: 0 };
  let recovered: Recovered = async () => {};

  const extend = driver.extendJobLock.bind(driver);
  const refusing: JobsDriver["extendJobLock"] = async (...args) => {
    if (args[2] === firstToken) {
      return false;
    }
    const held = await extend(...args);
    if (held) {
      renewals.count++;
    }
    return held;
  };
  driver.extendJobLock = refusing;

  /** Notes when the abandoned attempt's completion write has been answered. */
  const complete = driver.completeJob.bind(driver);
  const watched: JobsDriver["completeJob"] = async (...args) => {
    const kept = await complete(...args);
    if (args[2] === firstToken) {
      abandonedSettled.open();
    }
    return kept;
  };
  driver.completeJob = watched;
  if (driver.completeJobs) {
    const completeMany = driver.completeJobs.bind(driver);
    driver.completeJobs = async (...args) => {
      const settled = await completeMany(...args);
      if (args[1] === firstToken) {
        abandonedSettled.open();
      }
      return settled;
    };
  }

  const queue = new BunQueue("overlap", {
    namespace,
    driver,
    logger: noopLogger,
  });
  closers.push(() => queue.close());

  if (options.limits) {
    await queue.setLimits({ concurrency: 10 });
  }

  const worker = new BunQueueWorker(
    "overlap",
    async (job, ctx) => {
      running.now++;
      running.max = Math.max(running.max, running.now);
      try {
        if (job.name !== STALLS) {
          // A filler: holds its slot across one turn, so a claim that took
          // more than the free slots is caught running beside the rest.
          await turn();
          return "filler";
        }

        if (job.stalledCount === 0) {
          firstToken = job.lockToken;
          await within(firstStall.promise, "the stalled sweep");
          if (options.overlap) {
            await within(recoveredStarted.promise, "the recovered attempt");
          }
          await within(releaseGate.promise, "the test to release it");
          return "the abandoned attempt";
        }

        recoveredStarted.open();
        await recovered(ctx);
        return "the recovered attempt";
      } finally {
        running.now--;
      }
    },
    {
      namespace,
      driver,
      logger: noopLogger,
      concurrency,
      lockDuration: LOCK_MS,
      heartbeatInterval: HEARTBEAT_MS,
      stalledInterval: 50,
      pollInterval: 5,
      maintenance: false,
    },
  );
  closers.push(() => worker.close({ force: true }));

  worker.on("stalled", () => {
    stalls.count++;
    firstStall.open();
    if (stalls.count >= 2) {
      stalls.second.open();
    }
  });

  const ref: QueueRef = queue.ref;

  return {
    driver,
    queue,
    worker,
    ref,
    concurrency,
    recoveredStarted,
    abandonedSettled,
    stalls,
    renewals,
    running,
    /** Sets what the recovered attempt does before returning. */
    onRecovered(run: Recovered) {
      recovered = run;
    },
    /** Holds the abandoned attempt until the returned gate is opened. */
    holdAbandoned() {
      releaseGate = gate();
      return releaseGate;
    },
    /** Waits until the abandoned attempt has ended and been cleaned up. */
    async abandonedOver() {
      await within(abandonedSettled.promise, "the abandoned completion");
      await turn();
    },
    /** Starts the worker and adds the job that stalls. */
    async start() {
      void worker.run();
      return await queue.add(STALLS, {});
    },
    /** Waits for `id` to settle and returns how it ended. */
    async settled(id: string) {
      let record = await driver.getJob(ref, id);
      await waitFor(
        async () => {
          record = await driver.getJob(ref, id);
          return record?.state === "completed" || record?.state === "dead";
        },
        {
          timeout: LOCK_MS * 3 + GATE_MS,
          message: () =>
            `job never settled: ${JSON.stringify({ state: record?.state, stalls: stalls.count })}`,
        },
      );
      return {
        state: record?.state,
        returnValue: record?.returnValue,
        stalledCount: record?.stalledCount,
      };
    },
  };
}

/** How a job whose recovered attempt decided it ends. */
const RECOVERED = {
  state: "completed" as const,
  returnValue: "the recovered attempt",
  stalledCount: 1,
};

for (const { name, config, available } of BACKENDS) {
  for (const overlap of [true, false]) {
    const label = overlap
      ? "concurrency 2, attempts overlap"
      : "control: concurrency 1, attempts cannot overlap";

    describe.skipIf(!available)(
      `two attempts at one job (${label}): ${name}`,
      () => {
        it("keeps the recovered attempt's heartbeat, and its result", async () => {
          const h = await stallTwice(config, { overlap });
          h.onRecovered(async () => {
            await h.abandonedOver();
            // Two renewals of this attempt's lock after the abandoned one ended
            // prove its heartbeat survived — unless the job stalls again first,
            // which is what losing it looks like.
            const from = h.renewals.count;
            await within(
              Promise.race([
                waitFor(() => h.renewals.count >= from + 2, {
                  timeout: GATE_MS,
                }),
                h.stalls.second.promise,
              ]),
              "a renewal or a second stall",
            );
          });

          const job = await h.start();
          expect(await h.settled(job.id)).toEqual(RECOVERED);
          expect(h.stalls.count).toBe(1);
        }, 30_000);

        it("counts every attempt in flight, and never runs more than its concurrency", async () => {
          const h = await stallTwice(config, { overlap });
          const release = h.holdAbandoned();
          const counted = gate();
          const fillerStarted = gate();
          h.onRecovered(async () => {
            await within(counted.promise, "the count");
            if (overlap) {
              // Still running while the abandoned attempt's slot frees and is
              // refilled.
              await within(fillerStarted.promise, "a filler");
            }
          });
          h.worker.on("active", (job) => {
            if (job.name === "filler") {
              fillerStarted.open();
            }
          });

          const job = await h.start();
          if (!overlap) {
            // One slot: the recovered attempt waits for this one to end.
            release.open();
          }
          await within(h.recoveredStarted.promise, "the recovered attempt");
          await turn();

          // The probe: what the worker counts against its concurrency is what
          // is running. Both attempts hold a slot while they overlap.
          expect({
            counted: h.worker.activeCount,
            running: h.running.now,
          }).toEqual({
            counted: h.concurrency,
            running: h.concurrency,
          });
          counted.open();

          // Two jobs waiting, and one slot about to free: one may start, not two.
          const fillers = await Promise.all([
            h.queue.add("filler", {}),
            h.queue.add("filler", {}),
          ]);
          release.open();

          expect(await h.settled(job.id)).toEqual(RECOVERED);
          for (const filler of fillers) {
            expect((await h.settled(filler.id)).state).toBe("completed");
          }
          expect(h.running.max).toBeLessThanOrEqual(h.concurrency);
        }, 30_000);

        it("close() waits for the recovered attempt", async () => {
          const h = await stallTwice(config, { overlap });
          const ready = gate();
          const closed = gate();
          let closedWhileRunning: boolean | undefined;
          h.onRecovered(async () => {
            await h.abandonedOver();
            ready.open();
            // A close that waits cannot finish in this window; one that has
            // forgotten this attempt finishes almost at once.
            await Promise.race([closed.promise, Bun.sleep(CLOSE_WINDOW_MS)]);
            closedWhileRunning = closed.opened;
          });

          const job = await h.start();
          await within(ready.promise, "the recovered attempt");
          // A timeout past the window: the default, `lockDuration`, would give up
          // on the attempt at 600ms and abandon it, which is not waiting.
          await h.worker.close({ timeout: GATE_MS });
          closed.open();

          expect(closedWhileRunning).toBe(false);
          expect(await h.settled(job.id)).toEqual(RECOVERED);
        }, 30_000);

        it("close({ force: true }) aborts the recovered attempt", async () => {
          const h = await stallTwice(config, { overlap });
          const ready = gate();
          const closed = gate();
          const seen = gate<boolean>();
          h.onRecovered(async (ctx) => {
            await h.abandonedOver();
            ready.open();
            const aborted = new Promise<void>((resolve) =>
              ctx.signal.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
            // A forced close aborts first and waits for nothing, so an attempt
            // it knows of is aborted before `close()` returns.
            await Promise.race([aborted, closed.promise.then(turn)]);
            seen.open(ctx.signal.aborted);
          });

          await h.start();
          await within(ready.promise, "the recovered attempt");
          await h.worker.close({ force: true });
          closed.open();

          expect(await within(seen.promise, "the recovered attempt")).toBe(
            true,
          );
        }, 30_000);

        it("releases its limiter charge once per attempt", async () => {
          const released: string[] = [];
          const original = QueueLimiter.prototype.release;
          const spy = spyOn(
            QueueLimiter.prototype,
            "release",
          ).mockImplementation(function (this: QueueLimiter, jobName: string) {
            released.push(jobName);
            original.call(this, jobName);
          });

          try {
            const h = await stallTwice(config, { overlap, limits: true });
            h.onRecovered(async () => {
              await h.abandonedOver();
            });

            const job = await h.start();
            expect(await h.settled(job.id)).toEqual(RECOVERED);
            // Both attempts were charged when claimed; each ends in one release,
            // made as the attempt ends — before its completion is even written.
            await turn();
            expect(released.filter((one) => one === STALLS)).toEqual([
              STALLS,
              STALLS,
            ]);
          } finally {
            spy.mockRestore();
          }
        }, 30_000);
      },
    );
  }
}
