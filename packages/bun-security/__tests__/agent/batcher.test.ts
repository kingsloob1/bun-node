/**
 * The agent's event batcher against a fake `/agent/events` (PR-CP1's
 * contract): each answer (200, 429 with `Retry-After`, 5xx, a network
 * error, another 4xx), and the bounded retry queue's drops, counted in the
 * next batch. Also the seam CP1's route builds on: a gzip batch, signed by
 * a real agent, authenticated by `agentRequest` with its `route` checked.
 */
import { afterAll, describe, expect, it } from "bun:test";
import type {
  AgentEventBatch,
  BatchAnswer,
  SecurityEvent,
} from "../../lib/agent/index";
import { createEventBatcher } from "../../lib/agent/index";
import {
  agentGuard,
  sendSigned,
  verifyAgentBody,
} from "../../lib/control/agentRoutes";
import { agentOn, cleanUp, controlPlane } from "./fixture";

afterAll(cleanUp);

/** An event of `checkout`'s, `pad` characters of reason. */
const event = (i: number, pad = 0): SecurityEvent => ({
  id: `e${i}-${Math.random().toString(36).slice(2)}`,
  at: 1_000 + i,
  service: "checkout",
  action: "block",
  ...(pad === 0 ? {} : { reason: "x".repeat(pad) }),
});

/** A source (CP1's ring and recorder, structurally) of `n` events and no counters. */
function source(n: number, pad = 0) {
  const events: SecurityEvent[] = Array.from({ length: n }, (_, i) =>
    event(i, pad),
  );
  return {
    ring: {
      take: (max: number) => events.splice(0, max),
      size: () => events.length,
    },
    recorder: { flush: () => [] },
    push: (count: number) => {
      for (let i = 0; i < count; i++) events.push(event(i, pad));
    },
  };
}

describe("the event batcher", () => {
  it("sends a batch and drops it on 200; at most 500 events a batch", async () => {
    const sent: AgentEventBatch[] = [];
    const batcher = createEventBatcher({
      service: "checkout",
      source: source(700),
      send: async (batch) => {
        sent.push(batch);
        return { status: 200 };
      },
      intervalMs: 60_000,
    });
    await batcher.flush();
    await batcher.flush();
    batcher.close();
    expect(sent.map((batch) => batch.events.length)).toEqual([500, 200]);
    expect(sent[0]).toMatchObject({
      route: "events",
      format: "bun-security.events/1",
      service: "checkout",
    });
    expect(batcher.queued()).toBe(0);
  });

  for (const answer of [
    { status: 429, retryAfterSeconds: 0 },
    { status: 503 },
    { status: 0 },
  ] as BatchAnswer[]) {
    it(`keeps and resends the same batch on ${answer.status === 0 ? "a network error" : answer.status}`, async () => {
      const ids: string[] = [];
      let fail = true;
      let clock = 0;
      const batcher = createEventBatcher({
        service: "checkout",
        source: source(3),
        now: () => clock,
        send: async (batch) => {
          ids.push(batch.batchId);
          return fail ? answer : { status: 200 };
        },
        intervalMs: 60_000,
      });
      await batcher.flush();
      expect(batcher.queued()).toBe(1);
      fail = false;
      clock += 120_000;
      await batcher.flush();
      batcher.close();
      expect(batcher.queued()).toBe(0);
      expect(ids).toHaveLength(2);
      expect(ids[1]).toBe(ids[0]);
    });
  }

  it("honours Retry-After on a 429", async () => {
    let clock = 0;
    let calls = 0;
    const events = source(1);
    const batcher = createEventBatcher({
      service: "checkout",
      source: events,
      now: () => clock,
      send: async () => {
        calls++;
        return calls === 1
          ? { status: 429, retryAfterSeconds: 30 }
          : { status: 200 };
      },
      intervalMs: 60_000,
    });
    await batcher.flush();
    clock += 10_000;
    await batcher.flush();
    expect(calls).toBe(1);
    clock += 25_000;
    await batcher.flush();
    batcher.close();
    expect(calls).toBe(2);
  });

  it("drops a batch refused with another 4xx, without retrying, and counts it", async () => {
    let calls = 0;
    const batcher = createEventBatcher({
      service: "checkout",
      source: source(2),
      send: async () => {
        calls++;
        return { status: 403 };
      },
      intervalMs: 60_000,
    });
    await batcher.flush();
    await batcher.flush();
    batcher.close();
    expect(calls).toBe(1);
    expect(batcher.rejected()).toBe(1);
    expect(batcher.queued()).toBe(0);
  });

  it("drops the oldest past the queue's bound and reports the drops in the next batch's counters", async () => {
    let up = false;
    let clock = 0;
    const events = source(0);
    const sent: AgentEventBatch[] = [];
    const batcher = createEventBatcher({
      service: "checkout",
      source: events,
      now: () => clock,
      maxQueueBatches: 3,
      send: async (batch) => {
        if (!up) return { status: 503 };
        sent.push(batch);
        return { status: 200 };
      },
      intervalMs: 60_000,
    });
    for (let i = 0; i < 5; i++) {
      events.push(1);
      clock += 120_000;
      await batcher.flush();
    }
    expect(batcher.queued()).toBe(3);
    expect(batcher.dropped()).toBe(2);
    up = true;
    for (let i = 0; i < 3; i++) {
      clock += 120_000;
      events.push(1);
      await batcher.flush();
    }
    batcher.close();
    expect(batcher.queued()).toBe(0);
    // Every drop reached the control plane, as events.dropped {reason: "agent-queue"}.
    const reported = sent
      .flatMap((batch) => batch.counters)
      .filter((row) => row.metric === "events.dropped")
      .map((row) => {
        expect(row.dims).toEqual({ reason: "agent-queue" });
        return row.value as number;
      });
    expect(reported.reduce((a, b) => a + b, 0)).toBe(batcher.dropped());
    expect(batcher.dropped()).toBeGreaterThanOrEqual(2);
  });

  it("negative control: a queue that never overflows reports no drop", async () => {
    const sent: AgentEventBatch[] = [];
    const events = source(0);
    const batcher = createEventBatcher({
      service: "checkout",
      source: events,
      maxQueueBatches: 3,
      send: async (batch) => {
        sent.push(batch);
        return { status: 200 };
      },
      intervalMs: 60_000,
    });
    for (let i = 0; i < 5; i++) {
      events.push(1);
      await batcher.flush();
    }
    batcher.close();
    expect(sent).toHaveLength(5);
    expect(sent.flatMap((batch) => batch.counters)).toEqual([]);
    expect(batcher.dropped()).toBe(0);
  });

  it("bounds the queue by bytes as well", async () => {
    let clock = 0;
    const events = source(0, 1_000);
    const batcher = createEventBatcher({
      service: "checkout",
      source: events,
      now: () => clock,
      maxQueueBytes: 3_000,
      send: async () => ({ status: 503 }),
      intervalMs: 60_000,
    });
    for (let i = 0; i < 4; i++) {
      events.push(1);
      clock += 120_000;
      await batcher.flush();
    }
    batcher.close();
    expect(batcher.queued()).toBe(2);
    expect(batcher.dropped()).toBe(2);
  });
});

describe("the seam for PR-CP1's POST /agent/events", () => {
  it("a real agent's gzip batch is authenticated by agentRequest, its route checked", async () => {
    const cp = await controlPlane();
    const received: AgentEventBatch[] = [];
    const registry = cp.api.plane.agents!;
    // What CP1's route will do: authenticate, then check the body's route.
    // Mounted beside the API (whose router answers 404 after its own routes), at /cp1.
    const context = {
      plane: cp.api.plane,
      registry,
      options: {
        rateLimit: 600,
        heartbeatIntervalMs: 30_000,
        rotationGraceMs: 86_400_000,
        artefacts: undefined,
        maxArtefactBytes: 1,
        maxBodyBytes: 1024 * 1024,
      },
      logger: cp.api.plane.logger,
    };
    // The header checks in a guard (before a deferred body is read), the body's in the handler.
    let reached = 0;
    cp.app.use("/cp1/agent/events", agentGuard("events", context));
    cp.app.post("/cp1/agent/events", async (req, res) => {
      reached++;
      const outcome = await verifyAgentBody(req, res, "events", context);
      if (!outcome.ok) return;
      const batch = JSON.parse(
        new TextDecoder().decode(outcome.request.body),
      ) as AgentEventBatch;
      if (batch.route !== "events") {
        res.status(401).send("");
        return;
      }
      received.push(batch);
      await sendSigned(
        res,
        200,
        JSON.stringify({ duplicate: false }),
        outcome.request.secret,
        null,
        cp.clock.now(),
      );
    });
    const events = source(3);
    const { agent } = agentOn(cp, { events, url: "http://cp.test/cp1" });
    await agent.ready;
    await agent.events!.flush();
    agent.events!.close();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ service: "checkout", route: "events" });
    expect(received[0]!.events).toHaveLength(3);
    // A signed 200: the batch is done.
    expect(agent.events!.queued()).toBe(0);
    expect(reached).toBe(1);
    // An unknown agent is refused by the guard: the handler never runs.
    const stranger = await cp.app.fetch(
      new Request("http://cp.test/cp1/agent/events", {
        method: "POST",
        headers: {
          "x-bun-security-agent": "nobody",
          "x-bun-security-signature": "t=1,v1=00",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(stranger.status).toBe(401);
    expect(reached).toBe(1);
    // Negative control: a known agent's bad body signature passes the guard and is refused by the handler.
    const now = Math.floor(cp.clock.now() / 1000);
    const forged = await cp.app.fetch(
      new Request("http://cp.test/cp1/agent/events", {
        method: "POST",
        headers: {
          "x-bun-security-agent": "checkout-1",
          "x-bun-security-signature": `t=${now},v1=${"0".repeat(64)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ route: "events" }),
      }),
    );
    expect(forged.status).toBe(401);
    expect(reached).toBe(2);
  });
});
