/**
 * Prototype of the alternative the plan recommends *instead of* Bun's native
 * router: the same "candidate list" idea as native-routes.ts, computed in
 * JavaScript from the request path, used only when the route cache misses.
 *
 * - Routes are bucketed by their first path segment (lower-cased); a route
 *   whose first segment is a param, a wildcard, or absent (global middleware)
 *   goes in a list every request consults.
 * - On a cache miss, the candidates are the request's bucket merged with that
 *   list in registration order, minus any route provably disjoint from the
 *   concrete path (same test as native-routes.ts). The unchanged
 *   `getMatchedLayers()` runs over them, so every rule is the router's own,
 *   and its result is cached exactly as today.
 * - A hit never touches the index: it is a `Map.get` as before.
 *
 * No Bun routes, no reload, no raw-path guard (the path *is* the one
 * BunRouter matches), and `fetch()` takes the same path as a served request.
 * No library change: installed from outside by own-property hooks.
 */
import type { Route } from "@routejs/router";
import type { BunRouter, MatchedLayer, RouteMatchMethodOptionType } from "../../../../../packages/bun-common/lib/BunRouter";
import process from "node:process";

/** `BNR_BREAK_CANDIDATES=1` wrongly drops wildcard/regex routes — the negative control. */
const BREAK = process.env.BNR_BREAK_CANDIDATES === "1";
const ROUTEJS_SYNTAX = /[*+?:()\\{}]/;
const WHOLE_PARAM = /^:[A-Za-z0-9_]+$/;

type Segment = { kind: "static"; value: string } | { kind: "param" } | { kind: "unknown" };
type TaggedRoute = Route & { caseSensitive?: boolean };

function parsePattern(pattern: string): Segment[] {
  const trimmed = pattern.length > 1 && pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  if (trimmed === "/" || trimmed === "") return [];
  return trimmed
    .slice(1)
    .split("/")
    .map((raw): Segment => {
      if (WHOLE_PARAM.test(raw)) return { kind: "param" };
      if (raw === "" || ROUTEJS_SYNTAX.test(raw)) return { kind: "unknown" };
      return { kind: "static", value: raw };
    });
}

/** A concrete request path's segments: every one a literal, empty ones included. */
function parsePath(path: string): string[] {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed === "/" || trimmed === "" ? [] : trimmed.slice(1).split("/");
}

interface Compiled {
  route: TaggedRoute;
  segments: Segment[];
  plain: boolean;
  isMiddleware: boolean;
}

/** Whether `c` can never match `path` — only a literal mismatch or an impossible length proves it. */
function disjoint(c: Compiled, path: string[]): boolean {
  const { segments } = c;
  const caseSensitive = c.route.caseSensitive ?? false;
  for (let i = 0; i < segments.length && i < path.length; i++) {
    const a = segments[i];
    if (a.kind === "unknown") return BREAK; // BREAK: negative control only
    if (a.kind === "static") {
      const b = path[i];
      if (caseSensitive ? a.value !== b : a.value.toLowerCase() !== b.toLowerCase()) return true;
    }
  }
  if (!c.plain) return false;
  return c.isMiddleware ? segments.length > path.length : segments.length !== path.length;
}

export const indexStats = { misses: 0, candidatesTotal: 0, rebuilt: 0 };

export function installCandidateIndex(router: BunRouter) {
  const proto = Object.getPrototypeOf(router);
  const original = proto.getMatchedLayers as BunRouter["getMatchedLayers"];
  const originalRoutes = proto.routes as () => Route[];

  let built = -1;
  let buckets = new Map<string, number[]>();
  let everywhere: number[] = [];
  let compiled: Compiled[] = [];

  const rebuild = (routes: Route[]) => {
    indexStats.rebuilt++;
    buckets = new Map();
    everywhere = [];
    compiled = routes.map((route) => {
      const isMiddleware = route.path === null || route.path === undefined;
      const segments = parsePattern((isMiddleware ? route.group : route.path) ?? "/");
      return { route: route as TaggedRoute, segments, plain: segments.every((s) => s.kind !== "unknown"), isMiddleware };
    });
    compiled.forEach((c, index) => {
      const first = c.segments[0];
      if (first?.kind === "static") {
        const key = first.value.toLowerCase();
        let list = buckets.get(key);
        if (!list) buckets.set(key, (list = []));
        list.push(index);
      } else {
        everywhere.push(index);
      }
    });
    built = routes.length;
  };

  /** The candidates for `requestUrl`, in registration order. */
  const candidatesFor = (requestUrl: string): Route[] => {
    const routes = originalRoutes.call(router);
    if (routes.length !== built) rebuild(routes);
    const q = requestUrl.indexOf("?");
    const path = parsePath(q === -1 ? requestUrl : requestUrl.slice(0, q));
    const bucket = buckets.get((path[0] ?? "").toLowerCase()) ?? [];
    const out: Route[] = [];
    // merge two ascending index lists
    let i = 0;
    let j = 0;
    while (i < bucket.length || j < everywhere.length) {
      const next = j >= everywhere.length || (i < bucket.length && bucket[i] < everywhere[j]) ? bucket[i++] : everywhere[j++];
      const c = compiled[next];
      if (!disjoint(c, path)) out.push(c.route);
    }
    indexStats.misses++;
    indexStats.candidatesTotal += out.length;
    return out;
  };

  // `routes()` answers the candidates only while getMatchedLayers() runs, and
  // only if it asks — which it does on a cache miss alone.
  let pendingUrl: string | undefined;
  Object.defineProperty(router, "routes", {
    configurable: true,
    value(this: BunRouter) {
      if (pendingUrl !== undefined) {
        const url = pendingUrl;
        pendingUrl = undefined;
        return candidatesFor(url);
      }
      return originalRoutes.call(this);
    },
  });
  Object.defineProperty(router, "getMatchedLayers", {
    configurable: true,
    value(this: BunRouter, options: RouteMatchMethodOptionType): MatchedLayer[] {
      pendingUrl = options.requestUrl;
      try {
        return original.call(this, options);
      } finally {
        pendingUrl = undefined;
      }
    },
  });
}

/**
 * The route cache's FIFO eviction, `cache.delete(cache.keys().next().value)`,
 * is O(entries deleted so far) in both JavaScriptCore and V8: an
 * insertion-ordered Map keeps deleted slots until it rehashes, and
 * `keys().next()` walks past them. At the 50,000 cap that is ~18 µs per miss
 * (results/map-fifo.txt). This keeps the **same policy** — exact FIFO, at most
 * `max` entries — with O(1) eviction: a ring buffer of keys in insertion order
 * names the oldest, and `Map.delete` by key is O(1). It presents the `Map`
 * surface `getMatchedLayers` uses, with `keys()` yielding nothing so the
 * router's own eviction branch is a no-op, and evicts in `set`.
 */
export class RingFifoCache<V> {
  #map = new Map<string, V>();
  #ring: (string | undefined)[];
  #head = 0;
  constructor(private readonly max: number) {
    this.#ring = Array.from({ length: max });
  }
  get size() {
    return this.#map.size;
  }
  get(key: string): V | undefined {
    return this.#map.get(key);
  }
  set(key: string, value: V) {
    if (this.#map.has(key)) {
      this.#map.set(key, value);
      return this;
    }
    const oldest = this.#ring[this.#head];
    if (oldest !== undefined) this.#map.delete(oldest);
    this.#ring[this.#head] = key;
    this.#head = (this.#head + 1) % this.max;
    this.#map.set(key, value);
    return this;
  }
  keys(): IterableIterator<string> {
    return [][Symbol.iterator]();
  }
  delete(key: string) {
    // Leaves the key in the ring; evicting an absent key later is a no-op.
    return this.#map.delete(key);
  }
  clear() {
    this.#map.clear();
    this.#ring.fill(undefined);
    this.#head = 0;
  }
}

/** Replaces a router's route cache with {@link RingFifoCache} (same bound, same policy). */
export function installRingCache(router: BunRouter) {
  const r = router as unknown as { routeCacheMax: number; routeCacheLayers: unknown };
  if (r.routeCacheMax > 0) r.routeCacheLayers = new RingFifoCache<MatchedLayer[]>(r.routeCacheMax);
}
