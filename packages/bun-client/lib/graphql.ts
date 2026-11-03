/**
 * `@kingsleyweb/bun-client/graphql`: a typed GraphQL call over the client's
 * own request path (typed-client plan, `graphql.md` §3.1 (a2), PR-G1).
 *
 * ```ts
 * import { graphql } from "./graphql";                 // the app's gql.tada setup
 * import { print } from "@0no-co/graphql.web";
 * const UserQuery = graphql(`query User($id: ID!) { user(id: $id) { id name } }`);
 *
 * const gh = createGraphQLClient({ client: api, url: "/graphql", print });
 * const r = await gh.query(UserQuery, { id: "1" });
 * if (r.ok && !r.errors) r.data.user;                   // typed by the document
 * ```
 *
 * - **Types** come from the document, whichever tool made it: a
 *   `TypedDocumentNode` (gql.tada's `graphql()`, graphql-codegen's client
 *   preset) or a typed string (codegen's `TypedDocumentString`, or a string
 *   cast to {@link TypedString}), read through the `__apiType` phantom both
 *   tools emit. Nothing of `graphql` or `@graphql-typed-document-node/core`
 *   is imported; a plain string is untyped.
 * - **The document's text**: a string as it is; a parsed document's
 *   `loc.source.body` when it carries one (graphql-js's `parse`,
 *   `@0no-co/graphql.web`'s, a gql.tada fragment), else the app's own
 *   `print` (gql.tada 1.11.4's operation documents carry no `loc`, measured;
 *   nor do the ASTs graphql-codegen's client preset writes).
 * - **Transport**: GraphQL over HTTP, a `POST` of `{ query, variables,
 *   operationName }` asking for `application/graphql-response+json`; a
 *   query may go as a `GET` (`method: "GET"`), for a CDN to cache. Each
 *   call is the client's own call (`api.request`), so its base URL,
 *   headers, auth and refresh, middleware and timeout apply. A query is
 *   retried as an idempotent request, under the client's retry settings; a
 *   mutation never is.
 * - **Results**: a 2xx GraphQL response is `{ ok: true, data, errors? }`
 *   (partial data with errors is a legitimate GraphQL answer), with
 *   `throwOnGraphQLErrors` turning one with errors into a
 *   {@link GraphQLResponseError}; any other status is the client's failed
 *   result, `{ ok: false, status, error }`, or its `HttpError` under
 *   `throwOnError` (the client's, or the call's).
 * - **Validation**: the server checks against its schema, so the client
 *   checks nothing by default; a Standard Schema for a document's `data`
 *   (`validate: { result }`) runs through the client's own checks, its
 *   failure handled as any response's (`onFailure`, warn by default).
 *
 * Browser-safe; it imports nothing of the `.` entry's client (it reaches the
 * client's configuration through the client object), so an HTTP-only bundle
 * carries none of it, and this entry none of the HTTP pipeline.
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-contract";
import type {
  Client,
  ClientConfig,
  ClientFlags,
  ClientMiddleware,
  FailureMode,
  HeadersOption,
  RetryConfig,
} from "./types";
import { ClientError, GraphQLResponseError, HttpError } from "./errors";

/* ------------------------------------------------------------------ */
/* Documents                                                            */
/* ------------------------------------------------------------------ */

/**
 * The phantom a typed document carries (graphql-codegen's
 * `DocumentTypeDecoration`, gql.tada's `DocumentDecoration`): a function
 * from the variables to the result, never set at run time.
 */
interface DocumentDecoration<R, V> {
  /** Types only: the operation's variables to its result. */
  readonly __apiType?: (variables: V) => R;
}

/**
 * A parsed GraphQL document as this client reads it: the shape graphql-js,
 * `@0no-co/graphql.web` and gql.tada share, structurally (nothing of them
 * is imported).
 */
interface DocumentNodeLike {
  /** `"Document"`. */
  readonly kind: string;
  /** The document's definitions: its operation, and any fragments. */
  readonly definitions: readonly {
    /** `"OperationDefinition"`, `"FragmentDefinition"`, … */
    readonly kind: string;
    /** An operation's type: `"query"`, `"mutation"` or `"subscription"`. */
    readonly operation?: string;
    /** The definition's name, when it has one. */
    readonly name?: {
      /** The name. */
      readonly value: string;
    };
  }[];
  /** Where it was parsed from, when the parser kept it. */
  readonly loc?: {
    /** The source text. */
    readonly source: {
      /** The whole document, as written. */
      readonly body: string;
    };
  };
}

/**
 * A parsed document typed by its result `R` and variables `V`: what
 * gql.tada's `graphql()` and graphql-codegen's client preset return
 * (`@graphql-typed-document-node/core`'s shape, structurally).
 */
export type TypedDocumentNode<
  R = unknown,
  V = Readonly<Record<string, unknown>>,
> = DocumentNodeLike & DocumentDecoration<R, V>;

/**
 * A document's text typed by its result `R` and variables `V`, for an app
 * without a GraphQL tool: `"query { me { id } }" as TypedString<{ me: { id:
 * string } }, Record<never, never>>`. graphql-codegen's
 * `TypedDocumentString` (a `String` object) is taken too.
 */
export type TypedString<
  R = unknown,
  V = Readonly<Record<string, unknown>>,
> = string & DocumentDecoration<R, V>;

/** Any document a call takes: a parsed document, a string, or a `String` object (codegen's `TypedDocumentString`), typed or not. */
// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types -- codegen's TypedDocumentString extends String
export type GraphQLDocument = DocumentNodeLike | string | String;

/** A document's result type (as gql.tada's and `@graphql-typed-document-node/core`'s); `unknown` for an untyped one. */
export type ResultOf<D> = D extends {
  readonly __apiType?: (variables: never) => infer R;
}
  ? R
  : unknown;

/** A document's variables type (as gql.tada's and `@graphql-typed-document-node/core`'s); any variables for an untyped one. */
export type VariablesOf<D> = D extends {
  readonly __apiType?: (variables: infer V) => unknown;
}
  ? unknown extends V
    ? Readonly<Record<string, unknown>>
    : V
  : Readonly<Record<string, unknown>>;

/** The keys of `T` whose property is required. */
type RequiredKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T];

/** A call's arguments: the variables are required when the operation has a required one. */
type CallArgs<V, O> = [RequiredKeys<V>] extends [never]
  ? [variables?: V, options?: O]
  : [variables: V, options?: O];

/* ------------------------------------------------------------------ */
/* Results                                                              */
/* ------------------------------------------------------------------ */

/** One entry of a response's `errors` (the GraphQL spec's error format). */
export interface GraphQLError {
  /** What went wrong. */
  readonly message: string;
  /** Where in the document, when the server says. */
  readonly locations?: readonly {
    /** The line, from 1. */
    readonly line: number;
    /** The column, from 1. */
    readonly column: number;
  }[];
  /** The response field the error is for (`["user", "friends", 0]`), for a field error. */
  readonly path?: readonly (string | number)[];
  /** The server's own fields (`code`, …). */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/** A 2xx GraphQL response: complete, or (without `throwOnGraphQLErrors`) partial, with errors. */
type Answered<R, G> =
  | {
      /** A 2xx status with a GraphQL response. */
      ok: true;
      /** The status. */
      status: number;
      /** The operation's result. */
      data: R;
      /** Absent: the operation ran without an error. */
      errors?: undefined;
      /** The response's `extensions`, when it has them. */
      extensions?: Readonly<Record<string, unknown>>;
      /** The response, its body read. */
      response: Response;
    }
  | (G extends true
      ? never
      : {
          /** A 2xx status with a GraphQL response. */
          ok: true;
          /** The status. */
          status: number;
          /**
           * What the operation produced despite the errors: partial data,
           * `null` when an error stopped it, absent when the request itself
           * failed (a legacy `application/json` server answers that 200).
           */
          data?: R | null;
          /** What went wrong: at least one error. */
          errors: readonly GraphQLError[];
          /** The response's `extensions`, when it has them. */
          extensions?: Readonly<Record<string, unknown>>;
          /** The response, its body read. */
          response: Response;
        });

/** A status outside 2xx (a request error under GraphQL over HTTP, a proxy's, the server's). */
interface Failed {
  /** Not a 2xx status. */
  ok: false;
  /** The status. */
  status: number;
  /** Absent on failure. */
  data?: undefined;
  /** The body: a GraphQL response's JSON, another JSON body, or text. */
  error: unknown;
  /** The body's `errors`, when it is a GraphQL response with any. */
  errors?: readonly GraphQLError[];
  /** The response, its body read. */
  response: Response;
}

/**
 * What a call resolves to (`graphql.md` §3.1): a 2xx GraphQL response, its
 * `data` typed by the document (complete when `errors` is absent), or a
 * failed status.
 *
 * @typeParam R The document's result.
 * @typeParam G `true` under `throwOnGraphQLErrors`: no result has errors.
 * @typeParam H `true` under `throwOnError`: a failed status throws `HttpError`.
 */
export type GraphQLResult<R = unknown, G = false, H = false> =
  Answered<R, G> | (H extends true ? never : Failed);

/* ------------------------------------------------------------------ */
/* Options and the client                                               */
/* ------------------------------------------------------------------ */

/** Validation for one call (TC §5.6: GraphQL's is a BYO result schema only). */
interface ResultValidation<S> {
  /**
   * A Standard Schema for the response's `data`, run on a 2xx response
   * that has data (an issue's path starts at `data`); what it returns is
   * delivered as `data`, typed by its output. Default: none.
   */
  result?: S;
  /** What a failure does, as a response's (TC §5.5). Default: the client's, `"warn"`. */
  onFailure?: FailureMode;
}

/** The options of one call, beside the variables. */
export interface GraphQLCallOptions<
  G = undefined,
  H = undefined,
  S = undefined,
> {
  /** Aborts the call; it rejects with the signal's reason. Default: none. */
  signal?: AbortSignal;
  /** Milliseconds before the call fails with `TimeoutError`; `false` for none. Default: the client's. */
  timeout?: number | false;
  /** Headers for this call, over the client's and the route's. Default: none. */
  headers?: HeadersOption;
  /** Middleware for this call, inside the client's and the route's. Default: none. */
  middleware?: readonly ClientMiddleware[];
  /**
   * A query's retries, merged over the client's and the route's (the
   * method is always retried, as the query is idempotent); `false` turns
   * them off. A mutation is never retried. Default: theirs.
   */
  retry?: RetryConfig | false;
  /** A query's method: `"GET"` sends it in the URL, for a CDN to cache. Ignored by `mutate`. Default: the client's, `"POST"`. */
  method?: "GET" | "POST";
  /** A 2xx response with `errors` throws {@link GraphQLResponseError}. Default: the GraphQL client's. */
  throwOnGraphQLErrors?: G;
  /** A failed status throws the client's `HttpError`. Default: the HTTP client's `throwOnError`. */
  throwOnError?: H;
  /** A BYO schema for the result. Default: none. */
  validate?: ResultValidation<S>;
}

/** The later of a call's flag and the client's. */
type Later<C, D> = [C] extends [boolean] ? C : D;

/** A call's data: the BYO result schema's output, else the document's result. */
type DataOf<D, S> = [S] extends [StandardSchemaV1]
  ? StandardSchemaV1.InferOutput<S>
  : ResultOf<D>;

/** `query` or `mutate`. */
type Operation<G, H> = <
  D extends GraphQLDocument,
  CG extends boolean | undefined = undefined,
  CH extends boolean | undefined = undefined,
  S extends StandardSchemaV1 | undefined = undefined,
>(
  document: D,
  ...args: CallArgs<VariablesOf<D>, GraphQLCallOptions<CG, CH, S>>
) => Promise<GraphQLResult<DataOf<D, S>, Later<CG, G>, Later<CH, H>>>;

/**
 * The client {@link createGraphQLClient} returns.
 *
 * @typeParam G Its `throwOnGraphQLErrors`.
 * @typeParam H The HTTP client's `throwOnError`.
 */
export interface GraphQLClient<G = false, H = false> {
  /** Runs a query document (a mutation document throws a `ClientError`). */
  query: Operation<G, H>;
  /** Runs a mutation document, never retried (a query document throws a `ClientError`). */
  mutate: Operation<G, H>;
}

/** The options of {@link createGraphQLClient}. */
export interface GraphQLClientOptions<
  R = unknown,
  F extends ClientFlags = Record<never, never>,
  G = false,
> {
  /** The HTTP client (`createClient`) every call goes through: its base URL, headers, auth, middleware, retries, timeout and logger apply. */
  client: Client<R, F>;
  /**
   * The endpoint: a path under the client's `baseUrl`, as any route's
   * (`"/graphql"`), or an absolute URL for a client with no `baseUrl` (or
   * one under it). Calls run as route `"POST <url>"` (`"GET <url>"`), so
   * the client's `routes` configure them under that key.
   */
  url: string;
  /**
   * Prints a parsed document that carries no source (`loc`): the app's own
   * GraphQL printer, `print` from `@0no-co/graphql.web` (gql.tada's
   * parser) or `graphql`. It is called with the document a call was
   * given; its parameter is typed `never` so a printer typed by its own
   * library's node type (`ASTNode`) is accepted. Default: none, so such a
   * document throws.
   */
  print?: (document: never) => string;
  /** A query's method. Default: `"POST"`. */
  method?: "GET" | "POST";
  /** A 2xx response with `errors` throws {@link GraphQLResponseError}. Default: `false`. */
  throwOnGraphQLErrors?: G;
}

/** What the query layer (`./query`'s `q.graphql`) reads of a GraphQL client, under {@link INTERNALS}. */
interface GraphQLInternals {
  /** The endpoint, as given. */
  readonly url: string;
  /** A document's operation: its text, type and name (throws as a call would). */
  readonly describe: (document: GraphQLDocument) => OperationInfo;
}

/** One document's operation, as a call sends it. */
interface OperationInfo {
  /** The document's text. */
  readonly source: string;
  /** `"query"`, `"mutation"` or `"subscription"`. */
  readonly type: string;
  /** The operation's name; `undefined` for an anonymous one. */
  readonly name: string | undefined;
}

/* ------------------------------------------------------------------ */
/* Implementation                                                       */
/* ------------------------------------------------------------------ */

/** The symbol the client keeps its configuration under (`client.ts`). */
const CONFIG = Symbol.for("@kingsleyweb/bun-client");

/** The symbol a GraphQL client keeps {@link GraphQLInternals} under, for `./query`. */
const INTERNALS = Symbol.for("@kingsleyweb/bun-client/graphql");

/** What a call asks for (GraphQL over HTTP §Accept). */
const ACCEPT = "application/graphql-response+json, application/json;q=0.9";

/** A name, after whitespace, commas and comments (the lexer's ignored tokens). */
const NAME_AFTER = /(?:[\s,]|#[^\n\r]*)*([_A-Z]\w*)?/iy;

/** A name at a position. */
const WORD = /[_A-Z]\w*/iy;

/** Skips the string at `at` (a block string or a plain one): the index after it. */
function skipString(source: string, at: number): number {
  if (source.startsWith('"""', at)) {
    let from = at + 3;
    for (;;) {
      const end = source.indexOf('"""', from);
      if (end < 0) return source.length;
      if (source[end - 1] !== "\\") return end + 3;
      from = end + 3;
    }
  }
  let end = at + 1;
  while (end < source.length && source[end] !== '"') {
    if (source[end] === "\\") end++;
    end++;
  }
  return end + 1;
}

/**
 * The first operation of a document's text: its type and name, found at
 * the top level (fragments, comments and strings skipped). A selection set
 * with no keyword is the query shorthand.
 */
function scanOperation(source: string): {
  type: string;
  name: string | undefined;
} {
  let depth = 0;
  // Inside a fragment definition: its header, then (`body`) its selection.
  let fragment = false;
  let body = false;
  for (let at = 0; at < source.length;) {
    const char = source[at];
    if (char === "#") {
      const end = source.slice(at).search(/[\n\r]/);
      at = end < 0 ? source.length : at + end;
    } else if (char === '"') at = skipString(source, at);
    else if (char === "{" || char === "(" || char === "[") {
      if (depth === 0 && char === "{") {
        if (!fragment) return { type: "query", name: undefined };
        body = true;
      }
      depth++;
      at++;
    } else if (char === "}" || char === ")" || char === "]") {
      depth--;
      at++;
      if (depth === 0 && body) fragment = body = false;
    } else if (depth === 0 && /[_a-z]/i.test(char)) {
      WORD.lastIndex = at;
      const word = WORD.exec(source)![0];
      at += word.length;
      if (fragment) continue;
      if (word === "fragment") fragment = true;
      else if (/^(?:query|mutation|subscription)$/.test(word)) {
        NAME_AFTER.lastIndex = at;
        return { type: word, name: NAME_AFTER.exec(source)?.[1] };
      }
    } else at++;
  }
  return { type: "query", name: undefined };
}

/** Operations of string documents, by text: few and fixed, as a route map's paths are. */
const byText = new Map<string, OperationInfo>();

/** Operations of parsed documents and `String` objects. */
const byObject = new WeakMap<object, OperationInfo>();

/** The endpoint's path escaped for the client's path tokenizer (`:name`, `*name`, `{…}` and `\` are syntax there). */
function escapePath(path: string): string {
  return path.replace(/[\\{}]|[:*](?=[$_\p{ID_Start}"])/gu, "\\$&");
}

/** Whether a body is a GraphQL response: an object with `data` or `errors`. */
function isResponse(body: unknown): body is {
  data?: unknown;
  errors?: unknown;
  extensions?: Readonly<Record<string, unknown>>;
} {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    ("data" in body || "errors" in body)
  );
}

/** A response's errors: a non-empty array, else `undefined`. */
function errorsOf(body: unknown): readonly GraphQLError[] | undefined {
  const errors = isResponse(body) ? body.errors : undefined;
  return Array.isArray(errors) && errors.length > 0
    ? (errors as GraphQLError[])
    : undefined;
}

/**
 * A Standard Schema for a GraphQL response that runs `schema` on its
 * `data` (a response without data passes as it is), its issues' paths
 * under `data`, its output delivered as `data`.
 */
function onData(schema: StandardSchemaV1): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: schema["~standard"].vendor,
      validate: (body) => {
        const response = body as { data?: unknown } | null | undefined;
        if (response?.data == null) return { value: body };
        const settle = (
          result: StandardSchemaV1.Result<unknown>,
        ): StandardSchemaV1.Result<unknown> =>
          result.issues
            ? {
                issues: result.issues.map((issue) => ({
                  ...issue,
                  path: ["data", ...(issue.path ?? [])],
                })),
              }
            : { value: { ...response, data: result.value } };
        const result = schema["~standard"].validate(response.data);
        return result instanceof Promise ? result.then(settle) : settle(result);
      },
    },
  };
}

/** A call's options as the implementation reads them. */
type RuntimeCall = GraphQLCallOptions<
  boolean | undefined,
  boolean | undefined,
  StandardSchemaV1 | undefined
>;

/** The client's call, untyped, as this entry makes it. */
type RuntimeRequest = (
  key: string,
  options: object,
) => Promise<{
  ok: boolean;
  status: number;
  data?: unknown;
  error?: unknown;
  response: Response;
}>;

/**
 * Creates a GraphQL client over an HTTP client (`graphql.md` §3.1).
 *
 * ```ts
 * const gh = createGraphQLClient({ client: api, url: "/graphql", print });
 * const r = await gh.query(UserQuery, { id: "1" });
 * const m = await gh.mutate(RenameUser, { id: "1", name: "Ada" });
 * ```
 *
 * @param options See {@link GraphQLClientOptions}.
 * @throws ClientError when `url` is absolute and outside the client's `baseUrl`.
 */
export function createGraphQLClient<
  R,
  F extends ClientFlags,
  G extends boolean = false,
>(
  options: GraphQLClientOptions<R, F, G>,
): GraphQLClient<G, F extends { throwOnError: true } ? true : false>;
export function createGraphQLClient(
  options: GraphQLClientOptions<unknown, ClientFlags, boolean>,
): object {
  const api = options.client as unknown as {
    request: RuntimeRequest;
    [CONFIG]?: ClientConfig;
  };
  const config: ClientConfig = api[CONFIG] ?? {};
  const base = config.baseUrl ?? "";
  let target = options.url;
  if (base && /^[a-z][a-z\d+.-]*:/i.test(target)) {
    if (!target.startsWith(base))
      throw new ClientError(
        `createGraphQLClient: "${target}" is outside the client's baseUrl "${base}"; give a path under it, or a client without a baseUrl`,
      );
    target = target.slice(base.length);
  }
  // The URL's own query goes into every call's query object.
  const mark = target.indexOf("?");
  const path = escapePath(mark < 0 ? target : target.slice(0, mark));
  const own: Record<string, string | string[]> = {};
  if (mark >= 0)
    new URLSearchParams(target.slice(mark + 1)).forEach((value, name) => {
      const had = own[name];
      own[name] = had === undefined ? value : [had, value].flat();
    });
  const accept: ClientMiddleware = (ctx, next) => {
    if (!ctx.request.headers.has("accept"))
      ctx.request.headers.set("accept", ACCEPT);
    return next();
  };

  const describe = (document: GraphQLDocument): OperationInfo => {
    const text = typeof document === "string";
    const known = text ? byText.get(document) : byObject.get(document);
    if (known) return known;
    let info: OperationInfo;
    if (text || !("definitions" in document)) {
      const source = String(document);
      info = { source, ...scanOperation(source) };
    } else {
      const operation = document.definitions.find(
        (definition) => definition.kind === "OperationDefinition",
      );
      const source =
        document.loc?.source.body ??
        (options.print as ((document: object) => string) | undefined)?.(
          document,
        );
      if (source === undefined)
        throw new ClientError(
          `${options.url}: the document carries no source (loc); pass createGraphQLClient a print (gql.tada's and graphql-codegen's documents need one)`,
        );
      info = {
        source,
        type: operation?.operation ?? "query",
        name: operation?.name?.value,
      };
    }
    if (text) byText.set(document, info);
    else byObject.set(document, info);
    return info;
  };

  const run = async (
    kind: "query" | "mutation",
    document: GraphQLDocument,
    variables?: unknown,
    call: RuntimeCall = {},
  ): Promise<unknown> => {
    const operation = describe(document);
    const method =
      kind === "mutation" ? "POST" : (call.method ?? options.method ?? "POST");
    const key = `${method} ${path}`;
    if (operation.type !== kind)
      throw new ClientError(
        `${key}: ${kind === "query" ? "query" : "mutate"}() was given a ${operation.type}${operation.name ? ` (${operation.name})` : ""}`,
        { key },
      );
    const levels = [config.retry, config.routes?.[key]?.retry, call.retry];
    const off =
      kind === "mutation" ||
      levels.filter((level) => level !== undefined).at(-1) === false;
    const body = {
      query: operation.source,
      variables,
      operationName: operation.name,
    };
    const result = await api.request(key, {
      query:
        method === "GET"
          ? {
              ...own,
              query: body.query,
              variables:
                variables === undefined ? undefined : JSON.stringify(variables),
              operationName: body.operationName,
            }
          : own,
      body: method === "GET" ? undefined : body,
      signal: call.signal,
      timeout: call.timeout,
      headers: call.headers,
      middleware: [...(call.middleware ?? []), accept],
      retry: off ? false : { ...call.retry, methods: [method] },
      validate: call.validate?.result && {
        response: { 200: { custom: onData(call.validate.result) } },
        ...(call.validate.onFailure && {
          onFailure: { response: call.validate.onFailure },
        }),
      },
      throwOnError: false,
      undeclaredStatus: "result",
    });
    const { status, response } = result;
    const read = result.ok ? result.data : result.error;
    const errors = errorsOf(read);
    if (status < 200 || status > 299) {
      if (call.throwOnError ?? config.throwOnError)
        throw new HttpError(status, read, response, key);
      return { ok: false, status, error: read, errors, response };
    }
    if (!isResponse(read))
      throw new ClientError(
        `${key} answered ${status} with a body that is not a GraphQL response`,
        { key },
      );
    if (
      errors &&
      (call.throwOnGraphQLErrors ?? options.throwOnGraphQLErrors ?? false)
    )
      throw new GraphQLResponseError(
        key,
        status,
        errors,
        read.data,
        read.extensions,
        response,
      );
    return {
      ok: true,
      status,
      data: read.data,
      errors,
      extensions: read.extensions,
      response,
    };
  };

  const internals: GraphQLInternals = { url: options.url, describe };
  return {
    query: (
      document: GraphQLDocument,
      variables?: unknown,
      call?: RuntimeCall,
    ) => run("query", document, variables, call),
    mutate: (
      document: GraphQLDocument,
      variables?: unknown,
      call?: RuntimeCall,
    ) => run("mutation", document, variables, call),
    [INTERNALS]: internals,
  };
}

export { GraphQLResponseError } from "./errors";
