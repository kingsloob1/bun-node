/**
 * A processor *file*: the same `(job, ctx) => result` a function processor
 * is, as a module's default export, so a worker can run it somewhere else.
 *
 * `defineProcessor` does nothing at runtime; it types the export where it is
 * written. Used by `02-queues/isolated-processors.ts`.
 */
import process from "node:process";
import { isMainThread } from "node:worker_threads";
import { defineProcessor } from "@kingsleyweb/bun-jobs";

/** What a thumbnail job carries. */
export interface Thumbnail {
  /** The image to shrink. */
  imageId: number;
  /** The thumbnail's width, in pixels. */
  size: number;
}

/** What a thumbnail job answers with. */
export interface ThumbnailResult {
  /** The image that was shrunk. */
  imageId: number;
  /** The process the attempt ran in. */
  pid: number;
  /** Whether it ran on a process's main thread (false inside a `Worker`). */
  mainThread: boolean;
}

export default defineProcessor<Thumbnail, ThumbnailResult>(async (job, ctx) => {
  // Both work from inside an isolated attempt: the worker in the parent does
  // the writing, answering over the executor's message channel.
  await ctx.log(`shrinking image ${job.data.imageId} to ${job.data.size}px`);

  for (let step = 1; step <= 4; step++) {
    ctx.signal.throwIfAborted();
    await Bun.sleep(15);
    await job.updateProgress(step * 25);
  }

  return {
    imageId: job.data.imageId,
    pid: process.pid,
    mainThread: isMainThread,
  };
});
