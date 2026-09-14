/**
 * Reports where it is running, so `execution-modes.ts` can show the
 * difference between a child process, a `Worker` and the runner's own thread.
 */
import process from "node:process";
import { isMainThread } from "node:worker_threads";
import { defineHandler } from "@kingsleyweb/bun-jobs";

/** What a whoami run reports. */
export interface WhoAmI {
  /** The execution mode the runner chose. */
  mode: string;
  /** The process id the handler ran in. */
  pid: number;
  /** Whether it ran on a process's main thread (false inside a `Worker`). */
  mainThread: boolean;
  /** The arguments it was triggered with. */
  args: unknown;
}

export default defineHandler<{ greeting: string }, WhoAmI>((ctx) => ({
  mode: ctx.mode,
  pid: process.pid,
  mainThread: isMainThread,
  args: ctx.args,
}));
