/**
 * The policy's `limits`, `countedRules` and `concurrency`: what is accepted
 * and refused, explicit units included (T-L9-3: a window given as a bare
 * number, or under a second, is refused, as ConcaveHR's `THROTTLE_TTL=60`
 * meaning 60 ms should have been).
 */
import { PRESETS } from "../../lib/policy/presets";
import { describe, expect, it } from "bun:test";
import {
  compilePolicy,
  DEFAULT_CONCURRENCY_PER_IP,
  SecurityPolicyError,
} from "../../lib/index";
import type { PolicyIssue, SecurityPolicy } from "../../lib/index";
import { policyInternals } from "../../lib/policy/compile";

/** The issues `compilePolicy` refuses `policy` with (none when it compiles). */
function issuesOf(policy: unknown): PolicyIssue[] {
  try {
    compilePolicy(policy as SecurityPolicy);
    return [];
  } catch (error) {
    if (!(error instanceof SecurityPolicyError)) throw error;
    return [...error.issues];
  }
}

/** The issues' paths, as `a.b.0` text. */
function pathsOf(policy: unknown): string[] {
  return issuesOf(policy).map((issue) => issue.path.join("."));
}

const LIMIT = { id: "global", limit: 600, window: "1m" } as const;
const RULE = {
  id: "failed-password",
  event: "auth.failure",
  threshold: 10,
  window: "15m",
  duration: "1h",
} as const;

/** The rules of the policy itself, the presets left out. */
const own = <T extends { readonly id: string }>(rules: readonly T[]): T[] =>
  rules.filter((rule) => !Object.hasOwn(PRESETS, rule.id));

describe("limits", () => {
  it("accepts ConcaveHR's sign-in pair, and every field", () => {
    expect(
      issuesOf({
        limits: [
          {
            id: "signin-account",
            limit: 10,
            window: "1m",
            key: ["ip", "user"],
            routes: ["POST /auth/signin"],
          },
          {
            id: "signin-ip",
            limit: 30,
            window: { minutes: 1 },
            routes: ["POST /auth/signin"],
          },
          {
            id: "all.fields_1",
            limit: 1,
            window: "500ms",
            subSecond: true,
            key: "route",
            routes: ["/a", "* /b", "GET /c/:id", "/d/*", "/*"],
            algorithm: "gcra",
            cost: 0.5,
            mode: "dryRun",
            appliesToServices: true,
            evenWhenAllowed: true,
            code: "slow_down",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("T-L9-3: refuses a window given as a bare number, naming the units to write", () => {
    const issues = issuesOf({ limits: [{ ...LIMIT, window: 60 }] });
    expect(issues.map((issue) => issue.path.join("."))).toEqual([
      "limits.0.window",
    ]);
    expect(issues[0]?.message).toContain('"60s"');
  });

  it("T-L9-3: refuses a window under a second unless subSecond says so", () => {
    for (const window of ["60ms", { ms: 999 }, "0.5s"]) {
      const issues = issuesOf({ limits: [{ ...LIMIT, window }] });
      expect(issues.map((issue) => issue.path.join("."))).toEqual([
        "limits.0.window",
      ]);
      expect(issues[0]?.message).toContain("subSecond: true");
      expect(
        issuesOf({ limits: [{ ...LIMIT, window, subSecond: true }] }),
      ).toEqual([]);
    }
    // Negative control: exactly a second needs no flag.
    expect(issuesOf({ limits: [{ ...LIMIT, window: "1s" }] })).toEqual([]);
    expect(
      pathsOf({ limits: [{ ...LIMIT, window: "0s", subSecond: true }] }),
    ).toEqual(["limits.0.window"]);
  });

  it("refuses what is wrong, each at its path", () => {
    expect(
      pathsOf({
        limits: [
          { id: "-bad", limit: 0, window: "1m" },
          { id: "x", limit: 1.5, window: "1m", key: "address" },
          { id: "y", limit: 1, window: "1m", key: ["ip", "ip"] },
          { id: "z", limit: 1, window: "1m", routes: ["post /x"] },
          { id: "w", limit: 1, window: "1m", routes: ["/a/*/b"] },
          {
            id: "v",
            limit: 1,
            window: "1m",
            algorithm: "token-bucket",
            cost: -1,
          },
          { id: "u", limit: 1, window: "1m", mode: "on", code: "Bad Code" },
          {
            id: "t",
            limit: 1,
            window: "1m",
            evenWhenAllowed: "yes",
            appliesToServices: 1,
          },
          { id: "s", limit: 1, window: "1m", per: "route" },
          { id: "r", limit: 1 },
          { id: "x", limit: 1, window: "1m", routes: [] },
        ],
      }),
    ).toEqual([
      "limits.0.id",
      "limits.0.limit",
      "limits.1.limit",
      "limits.1.key",
      "limits.2.key.1",
      "limits.3.routes.0",
      "limits.4.routes.0",
      "limits.5.algorithm",
      "limits.5.cost",
      "limits.6.mode",
      "limits.6.code",
      "limits.7.appliesToServices",
      "limits.7.evenWhenAllowed",
      "limits.8.per",
      "limits.9.window",
      "limits.10.id",
      "limits.10.routes",
    ]);
  });

  it("refuses more than 1,000 limits", () => {
    const limits = Array.from({ length: 1001 }, (_, i) => ({
      id: `l${i}`,
      limit: 1,
      window: "1m",
    }));
    expect(pathsOf({ limits })).toEqual(["limits"]);
  });

  it("compiles windows to milliseconds and skips limits that are off", () => {
    const internals = policyInternals(
      compilePolicy({
        limits: [
          { ...LIMIT, key: ["user", "route"] },
          { id: "gone", limit: 1, window: "1m", mode: "off" },
          {
            id: "sub",
            limit: 1,
            window: "250ms",
            subSecond: true,
            algorithm: "fixed-window",
          },
        ],
      }),
    );
    expect(
      own(internals.limits).map((limit) => [limit.id, limit.window]),
    ).toEqual([
      ["global", 60_000],
      ["sub", 250],
    ]);
    expect(own(internals.limits)[0]?.key).toEqual({
      parts: ["user", "route"],
      addressOnly: false,
    });
    expect(own(internals.limits)[0]?.algorithm).toBe("sliding-window");
    expect(own(internals.limits)[0]?.code).toBe("rate_limited");
    expect(own(internals.limits)[1]?.key.addressOnly).toBe(true);
  });
});

describe("counted rules", () => {
  it("accepts ConcaveHR's seven, and a null duration", () => {
    expect(
      issuesOf({
        countedRules: [
          RULE,
          {
            id: "failed-mfa",
            event: "mfa.failure",
            threshold: 10,
            window: "15m",
            duration: "1h",
          },
          {
            id: "disposable-signup",
            event: "pattern.hit",
            threshold: 1,
            window: "60s",
            duration: "7d",
          },
          {
            id: "signups-per-ip",
            event: "signup",
            threshold: 5,
            window: "24h",
            duration: "7d",
            action: "challenge",
          },
          {
            id: "password-resets",
            event: "password.reset",
            threshold: 10,
            window: "1h",
            duration: "1d",
          },
          {
            id: "requests-per-second",
            event: "request",
            threshold: 100,
            window: "1s",
            duration: "15m",
          },
          {
            id: "not-found",
            event: "route.notFound",
            threshold: 120,
            window: "60s",
            duration: null,
            key: ["ip"],
            routes: ["/*"],
            mode: "dryRun",
            code: "gone",
            appliesToServices: true,
          },
        ],
      }),
    ).toEqual([]);
  });

  it("refuses what is wrong, each at its path", () => {
    expect(
      pathsOf({
        countedRules: [
          { ...RULE, event: "auth failure" },
          { ...RULE, id: "b", threshold: 0, duration: 3600 },
          { ...RULE, id: "c", window: 900, action: "drop" },
          { id: "d", event: "request", threshold: 1, window: "1m" },
          { ...RULE, id: "e", duration: "1s", window: "10ms" },
          { ...RULE, id: "b", enabled: true },
        ],
      }),
    ).toEqual([
      "countedRules.0.event",
      "countedRules.1.threshold",
      "countedRules.1.duration",
      "countedRules.2.window",
      "countedRules.2.action",
      "countedRules.3.duration",
      "countedRules.4.window",
      "countedRules.5.enabled",
      "countedRules.5.id",
    ]);
  });

  it("compiles by event, the duration in milliseconds or Infinity", () => {
    const internals = policyInternals(
      compilePolicy({
        countedRules: [
          RULE,
          { ...RULE, id: "forever", duration: null },
          { ...RULE, id: "off", mode: "off" },
          { ...RULE, id: "req", event: "request" },
        ],
      }),
    );
    expect(own(internals.countedRules).map((rule) => rule.id)).toEqual([
      "failed-password",
      "forever",
      "req",
    ]);
    expect(
      own(internals.countedByEvent.get("auth.failure") ?? []).map(
        (rule) => rule.duration,
      ),
    ).toEqual([3_600_000, Number.POSITIVE_INFINITY]);
    expect(
      internals.countedByEvent.get("request")?.map((rule) => rule.id),
    ).toEqual(["req"]);
    expect(own(internals.countedRules)[0]?.action).toBe("ban");
  });
});

describe("concurrency", () => {
  it("defaults to 64 per address and no total", () => {
    expect(DEFAULT_CONCURRENCY_PER_IP).toBe(64);
    expect(policyInternals(compilePolicy({})).concurrency).toEqual({
      perIp: 64,
      total: undefined,
      releaseAfter: 300_000,
      mode: "enforce",
    });
  });

  it("can be set, narrowed or turned off", () => {
    expect(
      policyInternals(
        compilePolicy({
          concurrency: {
            perIp: false,
            total: 500,
            releaseAfter: "30s",
            mode: "dryRun",
          },
        }),
      ).concurrency,
    ).toEqual({
      perIp: undefined,
      total: 500,
      releaseAfter: 30_000,
      mode: "dryRun",
    });
    expect(
      policyInternals(compilePolicy({ concurrency: false })).concurrency,
    ).toBeUndefined();
    expect(
      policyInternals(compilePolicy({ concurrency: { mode: "off" } }))
        .concurrency,
    ).toBeUndefined();
    expect(
      policyInternals(compilePolicy({ concurrency: { perIp: false } }))
        .concurrency,
    ).toBeUndefined();
  });

  it("refuses what is wrong", () => {
    expect(
      pathsOf({
        concurrency: {
          perIp: 0,
          total: true,
          releaseAfter: 30,
          mode: "x",
          max: 1,
        },
      }),
    ).toEqual([
      "concurrency.max",
      "concurrency.perIp",
      "concurrency.total",
      "concurrency.releaseAfter",
      "concurrency.mode",
    ]);
    expect(pathsOf({ concurrency: true })).toEqual(["concurrency"]);
    expect(pathsOf({ concurrency: { releaseAfter: "10ms" } })).toEqual([
      "concurrency.releaseAfter",
    ]);
  });
});
