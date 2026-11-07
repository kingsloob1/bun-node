/**
 * Which proxies to believe about the client: Express 5's `trust proxy`
 * setting, ported (its `compileTrust`, `proxy-addr` 2.0.8's walk and the
 * `forwarded` package's header parse, all MIT), plus helpers for the
 * platforms that sit in front of an app (Cloudflare, Railway).
 *
 * `BunRequest` reads `ip`, `ips`, `protocol`, `host` and `hostname` through
 * it; the adapters and `BunRouter` take a `trustProxy` option, and
 * `set("trust proxy", value)` as Express does.
 */
import { compileIpMatcher, isIpAddress } from "./utils/native";

/**
 * A custom trust test, as Express's `trust proxy` function form: called with
 * each address of the request's chain, closest first, and its hop index —
 * `0` for the socket peer, `1` for the right-most `X-Forwarded-For` entry,
 * and so on. Return `true` to trust that hop (and go on reading to its left).
 * The peer is `""` when there is none (a socket-free `fetch()`), where
 * Express passes `undefined`.
 */
export type TrustProxyFn = (addr: string, i: number) => boolean;

/**
 * The `trustProxy` option: which proxies in front of the app to trust, with
 * Express 5's `trust proxy` values and meanings.
 *
 * - `false` (the default): trust nothing. `req.ip` is the socket peer,
 *   `req.ips` is `[]`, and no `X-Forwarded-*` header is read.
 * - `true`: trust every hop. `req.ip` is the left-most `X-Forwarded-For`
 *   entry, which the client can write: only behind a proxy that overwrites
 *   the header, and only when nothing can reach the app except through it.
 * - a number `n`: trust the first `n` hops from the socket inward (`1`
 *   trusts the socket peer only). `0` trusts nothing.
 * - a string or array of addresses, CIDR ranges (`10.0.0.0/8`), IPv4
 *   netmasks (`10.0.0.0/255.0.0.0`) or the presets `loopback`, `linklocal`
 *   and `uniquelocal`; a string may list several, comma-separated. An
 *   entry that is not one throws a `TypeError` when the option is set.
 * - a {@link TrustProxyFn}.
 */
export type TrustProxyOption =
  boolean | number | string | readonly string[] | TrustProxyFn;

/** The trust settings a request is resolved with; see {@link behindCloudflare}. */
export interface ProxyTrustSettings {
  /** Which proxies to trust; see {@link TrustProxyOption}. */
  trustProxy: TrustProxyOption;
  /**
   * A header carrying the client's address as a single value, set by the
   * outermost proxy (`cf-connecting-ip`, `x-real-ip`, `fly-client-ip`), or
   * `undefined` to read only `X-Forwarded-For`. It is believed only when
   * `trustProxy` trusts the whole chain the request arrived through, the
   * farthest address included; see `clientIpHeader` on the request options.
   */
  clientIpHeader?: string;
}

/** Trusts nothing. */
const trustNone: TrustProxyFn = () => false;
/** Trusts every hop. */
const trustAll: TrustProxyFn = () => true;

/** Compiled trust functions, by the array they were compiled from. */
const compiledByList = new WeakMap<readonly string[], TrustProxyFn>();
/** Compiled trust functions, by the string or number they were compiled from. */
const compiledByValue = new Map<string | number, TrustProxyFn>();
/** {@link compiledByValue}'s cap: values come from configuration, not requests. */
const COMPILED_BY_VALUE_MAX = 256;

/**
 * Compiles a `trustProxy` value into its trust function, as Express's
 * `compileTrust` does for `app.set("trust proxy", value)`: a function is
 * returned as is; `true` trusts everything; a number `n` trusts hops with
 * index below `n`; a string is split on commas and trimmed; an array of
 * addresses, ranges and presets is compiled as `proxy-addr` compiles it;
 * `false`, `undefined` and `null` trust nothing. Throws a `TypeError` for an
 * address or range proxy-addr refuses, and for any other value
 * (`unsupported trust argument`).
 *
 * A string, number or array is compiled once and the result kept, so a
 * request costs no compilation; an array changed after it was first used
 * keeps its first compilation, as Express compiles once at `app.set`.
 */
export function compileTrustProxy(
  value: TrustProxyOption | null | undefined,
): TrustProxyFn {
  if (typeof value === "function") {
    return value;
  }
  if (value === true) {
    return trustAll;
  }
  if (value === false || value === undefined || value === null) {
    return trustNone;
  }
  if (typeof value === "number" || typeof value === "string") {
    const cached = compiledByValue.get(value);
    if (cached) {
      return cached;
    }
    const compiled =
      typeof value === "number"
        ? (_addr: string, i: number) => i < value
        : compileList(value.split(",").map((entry) => entry.trim()));
    if (compiledByValue.size >= COMPILED_BY_VALUE_MAX) {
      compiledByValue.clear();
    }
    compiledByValue.set(value, compiled);
    return compiled;
  }
  if (Array.isArray(value)) {
    const list = value as readonly string[];
    const cached = compiledByList.get(list);
    if (cached) {
      return cached;
    }
    const compiled = compileList(list);
    compiledByList.set(list, compiled);
    return compiled;
  }
  throw new TypeError("unsupported trust argument");
}

/** proxy-addr's `compile` for a list: an address matcher, by hop. */
function compileList(list: readonly string[]): TrustProxyFn {
  for (const entry of list) {
    if (typeof entry !== "string") {
      throw new TypeError("unsupported trust argument");
    }
  }
  const matcher = compileIpMatcher(list);
  return (addr) => matcher(addr);
}

/**
 * Whether `value` is the trust-nothing setting, so a request can skip the
 * walk: `undefined`, `null`, `false`, `0` or an empty list.
 */
export function isTrustProxyOff(
  value: TrustProxyOption | null | undefined,
): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    value === 0 ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * The addresses in an `X-Forwarded-For` value, **closest first** (the
 * right-most entry first), as the `forwarded` package parses them: split on
 * commas, spaces around each entry dropped, empty entries skipped. An entry
 * is kept as written; nothing checks it is an address.
 */
export function parseForwardedFor(header: string | null | undefined): string[] {
  const list: string[] = [];
  if (!header) {
    return list;
  }
  let end = header.length;
  let start = header.length;
  for (let i = header.length - 1; i >= 0; i--) {
    switch (header.charCodeAt(i)) {
      case 0x20 /* space */:
        if (start === end) {
          start = end = i;
        }
        break;
      case 0x2c /* , */:
        if (start !== end) {
          list.push(header.substring(start, end));
        }
        start = end = i;
        break;
      default:
        start = i;
        break;
    }
  }
  if (start !== end) {
    list.push(header.substring(start, end));
  }
  return list;
}

/**
 * The request's address chain, closest first, cut after the first address
 * `trust` refuses: proxy-addr's `all()`. It starts with `peer`, the socket
 * address, then the `X-Forwarded-For` entries from right to left. The last
 * address is the client's as far as the trusted proxies say (`req.ip`); the
 * function is never asked about it.
 */
export function proxyAddressChain(
  peer: string,
  forwardedFor: string | null | undefined,
  trust: TrustProxyFn,
): string[] {
  const addrs = [peer, ...parseForwardedFor(forwardedFor)];
  for (let i = 0; i < addrs.length - 1; i++) {
    if (!trust(addrs[i] ?? "", i)) {
      addrs.length = i + 1;
      break;
    }
  }
  return addrs;
}

/** What {@link resolveClientAddress} works from. */
export interface ClientAddressInput {
  /** The socket peer's address, `""` when there is none. */
  peer: string;
  /** The request's `X-Forwarded-For` value, if any. */
  forwardedFor: string | null | undefined;
  /** The compiled `trustProxy`; see {@link compileTrustProxy}. */
  trust: TrustProxyFn;
  /**
   * The value of the `clientIpHeader` header, if one is configured and
   * present; see {@link ProxyTrustSettings.clientIpHeader}.
   */
  clientIpHeaderValue?: string | null;
}

/** One address of a request's resolution chain; see {@link ClientAddress.chain}. */
export interface ProxyChainEntry {
  /** The address, as written. */
  readonly address: string;
  /**
   * Where it came from: the socket peer, an `X-Forwarded-For` entry, or the
   * `clientIpHeader` header.
   */
  readonly source: "socket" | "x-forwarded-for" | "header";
  /**
   * Whether `trustProxy` trusts it as a proxy. The address `ip` resolved to
   * is the first untrusted one; it is trusted only when every address was,
   * and the header's entry never is.
   */
  readonly trusted: boolean;
}

/** {@link resolveClientAddress}'s answer. */
export interface ClientAddress {
  /**
   * Every address the walk read, closest first: the socket peer, then the
   * `X-Forwarded-For` entries read, right to left, ending with the one `ip`
   * resolved to from them; then the `clientIpHeader` value when it was
   * believed. Frozen.
   */
  chain: readonly ProxyChainEntry[];
  /** The client's address: `req.ip`. */
  ip: string;
  /**
   * The trusted chain, client first, without the socket peer: `req.ips`.
   * When the client address header was believed, it leads.
   */
  ips: string[];
  /** Whether the `clientIpHeader` value was believed. */
  fromHeader: boolean;
}

/**
 * Resolves the client address from the socket peer, `X-Forwarded-For` and
 * the trust function, as Express 5's `req.ip` and `req.ips` do; then, when a
 * client address header is configured, believes it only when every address
 * of the chain is trusted, the farthest included (so the proxy that set it
 * is one the app trusts) and its value is an IP address.
 */
export function resolveClientAddress(input: ClientAddressInput): ClientAddress {
  const chain = proxyAddressChain(input.peer, input.forwardedFor, input.trust);
  const last = chain.length - 1;
  const ip = chain[last] ?? "";
  const ips = chain.slice(1).reverse();
  const lastTrusted = input.trust(ip, last);
  const entries: ProxyChainEntry[] = chain.map((address, i) =>
    Object.freeze({
      address,
      source: i === 0 ? ("socket" as const) : ("x-forwarded-for" as const),
      trusted: i < last || lastTrusted,
    }),
  );
  const header = input.clientIpHeaderValue?.trim();
  if (header && isIpAddress(header) && lastTrusted) {
    entries.push(
      Object.freeze({
        address: header,
        source: "header" as const,
        trusted: false,
      }),
    );
    return {
      chain: Object.freeze(entries),
      ip: header,
      ips: [header, ...ips],
      fromHeader: true,
    };
  }
  return { chain: Object.freeze(entries), ip, ips, fromHeader: false };
}

/**
 * One hop of {@link trustChain}: `true` for any address, or the addresses,
 * ranges and presets a `trustProxy` string or array takes.
 */
export type TrustHop = true | string | readonly string[];

/**
 * A trust function for a known chain of proxies, one entry per hop from the
 * socket inward: hop `i` is trusted when its address matches entry `i`, and
 * nothing beyond the last entry is trusted. `trustChain([true, true])` is
 * `trustProxy: 2`; `trustChain(["loopback", CLOUDFLARE_IP_RANGES])` trusts a
 * local nginx and, behind it, Cloudflare's edge only. Entries are compiled
 * here, so a bad one throws a `TypeError` at once.
 */
export function trustChain(hops: readonly TrustHop[]): TrustProxyFn {
  const tests = hops.map((hop) =>
    hop === true ? trustAll : compileTrustProxy(hop),
  );
  return (addr, i) => {
    const test = tests[i];
    return test !== undefined && test(addr, i);
  };
}

/**
 * Cloudflare's published edge ranges, IPv4 then IPv6, from
 * https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6
 * (the same as https://api.cloudflare.com/client/v4/ips), as fetched on
 * {@link CLOUDFLARE_IP_RANGES_DATE}. Cloudflare adds ranges now and then:
 * pass fresh ones to {@link behindCloudflare} (`ranges`), for example from
 * {@link fetchCloudflareIpRanges} at startup.
 */
export const CLOUDFLARE_IP_RANGES: readonly string[] = Object.freeze([
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
]);

/** The day {@link CLOUDFLARE_IP_RANGES} was taken from Cloudflare (UTC). */
export const CLOUDFLARE_IP_RANGES_DATE = "2026-11-07";

/** Cloudflare's API endpoint listing its edge ranges; no key needed. */
export const CLOUDFLARE_IP_RANGES_URL =
  "https://api.cloudflare.com/client/v4/ips";

/** Options for {@link fetchCloudflareIpRanges}. */
export interface FetchCloudflareIpRangesOptions {
  /** The `fetch` to call. Defaults to the global `fetch`. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Aborts the request. */
  signal?: AbortSignal;
  /** The endpoint. Defaults to {@link CLOUDFLARE_IP_RANGES_URL}. */
  url?: string;
}

/**
 * Fetches Cloudflare's current edge ranges (IPv4 then IPv6) from its API.
 * Nothing in this package calls it: the app opts in, typically once at
 * startup, falling back to {@link CLOUDFLARE_IP_RANGES} when it fails.
 * Rejects on a non-2xx answer, an answer that is not the documented shape
 * (`{ success: true, result: { ipv4_cidrs, ipv6_cidrs } }`), an empty
 * list, or an entry that is not a range `trustProxy` accepts.
 *
 * @example
 * ```ts
 * const ranges = await fetchCloudflareIpRanges().catch(() => CLOUDFLARE_IP_RANGES);
 * const adapter = new BunHttpAdapter(0, { ...behindCloudflare({ ranges }) });
 * ```
 */
export async function fetchCloudflareIpRanges(
  options: FetchCloudflareIpRangesOptions = {},
): Promise<string[]> {
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(options.url ?? CLOUDFLARE_IP_RANGES_URL, {
    ...(options.signal ? { signal: options.signal } : {}),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `Cloudflare IP ranges: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const result =
    typeof body === "object" && body !== null && "result" in body
      ? (body as { result: unknown }).result
      : undefined;
  const v4 = rangeList(result, "ipv4_cidrs");
  const v6 = rangeList(result, "ipv6_cidrs");
  if (
    (body as { success?: unknown }).success !== true ||
    v4 === undefined ||
    v6 === undefined ||
    v4.length + v6.length === 0
  ) {
    throw new Error("Cloudflare IP ranges: unexpected answer");
  }
  const ranges = [...v4, ...v6];
  // Throws for an entry trustProxy would refuse.
  compileIpMatcher(ranges);
  return ranges;
}

/** `result[key]` when it is an array of strings. */
function rangeList(result: unknown, key: string): string[] | undefined {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }
  const value: unknown = (result as Record<string, unknown>)[key];
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

/** Options for {@link behindCloudflare}. */
export interface BehindCloudflareOptions {
  /**
   * Cloudflare's edge ranges. Defaults to {@link CLOUDFLARE_IP_RANGES}, the
   * snapshot of {@link CLOUDFLARE_IP_RANGES_DATE}.
   */
  ranges?: readonly string[];
  /**
   * The proxies between Cloudflare and the app, closest first, as
   * {@link trustChain} hops: `[]` (the default) when Cloudflare connects to
   * the app directly, `["loopback"]` for an nginx on the same host,
   * `[true, true]` for Railway (see {@link behindRailway}).
   */
  via?: readonly TrustHop[];
  /**
   * The header Cloudflare puts the client address in: `"cf-connecting-ip"`
   * (the default, every plan) or `"true-client-ip"` (Enterprise, with the
   * "Add True-Client-IP header" Managed Transform; the same value).
   */
  header?: "cf-connecting-ip" | "true-client-ip";
}

/**
 * The trust settings for an app behind Cloudflare, to spread into an
 * adapter's or router's options: trust the proxies in `via`, then
 * Cloudflare's edge ranges at the next hop, and read the client from
 * `CF-Connecting-IP` once that chain checks out.
 *
 * Cloudflare sets `CF-Connecting-IP` to the address that connected to it,
 * and appends that address to `X-Forwarded-For` (keeping what the client
 * sent): https://developers.cloudflare.com/fundamentals/reference/http-headers/.
 * A request that reaches the app without passing Cloudflare fails the range
 * check, so its `CF-Connecting-IP` is ignored and `req.ip` is the address
 * that actually connected.
 *
 * @example
 * ```ts
 * new BunHttpAdapter(0, { ...behindCloudflare() });                  // Cloudflare → app
 * new BunHttpAdapter(0, { ...behindCloudflare({ via: ["loopback"] }) }); // → nginx → app
 * ```
 */
export function behindCloudflare(
  options: BehindCloudflareOptions = {},
): ProxyTrustSettings {
  return {
    trustProxy: trustChain([
      ...(options.via ?? []),
      options.ranges ?? CLOUDFLARE_IP_RANGES,
    ]),
    clientIpHeader: options.header ?? "cf-connecting-ip",
  };
}

/** Options for {@link behindRailway}. */
export interface BehindRailwayOptions {
  /**
   * Cloudflare in front of Railway: `true` for its edge ranges as of
   * {@link CLOUDFLARE_IP_RANGES_DATE}, or {@link behindCloudflare}'s options
   * (`ranges`, `header`; `via` is Railway's own two hops). Defaults to none.
   */
  cloudflare?: boolean | Omit<BehindCloudflareOptions, "via">;
}

/**
 * The trust settings for an app on Railway: its proxy (the socket peer) and
 * its edge (the right-most `X-Forwarded-For` entry) are trusted by position
 * — `trustProxy: 2` — since Railway publishes no address range for either
 * (its staff say `100.64.0.0/10` is not stable). With `cloudflare`, the next
 * hop must also be a Cloudflare edge, and the client is read from
 * `CF-Connecting-IP`.
 *
 * This follows what Railway's edge was measured to send in November 2026:
 * `X-Forwarded-For: <client>, <edge>`, the client's own value discarded.
 * Railway does not document `X-Forwarded-For`
 * (https://docs.railway.com/networking/public-networking/specs-and-limits
 * documents `X-Real-IP`), so check it on your service before relying on it;
 * the README shows how.
 */
export function behindRailway(
  options: BehindRailwayOptions = {},
): ProxyTrustSettings {
  const { cloudflare } = options;
  if (!cloudflare) {
    return { trustProxy: 2 };
  }
  return behindCloudflare({
    ...(cloudflare === true ? {} : cloudflare),
    via: [true, true],
  });
}
