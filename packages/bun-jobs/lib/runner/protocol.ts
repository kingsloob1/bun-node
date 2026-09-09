import type { SerializedError } from "@kingsleyweb/bun-common";
import type { DriverConfig, ExecutionMode, RunSource } from "../drivers/index";
import process from "node:process";

/**
 * The parent/child protocol, shared by the spawn and worker executors.
 *
 * Everything crosses as JSON (`serialization: "json"` for a child process,
 * pre-cloned values for a worker) so a run behaves identically in all three
 * modes — the same payload a handler sees in-process is what it sees in a
 * child, losses included.
 */

/** Protocol version, so a rolling upgrade can tell shapes apart. */
export const PROTOCOL_VERSION = 1;

/** Environment variables every child receives. */
export const CHILD_ENV = {
  /** `"1"` inside a runner child, so a module can skip side effects. */
  marker: "BUN_JOBS_CHILD",
  /** Which executor started it. */
  mode: "BUN_JOBS_MODE",
  /** The namespace the run belongs to. */
  namespace: "BUN_JOBS_NAMESPACE",
  /** The runner's id. */
  runnerId: "BUN_JOBS_RUNNER_ID",
  /** The run's id. */
  runId: "BUN_JOBS_RUN_ID",
  /** The handler file to import. */
  file: "BUN_JOBS_FILE",
} as const;

/** The part of a run context that can cross a process boundary. */
export interface SerializableContext<TArgs = unknown> {
  /** Identifies this run. */
  runId: string;
  /** The runner that started it. */
  runnerId: string;
  /** The runner's display name. */
  runnerName: string;
  /** The namespace the runner belongs to. */
  namespace: string;
  /** 1-based attempt number. */
  attempt: number;
  /** What asked for the run. */
  source: RunSource;
  /** Where the run is executing. */
  mode: ExecutionMode;
  /** When the run started, in epoch milliseconds. */
  startedAt: number;
  /** When the run will be aborted, or `null`. */
  deadline: number | null;
  /** Arguments for this run. */
  args: TArgs;
  /** How the handler can build a driver for the runner's backend. */
  driverConfig?: DriverConfig;
  /** The handler file to import. */
  file: string;
  /** How long the child has to unwind after `close` before it exits itself. */
  closeTimeout: number;
  /** Whether the child's logger should be forwarded to the parent. */
  forwardLogs: boolean;
}

/** Messages the parent sends. */
export type ParentToChild =
  | { t: "start"; runId: string; ctx: SerializableContext<any> }
  | { t: "message"; runId: string; data: unknown }
  | {
      t: "close";
      runId: string;
      reason: "timeout" | "stop" | "kill" | "lock-lost";
    };

/** Messages the child sends. */
export type ChildToParent =
  | { t: "ready"; pid: number; protocol: number }
  | { t: "started"; runId: string }
  | { t: "progress"; runId: string; value: unknown }
  | { t: "message"; runId: string; data: unknown }
  | {
      t: "log";
      runId: string;
      level: string;
      message: string;
      fields: unknown;
    }
  | { t: "done"; runId: string; result: unknown }
  | { t: "error"; runId: string; error: SerializedError };

/** Whether the current process is a runner child. */
export function isRunnerChild(): boolean {
  return process.env[CHILD_ENV.marker] === "1";
}

/** Exit code a child uses when it stops itself after a `close`. */
export const CLOSE_EXIT_CODE = 143;
