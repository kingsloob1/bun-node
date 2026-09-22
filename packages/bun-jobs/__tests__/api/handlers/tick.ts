import { defineHandler } from "../../../lib/index";

/**
 * A run in progress whose log keeps growing: writes `tick 1`, `tick 2`, …
 * `gap` ms apart, each flushed to the store, until it is sent `"release"` (or
 * aborted), then returns how many lines it wrote. With `quick` it writes one
 * line and returns at once, so a test can lay down finished runs beside it.
 */
export default defineHandler<{ gap?: number; quick?: boolean }, number>(
  async (ctx) => {
    if (ctx.args?.quick) {
      ctx.log("done");
      return 1;
    }

    const released = { value: false };
    ctx.onMessage((message) => {
      if (message === "release") {
        released.value = true;
      }
    });

    const gap = ctx.args?.gap ?? 10;
    let count = 0;
    while (!released.value && !ctx.signal.aborted) {
      count += 1;
      ctx.log(`tick ${count}`);
      await ctx.flushLogs();
      await Bun.sleep(gap);
    }
    return count;
  },
);
