/**
 * Scanning against ConcaveHR's request path (plan §11.2, §12; layers.md L7,
 * L8, L14, L3.2): ffuf-style probing of well-known paths, a fuzzing burst
 * of dead links (`not_found_per_minute`), a honeypot and a canary key
 * (T-L8-1), and the crawler allowance: a verified crawler crawling the same
 * hazards (T-L3-1) and a spoofed one (T-L3-2). Each with its negative
 * control, where the attack succeeds.
 */
import { describe, expect, it } from "bun:test";
import {
  apiKeyAbuse,
  crawl,
  paced,
  pathScan,
  PROBE_PATHS,
  spoofedCrawler,
} from "../../lib/testing/index";
import { concaveApp, GOOGLEBOT_ADDRESS } from "./app";

describe("path scanning: the probe paths, then 200 dead links", () => {
  // 20 a second: under requests_per_second's 100, so the probe set and the
  // not-found rule, not the rate, are what stop it.
  const attack = paced(pathScan({ count: 200 }), 50);

  it("refuses every probe, disguised as a 404, and bans the scanner through the ladder at the fourth", async () => {
    const app = await concaveApp();
    const result = await app.run(attack);
    expect(result.sent).toBe(PROBE_PATHS.length + 200);
    // Nothing reached the app: the first four probes were refused with the
    // managed set's disguised 404 (a scanner learns nothing), the rest banned.
    expect(result.refused).toBe(result.sent);
    expect(result.codes).toEqual({
      not_found: 4,
      banned: PROBE_PATHS.length + 196,
    });
    const fired = app.fired();
    expect(fired).toContain("probe:dotenv:block");
    expect(fired).toContain("probe:vcs:block");
    expect(app.security?.bans().map((ban) => [ban.id, ban.rule])).toEqual([
      ["ip:203.0.113.68", "ladder"],
    ]);
  });

  it("negative control: with no engine every probe and dead link is answered", async () => {
    const result = await (await concaveApp({ defences: false })).run(attack);
    expect(result.refused).toBe(0);
    expect(result.byStatus).toEqual({ "404": PROBE_PATHS.length + 200 });
  });
});

describe("fuzzing dead links (ConcaveHR's not_found_per_minute: 120 a minute → 24 h)", () => {
  const attack = paced(
    pathScan({ count: 300, probes: [], client: "203.0.113.90" }),
    50,
  );

  it("bans the fuzzer at its 120th route-not-found within a minute", async () => {
    const app = await concaveApp();
    const result = await app.run(attack);
    expect(result.byStatus).toEqual({ "404": 120, "403": 180 });
    expect(result.firstRefused).toBe(120);
    expect(app.security?.bans().map((ban) => [ban.id, ban.rule])).toEqual([
      ["ip:203.0.113.90", "counted:not_found_per_minute"],
    ]);
  });

  it("negative control: as shipped (dry run) it is only recorded, and every dead link is answered", async () => {
    const app = await concaveApp({
      policy: { presets: { not_found_per_minute: true } },
    });
    const result = await app.run(attack);
    expect(result.byStatus).toEqual({ "404": 300 });
    expect(app.security?.bans()).toEqual([]);
  });
});

describe("T-L8-1: a honeypot hit and a canary key", () => {
  it("bans on the first honeypot hit", async () => {
    const app = await concaveApp();
    const result = await app.run(
      paced(
        pathScan({
          count: 3,
          probes: ["/admin.php"],
          client: "203.0.113.91",
          userAgent: "Mozilla/5.0",
        }),
        1000,
      ),
    );
    // The honeypot answers exactly as the router's missing page does (a
    // plain 404, no problem body: the scanner cannot tell), and bans.
    expect(result.statuses).toEqual([404, 403, 403, 403]);
    expect(result.answers).toEqual([undefined, "banned", "banned", "banned"]);
    expect(result.firstRefused).toBe(1);
    // The hit passes on to the router (its answer is the disguise) and
    // weighs 10 on the ladder, which bans at once.
    expect(app.fired()).toContain("honeypot:log");
    expect(app.security?.bans().map((ban) => [ban.id, ban.rule])).toEqual([
      ["ip:203.0.113.91", "ladder"],
    ]);
  });

  it("bans the canary key's caller on its first use, with a critical alert", async () => {
    const app = await concaveApp();
    const result = await app.run(
      paced(
        apiKeyAbuse({
          key: "key_canary_backup",
          count: 2,
          path: "/api/v1/employees",
        }),
        1000,
      ),
    );
    expect(result.firstRefused).toBe(0);
    expect(result.byStatus).toEqual({ "403": 2 });
    expect(app.fired()).toContain("canary:backup-key:ban");
    expect(app.warnings.map((warning) => warning.kind)).toContain(
      "canary.used",
    );
  });

  it("negative control: with deception off, the honeypot is a 404 and the canary key is served", async () => {
    const app = await concaveApp({ policy: { deception: {} } });
    const honeypot = await app.run(
      pathScan({
        count: 0,
        probes: ["/admin.php"],
        client: "203.0.113.91",
        userAgent: "Mozilla/5.0",
      }),
    );
    expect(honeypot.byStatus).toEqual({ "404": 1 });
    const canary = await app.run(
      apiKeyAbuse({
        key: "key_canary_backup",
        count: 1,
        path: "/api/v1/employees",
      }),
    );
    expect(canary.byStatus).toEqual({ "200": 1 });
    expect(app.warnings).toEqual([]);
  });
});

describe("T-L3-1: a verified crawler crawls 500 dead links, a published /wp-admin link and a honeypot", () => {
  const paths = [
    ...Array.from({ length: 500 }, (_, i) => `/careers/old-${i}/apply/x`),
    "/wp-admin/",
    "/admin.php",
  ];
  const attack = paced(
    crawl({ crawler: "google", client: GOOGLEBOT_ADDRESS, paths }),
    50,
  );

  it("is never banned, challenged or refused; the probe and the honeypot are logged", async () => {
    const app = await concaveApp();
    const result = await app.run(attack);
    expect(result.refused).toBe(0);
    expect(result.byStatus).toEqual({ "404": 502 });
    expect(app.security?.bans()).toEqual([]);
    const fired = app.fired();
    expect(fired).toContain("probe:wordpress:log");
    expect(fired).toContain("honeypot:log");
    expect(
      app.decisions.every(
        ({ decision }) =>
          decision.action === "allow" || decision.action === "log",
      ),
    ).toBe(true);
    expect(
      app.decisions.some(({ decision }) => decision.crawler?.id === "google"),
    ).toBe(true);
  });

  it("negative control: with the allowance off, the same crawl is banned", async () => {
    const app = await concaveApp({ policy: { crawlers: { mode: "off" } } });
    const result = await app.run(attack);
    expect(result.refused).toBeGreaterThan(0);
    expect(app.security?.bans().map((ban) => ban.id)).toEqual([
      `ip:${GOOGLEBOT_ADDRESS}`,
    ]);
  });
});

describe("T-L3-2: Googlebot's User-Agent from an address outside its ranges", () => {
  const attack = paced(
    spoofedCrawler({
      client: "203.0.113.70",
      paths: ["/", "/pricing", "/careers/engineer"],
    }),
    1000,
  );

  it("is unverified, refused as crawler.spoofed and banned through the ladder", async () => {
    const app = await concaveApp();
    const result = await app.run(attack);
    expect(result.firstRefused).toBe(0);
    expect(result.byStatus).toEqual({ "403": 3 });
    expect(app.fired()).toContain("crawler.spoofed:block");
  });

  it("negative control: with the allowance off nobody looks at the claim, and the pages are served", async () => {
    const result = await (
      await concaveApp({ policy: { crawlers: { mode: "off" } } })
    ).run(attack);
    expect(result.byStatus).toEqual({ "200": 3 });
  });
});
