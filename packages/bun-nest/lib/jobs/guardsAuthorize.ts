import type { BunRequest, LoggerLike } from "@kingsleyweb/bun-common";
import type {
  JobsApiAuthorizeContext,
  JobsApiAuthorizeResult,
} from "@kingsleyweb/bun-jobs";
import type { CanActivate, ExecutionContext, Type } from "@nestjs/common";
import type { ModuleRef } from "@nestjs/core";
import { ConfigError, resolveLogger } from "@kingsleyweb/bun-common";
import { Logger, Scope } from "@nestjs/common";
import { ContextIdFactory } from "@nestjs/core";
import { isObservable, lastValueFrom } from "rxjs";

/** A guard, as `@UseGuards` takes one: a class, or an instance. */
export type GuardsAuthorizeGuard = Type<CanActivate> | CanActivate;

/**
 * The class `getClass()` answers, whose methods `getHandler()` answers: `read` for what
 * changes nothing, `mutate` for what does. Metadata on them, `@Roles(...)` say, is what a
 * `Reflector` reads, since the API's routes have no handler of their own to carry it.
 */
export type GuardsAuthorizePolicy = Type<{
  /** Stands for an action that changes nothing. Never called. */
  read: () => unknown;
  /** Stands for an action that changes state. Never called. */
  mutate: () => unknown;
}>;

/** What {@link guardsAuthorize} accepts. */
export interface GuardsAuthorizeOptions {
  /** Which policy class the guards see. Defaults to one with no metadata. */
  policy?: GuardsAuthorizePolicy;
  /**
   * Where a guard's unexpected failure is logged, since the caller is told nothing of it.
   * Defaults to Nest's `Logger`.
   */
  logger?: LoggerLike;
}

/**
 * What {@link guardsAuthorize} builds. It takes any context object, so one value fits the
 * API's `authorize` and the jobs UI's, which are told different things.
 */
export type GuardsAuthorize = (
  req: BunRequest,
  context: object,
) => Promise<JobsApiAuthorizeResult>;

/** The policy when none is given. */
class JobsApiPolicy {
  /** Stands for an action that changes nothing. */
  read(): void {}

  /** Stands for an action that changes state. */
  mutate(): void {}
}

/** What each execution context was built for, which {@link jobsApiContextOf} reads. */
const AUTHORIZE_CONTEXTS = new WeakMap<ExecutionContext, object>();

/**
 * What `authorize` was told about the decision a guard is making: the action, whether it
 * mutates, its queue, job, transport and channel.
 *
 * A guard on the jobs UI reads the UI's `{ asset, path }` the same way, typed by the caller:
 * `jobsApiContextOf<JobsUiAuthorizeContext>(context)`.
 *
 * @typeParam T What it was told. Defaults to the API's context.
 * @param context The `ExecutionContext` the guard was given.
 * @returns What it was told, or `undefined` when {@link guardsAuthorize} did not build this
 * context, so one guard can also sit on a controller.
 */
export function jobsApiContextOf<T = JobsApiAuthorizeContext>(
  context: ExecutionContext,
): T | undefined {
  return AUTHORIZE_CONTEXTS.get(context) as T | undefined;
}

/** A context of type `"http"`, built from Nest's public interface alone. */
function executionContextFor(
  req: BunRequest,
  told: object,
  policy: GuardsAuthorizePolicy,
): ExecutionContext {
  const handler =
    policy.prototype[
      (told as { mutation?: unknown }).mutation === true ? "mutate" : "read"
    ];
  const args = [req, undefined, undefined];
  const context: ExecutionContext = {
    getType: <T extends string>() => "http" as T,
    getClass: <T>() => policy as Type<T>,
    getHandler: () => handler,
    getArgs: <T extends unknown[]>() => args as T,
    getArgByIndex: <T>(index: number) => args[index] as T,
    switchToHttp: () => ({
      getRequest: <T>() => req as T,
      getResponse: <T>() => undefined as T,
      getNext: <T>() => undefined as T,
    }),
    switchToRpc: () => {
      throw new Error("guardsAuthorize: this context is http, not rpc");
    },
    switchToWs: () => {
      throw new Error("guardsAuthorize: this context is http, not ws");
    },
  };
  AUTHORIZE_CONTEXTS.set(context, told);
  return context;
}

/** The instance to ask: a provider's, a request's, or one built for this `authorize`. */
async function guardFor(
  moduleRef: ModuleRef,
  guard: GuardsAuthorizeGuard,
  req: BunRequest,
  built: Map<Type<CanActivate>, Promise<CanActivate>>,
): Promise<CanActivate> {
  if (typeof guard !== "function") {
    return guard;
  }
  let scope: Scope | undefined;
  try {
    ({ scope } = moduleRef.introspect(guard));
  } catch {
    // Not a provider: built once with DI, as `@UseGuards` builds a class it is given.
    let instance = built.get(guard);
    if (instance === undefined) {
      instance = moduleRef.create(guard);
      built.set(guard, instance);
      instance.catch(() => built.delete(guard));
    }
    return await instance;
  }
  if (scope === undefined || scope === Scope.DEFAULT) {
    return moduleRef.get(guard, { strict: false });
  }
  const contextId = ContextIdFactory.getByRequest(req);
  moduleRef.registerRequestByContextId(req, contextId);
  return await moduleRef.resolve(guard, contextId, { strict: false });
}

/** A failed guard as a denial. Nothing thrown can get past this as an allow, or a 500. */
function denialOf(
  error: unknown,
  logger: ReturnType<typeof resolveLogger>,
): JobsApiAuthorizeResult {
  const exception = error as {
    getStatus?: () => unknown;
    message?: unknown;
  } | null;
  const status =
    typeof exception?.getStatus === "function"
      ? exception.getStatus()
      : undefined;
  if (typeof status !== "number" || status >= 500) {
    // Not a refusal but a failure, whose message may hold anything: the caller is not told.
    logger.error("A guard failed while deciding jobs API access: denied", {
      error,
    });
    return { allow: false, status: 403 };
  }
  return {
    allow: false,
    status: status === 401 ? 401 : 403,
    ...(typeof exception?.message === "string" && exception.message !== ""
      ? { reason: exception.message }
      : {}),
  };
}

/**
 * An `authorize` built from Nest guards, for `BunJobsApiModule` and the jobs UI. The API's
 * routes are a router mounted on the adapter, not controllers, so Nest's pipeline never runs
 * for them; calling the guards from `authorize` covers each HTTP request and each WebSocket
 * channel, which no HTTP guard chain would.
 *
 * ```ts
 * BunJobsApiModule.forRootAsync({
 *   inject: [ModuleRef],
 *   useFactory: (moduleRef: ModuleRef) => ({
 *     basePath: "/admin/jobs",
 *     authorize: guardsAuthorize(moduleRef, [SessionGuard, JobsRolesGuard]),
 *   }),
 * });
 * ```
 *
 * Every guard must allow, in order, and the first that does not ends it. It fails closed:
 *
 * - `UnauthorizedException` is a 401; `false`, nothing, `ForbiddenException` and any other
 *   4xx exception a 403. An exception's message reaches the caller, as it does from a
 *   controller's guard.
 * - **Anything else a guard throws, rejects or fails with is a 403 too**, on both transports:
 *   it is logged, and the caller is told nothing of it.
 * - An empty list is refused at once, since it would allow everyone.
 *
 * Each guard is given a context of type `"http"`, even for a WebSocket channel, whose request
 * is the upgrade's: `switchToHttp().getRequest()` is the `BunRequest`. There is no response,
 * so `getResponse()` is `undefined`. `getHandler()` and `getClass()` are the `policy`, and
 * {@link jobsApiContextOf} says what is being decided.
 *
 * @param moduleRef Where a guard class is found or built.
 * @param guards The guards, as `@UseGuards` takes them.
 * @param options The `policy` and `logger`.
 * @returns The `authorize`.
 * @throws ConfigError on an empty list, or a `policy` without `read` and `mutate`.
 */
export function guardsAuthorize(
  moduleRef: ModuleRef,
  guards: readonly GuardsAuthorizeGuard[],
  options: GuardsAuthorizeOptions = {},
): GuardsAuthorize {
  if (guards.length === 0) {
    throw new ConfigError(
      "guardsAuthorize: give at least one guard, since an empty list would allow everyone",
    );
  }
  const policy: GuardsAuthorizePolicy = options.policy ?? JobsApiPolicy;
  if (
    typeof policy.prototype?.read !== "function" ||
    typeof policy.prototype.mutate !== "function"
  ) {
    throw new ConfigError(
      "guardsAuthorize: a policy is a class with the methods read and mutate",
      { policy: policy.name },
    );
  }
  const logger = resolveLogger(options.logger ?? new Logger("BunJobsApi"));
  const built = new Map<Type<CanActivate>, Promise<CanActivate>>();
  return async (req, told) => {
    try {
      const context = executionContextFor(req, told, policy);
      for (const guard of guards) {
        const instance = await guardFor(moduleRef, guard, req, built);
        const answer = instance.canActivate(context);
        const allowed = isObservable(answer)
          ? await lastValueFrom(answer)
          : await answer;
        if (!allowed) {
          return { allow: false, status: 403 };
        }
      }
      return true;
    } catch (error) {
      return denialOf(error, logger);
    }
  };
}
