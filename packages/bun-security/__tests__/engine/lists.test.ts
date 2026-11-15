/**
 * Layer L3 through the engine: matching, precedence, the `internal` list,
 * expiry, path scopes, dry run and the policy's mode (layers.md L3, L3.1,
 * §0.1, §0.4).
 */
import { describe, expect, it } from "bun:test";
import { createSecurity } from "../../lib/index";
import type {
  Decision,
  ListEntry,
  RequestFacts,
  SecurityPolicy,
} from "../../lib/index";
import { facts, fakeClock } from "../helpers";

/** Evaluates `request` under `policy`, synchronously. */
function decide(
  policy: SecurityPolicy,
  request: RequestFacts = facts(),
  now?: () => number,
): Decision {
  const security = createSecurity({ policy, ...(now ? { now } : {}) });
  const decision = security.evaluate(request);
  if (decision instanceof Promise)
    throw new Error("expected a synchronous decision");
  return decision;
}

/** A policy holding `lists`. */
const withLists = (...lists: ListEntry[]): SecurityPolicy => ({ lists });

describe("matching", () => {
  it("allows a request no entry matches, with no hits", () => {
    const decision = decide(
      withLists({ ip: "198.51.100.0/24", action: "block" }),
    );
    expect(decision).toEqual({
      action: "allow",
      hits: [],
      tags: [],
      risk: 0,
      subject: { address: "203.0.113.10", ip: "203.0.113.10" },
    });
  });

  it("blocks by range, answering 403 with the default code", () => {
    const decision = decide(
      withLists({ ip: "203.0.113.0/24", action: "block" }),
    );
    expect(decision.action).toBe("block");
    expect(decision.status).toBe(403);
    expect(decision.code).toBe("blocked");
    expect(decision.risk).toBe(1);
    expect(decision.hits).toEqual([
      {
        layer: "L3",
        rule: "ip:203.0.113.0/24",
        action: "block",
        reason: "block list",
      },
    ]);
  });

  it("uses the entry's id and code", () => {
    const decision = decide(
      withLists({
        id: "scanners",
        ip: "203.0.113.10",
        action: "block",
        code: "denied",
      }),
    );
    expect(decision.hits[0]?.rule).toBe("scanners");
    expect(decision.code).toBe("denied");
  });

  it("drops: no status, no code", () => {
    const decision = decide(withLists({ ip: "203.0.113.10", action: "drop" }));
    expect(decision.action).toBe("drop");
    expect(decision.status).toBeUndefined();
  });

  it("falls a challenge back to block while no challenge provider exists", () => {
    const decision = decide(
      withLists({ ip: "203.0.113.10", action: "challenge" }),
    );
    expect(decision.action).toBe("block");
    expect(decision.hits[0]?.reason).toContain("no challenge provider");
  });

  it("matches users and API key ids from identify()", () => {
    const policy = withLists(
      { user: "u_1", action: "block" },
      { apiKey: "key_9", action: "drop" },
    );
    expect(decide(policy, facts({ identity: { user: "u_1" } })).action).toBe(
      "block",
    );
    expect(
      decide(policy, facts({ identity: { apiKey: "key_9" } })).action,
    ).toBe("drop");
    expect(decide(policy, facts({ identity: { user: "u_2" } })).action).toBe(
      "allow",
    );
  });

  it("T-L2-2: an IPv4 range matches a client reported as ::ffff:a.b.c.d", () => {
    const decision = decide(
      withLists({ ip: "203.0.113.0/24", action: "block" }),
      facts({ client: "::ffff:203.0.113.5" }),
    );
    expect(decision.action).toBe("block");
    expect(decision.subject.address).toBe("203.0.113.5");
  });

  it("T-L2-3: a /64 entry catches every address an IPv6 client rotates through", () => {
    const policy = withLists({ ip: "2001:db8:1:2::/64", action: "block" });
    for (const client of [
      "2001:db8:1:2::1",
      "2001:db8:1:2:ffff:ffff:ffff:fffe",
    ]) {
      expect(decide(policy, facts({ client })).action).toBe("block");
    }
    expect(decide(policy, facts({ client: "2001:db8:1:3::1" })).action).toBe(
      "allow",
    );
  });
});

describe("precedence", () => {
  it("within a scope the most severe wins over a plain allow", () => {
    const decision = decide(
      withLists(
        { ip: "203.0.113.0/24", action: "allow" },
        { ip: "203.0.113.10", action: "block" },
      ),
    );
    expect(decision.action).toBe("block");
  });

  it("within a scope an override allow wins", () => {
    const decision = decide(
      withLists(
        { ip: "203.0.113.0/24", action: "allow", override: true },
        { ip: "203.0.113.10", action: "drop" },
      ),
    );
    expect(decision.action).toBe("allow");
    expect(decision.hits).toEqual([
      {
        layer: "L3",
        rule: "ip:203.0.113.0/24",
        action: "allow",
        reason: "allow list",
      },
    ]);
  });

  it("a more specific scope wins: route > service > group > global", () => {
    const global: ListEntry = {
      id: "g",
      ip: "203.0.113.0/24",
      action: "block",
      scope: "global",
    };
    const group: ListEntry = {
      id: "gr",
      ip: "203.0.113.0/24",
      action: "allow",
      scope: "group",
    };
    const service: ListEntry = { id: "s", ip: "203.0.113.10", action: "block" };
    const route: ListEntry = {
      id: "r",
      ip: "203.0.113.0/24",
      action: "allow",
      paths: ["/healthz"],
    };
    expect(decide(withLists(global, group)).hits[0]?.rule).toBe("gr");
    expect(decide(withLists(global, group, service)).hits[0]?.rule).toBe("s");
    expect(
      decide(
        withLists(global, group, service, route),
        facts({ path: "/healthz" }),
      ).hits[0]?.rule,
    ).toBe("r");
    expect(
      decide(
        withLists(global, group, service, route),
        facts({ path: "/other" }),
      ).hits[0]?.rule,
    ).toBe("s");
  });

  it("a locked entry beats every unlocked one, whatever its scope", () => {
    const locked: ListEntry = {
      id: "locked",
      ip: "203.0.113.0/24",
      action: "block",
      scope: "global",
      locked: true,
    };
    const allow: ListEntry = {
      id: "allow",
      ip: "203.0.113.10",
      action: "allow",
      override: true,
      paths: ["/"],
    };
    expect(decide(withLists(locked, allow)).hits[0]?.rule).toBe("locked");
  });
});

describe("the internal list (layers.md L3.1)", () => {
  const block: ListEntry = { ip: "10.0.0.0/8", action: "block" };

  it("is on by default and never blocked by a list entry", () => {
    const decision = decide(withLists(block), facts({ client: "10.1.2.3" }));
    expect(decision.action).toBe("allow");
    expect(decision.hits).toEqual([
      {
        layer: "L3",
        rule: "internal:10.0.0.0/8",
        action: "allow",
        reason: "internal list",
      },
    ]);
  });

  it("covers CGNAT, link-local, IPv6 loopback, ULA and link-local", () => {
    for (const client of [
      "100.64.0.1",
      "169.254.1.1",
      "::1",
      "fd12::1",
      "fe80::1",
      "::ffff:192.168.0.1",
    ]) {
      expect(decide({}, facts({ client })).hits[0]?.reason).toBe(
        "internal list",
      );
    }
  });

  it("protects addresses only: a user or API-key block still applies to an internal client", () => {
    const policy = withLists(
      block,
      { user: "mallory", action: "block" },
      { apiKey: "k", action: "drop" },
    );
    expect(
      decide(
        policy,
        facts({ client: "10.1.2.3", identity: { user: "mallory" } }),
      ).action,
    ).toBe("block");
    expect(
      decide(policy, facts({ client: "10.1.2.3", identity: { apiKey: "k" } }))
        .action,
    ).toBe("drop");
    expect(
      decide(policy, facts({ client: "10.1.2.3", identity: { user: "alice" } }))
        .action,
    ).toBe("allow");
    // A user allow does not undo the internal list either.
    expect(
      decide(
        withLists(block, { user: "alice", action: "allow" }),
        facts({ client: "10.1.2.3", identity: { user: "alice" } }),
      ).hits[0]?.rule,
    ).toBe("internal:10.0.0.0/8");
  });

  it("can be narrowed, or turned off", () => {
    expect(
      decide(
        { ...withLists(block), internal: { ranges: ["192.168.0.0/16"] } },
        facts({ client: "10.1.2.3" }),
      ).action,
    ).toBe("block");
    expect(
      decide(
        { ...withLists(block), internal: false },
        facts({ client: "10.1.2.3" }),
      ).action,
    ).toBe("block");
  });
});

describe("expiry and paths", () => {
  it("skips an expired entry, lazily at read time", () => {
    const clock = fakeClock(Date.parse("2026-11-30T23:59:59Z"));
    const security = createSecurity({
      policy: withLists({
        ip: "203.0.113.10",
        action: "block",
        expiresAt: "2026-12-01T00:00:00Z",
      }),
      now: clock.now,
    });
    expect((security.evaluate(facts()) as Decision).action).toBe("block");
    clock.advance(1000);
    expect((security.evaluate(facts()) as Decision).action).toBe("allow");
  });

  it("matches paths on whole segments", () => {
    const policy = withLists({
      ip: "203.0.113.10",
      action: "block",
      paths: ["/admin/"],
    });
    expect(decide(policy, facts({ path: "/admin" })).action).toBe("block");
    expect(decide(policy, facts({ path: "/admin/users" })).action).toBe(
      "block",
    );
    expect(decide(policy, facts({ path: "/administrator" })).action).toBe(
      "allow",
    );
  });
});

describe("dry run (layers.md §0.4)", () => {
  it("a dry-run entry records log with wouldHaveBeen and lets the request through", () => {
    const decision = decide(
      withLists({ ip: "203.0.113.10", action: "block", mode: "dryRun" }),
    );
    expect(decision.action).toBe("log");
    expect(decision.status).toBeUndefined();
    expect(decision.hits).toEqual([
      {
        layer: "L3",
        rule: "ip:203.0.113.10/32",
        action: "log",
        wouldHaveBeen: "block",
        reason: "dry run",
      },
    ]);
  });

  it("records nothing when the dry-run entry would not change the outcome", () => {
    const decision = decide(
      withLists(
        { id: "real", ip: "203.0.113.10", action: "drop" },
        { id: "dry", ip: "203.0.113.0/24", action: "block", mode: "dryRun" },
      ),
    );
    expect(decision.action).toBe("drop");
    expect(decision.hits.map((hit) => hit.rule)).toEqual(["real"]);
  });

  it("a dry-run allow that would have lifted a block is recorded", () => {
    const decision = decide(
      withLists(
        { id: "block", ip: "203.0.113.10", action: "block" },
        {
          id: "allow",
          ip: "203.0.113.0/24",
          action: "allow",
          override: true,
          mode: "dryRun",
        },
      ),
    );
    expect(decision.action).toBe("block");
    expect(decision.hits[1]).toEqual({
      layer: "L3",
      rule: "allow",
      action: "log",
      wouldHaveBeen: "allow",
      reason: "dry run",
    });
  });

  it("a dry-run policy makes every entry dry", () => {
    const decision = decide({
      ...withLists({ ip: "203.0.113.10", action: "drop" }),
      mode: "dryRun",
    });
    expect(decision.action).toBe("log");
    expect(decision.hits[0]?.wouldHaveBeen).toBe("drop");
  });

  it("an off policy allows everything and records nothing", () => {
    const decision = decide({
      ...withLists({ ip: "203.0.113.10", action: "drop" }),
      mode: "off",
    });
    expect(decision.action).toBe("allow");
    expect(decision.hits).toEqual([]);
    expect(decision.subject.ip).toBe("203.0.113.10");
  });

  it("negative control: the same entry enforced refuses", () => {
    expect(
      decide(withLists({ ip: "203.0.113.10", action: "block" })).action,
    ).toBe("block");
  });
});

describe("load()", () => {
  it("swaps the policy at once, and keeps the old one when the new is refused", () => {
    const security = createSecurity({ policy: {} });
    expect((security.evaluate(facts()) as Decision).action).toBe("allow");
    security.load(withLists({ ip: "203.0.113.10", action: "block" }));
    expect((security.evaluate(facts()) as Decision).action).toBe("block");
    expect(() =>
      security.load({ lists: [{ ip: "nope", action: "block" }] }),
    ).toThrow("security policy refused");
    expect((security.evaluate(facts()) as Decision).action).toBe("block");
    expect(security.policy.listEntries).toBe(1);
  });

  it("refuses an object shaped like a compiled policy that compilePolicy did not make", () => {
    const security = createSecurity({ policy: {} });
    const forged = { ...security.policy };
    expect(() => security.load(forged as never)).toThrow(
      "security policy refused",
    );
  });
});

describe("close()", () => {
  it("makes evaluate and explain throw", () => {
    const security = createSecurity({ policy: {} });
    security.close();
    expect(security.closed).toBe(true);
    expect(() => security.evaluate(facts())).toThrow("closed");
    expect(() => security.explain(facts())).toThrow("closed");
  });
});

describe("onDecision", () => {
  it("is called with every evaluate() decision, never explain()'s, and its errors are swallowed", () => {
    const seen: string[] = [];
    const security = createSecurity({
      policy: withLists({ ip: "203.0.113.10", action: "block" }),
      logger: () => {},
      onDecision: (decision, request) => {
        seen.push(`${decision.action} ${request.client}`);
        throw new Error("hook bug");
      },
    });
    expect((security.evaluate(facts()) as Decision).action).toBe("block");
    void security.explain(facts());
    expect(seen).toEqual(["block 203.0.113.10"]);
  });
});
