/**
 * Crawler conflicts in the heartbeat (layers.md L3.2, PR-AN2): the engine's
 * conflicts (an allowed crawler, the refusing list entry or manual ban whose
 * subject covers its published ranges, one range) reach the control plane's
 * agent record, at most 32 with the count found; each entry named by the
 * key the effective policy's paths use. The report is checked again when
 * the bundle or the bans change, else every 5 minutes. The control plane
 * refuses a malformed list. Each has its negative control.
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
  AGENT_HEADER,
  AGENT_SIGNATURE_HEADER,
  agentEnvelope,
} from "../../lib/agent/protocol";
import { createSecurity } from "../../lib/index";
import type { IntelLookup } from "../../lib/intel/types";
import { agentOn, cleanUp, controlPlane } from "./fixture";

afterAll(cleanUp);

type ControlPlaneFixture = Awaited<ReturnType<typeof controlPlane>>;

/** Intel that knows Google's ranges (`crawler:google`) and nothing else. */
function intel(ranges: readonly string[]): IntelLookup {
  return {
    lookup: () => ({ classes: [] }),
    provides: () => ({
      country: false,
      asn: false,
      classes: new Set(["crawler:google"]),
    }),
    ranges: (name) => (name === "crawler:google" ? ranges : []),
  };
}

/** Publishes `policy` at global. */
async function publish(cp: ControlPlaneFixture, policy: unknown) {
  const read = (await cp.call("GET", "/policies/global")).body;
  const saved = await cp.call("PUT", "/policies/global/draft", {
    policy,
    revision: read.draft?.revision ?? null,
  });
  expect(saved.status).toBe(200);
  const published = await cp.call("POST", "/policies/global/publish", {
    expectedHead: read.head?.id ?? null,
    confirm: "global",
  });
  expect(published.status).toBe(200);
}

/** The agent record's reported crawler conflicts. */
async function reported(cp: ControlPlaneFixture) {
  return (await cp.call("GET", "/agents/checkout-1")).body.reported.crawlers;
}

/** Posts a signed heartbeat body as agent `checkout-1`; the status. */
async function postBeat(
  cp: ControlPlaneFixture,
  over: Record<string, unknown>,
): Promise<number> {
  const body = JSON.stringify({
    route: "heartbeat",
    sentAt: 1,
    agentVersion: "test",
    bundle: null,
    bans: { seq: "0", count: 0 },
    health: "ok",
    ...over,
  });
  const signature = await agentEnvelope.signEnvelope(body, {
    direction: "request",
    secret: cp.secret,
    now: cp.clock.now(),
  });
  const response = await cp.app.fetch(
    new Request(`http://cp.test${cp.api.basePath}/agent/heartbeat`, {
      method: "POST",
      headers: {
        [AGENT_HEADER]: "checkout-1",
        [AGENT_SIGNATURE_HEADER]: signature,
        "content-type": "application/json",
      },
      body,
    }),
  );
  await response.text();
  return response.status;
}

describe("crawler conflicts in the heartbeat", () => {
  it("reach the agent record, each entry keyed as the effective policy names it", async () => {
    const cp = await controlPlane();
    await publish(cp, {
      lists: [
        { id: "no-google", ip: "66.249.66.0/24", action: "block" },
        { ip: "66.249.67.0/24", action: "block", paths: ["/a"] },
        { ip: "198.51.100.0/24", action: "block" },
      ],
    });
    const security = createSecurity({
      policy: {},
      logger: () => {},
      now: cp.clock.now,
      intel: intel(["66.249.64.0/19"]),
    });
    const { agent } = agentOn(cp, { security });
    await agent.ready;
    await agent.sync();
    const ban = security.ban({ ip: "66.249.70.1", reason: "by hand" });
    // A ban is local here: the next check is the 5-minute one.
    cp.clock.advance(5 * 60_000);
    await agent.heartbeat();
    const crawlers = await reported(cp);
    expect(crawlers).toEqual({
      conflicts: [
        { crawler: "google", entry: "no-google", range: "66.249.64.0/19" },
        {
          crawler: "google",
          entry: "ip:66.249.67.0/24|/a",
          range: "66.249.64.0/19",
        },
        { crawler: "google", ban: ban.id, range: "66.249.64.0/19" },
      ],
      total: 3,
    });
    // Every entry key is a path of the service's effective policy.
    const origins = (await cp.call("GET", "/services/checkout/effective")).body
      .origins as Record<string, string>;
    for (const conflict of crawlers.conflicts.filter(
      (c: { entry?: string }) => c.entry !== undefined,
    )) {
      expect(origins[`lists[id=${conflict.entry}]`]).toBe("global");
    }
    await agent.close();
  });

  it("carries at most 32, with the count found", async () => {
    const cp = await controlPlane();
    await publish(cp, {
      lists: Array.from({ length: 40 }, (_, i) => ({
        ip: `66.249.${i}.0/24`,
        action: "block",
      })),
    });
    const security = createSecurity({
      policy: {},
      logger: () => {},
      now: cp.clock.now,
      intel: intel(["66.249.0.0/16"]),
    });
    const { agent } = agentOn(cp, { security });
    await agent.ready;
    await agent.sync();
    await agent.heartbeat();
    const crawlers = await reported(cp);
    expect(crawlers.conflicts).toHaveLength(32);
    expect(crawlers.total).toBe(40);
    expect(crawlers.conflicts[0]).toEqual({
      crawler: "google",
      entry: "ip:66.249.0.0/24",
      range: "66.249.0.0/16",
    });
    await agent.close();
  });

  it("is checked again on a new bundle or after 5 minutes, not on every heartbeat", async () => {
    const cp = await controlPlane();
    const security = createSecurity({
      policy: {},
      logger: () => {},
      now: cp.clock.now,
      intel: intel(["66.249.64.0/19"]),
    });
    const { agent } = agentOn(cp, { security });
    await agent.ready;
    await agent.sync();
    await agent.heartbeat();
    expect(await reported(cp)).toEqual({ conflicts: [], total: 0 });
    // A local ban changes neither the bundle nor the control plane's bans:
    // the report stands until 5 minutes have passed.
    security.ban({ ip: "66.249.70.1", reason: "by hand" });
    cp.clock.advance(60_000);
    await agent.heartbeat();
    expect((await reported(cp)).total).toBe(0);
    cp.clock.advance(4 * 60_000);
    await agent.heartbeat();
    expect((await reported(cp)).total).toBe(1);
    // A new bundle is checked at once.
    await publish(cp, {
      lists: [{ ip: "66.249.66.0/24", action: "block" }],
    });
    await agent.sync();
    await agent.heartbeat();
    expect((await reported(cp)).total).toBe(2);
    await agent.close();
  });

  it("negative control: an engine without the check sends none", async () => {
    const cp = await controlPlane();
    const real = createSecurity({
      policy: {},
      logger: () => {},
      now: cp.clock.now,
    });
    // The agent's engine, without `crawlerConflicts`.
    const { crawlerConflicts: _dropped, ...rest } = Object.fromEntries(
      [
        "evaluate",
        "load",
        "ban",
        "unban",
        "status",
        "policy",
        "crawlerConflicts",
      ].map((key) => [
        key,
        typeof real[key as keyof typeof real] === "function"
          ? (
              real[key as keyof typeof real] as (...a: unknown[]) => unknown
            ).bind(real)
          : real[key as keyof typeof real],
      ]),
    );
    const { agent } = agentOn(cp, {
      security: rest as unknown as typeof real,
    });
    await agent.ready;
    await agent.heartbeat();
    const record = (await cp.call("GET", "/agents/checkout-1")).body.reported;
    expect(record.health).toBe("ok");
    expect(record.crawlers).toBeUndefined();
    await agent.close();
  });
});

describe("the control plane's check of a heartbeat's conflicts", () => {
  const conflict = {
    crawler: "google",
    entry: "ip:66.249.66.0/24",
    range: "66.249.64.0/19",
  };
  it("takes a well-formed list (the negative control)", async () => {
    const cp = await controlPlane();
    expect(
      await postBeat(cp, { crawlers: { conflicts: [conflict], total: 1 } }),
    ).toBe(200);
    expect(await reported(cp)).toEqual({ conflicts: [conflict], total: 1 });
  });

  it.each([
    [
      "more than 32",
      { conflicts: Array.from({ length: 33 }, () => conflict), total: 33 },
    ],
    ["a total under the list", { conflicts: [conflict, conflict], total: 1 }],
    [
      "both an entry and a ban",
      { conflicts: [{ ...conflict, ban: "b_1" }], total: 1 },
    ],
    [
      "neither an entry nor a ban",
      {
        conflicts: [{ crawler: "google", range: "66.249.64.0/19" }],
        total: 1,
      },
    ],
    [
      "a range that is not one",
      { conflicts: [{ ...conflict, range: "nope" }], total: 1 },
    ],
    [
      "a bad crawler id",
      { conflicts: [{ ...conflict, crawler: "-x" }], total: 1 },
    ],
    [
      "an unknown key",
      { conflicts: [{ ...conflict, message: "hi" }], total: 1 },
    ],
    [
      "an overlong entry",
      {
        conflicts: [{ ...conflict, entry: "e".repeat(301) }],
        total: 1,
      },
    ],
  ])("refuses %s", async (_name, crawlers) => {
    const cp = await controlPlane();
    expect(await postBeat(cp, { crawlers })).toBe(400);
  });
});
