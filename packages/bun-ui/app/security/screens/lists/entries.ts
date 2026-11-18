/**
 * A scope's list entries as the API carries them (bun-security's
 * `ListEntry`, layers.md L3.1): one subject (an address or CIDR range, an
 * account's key, a country, an ASN), an action and its options. Account
 * entries are **keys** (`userHash`, `apiKeyHash`) as the API returns them;
 * a raw `user` or `apiKey` id exists only in an entry the operator has
 * typed and not yet saved (the control plane keys it on save), and is never
 * shown.
 */

/** What a match does. */
export type ListAction = "allow" | "block" | "challenge" | "drop";

/** An entry's mode. */
export type ListMode = "enforce" | "dryRun" | "off";

/** One list entry. */
export interface ListEntryDto {
  /** A stable id, unique in the policy; the subject when absent. */
  readonly id?: string;
  /** An IPv4 or IPv6 address or CIDR range. */
  readonly ip?: string;
  /** A user id typed by the operator, keyed by the control plane on save. */
  readonly user?: string;
  /** A user's key (32 lower-case hex characters). */
  readonly userHash?: string;
  /** An API key id typed by the operator, keyed by the control plane on save. */
  readonly apiKey?: string;
  /** An API key id's key (32 lower-case hex characters). */
  readonly apiKeyHash?: string;
  /** A country, ISO 3166-1 alpha-2, upper case. */
  readonly country?: string;
  /** An autonomous system number. */
  readonly asn?: number;
  /** What a match does. */
  readonly action: ListAction;
  /** An allow entry wins over a block in the same scope. */
  readonly override?: boolean;
  /** Lower scopes cannot override it. */
  readonly locked?: boolean;
  /** Where the entry was written (`global`, `group`, `service`). */
  readonly scope?: string;
  /** Route prefixes it applies to; every path when absent. */
  readonly paths?: readonly string[];
  /** When it stops applying, ISO 8601 with its zone. */
  readonly expiresAt?: string;
  /** Its mode; `enforce` when absent. */
  readonly mode?: ListMode;
  /** Why it exists. */
  readonly reason?: string;
  /** Who added it. */
  readonly createdBy?: string;
  /** The refusal body's code. */
  readonly code?: string;
}

/** The filterable kinds (ui.md §4.1). */
export type EntryKind = "ip" | "user" | "apiKey" | "asn" | "country";

/** Each filterable kind's label. */
export const KIND_LABELS: Readonly<Record<EntryKind, string>> = {
  ip: "IP/CIDR",
  user: "User",
  apiKey: "API key",
  asn: "ASN",
  country: "Country",
};

/** The actions, in severity order. */
export const LIST_ACTIONS: readonly ListAction[] = [
  "allow",
  "challenge",
  "block",
  "drop",
];

/** The modes. */
export const LIST_MODES: readonly ListMode[] = ["enforce", "dryRun", "off"];

/** The most rows one CSV import may hold (ui.md §4.1). */
export const MAX_IMPORT_ROWS = 10_000;

/** An account's key: an HMAC, 32 lower-case hex characters. */
export const ACCOUNT_KEY_RE = /^[0-9a-f]{32}$/;

/** An account id as the policy accepts it (1-256 characters, no spaces). */
export const ACCOUNT_ID_RE = /^[\w.:/@+-]{1,256}$/;

/** An ISO 8601 timestamp with its time zone written. */
export const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Whether `value` is a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The list entries of a policy (its `lists`; anything else is skipped). */
export function listsOf(policy: unknown): ListEntryDto[] {
  if (!isRecord(policy) || !Array.isArray(policy.lists)) return [];
  return policy.lists.filter(
    (entry): entry is ListEntryDto =>
      isRecord(entry) && typeof entry.action === "string",
  );
}

/** An entry's filterable kind. */
export function entryKind(entry: ListEntryDto): EntryKind {
  if (entry.ip !== undefined) return "ip";
  if (entry.user !== undefined || entry.userHash !== undefined) return "user";
  if (entry.apiKey !== undefined || entry.apiKeyHash !== undefined)
    return "apiKey";
  if (entry.country !== undefined) return "country";
  return "asn";
}

/**
 * The value shown and searched for an entry: the address, the key, the
 * country, the ASN; `undefined` for a raw account id, which is never shown.
 */
export function shownValue(entry: ListEntryDto): string | undefined {
  if (entry.ip !== undefined) return entry.ip;
  if (entry.userHash !== undefined) return entry.userHash;
  if (entry.apiKeyHash !== undefined) return entry.apiKeyHash;
  if (entry.country !== undefined) return entry.country;
  if (entry.asn !== undefined) return String(entry.asn);
  return undefined;
}

/**
 * An entry's merge key, as the control plane's merge computes it
 * (`lib/control/merge.ts`): its `id`, else its subject and paths. A key
 * reads as its account would (`user:<key>`).
 */
export function entryKey(entry: ListEntryDto): string {
  if (typeof entry.id === "string") return entry.id;
  const paths = entry.paths === undefined ? "" : `|${entry.paths.join(",")}`;
  const pairs: readonly (readonly [string, string | number | undefined])[] = [
    ["ip", entry.ip],
    ["user", entry.user],
    ["user", entry.userHash],
    ["apiKey", entry.apiKey],
    ["apiKey", entry.apiKeyHash],
    ["country", entry.country],
    ["asn", entry.asn],
  ];
  for (const [name, value] of pairs) {
    if (value !== undefined) return `${name}:${String(value)}${paths}`;
  }
  return JSON.stringify(entry);
}

/** Whether an entry has expired at `now` (epoch ms). */
export function isExpired(entry: ListEntryDto, now: number): boolean {
  if (entry.expiresAt === undefined) return false;
  const at = Date.parse(entry.expiresAt);
  return Number.isFinite(at) && at <= now;
}

/** What changed in the lists from `before` to `after`, by entry key. */
export interface ListsDiff {
  /** Entries only in `after`. */
  readonly added: number;
  /** Entries only in `before`. */
  readonly removed: number;
  /** Entries in both, changed. */
  readonly changed: number;
}

/** Compares two lists by entry key. */
export function diffLists(
  before: readonly ListEntryDto[],
  after: readonly ListEntryDto[],
): ListsDiff {
  const old = new Map(before.map((entry) => [entryKey(entry), entry]));
  const now = new Map(after.map((entry) => [entryKey(entry), entry]));
  let added = 0;
  let changed = 0;
  for (const [key, entry] of now) {
    const was = old.get(key);
    if (was === undefined) added += 1;
    else if (stableJson(was) !== stableJson(entry)) changed += 1;
  }
  let removed = 0;
  for (const key of old.keys()) if (!now.has(key)) removed += 1;
  return { added, removed, changed };
}

/** JSON with object keys sorted, for comparing values. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

/** Whether two policies differ outside their lists. */
export function otherFieldsDiffer(before: unknown, after: unknown): boolean {
  const strip = (policy: unknown) => {
    if (!isRecord(policy)) return {};
    const { lists: _lists, ...rest } = policy;
    return rest;
  };
  return stableJson(strip(before)) !== stableJson(strip(after));
}
