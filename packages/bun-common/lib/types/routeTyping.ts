import type { DefaultRequestBody, TypedRouteHandler } from "./general";
import type { ExtractRouteParams } from "./routeParams";

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
 * The handler type for a route registered at `TPath` on a router mounted at
 * `TMountPath`.
 *
 * Params come from both paths concatenated, matching the runtime, which merges
 * the mount's matched params with the route's own. `TMountPath` defaults to the
 * empty string for an unmounted router, so concatenation is the identity there.
 */
export type MountedHandler<
  TMountPath extends string,
  TMountShape,
  TPath extends string,
  TShape,
> = TypedRouteHandler<
  ResolveParams<`${TMountPath}${TPath}`, TShape>,
  ResolveQuery<MergeShape<TMountShape, TShape>>,
  ResolveBody<MergeShape<TMountShape, TShape>>
>;
