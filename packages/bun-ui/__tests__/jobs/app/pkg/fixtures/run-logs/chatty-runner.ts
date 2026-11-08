import { defineHandler } from "@kingsleyweb/bun-jobs";

/**
 * The handler of `run-logs.integration.test.ts`' finished runs: writes
 * `lines` lines to the run's captured log — one per level it is given, plus
 * one with fields, which capture renders into the text — and flushes them to
 * the store before it returns, so the test never races the 250 ms flush.
 */
export default defineHandler<{ lines?: number }, { logged: number }>(
  async (ctx) => {
    const lines = ctx.args?.lines ?? 4;
    for (let index = 1; index <= lines; index++) {
      ctx.log(`step ${index}`, {
        level: index === lines ? "warn" : "info",
        fields: { step: index, of: lines },
      });
    }
    await ctx.flushLogs();
    return { logged: lines };
  },
);
