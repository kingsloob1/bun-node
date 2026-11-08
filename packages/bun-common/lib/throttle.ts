/**
 * Request throttling: `throttle(options)`, a middleware that counts each
 * client's requests in a {@link ThrottleStore} and answers `429 Too Many
 * Requests` past a limit, and `skipThrottle()`, a route's opt-out.
 *
 * Where it goes:
 *
 * - **Everywhere**: the `throttle` option of `BunRouter` and of both
 *   `BunHttpAdapter`s installs one as the router's first middleware, so it
 *   runs ahead of every route, every other middleware and the not-found
 *   handlers (so a burst of 404s counts too).
 * - **One route or mount**: `router.post("/login", throttle({...}), h)` or
 *   `router.use("/api", throttle({...}))`, as express-rate-limit is used.
 *
 * A route overrides a throttle that runs ahead of it (one registered with
 * `use()`, or the router option) by name: a `throttle()` among the route's
 * own callbacks with a limit of the same name replaces that limit for the
 * route (`@nestjs/throttler`'s `@Throttle({ default: … })`), and
 * `skipThrottle()` (or `skipThrottle("burst")`) turns the outer limits off
 * there (`@SkipThrottle()`). Limits with other names add to the outer ones.
 *
 * The defaults: a sliding-window counter (any store with an atomic
 * increment can run it, across processes), keyed on `req.ip` with an IPv6
 * address reduced to its `/56` (express-rate-limit 8's `ipv6Subnet`), a
 * `429` `application/problem+json` body with `Retry-After`, no rate-limit
 * headers otherwise (opt in to the IETF `RateLimit-Policy`/`RateLimit` of
 * draft-ietf-httpapi-ratelimit-headers-11 or the legacy `X-RateLimit-*`),
 * and fail-open on a store error with a warning at most every 10 s.
 * Durations always carry their unit (`"1m"`, `{ seconds: 30 }`), and limits
 * can change while serving ({@link ThrottleHandler.update}).
 */
import type { BunRequest } from "./BunRequest";
import type { BunResponse } from "./BunResponse";
import type { MatchedLayer } from "./BunRouter";
import type { Logger, LoggerLike, LogLevel } from "./logging";
import type { GcraOutcome, MaybePromise, ThrottleStore } from "./throttleStore";
import type { NextFunction, RouterHandler } from "./types/general";
import type { Duration } from "./utils/duration";
import { ConfigError } from "./errors";
import { LOG_LEVELS, resolveLogger } from "./logging";
import { memoryThrottleStore } from "./throttleStore";
import { toDurationMs } from "./utils/duration";
import { parseIpAddress, toIpv4IfMapped } from "./utils/native";

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

/**
 * How a limit counts:
 *
 * - `"sliding-window"` (the default): Cloudflare's sliding-window counter.
 *   Two fixed windows, the previous one weighted by how much of it still
 *   overlaps the sliding window: smooth at window edges (no 2× burst across
 *   a boundary) and needs only an atomic increment and a read, so it runs on
 *   every store. Approximate: it assumes the previous window's requests were
 *   spread evenly.
 * - `"fixed-window"`: one counter per aligned window. Exact and cheapest (one
 *   increment), but a client can send `2 × limit` across a window boundary.
 * - `"gcra"`: the generic cell rate algorithm, a token bucket of `limit`
 *   tokens refilling over `window`. Exact and smooth, but needs a store with
 *   an atomic {@link ThrottleStore.consumeGcra} (the memory store has one,
 *   and so has bun-cache's `cacheThrottleStore` on Redis, Postgres, MySQL,
 *   MariaDB and SQLite); any other store is refused at construction. A
 *   refused request takes no tokens.
 */
export type ThrottleAlgorithm = "fixed-window" | "gcra" | "sliding-window";

/**
 * What a limit counts per: `"global"`, one count per client across every
 * route the throttle covers (express-rate-limit's `app.use()`); `"route"`,
 * one per client **and** route (`@nestjs/throttler`'s per-handler count),
 * the route being the matched route's method and path pattern
 * (`"GET /users/:id"`), never the raw path, so ids cannot multiply counters.
 * A request no route handles counts under `"(no route)"`.
 */
export type ThrottleScope = "global" | "route";

/**
 * Which rate-limit headers go on a throttled response:
 *
 * - `false` (the default): none, so a client cannot pace itself just under
 *   a limit;
 * - `"ietf"` (and `true`): `RateLimit-Policy` and `RateLimit`, as
 *   draft-ietf-httpapi-ratelimit-headers-11 (2026-05) defines them, one list
 *   item per limit (`"default";q=100;w=60` and `"default";r=42;t=17`);
 * - `"legacy"`: `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
 *   `X-RateLimit-Reset` (seconds), with a `-<name>` suffix for a limit not
 *   named `default`, as `@nestjs/throttler` sends them;
 * - `"both"`.
 *
 * A `429` carries `Retry-After` (seconds) whatever this says.
 */
export type ThrottleHeaders = boolean | "both" | "ietf" | "legacy";

/** Answers who a request counts against: an address, `ip|account`, a user id, an API key. */
export type ThrottleKey = (req: BunRequest) => MaybePromise<string>;

/** How much a request counts: a fixed number, or one per request. */
export type ThrottleCost = number | ((req: BunRequest) => MaybePromise<number>);

/**
 * A limit's quota: a fixed number, or one per request (express-rate-limit's
 * `limit` as a function: a premium account gets more). A function answers a
 * positive integer; anything else is a `TypeError` for the error handlers.
 */
export type ThrottleQuota =
  number | ((req: BunRequest) => MaybePromise<number>);

/** Whether a request succeeded, for {@link ThrottleOptions.skipSuccessfulRequests} and {@link ThrottleOptions.skipFailedRequests}. */
export type ThrottleRequestWasSuccessful = (
  req: BunRequest,
  res: BunResponse,
) => MaybePromise<boolean>;

/** One named limit. */
export interface ThrottleLimit {
  /**
   * The most a client may spend per {@link window}: a positive integer, or a
   * function answering one per request (see {@link ThrottleQuota}). A
   * function's limit is documented as `"dynamic"` ({@link ThrottlePolicy}).
   */
  readonly limit: ThrottleQuota;
  /**
   * The window, its unit explicit: `"1m"`, `"30s"`, `"1h"`, `{ seconds: 30 }`.
   * Default `"1m"`. A bare number is refused (is it seconds or ms?), as is a
   * window under one second unless {@link allowSubSecond} says so.
   * Advertised in whole seconds (`w=`), rounded up.
   */
  readonly window?: Duration;
  /** Accept a window under one second. Default `false`: such a window is usually a unit mistake. */
  readonly allowSubSecond?: boolean;
  /** Who this limit counts against; default the throttle's {@link ThrottleOptions.key}. */
  readonly key?: ThrottleKey;
  /** What a request costs under this limit; default the throttle's {@link ThrottleOptions.cost}. */
  readonly cost?: ThrottleCost;
}

/** The limits of a throttle: what {@link throttle} and {@link ThrottleHandler.update} take. */
export interface ThrottleLimits {
  /**
   * The limit, as shorthand for `limits: { default: { limit, window } }`
   * (express-rate-limit's `limit`): a positive integer, or a function
   * answering one per request. Give it or {@link limits}, not both.
   */
  readonly limit?: ThrottleQuota;
  /** The shorthand limit's window (express-rate-limit's `windowMs`, but with a unit). Default `"1m"`. */
  readonly window?: Duration;
  /** The shorthand limit's {@link ThrottleLimit.allowSubSecond}. */
  readonly allowSubSecond?: boolean;
  /**
   * Several limits at once, by name (`{ burst: { limit: 20, window: "1s" },
   * sustained: { limit: 600, window: "1m" } }`), each with its own key if
   * it likes; a request is refused when any of them is exceeded, and counts
   * against all of them. A refused request counts too (counted, then
   * checked, in one atomic step, as express-rate-limit and
   * `@nestjs/throttler` do), so a client that keeps sending stays refused
   * and may need more than a window to recover; under `"gcra"` a refused
   * request takes nothing. Names are what the headers advertise and what a
   * route's override or `skipThrottle()` names: letters, digits, `_`, `.`
   * and `-`.
   */
  readonly limits?: Readonly<Record<string, ThrottleLimit>>;
}

/** What {@link throttle} takes. */
export interface ThrottleOptions extends ThrottleLimits {
  /**
   * Who a request counts against. Default {@link defaultThrottleKey}:
   * `req.ip` (an IPv6 address reduced to its {@link ipv6Subnet} prefix),
   * an IPv4-mapped address unmapped, `"unknown"` when there is none (a
   * socket-free `fetch()`). Behind a proxy, `req.ip` is the client's address
   * only when the adapter's `trustProxy` trusts that proxy; otherwise every
   * client behind it shares the proxy's count.
   * A key may be any string; a store namespaces it.
   */
  readonly key?: ThrottleKey;
  /**
   * The prefix length an IPv6 address is reduced to by the default
   * {@link key}, since one client usually holds a whole `/64` or `/56` and
   * can rotate addresses inside it. Default `56` (express-rate-limit 8's
   * `ipv6Subnet`); `false` keeps the full address. An integer from 1 to 128.
   */
  readonly ipv6Subnet?: false | number;
  /** What a request costs. Default `1`. A non-negative finite number. */
  readonly cost?: ThrottleCost;
  /**
   * Requests it answers `true` for are neither counted nor refused, and get
   * no headers: a health check, a trusted service's call, an allow-listed
   * network. Default: none. An error it throws goes to the error handlers.
   */
  readonly skip?: (req: BunRequest, res: BunResponse) => MaybePromise<boolean>;
  /** How every limit counts. Default `"sliding-window"`; see {@link ThrottleAlgorithm}. */
  readonly algorithm?: ThrottleAlgorithm;
  /**
   * Gives a successful request's cost back once its response is known, so
   * only failures count: a login limit that counts failed attempts alone.
   * express-rate-limit's `skipSuccessfulRequests`: on the response's
   * `finish`, a request {@link requestWasSuccessful} calls successful is
   * refunded from every limit it counted against. The refund comes after
   * the request was counted and let through, so concurrent requests still
   * see it counted while it runs. Default `false`.
   */
  readonly skipSuccessfulRequests?: boolean;
  /**
   * Gives a failed request's cost back once its response is known, so only
   * successes count. express-rate-limit's `skipFailedRequests`: refunded on
   * the response's `finish` when {@link requestWasSuccessful} says it
   * failed, on `close` before the response ended (the client went away),
   * and on `error`. A refused request is answered `429`, a failure, so it is
   * refunded too and a client that keeps sending is not held back by its
   * refusals; under `"gcra"` a refused request took nothing and gets
   * nothing back. Default `false`.
   */
  readonly skipFailedRequests?: boolean;
  /**
   * What {@link skipSuccessfulRequests} and {@link skipFailedRequests} call
   * success. Default: `res.statusCode < 400` (express-rate-limit's
   * `requestWasSuccessful`). An error it throws or rejects with counts the
   * request as successful for neither option: nothing is refunded.
   */
  readonly requestWasSuccessful?: ThrottleRequestWasSuccessful;
  /**
   * Where the counts live. Default a {@link memoryThrottleStore} of this
   * throttle's own (per process). For one limit across processes, a shared
   * store: `cacheThrottleStore(cache)` from `@kingsleyweb/bun-cache/throttle`.
   * Two throttles sharing a store need different {@link prefix}es (or limit
   * names), or they count together.
   */
  readonly store?: ThrottleStore;
  /** The namespace of every key this throttle writes. Default `"throttle"`. */
  readonly prefix?: string;
  /**
   * What a limit counts per. Default `"global"` for a throttle that runs
   * ahead of the routes (`use()`, the router option), `"route"` for one
   * among a route's own callbacks, so two routes sharing a store and a
   * prefix never share a count by accident. Pass `"global"` to a route-level
   * throttle used on several routes to give them one budget: register the
   * same `throttle()` on each, or give separate ones the same {@link store}
   * and {@link prefix} (each `throttle()` otherwise counts in a memory store
   * of its own).
   */
  readonly scope?: ThrottleScope;
  /** Which headers to send. Default `false` (none but `Retry-After` on a `429`); see {@link ThrottleHeaders}. */
  readonly headers?: ThrottleHeaders;
  /**
   * Called for every refused request, in place of the default `429`
   * `application/problem+json` answer ({@link sendTooManyRequests}, which
   * it may call itself): express-rate-limit's `handler`. The headers
   * (`Retry-After` included) are already set; `info` names each limit, its
   * key, its count and its reset. Calling `next()` lets the request
   * through; `next(err)` sends it to the error handlers.
   */
  readonly onLimited?: ThrottleLimitedHandler;
  /**
   * What a request gets when the store fails (throws or rejects):
   *
   * - `"open"` (the default): it goes through, unthrottled and without
   *   headers, and a warning is logged at most once every 10 s
   *   (express-rate-limit's `passOnStoreError: true`);
   * - `"closed"`: a {@link ThrottleStoreError} (`503`) goes to the error
   *   handlers (express-rate-limit's default);
   * - a {@link ThrottleStore}: it is counted there instead ("degrade to
   *   local", e.g. a {@link memoryThrottleStore}), with the same warning;
   *   should that fail too, the request goes through.
   */
  readonly failMode?: "closed" | "open" | ThrottleStore;
  /**
   * Logs one line per refused request at this level (`true`: `"warn"`),
   * naming the route and the limits, never the key (no address, no
   * account). Default `false`.
   */
  readonly logLimited?: boolean | LogLevel;
  /**
   * Where the fail-open warning and {@link logLimited} lines go. Default the
   * logger of the router the throttle is registered on, else a console
   * logger.
   */
  readonly logger?: LoggerLike;
  /**
   * The clock, epoch milliseconds, that places a request in a window.
   * Default `Date.now`; tests pass a fake one. Processes sharing a store
   * must have synchronised clocks (NTP), since a skew shifts their window
   * edges by as much, unless the store keeps its own clock: one whose
   * {@link ThrottleStore.countWindow} and `consumeGcra` read the server's
   * time (bun-cache's `cacheThrottleStore` on Redis and SQL does, by
   * default) ignores this clock for counting.
   */
  readonly now?: () => number;
}

/** One limit's outcome for one request. */
export interface ThrottleResult {
  /** The limit's name. */
  readonly name: string;
  /** The key the request counted against (the client's address, `ip|account`, …): never put it in a log line by default. */
  readonly key: string;
  /** What the limit counted per, for this request (`"global"`, or the route: `"GET /users/:id"`). */
  readonly scope: string;
  /** Its quota per window. */
  readonly limit: number;
  /** Its window, in milliseconds. */
  readonly window: number;
  /** The algorithm that counted it. */
  readonly algorithm: ThrottleAlgorithm;
  /** How much of the quota is spent, this request included (an estimate under the sliding window). */
  readonly used: number;
  /** Whole units left (`0` when refused). */
  readonly remaining: number;
  /** Milliseconds until the quota refills: the current window's end, or the bucket's. */
  readonly resetAfter: number;
  /** Milliseconds until a request of the same cost would fit; `0` when this one did. */
  readonly retryAfter: number;
  /** Whether this limit refused the request. */
  readonly limited: boolean;
}

/** What {@link ThrottleOptions.onLimited} is told. */
export interface ThrottleLimitedInfo {
  /** Every limit's outcome. */
  readonly results: readonly ThrottleResult[];
  /** The limits that refused the request (at least one). */
  readonly limited: readonly ThrottleResult[];
  /** Milliseconds until the request would fit every limit: the longest wait. */
  readonly retryAfter: number;
  /** The route the request reached (`"POST /login"`), `"(no route)"` for none, `"(unknown)"` when the router did not record it. */
  readonly route: string;
}

/** Answers a refused request; see {@link ThrottleOptions.onLimited}. */
export type ThrottleLimitedHandler = (
  req: BunRequest,
  res: BunResponse,
  next: NextFunction,
  info: ThrottleLimitedInfo,
) => unknown;

/** One limit as documents describe it (`x-bun-throttle`, the `429`). */
export interface ThrottlePolicy {
  /** The limit's name. */
  readonly name: string;
  /** Its quota per window; `"dynamic"` when a function answers it per request. */
  readonly limit: number | "dynamic";
  /** Its window, in milliseconds. */
  readonly window: number;
  /** How it counts. */
  readonly algorithm: ThrottleAlgorithm;
  /** What it counts per, as it applies to the route described. */
  readonly scope: ThrottleScope;
}

/** What {@link ThrottleHandler.reset} takes. */
export interface ThrottleResetOptions {
  /** Only these limits. Default: every limit. */
  readonly limits?: readonly string[];
  /**
   * The route a `"route"`-scoped count belongs to, as {@link ThrottleResult.scope}
   * names it (`"POST /login"`). Default `"global"`, the scope of a throttle
   * ahead of the routes.
   */
  readonly scope?: string;
}

/** The middleware {@link throttle} returns, with a handle on its limits and counts. */
export interface ThrottleHandler extends RouterHandler {
  /** Its limits as they stand, as documented (scope as it applies ahead of the routes). */
  readonly policies: readonly ThrottlePolicy[];
  /** The store it counts in. */
  readonly store: ThrottleStore;
  /**
   * Replaces its limits while it serves, without re-registering it: what a
   * central policy calls when its bundle changes. Takes the same
   * `limit`/`window` or `limits` as {@link throttle}, checked the same way
   * (a `ConfigError` leaves the old limits in place). Requests already
   * counting finish under the old ones. Counts carry over for a limit whose
   * name and window are unchanged; a new window starts from zero.
   */
  update: (limits: ThrottleLimits) => void;
  /**
   * What the request would get, consuming nothing: each limit's result as
   * if the request were counted (its cost included), for a dry run or an
   * `explain()`. Called from a handler the throttle already let through,
   * the request is counted once already, so `used` includes it and the
   * cost again. Uses the limits that apply ahead of the request's route.
   * Rejects (or throws) when the store fails, whatever `failMode` says.
   */
  peek: (req: BunRequest) => MaybePromise<ThrottleResult[]>;
  /**
   * Forgets one key's counts (an operator's unban, an allow-list entry), in
   * the current and previous windows of each limit. Needs a store with
   * {@link ThrottleStore.delete} (or, for a window algorithm on a store with
   * `countWindow`, {@link ThrottleStore.deleteWindow}); throws a
   * `ConfigError` without one.
   *
   * @param key The key, as the throttle's `key` answered it (for the default key, {@link throttleAddressKey} of the address).
   */
  reset: (key: string, options?: ThrottleResetOptions) => MaybePromise<void>;
}

/**
 * The error a throttle with `failMode: "closed"` passes to the error
 * handlers when its store fails: status `503`, the store's error as
 * `cause`.
 */
export class ThrottleStoreError extends Error {
  /** `503 Service Unavailable`: the limit cannot be checked, so the request is not served. */
  readonly status = 503;
  /** The same, for handlers that read `statusCode`. */
  readonly statusCode = 503;
  /** The failing store's name. */
  readonly store: string;

  constructor(
    /** The failing store's name. */
    store: string,
    /** What the store threw. */
    cause: unknown,
  ) {
    super(`throttle store "${store}" failed`, { cause });
    this.name = "ThrottleStoreError";
    this.store = store;
  }
}

/* ------------------------------------------------------------------ *
 * Internals shared with the router and the route model
 * ------------------------------------------------------------------ */

/** Tags a {@link throttle} middleware; its value is the throttle's state. */
const THROTTLE: unique symbol = Symbol.for("@kingsleyweb/bun-common.throttle");
/** Tags a {@link skipThrottle} marker; its value is the names it skips, or `null` for all. */
const SKIP: unique symbol = Symbol.for("@kingsleyweb/bun-common.skipThrottle");

/** A compiled limit. */
interface CompiledLimit {
  readonly name: string;
  readonly limit: ThrottleQuota;
  readonly window: number;
  readonly key: ThrottleKey;
  readonly cost: ThrottleCost;
}

/** What a request runs: the limits left for its route, and its scope. */
interface Plan {
  readonly limits: readonly CompiledLimit[];
  readonly scope: ThrottleScope;
}

/** A throttle's state, behind its {@link THROTTLE} tag. */
interface ThrottleState {
  /** The limits in force (replaced by `update()`). */
  limits: readonly CompiledLimit[];
  readonly scope: ThrottleScope | undefined;
  /** A router's logger, bound when it registers the throttle (see {@link bindThrottleLogger}). */
  routerLogger: (() => Logger) | undefined;
}

type Tagged = RouterHandler & {
  [THROTTLE]?: ThrottleState;
  [SKIP]?: ReadonlySet<string> | null;
};

/**
 * The matched layers of each request a throttle-bearing router runs, so a
 * throttle ahead of the routes can find the route the request will reach.
 * Recorded only by a router that holds a throttle ({@link recordThrottlePipeline}).
 */
const PIPELINES = new WeakMap<object, readonly MatchedLayer[]>();

/** What each request's throttles answered, for {@link getThrottleResults}. */
const RESULTS = new WeakMap<object, ThrottleResult[]>();

/**
 * Records a request's matched layers; the router calls it when it starts a
 * pipeline, and only while some route of it carries a throttle. Internal.
 */
export function recordThrottlePipeline(
  req: object,
  layers: readonly MatchedLayer[],
): void {
  PIPELINES.set(req, layers);
}

/** Whether `callback` is a {@link throttle} middleware or a {@link skipThrottle} marker. Internal. */
export function isThrottleCallback(callback: unknown): boolean {
  return (
    typeof callback === "function" &&
    ((callback as Tagged)[THROTTLE] !== undefined ||
      (callback as Tagged)[SKIP] !== undefined)
  );
}

/** Whether `callback` is a {@link skipThrottle} marker. Internal. */
export function isSkipThrottleMarker(callback: unknown): boolean {
  return (
    typeof callback === "function" && (callback as Tagged)[SKIP] !== undefined
  );
}

/**
 * Gives a throttle registered on a router that router's logger, unless its
 * own `logger` option named one or another router got there first. Internal.
 */
export function bindThrottleLogger(
  callback: unknown,
  logger: () => Logger,
): void {
  if (typeof callback !== "function") return;
  const state = (callback as Tagged)[THROTTLE];
  if (state !== undefined) state.routerLogger ??= logger;
}

/** Whether `callback` is a {@link throttle} middleware. */
export function isThrottleHandler(
  callback: unknown,
): callback is ThrottleHandler {
  return (
    typeof callback === "function" &&
    (callback as Tagged)[THROTTLE] !== undefined
  );
}

/**
 * What the throttles a request met answered, outermost first: one entry per
 * limit counted (express-rate-limit's `req.rateLimit`). `undefined` when no
 * throttle counted the request (none ran, it was skipped, or the store
 * failed open).
 */
export function getThrottleResults(
  req: BunRequest,
): readonly ThrottleResult[] | undefined {
  return RESULTS.get(req);
}

/** The names a route's own callbacks claim: skipped (all, or by name) and overridden. */
interface RouteClaims {
  skipAll: boolean;
  names: Set<string>;
}

/** What a route's own callbacks say about the throttles ahead of it. */
function claimsOf(own: readonly unknown[], self?: unknown): RouteClaims {
  const claims: RouteClaims = { skipAll: false, names: new Set() };
  for (const callback of own) {
    if (typeof callback !== "function" || callback === self) continue;
    const tagged = callback as Tagged;
    const skip = tagged[SKIP];
    if (skip === null) claims.skipAll = true;
    else if (skip !== undefined) {
      for (const name of skip) claims.names.add(name);
    }
    const state = tagged[THROTTLE];
    if (state !== undefined) {
      for (const limit of state.limits) claims.names.add(limit.name);
    }
  }
  return claims;
}

/**
 * The throttle policies that apply to a route, for a document: those of
 * each throttle in `outer` (the middleware that runs ahead of the route)
 * that the route's own callbacks neither skip nor override, then those of
 * each throttle among `own`. Internal: `listRoutes` calls it.
 */
export function throttlePoliciesFor(
  outer: readonly unknown[],
  own: readonly unknown[],
): ThrottlePolicy[] {
  const claims = claimsOf(own);
  const policies: ThrottlePolicy[] = [];
  for (const callback of outer) {
    if (!isThrottleHandler(callback) || own.includes(callback)) continue;
    if (claims.skipAll) continue;
    for (const policy of callback.policies) {
      if (!claims.names.has(policy.name)) policies.push(policy);
    }
  }
  for (const callback of own) {
    if (!isThrottleHandler(callback)) continue;
    const scope = (callback as Tagged)[THROTTLE]?.scope ?? "route";
    for (const policy of callback.policies) {
      policies.push({ ...policy, scope });
    }
  }
  return policies;
}

/* ------------------------------------------------------------------ *
 * The default key
 * ------------------------------------------------------------------ */

/**
 * An address reduced to what identifies its client: an IPv4 address (an
 * IPv4-mapped IPv6 one included, through bun-common's `toIpv4IfMapped`) in
 * dotted form, an IPv6 address to its first `prefix` bits
 * (`"2001:db8:aa:bb00::/56"`, any zone dropped), anything else unchanged.
 *
 * @param address The address (`req.ip`).
 * @param prefix  The IPv6 prefix length kept, 1–128; `false` keeps it all.
 */
export function throttleAddressKey(
  address: string,
  prefix: false | number = 56,
): string {
  const parsed = parseIpAddress(address);
  if (parsed === null) return address;
  // An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, how a dual-stack
  // listener reports an IPv4 peer) is its IPv4 client, so both forms share
  // one count; the legacy IPv4 spellings (`0x7f.0.0.1`) read canonically.
  const ip = toIpv4IfMapped(parsed);
  if (ip.kind === "ipv4") return ip.octets.join(".");
  const groups = ip.parts;
  const bits = prefix === false ? 128 : prefix;
  const masked = groups.map((group, index) => {
    const start = index * 16;
    if (bits >= start + 16) return group;
    if (bits <= start) return 0;
    return group & (0xffff << (16 - (bits - start))) & 0xffff;
  });
  // Shortest form: the longest run of two or more zero groups as `::`.
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < 8;) {
    if (masked[index] !== 0) {
      index++;
      continue;
    }
    let end = index;
    while (end < 8 && masked[end] === 0) end++;
    if (end - index > bestLength && end - index > 1) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  const hex = masked.map((group) => group.toString(16));
  const text =
    bestStart === -1
      ? hex.join(":")
      : `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
  return bits === 128 ? text : `${text}/${bits}`;
}

/**
 * The default {@link ThrottleOptions.key}: `req.ip` through
 * {@link throttleAddressKey} with a `/56` IPv6 prefix, `"unknown"` when the
 * request has no address.
 */
export function defaultThrottleKey(req: BunRequest): string {
  const ip = req.ip;
  return ip === "" ? "unknown" : throttleAddressKey(ip);
}

/* ------------------------------------------------------------------ *
 * Counting
 * ------------------------------------------------------------------ */

/** Whether `value` is a promise (or any thenable). */
function isThenable<T>(value: MaybePromise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** `fn(value)`, now or once `value` settles. */
function then<T, R>(
  value: MaybePromise<T>,
  fn: (resolved: T) => MaybePromise<R>,
): MaybePromise<R> {
  return isThenable(value) ? value.then(fn) : fn(value);
}

/** Every value, now when none is a promise. */
function all<T>(values: MaybePromise<T>[]): MaybePromise<T[]> {
  for (const value of values) {
    if (isThenable(value)) return Promise.all(values);
  }
  return values as T[];
}

/** A store failure, kept apart from a failure of the caller's own functions. */
class StoreFailure extends Error {
  constructor(cause: unknown) {
    super("throttle store failed", { cause });
    this.name = "StoreFailure";
  }
}

/** Runs a store call, turning a throw or a rejection into a {@link StoreFailure}. */
function guarded<T>(run: () => MaybePromise<T>): MaybePromise<T> {
  let value: MaybePromise<T>;
  try {
    value = run();
  } catch (error) {
    throw new StoreFailure(error);
  }
  return isThenable(value)
    ? value.then(undefined, (error: unknown) => {
        throw new StoreFailure(error);
      })
    : value;
}

/** Who a result is for: the limit's name, the key and the scope. */
interface ResultOf {
  readonly name: string;
  readonly key: string;
  readonly scope: string;
}

/**
 * The sliding-window outcome, from the current and previous windows' counts:
 * the previous count weighted by how much of it the sliding window still
 * covers, plus the current one.
 */
export function slidingWindowResult(
  input: {
    /** The quota. */
    readonly limit: number;
    /** The window, ms. */
    readonly window: number;
    /** This request's cost. */
    readonly cost: number;
    /** Milliseconds into the current window. */
    readonly elapsed: number;
    /** The current window's count, this request included. */
    readonly current: number;
    /** The previous window's final count. */
    readonly previous: number;
  },
  of: ResultOf = { name: "default", key: "", scope: "global" },
): ThrottleResult {
  const { limit, window, cost, elapsed, current, previous } = input;
  const left = window - elapsed;
  const estimate = (previous * left) / window + current;
  const limited = estimate > limit;
  let retryAfter = 0;
  if (limited) {
    if (current + cost <= limit && previous > 0) {
      // Fits later in this window, once enough of the previous one has
      // slid out.
      retryAfter = left - (window * (limit - current - cost)) / previous;
    } else {
      // Only in the next window, as the current count slides out.
      const into =
        cost > limit ? window : window * (1 - (limit - cost) / current);
      retryAfter = left + Math.max(0, into);
    }
    retryAfter = Math.max(1, Math.ceil(retryAfter));
  }
  return {
    ...of,
    limit,
    window,
    algorithm: "sliding-window",
    used: Math.ceil(estimate - 1e-9),
    remaining: limited ? 0 : Math.max(0, Math.floor(limit - estimate + 1e-9)),
    resetAfter: limited ? retryAfter : left,
    retryAfter,
    limited,
  };
}

/** A limit's quota and window, as one request sees them. */
interface Quota {
  /** The quota, resolved for the request. */
  readonly limit: number;
  /** The window, ms. */
  readonly window: number;
}

/** A limit as it applies to one request: who it counts against, the cost and the quota, resolved. */
interface Input {
  /** The key. */
  readonly key: string;
  /** The cost. */
  readonly cost: number;
  /** The quota. */
  readonly limit: number;
}

/** The fixed-window outcome, from the window's count. */
function fixedWindowResult(
  limit: Quota,
  of: ResultOf,
  current: number,
  elapsed: number,
): ThrottleResult {
  const limited = current > limit.limit;
  const left = limit.window - elapsed;
  return {
    ...of,
    limit: limit.limit,
    window: limit.window,
    algorithm: "fixed-window",
    used: current,
    remaining: Math.max(0, limit.limit - current),
    resetAfter: left,
    retryAfter: limited ? Math.max(1, left) : 0,
    limited,
  };
}

/** The GCRA outcome, from the store's answer. */
function gcraResult(
  limit: Quota,
  of: ResultOf,
  outcome: GcraOutcome,
): ThrottleResult {
  return {
    ...of,
    limit: limit.limit,
    window: limit.window,
    algorithm: "gcra",
    used: limit.limit - outcome.remaining,
    remaining: outcome.allowed ? outcome.remaining : 0,
    resetAfter: Math.ceil(outcome.resetAfter),
    retryAfter: outcome.allowed
      ? 0
      : Math.max(1, Math.ceil(outcome.retryAfter)),
    limited: !outcome.allowed,
  };
}

/** Whole seconds, rounded up, at least `min`. */
function seconds(ms: number, min = 0): number {
  return Math.max(min, Math.ceil(ms / 1000));
}

/** The label a route counts under with `scope: "route"`. */
function routeLabel(matched: unknown): string {
  if (matched === undefined || matched === null) return "(no route)";
  const { method, path } = matched as { method?: unknown; path?: unknown };
  const verb =
    typeof method === "string" && method !== ""
      ? method
      : Array.isArray(method)
        ? method.join(",")
        : "ALL";
  return `${verb} ${typeof path === "string" ? path : "*"}`;
}

/** The first route handler a request's pipeline reaches; `null` when the router recorded none. */
function routeLayerOf(req: object): MatchedLayer | null | undefined {
  const layers = PIPELINES.get(req);
  if (layers === undefined) return null;
  for (const layer of layers) {
    if (layer.isRouteHandler && !layer.isErrorHandler) return layer;
  }
  return undefined;
}

/**
 * The default {@link ThrottleOptions.onLimited}: `429` with an RFC 9457
 * `application/problem+json` body in bun-common's error style
 * (`urn:bun-common:error:TOO_MANY_REQUESTS`) and `Cache-Control: no-store`.
 * It names no limit, key or count.
 */
export function sendTooManyRequests(
  _req: BunRequest,
  res: BunResponse,
  _next: NextFunction,
  info: ThrottleLimitedInfo,
): void {
  if (res.headersSent) return;
  const wait = seconds(info.retryAfter, 1);
  res.status(429);
  res.setHeader("Content-Type", "application/problem+json");
  res.setHeader("Cache-Control", "no-store");
  res.send(
    JSON.stringify({
      type: "urn:bun-common:error:TOO_MANY_REQUESTS",
      title: "Too Many Requests",
      status: 429,
      code: "TOO_MANY_REQUESTS",
      detail: `Rate limit exceeded; retry in ${wait} second${wait === 1 ? "" : "s"}.`,
    }),
  );
}

/** The warning cadence when failing open, as bun-cache's §3.14. */
const WARN_EVERY_MS = 10_000;

/** The policy-name grammar: a token RFC 9651 strings carry without escapes. */
const NAME = /^[a-z0-9][\w.-]*$/i;

/** Checks a `cost` option. */
function checkCost(cost: unknown, what: string): ThrottleCost {
  if (
    typeof cost === "function" ||
    (typeof cost === "number" && Number.isFinite(cost) && cost >= 0)
  ) {
    return cost as ThrottleCost;
  }
  throw new ConfigError(
    `throttle(): ${what} must be a non-negative finite number or a function`,
  );
}

/** Compiles the limits of {@link ThrottleLimits}, or throws a `ConfigError`. */
function compileLimits(
  given: ThrottleLimits,
  baseKey: ThrottleKey,
  baseCost: ThrottleCost,
): CompiledLimit[] {
  const where = "throttle()";
  if (given === null || typeof given !== "object") {
    throw new ConfigError(`${where}: limits must be an object`);
  }
  if (given.limits !== undefined && given.limit !== undefined) {
    throw new ConfigError(
      `${where}: give either \`limit\` (with \`window\`) or \`limits\`, not both`,
    );
  }
  const specs: Readonly<Record<string, ThrottleLimit>> =
    given.limits ??
    (given.limit === undefined
      ? {}
      : {
          default: {
            limit: given.limit,
            ...(given.window === undefined ? {} : { window: given.window }),
            ...(given.allowSubSecond === undefined
              ? {}
              : { allowSubSecond: given.allowSubSecond }),
          },
        });
  const limits: CompiledLimit[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    if (!NAME.test(name)) {
      throw new ConfigError(
        `${where}: limit name ${JSON.stringify(name)} must start with a letter or digit and hold only letters, digits, "_", "." and "-"`,
      );
    }
    if (spec === null || typeof spec !== "object") {
      throw new ConfigError(`${where}: limits.${name} must be an object`);
    }
    if (
      typeof spec.limit !== "function" &&
      (!Number.isInteger(spec.limit) || spec.limit < 1)
    ) {
      throw new ConfigError(
        `${where}: limits.${name}.limit must be a positive integer or a function; got ${JSON.stringify(spec.limit)}`,
      );
    }
    const window = toDurationMs(
      spec.window ?? "1m",
      `${where}: limits.${name}.window`,
    );
    if (window < 1000 && spec.allowSubSecond !== true) {
      throw new ConfigError(
        `${where}: limits.${name}.window is ${window} ms, under a second; that is usually a unit mistake. Set allowSubSecond: true if it is meant`,
        { window },
      );
    }
    limits.push({
      name,
      limit: spec.limit,
      window,
      key: spec.key ?? baseKey,
      cost:
        spec.cost === undefined
          ? baseCost
          : checkCost(spec.cost, `limits.${name}.cost`),
    });
  }
  if (limits.length === 0) {
    throw new ConfigError(
      `${where}: give a \`limit\` (and a \`window\`), or at least one entry in \`limits\``,
    );
  }
  return limits;
}

/** The log levels {@link ThrottleOptions.logLimited} takes. */
const LEVELS: readonly unknown[] = LOG_LEVELS;

/** Whether `value` has a store's two required methods. */
function isStore(value: unknown): value is ThrottleStore {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as ThrottleStore).increment === "function" &&
    typeof (value as ThrottleStore).get === "function"
  );
}

/**
 * Builds a throttle middleware: see the module's description and
 * {@link ThrottleOptions}. Every option is checked here, so a bad one
 * throws a `ConfigError` at startup rather than per request.
 *
 * ```ts
 * app.use(throttle({ limit: 600, window: "1m" }));
 * app.post(
 *   "/login",
 *   throttle({
 *     limits: {
 *       account: { limit: 10, window: "1m", key: (req) => `${req.ip}|${req.body?.email}` },
 *       address: { limit: 30, window: "1m" },
 *     },
 *   }),
 *   login,
 * );
 * app.get("/health", skipThrottle(), health);
 * ```
 */
export function throttle(options: ThrottleOptions): ThrottleHandler {
  const where = "throttle()";
  if (options === null || typeof options !== "object") {
    throw new ConfigError(`${where}: options must be an object`);
  }
  const algorithm = options.algorithm ?? "sliding-window";
  if (!["fixed-window", "gcra", "sliding-window"].includes(algorithm)) {
    throw new ConfigError(
      `${where}: algorithm must be "sliding-window", "fixed-window" or "gcra"; got ${JSON.stringify(algorithm)}`,
    );
  }
  const store =
    options.store ??
    memoryThrottleStore(options.now === undefined ? {} : { now: options.now });
  if (!isStore(store)) {
    throw new ConfigError(
      `${where}: store must implement increment(key, cost, ttl) and get(key)`,
    );
  }
  const failMode = options.failMode ?? "open";
  if (failMode !== "open" && failMode !== "closed" && !isStore(failMode)) {
    throw new ConfigError(
      `${where}: failMode must be "open", "closed" or a fallback ThrottleStore`,
    );
  }
  const fallback = isStore(failMode) ? failMode : undefined;
  for (const counted of fallback === undefined ? [store] : [store, fallback]) {
    if (algorithm === "gcra" && typeof counted.consumeGcra !== "function") {
      throw new ConfigError(
        `${where}: algorithm "gcra" needs a store with an atomic consumeGcra(); store "${counted.name}" has none. Use "sliding-window" (any store), or a store that implements it (memoryThrottleStore)`,
        { store: counted.name },
      );
    }
  }
  const headerMode = options.headers ?? false;
  if (![true, false, "ietf", "legacy", "both"].includes(headerMode)) {
    throw new ConfigError(
      `${where}: headers must be true, false, "ietf", "legacy" or "both"`,
    );
  }
  const ietf =
    headerMode === true || headerMode === "ietf" || headerMode === "both";
  const legacy = headerMode === "legacy" || headerMode === "both";
  const scope = options.scope;
  if (scope !== undefined && scope !== "global" && scope !== "route") {
    throw new ConfigError(`${where}: scope must be "global" or "route"`);
  }
  const prefix = options.prefix ?? "throttle";
  if (typeof prefix !== "string" || prefix === "") {
    throw new ConfigError(`${where}: prefix must be a non-empty string`);
  }
  const subnet = options.ipv6Subnet ?? 56;
  if (
    subnet !== false &&
    (!Number.isInteger(subnet) || subnet < 1 || subnet > 128)
  ) {
    throw new ConfigError(
      `${where}: ipv6Subnet must be an integer from 1 to 128, or false`,
    );
  }
  const logLimited = options.logLimited ?? false;
  const limitedLevel: LogLevel | undefined =
    logLimited === true
      ? "warn"
      : logLimited === false
        ? undefined
        : logLimited;
  if (limitedLevel !== undefined && !LEVELS.includes(limitedLevel)) {
    throw new ConfigError(
      `${where}: logLimited must be a boolean or a log level`,
    );
  }
  const baseKey: ThrottleKey =
    options.key ??
    (subnet === 56
      ? defaultThrottleKey
      : (req) => {
          const ip = req.ip;
          return ip === "" ? "unknown" : throttleAddressKey(ip, subnet);
        });
  const baseCost = checkCost(options.cost ?? 1, "cost");
  const now = options.now ?? Date.now;
  const onLimited = options.onLimited ?? sendTooManyRequests;
  const skipSuccessful = options.skipSuccessfulRequests ?? false;
  const skipFailed = options.skipFailedRequests ?? false;
  if (typeof skipSuccessful !== "boolean" || typeof skipFailed !== "boolean") {
    throw new ConfigError(
      `${where}: skipSuccessfulRequests and skipFailedRequests must be booleans`,
    );
  }
  const requestWasSuccessful: ThrottleRequestWasSuccessful =
    options.requestWasSuccessful ?? ((_req, res) => res.statusCode < 400);
  if (typeof requestWasSuccessful !== "function") {
    throw new ConfigError(`${where}: requestWasSuccessful must be a function`);
  }
  const refunds = skipSuccessful || skipFailed;

  const state: ThrottleState = {
    limits: compileLimits(options, baseKey, baseCost),
    scope,
    routerLogger: undefined,
  };
  let logger: Logger | undefined;
  const log = (): Logger =>
    (logger ??= resolveLogger(options.logger, state.routerLogger?.()));
  let lastWarnAt = Number.NEGATIVE_INFINITY;
  const warnStoreFailure = (cause: unknown, what: string): void => {
    const at = Date.now();
    if (at - lastWarnAt < WARN_EVERY_MS) return;
    lastWarnAt = at;
    log().warn(`throttle store "${store.name}" failed; ${what}`, {
      error: cause,
    });
  };

  // `self` is the handler, set below: a route's plan asks whether the
  // handler is among the route's own callbacks.
  let self: RouterHandler | undefined;
  /** Each route's plan, by its callbacks array (stable per route record); dropped by `update()`. */
  let plans = new WeakMap<object, Plan>();
  const outerPlan = (): Plan => ({
    limits: state.limits,
    scope: scope ?? "global",
  });
  let outer = outerPlan();
  const planFor = (layer: MatchedLayer | null | undefined): Plan => {
    if (layer === null || layer === undefined) return outer;
    const callbacks = (layer.matched as { callbacks?: unknown[] }).callbacks;
    if (!Array.isArray(callbacks)) return outer;
    let plan = plans.get(callbacks);
    if (plan === undefined) {
      if (callbacks.includes(self)) {
        plan = { limits: state.limits, scope: scope ?? "route" };
      } else {
        const claims = claimsOf(callbacks, self);
        plan = {
          limits: claims.skipAll
            ? []
            : state.limits.filter((limit) => !claims.names.has(limit.name)),
          scope: scope ?? "global",
        };
      }
      plans.set(callbacks, plan);
    }
    return plan;
  };

  /** A GCRA bucket's key: a fixed quota is part of it, a per-request one is not (its bucket survives a change of quota). */
  const gcraKey = (limit: CompiledLimit, of: ResultOf): string =>
    `${prefix}:${limit.name}:gcra:${limit.window}:${typeof limit.limit === "number" ? limit.limit : "dynamic"}:${of.scope}:${of.key}`;

  /** One limit, counted in `counter` (or only read, with `peek`). */
  const count = (
    counter: ThrottleStore,
    limit: CompiledLimit,
    of: ResultOf,
    input: Input,
    at: number,
    peek: boolean,
  ): MaybePromise<ThrottleResult> => {
    const window = limit.window;
    const cost = input.cost;
    const quota: Quota = { limit: input.limit, window };
    if (algorithm === "gcra") {
      const consume = counter.consumeGcra?.bind(counter);
      if (consume === undefined) {
        throw new StoreFailure(new Error("the store has no consumeGcra()"));
      }
      return then(
        guarded(() =>
          consume(gcraKey(limit, of), {
            limit: quota.limit,
            window,
            cost: peek ? 0 : cost,
            now: at,
          }),
        ),
        (outcome) =>
          gcraResult(
            quota,
            of,
            peek && cost > 0
              ? // As if counted: it fits when `cost` more units do.
                {
                  ...outcome,
                  allowed: outcome.remaining >= cost,
                  remaining: Math.max(0, outcome.remaining - cost),
                }
              : outcome,
          ),
      );
    }
    const base = `${prefix}:${limit.name}:${window}:${of.scope}:${of.key}`;
    const countWindow = counter.countWindow?.bind(counter);
    if (countWindow !== undefined) {
      // One call, and the store's clock when it keeps one: it places the
      // request in a window and says how far into it the request is.
      return then(
        guarded(() =>
          countWindow(base, {
            window,
            cost: peek ? 0 : cost,
            previous: algorithm === "sliding-window",
            now: at,
          }),
        ),
        (counted) => {
          const current = Number(counted.current) + (peek ? cost : 0);
          const elapsed = Math.min(
            window,
            Math.max(0, Number(counted.elapsed)),
          );
          return algorithm === "fixed-window"
            ? fixedWindowResult(quota, of, current, elapsed)
            : slidingWindowResult(
                {
                  limit: quota.limit,
                  window,
                  cost,
                  elapsed,
                  current,
                  previous: Number(counted.previous),
                },
                of,
              );
        },
      );
    }
    const index = Math.floor(at / window);
    const elapsed = at - index * window;
    const currentKey = `${base}:${index}`;
    const current = guarded(() =>
      peek
        ? then(counter.get(currentKey), (value) => Number(value ?? 0) + cost)
        : // The sliding window's current counter lives until the next
          // window ends, when it is still read as the previous one.
          counter.increment(
            currentKey,
            cost,
            algorithm === "fixed-window"
              ? window - elapsed
              : 2 * window - elapsed,
          ),
    );
    if (algorithm === "fixed-window") {
      return then(current, (value) =>
        fixedWindowResult(quota, of, Number(value), elapsed),
      );
    }
    const previous = guarded(() => counter.get(`${base}:${index - 1}`));
    return then(all<number | undefined>([current, previous]), ([c, p]) =>
      slidingWindowResult(
        {
          limit: quota.limit,
          window,
          cost,
          elapsed,
          current: Number(c ?? 0),
          previous: Number(p ?? 0),
        },
        of,
      ),
    );
  };

  /** Every limit of `plan`, counted in `counter`. */
  const countAll = (
    counter: ThrottleStore,
    plan: Plan,
    inputs: readonly Input[],
    scopeKey: string,
    at: number,
    peek: boolean,
  ): MaybePromise<ThrottleResult[]> =>
    all(
      plan.limits.map((limit, index) =>
        count(
          counter,
          limit,
          { name: limit.name, key: inputs[index].key, scope: scopeKey },
          inputs[index],
          at,
          peek,
        ),
      ),
    );

  /**
   * Gives back what a request counted, in `counter` (`skipSuccessfulRequests`,
   * `skipFailedRequests`): its cost from the window it counted in (placed by
   * `at`, or by the store's clock on a store that keeps one), or, under
   * GCRA, the tokens it took (a refused request took none). A refund that
   * fails is lost: the request stays counted.
   */
  const refundAll = (
    counter: ThrottleStore,
    plan: Plan,
    inputs: readonly Input[],
    scopeKey: string,
    at: number,
    results: readonly ThrottleResult[],
  ): MaybePromise<unknown> =>
    all(
      plan.limits.map((limit, index): MaybePromise<unknown> => {
        const input = inputs[index];
        if (input.cost === 0) return undefined;
        const of = { name: limit.name, key: input.key, scope: scopeKey };
        const window = limit.window;
        if (algorithm === "gcra") {
          const consume = counter.consumeGcra?.bind(counter);
          if (consume === undefined || results[index]?.limited !== false) {
            return undefined;
          }
          return guarded(() =>
            consume(gcraKey(limit, of), {
              limit: input.limit,
              window,
              cost: -input.cost,
              now: now(),
            }),
          );
        }
        const base = `${prefix}:${limit.name}:${window}:${of.scope}:${of.key}`;
        const countWindow = counter.countWindow?.bind(counter);
        if (countWindow !== undefined) {
          return guarded(() =>
            countWindow(base, {
              window,
              cost: -input.cost,
              previous: false,
              now: at,
            }),
          );
        }
        // A lifetime of 1 ms: a counter that has expired since is not
        // brought back (only a negative one, gone at once, would be).
        return guarded(() =>
          counter.increment(
            `${base}:${Math.floor(at / window)}`,
            -input.cost,
            1,
          ),
        );
      }),
    );

  /** The keys, costs and quotas of `plan`'s limits for the request: the caller's own functions. */
  const inputsOf = (req: BunRequest, plan: Plan): MaybePromise<Input[]> =>
    all(
      plan.limits.map((limit) =>
        then(limit.key(req), (client) =>
          then(
            typeof limit.cost === "number" ? limit.cost : limit.cost(req),
            (cost) => {
              if (
                typeof cost !== "number" ||
                !Number.isFinite(cost) ||
                cost < 0
              ) {
                throw new TypeError(
                  `throttle(): cost must be a non-negative finite number; got ${String(cost)}`,
                );
              }
              return then(
                typeof limit.limit === "number"
                  ? limit.limit
                  : limit.limit(req),
                (quota): Input => {
                  if (
                    typeof quota !== "number" ||
                    !Number.isInteger(quota) ||
                    quota < 1
                  ) {
                    throw new TypeError(
                      `throttle(): limit "${limit.name}" must be a positive integer; its function answered ${String(quota)}`,
                    );
                  }
                  return { key: String(client), cost, limit: quota };
                },
              );
            },
          ),
        ),
      ),
    );

  /**
   * Arranges the refund of a counted request once its response is known
   * (express-rate-limit's `skipSuccessfulRequests` / `skipFailedRequests`):
   * at most once, on `finish`, `close` or `error` as those options say.
   */
  const refundWhenDone = (
    req: BunRequest,
    res: BunResponse,
    refund: () => MaybePromise<unknown>,
  ): void => {
    let done = false;
    const give = (): void => {
      if (done) return;
      done = true;
      let given: MaybePromise<unknown>;
      try {
        given = refund();
      } catch (error) {
        warnStoreFailure(
          error instanceof StoreFailure ? error.cause : error,
          "a refund was lost",
        );
        return;
      }
      if (isThenable(given)) {
        given.then(undefined, (error: unknown) => {
          warnStoreFailure(
            error instanceof StoreFailure ? error.cause : error,
            "a refund was lost",
          );
        });
      }
    };
    const judged = (wanted: boolean): void => {
      let verdict: MaybePromise<boolean>;
      try {
        verdict = requestWasSuccessful(req, res);
      } catch {
        return;
      }
      const settled = then(verdict, (succeeded) => {
        if (Boolean(succeeded) === wanted) give();
      });
      if (isThenable(settled)) settled.then(undefined, () => undefined);
    };
    if (skipFailed) {
      res.on("finish", () => judged(false));
      res.on("close", () => {
        if (!res.writableEnded) give();
      });
      res.on("error", give);
    }
    if (skipSuccessful) {
      res.on("finish", () => judged(true));
    }
  };

  /** Sets the headers, then lets the request on or refuses it. */
  const conclude = (
    req: BunRequest,
    res: BunResponse,
    next: NextFunction,
    results: ThrottleResult[],
    route: string,
    refund: (() => MaybePromise<unknown>) | undefined,
  ): unknown => {
    if (refund !== undefined) refundWhenDone(req, res, refund);
    const recorded = RESULTS.get(req);
    if (recorded === undefined) RESULTS.set(req, results);
    else recorded.push(...results);
    if (ietf && !res.headersSent) {
      res.append(
        "RateLimit-Policy",
        results
          .map((r) => `"${r.name}";q=${r.limit};w=${seconds(r.window, 1)}`)
          .join(", "),
      );
      res.append(
        "RateLimit",
        results
          .map((r) => `"${r.name}";r=${r.remaining};t=${seconds(r.resetAfter)}`)
          .join(", "),
      );
    }
    if (legacy && !res.headersSent) {
      for (const r of results) {
        const suffix = r.name === "default" ? "" : `-${r.name}`;
        res.setHeader(`X-RateLimit-Limit${suffix}`, String(r.limit));
        res.setHeader(`X-RateLimit-Remaining${suffix}`, String(r.remaining));
        res.setHeader(
          `X-RateLimit-Reset${suffix}`,
          String(seconds(r.resetAfter)),
        );
      }
    }
    const refused = results.filter((r) => r.limited);
    if (refused.length === 0) return next();
    const retryAfter = Math.max(...refused.map((r) => r.retryAfter));
    if (!res.headersSent) {
      res.setHeader("Retry-After", String(seconds(retryAfter, 1)));
      if (legacy) {
        for (const r of refused) {
          if (r.name !== "default") {
            res.setHeader(
              `Retry-After-${r.name}`,
              String(seconds(r.retryAfter, 1)),
            );
          }
        }
      }
    }
    if (limitedLevel !== undefined) {
      log()[limitedLevel](
        `throttled ${route} by ${refused
          .map((r) => `"${r.name}" (${r.limit} per ${seconds(r.window, 1)} s)`)
          .join(", ")}`,
        {
          route,
          limits: refused.map((r) => r.name),
          retryAfter: seconds(retryAfter, 1),
        },
      );
    }
    return onLimited(req, res, next, {
      results,
      limited: refused,
      retryAfter,
      route,
    });
  };

  /** Counts every limit of `plan` for the request. */
  const evaluate = (
    req: BunRequest,
    res: BunResponse,
    next: NextFunction,
    plan: Plan,
    scopeKey: string,
    route: string,
  ): unknown => {
    const at = now();
    // The caller's functions first: an error there is a bug, for the error
    // handlers; only the store's failures go to `failMode`.
    let inputs: MaybePromise<Input[]>;
    try {
      inputs = inputsOf(req, plan);
    } catch (error) {
      return next(error as Error);
    }
    /** The refund of what `counter` counted, when the options ask for one. */
    const refundIn =
      (counter: ThrottleStore, resolved: Input[]) =>
      (list: ThrottleResult[]): (() => MaybePromise<unknown>) | undefined =>
        refunds
          ? () => refundAll(counter, plan, resolved, scopeKey, at, list)
          : undefined;
    const onStoreError = (error: unknown, resolved: Input[]): unknown => {
      if (!(error instanceof StoreFailure)) throw error;
      if (failMode === "closed") {
        return next(new ThrottleStoreError(store.name, error.cause));
      }
      if (fallback === undefined) {
        warnStoreFailure(
          error.cause,
          'requests pass unthrottled (failMode "open")',
        );
        return next();
      }
      warnStoreFailure(
        error.cause,
        `counting in the fallback store "${fallback.name}"`,
      );
      let degraded: MaybePromise<ThrottleResult[]>;
      try {
        degraded = countAll(fallback, plan, resolved, scopeKey, at, false);
      } catch {
        return next();
      }
      return isThenable(degraded)
        ? degraded.then(
            (list) =>
              conclude(
                req,
                res,
                next,
                list,
                route,
                refundIn(fallback, resolved)(list),
              ),
            () => next(),
          )
        : conclude(
            req,
            res,
            next,
            degraded,
            route,
            refundIn(fallback, resolved)(degraded),
          );
    };
    const counted = (resolved: Input[]): unknown => {
      let results: MaybePromise<ThrottleResult[]>;
      try {
        results = countAll(store, plan, resolved, scopeKey, at, false);
      } catch (error) {
        return onStoreError(error, resolved);
      }
      if (isThenable(results)) {
        return results.then(
          (list) =>
            conclude(
              req,
              res,
              next,
              list,
              route,
              refundIn(store, resolved)(list),
            ),
          (error: unknown) => onStoreError(error, resolved),
        );
      }
      return conclude(
        req,
        res,
        next,
        results,
        route,
        refundIn(store, resolved)(results),
      );
    };
    if (isThenable(inputs)) {
      return inputs.then(counted, (error: unknown) => next(error as Error));
    }
    return counted(inputs);
  };

  /** The plan, the scope key and the route label for a request. */
  const situate = (req: BunRequest): [Plan, string, string] => {
    const layer = routeLayerOf(req);
    const plan = planFor(layer);
    // Without a recorded pipeline, the matched route Express sets
    // (`req.route`) names it, never the raw path.
    const route =
      layer === null
        ? req.route === undefined
          ? "(unknown)"
          : routeLabel(req.route)
        : routeLabel(layer?.matched);
    return [plan, plan.scope === "global" ? "global" : route, route];
  };

  const handler = ((req: BunRequest, res: BunResponse, next: NextFunction) => {
    const [plan, scopeKey, route] = situate(req);
    if (plan.limits.length === 0) return next();
    const skip = options.skip;
    if (skip === undefined) {
      return evaluate(req, res, next, plan, scopeKey, route);
    }
    let skipped: MaybePromise<boolean>;
    try {
      skipped = skip(req, res);
    } catch (error) {
      return next(error as Error);
    }
    if (isThenable(skipped)) {
      return skipped.then(
        (yes) =>
          yes ? next() : evaluate(req, res, next, plan, scopeKey, route),
        (error: unknown) => next(error as Error),
      );
    }
    return skipped ? next() : evaluate(req, res, next, plan, scopeKey, route);
  }) as Tagged & ThrottleHandler;
  self = handler;

  const policiesOf = (): readonly ThrottlePolicy[] =>
    Object.freeze(
      state.limits.map((limit): ThrottlePolicy =>
        Object.freeze({
          name: limit.name,
          limit: typeof limit.limit === "number" ? limit.limit : "dynamic",
          window: limit.window,
          algorithm,
          scope: scope ?? "global",
        }),
      ),
    );
  let policies = policiesOf();

  const update = (limits: ThrottleLimits): void => {
    // Compiled first: a bad update throws and changes nothing.
    state.limits = compileLimits(limits, baseKey, baseCost);
    plans = new WeakMap();
    outer = outerPlan();
    policies = policiesOf();
  };

  const peek = (req: BunRequest): MaybePromise<ThrottleResult[]> => {
    const [plan, scopeKey] = situate(req);
    if (plan.limits.length === 0) return [];
    const at = now();
    const unwrap = (error: unknown): never => {
      throw error instanceof StoreFailure ? error.cause : error;
    };
    return then(inputsOf(req, plan), (inputs) => {
      let results: MaybePromise<ThrottleResult[]>;
      try {
        results = countAll(store, plan, inputs, scopeKey, at, true);
      } catch (error) {
        return unwrap(error);
      }
      return isThenable(results) ? results.catch(unwrap) : results;
    });
  };

  const reset = (
    key: string,
    resetOptions: ThrottleResetOptions = {},
  ): MaybePromise<void> => {
    const remove = store.delete?.bind(store);
    // The store placed the counters, by its own clock if it keeps one, so it
    // names the ones to forget.
    const removeWindow =
      algorithm === "gcra" || store.countWindow === undefined
        ? undefined
        : store.deleteWindow?.bind(store);
    if (remove === undefined && removeWindow === undefined) {
      throw new ConfigError(
        `throttle(): reset() needs a store with delete(key); store "${store.name}" has none`,
      );
    }
    const scopeKey = resetOptions.scope ?? "global";
    const names =
      resetOptions.limits === undefined
        ? undefined
        : new Set(resetOptions.limits);
    const at = now();
    const keys: string[] = [];
    const windows: [string, number][] = [];
    for (const limit of state.limits) {
      if (names !== undefined && !names.has(limit.name)) continue;
      if (algorithm === "gcra") {
        keys.push(gcraKey(limit, { name: limit.name, key, scope: scopeKey }));
        continue;
      }
      const base = `${prefix}:${limit.name}:${limit.window}:${scopeKey}:${key}`;
      if (removeWindow === undefined) {
        const index = Math.floor(at / limit.window);
        keys.push(`${base}:${index}`, `${base}:${index - 1}`);
      } else {
        windows.push([base, limit.window]);
      }
    }
    const done: MaybePromise<void>[] = [];
    for (const k of keys) if (remove !== undefined) done.push(remove(k));
    for (const [base, window] of windows) {
      if (removeWindow !== undefined) {
        done.push(removeWindow(base, { window, now: at }));
      }
    }
    return then(all(done), () => undefined);
  };

  Object.defineProperty(handler, THROTTLE, { value: state });
  Object.defineProperties(handler, {
    policies: { get: () => policies, enumerable: true },
    store: { value: store, enumerable: true },
    update: { value: update },
    peek: { value: peek },
    reset: { value: reset },
  });
  return handler;
}

/**
 * Turns off, for one route, the throttles that run ahead of it (those
 * registered with `use()` and the router or adapter `throttle` option):
 * every limit, or only the named ones (`skipThrottle("burst")`), as
 * `@nestjs/throttler`'s `@SkipThrottle()`. It goes among the route's own
 * callbacks and only calls `next()`; a throttle among the route's own
 * callbacks still runs.
 *
 * ```ts
 * app.get("/health", skipThrottle(), (req, res) => res.send("ok"));
 * ```
 *
 * Registered with `use()` it skips nothing (the router warns).
 */
export function skipThrottle(...names: string[]): RouterHandler {
  for (const name of names) {
    if (typeof name !== "string" || !NAME.test(name)) {
      throw new ConfigError(
        `skipThrottle(): ${JSON.stringify(name)} is not a limit name`,
      );
    }
  }
  const marker = ((_req: BunRequest, _res: BunResponse, next: NextFunction) =>
    next()) as Tagged;
  Object.defineProperty(marker, SKIP, {
    value: names.length === 0 ? null : new Set(names),
  });
  return marker;
}

/**
 * A router's `throttle` option as middleware: a {@link ThrottleHandler}
 * as it is, options through {@link throttle}. Internal.
 */
export function toThrottleHandler(
  option: ThrottleHandler | ThrottleOptions,
): ThrottleHandler {
  return isThrottleHandler(option) ? option : throttle(option);
}
