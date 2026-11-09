/**
 * `@kingsleyweb/bun-nest/jobs` — bun-jobs in NestJS: the context and its
 * queues as a module (`BunJobsModule`, `@InjectQueue`, `@QueueToken`), and the
 * management API as another (`BunJobsApiModule`).
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
  type RegisterQueueAsyncOptions,
  type RegisterQueueOptions,
} from "./BunJobsModule";
export { InjectBunJobs, InjectQueue } from "./decorators/inject";
export { QueueToken, type QueueTokenClass } from "./queueToken";
export type { BunJobsQueueOptions } from "./registry";
export {
  BUN_JOBS_API,
  BUN_JOBS_API_OPTIONS,
  getBunJobsToken,
  getQueueToken,
} from "./tokens";

/**
 * The bun-jobs types this module's surface is written in, re-exported so a
 * consumer can name them without reaching for `@kingsleyweb/bun-jobs` itself
 * — and so TypeScript's declaration emit never raises TS2742 for a type it
 * cannot name.
 */
export type {
  BunJobsOptions,
  BunQueueOptions,
  JobsApi,
  JobsApiAction,
  JobsApiAuthorize,
  JobsApiConfig,
} from "@kingsleyweb/bun-jobs";
