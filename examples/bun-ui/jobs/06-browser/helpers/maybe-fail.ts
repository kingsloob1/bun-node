/**
 * A runner handler for `06-browser/overview-range.ts`: it returns, or throws
 * when its arguments ask it to. A run that threw is the one outcome a runner
 * series counts as `failed` (a timeout and a kill have counters of their
 * own), so the Overview's Runners section gets a known Failed figure.
 */
import { defineHandler } from "@kingsleyweb/bun-jobs";

/** Arguments of one run. */
export interface MaybeFailArgs {
  /** Throw instead of returning. */
  fail?: boolean;
}

export default defineHandler<MaybeFailArgs, { ok: true }>((ctx) => {
  if (ctx.args?.fail) {
    throw new Error("asked to fail");
  }
  return { ok: true };
});
