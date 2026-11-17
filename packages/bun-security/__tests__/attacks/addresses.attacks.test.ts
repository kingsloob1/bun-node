/**
 * Address games against ConcaveHR's request path (plan §11.2, §12; layers.md
 * L2, L5, L9): IPv6 rotation inside one /64 (T-L2-3), rotating Tor exits
 * (ConcaveHR's second wave), a key-cardinality flood (T-L9-2), a burst, and
 * a spoofed `X-Forwarded-For` on the plain `Bun.serve` path (T-L2-1). Each
 * with its negative control.
 */
import { describe, expect, it } from "bun:test";
import { memoryThrottleStore } from "@kingsleyweb/bun-common";
import { createSecurity } from "../../lib/index";
import { withSecurity } from "../../lib/serve/index";
import {
  addressRotation,
  burst,
  forwardedForSpoof,
  handlerTarget,
  ipv6Rotation,
  keyCardinalityFlood,
  paced,
  runAttack,
} from "../../lib/testing/index";
import { fakeClock } from "../helpers";
import { CONCAVE_POLICY, concaveApp } from "./app";

describe("T-L2-3: one client rotating through 150 addresses of one IPv6 /64", () => {
  // 150 requests in 0.75 s against requests_per_second's 100 a second.
  const attack = paced(ipv6Rotation({ count: 150 }), 5);

  it("is one key: requests_per_second bans the /64 at its 100th request", async () => {
    const app = await concaveApp();
    const result = await app.run(attack);
    expect(new Set(attack.requests.map((request) => request.client)).size).toBe(
      150,
    );
    expect(result.firstRefused).toBe(99);
    expect(result.byStatus).toEqual({ "200": 99, "403": 51 });
    expect(app.security?.bans().map((ban) => [ban.id, ban.rule])).toEqual([
      ["ip:2001:db8:1:2::/64", "counted:requests_per_second"],
    ]);
  });

  it("negative control: 150 addresses in 150 different /64s are 150 clients, none over the limit", async () => {
    const app = await concaveApp();
    const spread = paced(
      addressRotation({
        addresses: Array.from(
          { length: 150 },
          (_, i) => `2001:db8:${(i + 1).toString(16)}::1`,
        ),
      }),
      5,
    );
    const result = await app.run(spread);
    expect(result.byStatus).toEqual({ "200": 150 });
    expect(app.security?.bans()).toEqual([]);
  });
});

describe("rotating Tor exits (ConcaveHR's second wave, write-up §1)", () => {
  const exits = Array.from({ length: 20 }, (_, i) => `192.0.2.${i + 1}`);
  const attack = paced(
    addressRotation({
      addresses: exits,
      path: "/careers/engineer",
      perAddress: 2,
    }),
    1000,
  );

  it("refuses every exit with the Tor rule, whatever the address", async () => {
    const app = await concaveApp();
    const result = await app.run(attack);
    expect(result.byStatus).toEqual({ "403": 40 });
    expect(result.codes).toEqual({ blocked: 40 });
    expect(app.fired()).toEqual(["rule:tor_exit_nodes:block"]);
  });

  it("negative control: without the rule every exit is served", async () => {
    const app = await concaveApp({
      policy: { requestRules: { managed: { mode: "enforce" } } },
    });
    const result = await app.run(attack);
    expect(result.byStatus).toEqual({ "200": 40 });
  });
});

describe("T-L9-2: a key-cardinality flood, 3,000 addresses probing /.env once each", () => {
  // A distributed scan: each address probes once, so each gets an offence
  // score (the probe's weight, below the ladder's ban) and the scores
  // table must hold 3,000 keys.
  const attack = paced(keyCardinalityFlood({ count: 3000, path: "/.env" }), 2);

  it("keeps the scores within maxKeys, counts the evictions, warns once, and still refuses every probe", async () => {
    const clock = fakeClock();
    const app = await concaveApp({ engine: { maxKeys: 500 }, clock });
    const result = await app.run(attack);
    expect(result.refused).toBe(3000);
    expect(result.codes).toEqual({ not_found: 3000 });
    const state = app.security!.status().state;
    expect(state.scores).toBe(500);
    expect(state.evictions).toBe(2500);
    expect(
      app.warnings.filter((warning) => warning.kind === "state.evictions"),
    ).toHaveLength(1);
    // In force for 5 minutes in status(), what an agent's heartbeat reports (PR-CP6).
    const kinds = () =>
      app.security!.status().warnings.map((warning) => warning.kind);
    expect(kinds()).toContain("state.evictions");
    clock.advance(4 * 60_000);
    expect(kinds()).toContain("state.evictions");
    clock.advance(2 * 60_000);
    expect(kinds()).not.toContain("state.evictions");
  });

  it("negative control: under the default bound nothing is evicted and nothing warns", async () => {
    const app = await concaveApp();
    const result = await app.run(attack);
    expect(result.refused).toBe(3000);
    const state = app.security!.status().state;
    expect(state.scores).toBe(3000);
    expect(state.evictions).toBe(0);
    expect(app.warnings).toEqual([]);
    expect(app.security!.status().warnings).toEqual([]);
  });

  it("plain traffic from 3,000 addresses: the default store's counters stay within maxKeys, each drop counted and warned of once, no one refused", async () => {
    // Nothing scores here: each address only counts in the limits' store,
    // whose drops at maxKeys the engine now counts (bun-common #821). The
    // same run on a store of the app's own (below) gives the exact figure:
    // its `evictions` counts its "cap" drops.
    const flood = paced(keyCardinalityFlood({ count: 3000 }), 2);
    const own = memoryThrottleStore({ maxKeys: 500, now: fakeClock().now });
    const reference = await concaveApp({
      clock: fakeClock(),
      engine: { maxKeys: 500, throttleStore: own },
    });
    await reference.run(flood);
    expect(own.evictions).toBeGreaterThan(2000);

    const app = await concaveApp({
      clock: fakeClock(),
      engine: { maxKeys: 500 },
    });
    const result = await app.run(flood);
    expect(result.byStatus).toEqual({ "200": 3000 });
    const state = app.security!.status().state;
    expect(state.evictions).toBe(own.evictions);
    expect(state.warning?.message).toContain("rate-limit counters");
    expect(
      app.warnings.filter((warning) => warning.kind === "state.evictions"),
    ).toHaveLength(1);
  });

  it("control: a throttleStore the app passes is its own, and the engine counts none of its drops", async () => {
    const clock = fakeClock();
    const counters = memoryThrottleStore({ maxKeys: 500, now: clock.now });
    const app = await concaveApp({
      clock,
      engine: { maxKeys: 500, throttleStore: counters },
    });
    const result = await app.run(
      paced(keyCardinalityFlood({ count: 3000 }), 2),
    );
    expect(result.byStatus).toEqual({ "200": 3000 });
    expect(counters.size).toBeLessThanOrEqual(500);
    expect(counters.evictions).toBeGreaterThan(0);
    expect(app.security!.status().state.evictions).toBe(0);
    expect(app.warnings).toEqual([]);
  });

  it("control: under the default bound the same traffic evicts nothing and warns of nothing", async () => {
    const app = await concaveApp({ clock: fakeClock() });
    const result = await app.run(
      paced(keyCardinalityFlood({ count: 3000 }), 2),
    );
    expect(result.byStatus).toEqual({ "200": 3000 });
    expect(app.security!.status().state.evictions).toBe(0);
    expect(app.warnings).toEqual([]);
  });
});

describe("a burst of 150 requests in one instant", () => {
  it("is banned by requests_per_second at its 100th", async () => {
    const app = await concaveApp();
    const result = await app.run(burst({ count: 150, path: "/pricing" }));
    expect(result.firstRefused).toBe(99);
    expect(result.byStatus).toEqual({ "200": 99, "403": 51 });
  });

  it("negative control: without the counted rule (and under per-ip's 600) all 150 are served", async () => {
    const app = await concaveApp({
      policy: {
        countedRules: CONCAVE_POLICY.countedRules?.filter(
          (rule) => rule.id !== "requests_per_second",
        ),
      },
    });
    const result = await app.run(burst({ count: 150, path: "/pricing" }));
    expect(result.byStatus).toEqual({ "200": 150 });
  });
});

describe("T-L2-1: a spoofed X-Forwarded-For from an untrusted peer, on withSecurity", () => {
  const PEER = "198.51.100.7";
  const CLAIMED = "203.0.113.5";

  /** `withSecurity` over a plain handler, the peer untrusted (no trustProxy). */
  function served() {
    const security = createSecurity<Request>({ policy: {}, logger: () => {} });
    const handler = withSecurity(security, () => new Response("ok"), {
      logger: () => {},
    });
    return { security, target: handlerTarget(handler) };
  }

  it("a ban on the claimed address does not block it; a ban on the peer does", async () => {
    const { security, target } = served();
    const attack = forwardedForSpoof({
      peer: PEER,
      claimed: CLAIMED,
      count: 3,
    });
    security.ban({ ip: CLAIMED, duration: "1h" });
    expect((await runAttack(attack, target)).byStatus).toEqual({ "200": 3 });
    security.ban({ ip: PEER, duration: "1h" });
    const banned = await runAttack(attack, target);
    expect(banned.byStatus).toEqual({ "403": 3 });
    expect(banned.codes).toEqual({ banned: 3 });
  });

  it("negative control: the claim cannot hide a banned peer, and cannot frame the address it names", async () => {
    const { security, target } = served();
    security.ban({ ip: PEER, duration: "1h" });
    // The claimed address, coming from itself, is not the one banned.
    const honest = await runAttack(
      addressRotation({ addresses: [CLAIMED] }),
      target,
    );
    expect(honest.byStatus).toEqual({ "200": 1 });
  });
});
