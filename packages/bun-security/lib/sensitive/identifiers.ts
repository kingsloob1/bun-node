/**
 * Identifier checks where data is created (layers.md L11.7):
 * `security.check(facts, kind, value)` refuses an email, a phone number, a
 * username or a domain that matches an operator's pattern or the built-in
 * policy for self-chosen addresses (reserved names, the operator's own
 * domains), with one generic refusal whatever matched; and, for
 * `"password"`, asks the app's breached-password hook.
 */
import type { CompiledIdentifiers, CompiledPattern } from "./compile";

/** What `check()` checks. */
export type CheckKind = "email" | "phone" | "username" | "domain" | "password";

/** Reserved top-level names (RFC 2606, RFC 6761) and `localhost`. */
const RESERVED_TOP = new Set(["test", "example", "invalid", "localhost"]);

/** Reserved second-level names (RFC 2606). */
const RESERVED_SECOND = new Set(["example.com", "example.net", "example.org"]);

/** The longest value checked; a longer one is refused as it is. */
export const MAX_CHECKED_LENGTH = 320;

/** What matched a value: a pattern, or a built-in. */
export interface IdentifierMatch {
  /** The rule's id (`email:*@disposable.example`, `reserved-domain`, `own-domain`). */
  readonly rule: string;
  /** Why, for operators. */
  readonly reason: string;
  /** Whether the match only records (dry run). */
  readonly dryRun: boolean;
}

/** A domain's reserved name, if it is under one. */
function reserved(domain: string): boolean {
  const labels = domain.split(".");
  const top = labels.at(-1) ?? "";
  if (RESERVED_TOP.has(top)) return true;
  return RESERVED_SECOND.has(labels.slice(-2).join("."));
}

/** The first pattern of `list` that matches `value`. */
function first(
  list: readonly CompiledPattern[] | undefined,
  value: string,
): CompiledPattern | undefined {
  for (const pattern of list ?? []) {
    if (pattern.test(value)) return pattern;
  }
  return undefined;
}

/** The value as it is matched. */
export function normaliseIdentifier(kind: CheckKind, value: string): string {
  const trimmed = value.trim().toLowerCase();
  return kind === "phone" ? trimmed.replace(/[\s().-]/g, "") : trimmed;
}

/** What matches `value` of `kind`, or `undefined` when it may be used. */
export function matchIdentifier(
  identifiers: CompiledIdentifiers,
  kind: Exclude<CheckKind, "password">,
  value: string,
): IdentifierMatch | undefined {
  const normal = normaliseIdentifier(kind, value);
  if (normal === "" || normal.length > MAX_CHECKED_LENGTH) {
    return { rule: "malformed", reason: "empty or too long", dryRun: false };
  }
  const hit = first(identifiers.patterns.get(kind), normal);
  if (hit !== undefined) {
    return {
      rule: hit.id,
      reason: hit.reason ?? `matches ${kind} pattern ${hit.id}`,
      dryRun: hit.mode === "dryRun",
    };
  }
  let domain: string | undefined;
  if (kind === "email") {
    const at = normal.lastIndexOf("@");
    if (at <= 0 || at === normal.length - 1) {
      return {
        rule: "malformed",
        reason: "not an email address",
        dryRun: false,
      };
    }
    domain = normal.slice(at + 1);
  } else if (kind === "domain") {
    domain = normal;
  }
  if (domain === undefined) return undefined;
  const byDomain = first(identifiers.patterns.get("domain"), domain);
  if (byDomain !== undefined) {
    return {
      rule: byDomain.id,
      reason: byDomain.reason ?? `matches domain pattern ${byDomain.id}`,
      dryRun: byDomain.mode === "dryRun",
    };
  }
  if (identifiers.reserved && reserved(domain)) {
    return {
      rule: "reserved-domain",
      reason: "a reserved domain",
      dryRun: false,
    };
  }
  for (const own of identifiers.ownDomains) {
    if (domain === own || domain.endsWith(`.${own}`)) {
      return {
        rule: "own-domain",
        reason: "the operator's own domain, chosen by a client",
        dryRun: false,
      };
    }
  }
  return undefined;
}

/** The generic message of an identifier refusal. */
export const IDENTIFIER_MESSAGE = "This value cannot be used.";

/** The generic message of a breached password's refusal. */
export const PASSWORD_MESSAGE =
  "This password has appeared in a data breach; choose another.";
