/**
 * The login profile's account defences (layers.md L11.2 to L11.4, L11.8)
 * on the engine: the progressive delay, the challenge and the soft lock per
 * attempted username; the owner's device cookie keeping it in (T-L11-3);
 * credential stuffing (T-L11-1: one address × many usernames, many
 * addresses × one username, low and slow over six hours); the
 * risky-success tag; outcome inference; dry run; unlock; and the keys never
 * holding a username in clear.
 */
import { describe, expect, it } from "bun:test";
import { ConfigError } from "@kingsleyweb/bun-common";
import { createSecurity } from "../../lib/index";
import type {
  RequestFacts,
  SecurityWarning,
  SharedStateStore,
} from "../../lib/index";
import { Keyring } from "../../lib/sensitive/keys";
import { decide, engine, fail, fakeClock, login, SECRET } from "./helpers";

/** The device cookie's `name=value` from a `Set-Cookie` value. */
function cookiePair(setCookie: string | undefined): string {
  if (setCookie === undefined) throw new Error("no device cookie issued");
  return setCookie.split(";")[0] ?? "";
}

describe("failures per username", () => {
  it("delay the next attempt 1 s, 2 s (capped at maxDelay) after delayAfter, for a success as for a failure", async () => {
    const clock = fakeClock();
    const security = engine({}, clock);
    const delays: (number | undefined)[] = [];
    for (let i = 0; i < 8; i++) {
      const decision = await fail(security, login("alice"));
      delays.push(decision.delayMs);
      clock.advance(7_000);
    }
    expect(delays).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      1_000,
      2_000,
      2_000,
    ]);
    // Another username is untouched.
    expect((await decide(security, login("bob"))).action).toBe("allow");
    // The delay holds whatever the outcome will be: it is decided first.
    const next = await decide(security, login("ALICE "));
    expect(next).toMatchObject({ action: "delay", delayMs: 2_000 });
  });

  it("challenge (a block until challenge providers exist) at challengeAfter, and soft-lock at lockAfter", async () => {
    const clock = fakeClock();
    const security = engine(
      {
        profiles: {
          login: {
            failures: {
              delayAfter: 2,
              challengeAfter: 3,
              lockAfter: 5,
              lockFor: "10m",
            },
          },
        },
      },
      clock,
    );
    const actions: string[] = [];
    for (let i = 0; i < 6; i++) {
      const decision = await fail(security, login("carol"));
      actions.push(decision.action);
      clock.advance(7_000);
    }
    expect(actions).toEqual([
      "allow",
      "allow",
      "delay",
      "block",
      "block",
      "block",
    ]);
    const locked = await decide(security, login("carol"));
    expect(locked).toMatchObject({ status: 429, code: "rate_limited" });
    expect(locked.hits.map((hit) => hit.rule)).toContain("login:lock");
    // The lock outlives the failures window.
    clock.advance(9 * 60_000);
    expect(
      (await decide(security, login("carol"))).hits.map((h) => h.rule),
    ).toContain("login:lock");
    // Past the lock, the failures window still holds the challenge…
    clock.advance(2 * 60_000);
    const after = await decide(security, login("carol"));
    expect(after.hits.map((hit) => hit.rule)).toEqual(["login:challenge"]);
    // …until it ends.
    clock.advance(5 * 60_000);
    expect((await decide(security, login("carol"))).action).toBe("allow");
  });

  it("are cleared by a success, and lifted by unlock()", async () => {
    const clock = fakeClock();
    const security = engine(
      {
        profiles: {
          login: {
            failures: { delayAfter: 2, challengeAfter: 3, lockAfter: 4 },
          },
        },
      },
      clock,
    );
    for (let i = 0; i < 2; i++) {
      await fail(security, login("dave"));
      clock.advance(7_000);
    }
    await security.signal(login("dave"), "auth.success");
    expect((await decide(security, login("dave"))).action).toBe("allow");
    for (let i = 0; i < 4; i++) {
      await fail(security, login("dave"));
      clock.advance(7_000);
    }
    expect((await decide(security, login("dave"))).action).toBe("block");
    await security.unlock("Dave");
    expect((await decide(security, login("dave"))).action).toBe("allow");
  });
});

describe("T-L11-3: the owner's device keeps working while the username is attacked", () => {
  it("a valid device cookie for the username counts apart and passes the lock; untrusted attempts stay throttled", async () => {
    const clock = fakeClock();
    const security = engine(
      {
        profiles: {
          login: {
            failures: { delayAfter: 3, challengeAfter: 5, lockAfter: 6 },
          },
        },
      },
      clock,
    );
    // The owner signs in once, and gets a device cookie.
    const first = login("erin", "198.51.100.1");
    await decide(security, first);
    await security.signal(first, "auth.success");
    const cookie = cookiePair(security.deviceCookie(first));
    expect(cookie.startsWith("__Host-bun-security-device=")).toBe(true);
    // An attacker fails 10 times from other addresses, without the cookie.
    for (let i = 0; i < 10; i++) {
      await fail(security, login("erin", `203.0.113.${100 + i}`));
      clock.advance(7_000);
    }
    expect(
      (await decide(security, login("erin", "203.0.113.200"))).action,
    ).toBe("block");
    // The owner, with the cookie, is let in.
    const owner = await decide(security, login("erin", "198.51.100.1", cookie));
    expect(owner.action).toBe("allow");
    // Negative control: the cookie for another username does not pass.
    const stolen = await decide(
      security,
      login("frank", "198.51.100.1", cookie),
    );
    expect(stolen.subject.device).toBeUndefined();
    // A forged cookie does not pass either.
    const forged = await decide(
      security,
      login("erin", "203.0.113.201", `${cookie.slice(0, -2)}xx`),
    );
    expect(forged.action).toBe("block");
  });

  it("a cookie expires after maxAge, and one signed with another secret is refused", async () => {
    const clock = fakeClock();
    const security = engine(
      { profiles: { login: { device: { maxAge: "1d" } } } },
      clock,
    );
    const first = login("gina");
    await security.signal(first, "auth.success");
    const cookie = cookiePair(security.deviceCookie(first));
    expect(
      (await decide(security, login("gina", undefined, cookie))).subject.device,
    ).toBeDefined();
    clock.advance(86_400_001);
    expect(
      (await decide(security, login("gina", undefined, cookie))).subject.device,
    ).toBeUndefined();
    const other = new Keyring("another-secret-of-at-least-thirty-two-bytes");
    const keyed = new Keyring(SECRET);
    const value = other.issueDevice(keyed.username("gina"), clock.now());
    expect(
      keyed.verifyDevice(
        value,
        keyed.username("gina"),
        clock.now(),
        86_400_000,
      ),
    ).toBeUndefined();
  });
});

describe("T-L11-1: credential stuffing", () => {
  it("one address × many usernames: a challenge at 10 distinct usernames, a ban at 30", async () => {
    const clock = fakeClock();
    const security = engine({}, clock);
    const hits: string[] = [];
    for (let i = 0; i < 30; i++) {
      const request = login(`user${i}@example.org`, "203.0.113.50");
      const signalled = await security.signal(request, "auth.failure");
      hits.push(...signalled.map((hit) => `${i}:${hit.rule}:${hit.action}`));
      clock.advance(2_000);
    }
    expect(hits).toContain("9:login:distinct-usernames:challenge");
    expect(hits).toContain("29:login:distinct-usernames:ban");
    expect(security.bans()[0]).toMatchObject({
      id: "ip:203.0.113.50",
      rule: "login:distinct-usernames",
    });
    expect(
      (await decide(security, login("anyone", "203.0.113.50"))).action,
    ).toBe("ban");
    // Negative control: the defence off, the run goes unnoticed.
    const off = engine(
      {
        profiles: { login: { distinctUsernames: false } },
        presets: { "login.ip-failures": false, "login.ip-failures-ban": false },
      },
      fakeClock(),
    );
    for (let i = 0; i < 30; i++) {
      await off.signal(
        login(`user${i}@example.org`, "203.0.113.50"),
        "auth.failure",
      );
    }
    expect(off.bans()).toEqual([]);
  });

  it("many addresses × one username: the account's requests are tagged step-up at 10 distinct addresses", async () => {
    const clock = fakeClock();
    const security = engine({}, clock);
    for (let i = 0; i < 10; i++) {
      await security.signal(
        login("hank", `198.51.100.${i + 1}`),
        "auth.failure",
      );
      clock.advance(2_000);
    }
    const tagged = await decide(security, login("hank", "198.51.100.200"));
    expect(tagged.tags).toEqual(["step-up"]);
    expect(tagged.action).toBe("block");
    // Another account is not tagged.
    expect(
      (await decide(security, login("ivy", "198.51.100.200"))).tags,
    ).toEqual([]);
  });

  it("low and slow over six hours from one address: the distinct-usernames detector still fires within an hour's window", async () => {
    const clock = fakeClock();
    const security = engine({}, clock);
    const fired: number[] = [];
    // One attempt every 5 minutes, a new username each time, for 6 hours.
    for (let i = 0; i < 72; i++) {
      const hits = await security.signal(
        login(`slow${i}`, "203.0.113.60"),
        "auth.failure",
      );
      if (hits.some((hit) => hit.rule === "login:distinct-usernames"))
        fired.push(i);
      clock.advance(5 * 60_000);
    }
    // 12 per hour against a threshold of 10 in an hour.
    expect(fired.length).toBeGreaterThan(0);
    expect(fired[0]).toBeLessThan(12);
  });
});

describe("a success after many failures from its address", () => {
  it("is tagged risky-success and warned of", async () => {
    const clock = fakeClock();
    const warnings: SecurityWarning[] = [];
    const security = engine({}, clock, {
      onWarning: (warning) => warnings.push(warning),
    });
    for (let i = 0; i < 10; i++) {
      await security.signal(login(`kim${i}`, "203.0.113.70"), "auth.failure");
    }
    const hits = await security.signal(
      login("kim-real", "203.0.113.70"),
      "auth.success",
    );
    expect(hits.map((hit) => [hit.rule, hit.action])).toContainEqual([
      "login:risky-success",
      "tag",
    ]);
    expect(warnings.map((warning) => warning.kind)).toContain(
      "login.risky-success",
    );
    // Negative control: a success from a clean address.
    expect(
      await security.signal(login("kim-real", "203.0.113.71"), "auth.success"),
    ).toEqual([]);
  });
});

describe("outcome inference (layers.md L11.1)", () => {
  it("counts a 401 as a failure and a 2xx as a success when the app signalled neither; not when it did", async () => {
    const clock = fakeClock();
    const security = engine(
      { profiles: { login: { failures: { delayAfter: 2 } } } },
      clock,
    );
    const attempt = async (
      status: number,
      signal?: "auth.failure" | "auth.success",
    ) => {
      const request = login("lena");
      const decision = await security.evaluate(request, { track: true });
      if (signal !== undefined) await security.signal(request, signal);
      await security.complete(request, decision, { status });
      clock.advance(7_000);
      return { request, decision };
    };
    await attempt(401);
    await attempt(403);
    expect((await decide(security, login("lena"))).action).toBe("delay");
    // A success inferred: the count cleared, a device cookie issued.
    const success = await attempt(200);
    expect(security.deviceCookie(success.request)).toBeDefined();
    expect((await decide(security, login("lena"))).action).toBe("allow");
    // Signalled by the app: a 401 is not counted again.
    await attempt(401, "auth.failure");
    await attempt(401, "auth.failure");
    const count = await decide(security, login("lena"));
    expect(count.action).toBe("delay");
    expect(count.delayMs).toBe(1_000);
    // Off: nothing inferred.
    const off = engine(
      {
        profiles: {
          login: { inferOutcome: false, failures: { delayAfter: 1 } },
        },
      },
      clock,
    );
    const request = login("lena");
    await off.complete(request, await off.evaluate(request, { track: true }), {
      status: 401,
    });
    expect((await decide(off, login("lena"))).action).toBe("allow");
  });
});

describe("modes and keys", () => {
  it("in dry run records the delay, the challenge and the lock as log hits and refuses nothing", async () => {
    const clock = fakeClock();
    const security = engine(
      {
        profiles: {
          login: {
            mode: "dryRun",
            failures: { delayAfter: 1, challengeAfter: 2, lockAfter: 3 },
          },
        },
      },
      clock,
    );
    for (let i = 0; i < 4; i++) {
      await fail(security, login("mona"));
      clock.advance(7_000);
    }
    const decision = await decide(security, login("mona"));
    expect(decision.action).toBe("log");
    expect(
      decision.hits.find((hit) => hit.rule === "login:challenge")
        ?.wouldHaveBeen,
    ).toBe("block");
  });

  it("apply only on routes marked login, with the username known", async () => {
    const clock = fakeClock();
    const security = engine(
      { profiles: { login: { failures: { delayAfter: 1 } } } },
      clock,
    );
    const unmarked: RequestFacts = { ...login("nina"), profile: undefined };
    for (let i = 0; i < 3; i++) await fail(security, unmarked);
    expect((await decide(security, login("nina"))).action).toBe("allow");
    for (let i = 0; i < 3; i++) await fail(security, login(undefined));
    expect((await decide(security, login(undefined))).action).toBe("allow");
  });

  it("key a username by its HMAC: trimmed, case folded, the secret's own, never in clear", async () => {
    const one = new Keyring(SECRET);
    expect(one.username(" Olga@Example.org ")).toBe(
      one.username("olga@example.org"),
    );
    expect(one.username("olga@example.org")).not.toContain("olga");
    expect(new Keyring("b".repeat(32)).username("olga")).not.toBe(
      one.username("olga"),
    );
    expect(() => new Keyring("short")).toThrow(TypeError);
    const security = engine();
    const decision = await decide(security, login("olga@example.org"));
    expect(decision.subject.username).toBe(one.username("olga@example.org"));
  });

  it("refuse a shared store without a secret; take one with it, and no store without", () => {
    const store = (): SharedStateStore => ({
      name: "fake",
      throttle: { name: "t", increment: () => 1, get: () => 0 },
      intervals: { sync: 1e9, poll: 1e9, reconcile: 1e9 },
      get: async () => undefined,
      getMany: async (keys) => keys.map(() => undefined),
      set: async () => {},
      increment: async () => 0,
      touch: async () => {},
      pfAdd: async () => true,
      pfCount: async () => 0,
      health: () => ({ healthy: true, failingSince: undefined, failures: 0 }),
      close: async () => {},
    });
    expect(() =>
      createSecurity({ policy: {}, logger: () => {}, store: store() }),
    ).toThrow(ConfigError);
    // Negative controls: with the secret it starts; without a store no secret is needed.
    createSecurity({
      policy: {},
      logger: () => {},
      store: store(),
      secret: SECRET,
    }).close();
    createSecurity({ policy: {}, logger: () => {} }).close();
  });
});
