/**
 * A long task that talks to its runner: it reports progress, logs, answers
 * messages, and stops cleanly when asked.
 *
 * Messages go both ways. `ctx.send()` surfaces as the runner's `message`
 * event; `runner.send()` arrives here through `ctx.onMessage`. In `child-process`
 * and `worker-thread` modes they cross the process or thread boundary as IPC, so they
 * must be structured-cloneable.
 */
import { defineHandler } from "@kingsleyweb/bun-jobs";

/** Arguments a long task accepts. */
export interface LongTaskArgs {
  /** How many steps to take. */
  steps: number;
  /** Milliseconds per step. */
  stepMs: number;
}

export default defineHandler<LongTaskArgs, string>(async (ctx) => {
  let step = 0;
  let stopRequested = false;

  const unsubscribe = ctx.onMessage((message) => {
    if (message === "status") {
      ctx.send({ step, of: ctx.args.steps });
    } else if (message === "wrap up") {
      stopRequested = true;
    }
  });

  try {
    for (step = 1; step <= ctx.args.steps; step++) {
      if (stopRequested) {
        ctx.logger.warn("asked to wrap up early", { step });
        return `wrapped up at step ${step} of ${ctx.args.steps}`;
      }

      // Aborted by kill(), stop() or the runner's timeout.
      if (ctx.signal.aborted) {
        return `aborted at step ${step}`;
      }

      await Bun.sleep(ctx.args.stepMs);
      ctx.progress(Math.round((step / ctx.args.steps) * 100));
    }

    ctx.logger.info("all steps done", { steps: ctx.args.steps });
    return `finished ${ctx.args.steps} steps`;
  } finally {
    unsubscribe();
  }
});
