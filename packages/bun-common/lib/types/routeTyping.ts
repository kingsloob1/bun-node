import type {
  DefaultRequestBody,
  RouterHandler,
  TypedRouteHandler,
} from "./general";
import type {
  ExtractHostParams,
  ExtractRouteParams,
  WithHostParams,
} from "./routeParams";

/**
 * The name of every HTTP verb method `BunRouter` registers a route with —
 * `@routejs/router`'s verb set, WebDAV's included. `all`, `any` and `use` are
 * not verbs and are left out. An adapter may carry fewer (bun-nest's has no
 * `checkout`, say), so narrow with `Extract<RouterVerb, keyof TAdapter>` there.
 */
export type RouterVerb =
  | "checkout"
  | "copy"
  | "delete"
  | "get"
  | "head"
  | "lock"
  | "merge"
  | "mkactivity"
  | "mkcol"
  | "move"
  | "notify"
  | "options"
  | "patch"
  | "post"
  | "propfind"
  | "proppatch"
  | "purge"
  | "put"
  | "report"
  | "search"
  | "subscribe"
  | "trace"
  | "unlock"
  | "unsubscribe"
  | "view";

/**
 * A verb method with its generated typed overloads set aside: the untyped
 * `(path, ...handlers)` signature every verb (and `all`) shares, on
 * `BunRouter`, bun-common's `BunHttpAdapter` and bun-nest's alike.
 *
 * It exists for a verb chosen at runtime. `router[verb]` with `verb` a union
 * such as `"get" | "post"` is a union of overloaded methods. TypeScript calls
 * one only while every member's overload list is identical (today the
 * generator keeps them so); this type does not depend on that. The union is
 * assignable to it, with no cast, because every verb declares this signature
 * among its overloads:
 *
 * ```ts
 * for (const verb of ["get", "post"] as const) {
 *   const register: RouterVerbMethod<typeof router> = router[verb];
 *   register.call(router, "/doc", (req, res) => res.send(req.method));
 * }
 * ```
 *
 * The `this` parameter is the point of the `TRouter` argument: the method
 * reads its router off `this`, so a detached `register("/doc", h)` would throw
 * at runtime and is a compile error here. Call it with `.call(router, …)`.
 * Handlers are untyped (`req.params` is not narrowed from the path); use the
 * verb method directly when the verb is known statically.
 */
export type RouterVerbMethod<TRouter> = (
  this: TRouter,
  path: string,
  ...handlers: RouterHandler[]
) => TRouter;

/**
 * Types backing the verb methods' inference.
 *
 * A route handler's `req` is narrowed from two sources: the registered path
 * literal, and any `BunValidate` middleware registered ahead of it in the same
 * call. A validator advertises what it parsed through a phantom type, so
 * `router.get("/user/:id", validate({ query: Q }), handler)` gives the handler
 * `req.params` from the path and `req.query` from the schema, with nothing
 * restated by the caller.
 */

/** What a validator can advertise having parsed. */
export interface ValidationShape {
  /** Parsed `req.params`, when the validator declared a params schema. */
  params?: unknown;
  /** Parsed `req.query`, when the validator declared a query schema. */
  query?: unknown;
  /** Parsed `req.body`, when the validator declared a body schema. */
  body?: unknown;
}

/** A shape contributing nothing — the default for a non-validator position. */
export type EmptyShape = Record<never, never>;

/**
 * `req.params` for a route: whatever a validator parsed, else the params the
 * path literal declares.
 */
export type ResolveParams<TPath extends string, S> = S extends {
  params: infer P;
}
  ? P
  : ExtractRouteParams<TPath>;

/** `req.query`: whatever a validator parsed, else the untyped parser output. */
export type ResolveQuery<S> = S extends { query: infer Q }
  ? Q
  : Record<string, unknown>;

/** `req.body`: whatever a validator parsed, else the body-parser union. */
export type ResolveBody<S> = S extends { body: infer B }
  ? B
  : DefaultRequestBody;

/**
 * The final handler of a chain, with its request narrowed by the path and the
 * accumulated validator shapes.
 *
 * A handler declared with this type ahead of the call cannot follow an
 * inline validator call — `router.get(path, validate({ query }), handler)`
 * matches no overload. That is a TypeScript inference limit: the inline
 * `validate(...)` is inferred against the verb's unresolved shape parameter,
 * which then falls back to empty. (An inline arrow handler is unaffected.) Use
 * either form instead:
 *
 * ```ts
 * // the validator stored first
 * const pageQuery = validate({ query: PageQuery });
 * router.get("/posts/:id", pageQuery, handler);
 *
 * // or the verb's type arguments spelled out
 * router.get<"/posts/:id", { query: { page: number } }>(
 *   "/posts/:id",
 *   validate({ query: PageQuery }),
 *   handler,
 * );
 * ```
 */
export type ResolvedHandler<TPath extends string, S> = TypedRouteHandler<
  ResolveParams<TPath, S>,
  ResolveQuery<S>,
  ResolveBody<S>
>;

/**
 * Combines a mount's validated shape with a route's own, the route winning on
 * any key both declare.
 *
 * `params` is dropped from the mount's shape deliberately. At runtime the
 * pipeline rebinds `req.params` when it enters each matched route, so a
 * validator mounted with `use()` has its *params* replacement overwritten
 * before a sub-router's handler runs — while its `query` and `body`
 * replacements survive, since those are never rebound. Carrying mount params
 * into the types would promise a coercion the request never receives.
 */
export type MergeShape<TMountShape, TShape> = Omit<
  Omit<TMountShape, "params">,
  keyof TShape
> &
  TShape;

/**
 * `req.params` for a route on a host-scoped router: whatever a validator
 * parsed (it replaces `req.params` wholesale, host captures included), else
 * the path's params merged over the host pattern's. With no host (`""`) this is
 * exactly {@link ResolveParams}.
 */
export type ResolveHostedParams<
  TPath extends string,
  S,
  THost extends string,
> = S extends { params: infer P }
  ? P
  : WithHostParams<ExtractRouteParams<TPath>, ExtractHostParams<THost>>;

/**
 * The handler type for a route registered at `TPath` on a router mounted at
 * `TMountPath`.
 *
 * Params come from both paths concatenated, matching the runtime, which merges
 * the mount's matched params with the route's own. `TMountPath` defaults to the
 * empty string for an unmounted router, so concatenation is the identity there.
 *
 * `THost` is the host pattern a `domain()` scoped the router to; its captures
 * are merged into params too. It defaults to `""` — no host, no host params.
 */
export type MountedHandler<
  TMountPath extends string,
  TMountShape,
  TPath extends string,
  TShape,
  THost extends string = "",
> = TypedRouteHandler<
  ResolveHostedParams<`${TMountPath}${TPath}`, TShape, THost>,
  ResolveQuery<MergeShape<TMountShape, TShape>>,
  ResolveBody<MergeShape<TMountShape, TShape>>
>;
