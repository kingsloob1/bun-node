/**
 * The package's error types.
 *
 * Every one carries a stable `code`, so a caller can branch on the failure
 * without matching message text — and so an error still identifies itself
 * after crossing a process boundary, where the class is gone and only the
 * serialised `name`/`code` survive (see `serializeError` in bun-common).
 */

/** Base class: everything thrown by this package is one of these. */
export class JobsError extends Error {
  /** Stable identifier for the failure, e.g. `"LOCK_LOST"`. */
  readonly code: string;
  /** Extra detail about the failure, safe to log. */
  readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    context?: Record<string, unknown>,
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
    driver: string,
    operation: string,
    cause: unknown,
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
  constructor(key: string, context?: Record<string, unknown>) {
    super(`Lock ${key} is held elsewhere`, "LOCK_UNAVAILABLE", {
      key,
      ...context,
    });
  }
}

/**
 * A lock was lost mid-work: it expired, or another holder took it. The work
 * has to stop — whatever it was protecting is no longer exclusively ours.
 */
export class LockLostError extends JobsError {
  constructor(key: string, context?: Record<string, unknown>) {
    super(`Lock ${key} was lost`, "LOCK_LOST", { key, ...context });
  }
}

/** A run or a job attempt outlived its timeout. */
export class JobTimeoutError extends JobsError {
  /** The budget that elapsed, in milliseconds. */
  readonly ms: number;

  constructor(ms: number, context?: Record<string, unknown>) {
    super(`Timed out after ${ms}ms`, "JOB_TIMEOUT", { ms, ...context });
    this.ms = ms;
  }
}

/**
 * Thrown by a handler to say "this will never succeed" — the job goes
 * straight to the dead set with no further attempts.
 */
export class UnrecoverableJobError extends JobsError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "UNRECOVERABLE_JOB", context);
  }
}

/** A child process exited without reporting a result. */
export class ChildExitError extends JobsError {
  /** The child's exit code, when it exited normally. */
  readonly exitCode: number | null;
  /** The signal that killed the child, when one did. */
  readonly signalCode: string | null;

  constructor(
    exitCode: number | null,
    signalCode: string | null,
    context?: Record<string, unknown>,
  ) {
    super(
      `Child exited (code ${exitCode ?? "null"}, signal ${signalCode ?? "null"}) before reporting a result`,
      "CHILD_EXIT",
      { exitCode, signalCode, ...context },
    );
    this.exitCode = exitCode;
    this.signalCode = signalCode;
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

  constructor(reason: string, context?: Record<string, unknown>) {
    super(`Run was killed: ${reason}`, "RUN_KILLED", { reason, ...context });
    this.reason = reason;
  }
}

/** A runner's file has no usable default export. */
export class InvalidHandlerError extends JobsError {
  constructor(file: string, detail: string) {
    super(
      `${file} does not default-export a handler function: ${detail}`,
      "INVALID_HANDLER",
      { file },
    );
  }
}

/** A runner was triggered after it stopped. */
export class RunnerStoppedError extends JobsError {
  constructor(id: string) {
    super(`Runner ${id} is stopped`, "RUNNER_STOPPED", { id });
  }
}

/** A queue was used after `close()`. */
export class QueueClosedError extends JobsError {
  constructor(queue: string) {
    super(`Queue ${queue} is closed`, "QUEUE_CLOSED", { queue });
  }
}

/** A worker was used after `close()`. */
export class WorkerClosedError extends JobsError {
  constructor(id: string) {
    super(`Worker ${id} is closed`, "WORKER_CLOSED", { id });
  }
}

/** A value could not cross a boundary as JSON. */
export class SerializationError extends JobsError {
  constructor(what: string, cause?: unknown) {
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
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "CONFIG", context);
  }
}

/** A bounded queue (of triggers, or of jobs) is full. */
export class QueueFullError extends JobsError {
  constructor(what: string, max: number) {
    super(`${what} is full (max ${max})`, "QUEUE_FULL", { what, max });
  }
}
