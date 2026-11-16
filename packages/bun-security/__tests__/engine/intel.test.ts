/**
 * IP intelligence in the engine (layers.md L5): `country` and `asn` list
 * entries (L3, early stage, the lists' precedence); `country`, `asn` and
 * `class` conditions (L7); class weights in the bot signals (L10); the
 * address looked up only when the policy needs it; and a policy that needs
 * what the engine cannot know refused at start and on `load()`.
 */
import { ConfigError } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import type { Decision } from "../../lib/engine/decision";
import type { RequestFacts } from "../../lib/engine/facts";
import { createSecurity } from "../../lib/engine/security";
import type { Security } from "../../lib/engine/security";
import type { IntelLookup, IntelRecord } from "../../lib/intel/types";
import { parseAddress } from "../../lib/ip/address";
import { compilePolicy } from "../../lib/policy/compile";
import { SecurityPolicyError } from "../../lib/policy/errors";
import type { SecurityPolicy } from "../../lib/policy/types";
import { facts } from "../helpers";

/** A fake intel over a table, counting lookups. */
function fakeIntel(
  table: Record<
    string,
    Omit<IntelRecord, "classes"> & { classes?: readonly string[] }
  >,
  provides: {
    country?: boolean;
    asn?: boolean;
    classes?: readonly string[];
  } = {},
): IntelLookup & { lookups: number } {
  const fake = {
    lookups: 0,
    lookup(address: Parameters<IntelLookup["lookup"]>[0]): IntelRecord {
      fake.lookups++;
      const text =
        typeof address === "string"
          ? parseAddress(address)?.text
          : address.text;
      const found = text === undefined ? undefined : table[text];
      return { classes: [], ...found };
    },
    provides: () => ({
      country: provides.country ?? true,
      asn: provides.asn ?? true,
      classes: new Set(provides.classes ?? ["tor", "hosting"]),
    }),
  };
  return fake;
}

const TABLE = {
  "203.0.113.10": { country: "KP", asn: 64500, classes: ["tor"] },
  "198.51.100.7": { country: "DE", asn: 64501, classes: ["hosting"] },
};

/** `evaluate()`, synchronously. */
function decide(
  security: Security,
  request: RequestFacts,
  stage?: "early" | "route",
): Decision {
  const decision = security.evaluate(request, stage ? { stage } : {});
  if (decision instanceof Promise) throw new Error("expected synchronous");
  return decision;
}

const from = (client: string, overrides: Partial<RequestFacts> = {}) =>
  facts({ client, ...overrides });

describe("country and ASN list entries (L3)", () => {
  it("block by country and by ASN, early, with the entry's code", () => {
    const security = createSecurity({
      policy: {
        lists: [
          { country: "KP", action: "block", code: "region_blocked" },
          { asn: 64501, action: "block" },
        ],
      },
      intel: fakeIntel(TABLE),
    });
    expect(decide(security, from("203.0.113.10"))).toMatchObject({
      action: "block",
      code: "region_blocked",
    });
    expect(decide(security, from("203.0.113.10")).hits[0]).toMatchObject({
      layer: "L3",
      rule: "country:KP",
    });
    expect(decide(security, from("198.51.100.7")).hits[0]).toMatchObject({
      layer: "L3",
      rule: "asn:64501",
    });
    expect(decide(security, from("192.0.2.1")).action).toBe("allow");
    // Early stage: decided there, not again in the route stage.
    expect(decide(security, from("203.0.113.10"), "early").action).toBe(
      "block",
    );
    expect(decide(security, from("203.0.113.10"), "route").action).toBe(
      "allow",
    );
  });

  it("follow the lists' precedence: a more specific allow (an address) beats a country block only with override", () => {
    const policy = (override: boolean): SecurityPolicy => ({
      lists: [
        { country: "KP", action: "block" },
        { ip: "203.0.113.10", action: "allow", override },
      ],
    });
    expect(
      decide(
        createSecurity({ policy: policy(true), intel: fakeIntel(TABLE) }),
        from("203.0.113.10"),
      ).action,
    ).toBe("allow");
    expect(
      decide(
        createSecurity({ policy: policy(false), intel: fakeIntel(TABLE) }),
        from("203.0.113.10"),
      ).action,
    ).toBe("block");
  });

  it("are explained, and run in dry run as a log", async () => {
    const security = createSecurity({
      policy: { lists: [{ country: "KP", action: "block", mode: "dryRun" }] },
      intel: fakeIntel(TABLE),
    });
    expect(decide(security, from("203.0.113.10")).hits[0]).toMatchObject({
      action: "log",
      wouldHaveBeen: "block",
    });
    const explained = await security.explain(from("203.0.113.10"));
    expect(
      explained.steps.some(
        (step) => step.layer === "L3" && step.rule === "country:KP",
      ),
    ).toBe(true);
  });

  it("are validated", () => {
    for (const entry of [
      { country: "kp", action: "block" },
      { country: "KPX", action: "block" },
      { asn: -1, action: "block" },
      { asn: 1.5, action: "block" },
      { asn: 2 ** 32, action: "block" },
      { country: "KP", asn: 1, action: "block" },
    ]) {
      expect(() => compilePolicy({ lists: [entry as never] })).toThrow(
        SecurityPolicyError,
      );
    }
  });
});

describe("allow on a country entry (the user's ruling, 2026-11-16)", () => {
  /** The issues compiling `entry` raises. */
  function issuesOf(entry: object) {
    try {
      compilePolicy({ lists: [entry as never] });
      return [];
    } catch (error) {
      if (!(error instanceof SecurityPolicyError)) throw error;
      return error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      );
    }
  }

  it("is refused at compile time, with its path", () => {
    const issues = issuesOf({ country: "DE", action: "allow" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toStartWith(
      "lists.0.action: an allow entry for a whole country is refused",
    );
    // Dry run or off does not make it acceptable: the policy is refused as written.
    expect(
      issuesOf({ country: "DE", action: "allow", mode: "dryRun" }),
    ).toHaveLength(1);
  });

  it("negative control: every other action on a country, and allow on an ASN, compile", () => {
    for (const action of ["block", "challenge", "drop"]) {
      expect([action, issuesOf({ country: "DE", action })]).toEqual([
        action,
        [],
      ]);
    }
    expect(issuesOf({ asn: 64500, action: "allow" })).toEqual([]);
    const allowed = createSecurity({
      policy: {
        lists: [
          { asn: 64501, action: "allow" },
          { country: "DE", action: "block" },
        ],
      },
      intel: fakeIntel(TABLE),
    });
    // 198.51.100.7 is DE and AS64501: the ASN allow and the country block share
    // a scope, so the more severe wins, as for any two entries.
    expect(decide(allowed, from("198.51.100.7")).action).toBe("block");
  });
});

describe("country, asn and class conditions (L7)", () => {
  const rule = (when: object, action = "block"): SecurityPolicy => ({
    requestRules: {
      rules: [{ id: "r", when: when as never, action: action as never }],
    },
  });

  it("match on the client's country, ASN and classes", () => {
    const cases: [object, string, boolean][] = [
      [{ country: { equals: "kp" } }, "203.0.113.10", true],
      [{ country: { in: ["DE", "FR"] } }, "198.51.100.7", true],
      [{ country: { equals: "DE" } }, "203.0.113.10", false],
      [{ country: { exists: false } }, "192.0.2.1", true],
      [{ asn: { equals: 64500 } }, "203.0.113.10", true],
      [{ asn: { in: [1, 64501] } }, "198.51.100.7", true],
      [{ asn: { in: [1, 2] } }, "198.51.100.7", false],
      [{ asn: { exists: true } }, "192.0.2.1", false],
      [{ class: { equals: "tor" } }, "203.0.113.10", true],
      [{ class: { equals: "tor" } }, "198.51.100.7", false],
      [{ class: { in: ["tor", "hosting"] } }, "198.51.100.7", true],
      [
        {
          all: [
            { class: { equals: "hosting" } },
            { path: { prefix: "/login" } },
          ],
        },
        "198.51.100.7",
        false,
      ],
      [{ not: { country: { in: ["DE"] } } }, "203.0.113.10", true],
    ];
    for (const [when, client, matches] of cases) {
      const security = createSecurity({
        policy: rule(when),
        intel: fakeIntel(TABLE),
      });
      expect([
        JSON.stringify(when),
        client,
        decide(security, from(client)).action,
      ]).toEqual([JSON.stringify(when), client, matches ? "block" : "allow"]);
    }
  });

  it("run in the early stage", () => {
    const security = createSecurity({
      policy: rule({ class: { equals: "tor" } }),
      intel: fakeIntel(TABLE),
    });
    expect(decide(security, from("203.0.113.10"), "early").action).toBe(
      "block",
    );
    expect(decide(security, from("203.0.113.10"), "route").action).toBe(
      "allow",
    );
  });

  it("are validated", () => {
    for (const when of [
      { asn: { equals: -1 } },
      { asn: { in: [] } },
      { asn: { gt: 3 } },
      { asn: 5 },
      { class: "tor" },
      { country: { equals: 1 } },
    ]) {
      expect(() => compilePolicy(rule(when))).toThrow(SecurityPolicyError);
    }
  });
});

describe("class weights in the bot signals (L10)", () => {
  it("add each class's points to the risk, and challenge at challengeAt", () => {
    const security = createSecurity({
      policy: {
        botSignals: {
          classes: { tor: 3, hosting: 1 },
          challengeAt: 3,
          weights: { noUserAgent: 0 },
        },
      },
      intel: fakeIntel(TABLE),
    });
    const tor = decide(security, from("203.0.113.10"));
    expect(tor.hits[0]?.layer).toBe("L10");
    expect(tor.hits[0]?.reason).toStartWith("bot signals: class:tor (risk 3)");
    expect(tor.action).toBe("block"); // a challenge, falling back without a flow
    const hosting = decide(security, from("198.51.100.7"));
    expect([hosting.action, hosting.risk]).toEqual(["log", 1]);
    expect(() =>
      compilePolicy({ botSignals: { classes: { tor: -1 } } }),
    ).toThrow(SecurityPolicyError);
  });
});

describe("the lookup", () => {
  it("is never made for a policy that needs no intel, and made only for the client otherwise", () => {
    const idle = fakeIntel(TABLE);
    const plain = createSecurity({
      policy: { lists: [{ ip: "192.0.2.0/24", action: "block" }] },
      intel: idle,
    });
    decide(plain, from("203.0.113.10"));
    expect(idle.lookups).toBe(0);
    const busy = fakeIntel(TABLE);
    const security = createSecurity({
      policy: { lists: [{ country: "ZZ", action: "block" }] },
      intel: busy,
    });
    decide(security, from("203.0.113.10"));
    expect(busy.lookups).toBe(1);
  });
});

describe("a policy that needs what the engine cannot know", () => {
  it("is refused without an intel", () => {
    expect(() =>
      createSecurity({
        policy: { lists: [{ country: "KP", action: "block" }] },
      }),
    ).toThrow(/uses country, which need IP intelligence/);
    expect(() =>
      createSecurity({
        policy: {
          requestRules: { rules: [{ id: "r", when: { asn: { equals: 1 } } }] },
        },
      }),
    ).toThrow(ConfigError);
    expect(() =>
      createSecurity({ policy: { botSignals: { classes: { tor: 1 } } } }),
    ).toThrow(ConfigError);
    // Off entries and rules need nothing.
    expect(() =>
      createSecurity({
        policy: { lists: [{ country: "KP", action: "block", mode: "off" }] },
      }),
    ).not.toThrow();
  });

  it("is refused when the intel cannot give it, and on load() too", () => {
    expect(() =>
      createSecurity({
        policy: { lists: [{ country: "KP", action: "block" }] },
        intel: fakeIntel({}, { country: false }),
      }),
    ).toThrow(/no database of the intel gives countries/);
    expect(() =>
      createSecurity({
        policy: { lists: [{ asn: 1, action: "block" }] },
        intel: fakeIntel({}, { asn: false }),
      }),
    ).toThrow(/gives ASNs/);
    expect(() =>
      createSecurity({
        policy: {
          requestRules: {
            rules: [{ id: "r", when: { class: { in: ["tor", "vpn"] } } }],
          },
        },
        intel: fakeIntel({}),
      }),
    ).toThrow(/classes no feed or range of the intel provides: vpn/);
    const security = createSecurity({ policy: {} });
    expect(() =>
      security.load({ lists: [{ country: "KP", action: "block" }] }),
    ).toThrow(ConfigError);
    // The refused policy did not replace the one in force.
    expect(security.policy.source).toEqual({});
  });
});

describe("IP intelligence beside the sensitive endpoints' profile rules (PR-S7)", () => {
  it("a country entry, a class rule and the login profile's limit each decide their own requests", () => {
    const security = createSecurity({
      policy: {
        lists: [{ country: "KP", action: "block" }],
        requestRules: {
          rules: [
            {
              id: "tor-login",
              when: { class: { equals: "tor" } },
              action: "block",
            },
          ],
        },
      },
      intel: fakeIntel({
        ...TABLE,
        "198.51.100.8": { country: "NL", classes: ["tor"] },
      }),
    });
    const login = (client: string) =>
      from(client, {
        method: "POST",
        path: "/login",
        rawPath: "/login",
        profile: "login",
      });
    // L3 decides a listed country before any profile rule.
    expect(decide(security, login("203.0.113.10")).hits[0]).toMatchObject({
      layer: "L3",
      rule: "country:KP",
    });
    // L7's class rule on the profiled route.
    expect(decide(security, login("198.51.100.8")).hits[0]).toMatchObject({
      layer: "L7",
      rule: "rule:tor-login",
    });
    // Neither: the login profile's per-address limit (30 a minute) still counts.
    const plain = login("198.51.100.7");
    const decisions = Array.from({ length: 31 }, () => decide(security, plain));
    expect(decisions[29]?.action).not.toBe("block");
    expect(
      decisions[30]?.hits.some((hit) => hit.rule === "limit:login.ip"),
    ).toBe(true);
  });
});
