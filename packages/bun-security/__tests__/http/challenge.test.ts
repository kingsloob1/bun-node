/**
 * Challenges on bun-common's adapter (layers.md L10.2): under
 * `installSecurity` an address challenge is answered in the early stage and
 * its answer taken there, before the body is read by anything else; a
 * caller's challenge (a user list entry) in the route stage; and with
 * `securityMiddleware` alone the answer is taken in the route stage.
 */
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter, BunRouter } from "@kingsleyweb/bun-common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { challenges } from "../../lib/challenge/flow";
import { powChallenge, solvePowChallenge } from "../../lib/challenge/pow";
import type { PowChallengeData } from "../../lib/challenge/pow";
import { installSecurity, securityMiddleware } from "../../lib/http/index";
import { createSecurity } from "../../lib/index";
import type { SecurityPolicy } from "../../lib/index";

const PEER = "203.0.113.10";

/** An engine with a proof-of-work flow, reading the caller from `x-user`. */
function engine(policy: SecurityPolicy) {
  return createSecurity<BunRequest>({
    policy,
    logger: () => {},
    identify: (req) => {
      const user = req.request.headers.get("x-user");
      return user === null ? undefined : { user };
    },
    challenge: challenges({
      provider: powChallenge({ secret: "p".repeat(32), maxNumber: 300 }),
      secret: "c".repeat(32),
    }),
  });
}

/** Solves the challenge in an API problem and posts it through `fetch`; the clearance. */
async function solveThrough(
  fetch: (
    path: string,
    init: RequestInit & { remoteAddress?: string },
  ) => Promise<Response>,
  problem: Response,
  headers: Record<string, string> = {},
): Promise<string> {
  const body = (await problem.json()) as {
    challenge: { path: string; data: PowChallengeData };
  };
  const answered = await fetch(body.challenge.path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ answer: solvePowChallenge(body.challenge.data) }),
    remoteAddress: PEER,
  });
  expect(answered.status).toBe(200);
  return ((await answered.json()) as { clearance: string }).clearance;
}

describe("installSecurity with a challenge flow", () => {
  it("challenges an address early, takes the answer there, and admits the cleared client", async () => {
    const app = new BunHttpAdapter(0, { logger: () => {} });
    const security = engine({
      lists: [{ ip: "203.0.113.0/24", action: "challenge" }],
    });
    await installSecurity(app, security, { logger: () => {} });
    let reached = 0;
    app.get("/orders", (_req, res) => {
      reached++;
      res.send("orders");
    });
    const problem = await app.fetch("/orders", {
      headers: { accept: "application/json" },
      remoteAddress: PEER,
    });
    expect(problem.status).toBe(403);
    expect(reached).toBe(0);
    const clearance = await solveThrough(
      (path, init) => app.fetch(path, init),
      problem,
    );
    const admitted = await app.fetch("/orders", {
      headers: { "x-security-clearance": clearance },
      remoteAddress: PEER,
    });
    expect([admitted.status, await admitted.text()]).toEqual([200, "orders"]);
    expect(reached).toBe(1);
    expect(security.status().state.inFlight).toBe(0);
  });

  it("challenges a listed user in the route stage, and serves the page with its CSP", async () => {
    const app = new BunHttpAdapter(0, { logger: () => {} });
    await installSecurity(
      app,
      engine({ lists: [{ user: "u_1", action: "challenge" }] }),
      { logger: () => {} },
    );
    app.get("/me", (_req, res) => res.send("me"));
    const page = await app.fetch("/me", {
      headers: { accept: "text/html", "x-user": "u_1" },
      remoteAddress: PEER,
    });
    expect(page.status).toBe(403);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(await page.text()).toContain('id="bun-security-pow"');
    const other = await app.fetch("/me", {
      headers: { "x-user": "u_2" },
      remoteAddress: PEER,
    });
    expect(other.status).toBe(200);
  });

  it("takes the answer in the route stage under securityMiddleware alone", async () => {
    const router = new BunRouter();
    const security = engine({
      requestRules: {
        rules: [
          { id: "all", when: { path: { prefix: "/" } }, action: "challenge" },
        ],
      },
    });
    router.use(securityMiddleware(security, { router }));
    router.get("/x", (_req, res) => res.send("x"));
    const fetch = (
      path: string,
      init: RequestInit & { remoteAddress?: string },
    ) => router.fetch(path, init);
    const problem = await fetch("/x", {
      headers: { accept: "application/json" },
      remoteAddress: PEER,
    });
    expect(problem.status).toBe(403);
    const clearance = await solveThrough(fetch, problem);
    const admitted = await fetch("/x", {
      headers: { "x-security-clearance": clearance },
      remoteAddress: PEER,
    });
    expect(await admitted.text()).toBe("x");
  });
});
