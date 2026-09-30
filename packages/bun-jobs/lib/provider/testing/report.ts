import type { ProviderApiVersions } from "../define";
import { JobsError } from "../../shared/errors";

/**
 * The conformance report (plugins §12.1): one entry per check, in a fixed
 * order, with ids stable enough to diff two reports by.
 */

/** One check's outcome. */
export interface ConformanceCheck {
  /** A stable id, e.g. `"summon.dedupe.same-key-one-unit"`, so reports can be diffed. Its second segment is the check's group. */
  id: string;
  /** `"must"` checks fail the report; `"should"` checks warn. */
  level: "must" | "should";
  /**
   * What happened. `"skip"` when a declared capability makes the check
   * inapplicable, when the caller skipped it, or when a check it depends on
   * failed; `"warn"` is a failed `should`.
   */
  status: "pass" | "fail" | "warn" | "skip";
  /** What was expected and what was seen, secret-free. */
  detail?: string;
}

/** A kit run. Printable as a checklist, serialisable for a PR. */
export interface ConformanceReport {
  /** The provider, as `name@version`. */
  subject: string;
  /** The API versions it declared, and the host's. */
  apiVersion: {
    /** What the provider declared. */
    declared: ProviderApiVersions;
    /** What this build of bun-jobs speaks. */
    host: ProviderApiVersions;
  };
  /** Every check, in a fixed order. */
  checks: readonly ConformanceCheck[];
  /** `true` when no `must` check failed. */
  ok: boolean;
  /** Renders the report as a Markdown checklist, headed "tested against a fake". */
  toMarkdown: () => string;
}

/** The mark each status gets in the Markdown checklist. */
const MARKS: Record<ConformanceCheck["status"], string> = {
  pass: "[x]",
  fail: "[ ] **FAIL**",
  warn: "[ ] warn",
  skip: "[ ] skip",
};

/** Internal: builds a report from its checks. */
export function buildReport(
  /** `name@version`. */
  subject: string,
  /** The declared and host API versions. */
  apiVersion: ConformanceReport["apiVersion"],
  /** The checks, in order. */
  checks: readonly ConformanceCheck[],
): ConformanceReport {
  const frozen = Object.freeze(
    checks.map((check) => Object.freeze({ ...check })),
  );
  const ok = frozen.every(
    (check) => check.level !== "must" || check.status !== "fail",
  );
  const toMarkdown = (): string => {
    const lines = [
      `# Conformance: ${subject}`,
      "",
      "Tested against a fake: passing means the provider behaves correctly against its own fake platform, not that bun-jobs has reviewed it or that the platform behaves as the fake does.",
      "",
      `API versions: declared ${versions(apiVersion.declared)}; host ${versions(apiVersion.host)}.`,
      "",
      `Result: ${ok ? "conforms" : "does not conform"} (${count(frozen, "pass")} passed, ${count(frozen, "fail")} failed, ${count(frozen, "warn")} warned, ${count(frozen, "skip")} skipped).`,
      "",
    ];
    for (const check of frozen) {
      lines.push(
        `- ${MARKS[check.status]} \`${check.id}\` (${check.level})${check.detail === undefined ? "" : `: ${check.detail}`}`,
      );
    }
    return `${lines.join("\n")}\n`;
  };
  return Object.freeze({
    subject,
    apiVersion,
    checks: frozen,
    ok,
    toMarkdown,
  });
}

/** `core 0.1, summon 0.1`. */
function versions(apiVersion: ProviderApiVersions): string {
  return Object.entries(apiVersion)
    .filter(([, value]) => value !== undefined)
    .map(([facet, value]) => `${facet} ${String(value)}`)
    .join(", ");
}

/** How many checks have `status`. */
function count(
  checks: readonly ConformanceCheck[],
  status: ConformanceCheck["status"],
): number {
  return checks.filter((check) => check.status === status).length;
}

/**
 * Throws when `report.ok` is false, with the rendered report as the message:
 * a failed `must` check fails; a `should` warning, a skip and a pass never
 * do. For any test runner:
 *
 * ```ts
 * test("conforms", async () => {
 *   assertConformance(await runProviderConformance(acme, { config, platform }));
 * });
 * ```
 *
 * @throws {JobsError} (`CONFORMANCE_FAILED`) naming every failed check,
 *   with the report on its `context`.
 */
export function assertConformance(report: ConformanceReport): void {
  if (report.ok) {
    return;
  }
  const failed = report.checks.filter(
    (check) => check.level === "must" && check.status === "fail",
  );
  throw new JobsError(
    `${report.subject} does not conform: ${failed.map((check) => check.id).join(", ")}\n\n${report.toMarkdown()}`,
    "CONFORMANCE_FAILED",
    { failed: failed.map((check) => check.id) },
  );
}
