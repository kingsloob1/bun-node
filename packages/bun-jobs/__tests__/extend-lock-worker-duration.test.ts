import type { Job, JobsDriver, ProcessorContext } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  createDriver,
  DEFAULT_LOCK_DURATION,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * A bare `job.extendLock()` / `job.touch()` renews the lock for the claiming
 * worker's `lockDuration`, as its own heartbeat does — not for the fixed
 * `DEFAULT_LOCK_DURATION`.
 *
 * A worker configured with a short `lockDuration` wants a stuck job found
 * fast. One bare touch used to stretch its lock to 30 s, ten times that, and
 * the stalled sweep could not recover it until then. An explicit `ms` still
 * wins, and a view that is not the processor's still answers `false`.
 *
 * In-process here, on every backend; the child-process and worker-thread
 * targets are covered in `worker-target.test.ts`.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** Temp directories and server namespaces to release once the suite ends. */
const backendCleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(backendCleanups.map((cleanup) => cleanup()));
});

/** Memory, file, SQLite and every configured server. */
const BACKENDS = [
  { name: "memory", config: { type: "memory" } as const, available: true },
  ...(await crossProcessBackends({ cleanups: backendCleanups })),
];

/** The worker's lock: short, and far from `DEFAULT_LOCK_DURATION`. */
const LOCK_DURATION = 3_000;

for (const { name: backendName, config, available } of BACKENDS) {
  describe.skipIf(!available)(`a bare extendLock: ${backendName}`, () => {
    /** A driver for this backend and a queue on a fresh namespace. */
    function setup() {
      const driver = createDriver(config);
      const namespace = testNamespace("extend-lock");
      backendCleanups.push(async () => {
        await driver.purge(namespace);
        await driver.close();
      });
      const queue = new BunQueue<{ v: number }>("lock", {
        namespace,
        driver,
        logger: noopLogger,
      });
      closers.push(() => queue.close());
      return { driver, namespace, queue };
    }

    /**
     * A started worker with a 3 s lock and its automatic renewal pushed out of
     * the way, so the processor's own calls are the only thing moving it.
     */
    function startWorker(
      driver: JobsDriver,
      namespace: string,
      processor: (
        job: Job<{ v: number }, unknown>,
        ctx: ProcessorContext,
      ) => Promise<unknown>,
      options: { stalledInterval?: number } = {},
    ): BunQueueWorker<{ v: number }> {
      const worker = new BunQueueWorker<{ v: number }>("lock", processor, {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 5,
        lockDuration: LOCK_DURATION,
        heartbeatInterval: 120_000,
        waitToExit: false,
        ...options,
      });
      closers.push(() => worker.close({ force: true }));
      void worker.run();
      return worker;
    }

    /** How far ahead of `at` the stored lock expires, read now. */
    async function lockAhead(
      driver: JobsDriver,
      worker: BunQueueWorker<{ v: number }>,
      id: string,
      at: number,
    ): Promise<number | null> {
      const record = await driver.getJob(worker.ref, id);
      return record?.lockExpiresAt == null ? null : record.lockExpiresAt - at;
    }

    it("renews for the worker's lockDuration, from extendLock(), touch() and a refreshed view", async () => {
      const { driver, namespace, queue } = setup();
      const seen: Record<string, { held: boolean; ahead: number | null }> = {};
      let done = false;

      // A worker is referenced in its own processor only through this.
      let worker!: BunQueueWorker<{ v: number }>;
      const read = async (
        step: string,
        job: Job<{ v: number }, unknown>,
        renew: () => Promise<boolean>,
      ) => {
        const held = await renew();
        // Taken after the call returned: the expiry was set a little before,
        // so it reads a little under the duration, never over it.
        seen[step] = {
          held,
          ahead: await lockAhead(driver, worker, job.id, Date.now()),
        };
      };

      worker = startWorker(driver, namespace, async (job) => {
        await read("extendLock", job, async () => await job.extendLock());
        await read("touch", job, async () => await job.touch());
        const refreshed = await job.refresh();
        await read("refreshed", job, async () => await refreshed!.touch());
        await read("ms", job, async () => await job.touch(20_000));
        done = true;
        return null;
      });

      await queue.add("x", { v: 1 });
      await waitFor(() => done, {
        timeout: 15_000,
        message: "the processor never finished renewing",
      });

      const expectAhead = (step: string, duration: number) => {
        expect(seen[step]?.held).toBe(true);
        expect(seen[step]?.ahead).toBeLessThanOrEqual(duration);
        expect(seen[step]?.ahead).toBeGreaterThan(duration - 2_000);
      };
      expectAhead("extendLock", LOCK_DURATION);
      expectAhead("touch", LOCK_DURATION);
      expectAhead("refreshed", LOCK_DURATION);
      // An explicit duration still wins over the worker's.
      expectAhead("ms", 20_000);
      expect(LOCK_DURATION).toBeLessThan(DEFAULT_LOCK_DURATION - 2_000);
    }, 30_000);

    it("lets the stalled sweep recover the job about lockDuration after the last bare touch", async () => {
      const { driver, namespace, queue } = setup();
      let touchedAt: number | undefined;
      let stalledAt: number | undefined;

      const worker = startWorker(
        driver,
        namespace,
        async (job, ctx) => {
          // The last sign of life: one bare touch, then nothing — a job stuck
          // in a step that never renews again.
          expect(await job.touch()).toBe(true);
          touchedAt = Date.now();
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return null;
        },
        { stalledInterval: 200 },
      );
      worker.on("stalled", () => {
        stalledAt ??= Date.now();
      });

      await queue.add("x", { v: 1 });
      await waitFor(() => touchedAt !== undefined, { timeout: 10_000 });
      // With the touch holding the lock for DEFAULT_LOCK_DURATION, nothing
      // would come back for 30 s; the worker asked for 3.
      await waitFor(() => stalledAt !== undefined, {
        timeout: LOCK_DURATION + 6_000,
        message: `the job was not recovered within ${LOCK_DURATION + 6_000} ms of its last touch`,
      });

      const after = stalledAt! - touchedAt!;
      expect(after).toBeGreaterThanOrEqual(LOCK_DURATION - 500);
      expect(after).toBeLessThan(LOCK_DURATION + 6_000);
    }, 30_000);

    it("answers false from a view that is not the processor's, bare or not", async () => {
      const { driver, namespace, queue } = setup();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = false;

      const worker = startWorker(driver, namespace, async () => {
        started = true;
        await gate;
        return null;
      });

      const job = await queue.add("x", { v: 1 });
      await waitFor(() => started, { timeout: 10_000 });
      const before = (await driver.getJob(worker.ref, job.id))?.lockExpiresAt;

      const outside = await queue.getJob(job.id);
      expect(outside?.state).toBe("active");
      expect(outside?.lockToken).not.toBeNull();
      expect(await outside!.extendLock()).toBe(false);
      expect(await outside!.touch()).toBe(false);
      expect(await outside!.touch(600_000)).toBe(false);
      // The lock is where the worker's claim put it.
      expect((await driver.getJob(worker.ref, job.id))?.lockExpiresAt).toBe(
        before,
      );
      release();
    }, 30_000);
  });
}
