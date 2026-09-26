import process from "node:process";
import { isMainThread } from "node:worker_threads";
import { defineProcessor } from "@kingsleyweb/bun-jobs";

/**
 * A deliberately CPU-bound processor, run in a **child process**
 * (`target: "child-process"`, see `targets.ts`).
 *
 * This is what an off-thread target is *for*. The work below is a tight synchronous loop
 * with no `await` inside it: in-process it would hold the worker's thread for
 * the whole block, and while it did so the claim loop would not claim, the
 * heartbeat timer would not renew any lock, and every other job on that worker
 * would sit still. Run in a child process it burns a CPU the event loop does
 * not own, and the worker carries on claiming, heartbeating and reporting.
 *
 * What the child may use of the job is what bun-jobs' `workerTarget.ts`
 * answers over the
 * executor's message channel: `job.log()`, `job.updateProgress()`,
 * `job.touch()`/`extendLock()`, `ctx.heartbeat()`, `ctx.logger`, `ctx.signal`,
 * `job.fail()` and a flow's children. It has **no driver** — anything that
 * would write the stored job directly (`updateData`, `remove`, `promote`, …)
 * says so rather than failing obscurely.
 *
 * Its result records where it ran, which is the only honest evidence that it
 * ran anywhere else: a different pid than the playground's in a child
 * process, and `mainThread: false` on a worker thread.
 */

/** What a checksum job carries. */
export interface ChecksumData {
  /** The file being pretended to hash, for the log line. */
  file: string;
  /** How many blocks to hash. Each one blocks its thread for `BLOCK_MS`. Defaults to `4`. */
  blocks?: number;
  /** The starting value of the rolling digest. Defaults to `1`. */
  seed?: number;
}

/** What a checksum job answers with. */
export interface ChecksumResult {
  /** The digest it arrived at, in hex. */
  digest: string;
  /** How many blocks it hashed. */
  blocks: number;
  /** The pid that ran it — not the playground's, in a child process. */
  pid: number;
  /** Whether it ran on its realm's main thread — `false` on a worker thread. */
  mainThread: boolean;
  /**
   * Which executor started it: the mode the attempt's process reports in
   * `BUN_JOBS_MODE`, or `"in-process"` when that is unset.
   */
  mode: string;
}

/** How long one block holds its thread, in ms. */
const BLOCK_MS = 350;

/**
 * Burns CPU for `ms` without yielding, mixing `seed` into a digest as it goes.
 *
 * Arithmetic rather than a real hash on purpose: it needs no import, it cannot
 * be optimised away (the result is returned), and it is the *blocking* that is
 * the point, not the cryptography.
 */
function burn(ms: number, seed: number): number {
  const until = Date.now() + ms;
  let digest = seed >>> 0;
  while (Date.now() < until) {
    // A batch between clock reads, so the loop is dominated by the work.
    for (let i = 0; i < 100_000; i++) {
      digest = (Math.imul(digest ^ (digest >>> 15), 0x2c1b3c6d) + i) >>> 0;
    }
  }
  return digest;
}

export default defineProcessor<ChecksumData, ChecksumResult>(
  async (job, ctx) => {
    const blocks = job.data.blocks ?? 4;
    const mode = process.env.BUN_JOBS_MODE ?? "in-process";

    // Written through the worker: the child has no driver, so this line is a
    // request on the job channel that the worker answers from its own `Job`.
    await job.log(
      `hashing ${job.data.file} in ${blocks} blocks (${mode}, pid ${process.pid})`,
    );

    let digest = job.data.seed ?? 1;
    for (let block = 1; block <= blocks; block++) {
      // The only cancellation point there is: the loop below never yields, so
      // a `spawn` child that ignored this could only be stopped by killing it
      // (which is what `wedge.ts` demonstrates).
      if (ctx.signal.aborted) {
        throw new Error(`hashing ${job.data.file} was cancelled`);
      }

      digest = burn(BLOCK_MS, digest);

      // Forwarded to the worker, which writes it to the stored job — so the
      // progress bar on the job's screen moves from inside the child.
      await job.updateProgress(Math.round((block / blocks) * 100));
      // The block above held this thread for longer than a heartbeat tick, so
      // renew the lock explicitly rather than trusting a timer that could not
      // fire. In the child this is a round trip to the worker, which holds it.
      await ctx.heartbeat();
    }

    ctx.logger.debug("digest computed", { file: job.data.file, blocks });
    await job.log(`digest ${digest.toString(16)}`);

    return {
      digest: digest.toString(16),
      blocks,
      pid: process.pid,
      mainThread: isMainThread,
      mode,
    };
  },
);
