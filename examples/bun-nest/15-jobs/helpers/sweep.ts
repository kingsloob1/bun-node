/**
 * The file a runner of `runners.ts` runs (`run-all.ts` skips `helpers/`): it
 * finishes with a result, or throws when its arguments ask it to.
 */
import { defineHandler } from "@kingsleyweb/bun-jobs";

/** What a sweep run is told. */
export interface SweepArgs {
  /** Whether this run throws instead of finishing. */
  fail?: boolean;
}

export default defineHandler<SweepArgs, string>((ctx) => {
  if (ctx.args?.fail === true) {
    throw new Error("the sweep failed");
  }
  return "swept";
});
