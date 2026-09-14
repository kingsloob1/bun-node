/**
 * Reports every `RunContext` field, and where it is running, so
 * `runner-options.ts` can assert the context is the same in every execution
 * mode and that the `spawn` and `worker` options reached the child.
 *
 * It also exercises the context's callbacks: `progress` twice, `logger` once,
 * a line on stdout and one on stderr, and — when asked — a round trip of
 * messages (`ctx.send` out, `ctx.onMessage` back in).
 */
import process from "node:process";
import { isMainThread } from "node:worker_threads";
import { defineHandler, isRunnerChild } from "@kingsleyweb/bun-jobs";

/** Arguments the context handler accepts. */
export interface ContextArgs {
  /** Free-form marker, echoed back as `args`. */
  tag?: string;
  /** Send `{ ready: runId }` and wait for one message before returning. */
  waitForMessage?: boolean;
}

/** Everything the handler saw. */
export interface ContextReport {
  /** `ctx.runId`. */
  runId: string;
  /** `ctx.runnerId`. */
  runnerId: string;
  /** `ctx.runnerName`. */
  runnerName: string;
  /** `ctx.namespace`. */
  namespace: string;
  /** `ctx.attempt`. */
  attempt: number;
  /** `ctx.source`. */
  source: string;
  /** `ctx.mode`. */
  mode: string;
  /** `ctx.startedAt`. */
  startedAt: number;
  /** `ctx.deadline`. */
  deadline: number | null;
  /** `ctx.args`. */
  args: ContextArgs | null;
  /** Whether `ctx.signal` is an `AbortSignal`. */
  signalIsAbortSignal: boolean;
  /** Whether it was already aborted. */
  signalAborted: boolean;
  /** Whether `ctx.logger` has the structured logger's methods. */
  loggerIsStructured: boolean;
  /** Whether `progress`, `send` and `onMessage` are functions. */
  callbacksAreFunctions: boolean;
  /** `ctx.driverConfig`, or `null`. */
  driverConfig: unknown;
  /** Whether `ctx.driver` was set. */
  hasDriver: boolean;
  /** The message received through `ctx.onMessage`, when asked to wait. */
  received: unknown;
  /** `process.pid` where the handler ran. */
  pid: number;
  /** Whether it ran on the main thread. */
  isMainThread: boolean;
  /** `isRunnerChild()`: the `BUN_JOBS_CHILD` marker. */
  isChild: boolean;
  /** `process.cwd()`. */
  cwd: string;
  /** `process.argv`. */
  argv: string[];
  /** `EXAMPLE_OPTION_ENV` from the environment, or `null`. */
  env: string | null;
}

export default defineHandler<ContextArgs, ContextReport>(async (ctx) => {
  ctx.progress(50);
  ctx.progress({ phase: "half" });
  ctx.logger.info("context handler running", { marker: "log-marker" });
  console.log("stdout-marker");
  console.error("stderr-marker");

  let received: unknown = null;
  if (ctx.args?.waitForMessage) {
    received = await new Promise<unknown>((resolve) => {
      const unsubscribe = ctx.onMessage((message) => {
        unsubscribe();
        resolve(message);
      });
      ctx.send({ ready: ctx.runId });
    });
  }

  return {
    runId: ctx.runId,
    runnerId: ctx.runnerId,
    runnerName: ctx.runnerName,
    namespace: ctx.namespace,
    attempt: ctx.attempt,
    source: ctx.source,
    mode: ctx.mode,
    startedAt: ctx.startedAt,
    deadline: ctx.deadline,
    args: ctx.args ?? null,
    signalIsAbortSignal: ctx.signal instanceof AbortSignal,
    signalAborted: ctx.signal.aborted,
    loggerIsStructured:
      typeof ctx.logger.info === "function" &&
      typeof ctx.logger.child === "function",
    callbacksAreFunctions:
      typeof ctx.progress === "function" &&
      typeof ctx.send === "function" &&
      typeof ctx.onMessage === "function",
    driverConfig: ctx.driverConfig ?? null,
    hasDriver: ctx.driver !== undefined,
    received,
    pid: process.pid,
    isMainThread,
    isChild: isRunnerChild(),
    cwd: process.cwd(),
    argv: [...process.argv],
    env: process.env.EXAMPLE_OPTION_ENV ?? null,
  };
});
