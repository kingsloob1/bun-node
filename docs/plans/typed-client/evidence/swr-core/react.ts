// Throwaway spike: a React binding for core.ts over useSyncExternalStore.
import { createContext, createElement, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { hashKey } from "./core";
import type { Fetcher, MutateOptions, QueryClient, QueryKey, QueryOptions, QueryState } from "./core";

const ClientContext = createContext<QueryClient | null>(null);

export function QueryClientProvider(props: { client: QueryClient; children?: ReactNode }) {
  return createElement(ClientContext.Provider, { value: props.client }, props.children);
}

export function useQueryClient(): QueryClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useQueryClient: no QueryClientProvider above this component");
  return client;
}

export interface UseQueryOptions extends QueryOptions {
  /** Throw the in-flight promise while pending (and the error on failure), for <Suspense>. */
  suspense?: boolean;
}

export type UseQueryResult<T> = QueryState<T> & { refetch: () => Promise<T> };

export function useQuery<T>(key: QueryKey, fetcher: Fetcher<T>, opts: UseQueryOptions = {}): UseQueryResult<T> {
  const client = useQueryClient();
  // Suspense resolves, re-renders, then subscribes: with staleTime 0 that subscribe would refetch
  // what was just fetched. TanStack has the same floor (1 s) for suspense queries.
  const options = opts.suspense ? { ...opts, staleTime: Math.max(opts.staleTime ?? 0, 1000) } : opts;
  const hash = hashKey(key);
  // The store is keyed by the hash, so an inline key array does not resubscribe each render.
  const store = useMemo(() => client.watch<T>(key, fetcher, options), [client, hash]);
  store.setOptions(fetcher, options); // latest fetcher/options win; timers are not reconciled
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (options.suspense) {
    if (state.status === "pending") throw client.fetchQuery(key, fetcher, options);
    if (state.status === "error" && state.data === undefined) throw state.error;
  }
  return { ...state, refetch: store.refetch };
}

export interface UseMutationResult<V, R> {
  mutate: (vars: V) => void;
  mutateAsync: (vars: V) => Promise<R>;
  status: "idle" | "pending" | "success" | "error";
  data: R | undefined;
  error: unknown;
  reset: () => void;
}

export function useMutation<V, R>(
  fn: (vars: V) => Promise<R>,
  options: (vars: V) => MutateOptions<R> = () => ({}),
): UseMutationResult<V, R> {
  const client = useQueryClient();
  const [state, setState] = useState<{ status: UseMutationResult<V, R>["status"]; data?: R; error?: unknown }>({ status: "idle" });
  const latest = useRef({ fn, options });
  latest.current = { fn, options };
  const mutateAsync = useCallback(async (vars: V) => {
    setState({ status: "pending" });
    try {
      const data = await client.mutate(() => latest.current.fn(vars), latest.current.options(vars));
      setState({ status: "success", data });
      return data;
    } catch (error) {
      setState({ status: "error", error });
      throw error;
    }
  }, [client]);
  const mutate = useCallback((vars: V) => { mutateAsync(vars).catch(() => {}); }, [mutateAsync]);
  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { mutate, mutateAsync, reset, status: state.status, data: state.data, error: state.error };
}
