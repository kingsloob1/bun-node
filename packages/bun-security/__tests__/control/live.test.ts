/**
 * The live hub (ui.md §6, PR-CP5), driven directly with a recording
 * transport and a manual tick: what each role sees (a viewer never a
 * sample or an account subject; nobody a sample live), a replay after a
 * downgrade stripped to the new role, access lost closing the connection,
 * the feed's rate and its counts, back-pressure, resume and its gaps, the
 * limits, the overview's deltas per scope, and the control events.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { LIVE_CLOSE_CODES, LIVE_LIMITS } from "../../lib/control/contract/live";
import { LiveHub } from "../../lib/control/live/hub";
import { liveHooksOf } from "../../lib/control/liveHooks";
import {
  counters,
  fullEvent,
  liveApi,
  recorder,
  SECRET_SUBJECTS,
  settle,
} from "./liveFixtures";

const hubs: LiveHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
});

/** A hub on a fixture API's plane, ticked by hand. */
async function setup() {
  const test = await liveApi();
  test.api.live.close();
  const hub = new LiveHub(test.api.plane, {
    now: test.clock.now,
    timers: false,
  });
  hubs.push(hub);
  return { ...test, hub };
}

/** The `event` messages a transport got. */
const events = (sent: { type: string; data: any; id?: string }[]) =>
  sent.filter((m) => m.type === "event");

describe("what each role sees", () => {
  it("a viewer: no sample, no user, username or API-key subject, an account's rule id redacted", async () => {
    const { hub } = await setup();
    const viewer = recorder();
    await hub.open({ id: "vic" }, viewer).subscribe(["events:global"]);
    await settle();
    hub.publishBatch("pay", { events: [fullEvent("e1", "pay")], counters: [] });
    await settle();
    const [message] = events(viewer.sent);
    expect(message?.data.event).toEqual({
      id: "e1",
      at: expect.any(Number),
      service: "pay",
      action: "block",
      rule: "apiKey:[redacted]",
      rules: ["apiKey:[redacted]", "r-plain"],
      route: "POST /login",
      subjects: { ip: "203.0.113.7" },
      country: "NG",
      asn: 64_500,
    });
    const text = JSON.stringify(viewer.sent);
    for (const secret of [...Object.values(SECRET_SUBJECTS), "SAMPLE-SECRET"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("negative control: an analyst sees every subject, and still no sample live", async () => {
    const { hub } = await setup();
    const analyst = recorder();
    await hub.open({ id: "ann" }, analyst).subscribe(["events:global"]);
    await settle();
    hub.publishBatch("pay", { events: [fullEvent("e1", "pay")], counters: [] });
    await settle();
    const text = JSON.stringify(analyst.sent);
    for (const secret of Object.values(SECRET_SUBJECTS))
      expect(text).toContain(secret);
    expect(text).not.toContain("SAMPLE-SECRET");
  });

  it("a replay after a role downgrade is stripped to the new role", async () => {
    const { hub, call } = await setup();
    const first = recorder();
    const session = hub.open({ id: "ann" }, first);
    const subscribed = await session.subscribe(["events:global"]);
    hub.publishBatch("pay", {
      events: [fullEvent("e1", "pay"), fullEvent("e2", "pay")],
      counters: [],
    });
    await settle();
    expect(JSON.stringify(first.sent)).toContain(SECRET_SUBJECTS.user);
    session.closedByClient();
    // Downgrade: ann's analyst binding goes, a viewer one comes.
    const bindings = (await call("GET", "/role-bindings")).body.items as {
      id: string;
      operator: string;
      revision: number;
    }[];
    const binding = bindings.find((b) => b.operator === "ann")!;
    expect(
      (
        await call(
          "DELETE",
          `/role-bindings/${binding.id}?revision=${binding.revision}`,
        )
      ).status,
    ).toBe(204);
    await call("POST", "/role-bindings", {
      operator: "ann",
      role: "viewer",
      scope: "global",
    });
    const again = recorder();
    await hub
      .open({ id: "ann" }, again)
      .subscribe(["events:global"], { epoch: hub.epoch, seq: subscribed.seq });
    await settle();
    expect(events(again.sent).map((m) => m.data.event.id)).toEqual([
      "e1",
      "e2",
    ]);
    const text = JSON.stringify(again.sent);
    for (const secret of Object.values(SECRET_SUBJECTS))
      expect(text).not.toContain(secret);
  });

  it("a scope covers its descendants only: a group's analyst sees its service, not another", async () => {
    const { hub } = await setup();
    const gina = recorder();
    expect(
      (await hub.open({ id: "gina" }, gina).subscribe(["events:global"]))
        .refused,
    ).toEqual([{ topic: "events:global", reason: "forbidden" }]);
    await hub.open({ id: "gina" }, gina).subscribe(["events:group:payments"]);
    await settle();
    hub.publishBatch("pay", { events: [fullEvent("e1", "pay")], counters: [] });
    await settle();
    hub.publishBatch("shop", {
      events: [fullEvent("e2", "shop")],
      counters: [],
    });
    await settle();
    expect(events(gina.sent).map((m) => m.data.event.service)).toEqual(["pay"]);
    // An analyst on the group sees the group's events whole.
    expect(JSON.stringify(gina.sent)).toContain(SECRET_SUBJECTS.apiKey);
  });

  it("access lost closes the connection with 4403", async () => {
    const { hub, call } = await setup();
    const viewer = recorder();
    await hub.open({ id: "vic" }, viewer).subscribe(["overview:global"]);
    await settle();
    const bindings = (await call("GET", "/role-bindings")).body.items as {
      id: string;
      operator: string;
      revision: number;
    }[];
    const binding = bindings.find((b) => b.operator === "vic")!;
    await call(
      "DELETE",
      `/role-bindings/${binding.id}?revision=${binding.revision}`,
    );
    await hub.reauthorize();
    expect(viewer.closed?.code).toBe(LIVE_CLOSE_CODES.accessChanged);
    expect(hub.sessionsOf({ id: "vic" })).toBe(0);
  });
});

describe("detail per event (the user's decision of 2026-11-17)", () => {
  /** `mia`: a viewer on global and an analyst on group:payments. */
  const withMia = async () => {
    const test = await setup();
    await test.call("POST", "/role-bindings", {
      operator: "mia",
      role: "viewer",
      scope: "global",
    });
    const analyst = await test.call("POST", "/role-bindings", {
      operator: "mia",
      role: "analyst",
      scope: "group:payments",
    });
    return {
      ...test,
      analyst: analyst.body as { id: string; revision: number },
    };
  };

  it("an analyst of a group on events:global sees the group's events whole, the rest as a viewer", async () => {
    const { hub } = await withMia();
    const mia = recorder();
    await hub.open({ id: "mia" }, mia).subscribe(["events:global"]);
    hub.publishBatch("pay", { events: [fullEvent("p1", "pay")], counters: [] });
    hub.publishBatch("shop", {
      events: [fullEvent("s1", "shop")],
      counters: [],
    });
    await settle();
    const [pay, shop] = events(mia.sent).map((m) => m.data.event);
    expect(pay?.subjects).toEqual({ ip: "203.0.113.7", ...SECRET_SUBJECTS });
    expect(shop?.subjects).toEqual({ ip: "203.0.113.7" });
    expect(shop?.rule).toBe("apiKey:[redacted]");
    // Never the sample, whatever the rights.
    expect(JSON.stringify(mia.sent)).not.toContain("SAMPLE-SECRET");
  });

  it("negative control: a viewer alone sees both stripped, an analyst of global both whole", async () => {
    const { hub } = await withMia();
    const vic = recorder();
    const ann = recorder();
    await hub.open({ id: "vic" }, vic).subscribe(["events:global"]);
    await hub.open({ id: "ann" }, ann).subscribe(["events:global"]);
    hub.publishBatch("pay", { events: [fullEvent("p1", "pay")], counters: [] });
    hub.publishBatch("shop", {
      events: [fullEvent("s1", "shop")],
      counters: [],
    });
    await settle();
    expect(events(vic.sent).map((m) => m.data.event.subjects)).toEqual([
      { ip: "203.0.113.7" },
      { ip: "203.0.113.7" },
    ]);
    expect(
      events(ann.sent).every(
        (m) => m.data.event.subjects.user === SECRET_SUBJECTS.user,
      ),
    ).toBe(true);
  });

  it("a replay across a role change is stripped to the rights at send time", async () => {
    const { hub, call, analyst } = await withMia();
    const first = recorder();
    const session = hub.open({ id: "mia" }, first);
    const subscribed = await session.subscribe(["events:global"]);
    hub.publishBatch("pay", { events: [fullEvent("p1", "pay")], counters: [] });
    await settle();
    expect(events(first.sent)[0]?.data.event.subjects.user).toBe(
      SECRET_SUBJECTS.user,
    );
    // The group's analyst binding goes: mia is a viewer everywhere now.
    await call(
      "DELETE",
      `/role-bindings/${analyst.id}?revision=${analyst.revision}`,
    );
    await hub.reauthorize();
    hub.publishBatch("pay", { events: [fullEvent("p2", "pay")], counters: [] });
    await settle();
    expect(events(first.sent)[1]?.data.event.subjects).toEqual({
      ip: "203.0.113.7",
    });
    // A replay from before the change is stripped too.
    const again = recorder();
    await hub
      .open({ id: "mia" }, again)
      .subscribe(["events:global"], { epoch: hub.epoch, seq: subscribed.seq });
    await settle();
    expect(
      events(again.sent).map((m) => [m.data.event.id, m.data.event.subjects]),
    ).toEqual([
      ["p1", { ip: "203.0.113.7" }],
      ["p2", { ip: "203.0.113.7" }],
    ]);
  });
});

describe("rates, back-pressure and resume", () => {
  it("at most 20 feed events a second, 20 more for priority ones, the rest counted", async () => {
    const { hub } = await setup();
    const viewer = recorder();
    await hub.open({ id: "vic" }, viewer).subscribe(["events:global"]);
    await settle();
    const batch = [
      ...Array.from({ length: 30 }, (_, i) => fullEvent(`n${i}`, "pay")),
      ...Array.from({ length: 30 }, (_, i) =>
        fullEvent(`p${i}`, "pay", { action: "ban" }),
      ),
    ];
    hub.publishBatch("pay", { events: batch, counters: [] });
    await settle();
    const sent = events(viewer.sent);
    expect(sent.filter((m) => m.data.event.action === "block")).toHaveLength(
      LIVE_LIMITS.eventsPerSecond,
    );
    expect(sent.filter((m) => m.data.event.action === "ban")).toHaveLength(
      LIVE_LIMITS.priorityPerSecond,
    );
    hub.tick();
    await settle();
    expect(
      viewer.sent.filter((m) => m.type === "more").map((m) => m.data.count),
    ).toEqual([20]);
    // The next second starts again.
    hub.publishBatch("pay", {
      events: [fullEvent("later", "pay")],
      counters: [],
    });
    await settle();
    expect(events(viewer.sent).at(-1)?.data.event.id).toBe("later");
  });

  it("a slow subscriber is sent nothing past 1 MiB buffered, then a gap once it drains", async () => {
    const { hub } = await setup();
    const slow = recorder();
    await hub.open({ id: "vic" }, slow).subscribe(["events:global"]);
    await settle();
    slow.bufferedBytes = LIVE_LIMITS.slowBytes + 1;
    hub.publishBatch("pay", {
      events: [fullEvent("e1", "pay"), fullEvent("e2", "pay")],
      counters: [],
    });
    await settle();
    expect(events(slow.sent)).toHaveLength(0);
    hub.tick();
    await settle();
    expect(slow.sent.filter((m) => m.type === "gap")).toHaveLength(0);
    slow.bufferedBytes = 0;
    hub.tick();
    await settle();
    expect(
      slow.sent.filter((m) => m.type === "gap").map((m) => m.data.reason),
    ).toEqual(["slow"]);
    hub.publishBatch("pay", { events: [fullEvent("e3", "pay")], counters: [] });
    await settle();
    expect(events(slow.sent).map((m) => m.data.event.id)).toEqual(["e3"]);
  });

  it("resumes from the ring, or answers a gap for another epoch or a point it no longer holds", async () => {
    const { hub } = await setup();
    hub.publishBatch("pay", { events: [fullEvent("e1", "pay")], counters: [] });
    await settle();
    const seq = hub.seq;
    hub.publishBatch("pay", {
      events: [fullEvent("e2", "pay"), fullEvent("e3", "pay")],
      counters: [],
    });
    await settle();
    const resumed = recorder();
    await hub
      .open({ id: "vic" }, resumed)
      .subscribe(["events:global"], { epoch: hub.epoch, seq });
    await settle();
    expect(events(resumed.sent).map((m) => m.data.event.id)).toEqual([
      "e2",
      "e3",
    ]);
    expect(events(resumed.sent).map((m) => m.id)).toEqual([
      `${hub.epoch}:${seq + 1}`,
      `${hub.epoch}:${seq + 2}`,
    ]);
    const other = recorder();
    await hub
      .open({ id: "vic" }, other)
      .subscribe(["events:global"], { epoch: "0000", seq });
    await settle();
    expect(other.sent.map((m) => [m.type, m.data.reason])).toEqual([
      ["gap", "resume"],
    ]);
    // Past the ring's 1,000 messages, the first ones are gone.
    hub.publishBatch("pay", {
      events: Array.from({ length: LIVE_LIMITS.ringMessages }, (_, i) =>
        fullEvent(`x${i}`, "pay"),
      ),
      counters: [],
    });
    await settle();
    const old = recorder();
    await hub
      .open({ id: "vic" }, old)
      .subscribe(["events:global"], { epoch: hub.epoch, seq });
    await settle();
    expect(old.sent[0]?.data.reason).toBe("resume");
  });

  it("forgets messages older than five minutes", async () => {
    const { hub, clock } = await setup();
    hub.publishBatch("pay", { events: [fullEvent("e1", "pay")], counters: [] });
    await settle();
    clock.advance(LIVE_LIMITS.ringAgeMs + 1);
    hub.tick();
    await settle();
    expect(hub.since({ epoch: hub.epoch, seq: 0 })).toBeUndefined();
    expect(hub.since({ epoch: hub.epoch, seq: hub.seq })).toEqual([]);
  });
});

describe("limits", () => {
  it("5 connections an operator, 10 topics a connection; invalid and forbidden topics refused", async () => {
    const { hub } = await setup();
    for (let i = 0; i < LIVE_LIMITS.connectionsPerOperator; i++)
      hub.open({ id: "vic" }, recorder());
    expect(() => hub.open({ id: "vic" }, recorder())).toThrow(/at most 5/);
    // Another operator is not affected.
    const ann = hub.open({ id: "ann" }, recorder());
    const topics = Array.from({ length: 12 }, (_, i) =>
      i === 0 ? "events:global" : `overview:service:s${i}`,
    );
    const answer = await ann.subscribe([
      ...topics,
      "nonsense",
      "events:planet:x",
    ]);
    expect(answer.topics).toHaveLength(LIVE_LIMITS.topicsPerConnection);
    expect(
      answer.refused.filter((r) => r.reason === "limit").map((r) => r.topic),
    ).toEqual(topics.slice(10));
    expect(
      answer.refused.filter((r) => r.reason === "invalid").map((r) => r.topic),
    ).toEqual(["nonsense", "events:planet:x"]);
  });

  it("a closed session frees its slot", async () => {
    const { hub } = await setup();
    const sessions = Array.from(
      { length: LIVE_LIMITS.connectionsPerOperator },
      () => hub.open({ id: "vic" }, recorder()),
    );
    sessions[0].closedByClient();
    expect(() => hub.open({ id: "vic" }, recorder())).not.toThrow();
  });
});

describe("the overview and the control events", () => {
  it("sends a second's request deltas once per topic, summed over the scope's services", async () => {
    const { hub } = await setup();
    const all = recorder();
    const group = recorder();
    await hub.open({ id: "vic" }, all).subscribe(["overview:global"]);
    await settle();
    await hub
      .open({ id: "gina" }, group)
      .subscribe(["overview:group:payments"]);
    await settle();
    hub.publishBatch("pay", { events: [], counters: counters("pay", 2) });
    await settle();
    hub.publishBatch("pay", { events: [], counters: counters("pay", 1) });
    await settle();
    hub.publishBatch("shop", { events: [], counters: counters("shop", 5) });
    await settle();
    expect(all.sent).toEqual([]);
    hub.tick();
    await settle();
    expect(all.sent.map((m) => [m.type, m.data.requests])).toEqual([
      ["overview", { block: 8, allow: 80 }],
    ]);
    expect(group.sent.map((m) => m.data.requests)).toEqual([
      { block: 3, allow: 30 },
    ]);
    hub.tick();
    await settle();
    expect(all.sent).toHaveLength(1);
  });

  it("refuses a batch's rows of another service", async () => {
    const { hub } = await setup();
    const all = recorder();
    await hub
      .open({ id: "vic" }, all)
      .subscribe(["overview:global", "events:global"]);
    await settle();
    hub.publishBatch("pay", {
      events: [fullEvent("e1", "shop")],
      counters: counters("shop"),
    });
    await settle();
    hub.tick();
    await settle();
    expect(all.sent).toEqual([]);
  });

  it("sends a published policy on policy:<scope>, with its place in the stream", async () => {
    const { hub, call } = await setup();
    const viewer = recorder();
    await hub.open({ id: "vic" }, viewer).subscribe(["policy:global"]);
    await settle();
    await call("PUT", "/policies/global/draft", { policy: {}, revision: null });
    await call("POST", "/policies/global/publish", { expectedHead: null });
    await settle();
    const published = viewer.sent.find((m) => m.type === "policy.published");
    expect(published?.data).toMatchObject({
      topic: "policy:global",
      epoch: hub.epoch,
      scope: "global",
    });
    expect(published?.id).toBe(`${hub.epoch}:${published?.data.seq}`);
  });

  it("sends a ban written or lifted on bans:<scope>, its subject as stored", async () => {
    const test = await liveApi();
    const hub = test.api.live.hub;
    hubs.push(hub);
    const viewer = recorder();
    await hub.open({ id: "vic" }, viewer).subscribe(["bans:global"]);
    await settle();
    const gina = recorder();
    await hub.open({ id: "gina" }, gina).subscribe(["bans:group:payments"]);
    await settle();
    const made = await test.call("POST", "/bans", {
      scope: "service:pay",
      ip: "203.0.113.9",
      reason: "x",
    });
    await settle();
    expect(made.status).toBe(201);
    await test.call("POST", "/bans", {
      scope: "service:shop",
      ip: "198.51.100.1",
      reason: "y",
    });
    await settle();
    const bans = viewer.sent.filter((m) => m.type === "ban");
    expect(bans.map((m) => [m.data.ban.scope, m.data.ban.subject])).toEqual([
      ["service:pay", { type: "ip", value: "203.0.113.9" }],
      ["service:shop", { type: "ip", value: "198.51.100.1" }],
    ]);
    // A group's subscriber hears its own services' bans only.
    expect(
      gina.sent.filter((m) => m.type === "ban").map((m) => m.data.ban.scope),
    ).toEqual(["service:pay"]);
    const lifted = await test.call("POST", `/bans/${made.body.id}/lift`);
    await settle();
    expect(lifted.status).toBeLessThan(300);
    expect(
      viewer.sent.filter((m) => m.type === "ban").at(-1)?.data.ban.active,
    ).toBe(false);
  });

  it("a stored batch reaches the hub through CP4's hook", async () => {
    const test = await liveApi();
    const hub = test.api.live.hub;
    hubs.push(hub);
    const viewer = recorder();
    await hub.open({ id: "vic" }, viewer).subscribe(["events:global"]);
    await settle();
    liveHooksOf(test.api.plane).publishBatch("pay", {
      format: "bun-security.events/1",
      batchId: "b1",
      service: "pay",
      sentAt: 0,
      events: [fullEvent("e1", "pay")],
      counters: [],
    });
    await settle();
    expect(events(viewer.sent).map((m) => m.data.event.id)).toEqual(["e1"]);
  });
});
