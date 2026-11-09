import type { ArgumentsHost, ExceptionFilter, Type } from "@nestjs/common";
import { UnrecoverableJobError } from "@kingsleyweb/bun-jobs";
import { Catch } from "@nestjs/common";
import { isBunJobsContext } from "./executionContext";

/**
 * The base of an exception filter for jobs. **To fail the job, throw. A filter
 * that returns a value completes the job with that value**, which is Nest's
 * semantics, and what a filter recovering from an error wants.
 *
 * This base rethrows. A subclass overrides `catch`, and `super.catch` is the way
 * to say "still a failure".
 *
 * @typeParam T What the filter catches.
 */
export class BaseJobExceptionFilter<T = unknown> implements ExceptionFilter<T> {
  /**
   * Rethrows, so the job fails with this error.
   *
   * @param exception What was thrown.
   * @param _host The job, through `BunJobsExecutionContext.create(host)`.
   */
  catch(exception: T, _host: ArgumentsHost): unknown {
    throw exception as unknown;
  }
}

/**
 * A filter ending the job with no retry on the given errors: it rethrows them as
 * `UnrecoverableJobError`, with the original as `cause`.
 *
 * ```ts
 * @Processor("emails")
 * @UseFilters(UnrecoverableOn(BadRequestException, InvoiceRejected))
 * class EmailProcessor { … }
 * ```
 *
 * Outside a job it rethrows the error as it came, so it is safe on a class or a
 * global list that also serves HTTP.
 *
 * @param types What to catch: every error, when left out.
 * @returns The filter, for `@UseFilters`.
 */
export function UnrecoverableOn(
  ...types: Type<unknown>[]
): ExceptionFilter<unknown> {
  class UnrecoverableOnFilter implements ExceptionFilter<unknown> {
    /** Rethrows as unrecoverable, around a job. */
    catch(exception: unknown, host: ArgumentsHost): never {
      if (
        !isBunJobsContext(host) ||
        exception instanceof UnrecoverableJobError
      ) {
        throw exception;
      }
      const message =
        exception instanceof Error ? exception.message : String(exception);
      throw new UnrecoverableJobError(message, undefined, { cause: exception });
    }
  }
  Catch(...types)(UnrecoverableOnFilter);
  return new UnrecoverableOnFilter();
}
