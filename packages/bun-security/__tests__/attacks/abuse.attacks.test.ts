/**
 * Account and API abuse against ConcaveHR's request path (plan §11.2, §12;
 * layers.md L11.7, L12, L13, §3.3): disposable-address sign-ups (ConcaveHR's
 * first wave), a leaked API key used from many addresses, cross-site posts
 * with the victim's cookies (T-L13-1), and the integration bypassed
 * (T-INT-1). Each with its negative control, where the attack succeeds.
 */
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter, ConfigError } from "@kingsleyweb/bun-common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { createSecurity } from "../../lib/index";
import { installSecurity } from "../../lib/http/index";
import {
  addressRotation,
  apiKeyAbuse,
  crossSitePosts,
  disposableSignups,
  fetchTarget,
  paced,
  pathScan,
  runAttack,
  sequence,
} from "../../lib/testing/index";
import { CONCAVE_POLICY, concaveApp } from "./app";

/** The managed probe set, enforced: what the bypassed app would have refused. */
const SCAN_POLICY = { requestRules: { managed: { mode: "enforce" as const } } };

describe("disposable-address sign-ups (ConcaveHR's first wave, write-up §1)", () => {
  const attack = paced(
    disposableSignups({ path: "/auth/signup", count: 30 }),
    5000,
  );

  it("refuses the first generically, bans the address for 7 days, and creates no account", async () => {
    const app = await concaveApp();
    const result = await app.run(attack);
    expect(result.firstRefused).toBe(0);
    expect(result.answers[0]).toBe("invalid_identifier");
    expect(result.byStatus).toEqual({ "400": 1, "403": 29 });
    expect(app.signups).toEqual([]);
    const [ban] = app.security?.bans() ?? [];
    expect(ban).toMatchObject({
      id: "ip:203.0.113.71",
      rule: "counted:disposable_signup",
    });
    expect(ban.expiresAt! - app.clock.now()).toBeGreaterThan(6 * 86_400_000);
  });

  it("an ordinary address signs up from another client", async () => {
    const app = await concaveApp();
    await app.run(attack);
    const ok = await app.target({
      method: "POST",
      path: "/auth/signup",
      client: "198.51.100.30",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new.hire@gmail.com" }),
    });
    expect(ok.status).toBe(201);
    expect(app.signups).toEqual(["new.hire@gmail.com"]);
  });

  it("negative control: with no engine all 30 accounts are created", async () => {
    const app = await concaveApp({ defences: false });
    const result = await app.run(attack);
    expect(result.byStatus).toEqual({ "201": 30 });
    expect(app.signups).toHaveLength(30);
  });
});

describe("a Tor client on an auth route, and a disposable address: rule.hit apart from pattern.hit (plan §17.19)", () => {
  /** A sign-up from `client` with `email`. */
  const signup = (client: string, email: string) =>
    addressRotation({
      addresses: [client],
      method: "POST",
      path: "/auth/signup",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });

  it("the Tor rule blocks the exit without tripping disposable_signup; a disposable address still trips it", async () => {
    const app = await concaveApp();
    const tor = await app.run(
      paced(signup("192.0.2.9", "someone@gmail.com"), 1000),
    );
    expect(tor.codes).toEqual({ blocked: 1 });
    expect(app.fired()).toContain("rule:tor_exit_nodes:block");
    // Blocked, never banned: the rule's hit is not an identifier's.
    expect(app.security?.bans()).toEqual([]);
    expect(
      (await app.run(paced(signup("192.0.2.9", "x@gmail.com"), 1000, 2000)))
        .codes,
    ).toEqual({ blocked: 1 });

    const disposable = await app.run(
      paced(
        sequence(
          "disposable",
          signup("203.0.113.73", "probe@mailinator.example"),
          signup("203.0.113.73", "real.person@gmail.com"),
        ),
        1000,
        10_000,
      ),
    );
    expect(disposable.answers).toEqual(["invalid_identifier", "banned"]);
    expect(app.security?.bans().map((ban) => [ban.id, ban.rule])).toEqual([
      ["ip:203.0.113.73", "counted:disposable_signup"],
    ]);
  });

  it("negative control: a counted rule on rule.hit is what the Tor rule's hits feed", async () => {
    const app = await concaveApp({
      policy: {
        countedRules: [
          ...(CONCAVE_POLICY.countedRules ?? []),
          {
            id: "rule_hits",
            event: "rule.hit",
            threshold: 1,
            window: "60s",
            duration: "1h",
          },
        ],
      },
    });
    await app.run(paced(signup("192.0.2.9", "someone@gmail.com"), 1000));
    expect(app.security?.bans().map((ban) => [ban.id, ban.rule])).toEqual([
      ["ip:192.0.2.9", "counted:rule_hits"],
    ]);
  });
});

describe("a leaked API key used from 30 addresses (layers.md L12)", () => {
  const attack = paced(
    apiKeyAbuse({
      key: "key_leaked_live",
      count: 30,
      path: "/api/v1/employees",
    }),
    1000,
  );

  it("serves 20 addresses, then bans the key itself; the partner's own key is untouched", async () => {
    const app = await concaveApp();
    const result = await app.run(attack);
    expect(result.firstRefused).toBe(20);
    expect(result.byStatus).toEqual({ "200": 20, "403": 10 });
    expect(
      app.security?.bans().map((ban) => [ban.subject.type, ban.rule]),
    ).toEqual([["apiKey", "apiKey.manyAddresses"]]);
    // The ban names the key's HMAC, never the key.
    expect(JSON.stringify(app.security?.bans())).not.toContain(
      "key_leaked_live",
    );
    const partner = await app.run(
      apiKeyAbuse({
        key: "key_partner_live",
        count: 1,
        path: "/api/v1/employees",
        base: "45.81",
      }),
    );
    expect(partner.byStatus).toEqual({ "200": 1 });
  });

  it("negative control: without API-key watching every address is served", async () => {
    const app = await concaveApp({ policy: { apiKeys: undefined } });
    const result = await app.run(attack);
    expect(result.byStatus).toEqual({ "200": 30 });
  });
});

describe("T-L13-1: cross-site POSTs with the victim's cookies", () => {
  // Socket-free fetch() answers at http://localhost: the app's own origin.
  const attack = crossSitePosts({
    path: "/payroll/transfer",
    site: "http://localhost",
  });

  it("refuses the cross-site one by Fetch Metadata, allows same-site, and falls back to Origin without the header", async () => {
    const app = await concaveApp();
    const result = await app.run(attack);
    // [cross-site, same-origin, Origin only from evil.example, Origin only from itself]
    expect(result.statuses).toEqual([403, 200, 403, 200]);
    expect(result.answers).toEqual(["csrf", undefined, "csrf", undefined]);
  });

  it("negative control: with no engine every forged transfer goes through", async () => {
    const result = await (await concaveApp({ defences: false })).run(attack);
    expect(result.statuses).toEqual([200, 200, 200, 200]);
  });
});

describe("T-INT-1: the integration installed but bypassed", () => {
  /** An app whose first middleware answers everything: the engine behind it never runs. */
  function bypassed() {
    const adapter = new BunHttpAdapter(0, { logger: () => {} });
    adapter.use((_req, res) => res.status(404).send("not found"));
    return adapter;
  }

  it("start-up fails with the self-test error, and the install takes itself back off", async () => {
    const adapter = bypassed();
    const security = createSecurity<BunRequest>({
      policy: SCAN_POLICY,
      logger: () => {},
    });
    const failure = await installSecurity(adapter, security, {
      logger: () => {},
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as Error).message).toContain("self-test");
  });

  it("negative control: an app that ignored the failure would serve the whole scan; the same app with the install first refuses it", async () => {
    // The failure ignored: the scan is answered, as on ConcaveHR's pay-api.
    const adapter = bypassed();
    const security = createSecurity<BunRequest>({
      policy: SCAN_POLICY,
      logger: () => {},
    });
    await installSecurity(adapter, security, { logger: () => {} }).catch(
      () => undefined,
    );
    const scan = paced(pathScan({ count: 20 }), 50);
    const served = await runAttack(scan, fetchTarget(adapter));
    expect(served.refused).toBe(0);
    // Installed first, the same scan is refused from its first request.
    const app = await concaveApp();
    const refused = await app.run(scan);
    expect(refused.firstRefused).toBe(0);
    expect(refused.refused).toBe(refused.sent);
  });
});
