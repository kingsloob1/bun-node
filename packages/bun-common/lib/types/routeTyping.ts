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
