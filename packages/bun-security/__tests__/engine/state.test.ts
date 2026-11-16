/**
 * T-L9-2, a key-cardinality flood (layers.md L9.6, control-plane.md §9):
 * one attacker rotating keys (here, a new /64 per request) cannot grow the
 * engine's local state past `maxKeys`; evictions are counted; a
 * `state.evictions` warning is raised once, and cleared after a quiet
 * minute. The limiter's own memory store is bounded by the same `maxKeys`.
 */
import { describe, expect, it } from "bun:test";
import { ConfigError, memoryThrottleStore } from "@kingsleyweb/bun-common";
import { BanTable } from "../../lib/engine/bans";
import { createSecurity } from "../../lib/index";
import type {
  Decision,
  RequestFacts,
  Security,
  SecurityPolicy,
  SecurityWarning,
} from "../../lib/index";
import { facts, fakeClock } from "../helpers";

/** `evaluate()`, required to be synchronous (the memory store). */
function decide(
  security: Security,
  request: RequestFacts,
  track = false,
): Decision {
  const decision = security.evaluate(request, { track });
  if (decision instanceof Promise) throw new Error("expected synchronous");
  return decision;
}

/** A fresh /64 per index. */
const rotating = (i: number) =>
  `2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::1`;

describe("T-L9-2: a key-cardinality flood", () => {
  const POLICY: SecurityPolicy = {
    countedRules: [
      {
        id: "any",
        event: "request",
        threshold: 1,
        window: "1m",
        duration: "1h",
      },
    ],
  };

  it("keeps scores within maxKeys, counts the evictions and warns once", () => {
    const clock = fakeClock();
    const warnings: SecurityWarning[] = [];
    const store = memoryThrottleStore({ maxKeys: 100, now: clock.now });
    const security = createSecurity({
      // Every request scores its address; no step is ever reached.
      policy: {
        ladder: {
          weights: { request: 1 },
          steps: [{ score: 1_000, action: "ban" }],
        },
      },
      now: clock.now,
      logger: () => {},
      maxKeys: 100,
      throttleStore: store,
      onWarning: (warning) => warnings.push(warning),
    });
    for (let i = 0; i < 1_000; i++) {
      expect(decide(security, facts({ client: rotating(i) })).action).toBe(
        "allow",
      );
    }
    const state = security.status().state;
    expect(state.scores).toBe(100);
    expect(state.evictions).toBe(900);
    expect(store.size).toBeLessThanOrEqual(100);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: "state.evictions",
      minutes: 1,
    });
    expect(warnings[0]?.message).toContain("the scores table");
    expect(state.warning).toBe(warnings[0]);

    // A quiet minute clears the warning; a new flood raises it again.
    clock.advance(2 * 60_000);
    expect(security.status().state.warning).toBeUndefined();
    for (let i = 1_000; i < 1_200; i++) {
      decide(security, facts({ client: rotating(i) }));
    }
    expect(warnings).toHaveLength(2);
  });

  it("widens bans past bans.maxActive: a rotation inside one /48 ends as one range ban", () => {
    const clock = fakeClock();
    const warnings: SecurityWarning[] = [];
    const security = createSecurity({
      policy: { ...POLICY, ladder: false, bans: { maxActive: 100 } },
      now: clock.now,
      logger: () => {},
      onWarning: (warning) => warnings.push(warning),
    });
    const hits = Array.from({ length: 1_000 }, (_, i) =>
      decide(security, facts({ client: rotating(i) })),
    );
    expect(hits.every((decision) => decision.action === "ban")).toBe(true);
    // The first 100 were banned one by one; the 101st widened to its /48,
    // which refuses every later one at L4, before anything is counted.
    expect(hits[100]?.hits.map((hit) => hit.rule)).toEqual(["counted:any"]);
    expect(hits[101]?.hits.map((hit) => hit.rule)).toEqual([
      "ban:cidr:2001:db8::/48",
    ]);
    expect(security.status().state).toMatchObject({ bans: 101, trips: 101 });
    expect(warnings.map((warning) => warning.kind)).toEqual([
      "bans.aggregated",
    ]);
    // A manual ban is never dropped or widened.
    expect(security.ban({ ip: "203.0.113.77" }).id).toBe("ip:203.0.113.77");
    expect(security.status().state.bans).toBe(102);
  });

  it("drops an automatic ban that cannot be widened past bans.maxActive, and counts it", () => {
    const security = createSecurity({
      policy: {
        ladder: false,
        bans: { maxActive: 2 },
        countedRules: [
          {
            id: "u",
            event: "pattern.hit",
            threshold: 1,
            window: "1m",
            duration: "1h",
            key: "user",
          },
        ],
      },
      logger: () => {},
    });
    // A user ban has no range to widen to: past the bound it is dropped.
    for (const user of ["a", "b", "c", "d", "e"]) {
      const hits = security.signal(
        facts({ identity: { user } }),
        "pattern.hit",
      );
      if (hits instanceof Promise) throw new Error("expected synchronous");
    }
    expect(security.status().state).toMatchObject({ bans: 2, bansDropped: 3 });
    // A manual ban still fits past the bound.
    security.ban({ user: "f" });
    expect(security.status().state).toMatchObject({ bans: 3, bansDropped: 3 });
  });

  it("widens address bans into 1,024 ranges of slack past bans.maxActive, then drops and counts them", () => {
    // On the table itself: through the engine, every new range would cost the
    // next request a rebuild of the ranges' trie, which is the slow part of
    // a flood this size and not what this test is about.
    const table = new BanTable(() => 1);
    const now = Date.UTC(2026, 10, 16);
    const outcomes = Array.from({ length: 1_030 }, (_, i) =>
      table.add(
        {
          // 1,030 addresses, each in a /24 of its own.
          subject: {
            type: "ip",
            value: `${Math.floor(i / 256) + 1}.${i % 256}.0.1`,
          },
          action: "ban",
          reason: "flood",
          source: "auto",
          expiresAt: now + 3_600_000,
        },
        now,
      ),
    );
    expect(outcomes[0]).toMatchObject({
      aggregated: false,
      ban: { id: "ip:1.0.0.1" },
    });
    expect(outcomes[1]).toMatchObject({
      aggregated: true,
      ban: { id: "cidr:1.1.0.0/24" },
    });
    expect(outcomes.filter((outcome) => outcome.aggregated)).toHaveLength(
      1_024,
    );
    expect(
      outcomes.filter((outcome) => outcome.ban === undefined),
    ).toHaveLength(5);
    expect(table.size).toBe(1 + 1_024);
    expect(table.dropped).toBe(5);
    // Negative control: one more address in a range already held merges, never drops.
    expect(
      table.add(
        {
          subject: { type: "ip", value: "1.1.0.99" },
          action: "ban",
          reason: "flood",
          source: "auto",
          expiresAt: now + 3_600_000,
        },
        now,
      ),
    ).toMatchObject({
      aggregated: true,
      ban: { id: "cidr:1.1.0.0/24", count: 2 },
    });
    expect(table.dropped).toBe(5);
  });

  it("negative control: under the bound nothing is evicted and nothing warns", () => {
    const warnings: SecurityWarning[] = [];
    const security = createSecurity({
      policy: POLICY,
      logger: () => {},
      maxKeys: 2_000,
      onWarning: (warning) => warnings.push(warning),
    });
    for (let i = 0; i < 1_000; i++)
      decide(security, facts({ client: rotating(i) }));
    expect(security.status().state).toMatchObject({
      trips: 1_000,
      evictions: 0,
    });
    expect(warnings).toEqual([]);
  });

  it("bounds in-flight slots too, when complete() is never called", () => {
    const warnings: SecurityWarning[] = [];
    const security = createSecurity({
      policy: {},
      logger: () => {},
      maxKeys: 50,
      onWarning: (warning) => warnings.push(warning),
    });
    for (let i = 0; i < 500; i++)
      decide(security, facts({ client: rotating(i) }), true);
    expect(security.status().state).toMatchObject({
      inFlight: 50,
      inFlightClients: 50,
      evictions: 450,
    });
    expect(warnings[0]?.message).toContain("in-flight");
  });

  it("refuses a maxKeys that is not a positive whole number, and a store that is not one", () => {
    for (const maxKeys of [0, -1, 1.5, Number.NaN]) {
      expect(() => createSecurity({ policy: {}, maxKeys })).toThrow(
        ConfigError,
      );
    }
    expect(() =>
      createSecurity({
        policy: {},
        throttleStore: { name: "x" } as unknown as ReturnType<
          typeof memoryThrottleStore
        >,
      }),
    ).toThrow(/throttleStore/);
  });

  it("close() lets go of the state", () => {
    const security = createSecurity({ policy: POLICY, logger: () => {} });
    decide(security, facts(), true);
    security.close();
    expect(security.status().state).toMatchObject({
      trips: 0,
      bans: 0,
      inFlight: 0,
    });
  });
});
