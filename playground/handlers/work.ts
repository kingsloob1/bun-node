import process from "node:process";
import { isMainThread } from "node:worker_threads";
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
 *
 * It writes its progress three ways, so a run's log has something of each on
 * the runner screen: `ctx.log()` lines (the `log` stream), `console.log`/
 * `console.info` on `stdout`, and `console.warn` (every run, on its second
 * step) and `console.error` (when it fails) on `stderr`. Every execution
 * mode captures all of it: a `spawn` run through its pipes, a `worker` or
 * `in-process` run by attributing each console call to the run that made it
 * — the output still reaches this process's terminal too.
 *
 * Its first `stdout` line carries a made-up `apiKey=…`, so the run log shows
 * capture's default redaction: the value is stored redacted, not as printed.
 */
export default defineHandler<WorkArgs, string>(async (ctx) => {
  const ms = ctx.args?.ms ?? 2_000 + Math.floor(Math.random() * 6_000);
  ctx.logger.info("working", { ms });
  // Where this run is executing, with the evidence rather than only the
  // label: a `spawn` run is a pid of its own, a `worker` run shares the
  // parent's pid off the main thread, and `in-process` is the parent's pid on
  // it. `archive` is the runner whose mode can be changed from the UI
  // (Settings… offers all three), so switching it and triggering a run shows
  // this line change.
  ctx.log(
    `running ${ctx.mode} — pid ${process.pid}, main thread ${String(isMainThread)}`,
    {
      level: "info",
      fields: { mode: ctx.mode, pid: process.pid, mainThread: isMainThread },
    },
  );
  ctx.log("starting", { level: "info", fields: { ms } });
  // A made-up credential: the stored line has its value redacted.
  console.info(`connecting to upstream with apiKey=pk_demo_${ctx.runnerId}`);
  const steps = 4;
  const step = Math.max(1, Math.round(ms / steps));
  /** Waits `delay` ms, resolving `true` when the run is asked to stop first. */
  const wait = (delay: number) =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(resolve, delay, false);
      ctx.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        { once: true },
      );
    });

  for (let done = 1; done <= steps; done++) {
    if (await wait(step)) {
      ctx.log("asked to stop", { level: "warn" });
      return "stopped";
    }
    // `stdout` in the run's log, whichever mode it runs in.
    console.log(`step ${done}/${steps} of ${ctx.runnerId}`);
    if (done === 2) {
      // `stderr` in the run's log — an in-process run's too.
      console.warn(
        `upstream slow on step ${done} of ${ctx.runnerId}, carrying on`,
      );
    }
    ctx.log(`step ${done} done`, { level: "debug", fields: { done, steps } });
  }
  if (Math.random() < (ctx.args?.failRate ?? 0)) {
    console.error("upstream answered 503, giving up");
    ctx.log("failing this run", { level: "error" });
    throw new Error("upstream answered 503 Service Unavailable");
  }
  ctx.log("finished", { level: "info", fields: { ms } });
  return `done in ${ms} ms`;
});
