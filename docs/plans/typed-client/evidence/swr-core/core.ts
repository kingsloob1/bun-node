// Throwaway spike: a minimal, framework-agnostic SWR core. Zero runtime
// dependencies. Evidence for the typed-client plan, not product code.

export type QueryKey = readonly unknown[];
export type QueryStatus = "pending" | "success" | "error";
export type FetchStatus = "idle" | "fetching";

/** The observable state of one cache entry. Replaced (never mutated) on change. */
export interface QueryState<T = unknown> {
  readonly status: QueryStatus;
  readonly data: T | undefined;
  readonly error: unknown;
  readonly fetchStatus: FetchStatus;
  readonly updatedAt: number;
  readonly tags: readonly string[];
}

export interface FetchContext {
  /** Aborted by `cancel()`, by invalidation, or when the last subscriber leaves with `abortOnUnsubscribe`. */
  signal: AbortSignal;
  /** The ETag the entry's current data came with, for a conditional request. */
  etag: string | undefined;
}

/** `{ notModified: true }` models an HTTP 304: keep the data, bump `updatedAt`. */
export type FetchResult<T> = { data: T; etag?: string } | { notModified: true };
export type Fetcher<T> = (ctx: FetchContext) => Promise<FetchResult<T>>;

export interface BackoffOptions {
  base?: number;
  max?: number;
  /** ± fraction of the delay, e.g. 0.1 for ±10%. */
  jitter?: number;
}

/** Delay before retry `attempt` (1-based): base * 2^(attempt-1), capped, then jittered. */
export function computeBackoff(attempt: number, opts: BackoffOptions = {}, random: () => number = Math.random): number {
  const { base = 1000, max = 30_000, jitter = 0.1 } = opts;
  const raw = Math.min(base * 2 ** (Math.max(1, Math.floor(attempt)) - 1), max);
  const spread = raw * jitter;
  return Math.max(0, raw - spread + random() * 2 * spread);
}

export interface QueryOptions {
  staleTime?: number;
  gcTime?: number;
  retry?: number;
  retryDelay?: BackoffOptions;
  /** `false` disables in-flight dedupe (each call fetches). */
  dedupe?: boolean;
  /** A successful fetch started less than this long ago satisfies a new call. */
  dedupeMs?: number;
  refetchInterval?: number;
  refetchOnFocus?: boolean;
  refetchOnReconnect?: boolean;
  abortOnUnsubscribe?: boolean;
  tags?: readonly string[];
}

export interface Signal { subscribe: (fn: () => void) => () => void }
export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export function createEventSource(): Signal & { emit: () => void } {
  const fns = new Set<() => void>();
  return {
    subscribe(fn) { fns.add(fn); return () => fns.delete(fn); },
    emit() { for (const fn of [...fns]) fn(); },
  };
}

function domSource(target: "focus" | "online"): Signal {
  return {
    subscribe(fn) {
      if (typeof window === "undefined" || !window.addEventListener) return () => {};
      const onVisible = () => { if (document.visibilityState === "visible") fn(); };
      window.addEventListener(target, fn);
      if (target === "focus") document.addEventListener("visibilitychange", onVisible);
      return () => {
        window.removeEventListener(target, fn);
        if (target === "focus") document.removeEventListener("visibilitychange", onVisible);
      };
    },
  };
}

export interface QueryClientOptions {
  defaults?: QueryOptions;
  now?: () => number;
  timers?: Timers;
  random?: () => number;
  focusSource?: Signal;
  onlineSource?: Signal;
}

export type Updater<T> = T | ((prev: T | undefined) => T);
export type Rollback = () => void;

export interface MutateOptions<R> {
  /** Apply the optimistic change; return what undoes it (see `client.snapshot`). */
  optimistic?: (client: QueryClient) => Rollback | void;
  onSuccess?: (result: R) => void;
  onError?: (error: unknown) => void;
  /** Tags to invalidate once the mutation succeeds. */
  invalidateTags?: readonly string[];
}

export interface QueryStore<T> {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => QueryState<T>;
  refetch: () => Promise<T>;
  /** Swap the fetcher/options this store fetches with (no reconciliation of timers). */
  setOptions: (fetcher: Fetcher<T>, options?: QueryOptions) => void;
}

export interface DehydratedState {
  queries: { key: QueryKey; data: unknown; updatedAt: number; tags: readonly string[]; etag?: string }[];
}

interface ObserverConfig { fetcher: Fetcher<unknown>; options: QueryOptions }
interface Observer { cfg: ObserverConfig; listener: () => void; timer?: unknown }
interface Entry {
  key: QueryKey;
  hash: string;
  state: QueryState;
  observers: Set<Observer>;
  options: QueryOptions;
  promise?: Promise<unknown>;
  controller?: AbortController;
  fetchId: number;
  fetchedAt: number;
  invalidated: boolean;
  etag?: string;
  gcTimer?: unknown;
}

const noop = () => {};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` hash the same. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    isPlainObject(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
}
export const hashKey = (key: QueryKey): string => stableStringify(key);

/** Returns `next`, but reuses every subtree of `prev` that is deeply equal. */
export function replaceEqualDeep<T>(prev: unknown, next: T): T {
  if (prev === next) return prev as T;
  const arrays = Array.isArray(prev) && Array.isArray(next);
  if (!arrays && !(isPlainObject(prev) && isPlainObject(next))) return next;
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const keys = Object.keys(n);
  const copy: Record<string, unknown> = arrays ? ([] as unknown as Record<string, unknown>) : {};
  let same = keys.length === Object.keys(p).length;
  for (const k of keys) {
    const v = replaceEqualDeep(p[k], n[k]);
    copy[k] = v;
    if (v !== p[k] || !Object.hasOwn(p, k)) same = false;
  }
  return (same ? prev : copy) as T;
}

export type QueryClient = ReturnType<typeof createQueryClient>;

export function createQueryClient(clientOptions: QueryClientOptions = {}) {
  const defaults: QueryOptions = { staleTime: 0, gcTime: 5 * 60_000, retry: 0, ...clientOptions.defaults };
  const now = clientOptions.now ?? Date.now;
  const timers: Timers = clientOptions.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const random = clientOptions.random ?? Math.random;
  const entries = new Map<string, Entry>();
  const merge = (o?: QueryOptions): QueryOptions => ({ ...defaults, ...o });

  function set(e: Entry, patch: Partial<QueryState>) {
    e.state = { ...e.state, ...patch };
    for (const ob of [...e.observers]) ob.listener();
  }

  function scheduleGc(e: Entry) {
    if (e.gcTimer !== undefined) timers.clearTimeout(e.gcTimer);
    e.gcTimer = undefined;
    const gcTime = e.options.gcTime ?? defaults.gcTime!;
    if (e.observers.size > 0 || e.promise || !Number.isFinite(gcTime)) return;
    e.gcTimer = timers.setTimeout(() => {
      e.gcTimer = undefined;
      if (e.observers.size === 0 && !e.promise && entries.get(e.hash) === e) entries.delete(e.hash);
    }, gcTime);
  }

  function ensure(key: QueryKey, options?: QueryOptions): Entry {
    const hash = hashKey(key);
    let e = entries.get(hash);
    if (!e) {
      e = {
        key, hash, observers: new Set(), options: merge(options), fetchId: 0, fetchedAt: -Infinity, invalidated: false,
        state: { status: "pending", data: undefined, error: undefined, fetchStatus: "idle", updatedAt: 0, tags: options?.tags ?? [] },
      };
      entries.set(hash, e);
      scheduleGc(e);
    } else if (options) {
      e.options = { ...e.options, ...options };
      if (options.tags && options.tags !== e.state.tags) e.state = { ...e.state, tags: options.tags };
    }
    return e;
  }

  function isStale(e: Entry, o: QueryOptions): boolean {
    return e.state.status !== "success" || e.invalidated || now() - e.state.updatedAt >= (o.staleTime ?? 0);
  }

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const h = timers.setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { timers.clearTimeout(h); reject(signal.reason); }, { once: true });
    });
  }

  async function run<T>(e: Entry, fetcher: Fetcher<T>, o: QueryOptions, id: number, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let failure: unknown;
      try {
        const res = await fetcher({ signal, etag: e.etag });
        if (signal.aborted) throw signal.reason;
        if (id !== e.fetchId) return e.state.data as T; // superseded by a newer fetch
        if ("notModified" in res) {
          if (e.state.status !== "success") throw new Error("notModified without cached data");
          e.invalidated = false;
          set(e, { status: "success", error: undefined, fetchStatus: "idle", updatedAt: now() });
          return e.state.data as T;
        }
        e.etag = res.etag;
        e.invalidated = false;
        set(e, { status: "success", data: replaceEqualDeep(e.state.data, res.data), error: undefined, fetchStatus: "idle", updatedAt: now() });
        return e.state.data as T;
      } catch (error) { failure = error; }
      const current = id === e.fetchId;
      if (signal.aborted || !current || attempt >= (o.retry ?? 0)) {
        if (current) set(e, signal.aborted ? { fetchStatus: "idle" } : { status: "error", error: failure, fetchStatus: "idle" });
        throw failure;
      }
      try { await sleep(computeBackoff(attempt + 1, o.retryDelay, random), signal); }
      catch (abort) { if (id === e.fetchId) set(e, { fetchStatus: "idle" }); throw abort; }
    }
  }

  function fetchQuery<T>(key: QueryKey, fetcher: Fetcher<T>, options?: QueryOptions): Promise<T> {
    const o = merge(options);
    const e = ensure(key, options);
    if (o.dedupe !== false && e.promise) return e.promise as Promise<T>;
    if (o.dedupeMs && !e.invalidated && e.state.status === "success" && now() - e.fetchedAt < o.dedupeMs)
      return Promise.resolve(e.state.data as T);
    const id = ++e.fetchId;
    const controller = new AbortController();
    e.controller = controller;
    e.fetchedAt = now();
    if (e.gcTimer !== undefined) timers.clearTimeout(e.gcTimer);
    set(e, { fetchStatus: "fetching" });
    const p: Promise<T> = run(e, fetcher, o, id, controller.signal).finally(() => {
      if (e.promise === p) { e.promise = undefined; e.controller = undefined; }
      scheduleGc(e);
    });
    e.promise = p;
    return p;
  }

  function cancelEntry(e: Entry) {
    if (!e.promise) return;
    e.fetchId++;
    const c = e.controller;
    e.promise = undefined;
    e.controller = undefined;
    c?.abort(new DOMException("cancelled", "AbortError"));
    set(e, { fetchStatus: "idle" });
  }

  const background = (e: Entry, cfg: ObserverConfig) => { fetchQuery(e.key, cfg.fetcher, cfg.options).catch(noop); };

  function revalidateObserved(flag: "refetchOnFocus" | "refetchOnReconnect") {
    for (const e of entries.values()) {
      const ob = [...e.observers].find(o => o.cfg.options[flag] !== false);
      if (ob && isStale(e, ob.cfg.options)) background(e, ob.cfg);
    }
  }
  const unsubFocus = (clientOptions.focusSource ?? domSource("focus")).subscribe(() => revalidateObserved("refetchOnFocus"));
  const unsubOnline = (clientOptions.onlineSource ?? domSource("online")).subscribe(() => revalidateObserved("refetchOnReconnect"));

  const client = {
    fetchQuery,
    getQueryState: <T = unknown>(key: QueryKey) => entries.get(hashKey(key))?.state as QueryState<T> | undefined,
    getQueryData: <T = unknown>(key: QueryKey) => entries.get(hashKey(key))?.state.data as T | undefined,
    has: (key: QueryKey) => entries.has(hashKey(key)),
    get size() { return entries.size; },
    cancel(key: QueryKey) { const e = entries.get(hashKey(key)); if (e) cancelEntry(e); },

    /** A per-key store: `subscribe` starts a background fetch when stale; `getSnapshot` is identity-stable. */
    watch<T>(key: QueryKey, fetcher: Fetcher<T>, options?: QueryOptions): QueryStore<T> {
      const cfg: ObserverConfig = { fetcher: fetcher as Fetcher<unknown>, options: merge(options) };
      return {
        getSnapshot: () => ensure(key).state as QueryState<T>,
        refetch: () => fetchQuery(key, cfg.fetcher as Fetcher<T>, cfg.options),
        setOptions(f, o) { cfg.fetcher = f as Fetcher<unknown>; cfg.options = merge(o); },
        subscribe(listener) {
          const e = ensure(key, options);
          const ob: Observer = { cfg, listener };
          e.observers.add(ob);
          scheduleGc(e);
          if (isStale(e, cfg.options)) background(e, cfg);
          const interval = cfg.options.refetchInterval;
          if (interval) {
            const tick = () => { ob.timer = timers.setTimeout(() => { background(e, cfg); tick(); }, interval); };
            tick();
          }
          return () => {
            if (!e.observers.delete(ob)) return;
            if (ob.timer !== undefined) timers.clearTimeout(ob.timer);
            if (e.observers.size === 0) {
              if (cfg.options.abortOnUnsubscribe) cancelEntry(e);
              scheduleGc(e);
            }
          };
        },
      };
    },

    setQueryData<T>(key: QueryKey, updater: Updater<T>): T {
      const e = ensure(key);
      const next = typeof updater === "function"
        ? (updater as (p: T | undefined) => T)(e.state.data as T | undefined)
        : updater;
      set(e, { status: "success", data: next, error: undefined, updatedAt: now() });
      return next;
    },

    /** Cancels in-flight fetches of `key` and returns a function restoring its current state. */
    snapshot(key: QueryKey): Rollback {
      const e = ensure(key);
      cancelEntry(e);
      const saved = e.state;
      return () => {
        const target = ensure(key);
        target.state = { ...saved, fetchStatus: target.state.fetchStatus };
        for (const ob of [...target.observers]) ob.listener();
      };
    },

    /** Marks matching entries stale; observed ones refetch (cancelling an in-flight fetch first). */
    async invalidate(filter: { key?: QueryKey; tags?: readonly string[] }): Promise<void> {
      const prefix = filter.key?.map(stableStringify);
      const jobs: Promise<unknown>[] = [];
      for (const e of [...entries.values()]) {
        const keyMatch = prefix !== undefined && prefix.length <= e.key.length
          && prefix.every((p, i) => stableStringify(e.key[i]) === p);
        const tagMatch = filter.tags?.some(t => e.state.tags.includes(t)) ?? false;
        if (!keyMatch && !tagMatch) continue;
        e.invalidated = true;
        const ob = e.observers.values().next().value;
        if (ob) {
          cancelEntry(e);
          jobs.push(fetchQuery(e.key, ob.cfg.fetcher, ob.cfg.options).catch(noop));
        }
      }
      await Promise.all(jobs);
    },

    /** Runs `fn`; applies `optimistic` first and rolls it back if `fn` rejects. */
    async mutate<R>(fn: () => Promise<R>, opts: MutateOptions<R> = {}): Promise<R> {
      const rollback = opts.optimistic?.(client);
      try {
        const result = await fn();
        opts.onSuccess?.(result);
        if (opts.invalidateTags?.length) await client.invalidate({ tags: opts.invalidateTags });
        return result;
      } catch (error) {
        rollback?.();
        opts.onError?.(error);
        throw error;
      }
    },

    dehydrate(): DehydratedState {
      return {
        queries: [...entries.values()].filter(e => e.state.status === "success").map(e => ({
          key: e.key, data: e.state.data, updatedAt: e.state.updatedAt, tags: e.state.tags, ...(e.etag ? { etag: e.etag } : {}),
        })),
      };
    },

    hydrate(state: DehydratedState) {
      for (const q of state.queries) {
        const e = ensure(q.key);
        if (e.state.updatedAt >= q.updatedAt) continue;
        e.etag = q.etag;
        set(e, { status: "success", data: q.data, error: undefined, updatedAt: q.updatedAt, tags: q.tags });
      }
    },

    destroy() {
      unsubFocus();
      unsubOnline();
      for (const e of entries.values()) {
        cancelEntry(e);
        if (e.gcTimer !== undefined) timers.clearTimeout(e.gcTimer);
        for (const ob of e.observers) if (ob.timer !== undefined) timers.clearTimeout(ob.timer);
      }
      entries.clear();
    },
  };
  return client;
}

// ---- infinite queries (minimal) ----------------------------------------------

export interface InfiniteData<T, P> { pages: T[]; pageParams: P[] }
export interface InfiniteOptions<T, P> {
  initialPageParam: P;
  getNextPageParam: (lastPage: T, pages: T[]) => P | undefined;
}

/** Pages under one key. `fetcher` refetches every loaded page in order; `fetchNextPage` appends one. */
export function infiniteQuery<T, P>(
  client: QueryClient,
  key: QueryKey,
  pageFn: (ctx: FetchContext & { pageParam: P }) => Promise<T>,
  opts: InfiniteOptions<T, P>,
) {
  const fetcher: Fetcher<InfiniteData<T, P>> = async (ctx) => {
    const loaded = client.getQueryData<InfiniteData<T, P>>(key)?.pageParams.length ?? 1;
    const data: InfiniteData<T, P> = { pages: [], pageParams: [] };
    let param: P | undefined = opts.initialPageParam;
    for (let i = 0; i < loaded && param !== undefined; i++) {
      const page = await pageFn({ ...ctx, pageParam: param });
      data.pages.push(page);
      data.pageParams.push(param);
      param = opts.getNextPageParam(page, data.pages);
    }
    return { data };
  };
  const nextParam = (d: InfiniteData<T, P> | undefined) =>
    d && d.pages.length ? opts.getNextPageParam(d.pages[d.pages.length - 1]!, d.pages) : opts.initialPageParam;
  return {
    fetcher,
    hasNextPage: () => nextParam(client.getQueryData(key)) !== undefined,
    async fetchNextPage(): Promise<InfiniteData<T, P>> {
      const prev = client.getQueryData<InfiniteData<T, P>>(key);
      if (!prev) return client.fetchQuery(key, fetcher);
      const param = nextParam(prev);
      if (param === undefined) return prev;
      return client.fetchQuery(key, async (ctx) => {
        const page = await pageFn({ ...ctx, pageParam: param });
        return { data: { pages: [...prev.pages, page], pageParams: [...prev.pageParams, param] } };
      }, { dedupe: false });
    },
  };
}
