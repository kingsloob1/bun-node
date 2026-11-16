/**
 * Challenges through `withSecurity` (layers.md L10.2): the whole round
 * trip with a proof of work solved in the test — challenged, answered,
 * cleared, admitted — for a browser (page, form, cookie) and an API client
 * (problem, JSON, header); a failed answer signalled to the engine; and
 * the fallback to a block without a flow.
 */
import { describe, expect, it } from "bun:test";
import { challenges } from "../../lib/challenge/flow";
import { powChallenge, solvePowChallenge } from "../../lib/challenge/pow";
import type { PowChallengeData } from "../../lib/challenge/pow";
import { createSecurity } from "../../lib/engine/security";
import type { Security } from "../../lib/engine/security";
import type { SecurityPolicy } from "../../lib/policy/types";
import { withSecurity } from "../../lib/serve/index";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0";
const CHALLENGED: SecurityPolicy = {
  lists: [{ ip: "203.0.113.0/24", action: "challenge" }],
};

/** A secured handler and a way to call it from `peer`. */
function secured(policy: SecurityPolicy, withFlow = true) {
  const security: Security = createSecurity({
    policy,
    logger: () => {},
    ...(withFlow
      ? {
          challenge: challenges({
            provider: powChallenge({ secret: "p".repeat(32), maxNumber: 300 }),
            secret: "c".repeat(32),
          }),
        }
      : {}),
  });
  const handler = withSecurity(security, () => new Response("the app"), {
    logger: () => {},
  });
  const call = async (
    url: string,
    init: RequestInit = {},
    peer = "203.0.113.10",
  ) =>
    await handler(new Request(`http://app.test${url}`, init), {
      requestIP: () => ({ address: peer }),
    });
  return { security, call };
}

/** The proof of work embedded in a challenge page. */
function powOfPage(html: string): PowChallengeData {
  const json =
    /<script type="application\/json" id="bun-security-pow">(.*?)<\/script>/.exec(
      html,
    )?.[1];
  return JSON.parse(json!) as PowChallengeData;
}

describe("withSecurity with a challenge flow", () => {
  it("challenges a browser, takes its answer, and admits it with the clearance cookie", async () => {
    const { security, call } = secured(CHALLENGED);
    const page = await call("/account", {
      headers: { accept: "text/html", "user-agent": UA },
    });
    expect(page.status).toBe(403);
    expect(page.headers.get("content-security-policy")).toStartWith(
      "default-src 'none'",
    );
    const solved = solvePowChallenge(powOfPage(await page.text()))!;
    const answered = await call("/__bun-security/challenge", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": UA,
      },
      body: new URLSearchParams({ altcha: solved, return: "/account" }),
    });
    expect(answered.status).toBe(303);
    expect(answered.headers.get("location")).toBe("/account");
    const cookie = answered.headers.get("set-cookie")!.split(";")[0]!;
    const admitted = await call("/account", {
      headers: { cookie, "user-agent": UA },
    });
    expect([admitted.status, await admitted.text()]).toEqual([200, "the app"]);
    // Every tracked request gave its slot back.
    expect(security.status().state.inFlight).toBe(0);
  });

  it("gives an API client the challenge as a problem, and its clearance in the body for the header", async () => {
    const { call } = secured(CHALLENGED);
    const problem = await call("/api/orders", {
      headers: { accept: "application/json", "user-agent": "app/1" },
    });
    expect(problem.status).toBe(403);
    const body = (await problem.json()) as {
      code: string;
      challenge: { path: string; data: PowChallengeData };
    };
    expect(body.code).toBe("challenge_required");
    const answered = await call(body.challenge.path, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "app/1" },
      body: JSON.stringify({ answer: solvePowChallenge(body.challenge.data) }),
    });
    const { clearance, header } = (await answered.json()) as {
      clearance: string;
      header: string;
    };
    const admitted = await call("/api/orders", {
      headers: { [header]: clearance, "user-agent": "app/1" },
    });
    expect(admitted.status).toBe(200);
    // Negative control: the same token from another network is challenged again.
    const elsewhere = await call(
      "/api/orders",
      { headers: { [header]: clearance, "user-agent": "app/1" } },
      "203.0.114.10",
    );
    expect(elsewhere.status).toBe(200); // not on the list at all
    const otherUa = await call("/api/orders", {
      headers: { [header]: clearance, "user-agent": "app/2" },
    });
    expect(otherUa.status).toBe(403);
  });

  it("signals a failed answer, which a counted rule can ban on", async () => {
    // A request rule's challenge (L7) runs after the bans (L4), as an L3
    // challenge entry's now does too (the engine tests cover that one).
    const { call } = secured({
      requestRules: {
        rules: [
          {
            id: "everyone",
            when: { path: { prefix: "/" } },
            action: "challenge",
          },
        ],
      },
      countedRules: [
        {
          id: "failing",
          event: "challenge.failed",
          threshold: 3,
          window: "10m",
          duration: "1h",
        },
      ],
    });
    for (let i = 0; i < 3; i++) {
      const failed = await call("/__bun-security/challenge", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ altcha: "garbage" }),
      });
      expect(failed.status).toBe(403);
    }
    const banned = await call("/", { headers: { accept: "application/json" } });
    expect(((await banned.json()) as { code: string }).code).toBe("banned");
    // A banned client's answers are refused, not verified.
    const refused = await call("/__bun-security/challenge", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({ altcha: "garbage" }),
    });
    expect(((await refused.json()) as { code: string }).code).toBe("banned");
  });

  it("takes an answer from an admitted client too, giving back its slot", async () => {
    const { security, call } = secured({});
    const answered = await call(
      "/__bun-security/challenge",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ altcha: "garbage" }),
      },
      "198.51.100.1",
    );
    expect(answered.status).toBe(403);
    expect(security.status().state.inFlight).toBe(0);
  });

  it("falls back to the block without a flow, and passes the answer path to the app", async () => {
    const { call } = secured(CHALLENGED, false);
    const blocked = await call("/", {
      headers: { accept: "application/json" },
    });
    expect([
      blocked.status,
      ((await blocked.json()) as { code: string }).code,
    ]).toEqual([403, "blocked"]);
    const app = await call(
      "/__bun-security/challenge",
      { method: "POST" },
      "198.51.100.1",
    );
    expect(await app.text()).toBe("the app");
  });
});
