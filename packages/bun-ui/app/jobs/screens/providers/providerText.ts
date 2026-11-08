import type { ProviderDto, ProviderValidationDto } from "../../api/types";
import type { BadgeTone } from "../../components/Badge";
import { displayText } from "../../format";

/**
 * A compute provider in plain words: its readiness, and what "Test
 * connection" found.
 *
 * Each table is an exhaustive record of the values the contract lists, so a
 * value added there is a compile error here until it is named, and each
 * lookup shows a value this build does not know as its raw string.
 */

/** A provider's readiness. */
export type ProviderReadiness = ProviderDto["readiness"];

/** The kind a failed preflight classifies as. */
export type ProviderErrorKind = NonNullable<
  ProviderValidationDto["error"]
>["kind"];

/** A check's status. */
export type ProviderCheckStatus =
  ProviderValidationDto["checks"][number]["status"];

/** How a readiness reads. */
interface ReadinessText {
  /** In plain words. */
  label: string;
  /** Its badge colour. */
  tone: BadgeTone;
  /** What it means. */
  hint: string;
}

const READINESS: Readonly<Record<ProviderReadiness, ReadinessText>> = {
  ready: {
    label: "Ready",
    tone: "success",
    hint: "Its config is validated and it can summon.",
  },
  pending: {
    label: "Pending",
    tone: "warning",
    hint: "Its config is still being validated. It can't summon yet, and what it declares appears once it's ready.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    hint: "Its config was rejected, or building it threw. It can't summon until it's reconfigured; Test connection says why, where the provider has one.",
  },
};

/** A readiness in plain words, with its tone and meaning; a raw string for one this build does not know. */
export function providerReadiness(readiness: ProviderReadiness): ReadinessText {
  return typeof readiness === "string" && Object.hasOwn(READINESS, readiness)
    ? READINESS[readiness]
    : {
        label: displayText(readiness),
        tone: "neutral",
        hint: "A readiness this version of the UI does not know.",
      };
}

/**
 * Whose problem a failed preflight is: the config's or credentials' to fix,
 * the platform's for now, or the provider's own bug.
 */
const KIND: Readonly<Record<ProviderErrorKind, string>> = {
  misconfigured: "Configuration problem: fix the provider's config.",
  auth: "Credentials problem: the platform refused them.",
  transient: "Platform trouble, for now: try again.",
  throttled: "The platform is throttling calls: try again later.",
  quota: "The platform's quota is used up.",
  conflict: "A bug in the provider: it gave conflicting answers.",
};

const CHECK: Readonly<
  Record<ProviderCheckStatus, { label: string; tone: BadgeTone }>
> = {
  pass: { label: "Pass", tone: "success" },
  warn: { label: "Warn", tone: "warning" },
  fail: { label: "Fail", tone: "danger" },
};

/** Whose problem a failure is, in a sentence; a raw string for a kind this build does not know. */
export function providerErrorKind(kind: ProviderErrorKind): string {
  return typeof kind === "string" && Object.hasOwn(KIND, kind)
    ? KIND[kind]
    : `The preflight failed (${displayText(kind)}).`;
}

/** A check's status as a label and tone; a raw string for one this build does not know. */
export function providerCheck(status: ProviderCheckStatus): {
  label: string;
  tone: BadgeTone;
} {
  return typeof status === "string" && Object.hasOwn(CHECK, status)
    ? CHECK[status]
    : { label: displayText(status), tone: "neutral" };
}

/**
 * What "Test connection" found, in one line: passed, passed with warnings,
 * a failed check, a timeout, an invalid config, or a classified failure.
 */
export function validationSummary(result: ProviderValidationDto): string {
  if (result.error !== undefined) {
    const { kind, detail } = result.error;
    if (detail === "timeout") {
      return "No answer: the preflight timed out.";
    }
    if (detail.startsWith("invalid config: ")) {
      return `Configuration problem: invalid ${detail.slice("invalid config: ".length)}.`;
    }
    return `${providerErrorKind(kind)} (${displayText(detail)})`;
  }
  const failed = result.checks.filter((check) => check.status === "fail");
  const warned = result.checks.filter((check) => check.status === "warn");
  if (failed.length > 0) {
    return `Connection failed: ${failed.length} of ${result.checks.length} checks failed.`;
  }
  if (warned.length > 0) {
    return `Connected, with ${warned.length} warning${warned.length === 1 ? "" : "s"}.`;
  }
  return result.checks.length === 0
    ? "Connected."
    : `Connected: all ${result.checks.length} checks passed.`;
}
