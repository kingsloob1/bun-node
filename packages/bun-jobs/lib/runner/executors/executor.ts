import type { LogLevel, SerializedError } from "@kingsleyweb/bun-common";
import type { ExecutionMode, JobRecord, RunStatus } from "../../drivers/index";
import type { Job } from "../../queue/Job";
import type { ProcessorContext } from "../../queue/types";
import type { LogFields } from "../../shared/logger";
import type { RunContext, RunnerHandler, RunProgress } from "../types";
import { InvalidHandlerError } from "../../shared/errors";

/**
 * What every execution mode has to provide.
 *
 * A run is the same thing in all three modes — a context in, an outcome out —
 * so `runner-modes.test.ts` can assert the modes are interchangeable. What
 * differs is only *where* the handler runs, and therefore how much of it can
 * be forcibly stopped.
 */

/** How a run ended, from the executor's point of view. */
export interface RunOutcome {
  /** The terminal status. */
  status: Exclude<RunStatus, "running">;
  /** The handler's return value, when it produced one. */
  result?: unknown;
  /** The failure, flattened for storage and for crossing a boundary. */
  error?: SerializedError;
  /** The child's exit code, when it had one. */
  exitCode?: number | null;
  /** The signal that killed the child, when one did. */
  signal?: string | null;
  /** The child's process id, when it had one. */
  pid?: number;
  /**
   * Set when the run could not actually be stopped and may still be running.
   * Only in-process runs can end up here.
   */
  detached?: boolean;
}

/**
 * Callbacks an executor uses to report a run's progress as it happens.
 *
 * Messages stay `unknown` at this layer on purpose: an executor is transport,
 * carrying both a handler's own messages and the isolated-job channel, and
 * never knows a handler's declared types. `BunRunner` is where they are
 * asserted.
 */
export interface ExecutorEvents {
  /** The handler reported progress. */
  onProgress: (value: RunProgress) => void;
  /** The handler sent a message. */
  onMessage: (data: unknown) => void;
  /** The handler logged something (forwarded from a child). */
  onLog: (level: LogLevel, message: string, fields: LogFields) => void;
  /** A child wrote to a piped stream. */
  onOutput: (stream: "stdout" | "stderr", chunk: string) => void;
  /** The run has a process id. */
  onPid: (pid: number) => void;
}

/** A run in progress, as the runner sees it. */
export interface ExecutorHandle {
  /** Resolves when the run settles. Never rejects. */
  done: Promise<RunOutcome>;
  /**
   * Asks the run to stop: aborts its signal, and escalates to `SIGTERM` then
   * `SIGKILL` for a child that ignores it. `force` skips straight to the end
   * of the escalation.
   */
  stop: (reason: string, options?: { force?: boolean }) => void;
  /** Sends a message to the running handler. */
  send: (message: unknown) => boolean;
}

/** Everything an executor needs to start one run. */
export interface ExecutorStartOptions<TArgs = unknown> {
  /** The context handed to the handler. Serialisable except for `driver`. */
  context: RunContext<TArgs>;
  /** The resolved handler file. */
  file: string;
  /** Per-run timeout in milliseconds; `0` means none. */
  timeout: number;
  /** Grace after asking the run to stop, before escalating. */
  closeTimeout: number;
  /** Grace after `SIGTERM`, before `SIGKILL`. */
  killTimeout: number;
  /** Whether the run should keep the process alive. */
  waitToExit: boolean;
  /**
   * Whether a child's `ctx.logger` records should be forwarded to the parent
   * as `log` events instead of going to the child's own stdout.
   */
  forwardLogs: boolean;
  /** Callbacks for events the run produces. */
  events: ExecutorEvents;
  /**
   * What the file's default export is: a runner handler (the default), or a
   * queue job processor, called with the job in `job`.
   */
  kind?: "run" | "job";
  /** The job to process, when `kind` is `"job"`. */
  job?: JobRecord;
}

/** One way of running a handler file. */
export interface Executor {
  /** Which mode this executor implements. */
  readonly mode: ExecutionMode;
  /** Starts a run. */
  start: <TArgs>(options: ExecutorStartOptions<TArgs>) => ExecutorHandle;
}

/**
 * The job an isolated processor is handed in a child process or `Worker`: a
 * plain object standing in for a {@link Job}, since the real class needs a
 * driver the child does not have.
 *
 * It is every public member of `Job`, as a structural copy without the class's
 * private fields, so a member the child forgets to build is a compile error in
 * `isolatedJob` (`bootstrap/child-runtime.ts`) rather than a missing method at
 * runtime.
 */
export type IsolatedJob = Pick<
  Job<unknown, unknown>,
  keyof Job<unknown, unknown>
>;

/**
 * A processor file's default export, as the package calls it: with a job and
 * its context. Its declared data and result types are the file's own and
 * cannot be known where the file is imported, and the result may cross a
 * process boundary as JSON, so the return value stays `unknown`.
 */
export type IsolatedJobProcessor = (
  job: IsolatedJob,
  ctx: ProcessorContext,
) => unknown;

/**
 * Checks a module's default export and returns it as a handler.
 *
 * The contract is deliberately narrow — a file default-exports one function —
 * so a mistake (exporting an object, forgetting `default`) is reported as
 * exactly that instead of failing later with "not a function".
 *
 * `kind` says how the caller will invoke it, and only changes the return type:
 * a runner handler (the default) or a queue job processor. The module is what
 * a dynamic `import()` returned, so it is checked rather than trusted.
 */
export function toHandler(
  module: unknown,
  file: string,
  kind?: "run",
): RunnerHandler;
export function toHandler(
  module: unknown,
  file: string,
  kind: "job",
): IsolatedJobProcessor;
export function toHandler(
  module: unknown,
  file: string,
  _kind: "run" | "job" = "run",
): RunnerHandler | IsolatedJobProcessor {
  if (typeof module === "function") {
    return module as RunnerHandler;
  }

  if (typeof module !== "object" || module === null) {
    throw new InvalidHandlerError(file, `the module is ${typeof module}`);
  }

  const candidate = (module as { default?: unknown }).default;
  if (typeof candidate === "function") {
    return candidate as RunnerHandler<any, any>;
  }

  if (candidate === undefined) {
    throw new InvalidHandlerError(file, "there is no default export");
  }

  throw new InvalidHandlerError(
    file,
    `the default export is ${typeof candidate}`,
  );
}
