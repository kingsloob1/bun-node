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
 * Stale serving over HTTP (stale-while-revalidate, stale-if-error) and
 * buffered streams are PR-H2's (§9.4): entries keep the windows the response
 * gave, but PR-H1 treats anything past its freshness as a miss.
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
import type { Cache, GetOrSetOptions } from "../core/types";
import {
  answerConditional,
  captureBody,
  maskConditional,
  snapshotHeaders,
  withHeader,
} from "./capture";
import type { StoredResponse } from "./frame";
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

/** The `X-Cache` values (plan §21). `STALE` is PR-H2's. */
export type CacheStatus = "HIT" | "MISS" | "STALE" | "BYPASS" | "UNCACHEABLE";

/** `cacheResponse()`'s options (plan §9.1). Durations are in ms. */
export interface CacheResponseOptions {
  /**
   * How long a stored response stays fresh: a number of **ms**, which
   * overrides every freshness header (not the refusals: `no-store`,
   * `private` and the rest still apply); or `"headers"`, which reads
   * `Surrogate-Control: max-age`, then `s-maxage`, then `max-age`, then
   * `Expires` (Fastly's precedence) less the response's own `Age`, and does
   * not store a response that has none. Defaults to `"headers"`, so a route
   * caches what its `Cache-Control` (bun-common's `cacheControl()`) says.
   */
  ttl?: number | "headers";
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
   * so a bare path throws a `TypeError`.
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
      /** Why; `undefined` when the capture itself failed (a throwing `tags` function, an unreadable body). */
      reason: Refusal | undefined;
    };

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
  if (ttl !== "headers") {
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

  /** Invalidations started by this middleware and not finished, by tag: a GET for the path waits for them. */
  const pending = new Map<string, Promise<void>>();

  /** Invalidates `tags`, tracked in {@link pending} until it settles. */
  const invalidateTracked = (tags: readonly string[]): Promise<void> => {
    const done = cache.invalidateTags(tags).catch(() => {
      // The failure policy has reported it (an `error` event); a strict
      // cache's throw must not become an unhandled rejection here.
    });
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
   * 304 here.
   */
  const capture = (
    exchange: Exchange,
    onOutcome: (outcome: Outcome) => void,
  ): void => {
    const { req, res } = exchange;
    const preset: PresetHeaders = snapshotHeaders(res);
    const conditional = maskConditional(req);
    res.addResponseTransform(
      {
        transform: (response, context) => {
          const now = Date.now();
          let decided = decideStore(response, preset, {
            statuses,
            ttl,
            allowSetCookie: options.allowSetCookie ?? false,
            omitHeaders,
            statusHeader: statusHeaderName,
            authorization: req.getHeader("authorization") !== null,
            identityKeyed,
            now,
          });
          let body: Uint8Array | Promise<Uint8Array> | undefined;
          if (decided.ok) {
            body = captureBody(response, context);
            if (body === undefined) {
              decided = { ok: false, reason: "stream" };
            }
          }
          let out = response;
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
            onOutcome(
              decided.ok
                ? { ok: false, reason: undefined }
                : { ok: false, reason: decided.reason },
            );
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
                // A Blob body, read only now.
                decision.headers.push(["etag", etagOf(bytes)]);
              }
              onOutcome({
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
                    freshUntil: now + decision.ttl,
                    staleWhileRevalidate: decision.staleWhileRevalidate,
                    staleIfError: decision.staleIfError,
                  },
                  body: bytes,
                },
              });
            },
            () => onOutcome({ ok: false, reason: undefined }),
          );
          return out;
        },
      },
      { first: true },
    );
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
   * Runs the handler without coalescing, and stores its answer with a plain
   * `set` when it may be stored (a marker is never written here: it expires,
   * and the next coalesced miss decides again).
   */
  const runAndStore = (
    exchange: Exchange,
    key: string,
    variant: Variant | undefined,
  ): void => {
    capture(exchange, (outcome) => {
      if (!outcome.ok) {
        return;
      }
      const frame = frameFor(exchange, outcome, variant);
      if (frame === undefined) {
        void cache.delete(exchange.base).catch(() => {});
        return;
      }
      void cache
        .set(key, frame, {
          ttl: outcome.decision.ttl,
          tags: outcome.tags,
          staleWhileRevalidate: outcome.decision.staleWhileRevalidate,
          staleIfError: outcome.decision.staleIfError,
        })
        .catch(() => {});
    });
    exchange.next();
  };

  /** Answers from a stored response: status, headers, `Age`, the status header, then the bytes through `res.send` (which answers 304 itself). */
  const serveHit = (exchange: Exchange, stored: StoredResponse): void => {
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
    const resident = Math.max(
      0,
      Math.floor((Date.now() - meta.storedAt) / 1000),
    );
    res.setHeader("Age", String(meta.age + resident));
    markStatus(res, "HIT");
    res.send(body);
  };

  /** A read's result. */
  type Lookup =
    | { kind: "hit"; response: StoredResponse }
    | { kind: "uncacheable" }
    | { kind: "miss"; key: string; variant: Variant | undefined };

  /** Reads a request's entry: the base key, then its variant when the base key holds a vary record. */
  const lookup = async (exchange: Exchange): Promise<Lookup> => {
    const frame = decodeFrame(await cache.get(exchange.base));
    if (frame === undefined) {
      return { kind: "miss", key: exchange.base, variant: undefined };
    }
    if (frame.kind === "response") {
      return { kind: "hit", response: frame.response };
    }
    if (frame.kind === "uncacheable") {
      return { kind: "uncacheable" };
    }
    const { record } = frame;
    const values = headerValues(exchange.req, record.vary);
    if (sameList(values, record.values)) {
      return { kind: "hit", response: record.response };
    }
    const key = variantKey(exchange.base, record.vary, values);
    const variant = decodeFrame(await cache.get(key));
    if (variant?.kind === "response") {
      return { kind: "hit", response: variant.response };
    }
    return { kind: "miss", key, variant: { vary: record.vary, values } };
  };

  /**
   * The leader's load, inside the core's `getOrSet`: hand on, and resolve
   * with the frame to store once the response is captured — filling
   * `options`' `ttl`, `tags` and windows first, which the core reads at
   * write time. Gives up after `wait` (an answer that bypassed the
   * transforms never arrives), and stores a late answer with a plain `set`.
   */
  const lead = (
    exchange: Exchange,
    key: string,
    variant: Variant | undefined,
    writeOptions: GetOrSetOptions,
  ): Promise<Uint8Array | undefined> => {
    const deferred = createDeferred<Uint8Array | undefined>();
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      deferred.resolve(undefined);
    }, wait);
    timer.unref?.();
    capture(exchange, (outcome) => {
      if (settled) {
        // Gave up waiting: the late answer is stored the uncoalesced way.
        if (outcome.ok) {
          const frame = frameFor(exchange, outcome, variant);
          if (frame !== undefined) {
            void cache
              .set(key, frame, {
                ttl: outcome.decision.ttl,
                tags: outcome.tags,
                staleWhileRevalidate: outcome.decision.staleWhileRevalidate,
                staleIfError: outcome.decision.staleIfError,
              })
              .catch(() => {});
          }
        }
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (outcome.ok) {
        const frame = frameFor(exchange, outcome, variant);
        if (frame === undefined) {
          // The response's Vary changed under its base key: relearn it.
          void cache.delete(exchange.base).catch(() => {});
          deferred.resolve(undefined);
          return;
        }
        writeOptions.ttl = outcome.decision.ttl;
        writeOptions.tags = outcome.tags;
        writeOptions.staleWhileRevalidate =
          outcome.decision.staleWhileRevalidate;
        writeOptions.staleIfError = outcome.decision.staleIfError;
        deferred.resolve(frame);
        return;
      }
      if (
        outcome.reason !== undefined &&
        outcome.reason !== "authorization" &&
        uncacheableTtl > 0
      ) {
        writeOptions.ttl = uncacheableTtl;
        writeOptions.tags = [exchange.tag];
        deferred.resolve(encodeUncacheable());
        return;
      }
      deferred.resolve(undefined);
    });
    exchange.next();
    return deferred.promise;
  };

  /**
   * A GET through the core's single-flight: a fresh entry answers; the
   * first miss leads (runs the handler, stores its answer); the misses that
   * arrive meanwhile wait for it and answer from what it stored.
   */
  const coalesced = async (
    exchange: Exchange,
    key: string,
    variant: Variant | undefined,
  ): Promise<void> => {
    let leading = false;
    // Neutralise the core's own staleness machinery for this call: PR-H1
    // answers stale entries as misses, and a background refresh would call
    // the loader with no request to run. `ttl`, `tags` and the windows are
    // filled by the leader before its load resolves (`lead`).
    const writeOptions: GetOrSetOptions = {
      staleWhileRevalidate: 0,
      staleIfError: 0,
      softTimeout: 0,
      hardTimeout: 0,
      refreshAhead: 0,
      earlyExpiry: { beta: 0 },
      cacheUndefined: false,
    };
    let value: unknown;
    try {
      value = await cache.getOrSet(
        key,
        async () => {
          leading = true;
          return await lead(exchange, key, variant, writeOptions);
        },
        writeOptions,
      );
    } catch {
      // A strict cache's driver failure: serve the request uncached.
      value = undefined;
    }
    if (leading) {
      return;
    }
    const frame = decodeFrame(value);
    if (frame === undefined || frame.kind === "uncacheable") {
      runAndStore(exchange, key, variant);
      return;
    }
    if (frame.kind === "response") {
      serveHit(exchange, frame.response);
      return;
    }
    if (variant !== undefined) {
      // A vary record at a variant key: not one we wrote. Treat as a miss.
      runAndStore(exchange, key, variant);
      return;
    }
    const { record } = frame;
    const values = headerValues(exchange.req, record.vary);
    if (sameList(values, record.values)) {
      serveHit(exchange, record.response);
      return;
    }
    await coalesced(exchange, variantKey(exchange.base, record.vary, values), {
      vary: record.vary,
      values,
    });
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

    if (method === "HEAD") {
      // HEAD reads GET's entry; a miss runs the GET handler, unstored: its
      // body may be cut short (§9.3).
      const found = await lookup(exchange);
      if (found.kind === "hit") {
        serveHit(exchange, found.response);
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
      runAndStore(exchange, exchange.base, undefined);
      return;
    }

    const parsed = directives?.parsed;
    if (
      exchange.anonymousOnly ||
      !coalescing ||
      parsed?.maxAge !== undefined ||
      parsed?.minFresh !== undefined ||
      parsed?.onlyIfCached === true
    ) {
      const found = await lookup(exchange);
      if (found.kind === "hit") {
        const meta = found.response.meta;
        const now = Date.now();
        const age =
          meta.age + Math.max(0, Math.floor((now - meta.storedAt) / 1000));
        const tooOld = parsed?.maxAge !== undefined && age > parsed.maxAge;
        const tooClose =
          parsed?.minFresh !== undefined &&
          meta.freshUntil !== null &&
          meta.freshUntil - now < parsed.minFresh * 1000;
        if (!tooOld && !tooClose) {
          serveHit(exchange, found.response);
          return;
        }
      }
      if (parsed?.onlyIfCached === true) {
        // RFC 9111 §5.2.1.7: nothing stored that fits, and no forwarding.
        markStatus(res, "MISS");
        res.status(504).send("");
        return;
      }
      runAndStore(
        exchange,
        found.kind === "miss" ? found.key : exchange.base,
        found.kind === "miss" ? found.variant : undefined,
      );
      return;
    }

    await coalesced(exchange, exchange.base, undefined);
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
