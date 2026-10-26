/**
 * The `defineRoutes` registry (AD (a2), plan `docs/plans/api-docs-generation/`
 * §11 row (a2); the shape is the typed-client plan's §8.5,
 * `docs/plans/typed-client/`): a group of routes declared as data — an object
 * whose every property is one named definition — instead of statements.
 *
 * It is **a helper over `.describe()`**: each verb call on the builder
 * registers the route on a fresh `BunRouter`, exactly as the same call would
 * on any router, and the property name the definition is returned under
 * becomes the route's `operationId` (`describe({ operationId })`). Nothing
 * else changes — the router, its verb overloads and the generated documents
 * are untouched, and `generate-verb-overloads.ts --check` stays green because
 * no overload changes.
 *
 * The registry exists **for inference** (the typed-client plan's D3): the
 * returned object's type carries every definition, so `RoutesOf` reads the
 * same flat map generation emits, with no generated file. It is not *instead
 * of* generation — statement-style routes remain the default, and
 * `generateOpenApi`/`listRoutes` read a registry's routes like any others
 * (with their `operationId`s already named, no annotation needed).
 *
 * ```ts
 * export const users = defineRoutes("/users", (r) => ({
 *   get: r.get("/:id", validate({ params: IdParams }), handler),
 *   create: r.post("/", validate({ body: NewUser }), createHandler),
 * }));
 * app.use(users.mount, users.router);        // an ordinary sub-router mount
 * export type Api = RoutesOf<typeof users>;  // the flat map, keyed "VERB /path"
 * ```
 */
import type { ValidatorMiddleware } from "./BunValidate";
import { BunRouter } from "./BunRouter";
import { attachRouteDoc } from "./docs/routeDoc";
import type { RouterHandler } from "./types/general";
import type {
  EmptyShape,
  MountedHandler,
  ResolveParams,
  ResolveQuery,
} from "./types/routeTyping";
import { isFunction, isObject } from "./utils/native";

/**
 * One named route of a registry: what a builder verb returns and what
 * `build` returns a record of.
 *
 * `method` and `path` are literal-typed — the path already carries the
 * registry's mount, so a definition alone answers the key its flat-map entry
 * sits under (`"${method} ${path}"`). `callbacks` are the route's own
 * callbacks (the validator and the handler), in registration order. The
 * `__shape` property is a phantom carrier of the validator's shape — the same
 * one `ValidatorMiddleware` advertises — and never exists at runtime;
 * {@link RoutesOf} reads it.
 *
 * @typeParam TMethod The HTTP method, upper-case; `"ALL"` for an `all()`
 *   definition.
 * @typeParam TPath The full path: the registry's mount joined with the path
 *   as written on the builder.
 * @typeParam TShape The validator's advertised shape, `EmptyShape` when the
 *   definition declares no validator.
 */
export interface RouteDef<
  TMethod extends string = string,
  TPath extends string = string,
  TShape = EmptyShape,
> {
  /** The HTTP method, upper-case; `"ALL"` for an `all()` definition. */
  readonly method: TMethod;
  /** The full path — the registry's mount joined with the path as written. */
  readonly path: TPath;
  /** The route's own callbacks (the validator, then the handler), in order. */
  readonly callbacks: readonly unknown[];
  /** Phantom carrier of the validated shape; never present at runtime. */
  readonly __shape?: TShape;
}

/**
 * One verb on the builder {@link defineRoutes} hands to `build`. The two
 * forms mirror the router's own verb calls — `(path, handler)` and
 * `(path, validator, handler)` — and type the handler through the same
 * `MountedHandler` the generated overloads use, so `req.params` comes from
 * the path literal (the mount's params included) and `req.query`/`req.body`
 * from the validator.
 */
interface DefineVerb<TMount extends string, TMethod extends string> {
  <TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMount, EmptyShape, TPath, TShape>,
  ): RouteDef<TMethod, `${TMount}${TPath}`, TShape>;
  <TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMount, EmptyShape, TPath, TShape>,
  ): RouteDef<TMethod, `${TMount}${TPath}`, TShape>;
}

/**
 * The builder `build` receives: the six common verbs, each registering on the
 * registry's router and answering the {@link RouteDef} it defined.
 */
interface RouteBuilder<TMount extends string> {
  readonly get: DefineVerb<TMount, "GET">;
  readonly post: DefineVerb<TMount, "POST">;
  readonly put: DefineVerb<TMount, "PUT">;
  readonly delete: DefineVerb<TMount, "DELETE">;
  readonly patch: DefineVerb<TMount, "PATCH">;
  readonly all: DefineVerb<TMount, "ALL">;
}

/** The property names the registry's return reserves for itself. */
const RESERVED_KEYS = ["mount", "router"] as const;

/**
 * Declares a group of routes as data: `build` receives a builder whose verb
 * methods mirror the router's (`r.get(path, [validator], handler)`), each
 * call registering on a fresh `BunRouter` and answering its {@link RouteDef}.
 * The record `build` returns — property name to definition — is the
 * registry's route table: each property name becomes the route's
 * `operationId`, recorded with `.describe()`'s own store, so its rules apply
 * (a doc keyed on the terminal callback; a duplicate operation id is
 * `generateOpenApi`'s `ConfigError`, never a rename).
 *
 * The return is that record plus two reserved properties: `mount`, the mount
 * path as given, and `router`, the fresh router the routes registered on —
 * mounted as an ordinary sub-router:
 *
 * ```ts
 * const users = defineRoutes("/users", (r) => ({ … }));
 * app.use(users.mount, users.router);
 * ```
 *
 * The inner router takes no options, deliberately: a registry is declared for
 * where it will be mounted, and its parent's options apply once it is.
 *
 * `RoutesOf<typeof users>` turns the return into the flat map a typed client
 * is built over.
 *
 * @throws TypeError when `mount` is not a string, when `build` is not a
 *   function, when the returned record uses a reserved property name
 *   (`"mount"`, `"router"`), or when a property is not a definition the
 *   builder made (no terminal callback to document).
 */
export function defineRoutes<
  const TMount extends string,
  const TDefs extends Record<string, RouteDef>,
>(
  mount: TMount,
  build: (routes: RouteBuilder<TMount>) => TDefs,
): TDefs & { readonly mount: TMount; readonly router: BunRouter<TMount> } {
  if (typeof mount !== "string") {
    throw new TypeError("defineRoutes(): the mount must be a string");
  }
  if (!isFunction(build)) {
    throw new TypeError("defineRoutes(): build must be a function");
  }

  const router = new BunRouter<TMount>();
  const builder: RouteBuilder<TMount> = {
    get: makeVerb("GET", mount, (path, callbacks) => {
      router.get(path, ...callbacks);
    }),
    post: makeVerb("POST", mount, (path, callbacks) => {
      router.post(path, ...callbacks);
    }),
    put: makeVerb("PUT", mount, (path, callbacks) => {
      router.put(path, ...callbacks);
    }),
    delete: makeVerb("DELETE", mount, (path, callbacks) => {
      router.delete(path, ...callbacks);
    }),
    patch: makeVerb("PATCH", mount, (path, callbacks) => {
      router.patch(path, ...callbacks);
    }),
    all: makeVerb("ALL", mount, (path, callbacks) => {
      router.all(path, ...callbacks);
    }),
  };

  const defs = build(builder);
  for (const key of RESERVED_KEYS) {
    if (Object.hasOwn(defs, key)) {
      throw new TypeError(
        `defineRoutes(): "${key}" is a reserved property of the registry; name the route something else`,
      );
    }
  }
  for (const [name, def] of Object.entries(defs)) {
    const terminal: unknown = isObject(def) ? def.callbacks.at(-1) : undefined;
    if (
      !isFunction(terminal) &&
      (typeof terminal !== "object" || terminal === null)
    ) {
      throw new TypeError(
        `defineRoutes(): "${name}" is not a definition the builder made — it has no terminal callback to document`,
      );
    }
    attachRouteDoc(terminal, { operationId: name });
  }

  return { ...defs, mount, router };
}

/** Builds one verb of the registry's builder. */
function makeVerb<TMount extends string, TMethod extends string>(
  method: TMethod,
  mount: TMount,
  register: (path: string, callbacks: RouterHandler[]) => void,
): DefineVerb<TMount, TMethod> {
  const define = (
    path: string,
    ...callbacks: RouterHandler[]
  ): RouteDef<TMethod, string> => {
    register(path, callbacks);
    return { method, path: `${mount}${path}`, callbacks };
  };
  return define as unknown as DefineVerb<TMount, TMethod>;
}

/**
 * The flat route map of a registry — the same shape generation emits, keyed
 * `"VERB /full/path"` — read off `typeof` a `defineRoutes` return:
 *
 * ```ts
 * const users = defineRoutes("/users", (r) => ({
 *   get: r.get("/:id", validate({ params: IdParams }), handler),
 * }));
 * type Api = RoutesOf<typeof users>;
 * // { "GET /users/:id": { params: { id: string }; query: …; body: …; responses: … } }
 * ```
 *
 * Each entry answers what a client needs of the route: `params` from the
 * validator's parsed params when it declared them, else the full path's
 * captures; `query` the validator's parsed query (else the untyped parser
 * output); `body` the parsed body (else `undefined`); `responses` the
 * declared response map (else `{ 200: unknown }`). The reserved `mount` and
 * `router` properties of the registry contribute no entry.
 *
 * Pure type: it exists at compile time only.
 *
 * @typeParam T The registry's type — `typeof` a `defineRoutes` return.
 */
export type RoutesOf<T = Record<string, RouteDef>> = {
  [K in keyof T as RouteKeyOf<T[K]>]: RouteEntryOf<T[K]>;
};

/** The key a definition's entry sits under, `"VERB /full/path"`; `never` for anything else. */
type RouteKeyOf<D> =
  D extends RouteDef<infer M extends string, infer P extends string, unknown>
    ? `${M} ${P}`
    : never;

/** One entry of the flat map; `never` for a property that is not a definition. */
type RouteEntryOf<D> =
  D extends RouteDef<string, infer P, infer S>
    ? {
        params: ResolveParams<P, S>;
        query: ResolveQuery<S>;
        body: S extends { body: infer B } ? B : undefined;
        responses: S extends { responses: infer R } ? R : { 200: unknown };
      }
    : never;
