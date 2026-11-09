/**
 * `@kingsleyweb/bun-nest/jobs` — bun-jobs in NestJS: the context and its
 * queues as a module (`BunJobsModule`, `@InjectQueue`, `@QueueToken`), methods
 * as workers (`@Processor`, `@Process`, `@DefineJob`), and the management API
 * as another module (`BunJobsApiModule`).
 *
 * This subpath, and only this subpath, depends on `@kingsleyweb/bun-jobs`
 * (an optional peer). The package barrel never reaches it, so a Nest app
 * without bun-jobs neither compiles nor loads a line of it.
 *
 * ```ts
 * import { BunJobsApiModule } from "@kingsleyweb/bun-nest/jobs";
 *
 * @Module({
 *   imports: [
 *     BunJobsApiModule.forRootAsync({
 *       inject: [BunJobs, AuthService],
 *       useFactory: (jobs: BunJobs, auth: AuthService) => ({
 *         jobs,
 *         basePath: "/admin/jobs",
 *         authorize: (req, context) => auth.can(req, context),
 *       }),
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */

export {
  BunJobsApiModule,
  type BunJobsApiModuleAsyncOptions,
  type BunJobsApiModuleOptions,
  InjectJobsApi,
} from "./BunJobsApiModule";
export {
  type BunJobsBorrowOptions,
  type BunJobsBuildOptions,
  type BunJobsContextOptions,
  BunJobsModule,
  type BunJobsModuleAsyncOptions,
  type BunJobsModuleContextOptions,
  type BunJobsModuleOptions,
  type BunJobsOptionsFactory,
  type BunJobsRunOptions,
  type RegisterQueueAsyncOptions,
  type RegisterQueueOptions,
  type RegisterWorkerOptions,
} from "./BunJobsModule";
export {
  type BunJobsWorkerOptions,
  DefineJob,
  type DefineJobOptions,
  Process,
  type ProcessOptions,
  Processor,
  type ProcessorOptions,
  type QueueJobData,
  type QueueJobName,
  type QueueJobResult,
  type TypedProcessDecorator,
} from "./decorators/consumer";
export {
  CurrentJob,
  JobAttempt,
  JobContext,
  JobData,
  type JobDataOptions,
  JobId,
  JobLogger,
  JobName,
  type JobPipe,
  JobProgress,
  type JobProgressFn,
  JobSignal,
} from "./decorators/params";
export { JobForbiddenError } from "./errors";
export {
  BunJobsExecutionContext,
  type BunJobsContextType,
  isBunJobsContext,
} from "./executionContext";
export { BaseJobExceptionFilter, UnrecoverableOn } from "./filters";
export { JobLoggingInterceptor } from "./interceptors";
export type { OnDenied, OnInvalid } from "./pipeline";
export {
  type JobsEventKind,
  type JobsEventOf,
  type OnEventOptions,
  OnJobsEvent,
  type OnJobsEventOptions,
  OnQueueEvent,
  OnRunnerEvent,
  OnWorkerEvent,
  type TypedListenerDecorator,
} from "./decorators/events";
export {
  InjectBunJobs,
  InjectJobsNotifier,
  InjectQueue,
  InjectWorker,
} from "./decorators/inject";
export type { BunJobsShutdownOptions } from "./explorer";
export { isBunJob } from "./isBunJob";
export { JobsHost } from "./JobsHost";
export { BunJobsLifecycle, WorkerRef } from "./lifecycle";
export { QueueToken, type QueueTokenClass } from "./queueToken";
export type { BunJobsQueueOptions } from "./registry";
export {
  BUN_JOBS_API,
  BUN_JOBS_API_OPTIONS,
  getBunJobsToken,
  getJobsNotifierToken,
  getQueueToken,
  getWorkerToken,
} from "./tokens";

/**
 * The bun-jobs types this module's surface is written in, re-exported so a
 * consumer can name them without reaching for `@kingsleyweb/bun-jobs` itself
 * — and so TypeScript's declaration emit never raises TS2742 for a type it
 * cannot name.
 */
export type {
  BunJobsOptions,
  BunQueueEvents,
  BunQueueOptions,
  BunQueueWorker,
  BunQueueWorkerEvents,
  BunRunnerEvents,
  DriverEvent,
  Job,
  JobDefinitionOptions,
  JobsNotifier,
  JobsNotifierOptions,
  JobsApi,
  JobsApiAction,
  JobsApiAuthorize,
  JobsApiConfig,
  NameLimits,
  ProcessorContext,
} from "@kingsleyweb/bun-jobs";
