/**
 * An API-key list entry's default id (#836): the key id is kept only as
 * `HMAC(secret, "apiKey|" + id)` (layers.md L12, PR-S11), so the entry's
 * default id is `apiKey:` and that HMAC, the same key as
 * `Decision.subject.apiKey`, wherever it is reported: the hit's `rule`,
 * `onDecision`, `explain()`'s hits and trace, the logs. An id the policy's
 * author wrote is reported as written.
 */
import { describe, expect, it } from "bun:test";
import { createLogger } from "@kingsleyweb/bun-common";
import type { LogEvent } from "@kingsleyweb/bun-common";
import { evaluateLists } from "../../lib/engine/lists";
import { compilePolicy, createSecurity } from "../../lib/index";
import type { Decision, SecurityPolicy } from "../../lib/index";
import { policyInternals } from "../../lib/policy/compile";
import { facts } from "../helpers";

const SECRET = "the-keyed-entry-ids-test-secret-32b!";
const KEY = "key_blocked_9f3a";

/** An engine on `policy`; what it decided and logged. */
function engine(policy: SecurityPolicy, secret = SECRET) {
  const decisions: Decision[] = [];
  const logs: LogEvent[] = [];
  const security = createSecurity({
    secret,
    policy,
    logger: createLogger({ level: "trace", sink: (event) => logs.push(event) }),
    onDecision: (decision) => decisions.push(decision),
  });
  return { security, decisions, logs };
}

/** A request carrying `apiKey`. */
const withKey = (apiKey: string) =>
  facts({
    path: "/api/orders",
    rawPath: "/api/orders",
    routeKey: "GET /api/orders",
    identity: { apiKey },
  });

describe("an API-key list entry's id", () => {
  it("defaults to the key's HMAC, as the subject: the key id reaches no decision, explanation or log", async () => {
    const { security, decisions, logs } = engine({
      lists: [{ apiKey: KEY, action: "block" }],
    });
    await security.ready();
    const decision = await security.evaluate(withKey(KEY));
    // The list still matches.
    expect(decision.action).toBe("block");
    const subject = decision.subject.apiKey;
    expect(subject).toMatch(/^[0-9a-f]{32}$/);
    expect(decision.hits.map((hit) => hit.rule)).toEqual([`apiKey:${subject}`]);
    const explained = await security.explain(withKey(KEY));
    expect(explained.decision.hits.map((hit) => hit.rule)).toEqual([
      `apiKey:${subject}`,
    ]);
    expect(
      explained.steps.filter((step) => step.layer === "L3").map((s) => s.rule),
    ).toContain(`apiKey:${subject}`);
    for (const seen of [decision, decisions, explained, logs]) {
      expect(JSON.stringify(seen)).not.toContain(KEY);
    }
    await security.close();
  });

  it("is keyed in a dry-run entry's would-have-been hit too", async () => {
    const { security } = engine({
      lists: [{ apiKey: KEY, action: "block", mode: "dryRun" }],
    });
    await security.ready();
    const decision = await security.evaluate(withKey(KEY));
    // A dry-run hit is logged, not enforced.
    expect(decision.action).toBe("log");
    const rules = decision.hits.map((hit) => hit.rule);
    expect(rules).toEqual([`apiKey:${decision.subject.apiKey}`]);
    expect(JSON.stringify(decision)).not.toContain(KEY);
    await security.close();
  });

  it("is kept as written when the policy's author gives one", async () => {
    const { security } = engine({
      lists: [{ id: "partner-x-blocked", apiKey: KEY, action: "block" }],
    });
    await security.ready();
    const decision = await security.evaluate(withKey(KEY));
    expect(decision.action).toBe("block");
    expect(decision.hits.map((hit) => hit.rule)).toEqual(["partner-x-blocked"]);
    await security.close();
  });

  it("is keyed per engine: one compiled policy, two secrets, two ids, the same match", async () => {
    const policy = compilePolicy({ lists: [{ apiKey: KEY, action: "block" }] });
    const one = engine(policy as unknown as SecurityPolicy);
    const two = engine(
      policy as unknown as SecurityPolicy,
      "another-secret-of-at-least-32-bytes!!",
    );
    const [a, b] = [
      await one.security.evaluate(withKey(KEY)),
      await two.security.evaluate(withKey(KEY)),
    ];
    expect([a.action, b.action]).toEqual(["block", "block"]);
    expect(a.hits[0]?.rule).toBe(`apiKey:${a.subject.apiKey}`);
    expect(b.hits[0]?.rule).toBe(`apiKey:${b.subject.apiKey}`);
    expect(a.hits[0]?.rule).not.toBe(b.hits[0]?.rule);
    await one.security.close();
    await two.security.close();
  });

  it("other keys and other subjects are untouched, and bans by key still match", async () => {
    const { security } = engine({
      lists: [
        { apiKey: KEY, action: "block" },
        { ip: "198.51.100.0/24", action: "block" },
      ],
    });
    await security.ready();
    expect((await security.evaluate(withKey("key_other"))).action).toBe(
      "allow",
    );
    const byAddress = await security.evaluate(
      facts({ client: "198.51.100.7" }),
    );
    expect(byAddress.hits.map((hit) => hit.rule)).toEqual([
      "ip:198.51.100.0/24",
    ]);
    security.ban({ apiKey: "key_banned", duration: "1h" });
    const banned = await security.evaluate(withKey("key_banned"));
    expect(banned.action).toBe("ban");
    expect(JSON.stringify(banned)).not.toContain("key_banned");
    await security.close();
  });

  it("a duplicate is refused without echoing the key id", () => {
    expect(() =>
      compilePolicy({
        lists: [
          { apiKey: KEY, action: "block" },
          { apiKey: KEY, action: "challenge" },
        ],
      }),
    ).toThrow(/duplicates the apiKey of lists\[0\]/);
    try {
      compilePolicy({
        lists: [
          { apiKey: KEY, action: "block" },
          { apiKey: KEY, action: "challenge" },
        ],
      });
    } catch (error) {
      expect(String(error)).not.toContain(KEY);
    }
  });

  it("the control: the lists unkeyed (no engine's relabel) report the key id", () => {
    const policy = compilePolicy({ lists: [{ apiKey: KEY, action: "block" }] });
    const outcome = evaluateLists(
      policyInternals(policy),
      null,
      undefined,
      KEY,
      "/api/orders",
      Date.now(),
      false,
    );
    expect(outcome.decided?.id).toBe(`apiKey:${KEY}`);
  });
});
