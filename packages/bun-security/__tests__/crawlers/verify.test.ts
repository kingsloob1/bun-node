/**
 * Crawler verification (layers.md L3.2) with a fake resolver: no real DNS.
 * Forward-confirmed reverse DNS (T-L3-2's two forgeries), the ranges, the
 * verdict cache and its lifetimes, and the bounds (T-L3-4): a hanging
 * resolver is unknown within `verifyTimeoutMs` and nothing is cached; an
 * erroring one is unknown; a flood of claimants never opens more than
 * `maxPendingVerifications` lookups; one address's lookup is shared.
 */
import { describe, expect, it } from "bun:test";
import { CRAWLERS } from "../../lib/crawlers/registry";
import { CrawlerVerifier } from "../../lib/crawlers/verify";
import type { CrawlerResolver } from "../../lib/crawlers/verify";
import { ipIntel } from "../../lib/intel/intel";
import { parseAddress } from "../../lib/ip/address";
import { fakeClock } from "../helpers";

/** A DNS error with a code. */
function dnsError(code: string): Error {
  return Object.assign(new Error(`${code} (fake)`), { code });
}

/** A fake resolver over two tables, counting calls. */
function fakeResolver(
  ptr: Record<string, readonly string[] | Error>,
  forward: Record<string, readonly string[]>,
): CrawlerResolver & { reverses: number; lookups: number } {
  const resolver = {
    reverses: 0,
    lookups: 0,
    reverse: (address: string) => {
      resolver.reverses++;
      const found = ptr[address];
      if (found instanceof Error) return Promise.reject(found);
      return found === undefined
        ? Promise.reject(dnsError("ENOTFOUND"))
        : Promise.resolve(found);
    },
    lookup: (name: string) => {
      resolver.lookups++;
      const found = forward[name];
      return found === undefined
        ? Promise.reject(dnsError("ENOTFOUND"))
        : Promise.resolve(found);
    },
  };
  return resolver;
}

const GOOGLE = CRAWLERS.google;
const address = (text: string) => parseAddress(text)!;

describe("verification by forward-confirmed reverse DNS", () => {
  const resolver = () =>
    fakeResolver(
      {
        "66.249.66.1": ["crawl-66-249-66-1.googlebot.com"],
        "203.0.113.5": ["crawl-203-0-113-5.googlebot.com"], // a PTR the attacker controls
        "198.51.100.7": ["host.example.net"],
        "198.51.100.8": dnsError("ESERVFAIL"),
        "2001:4860:4801:10::1": [
          "crawl-2001-4860-4801-0010-0000-0000-0000-0001.googlebot.com.",
        ],
      },
      {
        "crawl-66-249-66-1.googlebot.com": ["66.249.66.1"],
        "crawl-203-0-113-5.googlebot.com": ["66.249.66.200"],
        "crawl-2001-4860-4801-0010-0000-0000-0000-0001.googlebot.com": [
          "2001:4860:4801:10::1",
        ],
      },
    );

  it("verifies a name under the crawler's domain that resolves back to the address (IPv4 and IPv6)", async () => {
    const verifier = new CrawlerVerifier({
      resolver: resolver(),
      now: Date.now,
    });
    expect(
      await verifier.verify(GOOGLE, address("66.249.66.1"), "rdns", undefined),
    ).toMatchObject({
      status: "verified",
      by: "rdns",
    });
    expect(
      await verifier.verify(
        GOOGLE,
        address("2001:4860:4801:10::1"),
        "rdns",
        undefined,
      ),
    ).toMatchObject({ status: "verified" });
  });

  it("T-L3-2: refuses a PTR under googlebot.com whose forward lookup does not return the address", async () => {
    const verifier = new CrawlerVerifier({
      resolver: resolver(),
      now: Date.now,
    });
    expect(
      await verifier.verify(GOOGLE, address("203.0.113.5"), "rdns", undefined),
    ).toMatchObject({
      status: "spoofed",
      reason:
        "crawl-203-0-113-5.googlebot.com does not resolve back to the address",
    });
  });

  it("refuses a name outside the crawler's domains, and an address with no name", async () => {
    const verifier = new CrawlerVerifier({
      resolver: resolver(),
      now: Date.now,
    });
    expect(
      (
        await verifier.verify(
          GOOGLE,
          address("198.51.100.7"),
          "rdns",
          undefined,
        )
      ).status,
    ).toBe("spoofed");
    expect(
      await verifier.verify(GOOGLE, address("192.0.2.1"), "rdns", undefined),
    ).toMatchObject({
      status: "spoofed",
      reason: "the address has no reverse DNS name",
    });
  });

  it("calls a resolver error unknown, and does not cache it", async () => {
    const dns = resolver();
    const verifier = new CrawlerVerifier({ resolver: dns, now: Date.now });
    expect(
      (
        await verifier.verify(
          GOOGLE,
          address("198.51.100.8"),
          "rdns",
          undefined,
        )
      ).status,
    ).toBe("unknown");
    await verifier.verify(GOOGLE, address("198.51.100.8"), "rdns", undefined);
    expect(dns.reverses).toBe(2);
    expect(verifier.cached).toBe(0);
  });

  it("caches verdicts: verified for 24 h, spoofed for 1 h, answered from the cache synchronously", async () => {
    const clock = fakeClock();
    const dns = resolver();
    const verifier = new CrawlerVerifier({ resolver: dns, now: clock.now });
    await verifier.verify(GOOGLE, address("66.249.66.1"), "rdns", undefined);
    await verifier.verify(GOOGLE, address("198.51.100.7"), "rdns", undefined);
    expect(dns.reverses).toBe(2);
    const cached = verifier.verify(
      GOOGLE,
      address("66.249.66.1"),
      "rdns",
      undefined,
    );
    expect(cached).not.toBeInstanceOf(Promise);
    expect(cached).toMatchObject({ status: "verified", by: "cache" });
    clock.advance(3_600_000);
    // The negative verdict expired; the positive one holds.
    await verifier.verify(GOOGLE, address("198.51.100.7"), "rdns", undefined);
    expect(dns.reverses).toBe(3);
    clock.advance(23 * 3_600_000);
    await verifier.verify(GOOGLE, address("66.249.66.1"), "rdns", undefined);
    expect(dns.reverses).toBe(4);
  });

  it("shares a verdict through a shared store, so a second process resolves nothing", async () => {
    const kept = new Map<string, unknown>();
    const store = {
      get: (key: string) => Promise.resolve(kept.get(key)),
      set: (key: string, value: unknown) => {
        kept.set(key, value);
        return Promise.resolve();
      },
    };
    const first = resolver();
    await new CrawlerVerifier({ resolver: first, store, now: Date.now }).verify(
      GOOGLE,
      address("66.249.66.1"),
      "rdns",
      undefined,
    );
    const second = resolver();
    const verdict = await new CrawlerVerifier({
      resolver: second,
      store,
      now: Date.now,
    }).verify(GOOGLE, address("66.249.66.1"), "rdns", undefined);
    expect([verdict.status, verdict.by, second.reverses]).toEqual([
      "verified",
      "cache",
      0,
    ]);
  });
});

describe("T-L3-4: the bounds", () => {
  it("a hanging resolver is unknown within verifyTimeoutMs, and nothing is cached", async () => {
    const hanging: CrawlerResolver = {
      reverse: () => new Promise(() => {}),
      lookup: () => new Promise(() => {}),
    };
    const verifier = new CrawlerVerifier({
      resolver: hanging,
      verifyTimeoutMs: 50,
      now: Date.now,
    });
    const started = performance.now();
    const verdict = await verifier.verify(
      GOOGLE,
      address("66.249.66.1"),
      "rdns",
      undefined,
    );
    const took = performance.now() - started;
    expect(verdict.status).toBe("unknown");
    expect(took).toBeLessThan(1_000);
    expect([verifier.cached, verifier.pending]).toEqual([0, 0]);
  });

  it("a flood of claimants opens at most maxPendingVerifications lookups; the rest are unknown at once", async () => {
    let open = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const slow: CrawlerResolver = {
      reverse: () =>
        new Promise((resolve) => {
          open++;
          most = Math.max(most, open);
          releases.push(() => {
            open--;
            resolve(["elsewhere.example"]);
          });
        }),
      lookup: () => Promise.resolve([]),
    };
    const verifier = new CrawlerVerifier({
      resolver: slow,
      maxPendingVerifications: 8,
      verifyTimeoutMs: 5_000,
      now: Date.now,
    });
    const verdicts = Array.from({ length: 1_000 }, (_, i) =>
      verifier.verify(
        GOOGLE,
        address(`10.${Math.floor(i / 250)}.${i % 250}.1`),
        "rdns",
        undefined,
      ),
    );
    expect(verifier.pending).toBe(8);
    const immediate = verdicts.filter((v) => !(v instanceof Promise));
    expect(immediate).toHaveLength(992);
    expect(
      immediate.every((v) => (v as { status: string }).status === "unknown"),
    ).toBe(true);
    // The lookups start a tick later (after the shared store is asked).
    await Bun.sleep(10);
    expect(releases).toHaveLength(8);
    for (const release of releases.splice(0)) release();
    const settled = await Promise.all(verdicts);
    expect(settled.filter((v) => v.status === "spoofed")).toHaveLength(8);
    expect(most).toBe(8);
  });

  it("one address's claimants share one lookup", async () => {
    const dns = fakeResolver(
      { "66.249.66.1": ["crawl-66-249-66-1.googlebot.com"] },
      { "crawl-66-249-66-1.googlebot.com": ["66.249.66.1"] },
    );
    const verifier = new CrawlerVerifier({ resolver: dns, now: Date.now });
    const both = await Promise.all([
      verifier.verify(GOOGLE, address("66.249.66.1"), "rdns", undefined),
      verifier.verify(GOOGLE, address("66.249.66.1"), "rdns", undefined),
    ]);
    expect(both.map((v) => v.status)).toEqual(["verified", "verified"]);
    expect(dns.reverses).toBe(1);
  });
});

describe("verification by ranges", () => {
  it("verifies inside the crawler's ranges without DNS, and falls back to DNS outside them", async () => {
    const intel = await ipIntel({
      ranges: { "crawler:google": ["66.249.64.0/19"] },
    });
    const dns = fakeResolver(
      { "203.0.113.9": ["crawl.googlebot.com"] },
      { "crawl.googlebot.com": ["203.0.113.9"] },
    );
    const verifier = new CrawlerVerifier({ resolver: dns, now: Date.now });
    expect(
      verifier.verify(
        GOOGLE,
        address("66.249.66.1"),
        "ranges-then-rdns",
        intel,
      ),
    ).toMatchObject({
      status: "verified",
      by: "ranges",
    });
    expect(dns.reverses).toBe(0);
    expect(
      (
        await verifier.verify(
          GOOGLE,
          address("203.0.113.9"),
          "ranges-then-rdns",
          intel,
        )
      ).status,
    ).toBe("verified");
    // `ranges` alone: outside them is spoofed, no DNS asked.
    expect(
      verifier.verify(GOOGLE, address("203.0.113.9"), "ranges", intel),
    ).toMatchObject({ status: "spoofed", by: "ranges" });
    expect(dns.reverses).toBe(1);
  });

  it("is unknown without the ranges loaded, or for a crawler with neither ranges nor DNS", async () => {
    const verifier = new CrawlerVerifier({
      resolver: fakeResolver({}, {}),
      now: Date.now,
    });
    expect(
      verifier.verify(GOOGLE, address("66.249.66.1"), "ranges", undefined),
    ).toMatchObject({ status: "unknown" });
    expect(
      verifier.verify(
        CRAWLERS.duckduckgo,
        address("20.191.45.212"),
        "ranges-then-rdns",
        undefined,
      ),
    ).toMatchObject({
      status: "unknown",
    });
    const intel = await ipIntel({
      ranges: { "crawler:duckduckgo": ["20.191.45.212/32"] },
    });
    expect(
      verifier.verify(
        CRAWLERS.duckduckgo,
        address("20.191.45.213"),
        "ranges-then-rdns",
        intel,
      ),
    ).toMatchObject({
      status: "spoofed",
    });
  });
});
