/**
 * Running one attempt: building the `RemoteJob` and `RemoteContext`, holding
 * the attempt to its time, and turning what the handler did into an outcome.
 *
 * Browser-safe: Web APIs and the package's error types.
 */

import type { RunLogLevel } from "../../api/contract/constants";
import type { RunProgress } from "../../api/contract/types";
import type {
  InvokeEnvelope,
  RemoteError,
  RemoteFailOutcome,
  RemoteInvokeJob,
  RemoteOutcomeLog,
  RemoteResultOutcome,
} from "../types";
import type { RemoteContext, RemoteJob, RemoteJobHandler } from "./types";
import { JobTimeoutError, UnrecoverableJobError } from "../../shared/errors";

/** The most log lines one outcome carries; past it the oldest are dropped. */
export const MAX_OUTCOME_LOGS = 1000;
/** How deep a serialised error's `cause` chain goes. */
const MAX_CAUSE_DEPTH = 4;

/** An outcome the executor answers with, or remembers: completed or failed. */
export type SettledOutcome = RemoteResultOutcome | RemoteFailOutcome;

/** Which limit an attempt's time came from. */
export type TimeLimit = "maxDurationMs" | "timeoutMs" | "deadlineAt";

/** Own properties of an error that are serialised as fields, not as `data`. */
const STANDARD = new Set(["name", "message", "stack", "code", "cause"]);

/** A value as JSON, or `undefined` when it is not JSON-serialisable. */
function jsonClone(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Serialises a thrown value as bun-common's `SerializedError` shape, so the
 * gateway rebuilds it with `deserializeError()`: name, message, code, stack,
 * a bounded `cause` chain, and the error's other own properties as `data`.
 */
export function serializeError(error: unknown, depth = 0): RemoteError {
  if (!(error instanceof Error)) {
    if (error !== null && typeof error === "object") {
      const shaped = error as { name?: unknown; message?: unknown };
      if (typeof shaped.message === "string") {
        return {
          name: typeof shaped.name === "string" ? shaped.name : "Error",
          message: shaped.message,
        };
      }
    }
    return { name: "Error", message: String(error) };
  }
  const out: RemoteError = { name: error.name, message: error.message };
  const { code } = error as { code?: unknown };
  if (typeof code === "string" || typeof code === "number") {
    out.code = code;
  }
  if (typeof error.stack === "string") {
    out.stack = error.stack;
  }
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    out.cause = serializeError(error.cause, depth + 1);
  }
  const data: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    if (!STANDARD.has(key)) {
      const value = jsonClone(
        (error as unknown as Record<string, unknown>)[key],
      );
      if (value !== undefined) {
        data[key] = value;
      }
    }
  }
  if (Object.keys(data).length > 0) {
    out.data = data;
  }
  return out;
}

/** What one attempt needs from the executor. */
export interface AttemptInput {
  /** The invoke the job came in. */
  envelope: InvokeEnvelope;
  /** The job. */
  job: RemoteInvokeJob;
  /** The handler that runs it. */
  handler: RemoteJobHandler;
  /** How long it may run, in ms, and which limit set that. */
  budget: { ms: number; limit: TimeLimit };
  /** Where the attempt's controller is registered, so a `cancel` can abort it. */
  controller: AbortController;
  /** Forwards a handler's log line to the author's logger. */
  onLog: (
    level: RunLogLevel,
    message: string,
    fields: Record<string, unknown>,
  ) => void;
}

/** What running an attempt produced. */
export interface AttemptRun {
  /** The outcome to answer with: settled when the handler returned, threw, ran out of time or was cancelled. */
  outcome: Promise<SettledOutcome>;
  /**
   * Settles when the handler itself has returned or thrown, which may be
   * after the outcome when it ignored its signal. The slot it holds is freed
   * then, not before: it is still using the machine.
   */
  finished: Promise<void>;
}

/**
 * Runs one attempt. The outcome is answered at the first of: the handler
 * returning or throwing, its time running out (`failed`, a
 * `JobTimeoutError`), or a cancel (`failed`, the abort's reason). Once
 * answered, the handler's later return, logs and progress are discarded.
 */
export function runAttempt(input: AttemptInput): AttemptRun {
  const { envelope, job, handler, budget, controller } = input;
  const started = Date.now();
  const logs: RemoteOutcomeLog[] = [];
  let lines = 0;
  let progress: RunProgress | undefined;
  let over = false;
  const fields = {
    job: job.id,
    name: job.name,
    attempt: job.attempt,
    namespace: envelope.namespace,
    queue: envelope.queue,
    worker: envelope.worker.id,
  };

  const log = async (line: string): Promise<number> => {
    if (over) {
      return lines;
    }
    const text = String(line);
    logs.push({ at: Date.now(), line: text });
    if (logs.length > MAX_OUTCOME_LOGS) {
      logs.shift();
    }
    lines = logs.length;
    input.onLog("info", text, fields);
    return lines;
  };

  const remoteJob: RemoteJob = {
    id: job.id,
    name: job.name,
    data: job.data,
    queue: { ns: envelope.namespace, queue: envelope.queue },
    attemptsMade: job.attempt,
    maxAttempts: job.maxAttempts ?? 1,
    createdAt: job.createdAt ?? 0,
    priority: job.priority ?? 0,
    repeatKey: job.repeatKey ?? null,
    parent: job.parent ?? null,
    idempotencyKey: job.idempotencyKey,
    fence: job.fence,
    log,
    async updateProgress(value) {
      if (!over) {
        progress = value;
      }
    },
  };
  const ctx: RemoteContext = {
    signal: controller.signal,
    attempt: job.attempt,
    delivery: job.delivery,
    workerId: envelope.worker.id,
    invokeId: envelope.id,
    deadlineAt: envelope.deadlineAt,
    log,
    heartbeat: async () => {},
  };

  /** The outcome's common fields. */
  const base = () => ({
    job: job.id,
    attempt: job.attempt,
    fence: job.fence,
    durationMs: Date.now() - started,
    ...(progress === undefined ? {} : { progress }),
    ...(logs.length === 0 ? {} : { logs: [...logs] }),
  });

  const failure = (error: unknown): RemoteFailOutcome => {
    const serialized = serializeError(error);
    const fatal =
      error instanceof UnrecoverableJobError ||
      serialized.name === "UnrecoverableJobError";
    return {
      op: "fail",
      ...base(),
      status: fatal ? "failed-fatal" : "failed",
      error: serialized,
    };
  };

  if (budget.ms <= 0) {
    // Out of time before it started (the gateway's deadline has passed):
    // answered as a timeout, and the handler is never called.
    controller.abort(new JobTimeoutError(0, { limit: budget.limit }));
  }
  const handled: Promise<SettledOutcome> = (async () => {
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    const result: unknown = await handler(remoteJob, ctx);
    if (result === undefined) {
      return { op: "result", ...base(), status: "completed" } as const;
    }
    const cloned = jsonClone(result);
    if (cloned === undefined) {
      throw new TypeError(
        "The handler's result is not JSON-serialisable, so it cannot be sent back",
      );
    }
    return {
      op: "result",
      ...base(),
      status: "completed",
      result: cloned,
    } as const;
  })().catch(failure);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<SettledOutcome>((resolve) => {
    const onAbort = (): void => resolve(failure(controller.signal.reason));
    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    controller.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort(new JobTimeoutError(budget.ms, { limit: budget.limit }));
    }, budget.ms);
  });

  const outcome = Promise.race([handled, stopped]).then((settled) => {
    over = true;
    clearTimeout(timer);
    return settled;
  });
  return {
    outcome,
    finished: handled.then(() => {}),
  };
}
