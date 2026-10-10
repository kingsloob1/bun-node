/**
 * Shared types for the inference spike. `#lib/*` resolves to the patched copy
 * of bun-common (variant v1) or to the real one (v0, v2) through each
 * generated project's tsconfig `paths`.
 */
import type { ValidatedShapeFor, ValidationSchemas, ValidatorMiddleware } from "#lib/BunValidate";
import type { EmptyShape, MountedHandler, ResolveParams } from "#lib/types/routeTyping";
import type { StandardSchemaV1 } from "#lib/types/standardSchema";
import { validate } from "#lib/BunValidate";

/** A response map: status → schema (or null for no body). */
export type ResponseSchemas = Record<number, StandardSchemaV1 | null>;
type InputsOf<S> = { [K in keyof S]: S[K] extends StandardSchemaV1 ? StandardSchemaV1.InferInput<S[K]> : never };
type OutputsOf<R> = { [K in keyof R]: R[K] extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<R[K]> : null };

/**
 * `validate()` plus the two things the client needs that the phantom
 * `__shape` does not carry today: the schemas' INPUT types (for bodies) and
 * the declared responses (api-docs-generation.md Decision 4, not built yet).
 */
export function v<const S extends ValidationSchemas, const R extends ResponseSchemas>(
  schemas: S,
  _responses: R,
): ValidatorMiddleware<ValidatedShapeFor<S> & { input: InputsOf<S>; responses: OutputsOf<R> }> {
  return validate(schemas) as never;
}

/** JSON round trip: what `res.json(x)` becomes after `JSON.parse` on the client. */
export type Jsonify<T> = T extends { toJSON: () => infer J } ? J
  : T extends string | number | boolean | null ? T
    : T extends undefined | ((...a: never[]) => unknown) | symbol ? never
      : T extends readonly (infer E)[] ? Jsonify<E>[]
        : { [K in keyof T as T[K] extends undefined | ((...a: never[]) => unknown) ? never : K]: Jsonify<T[K]> };

/** One route as the client sees it. */
export interface ClientEntry { params: unknown; query: unknown; body: unknown; responses: unknown }

type ParamsOpt<P> = keyof P extends never ? { params?: undefined } : { params: P };
/** The request options for one entry. */
export type RequestOpts<E extends ClientEntry> = ParamsOpt<E["params"]> & { query?: Partial<E["query"]>; body?: E["body"]; signal?: AbortSignal };
/** The discriminated result: one member per declared status. */
export type Result<E extends ClientEntry> = { [S in keyof E["responses"]]: { status: S; data: Jsonify<E["responses"][S]> } }[keyof E["responses"]];

// ---------- variant v1: a flat map keyed "VERB /path" (from the patched BunRouter) ----------
type PathsFor<R, M extends string> = { [K in keyof R & string]: K extends `${M} ${infer P}` ? P : never }[keyof R & string];
type At<R, K> = K extends keyof R ? (R[K] extends ClientEntry ? R[K] : never) : never;
/** An openapi-fetch-style client over a flat route map. */
export interface FlatClient<R> {
  get: <P extends PathsFor<R, "GET">>(path: P, opts: RequestOpts<At<R, `GET ${P}`>>) => Promise<Result<At<R, `GET ${P}`>>>;
  post: <P extends PathsFor<R, "POST">>(path: P, opts: RequestOpts<At<R, `POST ${P}`>>) => Promise<Result<At<R, `POST ${P}`>>>;
  put: <P extends PathsFor<R, "PUT">>(path: P, opts: RequestOpts<At<R, `PUT ${P}`>>) => Promise<Result<At<R, `PUT ${P}`>>>;
  delete: <P extends PathsFor<R, "DELETE">>(path: P, opts: RequestOpts<At<R, `DELETE ${P}`>>) => Promise<Result<At<R, `DELETE ${P}`>>>;
}
export function createFlatClient<R>(_base: string): FlatClient<R> {
  return {} as never;
}

// ---------- variant v2: a registry of named operations (no BunRouter change) ----------
/** A route definition: runtime callbacks plus the type of its shape. */
export interface RouteDef<M extends string, P extends string, S> {
  method: M;
  path: P;
  callbacks: unknown[];
  /** Phantom. */
  readonly __shape?: S;
}
type Verb = "GET" | "POST" | "PUT" | "DELETE";
type VerbFn<Mount extends string, M extends Verb> = <P extends string, S = EmptyShape>(
  path: P,
  validator: ValidatorMiddleware<S>,
  handler: MountedHandler<Mount, EmptyShape, P, S>,
) => RouteDef<M, `${Mount}${P}`, S>;
/** The builder handed to `defineRoutes`' callback. */
export interface RouteBuilder<Mount extends string> {
  get: VerbFn<Mount, "GET">;
  post: VerbFn<Mount, "POST">;
  put: VerbFn<Mount, "PUT">;
  delete: VerbFn<Mount, "DELETE">;
}
export function defineRoutes<const Mount extends string, const T extends Record<string, RouteDef<string, string, unknown>>>(
  mount: Mount,
  build: (r: RouteBuilder<Mount>) => T,
): T {
  const mk = (method: string) => (path: string, ...callbacks: unknown[]) => ({ method, path: mount + path, callbacks });
  return build({ get: mk("GET"), post: mk("POST"), put: mk("PUT"), delete: mk("DELETE") } as never);
}
type EntryOf<D> = D extends RouteDef<string, infer P, infer S>
  ? {
      params: ResolveParams<P, S>;
      query: S extends { query: infer Q } ? Q : Record<string, unknown>;
      body: S extends { input: { body: infer B } } ? B : undefined;
      responses: S extends { responses: infer R } ? R : { 200: unknown };
    }
  : never;
/** A tRPC-style client over `{ group: { operation: RouteDef } }`. */
export type NamedClient<A> = {
  [G in keyof A]: { [Op in keyof A[G]]: EntryOf<A[G][Op]> extends infer E extends ClientEntry ? (opts: RequestOpts<E>) => Promise<Result<E>> : never };
};
export function createNamedClient<A>(_base: string): NamedClient<A> {
  return {} as never;
}
