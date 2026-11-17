/**
 * Layer L4, bans (layers.md L4): manual bans and unbans, the merge rules
 * (the later expiry wins, "until lifted" beats any date, a manual ban
 * replaces an automatic reason, `ban` beats `challenge`), ranges and IPv6
 * keys, the internal list and service exemptions, the answer (`403`
 * `banned`, `Retry-After` only on request), dry run, and the bans a counted
 * rule wrote lifted when a new policy removes it.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createSecurity } from "../../lib/index";
import type { Decision, RequestFacts, SecurityPolicy } from "../../lib/index";
import { facts, fakeClock } from "../helpers";
import type { FakeClock } from "../helpers";

/** An engine on a fake clock, quiet, ladder off unless the policy sets one. */
function engine(policy: SecurityPolicy = {}, clock: FakeClock = fakeClock()) {
  return createSecurity({
    policy: { ladder: false, ...policy },
    now: clock.now,
    logger: () => {},
  });
}
type Engine = ReturnType<typeof engine>;

/** `signal()`, required to be synchronous. */
function signalNow(security: Engine, request: RequestFacts, event: string) {
  const hits = security.signal(request, event);
  if (hits instanceof Promise) throw new Error("expected synchronous");
  return hits;
}

/** `evaluate()`, synchronously. */
function decide(security: Engine, request: RequestFacts = facts()): Decision {
  const decision = security.evaluate(request);
  if (decision instanceof Promise) throw new Error("expected synchronous");
  return decision;
}

describe("manual bans", () => {
  it("bans an address for 24 h by default, answering 403 banned with no Retry-After", () => {
    const clock = fakeClock();
    const security = engine({}, clock);
    const ban = security.ban({
      ip: "203.0.113.10",
      reason: "scanner",
      by: "ops",
    });
    expect(ban).toMatchObject({
      id: "ip:203.0.113.10",
      subject: { type: "ip", value: "203.0.113.10" },
      action: "ban",
      reason: "scanner",
      source: "manual",
      createdBy: "ops",
      createdAt: clock.now(),
      expiresAt: clock.now() + 86_400_000,
      count: 1,
    });
    const refused = decide(security);
    expect(refused).toMatchObject({
      action: "ban",
      status: 403,
      code: "banned",
    });
    expect(refused.retryAfter).toBeUndefined();
    expect(refused.hits[0]?.rule).toBe("ban:ip:203.0.113.10");
    expect(decide(security, facts({ client: "203.0.113.11" })).action).toBe(
      "allow",
    );
    clock.advance(86_400_000);
    expect(decide(security).action).toBe("allow");
    expect(security.bans()).toEqual([]);
  });

  it("bans an IPv6 client by its /64, a range through the trie, a user and an API key", () => {
    const security = engine();
    expect(security.ban({ ip: "2001:db8:1:2::5" }).id).toBe(
      "ip:2001:db8:1:2::/64",
    );
    expect(
      decide(security, facts({ client: "2001:db8:1:2:ffff::1" })).action,
    ).toBe("ban");
    expect(security.ban({ ip: "198.51.100.0/24" }).id).toBe(
      "cidr:198.51.100.0/24",
    );
    expect(
      decide(security, facts({ client: "198.51.100.200" })).hits[0]?.rule,
    ).toBe("ban:cidr:198.51.100.0/24");
    security.ban({ user: "mallory" });
    security.ban({ apiKey: "key_9" });
    expect(
      decide(
        security,
        facts({ client: "192.0.2.1", identity: { user: "mallory" } }),
      ).action,
    ).toBe("ban");
    expect(
      decide(
        security,
        facts({ client: "192.0.2.1", identity: { apiKey: "key_9" } }),
      ).action,
    ).toBe("ban");
    expect(
      decide(
        security,
        facts({ client: "192.0.2.1", identity: { user: "alice" } }),
      ).action,
    ).toBe("allow");
  });

  it("challenge is a block until challenge providers exist; Retry-After and the code follow the policy", () => {
    const clock = fakeClock();
    const security = engine(
      { bans: { retryAfter: true, code: "go_away" } },
      clock,
    );
    security.ban({ ip: "203.0.113.10", action: "challenge", duration: "10m" });
    clock.advance(60_000);
    expect(decide(security)).toMatchObject({
      action: "block",
      status: 403,
      code: "go_away",
      retryAfter: 540,
    });
    security.ban({ user: "u", code: "custom" });
    expect(
      decide(security, facts({ client: "192.0.2.1", identity: { user: "u" } }))
        .code,
    ).toBe("custom");
  });

  it("refuses bad input", () => {
    const security = engine();
    for (const input of [
      {},
      { ip: "1.2.3.4", user: "x" },
      { ip: "not-an-ip" },
      { user: "" },
      { ip: "1.2.3.4", duration: 60 },
      { ip: "1.2.3.4", duration: "soon" },
      { ip: "1.2.3.4", action: "drop" },
    ]) {
      expect(() => security.ban(input as never)).toThrow(TypeError);
    }
  });
});

describe("merge rules", () => {
  it("the later expiry wins, and null (until lifted) beats any date", () => {
    const clock = fakeClock();
    const security = engine({}, clock);
    const start = clock.now();
    security.ban({ ip: "203.0.113.10", duration: "2h" });
    expect(security.ban({ ip: "203.0.113.10", duration: "1h" })).toMatchObject({
      expiresAt: start + 7_200_000,
      count: 2,
    });
    expect(security.ban({ ip: "203.0.113.10", duration: "3h" }).expiresAt).toBe(
      start + 10_800_000,
    );
    expect(
      security.ban({ ip: "203.0.113.10", duration: null }).expiresAt,
    ).toBeNull();
    expect(
      security.ban({ ip: "203.0.113.10", duration: "1h" }).expiresAt,
    ).toBeNull();
  });

  it("ban beats challenge, and a manual ban replaces an automatic reason but not the reverse", () => {
    const security = engine({
      countedRules: [
        {
          id: "probe",
          event: "pattern.hit",
          threshold: 1,
          window: "1m",
          duration: "1h",
        },
      ],
    });
    signalNow(security, facts(), "pattern.hit");
    const auto = security.bans()[0];
    expect(auto).toMatchObject({ source: "auto", rule: "counted:probe" });
    const manual = security.ban({
      ip: "203.0.113.10",
      reason: "confirmed",
      by: "ops",
      action: "challenge",
    });
    expect(manual).toMatchObject({
      source: "manual",
      reason: "confirmed",
      createdBy: "ops",
      action: "ban",
      count: 2,
    });
    signalNow(security, facts(), "pattern.hit");
    expect(security.bans()[0]).toMatchObject({
      source: "manual",
      reason: "confirmed",
      count: 3,
    });
  });
});

describe("unban", () => {
  it("lifts a ban, returning the lifted record, and is a no-op for none", () => {
    const clock = fakeClock();
    const security = engine({}, clock);
    security.ban({ ip: "203.0.113.10" });
    clock.advance(1000);
    expect(security.unban("ip:203.0.113.10", { by: "ops" })).toMatchObject({
      id: "ip:203.0.113.10",
      liftedAt: clock.now(),
      liftedBy: "ops",
    });
    expect(decide(security).action).toBe("allow");
    expect(security.unban("ip:203.0.113.10")).toBeUndefined();
    expect(security.unban("cidr:10.0.0.0/8")).toBeUndefined();
  });

  it("lifting an automatic address ban clears the address's score", () => {
    const security = createSecurity({
      policy: {
        ladder: {
          weights: { "pattern.hit": 4 },
          steps: [
            { score: 10, action: "ban" },
            { score: 100, action: "challenge" },
          ],
        },
      },
      logger: () => {},
    });
    for (let i = 0; i < 3; i++) signalNow(security, facts(), "pattern.hit");
    expect(security.bans()[0]).toMatchObject({ rule: "ladder" });
    signalNow(security, facts(), "pattern.hit"); // score 4 after the reset
    security.unban("ip:203.0.113.10");
    // Cleared: two more hits (8) stay under 10.
    signalNow(security, facts(), "pattern.hit");
    signalNow(security, facts(), "pattern.hit");
    expect(security.bans()).toEqual([]);
  });
});

describe("who bans refuse", () => {
  it("an address ban never refuses an internal client; a user ban does", () => {
    const security = engine();
    security.ban({ ip: "10.0.0.0/8" });
    security.ban({ ip: "10.1.2.3" });
    expect(decide(security, facts({ client: "10.1.2.3" })).action).toBe(
      "allow",
    );
    security.ban({ user: "eve" });
    expect(
      decide(security, facts({ client: "10.1.2.3", identity: { user: "eve" } }))
        .action,
    ).toBe("ban");
  });

  it("an allow entry is never refused by a ban", () => {
    const security = engine({
      lists: [{ ip: "198.51.100.7", action: "allow" }],
    });
    security.ban({ ip: "198.51.100.7" });
    expect(decide(security, facts({ client: "198.51.100.7" })).action).toBe(
      "allow",
    );
  });

  it("a verified service exempt from bans is refused only by bans of counted rules that apply to services", () => {
    const token = "svc-token";
    const security = engine({
      serviceIdentity: {
        services: [
          {
            id: "pay-api",
            verifier: `sha256:${createHash("sha256").update(token).digest("hex")}`,
            forwardsClientIp: true,
          },
        ],
      },
      countedRules: [
        {
          id: "strict",
          event: "auth.failure",
          threshold: 1,
          window: "1m",
          duration: "1h",
          appliesToServices: true,
        },
      ],
    });
    const via = facts({
      client: "10.4.0.2",
      headers: {
        "x-service-token": token,
        "x-service-client-ip": "203.0.113.66",
      },
    });
    security.ban({ ip: "203.0.113.66" });
    expect(decide(security, via).action).toBe("allow");
    // (A manual ban absorbs a later automatic one, so lift it first.)
    security.unban("ip:203.0.113.66");
    signalNow(security, via, "auth.failure");
    expect(decide(security, via).hits.map((hit) => hit.rule)).toEqual([
      "service:pay-api",
      "ban:ip:203.0.113.66",
    ]);
  });

  it("bans in dry run only log, and a dry-run policy too", () => {
    for (const policy of [
      { bans: { mode: "dryRun" as const } },
      { mode: "dryRun" as const },
    ]) {
      const security = engine(policy);
      security.ban({ ip: "203.0.113.10" });
      const logged = decide(security);
      expect(logged.action).toBe("log");
      expect(logged.hits.at(-1)).toMatchObject({
        rule: "ban:ip:203.0.113.10",
        wouldHaveBeen: "ban",
      });
    }
  });

  it("a new policy that removes or turns off a counted rule lifts its bans, and keeps manual ones", () => {
    const rule = {
      id: "probe",
      event: "pattern.hit",
      threshold: 1,
      window: "1m",
      duration: null,
    };
    const security = engine({ countedRules: [rule] });
    signalNow(security, facts(), "pattern.hit");
    const kept = security.ban({ user: "kept" });
    expect(security.bans()).toHaveLength(2);
    security.load({ ladder: false, countedRules: [rule] });
    expect(security.bans()).toHaveLength(2);
    security.load({
      ladder: false,
      countedRules: [{ ...rule, mode: "dryRun" }],
    });
    expect(security.bans().map((ban) => ban.id)).toEqual([kept.id]);
  });
});

describe("explain", () => {
  it("names the ban that refuses and writes nothing", () => {
    const security = engine();
    security.ban({ ip: "203.0.113.10" });
    const explained = security.explain(facts());
    if (explained instanceof Promise) throw new Error("expected synchronous");
    expect(explained.decision).toEqual(decide(security));
    expect(
      explained.steps.some(
        (step) => step.check === "ban" && step.rule === "ban:ip:203.0.113.10",
      ),
    ).toBe(true);
  });
});
