/**
 * Layer L1's request counts (layers.md L1): in flight per client address
 * (`429`, default 64) and in all (`503`, off by default), for tracked
 * requests only, given back by `complete()`, and expired after
 * `releaseAfter` when a `complete()` is lost.
 */
import { describe, expect, it } from "bun:test";
import { createSecurity } from "../../lib/index";
import type { Decision, RequestFacts, SecurityPolicy } from "../../lib/index";
import { facts, fakeClock } from "../helpers";
import type { FakeClock } from "../helpers";

/** An engine on a fake clock, quiet. */
function engine(
  policy: SecurityPolicy,
  clock: FakeClock = fakeClock(),
  maxKeys?: number,
) {
  return createSecurity({
    policy,
    now: clock.now,
    logger: () => {},
    ...(maxKeys === undefined ? {} : { maxKeys }),
  });
}
type Engine = ReturnType<typeof engine>;

/** A tracked, synchronous `evaluate()`. */
function track(security: Engine, request: RequestFacts = facts()): Decision {
  const decision = security.evaluate(request, { track: true });
  if (decision instanceof Promise) throw new Error("expected synchronous");
  return decision;
}

/** `complete()` with a 200. */
function done(
  security: Engine,
  request: RequestFacts,
  decision: Decision,
): void {
  const hits = security.complete(request, decision, { status: 200 });
  if (hits instanceof Promise) throw new Error("expected synchronous");
}

describe("in flight per client address", () => {
  it("allows 64 by default, refuses the 65th with 429, and lets one in when one completes", () => {
    const security = engine({});
    const held = Array.from({ length: 64 }, () => track(security));
    expect(held.every((d) => d.action === "allow")).toBe(true);
    expect(security.status().state).toMatchObject({
      inFlight: 64,
      inFlightClients: 1,
    });
    const refused = track(security);
    expect(refused).toMatchObject({
      action: "block",
      status: 429,
      code: "rate_limited",
      retryAfter: 1,
    });
    expect(refused.hits).toEqual([
      {
        layer: "L1",
        rule: "concurrency:per-ip",
        action: "block",
        reason: "in-flight per address: 64 of 64",
      },
    ]);
    // A refused request holds no slot.
    expect(security.status().state.inFlight).toBe(64);
    // Another address is unaffected.
    expect(track(security, facts({ client: "203.0.113.11" })).action).toBe(
      "allow",
    );
    const first = held[0];
    if (first === undefined) throw new Error("no decision");
    done(security, facts(), first);
    expect(track(security).action).toBe("allow");
  });

  it("counts an IPv6 /64 as one address", () => {
    const security = engine({ concurrency: { perIp: 2 } });
    expect(track(security, facts({ client: "2001:db8:5:6::1" })).action).toBe(
      "allow",
    );
    expect(track(security, facts({ client: "2001:db8:5:6::2" })).action).toBe(
      "allow",
    );
    expect(track(security, facts({ client: "2001:db8:5:6::3" })).action).toBe(
      "block",
    );
  });

  it("does not apply to untracked requests: a caller that never completes locks nobody out", () => {
    const security = engine({ concurrency: { perIp: 1 } });
    for (let i = 0; i < 10; i++) {
      const decision = security.evaluate(facts());
      if (decision instanceof Promise) throw new Error("expected synchronous");
      expect(decision.action).toBe("allow");
    }
    expect(security.status().state.inFlight).toBe(0);
  });

  it("gives a slot back only once", () => {
    const security = engine({ concurrency: { perIp: 2 } });
    const a = track(security);
    track(security);
    done(security, facts(), a);
    done(security, facts(), a);
    expect(security.status().state.inFlight).toBe(1);
    expect(track(security).action).toBe("allow");
    expect(track(security).action).toBe("block");
  });

  it("expires a slot whose complete() was lost, after releaseAfter", () => {
    const clock = fakeClock();
    const security = engine(
      { concurrency: { perIp: 1, releaseAfter: "30s" } },
      clock,
    );
    track(security);
    expect(track(security).action).toBe("block");
    clock.advance(30_001);
    expect(track(security).action).toBe("allow");
  });

  it("spares internal, allow-listed and verified-service-exempt clients; dry run only logs", () => {
    const security = engine({
      concurrency: { perIp: 1 },
      lists: [{ ip: "198.51.100.0/24", action: "allow" }],
    });
    for (const client of ["10.0.0.1", "198.51.100.1"]) {
      expect([
        track(security, facts({ client })).action,
        track(security, facts({ client })).action,
      ]).toEqual(["allow", "allow"]);
    }
    const dry = engine({ concurrency: { perIp: 1, mode: "dryRun" } });
    track(dry);
    const logged = track(dry);
    expect(logged.action).toBe("log");
    expect(logged.hits[0]).toMatchObject({
      rule: "concurrency:per-ip",
      wouldHaveBeen: "block",
    });
  });

  it("is off with concurrency: false", () => {
    const security = engine({ concurrency: false });
    for (let i = 0; i < 100; i++) expect(track(security).action).toBe("allow");
    expect(security.status().state.inFlight).toBe(0);
  });
});

describe("the in-flight cap (load shedding)", () => {
  it("refuses everyone past it with 503 and Retry-After, internal clients included", () => {
    const security = engine({ concurrency: { perIp: false, total: 3 } });
    const clients = ["203.0.113.1", "203.0.113.2", "10.0.0.3"];
    const held = clients.map((client) => track(security, facts({ client })));
    expect(held.map((d) => d.action)).toEqual(["allow", "allow", "allow"]);
    for (const client of ["203.0.113.9", "10.0.0.9"]) {
      expect(track(security, facts({ client }))).toMatchObject({
        action: "block",
        status: 503,
        code: "unavailable",
        retryAfter: 1,
      });
    }
    const first = held[0];
    if (first === undefined) throw new Error("no decision");
    done(security, facts({ client: "203.0.113.1" }), first);
    expect(track(security, facts({ client: "203.0.113.9" })).action).toBe(
      "allow",
    );
  });

  it("is checked before the lists, so a shed request costs no list lookup", () => {
    const security = engine({
      concurrency: { perIp: false, total: 1 },
      lists: [{ ip: "203.0.113.0/24", action: "block" }],
    });
    track(security, facts({ client: "198.51.100.1" }));
    expect(track(security).hits.map((hit) => hit.rule)).toEqual([
      "concurrency:total",
    ]);
  });

  it("is explained as for a tracked request, with no slot taken", () => {
    const security = engine({ concurrency: { perIp: false, total: 1 } });
    const explained = security.explain(facts());
    if (explained instanceof Promise) throw new Error("expected synchronous");
    expect(explained.decision.action).toBe("allow");
    track(security, facts({ client: "198.51.100.1" }));
    const shed = security.explain(facts());
    if (shed instanceof Promise) throw new Error("expected synchronous");
    expect(shed.decision).toEqual(track(security));
    expect(security.status().state.inFlight).toBe(1);
  });
});
