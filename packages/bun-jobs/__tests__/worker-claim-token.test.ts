import type { DriverConfig, JobsDriver } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { BunQueue, BunQueueWorker, createDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * A job's lock token belongs to one claim, not to the worker that made it
 * (#187).
 *
 * The worker used to mint one token in its constructor and stamp it on every
 * claim, so when it re-claimed a job its own stalled sweep had requeued, the
 * new claim carried the *same* token as the abandoned one. The abandoned
 * attempt's completion — deliberately not awaited, so its slot frees before
 * it lands — then matched the drivers' `state = 'active' AND lock_token = ?`
 * guard and recorded the abandoned attempt's result over the recovered one,
 * whose own completion was refused afterwards. Its heartbeat, `extendLock()`
 * and `fail()` matched the new claim the same way.
 *
 * **How the race is made certain rather than hoped for.** The abandoned
 * attempt's completion write — the first `completeJob` call — is held until
 * the recovered attempt has started, which is exactly the window a loaded
 * machine or a slow round trip opens. The recovered attempt then waits until
 * that write has been answered before it returns, so it is still running, well
 * inside its lock, when the write lands. Nothing here is a timing guess: the
 * only duration is the lock, and it only has to lapse once.
 *
 * The control runs the same scenario with nothing held: the abandoned write
 * lands before the re-claim and is refused, so the recovered result wins with
 * or without the fix. That is what shows the held write is the variable.
 */

/** The lock each claim takes. Lapsing it once is how the job stalls. */
const LOCK_MS = 600;
/** Longest any gate below may hold, so a broken scenario fails instead of hanging. */
const GATE_MS = 10_000;

/** Temp directories and server namespaces to release once the suite ends. */
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

/** A promise and the function that resolves it. */
function gate<T = void>(): { promise: Promise<T>; open: (value: T) => void } {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
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

/** What an abandoned claim's renewals did to the recovered claim's lock. */
interface Renewal {
  /** The recovered claim's lock expiry before the abandoned attempt renewed. */
  before: number | null;
  /** What the abandoned attempt's `job.extendLock()` answered. */
  extendLock: boolean;
  /** The lock expiry after `job.extendLock()`. */
  afterExtendLock: number | null;
  /** The lock expiry after the abandoned attempt's `ctx.heartbeat()`. */
  afterHeartbeat: number | null;
}

/**
 * Runs one job that stalls once under a single worker and is re-claimed by
 * that same worker, and reports how it ended.
 *
 * - `hold` holds the first completion write (the abandoned attempt's) until
 *   the recovered attempt has started.
 * - `renew` has the abandoned attempt, once the recovered one is running,
 *   renew the lock through `job.extendLock()` and `ctx.heartbeat()`.
 */
async function stallAndRecover(
  config: DriverConfig,
  options: { hold: boolean; renew?: boolean },
) {
  const driver = createDriver(config);
  const namespace = testNamespace("claim-token");
  backendCleanups.push(async () => {
    await driver.purge(namespace).catch(() => undefined);
    await driver.close();
  });

  const recoveredStarted = gate();
  const renewed = gate();
  /** How each completion write was answered, in order. */
  const answered: string[] = [];
  const firstAnswer = gate();

  if (options.hold) {
    const original = driver.completeJob.bind(driver);
    let calls = 0;
    const held: JobsDriver["completeJob"] = async (...args) => {
      if (++calls === 1) {
        await within(recoveredStarted.promise, "the recovered attempt");
      }
      return await original(...args);
    };
    driver.completeJob = held;
  }

  const queue = new BunQueue("claim-token", {
    namespace,
    driver,
    logger: noopLogger,
  });
  closers.push(() => queue.close());

  const stalled = gate();
  let attempts = 0;
  let renewal: Renewal | undefined;

  const worker = new BunQueueWorker(
    "claim-token",
    async (job, ctx) => {
      attempts++;

      if (job.stalledCount === 0) {
        // The first attempt outlives its lock: it waits for this worker's own
        // sweep to take the job back, then finishes as if nothing happened.
        await within(stalled.promise, "the stalled sweep");

        if (options.renew) {
          // Once this attempt has returned and the job is claimed again, its
          // own view of the job and its context are still in hand — as they
          // are for a heartbeat already in flight, or a processor that kept a
          // reference. At concurrency 1 the re-claim waits for this return, so
          // the renewals have to come after it.
          void (async () => {
            await within(recoveredStarted.promise, "the recovered attempt");
            const lockOf = async () =>
              (await driver.getJob(queue.ref, job.id))?.lockExpiresAt ?? null;
            const before = await lockOf();
            // Time must move, or a renewal that did land could leave the
            // expiry where it was.
            await Bun.sleep(5);
            const extendLock = await job.extendLock(60_000);
            const afterExtendLock = await lockOf();
            await Bun.sleep(5);
            await ctx.heartbeat();
            renewal = {
              before,
              extendLock,
              afterExtendLock,
              afterHeartbeat: await lockOf(),
            };
          })()
            .catch(() => undefined)
            .finally(() => renewed.open());
        }

        return "the abandoned attempt";
      }

      recoveredStarted.open();
      if (options.renew) {
        await within(renewed.promise, "the abandoned attempt's renewals");
      }
      // Still running when the abandoned attempt's completion is answered,
      // however it is answered: that write must not decide this job.
      await within(firstAnswer.promise, "the abandoned completion's answer");
      return "the recovered attempt";
    },
    {
      namespace,
      driver,
      logger: noopLogger,
      concurrency: 1,
      lockDuration: LOCK_MS,
      // No renewals: the first attempt has to lose its lock.
      heartbeatInterval: 60_000,
      stalledInterval: 50,
      pollInterval: 5,
      maintenance: false,
    },
  );
  closers.push(() => worker.close({ force: true }));

  worker.on("stalled", () => stalled.open());
  worker.on("completed", (_job, value) => {
    answered.push(`completed ${String(value)}`);
    firstAnswer.open();
  });
  worker.on("lockLost", () => {
    answered.push("lockLost");
    firstAnswer.open();
  });

  void worker.run();
  const added = await queue.add("once", {});

  let record = await driver.getJob(queue.ref, added.id);
  await waitFor(
    async () => {
      record = await driver.getJob(queue.ref, added.id);
      return record?.state === "completed" || record?.state === "dead";
    },
    {
      timeout: LOCK_MS + GATE_MS,
      message: () =>
        `job never settled: ${JSON.stringify({ state: record?.state, attempts, answered })}`,
    },
  );

  return {
    outcome: {
      state: record?.state,
      returnValue: record?.returnValue,
      stalledCount: record?.stalledCount,
      attempts,
    },
    renewal,
    answered,
  };
}

/** How every scenario below should end: the recovered attempt decides it. */
const RECOVERED = {
  state: "completed" as const,
  returnValue: "the recovered attempt",
  stalledCount: 1,
  attempts: 2,
};

for (const { name, config, available } of BACKENDS) {
  describe.skipIf(!available)(`a re-claimed job's lock: ${name}`, () => {
    it("keeps the recovered attempt's result when the abandoned completion lands late", async () => {
      const { outcome, answered } = await stallAndRecover(config, {
        hold: true,
      });

      expect(outcome).toEqual(RECOVERED);
      // The abandoned write was refused — the job was no longer its to settle
      // — and the recovered one landed.
      expect(answered).toEqual(["lockLost", "completed the recovered attempt"]);
    }, 30_000);

    it("control: keeps the recovered attempt's result when nothing holds the abandoned completion", async () => {
      const { outcome } = await stallAndRecover(config, { hold: false });

      expect(outcome).toEqual(RECOVERED);
    }, 30_000);

    it("does not let the abandoned claim renew the recovered claim's lock", async () => {
      const { outcome, renewal } = await stallAndRecover(config, {
        hold: false,
        renew: true,
      });

      expect(renewal).toBeDefined();
      expect(renewal!.before).not.toBeNull();
      expect({
        extendLock: renewal!.extendLock,
        afterExtendLock: renewal!.afterExtendLock,
        afterHeartbeat: renewal!.afterHeartbeat,
      }).toEqual({
        extendLock: false,
        afterExtendLock: renewal!.before,
        afterHeartbeat: renewal!.before,
      });
      expect(outcome).toEqual(RECOVERED);
    }, 30_000);
  });
}

describe("a claim's token", () => {
  /** Runs `count` jobs one at a time on one worker, and returns their tokens. */
  async function tokensOf(count: number, afterConstruct?: () => void) {
    const driver = createDriver({ type: "memory" });
    const namespace = testNamespace("claim-token-fresh");
    const tokens: string[] = [];
    const queue = new BunQueue("fresh", {
      namespace,
      driver,
      logger: noopLogger,
    });
    const worker = new BunQueueWorker(
      "fresh",
      async (job) => {
        tokens.push(job.lockToken ?? "");
      },
      {
        namespace,
        driver,
        logger: noopLogger,
        concurrency: 1,
        pollInterval: 5,
      },
    );
    closers.push(() => queue.close());
    closers.push(() => worker.close({ force: true }));
    afterConstruct?.();

    void worker.run();
    for (let at = 0; at < count; at++) {
      const job = await queue.add("x", {});
      await waitFor(
        async () =>
          (await driver.getJob(queue.ref, job.id))?.state === "completed",
      );
    }

    return { tokens, workerId: worker.id };
  }

  it("differs on every claim by the same worker, and is not derived from the worker", async () => {
    const { tokens, workerId } = await tokensOf(4);

    expect(tokens.every((token) => token.length > 0)).toBe(true);
    expect(new Set(tokens).size).toBe(tokens.length);

    // `host:pid:<uuid>:<worker id>`. The uuid is the part that makes a token
    // unique, and it must be a random (v4) one: not a counter, and not a
    // time-ordered v7 whose neighbours share a prefix.
    const uuids = tokens.map((token) => token.split(":")[2] ?? "");
    for (const uuid of uuids) {
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(workerId).not.toContain(uuid);
    }
    // Consecutive claims share no leading run a counter or a clock would give
    // them — past the handful of characters two random values share by chance.
    const shared = (a: string, b: string) => {
      let at = 0;
      while (at < a.length && a[at] === b[at]) at++;
      return at;
    };
    for (let at = 1; at < uuids.length; at++) {
      expect(shared(uuids[at - 1]!, uuids[at]!)).toBeLessThan(8);
    }
  });

  it("is drawn from the CSPRNG at claim time, not at construction", async () => {
    const drawn: string[] = [];
    const original = crypto.randomUUID.bind(crypto);
    let spy: ReturnType<typeof spyOn> | undefined;

    try {
      const { tokens } = await tokensOf(2, () => {
        // Installed only once the worker exists, so anything it computed in its
        // constructor is invisible here: a snapshot of a process after init,
        // restored into several VMs, would replay exactly that.
        spy = spyOn(crypto, "randomUUID").mockImplementation(() => {
          const value = original();
          drawn.push(value);
          return value;
        });
      });

      for (const token of tokens) {
        expect(drawn).toContain(token.split(":")[2] ?? "");
      }
    } finally {
      spy?.mockRestore();
    }
  });
});
