import { defineHandler } from "@kingsleyweb/bun-jobs";

/** Arguments a trigger may pass (the API's trigger dialog sends `args` when allowed). */
export interface WorkArgs {
  /** How long the run takes, in ms. Defaults to a random 2–8 s. */
  ms?: number;
  /** The chance it fails, 0–1. Defaults to 0. */
  failRate?: number;
}

/**
 * A runner's work: waits a while (stopping early when killed), then succeeds,
 * or fails with the given probability. Used by every playground runner.
 */
export default defineHandler<WorkArgs, string>(async (ctx) => {
  const ms = ctx.args?.ms ?? 2_000 + Math.floor(Math.random() * 6_000);
  ctx.logger.info("working", { ms });
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
  if (stopped) {
    return "stopped";
  }
  if (Math.random() < (ctx.args?.failRate ?? 0)) {
    throw new Error("upstream answered 503 Service Unavailable");
  }
  return `done in ${ms} ms`;
});
