/**
 * Every `challenge` the engine can reach (layers.md L10.2), with and
 * without a challenge flow: an L3 list entry, a counted rule's trip, the
 * ladder's 15-minute step, a ban made with `action: "challenge"`, an L7
 * request rule, and the bot signals' `challengeAt`. With a flow each is a
 * `challenge` (403, `challenge_required`); a client holding a valid
 * clearance passes it (logged), never a block or a ban; without a flow
 * each falls back to a `block`, as before PR-S9. Each counts in its own
 * stage.
 */
import { describe, expect, it } from "bun:test";
import { challenges } from "../../lib/challenge/flow";
import type { ChallengeFlow } from "../../lib/challenge/flow";
import type { ChallengeProvider } from "../../lib/challenge/types";
import type { Decision, SecurityLayer } from "../../lib/engine/decision";
import type { RequestFacts } from "../../lib/engine/facts";
import { createSecurity } from "../../lib/engine/security";
import type { Security } from "../../lib/engine/security";
import type { SecurityPolicy } from "../../lib/policy/types";
import { facts, fakeClock } from "../helpers";
import type { FakeClock } from "../helpers";

const FALLBACK =
  "challenge: no challenge provider configured, fell back to block";

/** A provider whose answers are never asked for here. */
const PROVIDER: ChallengeProvider = {
  id: "fake",
  field: "answer",
  issue: () => ({ provider: "fake", field: "answer", html: "" }),
  verify: () => ({ ok: true }),
};

/** A flow whose clearance is decided by a header the test sets (the real tokens are covered by flow.test.ts). */
function stubFlow(): ChallengeFlow & { asked: number } {
  const real = challenges({ provider: PROVIDER, secret: "s".repeat(32) });
  const flow = {
    ...real,
    asked: 0,
    cleared: (request: RequestFacts) => {
      flow.asked++;
      return request.headers["x-test-cleared"] === "yes";
    },
  };
  return flow;
}

/** An engine on a still clock, with or without a flow. */
function engine(
  policy: SecurityPolicy,
  flow: ChallengeFlow | undefined,
  clock: FakeClock = fakeClock(),
): Security {
  return createSecurity({
    policy,
    now: clock.now,
    logger: () => {},
    ...(flow === undefined ? {} : { challenge: flow }),
  });
}

/** `evaluate()`, synchronously. */
function decide(
  security: Security,
  request: RequestFacts = facts(),
  stage?: "early" | "route",
): Decision {
  const decision = security.evaluate(request, stage ? { stage } : {});
  if (decision instanceof Promise) throw new Error("expected synchronous");
  return decision;
}

/** `signal()`, synchronously. */
function signal(security: Security, event: string, request = facts()) {
  const hits = security.signal(request, event);
  if (hits instanceof Promise) throw new Error("expected synchronous");
  return hits;
}

const CLEARED = facts({ headers: { "x-test-cleared": "yes" } });

/** Each challenge source: a policy and how to bring the client to it. */
const SOURCES: {
  name: string;
  layer: SecurityLayer;
  policy: SecurityPolicy;
  provoke?: (security: Security) => void;
  request?: RequestFacts;
}[] = [
  {
    name: "an L3 list entry",
    layer: "L3",
    policy: { lists: [{ ip: "203.0.113.0/24", action: "challenge" }] },
  },
  {
    name: "a counted rule's trip",
    layer: "L4",
    policy: {
      countedRules: [
        {
          id: "signup",
          event: "signup",
          threshold: 2,
          window: "1h",
          duration: "15m",
          action: "challenge",
        },
      ],
    },
    provoke: (security) => {
      signal(security, "signup");
      signal(security, "signup");
    },
  },
  {
    name: "the ladder's 15-minute step",
    layer: "L4",
    policy: { ladder: { weights: { probe: 3 } } },
    provoke: (security) => {
      signal(security, "probe");
    },
  },
  {
    name: "a ban made with action challenge",
    layer: "L4",
    policy: {},
    provoke: (security) => {
      security.ban({
        ip: "203.0.113.10",
        action: "challenge",
        duration: "15m",
      });
    },
  },
  {
    name: "an L7 request rule",
    layer: "L7",
    policy: {
      requestRules: {
        rules: [
          { id: "x", when: { path: { equals: "/" } }, action: "challenge" },
        ],
      },
    },
  },
  {
    name: "the bot signals' challengeAt",
    layer: "L10",
    policy: { botSignals: { challengeAt: 1 } },
    request: facts({ headers: { "user-agent": "curl/8.5.0" } }),
  },
];

describe.each(SOURCES)(
  "a challenge from $name",
  ({ layer, policy, provoke, request }) => {
    it("challenges with a flow: 403 challenge_required, the hit's action challenge", () => {
      const flow = stubFlow();
      const security = engine(policy, flow);
      provoke?.(security);
      flow.asked = 0;
      const decision = decide(security, request);
      expect(decision).toMatchObject({
        action: "challenge",
        status: 403,
        code: "challenge_required",
      });
      const hit = decision.hits.find((h) => h.action === "challenge");
      expect(hit?.layer).toBe(layer);
      expect(hit?.reason ?? "").not.toContain(FALLBACK);
      expect(flow.asked).toBe(1);
    });

    it("lets a client with a valid clearance through, logged", () => {
      const flow = stubFlow();
      const security = engine(policy, flow);
      provoke?.(security);
      const cleared =
        request === undefined
          ? CLEARED
          : {
              ...request,
              headers: { ...request.headers, "x-test-cleared": "yes" },
            };
      const decision = decide(security, cleared);
      expect(decision.action).toBe("log");
      expect(decision.status).toBeUndefined();
      const hit = decision.hits.find(
        (h) => h.layer === layer && h.action === "log",
      );
      expect(hit?.reason).toContain(
        "challenge passed: the client holds a valid clearance",
      );
    });

    it("falls back to a block without a flow (negative control: the pre-S9 behaviour)", () => {
      const security = engine(policy, undefined);
      provoke?.(security);
      const decision = decide(security, request);
      expect(decision.action).toBe("block");
      expect(decision.hits.find((h) => h.action === "block")?.reason).toContain(
        FALLBACK,
      );
    });
  },
);

describe("challenges and the rest of the engine", () => {
  it("never lets a clearance past a block or a ban", () => {
    const flow = stubFlow();
    const blocked = engine(
      { lists: [{ ip: "203.0.113.0/24", action: "block" }] },
      flow,
    );
    expect(decide(blocked, CLEARED).action).toBe("block");
    const banned = engine({}, flow);
    banned.ban({ ip: "203.0.113.10", duration: "1h" });
    expect(decide(banned, CLEARED).action).toBe("ban");
    // Asked only when a challenge is hit: never for a block or a ban.
    expect(flow.asked).toBe(0);
  });

  it("never asks the flow for a request that hits no challenge", () => {
    const flow = stubFlow();
    const security = engine(
      { lists: [{ ip: "198.51.100.0/24", action: "challenge" }] },
      flow,
    );
    expect(decide(security).action).toBe("allow");
    expect(flow.asked).toBe(0);
  });

  it("asks the flow once for a request that hits several challenges", () => {
    const flow = stubFlow();
    const security = engine(
      {
        lists: [{ ip: "203.0.113.0/24", action: "challenge" }],
        requestRules: {
          rules: [
            { id: "x", when: { path: { equals: "/" } }, action: "challenge" },
          ],
        },
      },
      flow,
    );
    security.ban({ ip: "203.0.113.10", action: "challenge", duration: "1h" });
    const decision = decide(security);
    expect(decision.action).toBe("challenge");
    expect(flow.asked).toBe(1);
  });

  it("lets a ban outrank a challenge in the same decision", () => {
    const flow = stubFlow();
    const security = engine(
      {
        requestRules: {
          rules: [
            { id: "c", when: { path: { equals: "/" } }, action: "challenge" },
            {
              id: "b",
              when: { path: { equals: "/" } },
              action: "ban",
              duration: "1h",
            },
          ],
        },
      },
      flow,
    );
    expect(decide(security, CLEARED).action).toBe("ban");
  });

  it("records a dry-run challenge as what it would have done: challenge with a flow, block without", () => {
    const policy: SecurityPolicy = {
      requestRules: {
        rules: [
          {
            id: "x",
            when: { path: { equals: "/" } },
            action: "challenge",
            mode: "dryRun",
          },
        ],
      },
    };
    const withFlow = decide(engine(policy, stubFlow()));
    expect([withFlow.action, withFlow.hits[0]?.wouldHaveBeen]).toEqual([
      "log",
      "challenge",
    ]);
    const without = decide(engine(policy, undefined));
    expect([without.action, without.hits[0]?.wouldHaveBeen]).toEqual([
      "log",
      "block",
    ]);
  });

  it("challenges in the right stage: an address entry early, a user entry in the route stage", () => {
    const flow = stubFlow();
    const security = engine(
      {
        lists: [
          { ip: "203.0.113.0/24", action: "challenge" },
          { user: "u_1", action: "challenge" },
        ],
      },
      flow,
    );
    const early = decide(security, facts(), "early");
    expect(early.hits.map((h) => [h.layer, h.action])).toEqual([
      ["L3", "challenge"],
    ]);
    const other = facts({ client: "198.51.100.4", identity: { user: "u_1" } });
    expect(decide(security, other, "early").action).toBe("allow");
    expect(decide(security, other, "route").action).toBe("challenge");
  });

  it("explains a challenge without counting anything", async () => {
    const flow = stubFlow();
    const security = engine(
      { lists: [{ ip: "203.0.113.0/24", action: "challenge" }] },
      flow,
    );
    const explained = await security.explain(facts());
    expect(explained.decision.action).toBe("challenge");
  });

  it("exposes its flow, or undefined", () => {
    const flow = stubFlow();
    expect(engine({}, flow).challenge).toBe(flow);
    expect(engine({}, undefined).challenge).toBeUndefined();
  });

  it("challenges before it bans: T-L10-1, ConcaveHR's signups_per_ip (a challenge, then a ban on the ladder)", () => {
    const clock = fakeClock();
    const flow = stubFlow();
    const security = engine(
      {
        countedRules: [
          {
            id: "signups",
            event: "signup",
            threshold: 5,
            window: "24h",
            duration: "15m",
            action: "challenge",
          },
        ],
        ladder: { weights: { "challenge.failed": 1, probe: 1 } },
      },
      flow,
      clock,
    );
    for (let i = 0; i < 5; i++) signal(security, "signup");
    expect(decide(security).action).toBe("challenge");
    // A human solves it and goes on; a bot keeps failing and climbs the ladder.
    expect(decide(security, CLEARED).action).toBe("log");
    for (let i = 0; i < 10; i++) signal(security, "challenge.failed");
    const banned = decide(security, CLEARED);
    expect(banned.action).toBe("ban");
  });
});

describe("a challenge list entry lets L4 bans decide first (the user's ruling, 2026-11-16)", () => {
  const ENTRY: SecurityPolicy = {
    lists: [{ ip: "203.0.113.0/24", action: "challenge" }],
  };

  /** What the ban answers: `ban` with its own code, and no L3 hit before it. */
  function expectBanned(decision: Decision) {
    expect([decision.action, decision.status, decision.code]).toEqual([
      "ban",
      403,
      "banned",
    ]);
    expect(decision.hits.some((hit) => hit.layer === "L3")).toBe(false);
  }

  it.each([
    ["with a challenge flow", true],
    ["without one", false],
  ])("refuses a banned client by its ban at once, %s", (_name, withFlow) => {
    const security = engine(ENTRY, withFlow ? stubFlow() : undefined);
    security.ban({ ip: "203.0.113.10", duration: "1h" });
    expectBanned(decide(security));
    expectBanned(decide(security, facts(), "early"));
  });

  it("refuses a banned client by its ban even with a clearance", () => {
    const flow = stubFlow();
    const security = engine(ENTRY, flow);
    security.ban({ ip: "203.0.113.10", duration: "1h" });
    expectBanned(decide(security, CLEARED));
    // The ban decided alone: the flow was never asked.
    expect(flow.asked).toBe(0);
  });

  it("still challenges a client that is not banned", () => {
    const security = engine(ENTRY, stubFlow());
    const decision = decide(security);
    expect([decision.action, decision.code]).toEqual([
      "challenge",
      "challenge_required",
    ]);
    expect(decision.hits.map((hit) => [hit.layer, hit.action])).toEqual([
      ["L3", "challenge"],
    ]);
  });

  it("keeps an allow or block entry ahead of the bans", () => {
    const blocked = engine(
      { lists: [{ ip: "203.0.113.0/24", action: "block" }] },
      stubFlow(),
    );
    blocked.ban({ ip: "203.0.113.10", duration: "1h" });
    expect(decide(blocked)).toMatchObject({ action: "block", code: "blocked" });
    const allowed = engine(
      { lists: [{ ip: "203.0.113.0/24", action: "allow" }] },
      stubFlow(),
    );
    allowed.ban({ ip: "203.0.113.10", duration: "1h" });
    expect(decide(allowed).action).toBe("allow");
  });

  it("negative control: the old order (an entry answering before L4, as `block` still does) fails the ban check", () => {
    const old = engine(
      { lists: [{ ip: "203.0.113.0/24", action: "block" }] },
      stubFlow(),
    );
    old.ban({ ip: "203.0.113.10", duration: "1h" });
    expect(() => expectBanned(decide(old))).toThrow();
  });
});
