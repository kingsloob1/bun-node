/**
 * A runner handler: the file a `BunRunner` runs.
 *
 * Its default export is a function of a `RunContext`. `defineHandler` does
 * nothing at runtime — it types the handler where it is written, so the
 * arguments and result are checked here rather than where the runner is made.
 *
 * The same file runs unchanged in any execution mode: in a child process, in a
 * `Worker`, or in the runner's own process.
 */
import { defineHandler } from "@kingsleyweb/bun-jobs";

/** Arguments a cleanup run accepts. */
export interface CleanupArgs {
  /** Remove records older than this many days. */
  olderThanDays: number;
  /** How many records one batch removes. Defaults to `100`. */
  batchSize?: number;
}

/** What a cleanup run reports. */
export interface CleanupResult {
  /** Records removed. */
  removed: number;
  /** Batches it took. */
  batches: number;
}

export default defineHandler<CleanupArgs, CleanupResult>(async (ctx) => {
  const batchSize = ctx.args?.batchSize ?? 100;
  const batches = 3;
  let removed = 0;

  ctx.logger.info("cleanup starting", {
    olderThanDays: ctx.args?.olderThanDays,
    source: ctx.source,
    mode: ctx.mode,
  });

  for (let batch = 1; batch <= batches; batch++) {
    // Stopped, killed or timed out: give up between batches.
    ctx.signal.throwIfAborted();

    await Bun.sleep(20); // pretend to DELETE ... LIMIT batchSize
    removed += batchSize - batch * 7;
    ctx.progress({ batch, of: batches, removed });
  }

  return { removed, batches };
});
