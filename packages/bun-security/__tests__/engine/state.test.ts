/**
 * T-L9-2, a key-cardinality flood (layers.md L9.6, control-plane.md §9):
 * one attacker rotating keys (here, a new /64 per request) cannot grow the
 * engine's local state past `maxKeys`; evictions are counted; a
 * `state.evictions` warning is raised once, and cleared after a quiet
 * minute. The limiter's own memory store is bounded by the same `maxKeys`.
 */
import { describe, expect, it } from "bun:test";
import { ConfigError, memoryThrottleStore } from "@kingsleyweb/bun-common";
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

  it("keeps trips within maxKeys, counts the evictions and warns once", () => {
    const clock = fakeClock();
    const warnings: SecurityWarning[] = [];
    const store = memoryThrottleStore({ maxKeys: 100, now: clock.now });
    const security = createSecurity({
      policy: POLICY,
      now: clock.now,
      logger: () => {},
      maxKeys: 100,
      throttleStore: store,
      onWarning: (warning) => warnings.push(warning),
    });
    for (let i = 0; i < 1_000; i++) {
      expect(decide(security, facts({ client: rotating(i) }))).toMatchObject({
        action: "ban",
      });
    }
    const state = security.status().state;
    expect(state.trips).toBe(100);
    expect(state.evictions).toBe(900);
    expect(store.size).toBeLessThanOrEqual(100);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: "state.evictions",
      minutes: 1,
    });
    expect(warnings[0]?.message).toContain("counted-rule trips");
    expect(state.warning).toBe(warnings[0]);
    // The newest keys are still tripped; the oldest were pushed out.
    expect(decide(security, facts({ client: rotating(999) }))).toMatchObject({
      action: "ban",
    });

    // A quiet minute clears the warning; a new flood raises it again.
    clock.advance(2 * 60_000);
    expect(security.status().state.warning).toBeUndefined();
    for (let i = 1_000; i < 1_200; i++)
      decide(security, facts({ client: rotating(i) }));
    expect(warnings).toHaveLength(2);
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
    expect(security.status().state).toMatchObject({ trips: 0, inFlight: 0 });
  });
});
