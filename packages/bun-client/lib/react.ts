/**
 * `@kingsleyweb/bun-client/react`: the React binding (typed-client plan §7.1,
 * PR-C6). Thin hooks over `@tanstack/react-query`, fed by the query layer's
 * factories (`./query`), so a component reads a route by its path and gets
 * its data and errors typed from the route map:
 *
 * ```tsx
 * const q = queries(api, { manifest });
 * export const { useApi, useApiSuspense, useApiInfinite, useApiMutation } =
 *   createApiHooks(q);
 *
 * function User({ id }: { id: string }) {
 *   const user = useApi("/users/:id", { params: { id } });
 *   if (user.isPending) return "Loading";
 *   if (user.isError) return user.error.message;
 *   return user.data.name;
 * }
 * ```
 *
 * The reactivity is react-query's (`useSyncExternalStore` over query-core's
 * observers, batched into React's scheduler), and so are dedupe, Suspense,
 * StrictMode, focus and interval refetches. What this adds is the typing and
 * the query layer's behaviour underneath: keys, declared and header tags,
 * ETag revalidation, a mutation's `invalidates`, optimistic writes and their
 * rollback. The `QueryClient` comes from react-query's own
 * `QueryClientProvider`; there is no provider of ours.
 *
 * Not here yet, by the plan: `useLive(tags)` waits for the live channel
 * (`live(api)`, PR-W4), and `<ApiHydrate state>` for bun-views' hydration
 * (BVW PR-5, §6.6). Until then react-query's `HydrationBoundary` takes a
 * `dehydrate(queryClient)` state of these queries as it is: their keys and
 * data are plain JSON.
 *
 * `react` and `@tanstack/react-query` are optional peers: only this entry
 * imports react-query, and nothing else of the package imports this entry.
 */
import type { ClientError, HttpError } from "./errors";
import type {
  ApiInfiniteOptions,
  ApiQueryOptions,
  InfiniteCallOptions,
  InfiniteConfig,
  MutationConfig,
  OptimisticSnapshot,
  Queries,
  QueryCallOptions,
} from "./query";
import type { CallArgs, EntryAt, PathsOf, SuccessData } from "./types";
import type {
  InfiniteData,
  UseInfiniteQueryOptions,
  UseInfiniteQueryResult,
  UseMutationOptions,
  UseMutationResult,
  UseQueryOptions,
  UseQueryResult,
  UseSuspenseQueryOptions,
  UseSuspenseQueryResult,
} from "@tanstack/react-query";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

/** What a hook of route entry `E` fails with: the client's errors. */
type ErrorOf<E> = HttpError<E> | ClientError;

/** The entry of GET path `P`. */
type GetEntry<R, P> = EntryAt<R, `GET ${P & string}`>;

/** The query object a route's call takes. */
type QueryOf<E> =
  QueryCallOptions<E> extends { query?: infer Q } ? NonNullable<Q> : never;

/** The non-nullable type of query field `F`. */
type FieldOf<Q, F> = F extends keyof Q
  ? Exclude<Q[F], undefined | null>
  : never;

/** A mutation's variables: its call options, or nothing when no part is required. */
type MutationVariables<E> =
  [] extends CallArgs<E> ? QueryCallOptions<E> | void : QueryCallOptions<E>;

/** A query's key, as `q.query()` tags it. */
type KeyOf<TData, TError, K extends string> = ApiQueryOptions<
  TData,
  TError,
  K
>["queryKey"];

/** An infinite query's key, as `q.infinite()` tags it. */
type InfiniteKeyOf<TData, TError, TPage, K extends string> = ApiInfiniteOptions<
  TData,
  TError,
  TPage,
  K
>["queryKey"];

/**
 * react-query's options for {@link ApiHooks.useApi}, beside the call's: any
 * of `useQuery`'s but the key and the query function, which come from the
 * route (`staleTime`, `enabled`, `select`, `refetchInterval`, …). A `meta`
 * given here is merged under the route's `tags`.
 */
export type UseApiOptions<TData, TError, TSelect, K extends string> = Omit<
  UseQueryOptions<TData, TError, TSelect, KeyOf<TData, TError, K>>,
  "queryKey" | "queryFn"
>;

/** react-query's options for {@link ApiHooks.useApiSuspense}: `useSuspenseQuery`'s, as {@link UseApiOptions}. */
export type UseApiSuspenseOptions<
  TData,
  TError,
  TSelect,
  K extends string,
> = Omit<
  UseSuspenseQueryOptions<TData, TError, TSelect, KeyOf<TData, TError, K>>,
  "queryKey" | "queryFn"
>;

/**
 * react-query's options for {@link ApiHooks.useApiInfinite}: `useInfiniteQuery`'s
 * but the key, the query function and the paging (the third argument's), and
 * `select`.
 */
export type UseApiInfiniteOptions<
  TData,
  TError,
  TPage,
  K extends string,
> = Omit<
  UseInfiniteQueryOptions<
    TData,
    TError,
    InfiniteData<TData, TPage | undefined>,
    InfiniteKeyOf<TData, TError, TPage, K>,
    TPage | undefined
  >,
  | "queryKey"
  | "queryFn"
  | "initialPageParam"
  | "getNextPageParam"
  | "getPreviousPageParam"
  | "select"
>;

/**
 * react-query's options for {@link ApiHooks.useApiMutation}: `useMutation`'s
 * but the key, the mutation function and `onMutate` (the route and its
 * `optimistic` writers own them). `onSuccess`, `onError` and `onSettled` run
 * after the query layer's own (its invalidations and rollback), so they see
 * the cache as those left it; `meta` is merged under the route's
 * `invalidates`.
 */
export type UseApiMutationOptions<TData, TError, TVariables> = Omit<
  UseMutationOptions<TData, TError, TVariables, OptimisticSnapshot>,
  "mutationKey" | "mutationFn" | "onMutate"
>;

/** A query hook's arguments: the call's options (required when the route has a required part), then react-query's. */
type HookArgs<E, X> =
  [] extends CallArgs<E>
    ? [options?: QueryCallOptions<E>, query?: X]
    : [options: QueryCallOptions<E>, query?: X];

/** The hooks {@link createApiHooks} returns, typed by route map `R`. */
export interface ApiHooks<R> {
  /**
   * A GET route as a query (`useQuery(q.query(path, options))`):
   * `useApi("/users/:id", { params: { id } })`. `data` is the route's
   * success body (or `select`'s result), `error` the client's error for it
   * (`HttpError` with the route's declared error bodies, or another
   * `ClientError`).
   */
  useApi: <P extends PathsOf<R, "GET">, TSelect = SuccessData<GetEntry<R, P>>>(
    path: P,
    ...args: HookArgs<
      GetEntry<R, P>,
      UseApiOptions<
        SuccessData<GetEntry<R, P>>,
        ErrorOf<GetEntry<R, P>>,
        TSelect,
        `GET ${P}`
      >
    >
  ) => UseQueryResult<TSelect, ErrorOf<GetEntry<R, P>>>;
  /**
   * {@link ApiHooks.useApi} for `<Suspense>` (`useSuspenseQuery`): it
   * suspends until the data is there, so `data` is always defined, and
   * throws the first fetch's error to the nearest error boundary. Its
   * `staleTime` is at least 1 s (react-query's floor for suspense queries),
   * so the subscription made after the suspended render does not fetch
   * again what was just fetched (plan §7.1).
   */
  useApiSuspense: <
    P extends PathsOf<R, "GET">,
    TSelect = SuccessData<GetEntry<R, P>>,
  >(
    path: P,
    ...args: HookArgs<
      GetEntry<R, P>,
      UseApiSuspenseOptions<
        SuccessData<GetEntry<R, P>>,
        ErrorOf<GetEntry<R, P>>,
        TSelect,
        `GET ${P}`
      >
    >
  ) => UseSuspenseQueryResult<TSelect, ErrorOf<GetEntry<R, P>>>;
  /**
   * A GET route as an infinite query (`useInfiniteQuery(q.infinite(…))`),
   * the page in one of its query's fields: `useApiInfinite("/users", {},
   * { pageParam: "page", next: (last) => last.next })`. `data.pages` holds
   * each page's success body; `fetchNextPage()` asks `next` for the next.
   */
  useApiInfinite: <
    P extends PathsOf<R, "GET">,
    F extends keyof QueryOf<GetEntry<R, P>> & string,
  >(
    path: P,
    options: InfiniteCallOptions<GetEntry<R, P>, F>,
    page: InfiniteConfig<
      SuccessData<GetEntry<R, P>>,
      FieldOf<QueryOf<GetEntry<R, P>>, F>,
      F
    >,
    query?: UseApiInfiniteOptions<
      SuccessData<GetEntry<R, P>>,
      ErrorOf<GetEntry<R, P>>,
      FieldOf<QueryOf<GetEntry<R, P>>, F>,
      `GET ${P}`
    >,
  ) => UseInfiniteQueryResult<
    InfiniteData<
      SuccessData<GetEntry<R, P>>,
      FieldOf<QueryOf<GetEntry<R, P>>, F> | undefined
    >,
    ErrorOf<GetEntry<R, P>>
  >;
  /**
   * Any route as a mutation (`useMutation(q.mutation(key, config))`):
   * `useApiMutation("PATCH /users/:id", { optimistic })`, then
   * `mutate({ params, body })`. On success it invalidates the route's
   * declared `invalidates` tags, and settles after their refetches;
   * `optimistic` writes the named GET routes' cached queries first and puts
   * them back if the request fails.
   */
  useApiMutation: <K extends keyof R & string>(
    key: K,
    config?: MutationConfig<R, MutationVariables<R[K]>>,
    options?: UseApiMutationOptions<
      SuccessData<R[K]>,
      ErrorOf<R[K]>,
      MutationVariables<R[K]>
    >,
  ) => UseMutationResult<
    SuccessData<R[K]>,
    ErrorOf<R[K]>,
    MutationVariables<R[K]>,
    OptimisticSnapshot
  >;
}

/* ------------------------------------------------------------------ */
/* The hooks                                                            */
/* ------------------------------------------------------------------ */

/** A query layer's factories, called untyped. */
interface RuntimeQueries {
  /** `Queries.query`. */
  query: (path: string, options?: object) => QueryShape;
  /** `Queries.infinite`. */
  infinite: (path: string, options: object, page: object) => QueryShape;
  /** `Queries.mutation`. */
  mutation: (key: string, config?: object) => MutationShape;
}

/** What `q.query()` and `q.infinite()` return, as the hooks spread it. */
interface QueryShape {
  /** The route's tags (`meta.tags`). */
  meta: { tags: string[] };
}

/** A callback of a mutation's options, untyped. */
type Callback = (...args: never[]) => unknown;

/** What `q.mutation()` returns, as the hook composes it. */
interface MutationShape {
  /** `[routeKey]`. */
  mutationKey: readonly [string];
  /** Calls the route. */
  mutationFn: (variables: unknown) => Promise<unknown>;
  /** The optimistic writes. */
  onMutate: Callback;
  /** The rollback. */
  onError: Callback;
  /** The `invalidates` tags. */
  onSuccess: Callback;
  /** The written queries' invalidation. */
  onSettled: Callback;
  /** `invalidates`, as the manifest gives it. */
  meta: { invalidates: string[] };
}

/** The `meta` a hook's own options carry, if any. */
function metaOf(options: object | undefined): Record<string, unknown> {
  const meta = (options as { meta?: unknown } | undefined)?.meta;
  return typeof meta === "object" && meta !== null
    ? (meta as Record<string, unknown>)
    : {};
}

/**
 * Runs the query layer's callback, then the caller's (when given), with the
 * same arguments; resolves after both.
 */
function compose(
  own: Callback,
  theirs: Callback | undefined,
): (...args: never[]) => Promise<void> {
  return async (...args) => {
    await own(...args);
    await theirs?.(...args);
  };
}

/**
 * The React hooks over a query layer (plan §7.1): `useApi`,
 * `useApiSuspense`, `useApiInfinite` and `useApiMutation`, typed by the
 * route map of the client `q` was made from. Call it once per client, at
 * module level, and export the hooks; they read the `QueryClient` from
 * react-query's `QueryClientProvider`.
 *
 * ```tsx
 * import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
 * import { createClient } from "@kingsleyweb/bun-client";
 * import { queries } from "@kingsleyweb/bun-client/query";
 * import { createApiHooks } from "@kingsleyweb/bun-client/react";
 *
 * const api = createClient<Routes>({ baseUrl: "/api", manifest });
 * export const q = queries(api, { manifest });
 * export const { useApi, useApiMutation } = createApiHooks(q);
 *
 * const queryClient = new QueryClient();
 * root.render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
 * ```
 *
 * @param q The query layer's factories: `queries(api, { manifest })`. The
 *   same object serves prefetching, `getQueryData` and `invalidateTags`
 *   outside components.
 */
export function createApiHooks<R>(q: Queries<R>): ApiHooks<R> {
  const factories = q as unknown as RuntimeQueries;

  const useApi = (path: string, options?: object, query?: object) => {
    const base = factories.query(path, options);
    return useQuery({
      ...query,
      ...base,
      meta: { ...metaOf(query), ...base.meta },
    } as unknown as UseQueryOptions);
  };

  const useApiSuspense = (path: string, options?: object, query?: object) => {
    const base = factories.query(path, options);
    return useSuspenseQuery({
      ...query,
      ...base,
      meta: { ...metaOf(query), ...base.meta },
    } as unknown as UseSuspenseQueryOptions);
  };

  const useApiInfinite = (
    path: string,
    options: object,
    page: object,
    query?: object,
  ) => {
    const base = factories.infinite(path, options, page);
    return useInfiniteQuery({
      ...query,
      ...base,
      meta: { ...metaOf(query), ...base.meta },
    } as unknown as UseInfiniteQueryOptions);
  };

  const useApiMutation = (key: string, config?: object, options?: object) => {
    const base = factories.mutation(key, config);
    const theirs = (options ?? {}) as {
      onSuccess?: Callback;
      onError?: Callback;
      onSettled?: Callback;
    };
    return useMutation({
      ...options,
      mutationKey: base.mutationKey,
      mutationFn: base.mutationFn,
      onMutate: base.onMutate,
      onSuccess: compose(base.onSuccess, theirs.onSuccess),
      onError: compose(base.onError, theirs.onError),
      onSettled: compose(base.onSettled, theirs.onSettled),
      meta: { ...metaOf(options), ...base.meta },
    } as unknown as UseMutationOptions);
  };

  const hooks = { useApi, useApiSuspense, useApiInfinite, useApiMutation };
  return hooks as unknown as ApiHooks<R>;
}
