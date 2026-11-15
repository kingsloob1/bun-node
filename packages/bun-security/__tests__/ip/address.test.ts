/**
 * Address normalisation and keys (layers.md L2.1, L2.3).
 */
import { describe, expect, it } from "bun:test";
import {
  addressKey,
  normalizeAddress,
  parseAddress,
  parseCidr,
} from "../../lib/ip/address";

describe("normalizeAddress", () => {
  it("turns an IPv4-mapped address into IPv4 (a default listener's IPv4 clients)", () => {
    expect(normalizeAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeAddress("::FFFF:203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeAddress("::ffff:cb00:7105")).toBe("203.0.113.5");
  });

  it("writes IPv6 in its RFC 5952 form, one text per address", () => {
    expect(normalizeAddress("2001:DB8::1")).toBe("2001:db8::1");
    expect(normalizeAddress("2001:db8:0:0::1")).toBe("2001:db8::1");
    expect(normalizeAddress("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(
      "2001:db8::1",
    );
    expect(normalizeAddress("2001:db8:0:1:0:0:0:1")).toBe("2001:db8:0:1::1");
    expect(normalizeAddress("2001:db8:0:0:1:0:0:1")).toBe("2001:db8::1:0:0:1");
    expect(normalizeAddress("::")).toBe("::");
    expect(normalizeAddress("::1")).toBe("::1");
    expect(normalizeAddress("1::")).toBe("1::");
    expect(normalizeAddress("2001:db8:1:1:1:1:1:0")).toBe(
      "2001:db8:1:1:1:1:1:0",
    );
  });

  it("drops a zone", () => {
    expect(normalizeAddress("fe80::1%eth0")).toBe("fe80::1");
  });

  it("reads the legacy IPv4 forms trustProxy reads, canonically", () => {
    expect(normalizeAddress("2130706433")).toBe("127.0.0.1");
    expect(normalizeAddress("0x7f.0.0.1")).toBe("127.0.0.1");
  });

  it("refuses what is not an address", () => {
    for (const value of [
      "",
      "example.com",
      "1.2.3.256",
      "::g",
      undefined,
      42,
      "1".repeat(100),
    ]) {
      expect(normalizeAddress(value)).toBeNull();
    }
  });
});

describe("parseCidr", () => {
  it("clears host bits and writes the range canonically", () => {
    expect(parseCidr("203.0.113.77/24")?.text).toBe("203.0.113.0/24");
    expect(parseCidr("2001:DB8:0:0:1::/32")?.text).toBe("2001:db8::/32");
    expect(parseCidr("10.0.0.0/255.0.0.0")?.text).toBe("10.0.0.0/8");
  });

  it("reads a bare address as a whole-address range", () => {
    expect(parseCidr("203.0.113.5")?.text).toBe("203.0.113.5/32");
    expect(parseCidr("2001:db8::1")?.text).toBe("2001:db8::1/128");
  });

  it("turns an IPv4-mapped range of /96 or longer into IPv4", () => {
    expect(parseCidr("::ffff:203.0.113.0/120")?.text).toBe("203.0.113.0/24");
    expect(parseCidr("::ffff:0:0/80")?.family).toBe(6);
  });

  it("refuses /0 and garbage", () => {
    expect(parseCidr("0.0.0.0/0")).toBeNull();
    expect(parseCidr("::ffff:0.0.0.0/96")).toBeNull();
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("nope/8")).toBeNull();
    expect(parseCidr(8)).toBeNull();
  });
});

describe("addressKey", () => {
  /** The key of `text` at `prefix`. */
  const key = (text: string, prefix = 64): string => {
    const address = parseAddress(text);
    if (!address) throw new Error(text);
    return addressKey(address, prefix);
  };

  it("keys IPv4 by the address", () => {
    expect(key("203.0.113.5")).toBe("203.0.113.5");
    expect(key("::ffff:203.0.113.5")).toBe("203.0.113.5");
  });

  it("T-L2-3: keys IPv6 by its /64, so rotation inside one /64 is one key", () => {
    const keys = new Set(
      [
        "2001:db8:1:2::1",
        "2001:db8:1:2:ffff::9",
        "2001:db8:1:2:dead:beef:0:1",
      ].map((address) => key(address)),
    );
    expect([...keys]).toEqual(["2001:db8:1:2::/64"]);
    expect(key("2001:db8:1:3::1")).not.toBe(key("2001:db8:1:2::1"));
  });

  it("takes another prefix, and /128 is the address itself", () => {
    expect(key("2001:db8:1:2::1", 48)).toBe("2001:db8:1::/48");
    expect(key("2001:db8:1:2::1", 128)).toBe("2001:db8:1:2::1");
  });
});
