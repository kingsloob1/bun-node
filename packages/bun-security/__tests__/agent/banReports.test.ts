/**
 * Agent ban reporting (the user's defaults, 2026-11-18): an engine's own
 * automatic bans reach the control plane (`POST /agent/ban-reports`),
 * batched every 5 s (500 a batch), one per subject a minute unless the ban
 * escalates, capped at 600 a minute with the drops counted in the
 * heartbeat and alerted; stored as automatic bans with their rule, service
 * and ladder step; a lift from the UI reaches the fleet and a re-report of
 * the lifted ban does not re-create it; ended automatic bans are purged
 * after 30 days, the count audited.
 */
import { afterAll, describe, expect, it } from "bun:test";
import type { Ban, BanWrite } from "../../lib/engine/bans";
import type { SecurityAlertDto } from "../../lib/control/contract/index";
import { BanReporter } from "../../lib/agent/banReports";
import { createSecurity } from "../../lib/index";
import { facts } from "../helpers";
import { agentOn, cleanUp, controlPlane } from "./fixture";

afterAll(cleanUp);

const MINUTE = 60_000;
const DAY = 86_400_000;

/** A ban and the write that made it, as an engine hands them to a listener. */
function written(
  value: string,
  over: {
    expiresAt?: number | null;
    step?: number;
    source?: "auto" | "manual";
    type?: string;
  } = {},
): [Ban, BanWrite] {
  const type = over.type ?? "ip";
  const ban: Ban = {
    id: `${type}:${value}`,
    subject: { type, value },
    action: "ban",
    reason: "ladder: score reached 10",
    rule: "ladder",
    source: over.source ?? "auto",
    createdAt: 1_000,
    expiresAt: over.expiresAt === undefined ? 10_000_000 : over.expiresAt,
    count: 1,
    ...(over.step === undefined ? {} : { step: over.step }),
  };
  const write: BanWrite = {
    subject: ban.subject,
    action: "ban",
    reason: ban.reason,
    rule: "ladder",
    source: ban.source,
    expiresAt: ban.expiresAt,
    ...(over.step === undefined ? {} : { step: over.step }),
  };
  return [ban, write];
}

describe("BanReporter", () => {
  it("reports an automatic ban once per subject a minute, unless it escalates", () => {
    let now = 0;
    const reporter = new BanReporter({ now: () => now });
    reporter.offer(...written("192.0.2.1", { step: 1 }));
    reporter.offer(...written("192.0.2.1", { step: 1 }));
    expect(reporter.take().map((r) => r.subject.value)).toEqual(["192.0.2.1"]);
    // Within the minute: the same ban is not reported again…
    now = 30_000;
    reporter.offer(...written("192.0.2.1", { step: 1 }));
    expect(reporter.pending).toBe(0);
    // …but an escalation is: a later end, permanent, a higher step.
    reporter.offer(...written("192.0.2.1", { step: 1, expiresAt: 20_000_000 }));
    reporter.offer(...written("192.0.2.2", { step: 1 }));
    now = 31_000;
    reporter.offer(...written("192.0.2.2", { step: 2 }));
    reporter.offer(...written("192.0.2.3"));
    reporter.offer(...written("192.0.2.3", { expiresAt: null }));
    const batch = reporter.take();
    expect(
      batch.map((r) => [r.subject.value, r.step ?? null, r.expiresAt]),
    ).toEqual([
      ["192.0.2.1", 1, 20_000_000],
      ["192.0.2.2", 2, 10_000_000],
      ["192.0.2.3", null, null],
    ]);
    // After the minute, a report again.
    now = 31_000 + MINUTE;
    reporter.offer(...written("192.0.2.1", { step: 1, expiresAt: 20_000_000 }));
    expect(reporter.pending).toBe(1);
  });

  it("reports only automatic bans of addresses, ranges and account keys", () => {
    const reporter = new BanReporter({ now: () => 0 });
    reporter.offer(...written("192.0.2.9", { source: "manual" }));
    reporter.offer(...written("192.0.2.9|u", { type: "ip|user" }));
    reporter.offer(
      ...written("0123456789abcdef0123456789abcdef", { type: "user" }),
    );
    reporter.offer(...written("2001:db8:1:2::/64", { type: "ip" }));
    expect(reporter.take().map((r) => r.subject.type)).toEqual(["user", "ip"]);
  });

  it("caps 600 reports a minute and counts the rest, never silently; batches of 500", () => {
    let now = 0;
    const reporter = new BanReporter({ now: () => now });
    for (let i = 0; i < 605; i++)
      reporter.offer(...written(`10.0.${Math.floor(i / 250)}.${i % 250}`));
    expect(reporter.pending).toBe(600);
    expect(reporter.dropped).toBe(5);
    expect(reporter.take()).toHaveLength(500);
    expect(reporter.take()).toHaveLength(100);
    // The next minute takes reports again.
    now = MINUTE;
    reporter.offer(...written("10.9.9.9"));
    expect(reporter.pending).toBe(1);
    // A heartbeat that carried the count acknowledges it.
    reporter.acknowledge(5);
    expect(reporter.dropped).toBe(0);
  });

  it("puts back a batch not sent, keeping the queue bounded and counting the excess", () => {
    const reporter = new BanReporter({
      now: () => 0,
      limits: { queue: 3, perMinute: 100 },
    });
    for (const host of [1, 2, 3, 4])
      reporter.offer(...written(`192.0.2.${host}`));
    expect(reporter.pending).toBe(3);
    expect(reporter.dropped).toBe(1);
    const batch = reporter.take();
    reporter.requeue(batch);
    expect(reporter.pending).toBe(3);
  });
});

describe("the engine", () => {
  it("hands its layers' writes to watchBans, the ladder's with its step, never ban()'s; unsubscribes", async () => {
    const security = createSecurity({
      policy: {
        requestRules: { managed: false },
        ladder: { weights: { probe: 4 } },
      },
      logger: () => {},
    });
    const seen: [Ban, BanWrite][] = [];
    const stop = security.watchBans((ban, write) => seen.push([ban, write]));
    // 4 reaches the challenge step (3): step 1; 4 more, 8: still 1; then the ban (10): step 2.
    await security.signal(facts({ client: "203.0.113.50" }), "probe");
    await security.signal(facts({ client: "203.0.113.50" }), "probe");
    await security.signal(facts({ client: "203.0.113.50" }), "probe");
    const steps = seen.map(([ban, write]) => [
      write.source,
      write.rule,
      write.step,
      ban.step,
    ]);
    expect(steps.at(0)).toEqual(["auto", "ladder", 1, 1]);
    expect(steps.at(-1)).toEqual(["auto", "ladder", 2, 2]);
    // ban() (an operator's, or the control plane's applied by the agent) is not handed on.
    const before = seen.length;
    security.ban({ ip: "203.0.113.51", reason: "by hand" });
    expect(seen.length).toBe(before);
    stop();
    await security.signal(facts({ client: "203.0.113.53" }), "probe");
    await security.signal(facts({ client: "203.0.113.53" }), "probe");
    await security.signal(facts({ client: "203.0.113.53" }), "probe");
    expect(seen.length).toBe(before);
  });
});

describe("reported to the control plane", () => {
  /** A control plane, an agent on an engine whose ladder bans at the first probe. */
  async function setup() {
    const cp = await controlPlane();
    const security = createSecurity({
      policy: {
        requestRules: { managed: false },
        ladder: { weights: { probe: 10 } },
      },
      logger: () => {},
      now: cp.clock.now,
    });
    const { agent } = agentOn(cp, { security });
    await agent.ready;
    const alerts: SecurityAlertDto[] = [];
    cp.api.plane.onAlert((alert) => alerts.push(alert));
    return { cp, security, agent, alerts };
  }

  it("stores each as an automatic ban of the agent's service, with its rule and ladder step", async () => {
    const { cp, security, agent } = await setup();
    await security.signal(facts({ client: "203.0.113.60" }), "probe");
    await agent.reportBans();
    const page = await cp.call(
      "GET",
      "/bans?scope=service%3Acheckout&source=auto",
    );
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(1);
    const ban = page.body.items[0];
    expect(ban).toMatchObject({
      scope: "service:checkout",
      subject: { type: "ip", value: "203.0.113.60" },
      source: "auto",
      rule: "ladder",
      step: 2,
      active: true,
    });
    const detail = await cp.call("GET", `/bans/${ban.id}`);
    expect(detail.body.ladderStep).toBe(2);
    expect(agent.status().banReports).toEqual({ pending: 0, dropped: 0 });
  });

  it("a lift from the UI reaches the engine, and a re-report of that ban does not re-create it", async () => {
    const { cp, security, agent } = await setup();
    await security.signal(facts({ client: "203.0.113.61" }), "probe");
    await agent.reportBans();
    const id = (await cp.call("GET", "/bans?source=auto")).body.items[0].id;
    const engineBan = security
      .bans()
      .find((b) => b.subject.value === "203.0.113.61")!;
    expect(engineBan).toBeDefined();
    // The control plane pushes its copy to the service's agents.
    await agent.sync();
    cp.clock.advance(1_000);
    expect((await cp.call("POST", `/bans/${id}/lift`)).status).toBe(200);
    await agent.sync();
    expect(
      security.bans().some((b) => b.subject.value === "203.0.113.61"),
    ).toBe(false);
    // A late report of the ban the operator lifted is remembered as lifted.
    const late = await cp.api.plane.reportBans("checkout", [
      {
        subject: { type: "ip", value: "203.0.113.61" },
        action: "ban",
        reason: "late",
        rule: "ladder",
        createdAt: engineBan.createdAt,
        expiresAt: null,
      },
    ]);
    expect(late).toEqual({ stored: 0, lifted: 1 });
    expect((await cp.call("GET", `/bans/${id}`)).body.ban.active).toBe(false);
    // The control: a ban started after the lift is a new one.
    const fresh = await cp.api.plane.reportBans("checkout", [
      {
        subject: { type: "ip", value: "203.0.113.61" },
        action: "ban",
        reason: "again",
        rule: "ladder",
        createdAt: cp.clock.now() + 1,
        expiresAt: null,
      },
    ]);
    expect(fresh).toEqual({ stored: 1, lifted: 0 });
    expect((await cp.call("GET", `/bans/${id}`)).body.ban.active).toBe(true);
  });

  it("past the cap, the drops ride the next heartbeat and the control plane alerts", async () => {
    const { cp, security, agent, alerts } = await setup();
    for (let i = 0; i < 603; i++) {
      await security.signal(
        facts({ client: `44.1.${Math.floor(i / 250)}.${i % 250}` }),
        "probe",
      );
    }
    expect(agent.status().banReports).toEqual({ pending: 600, dropped: 3 });
    await agent.reportBans();
    expect(agent.status().banReports).toEqual({ pending: 0, dropped: 3 });
    const stored = await cp.store.listBans({ limit: 1_000, source: "auto" });
    expect(stored.items).toHaveLength(600);
    await agent.heartbeat();
    expect(alerts.map((alert) => [alert.kind, alert.detail])).toEqual([
      [
        "agent.banReportsDropped",
        { agent: "checkout-1", service: "checkout", dropped: 3 },
      ],
    ]);
    expect(
      (await cp.call("GET", "/agents/checkout-1")).body.reported.bansDropped,
    ).toBe(3);
    expect(agent.status().banReports?.dropped).toBe(0);
    // The control: a heartbeat with nothing dropped raises nothing.
    await agent.heartbeat();
    expect(alerts).toHaveLength(1);
    expect(
      (await cp.call("GET", "/agents/checkout-1")).body.reported.bansDropped,
    ).toBe(0);
  });

  it("refuses a malformed batch, and one signed for another route", async () => {
    const { cp } = await setup();
    const { isBanReportBatch } = await import("../../lib/control/agentRoutes");
    const good = {
      route: "banReports",
      sentAt: 1,
      bans: [
        {
          subject: { type: "ip", value: "192.0.2.1" },
          action: "ban",
          reason: "r",
          createdAt: 1,
          expiresAt: null,
        },
      ],
    };
    expect(isBanReportBatch(good)).toBe(true);
    for (const bad of [
      { ...good, extra: 1 },
      { ...good, bans: Array.from({ length: 501 }, () => good.bans[0]) },
      {
        ...good,
        bans: [{ ...good.bans[0], subject: { type: "ip|user", value: "x" } }],
      },
      { ...good, bans: [{ ...good.bans[0], step: 0 }] },
      { ...good, bans: [{ ...good.bans[0], reason: "" }] },
      { ...good, bans: [{ ...good.bans[0], password: "x" }] },
    ]) {
      expect(isBanReportBatch(bad as Record<string, unknown>)).toBe(false);
    }
    // Unsigned: refused before the body is read.
    const unsigned = await cp.app.fetch(
      new Request(`http://cp.test${cp.api.basePath}/agent/ban-reports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(good),
      }),
    );
    expect(unsigned.status).toBe(401);
  });
});

describe("retention", () => {
  it("purges the automatic bans that ended more than 30 days ago, audited; manual bans stay", async () => {
    const cp = await controlPlane();
    await cp.api.plane.reportBans("checkout", [
      {
        subject: { type: "ip", value: "192.0.2.80" },
        action: "ban",
        reason: "r",
        rule: "ladder",
        createdAt: cp.clock.now(),
        expiresAt: cp.clock.now() + DAY,
      },
    ]);
    await cp.call("POST", "/bans", {
      ip: "192.0.2.81",
      reason: "by hand",
      duration: "1d",
    });
    cp.clock.advance(20 * DAY);
    expect(await cp.api.purgeAutoBans()).toBe(0);
    cp.clock.advance(15 * DAY);
    expect(await cp.api.purgeAutoBans()).toBe(1);
    const left = await cp.store.listBans({ limit: 10 });
    expect(left.items.map((ban) => ban.source)).toEqual(["manual"]);
    const audit = await cp.call("GET", "/audit?action=bans.purge");
    expect(audit.body.items[0].entry).toMatchObject({ count: 1 });
  });

  it("is off with autoRetention: false, and refuses less than an hour", async () => {
    const off = await controlPlane({
      bans: {
        secret: "fleet-keying-secret-for-tests-0123456789",
        autoRetention: false,
      },
    });
    expect(await off.api.purgeAutoBans()).toBe(0);
    await expect(
      controlPlane({
        bans: {
          secret: "fleet-keying-secret-for-tests-0123456789",
          autoRetention: "10m",
        },
      }),
    ).rejects.toThrow("autoRetention");
  });
});
