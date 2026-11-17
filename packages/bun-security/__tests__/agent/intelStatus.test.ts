/**
 * Intel status in the heartbeat (PR-AN): the engine's IP feeds (size, last
 * refresh, last attempt, last failure cut to 200 characters, at most 32)
 * reach the control plane's agent record. The negative control: an engine
 * whose intel reports no status sends none.
 */
import { afterAll, describe, expect, it } from "bun:test";
import type { IntelLookup } from "../../lib/intel/types";
import { createSecurity } from "../../lib/index";
import { agentOn, cleanUp, controlPlane } from "./fixture";

afterAll(cleanUp);

/** Intel whose `status()` reports `count` feeds. */
function intel(count: number, withStatus = true): IntelLookup {
  const lookup: IntelLookup = {
    lookup: () => ({ classes: [] }),
    provides: () => ({
      country: false,
      asn: false,
      classes: new Set<string>(),
    }),
  };
  if (!withStatus) return lookup;
  return Object.assign(lookup, {
    status: () => ({
      databases: [],
      classes: {},
      cached: 0,
      feeds: Array.from({ length: count }, (_, i) => ({
        id: `feed-${i}`,
        class: "tor",
        entries: 1_000 + i,
        source: "fetch",
        updatedAt: i === 0 ? undefined : 100,
        attemptedAt: 200,
        error: i === 0 ? "x".repeat(300) : undefined,
        dueAt: 0,
      })),
    }),
  });
}

describe("intel status in the heartbeat", () => {
  it("reaches the agent record, bounded at 32 feeds and 200 characters", async () => {
    const cp = await controlPlane();
    const security = createSecurity({
      policy: {},
      logger: () => {},
      now: cp.clock.now,
      intel: intel(40),
    });
    const { agent } = agentOn(cp, { security });
    await agent.ready;
    await agent.heartbeat();
    const reported = (await cp.call("GET", "/agents/checkout-1")).body.reported;
    expect(reported.intel.feeds).toHaveLength(32);
    expect(reported.intel.feeds[0]).toEqual({
      id: "feed-0",
      size: 1_000,
      refreshedAt: null,
      attemptedAt: 200,
      error: "x".repeat(200),
    });
    expect(reported.intel.feeds[1]).toEqual({
      id: "feed-1",
      size: 1_001,
      refreshedAt: 100,
      attemptedAt: 200,
    });
  });

  it("negative control: an intel without status() sends none", async () => {
    const cp = await controlPlane();
    const security = createSecurity({
      policy: {},
      logger: () => {},
      now: cp.clock.now,
      intel: intel(0, false),
    });
    const { agent } = agentOn(cp, { security });
    await agent.ready;
    await agent.heartbeat();
    expect(
      (await cp.call("GET", "/agents/checkout-1")).body.reported.intel,
    ).toBeUndefined();
  });
});
