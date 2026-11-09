/**
 * The metadata keys the jobs modules read and write. Nest's are written here
 * by value rather than imported from a deep path, as the throttler's are; a
 * test asserts each equals Nest's constant, so a rename fails loudly.
 */

/** Nest's `PARAMTYPES_METADATA`: what `emitDecoratorMetadata` writes on a class. */
export const NEST_PARAMTYPES_METADATA = "design:paramtypes";
/** Nest's `SELF_DECLARED_DEPS_METADATA`: where `@Inject()` on a parameter writes. */
export const NEST_SELF_DECLARED_DEPS_METADATA = "self:paramtypes";
/** Nest's `PROPERTY_DEPS_METADATA`: where `@Inject()` on a property writes. */
export const NEST_PROPERTY_DEPS_METADATA = "self:properties_metadata";
/** Nest's `ROUTE_ARGS_METADATA`: where parameter decorators write. */
export const NEST_ROUTE_ARGS_METADATA = "__routeArguments__";
/** Nest's `SCOPE_OPTIONS_METADATA`: where `@Injectable({ scope })` writes. */
export const NEST_SCOPE_OPTIONS_METADATA = "scope:options";

/** Where `@QueueToken()` records the queue a token class stands for. */
export const QUEUE_TOKEN_METADATA = "bun-jobs:queue-token";

/** Where `@Processor()` records its queue and options. */
export const PROCESSOR_METADATA = "bun-jobs:processor";
/** Where `@Process()` records its job name and options. */
export const PROCESS_METADATA = "bun-jobs:process";
/** Where `@DefineJob()` records its job name and options. */
export const DEFINE_JOB_METADATA = "bun-jobs:define-job";
/** Where `@Cron()` and `@Every()` record their series. */
export const SCHEDULE_METADATA = "bun-jobs:schedule";
/** Where the event decorators record what a method listens to. */
export const EVENT_LISTENERS_METADATA = "bun-jobs:event-listeners";

/**
 * Nest's `RouteParamtypes.BODY`, the type `@JobData()` is recorded as, so pipes
 * are told `"body"` and an app's global validation applies to job data. It is
 * microservices' `RpcParamtype.PAYLOAD` too, for the same reason.
 */
export const NEST_BODY_PARAMTYPE = 3;
/** Nest's `FORBIDDEN_MESSAGE`: what a guard's `false` throws, through `ExternalContextCreator`. */
export const NEST_FORBIDDEN_MESSAGE = "Forbidden resource";

/**
 * Nest's `ENTRY_PROVIDER_WATERMARK`: marks a provider as an entry point, as a
 * controller is, so Nest gives it a request-scoped global enhancer's tree and
 * finds its transient enhancers. Without it, a request-scoped `APP_GUARD` is
 * silently not asked around a singleton (measured).
 */
export const NEST_ENTRY_PROVIDER_WATERMARK = "__entryProvider__";

/** Where Nest's `@UseGuards`, `@UseInterceptors`, `@UsePipes` and `@UseFilters` write. */
export const NEST_ENHANCER_METADATA = [
  "__guards__",
  "__interceptors__",
  "__pipes__",
  "__exceptionFilters__",
] as const;
