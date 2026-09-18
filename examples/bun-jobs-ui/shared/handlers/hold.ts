/**
 * A runner handler that stays in flight until it is stopped: until its abort
 * signal fires (a kill, the runner stopping) or `ms` pass. The examples use
 * it to put a run in `local.activeRuns`, which is what offers Kill, and
 * the demo to leave a run in flight for the runner screen to show.
 */
import { defineHandler } from "@kingsleyweb/bun-jobs";

/** Arguments of a held run. */
export interface HoldArgs {
  /** The longest it holds, in milliseconds. Defaults to 60 000. */
  ms?: number;
}

export default defineHandler<HoldArgs, string>(async (ctx) => {
  const ms = ctx.args?.ms ?? 60_000;
  if (ctx.signal.aborted) {
    return "stopped before it began";
  }
  const stopped = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(resolve, ms, false);
    ctx.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
  });
  return stopped ? "stopped" : `held for ${ms} ms`;
});
