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
 * - `params`, `query`, `headers`, `body`, `files`: a field left out is
 *   undeclared, and loosely typed at the call; `query: Record<never, never>`
 *   declares "none", and `body: undefined` declares "no body".
 * - `responses`: the body type per status; left out, `{ 200: unknown }`. A
 *   download is `Blob`, a streamed body `AsyncIterable` of its values
 *   (`other-transports.md` §4).
 * - `responseHeaders`: the headers each status declares, by lower-case name.
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
  /**
   * The request body: JSON, or a form's fields (a multipart or urlencoded
   * route, which {@link RouteManifest}'s `bodyType` names). Default:
   * undeclared, so `unknown`.
   */
  body?: unknown;
  /**
   * A multipart body's file fields, by name: `Blob` (a `File` is one) for a
   * field that takes one file, `Blob[]` for one that takes several.
   * Default: undeclared, so any record of them.
   */
  files?: object;
  /** Response bodies by status. Default: `{ 200: unknown }`. */
  responses?: object;
  /**
   * Response headers the route declares, by status, then by lower-case
   * name: what the client checks on arrival (§5.6), each value a string as
   * it arrives. Read them from the result's `response.headers`. Default:
   * undeclared.
   */
  responseHeaders?: object;
  /** The sender view (`RoutesOf`, plan §8.5): `params`, `query`, `headers`, `body`. */
  send?: object;
  /** The receiver view (`RoutesOf`, plan §8.5): response bodies by status. */
  receive?: object;
  /**
   * `"sse"`: the route answers a `text/event-stream` (`sse.md` §3.1). It is
   * read with `sse()` from `@kingsleyweb/bun-client/sse`, and the verbs,
   * `request` and `op` do not offer it. Default: an ordinary route.
   */
  stream?: "sse";
  /**
   * An event stream's events by name, each its `data`'s wire type
   * (`undefined` for an event that carries none), as `x-sse-events` (and
   * bun-common's `sse({ … })`) declares them. Default: undeclared, so any
   * event name with `unknown` data.
   */
  events?: object;
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

/**
 * The keys of `R` an HTTP call takes: every key but an event stream's
 * (`stream: "sse"`), which `sse()` reads (`sse.md` §3.1).
 */
export type HttpKeyOf<R> = {
  [K in keyof R]: R[K] extends { stream: "sse" } ? never : K;
}[keyof R];

/**
 * The paths of `R` whose method is `M`: `"GET /users/:id"` gives
 * `"/users/:id"` for `"GET"`. An event stream's path is not one
 * ({@link HttpKeyOf}).
 */
export type PathsOf<R, M extends string> =
  HttpKeyOf<R> extends infer K
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

/**
 * The `files` option for entry `E` (`other-transports.md` §3): the entry's
 * declared file fields, else any record of files, one or several per field.
 * Given, the body is sent as `multipart/form-data`.
 */
type FilesPart<E> =
  Declares<E, "files"> extends true
    ? KeyedPart<"files", PartOf<E, "files">>
    : { files?: Readonly<Record<string, Blob | readonly Blob[]>> };

/** The typed parts of a call to entry `E`: params, query, body, headers, files. */
export type CallParts<E> = ParamsPart<E> &
  QueryPart<E> &
  BodyPart<E> &
  HeadersPart<E> &
  FilesPart<E>;

/**
 * How a download is delivered (`other-transports.md` §4): a body the client
 * reads as a `Blob` (a media type neither JSON nor text) as a `"blob"`, as
 * the unread `"stream"`, or as an `"arrayBuffer"`.
 */
export type DownloadAs = "blob" | "stream" | "arrayBuffer";

/**
 * A call's options for entry `E`: its typed parts plus {@link CallConfig}.
 * `T` and `U` carry the call's `throwOnError` and `undeclaredStatus`, so the
 * return type follows them; `V` its `validate.response`, so a BYO response
 * schema's output types the status it is set for (§5.4).
 */
export type CallOptions<
  E,
  T extends boolean | undefined = undefined,
  U extends UndeclaredStatus | undefined = undefined,
  A extends DownloadAs | undefined = undefined,
  V extends ValidationConfig["response"] = undefined,
> = Omit<
  CallConfig,
  "headers" | "throwOnError" | "undeclaredStatus" | "as" | "validate"
> &
  CallParts<E> & {
    /** This call's `throwOnError` (§4.4). Default: the client's. */
    throwOnError?: T;
    /** This call's `undeclaredStatus` (§4.3). Default: the client's. */
    undeclaredStatus?: U;
    /** How a download is delivered ({@link CallConfig.as}). Default: `"blob"`. */
    as?: A;
    /**
     * Validation for this call, merged per key over the route's and the
     * client's (§6.2); `false` turns it all off, BYO schemas included. A BYO
     * schema set here for a response status (`response: { 200: { custom } }`)
     * types that status's `data` (or `error`) as the schema's output, which
     * is what the client delivers when the check passes (§5.4); a failed
     * check under `"warn"` or a hook that returns delivers the body as it
     * arrived, so a route whose BYO schema transforms is safest with
     * `onFailure: { response: "throw" }`. Only `response` is captured (`V`),
     * so a hook in `onFailure` keeps its contextual type. Default: the
     * route's.
     */
    validate?: false | (ValidationConfig & { response?: V });
  };

/** A call's arguments: the options are required when a typed part is. */
export type CallArgs<
  E,
  T extends boolean | undefined = undefined,
  U extends UndeclaredStatus | undefined = undefined,
  A extends DownloadAs | undefined = undefined,
  V extends ValidationConfig["response"] = undefined,
> = [RequiredKeys<CallParts<E>>] extends [never]
  ? [options?: CallOptions<E, T, U, A, V>]
  : [options: CallOptions<E, T, U, A, V>];

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

/** A download as {@link DownloadAs} `A` delivers it. */
type Download<A> = [A] extends ["stream"]
  ? ReadableStream<Uint8Array>
  : [A] extends ["arrayBuffer"]
    ? ArrayBuffer
    : Blob;

/** A streamed body's values: JSON values after JSON, raw bytes as they are. */
type Streamed<T> =
  T extends AsyncIterable<infer I>
    ? AsyncIterable<I extends Uint8Array ? I : Jsonify<I>>
    : never;

/**
 * A response body as the client returns it: after JSON, except a `Blob`,
 * which is how the client returns a body that is neither JSON nor text
 * (`readBody`), delivered as the call's `as` asks, and a streamed body
 * (`AsyncIterable`, an NDJSON route's lines or a raw one's chunks), which
 * the client iterates (`other-transports.md` §4).
 */
type WireBody<T, A = undefined> =
  | Jsonify<Exclude<T, Blob | AsyncIterable<unknown>>>
  | ([Extract<T, Blob>] extends [never] ? never : Download<A>)
  | Streamed<Extract<T, AsyncIterable<unknown>>>;

/**
 * The BYO schema a call's `validate.response` (`V`) sets for status `S`,
 * wrapped as `{ schema }`; `never` when it sets none, or turns it off
 * (`response: false`, or `false` for the status; `validate: false` leaves
 * `V` unset). The call is the last level (§6.2), so what it sets is what runs.
 */
type CustomAt<V, S> = [V] extends [object]
  ? (
      S extends keyof V
        ? V[S]
        : `${S & number}` extends keyof V
          ? V[`${S & number}`]
          : never
    ) extends infer P
    ? [P] extends [never]
      ? never
      : [P] extends [{ custom: infer C extends StandardSchemaV1 }]
        ? { schema: C }
        : never
    : never
  : never;

/**
 * A body as a BYO schema with output `O` delivers it (§5.4): its output in
 * place of the wire body, a streamed body's values one by one, and a
 * download read as `"stream"` left as it is (an unread body is never
 * checked).
 */
type CustomBody<T, O, A> =
  | ([Exclude<T, Blob | AsyncIterable<unknown>>] extends [never] ? never : O)
  | ([Extract<T, Blob>] extends [never]
      ? never
      : [A] extends ["stream"]
        ? ReadableStream<Uint8Array>
        : O)
  | ([Extract<T, AsyncIterable<unknown>>] extends [never]
      ? never
      : AsyncIterable<O>);

/** The declared body of status `S`, before the client reads it. */
type RawAt<E, S> = S extends keyof ResponsesOf<E> ? ResponsesOf<E>[S] : never;

/**
 * The body of status `S`, as the client returns it under the call's `as`
 * (`A`): the wire body after JSON, or, where the call's `validate.response`
 * (`V`) sets a BYO schema for the status, that schema's output. Distributes over
 * a union of statuses.
 */
type BodyAt<E, S, A = undefined, V = undefined> = S extends unknown
  ? [CustomAt<V, S>] extends [never]
    ? WireBody<RawAt<E, S>, A>
    : CustomAt<V, S> extends { schema: infer C extends StandardSchemaV1 }
      ? CustomBody<RawAt<E, S>, StandardSchemaV1.InferOutput<C>, A>
      : never
  : never;

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
 * @typeParam A The call's `as`: how a download is delivered.
 * @typeParam V The call's `validate.response`: a BYO schema set there for a
 *   status types its body as the schema's output (§5.4).
 */
export type Result<
  E,
  U extends UndeclaredStatus = "throw",
  A extends DownloadAs | undefined = undefined,
  V extends ValidationConfig["response"] = undefined,
> =
  | {
      [S in SuccessStatus<E>]: {
        /** A declared 2xx status. */
        ok: true;
        /** The status. */
        status: S;
        /** The parsed body (a download as `as` asks; a stream to iterate). */
        data: BodyAt<E, S, A, V>;
        /** Absent on success. */
        error?: undefined;
        /**
         * The file name the response's `Content-Disposition` gave
         * (`filename*` first, then `filename`), for a download; absent when
         * it named none.
         */
        filename?: string;
        /** The response, its body already read (a stream's still open). */
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
        error: BodyAt<E, S, A, V>;
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

/**
 * What `throwOnError: true` returns: the success body (a union over the 2xx
 * statuses), a download as `A` asks, a BYO schema's output where the call's
 * `validate.response` (`V`) sets one.
 */
export type SuccessData<
  E,
  A extends DownloadAs | undefined = undefined,
  V extends ValidationConfig["response"] = undefined,
> = BodyAt<E, SuccessStatus<E>, A, V>;

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

/** What a call to entry `E` resolves to, given the call's `T`/`U`/`A`/`V` and the client's flags `F`. */
export type CallReturn<E, T, U, F, A = undefined, V = undefined> = (
  [T] extends [boolean] ? T : GlobalThrow<F>
) extends infer Throw
  ? Throw extends true
    ? SuccessData<
        E,
        A & (DownloadAs | undefined),
        V & ValidationConfig["response"]
      >
    : Result<
        E,
        [U] extends [UndeclaredStatus]
          ? U
          : GlobalUndeclared<F> & UndeclaredStatus,
        A & (DownloadAs | undefined),
        V & ValidationConfig["response"]
      >
  : never;

/** A call to entry `E`. */
export type Call<E, F> = <
  T extends boolean | undefined = undefined,
  U extends UndeclaredStatus | undefined = undefined,
  A extends DownloadAs | undefined = undefined,
  V extends ValidationConfig["response"] = undefined,
>(
  ...args: CallArgs<E, T, U, A, V>
) => Promise<CallReturn<E, T, U, F, A, V>>;

/** A verb method: the path as a literal of the map's paths for that method. */
export type Verb<R, M extends string, F> = <
  P extends PathsOf<R, M>,
  T extends boolean | undefined = undefined,
  U extends UndeclaredStatus | undefined = undefined,
  A extends DownloadAs | undefined = undefined,
  V extends ValidationConfig["response"] = undefined,
>(
  path: P,
  ...args: CallArgs<EntryAt<R, `${M} ${P}`>, T, U, A, V>
) => Promise<CallReturn<EntryAt<R, `${M} ${P}`>, T, U, F, A, V>>;

/** An entry's `operationId` as a literal; `never` when it has none. */
type OperationIdOf<E> = E extends { operationId: infer O extends string }
  ? O
  : never;

/** `api.op`: one call per `operationId` in the map (other-transports.md §2), event streams left out. */
export type Operations<R, F> = {
  [K in HttpKeyOf<R> as OperationIdOf<R[K]>]: Call<R[K], F>;
};

/**
 * The options one entry gives {@link Client.url}, distributed over the
 * entries at a path: a path several methods share takes the union of their
 * options, so each method's `query` is accepted (a bare intersection of the
 * entries' parts reduced two different queries to `never`).
 */
type UrlOptionsOf<E> = E extends unknown ? ParamsPart<E> & QueryPart<E> : never;

/**
 * The options of {@link Client.url}: the params and query of the path's
 * entries. Optional when some entry at the path needs none (a URL is built
 * without a method, so the call cannot tell which entry it means).
 */
export type UrlArgs<R, P extends string> =
  Record<never, never> extends UrlOptionsOf<EntriesAtPath<R, P>>
    ? [options?: UrlOptionsOf<EntriesAtPath<R, P>>]
    : [options: UrlOptionsOf<EntriesAtPath<R, P>>];

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
    /**
     * The route's cache tags (`x-bun-cache`, bun-common's
     * `.describe({ cache })`), read by the query layer (`./query`, §6.4):
     * `tags` its queries are filed under, `invalidates` what a successful
     * call invalidates. A template names the route's path params in braces
     * (`"user:{id}"`). The core client ignores it. Default: none.
     */
    readonly cache?: {
      /** Tags the route's response carries (templates). Default: none. */
      readonly tags?: readonly string[];
      /** Tags a successful call invalidates (templates). Default: none. */
      readonly invalidates?: readonly string[];
    };
    /**
     * How a plain-object `body` is sent (`other-transports.md` §3):
     * `"json"`; `"multipart"`, a `multipart/form-data` `FormData` of its
     * fields (and the call's `files`); `"urlencoded"`, an
     * `application/x-www-form-urlencoded` form. A call with `files` is sent
     * as multipart whatever this says; a `FormData`, `URLSearchParams`,
     * `Blob` or stream body passes through as it is. Default: `"json"`.
     */
    readonly bodyType?: "json" | "multipart" | "urlencoded";
    /**
     * The statuses whose body streams (`other-transports.md` §4), by how
     * it is cut, as bun-common's `chunks()` says: `"ndjson"`, one JSON value
     * per line, each checked as the status's response schema; `"raw"`, the
     * bytes as they arrive (`Uint8Array`s). The call's `data` is then an
     * `AsyncIterable` of them, read as it is iterated. Default: none; a
     * response served as NDJSON (`application/x-ndjson`, `application/jsonl`,
     * …) is iterated by its lines all the same.
     */
    readonly chunks?: {
      readonly [S in StatusOf<R[K]>]?: "ndjson" | "raw";
    };
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
      /**
       * Run `custom` instead of the built-in schema. For a response status,
       * the built-in body schema; its declared headers are still checked.
       * Default: `false`.
       */
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
   * A multipart body's files (the call's `files`, each a `File`), checked
   * before the `FormData` is built. Default: `request`.
   */
  files?: PartValidation;
  /**
   * Responses, each status's body and the headers it declares (§5.6): one
   * switch for every status (`false` turns them off, BYO schemas included),
   * or one entry per status (a status not listed keeps the earlier levels'
   * setting). A BYO schema checks the body. Default: built-in schemas on in
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
  /**
   * What happens to the keys a BYO schema dropped (a `custom` schema of the
   * query, the body or a response body): keys the value had that the
   * schema's output, which is what is sent or delivered, no longer has, as
   * zod's `z.object()` strips undeclared keys without a word. `"strip"` (the
   * default): silently, as before. `"warn"`: the logger warns, naming the
   * part and the dropped paths, and the output still goes. `"reject"`: an
   * issue per dropped key (`Unrecognized key`, at its path), under
   * {@link onFailure} like any other. The built-in schemas never drop a key
   * (the generated ones are loose). Bun-common's `validate({ unknownKeys })`
   * is the server's side of it.
   */
  unknownKeys?: "strip" | "warn" | "reject";
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
  /** The request body (JSON, or a form's fields), before it is serialised. */
  readonly body?: StandardSchemaV1;
  /**
   * A multipart body's files, as an object by field name, each a `File`
   * (a call's `Blob` is checked as a `File` named `"blob"`) or a list of
   * them: presence, count, size and media type (the generated module uses
   * zod's `z.file()`).
   */
  readonly files?: StandardSchemaV1;
  /**
   * Response bodies by status, after JSON; `null`: no body. For a streamed
   * NDJSON status, the schema of one line (a bun-common `chunks()`
   * declaration is read as its chunk schema). A status not listed is not
   * checked.
   */
  readonly responses?: { readonly [status: number]: StandardSchemaV1 | null };
  /**
   * Response headers by status (§5.6): an object of the headers as they
   * arrived, by lower-case name, each a string (a repeated header joined
   * with `", "`, as `Headers.get` reads it). Checked under the status's
   * response switch and failure mode, like its body; a BYO schema
   * (`custom`) checks the body only. A status not listed has its headers
   * unchecked. In a browser, a cross-origin response exposes only the
   * headers its `Access-Control-Expose-Headers` names (and never
   * `Set-Cookie`), so a required header it hides reads as missing.
   */
  readonly responseHeaders?: { readonly [status: number]: StandardSchemaV1 };
  /**
   * An event stream's events by name (`sse.md` §3.3): the schema of each
   * event's `data` after it is decoded, `null` for an event that carries
   * none. An event whose name is not listed is a validation issue (the
   * server's rule). A bun-common `sse({ … })` declaration as the stream
   * status's response stands for this (its `events` and its `data`
   * decoding). Default: none, so events are not checked.
   */
  readonly events?: { readonly [name: string]: StandardSchemaV1 | null };
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
  /**
   * How a download is delivered (`other-transports.md` §4): a response
   * whose media type is neither JSON nor text arrives as a `Blob`
   * (`"blob"`), the unread body (`"stream"`, which nothing checks), or an
   * `ArrayBuffer` (`"arrayBuffer"`). A JSON or text body (an error's
   * problem+json) is read as it always is. Default: `"blob"`.
   */
  as?: DownloadAs;
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
    K extends HttpKeyOf<R> & string,
    T extends boolean | undefined = undefined,
    U extends UndeclaredStatus | undefined = undefined,
    A extends DownloadAs | undefined = undefined,
    V extends ValidationConfig["response"] = undefined,
  >(
    key: K,
    ...args: CallArgs<R[K], T, U, A, V>
  ) => Promise<CallReturn<R[K], T, U, F, A, V>>;
  /** The URL a call would request, `baseUrl` included; sends nothing. */
  url: <P extends AnyPathOf<R>>(path: P, ...args: UrlArgs<R, P>) => string;
  /** Calls by `operationId`: `api.op.getUser(opts)` is `api.get("/users/:id", opts)`. Needs {@link ClientConfig.manifest}. */
  op: Operations<R, F>;
}
