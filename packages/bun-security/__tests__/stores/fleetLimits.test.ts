/**
 * Limits, counted rules and offence scores across engines sharing a store
 * (topologies.md §3.2, §6.1): `shared` exact across engines, `local` per
 * engine, `hybrid` within its bound; a failing store degrades each limit as
 * its `onStoreError` says (`local` at its share, `open`, `closed` → 503);
 * counted rules count across engines and fall back to their local share;
 * offence scores sync, so offences on two engines add up on the ladder.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { ConfigError } from "@kingsleyweb/bun-common";
import { createSecurity } from "../../lib/index";
import type {
  CountedRule,
  Decision,
  LimitRule,
  Security,
  SecurityPolicy,
} from "../../lib/index";
import { facts, fakeClock } from "../helpers";
import { fleet, quiet } from "./fleet";
import type { Fleet } from "./fleet";

const open: Fleet[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});

/** A fleet, closed after the test. */
function make(...args: Parameters<typeof fleet>): Fleet {
  const f = fleet(...args);
  open.push(f);
  return f;
}

/** The fleet's engines. */
function engines(f: Fleet): Security[] {
  return f.members.map((member) => member.security);
}

/** The actions of `n` requests from `client`, round-robin over `list`. */
async function drive(
  list: readonly Security[],
  n: number,
  client = "198.51.100.20",
): Promise<Decision["action"][]> {
  const actions: Decision["action"][] = [];
  for (let i = 0; i < n; i++) {
    const engine = list[i % list.length];
    if (engine === undefined) throw new Error("no engine");
    actions.push((await engine.evaluate(facts({ client }))).action);
  }
  return actions;
}

/** A policy of one limit, `limit` per minute per address. */
function limitPolicy(
  limit: number,
  extra: Partial<LimitRule> = {},
  nodes?: number,
): SecurityPolicy {
  return {
    ...(nodes === undefined ? {} : { state: { nodes } }),
    limits: [{ id: "per-ip", limit, window: "1m", ...extra }],
  };
}

describe("where a limit counts", () => {
  it("shared (the default with a store): exact across engines", async () => {
    const f = make(3, limitPolicy(5));
    expect(await drive(engines(f), 8)).toEqual([
      ...Array.from({ length: 5 }, (): Decision["action"] => "allow"),
      "block",
      "block",
      "block",
    ]);
  });

  it("local: each engine counts alone (the negative control for shared)", async () => {
    const f = make(3, limitPolicy(5, { state: "local" }));
    const actions = await drive(engines(f), 15);
    expect(actions.every((action) => action === "allow")).toBe(true);
    expect(await drive(engines(f), 3)).toEqual(["block", "block", "block"]);
  });

  it("hybrid: counts here at once, and holds across engines once synced", async () => {
    const f = make(2, limitPolicy(10, { state: "hybrid" }));
    const [a, b] = engines(f);
    if (a === undefined || b === undefined) throw new Error("two");
    // Before a sync each engine sees its own count only: 6 + 6 pass a 10.
    expect((await drive([a], 6)).every((x) => x === "allow")).toBe(true);
    expect((await drive([b], 6)).every((x) => x === "allow")).toBe(true);
    await Promise.all([a.flush(), b.flush()]);
    await Promise.all([a.flush(), b.flush()]);
    // Synced: both see 12 of 10.
    expect(await drive([a, b], 2)).toEqual(["block", "block"]);
    // The overshoot is what was counted between syncs, bounded.
    const decision = a.evaluate(facts({ client: "198.51.100.20" }));
    expect(decision).not.toBeInstanceOf(Promise);
  });

  it("refuses shared or hybrid limits, and shared counted rules, without a store", () => {
    for (const policy of [
      limitPolicy(5, { state: "shared" }),
      limitPolicy(5, { state: "hybrid" }),
      {
        state: { mode: "shared" as const },
        limits: [{ id: "x", limit: 1, window: "1m" }],
      },
      {
        countedRules: [
          {
            id: "c",
            event: "request",
            threshold: 1,
            window: "1m",
            duration: "1h",
            state: "shared" as const,
          },
        ],
      },
    ]) {
      expect(() => createSecurity({ policy, logger: quiet })).toThrow(
        ConfigError,
      );
    }
    const security = createSecurity({ policy: {}, logger: quiet });
    expect(() => security.load(limitPolicy(5, { state: "shared" }))).toThrow(
      ConfigError,
    );
    expect(security.policy.source).toEqual({});
  });
});

describe("onStoreError", () => {
  it("local (the default): each engine counts at its local share while the store fails, and shared again once it answers", async () => {
    const clock = fakeClock();
    const f = make(2, limitPolicy(6, {}, 2), {
      security: { now: clock.now },
      store: { now: clock.now },
    });
    const [a, b] = engines(f);
    if (a === undefined || b === undefined) throw new Error("two");
    f.driver.setFaults({ down: true });
    // The share: 6 ÷ 2 nodes = 3 per engine.
    expect(await drive([a], 4)).toEqual(["allow", "allow", "allow", "block"]);
    const refused = await a.evaluate(facts({ client: "198.51.100.20" }));
    expect(refused.hits[0]?.reason).toContain("local share");
    expect(await drive([b], 4)).toEqual(["allow", "allow", "allow", "block"]);
    f.driver.setFaults({});
    clock.advance(30_000);
    // Back on the shared count (a new window: 30 s on, same minute or not).
    const after = await drive([a, b], 1, "198.51.100.21");
    expect(after).toEqual(["allow"]);
    expect(a.status().state.store?.healthy).toBe(true);
  });

  it("open: lets requests through uncounted, recording the failure", async () => {
    const f = make(1, limitPolicy(1, { onStoreError: "open" }));
    const [a] = engines(f);
    f.driver.setFaults({ down: true });
    const decisions = await Promise.all(
      [1, 2, 3].map(() => a?.evaluate(facts({ client: "198.51.100.22" }))),
    );
    for (const decision of decisions) {
      expect(decision?.action).toBe("log");
      expect(decision?.hits[0]).toMatchObject({
        rule: "limit:per-ip",
        action: "log",
        reason: "the shared store failed: onStoreError open",
      });
    }
  });

  it("closed: refuses 503 with Retry-After; in dry run only records it", async () => {
    const f = make(1, limitPolicy(1, { onStoreError: "closed" }));
    const [a] = engines(f);
    f.driver.setFaults({ down: true });
    const decision = await a?.evaluate(facts({ client: "198.51.100.23" }));
    expect(decision).toMatchObject({
      action: "block",
      status: 503,
      code: "unavailable",
      retryAfter: 5,
    });
    a?.load(limitPolicy(1, { onStoreError: "closed", mode: "dryRun" }));
    const dry = await a?.evaluate(facts({ client: "198.51.100.23" }));
    expect(dry?.action).toBe("log");
    expect(dry?.hits[0]?.wouldHaveBeen).toBe("block");
  });

  it("the policy's state.onStoreError is every limit's default", async () => {
    const f = make(1, {
      state: { onStoreError: "closed" },
      limits: [{ id: "x", limit: 5, window: "1m" }],
    });
    const [a] = engines(f);
    f.driver.setFaults({ down: true });
    expect((await a?.evaluate(facts()))?.status).toBe(503);
  });

  it("explain() reads the local share when the store fails", async () => {
    const f = make(1, limitPolicy(4, {}, 4));
    const [a] = engines(f);
    f.driver.setFaults({ down: true });
    const explained = await a?.explain(facts({ client: "198.51.100.24" }));
    expect(
      explained?.steps.find((step) => step.rule === "limit:per-ip")?.outcome,
    ).toContain("1 of 1 in 1m (the local share");
  });
});

describe("counted rules across engines", () => {
  const rule: CountedRule = {
    id: "c",
    event: "auth.failure",
    threshold: 4,
    window: "15m",
    duration: "1h",
  };
  const counted: SecurityPolicy = { state: { nodes: 2 }, countedRules: [rule] };

  it("count in the shared store; local state counts per engine", async () => {
    const f = make(2, counted);
    const [a, b] = engines(f);
    if (a === undefined || b === undefined) throw new Error("two");
    const client = facts({ client: "198.51.100.30" });
    for (const engine of [a, b, a]) {
      expect(await engine.signal(client, "auth.failure")).toEqual([]);
    }
    const trip = await b.signal(client, "auth.failure");
    expect(trip.map((hit) => hit.rule)).toEqual(["counted:c"]);
    const local = make(2, {
      countedRules: [{ ...rule, state: "local" as const }],
    });
    const [c, d] = engines(local);
    if (c === undefined || d === undefined) throw new Error("two");
    for (const engine of [c, d, c, d]) {
      expect(await engine.signal(client, "auth.failure")).toEqual([]);
    }
  });

  it("fall back to the threshold's local share when the store fails, or count nothing with onStoreError open", async () => {
    const f = make(1, counted);
    const [a] = engines(f);
    f.driver.setFaults({ down: true });
    const client = facts({ client: "198.51.100.31" });
    expect(await a?.signal(client, "auth.failure")).toEqual([]);
    const trip = await a?.signal(client, "auth.failure");
    expect(trip?.map((hit) => hit.rule)).toEqual(["counted:c"]);
    const openRule = make(1, {
      countedRules: [
        {
          ...rule,
          threshold: 1,
          onStoreError: "open" as const,
        },
      ],
    });
    const [b] = engines(openRule);
    openRule.driver.setFaults({ down: true });
    expect(await b?.signal(client, "auth.failure")).toEqual([]);
  });
});

describe("offence scores across engines", () => {
  const ladder: SecurityPolicy = {
    ladder: {
      steps: [{ score: 10, action: "ban", duration: "1h" }],
      weights: { "probe.hit": 4 },
    },
  };

  it("offences on two engines add up once synced (the negative control: not before)", async () => {
    const f = make(2, ladder);
    const [a, b] = engines(f);
    if (a === undefined || b === undefined) throw new Error("two");
    const client = facts({ client: "198.51.100.40" });
    await a.signal(client, "probe.hit");
    await a.signal(client, "probe.hit");
    // b scores 4 alone: no ban.
    expect(await b.signal(client, "probe.hit")).toEqual([]);
    await a.flush();
    await b.flush();
    // b now holds 4 + 8 (and a's view the same); the next offence bans.
    const hits = await b.signal(client, "probe.hit");
    expect(hits.map((hit) => hit.rule)).toEqual(["ladder"]);
    expect(hits[0]?.action).toBe("ban");
  });

  it("a ban resets the score everywhere once synced", async () => {
    const f = make(2, ladder);
    const [a, b] = engines(f);
    if (a === undefined || b === undefined) throw new Error("two");
    const client = facts({ client: "198.51.100.41" });
    for (let i = 0; i < 2; i++) await b.signal(client, "probe.hit");
    await b.flush();
    for (let i = 0; i < 3; i++) await a.signal(client, "probe.hit");
    await a.flush();
    await b.flush();
    // a bans at its third offence (12 > 10) and resets; the unban resets
    // again; b, which scored this key lately, reads the reset back.
    a.unban("ip:198.51.100.41");
    await a.flush();
    await b.flush();
    expect(await b.signal(client, "probe.hit")).toEqual([]);
  });

  it("the ladder's ban history is shared: a second ban on another engine escalates", async () => {
    const clock = fakeClock();
    const policy: SecurityPolicy = {
      ladder: {
        steps: [{ score: 1, action: "ban" }],
        weights: { "probe.hit": 1 },
        base: "1h",
        factor: 6,
      },
    };
    const f = make(2, policy, {
      security: { now: clock.now },
      store: { now: clock.now },
    });
    const [a, b] = engines(f);
    if (a === undefined || b === undefined) throw new Error("two");
    const client = facts({ client: "198.51.100.42" });
    await a.signal(client, "probe.hit");
    const first = a.bans()[0];
    expect(first?.expiresAt).toBe(clock.now() + 3_600_000);
    await a.flush();
    a.unban("ip:198.51.100.42");
    await a.flush();
    await b.flush();
    clock.advance(60_000);
    await b.signal(client, "probe.hit");
    await b.flush();
    // b learnt of a's ban at its own ban's sync; the next ban is the third.
    b.unban("ip:198.51.100.42");
    await b.flush();
    clock.advance(60_000);
    await b.signal(client, "probe.hit");
    const third = b.bans().find((ban) => ban.id === "ip:198.51.100.42");
    expect(third?.expiresAt).toBe(clock.now() + 36 * 3_600_000);
  });
});
