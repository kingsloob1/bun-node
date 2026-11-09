import type {
  BunQueueWorker,
  Job,
  ProcessorContext,
} from "@kingsleyweb/bun-jobs";
import { ConfigError } from "@kingsleyweb/bun-common";

/** What the explorer gives a {@link JobsHost} at bootstrap. Not exported from the entry. */
export interface JobsHostBinding {
  /** The worker serving the class's queue. */
  readonly worker: () => BunQueueWorker<any, any, any>;
  /** Closes that worker, within the module's `shutdown` budget. */
  readonly drain: () => Promise<void>;
}

/** Where the binding lives on an instance. */
export const JOBS_HOST_BINDING = Symbol("BUN_JOBS_HOST_BINDING");

/**
 * The base-class form of a processor, for an app coming from `@nestjs/bullmq`'s
 * `WorkerHost`: one `process(job, ctx)` method, the queue's catch-all, and the
 * worker and its drain out in the open.
 *
 * ```ts
 * @Processor("emails")
 * export class EmailProcessor extends JobsHost<Email, string> {
 *   async process(job: Job<Email, string>, ctx: ProcessorContext) {
 *     return send(job.data.to, ctx.signal);
 *   }
 * }
 * ```
 *
 * Any other class gets the same drain from an `onModuleDestroy` the module
 * installs on its instance. Here it is this class's: a subclass overriding
 * `onModuleDestroy` calls `super.onModuleDestroy()` first, or its worker drains
 * last, in the jobs module, after what its jobs use may have gone.
 *
 * @typeParam TData The job's data.
 * @typeParam TResult What it answers with.
 */
export abstract class JobsHost<TData = unknown, TResult = unknown> {
  /** Handles every job on the queue that no `@Process(name)` method names. */
  abstract process(
    job: Job<TData, TResult>,
    ctx: ProcessorContext,
  ): TResult | Promise<TResult>;

  /**
   * The worker serving this class's queue.
   *
   * @throws ConfigError before `onApplicationBootstrap`.
   */
  get worker(): BunQueueWorker<TData, TResult> {
    const binding = this.#binding();
    if (binding === undefined) {
      throw new ConfigError(
        `${this.constructor.name}.worker: no worker yet. Workers are built at onApplicationBootstrap, for a class with @Processor`,
      );
    }
    return binding.worker() as BunQueueWorker<TData, TResult>;
  }

  /** Closes the worker, letting jobs in flight finish before what they use goes. */
  async onModuleDestroy(): Promise<void> {
    await this.#binding()?.drain();
  }

  /** What the explorer gave this instance. */
  #binding(): JobsHostBinding | undefined {
    return (this as unknown as Record<symbol, JobsHostBinding | undefined>)[
      JOBS_HOST_BINDING
    ];
  }
}
