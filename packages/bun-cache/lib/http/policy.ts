/**
 * Whether `cacheResponse()` may store a response, for how long, and which of
 * its headers (plan §9.1; RFC 9111 §3 for a shared cache, read through
 * bun-common's `parseCacheControl`).
 */
import type { ParsedCacheControl } from "@kingsleyweb/bun-common";
import { parseCacheControl } from "@kingsleyweb/bun-common";
import { parseVary } from "./key";

/**
 * The hop-by-hop fields (RFC 9110 §7.6.1), never stored: they describe one
 * connection, not the response. Any field the `Connection` header lists is
 * dropped as well.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Fields recomputed on every answer, so never stored: the length (Bun writes it) and `Age` (§5.1). */
const RECOMPUTED = new Set(["content-length", "age"]);

/**
 * Why a response was not stored. Every reason but `"authorization"` marks
 * the key uncacheable for `uncacheableTtl` (hit-for-miss, §9.5).
 */
export type Refusal =
  /** The status is not in `statuses`. */
  | "status"
  /** `Cache-Control: no-store` (§5.2.2.5). */
  | "no-store"
  /** `Cache-Control: private`, unqualified (§5.2.2.7). */
  | "private"
  /**
   * `Cache-Control: no-cache`, unqualified (§5.2.2.4): storable, but every
   * reuse needs a revalidation PR-H1 cannot make, so it is not stored.
   */
  | "no-cache"
  /** The request had `Authorization` and nothing allowed a shared cache to store the answer (§3.5). */
  | "authorization"
  /** The handler set a cookie, and `allowSetCookie` is off. */
  | "set-cookie"
  /** `Vary: *` (§4.1). */
  | "vary"
  /** The body was streamed (or replaced by a transform ahead of the cache), so there are no bytes to store. */
  | "stream"
  /** No lifetime: `ttl: "headers"` and no freshness information, or a lifetime of 0 or less once `Age` is taken off. */
  | "lifetime";

/** What {@link decideStore} is told about the route and the request. */
export interface StorePolicy {
  /** The storable statuses. */
  statuses: ReadonlySet<number>;
  /** The route's TTL in ms, or `"headers"`. */
  ttl: number | "headers";
  /** Whether a response that sets a cookie is stored (with its cookies). */
  allowSetCookie: boolean;
  /** Lower-cased header names never stored. */
  omitHeaders: ReadonlySet<string>;
  /** The status header's lower-cased name, never stored; `undefined` when off. */
  statusHeader: string | undefined;
  /** Whether the request carried `Authorization`. */
  authorization: boolean;
  /** Whether the key varies on the requester's identity (`varyBy: ["authorization"]`, or a `key` function). */
  identityKeyed: boolean;
  /** The clock, epoch ms. */
  now: number;
}

/** A storable response's stored form, short of its body. */
export interface StoreDecision {
  /** Storable. */
  ok: true;
  /** The header lines to store, `[lower-cased name, value]`. */
  headers: [string, string][];
  /** The fresh-for, in ms (more than 0). */
  ttl: number;
  /** The response's own `Age`, in seconds. */
  age: number;
  /** The stale-while-revalidate window the response gives, in ms (PR-H2's to use). */
  staleWhileRevalidate: number;
  /** The stale-if-error window the response gives, in ms (PR-H2's to use). */
  staleIfError: number;
  /** The request headers the response varies on (its `Vary`), lower-cased and sorted. */
  vary: string[];
}

/** A refused response. */
export interface StoreRefusal {
  /** Not storable. */
  ok: false;
  /** Why. */
  reason: Refusal;
}

/**
 * The header lines a middleware set before the cache ran (and the lines of
 * `Set-Cookie` among them): those it sets again on every request, so a hit
 * must not replay the leader's copy (a request id, a CORS origin, a session
 * cookie). A line is "preset" while the response still has it unchanged.
 */
export type PresetHeaders = ReadonlyMap<string, string | readonly string[]>;

/** Reads a non-negative integer header (`Age`, RFC 9111 §5.1); `undefined` when absent or malformed. */
function deltaSeconds(value: string | null): number | undefined {
  if (value === null || !/^\s*\d+\s*$/.test(value)) {
    return undefined;
  }
  return Math.min(Number.parseInt(value, 10), 2_147_483_648);
}

/**
 * The freshness lifetime a shared cache reads from the headers, in seconds:
 * `Surrogate-Control: max-age`, then `s-maxage`, then `max-age`, then
 * `Expires` less `Date` (Fastly's precedence, §11; RFC 9111 §4.2.1 for the
 * last three). An `Expires` that does not parse is in the past (§5.3).
 * `undefined` when there is none.
 */
function headerLifetime(
  headers: Headers,
  cc: ParsedCacheControl,
  now: number,
): number | undefined {
  const surrogate = parseCacheControl(headers.get("surrogate-control"));
  const lifetime = surrogate.maxAge ?? cc.sMaxAge ?? cc.maxAge;
  if (lifetime !== undefined) {
    return lifetime;
  }
  const expires = headers.get("expires");
  if (expires === null) {
    return undefined;
  }
  const at = Date.parse(expires);
  if (Number.isNaN(at)) {
    return 0;
  }
  const date = Date.parse(headers.get("date") ?? "");
  return Math.max(0, (at - (Number.isNaN(date) ? now : date)) / 1000);
}

/** The field names a qualified `private="…"` or `no-cache="…"` withholds, lower-cased. */
function withheldFields(cc: ParsedCacheControl): Set<string> {
  const withheld = new Set<string>();
  for (const list of [cc.private, cc.noCache]) {
    if (Array.isArray(list)) {
      for (const name of list) {
        withheld.add(name.toLowerCase());
      }
    }
  }
  return withheld;
}

/** Whether `value` is the value `preset` recorded for its header. */
function isPreset(preset: PresetHeaders, name: string, value: string): boolean {
  const before = preset.get(name);
  return typeof before === "string" && before === value;
}

/**
 * The header lines of `headers` worth replaying to another request, `[lower-cased
 * name, value]`: not `Set-Cookie` (the caller decides on cookies), not a
 * hop-by-hop field or one the `Connection` header names, not `Content-Length`
 * or `Age`, not one of `dropped`, and not one a middleware ahead set and the
 * handler left unchanged (`preset`).
 */
export function headerLines(
  headers: Headers,
  preset: PresetHeaders,
  dropped: ReadonlySet<string>,
): [string, string][] {
  const connection = new Set<string>();
  for (const name of (headers.get("connection") ?? "").split(",")) {
    const field = name.trim().toLowerCase();
    if (field !== "") {
      connection.add(field);
    }
  }
  const lines: [string, string][] = [];
  for (const [name, value] of headers) {
    if (
      name === "set-cookie" ||
      HOP_BY_HOP.has(name) ||
      RECOMPUTED.has(name) ||
      connection.has(name) ||
      dropped.has(name) ||
      isPreset(preset, name, value)
    ) {
      continue;
    }
    lines.push([name, value]);
  }
  return lines;
}

/**
 * Decides whether a response is stored, and in what form. The checks follow
 * RFC 9111 §3 for a shared cache, in this order: the status; `no-store`
 * (which `must-understand` overrides for a status the cache stores,
 * §5.2.2.3); `private` and `no-cache`, unqualified (their qualified forms
 * only withhold the fields they name); `Authorization` (§3.5: `public`,
 * `s-maxage` or `must-revalidate` allow it); a new `Set-Cookie`; `Vary: *`;
 * then the lifetime.
 */
export function decideStore(
  response: Response,
  preset: PresetHeaders,
  policy: StorePolicy,
): StoreDecision | StoreRefusal {
  const headers = response.headers;
  if (!policy.statuses.has(response.status)) {
    return { ok: false, reason: "status" };
  }
  const cc = parseCacheControl(headers.get("cache-control"));
  if (cc.noStore === true && cc.mustUnderstand !== true) {
    return { ok: false, reason: "no-store" };
  }
  if (cc.private === true) {
    return { ok: false, reason: "private" };
  }
  if (cc.noCache === true) {
    return { ok: false, reason: "no-cache" };
  }
  if (
    policy.authorization &&
    !policy.identityKeyed &&
    cc.public !== true &&
    cc.sMaxAge === undefined &&
    cc.mustRevalidate !== true
  ) {
    return { ok: false, reason: "authorization" };
  }

  const presetCookies = new Set(preset.get("set-cookie") ?? []);
  const cookies = headers
    .getSetCookie()
    .filter((line) => !presetCookies.has(line));
  if (cookies.length > 0 && !policy.allowSetCookie) {
    return { ok: false, reason: "set-cookie" };
  }

  const vary = parseVary(headers.get("vary"));
  if (vary === "*") {
    return { ok: false, reason: "vary" };
  }

  const age = deltaSeconds(headers.get("age")) ?? 0;
  let ttl: number;
  if (policy.ttl === "headers") {
    const lifetime = headerLifetime(headers, cc, policy.now);
    if (lifetime === undefined) {
      return { ok: false, reason: "lifetime" };
    }
    ttl = Math.round((lifetime - age) * 1000);
  } else {
    ttl = policy.ttl;
  }
  if (!(ttl > 0)) {
    return { ok: false, reason: "lifetime" };
  }

  const dropped = withheldFields(cc);
  for (const name of policy.omitHeaders) {
    dropped.add(name);
  }
  if (policy.statusHeader !== undefined) {
    dropped.add(policy.statusHeader);
  }
  const lines = headerLines(headers, preset, dropped);
  if (!dropped.has("set-cookie")) {
    for (const line of cookies) {
      lines.push(["set-cookie", line]);
    }
  }

  const revalidate = cc.mustRevalidate === true || cc.proxyRevalidate === true;
  return {
    ok: true,
    headers: lines,
    ttl,
    age,
    staleWhileRevalidate: revalidate
      ? 0
      : (cc.staleWhileRevalidate ?? 0) * 1000,
    staleIfError: revalidate ? 0 : (cc.staleIfError ?? 0) * 1000,
    vary,
  };
}
