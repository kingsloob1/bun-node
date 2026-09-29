/**
 * Prototype of approach 1 in ../../../bun-native-routes.md (§4.2), the native
 * partition — built, tested and measured, and NOT recommended on this Bun:
 * **Bun's native router partitions the path space; BunRouter still decides.**
 *
 * - Every route handler whose path Bun can express exactly (static and
 *   whole-segment `:param` segments only) becomes a native key, one entry per
 *   method: `"/users/:p0": { GET: handler }`.
 * - Each (key, method) gets a precomputed **candidate list**: every route —
 *   middleware, error handlers, other endpoints — that is not *provably*
 *   disjoint from the key's shape, in registration order. The native handler
 *   runs the unchanged `getMatchedLayers()` over that list instead of the whole
 *   table, so ordering, params, decoding, `next('route')`, specificity and error
 *   handling are the router's own. Bun's precedence only picks the partition.
 * - A guard checks that the path BunRouter will see (`req.url`, which Bun
 *   normalises) still has the key's shape — Bun routes on the raw target
 *   (see ../results/dot-segments.txt). Anything else, and anything Bun does not
 *   route, reaches `fetch` → the full pipeline, exactly as today.
 * - A route registered after `listen()` bumps a version; candidate lists are
 *   rebuilt synchronously on the next native request (correctness), and the
 *   Bun table is rebuilt with `server.reload()` after a debounce (speed only).
 *
 * This file does NOT change library code. It hooks the router instance from
 * outside (an own-property `getMatchedLayers`, a `WeakMap` keyed by the native
 * `Request`, a `routes()` own property answering the candidates while a restricted match runs). The real
 * implementation would pass the candidate list as a parameter instead — see
 * the plan's §4.2 and §11 (not recommended on this Bun).
 */
import type { Route } from "@routejs/router";
import process from "node:process";
import type { BunRouter, MatchedLayer, RouteMatchMethodOptionType } from "../../../../../packages/bun-common/lib/BunRouter";

/** `BNR_NO_GUARD=1` disables the shape guard — the negative control. */
const NO_GUARD = process.env.BNR_NO_GUARD === "1";
/**
 * `BNR_CEILING=1` — NOT exact: reuses one request's layers for every request
 * to the key, rebinding only Bun's params. Measures the most native routing
 * could save with the current handle()/BunRequest/BunResponse; never a design.
 */
const CEILING = process.env.BNR_CEILING === "1";
/** `BNR_BREAK_CANDIDATES=1` deliberately under-fills candidate lists — the other negative control. */
const BREAK_CANDIDATES = process.env.BNR_BREAK_CANDIDATES === "1";

/** Methods Bun's method objects honour (survey §2). HEAD is derived from GET. */
const BUN_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** A path segment as far as disjointness is concerned. */
type Segment = { kind: "static"; value: string } | { kind: "param" } | { kind: "unknown" };

/** routejs treats these as syntax; a segment containing one is not a plain literal. */
const ROUTEJS_SYNTAX = /[*+?:()\\{}]/;
/** A whole-segment routejs param (its name charset). */
const WHOLE_PARAM = /^:[A-Za-z0-9_]+$/;
/** A literal Bun accepts verbatim and matches byte for byte (no `%`, ASCII). */
const BUN_SAFE_LITERAL = /^[A-Za-z0-9\-._~!$&'@,;=]+$/;

function parse(pattern: string): Segment[] {
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

/** The native key for a route handler's path, or `undefined` when Bun cannot express it exactly. */
export function nativeKey(path: string | null | undefined): string | undefined {
  if (!path || !path.startsWith("/")) return undefined;
  const segments = parse(path);
  let position = 0;
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "unknown") return undefined;
    if (segment.kind === "param") {
      parts.push(`:p${position++}`); // names are irrelevant to Bun's matching (survey §1)
    } else {
      if (!BUN_SAFE_LITERAL.test(segment.value) || segment.value === "." || segment.value === "..") return undefined;
      parts.push(segment.value);
    }
  }
  return `/${parts.join("/")}`;
}

type TaggedRoute = Route & { isEndpoint?: boolean; caseSensitive?: boolean };

/**
 * Whether `route` can never match a request whose path has `key`'s shape.
 * Conservative: only a literal-vs-literal mismatch at an aligned position, or
 * an impossible length between fully-plain patterns, proves it.
 */
function provablyDisjoint(key: Segment[], route: TaggedRoute): boolean {
  const isMiddleware = route.path === null || route.path === undefined;
  const pattern = (isMiddleware ? route.group : route.path) ?? "/";
  const segments = parse(pattern);
  const caseSensitive = route.caseSensitive ?? false;
  for (let i = 0; i < segments.length && i < key.length; i++) {
    const a = segments[i];
    if (a.kind === "unknown") return false; // a wildcard/regex/optional: stop aligning
    const b = key[i];
    if (a.kind === "static" && b.kind === "static") {
      const equal = caseSensitive ? a.value === b.value : a.value.toLowerCase() === b.value.toLowerCase();
      if (!equal) return true;
    }
  }
  const plain = segments.every((segment) => segment.kind !== "unknown");
  if (!plain) return false;
  // an exact route matches only its own segment count; a prefix at most the path's
  return isMiddleware ? segments.length > key.length : segments.length !== key.length;
}

function methodCanMatch(route: Route, method: string): boolean {
  const own = route.method;
  if (!own) return true;
  return Array.isArray(own) ? own.includes(method) : own === method;
}

/** What a native handler knows about its partition. */
export interface KeyInfo {
  key: string;
  method: string;
  /** The key's literal segments by position (`undefined` for a param). */
  literals: (string | undefined)[];
  candidates: Route[];
  /** CEILING mode only: the layers computed for the first request. */
  template?: MatchedLayer[];
}

function keyInfo(key: string, method: string, routes: Route[]): KeyInfo {
  const segments = parse(key);
  return {
    key,
    method,
    literals: segments.map((segment) => (segment.kind === "static" ? segment.value : undefined)),
    candidates: routes.filter(
      (route) =>
        methodCanMatch(route, method) &&
        !provablyDisjoint(segments, route as TaggedRoute) &&
        // negative control: drop every middleware from the candidates
        !(BREAK_CANDIDATES && (route as TaggedRoute).isEndpoint !== true),
    ),
  };
}

/**
 * Whether the path BunRouter will match (the request URL up to `?`, as
 * `getRequestPathFromRequestURL` cuts it) has the key's shape. Bun matched the
 * raw target; `req.url` is normalised, so the two can disagree.
 */
function hasKeyShape(info: KeyInfo, requestUrl: string): boolean {
  if (NO_GUARD) return true; // negative control for tests/sanity.test.ts only
  const q = requestUrl.indexOf("?");
  const path = q === -1 ? requestUrl : requestUrl.slice(0, q);
  const { literals } = info;
  if (literals.length === 0) return path === "/";
  let start = 1;
  for (let i = 0; i < literals.length; i++) {
    let end = path.indexOf("/", start);
    if (end === -1) end = path.length;
    else if (i === literals.length - 1) return false; // more segments than the key
    if (end === start) return false; // empty segment
    const literal = literals[i];
    if (literal !== undefined && path.slice(start, end) !== literal) return false;
    start = end + 1;
  }
  return true;
}

interface AdapterLike {
  instance: BunRouter;
  handleNativeRequest: (request: Request, server: Bun.Server<unknown>) => Promise<Response | undefined>;
  getBunServer: () => Bun.Server<unknown> | undefined;
}

type RouteHandler = (request: Request, server: Bun.Server<unknown>) => Promise<Response | undefined>;

/** Counters for tests and the report: which path each request took. */
export const nativeStats = { native: 0, guardFallback: 0, rebuilt: 0, reloads: 0, servedFetches: 0 };

/**
 * Installs native routing on an adapter. Returns the `routes` object to pass to
 * `Bun.serve`, rebuilt by `reload()` as the table changes.
 */
export class NativeRoutes {
  #pending = new WeakMap<Request, KeyInfo>();
  #infos = new Map<string, KeyInfo>();
  #version = -1;
  #router: BunRouter | undefined;
  #reloadTimer: ReturnType<typeof setTimeout> | undefined;
  #registeredKeys = "";

  constructor(
    private readonly adapter: AdapterLike,
    /** `routes` the application passed to `Bun.serve` itself; they win a key clash. */
    readonly userRoutes: Record<string, unknown> = {},
    private readonly reloadDebounceMs = 50,
  ) {}

  /** The `routes` object for `Bun.serve`, from the router's current table. */
  build(): Record<string, Partial<Record<string, RouteHandler>>> {
    this.#refresh();
    const table: Record<string, Partial<Record<string, RouteHandler>>> = {};
    for (const info of this.#infos.values()) {
      const handler: RouteHandler = (request, server) => {
        this.#pending.set(request, info);
        return this.adapter.handleNativeRequest(request, server);
      };
      (table[info.key] ??= {})[info.method] = handler;
    }
    this.#registeredKeys = [...this.#infos.keys()].join("\n");
    return table;
  }

  /** Recomputes keys and candidate lists when the table or the router changed. */
  #refresh(): boolean {
    const router = this.adapter.instance;
    const routes = router.routes();
    if (router === this.#router && routes.length === this.#version) return false;
    if (router !== this.#router) this.#install(router);
    this.#router = router;
    this.#version = routes.length;
    this.#infos.clear();
    for (const route of routes as TaggedRoute[]) {
      if (route.isEndpoint !== true) continue;
      const key = nativeKey(route.path);
      if (key === undefined) continue;
      const methods = route.method ? (Array.isArray(route.method) ? route.method : [route.method]) : BUN_METHODS;
      for (const method of methods) {
        if (!(BUN_METHODS as readonly string[]).includes(method)) continue;
        const id = `${method} ${key}`;
        if (!this.#infos.has(id)) this.#infos.set(id, keyInfo(key, method, routes));
      }
    }
    return true;
  }

  #install(router: BunRouter) {
    const original = Object.getPrototypeOf(router).getMatchedLayers as BunRouter["getMatchedLayers"];
    const originalSetRoute = Object.getPrototypeOf(router).setRoute as BunRouter["setRoute"];
    const pending = this.#pending;
    // eslint-disable-next-line ts/no-this-alias
    const self = this;
    // A route registered after listen(): schedule the (debounced) Bun rebuild.
    // Candidate lists are refreshed lazily by the length check below, so a
    // burst of registrations costs one rebuild, not one per route.
    Object.defineProperty(router, "setRoute", {
      configurable: true,
      value(this: BunRouter, ...args: Parameters<BunRouter["setRoute"]>) {
        const result = originalSetRoute.apply(this, args);
        if (self.adapter.getBunServer()) self.#scheduleReload();
        return result;
      },
    });
    // `routes()` answers the candidate list while a restricted match runs. An
    // own property defined once — assigning and deleting one per request would
    // push the router object into dictionary mode.
    const originalRoutes = Object.getPrototypeOf(router).routes as () => Route[];
    let restricted: Route[] | undefined;
    Object.defineProperty(router, "routes", {
      configurable: true,
      value(this: BunRouter) {
        return restricted ?? originalRoutes.call(this);
      },
    });
    /** Upper-bound mode: the first request's layers, reused with the next request's params. */
    const ceiling = (router: BunRouter, info: KeyInfo, options: RouteMatchMethodOptionType, request: Request): MatchedLayer[] => {
      if (!info.template) {
        restricted = info.candidates;
        const mutable = router as unknown as { routeCacheMax: number };
        const savedMax = mutable.routeCacheMax;
        mutable.routeCacheMax = 0;
        try {
          info.template = original.call(router, options);
        } finally {
          restricted = undefined;
          mutable.routeCacheMax = savedMax;
        }
        return info.template;
      }
      const bunParams = (request as unknown as { params: Record<string, string> }).params;
      return info.template.map((layer) => {
        if (!layer.isRouteHandler) return layer;
        const names = (info.candidates[layer.routeIndex] as Route).params ?? [];
        const params: Record<string, string> = {};
        for (let i = 0; i < names.length; i++) params[names[i] as string] = bunParams[`p${i}`];
        return { ...layer, matched: { ...layer.matched, params } };
      });
    };
    Object.defineProperty(router, "getMatchedLayers", {
      configurable: true,
      value(this: BunRouter, options: RouteMatchMethodOptionType & { request?: { request?: Request } }): MatchedLayer[] {
        const native = options.request?.request;
        let info = native ? pending.get(native) : undefined;
        if (!info) return original.call(this, options);
        pending.delete(native!);
        if (self.#refresh()) {
          nativeStats.rebuilt++;
          info = self.#infos.get(`${info.method} ${info.key}`);
          self.#scheduleReload();
        }
        if (!info || options.requestMethod !== info.method || !hasKeyShape(info, options.requestUrl)) {
          nativeStats.guardFallback++;
          return original.call(this, options);
        }
        nativeStats.native++;
        if (CEILING) return ceiling(this, info, options, native!);
        const mutable = this as unknown as { routeCacheMax: number };
        const savedMax = mutable.routeCacheMax;
        mutable.routeCacheMax = 0;
        restricted = info.candidates;
        try {
          return original.call(this, options);
        } finally {
          restricted = undefined;
          mutable.routeCacheMax = savedMax;
        }
      },
    });
  }

  /** Debounced rebuild of Bun's table; `onReload` receives the new `routes`. */
  #scheduleReload() {
    if (this.#reloadTimer) return;
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = undefined;
      const server = this.adapter.getBunServer();
      if (!server) return;
      const before = this.#registeredKeys;
      const routes = { ...this.build(), ...this.userRoutes };
      if (this.#registeredKeys === before) return;
      server.reload({ routes } as never);
      nativeStats.reloads++;
    }, this.reloadDebounceMs);
  }

  dispose() {
    clearTimeout(this.#reloadTimer);
  }
}
