import { UnrecoverableJobError } from "@kingsleyweb/bun-jobs";

/**
 * A guard denied a job. It goes to `dead` with no retry, because a retry would
 * ask the same guard the same question. bun-jobs keys that on the error's
 * **name**, which is `UnrecoverableJobError`'s here, so it survives a process
 * boundary too. `onDenied: "retry"` on a processor keeps the retry instead.
 *
 * The original `ForbiddenException` is its `cause`. Nest's own denial carries
 * the message `"Forbidden resource"`, and that is how it is told apart from
 * what a guard throws itself: a guard's own `ForbiddenException` with that same
 * message is treated alike.
 *
 * Its `code`, `"JOB_FORBIDDEN"`, is what tells a denial apart once the job is
 * stored, in `job.failedReason.code`: the class is gone by then, and the name is
 * `UnrecoverableJobError`'s.
 */
export class JobForbiddenError extends UnrecoverableJobError {
  /** `"JOB_FORBIDDEN"`, which survives into the stored job's `failedReason`. */
  override readonly code: string = "JOB_FORBIDDEN";

  constructor(
    /** Why, with the handler named. */
    message: string,
    /** Extra detail, safe to log. */
    context?: Record<string, unknown>,
    /** Standard error options: `cause` is the denial. */
    options?: { cause?: unknown },
  ) {
    super(message, context, options);
    this.name = "UnrecoverableJobError";
  }
}
