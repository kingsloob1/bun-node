import type {
  QueueRef,
  Retention,
  RunProgress,
  WorkerTargetMode,
} from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, BunQueueWorker, MemoryDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * A job's progress must be written before its completion is.
 *
 * In a worker-thread or child-process target the processor's
 * `job.updateProgress()` is a message to
 * the worker, which owns the driver. That write used to be fired and
 * forgotten, so a slow driver could land it *after* the completion — and a
 * reader that waited for `state === "completed"` read the previous value.
 * These tests make the driver's progress write slow, which turns a race that
 * showed up in about a fifth of runs on MySQL — and never on a memory driver
 * whose writes are immediate — into a certainty. The `in-process` arm is the
 * control: there the processor holds the driver itself, so it was ordered all
 * along and must stay that way.
 */

/** How long the slow driver below holds every progress write back. */
const PROGRESS_DELAY_MS = 150;

/** One write the driver made, in the order it landed. */
type Write = { kind: "progress"; value: RunProgress } | { kind: "complete" };

/** A memory driver whose progress writes land late, and which records order. */
class SlowProgressMemoryDriver extends MemoryDriver {
  /** Every progress and completion write, in the order each finished. */
  readonly writes: Write[] = [];

  override async updateProgress(
    q: QueueRef,
    id: string,
    // `unknown`, as the driver contract has it: a stored record may hold
    // anything, and narrowing here would make this driver unassignable.
    value: unknown,
  ): Promise<boolean> {
    await Bun.sleep(PROGRESS_DELAY_MS);
    const done = await super.updateProgress(q, id, value);
    this.writes.push({ kind: "progress", value: value as RunProgress });
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
    this.writes.push({ kind: "complete" });
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

/** A queue and a worker running `file` in `mode`, on the slow driver. */
function setup(mode: WorkerTargetMode, file: string) {
  const driver = new SlowProgressMemoryDriver();
  const namespace = testNamespace();
  const queue = new BunQueue("progress-order", {
    namespace,
    driver,
    logger: noopLogger,
  });
  const worker = new BunQueueWorker("progress-order", handler(file), {
    namespace,
    driver,
    logger: noopLogger,
    pollInterval: 5,
    target:
      mode === "child-process"
        ? { kind: mode, closeTimeout: 200, killTimeout: 200 }
        : mode === "worker-thread"
          ? { kind: mode, closeTimeout: 200 }
          : mode,
    waitToExit: false,
  });
  closers.push(
    () => queue.close(),
    () => worker.close({ force: true }),
  );
  void worker.run();
  return { driver, queue, worker };
}

for (const mode of ["child-process", "worker-thread", "in-process"] as const) {
  describe(`progress ordering: ${mode}`, () => {
    it("has written the last progress before the job reads completed", async () => {
      const { driver, queue } = setup(mode, "job-progress-final");

      const job = await queue.add("ordered", {}, { removeOnComplete: false });

      await waitFor(
        async () => (await queue.getJob(job.id))?.state === "completed",
        { timeout: 20_000, message: `the ${mode} job never completed` },
      );

      // Read the moment the state says completed: this is what a reader sees.
      const stored = await queue.getJob(job.id);
      expect(stored?.state).toBe("completed");
      expect(stored?.progress).toBe(100);

      // And the writes themselves went out in that order.
      expect(driver.writes).toEqual([
        { kind: "progress", value: 10 },
        { kind: "progress", value: 100 },
        { kind: "complete" },
      ]);
    }, 30_000);
  });
}
