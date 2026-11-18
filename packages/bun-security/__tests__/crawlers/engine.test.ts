/**
 * Verified crawlers in the engine (layers.md L3.2), T-L3-1 to T-L3-5: the
 * allowance and each exemption, spoofed claimants, the methods and paths it
 * covers, its own limit, dry run and off, the conflict check. No real DNS:
 * a fake resolver and a fake intel (Google's crawler ranges, a country, an
 * ASN, the hosting class), or ranges from a local fake for T-L3-5.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  analyticsSignalHook,
  ANALYTICS_METRICS,
  createAnalyticsRecorder,
} from "../../lib/analytics/index";
import type { CrawlerResolver } from "../../lib/crawlers/verify";
import type { Decision } from "../../lib/engine/decision";
import type { RequestFacts } from "../../lib/engine/facts";
import { createSecurity } from "../../lib/engine/security";
import type { Security } from "../../lib/engine/security";
import type { SecurityWarning } from "../../lib/engine/trust";
import { crawlerFeeds } from "../../lib/intel/crawlers";
import { ipIntel } from "../../lib/intel/intel";
import type { IntelLookup, IntelRecord } from "../../lib/intel/types";
import { cidrContains, parseAddress, parseCidr } from "../../lib/ip/address";
import type { SecurityPolicy } from "../../lib/policy/types";
import { facts, fakeClock } from "../helpers";
import type { FakeClock } from "../helpers";

const GOOGLEBOT =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const GOOGLE_RANGE = "66.249.64.0/19";
const CRAWLER = "66.249.66.1";
const OUTSIDER = "203.0.113.50";

/** A fake intel: Google's range is in the US, AS15169, and hosting. */
function fakeIntel(): IntelLookup {
  const range = parseCidr(GOOGLE_RANGE)!;
  return {
    lookup(address): IntelRecord {
      const parsed =
        typeof address === "string" ? parseAddress(address) : address;
      return parsed !== null && cidrContains(range, parsed)
        ? { country: "US", asn: 15169, classes: ["crawler:google", "hosting"] }
        : { classes: [] };
    },
    provides: () => ({
      country: true,
      asn: true,
      classes: new Set(["crawler:google", "hosting"]),
    }),
    ranges: (name) => (name === "crawler:google" ? [GOOGLE_RANGE] : []),
  };
}

/** A resolver that knows one forged PTR and nothing else (no real DNS). */
const resolver: CrawlerResolver = {
  reverse: (address) =>
    address === "203.0.113.5"
      ? Promise.resolve(["crawl-203-0-113-5.googlebot.com"])
      : Promise.reject(
          Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }),
        ),
  lookup: () => Promise.resolve(["66.249.66.200"]),
};

/** An engine over the fakes. */
function engine(
  policy: SecurityPolicy,
  options: {
    clock?: FakeClock;
    warnings?: SecurityWarning[];
    intel?: IntelLookup;
  } = {},
): Security {
  return createSecurity({
    policy,
    intel: options.intel ?? fakeIntel(),
    resolver,
    now: (options.clock ?? fakeClock()).now,
    logger: () => {},
    onWarning: (warning) => options.warnings?.push(warning),
  });
}

/** A request from `client` with Googlebot's `User-Agent`. */
function crawl(
  path: string,
  client = CRAWLER,
  overrides: Partial<RequestFacts> = {},
): RequestFacts {
  return facts({
    client,
    path,
    rawPath: path,
    headers: { "user-agent": GOOGLEBOT },
    ...overrides,
  });
}

/** The same request without the crawler's `User-Agent`. */
function plain(path: string, client = CRAWLER): RequestFacts {
  return facts({
    client,
    path,
    rawPath: path,
    headers: { "user-agent": "curl/8" },
  });
}

/** `evaluate()`, then `complete()` with `status`. */
async function visit(
  security: Security,
  request: RequestFacts,
  status = 200,
): Promise<Decision> {
  const decision = await security.evaluate(request, { track: true });
  await security.complete(request, decision, {
    status,
    routeNotFound: status === 404,
  });
  return decision;
}

/** The ConcaveHR crawl's hazards, enforced. */
const HAZARDS: SecurityPolicy = {
  requestRules: { managed: { mode: "enforce" } },
  deception: { honeypots: true },
  countedRules: [
    {
      id: "not_found_per_minute",
      event: "route.notFound",
      threshold: 120,
      window: "1m",
      duration: "24h",
    },
  ],
};

describe("T-L3-1: a verified crawler crawls dead links, a published /wp-admin link and a honeypot", () => {
  it("is never banned, challenged or scored; crawler.probe and crawler.honeypot are logged", async () => {
    const security = engine(HAZARDS);
    for (let i = 0; i < 500; i++) {
      const decision = await visit(security, crawl(`/old/page-${i}`), 404);
      expect(decision.action).toBe("allow");
    }
    const probe = await visit(security, crawl("/wp-admin/install.php"), 404);
    expect(probe.action).toBe("log");
    expect(probe.hits[0]?.reason).toStartWith("crawler.probe:");
    const honeypot = await visit(security, crawl("/wp-login.php"), 404);
    expect(honeypot.action).toBe("log");
    expect(
      honeypot.hits.some((hit) => hit.reason?.startsWith("crawler.honeypot:")),
    ).toBe(true);
    const after = await visit(security, crawl("/"));
    expect(after.action).toBe("allow");
    expect(after.crawler).toEqual({
      id: "google",
      verified: true,
      verifiedBy: "ranges",
      spoofed: false,
    });
    expect(security.bans()).toEqual([]);
    expect(security.status().state.scores).toBe(0);
  });

  it("negative control: with the allowance off, not_found_per_minute bans it", async () => {
    const security = engine({ ...HAZARDS, crawlers: { mode: "off" } });
    for (let i = 0; i < 121; i++)
      await visit(security, crawl(`/old/page-${i}`), 404);
    expect(security.bans().map((ban) => ban.rule)).toContain(
      "counted:not_found_per_minute",
    );
    expect((await security.evaluate(crawl("/"))).action).toBe("ban");
  });
});

describe("T-L3-2: spoofed claimants", () => {
  it("blocks a Googlebot User-Agent from outside the ranges with no PTR, weight 5", async () => {
    const security = engine({});
    const decision = await security.evaluate(crawl("/", OUTSIDER));
    expect(decision).toMatchObject({
      action: "block",
      status: 403,
      code: "blocked",
    });
    expect(decision.hits[0]).toMatchObject({
      layer: "L10",
      rule: "crawler.spoofed",
    });
    expect(decision.crawler).toEqual({
      id: "google",
      verified: false,
      verifiedBy: "rdns",
      spoofed: true,
    });
    expect(security.status().state.scores).toBe(1);
  });

  it("blocks one whose PTR names googlebot.com but whose forward lookup does not return it", async () => {
    const decision = await engine({}).evaluate(crawl("/", "203.0.113.5"));
    expect(decision.action).toBe("block");
    expect(decision.hits[0]?.reason).toContain(
      "does not resolve back to the address",
    );
  });

  it("takes the policy's action and weight, logs in dry run, and leaves a plain allow entry's address alone", async () => {
    const logged = await engine({
      crawlers: { spoofed: { action: "log", weight: 0 } },
    }).evaluate(crawl("/", OUTSIDER));
    expect([logged.action, logged.hits[0]?.rule]).toEqual([
      "log",
      "crawler.spoofed",
    ]);
    const dry = await engine({ crawlers: { mode: "dryRun" } }).evaluate(
      crawl("/", OUTSIDER),
    );
    expect([dry.action, dry.hits[0]?.wouldHaveBeen]).toEqual(["log", "block"]);
    const staff = await engine({
      lists: [{ ip: "203.0.113.0/24", action: "allow" }],
    }).evaluate(crawl("/", OUTSIDER));
    expect(staff.action).toBe("allow");
  });

  it("negative control: the same User-Agent's request from the crawler's ranges is not blocked", async () => {
    expect((await engine({}).evaluate(crawl("/"))).action).toBe("allow");
  });
});

describe("T-L3-3: outside the allowance, a verified crawler is an ordinary client", () => {
  it("a POST is held to the honeypots and the probe rules", async () => {
    const security = engine(HAZARDS);
    const post = await security.evaluate(
      crawl("/wp-login.php", CRAWLER, { method: "POST" }),
    );
    expect(
      post.hits.map((hit) => [
        hit.rule,
        hit.reason?.startsWith("crawler.") ?? false,
      ]),
    ).toEqual([["probe:wordpress", false]]);
    expect(post.action).toBe("block");
  });

  it("an excluded path is held to them too", async () => {
    const security = engine({
      ...HAZARDS,
      crawlers: { paths: { exclude: ["/wp-*"] } },
    });
    const decision = await security.evaluate(crawl("/wp-login.php"));
    expect(decision.action).toBe("block");
    expect(decision.hits[0]?.reason?.startsWith("crawler.")).toBe(false);
    // It is still verified: the decision says so.
    expect(decision.crawler?.verified).toBe(true);
  });
});

describe("T-L3-4: a resolver that hangs", () => {
  it("leaves the claimant unverified within verifyTimeoutMs: an ordinary client, not spoofed", async () => {
    const security = createSecurity({
      policy: { crawlers: { verify: "rdns" } },
      resolver: {
        reverse: () => new Promise(() => {}),
        lookup: () => new Promise(() => {}),
      },
      verifyTimeoutMs: 30,
      logger: () => {},
    });
    const started = performance.now();
    const decision = await security.evaluate(crawl("/"));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(decision.action).toBe("allow");
    expect(decision.crawler).toEqual({
      id: "google",
      verified: false,
      spoofed: false,
    });
  });
});

describe("T-L3-5: the conflict check, and a truncated range file", () => {
  it("names the crawler and the entry: a country block, an ASN block, an IP block, a manual ban", () => {
    const warnings: SecurityWarning[] = [];
    const security = engine(
      {
        lists: [
          { country: "US", action: "block" },
          { asn: 15169, action: "challenge" },
          { ip: "66.249.66.0/24", action: "block" },
          { ip: "198.51.100.0/24", action: "block" },
        ],
      },
      { warnings },
    );
    const conflicts = security.crawlerConflicts();
    expect(conflicts.map((c) => [c.crawler, c.entry])).toEqual([
      ["google", "lists[0] country:US"],
      ["google", "lists[1] asn:15169"],
      ["google", "lists[2] ip:66.249.66.0/24"],
    ]);
    expect(
      warnings
        .filter((w) => w.kind === "crawler.conflict")
        .map((w) => w.message),
    ).toEqual(
      conflicts.map((c) => `bun-security: crawler conflict: ${c.message}`),
    );
    // Each names its entry's key as the effective policy's paths do (PR-AN2).
    expect(conflicts.map((c) => [c.entryId, c.banId])).toEqual([
      ["country:US", undefined],
      ["asn:15169", undefined],
      ["ip:66.249.66.0/24", undefined],
    ]);
    const ban = security.ban({
      ip: "66.249.70.0/24",
      duration: "1h",
      reason: "by hand",
    });
    const byBan = security
      .crawlerConflicts()
      .filter((c) => c.entry.startsWith("ban "));
    expect(byBan.map((c) => [c.banId, c.entryId])).toEqual([
      [ban.id, undefined],
    ]);
    // An entry's own id, and a route-scoped entry's paths, as the merge keys them.
    expect(
      engine({
        lists: [
          { id: "no-google", ip: "66.249.66.0/24", action: "block" },
          { ip: "66.249.67.0/24", action: "block", paths: ["/a", "/b"] },
        ],
      })
        .crawlerConflicts()
        .map((c) => c.entryId),
    ).toEqual(["no-google", "ip:66.249.67.0/24|/a,/b"]);
    // Negative control: no conflict without the crawler's ranges.
    const blind = engine(
      { lists: [{ country: "US", action: "block" }] },
      { intel: { ...fakeIntel(), ranges: () => [] } },
    );
    expect(blind.crawlerConflicts()).toEqual([]);
  });

  describe("a truncated crawler range file", () => {
    let server: ReturnType<typeof Bun.serve>;
    let body = "";
    beforeAll(() => {
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Response(body),
      });
    });
    afterAll(() => server.stop(true));

    /** Google's file shape with `n` /24s in 66.249.64.0/19 and beyond. */
    const file = (n: number) =>
      JSON.stringify({
        creationTime: "2026-11-16T00:00:00",
        prefixes: Array.from({ length: n }, (_, i) => ({
          ipv4Prefix: `66.${249 + Math.floor(i / 256)}.${i % 256}.0/24`,
        })),
      });

    it("keeps the last good file; the crawler stays verified by it", async () => {
      const feeds = crawlerFeeds({ allow: ["google"] }).map((feed) => ({
        ...feed,
        url: `http://127.0.0.1:${server.port}/google.json`,
      }));
      const clock = fakeClock();
      const intel = await ipIntel({ feeds, now: clock.now, logger: () => {} });
      body = file(150);
      expect((await intel.refresh())[0]).toMatchObject({
        ok: true,
        entries: 150,
      });
      body = file(5);
      clock.advance(86_400_000);
      expect((await intel.refresh())[0]).toMatchObject({
        ok: false,
        entries: 150,
        error: "5 ranges, fewer than minEntries 100",
      });
      const security = createSecurity({
        policy: {},
        intel,
        resolver,
        logger: () => {},
      });
      expect(
        (await security.evaluate(crawl("/", "66.249.66.9"))).crawler,
      ).toMatchObject({ verified: true, verifiedBy: "ranges" });
    });
  });
});

describe("each exemption, for a verified crawler on its allowance", () => {
  it("geo: country and ASN blocks do not apply; an IP block still does", async () => {
    const geo = engine({
      lists: [
        { country: "US", action: "block" },
        { asn: 15169, action: "block" },
      ],
    });
    expect((await geo.evaluate(crawl("/"))).action).toBe("allow");
    expect((await geo.evaluate(plain("/"))).action).toBe("block");
    const ip = engine({ lists: [{ ip: "66.249.66.0/24", action: "block" }] });
    expect((await ip.evaluate(crawl("/"))).action).toBe("block");
  });

  it("perIpLimits: the per-address limits are replaced by the crawler's own (429 with Retry-After)", async () => {
    const security = engine({
      limits: [{ id: "tight", limit: 2, window: "1m", key: "ip" }],
      crawlers: { limit: "4/1m" },
    });
    const decisions: Decision[] = [];
    for (let i = 0; i < 5; i++)
      decisions.push(
        await security.evaluate(crawl(`/p${i}`, `66.249.66.${i + 1}`)),
      );
    expect(decisions.slice(0, 4).map((d) => d.action)).toEqual([
      "allow",
      "allow",
      "allow",
      "allow",
    ]);
    expect(decisions[4]).toMatchObject({ action: "block", status: 429 });
    expect(decisions[4]?.hits[0]?.rule).toBe("limit:crawler");
    expect(decisions[4]?.retryAfter).toBeGreaterThan(0);
    // Negative control: the per-address limit holds an ordinary client.
    for (let i = 0; i < 2; i++)
      await security.evaluate(plain("/x", "198.51.100.1"));
    expect((await security.evaluate(plain("/x", "198.51.100.1"))).action).toBe(
      "block",
    );
  });

  it("autoBans: the ladder never bans it, an earlier automatic ban is skipped, a manual ban applies", async () => {
    const security = engine({ ladder: { weights: { probe: 20 } } });
    for (let i = 0; i < 3; i++) await security.signal(crawl("/"), "probe");
    expect(security.bans()).toEqual([]);
    // An automatic ban of the address, written while it was not a claimant.
    for (let i = 0; i < 1; i++) await security.signal(plain("/"), "probe");
    expect(security.bans().map((ban) => ban.source)).toEqual(["auto"]);
    expect((await security.evaluate(plain("/"))).action).toBe("ban");
    expect((await security.evaluate(crawl("/"))).action).toBe("allow");
    security.ban({ ip: CRAWLER, duration: "1h", reason: "by hand" });
    expect((await security.evaluate(crawl("/"))).action).toBe("ban");
  });

  it("botSignals and hostingClass: no signals, and the hosting class is not counted", async () => {
    const signals = engine({
      botSignals: { classes: { hosting: 5 }, challengeAt: 1 },
    });
    expect((await signals.evaluate(crawl("/"))).action).toBe("allow");
    expect((await signals.evaluate(plain("/"))).action).toBe("block");
    const hosting = engine({
      requestRules: {
        managed: false,
        rules: [{ id: "no-hosting", when: { class: { equals: "hosting" } } }],
      },
    });
    expect((await hosting.evaluate(crawl("/"))).action).toBe("allow");
    expect((await hosting.evaluate(plain("/"))).action).toBe("block");
  });

  it("challenges: never challenged, with or without a flow", async () => {
    const security = engine({
      lists: [{ ip: "66.249.66.0/24", action: "challenge" }],
    });
    const decision = await security.evaluate(crawl("/"));
    expect(decision.action).toBe("log");
    expect(decision.hits[0]?.reason).toContain(
      "a verified crawler is never challenged",
    );
    expect((await security.evaluate(plain("/"))).action).toBe("block");
  });

  it("notFound: its route-not-found answers are not counted", async () => {
    const policy: SecurityPolicy = {
      countedRules: [
        {
          id: "nf",
          event: "route.notFound",
          threshold: 3,
          window: "1m",
          duration: "1h",
        },
      ],
    };
    const crawled = engine(policy);
    for (let i = 0; i < 10; i++) await visit(crawled, crawl(`/gone/${i}`), 404);
    expect(crawled.bans()).toEqual([]);
    const scanned = engine(policy);
    for (let i = 0; i < 3; i++) await visit(scanned, plain(`/gone/${i}`), 404);
    expect(scanned.bans()).toHaveLength(1);
  });

  it("lifts only what `exempt` lists", async () => {
    const security = engine({
      lists: [{ country: "US", action: "block" }],
      crawlers: { exempt: ["notFound"] },
    });
    expect((await security.evaluate(crawl("/"))).action).toBe("block");
  });
});

describe("the allowance's modes", () => {
  it("dryRun lifts nothing, and records that the allowance would have let it through", async () => {
    const security = engine({ ...HAZARDS, crawlers: { mode: "dryRun" } });
    const decision = await security.evaluate(crawl("/wp-login.php"));
    expect(decision.action).toBe("block");
    expect(decision.hits.at(-1)).toMatchObject({
      rule: "crawler:google",
      action: "log",
      wouldHaveBeen: "allow",
    });
  });

  it("off looks at no claimant", async () => {
    const decision = await engine({ crawlers: { mode: "off" } }).evaluate(
      crawl("/", OUTSIDER),
    );
    expect(decision.action).toBe("allow");
    expect(decision.crawler).toBeUndefined();
  });

  it("verifies by DNS, then answers from the cache; explains the claim", async () => {
    const dnsVerified: CrawlerResolver = {
      reverse: () => Promise.resolve(["crawl-198-51-100-77.googlebot.com"]),
      lookup: () => Promise.resolve(["198.51.100.77"]),
    };
    const security = createSecurity({
      policy: {},
      resolver: dnsVerified,
      logger: () => {},
    });
    expect(
      (await security.evaluate(crawl("/", "198.51.100.77"))).crawler,
    ).toMatchObject({ verified: true, verifiedBy: "rdns" });
    const second = security.evaluate(crawl("/", "198.51.100.77"));
    expect(second).not.toBeInstanceOf(Promise);
    expect((second as Decision).crawler?.verifiedBy).toBe("cache");
    const explained = await security.explain(crawl("/", "198.51.100.77"));
    expect(
      explained.steps.find((step) => step.check === "crawler")?.outcome,
    ).toStartWith("claims google: verified by cache");
  });

  it("counts a two-stage request's claim in both stages, verified once", async () => {
    const security = engine(HAZARDS);
    const request = crawl("/wp-login.php");
    expect((await security.evaluate(request, { stage: "early" })).action).toBe(
      "log",
    );
    expect(
      (
        await security.evaluate(
          { ...request, routeKey: "GET /wp-login.php" },
          { stage: "route" },
        )
      ).crawler?.verified,
    ).toBe(true);
  });
});

describe("the crawler series (layers.md L3.2, PR-AN2)", () => {
  /** An engine over the fakes that counts into a recorder; the rows of `crawlers`. */
  function counted(policy: SecurityPolicy) {
    const clock = fakeClock();
    const recorder = createAnalyticsRecorder({
      service: "site",
      now: clock.now,
    });
    const security = createSecurity({
      policy,
      intel: fakeIntel(),
      resolver,
      now: clock.now,
      logger: () => {},
      onDecision: (decision) => recorder.recordDecision(decision),
      onSignal: analyticsSignalHook({ recorder }),
    });
    const rows = () => {
      const out: Record<string, number> = {};
      for (const row of recorder.flush({ all: true })) {
        if (row.metric !== ANALYTICS_METRICS.crawlers) continue;
        const key = `${row.dims?.crawler}/${row.dims?.outcome}`;
        out[key] = (out[key] ?? 0) + row.value;
      }
      return out;
    };
    return { security, rows };
  }

  it("counts each verified crawler's requests, 404s, 429s and what its allowance lifted", async () => {
    const { security, rows } = counted({
      ...HAZARDS,
      crawlers: { limit: "6/1m" },
    });
    await visit(security, crawl("/"));
    await visit(security, crawl("/old/page"), 404);
    await visit(security, crawl("/wp-admin/install.php"), 404);
    await visit(security, crawl("/wp-login.php"), 404);
    // Two more inside the limit, then two refused by it (429).
    for (let i = 0; i < 4; i++) {
      const decision = await visit(security, crawl(`/p/${i}`));
      if (i >= 2) expect(decision.status).toBe(429);
    }
    // The probe and the honeypot were passed on and answered 404 too, and
    // `/wp-login.php` is in the managed probe set as well as a honeypot.
    expect(rows()).toEqual({
      "google/request": 8,
      "google/not-found": 3,
      "google/probe": 2,
      "google/honeypot": 1,
      "google/limited": 2,
    });
  });

  it("negative controls: an unverified claimant, a plain client and the allowance off count nothing", async () => {
    const { security, rows } = counted(HAZARDS);
    await visit(security, plain("/"), 404);
    await visit(security, crawl("/", OUTSIDER), 404);
    expect(rows()).toEqual({});
    const off = counted({ ...HAZARDS, crawlers: { mode: "off" } });
    await visit(off.security, crawl("/"), 404);
    await visit(off.security, crawl("/wp-admin/install.php"), 404);
    expect(off.rows()).toEqual({});
  });

  it("negative control: in dry run its limit's would-be refusals are not counted as limited", async () => {
    const { security, rows } = counted({
      ...HAZARDS,
      crawlers: { mode: "dryRun", limit: "1/1m" },
    });
    for (let i = 0; i < 3; i++) await visit(security, crawl(`/p/${i}`));
    expect(rows()["google/limited"]).toBeUndefined();
  });
});
