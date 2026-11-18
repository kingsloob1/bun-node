/**
 * Addresses and CIDR ranges in the browser, for the lists' validation and
 * their search ("an address finds the CIDR entries containing it"): IPv4
 * and IPv6, an IPv4-mapped IPv6 address read as IPv4, as bun-security's
 * `parseCidr` reads them. A range's host bits are masked off.
 */

/** A parsed address or range. */
export interface Cidr {
  /** 4 or 6. */
  readonly family: 4 | 6;
  /** The network, host bits masked off. */
  readonly base: bigint;
  /** The prefix length (32 or 128 for a single address). */
  readonly bits: number;
}

/** Each family's width in bits. */
const WIDTH = { 4: 32, 6: 128 } as const;

/** An IPv4 address as a number, or `null`. */
function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith("0")))
      return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/** An IPv6 address as a number, or `null`. */
function parseIpv6(text: string): bigint | null {
  if (text.length === 0 || text.includes("%")) return null;
  let head = text;
  let tail = "";
  const double = text.indexOf("::");
  if (double !== -1) {
    if (text.includes("::", double + 1)) return null;
    head = text.slice(0, double);
    tail = text.slice(double + 2);
  }
  const words = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const groups = part.split(":");
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i];
      if (i === groups.length - 1 && group.includes(".")) {
        const v4 = parseIpv4(group);
        if (v4 === null) return null;
        out.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const left = words(head);
  const right = words(tail);
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if (double === -1 ? missing !== 0 : missing < 1) return null;
  const all = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  let value = 0n;
  for (const word of all) value = (value << 16n) | BigInt(word);
  return value;
}

/** The mask of a prefix of `bits` in a family `width` wide. */
function maskOf(width: number, bits: number): bigint {
  const all = (1n << BigInt(width)) - 1n;
  return bits === 0
    ? 0n
    : (all >> BigInt(width - bits)) << BigInt(width - bits);
}

/** An address or a range, or `null`; a bare address is a /32 or /128. */
export function parseCidr(text: string): Cidr | null {
  const value = text.trim();
  if (value.length === 0 || value.length > 64) return null;
  const slash = value.indexOf("/");
  const address = slash === -1 ? value : value.slice(0, slash);
  const suffix = slash === -1 ? undefined : value.slice(slash + 1);
  let family: 4 | 6;
  let base: bigint | null;
  if (address.includes(":")) {
    family = 6;
    base = parseIpv6(address);
  } else {
    family = 4;
    base = parseIpv4(address);
  }
  if (base === null) return null;
  let bits: number = WIDTH[family];
  if (suffix !== undefined) {
    if (!/^\d{1,3}$/.test(suffix)) return null;
    bits = Number(suffix);
    if (bits > WIDTH[family]) return null;
  }
  // An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is read as IPv4.
  if (family === 6 && bits >= 96 && base >> 32n === 0xffffn) {
    family = 4;
    base &= 0xffffffffn;
    bits -= 96;
  }
  return { family, base: base & maskOf(WIDTH[family], bits), bits };
}

/** Whether `text` is a single address (not a range). */
export function isAddress(text: string): boolean {
  const parsed = parseCidr(text);
  return (
    parsed !== null &&
    !text.includes("/") &&
    parsed.bits === WIDTH[parsed.family]
  );
}

/** Whether `range` contains `address` (a range contains itself and narrower ones). */
export function cidrContains(range: Cidr, address: Cidr): boolean {
  if (range.family !== address.family || address.bits < range.bits)
    return false;
  return (
    (address.base & maskOf(WIDTH[range.family], range.bits)) === range.base
  );
}

/** The widest allow entry the policy accepts, by family (layers.md L3.1). */
export const WIDEST_ALLOW = { 4: 8, 6: 32 } as const;
