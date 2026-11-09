import type { Job, ProcessorContext } from "@kingsleyweb/bun-jobs";
import type { ArgumentsHost, ContextType } from "@nestjs/common";
import { BUN_JOBS_CONTEXT_TYPE } from "./pipeline";

/** Every context type a guard can see in an app with jobs: Nest's, and ours. */
export type BunJobsContextType = typeof BUN_JOBS_CONTEXT_TYPE | ContextType;

/**
 * Which `@Process` name each attempt runs under, for {@link BunJobsExecutionContext.getHandlerName}.
 * Keyed by the attempt's `ProcessorContext`.
 */
const HANDLER_NAMES = new WeakMap<ProcessorContext, string>();

/** Records the name an attempt runs under. */
export function recordHandlerName(
  /** The attempt's context. */
  ctx: ProcessorContext,
  /** The `@Process` name, or `"*"`. */
  name: string,
): void {
  HANDLER_NAMES.set(ctx, name);
}

/**
 * Whether a guard, interceptor or filter is looking at a job. A global enhancer
 * written for HTTP uses this, or `getType()`, to pass a job through.
 *
 * @param context The enhancer's context or host.
 */
export function isBunJobsContext(context: ArgumentsHost): boolean {
  return context.getType<BunJobsContextType>() === BUN_JOBS_CONTEXT_TYPE;
}

/**
 * The job behind an `ExecutionContext` or `ArgumentsHost`, as GraphQL's
 * `GqlExecutionContext` is the resolver's:
 *
 * ```ts
 * canActivate(context: ExecutionContext) {
 *   if (!isBunJobsContext(context)) return true;
 *   const job = BunJobsExecutionContext.create(context).getJob<{ tenant: string }>();
 *   return this.tenants.allows(job.data.tenant);
 * }
 * ```
 */
export class BunJobsExecutionContext {
  private constructor(
    /** The host, whose first two arguments are the job and its context. */
    private readonly host: ArgumentsHost,
  ) {}

  /**
   * Wraps a context or host.
   *
   * @param context What the enhancer was given.
   */
  static create(context: ArgumentsHost): BunJobsExecutionContext {
    return new BunJobsExecutionContext(context);
  }

  /** The job. */
  getJob<TData = unknown, TResult = unknown>(): Job<TData, TResult> {
    return this.host.getArgByIndex<Job<TData, TResult>>(0);
  }

  /** The attempt's context: `signal`, `logger`, `attempt`, `log`, `heartbeat`. */
  getProcessorContext(): ProcessorContext {
    return this.host.getArgByIndex<ProcessorContext>(1);
  }

  /** The job's queue. */
  getQueueName(): string {
    return this.getJob().queue.queue;
  }

  /** The `@Process` name this attempt runs under, or `"*"` for the catch-all. */
  getHandlerName(): string {
    return HANDLER_NAMES.get(this.getProcessorContext()) ?? "*";
  }
}
