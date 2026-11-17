/**
 * The global failure-rate rule (layers.md L11.2; the `login.failure-rate`
 * preset), on one engine: T2's finding — a spray from a fresh address per
 * attempt fired no M1 detector (60 of 60 answered) — closed when the preset
 * is enforced, recorded and warned of in its shipped dry run, and untouched
 * with it off; the baseline that keeps a noisy route quiet; who is answered
 * (`to`) and how (`respond`); the hold; and `explain()` agreeing.
 */
import type { IntelLookup, IntelRecord } from "../../lib/intel/types";
import type {
  Decision,
  RequestFacts,
  Security,
  SecurityPolicy,
  SecurityWarning,
} from "../../lib/index";
import type { FakeClock } from "../helpers";
import { describe, expect, it } from "bun:test";
import { challenges } from "../../lib/challenge/flow";
import { parseAddress } from "../../lib/ip/address";
import { compilePolicy, SecurityPolicyError } from "../../lib/index";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { engine, fakeClock, login, SECRET } from "./helpers";
import { passwordSpraying } from "../../lib/testing/index";

/** The rule alone: the other login presets and per-username defences off. */
function only(
  setting: boolean | "enforce",
  failureRate: NonNullable<
    NonNullable<NonNullable<SecurityPolicy["profiles"]>["login"]>
  > extends infer L
    ? L extends { failureRate?: infer F }
      ? F
      : never
    : never = {},
): SecurityPolicy {
  return {
    service: "auth",
    presets: {
      "login.account": false,
      "login.ip": false,
      "login.ip-failures": false,
      "login.ip-failures-ban": false,
      "per-ip": false,
      "login.failure-rate": setting,
    },
    profiles: {
      login: {
        distinctUsernames: false,
        distinctAddresses: false,
        failureRate: { minFailures: 20, ...failureRate },
      },
    },
  };
}

/** Whether a decision answers the request (anything but a refusal). */
const answers = (decision: Decision): boolean =>
  decision.action !== "block" && decision.action !== "challenge";

/** The spray's addresses' prefix: public, never internal, no other fixture's. */
const SPRAY_BASE = "100.200";

/**
 * T2's finding as T2's simulator builds it: `passwordSpraying` with a pool
 * as large as its username list, so every attempt is a fresh address and a
 * fresh username. Answers each attempt's username and address.
 */
function freshAddressSpray(
  count: number,
  offset = 0,
): { username: string; client: string }[] {
  const total = count + offset;
  const attack = passwordSpraying({
    usernames: Array.from(
      { length: total },
      (_, i) => `sprayed${i}@victims.test`,
    ),
    clients: total,
    base: SPRAY_BASE,
  });
  return attack.requests.slice(offset).map((request) => ({
    client: request.client,
    username: (JSON.parse(request.body ?? "{}") as { username: string })
      .username,
  }));
}

/** Runs a spray: each attempt decided, then its failure signalled; answers the decisions. */
async function spray(
  security: Security,
  count: number,
  offset = 0,
): Promise<Decision[]> {
  const decisions: Decision[] = [];
  for (const attempt of freshAddressSpray(count, offset)) {
    const request = login(attempt.username, attempt.client);
    const decision = await security.evaluate(request);
    decisions.push(decision);
    if (answers(decision)) {
      await security.signal(request, "auth.failure");
    }
    // The counts are read in the background; flush settles them.
    await security.flush();
  }
  return decisions;
}

/** The rule's hit on a decision, if any. */
const hitOf = (decision: Decision) =>
  decision.hits.find((hit) => hit.rule === "login:failure-rate");

/** `n` successful sign-ins from regular addresses, at the clock's time. */
async function succeed(
  security: Security,
  n: number,
  offset = 0,
): Promise<void> {
  for (let at = 0; at < n; at++) {
    const request = login(`user${at + offset}`, `203.0.113.${(at % 200) + 1}`);
    await security.evaluate(request);
    await security.signal(request, "auth.success");
  }
}

describe("T2's finding: a spray from a fresh address per attempt", () => {
  it("off: no detector fires, 60 of 60 answered (the finding)", async () => {
    const security = engine(only(false));
    const decisions = await spray(security, 60);
    expect(decisions.filter(answers)).toHaveLength(60);
    expect(decisions.some((d) => d.hits.length > 0)).toBe(false);
    expect(security.status().loginFailureRate).toBeUndefined();
  });

  it("enforced: tripped at its minimum, and every later attempt is refused", async () => {
    const warnings: SecurityWarning[] = [];
    const security = engine(only("enforce"), fakeClock(), {
      onWarning: (warning) => warnings.push(warning),
    });
    const decisions = await spray(security, 60);
    const answered = decisions.filter(answers).length;
    // The 20th failure trips it; the rest are refused.
    expect(answered).toBe(20);
    const refused = decisions[20]!;
    expect(refused.action).toBe("block");
    expect(hitOf(refused)?.reason).toContain("20 of 20 sign-ins failed");
    expect(
      warnings.filter((w) => w.kind === "login.failure-rate"),
    ).toHaveLength(1);
    expect(warnings[0]?.message).toContain("POST /login");
    expect(security.status().loginFailureRate).toEqual([
      expect.objectContaining({
        route: "POST /login",
        tripped: true,
        failures: 20,
      }),
    ]);
  });

  it("enforced with a challenge flow: challenged, not refused outright", async () => {
    const flow = challenges({
      provider: {
        id: "fake",
        field: "answer",
        issue: () => ({ provider: "fake", field: "answer", html: "" }),
        verify: () => ({ ok: true }),
      },
      secret: "s".repeat(32),
    });
    const security = engine(only("enforce"), fakeClock(), { challenge: flow });
    const decisions = await spray(security, 25);
    expect(decisions[20]?.action).toBe("challenge");
  });

  it("as shipped (true): dry run, every attempt answered, what it would do recorded, and warned of", async () => {
    const warnings: SecurityWarning[] = [];
    const security = engine(only(true), fakeClock(), {
      onWarning: (warning) => warnings.push(warning),
    });
    const decisions = await spray(security, 60);
    expect(decisions.filter(answers)).toHaveLength(60);
    const recorded = decisions.filter((d) => hitOf(d) !== undefined);
    expect(recorded).toHaveLength(40);
    expect(hitOf(recorded[0]!)).toMatchObject({
      action: "log",
      wouldHaveBeen: "block",
    });
    expect(warnings.map((w) => w.kind)).toEqual(["login.failure-rate"]);
    expect(warnings[0]?.message).toContain("dry run");
  });

  it("is on, in dry run, in a policy that says nothing about it", async () => {
    const compiled = compilePolicy({});
    expect(compiled).toBeDefined();
    const security = engine({
      presets: {
        "login.account": false,
        "login.ip": false,
        "login.ip-failures": false,
        "login.ip-failures-ban": false,
        "per-ip": false,
      },
      profiles: {
        login: { distinctUsernames: false, distinctAddresses: false },
      },
    });
    const decisions = await spray(security, 25);
    expect(decisions.every(answers)).toBe(true);
    expect(hitOf(decisions[24]!)).toMatchObject({ action: "log" });
  });
});

describe("the baseline", () => {
  it("a route that usually fails often does not trip at its usual rate, and trips well above it", async () => {
    const clock = fakeClock();
    const security = engine(only("enforce", { minFailures: 5 }), clock);
    // Hours of history: 40 % of sign-ins fail.
    for (let hour = 0; hour < 20; hour++) {
      for (let at = 0; at < 6; at++) {
        const request = login(`u${hour}-${at}`, `203.0.113.${at + 1}`);
        await security.signal(request, "auth.success");
      }
      for (let at = 0; at < 4; at++) {
        const request = login(`f${hour}-${at}`, `203.0.113.${at + 50}`);
        await security.signal(request, "auth.failure");
      }
      clock.advance(3_600_000);
    }
    await security.flush();
    // The same 40 % now: under 3 × the baseline's (capped at 90 %).
    await succeed(security, 9);
    for (let at = 0; at < 6; at++) {
      await security.signal(
        login(`now${at}`, `198.51.100.${at + 1}`),
        "auth.failure",
      );
    }
    await security.flush();
    expect(security.status().loginFailureRate?.[0]?.tripped).toBe(false);
    // A spray takes it past 90 %.
    const decisions = await spray(security, 120);
    expect(decisions.at(-1)?.action).toBe("block");
  });

  it("a surge of ordinary sign-ins (more attempts, the same ratio) trips nothing", async () => {
    const clock = fakeClock();
    const security = engine(only("enforce", { minFailures: 5 }), clock);
    // 20 hours at 12 failures and 108 successes an hour: 10 % fail.
    for (let hour = 0; hour < 20; hour++) {
      for (let at = 0; at < 108; at++) {
        await security.signal(
          login(`s${hour}-${at}`, "203.0.113.1"),
          "auth.success",
        );
      }
      for (let at = 0; at < 12; at++) {
        await security.signal(
          login(`f${hour}-${at}`, "203.0.113.2"),
          "auth.failure",
        );
      }
      clock.advance(3_600_000);
    }
    // A Monday morning: 6 × the volume in the window, still 10 % failing.
    for (let at = 0; at < 54; at++) {
      await security.signal(login(`ns${at}`, "203.0.113.1"), "auth.success");
    }
    for (let at = 0; at < 6; at++) {
      await security.signal(login(`nf${at}`, "203.0.113.2"), "auth.failure");
    }
    await security.flush();
    const [state] = security.status().loginFailureRate ?? [];
    expect(state?.ratio).toBeCloseTo(0.1, 1);
    expect(state?.baselineRatio).toBeCloseTo(0.1, 1);
    expect(state?.tripped).toBe(false);
  });
});

/** A fake IP intelligence: `hosting` for 198.18.0.0/16's addresses, an ASN per /24. */
function intel(): IntelLookup {
  return {
    lookup(address): IntelRecord {
      const text =
        typeof address === "string"
          ? (parseAddress(address)?.text ?? "")
          : address.text;
      const [a, b, c] = text.split(".");
      return a === "198" && b === "18"
        ? { asn: 64_500 + Number(c), classes: ["hosting"] }
        : { asn: 65_000, classes: [] };
    },
    provides: () => ({
      country: false,
      asn: true,
      classes: new Set(["hosting"]),
    }),
  };
}

/** Trips the route with a spray, then answers one more request. */
async function afterTrip(
  security: Security,
  request: RequestFacts,
): Promise<Decision> {
  await spray(security, 20);
  return await security.evaluate(request);
}

describe("who is answered, and how", () => {
  it("by default, an attempt from a hosting address or a new device; a known device is not, from a hosting address either", async () => {
    const clock = fakeClock();
    const security = engine(only("enforce"), clock, { intel: intel() });
    // The owner signs in once and holds a device cookie.
    const owner = login("owner@corp.test", "203.0.113.9");
    await security.evaluate(owner);
    await security.signal(owner, "auth.success");
    const cookie = (security.deviceCookie(owner) ?? "").split(";")[0] ?? "";
    expect(cookie).not.toBe("");
    await spray(security, 20);
    // Known device, regular address: answered.
    const known = await security.evaluate(
      login("owner@corp.test", "203.0.113.9", cookie),
    );
    expect(known.action).toBe("allow");
    // New device, regular address: refused.
    expect(
      (await security.evaluate(login("someone@corp.test", "203.0.113.20")))
        .action,
    ).toBe("block");
    // Known device, hosting address: answered (the cookie exempts it).
    expect(
      (await security.evaluate(login("owner@corp.test", "198.18.9.9", cookie)))
        .action,
    ).toBe("allow");
  });

  it('to: ["hosting"] answers only hosting addresses', async () => {
    const security = engine(only("enforce", { to: ["hosting"] }), fakeClock(), {
      intel: intel(),
    });
    expect(
      (await afterTrip(security, login("a@corp.test", "203.0.113.20"))).action,
    ).toBe("allow");
    expect(
      (await security.evaluate(login("b@corp.test", "198.18.1.1"))).action,
    ).toBe("block");
  });

  it('respond: "tag" answers with step-up, refusing nothing', async () => {
    const security = engine(only("enforce", { respond: "tag" }), fakeClock());
    const decision = await afterTrip(
      security,
      login("c@corp.test", "203.0.113.20"),
    );
    expect(decision.action).toBe("tag");
    expect(answers(decision)).toBe(true);
    expect(decision.tags).toContain("step-up");
    expect(hitOf(decision)?.action).toBe("tag");
  });

  it('respond: "limit" by asn: a stricter limit per ASN while tripped', async () => {
    const security = engine(
      only("enforce", {
        respond: "limit",
        to: ["all"],
        limit: { attempts: 3, window: "1m", by: "asn" },
      }),
      fakeClock(),
      { intel: intel() },
    );
    await spray(security, 20);
    const one = (n: number) => login(`x${n}@corp.test`, `198.18.200.${n}`);
    const actions: string[] = [];
    for (let n = 1; n <= 5; n++)
      actions.push((await security.evaluate(one(n))).action);
    expect(actions).toEqual(["allow", "allow", "allow", "block", "block"]);
    // Another ASN has its own count.
    expect(
      (await security.evaluate(login("y@corp.test", "198.18.201.1"))).action,
    ).toBe("allow");
  });

  it('respond: "limit" by hosting: one count for every hosting address, none for the rest', async () => {
    const security = engine(
      only("enforce", {
        respond: "limit",
        to: ["all"],
        limit: { attempts: 2, by: "hosting" },
      }),
      fakeClock(),
      { intel: intel() },
    );
    await spray(security, 20);
    const actions: string[] = [];
    for (let n = 1; n <= 3; n++) {
      actions.push(
        (await security.evaluate(login(`h${n}@corp.test`, `198.18.${n}.1`)))
          .action,
      );
    }
    expect(actions).toEqual(["allow", "allow", "block"]);
    expect(
      (await security.evaluate(login("r@corp.test", "203.0.113.30"))).action,
    ).toBe("allow");
  });

  it("explain() agrees with evaluate() while tripped, and counts nothing", async () => {
    const security = engine(
      only("enforce", {
        respond: "limit",
        to: ["all"],
        limit: { attempts: 2 },
      }),
      fakeClock(),
      { intel: intel() },
    );
    await spray(security, 20);
    const request = login("e@corp.test", "198.18.77.1");
    for (let n = 0; n < 3; n++) {
      const explained = await security.explain(request);
      expect(explained.decision.action).toBe(
        (await security.evaluate(request)).action,
      );
    }
    const steps = (await security.explain(request)).steps.filter(
      (s) => s.check === "failure-rate",
    );
    expect(steps.length).toBeGreaterThan(0);
  });
});

/** The `name=value` pair of a `Set-Cookie`. */
const pair = (setCookie: string | undefined): string =>
  (setCookie ?? "").split(";")[0] ?? "";

/**
 * Signs `username` in once from a regular address and answers its device
 * cookie pair, before any spray (the cookie is issued on a success).
 */
async function deviceOf(security: Security, username: string): Promise<string> {
  const request = login(username, "203.0.113.9");
  await security.evaluate(request);
  await security.signal(request, "auth.success");
  const cookie = pair(security.deviceCookie(request));
  expect(cookie).toContain("=");
  return cookie;
}

/** Whether the rule answered a decision (a hit of its own that is not a dry-run log). */
const answeredByRule = (decision: Decision): boolean =>
  decision.hits.some(
    (hit) => hit.rule === "login:failure-rate" && hit.action !== "log",
  );

describe("a valid device cookie for the username exempts a sign-in (the user's decision, 2026-11-17)", () => {
  const responds: {
    readonly name: string;
    readonly rate: Parameters<typeof only>[1];
  }[] = [
    { name: "challenge, to: all", rate: { respond: "challenge", to: ["all"] } },
    { name: "tag, to: hosting", rate: { respond: "tag", to: ["hosting"] } },
    {
      name: "limit by asn, to: all",
      rate: {
        respond: "limit",
        to: ["all"],
        limit: { attempts: 1, by: "asn" },
      },
    },
    {
      name: "limit by hosting, to: hosting",
      rate: {
        respond: "limit",
        to: ["hosting"],
        limit: { attempts: 1, by: "hosting" },
      },
    },
  ];
  for (const { name, rate } of responds) {
    it(`${name}: the owner's cookie from a hosting address passes, again and again; no cookie, another account's or a forged one is answered`, async () => {
      const security = engine(only("enforce", rate), fakeClock(), {
        intel: intel(),
      });
      const owner = await deviceOf(security, "owner@corp.test");
      const other = await deviceOf(security, "other@corp.test");
      await spray(security, 20);
      expect(security.status().loginFailureRate?.[0]?.tripped).toBe(true);
      // The owner, on a hosting address, three times: past `limit`'s 1.
      for (let n = 0; n < 3; n++) {
        const decision = await security.evaluate(
          login("owner@corp.test", `198.18.7.${n + 1}`, owner),
        );
        expect(answeredByRule(decision)).toBe(false);
        expect(decision.tags).not.toContain("step-up");
      }
      const [name, value] = owner.split("=");
      const forged = `${name}=${value?.slice(0, -4)}AAAA`;
      for (const cookie of [undefined, other, forged]) {
        // Twice each, so `limit`'s 1 attempt is passed too.
        const decisions = [
          await security.evaluate(
            login("owner@corp.test", "198.18.7.1", cookie),
          ),
          await security.evaluate(
            login("owner@corp.test", "198.18.7.2", cookie),
          ),
        ];
        expect({ cookie, answered: decisions.some(answeredByRule) }).toEqual({
          cookie,
          answered: true,
        });
      }
    });
  }

  it("the exemption is the trace's reason, and explain() agrees", async () => {
    const security = engine(only("enforce", { to: ["all"] }), fakeClock(), {
      intel: intel(),
    });
    const owner = await deviceOf(security, "owner@corp.test");
    await spray(security, 20);
    const request = login("owner@corp.test", "198.18.7.9", owner);
    const explained = await security.explain(request);
    expect(explained.decision.action).toBe(
      (await security.evaluate(request)).action,
    );
    expect(
      explained.steps.find((step) => step.check === "failure-rate")?.outcome,
    ).toContain("valid device cookie");
  });

  it("mutation check: with the exemption removed, the owner's cookie from a hosting address is refused", async () => {
    // A copy of lib/ under the package (so its imports resolve) with the
    // guard turned off: the case above must fail against it.
    const root = resolve(import.meta.dir, "../..");
    const base = join(root, "node_modules", ".cache");
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, "failure-rate-mutant-"));
    try {
      cpSync(join(root, "lib"), join(dir, "lib"), { recursive: true });
      const file = join(dir, "lib", "engine", "security.ts");
      const source = readFileSync(file, "utf8");
      const guard =
        'if (pass.subject.device !== undefined) {\n      pass.trace?.push({\n        layer: "L11",\n        check: "failure-rate",';
      expect(source).toContain(guard);
      writeFileSync(
        file,
        source.replace(
          guard,
          guard.replace("pass.subject.device !== undefined", "false"),
        ),
      );
      const mutant = (await import(
        join(dir, "lib", "index.ts")
      )) as typeof import("../../lib/index");
      const clock = fakeClock();
      const security = mutant.createSecurity({
        policy: only("enforce", { to: ["all"] }),
        secret: SECRET,
        now: clock.now,
        logger: () => {},
        intel: intel(),
      });
      const owner = await deviceOf(security, "owner@corp.test");
      await spray(security, 20);
      const decision = await security.evaluate(
        login("owner@corp.test", "198.18.7.9", owner),
      );
      expect(decision.action).toBe("block");
      expect(answeredByRule(decision)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the hold and the window", () => {
  it("stays tripped for `hold` once the spray stops, then answers again", async () => {
    const clock: FakeClock = fakeClock();
    const security = engine(
      only("enforce", { window: "5m", hold: "5m" }),
      clock,
    );
    await spray(security, 20);
    expect(
      (await security.evaluate(login("a@corp.test", "203.0.113.40"))).action,
    ).toBe("block");
    // Read every minute, as the engine's refresh does: the window keeps the
    // spray for 5 minutes, and the hold keeps the trip 5 more after that.
    const at = async (minutes: number): Promise<string> => {
      clock.advance(60_000);
      await security.flush();
      return (
        await security.evaluate(login(`m${minutes}@corp.test`, "203.0.113.41"))
      ).action;
    };
    const actions: string[] = [];
    for (let minute = 1; minute <= 11; minute++) actions.push(await at(minute));
    expect(actions.slice(0, 8)).toEqual(
      Array.from({ length: 8 }, () => "block"),
    );
    expect(actions.at(-1)).toBe("allow");
    expect(security.status().loginFailureRate?.[0]?.tripped).toBe(false);
  });

  it("counts per route: another login route is not tripped by this one's spray", async () => {
    const security = engine(only("enforce"), fakeClock());
    await spray(security, 20);
    const other: RequestFacts = {
      ...login("z@corp.test", "203.0.113.50"),
      path: "/admin/login",
      rawPath: "/admin/login",
      routeKey: "POST /admin/login",
    };
    expect((await security.evaluate(other)).action).toBe("allow");
  });

  it("an allow-listed client is neither counted nor answered", async () => {
    const policy = {
      ...only("enforce"),
      lists: [{ ip: "100.200.0.0/16", action: "allow" as const }],
    };
    const security = engine(policy, fakeClock());
    const decisions = await spray(security, 60);
    expect(decisions.every((d) => d.action === "allow")).toBe(true);
    expect(security.status().loginFailureRate).toEqual([]);
  });
});

describe("the policy", () => {
  it("refuses figures that cannot work", () => {
    const refused = (failureRate: Record<string, unknown>): boolean => {
      try {
        compilePolicy({
          profiles: { login: { failureRate } },
        } as SecurityPolicy);
        return false;
      } catch (error) {
        return error instanceof SecurityPolicyError;
      }
    };
    expect(refused({ factor: 1 })).toBe(true);
    expect(refused({ window: "10s" })).toBe(true);
    expect(refused({ baseline: "10m" })).toBe(true);
    expect(refused({ window: "1h", baseline: "2h" })).toBe(true);
    expect(refused({ respond: "ban" })).toBe(true);
    expect(refused({ to: [] })).toBe(true);
    expect(refused({ to: ["mobile"] })).toBe(true);
    expect(refused({ limit: { by: "country" } })).toBe(true);
    expect(refused({ minFailures: 0 })).toBe(true);
    expect(refused({ surprise: true })).toBe(true);
    expect(
      refused({
        factor: 4,
        respond: "limit",
        limit: { attempts: 5, window: "30s", by: "hosting" },
      }),
    ).toBe(false);
    expect(() =>
      compilePolicy({ presets: { "login.failure-rate": "on" as never } }),
    ).toThrow(SecurityPolicyError);
    expect(
      compilePolicy({ presets: { "login.failure-rate": "enforce" } }),
    ).toBeDefined();
  });
});
