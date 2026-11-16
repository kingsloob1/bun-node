/**
 * Who shares bans and offence scores (`state.scope`): `"shared"` (the
 * default), every shared service on the store's namespace; `"service"`, a
 * service's own processes alone. Mixed on one namespace: shared services
 * share among themselves, each per-service service keeps to itself, and
 * neither side reads the other's bans or scores.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { compilePolicy, SecurityPolicyError } from "../../lib/index";
import type { Security, SecurityPolicy } from "../../lib/index";
import { facts } from "../helpers";
import { fleet } from "./fleet";
import type { Fleet } from "./fleet";

const open: Fleet[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});

/** A policy for `service` in `scope`, with a ladder banning at 10 (`probe.hit` weighs 4). */
function policy(service: string, scope?: "shared" | "service"): SecurityPolicy {
  return {
    service,
    ...(scope === undefined ? {} : { state: { scope } }),
    ladder: {
      steps: [{ score: 10, action: "ban", duration: "1h" }],
      weights: { "probe.hit": 4 },
    },
  };
}

/** A fleet of one engine per policy, ready. */
async function services(...policies: SecurityPolicy[]): Promise<Security[]> {
  const f = fleet(0, {});
  open.push(f);
  const engines = policies.map((p) => f.add(p).security);
  await Promise.all(engines.map((engine) => engine.ready()));
  return engines;
}

/** Every engine flushed (writes, then reads), twice so each reads the others'. */
async function settle(engines: readonly Security[]): Promise<void> {
  for (let i = 0; i < 2; i++) {
    for (const engine of engines) await engine.flush();
  }
}

/** Whether `engine` refuses `ip` with a ban. */
async function banned(engine: Security, ip: string): Promise<boolean> {
  return (await engine.evaluate(facts({ client: ip }))).action === "ban";
}

describe("state.scope: bans", () => {
  it("shared (the default): a ban written by one service is enforced by another", async () => {
    const [a, b] = await services(policy("a"), policy("b"));
    if (a === undefined || b === undefined) throw new Error("two");
    a.ban({ ip: "203.0.113.80" });
    await settle([a, b]);
    expect(await banned(b, "203.0.113.80")).toBe(true);
    expect(a.bans()[0]?.scope).toBeUndefined();
  });

  it("service: a ban reaches the service's other processes, never another service (the negative control above)", async () => {
    const [a1, a2, b] = await services(
      policy("a", "service"),
      policy("a", "service"),
      policy("b", "service"),
    );
    if (a1 === undefined || a2 === undefined || b === undefined) {
      throw new Error("three");
    }
    a1.ban({ ip: "203.0.113.81", reason: "manual" });
    await settle([a1, a2, b]);
    expect(await banned(a2, "203.0.113.81")).toBe(true);
    expect(await banned(b, "203.0.113.81")).toBe(false);
    expect(b.bans()).toHaveLength(0);
    // A manual ban takes the service's scope.
    expect(a1.bans()[0]).toMatchObject({ scope: "service", service: "a" });
  });

  it("mixed: shared services share with each other only; a per-service one keeps to itself both ways", async () => {
    const [a, b1, b2, c] = await services(
      policy("a", "shared"),
      policy("b", "service"),
      policy("b", "service"),
      policy("c"),
    );
    if (!a || !b1 || !b2 || !c) throw new Error("four");
    a.ban({ ip: "203.0.113.82" });
    b1.ban({ ip: "203.0.113.83" });
    await settle([a, b1, b2, c]);
    // a's shared ban: c yes, b no.
    expect(await banned(c, "203.0.113.82")).toBe(true);
    expect(await banned(b1, "203.0.113.82")).toBe(false);
    expect(await banned(b2, "203.0.113.82")).toBe(false);
    // b's own ban: b's processes yes, a and c no.
    expect(await banned(b2, "203.0.113.83")).toBe(true);
    expect(await banned(a, "203.0.113.83")).toBe(false);
    expect(await banned(c, "203.0.113.83")).toBe(false);
  });

  it("mixed: the same subject banned in both scopes is two bans; a lift ends only its own", async () => {
    const [a, b1, b2] = await services(
      policy("a"),
      policy("b", "service"),
      policy("b", "service"),
    );
    if (!a || !b1 || !b2) throw new Error("three");
    a.ban({ ip: "203.0.113.84" });
    b1.ban({ ip: "203.0.113.84" });
    await settle([a, b1, b2]);
    b1.unban("ip:203.0.113.84");
    await settle([a, b1, b2]);
    expect(await banned(b2, "203.0.113.84")).toBe(false);
    expect(await banned(a, "203.0.113.84")).toBe(true);
  });

  it("a reconcile and a snapshot keep every scope's bans, whoever writes the snapshot", async () => {
    const f = fleet(0, {}, { store: { reconcileInterval: "100ms" } });
    open.push(f);
    const a = f.add(policy("a")).security;
    const b = f.add(policy("b", "service")).security;
    await Promise.all([a.ready(), b.ready()]);
    a.ban({ ip: "203.0.113.85" });
    b.ban({ ip: "203.0.113.86" });
    await settle([a, b]);
    // Reconciles run; one of them writes the snapshot.
    await Bun.sleep(400);
    const lateB = f.add(policy("b", "service")).security;
    const lateC = f.add(policy("c")).security;
    await Promise.all([lateB.ready(), lateC.ready()]);
    expect(lateB.bans().map((ban) => ban.id)).toEqual(["ip:203.0.113.86"]);
    expect(lateC.bans().map((ban) => ban.id)).toEqual(["ip:203.0.113.85"]);
  });

  it("a policy changing its scope changes which bans apply, from the store", async () => {
    const [a, c] = await services(policy("a"), policy("c"));
    if (!a || !c) throw new Error("two");
    c.ban({ ip: "203.0.113.87" });
    await settle([a, c]);
    expect(await banned(a, "203.0.113.87")).toBe(true);
    a.load(policy("a", "service"));
    expect(await banned(a, "203.0.113.87")).toBe(false);
    a.load(policy("a", "shared"));
    expect(await banned(a, "203.0.113.87")).toBe(true);
  });
});

describe("state.scope: offence scores", () => {
  it("add up across services when shared, and only within the service when not", async () => {
    const run = async (scope: "shared" | "service") => {
      const [a, b] = await services(policy("a", scope), policy("b", scope));
      if (!a || !b) throw new Error("two");
      const client = facts({ client: "198.51.100.90" });
      await a.signal(client, "probe.hit");
      await a.signal(client, "probe.hit");
      await settle([a, b]);
      await b.signal(client, "probe.hit");
      await settle([a, b]);
      return (await b.signal(client, "probe.hit")).map((hit) => hit.rule);
    };
    // Shared: 8 from a + 4 + 4 on b passes 10.
    expect(await run("shared")).toEqual(["ladder"]);
    // Per service: b has 8 of its own.
    expect(await run("service")).toEqual([]);
  });

  it("add up across one service's processes in per-service scope", async () => {
    const [a1, a2] = await services(
      policy("a", "service"),
      policy("a", "service"),
    );
    if (!a1 || !a2) throw new Error("two");
    const client = facts({ client: "198.51.100.91" });
    await a1.signal(client, "probe.hit");
    await a1.signal(client, "probe.hit");
    await settle([a1, a2]);
    await a2.signal(client, "probe.hit");
    await settle([a1, a2]);
    expect(
      (await a2.signal(client, "probe.hit")).map((hit) => hit.rule),
    ).toEqual(["ladder"]);
  });
});

describe("state.scope's checks", () => {
  it('refuses a bad value, and "service" without the policy\'s service', () => {
    const issues = (input: unknown): string[] => {
      try {
        compilePolicy(input as never);
        return [];
      } catch (error) {
        if (!(error instanceof SecurityPolicyError)) throw error;
        return error.issues.map((issue) => issue.path.join("."));
      }
    };
    expect(issues({ state: { scope: "group" } })).toEqual(["state.scope"]);
    expect(issues({ state: { scope: "service" } })).toEqual(["state.scope"]);
    expect(issues({ service: "a", state: { scope: "service" } })).toEqual([]);
  });
});
