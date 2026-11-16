/**
 * Layer L3, allow and deny lists (layers.md L3, L3.1): every entry matching
 * the client's address (through the CIDR trie), user or API key id, minus
 * those expired or scoped to other paths, resolved by precedence:
 *
 * 1. locked entries first, whatever their scope (a lower scope cannot
 *    override one; the `internal` list is locked);
 * 2. otherwise only the most specific scope that matched: route-scoped >
 *    service > group > global;
 * 3. within that set, an `allow` marked `override` wins; otherwise the most
 *    severe action does.
 *
 * The `internal` list is locked, so no address entry refuses an internal
 * client; it protects addresses only, so a refusing user or API-key entry
 * still applies to a request from an internal address (blocking one account
 * refuses nobody else behind that address).
 *
 * Dry-run entries never decide. The engine resolves the list twice, with
 * and without them, and when the outcome would differ it records the dry
 * entry's would-be action (layers.md §0.4).
 */
import type { IntelLookup } from "../intel/types";
import type { ParsedAddress } from "../ip/address";
import type { CompiledEntry, PolicyInternals } from "../policy/compile";
import type { ListAction } from "../policy/types";
import type { ExplainStep } from "./decision";

/** Severity of the list actions, in the order of `ACTION_SEVERITY`. */
const SEVERITY: Readonly<Record<ListAction, number>> = {
  allow: 0,
  challenge: 4,
  block: 5,
  drop: 7,
};

/** No entries. */
const NONE: readonly CompiledEntry[] = Object.freeze([]);

/** What the lists decided. */
export interface ListOutcome {
  /** The enforced entry that decided, if any matched. */
  readonly decided: CompiledEntry | undefined;
  /**
   * The dry-run entry that would have decided instead, when enforcing the
   * dry-run entries would change the outcome.
   */
  readonly wouldBe: CompiledEntry | undefined;
  /** Whether the client is in the `internal` list. */
  readonly internal: boolean;
}

/** Whether `path` is `prefix` or below it, on whole segments. */
function underPrefix(path: string, prefix: string): boolean {
  return (
    prefix === "/" ||
    path === prefix ||
    (path.startsWith(prefix) && path.charCodeAt(prefix.length) === 0x2f) /* / */
  );
}

/** Whether `entry` applies to a request for `path` at `now`. */
function applies(entry: CompiledEntry, path: string, now: number): boolean {
  if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
    return false;
  }
  if (entry.paths === undefined) {
    return true;
  }
  for (const prefix of entry.paths) {
    if (underPrefix(path, prefix)) return true;
  }
  return false;
}

/** The entry that decides among `entries`, by the precedence above. */
export function resolveEntries(
  entries: readonly CompiledEntry[],
): CompiledEntry | undefined {
  if (entries.length === 0) {
    return undefined;
  }
  let pool = entries.filter((entry) => entry.locked);
  if (pool.length === 0) {
    let level = -1;
    for (const entry of entries) level = Math.max(level, entry.level);
    pool = entries.filter((entry) => entry.level === level);
  }
  let best: CompiledEntry | undefined;
  for (const entry of pool) {
    if (entry.action === "allow" && entry.override) {
      return entry;
    }
    if (best === undefined || SEVERITY[entry.action] > SEVERITY[best.action]) {
      best = entry;
    }
  }
  return best;
}

/**
 * The deciding entry, the `internal` list protecting addresses only: when it
 * matched, a refusing user or API-key entry still decides; otherwise it
 * does.
 */
function decide(entries: readonly CompiledEntry[]): CompiledEntry | undefined {
  const internal = entries.find((entry) => entry.kind === "internal");
  if (internal === undefined) {
    return resolveEntries(entries);
  }
  const byIdentity = resolveEntries(
    entries.filter((entry) => entry.kind === "user" || entry.kind === "apiKey"),
  );
  return byIdentity !== undefined && byIdentity.action !== "allow"
    ? byIdentity
    : internal;
}

/** Describes an entry for an explanation. */
function describeEntry(entry: CompiledEntry): string {
  const flags = [
    entry.locked ? "locked" : undefined,
    entry.override ? "override" : undefined,
    entry.mode === "dryRun" ? "dry run" : undefined,
    entry.paths ? `paths ${entry.paths.join(", ")}` : undefined,
  ].filter(Boolean);
  return `${entry.id} → ${entry.action}${flags.length ? ` (${flags.join(", ")})` : ""}`;
}

/**
 * Evaluates the lists for one request. `dryPolicy` makes every entry dry
 * (the whole policy runs in dry run).
 */
export function evaluateLists(
  policy: PolicyInternals,
  address: ParsedAddress | null,
  user: string | undefined,
  apiKey: string | undefined,
  path: string,
  now: number,
  dryPolicy: boolean,
  trace?: ExplainStep[],
  intel?: IntelLookup,
  geoExempt = false,
): ListOutcome {
  const byAddress = address ? policy.ips.match(address) : NONE;
  const byUser = user === undefined ? undefined : policy.users.get(user);
  const byKey = apiKey === undefined ? undefined : policy.apiKeys.get(apiKey);
  // Country and ASN entries (layers.md L5): the address is looked up only
  // when the policy has some.
  let byCountry: readonly CompiledEntry[] | undefined;
  let byAsn: readonly CompiledEntry[] | undefined;
  if (
    address &&
    intel !== undefined &&
    (policy.countries.size > 0 || policy.asns.size > 0)
  ) {
    const record = intel.lookup(address);
    if (record.country !== undefined)
      byCountry = policy.countries.get(record.country);
    if (record.asn !== undefined) byAsn = policy.asns.get(record.asn);
    // A verified crawler on its allowance (layers.md L3.2, `geo`): country
    // and ASN entries that refuse do not apply; IP and CIDR entries still do.
    if (geoExempt) {
      byCountry = byCountry?.filter((entry) => entry.action === "allow");
      byAsn = byAsn?.filter((entry) => entry.action === "allow");
    }
  }
  if (
    byAddress.length === 0 &&
    byUser === undefined &&
    byKey === undefined &&
    byCountry === undefined &&
    byAsn === undefined
  ) {
    trace?.push({
      layer: "L3",
      check: "list",
      outcome: "no list entry matched",
    });
    return { decided: undefined, wouldBe: undefined, internal: false };
  }
  const enforced: CompiledEntry[] = [];
  const all: CompiledEntry[] = [];
  let internal = false;
  for (const group of [
    byAddress,
    byUser ?? NONE,
    byKey ?? NONE,
    byCountry ?? NONE,
    byAsn ?? NONE,
  ]) {
    for (const entry of group) {
      if (!applies(entry, path, now)) {
        trace?.push({
          layer: "L3",
          check: "list",
          rule: entry.id,
          outcome: `${describeEntry(entry)} skipped: ${entry.expiresAt !== undefined && entry.expiresAt <= now ? "expired" : "another path"}`,
        });
        continue;
      }
      if (entry.kind === "internal") internal = true;
      all.push(entry);
      if (entry.mode === "enforce" && !dryPolicy) enforced.push(entry);
    }
  }
  const decided = decide(enforced);
  const hypothetical = decide(all);
  const wouldBe =
    hypothetical !== undefined &&
    hypothetical !== decided &&
    hypothetical.action !== (decided?.action ?? "allow")
      ? hypothetical
      : undefined;
  if (trace) {
    for (const entry of all) {
      trace.push({
        layer: "L3",
        check: "list",
        rule: entry.id,
        outcome: `matched ${describeEntry(entry)}${entry === decided ? ": decided" : entry === wouldBe ? ": would have decided (dry run)" : ""}`,
        decided: entry === decided,
      });
    }
    if (decided === undefined && wouldBe === undefined) {
      trace.push({
        layer: "L3",
        check: "list",
        outcome: "no enforced entry decided",
      });
    }
  }
  return { decided, wouldBe, internal };
}
