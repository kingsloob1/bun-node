/**
 * Producer and worker — `BunQueue` and `BunQueueWorker` used directly.
 *
 * ```bash
 * bun 02-queues/producer-and-worker.ts
 * ```
 *
 * A queue is a name inside a namespace and nothing more: no server, no
 * registration. A producer and a worker find each other because they name the
 * same namespace and queue against the same backend — here in one process,
 * but equally in two services on two hosts (see `08-drivers/cross-process`).
 *
 * Reach for these classes over the `BunJobs` registry when a queue has one
 * kind of work and a typed payload, or when producers and consumers live in
 * different codebases.
 */
import { BunQueue, BunQueueWorker, createDriver } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** What a producer asks for. */
interface ResizeImage {
  /** Which image to resize. */
  imageId: number;
  /** Target width in pixels. */
  width: number;
}

/** What the worker answers with; stored as the job's `returnValue`. */
interface Resized {
  /** The image that was resized. */
  imageId: number;
  /** Where the result was written. */
  url: string;
  /** Size of the result, in bytes. */
  bytes: number;
}

title("Producer and worker");

// One driver instance, shared. A driver passed as an *instance* is never
// closed by the queue or worker using it — whoever created it closes it.
const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("media");

// The third type parameter narrows the job names this queue accepts.
const images = new BunQueue<ResizeImage, Resized, "resize">("images", {
  namespace,
  driver,
  // Merged under every `add()` on this queue.
  defaultJobOptions: { attempts: 2, removeOnComplete: false },
});

const worker = new BunQueueWorker<ResizeImage, Resized>(
  "images",
  async (job, ctx) => {
    await job.updateProgress({ stage: "downloading" });
    await Bun.sleep(20);

    // The signal is aborted on timeout, shutdown or a lost lock. Long work
    // should check it between steps.
    ctx.signal.throwIfAborted();

    await job.updateProgress({ stage: "resizing" });
    await Bun.sleep(20);

    return {
      imageId: job.data.imageId,
      url: `https://cdn.example.com/${job.data.imageId}-${job.data.width}.webp`,
      bytes: job.data.width * 42,
    };
  },
  {
    namespace,
    driver,
    id: "image-worker-1", // appears on job records and in logs
    concurrency: 3, // jobs processed at once by this worker
  },
);

let completed = 0;
worker.on("active", (job) => show(`worker took job ${job.id}`, job.data));
worker.on("completed", (job, result) => {
  completed++;
  show(`job ${job.id} completed`, result.url);
});
worker.on("error", (error, context) => {
  console.error(`worker error during ${context}:`, error);
});

// `run()` resolves only once the worker is closed, so keep the promise rather
// than awaiting it here.
const running = worker.run();

step("Adding six jobs");
const added = [];
for (const [index, width] of [320, 640, 960, 1280, 1920, 2560].entries()) {
  added.push(await images.add("resize", { imageId: 100 + index, width }));
}
show(
  "added",
  added.map((job) => `${job.id} (${job.state})`),
);

await waitFor("all six to complete", () => completed === added.length);

step("Reading a finished job back");
const job = await images.getJob(added[0]!.id);
show("state", job?.state);
show("returnValue", job?.returnValue);
show("progress", job?.progress);
show("processed by", job?.workerId ?? "(released after completion)");
show("attempts made", `${job?.attemptsMade} of ${job?.maxAttempts}`);
show("took", `${(job?.finishedOn ?? 0) - (job?.processedOn ?? 0)}ms`);
show("counts", await images.count());

step("Shutting down");
// Stops claiming, waits for what is in flight, then `run()` resolves.
await worker.close();
await running;
await images.close();
await driver.purge(namespace);
await driver.close();
show("worker, queue and driver closed");
