/**
 * `throttle()`'s default key on `req.clientAddress` (bun-node#792): the
 * client `req.ip` names, normalised, and never a malformed `X-Forwarded-For`
 * entry. The issue's reproduction, the key a junk entry falls back to, the
 * custom `ipv6Subnet` path, and the compatibility property the switch rests
 * on: for every request whose `req.ip` is an address, the key is the one
 * `req.ip` gave, so the counts a store already holds carry over.
 */
import { describe, expect, it } from "bun:test";
import { BunRouter } from "../lib/BunRouter";
import {
  defaultThrottleKey,
  getThrottleResults,
  throttle,
  throttleAddressKey,
} from "../lib/throttle";
import { normalizeIpAddress } from "../lib/utils/native";
import { makeRequest } from "./helpers";

/** A minute-aligned instant, so window edges are exact. */
const T0 = 60_000 * 29_000_000;

/** The statuses of `/` for each forwarded value, from the trusted peer 10.0.0.4. */
async function statuses(
  router: BunRouter,
  forwarded: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const xff of forwarded) {
    const res = await router.fetch("/", {
      headers: { "x-forwarded-for": xff },
      remoteAddress: "10.0.0.4",
    });
    out.push(`${xff} ${res.status}`);
  }
  return out;
}

describe("the default key is req.clientAddress", () => {
  it("the issue's reproduction: junk in X-Forwarded-For shares the nearest trusted hop's count", async () => {
    const router = new BunRouter({ trustProxy: true });
    router.use(throttle({ limit: 1, window: "1m", now: () => T0 }));
    router.get("/", (_req, res) => res.send("ok"));
    expect(
      await statuses(router, [
        "not-an-ip-1",
        "not-an-ip-2",
        "not-an-ip-3",
        "203.0.113.5",
        "203.0.113.5",
      ]),
    ).toEqual([
      // Before #792 each junk value was a key of its own: 200, 200, 200.
      "not-an-ip-1 200",
      "not-an-ip-2 429",
      "not-an-ip-3 429",
      "203.0.113.5 200",
      "203.0.113.5 429",
    ]);
  });

  it("names the key it counted: the trusted hop for junk, the client otherwise, unknown with no address", async () => {
    const keys: string[] = [];
    const router = new BunRouter({ trustProxy: true });
    router.use(throttle({ limit: 100, window: "1m", now: () => T0 }));
    router.get("/", (req, res) => {
      keys.push(getThrottleResults(req)?.[0]?.key ?? "none");
      res.send("ok");
    });
    await statuses(router, ["junk", "::ffff:203.0.113.5", "2001:DB8::1"]);
    await router.fetch("/");
    expect(keys).toEqual([
      "10.0.0.4",
      "203.0.113.5",
      "2001:db8::/56",
      "unknown",
    ]);
  });

  it("the ipv6Subnet path reads req.clientAddress too", async () => {
    const keys: string[] = [];
    const router = new BunRouter({ trustProxy: true });
    router.use(
      throttle({ limit: 100, window: "1m", ipv6Subnet: 64, now: () => T0 }),
    );
    router.get("/", (req, res) => {
      keys.push(getThrottleResults(req)?.[0]?.key ?? "none");
      res.send("ok");
    });
    const res = await router.fetch("/", {
      headers: { "x-forwarded-for": "junk, 2001:db8:1:2:3::9" },
      remoteAddress: "10.0.0.4",
    });
    expect(res.status).toBe(200);
    // The walk ends on "junk"; the nearest trusted hop is the IPv6 client.
    expect(keys).toEqual(["2001:db8:1:2::/64"]);
  });

  it("defaultThrottleKey reads clientAddress, not ip", async () => {
    const req = await makeRequest({
      peer: "10.0.0.4",
      headers: { "x-forwarded-for": "garbage" },
      options: { trustProxy: true },
    });
    expect(req.ip).toBe("garbage");
    expect(defaultThrottleKey(req)).toBe("10.0.0.4");
    const none = await makeRequest({ peer: null });
    expect(defaultThrottleKey(none)).toBe("unknown");
  });
});

describe("the key an address gets is unchanged (counts carry over)", () => {
  /** Spellings of addresses `req.ip` may hold, each an address. */
  const SPELLINGS = [
    "203.0.113.9",
    "::ffff:203.0.113.9",
    "::FFFF:cb00:7109",
    "0xcb.0.113.9",
    "3405803785",
    "0313.0.0161.011",
    "2001:db8::1",
    "2001:DB8:0:0:0:0:0:1",
    "2001:0db8:0000::0001",
    "fe80::1%eth0",
    "2001:db8:aa:bb00:1:2:3:4",
    "::",
    "::1",
    "1::",
    "2001:db8:0:0:1:0:0:1",
  ];
  const PREFIXES = [56, 64, 1, 128, false] as const;

  it("throttleAddressKey(req.ip) equals throttleAddressKey(req.clientAddress) for every spelling and prefix", () => {
    const differ: string[] = [];
    for (const spelling of SPELLINGS) {
      const normalized = normalizeIpAddress(spelling);
      expect({ spelling, normalized: normalized === null }).toEqual({
        spelling,
        normalized: false,
      });
      for (const prefix of PREFIXES) {
        if (
          throttleAddressKey(spelling, prefix) !==
          throttleAddressKey(normalized ?? "", prefix)
        ) {
          differ.push(`${spelling} /${String(prefix)}`);
        }
      }
    }
    expect(differ).toEqual([]);
  });

  it("holds for random addresses written in random spellings", () => {
    // A fixed-seed generator, so a failure reproduces.
    let state = 0x9e3779b9;
    const next = (): number => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };
    const hex = (value: number, pad: boolean, upper: boolean): string => {
      const text = value.toString(16);
      const padded = pad ? text.padStart(4, "0") : text;
      return upper ? padded.toUpperCase() : padded;
    };
    const differ: string[] = [];
    for (let i = 0; i < 2_000; i++) {
      let spelling: string;
      if (next() % 3 === 0) {
        const octets = [next() & 255, next() & 255, next() & 255, next() & 255];
        spelling =
          next() % 2 === 0 ? octets.join(".") : `::ffff:${octets.join(".")}`;
      } else {
        // Zero groups are common in real addresses: half of them, here.
        const groups = Array.from({ length: 8 }, () =>
          next() % 2 === 0 ? 0 : next() & 0xffff,
        );
        const pad = next() % 2 === 0;
        const upper = next() % 2 === 0;
        spelling = groups.map((group) => hex(group, pad, upper)).join(":");
        if (next() % 4 === 0) spelling += "%eth0";
      }
      const normalized = normalizeIpAddress(spelling);
      if (normalized === null) {
        differ.push(`${spelling} did not parse`);
        continue;
      }
      for (const prefix of PREFIXES) {
        if (
          throttleAddressKey(spelling, prefix) !==
          throttleAddressKey(normalized, prefix)
        ) {
          differ.push(`${spelling} /${String(prefix)}`);
        }
      }
    }
    expect(differ).toEqual([]);
  });
});
