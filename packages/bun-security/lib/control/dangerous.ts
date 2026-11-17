/**
 * Dangerous changes (control-plane.md §5.4): a publish that would make a
 * service refuse more than it did is checked against its effective policy
 * before and after. Found, it needs a second operator (`approvals:
 * "two-person"`) or the author typing the scope's name.
 *
 * Dangerous here: a rule, limit, counted rule or list entry going from dry
 * run to enforced, or the whole policy, on a `production` service; an
 * action raised (`log` → `block`, `block` → `ban`); an allow entry added or
 * widened; the ladder changed. (Bans, ASN or country bans and signing-key
 * rotation are dangerous too, and arrive with their routes.)
 */
import { ACTION_SEVERITY } from "../engine/actions";
import type { SecurityAction } from "../policy/types";

/** A JSON object. */
type JsonObject = Record<string, unknown>;

/** The keyed collections whose items carry a `mode` and an `action`. */
const COLLECTIONS: readonly (readonly [
  string,
  (policy: JsonObject) => unknown,
])[] = [
  ["lists", (policy) => policy.lists],
  ["limits", (policy) => policy.limits],
  ["countedRules", (policy) => policy.countedRules],
  [
    "requestRules.rules",
    (policy) => (policy.requestRules as JsonObject | undefined)?.rules,
  ],
];

/** An item's key in its collection. */
function keyOf(item: JsonObject, at: number): string {
  if (typeof item.id === "string") return item.id;
  for (const subject of ["ip", "user", "apiKey", "country", "asn"]) {
    if (item[subject] !== undefined)
      return `${subject}:${String(item[subject])}`;
  }
  return `#${at}`;
}

/** A collection's items by key. */
function itemsOf(value: unknown): Map<string, JsonObject> {
  const out = new Map<string, JsonObject>();
  if (!Array.isArray(value)) return out;
  value.forEach((item, at) => {
    if (typeof item === "object" && item !== null)
      out.set(keyOf(item as JsonObject, at), item as JsonObject);
  });
  return out;
}

/** The mode an item runs in, under the policy's own mode. */
function modeOf(item: JsonObject | undefined, policyMode: unknown): string {
  if (item?.mode === "off") return "off";
  if (policyMode === "dryRun" || policyMode === "off")
    return String(policyMode);
  return typeof item?.mode === "string" ? item.mode : "enforce";
}

/** An item's action's severity (the engine's order); a limit blocks. */
function severityOf(item: JsonObject | undefined, collection: string): number {
  if (item === undefined) return -1;
  const action =
    typeof item.action === "string"
      ? item.action
      : collection === "countedRules"
        ? "ban"
        : "block";
  return ACTION_SEVERITY[action as SecurityAction] ?? ACTION_SEVERITY.block;
}

/** The prefix length of an `ip` entry's range (`/32` for a bare IPv4 address). */
function prefixOf(ip: unknown): number | undefined {
  if (typeof ip !== "string") return undefined;
  const slash = ip.indexOf("/");
  if (slash >= 0) return Number(ip.slice(slash + 1));
  return ip.includes(":") ? 128 : 32;
}

/**
 * The dangerous changes from `before` to `after`, one effective policy of
 * one service, `production` saying whether it is a production service.
 * Each is a short line naming the path.
 */
export function dangerousChanges(
  before: JsonObject,
  after: JsonObject,
  production: boolean,
): string[] {
  const found: string[] = [];
  if (
    production &&
    before.mode === "dryRun" &&
    after.mode !== "dryRun" &&
    after.mode !== "off"
  ) {
    found.push(
      "mode: the policy goes from dry run to enforced on a production service",
    );
  }
  for (const [name, read] of COLLECTIONS) {
    const old = itemsOf(read(before));
    for (const [key, item] of itemsOf(read(after))) {
      const path = `${name}[id=${key}]`;
      const was = old.get(key);
      const wasMode = was === undefined ? undefined : modeOf(was, before.mode);
      const nowMode = modeOf(item, after.mode);
      if (production && wasMode === "dryRun" && nowMode === "enforce") {
        found.push(`${path}: from dry run to enforced on a production service`);
      }
      if (nowMode === "enforce" && was !== undefined && wasMode === "enforce") {
        if (severityOf(item, name) > severityOf(was, name)) {
          found.push(
            `${path}: its action raised from ${String(was.action ?? "its default")} to ${String(item.action)}`,
          );
        }
      }
      if (name === "lists" && item.action === "allow" && nowMode !== "off") {
        const before = was?.action === "allow" ? prefixOf(was.ip) : undefined;
        const now = prefixOf(item.ip);
        if (was === undefined || was.action !== "allow") {
          found.push(`${path}: an allow entry added`);
        } else if (before !== undefined && now !== undefined && now < before) {
          found.push(
            `${path}: an allow entry widened from /${before} to /${now}`,
          );
        }
      }
    }
  }
  if (
    JSON.stringify(before.ladder ?? null) !==
    JSON.stringify(after.ladder ?? null)
  ) {
    found.push("ladder: the escalation ladder changed");
  }
  return found;
}
