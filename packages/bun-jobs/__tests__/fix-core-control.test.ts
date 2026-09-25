import type { BunQueueWorkerOptions } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunQueueWorker,
  MemoryDriver,
  writeWorkerConfig,
  writeWorkerControl,
} from "../lib/index";
import { WORKER_CHANGES_STATE } from "../lib/queue/workerControl";
import { testNamespace, waitFor } from "./helpers";

/**
 * C7: on a backend that polls, the workers of one process follow one change
 * counter per queue, and read their own entries only when it moves.
 */

const open: BunQueueWorker<unknown, unknown>[] = [];

afterEach(async () => {
  await Promise.allSettled(
    open.map(async (worker) => worker.close({ force: true })),
  );
  open.length = 0;
});

/** A memory driver counting queue-state reads by entry name. */
function countingDriver(): {
  driver: MemoryDriver;
  reads: Map<string, number>;
} {
  const driver = new MemoryDriver();
  const reads = new Map<string, number>();
  const original = driver.getQueueState.bind(driver);
  driver.getQueueState = async (...args: Parameters<typeof original>) => {
    const name = args[1];
    reads.set(name, (reads.get(name) ?? 0) + 1);
    return await original(...args);
  };
  return { driver, reads };
}

/** A polling, remotely controlled worker on `mail`. */
function makeWorker(
  driver: MemoryDriver,
  ns: string,
  options?: Partial<BunQueueWorkerOptions>,
): BunQueueWorker<unknown, unknown> {
  const worker = new BunQueueWorker<unknown, unknown>(
    "mail",
    async () => null,
    {
      namespace: ns,
      driver,
      logger: noopLogger,
      control: { subscribe: false, interval: 100 },
      // Long, so only the control poll can carry a change inside the test.
      reportInterval: 60_000,
      pollInterval: 20,
      waitToExit: false,
      metrics: { workers: false },
      ...options,
    },
  );
  open.push(worker);
  return worker;
}

/** Reads of the per-worker control entries (not the counter). */
function entryReads(reads: Map<string, number>): number {
  let total = 0;
  for (const [name, count] of reads) {
    if (name.includes("wcfg:") || name.includes("wctl:")) {
      total += count;
    }
  }
  return total;
}

describe("worker control: one change counter per process (C7)", () => {
  it("reads one entry per interval for ten idle workers, and no worker entries", async () => {
    const { driver, reads } = countingDriver();
    const ns = testNamespace("c7");
    const workers = Array.from({ length: 10 }, () => makeWorker(driver, ns));
    for (const worker of workers) {
      void worker.run();
    }
    await waitFor(() => workers.every((worker) => worker.isRunning));
    // Past the first read of the counter, which every watcher answers once.
    await Bun.sleep(250);

    reads.clear();
    await Bun.sleep(1_000);

    const counter = reads.get(WORKER_CHANGES_STATE) ?? 0;
    // ~10 reads at 100ms; before, each worker read its two entries per
    // interval: ~200.
    expect(counter).toBeGreaterThanOrEqual(5);
    expect(counter).toBeLessThanOrEqual(15);
    expect(entryReads(reads)).toBe(0);
  });

  it("still applies a configuration override within the interval", async () => {
    const { driver } = countingDriver();
    const ns = testNamespace("c7cfg");
    const workers = [makeWorker(driver, ns), makeWorker(driver, ns)];
    for (const worker of workers) {
      void worker.run();
    }
    await waitFor(() => workers.every((worker) => worker.isRunning));
    await Bun.sleep(150);

    const writtenAt = Date.now();
    await writeWorkerConfig(driver, { ns, queue: "mail" }, workers[0]!.key, {
      concurrency: 5,
    });
    await waitFor(() => workers.every((worker) => worker.concurrency === 5), {
      timeout: 2_000,
    });
    // One interval (100ms) plus the reads, with slack for a loaded machine.
    expect(Date.now() - writtenAt).toBeLessThan(600);
  });

  it("still applies a lifecycle instruction within the interval", async () => {
    const { driver } = countingDriver();
    const ns = testNamespace("c7ctl");
    const worker = makeWorker(driver, ns);
    void worker.run();
    await waitFor(() => worker.isRunning);
    await Bun.sleep(150);

    await writeWorkerControl(
      driver,
      { ns, queue: "mail" },
      {
        id: worker.id,
        key: worker.key,
        incarnation: worker.processStartedAt,
        state: "paused",
      },
    );
    await waitFor(() => worker.isPaused(), { timeout: 2_000 });
  });

  it("stops polling once the last worker on the queue closes", async () => {
    const { driver, reads } = countingDriver();
    const ns = testNamespace("c7close");
    const worker = makeWorker(driver, ns);
    void worker.run();
    await waitFor(() => worker.isRunning);
    await Bun.sleep(150);
    await worker.close({ force: true });

    reads.clear();
    await Bun.sleep(300);
    expect(reads.get(WORKER_CHANGES_STATE) ?? 0).toBe(0);
  });
});
