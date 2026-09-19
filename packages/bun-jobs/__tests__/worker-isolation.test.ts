import type { IsolationMode } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  ConfigError,
  DEFAULT_LOCK_DURATION,
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
function setup(
  mode: IsolationMode,
  file: string,
  /** Lock tuning for the worker; the worker's defaults when absent. */
  lock: {
    /** The worker's `lockDuration`. */
    lockDuration?: number;
    /** The worker's `heartbeatInterval`. */
    heartbeatInterval?: number;
  } = {},
) {
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
    ...lock,
  });
  closers.push(
    () => queue.close(),
    () => worker.close({ force: true }),
  );
  void worker.run();
  return { queue, worker, driver };
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

    it("gives a flow's jobs their parent, and the parent its children's values and failures", async () => {
      // Every job in the flow runs the same file here, so a child reads
      // `job.parent` and the parent reads its children, all in `mode`. In
      // `spawn` and `worker` these used to be missing from the job object.
      const { queue } = setup(mode, "job-children");
      const flow = await queue.addFlow({
        name: "parent",
        data: {},
        opts: { removeOnComplete: false },
        children: [
          { name: "ok", data: {}, queue: "isolated" },
          {
            name: "bad",
            data: {},
            queue: "isolated",
            opts: { ignoreFailure: true },
          },
        ],
      });

      await waitFor(
        async () => (await queue.getJob(flow.job.id))?.state === "completed",
        { timeout: 20_000, message: `the ${mode} flow never completed` },
      );

      const ok = flow.children[0]!.job.id;
      const bad = flow.children[1]!.job.id;
      const stored = await queue.getJob(flow.job.id);

      expect(stored?.returnValue).toEqual({
        parent: null,
        values: {
          [`isolated:${ok}`]: {
            parent: { queue: "isolated", id: flow.job.id },
          },
        },
        failures: {
          [`isolated:${bad}`]: {
            isError: true,
            name: "UnrecoverableJobError",
            message: "optional source down",
          },
        },
      });
    }, 30_000);

    it("shows a caller's repeat key exactly as the worker's own Job does", async () => {
      // A key without `|` is shown bare; one with `|` keeps its stored `k:`
      // prefix (see `displayRepeatKey`). Isolated jobs used to report the raw
      // stored spelling, so the same job named its series differently.
      const { queue, worker } = setup(mode, "job-identity");
      const seen = new Map<
        string,
        { child: Record<string, unknown>; worker: Record<string, unknown> }
      >();
      worker.on("progress", (job, value) => {
        seen.set(job.name, {
          child: value as Record<string, unknown>,
          worker: {
            ...job.toJSON(),
            repeatKey: job.repeatKey,
            isRepeat: job.isRepeat,
          },
        });
      });

      await queue.add(
        "bare",
        {},
        { repeat: { every: 60_000, key: "nightly", immediately: true } },
      );
      await queue.add(
        "piped",
        {},
        { repeat: { every: 60_000, key: "report|daily", immediately: true } },
      );

      await waitFor(() => seen.size === 2, {
        timeout: 20_000,
        message: `the ${mode} repeat occurrences never ran`,
      });

      expect(seen.get("bare")!.child.repeatKey).toBe("nightly");
      expect(seen.get("bare")!.child.isRepeat).toBe(true);
      expect(seen.get("piped")!.child.repeatKey).toBe("k:report|daily");
      expect(seen.get("piped")!.child.isRepeat).toBe(true);
      for (const { child, worker: own } of seen.values()) {
        expect(child.repeatKey).toBe(own.repeatKey);
      }
    }, 30_000);

    it("hands the processor the same job members the worker's Job has", async () => {
      const { queue, worker } = setup(mode, "job-identity");
      let seen:
        | { child: Record<string, unknown>; worker: Record<string, unknown> }
        | undefined;
      worker.on("progress", (job, value) => {
        seen = {
          child: value as Record<string, unknown>,
          worker: {
            id: job.id,
            name: job.name,
            data: job.data,
            opts: job.opts,
            state: job.state,
            priority: job.priority,
            runAt: job.runAt,
            createdAt: job.createdAt,
            processedOn: job.processedOn,
            finishedOn: job.finishedOn,
            expiresAt: job.expiresAt,
            attemptsMade: job.attemptsMade,
            maxAttempts: job.maxAttempts,
            stalledCount: job.stalledCount,
            progress: job.progress,
            returnValue: job.returnValue,
            failedReason: job.failedReason?.message ?? null,
            stacktrace: job.stacktrace.map((error) => error.message),
            workerId: job.workerId,
            repeatKey: job.repeatKey,
            wasAdded: job.wasAdded,
            queue: job.queue,
            isRepeat: job.isRepeat,
            lockToken: job.lockToken,
            parent: job.parent,
          },
        };
      });

      // A repeat occurrence, so the derived members are exercised too.
      await queue.add(
        "plain",
        { n: 1 },
        {
          priority: 3,
          repeat: { every: 60_000, key: "members", immediately: true },
        },
      );
      await waitFor(() => seen !== undefined, {
        timeout: 20_000,
        message: `the ${mode} job never reported`,
      });

      expect(seen!.child).toStrictEqual(
        JSON.parse(JSON.stringify(seen!.worker)) as Record<string, unknown>,
      );
    }, 30_000);

    it("extends the lock by what extendLock(ms) asks, and heartbeat by lockDuration", async () => {
      // The worker's own renewal is pushed out of the way, and its
      // lockDuration made distinct from both the default and the asked-for
      // duration, so each of the three is visible in the lock's expiry.
      const lockDuration = 10_000;
      const { queue, worker, driver } = setup(mode, "job-extend-lock", {
        lockDuration,
        heartbeatInterval: 120_000,
      });
      const reads: Promise<{
        step: string;
        held: boolean;
        ahead: number | null;
      }>[] = [];
      worker.on("progress", (job, value) => {
        const { step, held, at } = value as {
          step: string;
          held: boolean;
          at: number;
        };
        reads.push(
          driver.getJob(worker.ref, job.id).then((record) => ({
            step,
            held,
            ahead:
              record?.lockExpiresAt == null ? null : record.lockExpiresAt - at,
          })),
        );
      });

      const job = await queue.add(
        "extend",
        { ms: 60_000, pause: 300 },
        { removeOnComplete: false },
      );
      await waitFor(
        async () => (await queue.getJob(job.id))?.state === "completed",
        { timeout: 20_000, message: `the ${mode} job never completed` },
      );

      const byStep = Object.fromEntries(
        (await Promise.all(reads)).map((read) => [read.step, read]),
      );
      // Each expiry is `now + duration` in the worker, a little before `at`
      // in the processor: so a little under the duration, never over it.
      const expectAhead = (step: string, duration: number) => {
        expect(byStep[step]?.held).toBe(true);
        expect(byStep[step]?.ahead).toBeLessThanOrEqual(duration);
        expect(byStep[step]?.ahead).toBeGreaterThan(duration - 2_000);
      };
      expectAhead("heartbeat", lockDuration);
      expectAhead("default", DEFAULT_LOCK_DURATION);
      expectAhead("ms", 60_000);
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
