/**
 * PR-CP1's `POST /agent/events` on CP4's signed requests: a real agent's
 * batch from CP1's ring and recorder, through the guard (headers) and the
 * handler (body signature, `route: "events"`), stored once; the live hub's
 * hook told; the refusals; the recorder's `flush({ all: true })` adding
 * partial minutes without counting twice. And #838's keyed list-entry ids
 * agreeing with a CP ban by key.
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
  createAnalyticsRecorder,
  createEventRing,
} from "../../lib/analytics/index";
import {
  AGENT_HEADER,
  AGENT_SIGNATURE_HEADER,
  agentEnvelope,
} from "../../lib/agent/protocol";
import { setLiveHooks } from "../../lib/control/liveHooks";
import { createSecurity } from "../../lib/index";
import type { Decision } from "../../lib/index";
import { memoryStore } from "../../lib/store/index";
import { facts } from "../helpers";
import { FLEET_SECRET, testApi } from "../control/helpers";
import { agentOn, cleanUp, controlPlane } from "./fixture";

afterAll(cleanUp);

/** CP1's ring and recorder on `service`, with a decision offered. */
function analytics(cp: Awaited<ReturnType<typeof controlPlane>>) {
  const recorder = createAnalyticsRecorder({
    service: "checkout",
    now: cp.clock.now,
  });
  const ring = createEventRing({
    service: "checkout",
    recorder,
    now: cp.clock.now,
  });
  return { ring, recorder };
}

/** A blocking decision for the ring. */
async function blocked(
  cp: Awaited<ReturnType<typeof controlPlane>>,
): Promise<Decision> {
  const security = createSecurity({
    policy: { lists: [{ ip: "203.0.113.5", action: "block" }] },
    logger: () => {},
    now: cp.clock.now,
  });
  await security.ready();
  const decision = await security.evaluate(facts({ client: "203.0.113.5" }));
  await security.close();
  return decision;
}

describe("POST /agent/events on the agents' signed requests", () => {
  it("stores a real agent's batch once, events and counters, and tells the live hub", async () => {
    const cp = await controlPlane();
    const published: string[] = [];
    setLiveHooks(cp.api.plane, {
      publishBatch: (service, batch) =>
        published.push(`${service}:${batch.events.length}`),
      publishBan: () => {},
    });
    const { ring, recorder } = analytics(cp);
    const decision = await blocked(cp);
    expect(decision.action).toBe("block");
    ring.offer(decision);
    recorder.count("requests", { action: "block" }, 3);
    const { agent } = agentOn(cp, { events: { ring, recorder } });
    await agent.ready;
    await agent.events!.flush();
    expect(agent.events!.queued()).toBe(0);
    const stored = await cp.store.listEvents!({
      limit: 10,
      service: "checkout",
    });
    expect(stored.items).toHaveLength(1);
    expect(stored.items[0]).toMatchObject({
      service: "checkout",
      action: "block",
    });
    // The open minute went too (flush({ all: true })): the live overview is not a minute behind.
    const points = await cp.store.series!({
      service: "checkout",
      metric: "requests",
      tier: "minute",
      from: cp.clock.now() - 3_600_000,
      to: cp.clock.now() + 60_000,
    });
    expect(points.reduce((sum, point) => sum + point.value, 0)).toBe(3);
    expect(published).toEqual(["checkout:1"]);
    await agent.close();
  });

  it("refuses an unknown agent in the guard, a bad signature and another route in the handler, another service's batch", async () => {
    const cp = await controlPlane();
    const post = async (
      body: string,
      over: { agent?: string; secret?: string } = {},
    ) => {
      const signature = await agentEnvelope.signEnvelope(body, {
        direction: "request",
        secret: over.secret ?? cp.secret,
        now: cp.clock.now(),
      });
      const response = await cp.app.fetch(
        new Request(`http://cp.test${cp.api.basePath}/agent/events`, {
          method: "POST",
          headers: {
            [AGENT_HEADER]: over.agent ?? "checkout-1",
            [AGENT_SIGNATURE_HEADER]: signature,
            "content-type": "application/json",
          },
          body,
        }),
      );
      return {
        status: response.status,
        signed: response.headers.get(AGENT_SIGNATURE_HEADER) !== null,
      };
    };
    const batch = (over: Record<string, unknown> = {}) =>
      JSON.stringify({
        route: "events",
        format: "bun-security.events/1",
        batchId: crypto.randomUUID(),
        service: "checkout",
        sentAt: 1,
        events: [],
        counters: [],
        ...over,
      });
    expect(await post(batch(), { agent: "nobody" })).toEqual({
      status: 401,
      signed: false,
    });
    expect(await post(batch(), { secret: "wrong" })).toEqual({
      status: 401,
      signed: true,
    });
    expect(await post(batch({ route: "heartbeat" }))).toEqual({
      status: 401,
      signed: true,
    });
    expect(await post(batch({ service: "blog" }))).toEqual({
      status: 403,
      signed: true,
    });
    // Negative control: the same batch, bound and its own, is stored.
    expect(await post(batch())).toEqual({ status: 200, signed: true });
  });

  it("serves events with agents only through agents; both options together are refused", () => {
    expect(() =>
      testApi({
        agents: { allowEphemeralStore: true },
        agentEvents: { authenticate: () => undefined },
      }),
    ).toThrow(/leave agentEvents out/);
    // Negative control: either alone is fine.
    expect(() =>
      testApi({ agents: { allowEphemeralStore: true } }),
    ).not.toThrow();
    expect(() =>
      testApi({ agentEvents: { authenticate: () => undefined } }),
    ).not.toThrow();
  });
});

describe("the recorder's flush({ all: true })", () => {
  it("adds a minute flushed in parts once, never twice", async () => {
    const store = memoryStore();
    let now = 120_000 + 5_000;
    const recorder = createAnalyticsRecorder({ service: "s", now: () => now });
    recorder.count("requests", {}, 3);
    await store.addCounters!(recorder.flush({ all: true }));
    now += 10_000;
    recorder.count("requests", {}, 2);
    // Negative control: without `all`, the open minute waits.
    expect(recorder.flush().filter((row) => row.metric === "requests")).toEqual(
      [],
    );
    await store.addCounters!(recorder.flush({ all: true }));
    const points = await store.series!({
      service: "s",
      metric: "requests",
      from: 0,
      to: 600_000,
    });
    expect(points.map((point) => [point.at, point.value])).toEqual([
      [120_000, 5],
    ]);
  });
});

describe("#838's keyed entry ids and a ban by key from the control plane", () => {
  it("report the same apiKey:<hmac> in a decision", async () => {
    const KEY = "key_agreed_77c1";
    const withKey = facts({
      path: "/api",
      rawPath: "/api",
      routeKey: "GET /api",
      identity: { apiKey: KEY },
    });
    const listed = createSecurity({
      secret: FLEET_SECRET,
      policy: { lists: [{ apiKey: KEY, action: "block" }] },
      logger: () => {},
    });
    await listed.ready();
    const byList = await listed.evaluate(withKey);
    await listed.close();
    const cp = await controlPlane();
    await cp.call("POST", "/bans", { apiKey: KEY, reason: "leaked" });
    const security = createSecurity({
      secret: FLEET_SECRET,
      policy: {},
      logger: () => {},
      now: cp.clock.now,
    });
    const { agent } = agentOn(cp, { security });
    await agent.sync();
    await security.ready();
    const byBan = await security.evaluate(withKey);
    expect(byBan.action).toBe("ban");
    const key = byList.subject.apiKey!;
    expect(byBan.subject.apiKey).toBe(key);
    expect(byList.hits.map((hit) => hit.rule)).toEqual([`apiKey:${key}`]);
    expect(byBan.hits.map((hit) => hit.rule).join(" ")).toContain(
      `apiKey:${key}`,
    );
    // Negative control: an engine on another secret neither matches nor names that key.
    const other = createSecurity({
      secret: "another-fleet-secret-0123456789abcdef",
      policy: {},
      logger: () => {},
    });
    await other.ready();
    const missed = await other.evaluate(withKey);
    expect(missed.subject.apiKey).not.toBe(key);
    await other.close();
    await security.close();
  });
});

describe("the live hub's ban hook", () => {
  it("is told of every ban written or lifted; a hook that throws fails nothing", async () => {
    const cp = await controlPlane();
    const told: string[] = [];
    setLiveHooks(cp.api.plane, {
      publishBatch: () => {},
      publishBan: (ban) =>
        told.push(
          `${ban.subject.value}:${ban.liftedAt === null ? "on" : "lifted"}`,
        ),
    });
    const made = await cp.call("POST", "/bans", {
      ip: "203.0.113.8",
      reason: "x",
    });
    await cp.call("POST", `/bans/${made.body.id}/lift`);
    expect(told).toEqual(["203.0.113.8:on", "203.0.113.8:lifted"]);
    setLiveHooks(cp.api.plane, {
      publishBatch: () => {},
      publishBan: () => {
        throw new Error("the hub is down");
      },
    });
    expect(
      (await cp.call("POST", "/bans", { ip: "203.0.113.9", reason: "x" }))
        .status,
    ).toBe(201);
  });
});
