import type { SerializedError } from "@kingsleyweb/bun-common";
import type {
  ClaimOptions,
  FailOutcome,
  IsolationMode,
  JobRecord,
  QueueRef,
  RunProgress,
} from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, BunQueueWorker, MemoryDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * A timed-out job's progress must be written before its failure record.
 *
 * `#process` runs an isolated attempt inside `withTimeout`, which rejects the
 * moment the deadline passes and leaves the run to be abandoned — so the
 * barrier that `IsolatedProcessor.run()` keeps in its `finally`, where the
 * progress writes the child asked for are awaited, never runs on this path.
 * The worker went straight to the failure record, and a progress write still
 * in flight landed on top of a job that was already dead.
 *
 * These tests remove the race: the slow driver below times its progress write
 * off the *claim*, so the write is certainly in flight when the deadline
 * passes and certainly finishes shortly after it. Nothing here depends on how
 * long a child takes to start.
 */

/** The deadline every job here is given, in ms. Longer than any child's start. */
const TIMEOUT_MS = 2_000;
/** How long after the deadline the driver lets a progress write finish. */
const OVERRUN_MS = 80;

/** One write the driver made, in the order it finished. */
interface Write {
  /** Which write it was. */
  kind: "progress" | "fail";
  /** The value written, for a progress write. */
  value?: RunProgress;
  /** When it finished, so a test can price the wait it caused. */
  at: number;
}

/** A memory driver whose progress writes straddle the job's deadline. */
class DeadlineProgressDriver extends MemoryDriver {
  /** Every progress and failure write, in the order each finished. */
  readonly writes: Write[] = [];
  /** When the job under test was claimed: the deadline is measured from it. */
  claimedAt = 0;
  /** Whether a progress write should hang for good rather than land late. */
  hang = false;
  /** Whether progress writes should land at once instead of straddling the deadline. */
  instant = false;

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

  override async updateProgress(
    q: QueueRef,
    id: string,
    // `unknown`, as the driver contract has it: a stored record may hold
    // anything, and narrowing here would make this driver unassignable.
    value: unknown,
  ): Promise<boolean> {
    if (this.hang) {
      // A driver that never answers — what the worker's bound is there for.
      await new Promise<never>(() => {});
    }
    if (!this.instant) {
      // Land just after the deadline, whenever the child happened to report.
      const until = this.claimedAt + TIMEOUT_MS + OVERRUN_MS;
      const wait = until - Date.now();
      if (wait > 0) {
        await Bun.sleep(wait);
      }
    }
    const done = await super.updateProgress(q, id, value);
    this.writes.push({
      kind: "progress",
      value: value as RunProgress,
      at: Date.now(),
    });
    return done;
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
}

const handler = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** A queue and a worker running `file` in `mode`, on the deadline driver. */
function setup(mode: IsolationMode, file: string) {
  const driver = new DeadlineProgressDriver();
  const namespace = testNamespace();
  const queue = new BunQueue("progress-timeout", {
    namespace,
    driver,
    logger: noopLogger,
  });
  const worker = new BunQueueWorker("progress-timeout", handler(file), {
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
    {
      timeout: 20_000,
      interval: 2,
      message: `the ${what} job never died`,
    },
  );

  return { id: job.id, progressAtDeath };
}

for (const mode of ["spawn", "worker"] as const) {
  describe(`progress ordering on timeout: ${mode}`, () => {
    it("writes the progress the child reported before the failure record", async () => {
      const { driver, queue } = setup(mode, "job-progress-timeout");

      const { progressAtDeath } = await runUntilDead(queue, mode);

      // Both writes have landed by now, one way or the other.
      await waitFor(() => driver.writes.length >= 2, {
        timeout: 5_000,
        message: () =>
          `only ${JSON.stringify(driver.writes)} was written for the ${mode} job`,
      });

      expect(driver.writes.map((write) => write.kind)).toEqual([
        "progress",
        "fail",
      ]);
      // And a reader that waited for the job to die saw the reported value.
      expect(progressAtDeath).toBe(50);
    }, 30_000);
  });
}

describe("progress ordering on timeout: drop after the deadline", () => {
  it("writes nothing a child sends once the attempt is over", async () => {
    const { driver, queue } = setup("worker", "job-progress-chatty");
    // The chatty child reports every 25ms; the point here is what happens to
    // the values it sends while it is being stopped, so the writes are quick.
    driver.instant = true;

    await runUntilDead(queue, "chatty");

    // Whatever it managed to report, the failure record is the last write:
    // nothing lands on a job the worker has already given up on.
    await Bun.sleep(500);
    const kinds = driver.writes.map((write) => write.kind);
    expect(kinds.filter((kind) => kind === "fail")).toHaveLength(1);
    expect(kinds.at(-1)).toBe("fail");
  }, 30_000);
});

describe("progress ordering on timeout: a driver that never answers", () => {
  it("records the failure without waiting for the write", async () => {
    const { driver, queue } = setup("worker", "job-progress-timeout");
    driver.hang = true;

    await runUntilDead(queue, "hanging");

    const failed = driver.writes.find((write) => write.kind === "fail");
    expect(failed).toBeDefined();
    // The bound, not the hung write, is what the failure record waited for.
    expect(failed!.at - (driver.claimedAt + TIMEOUT_MS)).toBeLessThan(1_500);
  }, 30_000);
});
