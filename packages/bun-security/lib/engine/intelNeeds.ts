/**
 * What a policy asks of IP intelligence (layers.md L5), checked when the
 * engine starts and on every `load()`: a policy naming a country, an ASN
 * or a class the engine cannot know is refused, rather than silently never
 * matching (a "block country X" that blocks nothing).
 */
import { ConfigError } from "@kingsleyweb/bun-common";
import type { IntelLookup } from "../intel/types";
import type { CompiledPolicy } from "../policy/compile";
import type { SecurityPolicy } from "../policy/types";
import type { RuleCondition } from "../rules/types";

/** What a policy needs. */
export interface IntelNeeds {
  /** A country entry or condition. */
  readonly country: boolean;
  /** An ASN entry or condition. */
  readonly asn: boolean;
  /** Classes named literally (`equals`, `in`, `botSignals.classes`). */
  readonly classes: ReadonlySet<string>;
  /** Whether a `class` condition is used at all. */
  readonly anyClass: boolean;
}

/** Walks a condition for intel targets. */
function walk(
  condition: RuleCondition,
  found: {
    country: boolean;
    asn: boolean;
    anyClass: boolean;
    classes: Set<string>;
  },
): void {
  const record = condition as Record<string, unknown>;
  if ("all" in record) {
    for (const c of record.all as RuleCondition[]) walk(c, found);
    return;
  }
  if ("any" in record) {
    for (const c of record.any as RuleCondition[]) walk(c, found);
    return;
  }
  if ("not" in record) {
    walk(record.not as RuleCondition, found);
    return;
  }
  if ("country" in record) found.country = true;
  if ("asn" in record) found.asn = true;
  if ("class" in record) {
    found.anyClass = true;
    const matcher = record.class as { equals?: string; in?: readonly string[] };
    if (typeof matcher.equals === "string") found.classes.add(matcher.equals);
    for (const name of matcher.in ?? []) found.classes.add(name);
  }
}

/** What `policy` needs of IP intelligence. */
export function intelNeeds(policy: CompiledPolicy): IntelNeeds {
  const source = policy.source as SecurityPolicy;
  const found = {
    country: false,
    asn: false,
    anyClass: false,
    classes: new Set<string>(),
  };
  for (const entry of source.lists ?? []) {
    if ((entry.mode ?? "enforce") === "off") continue;
    if (entry.country !== undefined) found.country = true;
    if (entry.asn !== undefined) found.asn = true;
  }
  for (const rule of source.requestRules?.rules ?? []) {
    if ((rule.mode ?? "enforce") !== "off") walk(rule.when, found);
  }
  // The new-ASN anomaly reads the client's ASN (layers.md L12).
  const newAsn = source.apiKeys?.newAsn;
  if (
    newAsn === true ||
    (typeof newAsn === "object" && newAsn.mode !== "off")
  ) {
    found.asn = true;
  }
  for (const [name, points] of Object.entries(
    source.botSignals?.classes ?? {},
  )) {
    if (points > 0) {
      found.anyClass = true;
      found.classes.add(name);
    }
  }
  return found;
}

/**
 * Throws a `ConfigError` when `policy` needs what `intel` cannot give: any
 * country, ASN or class without an `intel`; a country or ASN its databases
 * do not hold; a class no feed or static range provides.
 */
export function checkIntel(
  policy: CompiledPolicy,
  intel: IntelLookup | undefined,
  what: string,
): void {
  const needs = intelNeeds(policy);
  if (!needs.country && !needs.asn && !needs.anyClass) return;
  const uses = [
    needs.country ? "country" : undefined,
    needs.asn ? "asn" : undefined,
    needs.anyClass ? "class" : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  if (intel === undefined) {
    throw new ConfigError(
      `${what}: the policy uses ${uses}, which need IP intelligence: pass createSecurity's intel (ipIntel() from @kingsleyweb/bun-security/intel)`,
    );
  }
  const provides = intel.provides();
  if (needs.country && !provides.country) {
    throw new ConfigError(
      `${what}: the policy uses country, but no database of the intel gives countries`,
    );
  }
  if (needs.asn && !provides.asn) {
    throw new ConfigError(
      `${what}: the policy uses asn, but no database of the intel gives ASNs`,
    );
  }
  const unknown = [...needs.classes].filter(
    (name) => !provides.classes.has(name),
  );
  if (unknown.length > 0) {
    throw new ConfigError(
      `${what}: the policy names classes no feed or range of the intel provides: ${unknown.join(", ")} (it provides ${[...provides.classes].join(", ") || "none"})`,
    );
  }
}
