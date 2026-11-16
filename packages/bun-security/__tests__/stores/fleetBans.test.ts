/**
 * Bans across engines sharing a store (topologies.md §3.3, layers.md L4):
 * a ban written by one engine is enforced by the others through the bus at
 * once, or by the poll within its interval without one; lifts and automatic
 * bans travel the same way; an engine started later loads them before its
 * first request (`ready()`); a removed counted rule's bans stop applying in
 * its own service only; a failing store queues writes and raises
 * `store.unavailable` after 30 s.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { SecurityPolicy, SecurityWarning } from "../../lib/index";
import { facts, fakeClock } from "../helpers";
import { fleet } from "./fleet";
import type { Fleet } from "./fleet";

const open: Fleet[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});

/** A fleet, closed after the test. */
function make(...args: Parameters<typeof fleet>): Fleet {
  const f = fleet(...args);
  open.push(f);
  return f;
}

/** Waits until `check` holds, at most `ms`. */
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

/** The members, both present. */
function pair(f: Fleet) {
  const [a, b] = f.members;
  if (a === undefined || b === undefined) throw new Error("two members");
  return [a.security, b.security] as const;
}

describe("bans across engines", () => {
  it("a ban written by one engine refuses the client on another, through the bus", async () => {
    const f = make(2, {});
    const [a, b] = pair(f);
    await Promise.all([a.ready(), b.ready()]);
    a.ban({ ip: "203.0.113.9", reason: "scanner", by: "ops" });
    // a's write notifies; b reads on the bus's nudge, with no flush of its own.
    await a.flush();
    await until(() => b.bans().length === 1);
    const decision = await b.evaluate(facts({ client: "203.0.113.9" }));
    expect(decision.action).toBe("ban");
    expect(b.bans()[0]).toMatchObject({
      id: "ip:203.0.113.9",
      reason: "scanner",
      createdBy: "ops",
      source: "manual",
    });
    a.unban("ip:203.0.113.9", { by: "ops" });
    await a.flush();
    await until(() => b.bans().length === 0);
    expect((await b.evaluate(facts({ client: "203.0.113.9" }))).action).toBe(
      "allow",
    );
  });

  it("without a bus, the poll carries it within its interval (the negative control: not before)", async () => {
    const f = make(2, {}, { bus: false, store: { pollInterval: "100ms" } });
    const [a, b] = pair(f);
    await Promise.all([a.ready(), b.ready()]);
    a.ban({ ip: "203.0.113.10" });
    await a.flush();
    // Not yet: nothing nudged b, and its poll has not run.
    expect(b.bans()).toHaveLength(0);
    await until(() => b.bans().length === 1, 2000);
  });

  it("an automatic ban (a counted rule's trip) is enforced everywhere, naming its service", async () => {
    const policy: SecurityPolicy = {
      service: "auth",
      countedRules: [
        {
          id: "failed-password",
          event: "auth.failure",
          threshold: 2,
          window: "15m",
          duration: "1h",
        },
      ],
    };
    const f = make(2, policy);
    const [a, b] = pair(f);
    const client = facts({ client: "198.51.100.7" });
    // One failure on each engine: the shared counter trips on the second.
    await a.signal(client, "auth.failure");
    const hits = await b.signal(client, "auth.failure");
    expect(hits.map((hit) => hit.rule)).toEqual(["counted:failed-password"]);
    await b.flush();
    await until(() => a.bans().length === 1);
    expect(a.bans()[0]).toMatchObject({
      id: "ip:198.51.100.7",
      source: "auto",
      rule: "counted:failed-password",
      service: "auth",
    });
    expect((await a.evaluate(client)).action).toBe("ban");
  });

  it("an engine started later loads the bans before its first request (ready)", async () => {
    const f = make(1, {});
    const [a] = f.members;
    a?.security.ban({ ip: "203.0.113.11" });
    a?.security.ban({ user: "u_1", duration: null });
    await a?.security.flush();
    const late = f.add();
    await late.security.ready();
    expect(
      late.security
        .bans()
        .map((ban) => ban.id)
        .sort(),
    ).toEqual(["ip:203.0.113.11", "user:u_1"]);
  });

  it("a counted rule removed from a service's policy stops its bans in that service, not in another", async () => {
    const rule = {
      id: "r",
      event: "auth.failure",
      threshold: 1,
      window: "1m",
      duration: "1h",
    } as const;
    const f = make(1, { service: "auth", countedRules: [rule] });
    const [a] = f.members;
    if (a === undefined) throw new Error("one member");
    await a.security.signal(facts({ client: "198.51.100.8" }), "auth.failure");
    await a.security.flush();
    const sameService = f.add({ service: "auth" });
    const otherService = f.add({ service: "billing" });
    await Promise.all([
      sameService.security.ready(),
      otherService.security.ready(),
    ]);
    // The rule is gone from the "auth" policy: its bans no longer apply there.
    expect(sameService.security.bans()).toHaveLength(0);
    // Another service enforces the ban (its rules say nothing of auth's).
    expect(otherService.security.bans()).toHaveLength(1);
    // The writer drops it on loading a policy without the rule.
    a.security.load({ service: "auth" });
    expect(a.security.bans()).toHaveLength(0);
  });
});

describe("a failing store", () => {
  it("keeps enforcing from memory, queues the writes, and sends them when it answers", async () => {
    const clock = fakeClock();
    const f = make(
      2,
      {},
      { security: { now: clock.now }, store: { now: clock.now } },
    );
    const [a, b] = pair(f);
    f.driver.setFaults({ down: true });
    a.ban({ ip: "203.0.113.12" });
    await a.flush();
    expect((await a.evaluate(facts({ client: "203.0.113.12" }))).action).toBe(
      "ban",
    );
    expect(a.status().state.store).toMatchObject({
      healthy: false,
      pendingBans: 1,
    });
    f.driver.setFaults({});
    clock.advance(30_000);
    await a.flush();
    expect(a.status().state.store?.pendingBans).toBe(0);
    await b.flush();
    expect(b.bans().map((ban) => ban.id)).toEqual(["ip:203.0.113.12"]);
  });

  it("bounds the queue at maxPendingBans, counting what it drops", async () => {
    const f = make(1, {}, { security: { maxPendingBans: 2 } });
    const [a] = f.members;
    f.driver.setFaults({ down: true });
    for (const ip of ["203.0.113.13", "203.0.113.14", "203.0.113.15"]) {
      a?.security.ban({ ip });
    }
    await a?.security.flush();
    expect(a?.security.status().state.store).toMatchObject({
      pendingBans: 2,
      droppedBans: 1,
    });
  });

  it("raises store.unavailable once it has failed for 30 s, and again after it recovered and failed again", async () => {
    const clock = fakeClock();
    const warnings: SecurityWarning[] = [];
    const f = make(
      1,
      {},
      {
        security: {
          now: clock.now,
          onWarning: (warning) => warnings.push(warning),
        },
        store: { now: clock.now, pollInterval: "20ms" },
      },
    );
    const [a] = f.members;
    f.driver.setFaults({ down: true });
    a?.security.ban({ ip: "203.0.113.16" });
    await a?.security.flush();
    clock.advance(29_000);
    await Bun.sleep(80);
    expect(warnings).toHaveLength(0);
    clock.advance(1_000);
    await until(() => warnings.length === 1);
    expect(warnings[0]).toMatchObject({ kind: "store.unavailable" });
    await Bun.sleep(80);
    expect(warnings).toHaveLength(1);
    f.driver.setFaults({});
    clock.advance(30_000);
    await a?.security.flush();
    await until(() => a?.security.status().state.store?.healthy === true);
    await Bun.sleep(60);
    f.driver.setFaults({ down: true });
    await a?.security.flush();
    clock.advance(30_000);
    await until(() => warnings.length === 2);
  });
});
