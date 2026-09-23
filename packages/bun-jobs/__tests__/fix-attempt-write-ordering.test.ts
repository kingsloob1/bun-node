import type { SerializedError } from "@kingsleyweb/bun-common";
import type {
  ClaimOptions,
  FailOutcome,
  IsolationMode,
  JobRecord,
  QueueRef,
  Retention,
  RunProgress,
} from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, BunQueueWorker, MemoryDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * Every write a job made lands before the record of how that job ended — in
 * every isolation mode, and on every ending.
 *
 * #115 ordered an isolated processor's progress against its completion, and
 * #117 kept that ordering when a deadline abandoned the run. Two holes were
 * left, and both are closed here:
 *
 * - **`job.log` from a child.** The line is a real round trip, so a child
 *   that waited for it has it stored — but the worker answers the request from
 *   `void answer(...)`, so a line still in flight when the attempt ends could
 *   land after the ending record. Nothing about that is timeout-specific: the
 *   completion write is deliberately not awaited either.
 * - **`"in-process"` mode.** There is no fire-and-forget hop to order: the
 *   processor calls the real `Job.updateProgress` and awaits it. A deadline
 *   abandons it wherever it stands, including inside that write, and the
 *   worker had no handle on it.
 *
 * The drivers below remove the race rather than hoping for it: a write timed
 * off the *claim* is certainly in flight when the deadline passes and
 * certainly finishes shortly after it, and a write given a flat delay is
 * certainly in flight when a processor that does not wait for it returns.
 */

/** The deadline every timed-out job here is given, in ms. */
const TIMEOUT_MS = 2_000;
/** How long after the deadline a straddling write is let finish. */
const OVERRUN_MS = 80;
/** How long a flat-delay write takes, for the ordinary completion path. */
const SLOW_WRITE_MS = 80;

/** One write the driver made, in the order it finished. */
interface Write {
  /** Which write it was. */
  kind: "complete" | "fail" | "log" | "progress";
  /** The value written, for a progress write. */
  value?: RunProgress;
  /** The line written, for a log write. */
  line?: string;
  /** When it finished, so a test can price the wait it caused. */
  at: number;
}

/** A memory driver whose progress and log writes outlive the attempt. */
class LateWriteDriver extends MemoryDriver {
  /** Every write that records something about the job, in finishing order. */
  readonly writes: Write[] = [];
  /** When the job under test was claimed: the deadline is measured from it. */
  claimedAt = 0;
  /**
   * How a tracked write is delayed. `"deadline"` lands it `OVERRUN_MS` after
   * the job's deadline, a number is a flat delay in ms, and `"hang"` never
   * answers at all — what the worker's bound is there for.
   */
  delay: "deadline" | "hang" | number = "deadline";

  override async claimJob(
    q: QueueRef,
    opts: ClaimOptions,
  ): Promise<JobRecord | null> {
    const record = await super.claimJob(q, opts);
    if (record) {
      this.claimedAt = Date.now();
    }
    return record;
  }

  /** Holds a write back the way {@link LateWriteDriver.delay} asks. */
  async #hold(): Promise<void> {
    const delay = this.delay;

    if (delay === "hang") {
      // Never answers; the `return` is only how the narrowing below is spelled.
      await new Promise<never>(() => {});
      return;
    }

    if (delay === "deadline") {
      const wait = this.claimedAt + TIMEOUT_MS + OVERRUN_MS - Date.now();
      if (wait > 0) {
        await Bun.sleep(wait);
      }
      return;
    }

    await Bun.sleep(delay);
  }

  override async updateProgress(
    q: QueueRef,
    id: string,
    // `unknown`, as the driver contract has it: a stored record may hold
    // anything, and narrowing here would make this driver unassignable.
    value: unknown,
  ): Promise<boolean> {
    await this.#hold();
    const done = await super.updateProgress(q, id, value);
    this.writes.push({
      kind: "progress",
      value: value as RunProgress,
      at: Date.now(),
    });
    return done;
  }

  override async addJobLog(
    q: QueueRef,
    id: string,
    line: string,
    keep: number,
  ): Promise<number> {
    await this.#hold();
    const count = await super.addJobLog(q, id, line, keep);
    this.writes.push({ kind: "log", line, at: Date.now() });
    return count;
  }

  override async failJob(
    q: QueueRef,
    id: string,
    token: string,
    error: SerializedError,
    outcome: FailOutcome,
    now: number,
    keepStacktraces: number,
  ): Promise<boolean> {
    const done = await super.failJob(
      q,
      id,
      token,
      error,
      outcome,
      now,
      keepStacktraces,
    );
    this.writes.push({ kind: "fail", at: Date.now() });
    return done;
  }

  override async completeJob(
    q: QueueRef,
    id: string,
    token: string,
    result: unknown,
    retention: Retention,
    now: number,
  ): Promise<boolean> {
    const done = await super.completeJob(q, id, token, result, retention, now);
    this.writes.push({ kind: "complete", at: Date.now() });
    return done;
  }
}

const handler = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** A queue and a worker running `file` in `mode`, on the late-write driver. */
function setup(mode: IsolationMode, file: string) {
  const driver = new LateWriteDriver();
  const namespace = testNamespace();
  const queue = new BunQueue("attempt-writes", {
    namespace,
    driver,
    logger: noopLogger,
  });
  const worker = new BunQueueWorker("attempt-writes", handler(file), {
    namespace,
    driver,
    logger: noopLogger,
    pollInterval: 5,
    isolation: mode,
    isolationOptions: { closeTimeout: 200, killTimeout: 200 },
    waitToExit: false,
  });
  closers.push(
    () => queue.close(),
    () => worker.close({ force: true }),
  );
  void worker.run();
  return { driver, queue, worker };
}

/** Adds one job that will overrun `TIMEOUT_MS`, and reads it the moment it dies. */
async function runUntilDead(
  queue: BunQueue,
  what: string,
): Promise<{ id: string; progressAtDeath: unknown }> {
  const job = await queue.add(
    "slow",
    {},
    { attempts: 1, timeout: TIMEOUT_MS, removeOnFail: false },
  );
  let progressAtDeath: unknown;

  // Read on the same poll that first sees the job dead: that is the earliest
  // a reader could look, and what it finds is the whole point.
  await waitFor(
    async () => {
      const stored = await queue.getJob(job.id);
      if (stored?.state !== "dead") {
        return false;
      }
      progressAtDeath = stored.progress;
      return true;
    },
    { timeout: 20_000, interval: 2, message: `the ${what} job never died` },
  );

  return { id: job.id, progressAtDeath };
}

/** Adds one job that returns normally, and waits for it to be `completed`. */
async function runUntilDone(
  queue: BunQueue,
  what: string,
  data: unknown = {},
): Promise<string> {
  const job = await queue.add("quick", data, {
    attempts: 1,
    removeOnComplete: false,
  });

  await waitFor(
    async () => (await queue.getJob(job.id))?.state === "completed",
    {
      timeout: 20_000,
      interval: 2,
      message: `the ${what} job never completed`,
    },
  );

  return job.id;
}

/* --- residual 1: a log line from a child ---------------------------------- */

for (const mode of ["spawn", "worker"] as const) {
  describe(`attempt write ordering: ${mode} job.log`, () => {
    it("writes a log line the child asked for before the failure record", async () => {
      const { driver, queue } = setup(mode, "job-log-timeout");

      await runUntilDead(queue, `${mode} log`);

      await waitFor(() => driver.writes.length >= 2, {
        timeout: 5_000,
        message: () =>
          `only ${JSON.stringify(driver.writes)} was written for the ${mode} job`,
      });

      expect(driver.writes.map((write) => write.kind)).toEqual(["log", "fail"]);
    }, 30_000);

    it("writes a log line the child did not wait for before the completion record", async () => {
      const { driver, queue } = setup(mode, "job-log-fire-and-forget");
      driver.delay = SLOW_WRITE_MS;

      const id = await runUntilDone(queue, `${mode} fire-and-forget log`);

      await waitFor(() => driver.writes.length >= 2, {
        timeout: 5_000,
        message: () =>
          `only ${JSON.stringify(driver.writes)} was written for the ${mode} job`,
      });

      expect(driver.writes.map((write) => write.kind)).toEqual([
        "log",
        "complete",
      ]);
      // And the line is readable the moment the job reads back `completed`.
      expect((await queue.getJob(id))?.state).toBe("completed");
    }, 30_000);
  });
}

describe("attempt write ordering: a chatty child's log", () => {
  it("stores every line before the completion, without serialising them", async () => {
    const lines = 50;
    const { driver, queue } = setup("worker", "job-log-many");
    driver.delay = SLOW_WRITE_MS;

    await runUntilDone(queue, "chatty log", { lines });

    await waitFor(() => driver.writes.length >= lines + 1, {
      timeout: 10_000,
      message: () => `only ${driver.writes.length} writes landed`,
    });

    const kinds = driver.writes.map((write) => write.kind);
    expect(kinds.filter((kind) => kind === "log")).toHaveLength(lines);
    expect(kinds.at(-1)).toBe("complete");
    // Concurrent, not chained: 50 writes of `SLOW_WRITE_MS` each would take
    // 4 seconds one at a time, and they are independent of one another.
    const first = driver.writes[0]!.at;
    const last = driver.writes.at(-1)!.at;
    expect(last - first).toBeLessThan(lines * SLOW_WRITE_MS * 0.5);
  }, 30_000);
});

/* --- residual 2: in-process mode ------------------------------------------ */

describe("attempt write ordering: in-process", () => {
  it("writes the progress the processor reported before the failure record", async () => {
    const { driver, queue } = setup("in-process", "job-progress-timeout");

    const { progressAtDeath } = await runUntilDead(queue, "in-process");

    await waitFor(() => driver.writes.length >= 2, {
      timeout: 5_000,
      message: () =>
        `only ${JSON.stringify(driver.writes)} was written in-process`,
    });

    expect(driver.writes.map((write) => write.kind)).toEqual([
      "progress",
      "fail",
    ]);
    expect(progressAtDeath).toBe(50);
  }, 30_000);

  it("writes nothing the processor reports once the attempt is over", async () => {
    // Abandoning an in-process attempt does not stop the function: it keeps
    // reporting into a job the worker has already failed. Those values are
    // dropped, as a child's are.
    const { driver, queue } = setup(
      "in-process",
      "job-progress-after-deadline",
    );
    driver.delay = 0;

    await runUntilDead(queue, "in-process chatty");

    await Bun.sleep(500);
    const kinds = driver.writes.map((write) => write.kind);
    expect(kinds.filter((kind) => kind === "fail")).toHaveLength(1);
    expect(kinds.at(-1)).toBe("fail");
  }, 30_000);

  it("writes a log line the processor asked for before the failure record", async () => {
    const { driver, queue } = setup("in-process", "job-log-timeout");

    await runUntilDead(queue, "in-process log");

    await waitFor(() => driver.writes.length >= 2, {
      timeout: 5_000,
      message: () =>
        `only ${JSON.stringify(driver.writes)} was written in-process`,
    });

    expect(driver.writes.map((write) => write.kind)).toEqual(["log", "fail"]);
  }, 30_000);
});

describe("attempt write ordering: a plain function processor", () => {
  it("writes the progress it reported before the failure record", async () => {
    const driver = new LateWriteDriver();
    const namespace = testNamespace();
    const queue = new BunQueue("attempt-writes", {
      namespace,
      driver,
      logger: noopLogger,
    });
    // No processor file at all: the commonest shape of worker there is, and
    // the one that never went near an isolated attempt's barrier.
    const worker = new BunQueueWorker(
      "attempt-writes",
      async (job) => {
        await job.updateProgress(50);
        await Bun.sleep(30_000);
        return "done";
      },
      { namespace, driver, logger: noopLogger, pollInterval: 5 },
    );
    closers.push(
      () => queue.close(),
      () => worker.close({ force: true }),
    );
    void worker.run();

    const { progressAtDeath } = await runUntilDead(queue, "inline");

    await waitFor(() => driver.writes.length >= 2, {
      timeout: 5_000,
      message: () => `only ${JSON.stringify(driver.writes)} was written inline`,
    });

    expect(driver.writes.map((write) => write.kind)).toEqual([
      "progress",
      "fail",
    ]);
    expect(progressAtDeath).toBe(50);
  }, 30_000);
});

/* --- neither bound may be waived ------------------------------------------- */

describe("attempt write ordering: a write that never answers", () => {
  it("completes the job and takes the next one rather than holding its slot", async () => {
    const driver = new LateWriteDriver();
    driver.delay = "hang";
    const namespace = testNamespace();
    const queue = new BunQueue("attempt-writes", {
      namespace,
      driver,
      logger: noopLogger,
    });
    // A quarter of `lockDuration` is the barrier's budget on this path, so a
    // short lock makes it a second rather than the default seven and a half.
    const lockDuration = 4_000;
    const worker = new BunQueueWorker(
      "attempt-writes",
      async (job) => {
        if ((job.data as { hang?: boolean }).hang) {
          // Not awaited, and the driver never answers it: before the barrier
          // was capped this pinned the worker's only slot for good.
          void job.log("never answered").catch(() => undefined);
        }
        return "done";
      },
      {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 5,
        concurrency: 1,
        lockDuration,
      },
    );
    closers.push(
      () => queue.close(),
      () => worker.close({ force: true }),
    );

    const hanging = await queue.add(
      "hangs",
      { hang: true },
      { attempts: 1, removeOnComplete: false },
    );
    const next = await queue.add(
      "next",
      { hang: false },
      { attempts: 1, removeOnComplete: false },
    );
    const started = Date.now();
    void worker.run();

    // The job whose write never answered is recorded anyway...
    await waitFor(
      async () => (await queue.getJob(hanging.id))?.state === "completed",
      {
        timeout: 20_000,
        interval: 5,
        message: "the job with a hung write was never completed",
      },
    );
    // ...and the slot it held is free, which is what the cap is for. A worker
    // at concurrency 1 can only reach this one by letting the other go.
    await waitFor(
      async () => (await queue.getJob(next.id))?.state === "completed",
      {
        timeout: 20_000,
        interval: 5,
        message: "the worker never took its next job",
      },
    );

    // Comfortably inside the lock, and nowhere near the 20s the waits allow.
    expect(Date.now() - started).toBeLessThan(lockDuration);
    // The log line itself never landed: the cap is a cap, not a retry.
    expect(driver.writes.map((write) => write.kind)).toEqual([
      "complete",
      "complete",
    ]);
  }, 40_000);
});

/* --- the bound covers both kinds of write --------------------------------- */

describe("attempt write ordering: a driver that never answers", () => {
  it("records the failure without waiting for a hung log write", async () => {
    const { driver, queue } = setup("worker", "job-log-timeout");
    driver.delay = "hang";

    await runUntilDead(queue, "hanging log");

    const failed = driver.writes.find((write) => write.kind === "fail");
    expect(failed).toBeDefined();
    // The bound, not the hung write, is what the failure record waited for.
    expect(failed!.at - (driver.claimedAt + TIMEOUT_MS)).toBeLessThan(1_500);
  }, 30_000);
});
