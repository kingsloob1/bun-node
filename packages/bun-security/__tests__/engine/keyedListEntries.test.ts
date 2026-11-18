/**
 * List entries naming an account by its key (PR-U3): `lists[].userHash`
 * and `lists[].apiKeyHash` hold the account's HMAC under the fleet's
 * secret, as the control plane stores every account entry. The schema
 * takes them (exactly one subject, 32 lower-case hex, never echoed when
 * malformed), their default id is `user:<key>` / `apiKey:<key>`, and the
 * engine matches them as it matches a raw entry once keyed. A raw entry
 * keeps working. Each with its negative control.
 */
import { describe, expect, it } from "bun:test";
import { createSecurity } from "../../lib/index";
import type { Decision, SecurityPolicy } from "../../lib/index";
import { validatePolicy } from "../../lib/policy/schema";
import { Keyring } from "../../lib/sensitive/keys";
import { facts } from "../helpers";

const SECRET = "the-keyed-list-entries-secret-32b!!!";
const OTHER = "another-fleet-secret-of-32-bytes!!!!";
const USER = "carol@example.com";
const KEY_ID = "key_live_7f3a";
const keys = new Keyring(SECRET);

/** An engine on `policy` under `secret`, and the decisions it reported. */
function engine(policy: SecurityPolicy, secret = SECRET) {
  const decisions: Decision[] = [];
  const security = createSecurity({
    secret,
    policy,
    logger: () => {},
    onDecision: (decision) => decisions.push(decision),
  });
  return { security, decisions };
}

/** A request from `user` with API key `apiKey`. */
const as = (identity: { user?: string; apiKey?: string }) =>
  facts({
    client: "203.0.113.20",
    path: "/api/orders",
    rawPath: "/api/orders",
    routeKey: "GET /api/orders",
    identity,
  });

/** The issues `validatePolicy` finds, as `path: message` lines. */
const issuesOf = (policy: unknown) =>
  validatePolicy(policy).map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );

describe("the schema", () => {
  it("takes userHash and apiKeyHash as a subject each", () => {
    expect(
      issuesOf({
        lists: [
          { userHash: keys.user(USER), action: "block" },
          { apiKeyHash: keys.apiKey(KEY_ID), action: "allow" },
        ],
      }),
    ).toEqual([]);
  });

  it("refuses a malformed key without echoing it (the control: a well-formed one passes above)", () => {
    for (const bad of [USER, "ABCDEF0123456789ABCDEF0123456789", "ab12", 7]) {
      const found = issuesOf({ lists: [{ userHash: bad, action: "block" }] });
      expect(found).toEqual([
        "lists.0.userHash: must be a user's key: 32 lower-case hex characters (its HMAC under the fleet's secret)",
      ]);
      expect(JSON.stringify(found)).not.toContain(String(bad));
    }
    expect(
      issuesOf({ lists: [{ apiKeyHash: KEY_ID, action: "block" }] }),
    ).toEqual([
      "lists.0.apiKeyHash: must be an API key's key: 32 lower-case hex characters (its HMAC under the fleet's secret)",
    ]);
  });

  it("keeps exactly one subject: an id and a key together are refused", () => {
    expect(
      issuesOf({
        lists: [{ user: USER, userHash: keys.user(USER), action: "block" }],
      }),
    ).toEqual([
      "lists.0: must have exactly one of ip, user, userHash, apiKey, apiKeyHash, country, asn; got user, userHash",
    ]);
  });

  it("refuses two entries with one key, without echoing it; an id and its key cannot be told apart without the secret", () => {
    const key = keys.user(USER);
    const twice = issuesOf({
      lists: [
        { userHash: key, action: "block" },
        { userHash: key, action: "allow" },
      ],
    });
    expect(twice).toEqual(["lists.1.id: duplicates the user of lists[0]"]);
    expect(JSON.stringify(twice)).not.toContain(key);
    // The schema has no secret: a raw entry and the key of the same
    // account are two subjects to it (the control plane keys first, and so
    // refuses them; the engine weighs both, below).
    expect(
      issuesOf({
        lists: [
          { user: USER, action: "allow" },
          { userHash: key, action: "block" },
        ],
      }),
    ).toEqual([]);
  });
});

describe("the engine", () => {
  it("refuses the user a userHash entry names, reported under the key; another user passes", async () => {
    const key = keys.user(USER);
    const { security, decisions } = engine({
      lists: [{ userHash: key, action: "block" }],
    });
    const refused = await security.evaluate(as({ user: USER }));
    expect(refused.action).toBe("block");
    expect(refused.subject.user).toBe(key);
    expect(refused.hits.map((hit) => hit.rule)).toEqual([`user:${key}`]);
    const explained = await security.explain(as({ user: USER }));
    expect(explained.decision.hits.map((hit) => hit.rule)).toEqual([
      `user:${key}`,
    ]);
    expect(JSON.stringify({ refused, decisions })).not.toContain(USER);
    expect((await security.evaluate(as({ user: "dave" }))).action).toBe(
      "allow",
    );
    await security.close();
  });

  it("refuses the API key an apiKeyHash entry names", async () => {
    const key = keys.apiKey(KEY_ID);
    const { security } = engine({
      lists: [{ apiKeyHash: key, action: "block" }],
    });
    const refused = await security.evaluate(as({ apiKey: KEY_ID }));
    expect(refused.action).toBe("block");
    expect(refused.hits.map((hit) => hit.rule)).toEqual([`apiKey:${key}`]);
    expect((await security.evaluate(as({ apiKey: "key_other" }))).action).toBe(
      "allow",
    );
    await security.close();
  });

  it("matches only under the secret that made the key (the control: another fleet's key misses)", async () => {
    const theirs = new Keyring(OTHER).user(USER);
    const { security } = engine({
      lists: [{ userHash: theirs, action: "block" }],
    });
    expect((await security.evaluate(as({ user: USER }))).action).toBe("allow");
    await security.close();
    // And the key passed as an id is keyed again, and misses.
    const twice = engine({
      lists: [{ user: keys.user(USER), action: "block" }],
    });
    expect((await twice.security.evaluate(as({ user: USER }))).action).toBe(
      "allow",
    );
    await twice.security.close();
  });

  it("matches a keyed entry exactly as the raw entry it stands for: same action, same rule id", async () => {
    const raw = engine({ lists: [{ user: USER, action: "challenge" }] });
    const keyed = engine({
      lists: [{ userHash: keys.user(USER), action: "challenge" }],
    });
    const one = await raw.security.evaluate(as({ user: USER }));
    const two = await keyed.security.evaluate(as({ user: USER }));
    expect(two.action).toBe(one.action);
    expect(two.hits).toEqual(one.hits);
    await raw.security.close();
    await keyed.security.close();
  });

  it("an explicit id on a keyed entry is reported as written", async () => {
    const { security } = engine({
      lists: [{ id: "vip-block", userHash: keys.user(USER), action: "block" }],
    });
    const refused = await security.evaluate(as({ user: USER }));
    expect(refused.hits.map((hit) => hit.rule)).toEqual(["vip-block"]);
    await security.close();
  });

  it("weighs a raw entry and the key of the same account together, by the lists' precedence", async () => {
    const { security } = engine({
      lists: [
        { user: USER, action: "allow" },
        { userHash: keys.user(USER), action: "block" },
      ],
    });
    // The most severe of one scope wins; both carry the same rule id.
    const decided = await security.evaluate(as({ user: USER }));
    expect(decided.action).toBe("block");
    expect(decided.hits.map((hit) => hit.rule)).toEqual([
      `user:${keys.user(USER)}`,
    ]);
    await security.close();
  });

  it("a dry-run keyed entry records the would-be action", async () => {
    const { security } = engine({
      lists: [{ userHash: keys.user(USER), action: "block", mode: "dryRun" }],
    });
    const decided = await security.evaluate(as({ user: USER }));
    expect(decided.action).toBe("log");
    expect(decided.hits).toContainEqual(
      expect.objectContaining({
        rule: `user:${keys.user(USER)}`,
        wouldHaveBeen: "block",
      }),
    );
    await security.close();
  });
});
