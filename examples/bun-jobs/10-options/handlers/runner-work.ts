/**
 * A cooperative unit of work: it sleeps for `ms` in small steps, checking
 * `ctx.signal` between them, and throws the moment it is aborted — so a kill,
 * a stop, a timeout or a lost lock ends it well inside any grace period.
 *
 * `fail` makes it throw instead, for the failure paths.
 */
import { defineHandler } from "@kingsleyweb/bun-jobs";

/** Arguments the work handler accepts. */
export interface WorkArgs {
  /** How long to work, in milliseconds. Defaults to `0`. */
  ms?: number;
  /** Echoed back, so a run can be told apart from another. */
  tag?: string;
  /** When set, throw an `Error` with this message after working. */
  fail?: string;
  /**
   * Send `"working"` before starting, so a caller can wait until the handler
   * is really listening before it kills the run.
   */
  announce?: boolean;
}

/** What a finished run reports. */
export interface WorkResult {
  /** The `tag` it was given. */
  tag: string | null;
  /** What asked for the run. */
  source: string;
  /** The run's id. */
  runId: string;
}

export default defineHandler<WorkArgs, WorkResult>(async (ctx) => {
  if (ctx.args?.announce) {
    ctx.send("working");
  }

  const until = Date.now() + (ctx.args?.ms ?? 0);

  while (Date.now() < until) {
    if (ctx.signal.aborted) {
      throw new Error("aborted: unwound cleanly");
    }
    await Bun.sleep(5);
  }

  if (ctx.args?.fail) {
    throw new Error(ctx.args.fail);
  }

  return { tag: ctx.args?.tag ?? null, source: ctx.source, runId: ctx.runId };
});
