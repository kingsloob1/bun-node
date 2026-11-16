/**
 * The policy format's `version`: 1 is read, a missing version reads as 1, a
 * higher one is refused as **newer than this package** (and for that
 * alone, so an older service tells a newer policy from a malformed one),
 * anything else is malformed, and within version 1 an unknown key is still
 * refused.
 */
import { describe, expect, it } from "bun:test";
import {
  compilePolicy,
  createSecurity,
  SECURITY_POLICY_VERSION,
  SecurityPolicyError,
  securityPolicySchema,
} from "../../lib/index";
import type { PolicyIssue, SecurityPolicy } from "../../lib/index";

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

/** The issues the Standard Schema reports. */
function schemaIssues(policy: unknown): readonly { message: string }[] {
  const result = securityPolicySchema["~standard"].validate(policy);
  if (result instanceof Promise) throw new Error("the schema is synchronous");
  return "issues" in result && result.issues ? result.issues : [];
}

describe("the policy format version", () => {
  it("is 1", () => {
    expect(SECURITY_POLICY_VERSION).toBe(1);
  });

  it("accepts version 1 and records it", () => {
    expect(issuesOf({ version: 1 })).toEqual([]);
    expect(compilePolicy({ version: 1 }).version).toBe(1);
  });

  it("reads a policy without a version as version 1 (PR-S1's policies)", () => {
    expect(issuesOf({ service: "svc" })).toEqual([]);
    expect(compilePolicy({ service: "svc" }).version).toBe(1);
  });

  it("refuses a newer version for that alone, naming it newer than the package", () => {
    const policy = {
      version: 2,
      service: "svc",
      // Keys version 2 might add: not reported as typos.
      bots: { mode: "enforce" },
      lists: [{ ip: "203.0.113.0/24", action: "quarantine" }],
    };
    const issues = issuesOf(policy);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["version"]);
    expect(issues[0]?.message).toContain("format version 2");
    expect(issues[0]?.message).toContain(
      "newer than this package reads (version 1)",
    );
    expect(issues[0]?.message).toContain("upgrade @kingsleyweb/bun-security");
    expect(schemaIssues(policy)).toHaveLength(1);
    expect(() => createSecurity({ policy: policy as SecurityPolicy })).toThrow(
      /newer than this package/,
    );
  });

  it("refuses a malformed version as malformed, with every other issue", () => {
    for (const version of [0, -1, 1.5, "1", "2", null, true, Number.NaN]) {
      const issues = issuesOf({ version, typo: 1 });
      expect(issues.map((issue) => issue.path.join("."))).toEqual([
        "typo",
        "version",
      ]);
      expect(
        issues.find((issue) => issue.path[0] === "version")?.message,
      ).toStartWith("must be 1");
    }
  });

  it("still refuses an unknown key within version 1 (negative control for the newer path)", () => {
    for (const policy of [{ version: 1, bots: {} }, { bots: {} }]) {
      const issues = issuesOf(policy);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toEqual(["bots"]);
      expect(issues[0]?.message).toStartWith("unknown key");
    }
  });

  it("refuses a newer version on load() and keeps the policy in force", () => {
    const security = createSecurity({
      policy: { service: "svc" },
      logger: () => {},
    });
    const before = security.policy;
    expect(() =>
      security.load({
        version: 3,
        service: "svc",
      } as unknown as SecurityPolicy),
    ).toThrow(SecurityPolicyError);
    expect(security.policy).toBe(before);
  });
});
