/**
 * The runner handler behind `06-browser/runner-and-job-tools.ts`: it writes
 * a known log, then either returns or stays in flight until the example
 * opens the gate it names. It can also wait on a gate before it writes, so
 * the example starts the log once the page is following it.
 *
 * Its runs execute `in-process`, so the gates are shared through a global the
 * example installs ({@link LOG_RUNNER_GATES}); a run naming a gate that is
 * not there fails instead of hanging.
 */
import { defineHandler } from "@kingsleyweb/bun-jobs";

/** Where the example keeps its gates: promises by name. */
export const LOG_RUNNER_GATES = Symbol.for(
  "bun-node.examples.ui.log-runner.gates",
);

/** Arguments of one run. */
export interface LogRunnerArgs {
  /** How many `ctx.log()` lines to write, numbered `step 1`, `step 2`, …. Defaults to 0. */
  lines?: number;
  /** Milliseconds between two lines; 0 (the default) writes them at once. */
  everyMs?: number;
  /** Also write one `console.log` (captured as `stdout`) and one `console.error` (`stderr`) line. */
  consoleLines?: boolean;
  /** A secret-looking value to log as `password=<value>`, which capture redacts. */
  secret?: string;
  /** A gate to wait on after logging, keeping the run in flight. */
  hold?: string;
  /** A gate to wait on before the first line, so the log starts once the example says. */
  start?: string;
}

/** Waits for the gate `name`, or for the run to be stopped; a run naming a gate that is not there fails. */
async function waitOnGate(name: string, signal: AbortSignal): Promise<void> {
  const gates = (globalThis as Record<symbol, unknown>)[LOG_RUNNER_GATES] as
    Map<string, Promise<void>> | undefined;
  const gate = gates?.get(name);
  if (!gate) {
    throw new Error(`no gate named ${name}`);
  }
  // A kill or a stop ends the run too, so shutdown never hangs on it.
  await Promise.race([
    gate,
    new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
  ]);
}

export default defineHandler<LogRunnerArgs, { logged: number }>(async (ctx) => {
  const lines = ctx.args?.lines ?? 0;
  const everyMs = ctx.args?.everyMs ?? 0;
  if (ctx.args?.start !== undefined) {
    await waitOnGate(ctx.args.start, ctx.signal);
  }
  for (let index = 1; index <= lines; index++) {
    ctx.log(`step ${index}`, { level: index === lines ? "warn" : "info" });
    if (everyMs > 0) {
      // Flushed one by one, so the store (and the `logs` hint) sees each.
      await ctx.flushLogs();
      if (index < lines) {
        await Bun.sleep(everyMs);
      }
    }
  }
  if (ctx.args?.consoleLines === true) {
    console.log("[run output] rendered 3 pages");
    console.error("[run output] page 2 had a broken image");
  }
  if (ctx.args?.secret !== undefined) {
    ctx.log(`connecting with password=${ctx.args.secret}`);
  }
  await ctx.flushLogs();

  if (ctx.args?.hold !== undefined) {
    await waitOnGate(ctx.args.hold, ctx.signal);
  }
  return { logged: lines };
});
