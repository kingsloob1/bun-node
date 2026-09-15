/**
 * The package's error types.
 *
 * Every one carries a stable `code`, so a caller can branch on the failure
 * without matching message text — and so an error still identifies itself
 * after crossing a process boundary, where the class is gone and only the
 * serialised `name`/`code` survive (see `serializeError` in bun-common).
 *
 * Each class that fills in part of `context` itself declares that part, so
 * `error.context.ms` on a {@link JobTimeoutError} is a `number` rather than
 * `unknown`. The rest of `context` is whatever the throwing site added, and
 * stays open.
 *
 * The error's own fields are spread *after* the caller's detail, so they win:
 * a caller — typed or not — can add to `context` but never replace what the
 * declared type promises.
 */

/**
 * Extra detail a caller adds to an error's `context`: open, but never one of
 * the `TReserved` fields the error sets itself. At runtime the error's own
 * value wins regardless; the type makes the mistake visible where it is made.
 */
export type ErrorContext<TReserved extends string = never> = Record<
  string,
  unknown
> & { [Key in TReserved]?: never };

/** Base class: everything thrown by this package is one of these. */
export class JobsError extends Error {
  /** Stable identifier for the failure, e.g. `"LOCK_LOST"`. */
  readonly code: string;
  /** Extra detail about the failure, safe to log. */
  readonly context?: Record<string, unknown>;

  constructor(
    /** The human-readable description. */
    message: string,
    /** Stable identifier for the failure, e.g. `"LOCK_LOST"`. */
    code: string,
    /** Extra detail about the failure, safe to log. */
    context?: Record<string, unknown>,
    /** Standard error options. `cause` is whatever was caught, so it stays `unknown`. */
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.context = context;
  }
}

/** A driver operation failed. Wraps the backend's own error as `cause`. */
export class DriverError extends JobsError {
  /** The driver that failed, e.g. `"redis"`. */
  readonly driver: string;
  /** The contract method that failed, e.g. `"claimJob"`. */
  readonly operation: string;

  constructor(
    /** The driver that failed, e.g. `"redis"`. */
    driver: string,
    /** The contract method that failed, e.g. `"claimJob"`. */
    operation: string,
    /** The backend's own error, as caught — anything a client library throws. */
    cause: unknown,
    /** Extra detail about the failure, safe to log. */
    context?: Record<string, unknown>,
  ) {
    super(
      `${driver} driver failed during ${operation}`,
      "DRIVER_ERROR",
      context,
      { cause },
    );
    this.driver = driver;
    this.operation = operation;
  }
}

/** A lock is held elsewhere, so the caller may not proceed. */
export class LockUnavailableError extends JobsError {
  /** The lock's key, plus any detail the throwing site added. */
  declare readonly context: { key: string } & Record<string, unknown>;

  constructor(
    /** The lock's key. */
    key: string,
    /** Extra detail, safe to log. May not set `key`. */
    context?: ErrorContext<"key">,
  ) {
    super(`Lock ${key} is held elsewhere`, "LOCK_UNAVAILABLE", {
      ...context,
      key,
    });
  }
}

/**
 * A lock was lost mid-work: it expired, or another holder took it. The work
 * has to stop — whatever it was protecting is no longer exclusively ours.
 */
export class LockLostError extends JobsError {
  /** The lock's key, plus any detail the throwing site added. */
  declare readonly context: { key: string } & Record<string, unknown>;

  constructor(
    /** The lock's key. */
    key: string,
    /** Extra detail, safe to log. May not set `key`. */
    context?: ErrorContext<"key">,
  ) {
    super(`Lock ${key} was lost`, "LOCK_LOST", { ...context, key });
  }
}

/** A run or a job attempt outlived its timeout. */
export class JobTimeoutError extends JobsError {
  /** The budget that elapsed, in milliseconds. */
  readonly ms: number;
  /** The budget, plus any detail the throwing site added. */
  declare readonly context: { ms: number } & Record<string, unknown>;

  constructor(
    /** The budget that elapsed, in milliseconds. */
    ms: number,
    /** Extra detail, safe to log. May not set `ms`. */
    context?: ErrorContext<"ms">,
  ) {
    super(`Timed out after ${ms}ms`, "JOB_TIMEOUT", { ...context, ms });
    this.ms = ms;
  }
}

/**
 * Thrown by a handler to say "this will never succeed" — the job goes
 * straight to the dead set with no further attempts.
 */
export class UnrecoverableJobError extends JobsError {
  constructor(
    /** Why the job can never succeed. */
    message: string,
    /** Extra detail, safe to log. */
    context?: Record<string, unknown>,
  ) {
    super(message, "UNRECOVERABLE_JOB", context);
  }
}

/** A child process exited without reporting a result. */
export class ChildExitError extends JobsError {
  /** The child's exit code, when it exited normally. */
  readonly exitCode: number | null;
  /** The signal that killed the child, when one did. */
  readonly signalCode: string | null;
  /** The exit code and signal, plus any detail the throwing site added. */
  declare readonly context: {
    exitCode: number | null;
    signalCode: string | null;
  } & Record<string, unknown>;

  constructor(
    /** The child's exit code, or `null` when a signal ended it. */
    exitCode: number | null,
    /** The signal that killed the child, or `null`. */
    signalCode: string | null,
    /** Extra detail, safe to log. May not set `exitCode` or `signalCode`. */
    context?: ErrorContext<"exitCode" | "signalCode">,
  ) {
    super(
      `Child exited (code ${exitCode ?? "null"}, signal ${signalCode ?? "null"}) before reporting a result`,
      "CHILD_EXIT",
      { ...context, exitCode, signalCode },
    );
    this.exitCode = exitCode;
    this.signalCode = signalCode;
  }
}

/**
 * Why a parent in a flow was buried: one of its children failed for good, and
 * was not marked `ignoreFailure`. Names the child, and carries its message.
 */
export class ChildFailedError extends JobsError {
  /** The child that failed, as `queue:id`. */
  readonly child: string;
  /** The child as `queue:id` and its failure message, plus any added detail. */
  declare readonly context: { child: string; cause: string } & Record<
    string,
    unknown
  >;

  constructor(
    /** The child that failed: its queue, in the parent's namespace, and id. */
    child: { queue: string; id: string },
    /**
     * Why the child failed — its own reason, or for a child that was itself a
     * buried parent, the `ChildFailedError` that buried it. Only the message is
     * carried, into this error's message and `context.cause`.
     */
    cause: { name?: string; message: string },
    /** Extra detail to record beside `child` and `cause`, safe to log. May not set either. */
    context?: ErrorContext<"child" | "cause">,
  ) {
    super(
      `Child ${child.queue}:${child.id} failed: ${cause.message}`,
      "CHILD_FAILED",
      { ...context, child: `${child.queue}:${child.id}`, cause: cause.message },
    );
    this.child = `${child.queue}:${child.id}`;
  }
}

/**
 * A run was stopped on request — `kill()`, a stopping runner, a lost lock —
 * rather than failing on its own.
 *
 * Distinct from {@link ChildExitError}, which means a child ended without
 * reporting anything. A run asked to stop may well have unwound cleanly and
 * exited, and describing that as a child that "exited before reporting a
 * result" sent people looking for a crash that never happened.
 */
export class RunKilledError extends JobsError {
  /** Why it was stopped, as the caller gave it. */
  readonly reason: string;
  /** The reason, plus any detail the throwing site added. */
  declare readonly context: { reason: string } & Record<string, unknown>;

  constructor(
    /** Why it was stopped. */
    reason: string,
    /** Extra detail, safe to log. May not set `reason`. */
    context?: ErrorContext<"reason">,
  ) {
    super(`Run was killed: ${reason}`, "RUN_KILLED", { ...context, reason });
    this.reason = reason;
  }
}

/** A runner's file has no usable default export. */
export class InvalidHandlerError extends JobsError {
  /** The handler file. */
  declare readonly context: { file: string };

  constructor(
    /** The handler file. */
    file: string,
    /** What is wrong with its export. */
    detail: string,
  ) {
    super(
      `${file} does not default-export a handler function: ${detail}`,
      "INVALID_HANDLER",
      { file },
    );
  }
}

/** A runner was triggered after it stopped. */
export class RunnerStoppedError extends JobsError {
  /** The runner's id. */
  declare readonly context: { id: string };

  constructor(
    /** The runner's id. */
    id: string,
  ) {
    super(`Runner ${id} is stopped`, "RUNNER_STOPPED", { id });
  }
}

/** A queue was used after `close()`. */
export class QueueClosedError extends JobsError {
  /** The queue's name. */
  declare readonly context: { queue: string };

  constructor(
    /** The queue's name. */
    queue: string,
  ) {
    super(`Queue ${queue} is closed`, "QUEUE_CLOSED", { queue });
  }
}

/** A worker was used after `close()`. */
export class WorkerClosedError extends JobsError {
  /** The worker's id. */
  declare readonly context: { id: string };

  constructor(
    /** The worker's id. */
    id: string,
  ) {
    super(`Worker ${id} is closed`, "WORKER_CLOSED", { id });
  }
}

/** A value could not cross a boundary as JSON. */
export class SerializationError extends JobsError {
  /** What could not be serialised, e.g. `"job.data"`. */
  declare readonly context: { what: string };

  constructor(
    /** What could not be serialised, e.g. `"job.data"`. */
    what: string,
    /** What `JSON.stringify` threw, as caught. */
    cause?: unknown,
  ) {
    super(
      `${what} is not JSON-serialisable`,
      "SERIALIZATION",
      { what },
      {
        cause,
      },
    );
  }
}

/** An option is missing, malformed or contradictory. */
export class ConfigError extends JobsError {
  constructor(
    /** What is wrong, and ideally how to fix it. */
    message: string,
    /** The offending values, safe to log. */
    context?: Record<string, unknown>,
  ) {
    super(message, "CONFIG", context);
  }
}

/** A bounded queue (of triggers, or of jobs) is full. */
export class QueueFullError extends JobsError {
  /** What is full, and its cap. */
  declare readonly context: { what: string; max: number };

  constructor(
    /** What is full, e.g. `"trigger queue"`. */
    what: string,
    /** Its cap. */
    max: number,
  ) {
    super(`${what} is full (max ${max})`, "QUEUE_FULL", { what, max });
  }
}

/**
 * A message between processes did not have the shape its protocol promises —
 * for example a job-channel reply with no value, or one of the wrong type.
 *
 * It means the two sides disagree (a rolling upgrade, a bug), never that the
 * operation itself failed, so it is raised rather than papered over with a
 * made-up answer.
 */
export class ProtocolError extends JobsError {
  /** What was being exchanged and what was wrong with it, plus any added detail. */
  declare readonly context: { operation: string; problem: string } & Record<
    string,
    unknown
  >;

  constructor(
    /** The exchange that went wrong, e.g. `job channel "log"`. */
    operation: string,
    /** What was wrong with the message. */
    problem: string,
    /** Extra detail, safe to log. May not set `operation` or `problem`. */
    context?: ErrorContext<"operation" | "problem">,
  ) {
    super(`Protocol error in ${operation}: ${problem}`, "PROTOCOL", {
      ...context,
      operation,
      problem,
    });
  }
}
