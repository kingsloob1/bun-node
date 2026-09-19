import { defineProcessor } from "../../../lib/index";

/**
 * Renews its lock three ways — `ctx.heartbeat()`, `job.extendLock()` and
 * `job.extendLock(data.ms)` — reporting each through `updateProgress` with the
 * instant it returned, and pausing after each so the test can read the lock's
 * expiry before the next one moves it.
 */
export default defineProcessor<{ ms: number; pause: number }>(
  async (job, ctx) => {
    const pause = async () =>
      await new Promise((resolve) => setTimeout(resolve, job.data.pause));

    await ctx.heartbeat();
    await job.updateProgress({ step: "heartbeat", held: true, at: Date.now() });
    await pause();

    const byDefault = await job.extendLock();
    await job.updateProgress({
      step: "default",
      held: byDefault,
      at: Date.now(),
    });
    await pause();

    const byMs = await job.extendLock(job.data.ms);
    await job.updateProgress({ step: "ms", held: byMs, at: Date.now() });
    await pause();

    return null;
  },
);
