/**
 * The policy format: what `securityPolicySchema` and `compilePolicy` accept
 * and refuse (control-plane.md §2.3), explicit units included (README §11.2,
 * T-L9-3's rule for every duration and timestamp).
 */
import { describe, expect, it } from "bun:test";
import {
  compilePolicy,
  INTERNAL_RANGES,
  SecurityPolicyError,
  securityPolicySchema,
} from "../../lib/index";
import type { PolicyIssue } from "../../lib/index";

/** The issues `compilePolicy` refuses `policy` with (none when it compiles). */
function issuesOf(policy: unknown, maxListEntries?: number): PolicyIssue[] {
  try {
    compilePolicy(
      policy as never,
      maxListEntries === undefined ? {} : { maxListEntries },
    );
    return [];
  } catch (error) {
    if (!(error instanceof SecurityPolicyError)) throw error;
    return [...error.issues];
  }
}

/** The paths of `issues`, as `a.b[0]` text. */
function pathsOf(issues: readonly PolicyIssue[]): string[] {
  return issues.map((issue) =>
    issue.path
      .map((segment) =>
        typeof segment === "number" ? `[${segment}]` : `.${segment}`,
      )
      .join(""),
  );
}

const VERIFIER = `sha256:${"a".repeat(64)}`;

describe("compilePolicy accepts", () => {
  it("an empty policy, with the defaults", () => {
    const policy = compilePolicy({});
    expect(policy.mode).toBe("enforce");
    expect(policy.public).toBe(false);
    expect(policy.listEntries).toBe(0);
    expect(policy.internalRanges).toEqual(
      INTERNAL_RANGES.map((range) =>
        range.includes("/") ? range : `${range}/32`,
      ),
    );
  });

  it("a full policy", () => {
    const policy = compilePolicy({
      $comment: "keys starting with $ are ignored",
      service: "checkout",
      environment: "production",
      public: true,
      mode: "dryRun",
      keys: { ipv6Prefix: 56 },
      internal: { ranges: ["10.1.0.0/16", "127.0.0.0/8"] },
      lists: [
        {
          ip: "203.0.113.0/24",
          action: "block",
          reason: "scanner",
          createdBy: "ops",
        },
        {
          id: "partner",
          ip: "198.51.100.0/24",
          action: "allow",
          override: true,
          scope: "group",
        },
        { user: "u_1", action: "challenge", expiresAt: "2026-12-01T00:00:00Z" },
        {
          apiKey: "key_9",
          action: "drop",
          mode: "dryRun",
          code: "key-revoked",
        },
        {
          ip: "2001:db8::/32",
          action: "block",
          paths: ["/admin"],
          locked: true,
        },
        { ip: "192.0.2.1", action: "block", mode: "off" },
      ],
      serviceIdentity: {
        header: "x-api-token",
        clientIpHeader: "x-concave-client-ip",
        services: [
          {
            id: "pay-api",
            verifier: VERIFIER,
            forwardsClientIp: true,
            exempt: ["lists"],
          },
          { id: "jobs", verifier: [VERIFIER, `sha256:${"b".repeat(64)}`] },
        ],
      },
      trustCheck: { threshold: 0.6, window: "10m", minRequests: 5 },
    });
    expect(policy.service).toBe("checkout");
    expect(policy.mode).toBe("dryRun");
    // The `off` entry is not compiled.
    expect(policy.listEntries).toBe(5);
    expect(policy.internalRanges).toEqual(["10.1.0.0/16", "127.0.0.0/8"]);
    expect(Object.isFrozen(policy.source)).toBe(true);
    expect(Object.isFrozen(policy.source.lists)).toBe(true);
  });

  it("a duration as an object", () => {
    expect(issuesOf({ trustCheck: { window: { minutes: 3 } } })).toEqual([]);
  });

  it("a compiled policy, as it is", () => {
    const policy = compilePolicy({ service: "a" });
    expect(compilePolicy(policy)).toBe(policy);
  });

  it("internal: false, no internal ranges", () => {
    expect(compilePolicy({ internal: false }).internalRanges).toEqual([]);
  });
});

describe("compilePolicy refuses, naming every issue", () => {
  it("unknown keys, so a typo cannot switch a defence off", () => {
    expect(pathsOf(issuesOf({ list: [], trustcheck: false }))).toEqual([
      ".list",
      ".trustcheck",
    ]);
    expect(
      pathsOf(
        issuesOf({
          lists: [{ ip: "192.0.2.1", action: "block", expires: "x" }],
        }),
      ),
    ).toEqual([".lists[0].expires"]);
  });

  it("a non-object", () => {
    expect(issuesOf(null)).toHaveLength(1);
    expect(issuesOf([])).toHaveLength(1);
  });

  it("a bare-number duration, a sub-minute window and a part minute (explicit units)", () => {
    const [bare] = issuesOf({ trustCheck: { window: 300 } });
    expect(bare?.message).toContain("bare number is ambiguous");
    expect(issuesOf({ trustCheck: { window: "60ms" } })[0]?.message).toContain(
      "at least 60000 ms",
    );
    expect(issuesOf({ trustCheck: { window: "90s" } })[0]?.message).toContain(
      "whole minutes",
    );
    expect(issuesOf({ trustCheck: { window: "2h" } })[0]?.message).toContain(
      "at most an hour",
    );
    expect(issuesOf({ trustCheck: { window: "soon" } })[0]?.message).toContain(
      "must be a duration",
    );
  });

  it("a bare-number or zone-less timestamp", () => {
    const entry = { ip: "192.0.2.1", action: "block" };
    expect(
      issuesOf({ lists: [{ ...entry, expiresAt: 1_800_000_000 }] })[0]?.message,
    ).toContain("bare number is ambiguous");
    expect(
      issuesOf({ lists: [{ ...entry, expiresAt: "2026-12-01T00:00:00" }] })[0]
        ?.message,
    ).toContain("time zone");
    expect(
      issuesOf({ lists: [{ ...entry, expiresAt: "2026-02-31T00:00:00Z" }] })[0]
        ?.message,
    ).toContain("real date");
    expect(
      issuesOf({
        lists: [{ ...entry, expiresAt: "2028-02-29T23:59:59.5+01:00" }],
      }),
    ).toEqual([]);
    expect(
      issuesOf({ lists: [{ ...entry, expiresAt: "2026-13-01T00:00:00Z" }] })[0]
        ?.message,
    ).toContain("real date");
  });

  it("an allow entry wider than /8 or /32, but not a block entry (allow guard, layers.md L3.1)", () => {
    expect(
      issuesOf({ lists: [{ ip: "10.0.0.0/7", action: "allow" }] })[0]?.message,
    ).toContain("wider than /8");
    expect(
      issuesOf({ lists: [{ ip: "2001:db8::/31", action: "allow" }] })[0]
        ?.message,
    ).toContain("wider than /32");
    expect(
      issuesOf({ lists: [{ ip: "10.0.0.0/8", action: "allow" }] }),
    ).toEqual([]);
    expect(
      issuesOf({ lists: [{ ip: "2001:db8::/32", action: "allow" }] }),
    ).toEqual([]);
    expect(
      issuesOf({ lists: [{ ip: "10.0.0.0/7", action: "block" }] }),
    ).toEqual([]);
    // A mapped range is judged by the IPv4 range it maps.
    expect(
      issuesOf({ lists: [{ ip: "::ffff:0.0.0.0/100", action: "allow" }] })[0]
        ?.message,
    ).toContain("wider than /8");
  });

  it("an entry without exactly one subject, a bad address, action or field", () => {
    const issues = issuesOf({
      lists: [
        { action: "block" },
        { ip: "192.0.2.1", user: "u", action: "block" },
        { ip: "not-an-ip", action: "block" },
        { ip: "192.0.2.2", action: "ban" },
        { ip: "192.0.2.3", action: "block", override: true },
        { ip: "192.0.2.4", action: "block", paths: ["admin"] },
        { ip: "192.0.2.5", action: "block", code: "Has Spaces" },
        { ip: "192.0.2.6", action: "block", scope: "region", mode: "on" },
      ],
    });
    expect(pathsOf(issues)).toEqual([
      ".lists[0]",
      ".lists[1]",
      ".lists[2].ip",
      ".lists[3].action",
      ".lists[4].override",
      ".lists[5].paths[0]",
      ".lists[6].code",
      ".lists[7].scope",
      ".lists[7].mode",
    ]);
  });

  it("two entries with one id, given or derived", () => {
    expect(
      pathsOf(
        issuesOf({
          lists: [
            { ip: "203.0.113.7/24", action: "block" },
            { ip: "203.0.113.0/24", action: "allow" },
            { id: "x", user: "a", action: "block" },
            { id: "x", user: "b", action: "block" },
          ],
        }),
      ),
    ).toEqual([".lists[1].id", ".lists[3].id"]);
  });

  it("a list past its bound", () => {
    const lists = Array.from({ length: 4 }, (_, i) => ({
      ip: `192.0.2.${i}`,
      action: "block",
    }));
    expect(issuesOf({ lists }, 3)[0]?.message).toContain("the bound is 3");
    expect(issuesOf({ lists }, 4)).toEqual([]);
  });

  it("an internal range outside the built-in list: it can only be narrowed", () => {
    expect(
      issuesOf({ internal: { ranges: ["8.8.8.0/24"] } })[0]?.message,
    ).toContain("only be narrowed");
    expect(
      issuesOf({ internal: { ranges: ["10.0.0.0/7"] } })[0]?.message,
    ).toContain("only be narrowed");
    expect(
      issuesOf({ internal: { ranges: ["10.9.0.0/16", "fd00::/8"] } }),
    ).toEqual([]);
  });

  it("service identities with a token instead of a hash, duplicates, bad exemptions or headers", () => {
    const issues = issuesOf({
      serviceIdentity: {
        header: "X-Upper",
        services: [
          { id: "a", verifier: "plain-token" },
          { id: "a", verifier: VERIFIER },
          { id: "b", verifier: [], exempt: ["everything"] },
          { id: "c", verifier: VERIFIER, extra: 1 },
        ],
      },
    });
    expect(pathsOf(issues)).toEqual([
      ".serviceIdentity.header",
      ".serviceIdentity.services[0].verifier",
      ".serviceIdentity.services[1].id",
      ".serviceIdentity.services[2].verifier",
      ".serviceIdentity.services[2].exempt[0]",
      ".serviceIdentity.services[3].extra",
    ]);
    expect(
      pathsOf(
        issuesOf({
          serviceIdentity: {
            header: "x-a",
            clientIpHeader: "x-a",
            services: [],
          },
        }),
      ),
    ).toEqual([".serviceIdentity.clientIpHeader"]);
  });

  it("other settings out of range", () => {
    expect(
      pathsOf(
        issuesOf({
          mode: "loud",
          public: "yes",
          keys: { ipv6Prefix: 32 },
          trustCheck: { threshold: 0, minRequests: 0.5 },
        }),
      ),
    ).toEqual([
      ".public",
      ".mode",
      ".keys.ipv6Prefix",
      ".trustCheck.threshold",
      ".trustCheck.minRequests",
    ]);
  });

  it("with a readable message listing the issues", () => {
    expect(() =>
      compilePolicy({ lists: [{ ip: "x", action: "block" }] } as never),
    ).toThrow(
      /security policy refused \(1 issue\):\n {2}lists\[0\]\.ip: is not an IP address/,
    );
  });
});

describe("securityPolicySchema", () => {
  it("is a Standard Schema with the compiler's checks", () => {
    const standard = securityPolicySchema["~standard"];
    expect(standard.version).toBe(1);
    expect(standard.vendor).toBe("bun-security");
    const good = standard.validate({
      lists: [{ ip: "192.0.2.1", action: "block" }],
    });
    expect(good).toEqual({
      value: { lists: [{ ip: "192.0.2.1", action: "block" }] },
    });
    const bad = standard.validate({
      lists: [{ ip: "10.0.0.0/7", action: "allow" }],
    });
    expect("issues" in bad && bad.issues?.[0]?.path).toEqual([
      "lists",
      0,
      "ip",
    ]);
  });
});
