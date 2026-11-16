/**
 * Request facts (plan §4.1): what the engine decides from, computed once per
 * request by the integration. The engine is a pure function of facts, the
 * compiled policy and state, so facts are plain data: `explain()` takes the
 * same shape from a test, a log line or the UI's test-a-request form.
 */
import {
  compileTrustProxy,
  isTrustProxyOff,
  resolveClientAddress,
} from "@kingsleyweb/bun-common";
import type {
  ProxyChainEntry,
  TrustProxyOption,
} from "@kingsleyweb/bun-common";
import { canonicalPath } from "./path";

/**
 * Who the app says is calling (plan §4.2, `identify`): ids only, never a
 * secret. Each is keyed as given, or by its SHA-256 when over 256 bytes.
 */
export interface SecurityIdentity {
  /** The signed-in user's id. */
  readonly user?: string;
  /** The session's id. */
  readonly session?: string;
  /** The tenant (organisation, workspace) the request acts for. */
  readonly tenant?: string;
  /** The API key's **id** (never the key). */
  readonly apiKey?: string;
  /** The scopes the credential carries. */
  readonly scopes?: readonly string[];
  /**
   * The login identifier the request attempts (on a sign-in, an MFA or a
   * reset route): an email or username as the client typed it. Keyed by
   * its HMAC (trimmed, lower case), never stored (layers.md L2.3).
   */
  readonly username?: string;
  /** Where the request sends a code or a link (an email address, a phone number). Keyed by its HMAC. */
  readonly destination?: string;
}

/** The facts of one request, as the engine reads them. */
export interface RequestFacts {
  /** The method, as received (`GET`). */
  readonly method: string;
  /**
   * The path the rules match: layers.md L6's canonical form of
   * {@link rawPath} (`canonicalPath`: unreserved escapes decoded, dot
   * segments resolved, backslashes and repeated slashes folded), case kept.
   */
  readonly path: string;
  /** The path as received, before any decoding, without the query. */
  readonly rawPath: string;
  /** The query string as received, without its `?`; absent or `""` for none. */
  readonly query?: string;
  /** The matched route (`"POST /login"`), when routing has run. */
  readonly routeKey?: string;
  /**
   * The headers, names lower case, bounded: at most {@link MAX_FACT_HEADERS}
   * of them, each value cut at {@link MAX_FACT_HEADER_LENGTH} characters.
   */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * How many header fields the request carried (repeated names joined, as
   * `Headers` does), before the cut to {@link MAX_FACT_HEADERS} (layers.md
   * L6's header count).
   */
  readonly headerCount?: number;
  /**
   * Each kept header value's length in characters, before the cut to
   * {@link MAX_FACT_HEADER_LENGTH} (layers.md L6's header size).
   */
  readonly headerLengths?: Readonly<Record<string, number>>;
  /** The names of the cookies sent, at most 64. */
  readonly cookieNames: readonly string[];
  /** The socket peer's address, `""` when there is none (a Unix socket, a socket-free call). */
  readonly peer: string;
  /**
   * The client's address as the trusted proxy chain resolves it (bun-common's
   * `req.ip`); the peer when no proxy is trusted.
   */
  readonly client: string;
  /** How {@link client} was resolved, closest first (bun-common's `req.proxyChain`). */
  readonly chain: readonly ProxyChainEntry[];
  /** `Content-Length`, when sent and a whole number. */
  readonly contentLength?: number;
  /** The service's id; the policy's when absent. */
  readonly service?: string;
  /** The environment; the policy's when absent. */
  readonly environment?: string;
  /** Who the app says is calling, from `identify()`. */
  readonly identity?: SecurityIdentity;
  /**
   * The matched route's profile (`securityProfile("login")`), naming a
   * sensitive endpoint (layers.md L11): its rules (`profile` on a limit or
   * counted rule) and the login defences apply.
   */
  readonly profile?: string;
}

/** The most headers kept in {@link RequestFacts.headers}. */
export const MAX_FACT_HEADERS = 100;

/** The longest header value kept in {@link RequestFacts.headers}; longer ones are cut. */
export const MAX_FACT_HEADER_LENGTH = 4096;

/** The most cookie names kept. */
const MAX_COOKIE_NAMES = 64;

/** What {@link requestFacts} needs beside the request. */
export interface RequestFactsInit {
  /**
   * The socket peer's address, from `server.requestIP(request)?.address`;
   * `""` or absent when there is none.
   */
  readonly peer?: string | null;
  /**
   * Which proxies in front of the listener to trust, with bun-common's
   * `trustProxy` values (Express's `trust proxy`): off by default, so the
   * client is the peer and no forwarding header is read.
   */
  readonly trustProxy?: TrustProxyOption;
  /**
   * A header the outermost trusted proxy puts the client's address in
   * (`cf-connecting-ip`), believed only through a fully trusted chain; see
   * bun-common's `clientIpHeader`.
   */
  readonly clientIpHeader?: string;
  /** The matched route, when known. */
  readonly routeKey?: string;
  /** The matched route's profile, when it has one (layers.md L11). */
  readonly profile?: string;
  /** Who the app says is calling. */
  readonly identity?: SecurityIdentity;
  /** The service's id. */
  readonly service?: string;
  /** The environment. */
  readonly environment?: string;
}

/** The path of a request URL, without its query or fragment, as written. */
export function rawPathOf(url: string): string {
  const scheme = url.indexOf("://");
  const start = scheme === -1 ? 0 : url.indexOf("/", scheme + 3);
  if (start === -1) {
    return "/";
  }
  let end = url.length;
  for (let i = start; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (code === 0x3f /* ? */ || code === 0x23 /* # */) {
      end = i;
      break;
    }
  }
  return url.slice(start, end) || "/";
}

/** The cookie names in a `Cookie` header, at most {@link MAX_COOKIE_NAMES}. */
export function cookieNamesOf(header: string | undefined): readonly string[] {
  if (!header) {
    return [];
  }
  const names: string[] = [];
  for (const part of header.split(";")) {
    const equals = part.indexOf("=");
    const name = (equals === -1 ? part : part.slice(0, equals)).trim();
    if (name) {
      names.push(name);
      if (names.length === MAX_COOKIE_NAMES) break;
    }
  }
  return names;
}

/** The request's headers, lower case and bounded, with their count and the kept ones' full lengths. */
export function boundedHeaders(headers: Headers): {
  values: Record<string, string>;
  lengths: Record<string, number>;
  count: number;
} {
  const values: Record<string, string> = {};
  const lengths: Record<string, number> = {};
  let count = 0;
  for (const [name, value] of headers) {
    count++;
    if (count > MAX_FACT_HEADERS) continue;
    lengths[name] = value.length;
    values[name] =
      value.length > MAX_FACT_HEADER_LENGTH
        ? value.slice(0, MAX_FACT_HEADER_LENGTH)
        : value;
  }
  return { values, lengths, count };
}

/** The query of a request URL, without its `?` or fragment; `""` for none. */
export function queryOf(url: string): string {
  const start = url.indexOf("?");
  if (start === -1) return "";
  const hash = url.indexOf("#", start);
  return url.slice(start + 1, hash === -1 ? url.length : hash);
}

/** A `Content-Length` value as a number, when it is a whole number. */
function contentLengthOf(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,15}$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

/** A mutable view of {@link RequestFacts}, to build one. */
type MutableFacts = { -readonly [K in keyof RequestFacts]: RequestFacts[K] };

/**
 * The facts of a web-standard `Request`, as a plain `Bun.serve` handler sees
 * it: `peer` from `server.requestIP(request)`, the client resolved from it
 * and the forwarding headers by bun-common's trust-proxy resolution, which
 * reads them only when `trustProxy` trusts the hops they came through.
 *
 * @example
 * ```ts
 * const facts = requestFacts(request, {
 *   peer: server.requestIP(request)?.address,
 *   trustProxy: ["10.0.0.0/8"],
 * });
 * ```
 */
export function requestFacts(
  request: Request,
  init: RequestFactsInit = {},
): RequestFacts {
  const bounded = boundedHeaders(request.headers);
  const headers = bounded.values;
  const peer = init.peer ?? "";
  let client = peer;
  let chain: readonly ProxyChainEntry[];
  if (isTrustProxyOff(init.trustProxy)) {
    chain = [{ address: peer, source: "socket", trusted: false }];
  } else {
    const resolved = resolveClientAddress({
      peer,
      forwardedFor: request.headers.get("x-forwarded-for"),
      trust: compileTrustProxy(init.trustProxy),
      clientIpHeaderValue: init.clientIpHeader
        ? request.headers.get(init.clientIpHeader)
        : undefined,
    });
    client = resolved.ip;
    chain = resolved.chain;
  }
  const rawPath = rawPathOf(request.url);
  const facts: MutableFacts = {
    method: request.method,
    path: canonicalPath(rawPath),
    rawPath,
    query: queryOf(request.url),
    headers,
    headerCount: bounded.count,
    headerLengths: bounded.lengths,
    cookieNames: cookieNamesOf(headers.cookie),
    peer,
    client,
    chain,
  };
  const contentLength = contentLengthOf(headers["content-length"]);
  if (contentLength !== undefined) facts.contentLength = contentLength;
  if (init.routeKey !== undefined) facts.routeKey = init.routeKey;
  if (init.profile !== undefined) facts.profile = init.profile;
  if (init.identity !== undefined) facts.identity = init.identity;
  if (init.service !== undefined) facts.service = init.service;
  if (init.environment !== undefined) facts.environment = init.environment;
  return facts;
}
