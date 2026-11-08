/**
 * `@kingsleyweb/bun-client/query`: the data layer on `@tanstack/query-core`
 * (typed-client plan §6.3, §6.4, §7.2, PR-C5). What it adds over query-core,
 * and nothing more:
 *
 * - **Keys**: `[routeKey, { params, query }]`, so `invalidateQueries({
 *   queryKey: ["GET /users/:id"] })` reaches every user by prefix. Params are
 *   written as strings (the URL has no other kind), so `{ id: 7 }` and
 *   `{ id: "7" }` share a key. An infinite query's key ends in `"infinite"`,
 *   and leaves its page field out of `query`.
 * - **Tags**: a route's `cache.tags` from the manifest (`x-bun-cache`,
 *   `.describe({ cache })`), each template's `{name}` filled from the call's
 *   params, become the query's `meta.tags`; the `Cache-Tag` (comma-separated)
 *   and `Surrogate-Key` (space-separated) headers of its responses, which
 *   bun-cache's `cacheResponse({ surrogateKeys })` writes, are kept beside
 *   them. {@link invalidateTags} matches either. A mutation's
 *   `cache.invalidates`, filled from its variables' params, is invalidated on
 *   success, and the mutation settles after the refetches it caused.
 * - **Conditional revalidation**: a query's last `ETag` goes out as
 *   `If-None-Match` on its next fetch, and a `304` keeps the cached data
 *   (the same object, so nothing downstream sees a change; `dataUpdatedAt`
 *   still moves). An ETag is kept only for the data it came with: writing
 *   the query by hand (`setQueryData`, an optimistic update) drops it, and so
 *   does `Cache-Control: no-store`.
 * - **Optimistic updates**: `q.mutation(key, { optimistic })` writes the
 *   named GET routes' cached queries before the request and puts them back
 *   if it fails, then invalidates them once it settles.
 * - **Infinite queries**: the page parameter is a field of the route's
 *   query, typed from it.
 * - {@link observe}: a framework-free `subscribe`/`getSnapshot` store over a
 *   `QueryObserver` (or an `InfiniteQueryObserver`), whose snapshot keeps
 *   its identity until something in it changes (§6.3).
 *
 * Everything else (dedupe, stale-while-revalidate, focus and online
 * refetches, intervals, gc, the query's own retries) is query-core's, set on
 * the `QueryClient` or spread over what the factories return.
 *
 * `@tanstack/query-core` is an optional peer (Q3): only this entry imports
 * it, and the core client (`.`) imports nothing of this module.
 * {@link live} (PR-W4) keeps the observed queries fresh over bun-common's
 * live channel, through {@link tagsOfQuery}; its implementation
 * (`./live`) loads lazily.
 */
import type {
  DataTag,
  DefaultError,
  InfiniteData,
  InfiniteQueryObserverOptions,
  InfiniteQueryObserverResult,
  InvalidateOptions,
  InvalidateQueryFilters,
  MutationFunctionContext,
  Query,
  QueryClient,
  QueryFunctionContext,
  QueryKey,
  QueryObserverOptions,
  QueryObserverResult,
} from "@tanstack/query-core";
import type { StandardSchemaV1 } from "@kingsleyweb/bun-contract";
import type { ClientError, GraphQLResponseError, HttpError } from "./errors";
import type {
  GraphQLCallOptions,
  GraphQLDocument,
  ResultOf,
  VariablesOf,
} from "./graphql";
import type {
  CallArgs,
  CallParts,
  Client,
  ClientFlags,
  ClientMiddleware,
  EntryAt,
  PathsOf,
  RouteConfig,
  RouteManifest,
  RouteMap,
  SuccessData,
  ValidationConfig,
} from "./types";
import {
  hashKey,
  InfiniteQueryObserver,
  QueryObserver,
} from "@tanstack/query-core";

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

/** What a query or mutation of route entry `E` rejects with: the client's errors. */
type ErrorOf<E> = HttpError<E> | ClientError;

/**
 * The options of one query, infinite query or mutation call: the route's
 * typed parts (`params`, `query`, `body`, `headers`) and the per-route
 * settings (`timeout`, `retry`, `middleware`, `validate`). No `signal`
 * (query-core's is used), and no `throwOnError`/`undeclaredStatus`: a query
 * function always resolves the success body and throws the client's error
 * otherwise.
 *
 * @typeParam V The call's `validate.response`, as `q.query()` and
 *   `q.infinite()` capture it: a BYO schema set there for a 2xx status
 *   types the query's data as the schema's output (§5.4), as on the HTTP
 *   client. Default: any, typing nothing.
 */
export type QueryCallOptions<
  E,
  V extends ValidationConfig["response"] = ValidationConfig["response"],
> = CallParts<E> &
  Omit<RouteConfig, "headers" | "validate"> & {
    /**
     * Validation for this call, merged per key over the route's and the
     * client's; `false` turns it all off. A BYO schema set for a success
     * status (`response: { 200: { custom } }`) types the data as its output,
     * which is what the client delivers when the check passes (§5.4; a
     * failed check under `"warn"` delivers the body as it arrived, so
     * `onFailure: { response: "throw" }` is the safe pairing). The query's
     * key does not hold it: two queries of one route and params share one
     * cache entry whatever they validate. Default: the route's.
     */
    validate?: false | (ValidationConfig & { response?: V });
  };

/** The options argument, required when the route has a required part. */
type QueryArgs<E, V extends ValidationConfig["response"] = undefined> =
  [] extends CallArgs<E>
    ? [options?: QueryCallOptions<E, V>]
    : [options: QueryCallOptions<E, V>];

/** A mutation's variables: its call options, or nothing when no part is required. */
type MutationVariables<E> =
  [] extends CallArgs<E> ? QueryCallOptions<E> | void : QueryCallOptions<E>;

/** The second element of every key: the call's params (as strings) and query. */
interface KeyParts {
  /** The path params, each written as a string. */
  readonly params: Readonly<Record<string, string>>;
  /** The query object, as given. */
  readonly query: Readonly<Record<string, unknown>>;
}

/** A query's key: `[routeKey, { params, query }]`. */
type ApiQueryKey<K extends string> = readonly [K, KeyParts];

/** An infinite query's key: `[routeKey, { params, query }, "infinite"]`. */
type ApiInfiniteKey<K extends string> = readonly [K, KeyParts, "infinite"];

/** What `q.query()` returns: options any query-core method takes (`fetchQuery`, a `QueryObserver`, `useQuery`). */
export interface ApiQueryOptions<TData, TError, K extends string> {
  /** `[routeKey, { params, query }]`, tagged with the data type for `getQueryData`. */
  queryKey: DataTag<ApiQueryKey<K>, TData, TError>;
  /** Calls the route through the client, with `If-None-Match` once it has an ETag. */
  queryFn: (context: QueryFunctionContext<ApiQueryKey<K>>) => Promise<TData>;
  /** `tags`: the route's declared tags, filled from the params. */
  meta: { tags: string[] };
}

/** The non-nullable type of a query field. */
type FieldOf<Q, P> = P extends keyof Q
  ? Exclude<Q[P], undefined | null>
  : never;

/** The query object a route's call takes. */
type QueryOf<E> =
  CallParts<E> extends { query?: infer Q } ? NonNullable<Q> : never;

/** A page function: the next (or previous) page's value of the page field, `undefined` or `null` for none. */
type PageFunction<TData, TPage> = (
  page: TData,
  pages: TData[],
  pageParam: TPage | undefined,
  pageParams: (TPage | undefined)[],
) => TPage | undefined | null;

/**
 * The third argument of `q.infinite()` (§6.4): which query field carries the
 * page, and how to find the next one.
 *
 * @typeParam TData A page's data: the route's success body.
 * @typeParam TPage The page field's type, from the route's query.
 * @typeParam P The page field's name.
 */
export interface InfiniteConfig<TData, TPage, P extends string> {
  /** The query field the page goes in (`"page"`, `"cursor"`). */
  pageParam: P;
  /**
   * The first page's value. Default: the field's value in the call's query,
   * else none (the field is left out, and the server picks the first page).
   */
  initialPageParam?: TPage;
  /** The next page's value from the last page (query-core's `getNextPageParam`). */
  next: PageFunction<TData, TPage>;
  /** The previous page's value from the first page (`getPreviousPageParam`). Default: none, no backward paging. */
  previous?: PageFunction<TData, TPage>;
}

/** What `q.infinite()` returns: infinite query options for `fetchInfiniteQuery` or an `InfiniteQueryObserver`. */
export interface ApiInfiniteOptions<TData, TError, TPage, K extends string> {
  /** `[routeKey, { params, query }, "infinite"]`, the page field left out of `query`. */
  queryKey: DataTag<
    ApiInfiniteKey<K>,
    InfiniteData<TData, TPage | undefined>,
    TError
  >;
  /** Calls the route with the page in the page field. */
  queryFn: (
    context: QueryFunctionContext<ApiInfiniteKey<K>, TPage | undefined>,
  ) => Promise<TData>;
  /** As given, or the call's own value of the field. */
  initialPageParam: TPage | undefined;
  /** `next`, as query-core calls it. */
  getNextPageParam: PageFunction<TData, TPage>;
  /** `previous`, as query-core calls it, when given. */
  getPreviousPageParam?: PageFunction<TData, TPage>;
  /** `tags`: the route's declared tags, filled from the params. */
  meta: { tags: string[] };
}

/** The `optimistic` writers of a mutation: one per GET route of the map. */
type OptimisticWriters<R, V> = {
  [P in PathsOf<R, "GET"> as `GET ${P}`]?: (
    old: SuccessData<EntryAt<R, `GET ${P}`>>,
    variables: V,
  ) => SuccessData<EntryAt<R, `GET ${P}`>> | undefined;
};

/**
 * The options of `q.mutation()`.
 *
 * @typeParam R The route map.
 * @typeParam V The mutation's variables.
 * @typeParam S Its `validate.response`, captured so a BYO schema set for a
 *   success status types the mutation's data (§5.4). Default: any, typing
 *   nothing.
 */
export interface MutationConfig<
  R,
  V,
  S extends ValidationConfig["response"] = ValidationConfig["response"],
> {
  /**
   * Writes to the cache before the request is sent, put back if it fails
   * (§6.4): per GET route key, a function from a cached query's data and the
   * mutation's variables to the new data (`undefined` leaves that query as
   * it is). It is applied to each cached query of that route whose params
   * agree with the mutation's on every name both have, so a `PATCH
   * /users/:id` writing `"GET /users/:id"` touches that user only, and
   * `"GET /users"` (no params) every list. Infinite queries are left alone.
   * Those queries are cancelled first and invalidated once the mutation
   * settles. Default: none.
   */
  optimistic?: OptimisticWriters<R, V>;
  /**
   * Validation for every call of the mutation, as a call's `validate`
   * (merged per key over the route's and the client's). A BYO schema set
   * for a success status (`response: { 201: { custom } }`) types the
   * mutation's data as the schema's output (§5.4). Variables that carry
   * their own `validate` use it instead of this one. Default: the route's.
   */
  validate?: false | (ValidationConfig & { response?: S });
}

/** What `q.mutation()` returns: mutation options for a `MutationObserver` or `useMutation`. */
export interface ApiMutationOptions<
  TData,
  TError,
  TVariables,
  K extends string,
> {
  /** `[routeKey]`. */
  mutationKey: readonly [K];
  /** Calls the route; resolves the success body, throws the client's error. */
  mutationFn: (variables: TVariables) => Promise<TData>;
  /** Cancels and writes the optimistic queries; resolves what `onError` restores. */
  onMutate: (
    variables: TVariables,
    context: MutationFunctionContext,
  ) => Promise<OptimisticSnapshot>;
  /** Puts the optimistic queries back. */
  onError: (
    error: TError,
    variables: TVariables,
    snapshot: OptimisticSnapshot | undefined,
    context: MutationFunctionContext,
  ) => void;
  /** Invalidates the route's `invalidates` tags, filled from the variables' params; resolves after their refetches. */
  onSuccess: (
    data: TData,
    variables: TVariables,
    snapshot: OptimisticSnapshot | undefined,
    context: MutationFunctionContext,
  ) => Promise<void>;
  /** Invalidates the queries `optimistic` wrote. */
  onSettled: (
    data: TData | undefined,
    error: TError | null,
    variables: TVariables,
    snapshot: OptimisticSnapshot | undefined,
    context: MutationFunctionContext,
  ) => Promise<void>;
  /** `invalidates`: the route's templates, as the manifest gives them. */
  meta: { invalidates: string[] };
}

/** What an optimistic write saved: each written query as it was before. */
export interface OptimisticSnapshot {
  /** The written queries, in the order they were written. */
  readonly written: readonly {
    /** The query's key. */
    readonly queryKey: QueryKey;
    /** Its data before the write: the same object is put back. */
    readonly data: unknown;
    /** When that data arrived. */
    readonly dataUpdatedAt: number;
    /** The ETag that data came with, if any: put back with it. */
    readonly etag: string | undefined;
  }[];
}

/** The options of {@link queries}. */
export interface QueriesOptions<R> {
  /**
   * The route map's manifest, as given to `createClient` (the generator
   * writes it): its `cache` entries are the routes' declared tags and
   * invalidations. Default: none, so only the tags of the responses'
   * `Cache-Tag`/`Surrogate-Key` headers apply.
   */
  manifest?: RouteManifest<R>;
}

/** The factories {@link queries} returns over a client (§6.4). */
export interface Queries<R> {
  /**
   * A key for route `key` (`[key, { params, query }]`), for `getQueryData`,
   * `setQueryData` and filters. Leave the parts out for the route's prefix,
   * `[key]`, which every query of the route matches.
   */
  key: <K extends keyof R & string>(
    key: K,
    parts?: {
      /** Path params (written as strings, as the queries' keys hold them). */
      params?: object;
      /** The query object. */
      query?: object;
    },
  ) => QueryKey;
  /**
   * Query options for a GET route, by path: `q.query("/users/:id", { params:
   * { id } })`. A BYO schema in the options' `validate.response` for a
   * success status types the data as its output (§5.4).
   */
  query: <
    P extends PathsOf<R, "GET">,
    V extends ValidationConfig["response"] = undefined,
  >(
    path: P,
    ...args: QueryArgs<EntryAt<R, `GET ${P}`>, V>
  ) => ApiQueryOptions<
    SuccessData<EntryAt<R, `GET ${P}`>, undefined, V>,
    ErrorOf<EntryAt<R, `GET ${P}`>>,
    `GET ${P}`
  >;
  /**
   * Infinite query options for a GET route (§6.4), the page in one of its
   * query's fields: `q.infinite("/users", { query: { q } }, { pageParam:
   * "page", next: (last) => last.next })`. That field may be left out of
   * the options' query.
   */
  infinite: <
    P extends PathsOf<R, "GET">,
    F extends keyof QueryOf<EntryAt<R, `GET ${P}`>> & string,
    V extends ValidationConfig["response"] = undefined,
  >(
    path: P,
    options: InfiniteCallOptions<EntryAt<R, `GET ${P}`>, F, V>,
    page: InfiniteConfig<
      SuccessData<EntryAt<R, `GET ${P}`>, undefined, V>,
      FieldOf<QueryOf<EntryAt<R, `GET ${P}`>>, F>,
      F
    >,
  ) => ApiInfiniteOptions<
    SuccessData<EntryAt<R, `GET ${P}`>, undefined, V>,
    ErrorOf<EntryAt<R, `GET ${P}`>>,
    FieldOf<QueryOf<EntryAt<R, `GET ${P}`>>, F>,
    `GET ${P}`
  >;
  /**
   * Mutation options for any route, by key: `q.mutation("POST /users", {
   * optimistic })`. A BYO schema in the config's `validate.response` for a
   * success status types the data as its output (§5.4).
   */
  mutation: <
    K extends keyof R & string,
    S extends ValidationConfig["response"] = undefined,
  >(
    key: K,
    config?: MutationConfig<R, MutationVariables<R[K]>, S>,
  ) => ApiMutationOptions<
    SuccessData<R[K], undefined, S>,
    ErrorOf<R[K]>,
    MutationVariables<R[K]>,
    K
  >;
  /**
   * Query options for a GraphQL query (`graphql.md` §3.1), over a client
   * from `./graphql`'s `createGraphQLClient`: `q.graphql(gh, UserQuery, {
   * id })`. The key is `[url, operationName, variables]` (an anonymous
   * operation's text in place of its name); the query function resolves
   * the operation's `data` and rejects with `GraphQLResponseError` for a
   * response with errors (partial data included) and the client's errors
   * otherwise. `tags` become `meta.tags`, beside its responses' `Cache-Tag`
   * / `Surrogate-Key`.
   */
  graphql: <
    D extends GraphQLDocument,
    S extends StandardSchemaV1 | undefined = undefined,
  >(
    gh: GraphQLQueryClient,
    document: D,
    ...args: GraphQLQueryArgs<VariablesOf<D>, S>
  ) => GraphQLQueryOptions<
    [S] extends [StandardSchemaV1]
      ? StandardSchemaV1.InferOutput<S>
      : ResultOf<D>
  >;
  /** {@link invalidateTags}, the same function. */
  invalidateTags: typeof invalidateTags;
}

/** A GraphQL client (`createGraphQLClient`), as `q.graphql()` takes it. */
interface GraphQLQueryClient {
  /** Its query call. */
  readonly query: (...args: never[]) => Promise<unknown>;
}

/**
 * The options of `q.graphql()`: a GraphQL call's, without `signal`
 * (query-core's is used) or the throw switches (the query function always
 * throws), plus the query's tags.
 */
export type GraphQLQueryCallOptions<S> = Omit<
  GraphQLCallOptions<undefined, undefined, S>,
  "signal" | "throwOnError" | "throwOnGraphQLErrors"
> & {
  /** The query's `meta.tags`, which {@link invalidateTags} and {@link live} match. Default: none. */
  tags?: readonly string[];
};

/** `q.graphql()`'s arguments after the document: the variables are required when the operation has a required one. */
type GraphQLQueryArgs<V, S> = [RequiredKeysOf<V>] extends [never]
  ? [variables?: V, options?: GraphQLQueryCallOptions<S>]
  : [variables: V, options?: GraphQLQueryCallOptions<S>];

/** A GraphQL query's key: `[url, operationName (or the text), variables]`. */
type GraphQLQueryKey = readonly [string, string, unknown];

/** What `q.graphql()` returns: options any query-core method takes. */
export interface GraphQLQueryOptions<TData> {
  /** `[url, operationName, variables]`, tagged with the data type. */
  queryKey: DataTag<
    GraphQLQueryKey,
    TData,
    GraphQLResponseError<TData> | ClientError
  >;
  /** Runs the query through the GraphQL client; resolves its `data`. */
  queryFn: (context: QueryFunctionContext<GraphQLQueryKey>) => Promise<TData>;
  /** `tags`: as given. */
  meta: { tags: string[] };
}

/** The keys of `T` whose property is required. */
type RequiredKeysOf<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T];

/** The query with field `F` optional. */
type PageQuery<Q, F extends keyof Q> = Omit<Q, F> & Partial<Pick<Q, F>>;

/**
 * An infinite query's call options: the page field optional in `query`.
 * `V` is its `validate.response`, as {@link QueryCallOptions}' (each page's
 * data typed by a BYO schema's output).
 */
export type InfiniteCallOptions<
  E,
  F extends keyof QueryOf<E>,
  V extends ValidationConfig["response"] = ValidationConfig["response"],
> = Omit<QueryCallOptions<E, V>, "query"> &
  ([RequiredKeysOf<PageQuery<QueryOf<E>, F>>] extends [never]
    ? {
        /** The query, the page field optional. */
        query?: PageQuery<QueryOf<E>, F>;
      }
    : {
        /** The query, the page field optional. */
        query: PageQuery<QueryOf<E>, F>;
      });

/* ------------------------------------------------------------------ */
/* The per-client store: ETags and response tags                        */
/* ------------------------------------------------------------------ */

/** What the layer keeps per `QueryClient`, by query hash. */
interface Store {
  /** The ETag of each query's current data. */
  readonly etags: Map<string, string>;
  /** The ETag a fetch just read (`null`: none), applied when its data is. */
  readonly pending: Map<string, string | null>;
  /** The tags of each query's last response headers. */
  readonly headerTags: Map<string, readonly string[]>;
}

/** One store per `QueryClient`, alive as long as it is. */
const stores = new WeakMap<QueryClient, Store>();

/**
 * The client's store, created on first use with a cache listener that
 * applies a fetch's ETag when its data lands, drops it when the data is
 * written by hand (a `manual` success: `setQueryData`), and forgets a query
 * the cache removed.
 */
function storeFor(client: QueryClient): Store {
  let store = stores.get(client);
  if (store) return store;
  const created: Store = {
    etags: new Map(),
    pending: new Map(),
    headerTags: new Map(),
  };
  store = created;
  stores.set(client, created);
  client.getQueryCache().subscribe((event) => {
    const hash = event.query.queryHash;
    if (event.type === "removed") {
      created.etags.delete(hash);
      created.pending.delete(hash);
      created.headerTags.delete(hash);
      return;
    }
    if (event.type !== "updated" || event.action.type !== "success") return;
    if (event.action.manual) {
      created.etags.delete(hash);
      created.pending.delete(hash);
      return;
    }
    if (!created.pending.has(hash)) return;
    const etag = created.pending.get(hash);
    created.pending.delete(hash);
    if (etag == null) created.etags.delete(hash);
    else created.etags.set(hash, etag);
  });
  return created;
}

/**
 * The tags a response's headers carry: `Cache-Tag` split on commas,
 * `Surrogate-Key` on whitespace, de-duplicated; `undefined` when it has
 * neither header.
 */
function headerTagsOf(response: Response): string[] | undefined {
  const cacheTag = response.headers.get("cache-tag");
  const surrogate = response.headers.get("surrogate-key");
  if (cacheTag === null && surrogate === null) return undefined;
  const tags = new Set<string>();
  for (const tag of cacheTag?.split(",") ?? []) {
    if (tag.trim()) tags.add(tag.trim());
  }
  for (const tag of surrogate?.split(/\s+/) ?? []) {
    if (tag) tags.add(tag);
  }
  return [...tags];
}

/** Whether a response forbids keeping it: `Cache-Control: no-store`. */
function noStore(response: Response): boolean {
  return /(?:^|,)\s*no-store\s*(?:,|$)/i.test(
    response.headers.get("cache-control") ?? "",
  );
}

/** The query `key` names in `client`'s cache, if any. */
function queryAt(client: QueryClient, key: QueryKey): Query | undefined {
  const cache = client.getQueryCache();
  return cache.get(hashKey(key)) ?? cache.find({ queryKey: key, exact: true });
}

/**
 * Every tag of a cached query: its `meta.tags` (the route's declared tags)
 * and the tags its last response's headers carried. What
 * {@link invalidateTags} matches, and what {@link live} subscribes to.
 */
export function tagsOfQuery(client: QueryClient, query: Query): string[] {
  const declared = query.meta?.tags;
  const tags = new Set<string>(
    Array.isArray(declared)
      ? declared.filter((tag): tag is string => typeof tag === "string")
      : [],
  );
  for (const tag of stores.get(client)?.headerTags.get(query.queryHash) ?? [])
    tags.add(tag);
  return [...tags];
}

/**
 * Invalidates every query carrying one of `tags` (§6.4): a tag its route
 * declares (`meta.tags`) or one its last response sent in `Cache-Tag` or
 * `Surrogate-Key`. bun-cache's verb, for the client cache. Matching is
 * exact and case sensitive. Resolves when the refetches it started settle,
 * as `invalidateQueries` does.
 *
 * @param client The `QueryClient`.
 * @param tags The tags to invalidate.
 * @param filters More of `invalidateQueries`' filters (`type`, `refetchType`, …); its `predicate` is this function's.
 * @param options `invalidateQueries`' options (`cancelRefetch`, `throwOnError`).
 */
export function invalidateTags(
  client: QueryClient,
  tags: readonly string[],
  filters?: Omit<InvalidateQueryFilters, "predicate">,
  options?: InvalidateOptions,
): Promise<void> {
  const wanted = new Set(tags);
  if (wanted.size === 0) return Promise.resolve();
  return client.invalidateQueries(
    {
      ...filters,
      predicate: (query) =>
        tagsOfQuery(client, query).some((tag) => wanted.has(tag)),
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Live invalidation                                                    */
/* ------------------------------------------------------------------ */

/** {@link live}'s options. */
export interface LiveOptions {
  /**
   * How to reach the server's live channel: `"websocket"` (bun-common's
   * `liveContract` at `/__live` under the client's `baseUrl`) or `"sse"`
   * (its fallback, `/__live/sse`). Default: `"websocket"` where the
   * platform has a `WebSocket`, else `"sse"`; a socket that has not opened
   * 3 s after the start (a proxy refusing upgrades) gives way to `"sse"`.
   */
  transport?: "websocket" | "sse";
  /**
   * Called with the tags the server refused to subscribe this client to
   * (its per-tag authorization: a `hello` listing them as `denied`, or the
   * SSE fallback's `403` `LIVE_TAGS_DENIED` when it refuses every tag,
   * which ends that stream without a reconnect), each time it says so (a
   * reconnect, or a new tag, asks again). Those queries are not kept fresh
   * by the server. Default: each refused tag is logged
   * once, as a warning, through the client's `logger`.
   */
  onDenied?: (tags: string[]) => void;
}

/** The symbol {@link queries} keeps `live()` over its client under, for `./react`'s `useLive`. */
const LIVE = Symbol.for("@kingsleyweb/bun-client/query#live");

/** The implementation, loaded on the first {@link live} call. */
let liveModule: Promise<typeof import("./live")> | undefined;

/**
 * Keeps `queryClient`'s observed queries fresh over bun-common's live
 * channel (`websocket.md` §9; `liveInvalidation()` on the server): it
 * subscribes to the tags of every query with an observer ({@link
 * tagsOfQuery}: the route's declared tags and its responses' `Cache-Tag` /
 * `Surrogate-Key`), refcounted, and invalidates the queries under a tag
 * when the server says it was invalidated — once per invalidation, however
 * many of its tags they hold. After a reconnect it resumes from the last
 * invalidation it heard; when the server cannot replay what was missed (a
 * `gap`, or a restarted server's new epoch) every query is invalidated.
 * Answers the function that stops it.
 *
 * The implementation (and `./channel` or `./sse` under it) loads with
 * `import()` on the first call, so this entry stays small; nothing is
 * subscribed until it has.
 *
 * ```ts
 * const stop = live(api, queryClient);
 * ```
 *
 * @param api The client (`createClient`): its `baseUrl`, headers, auth and
 *   logger apply.
 * @param queryClient The `QueryClient` whose queries are kept fresh.
 * @param options See {@link LiveOptions}.
 */
export function live(
  api: {
    /** The client's URL builder. */
    readonly url: (...args: never[]) => string;
    /** The client's request. */
    readonly request: (...args: never[]) => Promise<unknown>;
  },
  queryClient: QueryClient,
  options: LiveOptions = {},
): () => void {
  let stop: (() => void) | undefined;
  let stopped = false;
  void (liveModule ??= import("./live")).then(
    (module) => {
      if (!stopped)
        stop = module.startLive(api, queryClient, options, tagsOfQuery);
    },
    (error: unknown) => {
      const logger =
        (
          (api as unknown as Record<symbol, unknown>)[
            Symbol.for("@kingsleyweb/bun-client")
          ] as { logger?: Pick<Console, "error"> } | undefined
        )?.logger ?? console;
      logger.error("live(): could not load", error);
    },
  );
  return () => {
    stopped = true;
    stop?.();
  };
}

/* ------------------------------------------------------------------ */
/* The factories                                                       */
/* ------------------------------------------------------------------ */

/** The symbol a GraphQL client keeps what `q.graphql()` reads under (`./graphql`). */
const GRAPHQL = Symbol.for("@kingsleyweb/bun-client/graphql");

/** The client as the factories call it, untyped. */
interface RuntimeClient {
  /** `Client.request`, its options untyped. */
  request: (key: string, options?: object) => Promise<unknown>;
}

/** Call options as the factories read them. */
interface RuntimeCall {
  /** Path params. */
  params?: Readonly<Record<string, unknown>>;
  /** The query object. */
  query?: Readonly<Record<string, unknown>>;
  /** The call's middleware. */
  middleware?: readonly ClientMiddleware[];
}

/** The params as a key writes them: every value a string. */
function keyParams(
  params: Readonly<Record<string, unknown>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) out[name] = String(value);
  }
  return out;
}

/** `{name}` in a template, the name captured. */
const PLACEHOLDER = /\{([^{}]+)\}/g;

/**
 * Fills each template's `{name}` from `params`; a template naming a param
 * the call does not have is left out (it would name no real tag).
 */
function fillTags(
  templates: readonly string[] | undefined,
  params: Readonly<Record<string, unknown>> | undefined,
): string[] {
  const out: string[] = [];
  for (const template of templates ?? []) {
    let missing = false;
    const tag = template.replace(PLACEHOLDER, (_match, name: string) => {
      const value = params?.[name];
      if (value === undefined || value === null) {
        missing = true;
        return "";
      }
      return String(value);
    });
    if (!missing && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** The value as a plain object, or `{}`. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Typed query, infinite query and mutation options over a client (§6.4).
 *
 * ```ts
 * import { QueryClient } from "@tanstack/query-core";
 * import { queries, observe } from "@kingsleyweb/bun-client/query";
 *
 * const api = createClient<Routes>({ baseUrl: "/api", manifest });
 * const q = queries(api, { manifest });
 * const queryClient = new QueryClient();
 *
 * await queryClient.fetchQuery(q.query("/users/:id", { params: { id: "7" } }));
 * const user = observe(queryClient, q.query("/users/:id", { params: { id: "7" } }));
 * await q.invalidateTags(queryClient, ["user:7"]);
 * ```
 *
 * @param api A client from `createClient`. Its configuration applies to
 *   every call (base URL, headers, auth, retries, validation).
 * @param options The manifest, for the declared tags.
 */
export function queries<R extends RouteMap<R>, F extends ClientFlags>(
  api: Client<R, F>,
  options: QueriesOptions<R> = {},
): Queries<R> {
  const client = api as unknown as RuntimeClient;
  const manifest = (options.manifest ?? {}) as Readonly<
    Record<
      string,
      | {
          cache?: {
            tags?: readonly string[];
            invalidates?: readonly string[];
          };
        }
      | undefined
    >
  >;

  const keyOf = (call: RuntimeCall): KeyParts => ({
    params: keyParams(call.params),
    query: { ...call.query },
  });

  /**
   * Runs one call: `throwOnError` on, so it resolves the success body and
   * rejects with the client's error; an innermost middleware sends
   * `If-None-Match` when asked and keeps the response for its headers.
   */
  const send = async (
    routeKey: string,
    call: RuntimeCall,
    signal: AbortSignal,
    ifNoneMatch: string | undefined,
  ): Promise<{ data?: unknown; error?: unknown; response?: Response }> => {
    let response: Response | undefined;
    const capture: ClientMiddleware = async (ctx, next) => {
      if (ifNoneMatch !== undefined)
        ctx.request.headers.set("if-none-match", ifNoneMatch);
      response = await next();
      return response;
    };
    try {
      const data = await client.request(routeKey, {
        ...call,
        signal,
        throwOnError: true,
        middleware: [...(call.middleware ?? []), capture],
      });
      return { data, response };
    } catch (error) {
      return { error, response };
    }
  };

  const query = (path: string, given?: RuntimeCall) => {
    const routeKey = `GET ${path}`;
    const call = given ?? {};
    return {
      queryKey: [routeKey, keyOf(call)] as const,
      queryFn: async (context: QueryFunctionContext): Promise<unknown> => {
        const store = storeFor(context.client);
        const cached = queryAt(context.client, context.queryKey);
        const hash = cached?.queryHash;
        const previous = cached?.state.data;
        const etag =
          hash !== undefined && previous !== undefined
            ? store.etags.get(hash)
            : undefined;
        const outcome = await send(routeKey, call, context.signal, etag);
        const { response } = outcome;
        const notModified = etag !== undefined && response?.status === 304;
        if (outcome.error !== undefined && !notModified)
          throw outcome.error as Error;
        if (notModified && outcome.error !== undefined) {
          // The client read a 304 as an error (undeclared, or not 2xx):
          // it is the server confirming the data we hold.
          await response?.body?.cancel().catch(() => undefined);
        }
        if (hash !== undefined) {
          const tags = response && headerTagsOf(response);
          if (tags !== undefined) store.headerTags.set(hash, tags);
          else if (!notModified) store.headerTags.delete(hash);
          store.pending.set(
            hash,
            response === undefined || noStore(response)
              ? null
              : (response.headers.get("etag") ?? (notModified ? etag : null)),
          );
        }
        return notModified ? previous : outcome.data;
      },
      meta: { tags: fillTags(manifest[routeKey]?.cache?.tags, call.params) },
    };
  };

  const infinite = (
    path: string,
    given: RuntimeCall,
    page: {
      pageParam: string;
      initialPageParam?: unknown;
      next: PageFunction<unknown, unknown>;
      previous?: PageFunction<unknown, unknown>;
    },
  ) => {
    const routeKey = `GET ${path}`;
    const { [page.pageParam]: initial, ...rest } = given.query ?? {};
    const call: RuntimeCall = { ...given, query: rest };
    return {
      queryKey: [routeKey, keyOf(call), "infinite"] as const,
      queryFn: async (
        context: QueryFunctionContext<QueryKey, unknown>,
      ): Promise<unknown> => {
        const query =
          context.pageParam === undefined || context.pageParam === null
            ? rest
            : { ...rest, [page.pageParam]: context.pageParam };
        const outcome = await send(
          routeKey,
          { ...call, query },
          context.signal,
          undefined,
        );
        const tags = outcome.response && headerTagsOf(outcome.response);
        if (tags !== undefined) {
          // An infinite query carries the tags of every page it holds.
          const hash = queryAt(context.client, context.queryKey)?.queryHash;
          if (hash !== undefined) {
            const store = storeFor(context.client);
            const known = store.headerTags.get(hash) ?? [];
            store.headerTags.set(hash, [...new Set([...known, ...tags])]);
          }
        }
        if (outcome.error !== undefined) throw outcome.error as Error;
        return outcome.data;
      },
      initialPageParam:
        "initialPageParam" in page ? page.initialPageParam : initial,
      getNextPageParam: page.next,
      ...(page.previous === undefined
        ? {}
        : { getPreviousPageParam: page.previous }),
      meta: { tags: fillTags(manifest[routeKey]?.cache?.tags, call.params) },
    };
  };

  const mutation = (
    routeKey: string,
    config: {
      optimistic?: Readonly<
        Record<
          string,
          ((old: unknown, variables: unknown) => unknown) | undefined
        >
      >;
      validate?: unknown;
    } = {},
  ) => {
    const invalidates = manifest[routeKey]?.cache?.invalidates ?? [];
    const writers = Object.entries(config.optimistic ?? {}).filter(
      (
        entry,
      ): entry is [string, (old: unknown, variables: unknown) => unknown] =>
        typeof entry[1] === "function",
    );

    /** The cached, non-infinite queries of `target` whose params agree with the variables'. */
    const targets = (
      queryClient: QueryClient,
      target: string,
      params: Readonly<Record<string, string>>,
    ): Query[] =>
      queryClient
        .getQueryCache()
        .findAll({ queryKey: [target] })
        .filter((cached) => {
          const key = cached.queryKey;
          if (key.length !== 2) return false;
          const own = asRecord(asRecord(key[1]).params);
          return Object.entries(own).every(
            ([name, value]) => !(name in params) || params[name] === value,
          );
        });

    return {
      mutationKey: [routeKey] as const,
      mutationFn: (variables: unknown) =>
        client.request(routeKey, {
          ...(config.validate === undefined
            ? {}
            : { validate: config.validate }),
          ...asRecord(variables),
          throwOnError: true,
        }),
      onMutate: async (
        variables: unknown,
        context: MutationFunctionContext,
      ): Promise<OptimisticSnapshot> => {
        const written: OptimisticSnapshot["written"][number][] = [];
        const store = storeFor(context.client);
        if (writers.length === 0) return { written };
        const params = keyParams(
          asRecord(asRecord(variables).params) as Record<string, unknown>,
        );
        for (const [target] of writers)
          await context.client.cancelQueries({ queryKey: [target] });
        for (const [target, write] of writers) {
          for (const cached of targets(context.client, target, params)) {
            const old = cached.state.data;
            if (old === undefined) continue;
            const next = write(old, variables);
            if (next === undefined) continue;
            written.push({
              queryKey: cached.queryKey,
              data: old,
              dataUpdatedAt: cached.state.dataUpdatedAt,
              etag: store.etags.get(cached.queryHash),
            });
            context.client.setQueryData(cached.queryKey, next);
          }
        }
        return { written };
      },
      onError: (
        _error: unknown,
        _variables: unknown,
        snapshot: OptimisticSnapshot | undefined,
        context: MutationFunctionContext,
      ): void => {
        // Put back in reverse, so a query written twice ends as it began:
        // the state itself (not `setQueryData`, whose structural sharing
        // would hand back a copy), and the ETag of that data.
        const store = storeFor(context.client);
        for (const { queryKey, data, dataUpdatedAt, etag } of [
          ...(snapshot?.written ?? []),
        ].reverse()) {
          const cached = queryAt(context.client, queryKey);
          if (cached === undefined) continue;
          cached.setState({ data, dataUpdatedAt });
          if (etag !== undefined) store.etags.set(cached.queryHash, etag);
        }
      },
      onSuccess: async (
        _data: unknown,
        variables: unknown,
        _snapshot: OptimisticSnapshot | undefined,
        context: MutationFunctionContext,
      ): Promise<void> => {
        await invalidateTags(
          context.client,
          fillTags(
            invalidates,
            asRecord(asRecord(variables).params) as Record<string, unknown>,
          ),
        );
      },
      onSettled: async (
        _data: unknown,
        _error: unknown,
        _variables: unknown,
        snapshot: OptimisticSnapshot | undefined,
        context: MutationFunctionContext,
      ): Promise<void> => {
        await Promise.all(
          (snapshot?.written ?? []).map(({ queryKey }) =>
            context.client.invalidateQueries({ queryKey, exact: true }),
          ),
        );
      },
      meta: { invalidates: [...invalidates] },
    };
  };

  const graphql = (
    gh: object,
    document: unknown,
    variables?: unknown,
    given: { tags?: readonly string[] } & RuntimeCall = {},
  ) => {
    const internals = (gh as Record<symbol, unknown>)[GRAPHQL] as
      | {
          url: string;
          describe: (document: unknown) => { source: string; name?: string };
        }
      | undefined;
    if (internals === undefined)
      throw new TypeError(
        "q.graphql() takes a client from createGraphQLClient (./graphql)",
      );
    const operation = internals.describe(document);
    const { tags, ...call } = given;
    return {
      queryKey: [
        internals.url,
        operation.name ?? operation.source,
        variables ?? {},
      ] as const,
      queryFn: async (context: QueryFunctionContext): Promise<unknown> => {
        let response: Response | undefined;
        const capture: ClientMiddleware = async (_ctx, next) =>
          (response = await next());
        try {
          const result = await (
            gh as {
              query: (
                document: unknown,
                variables: unknown,
                options: object,
              ) => Promise<{ data?: unknown }>;
            }
          ).query(document, variables, {
            ...call,
            signal: context.signal,
            throwOnError: true,
            throwOnGraphQLErrors: true,
            middleware: [...(call.middleware ?? []), capture],
          });
          return result.data;
        } finally {
          // The tags of its responses' headers, as a route query keeps them.
          const hash = queryAt(context.client, context.queryKey)?.queryHash;
          const found = response && headerTagsOf(response);
          if (hash !== undefined) {
            const store = storeFor(context.client);
            if (found !== undefined) store.headerTags.set(hash, found);
            else if (response !== undefined) store.headerTags.delete(hash);
          }
        }
      },
      meta: { tags: [...(tags ?? [])] },
    };
  };

  const factories = {
    key: (routeKey: string, parts?: RuntimeCall): QueryKey =>
      parts === undefined ? [routeKey] : [routeKey, keyOf(parts)],
    query,
    infinite,
    mutation,
    graphql,
    invalidateTags,
    // `./react`'s `useLive`: `live()` over this layer's client, so the
    // React entry starts it without importing this module.
    [LIVE]: (queryClient: QueryClient, liveOptions?: LiveOptions) =>
      live(
        client as unknown as Parameters<typeof live>[0],
        queryClient,
        liveOptions,
      ),
  };
  return factories as unknown as Queries<R>;
}

/* ------------------------------------------------------------------ */
/* observe()                                                            */
/* ------------------------------------------------------------------ */

/** What {@link observe} reports of a query (§6.3). */
export interface QuerySnapshot<TData, TError> {
  /** `"pending"` (no data yet), `"success"` or `"error"`. */
  readonly status: "pending" | "success" | "error";
  /** The data; `undefined` until the first success. */
  readonly data: TData | undefined;
  /** The last error, or `null`. */
  readonly error: TError | null;
  /** Whether a fetch is running (the first one or a background one). */
  readonly isFetching: boolean;
  /** Whether the data is stale (by `staleTime`) or invalidated. */
  readonly isStale: boolean;
  /** When the data last arrived (or a `304` confirmed it), ms since the epoch; `0` before. */
  readonly dataUpdatedAt: number;
}

/** What {@link observe} reports of an infinite query. */
export interface InfiniteQuerySnapshot<TData, TError> extends QuerySnapshot<
  TData,
  TError
> {
  /** Whether `next` gave a next page. */
  readonly hasNextPage: boolean;
  /** Whether `previous` gave a previous page. */
  readonly hasPreviousPage: boolean;
  /** Whether the next page is being fetched. */
  readonly isFetchingNextPage: boolean;
  /** Whether the previous page is being fetched. */
  readonly isFetchingPreviousPage: boolean;
}

/**
 * A query as an external store (§6.3): what a binding subscribes to
 * (`useSyncExternalStore(o.subscribe, o.getSnapshot)`) and what a vanilla
 * app uses directly.
 */
export interface ObservedQuery<
  TData,
  TError,
  TSnapshot = QuerySnapshot<TData, TError>,
> {
  /**
   * Calls `listener` after each change of the snapshot; returns the
   * unsubscribe. The first subscriber starts the observer (and its fetch,
   * if the data is missing or stale); the last one to leave stops it, so the
   * query goes inactive and query-core's gc may collect it.
   */
  subscribe: (listener: () => void) => () => void;
  /** The current snapshot: the same object until something in it changes. */
  getSnapshot: () => TSnapshot;
  /** Fetches again, whether or not the data is stale; resolves the snapshot after. */
  refetch: () => Promise<TSnapshot>;
  /** Replaces the observed options (another key: another query). */
  setOptions: (options: object) => void;
}

/** {@link ObservedQuery} for an infinite query, with its paging. */
export interface ObservedInfiniteQuery<TData, TError> extends ObservedQuery<
  TData,
  TError,
  InfiniteQuerySnapshot<TData, TError>
> {
  /** Fetches the next page; resolves the snapshot after. */
  fetchNextPage: () => Promise<InfiniteQuerySnapshot<TData, TError>>;
  /** Fetches the previous page; resolves the snapshot after. */
  fetchPreviousPage: () => Promise<InfiniteQuerySnapshot<TData, TError>>;
}

/** Infinite query options: what tells `observe()` to use an `InfiniteQueryObserver`. */
type AnyInfiniteOptions<TData, TError, TPage, TKey extends QueryKey> = {
  /** query-core's next-page function, present in every infinite query's options. */
  getNextPageParam: unknown;
} & InfiniteQueryObserverOptions<
  TData,
  TError,
  InfiniteData<TData, TPage>,
  TKey,
  TPage
>;

/** The snapshot of an observer's result, by the fields §6.3 names. */
function snapshotOf(
  result: QueryObserverResult<unknown, unknown>,
  infinite: boolean,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    status: result.status,
    data: result.data,
    error: result.error,
    isFetching: result.isFetching,
    isStale: result.isStale,
    dataUpdatedAt: result.dataUpdatedAt,
  };
  if (!infinite) return base;
  const paged = result as InfiniteQueryObserverResult<unknown, unknown>;
  base.hasNextPage = paged.hasNextPage;
  base.hasPreviousPage = paged.hasPreviousPage;
  base.isFetchingNextPage = paged.isFetchingNextPage;
  base.isFetchingPreviousPage = paged.isFetchingPreviousPage;
  return base;
}

/** Whether two snapshots hold the same values, field by field. */
function sameSnapshot(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): boolean {
  for (const name of Object.keys(a)) {
    if (!Object.is(a[name], b[name])) return false;
  }
  return true;
}

/**
 * Observes a query without a framework (§6.3): a `subscribe`/`getSnapshot`
 * store over query-core's `QueryObserver`, or its `InfiniteQueryObserver`
 * for infinite options (`q.infinite()`'s, or any with `getNextPageParam`).
 *
 * ```ts
 * const user = observe(queryClient, q.query("/users/:id", { params: { id: "7" } }));
 * const stop = user.subscribe(() => render(user.getSnapshot()));
 * ```
 *
 * @param client The `QueryClient`.
 * @param options Query options: `q.query()`'s or `q.infinite()`'s, with
 *   anything of query-core's spread over them (`staleTime`, `enabled`, …).
 */
export function observe<TData, TError, TPage, K extends string>(
  client: QueryClient,
  options: ApiInfiniteOptions<TData, TError, TPage, K> &
    Partial<
      InfiniteQueryObserverOptions<
        TData,
        TError,
        InfiniteData<TData, TPage | undefined>,
        ApiInfiniteKey<K>,
        TPage | undefined
      >
    >,
): ObservedInfiniteQuery<InfiniteData<TData, TPage | undefined>, TError>;
export function observe<TData, TError, K extends string>(
  client: QueryClient,
  options: ApiQueryOptions<TData, TError, K> &
    Partial<QueryObserverOptions<TData, TError, TData, TData, ApiQueryKey<K>>>,
): ObservedQuery<TData, TError>;
export function observe<
  TData,
  TError = DefaultError,
  TPage = unknown,
  TKey extends QueryKey = QueryKey,
>(
  client: QueryClient,
  options: AnyInfiniteOptions<TData, TError, TPage, TKey>,
): ObservedInfiniteQuery<InfiniteData<TData, TPage>, TError>;
export function observe<
  TData,
  TError = DefaultError,
  TKey extends QueryKey = QueryKey,
>(
  client: QueryClient,
  options: QueryObserverOptions<TData, TError, TData, TData, TKey>,
): ObservedQuery<TData, TError>;
export function observe(
  client: QueryClient,
  options: object,
): ObservedInfiniteQuery<unknown, unknown> {
  const infinite =
    typeof (options as { getNextPageParam?: unknown }).getNextPageParam ===
    "function";
  const observer: QueryObserver = infinite
    ? (new InfiniteQueryObserver(
        client,
        options as InfiniteQueryObserverOptions,
      ) as unknown as QueryObserver)
    : new QueryObserver(client, options as QueryObserverOptions);
  const listeners = new Set<() => void>();
  let snapshot = snapshotOf(observer.getCurrentResult(), infinite);
  let detach: (() => void) | undefined;

  /** Takes the observer's result; a new snapshot only when a field changed. */
  const take = (result: QueryObserverResult<unknown, unknown>): boolean => {
    const next = snapshotOf(result, infinite);
    if (sameSnapshot(snapshot, next)) return false;
    snapshot = next;
    return true;
  };

  const store = {
    subscribe: (listener: () => void): (() => void) => {
      const own = () => listener();
      listeners.add(own);
      if (detach === undefined) {
        detach = observer.subscribe((result) => {
          if (!take(result)) return;
          for (const notify of [...listeners]) notify();
        });
      }
      return () => {
        if (!listeners.delete(own)) return;
        if (listeners.size === 0 && detach !== undefined) {
          detach();
          detach = undefined;
        }
      };
    },
    getSnapshot: () => snapshot,
    refetch: async () => {
      take(await observer.refetch());
      return snapshot;
    },
    setOptions: (next: object) => {
      observer.setOptions(next as QueryObserverOptions);
      take(observer.getCurrentResult());
    },
    fetchNextPage: async () => {
      take(
        await (observer as unknown as InfiniteQueryObserver).fetchNextPage(),
      );
      return snapshot;
    },
    fetchPreviousPage: async () => {
      take(
        await (
          observer as unknown as InfiniteQueryObserver
        ).fetchPreviousPage(),
      );
      return snapshot;
    },
  };
  if (!infinite) {
    delete (store as Partial<typeof store>).fetchNextPage;
    delete (store as Partial<typeof store>).fetchPreviousPage;
  }
  return store as unknown as ObservedInfiniteQuery<unknown, unknown>;
}
