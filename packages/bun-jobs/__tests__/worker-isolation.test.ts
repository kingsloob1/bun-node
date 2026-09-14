import type { IsolationMode } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  ConfigError,
  MemoryDriver,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * Running a job's processor in a child process or a `Worker`.
 *
 * The same processor file runs in each mode, and each test checks what it
 * can only know by running there: which process or thread did the work, that
 * the job's log and progress still reached the store through the worker, and
 * that an error crossing the boundary still decides retries correctly.
 */

const handler = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** A queue and a worker running `file` in `mode`. */
function setup(mode: IsolationMode, file: string) {
  const driver = new MemoryDriver();
  const namespace = testNamespace();
  const queue = new BunQueue("isolated", {
    namespace,
    driver,
    logger: noopLogger,
  });
  const worker = new BunQueueWorker("isolated", handler(file), {
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
  return { queue, worker };
}

/** Whether a process id is still alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const mode of ["spawn", "worker", "in-process"] as const) {
  describe(`isolation: ${mode}`, () => {
    it("runs the job there, with its log and progress reaching the store", async () => {
      const { queue, worker } = setup(mode, "job-double");
      const progress: unknown[] = [];
      worker.on("progress", (_job, value) => progress.push(value));

      const job = await queue.add(
        "double",
        { n: 21 },
        { removeOnComplete: false },
      );

      await waitFor(
        async () => (await queue.getJob(job.id))?.state === "completed",
        { timeout: 20_000, message: `the ${mode} job never completed` },
      );

      const stored = await queue.getJob(job.id);
      const result = stored?.returnValue as {
        doubled: number;
        pid: number;
        child: string | null;
        logged: number;
        lockHeld: boolean;
      };

      expect(result.doubled).toBe(42);
      expect(result.logged).toBe(1);
      expect(result.lockHeld).toBe(true);
      expect(progress).toContain(50);
      expect(stored?.progress).toBe(50);
      expect(await queue.getJobLogs(job.id)).toEqual({
        logs: ["doubling 21", "done"],
        count: 2,
      });

      if (mode === "spawn") {
        expect(result.pid).not.toBe(process.pid);
        expect(result.child).toBe("1");
      } else if (mode === "worker") {
        expect(result.pid).toBe(process.pid);
        expect(result.child).toBe("1");
      } else {
        expect(result.pid).toBe(process.pid);
        expect(result.child).toBeNull();
      }
    }, 30_000);

    it("retries a failing job, and records the error from where it ran", async () => {
      const { queue } = setup(mode, "job-fail");
      const job = await queue.add("fail", {}, { attempts: 2, backoff: 1 });

      await waitFor(
        async () => (await queue.getJob(job.id))?.state === "dead",
        { timeout: 20_000, message: "the job never ran out of attempts" },
      );

      const stored = await queue.getJob(job.id);
      expect(stored?.attemptsMade).toBe(2);
      expect(stored?.failedReason?.message).toBe("attempt 2 failed");
    }, 30_000);

    it("still honours an unrecoverable error thrown there", async () => {
      const { queue } = setup(mode, "job-fail");
      const job = await queue.add(
        "fail",
        { unrecoverable: true },
        { attempts: 5, backoff: 1 },
      );

      await waitFor(
        async () => (await queue.getJob(job.id))?.state === "dead",
        { timeout: 20_000 },
      );

      const stored = await queue.getJob(job.id);
      expect(stored?.attemptsMade).toBe(1);
      expect(stored?.failedReason?.name).toBe("UnrecoverableJobError");
    }, 30_000);
  });
}

describe("isolation: what only isolation can do", () => {
  it("kills a spawned processor that ignores its signal when the job times out", async () => {
    const { queue, worker } = setup("spawn", "job-hang");
    let pid: number | undefined;
    worker.on("progress", (_job, value) => {
      pid = (value as { pid?: number }).pid ?? pid;
    });

    const job = await queue.add("hang", {}, { timeout: 300, attempts: 1 });

    await waitFor(() => pid !== undefined, { timeout: 20_000 });
    await waitFor(async () => (await queue.getJob(job.id))?.state === "dead", {
      timeout: 20_000,
      message: "the timed-out job never failed",
    });
    await waitFor(() => !isAlive(pid!), {
      timeout: 5_000,
      message: "the spawned processor was never killed",
    });

    expect((await queue.getJob(job.id))?.failedReason?.name).toBe(
      "JobTimeoutError",
    );
  }, 40_000);

  it("tells an isolated processor plainly what it cannot do", async () => {
    const { queue } = setup("spawn", "job-unavailable");
    const job = await queue.add("try", {}, { removeOnComplete: false });

    await waitFor(
      async () => (await queue.getJob(job.id))?.state === "completed",
      { timeout: 20_000 },
    );

    expect((await queue.getJob(job.id))?.returnValue).toContain(
      "is not available in an isolated job",
    );
  }, 30_000);

  it("refuses isolation for a function, and a file that does not resolve", () => {
    const namespace = testNamespace();
    const driver = new MemoryDriver();

    expect(
      () =>
        new BunQueueWorker("isolated", async () => null, {
          namespace,
          driver,
          logger: noopLogger,
          isolation: "spawn",
        }),
    ).toThrow(ConfigError);

    expect(
      () =>
        new BunQueueWorker("isolated", "./no/such/processor.ts", {
          namespace,
          driver,
          logger: noopLogger,
          isolation: "worker",
        }),
    ).toThrow(ConfigError);
  });
});
