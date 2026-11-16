/**
 * The policy's `requestRules` section is validated when the policy is
 * compiled (layers.md L7): a refused pattern is refused at save, with the
 * reason and its path.
 */
import { describe, expect, it } from "bun:test";
import {
  compilePolicy,
  SecurityPolicyError,
  securityPolicySchema,
} from "../../lib/index";
import type { SecurityPolicy } from "../../lib/index";
import { validateRequestRules } from "../../lib/rules/schema";

/** The issues of a `requestRules` section, as `path: message` lines. */
function issues(section: unknown): string[] {
  return validateRequestRules(section).map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
}

describe("validateRequestRules", () => {
  it("accepts a sound section", () => {
    expect(
      issues({
        rules: [
          {
            id: "no-dotenv",
            when: {
              any: [
                { path: { glob: "/**/.env*" } },
                { header: "user-agent", contains: "sqlmap", ignoreCase: true },
                { queryParam: "id", regex: "^\\d+'" },
                { client: { cidr: ["203.0.113.0/24", "2001:db8::/32"] } },
                { not: { method: { in: ["GET", "HEAD"] } } },
                { cookie: "debug", exists: true },
                { contentLength: { gt: 1_000_000 } },
                {
                  all: [
                    { user: { prefix: "svc_" } },
                    { routeKey: { equals: "POST /admin" } },
                  ],
                },
              ],
            },
            action: "ban",
            weight: 5,
            duration: "1d",
            crawlers: "skip",
          },
        ],
        managed: { mode: "enforce", exclude: ["wordpress"], weight: 2 },
        maxRegexInput: 2048,
      }),
    ).toEqual([]);
  });

  it("refuses a ReDoS-shaped pattern with the validator's reason and its path", () => {
    expect(
      issues({ rules: [{ id: "x", when: { path: { regex: "(a+)+$" } } }] }),
    ).toEqual([
      "requestRules.rules.0.when.path.regex: refused pattern: a quantifier inside a quantified group (nested quantifiers, as in (a+)+) is not allowed",
    ]);
  });

  it("names every problem", () => {
    const found = issues({
      rules: [
        { id: "a", when: { path: { glob: "/x", prefix: "/y" } } },
        { id: "a", when: { header: "user agent", contains: "x" } },
        { id: "c", when: { body: { equals: "x" } } },
        { id: "d", when: { cookie: "s", equals: "x" } },
        {
          id: "e",
          when: { path: { equals: "/x" } },
          action: "ban",
          duration: 60,
        },
        { id: "f", when: { path: { equals: "/x" } }, duration: "1h" },
        { id: "g", when: { client: { cidr: "not-a-range" } } },
        { id: "h", when: { any: [] } },
        {
          id: "i",
          when: { path: { equals: "/x" } },
          weight: 101,
          status: 302,
          mode: "loud",
          crawlers: "no",
        },
      ],
      managed: { exclude: ["drupal"] },
      maxRegexInput: 8,
      extra: true,
    });
    expect(found).toEqual([
      "requestRules.extra: unknown key (known: rules, managed, maxRegexInput)",
      "requestRules.rules.0.when.path: must hold exactly one of equals, in, prefix, suffix, contains, glob, regex, exists, length; got glob, prefix",
      'requestRules.rules.1.id: duplicates the id of requestRules.rules[0]: "a"',
      'requestRules.rules.1.when.header: must be a header name; got "user agent"',
      expect.stringContaining(
        "requestRules.rules.2.when: must name exactly one target",
      ),
      "requestRules.rules.3.when: a cookie test takes `exists: true | false` only (cookie values are not read)",
      expect.stringContaining(
        "requestRules.rules.4.duration: a bare number is ambiguous",
      ),
      'requestRules.rules.5.duration: applies to action "ban" only',
      expect.stringContaining(
        "requestRules.rules.6.when.client.cidr: must be an address or a range",
      ),
      "requestRules.rules.7.when.any: must be a non-empty list of conditions",
      "requestRules.rules.8.weight: must be a number from 0 to 100; got number 101",
      'requestRules.rules.8.mode: must be enforce, dryRun or off; got "loud"',
      "requestRules.rules.8.status: must be a whole number from 400 to 599; got number 302",
      'requestRules.rules.8.crawlers: must be apply or skip; got "no"',
      expect.stringContaining(
        "requestRules.managed.exclude.0: must be one of dotenv",
      ),
      "requestRules.maxRegexInput: must be a whole number from 16 to 8192; got number 8",
    ]);
  });
});

describe("compilePolicy with requestRules", () => {
  it("refuses a policy with a refused pattern, and the Standard Schema says the same", () => {
    const policy = {
      requestRules: {
        rules: [{ id: "bad", when: { header: "x", regex: "(a|aa)*" } }],
      },
    } as unknown as SecurityPolicy;
    expect(() => compilePolicy(policy)).toThrow(SecurityPolicyError);
    const result = securityPolicySchema["~standard"].validate(policy);
    expect("issues" in result && result.issues?.[0]?.path).toEqual([
      "requestRules",
      "rules",
      0,
      "when",
      "regex",
    ]);
  });

  it("refuses requestRules among the policy's keys only when it is malformed", () => {
    expect(() =>
      compilePolicy({ requestRules: { managed: true } }),
    ).not.toThrow();
    expect(() =>
      compilePolicy({
        requestRules: { managed: "yes" },
      } as unknown as SecurityPolicy),
    ).toThrow(SecurityPolicyError);
  });
});
