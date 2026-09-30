import type { Job } from "../../../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { heapStats } from "bun:jsc";
import { BunQueue, BunQueueWorker, MemoryDriver } from "../../../lib/index";

/**
 * The B1 retention measurement (`fix-core-slot-wait.test.ts`), in a process
 * of its own: a long job holds one of two slots while bursts of short jobs
 * complete beside it, and the live `Promise` count is read before and after
 * the second burst. Prints one JSON line, `{ before, after, active }`.
 *
 * A heap count is process-wide, so inside the suite it also counted whatever
 * earlier files left running: the baseline there was ~1,990 against 828
 * alone, and one seeded gate run crossed the 2,000 bound with this code
 * unchanged.
 */

/** Live `Promise` objects after a full collection. */
function livePromises(): number {
  Bun.gc(true);
  return heapStats().objectTypeCounts.Promise ?? 0;
}

/** Resolves once `condition` holds, polling; throws after `timeout` ms. */
async function until(
  condition: () => boolean,
  timeout = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeout} ms`);
    }
    await Bun.sleep(5);
  }
}

const driver = new MemoryDriver();
const namespace = "slot-wait-retention";
const queue = new BunQueue<{ long: boolean }>("work", {
  namespace,
  driver,
  logger: noopLogger,
  defaultJobOptions: { removeOnComplete: true },
});

let releaseLong!: () => void;
const longDone = new Promise<void>((resolve) => {
  releaseLong = resolve;
});
let completed = 0;

const worker = new BunQueueWorker<{ long: boolean }>(
  "work",
  async (job: Job<{ long: boolean }>) => {
    if (job.data.long) {
      await longDone;
    }
  },
  {
    namespace,
    driver,
    logger: noopLogger,
    concurrency: 2,
    pollInterval: 10,
    maxBlock: 20,
    metrics: { workers: false },
  },
);
worker.on("completed", () => {
  completed += 1;
});

/** Runs `count` short jobs beside the long one. */
async function burst(count: number): Promise<void> {
  const target = completed + count;
  await queue.addBulk(
    Array.from({ length: count }, () => ({
      name: "short",
      data: { long: false },
    })),
  );
  await until(() => completed >= target);
}

await queue.add("long", { long: true });
worker.run().catch(() => {});
await until(() => worker.activeCount === 1);

await burst(2_000);
const before = livePromises();
await burst(10_000);
const after = livePromises();
const active = worker.activeCount;

releaseLong();
await worker.close({ force: true });
await queue.close();
console.log(JSON.stringify({ before, after, active }));
