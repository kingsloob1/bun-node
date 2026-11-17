/**
 * The draft impact estimate (PR-CP7): stored events replayed through the
 * published policy and the draft. What changed by class, rule, route and
 * subject; every rule labelled honestly (a body rule is not evaluated);
 * account subjects taken as keys (account lists exact); sampled allows
 * counted unscaled with their rate; redacted per event to the caller;
 * bounded (window, events, time, services) and stopped when the caller
 * goes; one estimate per operator at a time and 6 a minute across the
 * instances. Each with its negative control.
 */
import type { SecurityEvent } from "../../lib/store/index";
import { describe, expect, it } from "bun:test";
import { estimateImpact } from "../../lib/control/impact";
import { memoryStore } from "../../lib/store/index";
import { Keyring } from "../../lib/sensitive/keys";
import { fakeClock } from "../helpers";
import { FLEET_SECRET, testApi } from "./helpers";

const keys = new Keyring(FLEET_SECRET);
const ALICE = keys.user("alice");

/** An API with group payments (service pay) and service shop; `extra` merged in. */
async function setup(extra: Parameters<typeof testApi>[0] = {}) {
  const t = testApi(extra);
  if ((await t.store.get("group", "payments")) === undefined) {
    await t.call("POST", "/groups", { id: "payments", name: "Payments" });
    await t.call("POST", "/services", {
      id: "pay",
      name: "Pay",
      groups: ["payments"],
    });
    await t.call("POST", "/services", { id: "shop", name: "Shop" });
  }
  return t;
}

/** Saves `policy` as `scope`'s draft. */
async function draft(
  t: Awaited<ReturnType<typeof setup>>,
  scope: string,
  policy: unknown,
) {
  const head = await t.call("GET", `/policies/${scope}`);
  const saved = await t.call("PUT", `/policies/${scope}/draft`, {
    policy,
    revision: head.body?.draft?.revision ?? null,
  });
  expect(saved.status).toBeLessThan(300);
}

let seq = 0;
/** An event of `service`, `minutesAgo` before now. */
function event(
  t: Awaited<ReturnType<typeof setup>>,
  service: string,
  over: Partial<SecurityEvent> = {},
  minutesAgo = 5,
): SecurityEvent {
  seq += 1;
  return {
    id: `ev${seq}`,
    at: t.clock.now() - minutesAgo * 60_000,
    service,
    action: "allow",
    route: "GET /orders",
    subjects: { ip: "203.0.113.5" },
    sample: {
      method: "GET",
      path: "/orders",
      headers: { "user-agent": "curl" },
    },
    ...over,
  };
}

/** Stores `events`. */
async function store(
  t: Awaited<ReturnType<typeof setup>>,
  events: SecurityEvent[],
) {
  for (let i = 0; i < events.length; i += 1_000) {
    await t.store.appendEvents!(`b${seq}-${i}`, events.slice(i, i + 1_000));
  }
}

describe("what a draft changes", () => {
  it("counts the change by class, rule, route and subject, with sample ids; nothing else changes", async () => {
    const t = await setup();
    await store(t, [
      ...Array.from({ length: 12 }, () => event(t, "pay")),
      event(t, "pay", { subjects: { ip: "192.0.2.9" }, route: "GET /cart" }),
      event(t, "shop"),
    ]);
    await draft(t, "group:payments", {
      lists: [{ id: "bad", ip: "203.0.113.5", action: "block" }],
    });
    const impact = await t.call("POST", "/policies/group:payments/impact", {});
    expect(impact.status).toBe(200);
    expect(impact.body.services).toEqual({ replayed: ["pay"], skipped: [] });
    expect(impact.body.events).toEqual({ read: 13, stoppedBy: null });
    expect(impact.body.transitions).toEqual([
      { from: "allow", to: "refuse", count: 12 },
    ]);
    expect(impact.body.rules).toEqual([
      { rule: "bad", newlyHit: 12, noLongerHit: 0, samples: expect.any(Array) },
    ]);
    expect(impact.body.rules[0].samples).toHaveLength(10);
    expect(impact.body.routes).toEqual([{ route: "GET /orders", changed: 12 }]);
    expect(impact.body.subjects).toEqual({ ip: 1 });
    expect(impact.body.labels).toContainEqual({
      rule: "lists",
      label: "exact",
    });
    // Nothing stored: the store's feed holds only the draft's write.
    const head = (await t.store.changesSince(0n, 1)).head;
    await t.call("POST", "/policies/group:payments/impact", {});
    expect((await t.store.changesSince(0n, 1)).head).toBe(head);
  });

  it("the control: a draft that changes nothing reports nothing", async () => {
    const t = await setup();
    await store(
      t,
      Array.from({ length: 5 }, () => event(t, "pay")),
    );
    await draft(t, "group:payments", {
      lists: [{ ip: "198.51.100.1", action: "block" }],
    });
    const impact = await t.call("POST", "/policies/group:payments/impact", {});
    expect(impact.body.transitions).toEqual([]);
    expect(impact.body.rules).toEqual([]);
    expect(impact.body.events.read).toBe(5);
  });

  it("matches account lists exactly on the events' keyed subjects", async () => {
    const t = await setup();
    await store(t, [
      event(t, "pay", { subjects: { ip: "192.0.2.1", user: ALICE } }),
      event(t, "pay", {
        subjects: { ip: "192.0.2.2", user: keys.user("bob") },
      }),
    ]);
    await draft(t, "service:pay", {
      lists: [{ user: "alice", action: "block" }],
    });
    const impact = await t.call("POST", "/policies/service:pay/impact", {});
    expect(impact.body.transitions).toEqual([
      { from: "allow", to: "refuse", count: 1 },
    ]);
    expect(impact.body.subjects).toEqual({ ip: 1, user: 1 });
  });

  it("labels every rule honestly: a body rule and a limit are not evaluated, a header rule partial, a method rule exact", async () => {
    const t = await setup();
    await store(t, [event(t, "pay")]);
    await draft(t, "service:pay", {
      shape: { maxBodySize: 1_024 },
      limits: [{ id: "tight", limit: 1, window: "1m" }],
      requestRules: {
        rules: [
          {
            id: "by-header",
            when: { header: "user-agent", contains: "curl" },
            action: "block",
          },
          {
            id: "by-method",
            when: { method: { equals: "TRACE" } },
            action: "block",
          },
          {
            id: "by-length",
            when: { contentLength: { gt: 100 } },
            action: "block",
          },
        ],
      },
    });
    const impact = await t.call("POST", "/policies/service:pay/impact", {});
    const label = (rule: string) =>
      impact.body.labels.find((l: any) => l.rule === rule)?.label;
    expect(label("shape.body")).toBe("not-evaluated");
    expect(label("rule:by-length")).toBe("not-evaluated");
    expect(label("limit:tight")).toBe("not-evaluated");
    expect(label("rule:by-header")).toBe("partial");
    expect(label("rule:by-method")).toBe("exact");
    // The partial rule did evaluate on the sample's (unredacted) user agent.
    expect(impact.body.rules.map((r: any) => r.rule)).toContain(
      "rule:by-header",
    );
  });

  it("counts sampled allows as sampled, unscaled, and states their rate", async () => {
    const t = await setup();
    await store(t, [
      event(t, "pay", { sampleRate: 0.001 }),
      event(t, "pay", { sampleRate: 0.001 }),
      event(t, "pay", { action: "block", rule: "x" }),
    ]);
    await draft(t, "service:pay", {
      lists: [{ ip: "203.0.113.5", action: "block" }],
    });
    const impact = await t.call("POST", "/policies/service:pay/impact", {});
    expect(impact.body.sampledAllows).toEqual({ read: 2, rates: [0.001] });
    expect(impact.body.transitions).toEqual([
      { from: "allow", to: "refuse", count: 3 },
    ]);
  });
});

describe("redaction per caller", () => {
  it("a caller without events:read sees account rules redacted and no account subjects; the control sees them", async () => {
    const t = await setup({
      owners: [],
      authorize: (operator, permission) =>
        operator.id !== "rita" || permission !== "events:read",
    });
    await store(t, [
      event(t, "pay", { subjects: { ip: "192.0.2.1", user: ALICE } }),
    ]);
    await draft(t, "service:pay", {
      lists: [{ user: "alice", action: "block" }],
    });
    const whole = await t.call(
      "POST",
      "/policies/service:pay/impact",
      {},
      "alice",
    );
    const redacted = await t.call(
      "POST",
      "/policies/service:pay/impact",
      {},
      "rita",
    );
    expect(whole.body.rules[0].rule).toBe(`user:${ALICE}`);
    expect(whole.body.subjects).toEqual({ ip: 1, user: 1 });
    expect(redacted.body.rules[0].rule).toBe("user:[redacted]");
    expect(redacted.body.subjects).toEqual({ ip: 1 });
    expect(JSON.stringify(redacted.body)).not.toContain(ALICE);
  });

  it("a service the caller cannot read analytics for is skipped", async () => {
    const t = await setup({
      owners: [],
      authorize: (operator, permission, target) =>
        !(
          operator.id === "rita" &&
          permission === "analytics:read" &&
          target.scope === "service:shop"
        ),
    });
    await store(t, [event(t, "pay"), event(t, "shop")]);
    await draft(t, "global", {
      lists: [{ ip: "203.0.113.5", action: "block" }],
    });
    const impact = await t.call("POST", "/policies/global/impact", {}, "rita");
    expect(impact.body.services).toEqual({
      replayed: ["pay"],
      skipped: [{ service: "shop", reason: "no analytics:read on it" }],
    });
    expect(impact.body.events.read).toBe(1);
    // The control: alice replays both.
    expect(
      (await t.call("POST", "/policies/global/impact", {}, "alice")).body.events
        .read,
    ).toBe(2);
  });
});

describe("bounds", () => {
  it("the window: 24 h by default, at most 7 days; events outside it are not read", async () => {
    const t = await setup();
    await store(t, [event(t, "pay"), event(t, "pay", {}, 25 * 60)]);
    await draft(t, "service:pay", { lists: [] });
    const impact = await t.call("POST", "/policies/service:pay/impact", {});
    expect(impact.body.events.read).toBe(1);
    expect(impact.body.window.to - impact.body.window.from).toBe(86_400_000);
    const wide = await t.call("POST", "/policies/service:pay/impact", {
      from: t.clock.now() - 8 * 86_400_000,
    });
    expect(wide.status).toBe(400);
    const week = await t.call("POST", "/policies/service:pay/impact", {
      from: t.clock.now() - 7 * 86_400_000,
    });
    expect(week.body.events.read).toBe(2);
  });

  it("stops at the events bound and the time bound, and says which", async () => {
    const t = await setup();
    await store(
      t,
      Array.from({ length: 20 }, () => event(t, "pay")),
    );
    await draft(t, "service:pay", { lists: [] });
    const base = {
      scope: "service:pay",
      from: t.clock.now() - 86_400_000,
      to: t.clock.now(),
      operator: { id: "alice" },
    };
    const events = await estimateImpact(t.api.plane, {
      ...base,
      bounds: { maxEvents: 7 },
    });
    expect(events.events).toEqual({ read: 7, stoppedBy: "events" });
    const time = await estimateImpact(t.api.plane, {
      ...base,
      bounds: { maxDurationMs: 0 },
    });
    expect(time.events.stoppedBy).toBe("time");
    const all = await estimateImpact(t.api.plane, base);
    expect(all.events).toEqual({ read: 20, stoppedBy: null });
  });

  it("stops when the caller goes away", async () => {
    const t = await setup();
    await store(
      t,
      Array.from({ length: 20 }, () => event(t, "pay")),
    );
    await draft(t, "service:pay", { lists: [] });
    const controller = new AbortController();
    controller.abort();
    const run = estimateImpact(t.api.plane, {
      scope: "service:pay",
      from: t.clock.now() - 86_400_000,
      to: t.clock.now(),
      operator: { id: "alice" },
      signal: controller.signal,
    });
    const error = await run.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
  });

  it("replays at most the services bound, naming the rest", async () => {
    const t = await setup();
    await draft(t, "global", { lists: [] });
    const impact = await estimateImpact(t.api.plane, {
      scope: "global",
      from: t.clock.now() - 86_400_000,
      to: t.clock.now(),
      operator: { id: "alice" },
      bounds: { maxServices: 1 },
    });
    expect(impact.services.replayed).toEqual(["pay"]);
    expect(impact.services.skipped).toEqual([
      { service: "shop", reason: "past the 1 services an estimate replays" },
    ]);
  });

  it("no draft is a 404", async () => {
    const t = await setup();
    expect(
      (await t.call("POST", "/policies/service:pay/impact", {})).status,
    ).toBe(404);
  });
});

describe("who may estimate, and how often", () => {
  it("rules:test and policy:read on the draft's scope: an analyst may, a viewer not", async () => {
    const t = await setup();
    await draft(t, "service:pay", { lists: [] });
    await t.call("POST", "/role-bindings", {
      operator: "vic",
      role: "viewer",
      scope: "global",
    });
    await t.call("POST", "/role-bindings", {
      operator: "ann",
      role: "analyst",
      scope: "service:pay",
    });
    expect(
      (await t.call("POST", "/policies/service:pay/impact", {}, "vic")).status,
    ).toBe(403);
    expect(
      (await t.call("POST", "/policies/service:pay/impact", {}, "ann")).status,
    ).toBe(200);
  });

  it("one estimate at a time per operator", async () => {
    const t = await setup();
    await draft(t, "service:pay", { lists: [] });
    // Another instance's estimate holds the operator's claim.
    const key = `ruleTest:running:${new Bun.CryptoHasher("sha256").update("alice").digest("hex").slice(0, 32)}`;
    expect(await t.store.claimKey(key, 60_000)).toBe(true);
    const busy = await t.call("POST", "/policies/service:pay/impact", {});
    expect([busy.status, busy.body.code]).toEqual([429, "rate_limited"]);
    await t.store.resetCounter(key);
    expect(
      (await t.call("POST", "/policies/service:pay/impact", {})).status,
    ).toBe(200);
    // Released after it ran: the next one runs too.
    expect(
      (await t.call("POST", "/policies/service:pay/impact", {})).status,
    ).toBe(200);
  });

  it("6 estimates a minute an operator, across two instances on one store", async () => {
    const clock = fakeClock();
    const shared = memoryStore({ now: clock.now });
    const a = await setup({ store: shared, now: clock.now });
    const b = await setup({ store: shared, now: clock.now });
    await draft(a, "service:pay", { lists: [] });
    for (let i = 0; i < 3; i++) {
      expect(
        (await a.call("POST", "/policies/service:pay/impact", {})).status,
      ).toBe(200);
      expect(
        (await b.call("POST", "/policies/service:pay/impact", {})).status,
      ).toBe(200);
    }
    const over = await a.call("POST", "/policies/service:pay/impact", {});
    expect([over.status, over.body.code]).toEqual([429, "rate_limited"]);
    clock.advance(60_000);
    expect(
      (await b.call("POST", "/policies/service:pay/impact", {})).status,
    ).toBe(200);
  });
});
