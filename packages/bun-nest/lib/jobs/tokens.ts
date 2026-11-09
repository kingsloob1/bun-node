/**
 * Injection tokens for bun-nest's jobs modules.
 *
 * Kept in their own module, importing nothing, so a consumer can name a token
 * in a provider or a test without pulling in the module — or, with it,
 * `@kingsleyweb/bun-jobs`.
 */

/** Provides the built `JobsApi`. Inject it with {@link InjectJobsApi}. */
export const BUN_JOBS_API = Symbol("BUN_JOBS_API");

/** Provides the options the module was configured with. */
export const BUN_JOBS_API_OPTIONS = Symbol("BUN_JOBS_API_OPTIONS");

/**
 * The token of a `BunJobs` context, as `BunJobsModule` provides it. The
 * default context is also provided under the class `BunJobs`, so a plain
 * `constructor(jobs: BunJobs)` works; a named one only under this.
 *
 * @param context The context's `name`; the default context when left out.
 */
export function getBunJobsToken(context?: string): string {
  return context === undefined
    ? "bun-jobs:context"
    : `bun-jobs:context:${context}`;
}

/**
 * The token of a registered queue, as `BunJobsModule.registerQueue()` provides
 * it: `"bun-jobs:queue:emails"`, or `"bun-jobs:billing:queue:emails"` in the
 * context named `billing`. Neither a queue's name nor a context's can hold a
 * `:`, so two tokens never meet.
 *
 * @param name The queue's name.
 * @param context The context's `name`; the default context when left out.
 */
export function getQueueToken(name: string, context?: string): string {
  return context === undefined
    ? `bun-jobs:queue:${name}`
    : `bun-jobs:${context}:queue:${name}`;
}

/**
 * The token of the handle on the worker serving a queue, which `@InjectWorker()`
 * injects and `registerQueue()` and `registerWorker()` provide.
 *
 * @param name The queue's name.
 * @param context The context's `name`; the default context when left out.
 */
export function getWorkerToken(name: string, context?: string): string {
  return context === undefined
    ? `bun-jobs:worker:${name}`
    : `bun-jobs:${context}:worker:${name}`;
}

/**
 * The token of a queue's `SummonController`, which `@InjectSummonController()` injects
 * and `registerQueue()` provides.
 *
 * @param queue The queue's name.
 * @param context The context's `name`; the default context when left out.
 */
export function getSummonControllerToken(
  queue: string,
  context?: string,
): string {
  return context === undefined
    ? `bun-jobs:summon:${queue}`
    : `bun-jobs:${context}:summon:${queue}`;
}

/**
 * The token of a runner `BunJobsModule.registerRunner()` registered, which
 * `@InjectRunner()` injects.
 *
 * @param id The runner's id.
 * @param context The context's `name`; the default context when left out.
 */
export function getRunnerToken(id: string, context?: string): string {
  return context === undefined
    ? `bun-jobs:runner:${id}`
    : `bun-jobs:${context}:runner:${id}`;
}

/**
 * The token of the `JobsNotifier` that `@InjectJobsNotifier()` injects.
 *
 * @param context The context's `name`; the default context when left out.
 */
export function getJobsNotifierToken(context?: string): string {
  return context === undefined
    ? "bun-jobs:notifier"
    : `bun-jobs:${context}:notifier`;
}

/**
 * The token of the options `BunJobsModule.forRoot()` was given (or
 * `forRootAsync()` built). A registered symbol, so two copies of the package
 * agree on it.
 *
 * @param context The context's `name`; the default context when left out.
 */
export function getBunJobsOptionsToken(context?: string): symbol {
  return Symbol.for(
    context === undefined
      ? "@kingsleyweb/bun-nest/jobs:options"
      : `@kingsleyweb/bun-nest/jobs:options:${context}`,
  );
}
