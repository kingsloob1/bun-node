import type { LogLevel, SerializedError } from "@kingsleyweb/bun-common";
import type {
  DriverConfig,
  ExecutionMode,
  JobRecord,
  RunSource,
} from "../drivers/index";
import type { LogFields } from "../shared/logger";
import type { RunProgress } from "./types";
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
  /**
   * Whether the child should capture its handler's console calls and send
   * them as `output` messages. Set only for a `worker` run, which shares no
   * pipe with its parent; absent means no.
   */
  captureConsole?: boolean;
  /**
   * What the child runs: a runner handler called with a run context (the
   * default), or a queue job processor called with a job and its context.
   */
  kind?: "run" | "job";
  /** The job being processed, when `kind` is `"job"`. */
  job?: JobRecord;
}

/**
 * The key marking a message as part of an isolated job's request and reply
 * channel rather than a user message.
 *
 * A job processor in a child has no driver, so the few job operations that
 * need one — appending to its log, renewing its lock — are asked of the
 * worker, which does have one, and answered back. They ride the existing
 * `message` channel, tagged with this key so they never reach a handler's own
 * `onMessage` listeners.
 */
export const JOB_CHANNEL = "__bunJobsJob";

/**
 * What the worker answers each job-channel operation with, by name: the
 * log's line count for `"log"`, whether the lock is still held for
 * `"heartbeat"`.
 */
export interface JobChannelReplies {
  /** How many lines the job's log keeps after the append. */
  log: number;
  /** Whether the job's lock is still held. */
  heartbeat: boolean;
  /** `job.getChildrenValues()`: completed children's results, keyed `queue:id`. */
  childrenValues: Record<string, unknown>;
  /**
   * `job.getChildrenFailures()`: the failures of children marked
   * `ignoreFailure`, keyed `queue:id`, serialised to cross the boundary.
   */
  childrenFailures: Record<string, SerializedError>;
}

/** An operation an isolated job can ask of its worker. */
export type JobChannelOperation = keyof JobChannelReplies;

/** A request an isolated job makes of its worker. */
export interface JobChannelRequest {
  /** Marks the message; the operation asked for. */
  [JOB_CHANNEL]: JobChannelOperation;
  /** Pairs the reply with the request. */
  seq: number;
  /** The line to log, for `"log"`. */
  line?: string;
  /**
   * For `"heartbeat"`: how long to extend the lock by, in milliseconds, as
   * `job.extendLock(ms)` asked. Absent for `ctx.heartbeat()` — and from a
   * child older than this field — in which case the worker renews for its own
   * `lockDuration`, as its heartbeat always has.
   */
  ms?: number;
}

/** What every {@link JobChannelReply} carries, whatever the outcome. */
interface JobChannelReplyBase {
  /** Marks the message as a reply. */
  [JOB_CHANNEL]: "reply";
  /** The request this answers. */
  seq: number;
}

/** A reply carrying the operation's answer. */
export interface JobChannelValueReply extends JobChannelReplyBase {
  /** The answer, shaped per operation as {@link JobChannelReplies} says. */
  value: JobChannelReplies[JobChannelOperation];
  /** Absent: a reply carries a value or an error, never both. */
  error?: never;
}

/**
 * A reply saying the operation failed in the worker. Only operations with no
 * safe fallback answer (reading a flow's children) reply this way; `log` and
 * `heartbeat` answer `0` and `false`.
 */
export interface JobChannelErrorReply extends JobChannelReplyBase {
  /** What the operation threw in the worker, serialised. */
  error: SerializedError;
  /** Absent: a reply carries a value or an error, never both. */
  value?: never;
}

/**
 * The worker's answer to a {@link JobChannelRequest}. A reply with neither a
 * value nor an error breaks the protocol, and the child rejects the request
 * with a `ProtocolError` rather than inventing an answer.
 */
export type JobChannelReply = JobChannelValueReply | JobChannelErrorReply;

/** Messages the parent sends. */
export type ParentToChild =
  | { t: "start"; runId: string; ctx: SerializableContext }
  // `data` is kept `unknown` on the wire: it is either a user message (whose
  // type only the handler knows) or a `JobChannelReply`, and the child tells
  // them apart at runtime.
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
  | { t: "progress"; runId: string; value: RunProgress }
  // A user message or a `JobChannelRequest`; the parent tells them apart.
  | { t: "message"; runId: string; data: unknown }
  | {
      t: "log";
      runId: string;
      level: LogLevel;
      message: string;
      fields: LogFields;
    }
  // One console call a `worker` run made, formatted and newline-terminated;
  // sent only when the context asked for `captureConsole`.
  | {
      t: "output";
      runId: string;
      stream: "stdout" | "stderr";
      chunk: string;
    }
  // The handler's return value, after a JSON round trip: nothing about its
  // type survives the crossing.
  | { t: "done"; runId: string; result: unknown }
  | { t: "error"; runId: string; error: SerializedError };

/** Whether the current process is a runner child. */
export function isRunnerChild(): boolean {
  return process.env[CHILD_ENV.marker] === "1";
}

/** Exit code a child uses when it stops itself after a `close`. */
export const CLOSE_EXIT_CODE = 143;
