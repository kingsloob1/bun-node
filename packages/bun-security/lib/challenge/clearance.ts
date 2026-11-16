/**
 * Clearance (layers.md L10.2): a passed challenge mints a token, so a human
 * is challenged once, not on every request. The token is signed with
 * bun-common's cookie signing (HMAC-SHA256, compared in constant time) and
 * bound to the client's network (its /24, or /64 for IPv6) and to a hash of
 * its `User-Agent`, so a token copied to another network or browser is
 * refused. A browser holds it in an `HttpOnly` cookie; an API client sends
 * it in a header.
 */
import { createHash, randomBytes } from "node:crypto";
import { parseCookie, signCookie, unsignCookie } from "@kingsleyweb/bun-common";
import { formatAddress, maskWords, parseAddress } from "../ip/address";

/** The token format's version, its first field. */
const VERSION = "v1";

/** What a clearance is checked against. */
export interface ClearanceSubject {
  /** The client's address (`""` when there is none). */
  readonly client: string;
  /** The `User-Agent` header (`""` when there is none). */
  readonly userAgent: string;
}

/** The network a clearance is bound to: the /24 of an IPv4 address, the /64 of an IPv6 one, `-` for none. */
export function clearanceNetwork(client: string): string {
  const address = parseAddress(client);
  if (address === null) return "-";
  const bits = address.family === 4 ? 24 : 64;
  return `${formatAddress(address.family, maskWords(address.words, bits))}/${bits}`;
}

/** The binding a token carries: a hash of the network and the `User-Agent`, never either in clear. */
function binding(subject: ClearanceSubject): string {
  return createHash("sha256")
    .update(`${clearanceNetwork(subject.client)}|${subject.userAgent}`)
    .digest("base64url")
    .slice(0, 22);
}

/**
 * A clearance token for `subject`, valid until `expiresAt` (epoch ms):
 * `v1.<expiry>.<nonce>.<binding>.<signature>`.
 */
export function mintClearance(
  secret: string,
  subject: ClearanceSubject,
  expiresAt: number,
): string {
  const nonce = randomBytes(9).toString("base64url");
  return signCookie(
    `${VERSION}.${Math.floor(expiresAt / 1000)}.${nonce}.${binding(subject)}`,
    secret,
  );
}

/** Why a token was refused, or `undefined` when it is valid for `subject` at `now`. */
export function clearanceRefusal(
  secret: string,
  token: string,
  subject: ClearanceSubject,
  now: number,
): "signature" | "format" | "expired" | "client" | undefined {
  if (token.length > 512) return "format";
  const value = unsignCookie(token, secret);
  if (value === false) return "signature";
  const [version, expiry, , bound, ...rest] = value.split(".");
  if (
    version !== VERSION ||
    rest.length > 0 ||
    !/^\d{1,12}$/.test(expiry ?? "")
  ) {
    return "format";
  }
  if (Number(expiry) * 1000 <= now) return "expired";
  if (bound !== binding(subject)) return "client";
  return undefined;
}

/** The clearance a request carries: its header's, else its cookie's. */
export function clearanceToken(
  headers: Readonly<Record<string, string>>,
  cookieName: string,
  headerName: string,
): string | undefined {
  const fromHeader = headers[headerName];
  if (fromHeader) return fromHeader;
  const cookie = headers.cookie;
  if (!cookie || !cookie.includes(cookieName)) return undefined;
  return parseCookie(cookie)[cookieName];
}
