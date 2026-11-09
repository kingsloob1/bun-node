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
 */
export class JobForbiddenError extends UnrecoverableJobError {
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
