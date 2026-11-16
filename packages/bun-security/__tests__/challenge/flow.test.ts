/**
 * The challenge flow (layers.md L10.2): the page or problem a challenged
 * request gets, the answer endpoint, and the clearance it mints. The proof
 * of work is solved in the test; a fake provider covers the rest.
 */
import { ConfigError } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import { challenges } from "../../lib/challenge/flow";
import { challengePage } from "../../lib/challenge/page";
import { powChallenge, solvePowChallenge } from "../../lib/challenge/pow";
import type { PowChallengeData } from "../../lib/challenge/pow";
import type { ChallengeProvider } from "../../lib/challenge/types";
import type { Decision } from "../../lib/engine/decision";
import { requestFacts } from "../../lib/engine/facts";
import { fakeClock } from "../helpers";

const SECRET = "flow-clearance-secret-0123456789-abcdef";
const POW_SECRET = "flow-pow-secret-0123456789-0123456789";
const PEER = "203.0.113.10";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0";

/** A challenged decision. */
const CHALLENGED: Decision = {
  action: "challenge",
  status: 403,
  code: "challenge_required",
  hits: [],
  tags: [],
  risk: 2,
  subject: { ip: PEER },
};

/** A request and its facts, from `peer`. */
function exchange(url: string, init: RequestInit = {}, peer = PEER) {
  const request = new Request(url, init);
  return { request, facts: requestFacts(request, { peer }) };
}

/** A provider that passes the answer "yes". */
const YES: ChallengeProvider = {
  id: "yes",
  field: "answer",
  issue: () => ({
    provider: "yes",
    field: "answer",
    html: "<b>say yes</b>",
    data: { ask: "yes" },
  }),
  verify: (answer) =>
    answer === "yes" ? { ok: true } : { ok: false, reason: "said no" },
};

/** The `Set-Cookie` a response carries, parsed into its name, value and attributes. */
function cookieOf(response: Response) {
  const header = response.headers.get("set-cookie") ?? "";
  const [pair = "", ...attributes] = header.split(/;\s*/);
  const at = pair.indexOf("=");
  return {
    name: pair.slice(0, at),
    value: decodeURIComponent(pair.slice(at + 1)),
    attributes: attributes.map((a) => a.toLowerCase()),
  };
}

describe("challenges()", () => {
  it("answers a browser with the challenge page under a strict CSP", async () => {
    const flow = challenges({
      provider: powChallenge({ secret: POW_SECRET, maxNumber: 500 }),
      secret: SECRET,
    });
    const { request, facts } = exchange("http://app.test/account?tab=2", {
      headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    });
    const response = await flow.respond(CHALLENGED, request, facts);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toStartWith("default-src 'none'; script-src 'nonce-");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    const html = await response.text();
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    // Every script and style carries the nonce; none runs without it.
    for (const tag of html.match(/<(?:script|style)\b[^>]*>/g) ?? []) {
      if (tag.includes('type="application/json"')) continue;
      expect(tag).toContain(`nonce="${nonce}"`);
    }
    expect(html).toContain('action="/__bun-security/challenge"');
    expect(html).toContain('name="return" value="/account?tab=2"');
  });

  it("answers an API client with a problem carrying the challenge", async () => {
    const flow = challenges({ provider: YES, secret: SECRET });
    const { request, facts } = exchange("http://app.test/api/x", {
      headers: { accept: "application/json" },
    });
    const response = await flow.respond(CHALLENGED, request, facts);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      code: "challenge_required",
      challenge: {
        provider: "yes",
        field: "answer",
        path: "/__bun-security/challenge",
        data: { ask: "yes" },
      },
    });
  });

  it("passes a solved proof of work: a 303 back, with a clearance cookie the flow then accepts", async () => {
    const clock = fakeClock();
    const flow = challenges({
      provider: powChallenge({
        secret: POW_SECRET,
        maxNumber: 500,
        now: clock.now,
      }),
      secret: SECRET,
      now: clock.now,
    });
    const asked = exchange("http://app.test/account", {
      headers: { accept: "application/json", "user-agent": UA },
    });
    const problem = (await (
      await flow.respond(CHALLENGED, asked.request, asked.facts)
    ).json()) as {
      challenge: { data: PowChallengeData };
    };
    const solved = solvePowChallenge(problem.challenge.data)!;
    const answer = exchange("http://app.test/__bun-security/challenge", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": UA,
      },
      body: new URLSearchParams({ altcha: solved, return: "/account" }),
    });
    expect(flow.answers(answer.request)).toBe(true);
    const result = await flow.answer(answer.request, answer.facts);
    expect(result.passed).toBe(true);
    expect(result.response.status).toBe(303);
    expect(result.response.headers.get("location")).toBe("/account");
    const cookie = cookieOf(result.response);
    expect(cookie.name).toBe("bun-security-clearance");
    expect(cookie.attributes).toContain("httponly");
    expect(cookie.attributes).toContain("samesite=lax");
    expect(cookie.attributes).toContain("path=/");
    expect(cookie.attributes).toContain("max-age=1800");
    // Back with the cookie: cleared. From another network, or a day later: not.
    const back = exchange("http://app.test/account", {
      headers: { cookie: `${cookie.name}=${cookie.value}`, "user-agent": UA },
    });
    expect(flow.cleared(back.facts)).toBe(true);
    const elsewhere = exchange(
      "http://app.test/account",
      {
        headers: { cookie: `${cookie.name}=${cookie.value}`, "user-agent": UA },
      },
      "198.51.100.7",
    );
    expect(flow.cleared(elsewhere.facts)).toBe(false);
    clock.advance(1800 * 1000);
    expect(flow.cleared(back.facts)).toBe(false);
  });

  it("names the cookie __Host- and marks it Secure over HTTPS", async () => {
    const flow = challenges({ provider: YES, secret: SECRET });
    const answer = exchange("https://app.test/__bun-security/challenge", {
      method: "POST",
      body: new URLSearchParams({ answer: "yes" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const result = await flow.answer(answer.request, answer.facts);
    const cookie = cookieOf(result.response);
    expect(cookie.name).toBe("__Host-bun-security-clearance");
    expect(cookie.attributes).toContain("secure");
    const back = exchange("https://app.test/", {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(flow.cleared(back.facts)).toBe(true);
  });

  it("gives an API client its clearance in the body, which it sends back in the header", async () => {
    const flow = challenges({ provider: YES, secret: SECRET });
    const answer = exchange("http://app.test/__bun-security/challenge", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "client/1" },
      body: JSON.stringify({ answer: "yes" }),
    });
    const result = await flow.answer(answer.request, answer.facts);
    expect(result.response.status).toBe(200);
    const body = (await result.response.json()) as {
      clearance: string;
      header: string;
    };
    expect(body.header).toBe("x-security-clearance");
    const back = exchange("http://app.test/api", {
      headers: {
        "x-security-clearance": body.clearance,
        "user-agent": "client/1",
      },
    });
    expect(flow.cleared(back.facts)).toBe(true);
    // Negative control: the same token with a byte changed is not.
    const forged = exchange("http://app.test/api", {
      headers: {
        // One character changed, never to itself (a fixed "AA" was the
        // token's own ending one run in 4,096: seed 33190, PR-S11's gate).
        "x-security-clearance": `${body.clearance.slice(0, -1)}${body.clearance.endsWith("A") ? "B" : "A"}`,
        "user-agent": "client/1",
      },
    });
    expect(flow.cleared(forged.facts)).toBe(false);
  });

  it("challenges again on a wrong answer, with a notice and challenge_failed", async () => {
    const flow = challenges({ provider: YES, secret: SECRET });
    const page = exchange("http://app.test/__bun-security/challenge", {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ answer: "no", return: "/x" }),
    });
    const failed = await flow.answer(page.request, page.facts);
    expect(failed.passed).toBe(false);
    expect(failed.reason).toBe("said no");
    expect(failed.response.status).toBe(403);
    expect(failed.response.headers.get("set-cookie")).toBeNull();
    expect(await failed.response.text()).toContain("That did not work");
    const api = exchange("http://app.test/__bun-security/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "no" }),
    });
    const refused = await flow.answer(api.request, api.facts);
    expect(((await refused.response.json()) as { code: string }).code).toBe(
      "challenge_failed",
    );
  });

  it("never returns to another origin, and refuses an oversized or unreadable answer", async () => {
    const flow = challenges({ provider: YES, secret: SECRET });
    for (const target of [
      "//evil.test/",
      "https://evil.test/",
      "/\\evil.test",
      "javascript:alert(1)",
    ]) {
      const answer = exchange("http://app.test/__bun-security/challenge", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ answer: "yes", return: target }),
      });
      const result = await flow.answer(answer.request, answer.facts);
      expect(result.response.headers.get("location")).toBe("/");
    }
    const big = exchange("http://app.test/__bun-security/challenge", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `answer=yes&pad=${"x".repeat(20_000)}`,
    });
    expect((await flow.answer(big.request, big.facts)).reason).toBe(
      "unreadable answer",
    );
    const garbled = exchange("http://app.test/__bun-security/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect((await flow.answer(garbled.request, garbled.facts)).passed).toBe(
      false,
    );
  });

  it("takes only a POST to its own path", () => {
    const flow = challenges({
      provider: YES,
      secret: SECRET,
      path: "/verify-human",
    });
    expect(flow.path).toBe("/verify-human");
    expect(
      flow.answers(
        new Request("http://app.test/verify-human", { method: "POST" }),
      ),
    ).toBe(true);
    expect(flow.answers(new Request("http://app.test/verify-human"))).toBe(
      false,
    );
    expect(
      flow.answers(
        new Request("http://app.test/__bun-security/challenge", {
          method: "POST",
        }),
      ),
    ).toBe(false);
  });

  it("renders the app's own page through the page hook", async () => {
    const seen: string[] = [];
    const flow = challenges({
      provider: YES,
      secret: SECRET,
      page: (descriptor, options) => {
        seen.push(
          `${descriptor.provider} ${options.action} ${options.returnTo}`,
        );
        return challengePage(descriptor, { ...options, title: "Our check" });
      },
    });
    const { request, facts } = exchange("http://app.test/a", {
      headers: { accept: "text/html" },
    });
    const response = await flow.respond(CHALLENGED, request, facts);
    expect(await response.text()).toContain("<title>Our check</title>");
    expect(seen).toEqual(["yes /__bun-security/challenge /a"]);
  });

  it("refuses a short secret, a short ttl and a bad path", () => {
    expect(() => challenges({ provider: YES, secret: "short" })).toThrow(
      ConfigError,
    );
    expect(() => challenges({ provider: YES, secret: SECRET, ttl: 5 })).toThrow(
      /ttl/,
    );
    expect(() =>
      challenges({ provider: YES, secret: SECRET, path: "no-slash" }),
    ).toThrow(/path/);
  });
});
