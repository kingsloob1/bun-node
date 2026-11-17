/**
 * An enforcement point's warning reaching an alert, end to end (PR-CP6):
 * the engine's `status().warnings` (here a feed whose refresh failed), the
 * agent's heartbeat, the control plane's agent record, an `agentWarning`
 * rule, a webhook. The negative control: the same path with the feed
 * healthy raises nothing. And the heartbeat stays bounded at 16.
 */
import { afterAll, describe, expect, it } from "bun:test";
import type { IntelLookup } from "../../lib/intel/types";
import { alertRulePreset, memoryDeliveryQueue } from "../../lib/control/index";
import { createSecurity } from "../../lib/index";
import { agentOn, cleanUp, controlPlane } from "./fixture";

afterAll(cleanUp);

/** IP intelligence whose one feed fails while `failing.error` is set. */
function feedIntel(failing: { error: string | undefined; at: number }) {
  const intel: IntelLookup & { status: () => unknown } = {
    lookup: () => ({ classes: [] }),
    provides: () => ({
      country: false,
      asn: false,
      classes: new Set<string>(),
    }),
    status: () => ({
      databases: [],
      classes: {},
      cached: 0,
      feeds: [
        {
          id: "tor",
          class: "tor",
          entries: 1_000,
          source: "disk",
          updatedAt: 0,
          attemptedAt: failing.at,
          error: failing.error,
          dueAt: 0,
        },
      ],
    }),
  };
  return intel;
}

describe("a warning on an enforcement point becomes an alert", () => {
  it("feed refresh failed: engine → heartbeat → agent record → rule → webhook; nothing while healthy", async () => {
    const bodies: string[] = [];
    let queue: ReturnType<typeof memoryDeliveryQueue> | undefined;
    const cp = await controlPlane({
      alerts: {
        timers: false,
        fetch: async (_url, init) => {
          bodies.push(typeof init.body === "string" ? init.body : "");
          return new Response("", { status: 200 });
        },
        queue: (deliver) =>
          (queue = memoryDeliveryQueue({
            deliver,
            now: () => cp.clock.now(),
            timers: false,
          })),
      },
    });
    const alerts = cp.api.alerts!;
    const failing: { error: string | undefined; at: number } = {
      error: undefined,
      at: cp.clock.now(),
    };
    const security = createSecurity({
      policy: {},
      logger: () => {},
      now: cp.clock.now,
      intel: feedIntel(failing),
    });
    const { agent } = agentOn(cp, { security });
    await agent.ready;
    await cp.store.put(
      "alertChannel",
      "ops",
      {
        id: "ops",
        name: "Ops",
        type: "webhook",
        url: "https://hooks.example.com/x",
        secret: "s".repeat(43),
      },
      null,
    );
    await cp.store.put(
      "alertRule",
      "feeds",
      alertRulePreset("feedRefreshFailed", {
        id: "feeds",
        scope: "global",
        channels: ["ops"],
      }),
      null,
    );
    // Healthy: the heartbeat carries no warning, and nothing is raised.
    await agent.heartbeat();
    expect((await alerts.evaluate()).raised).toBe(0);
    expect(
      (await cp.call("GET", "/agents/checkout-1")).body.reported.warnings,
    ).toEqual([]);
    // The feed fails: the next heartbeat carries it, and the rule fires.
    failing.error = "HTTP 503 from feeds.internal.example";
    await agent.heartbeat();
    expect(
      (await cp.call("GET", "/agents/checkout-1")).body.reported.warnings,
    ).toEqual([{ kind: "feed.refresh-failed", since: failing.at }]);
    expect((await alerts.evaluate()).raised).toBe(1);
    await queue!.work();
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0]!);
    expect(body).toMatchObject({
      kind: "rule:feeds",
      severity: "warning",
      scope: "global",
      facts: {
        warning: "feed.refresh-failed",
        agent: "checkout-1",
        service: "checkout",
        since: failing.at,
      },
    });
    // The warning's message (the feed's error, a host name) stays with the host.
    expect(bodies[0]).not.toContain("feeds.internal.example");
    // Recovered: the alert closes.
    failing.error = undefined;
    cp.clock.advance(30_000);
    await agent.heartbeat();
    expect((await alerts.evaluate()).closed).toBe(1);
    alerts.close();
  });

  it("a heartbeat carries at most 16 warnings", async () => {
    const cp = await controlPlane();
    const many = Array.from({ length: 20 }, (_, i) => ({
      kind: `kind.n${i}`,
      since: 1,
      share: 0.5,
    }));
    const security = createSecurity({
      policy: {},
      logger: () => {},
      now: cp.clock.now,
    });
    const stub = Object.assign(Object.create(security) as typeof security, {
      status: () => ({ ...security.status(), warnings: many }),
    });
    const { agent } = agentOn(cp, { security: stub });
    await agent.ready;
    await agent.heartbeat();
    const reported = (await cp.call("GET", "/agents/checkout-1")).body.reported;
    expect(reported.warnings).toHaveLength(16);
    expect(reported.warnings[0]).toEqual({
      kind: "kind.n0",
      since: 1,
      share: 0.5,
    });
  });
});
