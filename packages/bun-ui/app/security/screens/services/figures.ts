/**
 * The services list's figures (ui.md §3, the user's decision of
 * 2026-11-18): each service's agents' health from `GET /agents`; its
 * requests a minute and blocked share over the last hour from the
 * `requests` series grouped by service; and its policy's mode, with how
 * many of its items run in dry run, from its effective policy (read for the
 * services on the page only).
 */
import type { AgentsDto, SeriesDto } from "../../analytics/api";

/** The actions that refuse a request. */
const REFUSING = new Set(["block", "ban", "drop"]);

/** The keyed arrays whose items carry their own `mode`. */
const ITEM_LISTS: readonly (readonly string[])[] = [
  ["lists"],
  ["limits"],
  ["countedRules"],
  ["requestRules", "rules"],
  ["identifiers", "patterns"],
  ["messages", "limits"],
];

/** The sections with a `mode` of their own. */
const SECTION_MODES: readonly (readonly string[])[] = [
  ["concurrency"],
  ["bans"],
  ["ladder"],
  ["shape"],
  ["messages"],
  ["botSignals"],
  ["crawlers"],
  ["deception", "honeypots"],
  ["requestRules", "managed"],
  ["profiles", "login"],
  ["apiKeys", "newAsn"],
  ["apiKeys", "manyAddresses"],
];

/** The value at `path`. */
function at(policy: unknown, path: readonly string[]): unknown {
  let node = policy;
  for (const part of path) {
    if (typeof node !== "object" || node === null || Array.isArray(node))
      return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Whether `value` has `mode: "dryRun"`. */
function dry(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { mode?: unknown }).mode === "dryRun"
  );
}

/** How many items and sections of `policy` run in dry run. */
export function dryRunCount(policy: unknown): number {
  let count = 0;
  for (const path of ITEM_LISTS) {
    const items = at(policy, path);
    if (Array.isArray(items)) count += items.filter(dry).length;
  }
  for (const path of SECTION_MODES) if (dry(at(policy, path))) count += 1;
  return count;
}

/** A policy's mode in a few words. */
export function modeSummary(policy: unknown): string {
  const mode = at(policy, ["mode"]);
  if (mode === "off") return "Off";
  if (mode === "dryRun") return "Dry run (all of it)";
  const count = dryRunCount(policy);
  return count === 0
    ? "Enforced"
    : `Enforced, ${count.toLocaleString("en")} in dry run`;
}

/** A service's traffic over the series' window. */
export interface ServiceTraffic {
  /** Requests a minute. */
  readonly perMinute: number;
  /** The share refused, 0 to 1 (`null` with no request). */
  readonly blockedShare: number | null;
}

/** Each service's traffic from a `requests` series grouped by service, over `minutes`. */
export function trafficByService(
  series: SeriesDto,
  minutes: number,
): Map<string, ServiceTraffic> {
  const totals = new Map<string, { total: number; refused: number }>();
  for (const point of series.points) {
    if (point.service === undefined) continue;
    const sum = totals.get(point.service) ?? { total: 0, refused: 0 };
    sum.total += point.value;
    if (REFUSING.has(point.dims.action ?? "")) sum.refused += point.value;
    totals.set(point.service, sum);
  }
  return new Map(
    [...totals].map(([service, sum]) => [
      service,
      {
        perMinute: sum.total / minutes,
        blockedShare: sum.total === 0 ? null : sum.refused / sum.total,
      },
    ]),
  );
}

/** A service's agents in brief. */
export interface AgentSummary {
  /** Its agents (not revoked). */
  readonly count: number;
  /** How many in each state (`ok`, `late`, `offline`, `signature-failing`, `never-seen`). */
  readonly states: Readonly<Record<string, number>>;
  /** The bundle versions they enforce, highest first. */
  readonly bundles: readonly number[];
  /** The signing keys they report. */
  readonly keys: readonly string[];
  /** The latest heartbeat, epoch ms. */
  readonly lastSeen: number | null;
}

/** `service`'s agents in brief. */
export function agentSummary(
  agents: AgentsDto["items"],
  service: string,
): AgentSummary {
  const states: Record<string, number> = {};
  const bundles = new Set<number>();
  const keys = new Set<string>();
  let count = 0;
  let lastSeen: number | null = null;
  for (const agent of agents) {
    if (agent.service !== service || agent.status === "revoked") continue;
    count += 1;
    states[agent.status] = (states[agent.status] ?? 0) + 1;
    if (agent.reported?.bundleVersion != null)
      bundles.add(agent.reported.bundleVersion);
    if (agent.reported?.bundleKeyId != null)
      keys.add(agent.reported.bundleKeyId);
    if (
      agent.lastSeen !== null &&
      (lastSeen === null || agent.lastSeen > lastSeen)
    )
      lastSeen = agent.lastSeen;
  }
  return {
    count,
    states,
    bundles: [...bundles].sort((a, b) => b - a),
    keys: [...keys],
    lastSeen,
  };
}
