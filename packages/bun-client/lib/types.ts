/**
 * The client's types (typed-client plan §4, §6.1, §6.2): the route map, a
 * call's options derived from one entry, and the {@link Result} it returns.
 *
 * A map is flat and keyed like the server, `"GET /users/:id"` (§3.0). In
 * PR-C1 it is written by hand or read off a registry with bun-common's
 * `RoutesOf`; from PR-C2 the generator writes it from the OpenAPI document.
 * All three produce the same shape.
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-contract";
import type { ValidationError } from "./errors";
import type { Jsonify } from "./jsonify";
import type { PathParamValue } from "./path";

/** What a status may say about a failed call: thrown, or returned as a result (§4.3). */
export type UndeclaredStatus = "throw" | "result";

/**
 * One route of a {@link RouteMap}: what a client needs of it. Every field is
 * the **wire** side (plan D5): what is sent (each field's input, coerced
 * values as strings) and what comes back (before `Jsonify`, which the client
 * applies).
 *
 * - `params`, `query`, `headers`, `body`: a field left out is undeclared, and
 *   loosely typed at the call; `query: Record<never, never>` declares "none",
 *   and `body: undefined` declares "no body".
 * - `responses`: the body type per status; left out, `{ 200: unknown }`.
 * - `send`/`receive`: the sender and receiver views the plan's §8.5 adds to
 *   `RoutesOf` (PR-M1); when present they win over the fields above.
 */
export interface RouteEntry {
  /** The route's `operationId`, the name `api.op` calls it by. Default: none (not in `op`). */
  operationId?: string;
  /** Path params, by name. Default: undeclared, so any `Record` of values. */
  params?: object;
  /** The query object. Default: undeclared, so any object. */
  query?: object;
  /** Request headers the route declares, by lower-case name. Default: undeclared. */
  headers?: object;
  /** The request body (JSON). Default: undeclared, so `unknown`. */
  body?: unknown;
  /** Response bodies by status. Default: `{ 200: unknown }`. */
  responses?: object;
  /** The sender view (`RoutesOf`, plan §8.5): `params`, `query`, `headers`, `body`. */
  send?: object;
  /** The receiver view (`RoutesOf`, plan §8.5): response bodies by status. */
  receive?: object;
}

/**
 * A route map, keyed `"VERB /path"` with the server's own path literal.
 * Written as a constraint, `R extends RouteMap<R>`, so an `interface Routes`
 * (which has no index signature) satisfies it.
 */
export type RouteMap<R = Record<string, RouteEntry>> = {
  [K in keyof R]: RouteEntry;
};

/** The keys of `T` whose property is required; an index signature never is. */
type RequiredKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T];

/** The entry at key `K`, `never` when `K` is not one. */
export type EntryAt<R, K> = K extends keyof R ? R[K] : never;

/** The paths of `R` whose method is `M`: `"GET /users/:id"` gives `"/users/:id"` for `"GET"`. */
export type PathsOf<R, M extends string> = keyof R extends infer K
  ? K extends `${M} ${infer P}`
    ? P
    : never
  : never;

/** Every path of `R`, whatever its method. */
export type AnyPathOf<R> = keyof R extends infer K
  ? K extends `${string} ${infer P}`
    ? P
    : never
  : never;

/** The entries of `R` whose path is `P` (several methods may share one). */
type EntriesAtPath<R, P extends string> = {
  [K in keyof R]: K extends `${string} ${P}` ? R[K] : never;
}[keyof R];

/** The sender's view of an entry: its `send` view, else the entry itself. */
type SendView<E> = E extends { send: infer S extends object } ? S : E;

/** `true` when the entry declares part `K` in its sender view. */
type Declares<E, K extends string> = K extends keyof SendView<E> ? true : false;

/** The declared type of part `K`. */
type PartOf<E, K extends string> = K extends keyof SendView<E>
  ? SendView<E>[K]
  : never;

/**
 * `{ [K]: T }`, required when `T` has a required key, else optional. A `T`
 * with no keys at all (`Record<never, never>`, the map's "none") takes
 * `Record<string, never>`: an empty object passes and any key fails, where
 * `{}` would let excess keys through unchecked.
 */
type KeyedPart<K extends string, T> = [keyof T] extends [never]
  ? { [P in K]?: Record<string, never> }
  : [RequiredKeys<T>] extends [never]
    ? { [P in K]?: T }
    : { [P in K]: T };

/** A header value as a call writes it. */
type HeaderValue = string | undefined;

/** The `params` option for entry `E`. */
type ParamsPart<E> =
  Declares<E, "params"> extends true
    ? KeyedPart<"params", PartOf<E, "params">>
    : { params?: Readonly<Record<string, PathParamValue>> };

/** The `query` option for entry `E`. */
type QueryPart<E> =
  Declares<E, "query"> extends true
    ? KeyedPart<"query", PartOf<E, "query">>
    : { query?: object };

/** The `body` option for entry `E`: required unless its type admits `undefined`. */
type BodyPart<E> =
  Declares<E, "body"> extends true
    ? [PartOf<E, "body">] extends [undefined]
      ? { body?: undefined }
      : undefined extends PartOf<E, "body">
        ? { body?: PartOf<E, "body"> }
        : { body: PartOf<E, "body"> }
    : { body?: unknown };

/**
 * The `headers` option for entry `E`. A route that declares headers takes
 * them typed (optional at the call, since the client's or the route's
 * configuration may supply them) beside any other header; one that does not
 * takes any {@link HeadersOption}.
 */
type HeadersPart<E> =
  Declares<E, "headers"> extends true
    ? {
        headers?: Partial<PartOf<E, "headers">> &
          Readonly<Record<string, HeaderValue>>;
      }
    : { headers?: HeadersOption };

/** The typed parts of a call to entry `E`: params, query, body, headers. */
export type CallParts<E> = ParamsPart<E> &
  QueryPart<E> &
  BodyPart<E> &
  HeadersPart<E>;

/**
 * A call's options for entry `E`: its typed parts plus {@link CallConfig}.
 * `T` and `U` carry the call's `throwOnError` and `undeclaredStatus`, so the
 * return type follows them.
 */
export type CallOptions<
  E,
  T extends boolean | undefined = undefined,
  U extends UndeclaredStatus | undefined = undefined,
> = Omit<CallConfig, "headers" | "throwOnError" | "undeclaredStatus"> &
  CallParts<E> & {
    /** This call's `throwOnError` (§4.4). Default: the client's. */
    throwOnError?: T;
    /** This call's `undeclaredStatus` (§4.3). Default: the client's. */
    undeclaredStatus?: U;
  };

/** A call's arguments: the options are required when a typed part is. */
export type CallArgs<
  E,
  T extends boolean | undefined = undefined,
  U extends UndeclaredStatus | undefined = undefined,
> = [RequiredKeys<CallParts<E>>] extends [never]
  ? [options?: CallOptions<E, T, U>]
  : [options: CallOptions<E, T, U>];

/** A response map's key as a status number (`"404"` and `404` alike). */
type ToStatus<K> = K extends number
  ? K
  : K extends `${infer N extends number}`
    ? N
    : never;

/**
 * bun-common's `RoutesOf` today (before PR-M1's `receive` view) holds each
 * status's handler spec, `{ json, send, headers, cookies }`; its `json` is
 * the body a handler sends, which is the wire body.
 */
type BodyOfSpec<V> = V extends {
  json: infer J;
  send: unknown;
  headers: unknown;
  cookies: unknown;
}
  ? J
  : V;

/** An entry's responses, numerically keyed: `receive`, else `responses`, else `{ 200: unknown }`. */
export type ResponsesOf<E> = E extends { receive: infer R extends object }
  ? { [K in keyof R as ToStatus<K>]: R[K] }
  : E extends { responses: infer R extends object }
    ? { [K in keyof R as ToStatus<K>]: BodyOfSpec<R[K]> }
    : { 200: unknown };

/** Every status the entry declares. */
export type StatusOf<E> = keyof ResponsesOf<E> & number;

/** The declared 2xx statuses. */
export type SuccessStatus<E> =
  StatusOf<E> extends infer S
    ? S extends number
      ? `${S}` extends `2${string}`
        ? S
        : never
      : never
    : never;

/** The declared statuses that are not 2xx. */
export type ErrorStatus<E> = Exclude<StatusOf<E>, SuccessStatus<E>>;

/**
 * A response body as the client returns it: after JSON, except a `Blob`,
 * which is how the client returns a body that is neither JSON nor text
 * (`readBody`), and which JSON would make an object of its two properties.
 */
type WireBody<T> = Jsonify<Exclude<T, Blob>> | Extract<T, Blob>;

/** The body of status `S`, as the client returns it. */
type BodyAt<E, S> = WireBody<
  S extends keyof ResponsesOf<E> ? ResponsesOf<E>[S] : never
>;

/**
 * What a call returns (§4.4): one member per declared status, discriminated
 * by `ok` and `status`, so `if (r.ok)` narrows to the 2xx members and
 * `r.status === 404` to that one.
 *
 * `response` is the `Response`, its body already read into `data` or
 * `error`. With `undeclaredStatus: "result"` (`U`), a status the route does
 * not declare comes back as the catch-all member `{ ok: false, status:
 * number, error: unknown }`, which stops `status` narrowing much (§4.3).
 *
 * @typeParam E The route's entry.
 * @typeParam U `"result"` to include the catch-all member.
 */
export type Result<E, U extends UndeclaredStatus = "throw"> =
  | {
      [S in SuccessStatus<E>]: {
        /** A declared 2xx status. */
        ok: true;
        /** The status. */
        status: S;
        /** The parsed body. */
        data: BodyAt<E, S>;
        /** Absent on success. */
        error?: undefined;
        /** The response, its body already read. */
        response: Response;
      };
    }[SuccessStatus<E>]
  | {
      [S in ErrorStatus<E>]: {
        /** A declared status outside 2xx. */
        ok: false;
        /** The status. */
        status: S;
        /** Absent on failure. */
        data?: undefined;
        /** The parsed body (problem+json, by the plan's convention). */
        error: BodyAt<E, S>;
        /** The response, its body already read. */
        response: Response;
      };
    }[ErrorStatus<E>]
  | (U extends "result"
      ? {
          /** A status the route does not declare, 2xx included. */
          ok: false;
          /** The status. */
          status: number;
          /** Absent. */
          data?: undefined;
          /** The parsed body, whatever it is. */
          error: unknown;
          /** The response, its body already read. */
          response: Response;
        }
      : never);

/** What `throwOnError: true` returns: the success body (a union over the 2xx statuses). */
export type SuccessData<E> = BodyAt<E, SuccessStatus<E>>;

/** The type-level part of the client's configuration: what decides a call's return type. */
export interface ClientFlags {
  /** As {@link ClientConfig.throwOnError}. */
  throwOnError?: boolean;
  /** As {@link ClientConfig.undeclaredStatus}. */
  undeclaredStatus?: UndeclaredStatus;
}

/** The client's `throwOnError`, from its flags. */
type GlobalThrow<F> = F extends { throwOnError: infer T extends boolean }
  ? T
  : false;

/** The client's `undeclaredStatus`, from its flags. */
type GlobalUndeclared<F> = F extends {
  undeclaredStatus: infer U extends UndeclaredStatus;
}
  ? U
  : "throw";

/**
 * The configuration fields the flags `F` pin: `throwOnError` must be given
 * as the flags say (and may be left out only when they say `false`), the
 * same for `undeclaredStatus`. So the types never disagree with what runs.
 */
export type FlagConfig<F> = ([GlobalThrow<F>] extends [false]
  ? {
      /** `false`: name `{ throwOnError: true }` in `createClient`'s second type argument to turn it on. */
      throwOnError?: false;
    }
  : {
      /** As the client's flags say. */
      throwOnError: GlobalThrow<F>;
    }) &
  ([GlobalUndeclared<F>] extends ["throw"]
    ? {
        /** `"throw"`: name `{ undeclaredStatus: "result" }` in `createClient`'s second type argument to change it. */
        undeclaredStatus?: "throw";
      }
    : {
        /** As the client's flags say. */
        undeclaredStatus: GlobalUndeclared<F>;
      });

/** What a call to entry `E` resolves to, given the call's `T`/`U` and the client's flags `F`. */
export type CallReturn<E, T, U, F> = (
  [T] extends [boolean] ? T : GlobalThrow<F>
) extends infer Throw
  ? Throw extends true
    ? SuccessData<E>
    : Result<
        E,
        [U] extends [UndeclaredStatus]
          ? U
          : GlobalUndeclared<F> & UndeclaredStatus
      >
  : never;

/** A call to entry `E`. */
export type Call<E, F> = <
  T extends boolean | undefined = undefined,
  U extends UndeclaredStatus | undefined = undefined,
>(
  ...args: CallArgs<E, T, U>
) => Promise<CallReturn<E, T, U, F>>;

/** A verb method: the path as a literal of the map's paths for that method. */
export type Verb<R, M extends string, F> = <
  P extends PathsOf<R, M>,
  T extends boolean | undefined = undefined,
  U extends UndeclaredStatus | undefined = undefined,
>(
  path: P,
  ...args: CallArgs<EntryAt<R, `${M} ${P}`>, T, U>
) => Promise<CallReturn<EntryAt<R, `${M} ${P}`>, T, U, F>>;

/** An entry's `operationId` as a literal; `never` when it has none. */
type OperationIdOf<E> = E extends { operationId: infer O extends string }
  ? O
  : never;

/** `api.op`: one call per `operationId` in the map (other-transports.md §2). */
export type Operations<R, F> = {
  [K in keyof R as OperationIdOf<R[K]>]: Call<R[K], F>;
};

/** The options of {@link Client.url}: the params and query of the path's entries. */
export type UrlArgs<R, P extends string> = [
  RequiredKeys<
    ParamsPart<EntriesAtPath<R, P>> & QueryPart<EntriesAtPath<R, P>>
  >,
] extends [never]
  ? [options?: ParamsPart<EntriesAtPath<R, P>> & QueryPart<EntriesAtPath<R, P>>]
  : [options: ParamsPart<EntriesAtPath<R, P>> & QueryPart<EntriesAtPath<R, P>>];

/**
 * The runtime facts a map's types cannot carry, per route key: its
 * `operationId` (for `api.op`) and its declared statuses (for
 * `undeclaredStatus`). The generator (PR-C2) writes it beside the map; a
 * hand-written map writes it by hand, checked against the map by this type.
 *
 * A route without an entry here has no statuses known at run time: every
 * status it answers is returned as declared, and `undeclaredStatus` does not
 * apply to it.
 */
export type RouteManifest<R> = {
  readonly [K in keyof R]?: {
    /** The route's `operationId`, as the map declares it. */
    readonly operationId?: OperationIdOf<R[K]>;
    /** Every status the route declares. */
    readonly statuses?: readonly StatusOf<R[K]>[];
  };
};

/**
 * Headers as `new Headers()` takes them: the DOM's `HeadersInit`, or Bun's,
 * named through the constructor so the declarations need neither lib's alias.
 */
export type HeadersLike = NonNullable<ConstructorParameters<typeof Headers>[0]>;

/** Headers as any level of the configuration gives them: static, or a function per request. */
export type HeadersOption =
  HeadersLike | ((ctx: RequestContext) => HeadersLike | Promise<HeadersLike>);

/**
 * One request in flight: what the headers functions and the middleware see.
 * `request` is mutable: a middleware may change its headers or replace it.
 */
export interface RequestContext {
  /** The route key, `"GET /users/:id"`. */
  readonly key: string;
  /** The upper-case method. */
  readonly method: string;
  /** The route's path literal, `"/users/:id"`. */
  readonly path: string;
  /** The call's options as given (params, query, body, headers, …). */
  readonly options: Readonly<Record<string, unknown>>;
  /** The attempt, from `1`; a retry or an auth retry adds one. */
  readonly attempt: number;
  /** The request to send. Replace it to send another. */
  request: Request;
}

/**
 * A middleware: an onion of `(ctx, next) => Promise<Response>` (§6.1). Call
 * `next()` to send `ctx.request` (through the inner middleware), or return a
 * `Response` without calling it (a mock, a cache). Runs once per attempt.
 */
export type ClientMiddleware = (
  ctx: RequestContext,
  next: () => Promise<Response>,
) => Promise<Response>;

/** Retries (§6.2). */
export interface RetryConfig {
  /** Attempts after the first. Default: `2`. */
  attempts?: number;
  /** Methods retried. Default: `["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]` (idempotent). */
  methods?: readonly string[];
  /** Statuses retried, plus `"network"` for a failed fetch. Default: `[408, 429, 500, 502, 503, 504, "network"]`. */
  on?: readonly (number | "network")[];
  /** First delay, ms. Default: `300`. */
  baseMs?: number;
  /** Largest delay, ms. Default: `10_000`. */
  maxMs?: number;
  /** Jitter fraction, 0 to 1. Default: `0.5`. */
  jitter?: number;
  /** Wait as long as a `Retry-After` header asks, capped at `maxMs`. Default: `true`. */
  respectRetryAfter?: boolean;
}

/**
 * Token and refresh (§6.1). The token goes out as `Authorization: Bearer
 * <token>` unless the request already has an `Authorization` header.
 */
export interface AuthConfig {
  /**
   * The token, or a function returning it (sync or async), read per request.
   * `null` or `undefined`: no header. Default: none.
   */
  token?:
    | string
    | null
    | (() => string | null | undefined | Promise<string | null | undefined>);
  /**
   * Gets a new token after a status in `on`. Called once for any number of
   * concurrent failures (single-flight); each failed request is then sent
   * once more. Return the new token; `undefined` to read `token` again (the
   * app stored it itself); `null` for "no new token", which returns the
   * failure as it is. A throw rejects every waiting call with it.
   * Default: none (no refresh).
   */
  refresh?: () => Promise<string | null | undefined>;
  /** Statuses that trigger a refresh. Default: `[401]`. */
  on?: readonly number[];
}

/**
 * What a failed check does (§6.2): `"throw"` a {@link ValidationError};
 * `"warn"` through the client's `logger` and carry on (send the request, or
 * deliver the response as it arrived); or a hook, called with the error,
 * which may throw it (or anything) to fail the call, and otherwise carries
 * on as `"warn"` does, without the log line.
 */
export type FailureMode = "throw" | "warn" | ((error: ValidationError) => void);

/**
 * One part's validation (§5.4, §6.2): `true` runs the built-in schema,
 * `false` turns the part off (a BYO schema included), or an object.
 */
export type PartValidation =
  | boolean
  | {
      /** Run the built-in schema. Default: the level's `request`/`response` switch. */
      enabled?: boolean;
      /**
       * A Standard Schema run after the built-in one (§5.4), on the built-in
       * one's output when that passed and on the raw value when it failed,
       * so both report at once. What it returns is what is sent (a request
       * part) or delivered (a response). A set `custom` runs whatever the
       * mode, unless a `false` at this level or a later one turns the part
       * off. A later level's `custom` replaces an earlier one's. Default: none.
       */
      custom?: StandardSchemaV1;
      /** Run `custom` instead of the built-in schema. Default: `false`. */
      replace?: boolean;
    };

/**
 * Validation switches and BYO schemas (§5.4–§5.5, §6.2), at any level of the
 * configuration. Levels merge per key, later winning; a `false` (the whole
 * object, `request`, `response` or a part) turns everything under it off,
 * BYO schemas included, until a later level turns it back on.
 */
export interface ValidationConfig {
  /**
   * Every request part at once, before the parts' own entries at the same
   * level: `true` runs their built-in schemas, `false` turns them off (BYO
   * schemas included). Default: built-in schemas on in development, off in
   * production ({@link ClientConfig.mode}).
   */
  request?: boolean;
  /** Path parameters. Default: `request`. */
  params?: PartValidation;
  /** The query object, checked before it is serialised. Default: `request`. */
  query?: PartValidation;
  /** The body, checked before it is serialised. Default: `request`. */
  body?: PartValidation;
  /**
   * The request's headers, by lower-case name, as they are sent (every
   * level's, and the auth token's), on the first attempt. Checked, never
   * transformed: a BYO schema's output is not applied to headers.
   * Default: `request`.
   */
  headers?: PartValidation;
  /**
   * Response bodies: one switch for every status (`false` turns them off,
   * BYO schemas included), or one entry per status (a status not listed
   * keeps the earlier levels' setting). Default: built-in schemas on in
   * development, off in production.
   */
  response?: boolean | { readonly [status: number]: PartValidation };
  /**
   * What a failure does, for both directions or each. Default:
   * `{ request: "throw", response: "warn" }` (§5.5).
   */
  onFailure?:
    | FailureMode
    | {
        /** For a request part. Default: `"throw"`. */
        request?: FailureMode;
        /** For a response. Default: `"warn"`. */
        response?: FailureMode;
      };
}

/**
 * One route's runtime schemas (§5.1): any Standard Schema per request part,
 * and the response body's per status (`null`: the status has no body). The
 * generated `zod/mini` module (`bun-client generate --zod`) writes these, and
 * so may a browser-safe module of the server's own schemas.
 */
export interface RouteSchemas {
  /** The path parameters, as a call gives them (before they are encoded). */
  readonly params?: StandardSchemaV1;
  /** The query object, before it is serialised. */
  readonly query?: StandardSchemaV1;
  /** The request headers, by lower-case name. */
  readonly headers?: StandardSchemaV1;
  /** The request body, before it is serialised. */
  readonly body?: StandardSchemaV1;
  /** Response bodies by status, after JSON; `null`: no body. A status not listed is not checked. */
  readonly responses?: { readonly [status: number]: StandardSchemaV1 | null };
}

/**
 * Where the built-in schemas come from (§5.1, §5.2): a module exporting
 * `schemas`, one {@link RouteSchemas} per route key. Usually given as
 * `() => import("./api.zod.gen")`, so the schemas (and zod) load only when a
 * check first needs them.
 */
export interface SchemaSource<R> {
  /** The schemas, keyed like the route map. */
  readonly schemas: { readonly [K in keyof R]?: RouteSchemas };
}

/**
 * Per-route overrides (§6.2): the subset of {@link ClientConfig} that makes
 * sense for one route. `throwOnError` and `undeclaredStatus` are not here:
 * they decide a call's return type, which the client's type argument and
 * the call's own options carry.
 */
export interface RouteConfig {
  /** Headers for this route, merged by name over the client's. Default: none. */
  headers?: HeadersOption;
  /** Milliseconds before the call fails with `TimeoutError`; `false` for none. Default: the client's. */
  timeout?: number | false;
  /** Retries, merged per key over the client's; `false` turns them off. Default: the client's. */
  retry?: RetryConfig | false;
  /** Middleware for this route, inside the client's. Default: none. */
  middleware?: readonly ClientMiddleware[];
  /**
   * Validation for this route, merged per key over the client's (§6.2);
   * `false` turns it all off, BYO schemas included. Default: the client's.
   */
  validate?: ValidationConfig | false;
}

/** Per-call options beside the typed parts (§6.2): the route subset again, plus a signal. */
export interface CallConfig extends RouteConfig {
  /** Aborts this call; the call rejects with the signal's reason. Default: none. */
  signal?: AbortSignal;
  /** As {@link ClientConfig.throwOnError}, for this call. */
  throwOnError?: boolean;
  /** As {@link ClientConfig.undeclaredStatus}, for this call. */
  undeclaredStatus?: UndeclaredStatus;
}

/** Options for `createClient`. Every field is optional: `createClient<Routes>()` works. */
export interface ClientConfig<R = Record<string, RouteEntry>> {
  /** Prefix for every request URL. Default: `""` (same origin). */
  baseUrl?: string;
  /**
   * The fetch to call. Default: `globalThis.fetch`. On a server, pass
   * `(req) => router.fetch(req)` to run requests in process. With a custom
   * fetch, a relative URL outside a browser resolves against
   * `http://localhost`.
   */
  fetch?: (request: Request) => Promise<Response>;
  /** Headers for every request; a function is called per request. Default: none. */
  headers?: HeadersOption;
  /** `fetch`'s credentials mode. Default: `"same-origin"`. */
  credentials?: RequestInit["credentials"];
  /** Milliseconds before a call (retries and their waits included) fails with `TimeoutError`; `false` for none. Default: `30_000`. */
  timeout?: number | false;
  /** Retries; `false` turns them off. Default: see {@link RetryConfig}. */
  retry?: RetryConfig | false;
  /**
   * `true`: a call returns the success data and throws `HttpError` for a
   * declared error status. `false`: a call returns a {@link Result}.
   * Default: `false`. Typed through `createClient`'s second type argument.
   */
  throwOnError?: boolean;
  /**
   * A status the route does not declare: `"throw"` an `UnexpectedStatusError`,
   * or return it as `{ ok: false, status: number, error: unknown }`. Needs the
   * route's statuses in {@link manifest}. Default: `"throw"` (§4.3).
   */
  undeclaredStatus?: UndeclaredStatus;
  /** Middleware, outermost first. Default: none. */
  middleware?: readonly ClientMiddleware[];
  /** Token and refresh. Default: none. */
  auth?: AuthConfig;
  /**
   * Which defaults apply (§5.5): `"development"` turns validation on,
   * `"production"` off. Default: `"production"` when
   * `process.env.NODE_ENV === "production"` (read as a bundler replaces it;
   * where there is no `process`, `"development"`), else `"development"`.
   */
  mode?: "development" | "production";
  /**
   * The built-in runtime schemas (§5.1): the generated module
   * (`bun-client generate --zod`) or a browser-safe module of the server's
   * own, given as a function so they load on first use:
   * `() => import("./api.zod.gen")`. Default: none, so only BYO schemas run.
   */
  schemas?: SchemaSource<R> | (() => Promise<SchemaSource<R>>);
  /**
   * Validation switches, failure modes and BYO schemas for every route;
   * `false` turns it all off. Validation code (bun-contract's guards) is
   * loaded only when a check runs. Default: see {@link ValidationConfig}.
   */
  validate?: ValidationConfig | false;
  /** Where warnings (a response failing validation under `"warn"`) and retry notes go. Default: `console`. */
  logger?: Pick<Console, "warn" | "error" | "debug">;
  /** Per-route overrides, keyed like the map. Default: none. */
  routes?: { [K in keyof R]?: RouteConfig };
  /** The map's runtime facts: operation names and declared statuses. Default: none. */
  manifest?: RouteManifest<R>;
}

/** The client `createClient` returns (§6.1). */
export interface Client<R, F extends ClientFlags = Record<never, never>> {
  /** `GET` a path of the map. */
  get: Verb<R, "GET", F>;
  /** `POST` to a path of the map. */
  post: Verb<R, "POST", F>;
  /** `PUT` to a path of the map. */
  put: Verb<R, "PUT", F>;
  /** `PATCH` a path of the map. */
  patch: Verb<R, "PATCH", F>;
  /** `DELETE` a path of the map. */
  delete: Verb<R, "DELETE", F>;
  /** `HEAD` a path of the map. */
  head: Verb<R, "HEAD", F>;
  /** `OPTIONS` on a path of the map. */
  options: Verb<R, "OPTIONS", F>;
  /** Call a route by its key, `"PATCH /users/:id"`: for a method chosen at run time. */
  request: <
    K extends keyof R & string,
    T extends boolean | undefined = undefined,
    U extends UndeclaredStatus | undefined = undefined,
  >(
    key: K,
    ...args: CallArgs<R[K], T, U>
  ) => Promise<CallReturn<R[K], T, U, F>>;
  /** The URL a call would request, `baseUrl` included; sends nothing. */
  url: <P extends AnyPathOf<R>>(path: P, ...args: UrlArgs<R, P>) => string;
  /** Calls by `operationId`: `api.op.getUser(opts)` is `api.get("/users/:id", opts)`. Needs {@link ClientConfig.manifest}. */
  op: Operations<R, F>;
}
