/**
 * IP addresses and ranges as the engine keys and matches them (layers.md
 * L2.1, L2.3): parsed once with bun-common's parser — the trust-proxy
 * foundation's, so a list and `trustProxy` read an address the same way —
 * then normalised: an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, what a
 * default dual-stack `Bun.serve` listener reports for an IPv4 client) becomes
 * IPv4, an IPv6 address is written in its RFC 5952 form with any `%zone`
 * dropped, and IPv6 is keyed by its /64 (configurable) for limits and bans.
 */
import {
  parseIpAddress,
  parseIpRange,
  toIpv4IfMapped,
} from "@kingsleyweb/bun-common";
import type { IpRange, ParsedIp } from "@kingsleyweb/bun-common";

/**
 * A normalised address: its family, its bits as big-endian 32-bit words (one
 * for IPv4, four for IPv6) and its canonical text.
 */
export interface ParsedAddress {
  /** `4` or `6`; an IPv4-mapped IPv6 address is `4`. */
  readonly family: 4 | 6;
  /** The address bits, most significant word first: one word for IPv4, four for IPv6. */
  readonly words: Uint32Array;
  /** The canonical text: dotted quad, or RFC 5952 IPv6 without a zone. */
  readonly text: string;
}

/** A normalised range: an address with a prefix length, its host bits cleared. */
export interface ParsedCidr {
  /** `4` or `6`; an IPv4-mapped IPv6 range of /96 or longer is `4`. */
  readonly family: 4 | 6;
  /** The base address bits, host bits zero. */
  readonly words: Uint32Array;
  /** The prefix length: 1–32 for IPv4, 1–128 for IPv6. */
  readonly bits: number;
  /** The canonical text, `base/bits` (a whole address keeps its `/32` or `/128`). */
  readonly text: string;
}

/** The number of bits in an address of each family. */
export function familyBits(family: 4 | 6): 32 | 128 {
  return family === 4 ? 32 : 128;
}

/** `words` with every bit past the first `bits` cleared (a copy). */
export function maskWords(words: Uint32Array, bits: number): Uint32Array {
  const out = new Uint32Array(words.length);
  for (let i = 0; i < words.length; i++) {
    const start = i * 32;
    const word = words[i] ?? 0;
    if (bits >= start + 32) {
      out[i] = word;
    } else if (bits > start) {
      const keep = bits - start;
      out[i] = (word & (0xffffffff << (32 - keep))) >>> 0;
    }
  }
  return out;
}

/** Words of a parsed bun-common address, after mapped IPv4 became IPv4. */
function wordsOf(ip: ParsedIp): Uint32Array {
  if (ip.kind === "ipv4") {
    const [a = 0, b = 0, c = 0, d = 0] = ip.octets;
    return Uint32Array.of(((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
  }
  const p = ip.parts;
  const words = new Uint32Array(4);
  for (let i = 0; i < 4; i++) {
    words[i] = (((p[i * 2] ?? 0) << 16) | (p[i * 2 + 1] ?? 0)) >>> 0;
  }
  return words;
}

/** A dotted quad from one word. */
function formatIpv4(word: number): string {
  return `${word >>> 24}.${(word >>> 16) & 0xff}.${(word >>> 8) & 0xff}.${word & 0xff}`;
}

/**
 * An IPv6 address in RFC 5952 §4's form: lower case, no leading zeros, the
 * longest run of two or more zero groups (the first, on a tie) written `::`.
 */
export function formatIpv6(words: Uint32Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 4; i++) {
    const word = words[i] ?? 0;
    groups.push(word >>> 16, word & 0xffff);
  }
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) {
    return hex.join(":");
  }
  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

/** The canonical text of an address in `family` with these words. */
export function formatAddress(family: 4 | 6, words: Uint32Array): string {
  return family === 4 ? formatIpv4(words[0] ?? 0) : formatIpv6(words);
}

/**
 * Parses and normalises an address: `null` for anything that is not one (a
 * non-string, `""`, a host name). IPv4-mapped IPv6 becomes IPv4; a zone is
 * dropped. Accepts what bun-common's `trustProxy` accepts (its parser is
 * proxy-addr's), legacy IPv4 forms included, and writes them canonically.
 */
export function parseAddress(value: unknown): ParsedAddress | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return null;
  }
  const parsed = parseIpAddress(value);
  if (!parsed) {
    return null;
  }
  const ip = toIpv4IfMapped(parsed);
  const words = wordsOf(ip);
  const family = ip.kind === "ipv4" ? 4 : 6;
  return { family, words, text: formatAddress(family, words) };
}

/** The canonical text of an address, or `null` when `value` is not one. */
export function normalizeAddress(value: unknown): string | null {
  return parseAddress(value)?.text ?? null;
}

/**
 * What a policy is told when it gives a `/0` range: every address of a
 * family. {@link parseCidr} refuses one (bun-common's `parseIpRange` does, as
 * proxy-addr does for `trustProxy`, and the CIDR trie holds no zero-length
 * prefix), and each place that takes a range adds its own advice after it.
 */
export const WHOLE_FAMILY_RANGE =
  "a /0 range covers every address of its family";

/**
 * Whether `value` is a `/0` range: an address with prefix `0`
 * (`0.0.0.0/0`, `::/0`), an IPv4 netmask of `0.0.0.0`, or an IPv4-mapped
 * IPv6 address with prefix `96` (`::ffff:0:0/96`, which maps to the IPv4
 * `/0`). {@link parseCidr} answers `null` for each, and the places that
 * report it use {@link WHOLE_FAMILY_RANGE} rather than calling the value
 * unparseable.
 */
export function isWholeFamilyRange(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 64) return false;
  const slash = value.lastIndexOf("/");
  if (slash <= 0) return false;
  const address = parseIpAddress(value.slice(0, slash));
  if (address === null) return false;
  const suffix = value.slice(slash + 1);
  if (/^\d{1,3}$/.test(suffix)) {
    const bits = Number(suffix);
    return (
      bits === 0 ||
      (bits === 96 && toIpv4IfMapped(address).kind !== address.kind)
    );
  }
  const mask = address.kind === "ipv4" ? parseIpAddress(suffix) : null;
  return mask?.kind === "ipv4" && mask.octets.every((octet) => octet === 0);
}

/**
 * Parses an address or a CIDR range (`203.0.113.0/24`, `2001:db8::/32`, an
 * IPv4 netmask as `trustProxy` reads one): `null` for anything else. A bare
 * address is a whole-address range. An IPv4-mapped IPv6 range of /96 or
 * longer becomes the IPv4 range it maps, so it matches IPv4 clients; a
 * shorter one stays IPv6 (it spans more than the mapped space).
 */
export function parseCidr(value: unknown): ParsedCidr | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return null;
  }
  let range: IpRange;
  try {
    range = parseIpRange(value);
  } catch {
    return null;
  }
  let ip = range.ip;
  let bits = range.bits;
  if (ip.kind === "ipv6" && bits >= 96) {
    const mapped = toIpv4IfMapped(ip);
    if (mapped.kind === "ipv4") {
      ip = mapped;
      bits -= 96;
      if (bits === 0) {
        return null;
      }
    }
  }
  const family = ip.kind === "ipv4" ? 4 : 6;
  const words = maskWords(wordsOf(ip), bits);
  return {
    family,
    words,
    bits,
    text: `${formatAddress(family, words)}/${bits}`,
  };
}

/** Whether `address` falls inside `cidr` (the brute-force reference for the trie). */
export function cidrContains(
  cidr: ParsedCidr,
  address: ParsedAddress,
): boolean {
  if (cidr.family !== address.family) {
    return false;
  }
  const masked = maskWords(address.words, cidr.bits);
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== cidr.words[i]) {
      return false;
    }
  }
  return true;
}

/**
 * The key an address is counted and banned under (layers.md L2.3): an IPv4
 * address as itself, an IPv6 address as its `/prefix` network (`/64` by
 * default, so one subscriber's rotation through its /64 is one key), or as
 * itself at `/128`.
 */
export function addressKey(address: ParsedAddress, ipv6Prefix: number): string {
  if (address.family === 4 || ipv6Prefix >= 128) {
    return address.text;
  }
  return `${formatIpv6(maskWords(address.words, ipv6Prefix))}/${ipv6Prefix}`;
}
