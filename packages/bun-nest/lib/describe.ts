/**
 * `@Describe` (typed-client plan `nest-typed-routes.md` §3.2, N-D2, PR-N3):
 * a controller route's prose for the generated documents — bun-common's
 * `RouteDoc`, exactly what `.describe()` takes on a router route.
 *
 * ```ts
 * @Controller("users")
 * @Describe({ tags: ["users"] })
 * class UsersController {
 *   @Get(":id")
 *   @Validate({ params: IdParams, responses: { 200: User, 404: Problem } })
 *   @Describe({ operationId: "getUser", errors: ["NOT_FOUND"], cache: { tags: ["user:{id}"] } })
 *   one(@Param("id") id: string) { … }
 * }
 * ```
 *
 * It writes the doc as reflect metadata under `"bun:describe"` on the
 * method; NestJS's `RouterExplorer.copyMetadataToCallback` carries it onto
 * the handler it registers on the adapter, where bun-common's document
 * generators read it (`routeDocFor`, beside `describe()`'s own store) — the
 * path a `@Validate` contract takes. So `generateOpenApi(adapter.instance)`
 * documents a controller route as it documents a router route given the same
 * `.describe()`, and bun-common's live route source publishes its
 * `cache.invalidates` on a 2xx as it does a router route's. Prose only: it
 * never reaches the handler's types, and nothing is checked at run time.
 */
import type { RouteDoc } from "@kingsleyweb/bun-common/lib/docs";

/** The metadata key the doc is written under; bun-common's `routeDocFor` reads the same string. */
const DESCRIBE_METADATA = "bun:describe";

/** Nest's `METHOD_METADATA` (`@nestjs/common/constants`), by value: what marks a method as a route. */
const NEST_METHOD_METADATA = "method";

/** The `reflect-metadata` calls this module uses, read structurally: they exist once Nest is loaded. */
interface MetadataReflect {
  getOwnMetadata?: (key: unknown, target: object) => unknown;
  defineMetadata?: (key: unknown, value: unknown, target: object) => void;
}

const reflect = Reflect as unknown as MetadataReflect;

/**
 * Each described method's own doc (its method-level `@Describe`s merged),
 * kept apart from what a controller-level `@Describe` merges under it, so a
 * second controller-level one is merged under the method's own doc again
 * rather than under the first's result.
 */
const methodDocs = new WeakMap<object, RouteDoc>();

/**
 * Each method's `@Invalidates` templates (`./invalidates.ts`): its doc's
 * `cache.invalidates`, whichever of `@Describe` and `@Invalidates` was
 * applied last, since they are what the interceptor publishes.
 */
const methodInvalidates = new WeakMap<object, readonly string[]>();

/** A method's own doc, with its `@Invalidates` templates as `cache.invalidates`. */
function effectiveDoc(method: object): RouteDoc | undefined {
  const own = methodDocs.get(method);
  const invalidates = methodInvalidates.get(method);
  if (invalidates === undefined) return own;
  return { ...own, cache: { ...own?.cache, invalidates } };
}

/**
 * Records a method's `@Invalidates` templates and rewrites its doc with
 * them. Internal: `./invalidates.ts` calls it; not exported from the root.
 *
 * @param method    The decorated method.
 * @param templates Its tag templates.
 */
export function setRouteInvalidates(
  method: object,
  templates: readonly string[],
): void {
  methodInvalidates.set(method, templates);
  const doc = effectiveDoc(method);
  if (doc !== undefined) writeDoc(method, doc);
}

/** The doc `target` (a controller class) carries itself, if any. */
function ownDoc(target: object): RouteDoc | undefined {
  const doc = reflect.getOwnMetadata?.(DESCRIBE_METADATA, target);
  return typeof doc === "object" && doc !== null ? doc : undefined;
}

/** Writes `doc` on `target`; throws when the polyfill is missing, since the doc would vanish. */
function writeDoc(target: object, doc: RouteDoc): void {
  if (reflect.defineMetadata === undefined) {
    throw new TypeError(
      '@Describe(): reflect-metadata is not loaded — import "reflect-metadata" (Nest applications always do) before the controllers',
    );
  }
  reflect.defineMetadata(DESCRIBE_METADATA, doc, target);
}

/**
 * A class-level doc under a method's: the method's wins per top-level key,
 * except `tags`, which are the class's followed by the method's own (each
 * once), as `@nestjs/swagger`'s `@ApiTags` combine.
 */
function underClass(
  classDoc: RouteDoc,
  methodDoc: RouteDoc | undefined,
): RouteDoc {
  if (methodDoc === undefined) return classDoc;
  const merged: RouteDoc = { ...classDoc, ...methodDoc };
  if (classDoc.tags !== undefined && methodDoc.tags !== undefined) {
    return {
      ...merged,
      tags: [...new Set([...classDoc.tags, ...methodDoc.tags])],
    };
  }
  return merged;
}

/**
 * Describes a controller route for the generated documents (OpenAPI's
 * operation, the typed client's `x-bun-errors` and `x-bun-cache`): the same
 * {@link RouteDoc} `.describe()` takes on a bun-common router route —
 * `summary`, `description`, `tags`, `operationId`, `deprecated`, `hidden`,
 * `request`, `responses`, `security`, `errors`, `cache`, `extensions`.
 *
 * - **On a method**: the route's doc. Two `@Describe`s on one method merge,
 *   the upper one (applied last) winning per top-level key, as two
 *   `.describe()` calls do.
 * - **On a controller**: merged under each route method the class declares
 *   itself (a method carrying Nest's route metadata, `@Get()` and the
 *   rest): the method's doc wins per top-level key, except `tags`, which
 *   are the controller's followed by the method's. `@Describe({ hidden:
 *   true })` on a controller hides all its routes; two on one controller
 *   merge with each other first, the upper one winning. A route method inherited
 *   from a base controller is not touched: its function is the base's, and
 *   writing to it would describe the base's routes too — describe it on the
 *   base, or override it.
 *
 * Documentation only: it never reaches the handler's types (to constrain a
 * response, declare it on `@Validate({ responses })`), and nothing is
 * checked at run time. `cache.invalidates` is published by bun-common's
 * `liveInvalidation()` when it is mounted, filled from the request's params,
 * on a 2xx — or, with `@Invalidates` on the method, by its interceptor when
 * the handler succeeds; `@Invalidates`' templates are then the route's
 * `cache.invalidates`, whichever of the two was applied last.
 *
 * @param doc The route's doc; anything but a plain object throws a
 *   `TypeError` at decoration.
 */
export function Describe(doc: RouteDoc): MethodDecorator & ClassDecorator {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new TypeError("@Describe(): pass a RouteDoc object");
  }
  const decorator = (
    target: object,
    key?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    if (key !== undefined && descriptor !== undefined) {
      const method = descriptor.value as unknown;
      if (typeof method !== "function") {
        throw new TypeError(
          `@Describe() on ${String(key)}: only methods are routes, not accessors or fields`,
        );
      }
      const existing = methodDocs.get(method);
      const own = existing === undefined ? doc : { ...existing, ...doc };
      methodDocs.set(method, own);
      writeDoc(method, effectiveDoc(method) ?? own);
      return;
    }
    // The class form: the constructor. Class decorators run after every
    // member decorator, so the methods' own docs and Nest's route metadata
    // are in place.
    const constructor = target as { prototype?: object };
    const existing = ownDoc(target);
    const classDoc = existing === undefined ? doc : { ...existing, ...doc };
    writeDoc(target, classDoc);
    const prototype = constructor.prototype;
    if (prototype === undefined) return;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === "constructor") continue;
      const value = Object.getOwnPropertyDescriptor(prototype, name)
        ?.value as unknown;
      if (typeof value !== "function") continue;
      if (reflect.getOwnMetadata?.(NEST_METHOD_METADATA, value) === undefined) {
        continue;
      }
      writeDoc(value, underClass(classDoc, effectiveDoc(value)));
    }
  };
  return decorator;
}
