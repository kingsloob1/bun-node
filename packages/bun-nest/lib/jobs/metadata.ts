/**
 * The metadata keys the jobs modules read and write. Nest's are written here
 * by value rather than imported from a deep path, as the throttler's are; a
 * test asserts each equals Nest's constant, so a rename fails loudly.
 */

/** Nest's `PARAMTYPES_METADATA`: what `emitDecoratorMetadata` writes on a class. */
export const NEST_PARAMTYPES_METADATA = "design:paramtypes";
/** Nest's `SELF_DECLARED_DEPS_METADATA`: where `@Inject()` on a parameter writes. */
export const NEST_SELF_DECLARED_DEPS_METADATA = "self:paramtypes";
/** Nest's `ROUTE_ARGS_METADATA`: where parameter decorators write. */
export const NEST_ROUTE_ARGS_METADATA = "__routeArguments__";
/** Nest's `SCOPE_OPTIONS_METADATA`: where `@Injectable({ scope })` writes. */
export const NEST_SCOPE_OPTIONS_METADATA = "scope:options";

/** Where `@QueueToken()` records the queue a token class stands for. */
export const QUEUE_TOKEN_METADATA = "bun-jobs:queue-token";
