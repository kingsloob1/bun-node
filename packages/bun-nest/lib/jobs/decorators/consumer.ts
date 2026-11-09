import type {
  BunJobs,
  JobDefinitionOptions,
  NameLimits,
} from "@kingsleyweb/bun-jobs";
import type { Scope } from "@nestjs/common";
import type { QueueTokenClass } from "../queueToken";
import { ConfigError } from "@kingsleyweb/bun-common";
import { SetMetadata } from "@nestjs/common";
import {
  DEFINE_JOB_METADATA,
  NEST_SCOPE_OPTIONS_METADATA,
  PROCESS_METADATA,
  PROCESSOR_METADATA,
} from "../metadata";
import { requireQueueToken } from "../queueToken";

/**
 * What `jobs.worker()` takes, without what the module owns (`autorun`: it
 * starts the worker at bootstrap). `schema` and the other checks included.
 */
export type BunJobsWorkerOptions = Omit<
  NonNullable<Parameters<BunJobs["worker"]>[2]>,
  "autorun"
>;

/**
 * What {@link Processor} takes: everything a bun-jobs worker takes, passed
 * through, and where it belongs in Nest. Classes on one queue share one
 * worker, so they must not set different worker options.
 *
 * `target` can only be `"in-process"` here: a `@Process` method cannot be sent
 * to another thread or process. Anything else is a `ConfigError` at boot, and
 * `BunJobsModule.registerWorker` is the path for a processor file.
 */
export interface ProcessorOptions extends BunJobsWorkerOptions {
  /**
   * The Nest scope. `Scope.REQUEST` gives each job a fresh instance, with
   * `REQUEST` being the job (at a cost of tens of microseconds per job). Needs
   * no `@Injectable()` beside it.
   */
  scope?: Scope;
  /** The context's `name`; the default context when left out, or the queue token's. */
  context?: string;
}

/**
 * What {@link Process} takes: limits on one job name, on top of the queue's.
 * **They are stored on the queue, so they apply to every process consuming
 * it.** A name at its limit is skipped, not waited behind. Merged into what is
 * stored at bootstrap: the queue's own limits and every other name stay as
 * they were.
 */
export type ProcessOptions = NameLimits;

/** What {@link DefineJob} takes: a definition's options, and its context. */
export interface DefineJobOptions extends JobDefinitionOptions {
  /** The context's `name`; the default context when left out. */
  context?: string;
  /** The job's schemas, `{ data, result }`, as `jobs.define()` takes them. */
  schema?: NonNullable<Parameters<BunJobs["worker"]>[2]>["schema"];
}

/** What {@link Processor} recorded on a class. */
export interface ProcessorMetadata {
  /** The queue's name. */
  readonly queue: string;
  /** The context's `name`; `undefined` for the default context. */
  readonly context: string | undefined;
  /** The options as given. */
  readonly options: ProcessorOptions;
}

/** What {@link Process} recorded on a method. */
export interface ProcessMetadata {
  /** The job name; `undefined` for the catch-all. */
  readonly name: string | undefined;
  /** The options as given. */
  readonly options: ProcessOptions | undefined;
}

/** What {@link DefineJob} recorded on a method. */
export interface DefineJobMetadata {
  /** The job name. */
  readonly name: string;
  /** The options as given. */
  readonly options: DefineJobOptions | undefined;
}

/**
 * Marks a provider as consuming a queue: its {@link Process} methods handle
 * the queue's jobs, by name. Each queue in a context gets one bun-jobs worker,
 * shared by every class on it, because a worker claims any job on its queue.
 *
 * ```ts
 * @Processor("emails", { concurrency: 5 })
 * export class EmailService {
 *   constructor(private readonly mailer: Mailer) {}
 *
 *   @Process("welcome")
 *   async welcome(job: Job<Email>, ctx: ProcessorContext) {
 *     return this.mailer.send(job.data.to, ctx.signal);
 *   }
 * }
 * ```
 *
 * Only providers: `@Processor` on a controller is a `ConfigError` at boot.
 *
 * @param queue The queue's name, or its `@QueueToken()` class.
 * @param options See {@link ProcessorOptions}.
 */
export function Processor(
  queue: string | QueueTokenClass,
  options: ProcessorOptions = {},
): ClassDecorator {
  const named =
    typeof queue === "string"
      ? { queue, context: options.context }
      : requireQueueToken(queue, "@Processor()");
  if (options.context !== undefined && options.context !== named.context) {
    throw new ConfigError(
      `@Processor(): the queue token says context ${String(named.context)}, but the options say "${options.context}"`,
    );
  }
  const recorded: ProcessorMetadata = { ...named, options };
  return (target) => {
    Reflect.defineMetadata(PROCESSOR_METADATA, recorded, target);
    if (options.scope !== undefined) {
      Reflect.defineMetadata(
        NEST_SCOPE_OPTIONS_METADATA,
        { scope: options.scope },
        target,
      );
    }
  };
}

/**
 * Marks a method of a {@link Processor} class as the handler of one job name,
 * called as `(job, ctx)`. A bare `@Process()` is the catch-all: every name on
 * this queue that no other method names. A name nobody handles ends the job
 * with no retry, since no retry in this process would find a handler.
 *
 * @param name The job name; the catch-all when left out.
 * @param options See {@link ProcessOptions}.
 */
export function Process(
  name?: string,
  options?: ProcessOptions,
): MethodDecorator {
  const recorded: ProcessMetadata = { name, options };
  return SetMetadata(PROCESS_METADATA, recorded);
}

/**
 * Defines a job on the context's registry from a method of any provider:
 * `jobs.define(name, method, options)` at bootstrap, and `jobs.start()` once,
 * so `jobs.now(name, data)` and the builder check the name and apply the
 * options wherever a job is added from. A name nobody defines stays bun-jobs'
 * retryable `ConfigError`, for a deployment that does define it.
 *
 * @param name The job name.
 * @param options See {@link DefineJobOptions}.
 */
export function DefineJob(
  name: string,
  options?: DefineJobOptions,
): MethodDecorator {
  const recorded: DefineJobMetadata = { name, options };
  return SetMetadata(DEFINE_JOB_METADATA, recorded);
}

/** What `@Processor()` recorded on a class. */
export function processorOf(target: object): ProcessorMetadata | undefined {
  return Reflect.getMetadata(PROCESSOR_METADATA, target) as
    ProcessorMetadata | undefined;
}
