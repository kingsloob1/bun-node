import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { Injectable } from "@nestjs/common";
import { tap } from "rxjs";
import { BunJobsExecutionContext, isBunJobsContext } from "./executionContext";

/**
 * Logs one line per attempt through the job's own logger: its name, attempt,
 * duration and outcome. Passes anything but a job through, so it can sit on a
 * global list.
 *
 * Interceptors that should not exist for jobs: an `rxjs` `retry()` retries inside
 * one attempt, under one lock, invisibly to `attemptsMade`, backoff and dead
 * letters, so use the job's `attempts`. An `rxjs` `timeout()` abandons the work
 * without aborting it, so use the job's `timeout`, which aborts `ctx.signal`.
 */
export class JobLoggingInterceptor implements NestInterceptor {
  /** Times the attempt, and logs how it ended. */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!isBunJobsContext(context)) {
      return next.handle();
    }
    const host = BunJobsExecutionContext.create(context);
    const job = host.getJob();
    const { attempt, logger } = host.getProcessorContext();
    const started = performance.now();
    const fields = () => ({
      jobId: job.id,
      name: job.name,
      attempt,
      durationMs: Math.round(performance.now() - started),
    });
    return next.handle().pipe(
      tap({
        next: () => {
          logger.info(`job ${job.name} completed`, {
            ...fields(),
            outcome: "completed",
          });
        },
        error: (error: unknown) => {
          logger.warn(`job ${job.name} failed`, {
            ...fields(),
            outcome: "failed",
            error,
          });
        },
      }),
    );
  }
}

// `@Injectable()` by call: Bun reads the decorator options from the working
// directory's tsconfig (oven-sh/bun#28605).
Injectable()(JobLoggingInterceptor);
