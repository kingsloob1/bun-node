/**
 * The login defences' challenges through PR-S9's challenge flow (layers.md
 * L10.2, L11.2): the per-username challenge and the credential-stuffing
 * challenge are a `challenge` with a flow (403 `challenge_required`), a
 * pass with a valid clearance, and a `429` (per username) or the challenge
 * ban's `403` without a flow. The soft lock refuses (`429`) with a flow and
 * a clearance as without; and the stuffing ban at 30 refuses a cleared
 * client too.
 */
import { describe, expect, it } from "bun:test";
import { challenges } from "../../lib/challenge/flow";
import type { ChallengeFlow } from "../../lib/challenge/flow";
import type { ChallengeProvider } from "../../lib/challenge/types";
import type { RequestFacts, SecurityPolicy } from "../../lib/index";
import { engine, fail, fakeClock, login } from "./helpers";

/** A provider whose answers are never asked for here. */
const PROVIDER: ChallengeProvider = {
  id: "fake",
  field: "answer",
  issue: () => ({ provider: "fake", field: "answer", html: "" }),
  verify: () => ({ ok: true }),
};

/** A flow whose clearance a header decides (the real tokens are S9's flow.test.ts). */
function stubFlow(): ChallengeFlow {
  const real = challenges({ provider: PROVIDER, secret: "s".repeat(32) });
  return {
    ...real,
    cleared: (request: RequestFacts) =>
      request.headers["x-test-cleared"] === "yes",
  };
}

/** `request` holding a clearance. */
function cleared(request: RequestFacts): RequestFacts {
  return {
    ...request,
    headers: { ...request.headers, "x-test-cleared": "yes" },
  };
}

const LADDER: SecurityPolicy = {
  profiles: {
    login: { failures: { delayAfter: 2, challengeAfter: 3, lockAfter: 5 } },
  },
};

describe("the per-username challenge and the soft lock", () => {
  for (const withFlow of [true, false]) {
    it(`${withFlow ? "with" : "without"} a challenge flow`, async () => {
      const clock = fakeClock();
      const security = engine(
        LADDER,
        clock,
        withFlow ? { challenge: stubFlow() } : {},
      );
      for (let i = 0; i < 3; i++) {
        await fail(security, login("pat"));
        clock.advance(7_000);
      }
      const challenged = await security.evaluate(login("pat"));
      const hit = challenged.hits.find((h) => h.rule === "login:challenge");
      if (withFlow) {
        expect(challenged).toMatchObject({
          action: "challenge",
          status: 403,
          code: "challenge_required",
        });
        const passed = await security.evaluate(cleared(login("pat")));
        expect(passed.action).toBe("log");
        expect(
          passed.hits.find((h) => h.rule === "login:challenge")?.reason,
        ).toContain("challenge passed");
      } else {
        expect(challenged).toMatchObject({
          action: "block",
          status: 429,
          code: "rate_limited",
        });
        expect(hit?.reason).toContain("fell back to block");
      }
      // Two more failures: the soft lock, a refusal with or without a clearance.
      for (let i = 0; i < 2; i++) {
        await fail(security, login("pat"));
        clock.advance(7_000);
      }
      for (const request of [login("pat"), cleared(login("pat"))]) {
        const locked = await security.evaluate(request);
        expect(locked).toMatchObject({
          action: "block",
          status: 429,
          code: "rate_limited",
        });
        expect(locked.hits.map((h) => h.rule)).toContain("login:lock");
      }
    });
  }
});

describe("the credential-stuffing challenge and ban", () => {
  for (const withFlow of [true, false]) {
    it(`${withFlow ? "with" : "without"} a challenge flow`, async () => {
      const clock = fakeClock();
      const security = engine(
        {
          presets: {
            "login.ip-failures": false,
            "login.ip-failures-ban": false,
          },
        },
        clock,
        withFlow ? { challenge: stubFlow() } : {},
      );
      for (let i = 0; i < 10; i++) {
        await security.signal(
          login(`stuff${i}`, "203.0.113.90"),
          "auth.failure",
        );
      }
      expect(security.bans()[0]).toMatchObject({
        id: "ip:203.0.113.90",
        action: "challenge",
      });
      const next = login("someone", "203.0.113.90");
      const challenged = await security.evaluate(next);
      if (withFlow) {
        expect(challenged).toMatchObject({
          action: "challenge",
          code: "challenge_required",
        });
        expect((await security.evaluate(cleared(next))).action).toBe("log");
      } else {
        expect(challenged.action).toBe("block");
      }
      for (let i = 10; i < 30; i++) {
        await security.signal(
          login(`stuff${i}`, "203.0.113.90"),
          "auth.failure",
        );
      }
      expect(security.bans()[0]?.action).toBe("ban");
      // The ban refuses a cleared client as any other.
      expect((await security.evaluate(cleared(next))).action).toBe("ban");
    });
  }
});
