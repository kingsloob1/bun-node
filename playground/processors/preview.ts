import process from "node:process";
import { isMainThread } from "node:worker_threads";
import { defineProcessor } from "@kingsleyweb/bun-jobs";

/**
 * One processor file run **two ways at once**: `targets.ts` puts two workers
 * on the `previews` queue, one with `target: "worker-thread"` and one with
 * `target: "child-process"`, so the same code is visibly executed in a `Worker`
 * thread and in a child process side by side. The result says which ran it,
 * and the Workers page shows the two keys (`api.previews`, `api.previews.2`)
 * taking turns on the same backlog.
 *
 * What each target buys:
 *
 * - `"worker-thread"` — a fresh JavaScript context per attempt, in this
 *   process. A processor that leaks module state, or that has to be
 *   terminated, can be, without paying for a process. It shares the pid, so
 *   `mainThread: false` is the evidence it ran off the main thread.
 * - `"child-process"` — its own heap, its own pid, and the only target where
 *   a processor that ignores its signal can be killed for certain.
 *
 * It also shows the two things an off-thread processor may still decide about
 * its own job: it can **throw**, and the worker retries it with the job's
 * backoff across the boundary (the `previews` workers register the custom
 * `"decode-ramp"` strategy `targets.ts` defines); and it can call
 * `job.fail()`, which is final — the job dies now, whatever attempts remain,
 * because nothing about a corrupt asset improves on the next try.
 */

/** What a preview job carries. */
export interface PreviewData {
  /** The asset being rendered, for the log line. */
  asset: string;
  /**
   * Marks the asset as unreadable, so the processor calls `job.fail()` — the
   * one write an off-thread processor can still make that ends the job.
   */
  corrupt?: boolean;
  /**
   * The chance one attempt throws, 0–1, so retries cross the thread or
   * process boundary. Defaults to `0.25`.
   */
  flakiness?: number;
}

/** What a preview job answers with. */
export interface PreviewResult {
  /** The asset it rendered. */
  asset: string;
  /** The made-up size of the preview it produced, in bytes. */
  bytes: number;
  /** The pid that ran it — the playground's on a worker thread, its own in a child process. */
  pid: number;
  /** Whether it ran on its realm's main thread — `false` on a worker thread. */
  mainThread: boolean;
  /**
   * Which executor started it: the mode the attempt's process reports in
   * `BUN_JOBS_MODE`, or `"in-process"` when that is unset.
   */
  mode: string;
}

/** Waits `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default defineProcessor<PreviewData, PreviewResult>(async (job, ctx) => {
  const mode = process.env.BUN_JOBS_MODE ?? "in-process";
  await job.log(
    `attempt ${ctx.attempt}: decoding ${job.data.asset} (${mode}, pid ${process.pid}, main thread ${String(isMainThread)})`,
  );

  await job.updateProgress({ step: "decode", done: 1, of: 3 });
  await sleep(600);

  if (job.data.corrupt) {
    // Final, and deliberately not a `throw`: a throw would be retried until
    // `attempts` ran out, and a corrupt asset will still be corrupt then.
    // In a child this needs no round trip — the reason is reported as the
    // attempt's error, and the worker reads it as unrecoverable by name.
    await job.log("the asset's header is not a picture; giving up");
    await job.fail(new Error(`${job.data.asset} is not a readable image`));
    return {
      asset: job.data.asset,
      bytes: 0,
      pid: process.pid,
      mainThread: isMainThread,
      mode,
    };
  }

  // A step longer than a third of `lockDuration` would normally rely on the
  // heartbeat timer; asking for the renewal explicitly is what `heartbeat`
  // is for, and in a child it is answered by the worker that holds the lock.
  await ctx.heartbeat();
  await job.updateProgress({ step: "resize", done: 2, of: 3 });
  await sleep(700);

  if (Math.random() < (job.data.flakiness ?? 0.25)) {
    // Thrown in another thread or process; the worker rebuilds it by name,
    // counts the attempt and applies the job's backoff as if it were local.
    throw new Error(`the decoder ran out of memory on ${job.data.asset}`);
  }

  await job.updateProgress({ step: "encode", done: 3, of: 3 });
  await job.log(`encoded a preview of ${job.data.asset}`);

  return {
    asset: job.data.asset,
    bytes: 20_000 + Math.floor(Math.random() * 80_000),
    pid: process.pid,
    mainThread: isMainThread,
    mode,
  };
});
