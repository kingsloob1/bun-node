/**
 * API keys (layers.md L12 v1): keyed by their HMAC under `secret`, never
 * kept in clear; per-key and per-plan limits; the new-ASN and
 * many-addresses anomalies, each with every action, dry run and its event;
 * `onKeyCompromised` once per anomaly; revoke-and-ban. One process; the
 * shared-store, cross-process case is `__tests__/stores/apikeys.multiprocess.test.ts`.
 */
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { describe, expect, it } from "bun:test";
import type { Decision } from "../../lib/engine/decision";
import type { RequestFacts } from "../../lib/engine/facts";
import { createSecurity } from "../../lib/engine/security";
import type {
  CreateSecurityOptions,
  KeyCompromise,
  Security,
} from "../../lib/engine/security";
import type { IntelLookup } from "../../lib/intel/types";
import { parseAddress } from "../../lib/ip/address";
import { compilePolicy } from "../../lib/policy/compile";
import { SecurityPolicyError } from "../../lib/policy/errors";
import type { SecurityPolicy } from "../../lib/policy/types";
import { cacheStore } from "../../lib/stores/index";
import { facts, fakeClock } from "../helpers";
import type { FakeClock } from "../helpers";

const SECRET = "the-api-key-test-secret-of-32-bytes!!";

/** An intel whose ASN is the address's second octet: 45.1.x.x is AS1. */
const intel: IntelLookup = {
  lookup(address) {
    const parsed =
      typeof address === "string" ? parseAddress(address) : address;
    const word = parsed?.family === 4 ? (parsed.words[0] ?? 0) : 0;
    return { asn: (word >>> 16) & 0xff, classes: [] };
  },
  provides: () => ({ country: false, asn: true, classes: new Set() }),
};

/** An engine, recording what onKeyCompromised hears. */
function engine(
  policy: SecurityPolicy,
  options: Partial<CreateSecurityOptions> & { clock?: FakeClock } = {},
) {
  const heard: KeyCompromise[] = [];
  const { clock, ...rest } = options;
  const security = createSecurity({
    policy,
    secret: SECRET,
    intel,
    now: (clock ?? fakeClock()).now,
    logger: () => {},
    onKeyCompromised: (event) => heard.push(event),
    ...rest,
  });
  return { security, heard };
}

/** A request with API key `key` from `client`. */
function keyed(
  key: string,
  client: string,
  identity: Record<string, unknown> = {},
): RequestFacts {
  return facts({
    client,
    path: "/api/orders",
    rawPath: "/api/orders",
    routeKey: "GET /api/orders",
    identity: { apiKey: key, ...identity },
  });
}

/** `evaluate()` of each, in order. */
async function each(
  security: Security,
  requests: readonly RequestFacts[],
): Promise<Decision[]> {
  const out: Decision[] = [];
  for (const request of requests) out.push(await security.evaluate(request));
  return out;
}

describe("keying", () => {
  it("keys a key by its HMAC under the secret: never the id, and stable for a secret", async () => {
    const one = engine({}).security;
    const two = engine({}).security;
    const other = engine(
      {},
      { secret: "another-secret-also-at-least-32-bytes" },
    ).security;
    const [a] = await each(one, [keyed("key_live_1", "45.1.0.1")]);
    const [b] = await each(two, [keyed("key_live_1", "45.1.0.1")]);
    const [c] = await each(other, [keyed("key_live_1", "45.1.0.1")]);
    expect(a?.subject.apiKey).toMatch(/^[0-9a-f]{32}$/);
    expect(a?.subject.apiKey).toBe(b?.subject.apiKey);
    expect(c?.subject.apiKey).not.toBe(a?.subject.apiKey);
    expect(JSON.stringify(a)).not.toContain("key_live_1");
  });

  it("still matches list entries and bans by the key's id", async () => {
    const { security } = engine({
      lists: [{ apiKey: "key_blocked", action: "block" }],
    });
    expect(
      (await security.evaluate(keyed("key_blocked", "45.1.0.1"))).action,
    ).toBe("block");
    const ban = security.ban({ apiKey: "key_banned", duration: "1h" });
    expect(ban.subject.value).not.toContain("key_banned");
    expect(
      (await security.evaluate(keyed("key_banned", "45.2.0.1"))).action,
    ).toBe("ban");
    expect(
      (await security.evaluate(keyed("key_other", "45.2.0.1"))).action,
    ).toBe("allow");
  });

  it("refuses a shared store without a secret (S7's rule)", () => {
    const store = cacheStore(createCache({ driver: memoryDriver() }), {
      logger: () => {},
    });
    expect(() =>
      createSecurity({ policy: {}, store, logger: () => {} }),
    ).toThrow(/a shared store needs a secret/);
  });
});

describe("per-key limits", () => {
  it("count a key across its addresses, and per key and route", async () => {
    const { security } = engine({
      limits: [
        { id: "per-key", limit: 3, window: "1m", key: "apiKey" },
        {
          id: "per-key-route",
          limit: 2,
          window: "1m",
          key: ["apiKey", "route"],
          routes: ["/api/slow"],
        },
      ],
    });
    const decisions = await each(
      security,
      [1, 2, 3, 4].map((i) => keyed("k", `45.1.0.${i}`)),
    );
    expect(decisions.map((d) => d.action)).toEqual([
      "allow",
      "allow",
      "allow",
      "block",
    ]);
    expect(decisions[3]?.hits[0]?.rule).toBe("limit:per-key");
    expect((await security.evaluate(keyed("other", "45.1.0.1"))).action).toBe(
      "allow",
    );
  });

  it("take the key's plan from identify(): a plan's limit counts only keys on it", async () => {
    const { security } = engine({
      limits: [
        {
          id: "free",
          limit: 2,
          window: "1m",
          key: "apiKey",
          apiKeyPlan: "free",
        },
        { id: "pro", limit: 5, window: "1m", key: "apiKey", apiKeyPlan: "pro" },
      ],
    });
    const free = await each(
      security,
      [1, 2, 3].map(() => keyed("kf", "45.1.0.1", { apiKeyPlan: "free" })),
    );
    expect(free.map((d) => d.action)).toEqual(["allow", "allow", "block"]);
    const pro = await each(
      security,
      [1, 2, 3, 4, 5, 6].map(() =>
        keyed("kp", "45.1.0.1", { apiKeyPlan: "pro" }),
      ),
    );
    expect(pro.map((d) => d.action)).toEqual([
      "allow",
      "allow",
      "allow",
      "allow",
      "allow",
      "block",
    ]);
    // A key with no plan: neither counts it.
    const none = await each(
      security,
      [1, 2, 3, 4, 5, 6].map(() => keyed("kn", "45.1.0.1")),
    );
    expect(none.every((d) => d.action === "allow")).toBe(true);
    // Counted in the route stage only.
    expect(
      (
        await security.evaluate(
          keyed("kf2", "45.1.0.1", { apiKeyPlan: "free" }),
          { stage: "early" },
        )
      ).hits,
    ).toEqual([]);
    expect(() =>
      compilePolicy({
        limits: [{ id: "x", limit: 1, window: "1m", apiKeyPlan: "bad plan" }],
      }),
    ).toThrow(SecurityPolicyError);
  });
});

describe("the new-ASN anomaly", () => {
  it("learns a key's first ASN, tags a new one once, and lets a known one through", async () => {
    const { security } = engine({
      apiKeys: { newAsn: true },
      countedRules: [
        {
          id: "asn-hops",
          event: "apiKey.newAsn",
          threshold: 2,
          window: "1h",
          duration: "1h",
        },
      ],
    });
    const [first, again, moved, back, movedAgain] = await each(security, [
      keyed("k", "45.1.0.1"),
      keyed("k", "45.1.9.9"),
      keyed("k", "45.2.0.1"),
      keyed("k", "45.1.0.5"),
      keyed("k", "45.2.3.3"),
    ]);
    expect([first?.action, again?.action]).toEqual(["allow", "allow"]);
    expect(moved?.action).toBe("tag");
    expect(moved?.tags).toEqual(["api-key:new-asn"]);
    expect(moved?.hits[0]).toMatchObject({
      layer: "L12",
      rule: "apiKey.newAsn",
      action: "tag",
    });
    expect(moved?.hits[0]?.reason).toContain("AS2");
    expect([back?.action, movedAgain?.action]).toEqual(["allow", "allow"]);
    // Another key learns its own first ASN.
    expect((await security.evaluate(keyed("k2", "45.3.0.1"))).action).toBe(
      "allow",
    );
  });

  it("bans the key on `ban`, calls onKeyCompromised once with the key's id, and the ban holds everywhere", async () => {
    const { security, heard } = engine({
      apiKeys: { newAsn: { action: "ban", duration: "2h" } },
    });
    await each(security, [keyed("key_live_9", "45.1.0.1")]);
    const moved = await security.evaluate(keyed("key_live_9", "45.4.0.1"));
    expect(moved).toMatchObject({ action: "ban", status: 403 });
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({
      apiKey: "key_live_9",
      reason: "apiKey.newAsn",
    });
    expect(heard[0]?.ban?.subject.type).toBe("apiKey");
    expect(
      (await security.evaluate(keyed("key_live_9", "45.1.0.1"))).action,
    ).toBe("ban");
    expect((await security.evaluate(keyed("other", "45.4.0.1"))).action).toBe(
      "allow",
    );
    expect(heard).toHaveLength(1);
  });

  it("challenges, logs, and in dry run records what it would have done", async () => {
    const run = async (newAsn: object) => {
      const { security } = engine({ apiKeys: { newAsn } });
      await security.evaluate(keyed("k", "45.1.0.1"));
      return security.evaluate(keyed("k", "45.2.0.1"));
    };
    expect((await run({ action: "challenge" })).action).toBe("block"); // a challenge, without a flow
    expect((await run({ action: "log" })).hits[0]).toMatchObject({
      action: "log",
      rule: "apiKey.newAsn",
    });
    expect(
      (await run({ action: "ban", mode: "dryRun" })).hits[0],
    ).toMatchObject({ action: "log", wouldHaveBeen: "ban" });
    // Negative control: off.
    expect((await run({ mode: "off" })).hits).toEqual([]);
  });

  it("forgets a key's ASNs after `remember`", async () => {
    const clock = fakeClock();
    const { security } = engine(
      { apiKeys: { newAsn: { remember: "1d" } } },
      { clock },
    );
    await security.evaluate(keyed("k", "45.1.0.1"));
    clock.advance(86_400_000);
    // Forgotten: the next ASN is learned again, not an anomaly.
    expect((await security.evaluate(keyed("k", "45.2.0.1"))).action).toBe(
      "allow",
    );
  });

  it("needs an intel with ASNs", () => {
    expect(() =>
      createSecurity({
        policy: { apiKeys: { newAsn: true } },
        logger: () => {},
      }),
    ).toThrow(/uses asn/);
  });
});

describe("the many-addresses anomaly", () => {
  it("tags a key used from more than `limit` distinct addresses in the window", async () => {
    const { security } = engine({ apiKeys: { manyAddresses: { limit: 3 } } });
    const decisions = await each(
      security,
      [1, 2, 3, 3, 4, 5].map((i) => keyed("k", `45.1.0.${i}`)),
    );
    expect(decisions.map((d) => d.action)).toEqual([
      "allow",
      "allow",
      "allow",
      "allow",
      "tag",
      "tag",
    ]);
    expect(decisions[4]?.tags).toEqual(["api-key:many-addresses"]);
    expect(decisions[4]?.hits[0]?.reason).toContain("4 distinct addresses");
  });

  it("counts an IPv6 /64 as one address, and starts again in the next window", async () => {
    const clock = fakeClock();
    const { security } = engine(
      { apiKeys: { manyAddresses: { limit: 2, window: "1h" } } },
      { clock },
    );
    const v6 = await each(
      security,
      [1, 2, 3, 4].map((i) => keyed("k", `2001:db8:0:1::${i}`)),
    );
    expect(v6.every((d) => d.action === "allow")).toBe(true);
    await each(security, [keyed("k", "45.1.0.1"), keyed("k", "45.1.0.2")]);
    expect((await security.evaluate(keyed("k", "45.1.0.3"))).action).toBe(
      "tag",
    );
    clock.advance(3_600_000);
    expect((await security.evaluate(keyed("k", "45.1.0.4"))).action).toBe(
      "allow",
    );
  });

  it("takes identify()'s per-key limit, false for none", async () => {
    const { security } = engine({ apiKeys: { manyAddresses: { limit: 100 } } });
    const tight = await each(
      security,
      [1, 2, 3].map((i) =>
        keyed("t", `45.1.0.${i}`, { apiKeyMaxAddresses: 2 }),
      ),
    );
    expect(tight.map((d) => d.action)).toEqual(["allow", "allow", "tag"]);
    const mobile = engine({
      apiKeys: { manyAddresses: { limit: 2 } },
    }).security;
    const everywhere = await each(
      mobile,
      [1, 2, 3, 4].map((i) =>
        keyed("m", `45.1.0.${i}`, { apiKeyMaxAddresses: false }),
      ),
    );
    expect(everywhere.every((d) => d.action === "allow")).toBe(true);
  });

  it("counts its event once per key and window, however many requests are over", async () => {
    const { security } = engine({
      apiKeys: { manyAddresses: { limit: 1 } },
      countedRules: [
        {
          id: "many-twice",
          event: "apiKey.manyAddresses",
          threshold: 2,
          window: "1h",
          duration: "1h",
          key: "apiKey",
        },
      ],
    });
    const decisions = await each(
      security,
      [1, 2, 3, 4, 5].map((i) => keyed("k", `45.1.0.${i}`)),
    );
    expect(decisions.map((d) => d.action)).toEqual([
      "allow",
      "tag",
      "tag",
      "tag",
      "tag",
    ]);
    expect(security.bans()).toEqual([]);
  });

  it("on `ban`, suspends the key and tells the app once per window", async () => {
    const { security, heard } = engine({
      apiKeys: { manyAddresses: { limit: 2, action: "ban" } },
    });
    await each(security, [
      keyed("key_x", "45.1.0.1"),
      keyed("key_x", "45.1.0.2"),
    ]);
    expect((await security.evaluate(keyed("key_x", "45.1.0.3"))).action).toBe(
      "ban",
    );
    expect((await security.evaluate(keyed("key_x", "45.1.0.4"))).action).toBe(
      "ban",
    );
    expect(heard.map((e) => `${e.apiKey}:${e.reason}`)).toEqual([
      "key_x:apiKey.manyAddresses",
    ]);
  });
});

describe("revoke-and-ban", () => {
  it("bans the key at once, until lifted, and calls onKeyCompromised for the app to revoke it", async () => {
    const { security, heard } = engine({});
    const ban = security.revokeApiKey("key_leaked", {
      reason: "found on a paste site",
      by: "ops",
    });
    expect(ban).toMatchObject({
      source: "manual",
      expiresAt: null,
      reason: "found on a paste site",
      createdBy: "ops",
    });
    expect(heard).toEqual([
      {
        apiKey: "key_leaked",
        reason: "revoked",
        detail: "found on a paste site",
        ban,
        at: heard[0]?.at ?? 0,
      },
    ]);
    expect(
      (await security.evaluate(keyed("key_leaked", "45.9.0.1"))).action,
    ).toBe("ban");
    security.unban(ban.id);
    expect(
      (await security.evaluate(keyed("key_leaked", "45.9.0.1"))).action,
    ).toBe("allow");
    expect(() => security.revokeApiKey("")).toThrow(TypeError);
  });

  it("logs a hook that throws, and still bans", () => {
    const security = createSecurity({
      policy: {},
      logger: () => {},
      onKeyCompromised: () => {
        throw new Error("the app's hook failed");
      },
    });
    expect(security.revokeApiKey("k").subject.type).toBe("apiKey");
  });
});

describe("the apiKeys section's checks", () => {
  it("names every problem, with its path", () => {
    let paths: string[] = [];
    try {
      compilePolicy({
        apiKeys: {
          newAsn: { action: "suspend", remember: "1ms", limit: 3 },
          manyAddresses: { limit: 0, window: "nope", mode: "on" },
          other: true,
        } as never,
      });
    } catch (error) {
      paths = (error as SecurityPolicyError).issues.map((issue) =>
        issue.path.join("."),
      );
    }
    expect(paths).toEqual([
      "apiKeys.other",
      "apiKeys.newAsn.limit",
      "apiKeys.newAsn.action",
      "apiKeys.newAsn.remember",
      "apiKeys.manyAddresses.mode",
      "apiKeys.manyAddresses.window",
      "apiKeys.manyAddresses.limit",
    ]);
  });
});
