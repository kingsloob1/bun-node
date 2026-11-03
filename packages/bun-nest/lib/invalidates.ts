/**
 * `@Invalidates` (typed-client plan `nest-typed-routes.md` §4.3, N-D8,
 * PR-N4): when a controller route's handler succeeds, the tags its call
 * invalidates are published to the live channel (bun-common's
 * `publishTags()`, `@kingsleyweb/bun-common/live`), so every client
 * observing a query filed under one of them refetches it (bun-client's
 * `live()`).
 *
 * ```ts
 * @Patch(":id")
 * @Validate({ params: IdParams, body: UserPatch, responses: { 200: User } })
 * @Invalidates("user:{id}", "users")
 * update(@Param("id") id: string, @Body() body: UserPatch) { … }
 * ```
 *
 * The tags are `@CacheTags`' vocabulary — strings, or one function of the
 * `ExecutionContext` — with the live channel's templates: a `{name}` is
 * filled from the request's params (`"user:{id}"` → `"user:42"`), and a
 * template naming a param the request lacks is skipped. String templates are
 * also the route's documented `cache.invalidates` (`x-bun-cache`), so the
 * typed client invalidates its own queries on the same call.
 *
 * **It follows the handler, not the status**: the tags are published when
 * the handler's observable completes without an error, before the response
 * is written. A handler that throws publishes nothing, even when an
 * exception filter turns the error into a `2xx`. bun-common's live route
 * source (which publishes a route's `cache.invalidates` on any `2xx` once
 * `liveInvalidation()` is mounted) leaves a route carrying `@Invalidates` to
 * it — the `"bun:invalidates"` metadata on the handler says so — so each
 * success publishes once.
 */
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from "@nestjs/common";
import type { RouteDoc } from "@kingsleyweb/bun-common/lib/docs";
import type { Observable } from "rxjs";
import { Injectable, Logger, UseInterceptors } from "@nestjs/common";
import { tap } from "rxjs";
import { publishTags } from "@kingsleyweb/bun-common/live";
import { fillTagTemplates } from "@kingsleyweb/bun-common/lib/live/server";
import { setRouteInvalidates } from "./describe";

/**
 * The metadata key the decorator marks the method with: the function form's
 * function, or `true` for templates (read from the route's doc). bun-common's
 * live route source reads the same string, and leaves the route to this
 * interceptor.
 */
const INVALIDATES_METADATA = "bun:invalidates";

/** `@Describe`'s key, where the templates are read from at run time. */
const DESCRIBE_METADATA = "bun:describe";

/** Tags computed from the request's execution context, as `@CacheTags` takes them. */
type InvalidatesFunction = (context: ExecutionContext) => readonly string[];

/** The `reflect-metadata` calls this module uses, read structurally: they exist once Nest is loaded. */
interface MetadataReflect {
  getMetadata?: (key: unknown, target: object) => unknown;
  defineMetadata?: (key: unknown, value: unknown, target: object) => void;
}

const reflect = Reflect as unknown as MetadataReflect;

/**
 * Publishes a route's invalidations once its handler's observable completes.
 * Internal: `@Invalidates` applies it.
 */
class InvalidatesInterceptor implements NestInterceptor {
  /** Where a failing tags function is reported. */
  readonly #logger = new Logger("Invalidates");

  /** Passes the handler's values through and publishes on its completion. */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<string>() !== "http") return next.handle();
    const handler = context.getHandler();
    const spec = reflect.getMetadata?.(INVALIDATES_METADATA, handler);
    if (spec === undefined) return next.handle();
    let published = false;
    return next.handle().pipe(
      tap({
        complete: () => {
          if (published) return;
          published = true;
          this.#publish(context, handler, spec);
        },
      }),
    );
  }

  /** The tags of one successful call, published; a tags function that throws is logged, never the request's failure. */
  #publish(context: ExecutionContext, handler: object, spec: unknown): void {
    let tags: string[];
    try {
      if (typeof spec === "function") {
        const computed = (spec as InvalidatesFunction)(context);
        tags = Array.isArray(computed)
          ? computed.filter(
              (tag): tag is string => typeof tag === "string" && tag !== "",
            )
          : [];
      } else {
        const doc = reflect.getMetadata?.(DESCRIBE_METADATA, handler) as
          RouteDoc | undefined;
        const templates = doc?.cache?.invalidates ?? [];
        const req = context
          .switchToHttp()
          .getRequest<{ params?: Record<string, unknown> }>();
        tags = fillTagTemplates(templates, req.params);
      }
    } catch (error) {
      this.#logger.error(
        `computing the tags to invalidate failed: ${String(error)}`,
      );
      return;
    }
    if (tags.length > 0) publishTags(tags);
  }
}

// `@Injectable()` by call: Bun reads the decorator options from the working
// directory's tsconfig (oven-sh/bun#28605), and the call behaves the same
// under either decorator semantics (validation.ts has the same pattern).
Injectable()(InvalidatesInterceptor);

/**
 * Publishes the tags a successful call to the route invalidates, to the live
 * channel bun-common's `liveInvalidation()` serves (mount it on the adapter,
 * first). The tags, in `@CacheTags`' vocabulary:
 *
 * - **Templates** — `@Invalidates("user:{id}", "users")`: each `{name}`
 *   filled from the request's params, a template naming a param the request
 *   lacks skipped. They are also the route's documented
 *   `cache.invalidates` (`x-bun-cache`, what the typed client invalidates on
 *   its side), whatever a `@Describe({ cache: { invalidates } })` on the
 *   same method says.
 * - **None** — `@Invalidates()`: the route's `@Describe({ cache: {
 *   invalidates } })` templates.
 * - **A function** of the `ExecutionContext` —
 *   `@Invalidates((ctx) => [\`org:${…}\`])`: the tags, computed after the
 *   handler succeeded; nothing is documented for them. A function that
 *   throws is logged, and nothing is published.
 *
 * Published when the handler's observable completes without an error (before
 * the response is written), once per call: a handler that throws publishes
 * nothing, even when an exception filter answers `2xx`. The route is left
 * out of `liveInvalidation()`'s route source, which would otherwise publish
 * its `cache.invalidates` on the `2xx` a second time. On a method only.
 *
 * @param tags Templates (non-empty strings), or one function; anything else
 *   throws a `TypeError` at decoration.
 */
export function Invalidates(...tags: string[]): MethodDecorator;
export function Invalidates(tags: InvalidatesFunction): MethodDecorator;
export function Invalidates(
  ...tags: (string | InvalidatesFunction)[]
): MethodDecorator {
  const fn =
    tags.length === 1 && typeof tags[0] === "function" ? tags[0] : undefined;
  if (
    fn === undefined &&
    tags.some((tag) => typeof tag !== "string" || tag === "")
  ) {
    throw new TypeError(
      "@Invalidates(): pass tag templates (non-empty strings), or one function of the ExecutionContext",
    );
  }
  const templates = fn === undefined ? (tags as string[]) : [];
  return (target, key, descriptor) => {
    const method = descriptor.value as unknown;
    if (typeof method !== "function") {
      throw new TypeError(
        `@Invalidates() on ${String(key)}: only methods are routes, not accessors or fields`,
      );
    }
    if (reflect.defineMetadata === undefined) {
      throw new TypeError(
        '@Invalidates(): reflect-metadata is not loaded — import "reflect-metadata" (Nest applications always do) before the controllers',
      );
    }
    if (templates.length > 0) {
      setRouteInvalidates(method, Object.freeze([...templates]));
    }
    reflect.defineMetadata(INVALIDATES_METADATA, fn ?? true, method);
    UseInterceptors(InvalidatesInterceptor)(target, key, descriptor);
  };
}
