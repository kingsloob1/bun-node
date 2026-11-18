/**
 * The policy editor's tabs, one per layer (ui.md §3, layers.md L1–L14),
 * each with the policy keys it edits, so a tab can switch to JSON over
 * exactly those keys, and every key of the policy has a tab (a test checks
 * it against the schema). How a tab edits them (the user's decision of
 * 2026-11-18): hand-built forms for rules, limits, lists, profiles, the
 * ladder and the crawler allowance; forms generated from the JSON Schema
 * for the simple sections; the JSON editor for the rest.
 */

/** How a tab is built. */
export type TabKind =
  "schema" | "lists" | "crawlers" | "limits" | "counted" | "rules" | "json";

/** A tab. */
export interface PolicyTab {
  /** Its id, in the URL's `tab`. */
  readonly id: string;
  /** Its label. */
  readonly label: string;
  /** How it is built. */
  readonly kind: TabKind;
  /** The top-level policy keys it edits. */
  readonly keys: readonly string[];
}

/** The tabs, in layer order. */
export const POLICY_TABS: readonly PolicyTab[] = [
  {
    id: "general",
    label: "General",
    kind: "schema",
    keys: ["mode", "public", "environment", "service", "keys", "state"],
  },
  {
    id: "identity",
    label: "Identity and trust (L2)",
    kind: "schema",
    keys: ["trustCheck", "internal", "serviceIdentity"],
  },
  { id: "lists", label: "Lists (L3)", kind: "lists", keys: ["lists"] },
  {
    id: "crawlers",
    label: "Crawlers (L3.2)",
    kind: "crawlers",
    keys: ["crawlers"],
  },
  {
    id: "connections",
    label: "Connections (L1)",
    kind: "schema",
    keys: ["concurrency", "messages"],
  },
  {
    id: "limits",
    label: "Rate limits (L9)",
    kind: "limits",
    keys: ["limits", "presets"],
  },
  {
    id: "counted",
    label: "Counted rules and ladder (L4)",
    kind: "counted",
    keys: ["countedRules", "ladder", "bans"],
  },
  { id: "shape", label: "Request shape (L6)", kind: "schema", keys: ["shape"] },
  {
    id: "rules",
    label: "Request rules (L7)",
    kind: "rules",
    keys: ["requestRules"],
  },
  {
    id: "deception",
    label: "Deception (L8)",
    kind: "schema",
    keys: ["deception"],
  },
  {
    id: "bots",
    label: "Bot signals (L10)",
    kind: "schema",
    keys: ["botSignals"],
  },
  {
    id: "signin",
    label: "Sign-in (L11)",
    kind: "schema",
    keys: ["profiles", "identifiers"],
  },
  { id: "apikeys", label: "API keys (L12)", kind: "schema", keys: ["apiKeys"] },
  { id: "json", label: "Whole policy (JSON)", kind: "json", keys: [] },
];

/** The keys no tab but the whole policy's JSON edits. */
export const JSON_ONLY_KEYS: readonly string[] = ["version"];

/** The tab with `id`, else the first. */
export function tabOf(id: string | null): PolicyTab {
  return POLICY_TABS.find((tab) => tab.id === id) ?? POLICY_TABS[0];
}

/** `policy` narrowed to `keys` (those it sets). */
export function pick(
  policy: Readonly<Record<string, unknown>> | undefined,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (policy?.[key] !== undefined) out[key] = policy[key];
  }
  return out;
}
