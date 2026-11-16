/**
 * The sensitive endpoints' policy checks: `profiles.login`, a rule's
 * `profile`, the new key parts, and the login defences' compiled defaults.
 */
import { describe, expect, it } from "bun:test";
import { compilePolicy, SecurityPolicyError } from "../../lib/index";
import { sensitiveOf } from "../../lib/sensitive/compile";

/** The issue paths of `policy`, joined. */
function paths(policy: unknown): string[] {
  try {
    compilePolicy(policy as never);
    return [];
  } catch (error) {
    if (!(error instanceof SecurityPolicyError)) throw error;
    return error.issues.map((issue) => issue.path.join("."));
  }
}

describe("the sensitive endpoints' checks", () => {
  it("refuses bad login settings, naming each", () => {
    expect(
      paths({ profiles: { login: { failures: { delayAfter: 0 } } } }),
    ).toEqual(["profiles.login.failures.delayAfter"]);
    expect(
      paths({ profiles: { login: { failures: { window: 900 } } } }),
    ).toEqual(["profiles.login.failures.window"]);
    expect(
      paths({
        profiles: { login: { failures: { delayAfter: 9, challengeAfter: 3 } } },
      }),
    ).toEqual(["profiles.login.failures"]);
    expect(
      paths({ profiles: { login: { device: { cookie: "a b" } } } }),
    ).toEqual(["profiles.login.device.cookie"]);
    expect(
      paths({ profiles: { login: { device: { maxAge: "1s" } } } }),
    ).toEqual(["profiles.login.device.maxAge"]);
    expect(paths({ profiles: { login: { mode: "on" } } })).toEqual([
      "profiles.login.mode",
    ]);
    expect(paths({ profiles: { signup: {} } })).toEqual(["profiles.signup"]);
    expect(paths({ profiles: { login: false } })).toEqual([]);
    expect(
      paths({
        limits: [{ id: "x", limit: 1, window: "1m", profile: "no spaces" }],
      }),
    ).toEqual(["limits.0.profile"]);
    expect(
      paths({
        limits: [
          {
            id: "x",
            limit: 1,
            window: "1m",
            key: ["ip", "username"],
            profile: "login",
          },
        ],
        countedRules: [
          {
            id: "c",
            event: "otp.sent",
            threshold: 3,
            window: "1h",
            duration: "1h",
            key: "destinationPrefix",
            profile: "otp",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("compiles the login defences' defaults (layers.md L11.2), and none when off", () => {
    const login = sensitiveOf(compilePolicy({})).login;
    expect(login).toMatchObject({
      window: 900_000,
      delayAfter: 5,
      challengeAfter: 10,
      lockAfter: 20,
      lockFor: 900_000,
      maxDelay: 2_000,
      distinctUsernames: {
        window: 3_600_000,
        challengeAt: 10,
        banAt: 30,
        banFor: 3_600_000,
      },
      distinctAddresses: { window: 3_600_000, stepUpAt: 10 },
      riskySuccessAfter: 10,
      device: {
        cookie: "__Host-bun-security-device",
        maxAge: 365 * 86_400_000,
      },
      inferOutcome: true,
      mode: "enforce",
    });
    expect(
      sensitiveOf(compilePolicy({ profiles: { login: false } })).login,
    ).toBeUndefined();
    expect(
      sensitiveOf(compilePolicy({ profiles: { login: { mode: "off" } } }))
        .login,
    ).toBeUndefined();
    expect(sensitiveOf(compilePolicy({ mode: "off" })).login).toBeUndefined();
  });
});
