/**
 * The two pieces that keep a route-cache **miss** cheap: a candidate index
 * over the route table, and a FIFO cache whose eviction is O(1).
 *
 * Neither changes what matches. The index only rules out routes that provably
 * cannot match a path, so the router's own regexes still decide every request
 * (registration order, `next('route')`, error mode, specificity, decoding);
 * the cache keeps exactly the policy it replaces. See
 * `docs/plans/bun-native-routes.md` §4.6 for the measurements behind both.
 */
import type { Route } from "@routejs/router";

/**
 * Characters that make a segment a routejs pattern rather than a literal:
 * a param (`:`), a modifier (`*`, `+`, `?`), a regex group (`(`, `)`), an
 * escape (`\`), and the braces of Express 5's `{*name}`. A segment carrying
 * any of them is "unknown" — it may match more or fewer segments than one.
 */
const ROUTEJS_SYNTAX = /[*+?:()\\{}]/;

/** A whole-segment param: `:name`, which routejs matches as `[^/]+?`. */
const WHOLE_PARAM = /^:\w+$/;

/** Any character outside ASCII. */
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\u0000-\u007F]/;

/** An empty, never-mutated list of route indices. */
const NO_ROUTES: readonly number[] = [];

/** Segment kinds: a literal, a whole-segment param, or anything else. */
const STATIC = 0;
const PARAM = 1;
const UNKNOWN = 2;

/** One route, pre-parsed for {@link RouteCandidateIndex}. */
interface CompiledRoute {
  /** Each pattern segment's kind ({@link STATIC}, {@link PARAM}, {@link UNKNOWN}). */
  kinds: number[];
  /** Each literal segment's text (lower-cased when matching ignores case); `""` otherwise. */
  values: string[];
  /** Whether a literal segment holds non-ASCII text, which case folding cannot compare safely. */
  nonAscii: boolean[];
  /** Every segment is a literal or a whole-segment param, so the segment count is exact. */
  plain: boolean;
  /** `use()` middleware: a prefix match rather than an exact one. */
  prefix: boolean;
  /** Whether the route matches case-sensitively (its own `caseSensitive`). */
  caseSensitive: boolean;
}

/** `pattern`'s segments, after dropping one trailing slash. `"/"` has none. */
function splitPattern(pattern: string): string[] {
  const trimmed =
    pattern.length > 1 && pattern.endsWith("/")
      ? pattern.slice(0, -1)
      : pattern;
  return trimmed === "/" || trimmed === "" ? [] : trimmed.slice(1).split("/");
}

/**
 * A concrete request path's segments, every one a literal (empty ones kept).
 * One trailing slash is dropped, as every routejs pattern tolerates one.
 */
export function splitRequestPath(path: string): string[] {
  return splitPattern(path);
}

/** The kind of one pattern segment. */
function segmentKind(segment: string): number {
  if (WHOLE_PARAM.test(segment)) {
    return PARAM;
  }
  // An empty segment (`//`) is left to the regex too: it is never ruled out.
  return segment === "" || ROUTEJS_SYNTAX.test(segment) ? UNKNOWN : STATIC;
}

/** Pre-parses one route; see {@link CompiledRoute}. */
function compileRoute(route: Route): CompiledRoute {
  const prefix = route.path === null || route.path === undefined;
  const pattern = (prefix ? route.group : route.path) ?? "/";
  const caseSensitive = route.caseSensitive === true;
  // A pattern not starting with "/" is one unknown segment: never ruled out.
  const segments = pattern.startsWith("/") ? splitPattern(pattern) : [""];

  const kinds = segments.map(segmentKind);
  const nonAscii = segments.map((segment) => NON_ASCII.test(segment));
  const values = segments.map((segment, i) =>
    kinds[i] !== STATIC
      ? ""
      : caseSensitive || nonAscii[i]
        ? segment
        : segment.toLowerCase(),
  );
  return {
    kinds,
    values,
    nonAscii,
    plain: !kinds.includes(UNKNOWN),
    prefix,
    caseSensitive,
  };
}

/**
 * Whether `route` can never match the request path `segments`.
 *
 * Deliberately weak: only a literal-versus-literal mismatch at an aligned
 * segment, or an impossible segment count for a pattern of literals and
 * whole-segment params, proves it. The first segment that is anything else
 * (a wildcard, a regex, an optional param) stops the comparison and keeps the
 * route, because from there segments may no longer line up.
 */
function isDisjoint(route: CompiledRoute, segments: string[]): boolean {
  const { kinds } = route;
  const count = Math.min(kinds.length, segments.length);
  for (let i = 0; i < count; i++) {
    const kind = kinds[i];
    if (kind === UNKNOWN) {
      return false;
    }
    if (kind === STATIC) {
      const expected = route.values[i];
      const segment = segments[i];
      if (route.caseSensitive) {
        if (expected !== segment) {
          return true;
        }
      } else if (expected !== segment && expected !== segment.toLowerCase()) {
        // A regex with the `i` flag (and no `u`) folds ASCII letters only
        // against ASCII letters, which lower-casing reproduces exactly. With
        // non-ASCII text on either side the two can disagree (`σ` and `ς`
        // fold together), so such a segment never rules the route out.
        if (route.nonAscii[i] || NON_ASCII.test(segment)) {
          continue;
        }
        return true;
      }
    }
  }
  if (!route.plain) {
    return false;
  }
  // A prefix needs at least its own segments; an exact pattern, exactly them.
  return route.prefix
    ? kinds.length > segments.length
    : kinds.length !== segments.length;
}

/**
 * The routes that may match a request path, as indices into the route table,
 * in registration order — a superset of the routes that do.
 *
 * Routes are bucketed by their first path segment (lower-cased). A route whose
 * first segment is not a plain ASCII literal (a param, a pattern, or no
 * segment at all, as global middleware has) is consulted by every request. A
 * request's candidates are its bucket merged with that list in registration
 * order, minus the routes {@link isDisjoint} rules out.
 *
 * Rebuilt lazily when the table it was built from changes length or identity,
 * or after {@link invalidate}.
 */
export class RouteCandidateIndex {
  /** The table the index was built from; `undefined` until the first build. */
  #table: Route[] | undefined = undefined;
  /** The table's length at the build, so a pushed route triggers a rebuild. */
  #builtLength = -1;
  /** Each route, pre-parsed, by table index. */
  #compiled: CompiledRoute[] = [];
  /** Indices of routes whose first segment is a given lower-cased literal, ascending. */
  #buckets = new Map<string, number[]>();
  /** Indices of routes every request consults, ascending. */
  #everywhere: number[] = [];

  /** Drops the index; the next lookup rebuilds it. */
  invalidate(): void {
    this.#table = undefined;
    this.#builtLength = -1;
  }

  /** Builds the index over `routes`. */
  #build(routes: Route[]): void {
    this.#table = routes;
    this.#builtLength = routes.length;
    this.#compiled = routes.map(compileRoute);
    this.#buckets = new Map();
    this.#everywhere = [];
    for (let index = 0; index < this.#compiled.length; index++) {
      const compiled = this.#compiled[index];
      if (
        compiled.kinds.length > 0 &&
        compiled.kinds[0] === STATIC &&
        !compiled.nonAscii[0]
      ) {
        const key = compiled.caseSensitive
          ? compiled.values[0].toLowerCase()
          : compiled.values[0];
        let bucket = this.#buckets.get(key);
        if (bucket === undefined) {
          bucket = [];
          this.#buckets.set(key, bucket);
        }
        bucket.push(index);
      } else {
        this.#everywhere.push(index);
      }
    }
  }

  /**
   * Indices into `routes` of every route that may match `requestPath` (the
   * path part of the request target, as the router matches it), ascending.
   */
  candidates(routes: Route[], requestPath: string): number[] {
    if (routes !== this.#table || routes.length !== this.#builtLength) {
      this.#build(routes);
    }
    const segments = splitRequestPath(requestPath);
    // Only the first segment is looked up; the rest are lower-cased only
    // where a case-insensitive literal is compared (see isDisjoint).
    const bucket =
      (segments.length > 0
        ? this.#buckets.get(segments[0].toLowerCase())
        : undefined) ?? NO_ROUTES;
    const everywhere = this.#everywhere;
    const compiled = this.#compiled;

    const out: number[] = [];
    let i = 0;
    let j = 0;
    while (i < bucket.length || j < everywhere.length) {
      const index =
        j >= everywhere.length ||
        (i < bucket.length && bucket[i] < everywhere[j])
          ? bucket[i++]
          : everywhere[j++];
      if (!isDisjoint(compiled[index], segments)) {
        out.push(index);
      }
    }
    return out;
  }
}

/** Lookups per admission window (see {@link FifoCache}). */
export const ADMISSION_WINDOW = 4096;

/**
 * The hit ratio under which a window turns full admission off. A path
 * cache that hits less than this costs more to fill than it saves.
 */
export const ADMISSION_MIN_HIT_RATIO = 0.25;

/** While admission is off, one new key in this many is still stored. */
export const ADMISSION_SAMPLE = 64;

/**
 * A bounded map with first-in-first-out eviction in O(1).
 *
 * `Map` alone evicts its oldest entry with `map.delete(map.keys().next().value)`,
 * which is O(entries deleted so far) in both JavaScriptCore and V8: an
 * insertion-ordered `Map` keeps deleted slots until it rehashes, and
 * `keys().next()` walks past them — ~18 µs per insert at 50,000 entries. This
 * keeps the same policy (exact FIFO, at most `max` entries) but names the
 * oldest key from a ring buffer, so eviction is one `Map.delete`.
 *
 * It has no per-key `delete`: the router never removes a single entry, and
 * one would leave a stale ring slot behind. {@link clear} drops everything.
 *
 * With `admission`, it stops paying for entries nobody reads again: it
 * counts lookups ({@link get}) and hits over windows of
 * {@link ADMISSION_WINDOW}, and while the last window's hit ratio is under
 * {@link ADMISSION_MIN_HIT_RATIO}, {@link set} stores only one new key in
 * {@link ADMISSION_SAMPLE} — enough for a working set that returns to raise
 * the ratio and turn full admission back on. Counters only, no per-key state:
 * a "seen before" set costs a lookup on every miss, which is what admission
 * is there to save. What is cached never changes a result, only its cost.
 */
export class FifoCache<V> {
  /** Whether {@link set} is throttled by the hit ratio (see the class). */
  readonly #admission: boolean;
  /** Lookups in the current window. */
  #lookups = 0;
  /** Hits in the current window. */
  #hits = 0;
  /** Whether new keys are all stored: the last window's ratio was high enough. */
  #admitting = true;
  /** New keys offered while not admitting; every {@link ADMISSION_SAMPLE}th is stored. */
  #offered = 0;
  /** The entries. */
  #map = new Map<string, V>();
  /**
   * Keys in insertion order. It grows to `max` and is then reused as a ring,
   * with the oldest key at {@link #head} — so an unused cache costs nothing.
   */
  #ring: string[] = [];
  /** Once the ring is full, the slot the next insertion takes: the oldest key. */
  #head = 0;

  constructor(
    /** The most entries held; a positive integer. */
    private readonly max: number,
    /** Options; see {@link FifoCacheOptions}. */
    options?: FifoCacheOptions,
  ) {
    this.#admission = options?.admission === true;
  }

  /**
   * Whether new keys are all being stored: always without `admission`; with
   * it, while the last window's hit ratio was at least
   * {@link ADMISSION_MIN_HIT_RATIO}.
   */
  get admitting(): boolean {
    return this.#admitting;
  }

  /** The number of entries held. */
  get size(): number {
    return this.#map.size;
  }

  /** The entry for `key`, or `undefined`. Counted as a lookup for admission. */
  get(key: string): V | undefined {
    const value = this.#map.get(key);
    if (this.#admission) {
      if (value !== undefined) {
        this.#hits++;
      }
      if (++this.#lookups === ADMISSION_WINDOW) {
        this.#admitting =
          this.#hits >= ADMISSION_WINDOW * ADMISSION_MIN_HIT_RATIO;
        this.#lookups = 0;
        this.#hits = 0;
      }
    }
    return value;
  }

  /**
   * Stores an entry, evicting the oldest when full. Replacing an existing key
   * keeps its place in the eviction order, as `Map#set` keeps its position.
   */
  set(key: string, value: V): this {
    const map = this.#map;
    if (map.has(key)) {
      map.set(key, value);
      return this;
    }
    // Admission off: store one new key in ADMISSION_SAMPLE.
    if (!this.#admitting && this.#offered++ % ADMISSION_SAMPLE !== 0) {
      return this;
    }
    const ring = this.#ring;
    if (ring.length < this.max) {
      ring.push(key);
    } else {
      map.delete(ring[this.#head]);
      ring[this.#head] = key;
      this.#head = (this.#head + 1) % this.max;
    }
    map.set(key, value);
    return this;
  }

  /** Removes every entry, and starts admission afresh. */
  clear(): void {
    this.#map.clear();
    this.#ring = [];
    this.#head = 0;
    this.#lookups = 0;
    this.#hits = 0;
    this.#admitting = true;
    this.#offered = 0;
  }
}

/** Options for {@link FifoCache}. */
export interface FifoCacheOptions {
  /**
   * Throttle insertions while the hit ratio is low (see {@link FifoCache}).
   * Default `false`: every key is stored.
   */
  admission?: boolean;
}
