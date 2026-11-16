/**
 * A policy that cannot be compiled, and why.
 */
import { ConfigError } from "@kingsleyweb/bun-common";

/** One problem with a policy: where it is, and what is wrong. */
export interface PolicyIssue {
  /** What is wrong, and ideally how to fix it. */
  readonly message: string;
  /** Where: the keys and indexes from the policy's root (`["lists", 3, "ip"]`). */
  readonly path: readonly (string | number)[];
  /**
   * A machine-readable kind, for issues a program acts on: `"policy.newer"`
   * when the policy's format version is newer than this package reads (an
   * upgrade is needed; the policy is not malformed). Absent for every other
   * issue.
   */
  readonly code?: PolicyIssueCode;
}

/** The machine-readable kinds of {@link PolicyIssue.code}. */
export type PolicyIssueCode = "policy.newer";

/** The issue code of a policy whose format version is newer than this package reads. */
export const POLICY_NEWER: PolicyIssueCode = "policy.newer";

/** `path` written as `lists[3].ip`, or `(root)`. */
export function formatIssuePath(path: readonly (string | number)[]): string {
  let text = "";
  for (const segment of path) {
    text +=
      typeof segment === "number"
        ? `[${segment}]`
        : text
          ? `.${segment}`
          : segment;
  }
  return text || "(root)";
}

/**
 * The policy was refused: {@link issues} lists every problem found, not only
 * the first, so one round of edits can fix them all. A configuration error
 * (bun-common's `ConfigError`), never a runtime failure.
 */
export class SecurityPolicyError extends ConfigError {
  /** Every problem found. */
  readonly issues: readonly PolicyIssue[];

  constructor(
    /** Every problem found; at least one. */
    issues: readonly PolicyIssue[],
  ) {
    const lines = issues
      .slice(0, 20)
      .map((issue) => `  ${formatIssuePath(issue.path)}: ${issue.message}`);
    if (issues.length > 20) {
      lines.push(`  … and ${issues.length - 20} more`);
    }
    super(
      `security policy refused (${issues.length} ${issues.length === 1 ? "issue" : "issues"}):\n${lines.join("\n")}`,
      { issues: issues.length },
    );
    this.name = "SecurityPolicyError";
    this.issues = Object.freeze([...issues]);
  }
}
