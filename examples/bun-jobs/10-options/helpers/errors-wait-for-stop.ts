/**
 * A runner handler that reports it has started, then works until it is asked
 * to stop — so a tour can kill it or time it out at a moment it chooses.
 * Used by `10-options/errors.ts`; not meant to be run alone.
 *
 * It gives up by itself after 20 seconds, so a tour that fails half-way can
 * never leave it running.
 */
import { defineHandler } from "@kingsleyweb/bun-jobs";

export default defineHandler(async (ctx) => {
  ctx.progress({ started: true });

  const deadline = Date.now() + 20_000;
  while (!ctx.signal.aborted && Date.now() < deadline) {
    await Bun.sleep(10);
  }

  return ctx.signal.aborted ? "stopped when asked" : "gave up waiting";
});
