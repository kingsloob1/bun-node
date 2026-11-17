/**
 * The control plane's internal facts (PR-CP7). Only an engine built as a
 * throwaway (`THROWAWAY_ENGINE`) takes them: pre-keyed account subjects (a
 * replayed event's) match account lists as the ids would, and assumed
 * limit counts and scores apply to `explain()`. A live engine refuses facts
 * carrying either with a `TypeError` and counts nothing (the user's
 * decision, 2026-11-17). Each with its negative control.
 */
import type { CreateSecurityOptions } from "../../lib/index";
import { describe, expect, it } from "bun:test";
import { requestFacts } from "../../lib/engine/facts";
import { THROWAWAY_ENGINE, withInternal } from "../../lib/engine/internal";
import { createSecurity } from "../../lib/index";
import { Keyring } from "../../lib/sensitive/keys";

const SECRET = "an-engine-secret-of-at-least-32-bytes!!";
const keys = new Keyring(SECRET);

/** Facts for a request to `/x` from 192.0.2.1 by `identity`. */
const factsOf = (identity: { user?: string; apiKey?: string }) =>
  requestFacts(new Request("http://service.invalid/x"), {
    peer: "192.0.2.1",
    identity,
  });

/** A throwaway engine, as the control plane builds one. */
const throwaway = (options: CreateSecurityOptions) =>
  createSecurity({ ...({ [THROWAWAY_ENGINE]: true } as object), ...options });

const LIMITED: CreateSecurityOptions = {
  policy: { limits: [{ id: "three", limit: 3, window: "1m" }] },
  logger: () => {},
};

describe("a live engine refuses internal facts", () => {
  it("assume: a TypeError, and its counters are unchanged", async () => {
    const live = createSecurity(LIMITED);
    const assumed = withInternal(factsOf({}), {
      assume: { limits: { three: 3 } },
    });
    expect(() => live.explain(assumed)).toThrow(TypeError);
    expect(() => live.evaluate(assumed)).toThrow(TypeError);
    // Nothing was counted: three plain requests still go through, the fourth not.
    const plain = factsOf({});
    for (let i = 0; i < 3; i++)
      expect((await live.evaluate(plain)).action).toBe("allow");
    expect((await live.evaluate(plain)).action).not.toBe("allow");
    live.close();
  });

  it("prekeyed: a TypeError on every entry that takes facts", async () => {
    const live = createSecurity({
      policy: { lists: [{ user: "alice", action: "block" }] },
      secret: SECRET,
      logger: () => {},
    });
    const prekeyed = withInternal(factsOf({ user: keys.user("alice") }), {
      prekeyed: true,
    });
    expect(() => live.explain(prekeyed)).toThrow(TypeError);
    expect(() => live.evaluate(prekeyed)).toThrow(TypeError);
    expect(() => live.signal(prekeyed, "auth.failure")).toThrow(TypeError);
    expect(() => live.socket(prekeyed)).toThrow(TypeError);
    // The control: the same facts without the internal ones are taken (the key keyed again, matching nothing).
    expect(
      (await live.explain(factsOf({ user: keys.user("alice") }))).decision
        .action,
    ).toBe("allow");
    live.close();
  });
});

describe("a throwaway engine takes them (the negative control)", () => {
  it("a keyed user and API key match their list entries", async () => {
    const security = throwaway({
      policy: {
        lists: [
          { user: "alice", action: "block" },
          { apiKey: "k1", action: "block" },
        ],
      },
      secret: SECRET,
      logger: () => {},
    });
    const user = factsOf({ user: keys.user("alice") });
    const key = factsOf({ apiKey: keys.apiKey("k1") });
    expect(
      (await security.explain(withInternal(user, { prekeyed: true }))).decision
        .action,
    ).toBe("block");
    expect(
      (await security.explain(withInternal(key, { prekeyed: true }))).decision
        .action,
    ).toBe("block");
    // Without the internal facts, the key is keyed again and matches nothing.
    expect((await security.explain(user)).decision.action).toBe("allow");
    expect(
      (await security.explain(withInternal(user, { prekeyed: true }))).decision
        .subject.user,
    ).toBe(keys.user("alice"));
    security.close();
  });

  it("an assumed count trips a limit in explain(); evaluate() ignores it", async () => {
    const facts = withInternal(factsOf({}), {
      assume: { limits: { three: 3 } },
    });
    const explaining = throwaway(LIMITED);
    expect(
      (await explaining.explain(facts)).decision.hits.map((h) => h.rule),
    ).toContain("limit:three");
    explaining.close();
    const evaluating = throwaway(LIMITED);
    expect((await evaluating.evaluate(facts)).action).toBe("allow");
    evaluating.close();
  });
});
