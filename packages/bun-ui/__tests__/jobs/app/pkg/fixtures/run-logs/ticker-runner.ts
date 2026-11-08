import { defineHandler } from "@kingsleyweb/bun-jobs";

/**
 * The handler of `run-logs.integration.test.ts`' live run: logs a line every
 * `everyMs` until it has written `lines` of them, flushing each one, so the
 * view under test really has to tail a run that is still going.
 */
export default defineHandler<
  { lines?: number; everyMs?: number },
  { logged: number }
>(async (ctx) => {
  const lines = ctx.args?.lines ?? 6;
  const everyMs = ctx.args?.everyMs ?? 250;
  for (let index = 1; index <= lines; index++) {
    ctx.log(`tick ${index}`, { level: "info" });
    await ctx.flushLogs();
    if (index < lines) {
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  }
  return { logged: lines };
});
