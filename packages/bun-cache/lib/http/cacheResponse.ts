/**
 * `cacheResponse(cache, options)` (plan §9.1–§9.3, §9.5): a response
 * cache for bun-common's `BunRouter`, and so for both HTTP adapters.
 *
 * A hit answers from the cache and does not call `next()`. A miss hands on
 * and captures what the handler produced with a response transform
 * registered first (§9.7), storing it when RFC 9111 §3 allows. Identical
 * misses are coalesced through the core's single-flight (`getOrSet`), which
 * also gives the write its tag fence (§3.6): an invalidation that lands
 * while the handler runs drops the write rather than resurrecting the old
 * response.
 *
 * Past its freshness, an entry is served stale (§9.4) inside the windows the
 * route or the response gave (RFC 5861): inside stale-while-revalidate it is
 * answered `STALE` at once while one background replay of the request,
 * through the router's socket-free `fetch()`, refreshes it; inside
 * stale-if-error it answers a miss whose handler fails (a 5xx, or no answer
 * within `hardTimeout`). A streamed response can be stored with
 * `streams: { buffer }`.
 */
import type {
  BunRequest,
  BunResponse,
  NextFunction,
  ParsedCacheControl,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import {
  createDeferred,
  etag as etagOf,
  parseCacheControl,
} from "@kingsleyweb/bun-common";
import type { Cache, CacheLoaderContext, GetOrSetOptions } from "../core/types";
import type { TappedBody } from "./capture";
import {
  answerConditional,
  captureBody,
  maskConditional,
  snapshotHeaders,
  tapStream,
  withHeader,
} from "./capture";
import type { Frame, StoredResponse } from "./frame";
import {
  decodeFrame,
  encodeResponse,
  encodeUncacheable,
  encodeVary,
} from "./frame";
import type { Target } from "./key";
import {
  baseKey,
  headerValues,
  hostOf,
  pathTag,
  splitTarget,
  targetOf,
  variantKey,
} from "./key";
import type { PresetHeaders, Refusal, StoreDecision } from "./policy";
import { decideStore } from "./policy";
import { drain, replayIdOf, replayRequest } from "./replay";
import { responseTags } from "./tags";

/**
 * The statuses stored by default: those RFC 9110 §15.1 defines as
 * heuristically cacheable.
 */
const DEFAULT_STATUSES = [
  200, 203, 204, 300, 301, 308, 404, 405, 410, 414, 501,
] as const;

/** The methods whose 2xx/3xx answer invalidates the target (RFC 9111 §4.4). */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** How long a coalesced follower waits for the leader by default, in ms. */
const DEFAULT_WAIT = 10_000;
/** How long a key stays uncacheable (hit-for-miss) by default, in ms. */
const DEFAULT_UNCACHEABLE_TTL = 30_000;
/**
 * After a failed replay, how long before the key's next one, in ms: the
 * core's `failSafeBackoff` default, so a failing origin sees one replay per
 * key per 10 s instead of one per stale answer.
 */
const REPLAY_BACKOFF = 10_000;
/** The most keys an in-process key set (replay backoff, refresh-next) holds before it is cleared. */
const MAX_TRACKED_KEYS = 10_000;

/** Whether `status` is an origin error, which stale-if-error answers for (RFC 5861 §4: 500, 502, 503, 504; here every 5xx). */
function isErrorStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

/** Adds `key` to `set`, clearing the set first when it is full. */
function track(set: Set<string>, key: string): void {
  if (set.size >= MAX_TRACKED_KEYS) {
    set.clear();
  }
  set.add(key);
}

/**
 * The `X-Cache` values (plan §21): `HIT` fresh from the cache; `MISS` run
 * and stored; `STALE` past its freshness, inside a stale window; `BYPASS`
 * not looked up; `UNCACHEABLE` run and not stored.
 */
export type CacheStatus = "HIT" | "MISS" | "STALE" | "BYPASS" | "UNCACHEABLE";

/** `cacheResponse()`'s options (plan §9.1). Durations are in ms. */
export interface CacheResponseOptions {
  /**
   * How long a stored response stays fresh: a number of **ms**, which
   * overrides every freshness header (not the refusals: `no-store`,
   * `private` and the rest still apply); or `"headers"`, which reads
   * `Surrogate-Control: max-age`, then `s-maxage`, then `max-age`, then
   * `Expires` (Fastly's precedence) less the response's own `Age`, and does
   * not store a response that has none; or `"headers-or-cache"`, which reads
   * the same headers and, for a response that has none, falls back to the
   * cache's own TTL (`createCache`'s `ttl`: a number, a function of the
   * value, or `null`, never stale) instead of not storing it. Defaults to
   * `"headers"`, so a route caches what its `Cache-Control` (bun-common's
   * `cacheControl()`) says.
   */
  ttl?: number | "headers" | "headers-or-cache";
  /**
   * Tags for every entry this route stores, beside the path's own tag and
   * any `addCacheTags()` added: a list, or a function of the request and
   * response, called when the response is captured (so `req.params` is the
   * route's). `cache.invalidateTags([tag])` drops them.
   */
  tags?:
    | readonly string[]
    | ((req: BunRequest, res: BunResponse) => readonly string[]);
  /**
   * Request headers whose values are part of the key, besides the ones the
   * response's own `Vary` names (those are learned per URL). Case
   * insensitive. Defaults to none.
   */
  varyBy?: readonly string[];
  /**
   * The query string in the key: `"all"` (sorted by name), only the names
   * listed, or `false` to ignore it. Defaults to `"all"`.
   */
  query?: "all" | readonly string[] | false;
  /** Whether the host is part of the key (and of the path tag). Defaults to `false`, for single-host apps. */
  host?: boolean;
  /**
   * The key, from the request, in place of host, path, query and `varyBy`
   * (the response's `Vary` still applies). A key function also lifts the
   * `Authorization` rule: it is taken to include the requester's identity.
   */
  key?: (req: BunRequest) => string;
  /** Requests for which the cache is skipped entirely, answered `BYPASS`: no read, no store. */
  bypass?: (req: BunRequest) => boolean;
  /**
   * The response header carrying the {@link CacheStatus}; `false` sends
   * none. Never stored. Defaults to `"X-Cache"`.
   */
  statusHeader?: string | false;
  /**
   * Whether the request's `Cache-Control` counts: `no-store` bypasses,
   * `no-cache` (or `Pragma: no-cache` without `Cache-Control`) and a
   * `max-age` the stored response is older than run the handler and store
   * its answer, `min-fresh` asks for that much freshness left, and
   * `only-if-cached` answers 504 on a miss (RFC 9111 §5.2.1). Defaults to
   * `false`: ignored, as CDNs do, so no client can push its load onto the
   * origin.
   */
  honorRequest?: boolean;
  /**
   * Whether a response that sets a cookie is stored, cookie included, and
   * replayed to every hit. Cookies set by middleware ahead of the cache are
   * never stored either way. Defaults to `false`.
   */
  allowSetCookie?: boolean;
  /** The statuses that are stored. Defaults to RFC 9110's heuristically cacheable set: 200, 203, 204, 300, 301, 308, 404, 405, 410, 414, 501. */
  statuses?: readonly number[];
  /** Response headers never stored (case insensitive), beside the hop-by-hop ones, `Content-Length`, `Age` and `Set-Cookie`. */
  omitHeaders?: readonly string[];
  /**
   * Whether a `POST`, `PUT`, `PATCH` or `DELETE` through the middleware that
   * gets a 2xx or 3xx drops every stored entry for its path (and for a
   * same-host `Location` or `Content-Location`), all queries and variants
   * (RFC 9111 §4.4). Defaults to `true`.
   */
  invalidateOnUnsafe?: boolean;
  /**
   * Whether identical misses share one handler run (§9.5): the first runs
   * it, the rest wait for its stored entry. `wait` caps that wait, in ms
   * (default 10 s); after it a follower runs the handler itself. A leader
   * whose answer bypasses the response transforms (an unhandled error, the
   * adapter's bare 404) holds its followers that long. Defaults to `true`.
   */
  coalesce?:
    | boolean
    | {
        /** How long a follower waits for the leader, in ms. Defaults to 10 s. */
        wait?: number;
      };
  /**
   * After a response that may not be stored (`private`, a cookie, a 5xx…),
   * how long its key skips coalescing, so its requests run side by side
   * instead of queueing behind one handler (Varnish's hit-for-miss). A
   * storable response replaces the marker at once. `0` disables. Defaults
   * to 30 s.
   */
  uncacheableTtl?: number;
  /**
   * Whether a stored response with no `ETag` gets one computed from its
   * body (bun-common's `etag()`), so every hit can answer a conditional
   * request with 304. Defaults to `true`.
   */
  etag?: boolean;
  /**
   * The stale-while-revalidate window, in ms: once an entry is past its
   * freshness, it is answered `STALE` for this long while one background
   * replay (`revalidate`) refreshes it. In place of the response's
   * `stale-while-revalidate=` (RFC 5861 §3), which applies when this is not
   * set. Never under `must-revalidate` or `proxy-revalidate`. Defaults to
   * the response's, or 0.
   */
  staleWhileRevalidate?: number;
  /**
   * The stale-if-error window, in ms: once an entry is past its freshness,
   * a miss whose handler answers 5xx (an error handler's answer counts; an
   * unhandled error, answered outside the pipeline, does not) or does not
   * answer within `hardTimeout` gets the stale entry instead, `STALE`, and
   * the entry is kept. In place of the response's `stale-if-error=`
   * (RFC 5861 §4); the same rule. Defaults to the response's, or 0.
   */
  staleIfError?: number;
  /**
   * With a stale entry inside its stale-if-error window, how long a miss
   * waits for the handler before answering stale, in ms; the handler's late
   * answer is dropped (and not stored). Also caps a background replay.
   * Defaults to none: the handler is waited for.
   */
  hardTimeout?: number;
  /**
   * What a stale-while-revalidate refresh replays the request through: the
   * outermost router or adapter the route is on (a `BunRouter`, either
   * `BunHttpAdapter`), whose `fetch()` runs the whole pipeline without a
   * socket, so the replay routes as the request did. The replay is a `GET`
   * of the same URL carrying only the headers the key reads (`varyBy` and
   * the response's `Vary`), and an internal `x-bun-cache-revalidate` token
   * no client can forge. Without it, a stale entry is answered once, and the
   * next request for it refreshes it (waiting for the handler).
   */
  revalidate?: {
    /** Runs a request through the pipeline: `BunRouter.fetch()` or an adapter's. */
    fetch: (request: Request) => Promise<Response>;
  };
  /**
   * Streamed responses: `"skip"` does not store them; `{ buffer: maxBytes }`
   * copies the stream as it is sent, without delaying its first byte, and
   * stores it when it ends within `maxBytes` (the cache's `maxEntryBytes`
   * still applies). `text/event-stream` is never stored. Coalesced
   * followers wait for the stream to end. Defaults to `"skip"`.
   */
  streams?:
    | "skip"
    | {
        /** The most bytes a stream may come to and still be stored. */
        buffer: number;
      };
}

/**
 * What `cacheResponse()` returns: a router middleware with `invalidate()`.
 *
 * Put it **before** `validate()`: between `validate()` and the handler it
 * takes the validator's typed slot, and the handler's validated `req.query`
 * and `req.body` fall back to the untyped defaults. The plan's slot brand
 * (`__shape?: never`, §9.6) is not applied: with bun-common's verb
 * overloads it also makes `res` and `req.query` unusable in the ordinary
 * `router.get(path, pages, handler)` (see `__tests__/http.type-test.ts`).
 */
export type CacheResponseMiddleware = RouterHandler & {
  /**
   * Drops every entry stored for a path — all queries, all variants —
   * through the path's own tag. Takes a path (`"/posts/7"`), an absolute
   * URL, a `Request` or a `BunRequest`; with `host: true` it needs the host,
   * so a bare path throws a `TypeError`. Resolves once the entries are
   * dropped; writes this middleware still had in flight for the path are
   * dropped again, in the background, once they land.
   */
  invalidate: (target: string | Request | BunRequest) => Promise<void>;
};

/** A request's directives under `honorRequest`. */
interface RequestDirectives {
  /** Skip the cache. */
  bypass: boolean;
  /** Run the handler and store, without reading. */
  revalidate: boolean;
  /** The parsed header, for `max-age`, `min-fresh` and `only-if-cached`. */
  parsed: ParsedCacheControl;
}

/** What a capture reports once the response is known. */
type Outcome =
  | {
      /** Storable. */
      ok: true;
      /** The decision. */
      decision: StoreDecision;
      /** The stored form. */
      response: StoredResponse;
      /** Every tag the entry carries. */
      tags: string[];
    }
  | {
      /** Not storable. */
      ok: false;
      /** Why; `undefined` when the capture itself failed (a throwing `tags` function, an unreadable body, a buffered stream that failed). */
      reason: Refusal | undefined;
      /** The status the pipeline produced. */
      status: number;
      /** Whether the capture answered the stale entry in its place (stale-if-error). */
      servedStale: boolean;
    };

/** Whether a refused outcome is a failure, after which a stale entry is kept: an error status, or a capture that failed. */
function isFailure(outcome: Extract<Outcome, { ok: false }>): boolean {
  return (
    outcome.servedStale ||
    outcome.reason === undefined ||
    isErrorStatus(outcome.status)
  );
}

/** A request being served, with what every path needs. */
interface Exchange {
  /** The request. */
  req: BunRequest;
  /** The response. */
  res: BunResponse;
  /** The pipeline's `next`. */
  next: NextFunction;
  /** The base key. */
  base: string;
  /** The path's tag. */
  tag: string;
  /** Whether the request carries `Authorization` and the key does not vary on identity. */
  anonymousOnly: boolean;
}

/** The variant a key belongs to: the base key's vary record's headers and this request's values. */
interface Variant {
  /** The header names. */
  vary: string[];
  /** This request's values. */
  values: string[];
}

/** A stale entry a request found: past its freshness, inside the core's hard expiry (freshness plus the longer window). */
interface StaleEntry {
  /** The base key of the request. */
  base: string;
  /** The key the entry is stored at: the base key, or a variant key. */
  key: string;
  /** The variant, when `key` is a variant key. */
  variant: Variant | undefined;
  /** The request headers the response varies on (its vary record's), which a replay carries. */
  vary: readonly string[];
  /** The stored response. */
  response: StoredResponse;
  /** The frame at `key`, carrying the entry's `freshUntil` (re-encoded when the stored one differs): what coalesced followers decode. Never written back. */
  frame: Uint8Array;
  /** When it stopped being fresh (the core entry's `freshUntil`), epoch ms; the windows count from here. */
  freshUntil: number;
}

/** A running capture's state. */
interface CaptureHandle {
  /** Set once the transform has run: the pipeline produced a response on this `res`. */
  transformed: boolean;
  /** Set to give the capture up: the transform then passes the response through (answering a conditional request) and reports nothing. */
  abandoned: boolean;
  /** Called when the transform runs. */
  onTransformed: (() => void) | undefined;
}

/** A background replay a middleware is waiting on, by its id. */
interface Replay {
  /** The base key the replayed request must produce. */
  base: string;
  /** The key it refreshes. */
  key: string;
  /** The variant, when `key` is a variant key. */
  variant: Variant | undefined;
  /** The replayed request's exchange, once it arrives. */
  exchange: Exchange | undefined;
  /** The replayed request's capture, once it arrives. */
  handle: CaptureHandle | undefined;
  /** Reports the capture's outcome; `undefined` when the replay produced nothing to store. */
  settle: (outcome: Outcome | undefined) => void;
}

/** The core options of every `getOrSet` the middleware makes: the core's own staleness machinery off, since a background refresh there would call the loader with no request to run. `ttl`, `tags` and the windows are filled by the loader before it resolves. */
function loadOptions(): GetOrSetOptions {
  return {
    staleWhileRevalidate: 0,
    staleIfError: 0,
    softTimeout: 0,
    hardTimeout: 0,
    refreshAhead: 0,
    earlyExpiry: { beta: 0 },
    cacheUndefined: false,
  };
}

/** Whether two string lists are equal, element by element. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Reads the request directives `honorRequest` honours (RFC 9111 §5.2.1, §5.4). */
function requestDirectives(req: BunRequest): RequestDirectives {
  const header = req.getHeader("cache-control");
  const parsed = parseCacheControl(header);
  const pragmaNoCache =
    header === null &&
    /(?:^|,)\s*no-cache\s*(?:,|$)/i.test(req.getHeader("pragma") ?? "");
  return {
    bypass: parsed.noStore === true,
    revalidate:
      parsed.noCache !== undefined || pragmaNoCache || parsed.maxAge === 0,
    parsed,
  };
}

/** Validates a duration option: a finite number, `0` or more. */
function duration(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `cacheResponse(): ${name} must be a finite number of ms, 0 or more`,
    );
  }
  return value;
}

/**
 * A response cache for a `BunRouter` route or subtree (plan §9.1):
 *
 * ```ts
 * import { cacheResponse, addCacheTags } from "@kingsleyweb/bun-cache/http";
 *
 * const pages = cacheResponse(cache, { ttl: 60_000, varyBy: ["accept-language"] });
 * router.get("/posts/:id", pages, validate({ params: PostParams }), handler);
 * router.use("/blog", pages);
 * ```
 *
 * Place it **before** `validate()` and before nothing that must run on every
 * request: a hit answers without calling `next()`, so later middleware and
 * the handler do not run. Register `compression()` ahead of it: hits are
 * then compressed, and misses captured uncompressed. In Nest, guards do not
 * run before router middleware: cache behind a guard with the interceptor.
 *
 * The cache's codec must keep bytes: `"structured"` (the default) or
 * `"raw"`. A response is stored as one framed `Uint8Array`.
 */
export function cacheResponse(
  cache: Cache,
  options: CacheResponseOptions = {},
): CacheResponseMiddleware {
  const ttl = options.ttl ?? "headers";
  if (ttl !== "headers" && ttl !== "headers-or-cache") {
    duration("ttl", ttl);
  }
  const statusHeader =
    options.statusHeader === undefined ? "X-Cache" : options.statusHeader;
  if (
    statusHeader !== false &&
    (typeof statusHeader !== "string" || statusHeader === "")
  ) {
    throw new TypeError(
      "cacheResponse(): statusHeader must be a header name or false",
    );
  }
  const statusHeaderName =
    statusHeader === false ? undefined : statusHeader.toLowerCase();
  const varyBy = [
    ...new Set((options.varyBy ?? []).map((name) => name.toLowerCase())),
  ].sort();
  const queryOption = options.query ?? "all";
  const keyHost = options.host === true;
  const keyFn = options.key;
  const identityKeyed = keyFn !== undefined || varyBy.includes("authorization");
  const statuses = new Set<number>(options.statuses ?? DEFAULT_STATUSES);
  const omitHeaders = new Set(
    (options.omitHeaders ?? []).map((name) => name.toLowerCase()),
  );
  const coalesce = options.coalesce ?? true;
  const wait =
    typeof coalesce === "object"
      ? duration("coalesce.wait", coalesce.wait ?? DEFAULT_WAIT)
      : DEFAULT_WAIT;
  const coalescing = coalesce !== false;
  const uncacheableTtl = duration(
    "uncacheableTtl",
    options.uncacheableTtl ?? DEFAULT_UNCACHEABLE_TTL,
  );
  const computeEtag = options.etag ?? true;
  const invalidateOnUnsafe = options.invalidateOnUnsafe ?? true;
  const honorRequest = options.honorRequest ?? false;
  const routeSwr =
    options.staleWhileRevalidate === undefined
      ? undefined
      : duration("staleWhileRevalidate", options.staleWhileRevalidate);
  const routeSie =
    options.staleIfError === undefined
      ? undefined
      : duration("staleIfError", options.staleIfError);
  const hardTimeout =
    options.hardTimeout === undefined || options.hardTimeout === 0
      ? undefined
      : duration("hardTimeout", options.hardTimeout);
  const revalidate = options.revalidate;
  if (
    revalidate !== undefined &&
    (typeof revalidate !== "object" ||
      revalidate === null ||
      typeof revalidate.fetch !== "function")
  ) {
    throw new TypeError(
      "cacheResponse(): revalidate must be a router or adapter (an object with fetch())",
    );
  }
  const streams = options.streams ?? "skip";
  let streamBuffer: number | undefined;
  if (streams !== "skip") {
    if (
      typeof streams !== "object" ||
      streams === null ||
      typeof streams.buffer !== "number" ||
      !Number.isFinite(streams.buffer) ||
      streams.buffer <= 0
    ) {
      throw new TypeError(
        'cacheResponse(): streams must be "skip" or { buffer: bytes } with a positive buffer',
      );
    }
    streamBuffer = streams.buffer;
  }
  /** How long a background replay may take before it counts as failed, in ms. */
  const replayBudget = Math.min(wait, hardTimeout ?? Number.POSITIVE_INFINITY);

  /** Keys being refreshed by a background replay now: one replay per key. */
  const revalidating = new Set<string>();
  /** Keys whose last replay failed, and when the next may start (epoch ms). */
  const replayBackoff = new Map<string, number>();
  /** Without `revalidate`: keys answered stale once, whose next request refreshes them. */
  const refreshNext = new Set<string>();
  /** The background replays waiting on their request, by id. */
  const replays = new Map<string, Replay>();

  /** Invalidations started by this middleware and not finished, by tag: a GET for the path waits for them. */
  const pending = new Map<string, Promise<void>>();

  /**
   * The writes this middleware has in flight, by the path's tag: a capture's,
   * from the moment its transform runs until what it stores (an entry, a
   * marker, or nothing) is written — at most `wait`. An invalidation of the
   * path runs again once they have settled: a plain `set` (an uncoalesced
   * miss) is fenced only against invalidations after it was issued, and a
   * streamed body's is issued when the stream ends, so without the second
   * pass it could put back what the invalidation just dropped.
   */
  const writing = new Map<string, Set<Promise<void>>>();

  /** Tracks `settled`, a capture's write, under `tag` until it settles or `wait` passes. */
  const trackWrite = (tag: string, settled: Promise<void>): void => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capped = Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, wait);
        timer.unref?.();
      }),
    ]).finally(() => {
      clearTimeout(timer);
    });
    let writes = writing.get(tag);
    if (writes === undefined) {
      writes = new Set();
      writing.set(tag, writes);
    }
    const own = writes;
    own.add(capped);
    void capped.then(() => {
      own.delete(capped);
      if (own.size === 0 && writing.get(tag) === own) {
        writing.delete(tag);
      }
    });
  };

  /**
   * Invalidates `tags`, tracked in {@link pending} until it settles; and
   * again, in the background, once the writes in flight under them have
   * settled (see {@link writing}). The caller waits for the first pass only.
   */
  const invalidateTracked = (tags: readonly string[]): Promise<void> => {
    const inflight: Promise<void>[] = [];
    for (const tag of tags) {
      for (const write of writing.get(tag) ?? []) {
        inflight.push(write);
      }
    }
    const done = cache.invalidateTags(tags).catch(() => {
      // The failure policy has reported it (an `error` event); a strict
      // cache's throw must not become an unhandled rejection here.
    });
    if (inflight.length > 0) {
      void Promise.all([done, ...inflight])
        .then(async () => {
          await cache.invalidateTags(tags);
        })
        .catch(() => {
          // Reported by the failure policy, as above.
        });
    }
    for (const tag of tags) {
      pending.set(tag, done);
    }
    void done.finally(() => {
      for (const tag of tags) {
        if (pending.get(tag) === done) {
          pending.delete(tag);
        }
      }
    });
    return done;
  };

  /** Sets the status header on `res`, when there is one. */
  const markStatus = (res: BunResponse, status: CacheStatus): void => {
    if (statusHeader !== false) {
      res.setHeader(statusHeader, status);
    }
  };

  /** A stored response's `Age` at `now`, in seconds: its own when stored plus its time in the cache (RFC 9111 §4.2.3). */
  const ageOf = (stored: StoredResponse, now: number): number =>
    stored.meta.age +
    Math.max(0, Math.floor((now - stored.meta.storedAt) / 1000));

  /** Whether `entry` is inside its stale-while-revalidate window at `now`. */
  const withinSwr = (entry: StaleEntry, now: number): boolean => {
    const window = entry.response.meta.staleWhileRevalidate;
    return window > 0 && now <= entry.freshUntil + window;
  };

  /** Whether `entry` is inside its stale-if-error window at `now`. */
  const withinSie = (entry: StaleEntry, now: number): boolean => {
    const window = entry.response.meta.staleIfError;
    return window > 0 && now <= entry.freshUntil + window;
  };

  /**
   * A stored response as a native `Response`, marked `STALE`: what the
   * transform answers in place of `failed`, a 5xx. The headers middleware
   * ahead of the cache set (`preset`, still on `failed` unchanged) are kept,
   * as a hit through `res` keeps them.
   */
  const staleAnswer = (
    stored: StoredResponse,
    now: number,
    failed: Response,
    preset: PresetHeaders,
  ): Response => {
    const { meta, body } = stored;
    const headers = new Headers();
    for (const [name, value] of preset) {
      if (name === "set-cookie") {
        for (const line of failed.headers.getSetCookie()) {
          if (value.includes(line)) {
            headers.append(name, line);
          }
        }
      } else if (
        typeof value === "string" &&
        failed.headers.get(name) === value
      ) {
        headers.set(name, value);
      }
    }
    const storedCookies = meta.headers.some(([name]) => name === "set-cookie");
    if (storedCookies) {
      headers.delete("set-cookie");
    }
    for (const [name, value] of meta.headers) {
      if (name === "set-cookie") {
        headers.append(name, value);
      } else {
        headers.set(name, value);
      }
    }
    headers.set("age", String(ageOf(stored, now)));
    if (statusHeader !== false) {
      headers.set(statusHeader, "STALE");
    }
    return new Response(body.byteLength === 0 ? null : body, {
      status: meta.status,
      statusText: meta.statusText,
      headers,
    });
  };

  /** The tags of an entry: the path's, the route's and the handler's. */
  const tagsFor = (exchange: Exchange): string[] => {
    const tags = new Set<string>([exchange.tag]);
    const own = options.tags;
    if (own !== undefined) {
      for (const tag of typeof own === "function"
        ? own(exchange.req, exchange.res)
        : own) {
        tags.add(tag);
      }
    }
    for (const tag of responseTags(exchange.res)) {
      tags.add(tag);
    }
    return [...tags];
  };

  /**
   * Captures the response the rest of the pipeline produces on
   * `exchange.res`, and reports it through `onOutcome` (once). Registers
   * the transform first (§9.7); records the headers set so far; masks a
   * conditional request so the full response is produced, and answers its
   * 304 here. With `stale`, a 5xx inside its stale-if-error window is
   * answered with the stale entry instead (§9.4). With `streams: { buffer }`,
   * a streamed body is swapped for a copying tap, whose end reaches the
   * client only once the promise `onOutcome` returns has settled (at most
   * `wait`): return the write, so a request after the end finds it.
   */
  const capture = (
    exchange: Exchange,
    onOutcome: (outcome: Outcome) => Promise<unknown> | undefined,
    stale?: StaleEntry,
  ): CaptureHandle => {
    const { req, res } = exchange;
    /** Settles once the outcome has been reported and what `onOutcome` returned has settled. */
    const handled = createDeferred<void>();
    const report = (outcome: Outcome): void => {
      let done: Promise<unknown> | undefined;
      try {
        done = onOutcome(outcome);
      } catch {
        done = undefined;
      }
      void Promise.resolve(done).then(
        () => handled.resolve(),
        () => handled.resolve(),
      );
    };
    /** What a tapped stream's end waits for: the outcome handled, or `wait`. */
    const beforeClose = async (): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        handled.promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, wait);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    };
    const handle: CaptureHandle = {
      transformed: false,
      abandoned: false,
      onTransformed: undefined,
    };
    const preset: PresetHeaders = snapshotHeaders(res);
    const conditional = maskConditional(req);
    res.addResponseTransform(
      {
        transform: (response, context) => {
          handle.transformed = true;
          handle.onTransformed?.();
          if (handle.abandoned) {
            // Given up (the hard timeout answered stale): this is that
            // answer, or a late one bun-common already refuses to send.
            return conditional ? answerConditional(req, response) : response;
          }
          // From here the outcome is always reported: an invalidation of
          // the path waits for what it writes.
          trackWrite(exchange.tag, handled.promise);
          const now = Date.now();
          if (
            stale !== undefined &&
            isErrorStatus(response.status) &&
            withinSie(stale, now)
          ) {
            if (context.body === undefined) {
              // A streamed error nobody will read.
              void response.body?.cancel().catch(() => {});
            }
            report({
              ok: false,
              reason: "status",
              status: response.status,
              servedStale: true,
            });
            const answer = staleAnswer(stale.response, now, response, preset);
            return conditional ? answerConditional(req, answer) : answer;
          }
          let decided = decideStore(response, preset, {
            statuses,
            ttl,
            allowSetCookie: options.allowSetCookie ?? false,
            omitHeaders,
            statusHeader: statusHeaderName,
            authorization: req.getHeader("authorization") !== null,
            identityKeyed,
            staleWhileRevalidate: routeSwr,
            staleIfError: routeSie,
            now,
          });
          let out = response;
          let body: Uint8Array | Promise<Uint8Array> | undefined;
          /** Set when a buffered stream outgrew the buffer: refused as `"stream"`, not as a failure. */
          let tooLarge = false;
          if (decided.ok) {
            body = captureBody(response, context);
            if (body === undefined) {
              const source = response.body;
              const eventStream = (response.headers.get("content-type") ?? "")
                .toLowerCase()
                .startsWith("text/event-stream");
              if (
                streamBuffer === undefined ||
                source === null ||
                eventStream
              ) {
                decided = { ok: false, reason: "stream" };
              } else {
                const tapped = tapStream(source, streamBuffer, beforeClose);
                out = new Response(tapped.stream, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                });
                body = tapped.bytes.then((bytes: TappedBody) => {
                  if (bytes instanceof Uint8Array) {
                    return bytes;
                  }
                  tooLarge = bytes === "too-large";
                  throw new Error(`the stream ${bytes}`);
                });
              }
            }
          }
          let tags: string[] | undefined;
          if (decided.ok) {
            try {
              tags = tagsFor(exchange);
            } catch {
              // A throwing `tags` function: answer, but store nothing.
              tags = undefined;
            }
          }
          if (
            decided.ok &&
            computeEtag &&
            body instanceof Uint8Array &&
            !decided.headers.some(([name]) => name === "etag")
          ) {
            // Stored and sent alike, so the client's next conditional
            // request matches what a hit answers.
            const tag = etagOf(body);
            decided.headers.push(["etag", tag]);
            out = withHeader(out, "ETag", tag);
          }
          if (statusHeader !== false) {
            out = withHeader(
              out,
              statusHeader,
              decided.ok ? "MISS" : "UNCACHEABLE",
            );
          }
          if (conditional) {
            out = answerConditional(req, out);
          }

          if (!decided.ok || tags === undefined || body === undefined) {
            report({
              ok: false,
              reason: decided.ok ? undefined : decided.reason,
              status: response.status,
              servedStale: false,
            });
            return out;
          }
          const decision = decided;
          const entryTags = tags;
          void Promise.resolve(body).then(
            (bytes) => {
              if (
                computeEtag &&
                !decision.headers.some(([name]) => name === "etag")
              ) {
                // A Blob or streamed body, read only now.
                decision.headers.push(["etag", etagOf(bytes)]);
              }
              report({
                ok: true,
                decision,
                tags: entryTags,
                response: {
                  meta: {
                    status: response.status,
                    statusText: response.statusText,
                    headers: decision.headers,
                    storedAt: now,
                    age: decision.age,
                    // Under the cache's own TTL the core decides;
                    // the entry's `freshUntil` is read back on a hit.
                    freshUntil:
                      decision.ttl === undefined ? null : now + decision.ttl,
                    staleWhileRevalidate: decision.staleWhileRevalidate,
                    staleIfError: decision.staleIfError,
                  },
                  body: bytes,
                },
              });
            },
            () =>
              report({
                ok: false,
                reason: tooLarge ? "stream" : undefined,
                status: response.status,
                servedStale: false,
              }),
          );
          return out;
        },
      },
      { first: true },
    );
    return handle;
  };

  /** The frame to store at a key for a storable outcome; `undefined` when the variant no longer matches. */
  const frameFor = (
    exchange: Exchange,
    outcome: Extract<Outcome, { ok: true }>,
    variant: Variant | undefined,
  ): Uint8Array | undefined => {
    const vary = outcome.decision.vary;
    if (variant !== undefined) {
      // A variant key: the response must still vary on the same headers.
      return sameList(vary, variant.vary)
        ? encodeResponse(outcome.response)
        : undefined;
    }
    return vary.length === 0
      ? encodeResponse(outcome.response)
      : encodeVary({
          vary,
          values: headerValues(exchange.req, vary),
          response: outcome.response,
        });
  };

  /**
   * Answers from a stored response: status, headers, `Age`, the status
   * header, then the bytes through `res.send` (which answers 304 itself).
   */
  const serveStored = (
    exchange: Exchange,
    stored: StoredResponse,
    status: "HIT" | "STALE",
  ): void => {
    const { res } = exchange;
    const { meta, body } = stored;
    res.status(meta.status);
    if (meta.statusText !== "") {
      res.statusText(meta.statusText);
    }
    const cookies: string[] = [];
    for (const [name, value] of meta.headers) {
      if (name === "set-cookie") {
        cookies.push(value);
      } else {
        res.setHeader(name, value);
      }
    }
    if (cookies.length > 0) {
      res.setHeader("Set-Cookie", cookies);
    }
    res.setHeader("Age", String(ageOf(stored, Date.now())));
    markStatus(res, status);
    res.send(body);
  };

  /**
   * With a stale entry inside its stale-if-error window and a `hardTimeout`,
   * answers the stale entry when the handler has not answered in time, and
   * gives the capture up (the late answer is not stored; bun-common does not
   * send it). `onFire` runs after the stale answer.
   */
  const armHardTimeout = (
    exchange: Exchange,
    handle: CaptureHandle,
    stale: StaleEntry | undefined,
    onFire?: () => void,
  ): void => {
    if (
      hardTimeout === undefined ||
      stale === undefined ||
      !withinSie(stale, Date.now())
    ) {
      return;
    }
    const timer = setTimeout(() => {
      if (handle.transformed || exchange.res.headersSent) {
        return;
      }
      handle.abandoned = true;
      serveStored(exchange, stale.response, "STALE");
      onFire?.();
    }, hardTimeout);
    timer.unref?.();
    handle.onTransformed = () => clearTimeout(timer);
  };

  /**
   * Stores a storable outcome at `key` with a plain `set` (a vary change
   * drops the base key's record instead, to be relearnt). Resolves once
   * written; never rejects.
   */
  const storeOutcome = async (
    exchange: Exchange,
    key: string,
    variant: Variant | undefined,
    outcome: Extract<Outcome, { ok: true }>,
  ): Promise<void> => {
    const frame = frameFor(exchange, outcome, variant);
    if (frame === undefined) {
      await cache.delete(exchange.base).catch(() => {});
      return;
    }
    await cache
      .set(key, frame, {
        ttl: outcome.decision.ttl,
        tags: outcome.tags,
        staleWhileRevalidate: outcome.decision.staleWhileRevalidate,
        staleIfError: outcome.decision.staleIfError,
      })
      .catch(() => {});
  };

  /**
   * Runs the handler without coalescing, and stores its answer with a plain
   * `set` when it may be stored (a marker is never written here: it expires,
   * and the next coalesced miss decides again; a failure writes nothing, so
   * a stale entry stays).
   */
  const runAndStore = (
    exchange: Exchange,
    key: string,
    variant: Variant | undefined,
    stale: StaleEntry | undefined,
  ): void => {
    const handle = capture(
      exchange,
      (outcome) =>
        outcome.ok ? storeOutcome(exchange, key, variant, outcome) : undefined,
      stale,
    );
    armHardTimeout(exchange, handle, stale);
    exchange.next();
  };

  /** `HIT`, or `STALE` for a response a coalesced follower got past its freshness (a leader that kept the stale entry). */
  const statusOf = (stored: StoredResponse): "HIT" | "STALE" =>
    stored.meta.freshUntil !== null && Date.now() >= stored.meta.freshUntil
      ? "STALE"
      : "HIT";

  /** A read's result. */
  type Lookup =
    | {
        /** A fresh entry. */
        kind: "hit";
        /** Its response. */
        response: StoredResponse;
      }
    | {
        /** A stale entry, inside the core's hard expiry. */
        kind: "stale";
        /** The entry. */
        entry: StaleEntry;
      }
    | {
        /** The hit-for-miss marker. */
        kind: "uncacheable";
      }
    | {
        /** Nothing usable. */
        kind: "miss";
        /** The key a stored answer goes to. */
        key: string;
        /** The variant, when `key` is a variant key. */
        variant: Variant | undefined;
      };

  /** One key's frame, stale ones included (`getEntry`). */
  const read = async (
    key: string,
  ): Promise<
    | {
        /** The decoded frame. */
        frame: Frame;
        /** The frame as stored. */
        raw: Uint8Array;
        /** Whether the core entry is past its freshness. */
        stale: boolean;
        /** The core entry's `freshUntil`. */
        freshUntil: number | null;
      }
    | undefined
  > => {
    const entry = await cache.getEntry(key);
    if (entry === undefined || !(entry.value instanceof Uint8Array)) {
      return undefined;
    }
    const frame = decodeFrame(entry.value);
    return frame === undefined
      ? undefined
      : {
          frame,
          raw: entry.value,
          stale: entry.stale,
          freshUntil: entry.freshUntil,
        };
  };

  /**
   * Reads a request's entry: the base key, then its variant when the base
   * key holds a vary record. Stale entries are read too (inside the core's
   * hard expiry, freshness plus the longer window); a stale marker is a miss.
   */
  const lookup = async (exchange: Exchange): Promise<Lookup> => {
    const found = (
      at: NonNullable<Awaited<ReturnType<typeof read>>>,
      key: string,
      variant: Variant | undefined,
      vary: readonly string[],
      stored: StoredResponse,
    ): Lookup => {
      // The core entry decides when a response goes stale: under the cache's
      // own TTL (`"headers-or-cache"`) the stored response does not know
      // (`freshUntil: null`), and a cache's `jitter` moves it. What is
      // answered — and a stale frame handed to coalesced followers, which
      // read `X-Cache` from it — carries the entry's.
      const response =
        stored.meta.freshUntil === at.freshUntil
          ? stored
          : { ...stored, meta: { ...stored.meta, freshUntil: at.freshUntil } };
      if (!at.stale || at.freshUntil === null) {
        return { kind: "hit", response };
      }
      let frame = at.raw;
      if (response !== stored) {
        frame =
          at.frame.kind === "vary"
            ? encodeVary({ ...at.frame.record, response })
            : encodeResponse(response);
      }
      return {
        kind: "stale",
        entry: {
          base: exchange.base,
          key,
          variant,
          vary,
          response,
          frame,
          freshUntil: at.freshUntil,
        },
      };
    };
    const base = await read(exchange.base);
    if (base === undefined) {
      return { kind: "miss", key: exchange.base, variant: undefined };
    }
    const { frame } = base;
    if (frame.kind === "uncacheable") {
      return base.stale
        ? { kind: "miss", key: exchange.base, variant: undefined }
        : { kind: "uncacheable" };
    }
    if (frame.kind === "response") {
      return found(base, exchange.base, undefined, [], frame.response);
    }
    const { record } = frame;
    const values = headerValues(exchange.req, record.vary);
    if (sameList(values, record.values)) {
      return found(
        base,
        exchange.base,
        undefined,
        record.vary,
        record.response,
      );
    }
    const key = variantKey(exchange.base, record.vary, values);
    const variant: Variant = { vary: record.vary, values };
    const own = await read(key);
    if (own?.frame.kind === "response") {
      return found(own, key, variant, record.vary, own.frame.response);
    }
    return { kind: "miss", key, variant };
  };

  /**
   * The leader's load, inside the core's `getOrSet`: hand on, and resolve
   * with the frame to store once the response is captured — filling
   * `options`' `ttl`, `tags` and windows first, which the core reads at
   * write time. Gives up after `wait` (an answer that bypassed the
   * transforms never arrives), and stores a late answer with a plain `set`.
   * With a stale entry, a failure (a 5xx, the hard timeout) keeps it: the
   * load stores nothing and hands the stale frame to the followers.
   */
  const lead = (
    exchange: Exchange,
    key: string,
    variant: Variant | undefined,
    writeOptions: GetOrSetOptions,
    context: CacheLoaderContext,
    stale: StaleEntry | undefined,
    written: Promise<void>,
  ): Promise<Uint8Array | undefined> => {
    const deferred = createDeferred<Uint8Array | undefined>();
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      deferred.resolve(undefined);
    }, wait);
    timer.unref?.();
    /** Keeps the stale entry: nothing stored, followers answered from it. */
    const keepStale = (entry: StaleEntry): void => {
      settled = true;
      clearTimeout(timer);
      context.noStore();
      deferred.resolve(entry.frame);
    };
    const handle = capture(
      exchange,
      (outcome) => {
        if (settled) {
          // Gave up waiting: the late answer is stored the uncoalesced way.
          return outcome.ok
            ? storeOutcome(exchange, key, variant, outcome)
            : undefined;
        }
        if (!outcome.ok && stale !== undefined && isFailure(outcome)) {
          keepStale(stale);
          return written;
        }
        settled = true;
        clearTimeout(timer);
        if (outcome.ok) {
          const frame = frameFor(exchange, outcome, variant);
          if (frame === undefined) {
            // The response's Vary changed under its base key: relearn it.
            const relearnt = cache.delete(exchange.base).catch(() => {});
            deferred.resolve(undefined);
            return relearnt;
          }
          writeOptions.ttl = outcome.decision.ttl;
          writeOptions.tags = outcome.tags;
          writeOptions.staleWhileRevalidate =
            outcome.decision.staleWhileRevalidate;
          writeOptions.staleIfError = outcome.decision.staleIfError;
          deferred.resolve(frame);
          return written;
        }
        if (
          outcome.reason !== undefined &&
          outcome.reason !== "authorization" &&
          uncacheableTtl > 0
        ) {
          writeOptions.ttl = uncacheableTtl;
          writeOptions.tags = [exchange.tag];
          deferred.resolve(encodeUncacheable());
          return written;
        }
        deferred.resolve(undefined);
        return undefined;
      },
      stale,
    );
    armHardTimeout(exchange, handle, stale, () => {
      if (!settled && stale !== undefined) {
        keepStale(stale);
      }
    });
    exchange.next();
    return deferred.promise;
  };

  /**
   * A miss through the core's single-flight: the first leads (runs the
   * handler, stores its answer); the misses that arrive meanwhile wait for
   * it and answer from what it stored (or the stale entry it kept). An entry
   * someone refreshed since the lookup is answered as it is.
   */
  const coalesced = async (
    exchange: Exchange,
    key: string,
    variant: Variant | undefined,
    stale: StaleEntry | undefined,
  ): Promise<void> => {
    let leading = false;
    const writeOptions = loadOptions();
    /** Settles once the flight has settled: for a leader, after the core wrote what it loaded (a buffered stream's end waits for it). */
    const written = createDeferred<void>();
    let value: unknown;
    try {
      value = await cache.getOrSet(
        key,
        async (context) => {
          leading = true;
          return await lead(
            exchange,
            key,
            variant,
            writeOptions,
            context,
            stale,
            written.promise,
          );
        },
        writeOptions,
      );
    } catch {
      // A strict cache's driver failure: serve the request uncached.
      value = undefined;
    } finally {
      written.resolve();
    }
    if (leading) {
      return;
    }
    const frame = decodeFrame(value);
    if (frame === undefined || frame.kind === "uncacheable") {
      runAndStore(exchange, key, variant, stale);
      return;
    }
    if (frame.kind === "response") {
      serveStored(exchange, frame.response, statusOf(frame.response));
      return;
    }
    if (variant !== undefined) {
      // A vary record at a variant key: not one we wrote. Treat as a miss.
      runAndStore(exchange, key, variant, stale);
      return;
    }
    const { record } = frame;
    const values = headerValues(exchange.req, record.vary);
    if (sameList(values, record.values)) {
      serveStored(exchange, record.response, statusOf(record.response));
      return;
    }
    await coalesced(
      exchange,
      variantKey(exchange.base, record.vary, values),
      {
        vary: record.vary,
        values,
      },
      undefined,
    );
  };

  /**
   * The load of a background replay (§9.4), inside the core's `getOrSet` so
   * it shares the key's single-flight with any miss: sends `request` through
   * `revalidate.fetch()` and waits for the middleware to capture what the
   * pipeline produced for it. A storable answer is stored with the core's
   * fence (an invalidation during the replay drops it); one the response
   * forbids storing leaves the hit-for-miss marker, as a miss would; a
   * failure (a 5xx, nothing captured, past `replayBudget`) keeps the stale
   * entry and holds the key's next replay back for {@link REPLAY_BACKOFF}.
   */
  const replayLoad = async (
    id: string,
    request: Request,
    entry: StaleEntry,
    writeOptions: GetOrSetOptions,
    context: CacheLoaderContext,
  ): Promise<Uint8Array | undefined> => {
    const target = revalidate!;
    const settledOutcome = createDeferred<Outcome | undefined>();
    const replay: Replay = {
      base: entry.base,
      key: entry.key,
      variant: entry.variant,
      exchange: undefined,
      handle: undefined,
      settle: settledOutcome.resolve,
    };
    replays.set(id, replay);
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), replayBudget);
    timer.unref?.();
    const overBudget = new Promise<undefined>((resolve) => {
      budget.signal.addEventListener("abort", () => resolve(undefined), {
        once: true,
      });
    });
    let outcome: Outcome | undefined;
    try {
      const fetched = target.fetch(request);
      const response = await Promise.race([fetched, overBudget]);
      if (response === undefined) {
        // Past the budget: whatever arrives later is read by nobody.
        void fetched.then(
          (late) => late.body?.cancel().catch(() => {}),
          () => {},
        );
      } else {
        await drain(response, budget.signal);
        outcome =
          replay.handle?.transformed === true
            ? await Promise.race([settledOutcome.promise, overBudget])
            : undefined;
      }
    } catch {
      outcome = undefined;
    } finally {
      clearTimeout(timer);
      budget.abort();
      replays.delete(id);
    }
    const replayed = replay.exchange;
    if (outcome?.ok === true && replayed !== undefined) {
      const frame = frameFor(replayed, outcome, entry.variant);
      if (frame === undefined) {
        // The response's Vary changed under its base key: relearn it.
        void cache.delete(entry.base).catch(() => {});
        context.noStore();
        return undefined;
      }
      writeOptions.ttl = outcome.decision.ttl;
      writeOptions.tags = outcome.tags;
      writeOptions.staleWhileRevalidate = outcome.decision.staleWhileRevalidate;
      writeOptions.staleIfError = outcome.decision.staleIfError;
      return frame;
    }
    if (
      outcome !== undefined &&
      !outcome.ok &&
      replayed !== undefined &&
      !isFailure(outcome) &&
      outcome.reason !== "authorization" &&
      uncacheableTtl > 0
    ) {
      writeOptions.ttl = uncacheableTtl;
      writeOptions.tags = [replayed.tag];
      return encodeUncacheable();
    }
    if (replayBackoff.size >= MAX_TRACKED_KEYS) {
      replayBackoff.clear();
    }
    replayBackoff.set(entry.key, Date.now() + REPLAY_BACKOFF);
    context.noStore();
    return entry.frame;
  };

  /** Starts the background replay that refreshes `entry`, unless one is running for its key or the key is backing off after a failed one. */
  const startReplay = (req: BunRequest, entry: StaleEntry): void => {
    const key = entry.key;
    if (revalidating.has(key)) {
      return;
    }
    const until = replayBackoff.get(key);
    if (until !== undefined) {
      if (Date.now() < until) {
        return;
      }
      replayBackoff.delete(key);
    }
    revalidating.add(key);
    const id = crypto.randomUUID();
    const request = replayRequest(
      req,
      [...new Set([...varyBy, ...entry.vary])],
      id,
    );
    const writeOptions = loadOptions();
    void cache
      .getOrSet(
        key,
        async (context) =>
          await replayLoad(id, request, entry, writeOptions, context),
        writeOptions,
      )
      .catch(() => {
        // A strict cache's driver failure: the stale entry stays.
      })
      .finally(() => {
        revalidating.delete(key);
      });
  };

  /**
   * Answers a stale entry inside its stale-while-revalidate window, and
   * starts its refresh: a background replay with `revalidate`; without it,
   * the key is marked so its next request refreshes it — unless it already
   * was, and then this request refreshes (answers `false`, and the caller
   * runs it as a miss). `refresh: false` (a HEAD, which stores nothing)
   * neither marks nor refreshes.
   */
  const answerStale = (
    exchange: Exchange,
    entry: StaleEntry,
    refresh: boolean,
  ): boolean => {
    if (revalidate !== undefined) {
      startReplay(exchange.req, entry);
    } else if (refresh) {
      if (refreshNext.delete(entry.key)) {
        return false;
      }
      track(refreshNext, entry.key);
    }
    serveStored(exchange, entry.response, "STALE");
    return true;
  };

  /**
   * A background replay's request, arriving through the pipeline: when it
   * still maps to the key it refreshes, its response is captured and handed
   * to the waiting {@link replayLoad} — not through `getOrSet`, whose
   * flight that load already holds.
   */
  const serveReplay = (exchange: Exchange, replay: Replay): void => {
    const key =
      replay.variant === undefined
        ? exchange.base
        : variantKey(
            exchange.base,
            replay.variant.vary,
            headerValues(exchange.req, replay.variant.vary),
          );
    if (exchange.base !== replay.base || key !== replay.key) {
      // The key reads something the replay does not carry (a `key`
      // function's header): this answer is for another key.
      replay.settle(undefined);
      exchange.next();
      return;
    }
    replay.exchange = exchange;
    // No wait at a buffered stream's end here: the replay's load, which
    // holds the flight, is what reads that end.
    replay.handle = capture(exchange, (outcome) => {
      replay.settle(outcome);
      return undefined;
    });
    exchange.next();
  };

  /** A request whose 2xx/3xx answer invalidates its path, and a same-host `Location`/`Content-Location`. */
  const watchUnsafe = (req: BunRequest, res: BunResponse): void => {
    res.addResponseTransform(
      {
        transform: (response) => {
          if (response.status >= 200 && response.status < 400) {
            const host = keyHost ? hostOf(req) : undefined;
            const tags = new Set([pathTag(host, targetOf(req).path)]);
            for (const name of ["location", "content-location"]) {
              const value = response.headers.get(name);
              if (value === null) {
                continue;
              }
              try {
                const url = new URL(value, `http://${req.host}`);
                if (url.host.toLowerCase() === req.host.toLowerCase()) {
                  tags.add(
                    pathTag(
                      keyHost ? url.host.toLowerCase() : undefined,
                      url.pathname,
                    ),
                  );
                }
              } catch {
                // Not a URL: nothing to invalidate.
              }
            }
            void invalidateTracked([...tags]);
          }
          return response;
        },
      },
      { first: true },
    );
  };

  const middleware = async (
    req: BunRequest,
    res: BunResponse,
    next: NextFunction,
  ): Promise<void> => {
    if (res.headersSent) {
      next();
      return;
    }
    const method = req.method;
    if (method !== "GET" && method !== "HEAD") {
      if (invalidateOnUnsafe && UNSAFE_METHODS.has(method)) {
        watchUnsafe(req, res);
      }
      next();
      return;
    }
    if (options.bypass?.(req) === true) {
      markStatus(res, "BYPASS");
      next();
      return;
    }
    let directives: RequestDirectives | undefined;
    if (honorRequest) {
      directives = requestDirectives(req);
      if (directives.bypass) {
        markStatus(res, "BYPASS");
        next();
        return;
      }
    }

    const target: Target = targetOf(req);
    const host = keyHost ? hostOf(req) : undefined;
    const tag = pathTag(host, target.path);
    const waiting = pending.get(tag);
    if (waiting !== undefined) {
      await waiting;
    }
    const exchange: Exchange = {
      req,
      res,
      next,
      base: baseKey(req, {
        host,
        target,
        query: queryOption,
        varyBy,
        custom: keyFn?.(req),
      }),
      tag,
      anonymousOnly: req.getHeader("authorization") !== null && !identityKeyed,
    };

    if (method === "GET") {
      const id = replayIdOf(req);
      const replay = id === undefined ? undefined : replays.get(id);
      if (replay !== undefined) {
        replays.delete(id!);
        serveReplay(exchange, replay);
        return;
      }
    }

    if (method === "HEAD") {
      // HEAD reads GET's entry; a miss runs the GET handler, unstored: its
      // body may be cut short (§9.3). A stale entry inside its
      // stale-while-revalidate window is answered and refreshed as a GET's.
      const found = await lookup(exchange);
      if (found.kind === "hit") {
        serveStored(exchange, found.response, "HIT");
        return;
      }
      if (
        found.kind === "stale" &&
        withinSwr(found.entry, Date.now()) &&
        answerStale(exchange, found.entry, false)
      ) {
        return;
      }
      markStatus(res, "MISS");
      next();
      return;
    }

    if (directives?.revalidate === true) {
      // `no-cache`: run the handler, store its answer, read nothing. The
      // variant is unknown without a read, so a varying answer is stored
      // as the base key's first variant.
      runAndStore(exchange, exchange.base, undefined, undefined);
      return;
    }

    const found = await lookup(exchange);
    const parsed = directives?.parsed;
    if (
      parsed?.maxAge !== undefined ||
      parsed?.minFresh !== undefined ||
      parsed?.onlyIfCached === true
    ) {
      // The client bounds the age it accepts: never a stale answer.
      if (found.kind === "hit") {
        const meta = found.response.meta;
        const now = Date.now();
        const tooOld =
          parsed.maxAge !== undefined &&
          ageOf(found.response, now) > parsed.maxAge;
        const tooClose =
          parsed.minFresh !== undefined &&
          meta.freshUntil !== null &&
          meta.freshUntil - now < parsed.minFresh * 1000;
        if (!tooOld && !tooClose) {
          serveStored(exchange, found.response, "HIT");
          return;
        }
      }
      if (parsed.onlyIfCached === true) {
        // RFC 9111 §5.2.1.7: nothing stored that fits, and no forwarding.
        markStatus(res, "MISS");
        res.status(504).send("");
        return;
      }
      if (found.kind === "miss") {
        runAndStore(exchange, found.key, found.variant, undefined);
      } else if (found.kind === "stale") {
        runAndStore(exchange, found.entry.key, found.entry.variant, undefined);
      } else {
        runAndStore(exchange, exchange.base, undefined, undefined);
      }
      return;
    }

    if (found.kind === "hit") {
      serveStored(exchange, found.response, "HIT");
      return;
    }
    if (found.kind === "uncacheable") {
      // Hit-for-miss: run side by side, no coalescing.
      runAndStore(exchange, exchange.base, undefined, undefined);
      return;
    }
    let key: string;
    let variant: Variant | undefined;
    let stale: StaleEntry | undefined;
    if (found.kind === "stale") {
      if (
        withinSwr(found.entry, Date.now()) &&
        answerStale(exchange, found.entry, true)
      ) {
        return;
      }
      // Past stale-while-revalidate (or refreshing it now): a miss that
      // keeps the stale entry for stale-if-error.
      stale = found.entry;
      key = stale.key;
      variant = stale.variant;
    } else {
      key = found.key;
      variant = found.variant;
    }
    if (exchange.anonymousOnly || !coalescing) {
      runAndStore(exchange, key, variant, stale);
      return;
    }
    await coalesced(exchange, key, variant, stale);
  };

  const invalidate = async (
    target: string | Request | BunRequest,
  ): Promise<void> => {
    let host: string | undefined;
    let path: string;
    if (typeof target === "string") {
      if (target.startsWith("/")) {
        if (keyHost) {
          throw new TypeError(
            "cacheResponse().invalidate(): host is keyed, so give an absolute URL, a Request or a BunRequest",
          );
        }
        path = splitTarget(target).path;
      } else {
        const url = new URL(target);
        host = url.host.toLowerCase();
        path = url.pathname;
      }
    } else if (target instanceof Request) {
      const url = new URL(target.url);
      host = url.host.toLowerCase();
      path = url.pathname;
    } else {
      host = hostOf(target);
      path = targetOf(target).path;
    }
    await invalidateTracked([pathTag(keyHost ? host : undefined, path)]);
  };

  const handler: CacheResponseMiddleware = Object.assign(middleware, {
    invalidate,
  });
  return handler;
}
